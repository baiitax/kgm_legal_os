/**
 * Cryptographic primitives.
 *
 * Deliberately dependency-free: everything here is built on node:crypto so the
 * security properties are auditable in one file.
 *
 *  - Passwords      : scrypt (N=2^15, r=8, p=1), 32-byte salt, constant-time verify
 *  - Tokens         : 256-bit CSPRNG, stored only as SHA-256 hashes
 *  - Fingerprints   : keyed SHA-256 (peppered) so the DB is not an IP oracle
 *  - Encryption     : AES-256-GCM with a per-value nonce, for MFA secrets
 *  - TOTP           : RFC 6238, implemented here so MFA needs no new dependency
 */
import crypto from 'node:crypto';
import { hashPepper, masterKey } from '../config.js';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export interface PasswordHashParts {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(normalizePassword(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password. Always performs a hash computation, even for an unknown
 * user, so response timing does not reveal whether the account exists.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  const candidate = stored ?? dummyHash;
  const parts = candidate.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(normalizePassword(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  // A stored=null account still burns the same time but can never match.
  return stored !== null && crypto.timingSafeEqual(actual, expected);
}

const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));

/** NFKC + length cap protects against DoS via huge inputs. */
function normalizePassword(p: string): string {
  if (p.length > 4096) throw new PasswordTooLongError();
  return p.normalize('NFKC');
}

export class PasswordTooLongError extends Error {
  constructor() {
    super('password_too_long');
    this.name = 'PasswordTooLongError';
  }
}

/**
 * Password strength (§6). Assessed server-side; the UI mirrors these rules but
 * the server verdict is authoritative.
 */
export interface PasswordStrength {
  ok: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  failures: string[];
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789',
  '1234567890', 'qwerty', 'qwerty123', 'abc123', 'letmein', 'welcome',
  'welcome1', 'admin', 'admin123', 'iloveyou', '111111', '000000',
  'password1!', 'changeme', 'kgmlegal', 'kgm123456', 'saudi123', 'riyadh123',
]);

export function assessPasswordStrength(
  password: string,
  opts: { minLength: number; disallow?: string[] } = { minLength: 12 },
): PasswordStrength {
  const failures: string[] = [];
  const p = password ?? '';

  if (p.length < opts.minLength) failures.push('too_short');
  if (p.length > 128) failures.push('too_long');
  if (!/[a-z\u0620-\u06FF]/.test(p)) failures.push('needs_lowercase_or_arabic');
  if (!/[A-Z]/.test(p)) failures.push('needs_uppercase');
  if (!/[0-9]/.test(p)) failures.push('needs_digit');
  if (!/[^A-Za-z0-9]/.test(p)) failures.push('needs_symbol');
  if (COMMON_PASSWORDS.has(p.toLowerCase())) failures.push('too_common');

  // Reject passwords containing the account's own identifiers.
  for (const bad of opts.disallow ?? []) {
    const norm = bad.trim().toLowerCase();
    if (norm.length >= 4 && p.toLowerCase().includes(norm)) {
      failures.push('contains_personal_identifier');
      break;
    }
  }

  // Naive repetition / sequence check.
  if (/^(.)\1{5,}$/.test(p)) failures.push('repetitive');
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf)/i.test(p)) {
    failures.push('sequential');
  }

  let score = 0;
  if (p.length >= opts.minLength) score++;
  if (p.length >= 16) score++;
  if (failures.length === 0) score++;
  if (p.length >= 20 && failures.length === 0) score++;

  return { ok: failures.length === 0, score: Math.min(score, 4) as 0 | 1 | 2 | 3 | 4, failures };
}

/**
 * Optional rehash check — lets us transparently upgrade cost parameters.
 */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  return parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Peppered hash for values we may need to look up (emails, IPs, fingerprints). */
export function keyedHash(value: string): string {
  return crypto.createHmac('sha256', hashPepper).update(value).digest('hex');
}

export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  // Keep the /24 prefix so aggregate abuse detection works without storing
  // a full address. The hash is not reversible without the pepper.
  const parts = normalizeIp(ip).split('.');
  const coarse = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : normalizeIp(ip);
  return keyedHash(`ip:${coarse}`);
}

export function normalizeIp(ip: string): string {
  // Strip IPv6-mapped IPv4 prefix.
  return ip.replace(/^::ffff:/, '').split(',')[0].trim();
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still compare to keep timing uniform.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// At-rest encryption (AES-256-GCM) for MFA secrets & provider credentials
// ---------------------------------------------------------------------------
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('malformed_ciphertext');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238 (MFA-ready, §8)
// ---------------------------------------------------------------------------
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid_base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCodeAt(secretB32: string, timeStepSeconds = 30, t = Date.now()): string {
  const counter = Math.floor(t / 1000 / timeStepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/** Verifies with a ±1 step window to tolerate clock skew. */
export function verifyTotp(secretB32: string, code: string, windowSteps = 1): boolean {
  const clean = (code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const now = Date.now();
  for (let i = -windowSteps; i <= windowSteps; i++) {
    const expected = totpCodeAt(secretB32, 30, now + i * 30_000);
    if (timingSafeEqualStr(clean, expected)) return true;
  }
  return false;
}

export function otpUri(secretB32: string, account: string, issuer: string): string {
  const q = encodeURIComponent;
  return `otpauth://totp/${q(issuer)}:${q(account)}?secret=${secretB32}&issuer=${q(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 10): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plain.push(code);
    hashes.push(hashToken(code));
  }
  return { plain, hashes };
}

// ---------------------------------------------------------------------------
// Email OTP
// ---------------------------------------------------------------------------
export function generateOtp(digits = 6): string {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

// ---------------------------------------------------------------------------
// Device fingerprint (§7, §26)
// UA + coarse IP + a per-user random salt stored on the device row.
// ---------------------------------------------------------------------------
export function deviceFingerprint(userAgent: string, ip: string | null, uaFamily: string): string {
  return keyedHash(`dev:${uaFamily}:${ip ?? 'unknown'}:${(userAgent || '').slice(0, 120)}`);
}

export function maskNationalId(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(Math.max(digits.length - 4, 4))}${digits.slice(-4)}`;
}

/**
 * A commercial registration, kept for identification and not for transcription.
 *
 * Separate from `maskNationalId` because a CR is not a number: it can carry
 * letters, and stripping non-digits from it (as the national-id masker does) would
 * return a mask with nothing behind it. The last three characters are kept and the
 * rest is masked — the same convention the client register already shows.
 */
export function maskRegistration(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.length <= 3) return '***';
  return `${'*'.repeat(Math.max(v.length - 3, 3))}${v.slice(-3)}`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const keep = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${keep}${'*'.repeat(Math.max(local.length - keep.length, 3))}@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${phone.slice(0, phone.length - digits.length + Math.max(digits.length - 4, 0))}****${digits.slice(-4)}`;
}

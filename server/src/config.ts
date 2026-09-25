/**
 * KGM LEGAL OS — Client Portal
 * Runtime configuration.
 *
 * Every secret has a safe development default so the portal runs out of the
 * box, and a hard production guard so it cannot be deployed with one.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { defaultPoolMax } from './db/transient.js';
import { fileURLToPath } from 'node:url';

export type Env = 'development' | 'test' | 'production';

const bool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const raw = process.env;

export const NODE_ENV: Env = (raw.NODE_ENV as Env) || 'development';
export const isProd = NODE_ENV === 'production';
export const isTest = NODE_ENV === 'test';

/**
 * DATABASE DRIVER
 *  - 'sqlite'   demo / development / test. File-backed, zero configuration.
 *  - 'postgres' production. Connects to Supabase Postgres AS the restricted
 *               `portal_api` role so that RLS (0004) and column-level grants
 *               are actually enforced. Using the service key instead would
 *               BYPASS both — that is deliberately not supported here.
 */
export const DB_DRIVER = (raw.DB_DRIVER || (isProd ? 'postgres' : 'sqlite')) as
  | 'sqlite'
  | 'postgres';

/**
 * Directory holding server/package.json.
 *
 * This file is `server/src/config.ts`, so the package root is ONE level up from
 * its own directory. Getting this wrong is not a crash — it is a second, empty
 * database and a second, empty storage volume in whichever directory the count
 * lands on, with every query succeeding against nothing.
 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  env: NODE_ENV,
  port: int(raw.PORT, 8787),
  host: raw.HOST || '0.0.0.0',

  db: {
    driver: DB_DRIVER,
    /**
     * Anchored to the SERVER PACKAGE ROOT, not to process.cwd().
     *
     * A relative default here is a footgun with a silent failure mode: run any
     * script — a seed, a migration check, a one-off query — from the repository
     * root instead of `server/`, and it quietly creates a SECOND empty database
     * rather than opening the real one. The queries then succeed, return nothing,
     * and look like a bug in the code under test. Resolving against this file's
     * own location makes the path independent of where the process started.
     *
     * An explicit SQLITE_FILE still wins, and is resolved against cwd as before
     * so a deployment can point at an absolute path or a volume mount.
     */
    sqliteFile: raw.SQLITE_FILE
      ? path.resolve(raw.SQLITE_FILE)
      : path.resolve(SERVER_ROOT, 'data/kgm-portal.sqlite'),
    /** Postgres connection for the restricted portal_api role. */
    pgUrl: raw.DATABASE_URL || '',
    /*
      THE POOL SIZE IS A BUDGET SHARED WITH EVERY OTHER LIVE PROCESS, and on a serverless
      runtime the number of processes is not knowable. See db/transient.ts for the whole
      argument; the short version is that `SET ROLE` and session `set_config` (which the
      RLS model depends on) rule out the transaction pooler, so a session is a connection,
      and an elastic fleet of instances each holding ten of them exhausts the pooler.
      `PG_POOL_MAX` still wins when the operator sets it.
    */
    pgPoolMax: defaultPoolMax(raw),
  },

  /**
   * Supabase — used ONLY for private object storage and signed URL minting.
   * The service key never leaves the server process and is never rendered
   * into any client bundle, HTML page or API response.
   */
  supabase: {
    url: raw.SUPABASE_URL || '',
    serviceKey: raw.SUPABASE_SERVICE_ROLE_KEY || '',
    documentsBucket: raw.SUPABASE_BUCKET_DOCUMENTS || 'client-documents',
    uploadsBucket: raw.SUPABASE_BUCKET_UPLOADS || 'client-uploads',
    financialBucket: raw.SUPABASE_BUCKET_FINANCIAL || 'financial-documents',
  },

  storage: {
    /** Local private directory used when no Supabase project is configured. */
    driver: (raw.STORAGE_DRIVER || (raw.SUPABASE_URL ? 'supabase' : 'local')) as
      | 'local'
      | 'supabase',
    // Anchored to the package root for the same reason as sqliteFile, and it
    // matters more here: a document row whose storage_key resolves to a
    // different volume than the one the bytes were written to is a download that
    // 404s at click time, long after the upload appeared to succeed.
    localDir: raw.LOCAL_STORAGE_DIR
      ? path.resolve(raw.LOCAL_STORAGE_DIR)
      : path.resolve(SERVER_ROOT, 'data/storage'),
    /** §18 — signed URLs are short-lived by design. */
    signedUrlTtlSeconds: int(raw.SIGNED_URL_TTL_SECONDS, 60),
    exportUrlTtlSeconds: int(raw.EXPORT_URL_TTL_SECONDS, 300),
  },

  crypto: {
    /**
     * Master key for encrypting at-rest secrets (MFA keys, provider creds).
     * 32 bytes, hex. In production this must come from a KMS/secret manager.
     */
    masterKey: raw.KGM_MASTER_KEY || '',
    /** Keyed-hash pepper so stored hashes are not rainbow-table usable. */
    hashPepper: raw.KGM_HASH_PEPPER || '',
    signedUrlSecret: raw.KGM_SIGNED_URL_SECRET || '',
  },

  session: {
    cookieName: raw.SESSION_COOKIE || 'kgm_portal_session',
    csrfCookieName: raw.CSRF_COOKIE || 'kgm_csrf',
    csrfHeader: 'x-csrf-token',
    /** Absolute lifetime — a session dies at this point regardless of activity. */
    absoluteTtlSeconds: int(raw.SESSION_ABSOLUTE_TTL, 60 * 60 * 12),
    /** Idle lifetime — extended on activity, capped by the absolute TTL. */
    idleTtlSeconds: int(raw.SESSION_IDLE_TTL, 60 * 30),
    /** "Remember this device" extends idle TTL only, never the absolute TTL. */
    rememberIdleTtlSeconds: int(raw.SESSION_REMEMBER_IDLE_TTL, 60 * 60 * 24 * 14),
    secureCookie: bool(raw.SESSION_SECURE_COOKIE, isProd),
    sameSite: (raw.SESSION_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none',
    domain: raw.SESSION_COOKIE_DOMAIN || undefined,
    /** Device trust for MFA is time-boxed and revocable (§8). */
    trustedDeviceTtlDays: int(raw.TRUSTED_DEVICE_TTL_DAYS, 30),
  },

  /**
   * Firm OS session (§52).
   *
   * A SEPARATE cookie from the client portal, with its own name, its own CSRF
   * cookie and its own lifetimes. The two audiences must not share an
   * authorization surface (§6), and a shared cookie is the easiest way to
   * accidentally create one: a browser holding both would let a portal handler
   * see a firm token and vice versa.
   *
   * Lifetimes are shorter than the portal's by default. An operator session is
   * worth more than a client session, so it should not outlive a working day.
   */
  firmSession: {
    cookieName: raw.FIRM_SESSION_COOKIE || 'kgm_firm_session',
    csrfCookieName: raw.FIRM_CSRF_COOKIE || 'kgm_firm_csrf',
    csrfHeader: raw.FIRM_CSRF_HEADER || 'x-csrf-token',
    absoluteTtlSeconds: int(raw.FIRM_SESSION_ABSOLUTE_TTL, 60 * 60 * 8),
    idleTtlSeconds: int(raw.FIRM_SESSION_IDLE_TTL, 60 * 30),
    rememberIdleTtlSeconds: int(raw.FIRM_SESSION_REMEMBER_IDLE_TTL, 60 * 60 * 12),
    secureCookie: bool(raw.FIRM_SESSION_SECURE_COOKIE, isProd),
    sameSite: (raw.FIRM_SESSION_SAME_SITE || 'strict') as 'lax' | 'strict' | 'none',
    domain: raw.FIRM_SESSION_COOKIE_DOMAIN || undefined,
  },

  auth: {
    /** §6 — brute force protection. */
    maxFailedAttempts: int(raw.AUTH_MAX_FAILED, 5),
    lockoutSeconds: int(raw.AUTH_LOCKOUT_SECONDS, 15 * 60),
    /** Progressive delay: attempt N adds (N-1)*step ms up to a ceiling. */
    progressiveDelayStepMs: int(raw.AUTH_DELAY_STEP_MS, 400),
    progressiveDelayMaxMs: int(raw.AUTH_DELAY_MAX_MS, 4000),
    passwordResetTtlMinutes: int(raw.PASSWORD_RESET_TTL_MIN, 30),
    emailVerifyTtlMinutes: int(raw.EMAIL_VERIFY_TTL_MIN, 60 * 24),
    invitationTtlDays: int(raw.INVITATION_TTL_DAYS, 14),
    otpTtlMinutes: int(raw.OTP_TTL_MIN, 10),
    otpMaxAttempts: int(raw.OTP_MAX_ATTEMPTS, 5),
    /** §6 — password strength. */
    passwordMinLength: int(raw.PASSWORD_MIN_LENGTH, 12),
    passwordMaxLength: 128,
    /** Simulated outbound email. In production, wire to SES/Postmark/Resend. */
    emailDriver: (raw.EMAIL_DRIVER || 'console') as 'console' | 'ses' | 'http',
    emailHttpUrl: raw.EMAIL_HTTP_URL || '',
    portalBaseUrl: raw.PORTAL_BASE_URL || `http://localhost:${int(raw.PORT, 8787)}`,
  },

  rateLimit: {
    /** In-process limiter. Production should use Redis/Upstash for a fleet. */
    store: (raw.RATE_LIMIT_STORE || 'memory') as 'memory',
    loginWindowSeconds: int(raw.RL_LOGIN_WINDOW, 15 * 60),
    loginMaxPerIp: int(raw.RL_LOGIN_MAX_IP, 20),
    loginMaxPerEmail: int(raw.RL_LOGIN_MAX_EMAIL, 8),
    apiWindowSeconds: int(raw.RL_API_WINDOW, 60),
    apiMaxPerSession: int(raw.RL_API_MAX, 300),
    uploadWindowSeconds: int(raw.RL_UPLOAD_WINDOW, 60 * 60),
    uploadMaxPerSession: int(raw.RL_UPLOAD_MAX, 40),
    sensitiveWindowSeconds: int(raw.RL_SENSITIVE_WINDOW, 60 * 60),
    sensitiveMaxPerUser: int(raw.RL_SENSITIVE_MAX, 10),
  },

  uploads: {
    maxBytes: int(raw.UPLOAD_MAX_BYTES, 25 * 1024 * 1024),
    allowedMime: new Set(
      (
        raw.UPLOAD_ALLOWED_MIME ||
        'application/pdf,' +
          'application/msword,' +
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
          'application/vnd.ms-excel,' +
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
          'application/vnd.openxmlformats-officedocument.presentationml.presentation,' +
          'image/jpeg,image/png,image/webp,image/heic,' +
          'text/plain,text/csv'
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    /** Extension allowlist is enforced in addition to MIME sniffing. */
    allowedExt: new Set([
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.jpg', '.jpeg', '.png', '.webp', '.heic', '.txt', '.csv',
    ]),
    scanDriver: (raw.SCAN_DRIVER || 'stub') as 'stub' | 'clamav',
    clamavHost: raw.CLAMAV_HOST || '127.0.0.1',
    clamavPort: int(raw.CLAMAV_PORT, 3310),
  },

  payments: {
    /** Provider abstraction (§21). Swap in mada/HyperPay/Stripe/Moyasar. */
    provider: (raw.PAYMENT_PROVIDER || 'mock') as 'mock' | 'hyperpay' | 'stripe' | 'moyasar',
    webhookSecret: raw.PAYMENT_WEBHOOK_SECRET || '',
    currency: 'SAR',
    vatRate: 0.15,
  },

  security: {
    cspNonceLength: 16,
    hstsMaxAge: int(raw.HSTS_MAX_AGE, 60 * 60 * 24 * 365),
    reportOnlyCsp: bool(raw.CSP_REPORT_ONLY, false),
    /** Internal routes that must never be reachable by a portal session. */
    forbiddenPathPrefixes: [
      '/admin', '/compliance', '/billing/internal', '/settings/users', '/audit',
      '/internal-matters', '/firm-settings', '/staff', '/internal',
    ],
  },

  demo: {
    seedOnBoot: bool(raw.SEED_ON_BOOT, !isProd),
    seedCredentials: raw.SEED_CREDENTIALS || '',
  },
} as const;

/**
 * Deterministic per-installation fallbacks for development only. They are
 * derived from a stable seed so restarts do not invalidate existing sessions.
 */
const devSeed = 'kgm-legal-os-development-only-not-a-secret';
const devKey = (label: string) =>
  crypto.createHash('sha256').update(`${devSeed}:${label}`).digest('hex');

export function resolveSecret(value: string, label: string): string {
  if (value) return value;
  if (isProd) {
    throw new Error(
      `FATAL: ${label} is not configured. Refusing to start production without it.`,
    );
  }
  return devKey(label);
}

export const masterKey = Buffer.from(
  resolveSecret(config.crypto.masterKey, 'KGM_MASTER_KEY'),
  'hex',
).subarray(0, 32);

export const hashPepper = resolveSecret(config.crypto.hashPepper, 'KGM_HASH_PEPPER');

export const signedUrlSecret = Buffer.from(
  resolveSecret(config.crypto.signedUrlSecret, 'KGM_SIGNED_URL_SECRET'),
  'hex',
).subarray(0, 32);

if (masterKey.length !== 32) {
  throw new Error('FATAL: KGM_MASTER_KEY must decode to at least 32 bytes of hex.');
}

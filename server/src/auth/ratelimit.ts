/**
 * Rate limiting & progressive lockout (§6).
 *
 * In-process fixed-window counters. Correct for a single instance; in a fleet
 * swap the `CounterStore` for Redis/Upstash — the call sites do not change.
 *
 * Three independent budgets are enforced on login:
 *   1. per-IP      — stops distributed credential stuffing from one source
 *   2. per-email   — stops a single account being hammered
 *   3. per-account — the DB-backed failed_login_count that drives lockout
 *
 * The per-account lockout is durable (it survives a restart) because it lives
 * on the users row, not in memory.
 */
import { config } from '../config.js';

interface Counter {
  count: number;
  resetAt: number;
}

export interface CounterStore {
  hit(key: string, windowMs: number): { count: number; resetAt: number };
  reset(key: string): void;
  peek(key: string): Counter | undefined;
}

export class MemoryCounterStore implements CounterStore {
  private readonly map = new Map<string, Counter>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number) {
    this.sweep();
    const now = Date.now();
    const existing = this.map.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.map.set(key, fresh);
      return fresh;
    }
    existing.count++;
    return existing;
  }

  reset(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  peek(key: string) {
    const c = this.map.get(key);
    if (!c || c.resetAt <= Date.now()) return undefined;
    return c;
  }

  /** Drops expired windows so a long-running process cannot grow unbounded. */
  private sweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.map) if (v.resetAt <= now) this.map.delete(k);
  }
}

export const counters: CounterStore = new MemoryCounterStore();

export interface LimitResult {
  limited: boolean;
  remaining: number;
  retryAfterSeconds: number;
  count: number;
}

export function limit(key: string, max: number, windowSeconds: number): LimitResult {
  const windowMs = windowSeconds * 1000;
  const { count, resetAt } = counters.hit(key, windowMs);
  const limited = count > max;
  return {
    limited,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: limited ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) : 0,
    count,
  };
}

export function resetLimit(...keys: string[]) {
  for (const k of keys) counters.reset(k);
}

/**
 * Clears every budget. Used by the test suite so one spec cannot exhaust a
 * limiter that the next spec depends on; never called from request handling.
 */
export function resetAllLimits(): void {
  if (counters instanceof MemoryCounterStore) counters.clear();
}

export const keys = {
  loginIp: (ip: string) => `rl:login:ip:${ip}`,
  loginEmail: (email: string) => `rl:login:email:${email.toLowerCase()}`,
  resetIp: (ip: string) => `rl:reset:ip:${ip}`,
  resetEmail: (email: string) => `rl:reset:email:${email.toLowerCase()}`,
  inviteToken: (hint: string) => `rl:invite:${hint}`,
  api: (sessionId: string) => `rl:api:${sessionId}`,
  upload: (sessionId: string) => `rl:upload:${sessionId}`,
  sensitive: (userId: string, op: string) => `rl:sens:${userId}:${op}`,
  verifyEmail: (ip: string) => `rl:verify:ip:${ip}`,
  webhook: (ip: string) => `rl:webhook:ip:${ip}`,
  // Firm OS (§52). SEPARATE budget keys from the portal, so a brute-force
  // attempt against the firm login cannot exhaust a client's budget and lock a
  // real client out — and vice versa. The durable `users.locked_until` counter
  // IS shared, because that one is about the credential, not the door.
  firmLoginIp: (ip: string) => `rl:firmlogin:ip:${ip}`,
  firmLoginEmail: (email: string) => `rl:firmlogin:email:${email.toLowerCase()}`,
  firmApi: (sessionId: string) => `rl:firmapi:${sessionId}`,
  firmSensitive: (membershipId: string, op: string) => `rl:firmsens:${membershipId}:${op}`,
};

/**
 * Progressive delay (§6). The Nth consecutive failure costs (N-1)×step ms,
 * capped. This makes automated guessing expensive without locking a genuine
 * user out for a typo.
 */
export function progressiveDelayMs(failedAttempts: number): number {
  const step = config.auth.progressiveDelayStepMs;
  const max = config.auth.progressiveDelayMaxMs;
  if (failedAttempts <= 1) return 0;
  return Math.min(max, (failedAttempts - 1) * step);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Durable lockout decision. Derived from the users row so it survives restarts
 * and applies across every process.
 */
export interface LockoutDecision {
  locked: boolean;
  retryAfterSeconds: number;
  remainingAttempts: number;
}

export function evaluateLockout(
  failedLoginCount: number,
  lockedUntil: string | null,
  now = Date.now(),
): LockoutDecision {
  const max = config.auth.maxFailedAttempts;
  if (lockedUntil) {
    const until = new Date(lockedUntil).getTime();
    if (until > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000), remainingAttempts: 0 };
    }
  }
  const remaining = Math.max(0, max - (failedLoginCount % max || 0));
  return { locked: false, retryAfterSeconds: 0, remainingAttempts: remaining };
}

export function nextLockoutTimestamp(failedLoginCount: number, now = Date.now()): string | null {
  const max = config.auth.maxFailedAttempts;
  if (failedLoginCount > 0 && failedLoginCount % max === 0) {
    // Escalate: each successive lockout is twice as long, capped at 24 h.
    const cycles = Math.floor(failedLoginCount / max);
    const seconds = Math.min(24 * 3600, config.auth.lockoutSeconds * 2 ** (cycles - 1));
    return new Date(now + seconds * 1000).toISOString();
  }
  return null;
}

/**
 * Database driver abstraction.
 *
 * One portable SQL repository (db/repo.ts) sits on top of this interface.
 * Two drivers implement it:
 *
 *   sqlite    — demo, development, tests. File-backed via better-sqlite3.
 *   postgres  — production. Connects to Supabase Postgres AS the restricted
 *               `portal_api` role and sets the kgm.* GUCs so that Row Level
 *               Security (migration 0004) is live. This is the reason we do
 *               not use supabase-js with a service key for data access:
 *               service_role bypasses RLS, which would silently void the
 *               database layer of the security model.
 *
 * THE TWO-PHASE REQUEST SCOPE
 *   Session resolution has to read `users` / `client_sessions` /
 *   `client_invitations` BEFORE we know who the caller is, so a user-scoped RLS
 *   context cannot cover it. Rather than widen the portal role, the connection
 *   runs in one of two server-controlled phases:
 *
 *     phase 'auth'   — capability-based lookups only (by opaque token hash, by
 *                      email, by session token). No domain table is readable.
 *     phase 'portal' — strictly scoped to kgm.tenant_id + kgm.client_ids.
 *
 *   The phase is set by the server from the resolved session state. It is never
 *   taken from a header, cookie or body, and a handler cannot switch itself
 *   back to 'auth' to widen its own reach.
 *
 * SQL CONVENTIONS (both dialects)
 *   - placeholders are always `?`; the postgres driver rewrites them to $n
 *   - booleans are written as the literals TRUE/FALSE and passed as JS
 *     booleans; the sqlite driver coerces parameters to 0/1
 *   - timestamps are ISO-8601 strings in both directions
 *   - money is read back as a string and formatted at the edge
 *   - never interpolate a value into SQL text; always use a placeholder
 */

export type Param =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | Buffer;

export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
}

export type ScopePhase = 'auth' | 'portal' | 'firm';

/**
 * The authorization context pushed into the connection. On postgres these
 * become `SET kgm.*` values that RLS policies read.
 *
 * `membershipId` is the Firm OS half of the principal: it is what
 * kgm_membership() reads to resolve roles and matter access. A client request
 * leaves it null, so firm_* tables are invisible to it by construction.
 */
export interface RequestContext {
  phase: ScopePhase;
  tenantId: string | null;
  userId: string | null;
  clientIds: string[];
  membershipId?: string | null;
}

export const AUTH_PHASE: RequestContext = {
  phase: 'auth',
  tenantId: null,
  userId: null,
  clientIds: [],
};

export interface Queryable {
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<RunResult>;
}

/**
 * A connection (or connection-equivalent) dedicated to one HTTP request.
 * `setContext` may be called more than once: the auth phase resolves the
 * principal, then the portal phase scopes the rest of the request.
 */
export interface Scope {
  readonly q: Queryable;
  setContext(ctx: RequestContext): Promise<void>;
  /**
   * Runs `fn` in a transaction on this request's connection. Nested calls join
   * the outer transaction (savepoints on postgres, a depth counter on sqlite),
   * so repository methods compose without deadlocking on BEGIN.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface Db extends Queryable {
  readonly driver: 'sqlite' | 'postgres';
  /** Acquires a request scope. MUST be ended, even on error. */
  acquire(): Promise<Scope>;
  close(): Promise<void>;
}

/** Normalizes a value that may be a Date (pg) or an ISO string (sqlite). */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}

export function toDate(v: unknown): Date | null {
  const iso = toIso(v);
  return iso ? new Date(iso) : null;
}

export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 't' || v === 'true' || v === '1';
  return Boolean(v);
}

/** Money is carried as an exact 2-decimal string end to end. */
export function toMoney(v: unknown): string {
  if (v === null || v === undefined) return '0.00';
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

export function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

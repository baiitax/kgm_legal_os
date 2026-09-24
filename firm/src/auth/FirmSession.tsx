/**
 * FIRM SESSION CONTEXT.
 *
 * NOT SHARED WITH THE CLIENT PORTAL. This is the second of the three things the
 * two products must not share (API client, auth context, route table), and it is
 * the one that matters most: a shared auth context is a shared idea of who the
 * caller is, and the moment a firm member's principal can be read through a
 * component the portal also renders, the separation in §3/§6 stops being
 * structural.
 *
 * WHAT THIS HOLDS
 *   The resolved session exactly as the server returned it, plus the derived
 *   navigation. It stores no authority of its own.
 *
 * THE DISCIPLINE THIS ENFORCES
 *   `permissions` is a Set built once from the server's resolved codes and exposed
 *   read-only. Nothing in the app can add to it. A component that needs to know
 *   whether to render an approval button asks `can('billing.approve')`, which
 *   reads that Set — and the server re-checks the same code against the database
 *   on the request regardless. The client-side check exists to avoid rendering a
 *   control that will fail, never to permit anything.
 *
 *   This is why `can()` is a convenience and not a control, and why every screen
 *   still handles 403/404 from the API rather than trusting that `can()` said yes.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  bootstrapCsrf, firmApi, FirmApiError,
  type FirmSessionPayload, type LoginResult, type MatterAccessLevel,
} from '../api/firm.js';
import { visibleNav, type VisibleNav } from '../app/nav.js';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

export interface MfaChallenge {
  method: string;
  maskedDestination?: string;
  expiresInMinutes?: number;
}

interface FirmSessionValue {
  readonly status: SessionStatus;
  readonly session: FirmSessionPayload | null;
  readonly error: FirmApiError | null;

  /** The resolved permission codes. Read-only; nothing client-side can widen it. */
  readonly permissions: ReadonlySet<string>;
  /** Navigation filtered by those permissions (§50). */
  readonly nav: VisibleNav;

  /**
   * Client-side convenience check. NOT a control — the server re-checks every
   * request against the database. Use it to decide whether to render a control,
   * and still handle the refusal when the request is made.
   */
  can(code: string): boolean;
  canAny(codes: readonly string[]): boolean;

  readonly member: FirmSessionPayload['member'] | null;
  readonly displayName: string;
  readonly displayNameAr: string | null;
  readonly practiceAreas: readonly string[];
  readonly firmWideScope: boolean;
  readonly ceilings: FirmSessionPayload['member']['ceilings'] | null;
  readonly tenants: FirmSessionPayload['tenants'];
  readonly activeTenantId: string | null;
  readonly mfaEnabled: boolean;
  readonly mfaVerified: boolean;

  /** An MFA challenge raised during login, if any. */
  readonly mfaChallenge: MfaChallenge | null;

  signIn(email: string, password: string, remember?: boolean): Promise<LoginResult>;
  submitMfa(code: string, remember?: boolean): Promise<LoginResult>;
  signOut(): Promise<void>;
  switchTenant(tenantId: string): Promise<void>;
  /** Re-reads the session from the server. Used after a role or status change. */
  refresh(): Promise<void>;
  clearError(): void;
}

const Ctx = createContext<FirmSessionValue | null>(null);

/**
 * Tells the preloader in main.tsx that the session has settled.
 *
 * A window event rather than a shared flag or a callback prop, because main.tsx
 * runs before React mounts and must not import this module: if it did, the
 * preloader's teardown would be bundled into the app chunk and the boot sequence
 * would depend on the very thing it is waiting for.
 *
 * Fires exactly once per page load. A later refresh() or tenant switch must not
 * re-trigger it — the preloader element is already gone by then, and dispatching
 * again would be harmless but misleading in the event log.
 */
let settledSent = false;
function signalSettled(): void {
  if (settledSent || typeof window === 'undefined') return;
  settledSent = true;
  window.dispatchEvent(new Event('kgm:session-settled'));
}

const EMPTY_NAV: VisibleNav = { groups: [], allowedPaths: new Set<string>(), isEmpty: true };

export function FirmSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<FirmSessionPayload | null>(null);
  const [error, setError] = useState<FirmApiError | null>(null);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  // Guards against overlapping refreshes writing stale sessions out of order.
  const requestSeq = useRef(0);

  /** Applies an authenticated payload, or raises an MFA challenge. */
  const applyResult = useCallback((result: LoginResult): 'authenticated' | 'mfa' => {
    if (result.step === 'mfa') {
      setMfaChallenge({
        method: result.method ?? 'totp',
        maskedDestination: result.maskedDestination,
        expiresInMinutes: result.expiresInMinutes,
      });
      setStatus('anonymous');
      return 'mfa';
    }
    setMfaChallenge(null);
    setSession({
      member: result.member!,
      preferences: result.preferences!,
      security: result.security!,
      tenants: result.tenants ?? [],
      activeTenantId: result.activeTenantId ?? '',
    });
    setStatus('authenticated');
    signalSettled();
    return 'authenticated';
  }, []);

  /**
   * Restores a session on load.
   *
   * The CSRF token is bootstrapped FIRST. Without it the login form cannot post,
   * and doing it here rather than in the login screen means a deep link straight
   * to a form still works.
   */
  useEffect(() => {
    let cancelled = false;
    const seq = ++requestSeq.current;

    (async () => {
      try {
        await bootstrapCsrf();
        const payload = await firmApi.session();
        if (cancelled || seq !== requestSeq.current) return;
        setSession(payload);
        setStatus('authenticated');
        signalSettled();
      } catch (err) {
        if (cancelled || seq !== requestSeq.current) return;
        // 401 is the normal "not signed in" answer, not an error to surface.
        if (err instanceof FirmApiError && err.status === 401) {
          setStatus('anonymous');
          signalSettled();
          return;
        }
        // A network failure at boot must not render as "signed out": the member
        // may well have a valid session, and clearing the UI would be wrong.
        setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'Unable to reach the server'));
        setStatus('error');
        signalSettled();
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const permissions = useMemo(
    () => new Set(session?.member.permissions ?? []),
    [session],
  );

  const nav = useMemo(
    () => (session ? visibleNav(session.member.permissions) : EMPTY_NAV),
    [session],
  );

  const can = useCallback((code: string) => permissions.has(code), [permissions]);
  const canAny = useCallback(
    (codes: readonly string[]) => codes.some((c) => permissions.has(c)),
    [permissions],
  );

  const signIn = useCallback(async (email: string, password: string, remember = false) => {
    setError(null);
    try {
      // A fresh CSRF token: the one in the browser may predate a server restart.
      await bootstrapCsrf();
      const result = await firmApi.login(email.trim().toLowerCase(), password, remember);
      applyResult(result);
      return result;
    } catch (err) {
      const apiErr = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'Unable to reach the server');
      setError(apiErr);
      throw apiErr;
    }
  }, [applyResult]);

  const submitMfa = useCallback(async (code: string, remember = false) => {
    setError(null);
    try {
      const result = await firmApi.verifyMfa(code.trim(), remember);
      applyResult(result);
      return result;
    } catch (err) {
      const apiErr = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'Unable to reach the server');
      setError(apiErr);
      throw apiErr;
    }
  }, [applyResult]);

  const signOut = useCallback(async () => {
    try { await firmApi.logout(); }
    catch { /* A failed logout still clears local state; the session expires. */ }
    setSession(null);
    setMfaChallenge(null);
    setStatus('anonymous');
    // A fresh token for the next sign-in attempt.
    await bootstrapCsrf().catch(() => undefined);
  }, []);

  const switchTenant = useCallback(async (tenantId: string) => {
    setError(null);
    try {
      const result = await firmApi.switchTenant(tenantId);
      applyResult(result);
      // The permission set is tenant-scoped, so the full session (including
      // settings and branding) has to be re-read rather than reused.
      const full = await firmApi.session();
      setSession(full);
    } catch (err) {
      const apiErr = err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'Unable to reach the server');
      setError(apiErr);
      throw apiErr;
    }
  }, [applyResult]);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const payload = await firmApi.session();
      if (seq !== requestSeq.current) return;
      setSession(payload);
      setStatus('authenticated');
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err instanceof FirmApiError && err.status === 401) {
        setSession(null);
        setStatus('anonymous');
        return;
      }
      setError(err instanceof FirmApiError ? err : new FirmApiError(0, 'network_error', 'Unable to reach the server'));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<FirmSessionValue>(() => {
    const member = session?.member ?? null;
    return {
      status,
      session,
      error,
      permissions,
      nav,
      can,
      canAny,
      member,
      displayName: member?.displayName ?? '',
      displayNameAr: member?.displayNameAr ?? null,
      practiceAreas: member?.practiceAreas ?? [],
      firmWideScope: member?.firmWideScope ?? false,
      ceilings: member?.ceilings ?? null,
      tenants: session?.tenants ?? [],
      activeTenantId: session?.activeTenantId ?? null,
      mfaEnabled: session?.security.mfaEnabled ?? false,
      mfaVerified: session?.security.mfaVerified ?? false,
      mfaChallenge,
      signIn,
      submitMfa,
      signOut,
      switchTenant,
      refresh,
      clearError,
    };
  }, [
    status, session, error, permissions, nav, can, canAny, mfaChallenge,
    signIn, submitMfa, signOut, switchTenant, refresh, clearError,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFirmSession(): FirmSessionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFirmSession() must be used inside <FirmSessionProvider>');
  return ctx;
}

/**
 * Convenience for screens that only need the permission checks.
 *
 * Kept separate from useFirmSession so a deeply-nested presentational component
 * does not re-render when unrelated session fields change.
 */
export function useCan() {
  const { can, canAny, permissions } = useFirmSession();
  return useMemo(() => ({ can, canAny, permissions }), [can, canAny, permissions]);
}

export type { MatterAccessLevel };

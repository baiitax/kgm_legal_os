/**
 * Authentication state.
 *
 * The provider holds exactly what the server told it and nothing more. There is
 * no client-side role, no cached permission list and no "isAdmin" flag: every
 * screen re-reads from the API, and the API re-resolves authorization from the
 * session cookie on each request. If a cookie is revoked server-side, the next
 * call 401s and this provider clears the UI.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { get, post, setUnauthorizedHandler, ApiError } from './api/client';
import type { BootstrapResponse, LoginResponse, SessionResponse } from './api/types';
import { useI18n } from './i18n';

interface AuthValue {
  /** Public configuration: password policy, upload limits, product names. */
  boot: BootstrapResponse | null;
  session: SessionResponse;
  /** True until the first bootstrap + session round-trip has settled. */
  loading: boolean;
  error: unknown;
  signedIn: boolean;
  /** Second-factor step in progress, when the server asked for one. */
  mfa: { method: string; maskedDestination?: string; expiresInMinutes?: number } | null;
  signIn: (email: string, password: string, remember: boolean) => Promise<LoginResponse>;
  submitMfa: (code: string, recovery?: boolean) => Promise<LoginResponse>;
  resendMfa: () => Promise<void>;
  cancelMfa: () => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

const ANONYMOUS: SessionResponse = { authenticated: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const { setLang, setCalendar } = useI18n();
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [session, setSession] = useState<SessionResponse>(ANONYMOUS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [mfa, setMfa] = useState<AuthValue['mfa']>(null);
  const [nonce, setNonce] = useState(0);

  /**
   * Bootstrap first: it is what issues the CSRF cookie, so every subsequent
   * state-changing request depends on it having run.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await get<BootstrapResponse>('/api/auth/bootstrap');
      setBoot(b);
      if (b.authenticated) {
        const s = await get<SessionResponse>('/api/auth/session');
        setSession(s);
        if (s.preferences) {
          setLang(s.preferences.language);
          setCalendar(s.preferences.calendar);
        }
      } else {
        setSession(ANONYMOUS);
      }
    } catch (err) {
      // A failed bootstrap means the SPA cannot do anything at all: no CSRF
      // token, no policy. Surface it rather than rendering a broken shell.
      setError(err);
      setSession(ANONYMOUS);
    } finally {
      setLoading(false);
    }
  }, [setLang, setCalendar]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  // Any 401, from any screen, ends the local session immediately.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(ANONYMOUS);
      setMfa(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const adopt = useCallback(
    (res: LoginResponse) => {
      setSession({
        authenticated: true,
        user: res.user
          ? { ...res.user, portalRole: 'client_primary' }
          : undefined,
        preferences: res.preferences,
      });
      if (res.preferences) {
        setLang(res.preferences.language);
        setCalendar(res.preferences.calendar);
      }
      // The login response carries the authoritative session, including the
      // portal role and expiry. Reading it back keeps state in one place.
      void get<SessionResponse>('/api/auth/session').then((s) => {
        setSession(s);
        if (s.preferences) {
          setLang(s.preferences.language);
          setCalendar(s.preferences.calendar);
        }
      }).catch(() => undefined);
    },
    [setLang, setCalendar],
  );

  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const res = await post<LoginResponse>('/api/auth/login', { email, password, remember });
    if (res.step === 'mfa') {
      setMfa({
        method: res.method ?? 'totp',
        maskedDestination: res.maskedDestination,
        expiresInMinutes: res.expiresInMinutes,
      });
      return res;
    }
    if (res.step === 'authenticated') {
      setMfa(null);
      adopt(res);
    }
    return res;
  }, [adopt]);

  const submitMfa = useCallback(async (code: string, recovery = false) => {
    const res = await post<LoginResponse>('/api/auth/mfa/verify', recovery ? { recoveryCode: code } : { code });
    if (res.step === 'authenticated') {
      setMfa(null);
      adopt(res);
    }
    return res;
  }, [adopt]);

  const resendMfa = useCallback(async () => {
    await post<{ sent: boolean }>('/api/auth/mfa/resend', {});
  }, []);

  const signOut = useCallback(async () => {
    try {
      await post<{ signedOut: boolean }>('/api/auth/logout', {});
    } catch (err) {
      // Signing out must always leave the UI signed out, even if the call fails.
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setSession(ANONYMOUS);
      setMfa(null);
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      boot,
      session,
      loading,
      error,
      signedIn: session.authenticated === true,
      mfa,
      signIn,
      submitMfa,
      resendMfa,
      cancelMfa: () => setMfa(null),
      signOut,
      refresh: load,
      retry: () => setNonce((n) => n + 1),
    }),
    [boot, session, loading, error, mfa, signIn, submitMfa, resendMfa, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

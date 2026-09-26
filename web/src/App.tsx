/**
 * Application shell and routing.
 *
 * Route guards here are a CONVENIENCE, not a control: hiding a link from an
 * unauthenticated visitor saves them a failed request, and the server refuses
 * the request anyway if they navigate there directly. Nothing in this file is
 * load-bearing for security.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { get } from './api/client';
import { I18nProvider, useI18n } from './i18n';
import { Icon, PageLoader } from './components/ui';
import { LanguageToggle } from './components/LanguageToggle';
import { Sidebar, TabBar, TopBar, useCapability } from './shell';
import { DETAIL_ITEMS, DESTINATIONS, capabilitiesFor } from './nav';

const Login = lazy(() => import('./pages/Login'));
const Invite = lazy(() => import('./pages/Invite'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Matters = lazy(() => import('./pages/Matters'));
const MatterDetail = lazy(() => import('./pages/MatterDetail'));
const Hearings = lazy(() => import('./pages/Hearings'));
const Deadlines = lazy(() => import('./pages/Deadlines'));
const Documents = lazy(() => import('./pages/Documents'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Receipts = lazy(() => import('./pages/Receipts'));
const Messages = lazy(() => import('./pages/Messages'));
const Thread = lazy(() => import('./pages/Thread'));
const Appointments = lazy(() => import('./pages/Appointments'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Security = lazy(() => import('./pages/Security'));
const Privacy = lazy(() => import('./pages/Privacy'));
const NotFound = lazy(() => import('./pages/NotFound'));

function BrandMark({ small }: { small?: boolean }) {
  return (
    <div className={small ? 'brand-mark brand-mark--sm' : 'brand-mark'} aria-hidden="true">
      <Icon name="scale" size={small ? 20 : 28} />
    </div>
  );
}

/**
 * The unread count is polled rather than pushed: there is no websocket, so the
 * portal stays a plain request/response app with no extra attack surface. The
 * interval is deliberately gentle.
 *
 * It lives here, beside the shell, because three surfaces now read it — the
 * desktop sidebar's orientation badge would be a fourth, and one number read
 * four times is one number.
 */
function useUnread(signedIn: boolean): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!signedIn) {
      setUnread(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      const res = await get<{ unreadCount: number }>('/api/client/notifications').catch(() => null);
      if (alive && res) setUnread(Number(res.unreadCount ?? 0));
    };
    void tick();
    const id = window.setInterval(() => void tick(), 60_000);
    const onFocus = () => void tick();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [signedIn]);
  return unread;
}

export function Shell({ children }: { children: ReactNode }) {
  const { signedIn } = useAuth();
  const location = useLocation();
  const unread = useUnread(signedIn);
  /*
    A contact must not land on a screen they cannot use. The account surfaces
    are the holder's, and the guard turns a typed URL into a sentence rather
    than a page that loads and then fails — the server refuses the request
    either way, which is what actually protects it.
  */
  const { has } = useCapability();

  // Scroll to the top on navigation: a long matter page should not open halfway.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <div className="app">
      {signedIn && <Sidebar />}
      {signedIn && <TopBar unread={unread} />}
      <main className="main" id="main">
        {signedIn && !has('billing') && isBillingPath(location.pathname)
          ? <HolderOnly />
          : children}
      </main>
      {signedIn && <TabBar unread={unread} path={location.pathname} />}
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { signedIn, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!signedIn) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function RequireAnonymous({ children }: { children: ReactNode }) {
  const { signedIn, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (signedIn) return <Navigate to="/portal" replace />;
  /*
    The language switch is rendered HERE rather than inside each page, because
    the reader who needs it most is the one who cannot read the current
    interface language — and if it lived in the pages, a new anonymous screen
    would silently ship without it. This wraps sign-in, invitation acceptance,
    forgot-password and reset-password alike.
  */
  return (
    <>
      <div className="auth-lang">
        <LanguageToggle />
      </div>
      {children}
    </>
  );
}

function BootFailure() {
  const { t, errorText } = useI18n();
  const { error, retry } = useAuth();
  const code = (error as { code?: string })?.code ?? 'network_error';
  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__head">
          <BrandMark />
          <h1>{t('app.portal')}</h1>
        </div>
        <div className="auth__body">
          <div className="alert alert--error" role="alert">
            <Icon name="alert" size={18} />
            <div className="alert__body">{errorText(code)}</div>
          </div>
          <button className="btn btn--primary btn--block" onClick={retry}>
            <Icon name="refresh" size={16} />
            {t('common.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The screens, keyed by the nav model's ids.
 *
 * `DESTINATIONS` is the list; this map is only "which component answers", and
 * the parity between the two is enforced by the type on the map — a nav entry
 * without a screen, or a screen without a nav entry, is a compile error rather
 * than a page nobody can reach. That is the defect this replaced: the portal
 * held a nav array and a route table as two independent literals, and nine of
 * fourteen destinations were reachable only on a desktop.
 */
const SCREENS: Record<string, ComponentType> = {
  dashboard: Dashboard,
  notifications: Notifications,
  messages: Messages,
  thread: Thread,
  matters: Matters,
  matter: MatterDetail,
  documents: Documents,
  hearings: Hearings,
  deadlines: Deadlines,
  appointments: Appointments,
  profile: Profile,
  security: Security,
  privacy: Privacy,
  invoices: Invoices,
  invoice: InvoiceDetail,
  receipts: Receipts,
};

/** The exact shape of a nav path, as a react-router pattern. */
const asRoute = (to: string) => to.replace(/:id$/, ':id');

function AppRoutes() {
  const { loading, error } = useAuth();
  if (loading) return <PageLoader />;
  if (error) return <BootFailure />;

  return (
    <Routes>
      <Route path="/login" element={<RequireAnonymous><Login /></RequireAnonymous>} />
      <Route path="/invite/accept" element={<RequireAnonymous><Invite /></RequireAnonymous>} />
      <Route path="/forgot-password" element={<RequireAnonymous><ForgotPassword /></RequireAnonymous>} />
      <Route path="/reset-password" element={<RequireAnonymous><ResetPassword /></RequireAnonymous>} />

      {/*
        Every destination the nav model declares, in the model's order, guarded
        by the capability the model assigns it. A detail path is governed by the
        same capability as its list (`/portal/matters/:id` is `work` because
        `/portal/matters` is) — which is why the model states the capability once
        per screen rather than once per URL.
      */}
      {DESTINATIONS.concat(DETAIL_ITEMS).map((item) => {
        const Screen = SCREENS[item.id];
        if (!Screen) throw new Error(`nav entry '${item.id}' has no screen`);
        return (
          <Route
            key={item.to}
            path={asRoute(item.to)}
            element={<RequireAuth><RequireCapability capability={item.capability}><Screen /></RequireCapability></RequireAuth>}
          />
        );
      })}

      <Route path="/" element={<Navigate to="/portal" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * The client-side half of the role rule.
 *
 * It says WHY in the reader's language instead of rendering a page whose every
 * request will 403, and it is explicitly not a control: the server refuses the
 * money surfaces itself (`requireAccountHolder` in the API), so a contact who
 * edits the URL, or calls the endpoint directly, is refused there.
 */
function RequireCapability({ capability, children }: { capability: string; children: ReactNode }) {
  const { role } = useCapability();
  if (!capabilitiesFor(role).has(capability as never)) return <HolderOnly />;
  return <>{children}</>;
}

function isBillingPath(path: string): boolean {
  return path.startsWith('/portal/invoices') || path.startsWith('/portal/receipts');
}

function HolderOnly() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="empty">
        <Icon name="lock" size={28} />
        <h2>{t('nav.group.finance')}</h2>
        <p>{t('nav.holderOnly')}</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <AuthProvider>
          <a className="skip-link" href="#main">
            <SkipLabel />
          </a>
          <Shell>
            <Suspense fallback={<PageLoader />}>
              <AppRoutes />
            </Suspense>
          </Shell>
        </AuthProvider>
      </BrowserRouter>
    </I18nProvider>
  );
}

function SkipLabel() {
  const { t } = useI18n();
  return <>{t('app.skip')}</>;
}

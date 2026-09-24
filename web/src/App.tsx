/**
 * Application shell and routing.
 *
 * Route guards here are a CONVENIENCE, not a control: hiding a link from an
 * unauthenticated visitor saves them a failed request, and the server refuses
 * the request anyway if they navigate there directly. Nothing in this file is
 * load-bearing for security.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { get, patch } from './api/client';
import { I18nProvider, useI18n } from './i18n';
import { Icon, PageLoader } from './components/ui';
import type { Lang } from './api/client';

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

/* --------------------------------------------------------------- nav model -- */
interface NavItem {
  to: string;
  labelKey: 'nav.dashboard' | 'nav.matters' | 'nav.hearings' | 'nav.deadlines'
    | 'nav.documents' | 'nav.invoices' | 'nav.receipts' | 'nav.messages'
    | 'nav.appointments' | 'nav.notifications' | 'nav.profile' | 'nav.security'
    | 'nav.privacy';
  icon: Parameters<typeof Icon>[0]['name'];
  badge?: number;
}

const NAV_GROUPS: Array<{ key: 'nav.group.main' | 'nav.group.matters' | 'nav.group.finance' | 'nav.group.account'; items: NavItem[] }> = [
  {
    key: 'nav.group.main',
    items: [
      { to: '/portal', labelKey: 'nav.dashboard', icon: 'home' },
      { to: '/portal/notifications', labelKey: 'nav.notifications', icon: 'bell' },
    ],
  },
  {
    key: 'nav.group.matters',
    items: [
      { to: '/portal/matters', labelKey: 'nav.matters', icon: 'folder' },
      { to: '/portal/hearings', labelKey: 'nav.hearings', icon: 'gavel' },
      { to: '/portal/deadlines', labelKey: 'nav.deadlines', icon: 'clock' },
      { to: '/portal/documents', labelKey: 'nav.documents', icon: 'doc' },
      { to: '/portal/messages', labelKey: 'nav.messages', icon: 'chat' },
      { to: '/portal/appointments', labelKey: 'nav.appointments', icon: 'calendar' },
    ],
  },
  {
    key: 'nav.group.finance',
    items: [
      { to: '/portal/invoices', labelKey: 'nav.invoices', icon: 'invoice' },
      { to: '/portal/receipts', labelKey: 'nav.receipts', icon: 'receipt' },
    ],
  },
  {
    key: 'nav.group.account',
    items: [
      { to: '/portal/profile', labelKey: 'nav.profile', icon: 'user' },
      { to: '/portal/security', labelKey: 'nav.security', icon: 'shield' },
      { to: '/portal/privacy', labelKey: 'nav.privacy', icon: 'lock' },
    ],
  },
];

/** The five destinations that earn a place on the mobile tab bar. */
const TABS: NavItem[] = [
  { to: '/portal', labelKey: 'nav.dashboard', icon: 'home' },
  { to: '/portal/matters', labelKey: 'nav.matters', icon: 'folder' },
  { to: '/portal/documents', labelKey: 'nav.documents', icon: 'doc' },
  { to: '/portal/invoices', labelKey: 'nav.invoices', icon: 'invoice' },
  { to: '/portal/profile', labelKey: 'nav.profile', icon: 'user' },
];

function LangToggle() {
  const { lang, setLang, t } = useI18n();
  const { session } = useAuth();
  const navigate = useNavigate();

  const apply = async (next: Lang) => {
    setLang(next);
    // Persisting is best-effort: the switch must feel instant even if the write
    // fails, and an unauthenticated visitor simply gets a local preference.
    if (session.authenticated) {
      await patch('/api/client/preferences', { language: next }).catch(() => undefined);
    }
    navigate(window.location.pathname);
  };

  return (
    <div className="lang-toggle" role="group" aria-label={t('a11y.langSwitch')}>
      <button type="button" aria-pressed={lang === 'ar'} onClick={() => void apply('ar')}>ع</button>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => void apply('en')}>EN</button>
    </div>
  );
}

function BrandMark({ small }: { small?: boolean }) {
  return (
    <div className={small ? 'brand-mark brand-mark--sm' : 'brand-mark'} aria-hidden="true">
      <Icon name="scale" size={small ? 20 : 28} />
    </div>
  );
}

function Sidebar() {
  const { t, fmt, lang } = useI18n();
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const user = session.user;
  const name = lang === 'ar' ? (user?.displayNameAr ?? user?.displayName) : user?.displayName;

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="sidebar__logo">
          <BrandMark />
          <div>
            <b>{t('app.name')}</b>
            <small>{t('app.portal')}</small>
          </div>
        </div>
        {user && (
          <div className="sidebar__who">
            <b>{name}</b>
            <span className="ltr">{user.email}</span>
            {session.security?.sessionExpiresAt && (
              <span>
                {t('auth.sessionEnding')} {fmt.relative(session.security.sessionExpiresAt)}
              </span>
            )}
          </div>
        )}
      </div>

      <nav className="sidebar__nav" aria-label={t('a11y.mainNav')}>
        {NAV_GROUPS.map((group) => (
          <div key={group.key}>
            <div className="sidebar__group">{t(group.key)}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/portal'}
                className="navlink"
              >
                <span className="navlink__icon"><Icon name={item.icon} size={17} /></span>
                {t(item.labelKey)}
                {item.badge ? <span className="navlink__badge">{item.badge}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__foot">
        <div className="row" style={{ marginBlockEnd: 10 }}>
          <LangToggle />
        </div>
        <button
          className="btn btn--ghost btn--sm btn--block"
          style={{ color: '#eaf1ee' }}
          onClick={async () => {
            await signOut();
            navigate('/login');
          }}
        >
          <Icon name="logout" size={15} />
          {t('nav.signOut')}
        </button>
      </div>
    </aside>
  );
}

function TopBar({ unread }: { unread: number }) {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const user = session.user;
  const name = lang === 'ar' ? (user?.displayNameAr ?? user?.displayName) : user?.displayName;

  return (
    <header className="topbar">
      <Link to="/portal" className="topbar__brand" aria-label={t('app.name')}>
        <BrandMark small />
        <span>{name ?? t('app.portal')}</span>
      </Link>
      <span className="topbar__spacer" />
      <LangToggle />
      <Link
        to="/portal/notifications"
        className="icon-btn"
        aria-label={t('a11y.notifications', { n: unread })}
        style={{ position: 'relative' }}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="tabbar__dot" />}
      </Link>
    </header>
  );
}

function TabBar({ unread }: { unread: number }) {
  const { t } = useI18n();
  return (
    <nav className="tabbar" aria-label={t('a11y.mainNav')}>
      {TABS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/portal'}>
          <Icon name={item.icon} size={20} />
          <span>{t(item.labelKey)}</span>
          {item.labelKey === 'nav.dashboard' && unread > 0 && <span className="tabbar__dot" />}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The unread count is polled rather than pushed: there is no websocket, so the
 * portal stays a plain request/response app with no extra attack surface. The
 * interval is deliberately gentle.
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

function Shell({ children }: { children: ReactNode }) {
  const { signedIn } = useAuth();
  const location = useLocation();
  const unread = useUnread(signedIn);

  // Scroll to the top on navigation: a long matter page should not open halfway.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <div className="app">
      {signedIn && <Sidebar />}
      {signedIn && <TopBar unread={unread} />}
      <main className="main" id="main">
        {children}
      </main>
      {signedIn && <TabBar unread={unread} />}
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
  return <>{children}</>;
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

      <Route path="/portal" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/portal/matters" element={<RequireAuth><Matters /></RequireAuth>} />
      <Route path="/portal/matters/:id" element={<RequireAuth><MatterDetail /></RequireAuth>} />
      <Route path="/portal/hearings" element={<RequireAuth><Hearings /></RequireAuth>} />
      <Route path="/portal/deadlines" element={<RequireAuth><Deadlines /></RequireAuth>} />
      <Route path="/portal/documents" element={<RequireAuth><Documents /></RequireAuth>} />
      <Route path="/portal/invoices" element={<RequireAuth><Invoices /></RequireAuth>} />
      <Route path="/portal/invoices/:id" element={<RequireAuth><InvoiceDetail /></RequireAuth>} />
      <Route path="/portal/receipts" element={<RequireAuth><Receipts /></RequireAuth>} />
      <Route path="/portal/messages" element={<RequireAuth><Messages /></RequireAuth>} />
      <Route path="/portal/messages/:id" element={<RequireAuth><Thread /></RequireAuth>} />
      <Route path="/portal/appointments" element={<RequireAuth><Appointments /></RequireAuth>} />
      <Route path="/portal/notifications" element={<RequireAuth><Notifications /></RequireAuth>} />
      <Route path="/portal/profile" element={<RequireAuth><Profile /></RequireAuth>} />
      <Route path="/portal/security" element={<RequireAuth><Security /></RequireAuth>} />
      <Route path="/portal/privacy" element={<RequireAuth><Privacy /></RequireAuth>} />

      <Route path="/" element={<Navigate to="/portal" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
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

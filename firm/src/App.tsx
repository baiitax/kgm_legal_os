/**
 * FIRM APP SHELL
 *
 * Composes the rail, topbar, bottom nav and routed content, and owns the three
 * decisions that belong at this level rather than inside a screen:
 *
 *   1 · Whether to render the shell at all. An anonymous member gets the sign-in
 *      screen with no chrome around it — a sidebar beside a login form implies the
 *      app is already open.
 *
 *   2 · The route guard. Every path is checked against the permission-filtered nav
 *      before its screen mounts (§50).
 *
 *   3 · Session expiry. When the server starts answering 401, the shell drops to
 *      sign-in rather than leaving a screen of stale data on display.
 *
 * RAIL STATE LIVES IN CSS, NOT IN REACT
 *   The collapsed/expanded preference is written to `data-rail` on <html> by
 *   AppRail, and the shell's grid reads that attribute instead of taking a prop.
 *   Toggling the rail therefore does not re-render the routed screen — a 60-row
 *   matters table re-rendering because a sidebar collapsed is the kind of cost
 *   that is invisible in a demo and obvious in use.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  BottomSheet, EmptyState, I18nProvider, IconLogout, PageSkeleton,
  ToastProvider, useI18n,
} from '@kgm/ui';
import { FirmSessionProvider, useFirmSession } from './auth/FirmSession.js';
import { ThemeProvider } from './app/theme.js';
import { AppRail } from './shell/AppRail.js';
import { Topbar } from './shell/Topbar.js';
import { BottomNav } from './shell/BottomNav.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { Users } from './pages/Users.js';
import { Audit } from './pages/Audit.js';
import { Settings } from './pages/Settings.js';
import { Denied, navigate, useGuard, useRoute } from './app/routes.js';
import { FIRM_I18N } from './i18n/dictionary.js';
import { SignIn } from './pages/SignIn.js';
import { Dashboard } from './pages/Dashboard.js';
import { Clients } from './pages/Clients.js';
import { Matters } from './pages/Matters.js';
import { MyWork } from './pages/MyWork.js';
import { MatterWorkspace } from './pages/MatterWorkspace.js';
import './shell/shell.css';

/** Sentinel the More sheet uses to request a sign-out through the shell. */
const SIGNOUT = '__signout';

/**
 * The root.
 *
 * Provider order follows dependency: theme and i18n depend on nothing, the session
 * reads neither, and toasts are innermost because a screen may want to announce a
 * session-state change.
 */
export function App() {
  return (
    <ThemeProvider>
      <I18nProvider
        bundle={FIRM_I18N}
        // Arabic-first (§ Arabic-first). The provider still prefers a stored
        // preference, then the browser's language, then this default.
        initialLang="ar"
        initialCalendar="islamic-umalqura"
      >
        <FirmSessionProvider>
          <ToastProvider anchor="top-end">
            <Shell />
          </ToastProvider>
        </FirmSessionProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

// ==========================================================================

function Shell() {
  const { t } = useI18n();
  const { status, signOut } = useFirmSession();
  const route = useRoute();
  const guard = useGuard(route.basePath);
  const [moreOpen, setMoreOpen] = useState(false);

  // One sign-out path, reachable from the topbar and from the More sheet. A
  // custom event keeps the sheet from having to receive the session context just
  // to forward a callback through two layers.
  useEffect(() => {
    const handler = () => { void signOut(); };
    window.addEventListener(SIGNOUT, handler);
    return () => window.removeEventListener(SIGNOUT, handler);
  }, [signOut]);

  const onNavigate = useCallback((to: string) => {
    if (to === SIGNOUT) {
      setMoreOpen(false);
      window.dispatchEvent(new Event(SIGNOUT));
      return;
    }
    setMoreOpen(false);
    navigate(to);
    /*
      A route change is the natural moment to move focus to the new page's
      heading. Without it, focus stays on the nav control that was just activated
      and the next Tab lands somewhere unrelated to the screen now on display —
      which for a keyboard user means the navigation and the content disagree
      about where they are.
    */
    window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>(
        '.firm-pagehead__title, .firm-matterhead__title',
      );
      if (!heading) return;
      // tabindex="-1" makes it focusable programmatically without adding a stop
      // to the tab order.
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    });
  }, []);

  // Anonymous: sign-in with no shell chrome around it.
  if (status === 'anonymous' || guard.kind === 'anonymous') {
    return <SignIn />;
  }

  // Session still resolving. The preloader in index.html is already on screen;
  // this replaces it with a skeleton of similar shape so there is no blank frame.
  if (status === 'loading' || guard.kind === 'loading') {
    return (
      <div className="firm-booting">
        <PageSkeleton title={t('app.tagline')} hint={t('boot.loading')} />
      </div>
    );
  }

  return (
    <div className="firm-shell">
      <AppRail path={route.basePath} onNavigate={onNavigate} />

      <Topbar onNavigate={onNavigate} onSignOut={() => window.dispatchEvent(new Event(SIGNOUT))} />

      <main className="firm-main" id="firm-main">
        {guard.kind === 'denied' ? (
          <Denied onNavigate={onNavigate} />
        ) : guard.kind === 'unknown' ? (
          <Denied onNavigate={onNavigate} unknown />
        ) : (
          <Routed basePath={route.basePath} onNavigate={onNavigate} />
        )}
      </main>

      <BottomNav path={route.basePath} onNavigate={onNavigate} onOpenMore={() => setMoreOpen(true)} />

      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={t('mobile.moreTitle')}>
        <MoreSheetBody onNavigate={onNavigate} />
      </BottomSheet>
    </div>
  );
}

// ==========================================================================

/**
 * The route table.
 *
 * A switch rather than a router library: there are a handful of real screens, and a
 * declarative route table would be more code than the routes it describes. If the
 * module count grows past a dozen this is the piece to replace — and it is the
 * only piece, because the guard and the nav are already separate from it.
 */
function Routed({ basePath, onNavigate }: { basePath: string; onNavigate: (to: string) => void }) {
  const matterMatch = basePath.match(/^\/matters\/([^/]+)$/);
  if (matterMatch) {
    return <MatterWorkspace matterId={decodeURIComponent(matterMatch[1])} onNavigate={onNavigate} />;
  }

  switch (basePath) {
    case '/':
      return <Dashboard onNavigate={onNavigate} />;
    case '/my-work':
      return <MyWork onNavigate={onNavigate} />;
    case '/clients':
      return <Clients onNavigate={onNavigate} />;
    case '/matters':
      return <Matters onNavigate={onNavigate} />;
    case '/admin/users':
      return <Users />;
    case '/admin/audit':
      return <Audit />;
    case '/admin/settings':
      return <Settings />;
    default:
      return <PlannedScreen onNavigate={onNavigate} />;
  }
}

/**
 * A permitted path with no screen yet.
 *
 * The guard already confirmed the member may route here, so this is not a denial —
 * it is an unbuilt module. `denied` would tell them they lack a permission they
 * hold; `unknown` would tell them the route does not exist when it does. Saying
 * "in development" is the only honest option.
 */
function PlannedScreen({ onNavigate }: { onNavigate: (to: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="firm-guard">
      <div className="firm-guard__inner">
        <EmptyState
          kind="empty"
          title={t('nav.planned')}
          description={t('common.notFound.body')}
          action={{ label: t('nav.dashboard'), onClick: () => onNavigate('/') }}
        />
      </div>
    </div>
  );
}

/**
 * The More sheet's body (§17).
 *
 * Built from the same permission-filtered nav the rail uses, so mobile and desktop
 * cannot disagree about what a member may reach.
 */
function MoreSheetBody({ onNavigate }: { onNavigate: (to: string) => void }) {
  const { t } = useI18n();
  const { nav } = useFirmSession();

  if (nav.groups.length === 0) {
    return (
      <div className="kgm-rail__empty">
        <p className="kgm-rail__emptytitle">{t('nav.noModules')}</p>
        <p className="kgm-rail__emptyhint">{t('nav.noModulesHint')}</p>
      </div>
    );
  }

  return (
    <div className="kgm-morelist">
      {/*
        Mobile parity for the language control. The topbar's compact toggle is
        present on phones too, but the More sheet is where a mobile member looks
        for settings-shaped controls, and omitting it there would make the toggle
        discoverable on desktop and effectively hidden on a phone.
      */}
      <div className="kgm-morelist__prefs">
        <p className="kgm-morelist__grouplabel">{t('topbar.language')}</p>
        <LanguageToggle />
      </div>

      {nav.groups.map(({ group, leaves }) => {
        const tiles = group.to
          ? [{ id: group.id, to: group.to, labelKey: group.labelKey, icon: group.icon, planned: false }]
          : leaves.map((l) => ({ id: l.id, to: l.to, labelKey: l.labelKey, icon: l.icon, planned: !!l.planned }));
        if (tiles.length === 0) return null;

        return (
          <div className="kgm-morelist__group" key={group.id}>
            {!group.to && <p className="kgm-morelist__grouplabel">{t(group.labelKey)}</p>}
            <div className="kgm-morelist__grid">
              {tiles.map((tile) => (
                <button
                  key={tile.id}
                  type="button"
                  className="kgm-morelist__item"
                  data-planned={tile.planned || undefined}
                  aria-disabled={tile.planned || undefined}
                  onClick={() => { if (!tile.planned) onNavigate(tile.to); }}
                >
                  <span className="kgm-morelist__icon" aria-hidden="true"><tile.icon size={20} /></span>
                  {t(tile.labelKey)}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {/* Sign out lives in the sheet on mobile. The profile drawer is itself a
          sheet at this width, so reaching sign-out through it would mean stacking
          two sheets for one action. */}
      <div className="kgm-morelist__group">
        <div className="kgm-morelist__grid">
          <button type="button" className="kgm-morelist__item" onClick={() => onNavigate(SIGNOUT)}>
            <span className="kgm-morelist__icon" aria-hidden="true"><IconLogout size={20} /></span>
            {t('auth.signOut')}
          </button>
        </div>
      </div>

      <p className="kgm-morelist__lang">{t('app.name')} · {t('app.tagline')}</p>
    </div>
  );
}

export type { ReactNode };

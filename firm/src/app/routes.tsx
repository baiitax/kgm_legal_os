/**
 * FIRM OS ROUTES · §50
 *
 * A hash router, and the reason is deployment rather than preference.
 *
 * The firm SPA is served by Express at /firm on the same origin as the API, which
 * is not optional: the session cookie is `path: '/'` with `SameSite=strict`, and
 * CSRF is a signed double-submit pair. Both require same-origin. A history router
 * under a path prefix would also require the server to rewrite every unknown
 * /firm/* URL back to index.html — one more fallback rule, ordered correctly
 * against the portal's own catch-all, on a server that already has two SPAs to
 * keep apart. A hash router needs exactly one static mount and cannot collide
 * with the portal's routes by construction.
 *
 * THE GUARD
 *   Every route is checked against the permission-filtered nav before it renders.
 *   This is the second half of §50: hiding a module from the rail is a courtesy,
 *   and a member who types `#/admin/audit` without `audit.read` must get a denial
 *   rather than a component that fires a request the server will refuse.
 *
 *   The guard and the rail read the SAME `nav.allowedPaths` set, derived in one
 *   place from the server's permission codes. Two independently-maintained lists
 *   — one for the menu, one for the routes — is how a hidden tab ends up
 *   reachable, or a visible tab ends up 404ing.
 *
 *   The guard is still not the control. The server enforces regardless. What the
 *   guard buys is that the interface never promises something the API will
 *   refuse, which is the difference between a permission system and a permission
 *   system with confusing error messages.
 */
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, useI18n } from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { isPathAllowed } from './nav.js';

/** Normalizes `location.hash` to a path. `#/matters/abc` → `/matters/abc`. */
export function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** Navigates by hash. Used instead of react-router so the app has one router. */
export function navigate(to: string): void {
  if (typeof window === 'undefined') return;
  const next = to.startsWith('/') ? to : `/${to}`;
  if (currentPath() === next) return;
  window.location.hash = next;
}

/** Subscribes to hash changes. Returns an unsubscribe. */
function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  // A popstate can also land on a different hash in some browsers.
  window.addEventListener('popstate', fn);
  return () => {
    window.removeEventListener('hashchange', fn);
    window.removeEventListener('popstate', fn);
  };
}

export interface RouteState {
  readonly path: string;
  /** The path with any `?query` removed. */
  readonly basePath: string;
  readonly query: URLSearchParams;
  navigate: (to: string) => void;
}

/**
 * Tracks the current route.
 *
 * Reads the hash synchronously on first render so a deep link paints the right
 * screen immediately rather than flashing the dashboard first.
 */
export function useRoute(): RouteState {
  const [path, setPath] = useState<string>(() => currentPath());

  useEffect(() => subscribe(() => setPath(currentPath())), []);

  // Keep the document title in step with the route. A browser tab that says
  // "Dashboard" while showing a matter is a small thing that makes a multi-tab
  // workflow unusable.
  useEffect(() => {
    document.title = titleFor(path);
  }, [path]);

  const split = path.split('?');
  const basePath = split[0] || '/';
  const query = new URLSearchParams(split[1] ?? '');

  return { path, basePath, query, navigate };
}

function titleFor(path: string): string {
  const base = 'KGM LEGAL OS';
  if (path.startsWith('/matters/')) return `${base} · Matter`;
  if (path.startsWith('/matters')) return `${base} · Matters`;
  if (path.startsWith('/admin/audit')) return `${base} · Audit`;
  return `${base} · Workspace`;
}

// ==========================================================================
// GUARD
// ==========================================================================

export type GuardResult =
  | { kind: 'allow' }
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'denied' }
  | { kind: 'unknown' };

/**
 * Resolves whether a path may render.
 *
 * `unknown` is distinct from `denied`: an unrouted path is a broken link or a
 * stale bookmark, and telling a member "not authorized" for a typo would be a
 * false statement about their permissions.
 */
/**
 * A hook, not a plain function: it reads the session and therefore must only be
 * called unconditionally at the top of a component. Naming it `useGuard` is what
 * lets the rules-of-hooks lint rule enforce that.
 */
export function useGuard(path: string): GuardResult {
  const { status, nav } = useFirmSession();

  if (status === 'loading') return { kind: 'loading' };
  if (status !== 'authenticated') return { kind: 'anonymous' };

  const base = path.split('?')[0] || '/';

  // Root is always allowed for an authenticated member: the dashboard has an
  // empty permission list by design.
  if (base === '/') return { kind: 'allow' };

  // The matter workspace is governed by /matters. A member who may list matters
  // may open one; whether they may SEE it is the server's answer per matter, and
  // the workspace renders `denied` from a 404 rather than pre-judging it here.
  if (isPathAllowed(nav.allowedPaths, base)) return { kind: 'allow' };

  // Distinguish "a route that exists but you may not" from "no such route" so the
  // two render differently. Only paths the app actually defines are known.
  return KNOWN_PREFIXES.some((p) => base === p || base.startsWith(`${p}/`))
    ? { kind: 'denied' }
    : { kind: 'unknown' };
}

/**
 * Route prefixes this app defines.
 *
 * Deliberately the FULL set, including modules the member may not have: the guard
 * needs to know a path is a real destination in order to say "denied" rather than
 * "not found". This list authorizes nothing — `nav.allowedPaths` does that.
 */
const KNOWN_PREFIXES: readonly string[] = [
  '/', '/my-work', '/tasks', '/calendar', '/notifications',
  '/clients', '/matters', '/hearings', '/deadlines', '/documents',
  '/contracts', '/poa', '/billing', '/time', '/expenses', '/collections',
  '/conflicts', '/licences', '/training', '/complaints', '/messages',
  '/admin/users', '/admin/teams', '/admin/settings', '/admin/audit',
];

/**
 * The denial screen.
 *
 * Shared by the route guard and by screens that receive a 403, so a member sees
 * one consistent answer to "you may not" regardless of which layer produced it.
 */
export function Denied({ onNavigate, unknown = false }: { onNavigate: (to: string) => void; unknown?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="firm-guard">
      <div className="firm-guard__inner">
        <EmptyState
          kind={unknown ? 'empty' : 'denied'}
          title={unknown ? t('common.notFound.title') : t('common.denied.title')}
          description={unknown ? t('common.notFound.body') : t('common.denied.body')}
          action={{ label: t('nav.dashboard'), onClick: () => onNavigate('/') }}
        />
      </div>
    </div>
  );
}

/** Convenience for imperative navigation from anywhere in the app. */
export function useNavigate() {
  return useCallback((to: string) => navigate(to), []);
}

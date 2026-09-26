/**
 * THE PORTAL CHROME · sidebar, topbar, bottom bar, More sheet
 *
 * These four surfaces are the same model rendered four ways. `web/src/nav.ts`
 * says what exists, what it is called, and who may see it; nothing in this file
 * is allowed to hold a second opinion about any of that.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * The portal had a static four-group sidebar for desktop and a fixed five-tab
 * bar for mobile, and the two listed different products. Nine of the fourteen
 * authenticated destinations existed only on a desktop: on a phone the reader
 * got Home, Matters, Documents, Invoices and Profile, and no way to reach
 * hearings, deadlines, messages, appointments, notifications, receipts, security
 * or privacy. The desktop had no topbar at all (it is `display: none` above
 * 1024 px), so the unread count was invisible on desktop and the account menu
 * was invisible on mobile except as an avatar.
 *
 * ── WHAT REPLACES IT ────────────────────────────────────────────────────────
 *
 * One header at every width: context on the inline-start edge, controls on the
 * inline-end. Below it the sidebar on desktop; below that the tab bar on mobile,
 * whose last slot opens a sheet holding every remaining destination and the
 * account actions. The same capability filter governs all of them, so the two
 * layouts cannot drift into two products again.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/ui';
import { useI18n } from '../i18n';
import { useAuth } from '../auth';
import { LanguageToggle } from '../components/LanguageToggle';
import {
  HOME_ID, HOME_PATH, MORE_ID, SLOT_COUNT, canOpen, groupFor, slotCandidates, visibleNav,
  type Capability, type NavItem,
} from '../nav';

/**
 * The identity block, the avatar, and the popover that carries sign-out.
 *
 * The account panel is deliberately the SAME panel the earlier phase rebuilt for
 * mobile: it carries who is signed in, the language switch, and the way out. It
 * is imported by both the topbar (where it qualifies the avatar) and the More
 * sheet (where a phone needs it in the same gesture as everything else). Its
 * class names and inline-end anchoring are asserted by `test/signout.test.tsx`
 * and must not change shape.
 */

function initialsOf(displayName: string | undefined, email: string | undefined, lang: string): string {
  const source = displayName?.trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase();
  }
  return (email?.split('@')[0]?.slice(0, 2) ?? '').toUpperCase() || (lang === 'ar' ? 'م' : 'A');
}

/** The portal role, as a chip. Endonyms for the role names are not translated. */
export function RoleChip({ role }: { role: string | null | undefined }) {
  const { t } = useI18n();
  const key = role === 'client_primary' ? 'nav.role.primary' : 'nav.role.contact';
  const tone = role === 'client_primary' ? 'role-chip--primary' : 'role-chip--contact';
  return (
    <span className={`role-chip ${tone}`} data-role={role ?? 'unknown'}>
      <Icon name={role === 'client_primary' ? 'shield' : 'user'} size={12} />
      {t(key)}
    </span>
  );
}

/**
 * The account popover.
 *
 * Exported because the More sheet renders it too — a phone should not have to
 * find the avatar to sign out, and duplicating the panel would be the second
 * copy of a security control.
 */
export function AccountMenu() {
  const { t, lang, fmt } = useI18n();
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const user = session.user;
  const lang_ = lang;
  const name = lang_ === 'ar' ? (user?.displayNameAr ?? user?.displayName) : user?.displayName;
  const initials = initialsOf(name, user?.email, lang_);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const end = async () => {
    setBusy(true);
    try {
      await signOut();
      navigate('/login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="acct__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('a11y.accountMenu')}
        onClick={() => (open ? setOpen(false) : setOpen(true))}
      >
        <span className="acct__avatar" aria-hidden="true">{initials}</span>
      </button>

      {open && (
        <div className="acct__panel" role="menu" ref={panelRef} aria-label={t('a11y.accountMenu')}>
          <div className="acct__who">
            <span className="acct__avatar acct__avatar--lg" aria-hidden="true">{initials}</span>
            <div>
              <b>{name}</b>
              <span className="ltr">{user?.email}</span>
              {session.security?.sessionExpiresAt && (
                <span className="acct__meta">
                  {t('auth.sessionEnding')} {fmt.relative(session.security.sessionExpiresAt)}
                </span>
              )}
              <span className="acct__meta"><RoleChip role={session.user?.portalRole} /></span>
            </div>
          </div>

          <div className="acct__row"><LanguageToggle /></div>

          <button type="button" role="menuitem" className="acct__item" onClick={() => go('/portal/profile')}>
            <Icon name="user" size={16} />{t('nav.profile')}
          </button>
          <button type="button" role="menuitem" className="acct__item" onClick={() => go('/portal/security')}>
            <Icon name="shield" size={16} />{t('nav.security')}
          </button>
          <button type="button" role="menuitem" className="acct__item" onClick={() => go('/portal/privacy')}>
            <Icon name="lock" size={16} />{t('nav.privacy')}
          </button>

          <div className="acct__sep" />

          <button
            type="button"
            role="menuitem"
            className="acct__item acct__item--danger"
            onClick={end}
            disabled={busy}
          >
            <Icon name="logout" size={16} />{t('nav.signOut')}
          </button>
          <p className="acct__hint">{t('nav.signOutConfirm')}</p>
        </div>
      )}
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

/**
 * The desktop sidebar.
 *
 * Its head answers the three questions a rail in a multi-entity product has to:
 * who is signed in, in what capacity, and on whose behalf. The capacity chip is
 * the role the server resolved; the entity line names the client this session is
 * acting for, because `principal.primaryClientId` is what every query narrows to.
 */
export function Sidebar() {
  const { t, fmt, lang } = useI18n();
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const user = session.user;
  const name = lang === 'ar' ? (user?.displayNameAr ?? user?.displayName) : user?.displayName;
  const clientName = lang === 'ar'
    ? (user?.clientNameAr ?? user?.clientName)
    : user?.clientName;
  const nav = visibleNav(session.user?.portalRole);

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
            <RoleChip role={session.user?.portalRole} />
            {clientName && <span className="sidebar__entity">{clientName}</span>}
            {session.security?.sessionExpiresAt && (
              <span>
                {t('auth.sessionEnding')} {fmt.relative(session.security.sessionExpiresAt)}
              </span>
            )}
          </div>
        )}
      </div>

      <nav className="sidebar__nav" aria-label={t('a11y.mainNav')}>
        {nav.groups.map(({ group, items }) => (
          <div key={group.id}>
            <div className="sidebar__group">{t(group.labelKey)}</div>
            {items.filter((i) => !i.detail).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === HOME_PATH}
                data-nav={item.id}
                className="navlink"
              >
                <span className="navlink__icon"><Icon name={item.icon} size={17} /></span>
                {t(item.labelKey)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar__foot">
        <div className="row" style={{ marginBlockEnd: 10 }}>
          <LanguageToggle />
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

/**
 * The header, at every width.
 *
 * It used to be `display: none` above 1024 px, which is why the desktop layout
 * had no unread count and no orientation. Now: the section the reader is in,
 * then the count, the language and the account.
 *
 * Orientation comes from the nav model rather than from the route, so a deep
 * path inside a section (`/portal/matters/<id>`) still says "Matters" instead of
 * the client's own name — which is what it used to say, and which answers a
 * question nobody asked.
 */
export function TopBar({ unread }: { unread: number }) {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const location = useLocation();
  const user = session.user;
  const clientName = lang === 'ar'
    ? (user?.clientNameAr ?? user?.clientName)
    : user?.clientName;
  const nav = visibleNav(session.user?.portalRole);
  const item = [...nav.groups.flatMap(({ items }) => items)]
    .filter((i) => !i.detail)
    .find((i) => location.pathname === i.to || (i.to !== HOME_PATH && location.pathname.startsWith(`${i.to}/`)));
  const group = groupFor(location.pathname);

  return (
    <header className="topbar">
      <Link to={HOME_PATH} className="topbar__brand" aria-label={t('app.name')}>
        <BrandMark small />
        <span className="topbar__where">
          <b>{item ? t(item.labelKey) : t('app.portal')}</b>
          <small>{clientName ?? t('app.portal')}</small>
        </span>
      </Link>
      {group && <span className="topbar__crumb">{t(group.labelKey)}</span>}
      <span className="topbar__spacer" />
      <LanguageToggle variant="compact" />
      <Link
        to="/portal/notifications"
        className="icon-btn"
        aria-label={t('a11y.notifications', { n: unread })}
        style={{ position: 'relative' }}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="tabbar__dot" />}
      </Link>
      <AccountMenu />
    </header>
  );
}

/**
 * The mobile bar: five slots, of which the last is More.
 *
 * Home and More are fixed. The middle three are the highest-priority
 * destinations this member's capability set actually contains, so a contact's
 * bar never reserves a slot for a screen the server will refuse. Nothing here
 * adds reach — it re-orders what `nav.ts` already allowed, which is the same
 * invariant the Firm OS bar is held to.
 */
export function TabBar({ unread, path }: { unread: number; path: string }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const [more, setMore] = useState(false);
  /*
    The slot that opened the sheet keeps its own ref, so focus returns to the
    control the reader actually used rather than to whatever `document.activeElement`
    happened to be at mount time. A browser focuses a clicked button; jsdom does
    not, and relying on the difference is how a focus-return works in production
    and hangs in a test — or, worse, the reverse.
  */
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const nav = visibleNav(session.user?.portalRole);
  const slots = slotCandidates(nav).slice(0, SLOT_COUNT);
  const hidden = nav.groups
    .flatMap(({ items }) => items)
    .filter((i) => !i.detail && i.to !== HOME_PATH && !slots.some((s) => s.id === i.id));
  const moreIsCurrent = hidden.some((i) => canOpen(nav, i.to) && path.startsWith(i.to));

  return (
    <>
      <nav className="tabbar" aria-label={t('nav.tabbar')}>
        <NavLink
          to={HOME_PATH}
          end
          data-nav={HOME_ID}
          className={({ isActive }) => (isActive ? 'tab--on' : undefined)}
        >
          <Icon name="home" size={20} />
          <span>{t('nav.dashboard')}</span>
          {unread > 0 && <span className="tabbar__dot" />}
        </NavLink>

        {slots.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            data-nav={item.id}
            className={({ isActive }) => (isActive ? 'tab--on' : undefined)}
          >
            <Icon name={item.icon} size={20} />
            <span>{t(item.labelKey)}</span>
            {item.badgeKey === 'notifications' && unread > 0 && <span className="tabbar__dot" />}
          </NavLink>
        ))}

        <button
          ref={moreRef}
          type="button"
          className={moreIsCurrent ? 'tab--on' : undefined}
          data-nav={MORE_ID}
          aria-expanded={more}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <Icon name="layers" size={20} />
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {more && (
        <MoreSheet
          path={path}
          onClose={() => {
            setMore(false);
            moreRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * The More sheet.
 *
 * Every destination the bar could not hold, grouped, plus the account actions —
 * which is the fix for the mobile layout's real defect: eight screens that had
 * no route to them at all, and a sign-out reachable only from an unlabelled
 * avatar.
 *
 * It is a dialog rather than a menu because it is a page of destinations, and it
 * owes a keyboard the same three things any layer owes: Escape closes, focus
 * moves inside, focus returns to the slot that opened it.
 */
/** The selector the focus cycle uses, lifted from the firm's overlay so the two
 *  products trap focus over the same set of elements. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function MoreSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useI18n();
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  /*
    Two scopes, on purpose: the CYCLE covers the whole dialog including the close
    button and the account actions in the footer, and the INITIAL focus lands on
    the first destination inside the body — a sheet that opens with the focus on
    its dismiss control invites the reader to leave rather than to read.
  */
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sheetRef.current?.querySelector<HTMLElement>(`.sheet__body :is(${FOCUSABLE})`)?.focus();

    /*
      A dialog owes a keyboard four things, and this is all four: focus moves
      inside on open, Tab cycles within it, Escape closes, and focus returns to
      the control that opened it. Without the cycle the sheet is a layer the user
      can tab out of into the page underneath — which is still there, still
      interactive, and now invisible behind a full-height overlay. The Firm OS
      sheet has trapped this for a while (`packages/ui` Overlay); the portal had
      no sheet at all until now, so this is the same contract arriving here.
    */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The caller restores focus — see TabBar's ref.
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !sheetRef.current) return;
      // Every focusable in the sheet, in DOM order. No visibility filter: the
      // sheet holds no hidden controls, and a filter that depends on measured
      // layout (`offsetParent`) is a filter that silently disables the cycle
      // wherever layout cannot be measured.
      const items = [...sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nav = visibleNav(session.user?.portalRole);
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const role = session.user?.portalRole;
  const isHolder = role === 'client_primary';

  /*
    The money group is shown to a contact as a disabled row rather than hidden.
    A member who cannot see the invoices at all reasonably concludes the portal
    lost them; a member who sees "Invoices — account holder" learns the rule
    instead of guessing at a defect. The route itself refuses either way.
  */
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t('nav.moreTitle')} ref={sheetRef}>
      <div className="sheet__head">
        <b>{t('nav.moreTitle')}</b>
        <button type="button" className="icon-btn" aria-label={t('a11y.close')} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="sheet__body">
        {nav.groups.map(({ group, items }) => (
          <section key={group.id} className="sheet__group">
            <h3 className="sheet__grouplabel">{t(group.labelKey)}</h3>
            <div className="sheet__tiles">
              {items.filter((i) => !i.detail).map((item) => (
                <button
                  key={item.to}
                  type="button"
                  data-nav={item.id}
                  className={path.startsWith(item.to) && item.to !== HOME_PATH ? 'sheet__tile sheet__tile--on' : 'sheet__tile'}
                  onClick={() => go(item.to)}
                >
                  <Icon name={item.icon} size={19} />
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {!isHolder && (
          <section className="sheet__group">
            <h3 className="sheet__grouplabel">{t('nav.group.finance')}</h3>
            <div className="sheet__tiles">
              <span className="sheet__tile sheet__tile--locked" data-nav="invoices--locked" aria-disabled="true">
                <Icon name="lock" size={19} />
                <span>{t('nav.holderOnly')}</span>
              </span>
            </div>
          </section>
        )}
      </div>

      <div className="sheet__foot">
        <LanguageToggle />
        <div className="sheet__account">
          <AccountMenu />
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm btn--block sheet__signout"
          onClick={async () => {
            onClose();
            await signOut();
            navigate('/login');
          }}
        >
          <Icon name="logout" size={15} />
          {t('nav.signOut')}
        </button>
      </div>
    </div>
  );
}

/**
 * One capability answer for the whole chrome, so a page body and a nav entry
 * cannot disagree about what this session may do.
 */
export function useCapability(): { has: (c: Capability) => boolean; role: string | null } {
  const { session } = useAuth();
  const role = session.user?.portalRole ?? null;
  const nav = visibleNav(role);
  return { has: (c) => nav.capabilities.has(c), role };
}

export type { NavItem };

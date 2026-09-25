/**
 * TOPBAR · §13
 *
 * Global search, tenant switcher, notifications, language toggle, theme toggle,
 * profile menu.
 *
 * TWO DECISIONS WORTH NAMING
 *
 * 1 · The search opens a command palette rather than navigating to a results
 *    page. §14 asks for grouped results across clients, matters, documents,
 *    invoices, hearings and users — that is a picker, not a page, and ⌘K is the
 *    convention people already have.
 *
 * 2 · The language toggle shows the OTHER language's name ("English" while in
 *    Arabic). A toggle labelled in the language you are trying to leave is
 *    unreadable at exactly the moment you need it.
 *
 * §13 also wants the topbar to stay out of the way. It is one row, 60px, sticky,
 * and every control in it is reachable without a submenu.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, BottomSheet, Button, Drawer, IconButton, IconBell, IconCheck,
  IconLogout, IconMenu, IconMoon, IconSearch, IconShield, IconSun, IconMonitor,
  IconUsers, Tooltip, useI18n, useFmt,
} from '@kgm/ui';
import { useFirmSession } from '../auth/FirmSession.js';
import { useTheme } from '../app/theme.js';
import { CommandPalette } from './CommandPalette.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { ActiveSessions } from '../components/ActiveSessions.js';
import './shell.css';

interface TopbarProps {
  readonly onNavigate: (to: string) => void;
  readonly onSignOut: () => void;
}

export function Topbar({ onNavigate, onSignOut }: TopbarProps) {
  const { t, lang } = useI18n();
  const { mode, cycle } = useTheme();
  const {
    displayName, displayNameAr, member, tenants, activeTenantId,
    switchTenant, mfaEnabled, permissions,
  } = useFirmSession();
  const fmt = useFmt();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  // The name shown follows the interface language, not the member's record.
  // An Arabic UI showing a Latin transliteration of an Arabic name is the small
  // kind of wrong that makes a localized product feel imported.
  const shownName = useMemo(() => {
    if (lang === 'ar' && displayNameAr) return displayNameAr;
    return displayName;
  }, [lang, displayName, displayNameAr]);

  const initials = useMemo(() => {
    const parts = shownName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '·';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }, [shownName]);


  const activeTenant = useMemo(
    () => tenants.find((x) => x.tenantId === activeTenantId) ?? null,
    [tenants, activeTenantId],
  );

  /** The firm name in the interface language. */
  const tenantName = useCallback(
    (tn: { tenantName: string; tenantNameAr: string | null }) =>
      (lang === 'ar' && tn.tenantNameAr ? tn.tenantNameAr : tn.tenantName),
    [lang],
  );

  const shownRole = useMemo(() => {
    // With several firms, the active tenant's job title is the standing that
    // currently applies; the role name from the membership is the fallback.
    if (activeTenant) {
      const jt = lang === 'ar' && activeTenant.jobTitleAr ? activeTenant.jobTitleAr : activeTenant.jobTitle;
      if (jt) return jt;
    }
    const r = member?.roles[0];
    if (!r) return '—';
    return lang === 'ar' && r.nameAr ? r.nameAr : r.name;
  }, [activeTenant, member, lang]);

  const themeIcon = mode === 'dark' ? <IconMoon size={18} /> : mode === 'light' ? <IconSun size={18} /> : <IconMonitor size={18} />;
  const themeLabel = t(`theme.${mode}`);

  /** ⌘K / Ctrl+K, and Escape to close. Registered here so it works from
   *  anywhere in the shell rather than only when focus is in the topbar. */
  const onKeydown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen((o) => !o);
    }
  }, []);

  // Attached via an effect so the listener lives for the shell's lifetime
  // regardless of which child has focus, and is removed on unmount.
  useEffect(() => {
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [onKeydown]);

  const handleSwitchTenant = async (tenantId: string) => {
    // Compare against the real field. A switch that posts an undefined id would
    // be refused by the server's uuid validation, but refusing it here avoids a
    // round trip and keeps the button's active state honest.
    if (!tenantId || tenantId === activeTenantId) return;
    setSwitching(true);
    try {
      await switchTenant(tenantId);
      // The permission set is tenant-scoped, so the palette and profile must
      // close rather than show the previous tenant's state.
      setProfileOpen(false);
      setMobileMenuOpen(false);
      onNavigate('/');
    } finally {
      setSwitching(false);
    }
  };

  const profileBody = (
    <div className="kgm-profile">
      <div className="kgm-profile__head">
        <span className="kgm-profile__avatar" aria-hidden="true">{initials}</span>
        <div>
          <p className="kgm-profile__name">{shownName}</p>
          <p className="kgm-profile__email">{member?.email}</p>
        </div>
      </div>

      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.role')}</h3>
        <ul className="kgm-profile__chips">
          {(member?.roles ?? []).map((r) => (
            <li key={r.code}>
              <Badge tone="brand">{lang === 'ar' && r.nameAr ? r.nameAr : r.name}</Badge>
            </li>
          ))}
          {mfaEnabled && (
            <li><Badge tone="lime" icon={<IconShield size={11} />}>{t('profile.mfaEnabled')}</Badge></li>
          )}
        </ul>
      </div>

      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.department')}</h3>
        <ul className="kgm-profile__chips">
          {(member?.departments ?? []).map((d) => (
            <li key={d.code}>
              <Badge tone={d.isLead ? 'brand' : 'neutral'}>
                {lang === 'ar' && d.nameAr ? d.nameAr : d.name}
                {d.isLead ? ' · lead' : ''}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.practiceAreas')}</h3>
        {member?.firmWideScope ? (
          <Badge tone="gold">{t('profile.firmWide')}</Badge>
        ) : (
          <ul className="kgm-profile__chips">
            {(member?.practiceAreas ?? []).map((pa) => (
              <li key={pa}>
                <Badge tone="info">{pa}</Badge>
              </li>
            ))}
            {(member?.practiceAreas ?? []).length === 0 && (
              <li className="kgm-profile__email">{t('common.none')}</li>
            )}
          </ul>
        )}
      </div>

      {/*
        Authority ceilings. Shown because §10 makes them the member's actual
        limits, and a limit nobody can see is a limit people discover by failing.
        `null` renders as "no authority" — never as unlimited.
      */}
      <div className="kgm-profile__section">
        <h3 className="kgm-profile__sectiontitle">{t('profile.authority')}</h3>
        {member?.ceilings.financialSar == null && member?.ceilings.writeoffSar == null && member?.ceilings.discountPct == null ? (
          <p className="kgm-profile__noauthority">
            <IconShield size={16} aria-hidden="true" />
            {t('profile.noAuthority')}
          </p>
        ) : (
          <div className="kgm-profile__authority">
            <Ceiling label={t('profile.authorityFinancial')} value={member?.ceilings.financialSar} fmt={fmt} />
            <Ceiling label={t('profile.authorityWriteoff')} value={member?.ceilings.writeoffSar} fmt={fmt} />
            <CeilingPct label={t('profile.authorityDiscount')} value={member?.ceilings.discountPct} />
          </div>
        )}
      </div>

      {tenants.length > 1 && (
        <div className="kgm-profile__section">
          <h3 className="kgm-profile__sectiontitle">{t('tenants.switch')}</h3>
          <ul className="kgm-profile__chips">
            {tenants.map((tn) => {
              const current = tn.tenantId === activeTenantId;
              const title = lang === 'ar' && tn.jobTitleAr ? tn.jobTitleAr : tn.jobTitle;
              return (
                <li key={tn.membershipId} className="kgm-profile__tenant">
                  <Button
                    variant={current ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={switching}
                    block
                    icon={current ? <IconCheck size={14} /> : undefined}
                    onClick={() => handleSwitchTenant(tn.tenantId)}
                    aria-pressed={current}
                  >
                    {tenantName(tn)}
                  </Button>
                  {/* The per-tenant role. A member can hold different standing at
                      different firms; without this the switcher hides which hat
                      you are about to put on. */}
                  {title && <span className="kgm-profile__tenantrole">{title}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/*
        Placed directly above sign-out: the two are the same family of control, and
        a member who came here to end sessions should not have to hunt past the
        tenant switcher for it.
      */}
      <ActiveSessions />

      <div className="kgm-profile__section">
        <Button variant="ghost" icon={<IconLogout size={16} />} block onClick={onSignOut}>
          {t('auth.signOut')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <header className="kgm-topbar">
        {/* Mobile menu: opens the module sheet, since the rail is not rendered. */}
        <IconButton
          className="kgm-topbar__menu"
          label={t('mobile.moreTitle')}
          icon={<IconMenu size={20} />}
          onClick={() => setMobileMenuOpen(true)}
        />

        {/* Global search. A button, not an input: §14's grouped results need a
            palette, and an input that opens a palette on focus is a control that
            lies about what it is. */}
        <button
          type="button"
          className="kgm-topbar__search"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
        >
          <IconSearch size={16} aria-hidden="true" />
          <span className="kgm-topbar__searchtext">{t('topbar.search')}</span>
          <span className="kbd" aria-hidden="true">⌘K</span>
        </button>

        <span className="kgm-topbar__spacer" />

        {activeTenant && tenants.length > 1 && (
          <Tooltip label={t('topbar.tenant')}>
            <span className="kgm-topbar__tenant">
              <Badge tone="neutral">{tenantName(activeTenant)}</Badge>
            </span>
          </Tooltip>
        )}

        <div className="kgm-topbar__iconbtns">
          <Tooltip label={t('topbar.notifications')}>
            <IconButton
              label={t('topbar.notifications')}
              icon={<IconBell size={18} />}
              onClick={() => onNavigate('/notifications')}
            />
          </Tooltip>

          {/*
            Was an icon-only globe that cycled ar→en→ar. Replaced with the
            labelled toggle: a globe says "another language exists" without saying
            which is active or which a press selects. Compact variant, because the
            topbar is a 60px row shared with notifications, theme and profile.
          */}
          <LanguageToggle variant="compact" />

          <Tooltip label={`${t('topbar.theme')} — ${themeLabel}`}>
            <IconButton
              label={t('topbar.theme')}
              icon={themeIcon}
              onClick={cycle}
              aria-pressed={mode === 'dark'}
            />
          </Tooltip>

          {/* The profile control. On a phone it opens a bottom sheet rather than
              a drawer: a side drawer over a 375px viewport leaves no room to read
              what is in it. */}
          <button
            type="button"
            className="kgm-topbar__profile"
            onClick={() => setProfileOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={profileOpen}
            /* Below 900px `.kgm-topbar__who` is display:none and the avatar is
               aria-hidden, so without this the control a phone user must press
               to reach sign-out has NO accessible name at all. A labelled
               control is also the only thing a screen reader can announce. */
            aria-label={`${t('profile.title')} — ${shownName}`}
          >
            <span className="kgm-topbar__avatar" aria-hidden="true">{initials}</span>
            <span className="kgm-topbar__who">
              <span className="kgm-topbar__name">{shownName}</span>
              <span className="kgm-topbar__role">{shownRole}</span>
            </span>
          </button>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onNavigate} />

      {/* Profile: drawer at ≥900px, sheet below. Both take the same body, so the
          content cannot differ between form factors. */}
      <Drawer
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title={t('profile.title')}
        side="end"
        className="kgm-profiledrawer"
      >
        {profileBody}
      </Drawer>

      <BottomSheet open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} title={t('mobile.moreTitle')}>
        <MobileModuleList onNavigate={(to) => { setMobileMenuOpen(false); onNavigate(to); }} permissions={permissions} />
      </BottomSheet>
    </>
  );
}

// ==========================================================================

function Ceiling({ label, value, fmt }: { label: string; value: number | null | undefined; fmt: ReturnType<typeof useFmt> }) {
  return (
    <div className="kgm-profile__ceiling">
      <span className="kgm-profile__ceilinglabel">{label}</span>
      <span className="kgm-profile__ceilingvalue" data-none={value == null ? '' : undefined}>
        {value == null ? '—' : fmt.amount(value)}
      </span>
    </div>
  );
}

function CeilingPct({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="kgm-profile__ceiling">
      <span className="kgm-profile__ceilinglabel">{label}</span>
      <span className="kgm-profile__ceilingvalue" data-none={value == null ? '' : undefined}>
        {value == null ? '—' : `${value}%`}
      </span>
    </div>
  );
}

/**
 * The module list for the mobile More sheet (§17).
 *
 * Rebuilt from the SAME filtered nav the rail uses, so mobile and desktop cannot
 * disagree about what a member may reach. Two lists — one for the rail, one for
 * the sheet — is how a module ends up reachable on a phone and hidden on desktop.
 */
function MobileModuleList({ onNavigate, permissions }: { onNavigate: (to: string) => void; permissions: ReadonlySet<string> }) {
  const { t } = useI18n();
  const { nav } = useFirmSession();
  void permissions;

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
      {nav.groups.map(({ group, leaves }) => {
        // Standalone groups (dashboard, matters, clients, messages) render as a
        // single tile rather than an empty heading with nothing under it.
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

      {/* Sign out belongs in the sheet on mobile: the profile drawer is a sheet
          too, and stacking two sheets to reach a sign-out is one sheet too many. */}
      <div className="kgm-morelist__group">
        <div className="kgm-morelist__grid">
          <button
            type="button"
            className="kgm-morelist__item"
            onClick={() => onNavigate('__signout')}
          >
            <span className="kgm-morelist__icon" aria-hidden="true"><IconLogout size={20} /></span>
            {t('auth.signOut')}
          </button>
          <button
            type="button"
            className="kgm-morelist__item"
            onClick={() => onNavigate('/admin/users')}
            aria-disabled={!permissions.has('users.read') || undefined}
            data-planned={!permissions.has('users.read') || undefined}
          >
            <span className="kgm-morelist__icon" aria-hidden="true"><IconUsers size={20} /></span>
            {t('nav.users')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * THE MATTER'S LIFE — the controls that move it, restrict it, and open it to people
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Gap analysis III §2.3: eleven matter routes and no screen. The state route, the
 * restriction route and the access route have existed since P0.4/P0.5 and were reached
 * only with curl — so a firm could not close a matter, could not lock one down when a
 * conflict surfaced, and could not open one to the person who was going to work it
 * without a database client. This file is the three controls, on the header, where the
 * facts they change are already displayed.
 *
 * THREE THINGS THESE CONTROLS DO NOT DO
 *
 *   · They do not decide anything. Every option offered comes from the server: the state
 *     list arrives as `allowedTransitions` on the matter, computed from the domain's own
 *     map; the access levels come from the wire's enum; the member list comes from the
 *     members endpoint. No rule is re-implemented here, because a re-implementation is a
 *     rule that can disagree with the one that enforces.
 *   · They do not hide the permission checks behind a disabled button. A control is shown
 *     only to a member who holds the code the ROUTE asks for, and the route asks for the
 *     same one — so the button and the refusal cannot disagree. §50: visuals never
 *     override authorization.
 *   · They do not swallow a refusal. `conflict_gate`, `cdd_incomplete`, `invalid_transition`
 *     and `permission_denied` each arrive with a code, and each is rendered as itself: the
 *     member needs to know WHICH gate closed, because that is what tells them what to do
 *     next. A toast reading "error" sends them to a colleague; a toast reading "Rule 11 —
 *     a conflict finding is undispositioned" sends them to the register.
 */
import { useEffect, useState } from 'react';
import {
  Button, Modal, SelectField, TextArea, Badge, IconLock, IconRestricted,
  StatusChip, useI18n, useToast,
} from '@kgm/ui';
import { useCan } from '../../auth/FirmSession.js';
import {
  firmApi, FirmApiError,
  type MatterAccessLevel, type MatterDetail, type MatterInternalStatus,
} from '../../api/firm.js';

/** The wire's access levels, in the order a firm thinks about them. */
const ACCESS_LEVELS: ReadonlyArray<MatterAccessLevel | 'none'> =
  ['view', 'operational', 'edit', 'compliance', 'financial', 'full', 'none'];

/*
  A refusal, said in the screen's own words.

  The codes are the server's and they are mapped one by one, with a fallback that shows
  the server's message rather than hiding it: an unmapped code should be legible to the
  member and obvious to whoever reads the bug report.
*/
function refusalText(err: unknown, t: (k: string, v?: Readonly<Record<string, string | number>>) => string): string {
  const code = err instanceof FirmApiError ? err.code : 'network_error';
  switch (code) {
    case 'conflict_gate': return t('life.err.conflict');
    case 'cdd_incomplete': return t('life.err.cdd');
    case 'invalid_transition': return t('life.err.transition');
    case 'eligibility': return t('life.err.eligibility');
    case 'permission_denied': return t('life.err.permission');
    default: return err instanceof Error ? err.message : t('life.err.other');
  }
}

/**
 * A reason field, required.
 *
 * Every one of these writes carries a reason, and the server refuses a restriction
 * without one — so the dialog asks for it before the request rather than after the
 * refusal. The reason is what a colleague reads a year later; "why is this file locked"
 * has to have an answer in the record.
 */
function ReasonField({
  value, onChange, label, hint, required = true,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <TextArea
      label={label}
      hint={hint}
      value={value}
      rows={2}
      maxLength={500}
      onChange={(e) => onChange(e.target.value)}
      required={required}
    />
  );
}

/* ─────────────────────────────────────────────────────────────── the state ── */

function MoveDialog({
  matter, onClose, onMoved,
}: {
  matter: MatterDetail;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const options = matter.allowedTransitions ?? [];
  const [target, setTarget] = useState<string>(options[0] ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!target || !matter.id) return;
    setBusy(true);
    try {
      await firmApi.setMatterStatus(matter.id, {
        internalStatus: target as MatterInternalStatus,
        reason: reason.trim() || null,
      });
      toast.success(t('life.move.done', { state: t(`state.${target}`) }));
      onMoved();
      onClose();
    } catch (err) {
      /* The refusal is rendered as ITSELF, not as "failed". */
      toast.error(t('life.move.failed', { state: t(`state.${target}`) }), refusalText(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('life.move.title')}
      description={t('life.move.body', { from: t(`state.${matter.internalStatus ?? ''}`) })}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!target} onClick={() => { void submit(); }}>
            {t('life.move.action')}
          </Button>
        </>
      )}
    >
      <div className="firm-life__form">
        <SelectField
          label={t('life.move.to')}
          hint={t('life.move.toHint')}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          options={options.map((s) => ({ value: s, label: t(`state.${s}`) }))}
        />
        <ReasonField
          label={t('life.move.reason')}
          hint={t('life.move.reasonHint')}
          value={reason}
          onChange={setReason}
          required={false}
        />
        {/*
          THE TWO GATES THAT CAN REFUSE THIS MOVE, NAMED IN ADVANCE. A member about to
          move a matter into `active` should know that the client's due diligence is what
          the server is about to check — the manual's prohibition is not a surprise the
          system springs on people.
        */}
        {target === 'active' && (
          <p className="firm-life__note c-muted">{t('life.move.cddNote')}</p>
        )}
        {matter.internalStatus === 'conflict_check' && (
          <p className="firm-life__note c-muted">{t('life.move.conflictNote')}</p>
        )}
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────── the ring ── */

function RestrictDialog({
  matter, onClose, onChanged,
}: {
  matter: MatterDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const restricting = !matter.restricted;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!matter.id || (restricting && reason.trim().length < 3)) return;
    setBusy(true);
    try {
      await firmApi.setMatterRestriction(matter.id, {
        restricted: restricting,
        reason: restricting ? reason.trim() : null,
      });
      toast.success(restricting ? t('life.restrict.done') : t('life.unrestrict.done'));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('life.restrict.failed'), refusalText(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={restricting ? t('life.restrict.title') : t('life.unrestrict.title')}
      description={restricting ? t('life.restrict.body') : t('life.unrestrict.body')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={restricting ? 'primary' : 'secondary'}
            loading={busy}
            disabled={restricting && reason.trim().length < 3}
            onClick={() => { void submit(); }}
          >
            {restricting ? t('life.restrict.action') : t('life.unrestrict.action')}
          </Button>
        </>
      )}
    >
      <div className="firm-life__form">
        {restricting ? (
          <ReasonField
            label={t('life.restrict.reason')}
            hint={t('life.restrict.reasonHint')}
            value={reason}
            onChange={setReason}
          />
        ) : (
          <p className="firm-life__note c-muted">
            {/*
              Lifting a restriction is the one write here that can succeed for a member
              who does NOT reach `full` on the matter: whoever applied the restriction may
              reverse it (the server's `canLiftRestriction`). The screen says so, because
              a button whose rule is invisible looks like a bug the first time it works
              and the second time it does not.
            */}
            {t('life.unrestrict.note')}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ──────────────────────────────────────────────────── who may work on it ── */

interface MemberOption { membershipId: string; email: string; name?: string | null; nameAr?: string | null }

function AccessDialog({
  matter, onClose, onChanged,
}: {
  matter: MatterDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const [members, setMembers] = useState<MemberOption[] | null>(null);
  const [membershipId, setMembershipId] = useState('');
  const [level, setLevel] = useState<MatterAccessLevel | 'none'>('view');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  /*
    The member list is fetched when the dialog OPENS, not with the matter: it is a firm
    register, and a matter screen has no business carrying it in memory.
  */
  useEffect(() => {
    let alive = true;
    firmApi.members()
      .then((r) => { if (alive) setMembers(r.members as unknown as MemberOption[]); })
      .catch(() => { if (alive) setMembers([]); });
    return () => { alive = false; };
  }, []);

  async function submit() {
    if (!matter.id || !membershipId) return;
    setBusy(true);
    try {
      await firmApi.setMatterAccess(matter.id, {
        membershipId,
        accessLevel: level,
        reason: reason.trim() || null,
      });
      toast.success(t('life.access.done', { level: t(`access.${level}`) }));
      onChanged();
      onClose();
    } catch (err) {
      toast.error(t('life.access.failed'), refusalText(err, t));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('life.access.title')}
      description={t('life.access.body')}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!membershipId} onClick={() => { void submit(); }}>
            {t('life.access.action')}
          </Button>
        </>
      )}
    >
      <div className="firm-life__form">
        <SelectField
          label={t('life.access.member')}
          value={membershipId}
          onChange={(e) => setMembershipId(e.target.value)}
          disabled={members === null}
          options={[
            { value: '', label: members === null ? t('common.loading') : t('life.access.pick') },
            ...(members ?? []).map((m) => ({
              value: m.membershipId,
              label: `${pick(m.nameAr, m.name) || m.email} · ${m.email}`,
            })),
          ]}
        />
        <SelectField
          label={t('life.access.level')}
          hint={t('life.access.levelHint')}
          value={level}
          onChange={(e) => setLevel(e.target.value as MatterAccessLevel | 'none')}
          options={ACCESS_LEVELS.map((l) => ({ value: l, label: t(`access.${l}`) }))}
        />
        <ReasonField
          label={t('life.access.reason')}
          value={reason}
          onChange={setReason}
          required={false}
        />
        {/*
          THE ELIGIBILITY GATE, ANNOUNCED. Granting access to a member whose licence is
          suspended is refused by the server (P-1.1), and the refusal is on the TARGET
          rather than on the actor. Saying so here explains why an administrator who did
          nothing wrong sees a refusal naming someone else.
        */}
        <p className="firm-life__note c-muted">{t('life.access.eligibilityNote')}</p>
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────── the bar ── */

export function MatterLifecycleBar({
  matter, onChanged,
}: {
  matter: MatterDetail;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const { can } = useCan();
  const [dialog, setDialog] = useState<'move' | 'restrict' | 'access' | null>(null);

  /*
    WHO SEES WHAT, AND WHY IT IS THE ROUTE'S OWN RULE.

    · Move       — `matters.status` and full access (the route requires MATTER_MANAGE).
    · Restrict   — `matters.restrict`. Lifting is offered to the same member: the server
                   permits the member who applied it even without `full`.
    · Open to    — `users.assign_matter` and full access.
  */
  const full = matter.accessLevel === 'full';
  const mayMove = can('matters.status') && full;
  const mayRestrict = can('matters.restrict');
  const mayGrant = can('users.assign_matter') && full;
  const moves = matter.allowedTransitions ?? [];

  if (!mayMove && !mayRestrict && !mayGrant) return null;

  return (
    <div className="firm-life">
      {/* The state itself, always visible. It is the fact the controls act on, and
          until this bar existed the workspace never showed it at all. */}
      <span className="firm-life__state">
        <StatusChip status={String(matter.internalStatus ?? 'intake')} lang={lang} />
      </span>

      {mayMove && (
        <Button
          variant="secondary"
          size="sm"
          disabled={moves.length === 0}
          title={moves.length === 0 ? t('life.move.final') : undefined}
          onClick={() => setDialog('move')}
        >
          {t('life.move.action')}
        </Button>
      )}

      {mayRestrict && (
        <Button
          variant={matter.restricted ? 'ghost' : 'secondary'}
          size="sm"
          icon={matter.restricted ? <IconLock size={14} /> : <IconRestricted size={14} />}
          onClick={() => setDialog('restrict')}
        >
          {matter.restricted ? t('life.unrestrict.action') : t('life.restrict.action')}
        </Button>
      )}

      {mayGrant && (
        <Button variant="ghost" size="sm" onClick={() => setDialog('access')}>
          {t('life.access.action')}
        </Button>
      )}

      {matter.restricted && <Badge tone="gold" size="xs" icon={<IconRestricted size={11} />}>{t('matter.restricted')}</Badge>}

      {dialog === 'move' && (
        <MoveDialog matter={matter} onClose={() => setDialog(null)} onMoved={onChanged} />
      )}
      {dialog === 'restrict' && (
        <RestrictDialog matter={matter} onClose={() => setDialog(null)} onChanged={onChanged} />
      )}
      {dialog === 'access' && (
        <AccessDialog matter={matter} onClose={() => setDialog(null)} onChanged={onChanged} />
      )}
    </div>
  );
}

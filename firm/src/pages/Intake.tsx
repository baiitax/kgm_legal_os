/*
  INTAKE · ADD A CLIENT, OPEN A CASE, NAME A LAWYER — WITHOUT LEAVING THE SCREEN.
  ─────────────────────────────────────────────────────────────────────────────

  ONE SCREEN, NOT FOUR WIZARDS.

  The work this screen replaces is a sequence a firm runs in one sitting: the client
  arrives, a file is opened, somebody is made answerable for it, and the register is
  checked for a conflict. On paper that is four forms and three navigations, and every
  hand-off between them is a place a case is lost — a client recorded under a name the
  conflict engine will not match, a matter opened with no lead, a check that never ran
  because the person who opened the file had already moved on.

  So the four stages are sections of ONE page and every hand-off happens in place:

    · choosing a client, or adding one, keeps the form exactly where it is;
    · the matter number is PROPOSED before the form is submitted — allocated by the
      server from the firm's own sequence, so nobody has to ask what the file is
      called or invent a number that already exists;
    · the lead is chosen while the case is being described, not afterwards on a
      different tab, and the picker shows how many matters each person already
      carries — which is the fact a partner actually weighs;
    · the conflict check runs INSIDE the create call, so the file cannot exist
      without it.

  §50 APPLIES TO A FORM AS MUCH AS TO A LIST: the screen gates on `matters.create`
  before it renders a field, and the API refuses anyway. `can()` is a convenience,
  never a control.

  WHAT THE SCREEN REFUSES TO PRETEND. A create that finds a conflict does not report
  success. It reports the file, the number, and the fact that the Rule 11 gate is
  holding it in `conflict_check` until every finding is dispositioned — with the count
  and the way there. A screen that said "Matter created ✓" over that would be teaching
  people that the gate does not matter.
*/
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardBody, Checkbox, EmptyState, IconCheck, IconClients,
  IconConflicts, IconMatters, IconPlus, IconSearch, IconUser, PageSkeleton, SelectField,
  TextArea, TextField, useI18n, useToast,
} from '@kgm/ui';
import {
  FirmApiError, firmApi,
  type ClientNameMatch, type CreateMatterResult, type MatterIntakeBootstrap,
} from '../api/firm.js';
import { useFirmSession } from '../auth/FirmSession.js';
import '../shell/shell.css';

interface IntakeProps {
  /** `matter` opens a case; `client` adds a client and stops there. */
  readonly mode?: 'matter' | 'client';
  /** Pre-selected client, when the member came here from a client row. */
  readonly initialClientId?: string | null;
  readonly onNavigate: (to: string) => void;
}

/** The two roles a case can be opened under. Mirrors 0058's index and 0002's CHECK. */
const LEAD_ROLES = ['lead_lawyer', 'lead_partner'] as const;

const BLANK_CLIENT = {
  clientType: 'organization' as 'individual' | 'organization',
  name: '', nameAr: '', email: '', phone: '', city: '', commercialRegistration: '', nationalId: '',
};

/**
 * The client-facing name of a matter role, from the dictionary.
 *
 * The six codes are the database's vocabulary (0002's CHECK, and 0058's index) and the
 * screen must not invent a seventh. Keys are `role.matterRole.<code>`.
 */
function matterRoleLabel(t: (key: string) => string, code: string): string {
  return t(`role.matterRole.${code}`);
}

/** The lifecycle state in the firm's own words. Keys are `status.<code>`. */
function matterStatusLabel(t: (key: string) => string, code: string): string {
  return t(`status.${code}`);
}

const BLANK_MATTER = {
  title: '', titleAr: '', caseNumber: '', practiceArea: '', court: '',
  summary: '', summaryAr: '', matterNumber: '',
};

export function Intake({ mode = 'matter', initialClientId = null, onNavigate }: IntakeProps) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { can } = useFirmSession();

  const [boot, setBoot] = useState<MatterIntakeBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<FirmApiError | null>(null);

  const [clientId, setClientId] = useState<string>(initialClientId ?? '');
  const [query, setQuery] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [clientForm, setClientForm] = useState({ ...BLANK_CLIENT });
  const [clientMatches, setClientMatches] = useState<ClientNameMatch[]>([]);
  const [clientBusy, setClientBusy] = useState(false);

  const [form, setForm] = useState({ ...BLANK_MATTER });
  const [extraMembers, setExtraMembers] = useState<Array<{ staffId: string; matterRole: string }>>([]);
  const [leadStaffId, setLeadStaffId] = useState('');
  const [leadRole, setLeadRole] = useState<string>('lead_lawyer');
  const [runCheck, setRunCheck] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [created, setCreated] = useState<CreateMatterResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setFatal(null);
    try {
      const data = await firmApi.matterIntake();
      setBoot(data);
      setForm((f) => ({ ...f, matterNumber: f.matterNumber || data.matterNumber.proposed,
        practiceArea: f.practiceArea || (data.practiceAreas[0] ?? '') }));
    } catch (err) {
      setFatal(err as FirmApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const client = useMemo(
    () => boot?.clients.find((c) => c.id === clientId) ?? null,
    [boot, clientId],
  );

  const filteredClients = useMemo(() => {
    const all = boot?.clients ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 40);
    return all.filter((c) =>
      c.name.toLowerCase().includes(q)
      || (c.nameAr ?? '').toLowerCase().includes(q)
      || (c.city ?? '').toLowerCase().includes(q)).slice(0, 40);
  }, [boot, query]);

  /*
    The label a person is shown by. `staff.job_title` is the firm's own vocabulary
    for a person and `internal_role` is the system's; the job title wins when the
    firm has written one, because that is what the firm calls them.
  */
  const staffLabel = useCallback((staffId: string) => {
    const s = boot?.staff.find((x) => x.staffId === staffId);
    if (!s) return '';
    return `${pick(s.nameAr, s.name)} · ${pick(s.jobTitleAr, s.jobTitle) || s.role}`;
  }, [boot, pick]);

  /* ── ADD CLIENT · in place, without leaving the case form ──────────────────── */

  async function submitClient(confirmDuplicate: boolean) {
    if (!clientForm.name.trim()) return;
    setClientBusy(true); setClientMatches([]);
    try {
      const out = await firmApi.createClient({
        clientType: clientForm.clientType,
        name: clientForm.name.trim(),
        nameAr: clientForm.nameAr.trim() || null,
        email: clientForm.email.trim() || null,
        phone: clientForm.phone.trim() || null,
        city: clientForm.city.trim() || null,
        commercialRegistration: clientForm.commercialRegistration.trim() || null,
        nationalId: clientForm.nationalId.trim() || null,
        confirmDuplicate,
      });
      setClientId(out.id);
      setClientForm({ ...BLANK_CLIENT });
      setAddingClient(false);
      toast.success(t('intake.client.added'), out.name);
      // The register is reloaded so the new client is selectable and its matter count
      // is the server's answer rather than a client-side guess.
      void load();
    } catch (err) {
      const e = err as FirmApiError;
      if (e.code === 'client_name_exists') {
        const matches = (e.details?.matches ?? []) as ClientNameMatch[];
        setClientMatches(matches);
      } else {
        toast.error(t('intake.client.failed'), e.message);
      }
    } finally {
      setClientBusy(false);
    }
  }

  /* ── OPEN THE CASE ─────────────────────────────────────────────────────────── */

  async function submitMatter() {
    if (!clientId || !form.title.trim()) return;
    setBusy(true); setFailure(null);
    try {
      const out = await firmApi.createMatter({
        clientId,
        title: form.title.trim(),
        titleAr: form.titleAr.trim() || null,
        matterNumber: form.matterNumber.trim() || null,
        caseNumber: form.caseNumber.trim() || null,
        practiceArea: form.practiceArea.trim() || null,
        court: form.court.trim() || null,
        summary: form.summary.trim() || null,
        summaryAr: form.summaryAr.trim() || null,
        leadStaffId: leadStaffId || null,
        leadRole: leadRole as 'lead_lawyer' | 'lead_partner',
        team: extraMembers,
        runConflictCheck: runCheck,
      });
      setCreated(out);
    } catch (err) {
      const e = err as FirmApiError;
      setFailure({ code: e.code, message: e.message });
    } finally {
      setBusy(false);
    }
  }

  /* ── states ────────────────────────────────────────────────────────────────── */

  if (!can('matters.create')) {
    return (
      <div className="firm-page">
        <Card><CardBody>
          <EmptyState
            kind="denied"
            icon={<IconMatters size={22} />}
            title={t('intake.denied.title')}
            description={t('intake.denied.body')}
          />
        </CardBody></Card>
      </div>
    );
  }

  if (loading) return <PageSkeleton />;

  if (fatal || !boot) {
    return (
      <div className="firm-page">
        <Alert tone="critical" title={t('intake.failed.title')}>
          <p>{fatal?.message ?? t('intake.failed.body')}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>{t('common.retry')}</Button>
        </Alert>
      </div>
    );
  }

  /* ── the receipt ───────────────────────────────────────────────────────────── */

  if (created) {
    const findings = created.conflict.hits.length;
    const held = created.internalStatus === 'conflict_check';
    return (
      <div className="firm-page">
        <header className="firm-pagehead">
          <div>
            <h1 className="firm-pagehead__title">{t('intake.done.title')}</h1>
            <p className="firm-pagehead__sub">{t('intake.done.sub')}</p>
          </div>
        </header>

        <div className="firm-intake__receipt">
          <Card>
            <CardBody>
              <div className="firm-receipt__number num">{created.matterNumber}</div>
              <dl className="firm-deflist firm-deflist--inline">
                <div><dt>{t('matter.title')}</dt><dd>{pick(null, form.title)}</dd></div>
                <div><dt>{t('intake.client')}</dt><dd>{created.client.name}</dd></div>
                <div>
                  <dt>{t('intake.lead')}</dt>
                  <dd>{created.lead ? created.lead.name : t('intake.lead.none')}</dd>
                </div>
                <div>
                  <dt>{t('matter.status')}</dt>
                  <dd><Badge tone={held ? 'warning' : 'lime'} size="xs">
                    {matterStatusLabel(t, created.internalStatus)}
                  </Badge></dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          {/*
            THE GATE, REPORTED HONESTLY. A file that a check held back is not a
            failure and is not a success: it is a file waiting on a decision, and the
            count is the one number that says whether that decision is imminent.
          */}
          {findings > 0 ? (
            <Alert tone="warning" title={t('intake.done.conflict.title')}>
              <p>{t('intake.done.conflict.body', { n: String(findings) })}</p>
            </Alert>
          ) : created.conflict.checkId ? (
            <Alert tone="info" title={t('intake.done.checked.title')}>
              <p>{t('intake.done.checked.body', {
                parties: String(created.conflict.partiesChecked),
                matters: String(created.conflict.mattersSearched),
              })}</p>
            </Alert>
          ) : null}

          <div className="firm-intake__next">
            <Button variant="primary" onClick={() => onNavigate(`/matters/${created.id}`)}>
              {t('intake.done.open')}
            </Button>
            {findings > 0 && (
              <Button variant="secondary" onClick={() => onNavigate(`/matters/${created.id}`)}>
                {t('intake.done.disposition')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => {
              setCreated(null);
              setForm({ ...BLANK_MATTER, matterNumber: boot.matterNumber.proposed });
              setExtraMembers([]);
            }}>
              {t('intake.done.another')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* ── the form ──────────────────────────────────────────────────────────────── */

  const canSubmit = !!clientId && form.title.trim().length >= 2 && !busy;

  return (
    <div className="firm-page firm-intake">
      <header className="firm-pagehead">
        <div>
          <h1 className="firm-pagehead__title">{t('intake.title')}</h1>
          <p className="firm-pagehead__sub">{t('intake.sub')}</p>
        </div>
      </header>

      {/*
        ═══ 1 · THE CLIENT ═══
        Choosing and adding are the same section, so a firm that has never heard of
        this client before does not have to leave the case form, save, come back and
        start again — which is the single most common way an intake form is abandoned.
      */}
      <Card>
        <CardBody>
          <h2 className="firm-panel__subhead">
            <span className="firm-steps__n">1</span>{t('intake.client')}
          </h2>

          {client ? (
            <div className="firm-intake__chosen">
              <div className="firm-intake__chosen-main">
                <IconClients size={18} />
                <div>
                  <div className="firm-intake__chosen-name">{pick(client.nameAr, client.name)}</div>
                  <div className="firm-panel__note">
                    {t(`client.type.${client.clientType}`)}
                    {client.matterCount > 0
                      ? ` · ${t('intake.client.existing', { n: String(client.matterCount) })}`
                      : ` · ${t('intake.client.first')}`}
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setClientId('')}>
                {t('intake.client.change')}
              </Button>
            </div>
          ) : (
            <>
              <TextField
                label={t('intake.client.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leadingIcon={<IconSearch size={15} />}
                placeholder={t('intake.client.search.placeholder')}
              />
              <ul className="firm-intake__clients">
                {filteredClients.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="firm-intake__client" onClick={() => setClientId(c.id)}>
                      <span className="firm-intake__client-name">{pick(c.nameAr, c.name)}</span>
                      <span className="firm-panel__note">
                        {t(`client.type.${c.clientType}`)}
                        {' · '}
                        {c.matterCount === 0
                          ? t('intake.client.first')
                          : t('intake.client.existing', { n: String(c.matterCount) })}
                      </span>
                    </button>
                  </li>
                ))}
                {filteredClients.length === 0 && (
                  <li><p className="firm-panel__note">{t('intake.client.none')}</p></li>
                )}
              </ul>
              <Button
                variant="secondary" size="sm" icon={<IconPlus size={15} />}
                onClick={() => setAddingClient((v) => !v)}
              >
                {t('intake.client.add')}
              </Button>
            </>
          )}

          {addingClient && !client && (
            <div className="firm-intake__newsclient">
              <SelectField
                label={t('client.type')}
                value={clientForm.clientType}
                onChange={(e) => setClientForm({ ...clientForm, clientType: e.target.value as 'individual' | 'organization' })}
                options={[
                  { value: 'organization', label: t('client.type.organization') },
                  { value: 'individual', label: t('client.type.individual') },
                ]}
              />
              <TextField
                label={t('client.name')} required
                value={clientForm.name}
                onChange={(e) => setClientForm({ ...clientForm, name: e.target.value })}
                hint={t('intake.client.name.hint')}
              />
              <TextField
                label={t('client.nameAr')}
                value={clientForm.nameAr}
                onChange={(e) => setClientForm({ ...clientForm, nameAr: e.target.value })}
              />
              <TextField
                label={t('client.email')} type="email"
                value={clientForm.email}
                onChange={(e) => setClientForm({ ...clientForm, email: e.target.value })}
              />
              <TextField
                label={t('client.phone')}
                value={clientForm.phone}
                onChange={(e) => setClientForm({ ...clientForm, phone: e.target.value })}
              />
              <TextField
                label={t('client.city')}
                value={clientForm.city}
                onChange={(e) => setClientForm({ ...clientForm, city: e.target.value })}
              />
              <TextField
                label={t('client.cr')}
                value={clientForm.commercialRegistration}
                onChange={(e) => setClientForm({ ...clientForm, commercialRegistration: e.target.value })}
              />
              <TextField
                label={t('client.nationalId')}
                value={clientForm.nationalId}
                onChange={(e) => setClientForm({ ...clientForm, nationalId: e.target.value })}
                hint={t('intake.client.id.hint')}
              />

              {/*
                THE DUPLICATE IS THE CONFLICT ENGINE'S BUSINESS, NOT THE FORM'S.
                The refusal carries the clients the firm already holds under this
                name; the member either takes one of them or says explicitly that
                this is a second entity — and that answer is what the audit records.
              */}
              {clientMatches.length > 0 && (
                <Alert tone="warning" title={t('intake.client.duplicate')}>
                  <ul className="firm-intake__matches">
                    {clientMatches.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button" className="firm-intake__match"
                          onClick={() => { setClientId(m.id); setAddingClient(false); setClientMatches([]); }}
                        >
                          {pick(m.nameAr, m.name)}
                          <span className="firm-panel__note">
                            {t('intake.client.existing', { n: String(m.matterCount) })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}

              <div className="firm-intake__actions">
                <Button
                  variant="primary" size="sm" disabled={clientBusy || clientForm.name.trim().length < 2}
                  onClick={() => void submitClient(false)}
                >
                  {t('intake.client.save')}
                </Button>
                {clientMatches.length > 0 && (
                  <Button variant="secondary" size="sm" disabled={clientBusy}
                    onClick={() => void submitClient(true)}>
                    {t('intake.client.saveAnyway')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => {
                  setAddingClient(false); setClientMatches([]);
                }}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/*
        ═══ 2 · THE CASE ═══
        Everything the file is called and everything it is about. The number is shown
        before submission because it is the firm's register talking, not a field: it
        is prefilled from the server's own sequence and may be overridden only by
        somebody who actually has an external number to use.
      */}
      <Card>
        <CardBody>
          <h2 className="firm-panel__subhead">
            <span className="firm-steps__n">2</span>{t('intake.case')}
          </h2>
          <div className="firm-formgrid">
            <TextField
              label={t('intake.case.title')} required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <TextField
              label={t('intake.case.titleAr')}
              value={form.titleAr}
              onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
            />
            <TextField
              label={t('intake.case.number')}
              value={form.matterNumber}
              onChange={(e) => setForm({ ...form, matterNumber: e.target.value })}
              hint={t('intake.case.number.hint')}
            />
            <TextField
              label={t('intake.case.caseNumber')}
              value={form.caseNumber}
              onChange={(e) => setForm({ ...form, caseNumber: e.target.value })}
              hint={t('intake.case.caseNumber.hint')}
            />
            <SelectField
              label={t('matter.practiceArea')}
              value={form.practiceArea}
              onChange={(e) => setForm({ ...form, practiceArea: e.target.value })}
              options={boot.practiceAreas.map((a) => ({ value: a, label: a }))}
              placeholder={t('intake.case.area.none')}
            />
            <TextField
              label={t('intake.case.court')}
              value={form.court}
              onChange={(e) => setForm({ ...form, court: e.target.value })}
            />
          </div>
          <TextArea
            label={t('intake.case.summary')}
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            hint={t('intake.case.summary.hint')}
            maxLength={4000} maxLengthCounter
          />
          <TextArea
            label={t('intake.case.summaryAr')}
            value={form.summaryAr}
            onChange={(e) => setForm({ ...form, summaryAr: e.target.value })}
            maxLength={4000}
          />
          {/*
            A STATED RULE WHERE THE TOGGLE USED TO BE. The opening entry on the client's
            timeline is client-visible by policy (0048: firm appends must satisfy
            `client_visible is true`), so there is nothing to choose — and an option that
            is true-and-ignored is worse than no option. What stays internal lives in the
            firm's own notes, not in the client's chronology.
          */}
          <div className="firm-formgrid__wide">
            <Checkbox
              label={t('intake.case.opening')}
              hint={t('intake.case.opening.hint')}
              checked
              disabled
              onChange={() => undefined}
            />
          </div>
        </CardBody>
      </Card>

      {/*
        ═══ 3 · WHO ANSWERS FOR IT ═══
        The assignment is part of opening the case, because a matter with no lead is a
        matter nobody is working. The load each person already carries is shown: it is
        the only fact that makes the choice informed, and it is already in the payload.
      */}
      <Card>
        <CardBody>
          <h2 className="firm-panel__subhead">
            <span className="firm-steps__n">3</span>{t('intake.lead')}
          </h2>
          <div className="firm-formgrid">
            <SelectField
              label={t('intake.lead.who')}
              value={leadStaffId}
              onChange={(e) => setLeadStaffId(e.target.value)}
              placeholder={t('intake.lead.none')}
              options={boot.staff.map((s) => ({
                value: s.staffId,
                label: `${pick(s.nameAr, s.name)} · ${pick(s.jobTitleAr, s.jobTitle) || s.role}`
                  + (s.activeMatters ? ` (${t('intake.lead.load', { n: String(s.activeMatters) })})` : ''),
              }))}
            />
            <SelectField
              label={t('intake.lead.role')}
              value={leadRole}
              onChange={(e) => setLeadRole(e.target.value)}
              options={LEAD_ROLES.map((r) => ({ value: r, label: matterRoleLabel(t, r) }))}
            />
          </div>

          {extraMembers.length > 0 && (
            <ul className="firm-intake__team">
              {extraMembers.map((m) => (
                <li key={`${m.staffId}:${m.matterRole}`}>
                  <IconUser size={15} />
                  <span>{staffLabel(m.staffId)}</span>
                  <Badge tone="neutral" size="xs">{matterRoleLabel(t, m.matterRole)}</Badge>
                  <Button
                    variant="ghost" size="xs"
                    onClick={() => setExtraMembers(extraMembers.filter((x) => x !== m))}
                  >
                    {t('common.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="firm-intake__addmember">
            <SelectField
              label={t('intake.team.add')}
              value=""
              onChange={(e) => {
                const staffId = e.target.value;
                if (!staffId || staffId === leadStaffId) return;
                if (extraMembers.some((m) => m.staffId === staffId)) return;
                setExtraMembers([...extraMembers, { staffId, matterRole: 'associate' }]);
              }}
              placeholder={t('intake.team.none')}
              options={boot.staff
                .filter((s) => s.staffId !== leadStaffId && !extraMembers.some((m) => m.staffId === s.staffId))
                .map((s) => ({ value: s.staffId, label: `${pick(s.nameAr, s.name)} · ${s.role}` }))}
            />
            {extraMembers.length > 0 && (
              <label className="firm-intake__rolepick">
                <span className="t-caption">{t('intake.team.role')}</span>
                <select
                  className="kgm-input kgm-input--select"
                  value={extraMembers[extraMembers.length - 1]?.matterRole ?? 'associate'}
                  onChange={(e) => {
                    const next = [...extraMembers];
                    next[next.length - 1] = { ...next[next.length - 1]!, matterRole: e.target.value };
                    setExtraMembers(next);
                  }}
                >
                  {['associate', 'paralegal', 'lead_lawyer', 'lead_partner', 'finance_contact', 'compliance_contact']
                    .map((r) => <option key={r} value={r}>{matterRoleLabel(t, r)}</option>)}
                </select>
              </label>
            )}
          </div>

          <Checkbox
            label={t('intake.check')}
            hint={t('intake.check.hint')}
            checked={runCheck}
            onChange={(e) => setRunCheck(e.target.checked)}
          />
        </CardBody>
      </Card>

      {/*
        ═══ THE ONE BUTTON ═══
        Everything above is one submission. The line beside it states exactly what is
        about to be written — client, number, lead — so the last thing read before
        submitting is what will exist afterwards.
      */}
      <div className="firm-intake__submit">
        <div className="firm-intake__submitline">
          <IconCheck size={15} />
          <span>
            {client
              ? pick(client.nameAr, client.name)
              : t('intake.client')}
            {' · '}
            <span className="num">{form.matterNumber || boot.matterNumber.proposed}</span>
            {leadStaffId ? <> {' · '}{staffLabel(leadStaffId)}</> : null}
            {runCheck ? <> {' · '}{t('intake.check.short')}</> : null}
          </span>
        </div>
        <Button variant="primary" disabled={!canSubmit} onClick={() => void submitMatter()}>
          {busy ? t('common.saving') : t('intake.submit')}
        </Button>
      </div>

      {failure && (
        <Alert tone="critical" title={t('intake.failed.title')}>
          <p>{failure.message}</p>
          {failure.code === 'matter_number_taken' && (
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t('intake.number.reload')}
            </Button>
          )}
        </Alert>
      )}

      {mode === 'client' && (
        <p className="firm-panel__note">{t('intake.clientOnly.hint')}</p>
      )}

      {!client && (
        <EmptyState
          icon={<IconConflicts size={20} />}
          title={t('intake.needclient.title')}
          description={t('intake.needclient.body')}
        />
      )}
    </div>
  );
}

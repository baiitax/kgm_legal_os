#!/usr/bin/env node
/**
 * THE INTAKE WORKFLOW, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS AND WHAT THE SUITE CANNOT DO
 *
 *   `tests/security/intake.test.ts` runs on SQLite. SQLite has no roles, no column
 *   privileges and no row-level security, so every write this phase opened has TWO
 *   mechanisms behind it and the suite exercises exactly one:
 *
 *     · on SQLite the INSERT simply happens; on Postgres it happens only because
 *       migration 0058 granted the columns to `firm_api` AND added policies whose
 *       WITH CHECK admits a brand-new row. A policy without a grant is not access,
 *       and a grant without a policy is not permission — the suite can see neither.
 *     · `matter_team` carries a partial unique index (one active lead per role) and a
 *       CHECK (the finance and compliance contacts are never client-visible). Both
 *       exist only in Postgres; on SQLite the service-level rule is the only one.
 *     · `audit_events.action` is CHECK-constrained against a GENERATED vocabulary.
 *       An action missing from the constraint makes `tryWrite` swallow the row with a
 *       console warning while the product looks perfect. The union and the generated
 *       migration must agree, and only the real database can say whether they do.
 *
 *   So the assertions below are written against the DATABASE as much as against the
 *   API: after the API says "created", the harness asks Postgres for the row, for the
 *   privileges, and for the audit trail.
 *
 * IT IS IDEMPOTENT, AND IT CLEANS UP IN `finally`. The clients and matters it creates
 * are synthetic and are removed afterwards — the audit rows stay, because an audit
 * trail that can be tidied is not an audit trail.
 *
 * USAGE
 *   node scripts/verify/intake-live.mjs                        # local :8787
 *   node scripts/verify/intake-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;

const FIRM_PASSWORD = 'Demo!Firm2026';
const TENANT_KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_NAJD = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
const FAISAL_STAFF = 'f1000000-0000-4000-8000-000000000002';
const MARIAM_STAFF = 'f1000000-0000-4000-8000-000000000003';
const OMAR_STAFF = 'f1000000-0000-4000-8000-000000000004';

const STAMP = `live-${Date.now().toString(36)}`;
const CLIENT_NAME = `Al-Suqoor Contracting ${STAMP}`;
const MATTER_TITLE = `Live intake check ${STAMP}`;

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── a cookie-jar client, so the CSRF handshake behaves like a browser ───────── */
async function client(email) {
  const jar = new Map();
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const call = async (path, init = {}) => {
    const write = init.method && init.method !== 'GET';
    /* The firm's CSRF cookie is namespaced (`kgm_firm_csrf`); looked up by suffix so
       a renamed cookie fails here rather than silently sending no token. */
    const csrfCookie = [...jar.entries()].find(([k]) => k.endsWith('csrf'))?.[1];
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(write && csrfCookie ? { 'x-csrf-token': csrfCookie } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    });
    absorb(res);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
    return { status: res.status, body, text };
  };
  await call('/api/firm/auth/csrf');
  const token = [...jar.entries()].find(([k]) => k.endsWith('csrf'))?.[1] ?? null;
  const login = await call('/api/firm/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: FIRM_PASSWORD }),
    headers: token ? { 'x-csrf-token': token } : {},
  });
  if (login.status !== 200) {
    throw new Error(`login failed for ${email}: ${login.status} ${login.text.slice(0, 200)}`);
  }
  return { call, email };
}

const data = (res) => res.body?.data ?? res.body;

let admin;
/** Everything created here, so the `finally` can take it back out in FK order. */
const created = { clientIds: [], matterIds: [] };

async function cleanup() {
  for (const matterId of created.matterIds) {
    await admin.query('delete from public.conflict_hits where matter_id = $1', [matterId]);
    await admin.query('delete from public.conflict_checks where matter_id = $1', [matterId]);
    await admin.query('delete from public.matter_timeline where matter_id = $1', [matterId]);
    await admin.query('delete from public.matter_parties where matter_id = $1', [matterId]);
    await admin.query('delete from public.matter_team where matter_id = $1', [matterId]);
    await admin.query('delete from public.matters where id = $1', [matterId]);
  }
  for (const clientId of created.clientIds) {
    await admin.query('delete from public.client_invitations where client_id = $1', [clientId]);
    await admin.query('delete from public.clients where id = $1', [clientId]);
  }
}

async function main() {
  console.log(`\n  INTAKE · live check against ${BASE}\n  ${'─'.repeat(70)}`);

  admin = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();

  /* ── the privileges 0058 added, asked of the CATALOGUE ──────────────────── */
  const grants = await admin.query(
    `select table_name, privilege_type, count(*)::int as n
       from information_schema.column_privileges
      where grantee = 'firm_api'
        and table_name in ('clients','matters','matter_team','client_invitations')
        and privilege_type in ('INSERT','UPDATE')
      group by 1,2 order by 1,2`);
  const has = (table, priv) => grants.rows.some((r) => r.table_name === table && r.privilege_type === priv);
  check(has('clients', 'INSERT') && has('clients', 'UPDATE'),
    'firm_api holds the client INSERT and UPDATE privileges', JSON.stringify(grants.rows));
  check(has('matters', 'INSERT') && has('matters', 'UPDATE'),
    'firm_api holds the matter INSERT and UPDATE privileges');
  check(has('matter_team', 'INSERT') && has('matter_team', 'UPDATE'),
    'firm_api holds the matter_team INSERT and UPDATE privileges');
  /* The invitation read is column-scoped on purpose: the firm re-reads the invitation it
     minted (who, when, which role, whether it was accepted) and never the token hash. A
     table-level SELECT here would hand over a column added later without anyone noticing. */
  const invCols = (await admin.query(
    `select column_name from information_schema.column_privileges
      where grantee = 'firm_api' and table_name = 'client_invitations'
        and privilege_type = 'SELECT'`)).rows.map((r) => r.column_name);
  check(invCols.includes('accepted_at') && invCols.includes('portal_role'),
    'firm_api may read the invitation it minted');
  check(!invCols.includes('token_hash'),
    'and cannot read the token it hashed', invCols.includes('token_hash') ? 'token_hash readable' : '');

  const policies = await admin.query(
    `select policyname from pg_policies
      where schemaname = 'public' and policyname in
        ('clients_firm_insert','clients_firm_write','matters_firm_insert',
         'matter_team_firm_write','invitations_firm_insert','invitations_firm_read')`);
  check(policies.rowCount === 6, 'the six intake policies are present', `${policies.rowCount}/6`);

  const idx = await admin.query(
    `select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'matter_team_one_lead_uq'`);
  check(idx.rowCount === 1 && /\(matter_id, matter_role\)/.test(idx.rows[0].indexdef),
    'one active lead per role is an index, not a habit', idx.rows[0]?.indexdef ?? 'missing');

  const vocab = await admin.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'audit_events_action_check'`);
  const definition = vocab.rows[0]?.def ?? '';
  const ACTIONS = ['CLIENT_CREATED', 'CLIENT_UPDATED', 'MATTER_CREATED', 'MATTER_REPORT_UPDATED',
    'MATTER_TEAM_ASSIGNED', 'MATTER_TEAM_UNASSIGNED'];
  const missing = ACTIONS.filter((a) => !definition.includes(`'${a}'`));
  check(missing.length === 0, 'the audit vocabulary admits every intake action',
    missing.length ? `missing: ${missing.join(', ')}` : '');
  check(!/internal_notes|risk_rating/.test(
    (await admin.query(
      `select column_name from information_schema.column_privileges
        where grantee = 'firm_api' and table_name = 'matters'
          and column_name in ('internal_notes','risk_rating')`)).rows.map((r) => r.column_name).join(',')),
  'the privilege ring is still closed on matters');

  /* ── the workflow ───────────────────────────────────────────────────────── */
  const noura = await client('noura@kgm.example.test');

  const boot = await noura.call('/api/firm/matters/new');
  const bootstrap = data(boot);
  check(boot.status === 200 && Array.isArray(bootstrap?.clients) && Array.isArray(bootstrap?.staff),
    'the opening form is served in one call',
    `${boot.status} clients=${bootstrap?.clients?.length} staff=${bootstrap?.staff?.length}`);
  check(typeof bootstrap?.matterNumber?.proposed === 'string'
    && /^[A-Z0-9]+-\d{4}-\d{4}$/.test(bootstrap.matterNumber.proposed),
    'the matter number is proposed before the file exists', bootstrap?.matterNumber?.proposed);
  check(bootstrap?.staff?.every((s) => s.activeMatters !== undefined),
    'the assignment picker carries each lawyer\'s current load');

  const clientRes = await noura.call('/api/firm/clients', {
    method: 'POST',
    body: JSON.stringify({
      clientType: 'organization', name: CLIENT_NAME, nameAr: `الصقور للمقاولات ${STAMP}`,
      city: 'Riyadh', commercialRegistration: '1010-LIVE-01', nationalId: '1099887766',
    }),
  });
  const clientId = data(clientRes)?.id;
  if (clientId) created.clientIds.push(clientId);
  check(clientRes.status === 201 && !!clientId, 'a client is created', `${clientRes.status}`);

  const clientRow = clientId
    ? (await admin.query(
      'select name, name_ar, national_id_masked, national_id_hash, status from public.clients where id = $1',
      [clientId])).rows[0]
    : null;
  check(!!clientRow && clientRow.status === 'active', 'the client row exists in Postgres');
  check(!!clientRow && /\*{4,}\d{4}$/.test(clientRow.national_id_masked)
    && !String(clientRow.national_id_masked).includes('1099887766'),
  'the identity document is masked, not stored', clientRow?.national_id_masked);
  check(!!clientRow && String(clientRow.national_id_hash).length > 20
    && !String(clientRow.national_id_hash).includes('1099887766'),
  'and hashed, so a search can match it without reading it');

  /* The same client, written the way a second clerk would write it. */
  const dupeRes = await noura.call('/api/firm/clients', {
    method: 'POST',
    body: JSON.stringify({ clientType: 'organization', name: CLIENT_NAME.toUpperCase() }),
  });
  check(dupeRes.status === 409 && dupeRes.body?.error?.code === 'client_name_exists',
    'a folded duplicate is a question, not a second client', `${dupeRes.status}`);
  check(Array.isArray(dupeRes.body?.error?.details?.matches)
    && dupeRes.body.error.details.matches.some((m) => m.id === clientId),
  'and the refusal names the client already on the register');

  const confirmRes = await noura.call('/api/firm/clients', {
    method: 'POST',
    body: JSON.stringify({
      clientType: 'organization', name: `${CLIENT_NAME} (branch)`, confirmDuplicate: true,
    }),
  });
  const branchId = data(confirmRes)?.id;
  if (branchId) created.clientIds.push(branchId);
  check(confirmRes.status === 201 && branchId !== clientId,
    'a confirmed second entity is created and is a different row', `${confirmRes.status}`);

  /* ── open the case ──────────────────────────────────────────────────────── */
  const matterRes = await noura.call('/api/firm/matters', {
    method: 'POST',
    body: JSON.stringify({
      clientId, title: MATTER_TITLE,
      practiceArea: 'litigation', court: 'Riyadh Commercial Court',
      summary: 'Live check of the intake workflow.',
      leadStaffId: NOURA_STAFF, leadRole: 'lead_lawyer',
      team: [{ staffId: MARIAM_STAFF, matterRole: 'paralegal' }],
    }),
  });
  const matter = data(matterRes);
  if (matter?.id) created.matterIds.push(matter.id);
  check(matterRes.status === 201 && !!matter?.id, 'the case is opened', `${matterRes.status} ${matterRes.text.slice(0, 200)}`);
  /*
    EVERYTHING BELOW DEPENDS ON THE FILE. When the create fails, the team and report
    assertions cannot run and would each report a 500 against `undefined` — twenty red
    lines that say nothing about where the fault is. So the chain stops here, loudly.
  */
  if (!matter?.id) {
    check(false, 'the rest of the workflow is reached (matter id missing — stopped here)');
    return;
  }
  check(/^[A-Z0-9]+-\d{4}-\d{4}$/.test(String(matter?.matterNumber)),
    'a matter number was allocated from the firm sequence', matter?.matterNumber);
  check(matter?.internalStatus === 'intake',
    'the file is born in intake — never active, because the CDD gate owns that', matter?.internalStatus);
  check(!!matter?.conflict?.checkId,
    'the conflict check ran inside the create, so no file exists without one');

  const matterRow = matter?.id
    ? (await admin.query(
      `select matter_number, internal_status, conflict_cleared, client_id, title_ar
         from public.matters where id = $1`, [matter.id])).rows[0]
    : null;
  check(!!matterRow && matterRow.internal_status === 'intake' && matterRow.conflict_cleared === false,
    'the row says the same thing: intake, and not cleared',
    `${matterRow?.internal_status}/${matterRow?.conflict_cleared}`);
  check(!!matterRow && matterRow.title_ar === MATTER_TITLE,
    'the Arabic title column is satisfied, as both dialects require', matterRow?.title_ar);

  const teamRows = matter?.id
    ? (await admin.query(
      `select staff_id, matter_role, is_active from public.matter_team
        where matter_id = $1 order by matter_role`, [matter.id])).rows
    : [];
  check(teamRows.length === 2 && teamRows.some((r) => r.staff_id === NOURA_STAFF && r.matter_role === 'lead_lawyer'),
    'the lead and the team were written in the same transaction', JSON.stringify(teamRows));

  const timeline = matter?.id
    ? (await admin.query(
      `select event_type, client_visible from public.matter_timeline where matter_id = $1`, [matter.id])).rows
    : [];
  check(timeline.some((r) => r.event_type === 'matter_opened' && r.client_visible === true),
    'the opening is on the timeline, and the client may see it', JSON.stringify(timeline));

  /* ── assign ─────────────────────────────────────────────────────────────── */
  /*
    ASSIGNING IS A PARTNER'S ACT, AND THIS HARNESS SAYS SO. `matters.assign` sits in the
    PARTNER and MANAGING_PARTNER templates and not in the lawyer's (firm-catalogue.ts), and
    the permission is only half of it: the route also demands full access on the file itself
    (`MATTER_MANAGE = ['full']`). So Noura — managing partner, and the lead written at intake
    — does the staffing, and the lawyer who leads the file afterwards does the reporting.

    A harness that used one login for everything would be proving a workflow the firm does
    not have; the first version of this file did exactly that and read a corporate rule as a
    server defect.
  */

  /* §11 WHILE NOURA STILL LEADS IT: the compliance contact is never client-visible, and the
     table's CHECK refuses the row if the service says otherwise. */
  const hidden = await noura.call(`/api/firm/matters/${matter.id}/team`, {
    method: 'POST',
    body: JSON.stringify({
      staffId: OMAR_STAFF, matterRole: 'compliance_contact', clientVisible: true,
    }),
  });
  check(hidden.status === 201 && data(hidden)?.clientVisible === false && data(hidden)?.clientVisibleForced === true,
    '§11 · the compliance contact is forced off the client\'s view',
    `${hidden.status} ${JSON.stringify(data(hidden)?.clientVisible)}`);
  const hiddenRow = (await admin.query(
    `select client_visible from public.matter_team where matter_id = $1 and staff_id = $2`,
    [matter.id, OMAR_STAFF])).rows[0];
  check(hiddenRow?.client_visible === false, 'and the CHECK constraint agrees with the service');

  const badRole = await noura.call(`/api/firm/matters/${matter.id}/team`, {
    method: 'POST',
    body: JSON.stringify({ staffId: MARIAM_STAFF, matterRole: 'lawyer' }),
  });
  check(badRole.status === 400, 'a role the CHECK does not admit is refused before the write', `${badRole.status}`);

  const secondLead = await noura.call(`/api/firm/matters/${matter.id}/team`, {
    method: 'POST',
    body: JSON.stringify({ staffId: FAISAL_STAFF, matterRole: 'lead_lawyer' }),
  });
  check(secondLead.status === 409 && secondLead.body?.error?.code === 'matter_has_lead',
    'a second lead of the same role is refused, by name', `${secondLead.status}`);
  check(/Noura/.test(secondLead.text), 'the refusal names the incumbent', secondLead.text.slice(0, 160));

  const takeOver = await noura.call(`/api/firm/matters/${matter.id}/team`, {
    method: 'POST',
    body: JSON.stringify({ staffId: FAISAL_STAFF, matterRole: 'lead_lawyer', replaceLead: true }),
  });
  check(takeOver.status === 201 && data(takeOver)?.replaced === true,
    'taking the role over is one action', `${takeOver.status}`);
  const leads = (await admin.query(
    `select staff_id, is_active from public.matter_team
      where matter_id = $1 and matter_role = 'lead_lawyer' order by staff_id`, [matter.id])).rows;
  const activeLeads = leads.filter((r) => r.is_active);
  check(activeLeads.length === 1 && activeLeads[0].staff_id === FAISAL_STAFF,
    'exactly one active lead remains, and it is the new one', JSON.stringify(leads));
  check(leads.length === 2, 'the incumbent is deactivated rather than deleted', JSON.stringify(leads));

  /*
    THE FILE HAS CHANGED HANDS, SO THE REST OF THE WORKFLOW IS THE NEW LEAD'S. `replaceLead`
    deactivates the incumbent outright — that is what one-lead-per-role means — so Noura is
    off the matter from here on, and her next write would be a 404 rather than a success.
    Signing in as the lawyer who now runs the file is the workflow, not a workaround.
  */
  const faisal = await client('faisal@kgm.example.test');

  /* ── the report ─────────────────────────────────────────────────────────── */
  const report = await faisal.call(`/api/firm/matters/${matter.id}/report`, {
    method: 'PATCH',
    body: JSON.stringify({
      summary: 'The defence has been filed.',
      court: 'Riyadh Commercial Court — Circuit 3',
      note: 'We filed the defence on Tuesday.',
      notifyClient: true,
    }),
  });
  check(report.status === 200 && data(report)?.notifiedClient === true,
    'the report is written and the client told, in one call', `${report.status}`);

  const after = (await admin.query(
    'select last_client_update_at, summary, court from public.matters where id = $1',
    [matter.id])).rows[0];
  check(after?.last_client_update_at !== null, 'the portal\'s "last update" date moved');
  check(String(after?.court).includes('Circuit 3'), 'the report columns are the ones 0058 granted');

  const note = (await admin.query(
    `select event_type, client_visible, description from public.matter_timeline
      where matter_id = $1 and event_type = 'status_update'`, [matter.id])).rows[0];
  check(!!note && note.client_visible === true,
    'the client-facing note is on the timeline and visible to the client');

  /*
    THE RULE THE SQLITE SUITE CANNOT HOLD. 0048's `firm_timeline_append` admits only
    client-visible rows from firm_api, so an internal note would be refused here and
    accepted on SQLite. This is the positive half of that proof: whatever the workflow wrote
    to the client's chronology, the client can read it.
  */
  const timelineRows = (await admin.query(
    `select event_type, client_visible from public.matter_timeline
      where matter_id = $1 order by occurred_at`, [matter.id])).rows;
  check(timelineRows.length >= 2 && timelineRows.every((r) => r.client_visible === true),
    '0048 · every timeline row the firm wrote is client-visible', JSON.stringify(timelineRows));

  const statusThroughReport = await faisal.call(`/api/firm/matters/${matter.id}/report`, {
    method: 'PATCH',
    body: JSON.stringify({ summary: 'x', internalStatus: 'active' }),
  });
  check(statusThroughReport.status === 400,
    'the lifecycle status cannot be set through the report', `${statusThroughReport.status}`);

  /* ── the trail, asked of the DATABASE ───────────────────────────────────── */
  const audit = await admin.query(
    `select action, count(*)::int as n from public.audit_events
      where tenant_id = $1 and resource_id = any($2::text[])
      group by action order by action`, [TENANT_KGM, [clientId, matter.id]]);
  const byAction = Object.fromEntries(audit.rows.map((r) => [r.action, r.n]));
  const trail = JSON.stringify(byAction);
  check(byAction.CLIENT_CREATED >= 1, 'CLIENT_CREATED is in the trail', trail);
  check(byAction.MATTER_CREATED === 1, 'MATTER_CREATED is in the trail', trail);
  /* Four assignments: the lead chosen at intake, the paralegal beside her, the hand-over,
     and the compliance contact. Each one is a row, because "who was on this file in March"
     is asked in March and nobody can answer it from a current-state table. */
  check((byAction.MATTER_TEAM_ASSIGNED ?? 0) >= 4,
    'MATTER_TEAM_ASSIGNED is in the trail, once per assignment', trail);
  check(byAction.MATTER_TEAM_UNASSIGNED >= 1, 'MATTER_TEAM_UNASSIGNED records the hand-over', trail);
  check(byAction.MATTER_REPORT_UPDATED === 1, 'MATTER_REPORT_UPDATED is in the trail', trail);
  check(byAction.CONFLICT_CHECK_RUN === 1, 'CONFLICT_CHECK_RUN is in the trail', trail);

  const reportAudit = (await admin.query(
    `select metadata from public.audit_events
      where action = 'MATTER_REPORT_UPDATED' and resource_id = $1`, [matter.id])).rows[0];
  check(reportAudit && !JSON.stringify(reportAudit.metadata).includes('defence has been filed'),
    'and the audit row names fields, never their values');

  /* ── another firm's client is not reachable through intake ──────────────── */
  const foreignClient = (await admin.query(
    'select id from public.clients where tenant_id = $1 limit 1', [TENANT_NAJD])).rows[0]
    ?? { id: '00000000-0000-4000-8000-0000000000ee' };   // asked of the other firm either way
  const foreign = await noura.call('/api/firm/matters', {
    method: 'POST',
    body: JSON.stringify({ clientId: foreignClient.id, title: 'Another firm\'s client' }),
  });
  const absent = await noura.call('/api/firm/matters', {
    method: 'POST',
    body: JSON.stringify({ clientId: '00000000-0000-4000-8000-0000000000ff', title: 'Nobody\'s client' }),
  });
  check(foreign.status === 404 && absent.status === 404,
    'another firm\'s client and a fabricated one are both refused', `${foreign.status}/${absent.status}`);
  check(JSON.stringify(foreign.body) === JSON.stringify(absent.body),
    'and refused byte-identically, so the door is no oracle');

  /* ── the member who may not open a file ─────────────────────────────────── */
  const mariam = await client('mariam@kgm.example.test');
  const refused = await mariam.call('/api/firm/matters', {
    method: 'POST',
    body: JSON.stringify({ clientId, title: 'A matter the paralegal cannot open' }),
  });
  check(refused.status === 403, 'a member without matters.create is refused', `${refused.status}`);
  const strays = await admin.query(
    'select id from public.matters where tenant_id = $1 and title = $2',
    [TENANT_KGM, 'A matter the paralegal cannot open']);
  check(strays.rowCount === 0, 'and nothing was written');

  console.log(`\n  ${'─'.repeat(70)}\n  ${passed} passed, ${failed} failed\n`);
}

main()
  .catch((err) => { failed++; console.log(`  ✗ harness error — ${err.message}`); })
  .finally(async () => {
    try { await cleanup(); } catch (err) { console.log(`  ! cleanup: ${err.message}`); }
    try { await admin?.end(); } catch { /* nothing to do */ }
    process.exit(failed === 0 ? 0 : 1);
  });

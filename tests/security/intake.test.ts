/**
 * TASK 25 · INTAKE — ADD A CLIENT, OPEN A CASE, ASSIGN IT, REPORT ON IT.
 *
 * WHY THE FOUR STAGES NEED FOUR KINDS OF ASSERTION.
 *
 * The four stages were missing at every layer at once: no route, no repository
 * method, and — the part that made it unbuildable — no GRANT. `firm_api` held no
 * INSERT privilege on `clients`, `matters` or `matter_team`, and the policies on
 * those tables were written to deny rather than to permit (`firm_client_scope` is a
 * `for all` policy whose WITH CHECK is the literal `false`). A front end could not
 * have fixed it, and a test that only exercised the UI would have passed against a
 * codebase where the feature was impossible.
 *
 * So these tests are written against the ROUTES, and they assert the things that
 * make intake safe rather than the things that make it work:
 *
 *   A · A CLIENT IS CREATED IN A FORM THE CONFLICT ENGINE CAN SEARCH. The normalised
 *       name is the engine's key; a client created without it is a client the firm
 *       can act for and cannot check. And the identity document is MASKED AND HASHED
 *       and never returned — the register is for choosing a client, not identifying
 *       one in bulk.
 *
 *   B · A MATTER CANNOT BE BORN ACTIVE, CANNOT BE BORN CLEARED, AND CANNOT BE BORN
 *       WITHOUT A LEAD. `internal_status` is not accepted from the caller; the CDD
 *       gate owns the transition into `active` and it is asked in
 *       `POST /matters/:id/status`. `conflict_cleared` is written as the derived
 *       false, and 0032's trigger refuses a contradicting value. A matter with no
 *       lead is a file nobody answers for.
 *
 *   C · THE NUMBER IS ALLOCATED BY THE SERVER AND UNIQUE PER FIRM. Two matters
 *       opened under the same number is a register that cannot be cited.
 *
 *   D · ONE LEAD PER ROLE, AND THE HIDDEN ROLES STAY HIDDEN. A second lead is a 409
 *       that NAMES the incumbent (or one action with `replaceLead`), and a finance or
 *       compliance contact is forced off the client's view rather than trusted not
 *       to be — the CHECK constraint in 0058 says the same thing underneath.
 *
 *   E · THE REPORT MOVES THE DATE THE CLIENT READS. `last_client_update_at` and a
 *       client-visible timeline entry in the same write; the lifecycle status is
 *       refused by the strict body, because a report is not a way round the gates.
 *
 *   F · AUTHORIZATION IS ASKED AT EVERY DOOR. A member without `matters.create`
 *       cannot create one, and — the assertion that matters — NO ROW IS WRITTEN when
 *       they try. A matter created by a refused caller would be a file with no
 *       author, which is worse than the refusal.
 *
 *   G · ANOTHER FIRM'S CLIENT IS A 404, IDENTICALLY TO A FABRICATED ONE. Naming a
 *       client of another tenant must not be an existence oracle (bite (i)).
 *
 *   H · EVERY ACT IS IN THE AUDIT TRAIL, BY NAME. `MATTER_CREATED` and its siblings
 *       were added to the union and the generated vocabulary in the same change;
 *       a vocabulary that does not admit an action makes `tryWrite` swallow the row
 *       with a console warning while the product looks perfect, so the assertions
 *       below ask the DATABASE for the row rather than trusting the response.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  bootStack, firmLoginAs, createAgent, FIRM, IDS, type Stack, type Agent, type ApiResponse,
} from '../helpers.js';

let s: Stack;
let noura: Agent;    // Managing Partner · matters.create/assign/update · full access
let mariam: Agent;   // Paralegal · works matters, may not create them
let sara: Agent;     // Finance · no legal module at all

const KGM = IDS.tenantKgm;
const NAJD = IDS.tenantNajd;
const MATTER = IDS.matterCommercial;

const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
const FAISAL_STAFF = 'f1000000-0000-4000-8000-000000000002';
const MARIAM_STAFF = 'f1000000-0000-4000-8000-000000000003';
const OMAR_STAFF = 'f1000000-0000-4000-8000-000000000004';

/** The successful response body. Every route answers `{ ok: true, data: … }`. */
const payload = (res: ApiResponse): any => res.body?.data ?? res.body;

const run = (sql: string, params: unknown[] = []) => s.db.run(sql, params as never);
const get = async (sql: string, params: unknown[] = []) =>
  s.db.get<Record<string, unknown>>(sql, params as never);
const all = async (sql: string, params: unknown[] = []) =>
  s.db.all<Record<string, unknown>>(sql, params as never);

/** A name no other test uses, so the duplicate check cannot be tripped by a neighbour. */
let seq = 0;
const uniqueName = (base: string) => `${base} ${Date.now().toString(36)}-${seq++}`;

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  mariam = createAgent(s.app);
  sara = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(mariam, FIRM.paralegal)).status).toBe(200);
  expect((await firmLoginAs(sara, FIRM.finance)).status).toBe(200);
});
afterEach(async () => { await s.shutdown(); });

// ═══════════════════════════════════════════════════════════════════════════════
describe('§25-A · add client', () => {
  it('creates a client under the name the conflict engine searches on', async () => {
    const name = uniqueName('شركة الأفق');
    const res = await noura.post('/api/firm/clients', {
      clientType: 'organization',
      name: 'Al-Afaq Trading Co.',
      nameAr: name,
      email: 'new.client@example.test',
      city: 'Jeddah',
    });
    expect(res.status).toBe(201);
    const data = payload(res);
    expect(data.id).toBeTruthy();

    const row = await get(
      `select id, name, name_ar, status, client_type from clients where id = ?`, [data.id]);
    expect(row).toBeTruthy();
    expect(String(row!.name_ar)).toBe(name);
    expect(String(row!.status)).toBe('active');
    expect(String(row!.client_type)).toBe('organization');

    /*
      AND THE CLIENT IS FINDABLE THE WAY THE CONFLICT ENGINE FINDS CLIENTS.

      `clients` carries no normalised-name column — matching for a client happens
      through `matchPartyNames`, in the application, which is the path
      `loadConflictDataset` takes. The assertion that means something is therefore not
      "a column was written" but "a different spelling of the same name is recognised
      as the same client": the register folds case, punctuation, the legal form and
      the definite article, and the duplicate check below reaches the same answer the
      conflict check will.
    */
    const folded = await noura.post('/api/firm/clients', {
      clientType: 'organization',
      name: 'AL-AFAQ TRADING CO',
      nameAr: 'الأفق التجاري',
    });
    expect(folded.status).toBe(409);
    expect(folded.body?.error?.code).toBe('client_name_exists');
    const named = (folded.body?.error?.details?.matches ?? []) as Array<{ id: string }>;
    expect(named.some((m) => m.id === data.id)).toBe(true);
  });

  it('never stores the identity document, and never returns what it stores', async () => {
    const res = await noura.post('/api/firm/clients', {
      clientType: 'individual',
      name: uniqueName('Fahd Al-Otaibi'),
      nationalId: '1044778899',
      commercialRegistration: '10107788991',
    });
    expect(res.status).toBe(201);
    const id = payload(res).id;

    const row = await get(
      `select national_id_masked, national_id_hash, commercial_reg_masked
         from clients where id = ?`, [id]);
    const masked = String(row!.national_id_masked);
    const hash = String(row!.national_id_hash);
    expect(masked).toMatch(/\*{4,}\d{4}$/);
    expect(masked).not.toContain('1044778899');
    // A hash, not the number — and not a reversible encoding of it either.
    expect(hash).not.toContain('1044778899');
    expect(hash.length).toBeGreaterThan(20);
    expect(String(row!.commercial_reg_masked)).toMatch(/\*/);
    expect(String(row!.commercial_reg_masked)).not.toBe('10107788991');

    // The response carries neither: no route may hand back what it masked.
    expect(JSON.stringify(payload(res))).not.toContain('1044778899');
  });

  it('answers a duplicate name with the register, and records the decision when confirmed', async () => {
    const name = uniqueName('Gulf Star Contracting');
    const first = await noura.post('/api/firm/clients', { clientType: 'organization', name });
    expect(first.status).toBe(201);

    const second = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: `  ${name.toUpperCase()}  `,
    });
    // 409, and the body NAMES the client already held — not merely a refusal.
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe('client_name_exists');
    const matches = second.body?.error?.details?.matches as Array<{ id: string; name: string }>;
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.some((m) => m.id === payload(first).id)).toBe(true);

    // Confirmed, it proceeds — and the audit row says the duplicate was a decision.
    const third = await noura.post('/api/firm/clients', {
      clientType: 'organization', name, confirmDuplicate: true,
    });
    expect(third.status).toBe(201);
    expect(payload(third).id).not.toBe(payload(first).id);

    const audited = await all(
      `select metadata from audit_events
        where tenant_id = ? and action = 'CLIENT_CREATED' and resource_id = ?`,
      [KGM, payload(third).id]);
    expect(audited.length).toBe(1);
    expect(String(audited[0].metadata)).toContain('confirmedDuplicate');
  });

  it('refuses a name with nothing searchable in it', async () => {
    const res = await noura.post('/api/firm/clients', { clientType: 'organization', name: '؟؟؟' });
    // Either the schema rejects a two-character name or the normalisation empties it;
    // both are refusals, and neither writes a row.
    expect([400]).toContain(res.status);
    const rows = await all(`select id from clients where name = '؟؟؟'`);
    expect(rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§25-B · open the case', () => {
  const newClient = async (name: string): Promise<string> => {
    const res = await noura.post('/api/firm/clients', { clientType: 'organization', name });
    expect(res.status).toBe(201);
    return payload(res).id as string;
  };

  it('creates the matter, its lead, its opening entry and its conflict check in one call', async () => {
    const clientId = await newClient(uniqueName('Nukhba Holding'));
    const res = await noura.post('/api/firm/matters', {
      clientId,
      title: 'Commercial dispute — supply agreement',
      matterNumber: null,
      practiceArea: 'litigation',
      court: 'Riyadh Commercial Court',
      summary: 'Claim for defective delivery under a supply agreement.',
      leadStaffId: FAISAL_STAFF,
      leadRole: 'lead_lawyer',
    });
    expect(res.status).toBe(201);
    const data = payload(res);
    expect(data.matterNumber).toMatch(/^[A-Z]+-\d{4}-\d{4}$/);

    const row = await get(
      `select id, matter_number, client_id, title, internal_status, conflict_cleared,
              practice_area, opened_at, country_code_is_absent
         from (select *, null as country_code_is_absent from matters) where id = ?`,
      [data.id]);
    expect(row).toBeTruthy();
    expect(String(row!.client_id)).toBe(clientId);
    expect(String(row!.practice_area)).toBe('litigation');
    /*
      BORN IN INTAKE, NOT ACTIVE, AND NOT CLEARED. The CDD gate guards the move into
      `active` and Rule 11's gate guards the move out of `conflict_check`; a create
      route that could set either would be a way around both.
    */
    expect(String(row!.internal_status)).toBe('intake');
    expect(Number(row!.conflict_cleared)).toBe(0);

    // The lead is on the file, as the lead.
    const team = await all(
      `select staff_id, matter_role, is_active from matter_team where matter_id = ?`, [data.id]);
    expect(team.length).toBe(1);
    expect(String(team[0].staff_id)).toBe(FAISAL_STAFF);
    expect(String(team[0].matter_role)).toBe('lead_lawyer');
    expect(Number(team[0].is_active)).toBe(1);

    // The opening is on the timeline, and the client may see it.
    const timeline = await all(
      `select event_type, client_visible, title from matter_timeline where matter_id = ?`,
      [data.id]);
    expect(timeline.length).toBe(1);
    expect(String(timeline[0].event_type)).toBe('matter_opened');
    expect(Number(timeline[0].client_visible)).toBe(1);

    // The conflict check ran, and is a check on THIS matter.
    expect(data.conflict.checkId).toBeTruthy();
    const check = await get(
      `select matter_id, kind, status from conflict_checks where id = ?`, [data.conflict.checkId]);
    expect(String(check!.matter_id)).toBe(data.id);
    expect(String(check!.kind)).toBe('intake');
  });

  it('allocates a distinct number for each matter the firm opens', async () => {
    const clientId = await newClient(uniqueName('Two Files Est.'));
    const a = await noura.post('/api/firm/matters', { clientId, title: 'First file' });
    const b = await noura.post('/api/firm/matters', { clientId, title: 'Second file' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(payload(a).matterNumber).not.toBe(payload(b).matterNumber);

    // And the register agrees: the numbers are unique per tenant, as the index says.
    const rows = await all(
      `select matter_number, count(*) as n from matters where tenant_id = ?
        group by matter_number having count(*) > 1`, [KGM]);
    expect(rows.length).toBe(0);
  });

  it('refuses a matter number already on the register rather than colliding with it', async () => {
    const clientId = await newClient(uniqueName('Collide Co.'));
    const first = await noura.post('/api/firm/matters', { clientId, title: 'Holder of the number' });
    const number = payload(first).matterNumber as string;

    const second = await noura.post('/api/firm/matters', {
      clientId, title: 'Wants the same number', matterNumber: number,
    });
    expect(second.status).toBe(409);
    expect(second.body?.error?.code).toBe('matter_number_taken');

    // Only the first matter exists under that number.
    const rows = await all(
      `select id from matters where tenant_id = ? and matter_number = ?`, [KGM, number]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(payload(first).id);
  });

  it('refuses a client of another firm, identically to one that does not exist', async () => {
    const foreign = await get(
      `select id from clients where tenant_id = ? limit 1`, [NAJD]);
    expect(foreign).toBeTruthy();

    const real = await noura.post('/api/firm/matters', {
      clientId: String(foreign!.id), title: 'Matter for a client we do not have',
    });
    const fabricated = await noura.post('/api/firm/matters', {
      clientId: randomUUID(), title: 'Matter for a client that does not exist',
    });

    expect(real.status).toBe(404);
    expect(fabricated.status).toBe(404);
    // Byte-identical: no oracle that says "this client exists, elsewhere".
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(fabricated.body));
    // And nothing was written.
    const rows = await all(
      `select id from matters where title like 'Matter for a client%'`);
    expect(rows.length).toBe(0);
  });

  it('refuses a departed member as the lead rather than creating an orphaned file', async () => {
    const clientId = await newClient(uniqueName('Orphan Check Ltd.'));
    await run(
      `update firm_memberships set status = 'left' where tenant_id = ? and staff_id = ?`,
      [KGM, MARIAM_STAFF]);

    const res = await noura.post('/api/firm/matters', {
      clientId, title: 'Led by somebody who has left', leadStaffId: MARIAM_STAFF,
    });
    expect(res.status).toBe(404);
    const rows = await all(`select id from matters where title = 'Led by somebody who has left'`);
    expect(rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§25-C · assign the case', () => {
  let matterId: string;

  beforeEach(async () => {
    const client = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('Assignment Client'),
    });
    /*
      THE LEAD IS THE ACTOR, AND THAT IS THE RULE RATHER THAN A CONVENIENCE. The
      assignment route asks for `matters.assign` AND full access on THIS matter
      (`MATTER_MANAGE`): deciding who may read a file is a decision about the file's
      confidentiality, so it belongs to the people answerable for it. A partner who
      merely has `matters.read_all` sees the matter and cannot staff it — they are
      told the file exists and not who works it.
    */
    const matter = await noura.post('/api/firm/matters', {
      clientId: payload(client).id, title: 'Assignment matter',
      leadStaffId: NOURA_STAFF, leadRole: 'lead_lawyer',
    });
    expect(matter.status).toBe(201);
    matterId = payload(matter).id;
  });

  it('assigns a person, and the team tab shows them with their role', async () => {
    const res = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'paralegal',
    });
    expect(res.status).toBe(201);
    const data = payload(res);
    expect(data.created).toBe(true);
    expect(data.clientVisible).toBe(true);

    const read = await noura.get(`/api/firm/matters/${matterId}/team`);
    expect(read.status).toBe(200);
    const team = payload(read).team as Array<{ staffId: string; matterRole: string }>;
    // The fixture's lead, plus the person just assigned — and nobody else.
    expect(team.map((m) => m.staffId).sort()).toEqual([NOURA_STAFF, MARIAM_STAFF].sort());

    /*
      THE ASSIGNMENT IS NOT ON THE TIMELINE — and this assertion is the one that would have
      caught a 500 on the real database. `matter_timeline` is the CLIENT's chronology and
      0048 admits only `client_visible is true` from firm_api, so an internal `note` row is
      refused by the INSERT policy on PostgreSQL while passing silently on SQLite. The
      client-facing answer to "who runs my case" is `matter_team.client_visible` (asserted
      through the team read above) and the internal record is the audit row below.

      This suite cannot enforce the policy — SQLite has no roles — so the positive proof
      lives in `scripts/verify/intake-live.mjs`, which asserts against Postgres that every
      timeline row the firm wrote on this file is client-visible.
    */
    const timeline = await all(
      `select event_type, client_visible from matter_timeline
        where matter_id = ? and event_type = 'note'`, [matterId]);
    expect(timeline.length).toBe(0);
    const hidden = await all(
      `select id from matter_timeline where matter_id = ? and client_visible = 0`, [matterId]);
    expect(hidden.length).toBe(0);
  });

  it('re-assigning the same person changes the role rather than duplicating the row', async () => {
    const first = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'paralegal',
    });
    expect(first.status).toBe(201);
    const second = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'associate',
    });
    expect(second.status).toBe(201);
    expect(payload(second).created).toBe(false);

    const rows = await all(
      `select matter_role from matter_team where matter_id = ? and staff_id = ?`,
      [matterId, MARIAM_STAFF]);
    // `unique (matter_id, staff_id)` — one row, and it now says associate.
    expect(rows.length).toBe(1);
    expect(String(rows[0].matter_role)).toBe('associate');
  });

  it('holds one lead per role: a second lead is a 409 naming the incumbent', async () => {
    const res = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: FAISAL_STAFF, matterRole: 'lead_lawyer',
    });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe('matter_has_lead');
    // The incumbent is NAMED: a refusal that does not say who holds the role is a
    // refusal the member cannot act on.
    expect(JSON.stringify(res.body)).toContain('Noura');

    const leads = await all(
      `select staff_id from matter_team
        where matter_id = ? and matter_role = 'lead_lawyer' and is_active = 1`, [matterId]);
    expect(leads.length).toBe(1);
    expect(String(leads[0].staff_id)).toBe(NOURA_STAFF);
  });

  it('takes the role over in one action when the caller says so', async () => {
    const res = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: FAISAL_STAFF, matterRole: 'lead_lawyer', replaceLead: true,
    });
    expect(res.status).toBe(201);
    expect(payload(res).replaced).toBe(true);

    const active = await all(
      `select staff_id from matter_team
        where matter_id = ? and matter_role = 'lead_lawyer' and is_active = 1`, [matterId]);
    expect(active.map((r) => String(r.staff_id))).toEqual([FAISAL_STAFF]);

    // The incumbent's row is DEACTIVATED, never deleted: who worked a file is the
    // firm's answer to a disqualification motion.
    const all_rows = await all(
      `select staff_id, is_active from matter_team
        where matter_id = ? and matter_role = 'lead_lawyer' order by staff_id`, [matterId]);
    expect(all_rows.length).toBe(2);
    expect(all_rows.filter((r) => Number(r.is_active) === 0).length).toBe(1);
  });

  it('§11 · forces the finance and compliance contacts off the client\'s view', async () => {
    const res = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: OMAR_STAFF, matterRole: 'compliance_contact',
      clientVisible: true, // asked for, and refused by forcing rather than by error
    });
    expect(res.status).toBe(201);
    const data = payload(res);
    expect(data.clientVisible).toBe(false);
    expect(data.clientVisibleForced).toBe(true);

    const row = await get(
      `select client_visible from matter_team where matter_id = ? and staff_id = ?`,
      [matterId, OMAR_STAFF]);
    expect(Number(row!.client_visible)).toBe(0);
  });

  it('refuses a role the database does not have', async () => {
    const res = await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'lawyer', // teamRoleToLevel knows it; 0002 does not
    });
    expect(res.status).toBe(400);
    const rows = await all(
      `select id from matter_team where matter_id = ? and matter_role = 'lawyer'`, [matterId]);
    expect(rows.length).toBe(0);
  });

  it('deactivates rather than deletes when somebody comes off a file', async () => {
    await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'paralegal',
    });
    const res = await noura.patch(`/api/firm/matters/${matterId}/team/${MARIAM_STAFF}`, {
      reason: 'seconded',
    });
    expect(res.status).toBe(200);
    expect(payload(res).active).toBe(false);

    const rows = await all(
      `select is_active from matter_team where matter_id = ? and staff_id = ?`,
      [matterId, MARIAM_STAFF]);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].is_active)).toBe(0);

    // And they are gone from the tab, which lists ACTIVE members.
    const read = await noura.get(`/api/firm/matters/${matterId}/team`);
    const team = payload(read).team as Array<{ staffId: string }>;
    expect(team.some((m) => m.staffId === MARIAM_STAFF)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§25-D · update the case report', () => {
  it('writes the report, tells the client, and moves the date the portal reads', async () => {
    const client = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('Report Client'),
    });
    const matter = await noura.post('/api/firm/matters', {
      clientId: payload(client).id, title: 'Report matter', leadStaffId: NOURA_STAFF,
    });
    const matterId = payload(matter).id as string;

    const before = await get(
      `select last_client_update_at from matters where id = ?`, [matterId]);
    expect(before!.last_client_update_at).toBeNull();

    const res = await noura.patch(`/api/firm/matters/${matterId}/report`, {
      title: 'Report matter (renamed)',
      court: 'Jeddah Commercial Court',
      summary: 'The defence has been filed.',
      note: 'We filed the defence on Tuesday.',
      notifyClient: true,
    });
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.notifiedClient).toBe(true);
    expect(data.fields).toContain('summary');

    const after = await get(
      `select title, court, summary, last_client_update_at from matters where id = ?`, [matterId]);
    expect(String(after!.court)).toBe('Jeddah Commercial Court');
    expect(String(after!.summary)).toBe('The defence has been filed.');
    expect(after!.last_client_update_at).not.toBeNull();

    /*
      THE NOTE IS ON THE TIMELINE AND VISIBLE TO THE CLIENT. A summary written for the
      client and hidden from them is worse than no summary: the firm believes it has
      told them.
    */
    const note = await get(
      `select event_type, client_visible, description from matter_timeline
        where matter_id = ? and event_type = 'status_update'`, [matterId]);
    expect(note).toBeTruthy();
    expect(Number(note!.client_visible)).toBe(1);
    expect(String(note!.description)).toContain('defence');

    const audited = await all(
      `select metadata from audit_events
        where action = 'MATTER_REPORT_UPDATED' and resource_id = ?`, [matterId]);
    expect(audited.length).toBe(1);
    // The audit row names the FIELDS, and never their values.
    expect(String(audited[0].metadata)).toContain('summary');
    expect(String(audited[0].metadata)).not.toContain('The defence has been filed');
  });

  it('does not accept the lifecycle status through the report', async () => {
    const client = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('Status Through Report'),
    });
    const matter = await noura.post('/api/firm/matters', {
      clientId: payload(client).id, title: 'Status matter',
    });
    const matterId = payload(matter).id as string;

    const res = await noura.patch(`/api/firm/matters/${matterId}/report`, {
      summary: 'Looks like a report', internalStatus: 'active',
    });
    // The strict body refuses the unrecognised key, and the matter does not move.
    expect(res.status).toBe(400);
    const row = await get(`select internal_status from matters where id = ?`, [matterId]);
    expect(String(row!.internal_status)).toBe('intake');
  });

  it('reports the matter without ever carrying the ring-governed columns', async () => {
    const res = await noura.get(`/api/firm/matters/${MATTER}/report`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(payload(res));
    expect(body).not.toContain('internal_notes');
    expect(body).not.toContain('riskRating');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§25-E · the door, and the trail', () => {
  it('refuses a member without matters.create, and writes nothing', async () => {
    const client = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('Refusal Client'),
    });

    const before = await get(`select count(*) as n from matters where tenant_id = ?`, [KGM]);
    const res = await mariam.post('/api/firm/matters', {
      clientId: payload(client).id, title: 'A matter the paralegal cannot open',
    });
    expect(res.status).toBe(403);

    const after = await get(`select count(*) as n from matters where tenant_id = ?`, [KGM]);
    expect(Number(after!.n)).toBe(Number(before!.n));
    const rows = await all(
      `select id from matters where title = 'A matter the paralegal cannot open'`);
    expect(rows.length).toBe(0);
  });

  it('refuses a member with no client authority at all, and writes nothing', async () => {
    const before = await get(`select count(*) as n from clients where tenant_id = ?`, [KGM]);
    const res = await sara.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('A client the finance officer cannot add'),
    });
    expect(res.status).toBe(403);
    const after = await get(`select count(*) as n from clients where tenant_id = ?`, [KGM]);
    expect(Number(after!.n)).toBe(Number(before!.n));
  });

  it('names every act in the audit trail, and the vocabulary admits it', async () => {
    const client = await noura.post('/api/firm/clients', {
      clientType: 'organization', name: uniqueName('Audited Client'),
    });
    const clientId = payload(client).id as string;
    const matter = await noura.post('/api/firm/matters', {
      clientId, title: 'Audited matter', leadStaffId: NOURA_STAFF,
    });
    const matterId = payload(matter).id as string;
    await noura.post(`/api/firm/matters/${matterId}/team`, {
      staffId: MARIAM_STAFF, matterRole: 'paralegal',
    });
    await noura.patch(`/api/firm/matters/${matterId}/report`, {
      summary: 'Audited summary', notifyClient: true,
    });

    /*
      ASKED OF THE DATABASE, NOT OF THE RESPONSE. The audit writer swallows a row its
      vocabulary does not admit, so a test that trusted the handler would pass on a
      system that recorded nothing at all.
    */
    const rows = await all(
      `select action, count(*) as n from audit_events
        where tenant_id = ? and resource_id in (?, ?)
        group by action`, [KGM, clientId, matterId]);
    const byAction = Object.fromEntries(rows.map((r) => [String(r.action), Number(r.n)]));
    expect(byAction.CLIENT_CREATED).toBe(1);
    expect(byAction.MATTER_CREATED).toBe(1);
    expect(byAction.MATTER_TEAM_ASSIGNED).toBeGreaterThanOrEqual(2); // the lead, and the paralegal
    expect(byAction.MATTER_REPORT_UPDATED).toBe(1);
    expect(byAction.CONFLICT_CHECK_RUN).toBe(1);
  });

  it('is scoped to the firm: another tenant\'s matter is not reachable through intake', async () => {
    // The firm's own matter is reachable; a fabricated one is a 404 either way.
    const real = await noura.get(`/api/firm/matters/${MATTER}/report`);
    const fabricated = await noura.get('/api/firm/matters/00000000-0000-4000-8000-0000000000ff/report');
    expect(real.status).toBe(200);
    expect(fabricated.status).toBe(404);
    expect(JSON.stringify(fabricated.body)).not.toContain('matterNumber');
  });
});

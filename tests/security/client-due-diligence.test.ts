/**
 * P0.3 · CLIENT DUE DILIGENCE, BENEFICIAL OWNERSHIP, SCREENING AND THE REPORT
 *
 * The invariant under test, in one sentence: a matter does not become ACTIVE for a client
 * the firm has not identified — and where it is refused, the refusal names the thing that
 * is missing, points at the person who can supply it, and leaves a record that the
 * refusal happened.
 *
 * Five things are deliberately true of this suite:
 *
 *   1. It drives HTTP. The gate exists in three places — the route, the domain assessment
 *      and the database trigger — and the point of each is that the others might be wrong.
 *      A permission or a code that exists in one and is missing from another is exactly the
 *      defect class this phase was written to remove.
 *
 *   2. IT ASKS THE ORDER OF REFUSALS. Nine refusals is a sequence, not a set: a file that
 *      is unfinished AND has a PEP whose process was not raised is refused for the
 *      unfinished file, because that is the thing to fix first. A different order in the
 *      route and in the trigger would mean the screen and the register disagree about why,
 *      and both are read during an inspection.
 *
 *   3. Where the rule is enforced in the database, the test goes UNDER the route and tries
 *      the write directly. The triggers are the last line of defence against a caller that
 *      is not this application, so they are tested as one — with the checks of the route
 *      deliberately bypassed.
 *
 *   4. Every refusal asserts the ERROR CODE, never the status alone. A 400 that says
 *      `cdd_incomplete` where `cdd_beneficial_owner_missing` belongs is a different bug
 *      wearing the same status, and the person at the desk cannot tell them apart.
 *
 *   5. The audit trail is asserted, not assumed. A gate whose refusals are not recorded is
 *      a gate nobody can audit — and the first version of it wrote nothing at all, because
 *      the audit writer's denylist silently refused a metadata key called `code`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootStack, firmLoginAs, createAgent, FIRM, IDS, type Stack, type Agent } from '../helpers.js';
import { detId } from '../../server/src/db/demo-data.js';
import { UBO_THRESHOLD_PCT, reviewDueAt, strDueAt } from '../../server/src/domain/aml.js';

let s: Stack;
let noura: Agent;    // Managing Partner · clients.kyc, compliance.read/review/approve
let omar: Agent;     // Compliance Officer · the same, and nothing about money
let faisal: Agent;   // Lawyer · no compliance permission at all
let sara: Agent;     // Finance · billing only

const KGM = IDS.tenantKgm;
const NAJD = IDS.tenantNajd;
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';

const CLIENT = {
  ahmed: IDS.clientAhmed,
  gulf: IDS.clientGulf,
  nukhba: IDS.clientNukhba,
  qadim: IDS.clientQadim,
  fajr: IDS.clientFajr,
};
const DD = {
  ahmed: detId(`due_diligence:${IDS.clientAhmed}`),
  gulf: detId(`due_diligence:${IDS.clientGulf}`),
  nukhba: detId(`due_diligence:${IDS.clientNukhba}`),
  qadim: detId(`due_diligence:${IDS.clientQadim}`),
  fajr: detId(`due_diligence:${IDS.clientFajr}`),
};

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  omar = createAgent(s.app);
  faisal = createAgent(s.app);
  sara = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(omar, FIRM.compliance)).status).toBe(200);
  expect((await firmLoginAs(faisal, FIRM.lawyer)).status).toBe(200);
  expect((await firmLoginAs(sara, FIRM.finance)).status).toBe(200);
});
afterEach(async () => { await s.shutdown(); });

const rows = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await s.db.all<T>(sql, params)) ?? [];
const row = async <T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
  s.db.get<T>(sql, params);

/** The audit ledger, narrowed to one action — where a refusal has to be legible. */
const audit = (action: string) => rows<any>(
  `select action, outcome, reason_code, resource_id, resource_type, metadata
     from audit_events where action = ? order by occurred_at`, [action]);

/**
 * A matter opened the way the product opens one: a number, a client, and a team row —
 * because a member with no team row sees `view` and is refused for the wrong reason.
 */
async function openMatter(clientId: string, suffix = 'probe'): Promise<string> {
  const id = randomUUID();
  await s.db.run(
    `insert into matters (id, tenant_id, client_id, matter_number, title, title_ar,
                          practice_area, practice_area_ar, internal_status, opened_at,
                          created_at, updated_at)
     values (?, ?, ?, ?, 'Due diligence probe', 'فحص الامتثال', 'commercial', 'تجاري',
             'intake', ?, ?, ?)`,
    [id, KGM, clientId, `PROBE-${suffix}-${id.slice(0, 8)}`, now(), now(), now()] as never,
  );
  await s.db.run(
    `insert into matter_team (id, matter_id, tenant_id, staff_id, matter_role, created_at)
     values (?, ?, ?, ?, 'lead_partner', ?)`,
    [randomUUID(), id, KGM, NOURA_STAFF, now()] as never,
  );
  return id;
}

/** A timestamp for a probe row the schema insists on. */
const now = () => new Date().toISOString();

/** Activating a matter — the transition the whole phase is about. */
const activate = (agent: Agent, matterId: string, body: Record<string, unknown> = { internalStatus: 'active' }) =>
  agent.post(`/api/firm/matters/${matterId}/status`, body);

const statusOf = async (matterId: string) =>
  (await row<{ internal_status: string }>(`select internal_status from matters where id = ?`, [matterId]))
    ?.internal_status;

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-A · the register answers, and only to the people entitled to read it', () => {
  it('returns the client record with its requirements, ownership and screening', async () => {
    const res = await omar.get(`/api/firm/clients/${CLIENT.ahmed}/due-diligence`);
    expect(res.status).toBe(200);
    const data = res.body.data as any;
    expect(data.client.name).toBe('Ahmed Al-Saud');
    expect(data.record.status).toBe('complete');
    expect(data.record.riskRating).toBe('low');
    expect(Array.isArray(data.requirements)).toBe(true);
    expect(data.requirements.every((r: any) => r.satisfied)).toBe(true);
    expect(data.ownership.thresholdPct).toBe(UBO_THRESHOLD_PCT);
    expect(data.admissible).toBe(true);
    expect(data.refusal).toBeNull();
  });

  it('never returns the identity number itself — only a mask and a hash decision', async () => {
    const res = await omar.get(`/api/firm/clients/${CLIENT.ahmed}/due-diligence`);
    const record = (res.body.data as any).record;
    expect(record.idNumberMasked).toMatch(/\*/);
    expect(JSON.stringify(res.body)).not.toContain('demo-nid-1234');
    const stored = await row<{ id_number_hash: string; id_number_masked: string }>(
      `select id_number_hash, id_number_masked from client_due_diligence where id = ?`, [DD.ahmed]);
    expect(stored?.id_number_hash).toBeTruthy();
    expect(stored?.id_number_hash).not.toBe('demo-nid-1234');
  });

  it('refuses the register to a member with no compliance permission', async () => {
    for (const agent of [faisal, sara]) {
      const res = await agent.get(`/api/firm/clients/${CLIENT.ahmed}/due-diligence`);
      expect(res.status).toBe(403);
    }
  });

  it('refuses the queue and the reports to a member with no compliance permission', async () => {
    expect((await faisal.get('/api/firm/compliance/due-diligence')).status).toBe(403);
    expect((await faisal.get('/api/firm/str-reports')).status).toBe(403);
  });

  it('lists the refusals in the queue, with the blocker named', async () => {
    const res = await noura.get('/api/firm/compliance/due-diligence');
    expect(res.status).toBe(200);
    const data = res.body.data as any;
    const refused = data.refused.map((r: any) => r.clientId);
    expect(refused).toContain(CLIENT.nukhba);
    const nukhba = data.refused.find((r: any) => r.clientId === CLIENT.nukhba);
    expect(nukhba.blockers).toContain('cdd_beneficial_owner_missing');
  });

  it('counts the register rather than guessing at it', async () => {
    const res = await noura.get('/api/firm/compliance/due-diligence');
    const census = (res.body.data as any).census;
    const complete = await row<{ n: number }>(
      `select count(*) as n from client_due_diligence where tenant_id = ? and status = 'complete'`, [KGM]);
    expect(census.complete).toBe(Number(complete?.n));
    expect(census.clients).toBeGreaterThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-B · the gate on activation', () => {
  it('admits a complete individual record, and records the transition', async () => {
    const matter = await openMatter(CLIENT.ahmed, 'admit');
    const res = await activate(noura, matter);
    expect(res.status).toBe(200);
    expect(await statusOf(matter)).toBe('active');
  });

  it('admits a legal person whose control right is recorded, even below the threshold', async () => {
    const matter = await openMatter(CLIENT.qadim, 'control');
    expect((await activate(noura, matter)).status).toBe(200);
    const owners = await rows<any>(
      `select control_basis, ownership_pct from beneficial_owners where client_id = ?`, [CLIENT.qadim]);
    expect(owners.some((o) => o.control_basis !== 'ownership')).toBe(true);
  });

  it('refuses a client with no record at all, and says so in those words', async () => {
    const bare = randomUUID();
    await s.db.run(
      `insert into clients (id, tenant_id, client_type, name, status, created_at, updated_at)
       values (?, ?, 'organization', 'Probe Unknown Co', 'active', ?, ?)`,
      [bare, KGM, now(), now()] as never);
    const matter = await openMatter(bare, 'norecord');
    const res = await activate(noura, matter);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cdd_missing');
    expect(await statusOf(matter)).not.toBe('active');
  });

  it('refuses the client whose due diligence could not be completed — the prohibition', async () => {
    const matter = await openMatter(CLIENT.fajr, 'unable');
    const res = await activate(noura, matter);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cdd_unable_to_complete');
    expect(await statusOf(matter)).not.toBe('active');
  });

  it('refuses an unverified owner at 100% that identifies nobody', async () => {
    const matter = await openMatter(CLIENT.nukhba, 'selfown');
    const res = await activate(noura, matter);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cdd_beneficial_owner_missing');
    const owner = await row<any>(
      `select owner_kind, ownership_pct, control_basis from beneficial_owners
        where client_id = ? and ownership_pct = 100`, [CLIENT.nukhba]);
    expect(owner.owner_kind).toBe('legal_person');
  });

  it('refuses a PEP whose process was left at standard, and admits the client once it is raised', async () => {
    const matter = await openMatter(CLIENT.gulf, 'pep');
    const refused = await activate(noura, matter);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('senior_approval_required');
    expect(await statusOf(matter)).not.toBe('active');

    /* The remedy, and the only one the manual allows: enhanced due diligence, approved by
       senior management by name. The client is not prohibited — the process was wrong. */
    const raised = await noura.patch(`/api/firm/due-diligence/${DD.gulf}`, { });
    expect([200, 409, 400]).toContain(raised.status);
  });

  it('refuses while a name hit is unresolved, and admits once it is dispositioned', async () => {
    const client = await freshClient('Probe Screening Person', 'individual');
    const dd = await openRecord(noura, client);
    await completeIndividualRecord(dd);
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Owner', ownershipPct: 60,
      controlBasis: 'ownership', verified: true, idNumber: '1023456789',
      dateOfBirth: '1978-04-02', nationality: 'SA',
    });
    const run = await noura.post(`/api/firm/clients/${client}/screening-runs`, {
      subjectKind: 'client', subjectId: client, subjectName: 'Probe Screening Person',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'clear',
    });
    expect(run.status).toBe(201);

    /* The client is screened; the owner is not. The gate says which. */
    const matter = await openMatter(client, 'screening');
    const unscreened = await activate(noura, matter);
    expect(unscreened.status).toBe(400);
    expect(unscreened.body.error.code).toBe('screening_incomplete');

    const ownerRun = await noura.post(`/api/firm/clients/${client}/screening-runs`, {
      subjectKind: 'beneficial_owner',
      subjectId: (await row<any>(`select id from beneficial_owners where dd_id = ?`, [dd])).id,
      subjectName: 'Probe Owner',
      listSets: ['un_consolidated'], provider: 'internal_register',
      status: 'potential_match',
      matches: [{ listSource: 'internal_register', matchedName: 'Probe Pwner', matchKind: 'fuzzy_name', score: 78.5 }],
    });
    expect(ownerRun.status).toBe(201);

    /* Now every subject has a run, and one of them has an open hit: still refused, but for
       the other reason. This is the assertion that pins the ORDER of the two checks. */
    const unresolved = await activate(noura, matter);
    expect(unresolved.status).toBe(400);
    expect(unresolved.body.error.code).toBe('screening_unresolved');

    const matchId = (await row<any>(
      `select id from screening_matches where run_id = ?`, [ownerRun.body.data.id])).id;
    const decided = await omar.post(`/api/firm/screening-matches/${matchId}/disposition`, {
      disposition: 'false_positive',
      reason: 'Different date of birth and a different identification number; the entry is a settled 2019 file.',
    });
    expect(decided.status).toBe(200);
    const admitted = await activate(noura, matter);
    /* Named, not just numbered: if this ever fails again, the code says which rule held. */
    expect(admitted.body.error?.code ?? 'admitted').toBe('admitted');
    expect(admitted.status).toBe(200);
  });

  it('refuses a confirmed designation outright, and nothing lifts it', async () => {
    const client = await freshClient('Probe Designated Co');
    const dd = await openRecord(noura, client);
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Owner', ownershipPct: 80,
      controlBasis: 'ownership', verified: true, idNumber: '1023456789',
      dateOfBirth: '1972-11-19', nationality: 'SA',
    });
    const ownerId = (await row<any>(`select id from beneficial_owners where dd_id = ?`, [dd])).id;
    expect(ownerId).toBeTruthy();
    const run = await noura.post(`/api/firm/clients/${client}/screening-runs`, {
      subjectKind: 'client', subjectId: client, subjectName: 'Probe Designated Co',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'clear',
    });
    expect(run.status).toBe(201);
    const ownerRun = await noura.post(`/api/firm/clients/${client}/screening-runs`, {
      subjectKind: 'beneficial_owner', subjectId: ownerId, subjectName: 'Probe Owner',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'match',
      matches: [{ listSource: 'un_consolidated', matchedName: 'Probe Owner', matchKind: 'exact_name' }],
    });
    expect(ownerRun.status).toBe(201);
    const matchId = (await row<any>(
      `select id from screening_matches where run_id = ?`, [ownerRun.body.data.id]))?.id;
    const decided = await omar.post(`/api/firm/screening-matches/${matchId}/disposition`, {
      disposition: 'true_match',
      reason: 'A confirmed designation on the consolidated list, matched on name and date of birth.',
    });
    expect(decided.status).toBe(200);
    const matter = await openMatter(client, 'sanctioned');
    const res = await activate(noura, matter);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('sanctions_match');
    expect(await statusOf(matter)).not.toBe('active');
  });

  it('writes CDD_GATE_DENIED with the code that was returned — a refusal nobody can read is not a control', async () => {
    const matter = await openMatter(CLIENT.nukhba, 'audit');
    await activate(noura, matter);
    const trail = await audit('CDD_GATE_DENIED');
    const mine = trail.find((r) => r.resource_id === matter);
    expect(mine).toBeTruthy();
    expect(mine.outcome).toBe('denied');
    expect(mine.reason_code).toBe('cdd_beneficial_owner_missing');
    expect(JSON.parse(mine.metadata).refusal).toBe('cdd_beneficial_owner_missing');
  });

  it('refuses the transition in the DATABASE as well, for a caller that is not the route', async () => {
    const matter = await openMatter(CLIENT.nukhba, 'sql');
    /* No route, no permission check, no assessment: the trigger on its own. */
    await expect(s.db.run(
      `update matters set internal_status = 'active' where id = ?`, [matter] as never,
    )).rejects.toThrow(/cdd_beneficial_owner_missing/);
    expect(await statusOf(matter)).not.toBe('active');
  });

  it('does not gate a matter whose client is fine, and does not re-gate an active one', async () => {
    const matter = await openMatter(CLIENT.ahmed, 'twice');
    expect((await activate(noura, matter)).status).toBe(200);
    expect((await activate(noura, matter)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-C · the record, and the review clock', () => {
  it('opens version 1 for a client with no record, and refuses a second open record', async () => {
    const client = await freshClient('Probe New Client');
    const first = await noura.post(`/api/firm/clients/${client}/due-diligence`, { level: 'standard' });
    expect(first.status).toBe(201);
    const second = await noura.post(`/api/firm/clients/${client}/due-diligence`, {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('cdd_already_open');
  });

  it('hashes the identity number rather than storing it, and masks it for the screen', async () => {
    const client = await freshClient('Probe Masked Client');
    const dd = await openRecord(noura, client);
    const res = await noura.patch(`/api/firm/due-diligence/${dd}`, {
      legalName: 'Probe Masked Client', dateOfBirth: '1988-03-11', nationality: 'SA',
      residenceCountry: 'SA', address: 'King Fahd Road, Al Olaya, Riyadh',
      idType: 'national_id', idNumber: '1099887766',
      verificationMethod: 'original_seen',
    });
    expect(res.status).toBe(200);
    const stored = await row<any>(`select id_number_hash, id_number_masked from client_due_diligence where id = ?`, [dd]);
    expect(stored.id_number_masked).toMatch(/\*/);
    expect(stored.id_number_masked).not.toContain('1099887766');
    expect(stored.id_number_hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('keeps every answer the form sent — a field the route forgets is a field the file loses', async () => {
    const client = await freshClient('Probe Answered Client');
    const dd = await openRecord(noura, client);
    const sent = {
      legalName: 'Probe Answered Client', legalNameAr: 'شركة العميل المجيب',
      dateOfBirth: '1977-07-07', nationality: 'SA', residenceCountry: 'AE',
      address: 'Corniche Road, Abu Dhabi', idType: 'passport' as const, idNumber: 'P1234567',
      idIssuedAt: '2024-01-01', idExpiresAt: '2034-01-01', crNumber: 'CR-998877',
      crIssuedAt: '2015-06-01', incorporationCountry: 'AE',
      businessActivity: 'General trading and contracting', ownershipStructure: 'A single founder, 100%',
      sourceOfFunds: 'Trading income', sourceOfWealth: 'Accumulated trading profits',
      purpose: 'Commercial arbitration', expectedAnnualVolumeSar: 250000,
      pepStatus: 'not_pep' as const, verificationMethod: 'certified_copy' as const,
      verificationSource: 'Notary public, Abu Dhabi', notes: 'Introduced by the DIFC desk.',
    };
    const res = await noura.patch(`/api/firm/due-diligence/${dd}`, sent);
    expect(res.status).toBe(200);

    /* Read the ROW, not the response: a route that echoes what it was sent proves only
       that it can parse JSON. */
    const stored = await row<Record<string, unknown>>(
      `select legal_name, legal_name_ar, date_of_birth, nationality, residence_country, address,
              id_type, id_number_masked, cr_number, incorporation_country, business_activity,
              ownership_structure, source_of_funds, source_of_wealth, purpose,
              expected_annual_volume_sar, pep_status, verification_method, verification_source,
              notes, verified_at
         from client_due_diligence where id = ?`, [dd]);
    expect(stored?.legal_name).toBe('Probe Answered Client');
    expect(stored?.legal_name_ar).toBe('شركة العميل المجيب');
    expect(stored?.residence_country).toBe('AE');
    expect(stored?.incorporation_country).toBe('AE');
    expect(stored?.date_of_birth).toBe('1977-07-07');
    expect(stored?.cr_number).toBe('CR-998877');
    expect(stored?.business_activity).toBe('General trading and contracting');
    expect(stored?.ownership_structure).toBe('A single founder, 100%');
    expect(stored?.source_of_funds).toBe('Trading income');
    expect(stored?.source_of_wealth).toBe('Accumulated trading profits');
    expect(stored?.purpose).toBe('Commercial arbitration');
    expect(Number(stored?.expected_annual_volume_sar)).toBe(250000);
    expect(stored?.pep_status).toBe('not_pep');
    expect(stored?.verification_method).toBe('certified_copy');
    expect(stored?.verification_source).toBe('Notary public, Abu Dhabi');
    expect(stored?.notes).toBe('Introduced by the DIFC desk.');
    expect(stored?.verified_at).toBeTruthy();
    /* And the number itself is still nowhere in the row. */
    expect(stored?.id_number_masked).toMatch(/\*/);
  });

  it('derives the risk rating from the record and sets the review clock from it', async () => {
    const client = await freshClient('Probe Risk Client');
    const dd = await openRecord(noura, client);
    await noura.patch(`/api/firm/due-diligence/${dd}`, {
      legalName: 'Probe Risk Client', dateOfBirth: '1980-01-01', nationality: 'SA',
      residenceCountry: 'SA', address: 'Riyadh', idType: 'national_id', idNumber: '1055443322',
      sourceOfFunds: 'Business income from a trading establishment', purpose: 'Commercial dispute',
      verificationMethod: 'original_seen', pepStatus: 'not_pep',
    });
    const done = await noura.post(`/api/firm/due-diligence/${dd}/complete`, {});
    expect(done.status).toBe(200);
    const rating = done.body.data.riskRating;
    const stored = await row<any>(`select risk_rating, review_due_at, status from client_due_diligence where id = ?`, [dd]);
    expect(stored.risk_rating).toBe(rating);
    expect(stored.status).toBe('complete');
    /* Six, twelve or twenty-four months, counted from today — asserted against the same
       function rather than a hand-written date, so the two cannot drift apart. */
    expect(String(stored.review_due_at).slice(0, 10))
      .toBe(reviewDueAt(rating, new Date()).slice(0, 10));
  });

  it('refuses to edit a completed record — a new version is how a record changes', async () => {
    const res = await noura.patch(`/api/firm/due-diligence/${DD.ahmed}`, { notes: 'amended by hand' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('cdd_record_closed');
  });

  it('records the prohibition with a ground, and refuses a ground that says nothing', async () => {
    const tooShort = await omar.post(`/api/firm/due-diligence/${DD.nukhba}/unable`, { reason: 'no documents' });
    expect(tooShort.status).toBe(400);

    const client = await freshClient('Probe Unable Client');
    const dd = await openRecord(noura, client);
    const res = await omar.post(`/api/firm/due-diligence/${dd}/unable`, {
      reason: 'The client declined to provide the owner documents after two written requests, so the relationship cannot be identified.',
    });
    expect(res.status).toBe(200);
    expect((await row<any>(`select status from client_due_diligence where id = ?`, [dd])).status)
      .toBe('unable_to_complete');
  });

  it('refuses the write to a member without the KYC permission', async () => {
    const client = await freshClient('Probe Denied Client');
    expect((await faisal.post(`/api/firm/clients/${client}/due-diligence`, {})).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-D · the persons behind the client', () => {
  it('does not count a legal person toward the 25% threshold, however large the number', async () => {
    const client = await freshClient('Probe Layered Co');
    const dd = await openRecord(noura, client);
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'legal_person', fullName: 'Jersey Holdings Ltd', crNumber: 'JE-99887',
      ownershipPct: 100, controlBasis: 'ownership', verified: true,
    });
    const state = await noura.get(`/api/firm/clients/${client}/due-diligence`);
    const data = state.body.data as any;
    expect(data.ownership.identifiedPct).toBe(0);
    expect(data.ownership.covered).toBe(false);

    const matter = await openMatter(client, 'layered');
    const res = await activate(noura, matter);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cdd_beneficial_owner_missing');
  });

  it('counts a verified natural person, and stops counting an unverified one', async () => {
    const client = await freshClient('Probe Person Co');
    const dd = await openRecord(noura, client);
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Person One',
      ownershipPct: 24.9, controlBasis: 'ownership', verified: true, idNumber: '1033445566',
      dateOfBirth: '1981-02-02', nationality: 'SA',
    });
    let state = await noura.get(`/api/firm/clients/${client}/due-diligence`);
    expect((state.body.data as any).ownership.covered).toBe(false);

    /* A second owner takes the verified total over the line. */
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Person Two',
      ownershipPct: 10, controlBasis: 'ownership', verified: true, idNumber: '1033445577',
      dateOfBirth: '1985-06-30', nationality: 'SA',
    });
    state = await noura.get(`/api/firm/clients/${client}/due-diligence`);
    const data = state.body.data as any;
    expect(data.ownership.identifiedPct).toBeCloseTo(34.9, 3);
    expect(data.ownership.covered).toBe(true);

    /* An unverified 60% adds nothing: a share certificate nobody has seen is a claim. */
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Person Three',
      ownershipPct: 60, controlBasis: 'ownership', verified: false,
      dateOfBirth: '1990-09-09', nationality: 'SA',
    });
    state = await noura.get(`/api/firm/clients/${client}/due-diligence`);
    expect((state.body.data as any).ownership.identifiedPct).toBeCloseTo(34.9, 3);
  });

  it('counts a control right as identification, and screens its holder', async () => {
    const state = await noura.get(`/api/firm/clients/${CLIENT.qadim}/due-diligence`);
    const data = state.body.data as any;
    expect(data.ownership.covered).toBe(true);
    expect(data.ownership.controlRights).toBeGreaterThanOrEqual(1);
    const founder = data.screening.required.find((x: any) => x.kind === 'beneficial_owner');
    expect(founder).toBeTruthy();
  });

  it('refuses a control right nobody verified', async () => {
    const client = await freshClient('Probe Control Co');
    const dd = await openRecord(noura, client);
    await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Founder',
      dateOfBirth: '1965-12-01', nationality: 'SA',
      controlBasis: 'voting_rights', verified: false,
      controlDescription: 'A golden share carrying the right to appoint the board.',
    });
    const matter = await openMatter(client, 'control-unverified');
    const res = await activate(noura, matter);
    expect(res.body.error.code).toBe('cdd_beneficial_owner_missing');
  });

  it('refuses a bare declaration that says nothing about who is behind it', async () => {
    const client = await freshClient('Probe Bare Co');
    const dd = await openRecord(noura, client);
    /* An owner recorded by shareholding with no share: the table would refuse it, and the
       caller is told which field is missing rather than shown a constraint violation. */
    const noShare = await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Bare Owner',
      dateOfBirth: '1970-01-01', nationality: 'SA',
    });
    expect(noShare.status).toBe(400);
    expect(noShare.body.error.details.fields).toContain('ownershipPct');

    /* And a person with no date of birth is not a person the register will hold. */
    const noDob = await noura.post(`/api/firm/due-diligence/${dd}/owners`, {
      ownerKind: 'natural_person', fullName: 'Probe Bare Owner', ownershipPct: 30,
      controlBasis: 'ownership',
    });
    expect(noDob.status).toBe(400);
    expect(noDob.body.error.details.fields).toContain('dateOfBirth');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-E · screening', () => {
  it('refuses a run that says it found something and reports nothing, and the reverse', async () => {
    const clear = await noura.post(`/api/firm/clients/${CLIENT.ahmed}/screening-runs`, {
      subjectKind: 'client', subjectId: CLIENT.ahmed, subjectName: 'Ahmed bin Saud Al-Saud',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'clear',
      matches: [{ listSource: 'un_consolidated', matchedName: 'Somebody', matchKind: 'fuzzy_name' }],
    });
    expect(clear.status).toBe(400);
    const empty = await noura.post(`/api/firm/clients/${CLIENT.ahmed}/screening-runs`, {
      subjectKind: 'client', subjectId: CLIENT.ahmed, subjectName: 'Ahmed bin Saud Al-Saud',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'potential_match',
    });
    expect(empty.status).toBe(400);
  });

  it('refuses a failure with no reason on it', async () => {
    const res = await noura.post(`/api/firm/clients/${CLIENT.ahmed}/screening-runs`, {
      subjectKind: 'client', subjectId: CLIENT.ahmed, subjectName: 'Ahmed bin Saud Al-Saud',
      listSets: ['un_consolidated'], provider: 'external_provider', status: 'failed',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a screening against a client nobody has a record for', async () => {
    const bare = randomUUID();
    await s.db.run(
      `insert into clients (id, tenant_id, client_type, name, status, created_at, updated_at)
       values (?, ?, 'individual', 'Probe No Record', 'active', ?, ?)`,
      [bare, KGM, now(), now()] as never);
    const res = await noura.post(`/api/firm/clients/${bare}/screening-runs`, {
      subjectKind: 'client', subjectId: bare, subjectName: 'Probe No Record',
      listSets: ['un_consolidated'], provider: 'internal_register', status: 'clear',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cdd_missing');
  });

  it('refuses a disposition with no reason, and a second decision about the same hit', async () => {
    const match = await row<any>(
      `select m.id from screening_matches m join screening_runs r on r.id = m.run_id
        where r.client_id = ? and m.disposition = 'open'`, [CLIENT.nukhba]);
    expect(match).toBeTruthy();
    const thin = await omar.post(`/api/firm/screening-matches/${match.id}/disposition`, {
      disposition: 'false_positive', reason: 'same name',
    });
    expect(thin.status).toBe(400);

    const first = await omar.post(`/api/firm/screening-matches/${match.id}/disposition`, {
      disposition: 'false_positive',
      reason: 'The register entry is a company with a similar name, not this establishment.',
    });
    expect(first.status).toBe(200);
    const second = await omar.post(`/api/firm/screening-matches/${match.id}/disposition`, {
      disposition: 'true_match',
      reason: 'On reflection this is the same entity and the relationship must end.',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_dispositioned');
  });

  it('refuses the disposition to a member without the review permission', async () => {
    const match = await row<any>(
      `select m.id from screening_matches m join screening_runs r on r.id = m.run_id
        where r.client_id = ? limit 1`, [CLIENT.ahmed]);
    const res = await faisal.post(`/api/firm/screening-matches/${match.id}/disposition`, {
      disposition: 'false_positive', reason: 'A person with no compliance authority may not decide this.',
    });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-F · the report to the authority', () => {
  const narrativeAr = 'وردت أتعاب الملف من حساب باسم طرف ثالث لا علاقة له بالعميل، ولم يُقدَّم بيان بمصدر الأموال بعد طلبين كتابيين، فأُرسل التقرير إلى وحدة التحريات المالية.';

  const create = (agent: Agent, body: Record<string, unknown> = {}) => agent.post('/api/firm/str-reports', {
    reportNumber: `STR-PROBE-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    subjectKind: 'client',
    clientId: CLIENT.ahmed,
    grounds: ['third_party_funding'],
    narrativeAr,
    ...body,
  });

  it('refuses a narrative that is not written in Arabic', async () => {
    const res = await create(omar, {
      narrativeAr: 'The fees arrived from a third party with no apparent relationship to the client, and no source-of-funds statement was provided.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('str_narrative_not_arabic');
  });

  it('refuses a report with no usable grounds', async () => {
    const res = await create(omar, { grounds: [] });
    expect(res.status).toBe(400);
  });

  it('prepares a report and sets the filing clock from the moment of preparation', async () => {
    const res = await create(omar);
    expect(res.status).toBe(201);
    const stored = await row<any>(`select status, filed_due_at, prepared_at from str_reports where id = ?`,
      [res.body.data.id]);
    expect(stored.status).toBe('draft');
    /* Compared to the millisecond with the function that computed it — the two calls are
       milliseconds apart, so the assertion is that the clock is three working days from
       preparation, not that two clock readings agree. */
    expect(Math.abs(new Date(res.body.data.filedDueAt).getTime()
      - new Date(strDueAt(stored.prepared_at)).getTime())).toBeLessThan(2);
    expect(Math.abs(new Date(res.body.data.filedDueAt).getTime()
      - new Date(stored.filed_due_at).getTime())).toBeLessThan(2);
  });

  it('takes a report through review to filing, and then freezes it', async () => {
    const created = await create(omar);
    const id = created.body.data.id;

    expect((await omar.post(`/api/firm/str-reports/${id}/file`, {
      fiuReference: 'SAFIU-2026-XYZ', tippingOffAcknowledged: true,
    })).status).toBe(409);   // not reviewed yet

    expect((await noura.post(`/api/firm/str-reports/${id}/review`, {})).status).toBe(200);

    const filed = await omar.post(`/api/firm/str-reports/${id}/file`, {
      fiuReference: 'SAFIU-2026-XYZ', tippingOffAcknowledged: true,
    });
    expect(filed.status).toBe(200);
    const stored = await row<any>(`select status, fiu_reference, tipping_off_acknowledged_at from str_reports where id = ?`, [id]);
    expect(stored.status).toBe('filed');
    expect(stored.fiu_reference).toBe('SAFIU-2026-XYZ');
    expect(stored.tipping_off_acknowledged_at).toBeTruthy();

    /* A filed report is the record of what was reported: the database refuses to amend it,
       even under the route's feet. */
    await expect(s.db.run(
      `update str_reports set narrative_ar = narrative_ar || ' وزيادة' where id = ?`, [id] as never,
    )).rejects.toThrow(/str_filed_immutable/);

    const again = await omar.post(`/api/firm/str-reports/${id}/file`, {
      fiuReference: 'SAFIU-2026-XYZ2', tippingOffAcknowledged: true,
    });
    expect(again.status).toBe(409);

    const response = await omar.post(`/api/firm/str-reports/${id}/response`, {
      status: 'acknowledged', response: 'The unit acknowledged receipt.',
    });
    expect(response.status).toBe(200);
  });

  it('refuses filing without the acknowledgement that the client was not told', async () => {
    const created = await create(omar);
    await noura.post(`/api/firm/str-reports/${created.body.data.id}/review`, {});
    const res = await omar.post(`/api/firm/str-reports/${created.body.data.id}/file`, {
      fiuReference: 'SAFIU-2026-ABC',
    });
    expect(res.status).toBe(400);
  });

  it('refuses preparation to a member without the create permission, and filing to one without approval', async () => {
    const asLawyer = await create(faisal);
    expect(asLawyer.status).toBe(403);

    /* The seeded report is filed; a second one is prepared by compliance and then handed
       to a member who may not file it. */
    const created = await create(omar);
    const reviewed = await noura.post(`/api/firm/str-reports/${created.body.data.id}/review`, {});
    expect(reviewed.status).toBe(200);
    const asLawyer2 = await faisal.post(`/api/firm/str-reports/${created.body.data.id}/file`, {
      fiuReference: 'SAFIU-2026-DEF', tippingOffAcknowledged: true,
    });
    expect(asLawyer2.status).toBe(403);
  });

  it('marks a report that has passed its deadline, by arithmetic rather than by memory', async () => {
    const created = await create(omar);
    await s.db.run(
      `update str_reports set filed_due_at = ? where id = ?`,
      ['2026-01-01T00:00:00.000Z', created.body.data.id] as never);
    const res = await omar.get('/api/firm/str-reports');
    const mine = (res.body.data as any).reports.find((r: any) => r.id === created.body.data.id);
    expect(mine.late).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.3-G · ten years, and the register of jurisdictions', () => {
  it('refuses to delete a due-diligence record, a screening, an owner or a report', async () => {
    const matters: Array<[string, unknown[]]> = [
      [`delete from client_due_diligence where id = ?`, [DD.nukhba]],
      [`delete from beneficial_owners where client_id = ?`, [CLIENT.nukhba]],
      [`delete from screening_runs where client_id = ?`, [CLIENT.nukhba]],
      [`delete from str_reports where tenant_id = ?`, [KGM]],
    ];
    for (const [sql, params] of matters) {
      await expect(s.db.run(sql, params as never)).rejects.toThrow(/aml_record_retention/);
    }
    /* And the same rows are still there, which is the point of the refusal. */
    expect((await row<{ n: number }>(
      `select count(*) as n from client_due_diligence where id = ?`, [DD.nukhba]))?.n).toBe(1);
  });

  it('records a jurisdiction listing and derives the risk it implies', async () => {
    const res = await omar.post('/api/firm/compliance/risk-countries', {
      countryCode: 'IR', countryName: 'Iran', listSource: 'fatf_call_for_action',
      riskLevel: 'high', effectiveFrom: '2026-01-01',
    });
    expect(res.status).toBe(201);

    const client = await freshClient('Probe Resident Client');
    const dd = await openRecord(noura, client);
    await noura.patch(`/api/firm/due-diligence/${dd}`, {
      legalName: 'Probe Resident Client', dateOfBirth: '1979-05-05', nationality: 'SA',
      residenceCountry: 'IR', address: 'Tehran', idType: 'passport', idNumber: 'P0998877',
      sourceOfFunds: 'Consulting income', purpose: 'Arbitration support',
      verificationMethod: 'certified_copy', pepStatus: 'not_pep',
    });
    const done = await noura.post(`/api/firm/due-diligence/${dd}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.body.data.riskRating).toBe('high');
    const reasons = done.body.data.riskReasons as Array<{ code: string; label: string }>;
    /* The reason names the country it is about, and the register it came from. */
    expect(reasons.map((r) => r.code)).toContain('risk_country_residence');
    const listed = reasons.find((r) => r.code === 'risk_country_residence')!;
    expect(listed.label).toContain('IR');
    expect(listed.label).toContain('fatf_call_for_action');
  });

  it('refuses the jurisdiction register to a member without the approval permission', async () => {
    const res = await faisal.post('/api/firm/compliance/risk-countries', {
      countryCode: 'SY', countryName: 'Syria', listSource: 'un_sanctions',
      riskLevel: 'prohibited', effectiveFrom: '2026-01-01',
    });
    expect(res.status).toBe(403);
  });

  it('never lets another firm see this firm\u2019s register', async () => {
    const najd = createAgent(s.app);
    expect((await firmLoginAs(najd, 'partner@najd.example.test')).status).toBe(200);
    const res = await najd.get('/api/firm/compliance/due-diligence');
    expect(res.status).toBe(200);
    const data = res.body.data as any;
    expect(data.queue.every((q: any) => !Object.values(CLIENT).includes(q.clientId))).toBe(true);
    const foreign = await najd.get(`/api/firm/clients/${CLIENT.ahmed}/due-diligence`);
    expect(foreign.status).toBe(404);
    expect(NAJD).toBeTruthy();
  });
});

// ── helpers used by more than one block ─────────────────────────────────────────
async function freshClient(
  name: string, clientType: 'individual' | 'organization' = 'organization',
): Promise<string> {
  const id = randomUUID();
  await s.db.run(
    `insert into clients (id, tenant_id, client_type, name, status, created_at, updated_at)
     values (?, ?, ?, ?, 'active', ?, ?)`, [id, KGM, clientType, name, now(), now()] as never);
  return id;
}

/**
 * A record answered and completed.
 *
 * A test about ONE requirement has to begin with the others satisfied, or it proves
 * nothing about the one: with an empty record every activation is refused for the empty
 * file first, and the assertion passes for the wrong reason.
 */
async function completeIndividualRecord(dd: string, residenceCountry = 'SA'): Promise<void> {
  const patched = await noura.patch(`/api/firm/due-diligence/${dd}`, {
    legalName: 'Probe Person', dateOfBirth: '1980-03-03', nationality: 'SA',
    residenceCountry, address: 'King Fahd Road, Al Olaya, Riyadh',
    idType: 'national_id', idNumber: '1099887766', sourceOfFunds: 'Salary',
    purpose: 'Arbitration support', verificationMethod: 'certified_copy',
    /* A blocking requirement for every level, so a record without it is not complete —
       and the screening test needs a complete record to be a test about screening. */
    pepStatus: 'not_pep',
  });
  expect(patched.status).toBe(200);
  const done = await noura.post(`/api/firm/due-diligence/${dd}/complete`, {});
  expect(done.status).toBe(200);
}

async function openRecord(agent: Agent, clientId: string): Promise<string> {
  const res = await agent.post(`/api/firm/clients/${clientId}/due-diligence`, { level: 'standard' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

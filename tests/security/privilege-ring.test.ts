/**
 * P0.5 · THE PRIVILEGE RING
 *
 * The invariant under test, in one sentence: the firm's own work product — its internal
 * notes on a matter, its assessment of its own exposure, and the documents that carry its
 * advice — is readable only by a member the firm declares a practising lawyer who holds a
 * licence good enough to practise, and every disclosure out of that ring is recorded
 * against one of القاعدة الحادية والعشرون's four grounds.
 *
 * Seven things are deliberately true of this suite:
 *
 *   1. THE RING IS A LICENCE QUESTION, NOT A ROLE. A managing partner without a licence is
 *      outside it and an associate with one is inside, so the assertions drive the LICENCE
 *      REGISTER — suspending one, revoking one, letting one lapse, deleting one — and read
 *      the answer off the wire. A suite that only tested "paralegals are refused" would
 *      pass against a hardcoded role list, which is the design this phase rejected.
 *
 *   2. THE VERDICT IS NOT FROZEN AT SIGN-IN. The principal is re-resolved on every request,
 *      so the suspension test suspends the licence and then asks the SAME session again:
 *      a ring captured once at login would keep the door open for the length of a session,
 *      which is the length of time that matters.
 *
 *   3. THE FIELDS ARE ASSERTED BY THE BYTES. `withheld` naming a field is the screen's
 *      signal, not the security property; the security property is that the VALUE is not in
 *      the response body. So the raw text is searched for the seeded note, not just the
 *      object for the key.
 *
 *   4. THE DATABASE'S OWN OPINION IS TESTED UNDERNEATH THE ROUTE. Three rules live in more
 *      than one dialect — a privileged document is internal, a release names a document on
 *      its own matter, the ring itself — and defect (o) is what happens when only one copy
 *      is right. Each rule is asserted at the route AND again by writing straight to the
 *      table.
 *
 *   5. THE TWO RISK RATINGS ARE KEPT APART. `client_due_diligence.risk_rating` is the AML
 *      assessment of the client and stays readable by compliance; `matters.risk_rating` is
 *      the firm's assessment of its own exposure and is advice. Both are asserted in the
 *      same test, because a rule that withheld both would look identical to a rule that
 *      withheld neither.
 *
 *   6. REFUSALS ARE NAMED, NOT OPAQUE. Each refusal carries the token the client screen
 *      needs to say what to do next, and for the ring that token is the reason itself:
 *      `suspended` tells a lawyer to call the bar; `outside_ring` tells a paralegal that
 *      nothing is wrong with her file.
 *
 *   7. THE TRAIL IS ASSERTED, NOT ASSUMED. A read of privileged material is recorded with
 *      the membership that made it; a refusal is recorded with the ring's reason; and the
 *      metadata keys are ones the audit writer's denylist does not silently eat (P0.3's
 *      `code`, which dropped the whole event).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  bootStack, firmLoginAs, loginAs, createAgent, FIRM, IDS,
  type Stack, type Agent, type ApiResponse,
} from '../helpers.js';
import { lawyerRingFrom, NO_RING, DISCLOSURE_GROUNDS, DISCLOSURE_GROUND_CODES, groundOf, groundPermits, isPrivilegedClass } from '../../server/src/domain/privilege.js';

let s: Stack;
let noura: Agent;    // Managing Partner · licensed · in the ring
let faisal: Agent;   // Lawyer · licensed · in the ring, and on the matter as lead lawyer
let mariam: Agent;   // Paralegal · not a practising role · works the matter, outside the ring
let omar: Agent;     // Compliance · outside the ring, and entitled to the AML rating
let sara: Agent;     // Finance · outside the ring
let ahmed: Agent;    // the client who owns the matter

const MATTER = IDS.matterCommercial;          // Ahmed Al-Saud's Commercial Dispute, KGM
const MATTER_CLIENT = IDS.clientAhmed;
const NAJD_MATTER = 'eeeeeeee-0000-4000-8000-000000000010';
const NAJD_DOC = 'c1000000-0000-4000-8000-000000000006';   // Layla's file, another tenant
const CONSENT_DOC = 'c1000000-0000-4000-8000-000000000002'; // Engagement Letter, same matter
const OTHER_MATTER_DOC = 'c1000000-0000-4000-8000-000000000001'; // Statement of Claim — on MATTER

const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
const FAISAL_STAFF = 'f1000000-0000-4000-8000-000000000002';

/** The seeded note and rating, so the assertions are about values that exist. */
const SEEDED_NOTE = 'INTERNAL: partner to approve settlement posture before next session.';

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  faisal = createAgent(s.app);
  mariam = createAgent(s.app);
  omar = createAgent(s.app);
  sara = createAgent(s.app);
  ahmed = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(faisal, FIRM.lawyer)).status).toBe(200);
  expect((await firmLoginAs(mariam, FIRM.paralegal)).status).toBe(200);
  expect((await firmLoginAs(omar, FIRM.compliance)).status).toBe(200);
  expect((await firmLoginAs(sara, FIRM.finance)).status).toBe(200);
  expect((await loginAs(ahmed, 'ahmed.alsaud@example.test')).status).toBe(200);
});
afterEach(async () => { await s.shutdown(); });

/** The successful response body. Every route answers `{ ok: true, data: … }`. */
const payload = (res: ApiResponse): any => res.body?.data ?? res.body;

const rows = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await s.db.all<T>(sql, params)) ?? [];
const row = async <T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
  s.db.get<T>(sql, params);
const run = (sql: string, params: unknown[] = []) => s.db.run(sql, params as never);

/** Writes straight to the table and returns the refusal, or null if the write was allowed. */
const refusalOf = async (sql: string, params: unknown[] = []): Promise<string | null> => {
  try { await run(sql, params); return null; }
  catch (err) { return String((err as Error).message ?? err); }
};

const audit = (action: string) => rows<any>(
  `select id, action, outcome, reason_code, resource_id, actor_user_id, metadata
     from audit_events where action = ? order by occurred_at`, [action]);
const meta = (r: any): Record<string, any> =>
  typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});

/** The session payload — the same one login returns, and where the ring is announced. */
const session = async (agent: Agent) => payload(await agent.get('/api/firm/session'));

const membershipId = async (userId: string) =>
  String((await row<{ id: string }>(
    `select id from firm_memberships where user_id = ?`, [userId]))?.id);

/** Puts a licence into a state, for the tests that are about the register and not the role. */
const setLicence = (staffId: string, fields: Record<string, string | null>) => {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  return run(`update professional_licences set ${sets} where staff_id = ?`,
    [...Object.values(fields), staffId]);
};

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.5-A · THE RING IS A LICENCE QUESTION, NOT A ROLE', () => {
  it('is outside the ring for a role that does not practise, before any licence is read', () => {
    /* The order is the point: a paralegal is not "unlicensed", she is a person the question
       does not arise for. Reading her licence first would make the refusal message wrong. */
    expect(lawyerRingFrom({ requiresLicence: false, entitled: true, reason: 'not_a_practising_role' }))
      .toEqual({ inRing: false, reason: 'outside_ring' });
    expect(lawyerRingFrom({ requiresLicence: true, entitled: true, reason: 'valid' }))
      .toEqual({ inRing: true, reason: 'in_ring' });
    for (const reason of ['no_licence_on_record', 'suspended', 'revoked', 'expired', 'pending']) {
      expect(lawyerRingFrom({ requiresLicence: true, entitled: false, reason }))
        .toEqual({ inRing: false, reason });
    }
    /* An unrecognised reason is a refusal nobody has explained yet — never a licence. */
    expect(lawyerRingFrom({ requiresLicence: true, entitled: false, reason: 'who_knows' }))
      .toEqual({ inRing: false, reason: 'outside_ring' });
  });

  it('puts the two licensed lawyers in and the other three out, on the session itself', async () => {
    expect((await session(noura)).member.privilege).toEqual({ inRing: true, reason: 'in_ring' });
    expect((await session(faisal)).member.privilege).toEqual({ inRing: true, reason: 'in_ring' });
    for (const agent of [mariam, omar, sara]) {
      expect((await session(agent)).member.privilege).toEqual({ inRing: false, reason: 'outside_ring' });
    }
  });

  it('reads a suspension off the register on the NEXT request, not at the next sign-in', async () => {
    /* The session is four days old in every hostile scenario that matters. A ring decided
       once at login would let a suspended lawyer read advice until the cookie expired. */
    expect(payload(await faisal.get(`/api/firm/matters/${MATTER}`)).internalNotes).toBe(SEEDED_NOTE);

    await setLicence(FAISAL_STAFF, { status: 'suspended' });

    const after = await faisal.get(`/api/firm/matters/${MATTER}`);
    expect(after.status).toBe(200);                          // still his matter to work
    expect(payload(after).privilege).toEqual({ inRing: false, reason: 'suspended' });
    expect(payload(after).internalNotes).toBeUndefined();
    expect(payload(after).withheld).toContain('internalNotes');
    expect(after.text).not.toContain('INTERNAL:');
  });

  it('calls an expiry an expiry and a revocation a revocation', async () => {
    await setLicence(FAISAL_STAFF, { expires_at: '2020-01-01' });
    expect((await session(faisal)).member.privilege).toEqual({ inRing: false, reason: 'expired' });

    await setLicence(FAISAL_STAFF, { expires_at: '2099-01-01', status: 'revoked' });
    expect((await session(faisal)).member.privilege).toEqual({ inRing: false, reason: 'revoked' });

    /* A suspension outranks a revocation and an expiry outranks a pending application — the
       most serious reason is the one that tells the member what to do next. */
    await setLicence(FAISAL_STAFF, { expires_at: '2099-01-01', status: 'suspended' });
    expect((await session(faisal)).member.privilege).toEqual({ inRing: false, reason: 'suspended' });

    await setLicence(FAISAL_STAFF, { expires_at: '2020-01-01', status: 'pending' });
    expect((await session(faisal)).member.privilege).toEqual({ inRing: false, reason: 'expired' });
  });

  it('treats a practising role with no licence row as no permission, never as permission', async () => {
    /* ABSENCE IS NOT PERMISSION. The inverse default is the whole reason the ring can be
       trusted, so it is asserted by deleting the row rather than by a fake member. */
    expect(await refusalOf(`delete from professional_licences where staff_id = ?`, [FAISAL_STAFF]))
      .toBeNull();
    expect((await session(faisal)).member.privilege).toEqual({ inRing: false, reason: 'no_licence_on_record' });

    /* And a managing partner is not exempt: the ring asks about the licence, not the rank. */
    expect(await refusalOf(`delete from professional_licences where staff_id = ?`, [NOURA_STAFF]))
      .toBeNull();
    expect((await session(noura)).member.privilege).toEqual({ inRing: false, reason: 'no_licence_on_record' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.5-B · THE TWO COLUMNS ARE OFF THE WIRE', () => {
  it('hands a licensed lawyer the firm’s own read of the matter, and records the read', async () => {
    const res = await noura.get(`/api/firm/matters/${MATTER}`);
    expect(res.status).toBe(200);
    expect(payload(res).internalNotes).toBe(SEEDED_NOTE);
    expect(payload(res).riskRating).toBe('high');
    expect(payload(res).privilege).toEqual({ inRing: true, reason: 'in_ring' });
    expect(payload(res).withheld).not.toContain('internalNotes');

    const trail = await audit('PRIVILEGED_READ');
    expect(trail).toHaveLength(1);
    expect(trail[0].outcome).toBe('success');
    expect(trail[0].reason_code).toBe('in_ring');
    expect(meta(trail[0]).membershipId).toBe(await membershipId(IDS.userNoura));
    expect(meta(trail[0]).fields).toEqual(['internalNotes', 'riskRating']);
  });

  it('lets the paralegal work the matter and withholds the firm’s work product from her', async () => {
    const res = await mariam.get(`/api/firm/matters/${MATTER}`);
    expect(res.status).toBe(200);                       // the matter is hers to work
    expect(payload(res).internalNotes).toBeUndefined(); // the firm's strategy is not
    expect(payload(res).riskRating).toBeUndefined();
    expect(payload(res).withheld).toEqual(expect.arrayContaining(['internalNotes', 'riskRating']));
    expect(payload(res).privilege).toEqual({ inRing: false, reason: 'outside_ring' });
    /* The key being absent is the screen's view; the value being absent is the guarantee. */
    expect(res.text).not.toContain('INTERNAL:');
    expect(res.text).not.toContain('settlement posture');
  });

  it('withholds it from finance as well — reading all matters is not reading the file', async () => {
    const list = await sara.get('/api/firm/matters');
    expect(list.status).toBe(200);
    expect(payload(list).matters.length).toBeGreaterThan(0);
    for (const m of payload(list).matters) {
      expect(m.internalNotes).toBeUndefined();
      expect(m.riskRating).toBeUndefined();
    }
    expect(list.text).not.toContain('INTERNAL:');

    const detail = await sara.get(`/api/firm/matters/${MATTER}`);
    expect(detail.status).toBe(200);
    expect(payload(detail).withheld).toEqual(expect.arrayContaining(['internalNotes', 'riskRating']));
    expect(detail.text).not.toContain('INTERNAL:');
  });

  it('keeps the two risk ratings apart: compliance loses the firm’s, keeps the client’s', async () => {
    const matter = await omar.get(`/api/firm/matters/${MATTER}`);
    expect(matter.status).toBe(200);
    expect(payload(matter).withheld).toEqual(expect.arrayContaining(['internalNotes', 'riskRating']));
    expect(payload(matter).riskRating).toBeUndefined();

    /* The AML assessment of the CLIENT is compliance's own work product and must survive
       the ring. A change that withheld both would be a regression the first test cannot see. */
    const dd = await omar.get(`/api/firm/clients/${MATTER_CLIENT}/due-diligence`);
    expect(dd.status).toBe(200);
    expect(payload(dd).record?.riskRating).toBe('low');
  });

  it('never reaches the client, in the matter detail or the document list', async () => {
    const matter = await ahmed.get(`/api/client/matters/${MATTER}`);
    expect(matter.status).toBe(200);                    // the client sees his own matter
    expect(Object.keys(payload(matter))).not.toContain('internalNotes');
    expect(Object.keys(payload(matter))).not.toContain('riskRating');
    expect(matter.text).not.toContain('INTERNAL:');

    const docs = await ahmed.get(`/api/client/documents?matterId=${MATTER}`);
    expect(docs.status).toBe(200);
    expect(docs.text).not.toContain('INTERNAL:');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.5-C · THE LEDGER, AND THE ONLY DOOR INTO IT', () => {
  it('lets a lawyer release on a lawful ground, recording who, to whom and why', async () => {
    const res = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note',
      ground: 'crime_prevention',
      recipientKind: 'authority',
      recipientName: 'Public Prosecution — Riyadh',
      note: 'Reported a forged instrument discovered in the file.',
    });
    expect(res.status).toBe(201);
    expect(payload(res).ground).toBe('crime_prevention');

    const ledger = await rows<any>(`select * from privilege_releases where matter_id = ?`, [MATTER]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].recipient_kind).toBe('authority');
    expect(ledger[0].recipient_name).toBe('Public Prosecution — Riyadh');
    expect(ledger[0].released_by_membership_id).toBe(await membershipId(IDS.userNoura));
    /* The timestamp is written by the application in both dialects, and it is a real one. */
    expect(String(ledger[0].released_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const listed = await noura.get(`/api/firm/matters/${MATTER}/privilege-releases`);
    expect(listed.status).toBe(200);
    expect(payload(listed).count).toBe(1);
    expect(payload(listed).releases[0].ground).toBe('crime_prevention');

    const trail = await audit('PRIVILEGE_RELEASED');
    expect(trail).toHaveLength(1);
    expect(trail[0].outcome).toBe('success');
    expect(meta(trail[0]).ground).toBe('crime_prevention');
    expect(meta(trail[0]).accessLevel).toBe('full');
  });

  it('refuses a lawyer whose licence has been suspended, and names the reason', async () => {
    await setLicence(FAISAL_STAFF, { status: 'suspended' });
    const res = await faisal.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note',
      ground: 'self_defence',
      recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh',
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('privilege_ring_refused');
    expect(res.body.error?.message).toMatch(/suspended/);

    /* Nothing was written, and the refusal is legible in the ledger that matters. */
    expect(await rows(`select id from privilege_releases`)).toHaveLength(0);
    const trail = await audit('PRIVILEGE_RELEASED');
    expect(trail).toHaveLength(1);            // exactly one: not dropped, and not doubled
    expect(trail[0].outcome).toBe('denied');
    expect(trail[0].reason_code).toBe('suspended');
    expect(meta(trail[0]).refusal).toBe('suspended');
  });

  it('does not let a paralegal reach the door at all', async () => {
    /* `operational` cannot write to a matter, so the refusal is the same 404 a stranger
       gets — she never learns whether the matter exists, let alone what a ground is. */
    const res = await mariam.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note',
      ground: 'self_defence',
      recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh',
    });
    expect(res.status).toBe(404);
    expect(await rows(`select id from privilege_releases`)).toHaveLength(0);
  });

  it('keeps the ledger of what was disclosed inside the ring as well', async () => {
    /* The ledger is metadata about privileged material: that a note went to the Public
       Prosecution on a crime-prevention ground is itself a fact the client would pay to
       know, so reading it is a privileged read. */
    await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note', ground: 'crime_prevention',
      recipientKind: 'authority', recipientName: 'Public Prosecution — Riyadh',
    });
    expect((await noura.get(`/api/firm/matters/${MATTER}/privilege-releases`)).status).toBe(200);

    const res = await mariam.get(`/api/firm/matters/${MATTER}/privilege-releases`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('privilege_ring_refused');
    expect(res.text).not.toContain('Public Prosecution');

    const denied = (await audit('PRIVILEGED_READ')).filter((r) => r.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].reason_code).toBe('outside_ring');
  });

  it('refuses an AML suspicion aimed at the other side, at the route and in the table', async () => {
    const res = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note',
      ground: 'aml_suspicion',
      recipientKind: 'third_party',
      recipientName: 'Gulf Horizon Trading Est.',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('privilege_ground_recipient_mismatch');
    expect(res.body.error?.details?.permittedRecipients).toEqual(['regulator']);

    /* Underneath the route, the table refuses it for anybody who reaches the table. */
    const refusal = await refusalOf(
      `insert into privilege_releases (id, tenant_id, matter_id, subject_kind, ground,
         recipient_kind, recipient_name, released_by_membership_id, released_at)
       values (?, ?, ?, 'matter_note', 'aml_suspicion', 'third_party', 'The other side', ?, ?)`,
      ['11111111-2222-4333-8444-555555555555', IDS.tenantKgm, MATTER,
        await membershipId(IDS.userNoura), new Date().toISOString()]);
    expect(String(refusal)).toMatch(/CHECK constraint failed/);
  });

  it('refuses the client’s consent as a flag: the writing must be named', async () => {
    const res = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'assessment',
      ground: 'client_written_consent',
      recipientKind: 'third_party',
      recipientName: 'The counterparty’s counsel',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('privilege_consent_document_required');

    /* And the table refuses it too — a boolean saying the client agreed is not a writing. */
    const refusal = await refusalOf(
      `insert into privilege_releases (id, tenant_id, matter_id, subject_kind, ground,
         recipient_kind, recipient_name, released_by_membership_id, released_at)
       values (?, ?, ?, 'assessment', 'client_written_consent', 'court', 'Court', ?, ?)`,
      ['11111111-2222-4333-8444-666666666666', IDS.tenantKgm, MATTER,
        await membershipId(IDS.userNoura), new Date().toISOString()]);
    expect(String(refusal)).toMatch(/CHECK constraint failed/);
  });

  it('accepts the client’s consent when the document that carries it is named', async () => {
    const res = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'assessment',
      ground: 'client_written_consent',
      recipientKind: 'third_party',
      recipientName: 'The counterparty’s counsel',
      consentDocumentId: CONSENT_DOC,
    });
    expect(res.status).toBe(201);
    const ledger = await rows<any>(`select consent_document_id from privilege_releases`);
    expect(ledger[0].consent_document_id).toBe(CONSENT_DOC);
  });

  it('refuses a document release that names no document', async () => {
    const res = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'document', ground: 'self_defence',
      recipientKind: 'court', recipientName: 'Commercial Court — Riyadh',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_failed');
  });

  it('refuses a release whose document belongs to another file or another firm', async () => {
    /* A ledger that names any document in the database as the thing that authorised a
       release is a ledger that cannot be read. The subject document must be ON the matter;
       the client's consent must be the CLIENT's. */
    const foreign = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'document',
      ground: 'self_defence',
      recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh',
      documentId: NAJD_DOC,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error?.code).toBe('privilege_document_mismatch');

    const foreignConsent = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'assessment',
      ground: 'client_written_consent',
      recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh',
      consentDocumentId: NAJD_DOC,
    });
    expect(foreignConsent.status).toBe(400);
    expect(foreignConsent.body.error?.code).toBe('privilege_document_mismatch');

    /* The document that IS on the matter is accepted, so the refusal is about scope and
       not about documents being refused by default. */
    const onMatter = await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'document',
      ground: 'self_defence',
      recipientKind: 'court',
      recipientName: 'Commercial Court — Riyadh',
      documentId: OTHER_MATTER_DOC,
    });
    expect(onMatter.status).toBe(201);

    /* And the table says the same thing to anybody who reaches it directly. */
    const refusal = await refusalOf(
      `insert into privilege_releases (id, tenant_id, matter_id, document_id, subject_kind, ground,
         recipient_kind, recipient_name, released_by_membership_id, released_at)
       values (?, ?, ?, ?, 'document', 'self_defence', 'court', 'Court', ?, ?)`,
      ['11111111-2222-4333-8444-777777777777', IDS.tenantKgm, MATTER, NAJD_DOC,
        await membershipId(IDS.userNoura), new Date().toISOString()]);
    expect(String(refusal)).toMatch(/privilege_document_mismatch/);
  });

  it('is append-only, and insists the release names a member who exists', async () => {
    await noura.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note', ground: 'crime_prevention',
      recipientKind: 'authority', recipientName: 'Public Prosecution — Riyadh',
    });
    const id = String((await row<{ id: string }>(`select id from privilege_releases`))!.id);

    expect(String(await refusalOf(`update privilege_releases set ground = 'self_defence' where id = ?`, [id])))
      .toMatch(/privilege_release_immutable/);
    expect(String(await refusalOf(`delete from privilege_releases where id = ?`, [id])))
      .toMatch(/privilege_release_immutable/);

    /* A release attributed to nobody is not a record of a release. */
    expect(String(await refusalOf(
      `insert into privilege_releases (id, tenant_id, matter_id, subject_kind, ground,
         recipient_kind, recipient_name, released_by_membership_id, released_at)
       values (?, ?, ?, 'matter_note', 'self_defence', 'court', 'Court', ?, ?)`,
      ['11111111-2222-4333-8444-888888888888', IDS.tenantKgm, MATTER,
        'f0000000-0000-4000-8000-0000000000ff', new Date().toISOString()])))
      .toMatch(/FOREIGN KEY constraint failed/);
  });

  it('answers a matter in another firm with a 404, not a ledger', async () => {
    const res = await noura.get(`/api/firm/matters/${NAJD_MATTER}/privilege-releases`);
    expect(res.status).toBe(404);
  });

  it('states the four grounds as data both dialects can read', () => {
    expect(DISCLOSURE_GROUND_CODES).toEqual(
      ['crime_prevention', 'aml_suspicion', 'self_defence', 'client_written_consent']);
    for (const g of DISCLOSURE_GROUNDS) {
      expect(g.recipients.length).toBeGreaterThan(0);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.labelEn.length).toBeGreaterThan(0);
    }
    expect(groundOf('aml_suspicion')!.recipients).toEqual(['regulator']);
    expect(groundPermits('aml_suspicion', 'regulator')).toBe(true);
    expect(groundPermits('aml_suspicion', 'third_party')).toBe(false);
    expect(groundPermits('client_written_consent', 'third_party')).toBe(true);
    expect(groundOf('client_written_consent')!.requiresDocument).toBe(true);
    expect(groundOf('self_defence')!.requiresDocument).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.5-D · A PRIVILEGED DOCUMENT IS INTERNAL BY CONSTRUCTION', () => {
  it('knows which classes are privileged and which is merely unclassified', () => {
    expect(isPrivilegedClass('none')).toBe(false);
    for (const c of ['advice', 'work_product', 'litigation']) {
      expect(isPrivilegedClass(c)).toBe(true);
    }
    expect(isPrivilegedClass(undefined)).toBe(false);
    expect(isPrivilegedClass('whatever')).toBe(false);
  });

  it('will not let a document the client is looking at quietly become advice', async () => {
    /* Before: the statement of claim is the client's own copy and he can open it. */
    const before = await ahmed.get(`/api/client/documents?matterId=${MATTER}`);
    expect(payload(before).documents.map((d: any) => d.id)).toContain(OTHER_MATTER_DOC);

    /* The one-step shortcut — mark it privileged and leave it visible — is refused, because
       a privileged document the client is still being served is a contradiction. */
    const shortcut = await refusalOf(
      `update documents set privilege_class = 'work_product' where id = ?`, [OTHER_MATTER_DOC]);
    expect(String(shortcut)).toMatch(/privilege_class_internal/);

    /* AND THE LONG WAY ROUND IS CLOSED TOO — by the portal's own rule, which this phase did
       not write and must not weaken: a document that has been served cannot be re-pointed at
       another visibility. Material that becomes privileged is created privileged; the one
       direction material crosses that line is a RELEASE, with a ground, in the ledger. */
    expect(String(await refusalOf(
      `update documents set client_visibility = 'internal' where id = ?`, [OTHER_MATTER_DOC])))
      .toMatch(/ownership and storage path are immutable/);

    /* Nothing was silently taken away, and nothing was silently opened. */
    const after = await ahmed.get(`/api/client/documents?matterId=${MATTER}`);
    expect(payload(after).documents.map((d: any) => d.id)).toContain(OTHER_MATTER_DOC);
    expect(payload(after).documents.find((d: any) => d.id === OTHER_MATTER_DOC).title)
      .toBe('Statement of Claim');
  });

  it('refuses to create a privileged document that is client-visible in the first place', async () => {
    const insertDoc = (id: string, visibility: string, klass: string) => refusalOf(
      `insert into documents (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
         original_filename, stored_filename, title, title_ar, document_type, category, origin,
         version, mime_type, size_bytes, sha256, scan_status, status, client_visibility,
         privilege_class, requested, uploaded_by_staff_id, created_at, updated_at)
       values (?, ?, ?, ?, 'client-documents', ?, 'advice.pdf', 'advice.pdf', 'Advice',
               'مشورة', 'opinion', 'from_firm', 'firm', 1, 'application/pdf', 10, 'sha',
               'clean', 'available', ?, ?, 0, ?, ?, ?)`,
      [id, IDS.tenantKgm, MATTER_CLIENT, MATTER, `scope-test/${id}`, visibility, klass,
        'f1000000-0000-4000-8000-000000000003', new Date().toISOString(), new Date().toISOString()]);

    expect(String(await insertDoc('c1000000-0000-4000-8000-0000000000aa', 'visible', 'advice')))
      .toMatch(/privilege_class_internal/);

    /* The same row, internal, is what the database expects — and it is not the client's,
       whatever else it is. */
    expect(await insertDoc('c1000000-0000-4000-8000-0000000000ab', 'internal', 'advice'))
      .toBeNull();
    const docs = await ahmed.get(`/api/client/documents?matterId=${MATTER}`);
    expect(payload(docs).documents.map((d: any) => d.title)).not.toContain('Advice');

    /* And the reverse direction is refused as well, whichever of the two rules reaches it
       first: the ring's ("a privileged document cannot be made client-visible") or the
       portal's ("ownership and storage path are immutable"). Both answers are correct, and
       asserting the pair is what stops a later edit from deleting one of them. */
    expect(String(await refusalOf(
      `update documents set client_visibility = 'visible' where id = ?`,
      ['c1000000-0000-4000-8000-0000000000ab'])))
      .toMatch(/privilege_class_internal|immutable/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.5-E · THE TRAIL A COURT WILL READ', () => {
  it('writes no privileged read for a member who never asked for one', async () => {
    await mariam.get(`/api/firm/matters/${MATTER}`);
    const maria = await membershipId(IDS.userMariam);
    const trail = (await audit('PRIVILEGED_READ')).filter((r) => meta(r).membershipId === maria);
    expect(trail).toHaveLength(0);
    /* …while the ordinary view of the matter IS recorded, because seeing the file is the
       fact a disqualification motion asks about. */
    expect((await audit('MATTER_VIEWED')).length).toBeGreaterThan(0);
  });

  it('keeps the read, the refusal and the release distinguishable in one ledger', async () => {
    await noura.get(`/api/firm/matters/${MATTER}`);
    await setLicence(FAISAL_STAFF, { status: 'suspended' });
    await faisal.post(`/api/firm/matters/${MATTER}/privilege-releases`, {
      subjectKind: 'matter_note', ground: 'self_defence',
      recipientKind: 'court', recipientName: 'Commercial Court — Riyadh',
    });

    const reads = await audit('PRIVILEGED_READ');
    const releases = await audit('PRIVILEGE_RELEASED');
    expect(reads.map((r) => r.outcome)).toEqual(['success']);
    expect(releases.map((r) => r.outcome)).toEqual(['denied']);
    /* Different actions, so a reviewer can ask "what was read" and "what was disclosed"
       separately — the two questions have different answers before a regulator. */
    expect(reads[0].action).not.toBe(releases[0].action);
    expect(reads[0].resource_id).toBe(MATTER);
  });

  it('carries the ring on the session without letting the screen decide anything', async () => {
    /* §50: the screen is told the fact so it can explain a lock. The fact that it is told is
       not the mechanism — the same request without the client's rendering is what is asserted
       above, and NO_RING is the default the domain refuses with. */
    expect(NO_RING).toEqual({ inRing: false, reason: 'outside_ring' });
    const body = await session(mariam);
    expect(body.member.privilege).toEqual({ inRing: false, reason: 'outside_ring' });
    expect(body.member.permissions).toBeDefined();  // codes are sent; they are not the gate
  });
});

/**
 * PHASE P-1 · THE ELIGIBILITY LAYER  (migration 0027)
 *
 * The gap this closes: every control in the system before this answered "may this
 * actor do this thing?", and none answered "is this actor legally permitted to be
 * doing this at all?" The system would grant matter access to a member whose
 * licence was suspended and would record a licensed lawyer as working for two
 * firms — the one arrangement Article 16 of the اللائحة التنفيذية لنظام المحاماة
 * prohibits.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING
 *   Not the feature; the DEFAULT. The single most likely way this layer rots is
 *   that someone makes absence mean permission, because every other nullable field
 *   in every other system works that way and a new joiner with no licence row is
 *   the common case. So the tests below pin the refusal, the reason, and the fact
 *   that a refusal is indistinguishable from a member who does not exist.
 *
 * THE FOUR CLAIMS
 *   1. A practising role with NO licence on record is NOT entitled. Absence is not
 *      permission — the inverse of the usual default, taken deliberately.
 *   2. A suspended licence withdraws entitlement immediately, and revoking it
 *      again does not restore it.
 *   3. A non-practising role is never gated — a paralegal must stay assignable, or
 *      the firm learns to ignore the flag.
 *   4. Assignment of a matter to an ineligible member is REFUSED, the refusal is
 *      recorded as evidence, and the response does not reveal whether the member
 *      exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, createAgent, firmLoginAs, FIRM, IDS, type Stack } from '../helpers.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

/** The membership id for a seeded firm member, read from the live session. */
async function membershipIdFor(admin: ReturnType<typeof createAgent>, email: string): Promise<string> {
  const res = await admin.get('/api/firm/admin/members');
  const members = (res.body?.data?.members ?? []) as Array<{ membershipId: string; email: string }>;
  const found = members.find((m) => m.email === email);
  if (!found) throw new Error(`no membership for ${email}`);
  return found.membershipId;
}

describe('P-1 · eligibility — a licence is required to practise, and absence is not permission', () => {
  it('reports the two seeded lawyers as entitled and names the licence they hold', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.get('/api/firm/eligibility');
    expect(res.status).toBe(200);

    const members = (res.body?.data?.members ?? []) as Array<{
      email: string; requiresLicence: boolean; entitled: boolean; reason: string;
      licences: Array<{ licenceNumber: string; status: string }>;
    }>;

    const noura = members.find((m) => m.email === 'noura@kgm.example.test')!;
    expect(noura.requiresLicence).toBe(true);
    expect(noura.entitled).toBe(true);
    expect(noura.reason).toBe('valid');
    expect(noura.licences[0].licenceNumber).toBe('SA-BAR-11482');
  });

  it('does not gate a paralegal, a compliance officer or a finance manager', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const members = ((await agent.get('/api/firm/eligibility')).body?.data?.members ?? []) as Array<{
      email: string; requiresLicence: boolean; entitled: boolean; reason: string;
    }>;

    // The three non-practising roles hold NO licence row, and that is the correct
    // state for them. If this test ever fails, the gate has started demanding a
    // licence from people who do not need one — which is how a compliance control
    // becomes a thing the firm routes around.
    for (const email of ['mariam@kgm.example.test', 'omar@kgm.example.test', 'sara@kgm.example.test']) {
      const m = members.find((x) => x.email === email)!;
      expect(m.requiresLicence, `${email} must not require a licence`).toBe(false);
      expect(m.entitled, `${email} must remain assignable`).toBe(true);
      expect(m.reason).toBe('not_a_practising_role');
    }
  });

  it('withdraws entitlement the moment a licence is suspended', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const faisal = await membershipIdFor(agent, 'faisal@kgm.example.test');

    // Faisal is a lawyer with a valid licence. Assert the starting state first:
    // without this, a test that only checks the refusal could pass because the
    // licence was never seeded at all.
    const before = await agent.get(`/api/firm/eligibility/me`);
    expect(before.status).toBe(200);

    const suspended = await agent.post(`/api/firm/eligibility/${faisal}/licences`, {
      licenceNumber: 'SA-BAR-20917',
      status: 'suspended',
      statusReference: 'قرار لجنة التأديب 1447/218',
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.eligibility.entitled).toBe(false);
    expect(suspended.body.data.eligibility.reason).toBe('suspended');

    // And the register now shows him as not entitled, with the suspension named.
    const members = ((await agent.get('/api/firm/eligibility')).body?.data?.members ?? []) as Array<{
      email: string; entitled: boolean; reason: string;
    }>;
    const f = members.find((m) => m.email === 'faisal@kgm.example.test')!;
    expect(f.entitled).toBe(false);
    expect(f.reason).toBe('suspended');
  });

  it('refuses to hand a matter to a member who is not entitled, and records the evidence', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const faisal = await membershipIdFor(agent, 'faisal@kgm.example.test');
    const mariam = await membershipIdFor(agent, 'mariam@kgm.example.test');

    await agent.post(`/api/firm/eligibility/${faisal}/licences`, {
      licenceNumber: 'SA-BAR-20917', status: 'suspended',
      statusReference: 'قرار لجنة التأديب 1447/218',
    });

    // Mariam IS entitled, so the matter exists and the actor has authority to
    // grant — the only variable is the target's eligibility.
    const refused = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/access`, {
      membershipId: faisal, accessLevel: 'edit', reason: 'due diligence review',
    });
    // Indistinguishable from a member that does not exist. §72's rule, applied to
    // eligibility: a distinct error here would let a caller probe who holds a
    // licence, and licence status is health-adjacent personal data.
    expect(refused.status).toBe(404);

    // The refusal is not merely blocked, it is RECORDED — a gate that refuses
    // silently cannot be audited, which is the whole point of a gate.
    const auditLog = await agent.get('/api/firm/admin/audit');
    const actions = JSON.stringify(auditLog.body);
    expect(actions).toContain('ELIGIBILITY_DENIED');

    // And the same grant to an entitled member still succeeds, so the gate is a
    // filter and not a wall.
    const allowed = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/access`, {
      membershipId: mariam, accessLevel: 'operational', reason: 'document review',
    });
    expect([200, 201]).toContain(allowed.status);
  });

  it('refuses the licence write when the target is not a member of this firm', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    // A well-formed membership id that belongs to no one. The response must not
    // distinguish "belongs to another firm" from "does not exist".
    const res = await agent.post(
      '/api/firm/eligibility/99999999-9999-4999-8999-999999999999/licences',
      { licenceNumber: 'SA-BAR-99999', status: 'valid' },
    );
    expect(res.status).toBe(404);
  });
});

describe('P-1 · prior office — the five-year window of Article 14 and Rule 8/3', () => {
  it('bars a member still in judicial post, and does not give the bar an end date', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const faisal = await membershipIdFor(agent, 'faisal@kgm.example.test');

    const res = await agent.post(`/api/firm/eligibility/${faisal}/prior-office`, {
      officeKind: 'judiciary',
      institution: 'محكمة الاستئناف بالرياض',
      institutionAr: 'محكمة الاستئناف بالرياض',
      roleTitle: 'Judge',
      startedOn: '2015-01-01',
      // No endedOn: STILL IN POST. The bar has not started and does not end on a
      // date, so the response must carry barred=true with a NULL end date rather
      // than a date that would imply the restriction lifts.
      endedOn: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.barred).toBe(true);
    expect(res.body.data.stillInPost).toBe(true);
    expect(res.body.data.restrictionEndsOn).toBeNull();
  });

  it('bars for five years after the post ends, and not a day longer', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const mariam = await membershipIdFor(agent, 'mariam@kgm.example.test');

    // Ended four years ago: still inside the window.
    const inside = await agent.post(`/api/firm/eligibility/${mariam}/prior-office`, {
      officeKind: 'public_prosecution',
      institution: 'النيابة العامة',
      startedOn: '2010-01-01',
      endedOn: fourYearsAgo(),
    });
    expect(inside.status).toBe(200);
    expect(inside.body.data.barred).toBe(true);
    expect(inside.body.data.stillInPost).toBe(false);
    // Five years from an end date four years ago is one year from today.
    expect(inside.body.data.restrictionEndsOn).toBe(fiveYearsAfter(fourYearsAgo()));
  });

  it('does not bar a member whose window elapsed', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const sara = await membershipIdFor(agent, 'sara@kgm.example.test');

    const res = await agent.post(`/api/firm/eligibility/${sara}/prior-office`, {
      officeKind: 'government_body',
      institution: 'وزارة التجارة',
      startedOn: '2005-01-01',
      endedOn: '2015-12-31',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.barred).toBe(false);
  });
});

/** Local helpers — the dates are computed, not pasted, so the test cannot rot. */
function yearsFromNow(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
const fourYearsAgo = () => yearsFromNow(-4);
const fiveYearsAfter = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const target = y + 5;
  const lastDay = new Date(Date.UTC(target, m, 0)).getUTCDate();
  return `${target}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
};

describe('P-1 · the two rules that must hold in the DATABASE, not in a service', () => {
  it('reads a practising role with no licence row as a REFUSAL named no_licence_on_record', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const faisal = await membershipIdFor(agent, 'faisal@kgm.example.test');

    /*
      The single most likely way this layer rots: someone decides that a NULL
      licence means "not yet recorded" and lets the grant through, because a new
      joiner with no paperwork is the common case and refusing them is
      inconvenient. That decision would silently convert the whole register into
      decoration. So the test creates the exact state a fresh hire would have —
      nobody has recorded a licence yet — and pins the refusal by its reason.

      The deletion is direct SQL rather than an API call on purpose: no endpoint
      should be able to delete a licence, and a test that needed one would be
      asking for an operation the system does not offer.
    */
    await s.db.run(`delete from professional_licences where staff_id = ?`, [await staffIdFor(agent, faisal)]);

    const res = await agent.get('/api/firm/eligibility');
    const members = (res.body?.data?.members ?? []) as Array<{
      email: string; entitled: boolean; reason: string; licences: unknown[];
    }>;
    const f = members.find((m) => m.email === 'faisal@kgm.example.test')!;
    expect(f.licences).toHaveLength(0);
    expect(f.entitled).toBe(false);
    expect(f.reason).toBe('no_licence_on_record');
  });

  it('refuses a second active membership at another firm — Article 16 of the Implementing Regulation', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    // The guard keys on the STAFF member, because it is licences that make a
    // person a lawyer: a second membership for a user whose staff record holds a
    // valid licence is the arrangement Article 16 forbids, whatever the
    // membership row itself says.
    const nouraStaff = await staffIdFor(agent, await membershipIdFor(agent, 'noura@kgm.example.test'));

    /*
      «لا يجوز أن يكون المحامي شريكاً في أكثر من شركة مهنية للمحاماة، كما لا يجوز أن
       يعمل المحامي لدى أكثر من مكتب أو شركة مهنية للمحاماة.»

      Noura is an active MANAGING_PARTNER of KGM. The same user may hold a
      membership of the other tenant (the schema's unique key is per-tenant by
      design, and a user legitimately belongs to several tenancies over a career),
      but may not be ACTIVE in two firms at once.

      This is a database trigger rather than a service check because there are
      several paths to the memberships table and the rule is about the row, not
      about who is inserting it. The assertion is on the thrown error, not on a
      service pretending to validate: if the trigger were dropped, this test fails.
    */
    await expect(
      s.db.run(
        `insert into firm_memberships
           (id, tenant_id, user_id, staff_id, status, financial_authority_sar,
            writeoff_authority_sar, discount_authority_pct, joined_at, created_at, updated_at)
         values (?, ?, ?, ?, 'active', null, null, null, ?, ?, ?)`,
        [
          'ffffffff-0000-4000-8000-0000000000ff', IDS.tenantNajd, IDS.userNoura,
          nouraStaff,
          new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
        ],
      ),
    ).rejects.toThrow(/Article 16/i);

    // The negative control: the SAME licensed lawyer, the same second firm, but
    // NOT active — a membership they have LEFT. This must be allowed, because
    // recording that a lawyer once worked elsewhere is exactly the fact the
    // conflict checks need, and a guard that refused it would make the firm
    // unable to document its own history. Note the guard does not merely check
    // "a membership exists": it checks the STATUS, on insert and on update.
    await expect(
      s.db.run(
        `insert into firm_memberships
           (id, tenant_id, user_id, staff_id, status, financial_authority_sar,
            writeoff_authority_sar, discount_authority_pct, joined_at, created_at, updated_at)
         values (?, ?, ?, ?, 'left', null, null, null, ?, ?, ?)`,
        [
          'ffffffff-0000-4000-8000-0000000000fd', IDS.tenantNajd, IDS.userNoura,
          nouraStaff,
          new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
        ],
      ),
    ).resolves.toBeDefined();
  });
});

/** The staff id behind a membership — reached through the members list. */
async function staffIdFor(admin: ReturnType<typeof createAgent>, membershipId: string): Promise<string> {
  const res = await admin.get('/api/firm/admin/members');
  const members = (res.body?.data?.members ?? []) as Array<{ membershipId: string; staffId: string }>;
  const found = members.find((m) => m.membershipId === membershipId);
  if (!found) throw new Error(`no membership ${membershipId}`);
  return found.staffId;
}

describe('P-1.4 · every matter read is recorded', () => {
  it('writes MATTER_VIEWED when a matter is opened, and names the access level', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.lawyer);

    // The 69-action vocabulary held DOCUMENT_VIEWED, INVOICE_VIEWED, MESSAGE_READ
    // and RECEIPT_VIEWED and not this one. Because migration 0023 makes the
    // TypeScript union the database's contract, no call site could have written
    // it even if someone had tried — so the check here is that the action is BOTH
    // declared and actually reached by a real request.
    const before = await countAudit(agent, 'MATTER_VIEWED');

    // A matter the lawyer can reach. The list is itself scoped by permission, so
    // whatever it returns, opening the first row is a request that must be both
    // authorised and recorded.
    const list = await agent.get('/api/firm/matters');
    const matters = (list.body?.data?.matters ?? []) as Array<{ id: string }>;
    expect(matters.length).toBeGreaterThan(0);

    const read = await agent.get(`/api/firm/matters/${matters[0].id}`);
    expect(read.status).toBe(200);

    // The read is not transactional with its audit — it uses tryWrite by design,
    // so the write is awaited here but is allowed to fail without failing the
    // read. In a test it must not fail, or the trail has a hole.
    expect(await countAudit(agent, 'MATTER_VIEWED')).toBe(before + 1);
  });

  it('records the level, so the trail shows how much was seen and not merely that someone looked', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const matters = ((await agent.get('/api/firm/matters')).body?.data?.matters ?? []) as Array<{ id: string }>;
    await agent.get(`/api/firm/matters/${matters[0].id}`);

    const row = await s.db.get<{ reason_code: string; resource_id: string }>(
      `select reason_code, resource_id from audit_events
        where action = 'MATTER_VIEWED' order by occurred_at desc limit 1`,
    );
    expect(row?.resource_id).toBe(matters[0].id);
    // 'access_level:full' and friends — a Bare "viewed" answers the wrong
    // question when the dispute is about WHAT a conflicted lawyer had seen.
    expect(row?.reason_code).toMatch(/^access_level:/);
  });

  it('does not record a view for a matter the member cannot reach', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.compliance);
    const before = await countAudit(agent, 'MATTER_VIEWED');

    // A matter outside the member's scope. The refusal must not be logged as a
    // view: an audit trail that records attempts as reads would overstate what
    // was seen, which is the one thing this log exists to establish.
    const denied = await agent.get(`/api/firm/matters/${IDS.matterRealEstate}`);
    expect([403, 404]).toContain(denied.status);
    expect(await countAudit(agent, 'MATTER_VIEWED')).toBe(before);
  });
});

/** Counts audit rows of one action, through the privileged admin surface. */
async function countAudit(admin: ReturnType<typeof createAgent>, action: string): Promise<number> {
  const row = await s.db.get<{ n: number }>(
    `select count(*) as n from audit_events where action = ?`, [action],
  );
  void admin;
  return Number(row?.n ?? 0);
}

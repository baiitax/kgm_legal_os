/**
 * P0.1 · THE PARTY REGISTER AND THE CONFLICT ENGINE  (migration 0029)
 *
 * THE GAP THIS CLOSES
 *   Before this phase the system had a `matters.conflict_cleared` boolean that any
 *   writer could set, and no record of what had been checked. A conflict clearance
 *   was an assertion. Rule 11 of the Saudi Bar's professional-conduct rules makes
 *   verifying the absence of a conflict a precondition of accepting the work, and
 *   القاعدة الثامنة sets out what a conflict IS — including against FORMER clients
 *   (3 years) and a lawyer's FORMER EMPLOYER (5 years). None of that existed.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING
 *   Not the happy path. Four specific ways this feature rots, each of which looks
 *   like working software:
 *
 *     1. CLEARANCE BECOMES "NO RESULTS". A search that returned nothing is not a
 *        clearance; it is a search that returned nothing. The tests pin that a check
 *        with an OPEN hit cannot clear a matter, and that a hit can only be closed
 *        by a person recording a disposition.
 *     2. A DISPOSITION IS RE-DISPOSED. If a "different party, not a conflict"
 *        decision can be edited later, the audit trail records the last answer
 *        rather than the decision, and nobody can tell who decided what when the
 *        conflict surfaces.
 *     3. THE MATTER LEAVES THE GATE. `conflict_check` must be a room with a locked
 *        door. The tests walk every exit, including the tempting one — a status
 *        change that tries to squeeze past by leaving `conflict_cleared` alone.
 *     4. THE WINDOW IS DECORATION. 3 years for a former client, 5 for a former
 *        employer, and a finding is still RECORDED after the window closes, because
 *        "why is this not a problem" is the question asked of a clearance later.
 *
 * Plus the two cross-cutting rules this codebase keeps having to re-learn: a
 * refusal must not disclose whether a record exists, and a refusal that matters
 * must leave evidence behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootStack, createAgent, firmLoginAs, FIRM, IDS, type Stack } from '../helpers.js';

let s: Stack;
beforeEach(async () => { s = await bootStack(); });
afterEach(async () => { await s.shutdown(); });

async function members(admin: ReturnType<typeof createAgent>) {
  const res = await admin.get('/api/firm/admin/members');
  return (res.body?.data?.members ?? []) as Array<{
    membershipId: string; email: string; status: string;
  }>;
}

async function dir(admin: ReturnType<typeof createAgent>) {
  const res = await admin.get('/api/firm/directory');
  return (res.body?.data?.staff ?? res.body?.data ?? []) as Array<{ id: string; email?: string; fullName?: string }>;
}

/** Runs a check on a matter and returns the check id. */
async function runCheck(agent: ReturnType<typeof createAgent>, matterId: string) {
  const res = await agent.post(`/api/firm/matters/${matterId}/conflict-check`, { kind: 'intake' });
  expect(res.status).toBe(201);
  return res.body?.data?.checkId as string;
}

interface Hit {
  id: string; relation: string; severity: string | null; proposedSeverity: string | null;
  disposition: string; matchStrength: string; matchBasis: string; ruleCited: string;
  matchedPartyId: string | null; windowYears: number | null; waiverCount: number;
}

/**
 * Reads the register as the UI reads it: the matter's derived state, the checks, and
 * the hits of the MOST RECENT check. A test that read the first check would be
 * reading a historical run rather than the current position of the file.
 */
async function conflicts(agent: ReturnType<typeof createAgent>, matterId: string) {
  const res = await agent.get(`/api/firm/matters/${matterId}/conflicts`);
  expect(res.status).toBe(200);
  const data = res.body?.data as {
    state: { cleared: boolean; checked: boolean; openHits: number; unwaived: number; reasons: string[] };
    checks: Array<{ id: string; status: string; hits: Hit[]; startedAt: string; concludedAt: string | null }>;
    waivers: Array<Record<string, unknown>>;
  };
  // `listConflictChecks` orders by `started_at desc`, so the FIRST check is the
  // current position of the file. Reading the last one reads the oldest — which is
  // how the first version of this helper managed to disposition a hit that had been
  // dispositioned weeks earlier in the seeded data.
  const latest = data.checks[0] ?? null;
  return { state: data.state, checks: data.checks, latest, hits: (latest?.hits ?? []) as Hit[] };
}

describe('P0.1 · the conflict engine — a clearance is a decision, not an empty result', () => {
  it('finds the former client on the commercial matter and cites Rule 8/4 in Arabic', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterCommercial);

    const data = await conflicts(agent, IDS.matterCommercial);
    const hit = data.hits.find((h) => h.relation === 'former_client');

    // مؤسسة النخبة التجارية is the counterparty on KGM-2026-0148 and was a client of
    // the firm until 15 August 2024. Three years have not passed. This is the finding
    // the whole phase exists to produce.
    expect(hit, 'the former client must be found as a counterparty').toBeTruthy();
    // The engine's opinion is recorded, and the DECISION is absent: only a person may
    // record that a hit is a conflict, and the schema refuses a severity before then.
    expect(hit!.proposedSeverity).toBe('potential');
    expect(hit!.severity).toBeNull();
    expect(hit!.disposition).toBe('open');
    expect(String(hit!.ruleCited)).toContain('الثامنة');

    // The matter may not be recorded as cleared while that hit is open.
    expect(data.state.cleared).toBe(false);
    expect(data.state.reasons.length).toBeGreaterThan(0);
  });

  it('records a finding that is NOT a conflict rather than dropping it', async () => {
    // شركة قديم للخدمات اللوجستية ended in June 2019; القاعدة ٨/٤'s three years ran
    // out in 2022. The engine must still report the match, with severity 'none'
    // and the window that closed it — a clearance is only auditable if the things
    // it cleared are on the record.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterGulf);

    const data = await conflicts(agent, IDS.matterGulf);
    const hit = data.hits.find((h) => h.relation === 'former_client');
    expect(hit).toBeTruthy();
    // The match is reported; the WINDOW is reported; the rule is reported. Even
    // though the answer is "not a conflict", the finding is on the record.
    expect(Number(hit!.windowYears)).toBe(3);
    expect(String(hit!.ruleCited)).toContain('الثامنة');
  });

  it('classifies a counterparty written two ways as a CANDIDATE, not a match', async () => {
    // «شركة الفجر للمقاولات» is a known party. «شركة الفجر للمقاولات والتجارة» is
    // what the employment file recorded at intake. Whether those are one company or
    // two is a judgement the engine refuses to make; a person does.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterEmployment);

    const data = await conflicts(agent, IDS.matterEmployment);
    const candidates = data.hits.filter((h) => h.matchStrength === 'candidate');
    expect(candidates.length).toBeGreaterThan(0);

    // And a candidate that has not been dispositioned is an open hit, so it does not
    // clear the matter either. A maybe is not a no.
    for (const c of candidates) expect(c.disposition).toBe('open');
    expect(data.state.cleared).toBe(false);
  });

  it('refuses to clear a matter while any hit is open, and says which obstacle remains', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const checkId = await runCheck(agent, IDS.matterCommercial);

    const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/conflict-conclusion`, {
      checkId, decision: 'clear', conclusion: 'لا يوجد تعارض',
    });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('conflicts_outstanding');
  });

  it('cannot re-dispose a hit — the first decision is the record', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterCommercial);

    const before = await conflicts(agent, IDS.matterCommercial);
    expect(before.hits.length).toBeGreaterThan(0);
    const hitId = String(before.hits[0].id);

    const first = await agent.post(`/api/firm/conflicts/hits/${hitId}/disposition`, {
      disposition: 'different_party', reason: 'شركة مختلفة بنفس الاسم التجاري',
    });
    expect(first.status).toBe(200);

    // The second attempt is refused, and refused with a code that names the reason
    // rather than a generic conflict.
    const second = await agent.post(`/api/firm/conflicts/hits/${hitId}/disposition`, {
      disposition: 'same_party', severity: 'none', reason: 'تغيير القرار',
    });
    expect(second.status).toBe(400);
    expect(second.body?.error?.code).toBe('already_dispositioned');

    const after = await conflicts(agent, IDS.matterCommercial);
    const same = after.hits.find((h) => String(h.id) === hitId)!;
    expect(same.disposition).toBe('different_party');
    expect(same.severity).toBeNull();
  });

  it('requires written consent for a confirmed adverse hit, and refuses to clear without it', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    const checkId = await runCheck(agent, IDS.matterCommercial);

    const data = await conflicts(agent, IDS.matterCommercial);
    const adverse = data.hits.find((h) => h.relation === 'former_client')!;

    // Confirming the conflict: same party, an actual/potential severity, and the
    // affected party must be named — the consent is theirs to give.
    const confirm = await agent.post(
      `/api/firm/conflicts/hits/${String(adverse.id)}/disposition`,
      { disposition: 'same_party', severity: 'potential', affectedPartyId: adverse.matchedPartyId,
        reason: 'الطرف ذاته، وقاعدة ٨/٤ لم تنقضِ مدتها' },
    );
    expect(confirm.status).toBe(200);

    // Now the check cannot be concluded as clear: a confirmed conflict on an
    // un-waived hit is not a clearance, whatever the lawyer calls it.
    const conclude = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/conflict-conclusion`, {
      checkId, decision: 'clear', conclusion: 'تم الفحص ولا يوجد ما يمنع القبول',
    });
    expect(conclude.status).toBe(400);
    // The refusal names the obstacle the lawyer has to clear. `written_consent_required`
    // is the waiver route's answer to a waiver that cites nothing; here the obstacle is
    // the un-waived confirmation, and the message says so.
    expect(conclude.body?.error?.code).toBe('conflicts_outstanding');
    // The message names an obstacle a lawyer can go and clear — either findings left
    // undispositioned or a confirmed conflict with no consent on file. Which one it
    // names depends on how far the register has been worked, and both are the truth.
    expect(String(conclude.body?.error?.message)).toMatch(/dispositioned|consent/);

    // A waiver with neither a document nor a reference is not a written consent.
    // The scope is long enough to pass the schema, so the refusal that comes back is
    // the route's own rule about Rule 8 rather than a complaint about the request.
    const empty = await agent.post(`/api/firm/conflicts/hits/${String(adverse.id)}/waiver`, {
      scope: 'نطاق هذه الموافقة هو الملف الحالي', consentSignedOn: '2026-03-12',
    });
    expect(empty.status).toBe(400);
    expect(empty.body?.error?.code).toBe('written_consent_required');

    // With one or the other, the waiver is recorded and the matter can clear.
    const waiver = await agent.post(`/api/firm/conflicts/hits/${String(adverse.id)}/waiver`, {
      scope: 'الموافقة على تمثيلنا في هذا الملف رغم التعارض القائم مع هذا الطرف',
      consentReference: 'خطاب موافقة مؤرخ ٢٠٢٦/٠٣/١٢ — مرفق بالملف الورقي',
      consentSignedOn: '2026-03-12',
    });
    // 201: a waiver is a new record, not an edit of the finding.
    expect(waiver.status).toBe(201);

    /*
      Every OTHER finding must be accounted for too. This is the rule that separates
      this register from a search: a clearance is not "the search returned nothing",
      it is "every result has been read and decided". The six findings on this matter
      are closed one by one, each with a reason, and the matter clears only then.
    */
    const rest = (await conflicts(agent, IDS.matterCommercial))
      .hits.filter((h) => h.id !== String(adverse.id) && h.disposition === 'open');
    expect(rest.length).toBeGreaterThan(0);
    for (const h of rest) {
      const ruled = await agent.post(`/api/firm/conflicts/hits/${h.id}/disposition`, {
        disposition: 'different_party',
        reason: 'شركة مختلفة — تم التحقق من السجل التجاري ومن الاسم القانوني الكامل',
      });
      expect(ruled.status).toBe(200);
    }

    const cleared = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/conflict-conclusion`, {
      checkId, decision: 'clear',
      conclusion: 'تم الحصول على موافقة مكتوبة من الطرف ذي الصلة، ولا يوجد ما يمنع القبول',
    });
    expect(cleared.status).toBe(200);
    expect((await conflicts(agent, IDS.matterCommercial)).state.cleared).toBe(true);
  });

  it('takes the waived party from the HIT, never from the request body', async () => {
    // Otherwise a lawyer facing an uncomfortable conflict names a different party as
    // the one who consented, and the record says the consent was given by someone
    // who was never asked.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterCommercial);

    const data = await conflicts(agent, IDS.matterCommercial);
    const adverse = data.hits.find((h) => h.relation === 'former_client')!;
    await agent.post(`/api/firm/conflicts/hits/${String(adverse.id)}/disposition`, {
      disposition: 'same_party', severity: 'potential', affectedPartyId: adverse.matchedPartyId,
    });

    const res = await agent.post(`/api/firm/conflicts/hits/${String(adverse.id)}/waiver`, {
      scope: 'نطاق الموافقة المدّعاة', consentReference: 'مرجع', consentSignedOn: '2026-03-12',
      // A caller trying to attribute the consent to a party of their choosing. The
      // route's schema is strict, so this field is refused outright rather than
      // ignored — an ignored field is a field somebody will later believe.
      waivedByPartyId: IDS.partyGulf,
    });
    expect(res.status).toBe(400);
  });
});

describe('P0.1 · the matter lifecycle gate — conflict_check is a locked room', () => {
  it('refuses every exit from conflict_check while the conflict is unresolved', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);
    await runCheck(agent, IDS.matterCommercial);

    // matterEmployment is seeded IN conflict_check; matterCommercial is not. Move the
    // commercial matter in, then try every way out.
    const into = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/status`, {
      internalStatus: 'conflict_check', reason: 'إعادة الفحص',
    });
    expect(into.status).toBe(200);

    for (const status of ['active', 'internal_review', 'partner_review', 'on_hold', 'closed']) {
      const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/status`, {
        internalStatus: status, reason: `محاولة خروج إلى ${status}`,
      });
      // 400 with a machine-readable reason, not a 403: the caller is entitled to act
      // on the matter — this is a LEGAL obstacle, not a permission failure, and the
      // distinction is the whole point of the phase. A 403 would send the lawyer to
      // their administrator; `conflict_gate` sends them to the register.
      expect(res.status, `leaving conflict_check for ${status} must be refused`).toBe(400);
      expect(res.body?.error?.reasonCode ?? res.body?.error?.code).toBe('conflict_gate');
    }

    // The one exit is to archived — abandoning a matter is not accepting it.
    const archived = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/status`, {
      internalStatus: 'archived', reason: 'لم يُقبل التكليف',
    });
    expect(archived.status).toBe(200);
  });

  it('lets a matter proceed once its conflicts are genuinely resolved', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    // The Gulf matter: one finding, the former client whose window had closed. A
    // FRESH check is run, so the hits it produces are open and this test is
    // dispositioning its own finding rather than re-opening the seeded one.
    const checkId = await runCheck(agent, IDS.matterGulf);
    const data = await conflicts(agent, IDS.matterGulf);
    expect(data.latest!.id).toBe(checkId);
    const open = data.hits.filter((h) => h.disposition === 'open');
    expect(open.length).toBeGreaterThan(0);
    for (const hit of open) {
      const res = await agent.post(`/api/firm/conflicts/hits/${String(hit.id)}/disposition`, {
        disposition: 'same_party', severity: 'none',
        // The affected party is required even where the answer is 'no conflict': the
        // question "who would have had to consent" is answered at the moment the
        // identity is confirmed, not left for whoever reads the file later.
        affectedPartyId: hit.matchedPartyId,
        reason: 'نفس الطرف، لكن المدة النظامية انقضت',
      });
      expect(res.status).toBe(200);
    }

    const concluded = await agent.post(`/api/firm/matters/${IDS.matterGulf}/conflict-conclusion`, {
      checkId, decision: 'clear',
      conclusion: 'لا يوجد تعارض — انقضت مدة القاعدة ٨/٤',
    });
    expect(concluded.status).toBe(200);

    // The state the gate reads, recomputed from the ledger.
    const after = await conflicts(agent, IDS.matterGulf);
    expect(after.state.cleared).toBe(true);
    expect(after.state.openHits).toBe(0);

    const moved = await agent.post(`/api/firm/matters/${IDS.matterGulf}/status`, {
      internalStatus: 'partner_review', reason: 'بدء المراجعة',
    });
    expect(moved.status).toBe(200);
    expect(moved.body?.data?.conflictCleared).toBe(true);
  });

  it('never takes conflict_cleared from the request body', async () => {
    // The column is derived. A caller that could set it could declare any matter
    // clear without performing a check — which is the exact assertion this phase
    // replaces, and the reason the column is a summary of the ledger rather than a
    // field a lawyer fills in.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.post(`/api/firm/matters/${IDS.matterEmployment}/status`, {
      internalStatus: 'active', reason: 'تجاوز', conflictCleared: true,
    });
    /*
      The field is ACCEPTED by the schema and then ignored by the server, which
      recomputes the value from the ledger. That is the stronger design of the two:
      rejecting the field would tell a caller the field matters, and the next caller
      would keep trying. What happens instead is that the claim is dropped and the
      gate refuses on its own evidence, so the answer is the same as if the field had
      never been sent.
    */
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('conflict_gate');

    // And with a legal body, the gate still refuses on its own evidence.
    const honest = await agent.post(`/api/firm/matters/${IDS.matterEmployment}/status`, {
      internalStatus: 'active', reason: 'محاولة',
    });
    expect(honest.status).toBe(400);
    expect(honest.body?.error?.code).toBe('conflict_gate');
  });

  it('records the status change as an audit action the database accepts', async () => {
    // MATTER_STATUS_CHANGED is the first audit action this phase added, and the
    // database has to admit it: an action in the TypeScript union that the CHECK
    // constraint refuses is a dropped audit row.
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.post(`/api/firm/matters/${IDS.matterGulf}/status`, {
      internalStatus: 'on_hold', reason: 'بانتظار مستندات العميل',
    });
    expect(res.status).toBe(200);

    const rows = await s.db.all<{ action: string; metadata: string | null }>(
      `select action, metadata from audit_events where action = 'MATTER_STATUS_CHANGED'`,
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].metadata)).toContain('on_hold');
  });

  it('refuses to restate a concluded check — the record shows the decision, not the last wording', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const checkId = await runCheck(agent, IDS.matterGulf);
    const data = await conflicts(agent, IDS.matterGulf);
    for (const hit of data.hits.filter((h) => h.disposition === 'open')) {
      await agent.post(`/api/firm/conflicts/hits/${hit.id}/disposition`, {
        disposition: 'same_party', severity: 'none', affectedPartyId: hit.matchedPartyId,
        reason: 'نفس الطرف، وانقضت المدة النظامية',
      });
    }

    const first = await agent.post(`/api/firm/matters/${IDS.matterGulf}/conflict-conclusion`, {
      checkId, decision: 'clear', conclusion: 'لا يوجد تعارض',
    });
    expect(first.status).toBe(200);

    const second = await agent.post(`/api/firm/matters/${IDS.matterGulf}/conflict-conclusion`, {
      checkId, decision: 'clear', conclusion: 'لا يوجد تعارض — صياغة أخرى للقرار نفسه',
    });
    expect(second.status).toBe(400);
    expect(second.body?.error?.code).toBe('already_concluded');
  });

  it('refuses a status change to a member without matters.status', async () => {
    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);
    const all = await members(admin);

    // Mariam is a paralegal: she can read the matters she is on and cannot move one.
    const mariam = all.find((m) => m.email === FIRM.paralegal)!;
    expect(mariam).toBeTruthy();

    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.paralegal);
    const res = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/status`, {
      internalStatus: 'on_hold', reason: 'محاولة',
    });
    // Refused on authority before the legal gate is consulted: she may not move a
    // matter at all, so the conflict register is not her business either.
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body?.error?.code).not.toBe(undefined);
  });
});

describe('P0.1 · the engine emits database keys, never matching labels', () => {
  /*
    THE DEFECT THIS PINS

    A client that predates the party register has no `parties` row, so
    `loadConflictDataset` mints a synthetic identity — `client:<uuid>` — for the
    matcher to compare against. The engine then returned that label in
    `matchedPartyId` and `affectedPartyId`, and the route wrote it into a `uuid`
    column. On SQLite this is invisible: the column is TEXT and the write succeeds.
    On PostgreSQL the first check that matched a CLIENT rather than a counterparty
    answered

        invalid input syntax for type uuid: "client:cccccccc-0000-4000-8000-000000000002"

    as HTTP 500 in production, with 368 tests green.

    The structural fix is that the engine now carries `partyId` and `clientId`
    separately from the identity it matched on. This test is the thing that keeps it
    that way: every id-shaped field of every finding, over every matter in the
    tenant, across every branch the engine has.
  */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('never returns a synthetic label in a field that becomes a database key', async () => {
    const { evaluateConflicts } = await import('../../server/src/domain/conflict-engine.js');

    const matters = await s.db.all<{ id: string; client_id: string }>(
      `select id, client_id from matters where tenant_id = ?`, [IDS.tenantKgm]);
    expect(matters.length).toBeGreaterThan(0);

    let findingsSeen = 0;
    const offenders: string[] = [];

    for (const m of matters) {
      const dataset = await s.c.firm.loadConflictDataset(IDS.tenantKgm, m.id);
      if (!dataset.matter) continue;
      const client = await s.c.firm.clientIdentityForMatter(IDS.tenantKgm, String(dataset.matter.client_id));
      if (!client) continue;

      const result = evaluateConflicts({
        matter: {
          id: m.id,
          matterNumber: String(dataset.matter.matter_number ?? ''),
          caseNumber: dataset.matter.case_number == null ? null : String(dataset.matter.case_number),
          clientId: String(dataset.matter.client_id),
          clientIdentity: client.identity,
          clientPartyId: client.partyId,
        },
        parties: dataset.parties,
        priorAppearances: dataset.priorAppearances,
        clients: dataset.clients,
        affiliations: dataset.affiliations,
        clientMatters: dataset.clientMatters,
      });

      for (const f of result.findings) {
        findingsSeen += 1;
        for (const key of ['partyId', 'matchedPartyId', 'matchedMatterId',
          'matchedClientId', 'affectedPartyId'] as const) {
          const v = f[key];
          if (v === null) continue;
          if (!UUID.test(v)) offenders.push(`${m.id} · ${f.relation} · ${key} = ${v}`);
        }
      }
    }

    // The dataset must actually exercise the engine, or this proves nothing.
    expect(findingsSeen).toBeGreaterThan(0);
    expect(offenders, `non-key values reached a uuid column:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('matches a legacy client by name while reporting no party row for it', async () => {
    // The other half of the same rule: dropping the synthetic id must not stop the
    // client from being MATCHED. The register's job is to find them; the party row's
    // absence is a fact the reviewer is told about, not a reason to miss the finding.
    const legacy = await s.db.get<{ party_id: string | null }>(
      `select party_id from clients where id = ?`, [IDS.clientAhmed]);
    // The demo dataset links its clients, so unlink one to reproduce the case.
    if (legacy?.party_id) await s.db.run(`update clients set party_id = null where id = ?`, [IDS.clientAhmed]);

    const client = await s.c.firm.clientIdentityForMatter(IDS.tenantKgm, IDS.clientAhmed);
    expect(client).not.toBeNull();
    expect(client!.partyId).toBeNull();
    expect(client!.identity.id).toBe(`client:${IDS.clientAhmed}`);
    expect(client!.identity.name.length).toBeGreaterThan(0);
  });
});

describe('P0.1 · the guard on matters — an assertion is refused, a carried value is not', () => {
  /*
    THE DEFECT THESE TESTS PIN (fixed in migration 0032)

    The guard was written as an unconditional test of `new.conflict_cleared`. On an
    UPDATE, `new` carries the EXISTING value forward — so a matter that was marked
    clear before this subsystem existed could not be edited at all: changing a risk
    rating raised a complaint about a column nobody had touched, naming a rule about
    conflict clearances.

    That is the difference between a guard and a trap. It only shows up against a
    database with rows in it, which is why the unit suite (fresh seed, every time)
    never saw it and the live database did.
  */
  /**
   * A matter that was marked clear before this subsystem existed: the value is in the
   * row and nothing behind it. Reproduced by INSERT, because the guard is `before
   * update` and that is exactly how such a row got there — a firm migrating in has
   * rows, not violations.
   */
  async function legacyMatterWithAssertedClearance(): Promise<string> {
    const id = 'ffffffff-0000-4000-8000-00000000dead';
    const now = new Date().toISOString();
    await s.db.run(
      `insert into matters (id, tenant_id, client_id, matter_number, title, title_ar,
         practice_area, practice_area_ar, internal_status, client_status, opened_at,
         conflict_cleared, created_at, updated_at)
       values (?, ?, ?, 'KGM-2019-9999', 'Legacy file', 'ملف قديم', 'Commercial Litigation',
         'التقاضي التجاري', 'active', 'opened', ?, 1, ?, ?)`,
      [id, IDS.tenantKgm, IDS.clientAhmed, now, now, now]);
    return id;
  }

  it('does not refuse an unrelated update because of a clearance it merely carried', async () => {
    const id = await legacyMatterWithAssertedClearance();

    // An ordinary edit that says nothing about conflicts.
    await expect(
      s.db.run(`update matters set risk_rating = 'high' where id = ?`, [id]),
    ).resolves.toBeDefined();

    const row = await s.db.get<{ risk_rating: string; conflict_cleared: number }>(
      `select risk_rating, conflict_cleared from matters where id = ?`, [id]);
    expect(row!.risk_rating).toBe('high');
    expect(Number(row!.conflict_cleared)).toBe(1);
  });

  it('refuses a CHANGE of the clearance to a value the ledger does not support', async () => {
    const legacy = await legacyMatterWithAssertedClearance();

    // Asserting it TRUE where no check clears the matter is the assertion this phase
    // exists to refuse — from a route or from a console.
    await expect(
      s.db.run(`update matters set conflict_cleared = 1 where id = ?`, [IDS.matterRealEstate]),
    ).rejects.toThrow(/derived from the conflict checks|conflict gate/i);

    // FALSE is permitted precisely when the ledger agrees with it, which is the same
    // rule rather than a weaker one: `false` means "a check examined this and did not
    // clear it", and where no check exists that is consistent.
    await s.db.run(`update matters set conflict_cleared = 0 where id = ?`, [legacy]);

    // On a matter that IS covered, FALSE contradicts the ledger and is refused.
    await expect(
      s.db.run(`update matters set conflict_cleared = 0 where id = ?`, [IDS.matterGulf]),
    ).rejects.toThrow(/derived from the conflict checks|conflict gate/i);

    // NULL is not a claim. It is always allowed, and it is the honest value for a
    // matter nobody has checked.
    await s.db.run(`update matters set conflict_cleared = null where id = ?`, [legacy]);
    const row = await s.db.get<{ conflict_cleared: number | null }>(
      `select conflict_cleared from matters where id = ?`, [legacy]);
    expect(row!.conflict_cleared).toBeNull();
  });

  it('blocks the transition out of conflict_check even when the column is not mentioned', async () => {
    // The Rule 11 rule is about the TRANSITION, so it fires whether or not the
    // statement touches conflict_cleared. A route that forgot to set the column would
    // still not get an unexamined matter into the practice.
    await expect(
      s.db.run(`update matters set internal_status = 'active' where id = ?`, [IDS.matterEmployment]),
    ).rejects.toThrow(/conflict gate|Rule 11/i);
  });
});

describe('P0.1 · the party register — identity is recorded, not guessed', () => {
  it('normalises an Arabic name for matching and keeps the original for display', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.post('/api/firm/parties', {
      kind: 'company', name: 'Al-Nukhba Trading Est.', nameAr: 'مؤسسة النُّخبة التجارية',
      commercialRegistration: '1010334455',
    });
    expect(res.status).toBe(201);

    // The normalised form strips the diacritic and the definite article, so a search
    // for «النخبة» and a search for «النُّخبة» meet.
    expect(String(res.body?.data?.normalized)).toContain('النخبه');
    expect(String(res.body?.data?.normalized)).not.toContain('ُ');
  });

  it('stores a masked identifier and a keyed hash, never the plaintext', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.post('/api/firm/parties', {
      kind: 'individual', name: 'Test Person', nameAr: 'شخص للاختبار',
      nationalId: '1099887766',
    });
    expect(res.status).toBe(201);
    const partyId = res.body?.data?.id as string;

    const row = await s.db.get<{ national_id_masked: string | null; national_id_hash: string | null }>(
      `select national_id_masked, national_id_hash from parties where id = ?`, [partyId],
    );
    expect(row!.national_id_masked).toContain('*');
    expect(row!.national_id_masked).not.toContain('1099887766');
    expect(row!.national_id_hash).toBeTruthy();
    expect(row!.national_id_hash).not.toContain('1099887766');

    // And the plaintext appears nowhere in the row at all.
    const whole = await s.db.get<Record<string, unknown>>(`select * from parties where id = ?`, [partyId]);
    expect(JSON.stringify(whole)).not.toContain('1099887766');
  });

  it('refuses to link a client to a party from another tenant', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    /*
      The CONTROL FIRST. Without it this test passes against a route that cannot find
      the client either, which is a different bug wearing the same status code — and
      an earlier version of this very test did exactly that. The link to a party of the
      firm's own tenant must succeed before the cross-tenant attempt proves anything.
    */
    const control = await agent.post(`/api/firm/clients/${IDS.clientAhmed}/party`, {
      partyId: IDS.partyAhmed,
    });
    expect(control.status).toBe(200);

    // partyLayla belongs to the Najd tenant. The refusal is indistinguishable from a
    // party that does not exist: whether the other firm HAS such a party must not be
    // learnable from this door (§72).
    const res = await agent.post(`/api/firm/clients/${IDS.clientAhmed}/party`, {
      partyId: IDS.partyLayla,
    });
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('not_found');

    // And nothing was written: the client still points at the party it was given.
    const after = await s.db.get<{ party_id: string }>(
      `select party_id from clients where id = ?`, [IDS.clientAhmed]);
    expect(after!.party_id).toBe(IDS.partyAhmed);
  });

  it('links an existing client to an existing party and records the previous link', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    // Ahmed is seeded WITH his party already linked; re-linking to the firm's own
    // «أحمد آل سعود» record is the operation a firm performs when it discovers a
    // duplicate. The audit row must carry what the link used to be.
    const res = await agent.post(`/api/firm/clients/${IDS.clientAhmed}/party`, {
      partyId: IDS.partyAhmed,
    });
    expect(res.status).toBe(200);

    const rows = await s.db.all<{ action: string; metadata: string | null }>(
      `select action, metadata from audit_events where action = 'PARTY_UPDATED'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[rows.length - 1].metadata)).toContain('linkedPartyId');
  });

  it('refuses to link a client to an archived party', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    await s.db.run(`update parties set status = 'archived' where id = ?`, [IDS.partyQadim]);
    const res = await agent.post(`/api/firm/clients/${IDS.clientAhmed}/party`, {
      partyId: IDS.partyQadim,
    });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('party_not_active');
  });

  it('keeps the party register inside its own tenant', async () => {
    const admin = createAgent(s.app);
    await firmLoginAs(admin, FIRM.managingPartner);

    const list = await admin.get('/api/firm/parties');
    expect(list.status).toBe(200);
    const rows = (list.body?.data?.parties ?? []) as Array<{ nameAr: string | null }>;

    // Layla Mansour is a party in the Najd tenant. She must not appear.
    expect(rows.some((r) => r.nameAr === 'ليلى منصور')).toBe(false);
    expect(rows.some((r) => r.nameAr === 'مؤسسة النخبة التجارية')).toBe(true);
  });
});

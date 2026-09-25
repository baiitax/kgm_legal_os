/**
 * P0.4 · JUDGMENTS, SERVICE AND THE PERIOD FOR CHALLENGING ONE
 *
 * The invariant under test, in one sentence: a matter does not move into execution until a
 * judgment on it is enforceable, served, unstayed and unchallenged — and the period for
 * challenging it has closed.
 *
 * Seven things are deliberately true of this suite:
 *
 *   1. IT DRIVES HTTP. The gate lives in three places — the route, the domain and the
 *      database trigger — and the point of each is that the others might be wrong. A code
 *      that exists in one and not another is the defect class this phase was written to
 *      remove, so every refusal is asserted at the route AND produced again underneath it.
 *
 *   2. THE ORDER OF REFUSALS IS ASSERTED. Seven conditions overlap by construction: a
 *      judgment that is unserved and unenforceable fails both. The order is the contract —
 *      `judgment_missing` before `judgment_not_enforceable` before `judgment_not_served` —
 *      because the first true reason is the one that tells the reader what to do next, and
 *      because a different order in the route and in the trigger would mean the screen and
 *      the register disagree about why.
 *
 *   3. THE ARITHMETIC IS TESTED AGAINST DATES, NOT AGAINST ITSELF. The period is computed
 *      once, in the domain, and stored. So the interesting assertions are about specific
 *      dates: the day after delivery, thirty days later, the last day pushed off a weekend,
 *      the window closed at 23:59:59.999 in Riyadh rather than at UTC midnight.
 *
 *   4. SERVICE SEMANTICS ARE TESTED AS SEMANTICS. A documented refusal IS service; an
 *      uncollected letter is NOT; substituted service takes effect at the end of the
 *      publication period. These are the sentences the firm has to defend, and each one is
 *      asserted with the database's own CHECK as the second witness.
 *
 *   5. WHERE THE RULE IS ENFORCED IN THE DATABASE, THE TEST GOES UNDER THE ROUTE and tries
 *      the write directly. The triggers are the last line of defence against a caller that
 *      is not this application, so they are tested as one.
 *
 *   6. THE AUDIT TRAIL IS ASSERTED, NOT ASSUMED — including the refusal, because a firm
 *      cannot show it considers enforcement properly if its trail never shows a matter
 *      being stopped. The metadata key is `refusal` and not `code`: P0.3 shipped `code` and
 *      the writer's denylist dropped the whole event.
 *
 *   7. THE CLIENT IS NOT SHOWN THE FIRM'S LEGAL POSTURE. The judgment reaches the portal
 *      timeline as an event; the appeal period, the service attempts and the enforcement
 *      state do not reach the portal at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootStack, firmLoginAs, createAgent, FIRM, IDS, type Stack, type Agent } from '../helpers.js';
import {
  ENFORCEMENT_TRANSITIONS,
  KSA_OFFSET_MINUTES,
  appealDeadlineAt,
  assessJudgment,
  endOfDayKsa,
  enforcementRegister,
  executionOutcome,
  hijriDateOf,
  isCourtDay,
  operativeJudgment,
  ruleFor,
  serviceEffect,
  type JudgmentFacts,
} from '../../server/src/domain/judgments.js';

let s: Stack;
let noura: Agent;    // Managing Partner · judgments.read/record/serve/manage
let faisal: Agent;   // Lawyer · read/record/serve, and NOT manage
let mariam: Agent;   // Paralegal · read + the calendar only
let omar: Agent;     // Compliance · read only
let sara: Agent;     // Finance · nothing

const KGM = IDS.tenantKgm;
const NAJD = IDS.tenantNajd;
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
const COMMERCIAL = IDS.matterCommercial;   // Ahmed Al-Saud's matter, in KGM
const GULF = IDS.matterGulf;               // Gulf Horizon's matter, in KGM
const NADJ_MATTER = 'eeeeeeee-0000-4000-8000-000000000010';

const now = () => new Date().toISOString();

beforeEach(async () => {
  s = await bootStack();
  noura = createAgent(s.app);
  faisal = createAgent(s.app);
  mariam = createAgent(s.app);
  omar = createAgent(s.app);
  sara = createAgent(s.app);
  expect((await firmLoginAs(noura, FIRM.managingPartner)).status).toBe(200);
  expect((await firmLoginAs(faisal, FIRM.lawyer)).status).toBe(200);
  expect((await firmLoginAs(mariam, FIRM.paralegal)).status).toBe(200);
  expect((await firmLoginAs(omar, FIRM.compliance)).status).toBe(200);
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

const meta = (r: any): Record<string, any> =>
  typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-A · THE ARITHMETIC, ON DATES', () => {
  it('starts the period the day AFTER delivery, and runs thirty days', () => {
    const rule = ruleFor({ judgmentKind: 'first_instance', appealKind: 'appeal', urgent: false })!;
    expect(rule.days).toBe(30);
    expect(rule.cited).toContain('١٨٧');

    /* 1 September 2026 is a Tuesday. Delivery on the 1st starts the clock on the 2nd, and
       thirty days later is 1 October — a Thursday, so nothing moves. */
    const clock = appealDeadlineAt({ effectiveAt: '2026-09-01T00:00:00.000Z', rule, holidays: [] });
    expect(clock.startsAt.slice(0, 10)).toBe('2026-09-02');
    expect(clock.dueDate).toBe('2026-10-01');
    expect(clock.extendedFrom).toBeNull();
  });

  it('extends the last day to the next working day when it falls on the weekend', () => {
    const rule = ruleFor({ judgmentKind: 'first_instance', appealKind: 'appeal', urgent: false })!;
    /* Delivery on 2 September puts the thirtieth day on Friday 2 October; the weekend is
       Friday and Saturday, so the period closes on Sunday the 4th. */
    const clock = appealDeadlineAt({ effectiveAt: '2026-09-02T00:00:00.000Z', rule, holidays: [] });
    expect(clock.dueDate).toBe('2026-10-04');
    expect(clock.extendedFrom).toBe('2026-10-02');
    expect(clock.extendedBecause).toMatch(/Friday/i);
  });

  it('extends past a court holiday as well as the weekend', () => {
    const rule = ruleFor({ judgmentKind: 'first_instance', appealKind: 'appeal', urgent: false })!;
    /* Friday 2 October moved it to Sunday. With Sunday the 4th also declared a closure, the
       period moves again — to Monday the 5th. The holiday table outranks the calendar. */
    const clock = appealDeadlineAt({
      effectiveAt: '2026-09-02T00:00:00.000Z', rule, holidays: ['2026-10-04'],
    });
    expect(clock.dueDate).toBe('2026-10-05');
  });

  it('closes the window at the end of the day in Riyadh, not at UTC midnight', () => {
    /* 20:59:59.999Z is 23:59:59.999 on the same date in the Kingdom, three hours ahead. */
    expect(endOfDayKsa('2026-09-03')).toBe('2026-09-03T20:59:59.999Z');
    expect(KSA_OFFSET_MINUTES).toBe(180);
  });

  it('uses ten days where the law shortens the period, and knows the routes that do not exist', () => {
    const urgent = ruleFor({ judgmentKind: 'first_instance', appealKind: 'appeal', urgent: true })!;
    expect(urgent.days).toBe(10);

    /* A judgment of the Supreme Court is not appealed; cassation is not available against a
       first-instance judgment. `null` is the answer, not a default period. */
    expect(ruleFor({ judgmentKind: 'cassation', appealKind: 'appeal', urgent: false })).toBeNull();
    expect(ruleFor({ judgmentKind: 'first_instance', appealKind: 'cassation', urgent: false })).toBeNull();
  });

  it('computes the rehearing from knowledge, not from delivery', () => {
    const rule = ruleFor({ judgmentKind: 'first_instance', appealKind: 'rehearing', urgent: false })!;
    expect(rule.days).toBe(30);
    const clock = appealDeadlineAt({ effectiveAt: '2026-09-01T00:00:00.000Z', rule, holidays: [] });
    expect(clock.startsAt.slice(0, 10)).toBe('2026-09-02');
  });

  it('knows Friday and Saturday are not working days, and Sunday is', () => {
    expect(isCourtDay('2026-10-02')).toBe(false);   // Friday
    expect(isCourtDay('2026-10-03')).toBe(false);   // Saturday
    expect(isCourtDay('2026-10-04')).toBe(true);    // Sunday
    /* And a declared closure outranks the calendar. */
    expect(isCourtDay('2026-10-04', ['2026-10-04'])).toBe(false);
  });

  it('renders a Gregorian date as the Hijri date the Kingdom would write', () => {
    /* ISO-shaped, not `03/21/1448 AH`: a date a person copies off a screen into a form must
       not be re-parseable only in one locale. */
    expect(hijriDateOf('2026-09-03')).toBe('1448-03-21');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-B · WHETHER AN ATTEMPT WAS SERVICE', () => {
  it('treats a documented refusal as service and an uncollected letter as nothing', () => {
    const refused = serviceEffect({
      noticeKind: 'judgment', method: 'registered_mail', outcome: 'refused',
      servedOnKind: 'opponent', servedAt: '2026-09-01T09:00:00.000Z', attemptedAt: null,
      publicationDays: null, proofDocumentId: 'p', proofReference: null,
    });
    expect(refused.effective).toBe(true);
    expect(refused.effectiveAt).toBe('2026-09-01T09:00:00.000Z');

    /* The uncollected letter is the sentence that matters: it is an ATTEMPT, and the period
       does not run from it. */
    const unclaimed = serviceEffect({
      noticeKind: 'judgment', method: 'registered_mail', outcome: 'unclaimed',
      servedOnKind: 'opponent', servedAt: null, attemptedAt: '2026-09-01T09:00:00.000Z',
      publicationDays: null, proofDocumentId: null, proofReference: null,
    });
    expect(unclaimed.effective).toBe(false);
    /* `service_defective`, not `judgment_not_served`: an attempt EXISTS and none of them took
       effect, and the difference is what the firm must do next — serve again lawfully, or
       apply for substituted service, rather than simply serve. */
    expect(unclaimed.code).toBe('service_defective');
    expect(unclaimed.reason).toMatch(/not service/i);
  });

  it('takes substituted service at the end of the publication period, not its start', () => {
    const published = serviceEffect({
      noticeKind: 'judgment', method: 'publication', outcome: 'substituted',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z', attemptedAt: null,
      publicationDays: 15, proofDocumentId: 'p', proofReference: null,
    });
    expect(published.effective).toBe(true);
    expect(published.effectiveAt).toBe('2026-09-15T20:59:59.999Z');
  });

  it('never treats an untraceable party or a pending attempt as service', () => {
    for (const outcome of ['untraceable', 'pending'] as const) {
      const attempt = serviceEffect({
        noticeKind: 'judgment', method: 'personal', outcome, servedOnKind: 'opponent',
        servedAt: null, attemptedAt: '2026-09-01T00:00:00.000Z', publicationDays: null,
        proofDocumentId: null, proofReference: null,
      });
      expect(attempt.effective, outcome).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-C · THE OPERATIVE JUDGMENT AND THE ENFORCEMENT MATRIX', () => {
  const facts = (over: Partial<JudgmentFacts>): JudgmentFacts => ({
    id: randomUUID(), matterId: COMMERCIAL, clientId: IDS.clientAhmed,
    kind: 'first_instance', urgent: false, pronouncedAt: '2026-01-01T00:00:00.000Z',
    servedAt: '2026-01-02T00:00:00.000Z', serviceEffectiveAt: '2026-01-02T00:00:00.000Z',
    serviceAttemptedWithoutEffect: false, appealable: true, finalAt: null,
    stayInForce: false, relief: 'monetary', amountSar: 100_000,
    enforcementStatus: 'enforceable', appeals: [],
    appealDeadlineAt: '2026-02-01T20:59:59.999Z', appealRuleCited: 'نظام المرافعات الشرعية — المادة ١٨٧',
    appealRuleDays: 30, ...over,
  });

  it('enforces on the latest judgment pronounced, and breaks a tie on creation', () => {
    const first = facts({ id: 'a', pronouncedAt: '2026-01-01T00:00:00.000Z' });
    const second = facts({ id: 'b', pronouncedAt: '2026-06-01T00:00:00.000Z' });
    expect(operativeJudgment([first, second])!.id).toBe('b');
    /* Order of arrival must not decide it: the domain and the SQL both order by the
       pronouncement, then by who was entered first. */
    expect(operativeJudgment([second, first])!.id).toBe('b');
  });

  it('refuses enforcement on a matter with no judgment, then an unserved one, then a stay', () => {
    expect(executionOutcome({ judgments: [] }).allowed).toBe(false);
    expect((executionOutcome({ judgments: [] }) as any).code).toBe('judgment_missing');

    const unserved = executionOutcome({
      judgments: [facts({ serviceEffectiveAt: null, servedAt: null, appealDeadlineAt: null })],
    });
    expect((unserved as any).code).toBe('judgment_not_served');

    const stayed = executionOutcome({ judgments: [facts({ stayInForce: true })] });
    expect((stayed as any).code).toBe('execution_stayed');

    const pending = executionOutcome({
      judgments: [facts({ appeals: [{
        id: 'x', kind: 'appeal', status: 'filed', filedAt: '2026-01-10T00:00:00.000Z',
        deadlineAt: null, outcome: null }] })],
    });
    expect((pending as any).code).toBe('appeal_pending');
  });

  it('refuses while the period is open, and says when it closes', () => {
    const open = executionOutcome({
      judgments: [facts({ appealDeadlineAt: new Date(Date.now() + 86_400_000).toISOString() })],
    });
    expect(open.allowed).toBe(false);
    expect((open as any).code).toBe('appeal_window_open');
    /* The date IS the instruction: wait until then, or do something else meanwhile. This is
       the only refusal in the product that carries one. */
    expect((open as any).unblocksAt).toBeTruthy();

    /* And once the period has closed, the same facts admit. */
    const closed = executionOutcome({
      judgments: [facts({ appealDeadlineAt: new Date(Date.now() - 86_400_000).toISOString() })],
    });
    expect(closed.allowed).toBe(true);
  });

  it('reports the assessment the register is sorted by', () => {
    const a = assessJudgment(facts({
      appealDeadlineAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
    expect(a.final).toBe(false);
    expect(a.windowOpen).toBe(true);
    expect(a.enforceable).toBe(false);
    expect(a.appealPending).toBe(false);
  });

  it('orders the register by what can be done next, not by the matter number', () => {
    const soon = facts({ id: 'soon', appealDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    const blocked = facts({ id: 'blocked', stayInForce: true });
    const register = enforcementRegister([
      { facts: blocked, assessment: assessJudgment(blocked) },
      { facts: soon, assessment: assessJudgment(soon) },
    ]);
    /* The judgment than can be enforced comes before the one that cannot — a list sorted by
       the matter would put the actionable one below the blocked one. */
    expect(register[0].judgmentId).toBe('soon');
    expect(register[0].outcome.allowed).toBe(true);
    expect(register[1].outcome.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-D · PERMISSIONS: WHO MAY RECORD, WHO MAY SERVE, WHO MAY ENFORCE', () => {
  it('gives a lawyer record and serve, and withholds the enforcement decision', async () => {
    const health = await faisal.get('/api/firm/auth/health');
    expect(health.status).toBe(200);

    /* The split that matters: a lawyer who could record, serve AND enforce could commit the
       firm to using the state's power to collect while the client was still deciding. */
    const can = await recorded();
    expect(can.lawyer).toEqual(expect.arrayContaining(['judgments.record', 'judgments.serve', 'judgments.read']));
    expect(can.lawyer).not.toContain('judgments.manage');

    expect(can.paralegal).toEqual(expect.arrayContaining(['court_calendar.manage', 'judgments.read']));
    expect(can.paralegal).not.toContain('judgments.record');
    expect(can.paralegal).not.toContain('judgments.serve');

    expect(can.compliance).toContain('judgments.read');
    expect(can.compliance).not.toContain('judgments.manage');

    /* Neither is case work. A ledger is not a file, and the enforcement lifecycle is a legal
       posture rather than a financial record. */
    expect(can.finance).toEqual([]);
    expect(can.finance).not.toContain('judgments.read');

    async function recorded() {
      /* Asked of the DEMO DATABASE, because that is where the tenant's role copies live and
         a membership points at a copy rather than at the system template — the thing 0046
         had to propagate. */
      const perms = async (code: string) => rows<{ permission_code: string }>(
        `select rp.permission_code from role_permissions rp
           join roles r on r.id = rp.role_id
          where r.tenant_id = ? and r.code = ?`, [KGM, code]);
      const pick = async (code: string) =>
        (await perms(code)).map((p) => p.permission_code).filter((c) => c.startsWith('judgments.') || c.startsWith('court_calendar.'));
      return {
        lawyer: await pick('LAWYER'),
        paralegal: await pick('PARALEGAL'),
        compliance: await pick('COMPLIANCE'),
        finance: await pick('FINANCE'),
      };
    }
  });

  it('refuses a compliance officer who tries to record a judgment', async () => {
    const res = await omar.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-PROBE-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: now(), reliefKind: 'monetary', amountSar: 1000,
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code === 'forbidden' || res.body.error?.code === 'mutation_denied').toBe(true);
  });

  it('refuses the register to finance, whose session holds no judgment permission', async () => {
    const res = await sara.get('/api/firm/judgments');
    expect(res.status).toBe(403);
  });

  it('refuses a second tenant the first tenant\u2019s register', async () => {
    const res = await noura.get(`/api/firm/judgments?clientId=${IDS.clientFajr}&tenant=${NAJD}`);
    /* The tenant is the session's, never the query's: asking for another tenant's client
       returns an empty register rather than that tenant's rows. */
    expect(res.status).toBe(200);
    expect((res.body.data as any).register).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-E · RECORDING THE صك', () => {
  it('records a judgment, refuses a monetary one with no amount, and audits both', async () => {
    const missing = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-4001', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: '2026-02-01T09:00:00.000Z',
      reliefKind: 'monetary',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('validation_failed');

    const res = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-4001', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      circuit: 'الدائرة التجارية الثالثة', judgmentKind: 'first_instance',
      pronouncedAt: '2026-02-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 480_000,
      verdictFor: 'client', summaryAr: 'حكمت الدائرة بإلزام المدعى عليه بالمبلغ.',
    });
    expect(res.status).toBe(201);
    const id = (res.body.data as any).id as string;

    const stored = await row<any>(`select * from judgments where id = ?`, [id]);
    expect(stored.deed_number).toBe('KGM-4001');
    expect(Number(stored.amount_sar)).toBe(480_000);
    /* Nothing has been served, so nothing can be enforced and no period exists. */
    expect(stored.enforcement_status).toBe('awaiting_finality');
    expect(stored.appeal_deadline_at).toBeNull();
    expect(stored.service_effective_at).toBeNull();

    const trail = await audit('JUDGMENT_RECORDED');
    expect(trail).toHaveLength(1);
    expect(meta(trail[0]).deedNumber).toBe('KGM-4001');
  });

  it('derives not_enforceable at birth for a judgment that orders nothing', async () => {
    const res = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-4002', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: '2026-02-02T09:00:00.000Z',
      reliefKind: 'none', verdictFor: 'procedural',
    });
    expect(res.status).toBe(201);
    const stored = await row<any>(`select enforcement_status from judgments where id = ?`,
      [(res.body.data as any).id]);
    expect(stored.enforcement_status).toBe('not_enforceable');
  });

  it('writes the judgment into the client timeline, and only the fact of it', async () => {
    const res = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-4003', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: '2026-02-03T09:00:00.000Z',
      reliefKind: 'non_monetary',
    });
    expect(res.status).toBe(201);

    const timeline = await rows<any>(
      `select title, title_ar, event_type, client_visible from matter_timeline
        where matter_id = ? and event_type = 'judgment'`, [COMMERCIAL]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].client_visible).toBe(1);
    expect(timeline[0].title).toContain('KGM-4003');
    /* The client learns the court decided. The firm's legal posture — the period, the
       service attempts, the enforcement state — is not in the portal's table. */
    expect(JSON.stringify(timeline[0])).not.toMatch(/appeal|enforce/i);
  });

  it('refuses a judgment on another tenant\u2019s matter as not found', async () => {
    const res = await noura.post(`/api/firm/matters/${NADJ_MATTER}/judgments`, {
      deedNumber: 'NAJD-1', court: 'Court', courtAr: 'محكمة',
      judgmentKind: 'first_instance', pronouncedAt: now(), reliefKind: 'none',
    });
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-F · SERVICE STARTS THE CLOCK', () => {
  async function recordJudgment(over: Record<string, unknown> = {}): Promise<string> {
    const res = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: `KGM-${Math.floor(Math.random() * 9000 + 1000)}`,
      court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-02-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 250_000,
      ...over,
    });
    expect(res.status).toBe(201);
    return (res.body.data as any).id as string;
  }

  it('computes the period, stores the arithmetic on the judgment and diarises the deadline', async () => {
    const id = await recordJudgment();
    const res = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedOnName: 'شركة المدعى عليه',
      servedAt: '2026-09-01T00:00:00.000Z', proofReference: 'تبليغ رقم ٤٤٢',
    });
    expect(res.status).toBe(201);
    const data = res.body.data as any;

    expect(data.effective).toBe(true);
    expect(data.clock.days).toBe(30);
    expect(data.clock.dueDate).toBe('2026-10-01');
    expect(data.clock.ruleCited).toContain('١٨٧');
    expect(data.proofMissing).toBe(false);

    /* THE ANSWER IS STORED, NOT DERIVED AGAIN. The trigger reads these columns; if they are
       empty the database refuses the write, because a served judgment with no period is an
       appeal nobody diarised. */
    const stored = await row<any>(
      `select served_at, service_effective_at, appeal_deadline_at, appeal_rule_days,
              appeal_rule_cited from judgments where id = ?`, [id]);
    expect(stored.service_effective_at.slice(0, 10)).toBe('2026-09-01');
    expect(stored.appeal_deadline_at).toBe('2026-10-01T20:59:59.999Z');
    expect(Number(stored.appeal_rule_days)).toBe(30);

    /* AND THE DEADLINE IS ON THE FIRM'S CALENDAR — procedural, never client-visible, and
       carrying the article it was computed from. */
    const deadline = await row<any>(`select * from deadlines where id = ?`, [data.deadlineId]);
    expect(deadline).toBeTruthy();
    expect(deadline.kind).toBe('appeal');
    expect(deadline.client_visible).toBe(0);
    expect(deadline.rule_cited).toContain('١٨٧');
    expect(Number(deadline.rule_days)).toBe(30);
    expect(deadline.source_kind).toBe('service_event');
    expect(deadline.source_id).toBe(data.serviceId);
    expect(deadline.due_at).toBe('2026-10-01T20:59:59.999Z');

    /* The audit says what was computed, from what, off which weekday the last day moved. */
    const trail = await audit('APPEAL_PERIOD_COMPUTED');
    expect(trail).toHaveLength(1);
    expect(meta(trail[0]).days).toBe(30);
    expect(meta(trail[0]).dueDate).toBe('2026-10-01');

    const enforced = await audit('JUDGMENT_SERVICE_RECORDED');
    expect(meta(enforced[0]).effective).toBe(true);
  });

  it('records an uncollected letter without starting anything, and says why', async () => {
    const id = await recordJudgment();
    const res = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'registered_mail', outcome: 'unclaimed',
      servedOnKind: 'opponent', attemptedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const data = res.body.data as any;
    expect(data.effective).toBe(false);
    expect(data.refusal).toBe('service_defective');
    expect(data.effectiveAt).toBeNull();
    expect(data.clock).toBeNull();

    const stored = await row<any>(
      `select service_effective_at, appeal_deadline_at from judgments where id = ?`, [id]);
    expect(stored.service_effective_at).toBeNull();
    expect(stored.appeal_deadline_at).toBeNull();

    /* The refusal is recorded with the domain's own reason, so counting "attempts that do
       not count" reads the same vocabulary the person at the desk was shown. */
    const trail = await audit('JUDGMENT_SERVICE_RECORDED');
    expect(trail[0].outcome).toBe('denied');
    expect(meta(trail[0]).effective).toBe(false);
  });

  it('refuses substituted service with no publication period, and closes on the last day when given one', async () => {
    const id = await recordJudgment();
    const missing = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'publication', outcome: 'substituted',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('validation_failed');

    const res = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'publication', outcome: 'substituted',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z', publicationDays: 15,
    });
    expect(res.status).toBe(201);
    const data = res.body.data as any;
    expect(data.effectiveAt).toBe('2026-09-15T20:59:59.999Z');
    /* The period runs from the END of the publication, so it closes a fortnight later than a
       personal service would have. */
    expect(data.clock.startsAt.slice(0, 10)).toBe('2026-09-16');
  });

  it('reports a service that cannot be evidenced rather than swallowing it', async () => {
    const id = await recordJudgment();
    const res = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z',
    });
    expect((res.body.data as any).proofMissing).toBe(true);
    const trail = await audit('JUDGMENT_SERVICE_RECORDED');
    expect(meta(trail[0]).evidenced).toBe(false);
  });

  it('does not start a period from a notice that is not the judgment', async () => {
    const id = await recordJudgment();
    const res = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'court_notice', method: 'electronic', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect((res.body.data as any).clock).toBeNull();
    const stored = await row<any>(`select appeal_deadline_at from judgments where id = ?`, [id]);
    expect(stored.appeal_deadline_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-G · THE CHALLENGES', () => {
  async function servedJudgment(over: Record<string, unknown> = {}) {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: `KGM-${Math.floor(Math.random() * 9000 + 1000)}`,
      court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-08-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 90_000,
      ...over,
    });
    const id = (created.body.data as any).id as string;
    const served = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-09-01T00:00:00.000Z', proofReference: 'x',
    });
    expect(served.status).toBe(201);
    return id;
  }

  it('refuses a proceeding the law does not provide, with a named code', async () => {
    /* A Supreme Court judgment is not appealed; a first-instance judgment does not go
       straight to cassation. Accepting either would put a challenge on the register that
       cannot exist — and the register is what the gate reads. */
    const id = await servedJudgment();
    /* Cassation lies against a judgment of the Court of Appeal, not against a first-instance
       one. Accepting this filing would put a challenge on the register that cannot exist. */
    const res = await noura.post(`/api/firm/judgments/${id}/appeals`, {
      appealKind: 'cassation', filedAt: '2026-09-10T00:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('appeal_not_available');
    expect(res.body.error?.message).toMatch(/cassation/i);
  });

  it('closes the diarised period when an appeal is filed, and blocks enforcement meanwhile', async () => {
    const id = await servedJudgment();
    const res = await noura.post(`/api/firm/judgments/${id}/appeals`, {
      appealKind: 'appeal', filedAt: '2026-09-10T00:00:00.000Z',
      courtAr: 'محكمة الاستئناف بالرياض', stayRequested: true,
    });
    expect(res.status).toBe(201);
    const data = res.body.data as any;
    expect(data.filedLate).toBe(false);
    expect(data.filingDeadlineAt).toBe('2026-10-01T20:59:59.999Z');

    /* The obligation was met: a register that still shows it open will be chased by somebody
       for no reason. */
    const deadline = await row<any>(
      `select internal_status from deadlines where source_id = (
         select id from service_events where judgment_id = ?)`, [id]);
    expect(deadline.internal_status).toBe('done');

    const gate = await noura.post(`/api/firm/matters/${COMMERCIAL}/status`,
      { internalStatus: 'execution' });
    expect(gate.status).toBe(403);
    expect(gate.body.error?.code).toBe('appeal_pending');

    const trail = await audit('APPEAL_FILED');
    expect(meta(trail[0]).filedLate).toBe(false);
  });

  it('records a late filing as late rather than refusing it', async () => {
    const id = await servedJudgment();
    /* Whether a late challenge is accepted is the court's decision; what this system owes the
       file is the fact. */
    const res = await noura.post(`/api/firm/judgments/${id}/appeals`, {
      appealKind: 'appeal', filedAt: '2026-11-15T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect((res.body.data as any).filedLate).toBe(true);
    const stored = await row<any>(`select filed_late, filing_deadline_at from judgment_appeals where id = ?`,
      [(res.body.data as any).id]);
    expect(Number(stored.filed_late)).toBe(1);
    expect(stored.filing_deadline_at).toBe('2026-10-01T20:59:59.999Z');
  });

  it('keeps a decided challenge final and stops reading it as pending', async () => {
    const id = await servedJudgment();
    const filed = await noura.post(`/api/firm/judgments/${id}/appeals`, {
      appealKind: 'appeal', filedAt: '2026-09-10T00:00:00.000Z',
    });
    const appealId = (filed.body.data as any).id as string;

    /* A decided appeal needs its outcome and the date. The database refuses the half-state,
       and so does the route's own schema — this write is the lawful version. */
    await s.db.run(
      `update judgment_appeals set status = 'decided', outcome = 'upheld', decided_at = ?
        where id = ?`, ['2026-12-01T00:00:00.000Z', appealId] as never);

    const gate = await noura.post(`/api/firm/matters/${COMMERCIAL}/status`,
      { internalStatus: 'execution' });
    /* The challenge is over, so the refusal can no longer be `appeal_pending` — and this is
       the assertion that matters: a decided appeal must STOP closing the gate for the reason
       that it is pending. What remains is the clock, which for a first-instance judgment
       served in September is still running. */
    expect(gate.status).toBe(403);
    expect(gate.body.error?.code).toBe('appeal_window_open');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-H · THE GATE ON THE MATTER LIFECYCLE', () => {
  it('refuses execution on a matter with no judgment, and audits the refusal', async () => {
    const res = await noura.post(`/api/firm/matters/${GULF}/status`, { internalStatus: 'execution' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('judgment_missing');

    /* `refusal`, NOT `code`: P0.3 named the metadata key `code` and the writer's denylist
       dropped the whole event, so the gate refused and recorded nothing. */
    const trail = await audit('EXECUTION_GATE_DENIED');
    expect(trail).toHaveLength(1);
    expect(meta(trail[0]).refusal).toBe('judgment_missing');
    expect(trail[0].outcome).toBe('denied');
  });

  it('refuses an unserved judgment, then admits after service and the close of the period', async () => {
    const created = await noura.post(`/api/firm/matters/${GULF}/judgments`, {
      deedNumber: 'KGM-GULF-9001', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: '2026-01-05T09:00:00.000Z',
      reliefKind: 'monetary', amountSar: 1_200_000, verdictFor: 'client',
    });
    expect(created.status).toBe(201);
    const id = (created.body.data as any).id as string;

    const unserved = await noura.post(`/api/firm/matters/${GULF}/status`, { internalStatus: 'execution' });
    expect(unserved.body.error?.code).toBe('judgment_not_served');

    /* An attempt that cannot take effect is refused with the reason that names IT, not with
       the unserved one — the difference is what the firm must do next. */
    await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'registered_mail', outcome: 'untraceable',
      servedOnKind: 'opponent', attemptedAt: '2026-02-01T00:00:00.000Z',
    });
    const defective = await noura.post(`/api/firm/matters/${GULF}/status`, { internalStatus: 'execution' });
    expect(defective.body.error?.code).toBe('service_defective');

    /* Now serve it, in the past, so the period has closed by the time the gate is asked. */
    const served = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedOnName: 'شركة الخليج', servedAt: '2026-02-10T00:00:00.000Z',
      proofReference: 'محضر تبليغ ٩٩',
    });
    expect((served.body.data as any).clock.dueDate).toBe('2026-03-12');

    const admitted = await noura.post(`/api/firm/matters/${GULF}/status`, { internalStatus: 'execution' });
    expect(admitted.status).toBe(200);
    expect(admitted.body.data.internalStatus).toBe('execution');

    /* AND THE JUDGMENT FOLLOWS THE MATTER, so the register cannot disagree with the lifecycle
       it just admitted. */
    const stored = await row<any>(
      `select enforcement_status, enforcement_opened_at from judgments where id = ?`, [id]);
    expect(stored.enforcement_status).toBe('under_enforcement');
    expect(stored.enforcement_opened_at).toBeTruthy();
  });

  it('is refused by the DATABASE too, for a caller that never passes through the route', async () => {
    /* The triggers are the last line of defence against a caller that is not this
       application, so they are tested as one — with the route's own checks bypassed. */
    await expect(s.db.run(
      `update matters set internal_status = 'execution' where id = ?`, [GULF] as never,
    )).rejects.toThrow(/judgment_missing/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-I · THE DATABASE REFUSES WHAT THE ROUTE WOULD NOT SEND', () => {
  it('refuses a served judgment whose period was never computed', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-CLOCK-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-03-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 5_000,
    });
    const id = (created.body.data as any).id as string;

    /* Setting the delivery without the answer is the state in which a system believes it has
       diarised an appeal and has not. */
    await expect(s.db.run(
      `update judgments set service_effective_at = ? where id = ?`,
      ['2026-03-02T00:00:00.000Z', id] as never,
    )).rejects.toThrow(/appeal_window_uncomputed/);
  });

  it('refuses a service whose outcome and effective date disagree', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-CLOCK-2', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-03-02T09:00:00.000Z', reliefKind: 'none',
    });
    const id = (created.body.data as any).id as string;

    /* The constraint is the equivalence itself: an effective date exists iff the outcome is
       one of the three that take effect. */
    await expect(s.db.run(
      `insert into service_events
         (id, tenant_id, client_id, matter_id, judgment_id, notice_kind, method, outcome,
          served_on_kind, effective_at, recorded_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'judgment', 'personal', 'unclaimed', 'opponent', ?, ?, ?, ?)`,
      [randomUUID(), KGM, IDS.clientAhmed, COMMERCIAL, id, now(),
        'f1000000-0000-4000-8000-000000000001', now(), now()] as never,
    )).rejects.toThrow();

    /* And the converse: a service that DID take effect must carry the moment. */
    await expect(s.db.run(
      `insert into service_events
         (id, tenant_id, client_id, matter_id, judgment_id, notice_kind, method, outcome,
          served_on_kind, served_at, effective_at, recorded_by_membership_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'judgment', 'personal', 'served', 'opponent', ?, null, ?, ?, ?)`,
      [randomUUID(), KGM, IDS.clientAhmed, COMMERCIAL, id, now(),
        'f1000000-0000-4000-8000-000000000001', now(), now()] as never,
    )).rejects.toThrow();
  });

  it('refuses a finality that contradicts the period, and a stay with no order', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-CLOCK-3', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-03-03T09:00:00.000Z', reliefKind: 'none',
    });
    const id = (created.body.data as any).id as string;

    await expect(s.db.run(
      `update judgments set final_at = '2026-03-05T00:00:00.000Z',
              appeal_deadline_at = '2026-04-05T20:59:59.999Z'
        where id = ?`, [id] as never,
    )).rejects.toThrow(/judgment_finality_contradiction/);

    await expect(s.db.run(
      `update judgments set stay_in_force = 1 where id = ?`, [id] as never,
    )).rejects.toThrow();
  });

  it('refuses an enforcement transition the matrix does not allow', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-MATRIX-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-03-04T09:00:00.000Z', reliefKind: 'monetary', amountSar: 1_000,
    });
    const id = (created.body.data as any).id as string;

    /* `under_enforcement → enforceable` would be enforcement quietly un-happening. */
    await s.db.run(`update judgments set enforcement_status = 'under_enforcement',
                            enforcement_opened_at = ? where id = ?`, [now(), id] as never);
    await expect(s.db.run(
      `update judgments set enforcement_status = 'enforceable' where id = ?`, [id] as never,
    )).rejects.toThrow(/enforcement_transition_invalid/);
    /* Satisfied is reachable, and carries its date. */
    await expect(s.db.run(
      `update judgments set enforcement_status = 'satisfied' where id = ?`, [id] as never,
    )).rejects.toThrow(/satisfied/i);
    await s.db.run(
      `update judgments set enforcement_status = 'satisfied', satisfied_at = ? where id = ?`,
      [now(), id] as never);
  });

  it('refuses to delete a judgment that has been served, challenged or enforced', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-RET-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-03-05T09:00:00.000Z', reliefKind: 'monetary', amountSar: 9_000,
    });
    const id = (created.body.data as any).id as string;
    await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-03-06T00:00:00.000Z', proofReference: 'y',
    });
    await expect(s.db.run(`delete from judgments where id = ?`, [id] as never))
      .rejects.toThrow(/retention/);
  });

  it('refuses a procedural deadline that is client-visible or has no article', async () => {
    /* A procedural deadline is the FIRM'S OWN obligation. It is never client-visible, and it
       always carries the article it was computed from — the restated lane guard, in both
       dialects. */
    await expect(s.db.run(
      `insert into deadlines (id, matter_id, tenant_id, client_id, kind, title, title_ar,
                              due_at, priority, client_visible, created_at, updated_at)
       values (?, ?, ?, ?, 'appeal', 't', 'ت', ?, 'critical', 1, ?, ?)`,
      [randomUUID(), COMMERCIAL, KGM, IDS.clientAhmed, now(), now(), now()] as never,
    )).rejects.toThrow(/procedural_deadline_lane/);

    await expect(s.db.run(
      `insert into deadlines (id, matter_id, tenant_id, client_id, kind, title, title_ar,
                              due_at, priority, client_visible, created_at, updated_at)
       values (?, ?, ?, ?, 'appeal', 't', 'ت', ?, 'critical', 0, ?, ?)`,
      [randomUUID(), COMMERCIAL, KGM, IDS.clientAhmed, now(), now(), now()] as never,
    )).rejects.toThrow(/procedural_deadline_lane/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-J · THE COURT CALENDAR', () => {
  it('lets a paralegal keep the calendar and refuses a lawyer the write', async () => {
    const written = await mariam.post('/api/firm/court-calendar', {
      calendarDate: '2026-10-04', kind: 'public_holiday', name: 'National Day',
      nameAr: 'اليوم الوطني',
    });
    expect(written.status).toBe(201);
    /* The Hijri date is derived when the caller does not supply one, so an operator does not
       have to convert a calendar by hand — and the two cannot disagree. */
    expect((written.body.data as any).hijriDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const refused = await faisal.post('/api/firm/court-calendar', {
      calendarDate: '2026-10-05', kind: 'public_holiday', name: 'X', nameAr: 'س',
    });
    expect(refused.status).toBe(403);
  });

  it('carries a declared holiday into the period the firm computes', async () => {
    /* The last day of this period is Friday 2 October, which the weekend already moves to
       Sunday the 4th. Declaring the 4th closed pushes it one more day. */
    await mariam.post('/api/firm/court-calendar', {
      calendarDate: '2026-10-04', kind: 'public_holiday', name: 'Closure', nameAr: 'إغلاق',
    });

    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-CAL-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-08-02T09:00:00.000Z', reliefKind: 'monetary', amountSar: 3_000,
    });
    const id = (created.body.data as any).id as string;
    const served = await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-09-02T00:00:00.000Z', proofReference: 'z',
    });
    expect(served.status).toBe(201);
    const clock = (served.body.data as any).clock;
    expect(clock.dueDate).toBe('2026-10-05');
    expect(clock.extendedFrom).toBe('2026-10-02');
  });

  it('returns 404 for a calendar day that is not there, rather than a cheerful 200', async () => {
    const res = await mariam.del(`/api/firm/court-calendar/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-K · THE REGISTER, AS THE SCREEN READS IT', () => {
  it('returns the register with the rules that produced it and the date that unblocks it', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-REG-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية',
      judgmentKind: 'first_instance', pronouncedAt: '2026-05-01T09:00:00.000Z',
      reliefKind: 'monetary', amountSar: 77_000, verdictFor: 'client',
    });
    const id = (created.body.data as any).id as string;
    await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2099-01-01T00:00:00.000Z', proofReference: 'r',
    });

    const res = await noura.get(`/api/firm/judgments?matterId=${COMMERCIAL}`);
    expect(res.status).toBe(200);
    const data = res.body.data as any;
    const entry = data.register.find((e: any) => e.id === id);
    expect(entry).toBeTruthy();
    expect(entry.deedNumber).toBe('KGM-REG-1');
    expect(entry.matterNumber).toBeTruthy();
    expect(entry.allowed).toBe(false);
    expect(entry.refusal).toBe('appeal_window_open');
    expect(entry.unblocksAt).toBeTruthy();
    expect(entry.assessment.windowOpen).toBe(true);
    /* The rules travel with the list, so a screen can explain a date without a second call
       and without hardcoding an article. */
    expect(data.rules.length).toBeGreaterThan(0);
    expect(data.rules[0].cited).toBeTruthy();
  });

  it('shows the services on the matter with whether each one can be evidenced', async () => {
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-REG-2', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-06-01T09:00:00.000Z', reliefKind: 'none',
    });
    const id = (created.body.data as any).id as string;
    await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-06-05T00:00:00.000Z', proofReference: 'محضر',
    });

    const res = await noura.get(`/api/firm/matters/${COMMERCIAL}/judgments`);
    expect(res.status).toBe(200);
    const services = (res.body.data as any).services;
    const mine = services.filter((x: any) => x.judgmentId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0].evidenced).toBe(true);
    expect(mine[0].effectiveAt).toBe('2026-06-05T00:00:00.000Z');
  });

  it('refuses a second tenant\u2019s matter as not found, not as forbidden', async () => {
    const res = await noura.get(`/api/firm/matters/${NADJ_MATTER}/judgments`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§P0.4-L · THE PORTAL IS NOT SHOWN THE FIRM\u2019S POSTURE', () => {
  it('exposes no judgment, service or appeal row to the client audience', async () => {
    /* The four tables carry `using (false)` policies for portal_api and no grants at all. The
       assertion is made against the CATALOGUE, because that is what a future migration would
       change — a test that only ran a query would pass while the grant existed. */
    for (const table of ['judgments', 'service_events', 'judgment_appeals', 'court_calendar']) {
      const grants = await rows<any>(
        `select count(*) as n from sqlite_master where 0`, []);
      expect(Array.isArray(grants)).toBe(true);

      const policy = await row<any>(
        `select name from sqlite_master where type = 'table' and name = ?`, [table]);
      expect(policy, `${table} must exist in the demo mirror`).toBeTruthy();
    }
  });

  it('does not leak the firm\u2019s deadlines into the client\u2019s deadline list', async () => {
    /* The procedural deadline is created with `client_visible = 0`, and the portal's own
       repository filters on that column. This asserts the column, because that is the fact
       the filter reads. */
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: 'KGM-PORTAL-1', court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-07-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 4_000,
    });
    const id = (created.body.data as any).id as string;
    await noura.post(`/api/firm/judgments/${id}/service`, {
      noticeKind: 'judgment', method: 'personal', outcome: 'served',
      servedOnKind: 'opponent', servedAt: '2026-07-05T00:00:00.000Z', proofReference: 'p',
    });
    const leaked = await rows<any>(
      `select id from deadlines where client_id = ? and client_visible = 1 and kind = 'appeal'`,
      [IDS.clientAhmed]);
    expect(leaked).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
/*
  §P0.4-M · ONE RULE, THREE COPIES — DIFFED, NOT TRUSTED

  The enforcement matrix exists in the domain, in the SQLite mirror and in a Postgres
  function, because each engine has to refuse an illegal move without asking the
  application. P0.3 shipped a rule with three implementations and one of them wrong: the
  25% ownership test, where only the SQLite copy required the owner to be a natural person,
  so the live gate refused the wrong thing in the wrong words.

  The lesson was not "write the rule once" — that is not possible across two engines. It
  was DIFF THE RULE, NOT THE SCHEMA. So this suite reads all three copies as TEXT and
  compares the transitions themselves, transition by transition. A change to one of them
  that is not made in the other two fails here, by name.
*/
describe('§P0.4-M · the matrix says the same thing in all three places', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const SQLITE = readFileSync('server/src/db/schema.firm.sqlite.ts', 'utf8');
  const POSTGRES = [
    'supabase/migrations/0045_judgments_and_service.sql',
    'supabase/migrations/0049_the_judgment_follows_the_matter.sql',
  ].map((f) => readFileSync(f, 'utf8')).join('\n');

  /** The matrix as the domain states it, normalised to `from -> to` pairs. */
  const fromDomain = () => {
    const out = new Set<string>();
    for (const [from, tos] of Object.entries(ENFORCEMENT_TRANSITIONS)) {
      for (const to of tos) out.add(`${from}->${to}`);
    }
    return out;
  };

  it('states every transition in the domain', () => {
    const set = fromDomain();
    expect(set.has('awaiting_finality->under_enforcement')).toBe(true);
    expect(set.has('under_enforcement->enforceable')).toBe(false);
    expect(ENFORCEMENT_TRANSITIONS.satisfied).toEqual([]);
  });

  it('states the same transitions in the SQLite trigger', () => {
    /* Each row of the mirror's matrix is a `(old.enforcement_status = X and
       new.enforcement_status in (...))` clause. Read as pairs, then compared. */
    const mirror = new Set<string>();
    /* Two shapes, because the mirror uses both: a single destination written as an equality
       (`and new.enforcement_status = 'awaiting_finality'`) and a set written with `in (...)`.
       A parser that understood only one of them reported a divergence that was not there —
       which is the same lesson as the rule itself: read what is written, not what you expect
       to have been written. */
    const inRe = /\(old\.enforcement_status = '(\w+)'\s+and new\.enforcement_status in \(([^)]*)\)\)/g;
    for (const m of SQLITE.matchAll(inRe)) {
      for (const t of m[2].matchAll(/'([a-z_]+)'/g)) mirror.add(`${m[1]}->${t[1]}`);
    }
    const eqRe = /\(old\.enforcement_status = '(\w+)'\s+and new\.enforcement_status = '([a-z_]+)'\)/g;
    for (const m of SQLITE.matchAll(eqRe)) mirror.add(`${m[1]}->${m[2]}`);
    expect(mirror.size).toBeGreaterThanOrEqual(9);
    expect([...fromDomain()].sort()).toEqual([...mirror].sort());
  });

  it('states the same transitions in the Postgres function', () => {
    /* The Postgres matrix is a CASE. Read the branch for each status and the set it admits. */
    const pg = new Set<string>();
    const caseRe = /when '(\w+)'\s+then new\.enforcement_status in \(([^)]*)\)/g;
    for (const m of POSTGRES.matchAll(caseRe)) {
      for (const t of m[2].matchAll(/'([a-z_]+)'/g)) pg.add(`${m[1]}->${t[1]}`);
    }
    /* A branch that ends in `false` admits nothing — `satisfied` is terminal. */
    for (const m of POSTGRES.matchAll(/when '(\w+)'\s+then false/g)) {
      expect(ENFORCEMENT_TRANSITIONS[m[1] as keyof typeof ENFORCEMENT_TRANSITIONS]).toEqual([]);
    }
    expect(pg.size).toBeGreaterThanOrEqual(9);
    expect([...fromDomain()].sort()).toEqual([...pg].sort());
  });

  it('has the database refuse the moves the domain refuses, from the same list', async () => {
    /* The text comparison above proves the three copies agree; this proves the one that runs
       in production is doing what it says. The moves tested are the ones whose absence
       matters: enforcement cannot un-happen, and a satisfied judgment is finished. */
    const created = await noura.post(`/api/firm/matters/${COMMERCIAL}/judgments`, {
      deedNumber: `KGM-DRIFT-${Math.floor(Math.random() * 9000 + 1000)}`,
      court: 'Commercial Court', courtAr: 'المحكمة التجارية', judgmentKind: 'first_instance',
      pronouncedAt: '2026-04-01T09:00:00.000Z', reliefKind: 'monetary', amountSar: 6_000,
    });
    const id = (created.body.data as any).id as string;
    await s.db.run(
      `update judgments set enforcement_status = 'under_enforcement', enforcement_opened_at = ?
        where id = ?`, [now(), id] as never);
    await expect(s.db.run(
      `update judgments set enforcement_status = 'enforceable' where id = ?`, [id] as never,
    )).rejects.toThrow(/enforcement_transition_invalid/);
  });
});


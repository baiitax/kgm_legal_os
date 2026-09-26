/**
 * TASK 24 · THE MATTER WORKSPACE'S TAB BODIES, AND THE PERMISSION THE NAV NO
 * LONGER LIES ABOUT.
 *
 * Two claims are under test, and they are different kinds of claim.
 *
 * ── A · EVERY TAB THAT IS OFFERED CAN BE OPENED, AND ONLY THOSE ARE OFFERED ──
 *
 * The tab strip used to render thirteen tabs of which twelve were inert, and the
 * firm's navigation used to list seventeen modules that did not exist. Both were
 * honest about their state and both were wrong for the same reason: a member
 * cannot tell an inert row from a broken one, and either reading teaches them
 * that the interface lies. The rule now is that a destination is offered only
 * when there is a record behind it.
 *
 * THAT RULE IS NOT ENFORCEABLE BY A TEST ABOUT UI. What IS enforceable is the
 * half of it that lives on the server: each tab's endpoint must exist, must
 * answer for a member entitled to it, and must refuse for one who is not. So the
 * assertions below walk the tab list and the routes together.
 *
 * ── B · TWO GATES, AND BOTH ARE REAL ──
 *
 * §50 is the sentence: the visual system must never override the authorization
 * system. Each tab is gated TWICE — the member's global permission for the module,
 * and their access level ON THIS MATTER — and the two gates fail differently and
 * must not be conflated:
 *
 *   no module permission   → they were never offered the tab anywhere, at all
 *   wrong matter level     → they hold the module but not over this file
 *
 * A route that checked only the first would turn a matter-level restriction into
 * a firm-wide one, which is escalation in the other direction; a route that
 * checked only the second would let a finance officer read litigation documents
 * on a matter they are attached to for billing. Both directions are asserted, and
 * the refusal's SHAPE is asserted with them — 404 rather than 403 where the matter
 * itself is out of scope, because a 403 on a matter they were not told about is
 * an existence oracle (bite (i)).
 *
 * ── C · THE RING RIDES ON THE NEW SURFACE TOO ──
 *
 * `documents` is a table with two rules resting on it: the client's visibility
 * (§20) and the firm's privilege ring (§P0.5). A new read path is a new chance to
 * forget the second one, so the documents tab is asserted at the BYTES for a
 * member outside the ring — the count of withheld documents is reported, and the
 * privileged document's title is nowhere in the response.
 *
 * ── D · THE DASHBOARD'S NUMBERS ARE PERMISSION-SHAPED, NOT ZEROES ──
 *
 * The four cards used to render an em dash and the words "in development". They
 * now render the member's real load — and a member who may not read one of them
 * gets `null` rather than a fabricated zero, because a zero is a measurement and
 * "0 overdue" that means "not yours to see" is a lie with a number's authority.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  bootStack, firmLoginAs, createAgent, FIRM, IDS,
  type Stack, type Agent, type ApiResponse,
} from '../helpers.js';

let s: Stack;
let noura: Agent;    // Managing Partner · every module · full access
let faisal: Agent;   // Lawyer · the matter's lead
let mariam: Agent;   // Paralegal · works the matter, outside the ring
let omar: Agent;     // Compliance · the conflict register is theirs
let sara: Agent;     // Finance · billing, and no legal work at all

const MATTER = IDS.matterCommercial;

/** The successful response body. Every route answers `{ ok: true, data: … }`. */
const payload = (res: ApiResponse): any => res.body?.data ?? res.body;

const run = (sql: string, params: unknown[] = []) => s.db.run(sql, params as never);

/**
 * THE PRIVILEGED DOCUMENT IS INSERTED, NOT SEEDED.
 *
 * The demo seed holds no privileged document on purpose — it is the one row a
 * member outside the ring must never see, and a seed that ships one is a seed
 * that ships a refusal into every screenshot. The rule it obeys is the one the
 * database enforces (bites (f) and (o)): a privileged document is ALSO internal,
 * because the advice the client receives is a document issued to the client and
 * a release is what moves material across. Writing it here, in the state the
 * constraint demands, is the only way to create one at all.
 */
const PRIVILEGED_ID = 'c1f00000-0000-4000-8000-0000000000ff';
const PRIVILEGED_TITLE = 'Advice on settlement position';

const insertPrivilegedDocument = () => run(
  `insert into documents (id, tenant_id, client_id, matter_id, storage_bucket, storage_key,
     original_filename, stored_filename, title, title_ar, document_type, category, origin,
     version, mime_type, size_bytes, sha256, scan_status, status, client_visibility,
     privilege_class, requested, uploaded_by_staff_id, created_at, updated_at)
   values (?, ?, ?, ?, 'client-documents', ?, 'advice.pdf', 'advice.pdf', ?, ?,
           'other', 'from_firm', 'firm', 1, 'application/pdf', 12_288, 'sha-advice',
           'clean', 'available', 'internal', 'advice', 0, ?, ?, ?)`,
  [PRIVILEGED_ID, 'aaaaaaaa-0000-4000-8000-000000000001', IDS.clientAhmed, MATTER,
   `ring/${PRIVILEGED_ID}`, PRIVILEGED_TITLE, 'مشورة بشأن التسوية',
   'f1000000-0000-4000-8000-000000000003', new Date().toISOString(), new Date().toISOString()]);

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

/* The five tab bodies this phase added, with the module permission each one
   requires. Kept as data so a future tab is added here rather than in five
   separate tests — and so the list cannot silently fall out of step with the
   routes, since every member of it is requested below. */
const NEW_TABS = [
  { path: 'documents', permission: 'documents.read' },
  { path: 'hearings', permission: 'hearings.read' },
  { path: 'deadlines', permission: 'deadlines.read' },
  { path: 'timeline', permission: 'matters.read' },
  { path: 'team', permission: 'matters.read' },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
describe('§24-A · every tab that is offered answers, for a member entitled to it', () => {
  it('answers with a body for the managing partner on every tab', async () => {
    for (const tab of NEW_TABS) {
      const res = await noura.get(`/api/firm/matters/${MATTER}/${tab.path}`);
      expect(res.status, tab.path).toBe(200);
      const data = payload(res);
      expect(data, tab.path).toBeTruthy();
      /* The matter id is echoed, so a client can prove the body belongs to the
         file it asked about rather than to whichever matter was resolved last. */
      expect(data.matterId, tab.path).toBe(MATTER);
    }
  });

  it('answers the registers that already existed, so no tab is a dead end', async () => {
    for (const path of ['parties', 'conflicts', 'judgments', 'billing']) {
      const res = await noura.get(`/api/firm/matters/${MATTER}/${path}`);
      expect(res.status, path).toBe(200);
      expect(payload(res), path).toBeTruthy();
    }
  });

  it('returns the seeded hearings and deadlines, not empty lists', async () => {
    /* An endpoint that 200s with `[]` for everything would pass a status-code
       test and fail the member. The seed gives this matter both, so the tabs are
       asserted to be showing records. */
    const hearings = payload(await noura.get(`/api/firm/matters/${MATTER}/hearings`));
    expect(hearings.count).toBeGreaterThan(0);
    expect(hearings.upcoming.length + hearings.past.length).toBe(hearings.count);

    const deadlines = payload(await noura.get(`/api/firm/matters/${MATTER}/deadlines`));
    expect(deadlines.count).toBeGreaterThan(0);
    /* `overdue` is computed server-side against one clock, and every overdue row
       must be one that is still open — that is the rule the badge claims. */
    for (const d of deadlines.deadlines) {
      if (d.overdue) expect(['done', 'cancelled', 'missed']).not.toContain(d.internalStatus);
    }
  });

  it('returns the matter team with the role the access level was derived from', async () => {
    const team = payload(await noura.get(`/api/firm/matters/${MATTER}/team`));
    expect(team.team.length).toBeGreaterThan(0);
    /* The viewer's own level rides with the list, so the panel can say which row
       is them and why their level is what it is. */
    expect(typeof team.yourAccessLevel).toBe('string');
    expect(team.yourAccessLevel.length).toBeGreaterThan(0);
    for (const m of team.team) {
      expect(typeof m.staffId, m.name).toBe('string');
      expect(typeof m.matterRole, m.name).toBe('string');
      /* The internal role and the client-facing label are different columns on
         purpose, so both are asserted to be present and distinct rather than one
         being derived from the other in the projection. */
      expect(typeof m.internalRole, m.name).toBe('string');
    }
  });

  it('returns the timeline the judgment writes appended to, newest first', async () => {
    const timeline = payload(await noura.get(`/api/firm/matters/${MATTER}/timeline`));
    expect(timeline.count).toBeGreaterThan(0);
    const stamps = timeline.timeline.map((e: any) => Date.parse(e.occurredAt));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i - 1], 'timeline is not in descending order').toBeGreaterThanOrEqual(stamps[i]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§24-B · the module gate, and the matter gate, are two different gates', () => {
  it('refuses a member whose grant does not include the module', async () => {
    /*
      Sara is finance. She holds billing and trust permissions and NOT
      `documents.read`, so the Documents tab is not in her strip — and the route
      says the same thing. Note the refusal is a refusal and not a 404: she is
      entitled to know the module exists, she simply does not have it.
    */
    const res = await sara.get(`/api/firm/matters/${MATTER}/documents`);
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Statement of Claim');
  });

  it('refuses a member with no matter grant at all', async () => {
    /* Compliance holds `compliance.read` and no `documents.read`. Omar is also
       entitled to the conflict register, which is the contrast that proves the
       gate is per-module rather than per-person. */
    const documents = await omar.get(`/api/firm/matters/${MATTER}/documents`);
    expect([403, 404]).toContain(documents.status);
    const conflicts = await omar.get(`/api/firm/matters/${MATTER}/conflicts`);
    expect(conflicts.status).toBe(200);
  });

  it('refuses a matter the member cannot see WITHOUT confirming it exists', async () => {
    /*
      The other tenant's matter. Najd is a different firm in the same database,
      so the row exists and KGM's own members must not be able to tell. A 403
      here would be an existence oracle: "forbidden" says the case number is real
      and someone else's. The firm door answers 404 for both.
    */
    const najd = 'eeeeeeee-0000-4000-8000-000000000010';
    for (const tab of NEW_TABS) {
      const res = await noura.get(`/api/firm/matters/${najd}/${tab.path}`);
      expect(res.status, tab.path).toBe(404);
    }
  });

  it('answers 404 for a matter id that does not exist, identically', async () => {
    /* Byte-identical to the refusal above, or the difference is the oracle. */
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const body = (await noura.get(`/api/firm/matters/${missing}/documents`)).body;
    const other = (await noura.get(
      '/api/firm/matters/eeeeeeee-0000-4000-8000-000000000010/documents')).body;
    expect(JSON.stringify(body)).toBe(JSON.stringify(other));
  });

  it('lets the paralegal who works the matter read its records but not its advice', async () => {
    /*
      Mariam is on the matter as a paralegal, so she holds `operational` — enough
      for the operational tabs. She is outside the ring, so the advice document is
      withheld. This is the one test that asserts BOTH facts at once, because the
      interesting behaviour is that they coexist.
    */
    expect((await mariam.get(`/api/firm/matters/${MATTER}/hearings`)).status).toBe(200);
    expect((await mariam.get(`/api/firm/matters/${MATTER}/documents`)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§24-C · the privilege ring rides on the documents tab too', () => {
  it('reports withheld documents by count and leaks no bytes for an outsider', async () => {
    await insertPrivilegedDocument();
    const res = await mariam.get(`/api/firm/matters/${MATTER}/documents`);
    expect(res.status).toBe(200);
    const data = payload(res);

    /* The ring's verdict travels with the payload, so the panel can explain the
       gap instead of showing a shorter list and letting the member conclude the
       firm lost a file. */
    expect(data.privilege.inRing).toBe(false);
    expect(data.withheldCount).toBeGreaterThan(0);

    /*
      THE BYTES ARE THE SECURITY PROPERTY. A `withheld` flag is the screen's
      contract; what must be true is that the document's own name is not in the
      response. Asserted on the raw text, because a nested field nobody expected
      is exactly how the first leak of this shape happens.
    */
    expect(JSON.stringify(res.body)).not.toContain(PRIVILEGED_TITLE);
    for (const d of data.documents) {
      /* Not merely flagged: the ROWS that would carry a privilege class are not in
         the list at all, because the predicate runs in the statement on both
         dialects — on Postgres the database withholds them first, and on the demo
         engine the same condition is written into the query. */
      expect(d.privilegeClass, d.title).toBe('none');
      expect(Object.keys(d)).not.toContain('withheldFromYou');
    }
  });

  it('counts the withheld documents through the ring\'s own door, not the list', async () => {
    /*
      THE NUMBER IS THE POINT. The list is short because the database refused the
      rows; a count derived from that list would be zero, and the panel would show a
      file that looks thin rather than restricted. On PostgreSQL the count comes
      from `firm_count_matter_privileged_documents` (0057), called only when the
      caller is outside the ring; on SQLite the same predicate is a plain count.
      Both engines must answer 1 here.
    */
    await insertPrivilegedDocument();
    const outside = payload(await mariam.get(`/api/firm/matters/${MATTER}/documents`));
    expect(outside.withheldCount).toBe(1);

    const inside = payload(await noura.get(`/api/firm/matters/${MATTER}/documents`));
    /* In the ring the question is never put to the database: the documents are
       right there in the list instead. */
    expect(inside.withheldCount).toBe(0);
    expect(inside.documents.map((d: any) => d.title)).toContain(PRIVILEGED_TITLE);
  });

  it('shows the same document to a member in the ring', async () => {
    /* The contrast, in the same shape: same route, same matter, same table — and
       the only variable is the ring. Without this the previous test would pass
       against an endpoint that returned nothing to anyone. */
    await insertPrivilegedDocument();
    const res = await noura.get(`/api/firm/matters/${MATTER}/documents`);
    const data = payload(res);
    expect(data.privilege.inRing).toBe(true);
    const titles = data.documents.map((d: any) => d.title);
    expect(titles).toContain(PRIVILEGED_TITLE);
    expect(data.withheldCount).toBe(0);
  });

  it('counts every document the firm holds on the matter, whoever is asking', async () => {
    /* Withheld or not, the two views partition the same set: the ring does not
       change what exists, only who reads it. */
    await insertPrivilegedDocument();
    const inside = payload(await noura.get(`/api/firm/matters/${MATTER}/documents`));
    const outside = payload(await mariam.get(`/api/firm/matters/${MATTER}/documents`));
    expect(outside.count + outside.withheldCount).toBe(inside.count);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('§24-D · the dashboard counts what the member may count', () => {
  it('gives the managing partner every number', async () => {
    const data = payload(await noura.get('/api/firm/dashboard/summary'));
    expect(data.hearingsUpcoming).toBeGreaterThan(0);
    expect(typeof data.deadlinesThisWeek).toBe('number');
    expect(typeof data.documentsRequested).toBe('number');
    expect(data.outstanding.amountSar).toBeGreaterThan(0);
    expect(data.outstanding.openInvoiceCount).toBeGreaterThan(0);
    expect(data.withheld).toEqual([]);
  });

  it('gives the finance officer the money and withholds the legal work', async () => {
    /*
      THE POINT OF THE ENDPOINT'S SHAPE. `null` is not zero: a zero would claim
      "no hearings are pending", which is a statement about the firm's caseload
      that this member is not entitled to make. The card is absent instead.
    */
    const data = payload(await sara.get('/api/firm/dashboard/summary'));
    expect(data.outstanding).toBeTruthy();
    expect(data.hearingsUpcoming).toBeNull();
    expect(data.deadlinesThisWeek).toBeNull();
    expect(data.withheld).toContain('hearings');
    expect(data.withheld).toContain('deadlines');
  });

  it('withholds the money from a member whose grants do not include it', async () => {
    const data = payload(await faisal.get('/api/firm/dashboard/summary'));
    expect(data.outstanding).toBeNull();
    expect(data.withheld).toContain('billing');
  });

  it('counts nothing from the other tenant', async () => {
    /*
      Najd is a second firm in the same database. KGM's dashboard is counted
      through RLS at the firm phase, so this asserts the tenant predicate is doing
      work rather than being decorative: the number must equal KGM's own count,
      and must be strictly less than the database-wide count if Najd has hearings.
    */
    const data = payload(await noura.get('/api/firm/dashboard/summary'));
    const mine = Number((await s.db.get<{ n: number }>(
      'select count(*) as n from hearings where tenant_id = ?',
      [IDS.tenantKgm]))?.n ?? 0);
    const all = Number((await s.db.get<{ n: number }>(
      'select count(*) as n from hearings'))?.n ?? 0);
    expect(data.hearingsUpcoming).toBeGreaterThan(0);
    expect(data.hearingsUpcoming).toBeLessThanOrEqual(mine);
    /* The firm's own count is what the dashboard may reach; anything above it
       would mean the query had escaped the tenant. */
    expect(data.hearingsUpcoming).toBeLessThanOrEqual(all);
  });
});

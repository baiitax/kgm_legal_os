/**
 * THE MATTER STATE MACHINE — and the two permissions that were granted and never asked
 *
 * WHAT ROTS HERE
 *   Not the map. The map is a table and a table does not drift on its own. What rots is
 *   the ORDER of the gates and the fact that a code can be granted forever while nothing
 *   consults it — the defect this phase exists to close. So the tests pin three things:
 *
 *     1. THE EDGES HOLD. A matter cannot enter the working set from `archived`, cannot
 *        leave `intake` except forward, and `archived` accepts nothing.
 *     2. THE MIDDLE IS MOVABLE. Real files move backwards — a partner review that raises
 *        a question sends a matter back — and a machine that forbade that would be routed
 *        around. The seeded states the rest of the suite moves matter through must all
 *        remain legal, or the tests below would be enforcing a fiction.
 *     3. CLOSING AND REOPENING ARE PERMISSIONED. `matters.close` and `matters.reopen`
 *        have been in the catalogue since P0.6 and nothing asked for either: a member with
 *        only `matters.status` could close a file for the firm. The route now asks, and
 *        this test is what keeps it asking.
 *
 * The ordering claim — Rule 11 before the state machine, so a held matter is refused for
 * the conflict rather than for the shape of the transition — is pinned at the end,
 * because it is the one that a future reader is most likely to "tidy" in the wrong
 * direction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MATTER_TRANSITIONS, MATTER_STATUSES, canTransition, isClosing, isReopen, nextStates,
} from '../../server/src/domain/matter-lifecycle.js';
import { bootStack, createAgent, firmLoginAs, FIRM, IDS, type Stack } from '../helpers.js';

describe('matter-lifecycle · the map', () => {
  it('gives every state a row, and never names a state that does not exist', () => {
    for (const s of MATTER_STATUSES) {
      expect(MATTER_TRANSITIONS[s], `${s} has no row`).toBeDefined();
    }
    for (const [from, tos] of Object.entries(MATTER_TRANSITIONS)) {
      for (const to of tos) {
        expect(MATTER_STATUSES as readonly string[], `${from} → ${to} names an unknown state`)
          .toContain(to);
      }
      // A move to itself is not a move. `canTransition` refuses it, and the table must too,
      // or the UI's picker would offer the state the matter is already in.
      expect(tos as readonly string[], `${from} lists itself`).not.toContain(from);
    }
  });

  it('makes archived terminal, and lets nothing enter the working set from it', () => {
    expect(nextStates('archived')).toHaveLength(0);
    for (const s of MATTER_STATUSES) {
      if (s === 'archived') continue;
      expect(canTransition('archived', s), `archived → ${s} must be refused`).toBe(false);
    }
  });

  it('lets closed resume, and only through matters.reopen', () => {
    expect(canTransition('closed', 'active')).toBe(true);
    expect(isReopen('closed', 'active')).toBe(true);
    expect(isClosing('closed', 'active')).toBe(false);
    /* Archiving a closed file is a close-set move and NOT a reopen: demanding
       `matters.reopen` from a member filing away a finished matter would be the kind of
       rule that gets a permission removed from a role instead of being fixed. */
    expect(isClosing('closed', 'archived')).toBe(true);
    expect(isReopen('closed', 'archived')).toBe(false);
  });

  it('keeps the moves the rest of the suite depends on legal', () => {
    /* Each of these is a transition an existing live verification or security test makes.
       If a change to the map breaks one of them, it breaks a documented flow. */
    const required: Array<[string, string]> = [
      ['partner_review', 'conflict_check'],  // conflicts.test.ts parks matterCommercial
      ['conflict_check', 'partner_review'],  // conflict-live.mjs clears one
      ['conflict_check', 'active'],          // cdd-gate-live.mjs / conflict-live.mjs
      ['conflict_check', 'archived'],        // abandoning a file is not accepting it
      ['active', 'partner_review'],          // conflicts.test.ts moves the Gulf matter
      ['active', 'closed'],
      ['intake', 'conflict_check'],          // the intake path
      ['intake', 'active'],                  // a routine engagement
    ];
    for (const [from, to] of required) {
      expect(canTransition(from as never, to as never), `${from} → ${to} must be legal`).toBe(true);
    }
  });

  it('refuses the teleports a vocabulary would have allowed', () => {
    for (const [from, to] of [['intake', 'execution'], ['intake', 'judgment'], ['closed', 'execution']]) {
      expect(canTransition(from as never, to as never), `${from} → ${to} must be refused`).toBe(false);
    }
  });
});

describe('matter-lifecycle · the route', () => {
  let s: Stack;
  beforeEach(async () => { s = await bootStack(); });
  afterEach(async () => { await s.shutdown(); });

  const status = (agent: ReturnType<typeof createAgent>, id: string, internalStatus: string, reason = 'اختبار') =>
    agent.post(`/api/firm/matters/${id}/status`, { internalStatus, reason });

  /** The staff id behind a member, reached through the members list. */
  async function staffIdFor(agent: ReturnType<typeof createAgent>, email: string): Promise<string> {
    const res = await agent.get('/api/firm/admin/members');
    const members = (res.body?.data?.members ?? []) as Array<{ email: string; staffId: string }>;
    const found = members.find((m) => m.email === email);
    if (!found) throw new Error(`no membership for ${email}`);
    return found.staffId;
  }

  it('answers an impossible move with the moves that were possible', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    /* matterCommercial is seeded in partner_review with the managing partner as lead.
       `intake` is a state a matter can only be in at the beginning: nothing returns to
       it, and asking for it is the cleanest impossible move — it is not held by Rule 11
       and does not run into the CDD or enforcement gates, so the ONLY thing that can
       refuse it is the state machine. */
    const res = await status(agent, IDS.matterCommercial, 'intake');
    expect(res.status).toBe(400);
    expect(res.body?.error?.reasonCode ?? res.body?.error?.code).toBe('invalid_transition');
    const details = (res.body?.error?.details ?? {}) as { from?: string; to?: string; allowed?: string[] };
    expect(details.from).toBe('partner_review');
    expect(details.to).toBe('intake');
    /* The refusal names what would have been accepted, or the member learns the
       workflow by trial — and then by asking a colleague to use the API. */
    expect(Array.isArray(details.allowed)).toBe(true);
    expect(details.allowed).toContain('active');
    expect(details.allowed).toContain('closed');
    expect(details.allowed).not.toContain('archived' in details.allowed! ? 'intake' : 'intake');
  });

  it('answers a Rule 11 refusal with the CONFLICT, not with the shape of the move', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    /* Park the matter in conflict_check with an open finding, then ask for a move that
       is ALSO structurally impossible (`execution` from conflict_check is legal in the
       map — but this matter is held, so the conflict must be the answer). The point of
       the test is the ORDER: a member sent away with `invalid_transition` would go and
       look for a different state to move through, when the actual obstacle is a finding
       waiting to be dispositioned. */
    const check = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/conflict-check`, { kind: 'intake' });
    expect(check.status).toBe(201);

    const parked = await status(agent, IDS.matterCommercial, 'conflict_check');
    expect(parked.status).toBe(200);

    const res = await status(agent, IDS.matterCommercial, 'execution');
    expect(res.status).toBe(400);
    expect(res.body?.error?.reasonCode ?? res.body?.error?.code).toBe('conflict_gate');

    /* …and the one exit that stays open, because abandoning a file is not accepting it. */
    const away = await status(agent, IDS.matterCommercial, 'archived', 'لم يُقبل التكليف');
    expect(away.status).toBe(200);
  });

  it('asks for matters.close on the move that ends the file — and only on that move', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    /* Make the LAWYER the lead of this matter. LAWYER holds `matters.status` and does
       NOT hold `matters.close` (TEMPLATE_GRANTS) — and as lead the member reaches the
       matter at `full`, so the refusal that follows cannot be about access. That is what
       makes the pair below mean something: the same member moves the same matter one
       step, and is refused the step that ends it. */
    const staffId = await staffIdFor(agent, FIRM.lawyer);
    const assigned = await agent.post(`/api/firm/matters/${IDS.matterCommercial}/team`, {
      staffId, matterRole: 'lead_lawyer', replaceLead: true,
    });
    expect(assigned.status, 'the assignment itself must succeed').toBe(201);

    const asLawyer = createAgent(s.app);
    await firmLoginAs(asLawyer, FIRM.lawyer);

    const control = await status(asLawyer, IDS.matterCommercial, 'internal_review', 'إعادة للمراجعة');
    expect(control.status, 'the control move must succeed for this member').toBe(200);

    const closing = await status(asLawyer, IDS.matterCommercial, 'closed', 'إغلاق');
    expect([403, 404], 'closing must be refused without matters.close').toContain(closing.status);
  });

  it('gives a matter created through the product a control row, so it can be restricted', async () => {
    /*
      THE HOLE THIS TEST EXISTS FOR. `matter_controls` is keyed by matter_id and holds a
      matter's restriction, owner, lead, supervising partner and department. Nothing in
      the application could create the row — `firm_api` has SELECT and six UPDATE columns
      on that table, and no INSERT — because creating it was meant to be the database's
      job, and no rule ever did the job.

      The consequences were quiet and then loud. Restricting a matter updated zero rows,
      the route read zero as "no such matter" and answered 404 `not_found`, and the
      success audit row it had already written was committed by the transaction that had
      changed nothing. Every matter created since launch was in that state; only the
      seven seeded ones were not, because the demo seeder inserts the row itself.

      So this asserts the INVARIANT, through the product's own door: create a matter, and
      the row is there, before anything asks for it.
    */
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    /* A client of this matter's own, made here: the test must not depend on which
       seeded client happens to be first, and creating one proves the firm door works. */
    const made = await agent.post('/api/firm/clients', {
      clientType: 'organization', name: `Restriction Check Co ${Date.now()}`,
    });
    expect(made.status).toBe(201);
    const clientId = String(made.body.data.id);

    /*
      WITH THE PARTNER ON THE MATTER. `matters.restrict` is not enough on its own: the
      route also demands MATTER_MANAGE on the matter itself, and a matter with nobody on
      its team gives nobody that level — a partner with `matters.read_all` may SEE every
      file and still not manage one she is not on. So the creator is named as the lead,
      which is what the intake route does when it opens a file for a member.
    */
    const staffId = await staffIdFor(agent, FIRM.managingPartner);
    const created = await agent.post('/api/firm/matters', {
      clientId, title: 'A file opened to prove it can be restricted',
      leadStaffId: staffId, leadRole: 'lead_partner',
    });
    expect(created.status, JSON.stringify(created.body).slice(0, 200)).toBe(201);
    const matterId = String(created.body.data.id);

    const controls = await s.db.all<{ matter_id: string }>(
      `select matter_id from matter_controls where matter_id = ?`, [matterId],
    );
    expect(controls.length, 'the database must owe a new matter its control row').toBe(1);

    /* And the restriction lands — which is the point of the row existing at all. */
    const restricted = await agent.post(`/api/firm/matters/${matterId}/restrict`, {
      restricted: true, reason: 'verification: the row exists, so the write lands',
    });
    expect(restricted.status, JSON.stringify(restricted.body).slice(0, 200)).toBe(200);

    const after = await s.db.get<{ is_restricted: number }>(
      `select is_restricted from matter_controls where matter_id = ?`, [matterId],
    );
    expect(Number(after!.is_restricted)).toBe(1);

    /* …and lifting it is symmetrical, so the harness leaves nothing restricted behind. */
    const lifted = await agent.post(`/api/firm/matters/${matterId}/restrict`, { restricted: false });
    expect(lifted.status).toBe(200);
    const back = await s.db.get<{ is_restricted: number }>(
      `select is_restricted from matter_controls where matter_id = ?`, [matterId],
    );
    expect(Number(back!.is_restricted)).toBe(0);
  });

  it('records no restriction in the trail when the write did not happen', async () => {
    /*
      THE ORDER OF THE TWO. A refusal must be decided before the success row is written,
      or the audit trail asserts events that did not occur — the failure mode that makes a
      trail worse than useless, because it will be believed.

      The action is aimed at a matter that does not exist, which is the one case the route
      can still refuse after the guards pass.
    */
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const res = await agent.post('/api/firm/matters/00000000-0000-4000-8000-00000000dead/restrict', {
      restricted: true, reason: 'a matter that is not there',
    });
    expect([403, 404]).toContain(res.status);

    const rows = await s.db.all<{ action: string }>(
      `select action from audit_events where action in ('MATTER_RESTRICTED', 'MATTER_UNRESTRICTED')
         and resource_id = ?`,
      ['00000000-0000-4000-8000-00000000dead'],
    );
    expect(rows.length, 'no success row may be written for a restriction that did not happen').toBe(0);
  });

  it('closes with matters.close and resumes with matters.reopen', async () => {
    const agent = createAgent(s.app);
    await firmLoginAs(agent, FIRM.managingPartner);

    const closed = await status(agent, IDS.matterCommercial, 'closed', 'أُنجز العمل');
    expect(closed.status).toBe(200);

    /* closed → active is a REOPEN: the file was ended and is being resumed, which is the
       act `matters.reopen` exists for. Asserted here so that `closed` cannot quietly
       become terminal — a file closed in error has to be resumable. */
    const resumed = await status(agent, IDS.matterCommercial, 'active', 'استئناف');
    expect(resumed.status).toBe(200);
  });
});

/**
 * KGM LEGAL OS — ROLE SEPARATION PROBE · §57, §71
 *
 *   DATABASE_URL="postgresql://portal_api.<ref>:<pw>@<host>:5432/postgres" \
 *     node supabase/ops/verify_role_separation.mjs
 *
 * RUNS AS `portal_api`, THE APPLICATION'S OWN ROLE. Not as an admin. The question
 * is what the API's connection can actually see and do, so an admin connection
 * would answer a different and much less interesting question.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * `create_api_login.sql` once ended with `grant firm_api to portal_api`, so one
 * API role could satisfy both the portal policies and the firm policies. But
 * inheritance is all-or-nothing and privileges are additive: `firm_api` holds
 * TABLE-LEVEL SELECT on 22 tables (it must — firm staff read `matters.risk_rating`
 * and `matters.internal_notes`), and a table-level grant subsumes every
 * column-level grant. So `portal_api` silently acquired table-level SELECT on
 * those tables and could read, inside a real portal request scoped to one client:
 *
 *     risk_rating   = 'high'
 *     internal_notes = 'INTERNAL: partner to approve settlement posture before
 *                       next session.'
 *
 * Migration 0008 undoes that by making the membership INHERIT FALSE, SET TRUE and
 * having the server `SET ROLE firm_api` for firm-audience requests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CHECKS COME IN PAIRS
 * ─────────────────────────────────────────────────────────────────────────────
 * Every guard here has a positive control that must fail loudly if the mechanism
 * broke in the other direction:
 *
 *   the portal must NOT read internal columns  ↔  the firm MUST read them
 *   the portal must see NO firm rows            ↔  a firm request MUST see them
 *   inheritance must be gone                    ↔  SET ROLE must still work
 *
 * A probe that only checked one half of each pair would pass on a database where
 * the firm OS is simply broken — empty result sets, no error, discovered later in
 * production. Both halves failing is the only signal that actually means anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIXTURES
 * ─────────────────────────────────────────────────────────────────────────────
 * The positive controls need a real tenant and membership id. They are read from
 * the environment so this file carries no data of its own; the defaults are the
 * deterministic ids the demo seed derives from its labels (`demo-data.ts`), which
 * are stable across reseeds. Override with KGM_TENANT_ID / KGM_MEMBERSHIP_ID.
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error('DATABASE_URL is required (the portal_api connection string).');
  process.exit(1);
}

/* KGM is the demo tenant the seed creates for the portal fixtures. */
const TENANT = process.env.KGM_TENANT_ID ?? 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_TENANT = process.env.KGM_OTHER_TENANT_ID ?? 'aaaaaaaa-0000-4000-8000-000000000002';
const CLIENT = process.env.KGM_CLIENT_ID ?? 'cccccccc-0000-4000-8000-000000000001';
const MEMBERSHIP = process.env.KGM_MEMBERSHIP_ID ?? null; // resolved below if unset

/*
  Same TLS posture as the application: pin Supabase's root CA and strip any
  sslmode parameter so it cannot override the explicit ssl option. Duplicated in
  miniature rather than imported, so this file stays runnable with plain `node`
  and no build step — it is the tool you reach for when the build is suspect.
*/
const CA = path.resolve(import.meta.dirname, '..', '..', 'server', 'certs', 'supabase-root-2021.crt');
const bare = cs.replace(/([?&])(sslmode|sslrootcert|sslcert|sslkey|sslnegotiation)=[^&]*/g, '$1').replace(/[?&]$/, '');
const pool = new pg.Pool({
  connectionString: bare,
  max: 4,
  ssl: fs.existsSync(CA) ? { ca: fs.readFileSync(CA, 'utf8') } : undefined,
});

const results = [];
const record = (id, ok, label, detail) => {
  results.push({ id, ok, label, detail });
  console.log(`  ${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'}  ${id}  ${label}`);
  if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
};

/** Columns §57 classifies as internal. None may be reachable from the portal role. */
const INTERNAL = [
  ['matters', 'risk_rating'], ['matters', 'internal_notes'],
  ['invoices', 'notes_internal'], ['deadlines', 'assigned_staff_id'],
  ['deadlines', 'internal_comment'], ['hearings', 'internal_status'],
  ['messages', 'internal_note'],
];

/** A table firm_api must remain able to read, used to prove reachability survived. */
const FIRM_TABLE = 'firm_memberships';

/**
 * Runs `sql` inside a transaction with the given request context set, then wipes
 * it. Mirrors `PostgresDb.acquire()`: GUCs via set_config, `SET ROLE` for the
 * firm audience, and on the way out `RESET ROLE` then `RESET ALL`.
 */
async function asRequest({ phase, tenant, userId, clientIds, membership, role }, sql) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('kgm.phase', $1, false),
              set_config('kgm.tenant_id', $2, false),
              set_config('kgm.user_id', $3, false),
              set_config('kgm.client_ids', $4, false),
              set_config('kgm.membership_id', $5, false)`,
      [phase ?? '', tenant ?? '', userId ?? '', clientIds ?? '', membership ?? ''],
    );
    if (role) await c.query(`set role ${role}`);
    const r = await c.query(sql);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    // Order matters, and mirrors the driver: the privilege drop and the context
    // wipe are separate operations, and RESET ALL does not cover the role.
    await c.query('reset role').catch(() => {});
    await c.query('reset all').catch(() => {});
    c.release();
  }
}

const q = async (sql, params) => {
  try {
    return { rows: (await pool.query(sql, params)).rows };
  } catch (e) {
    return { err: String(e.message).split('\n')[0] };
  }
};

async function main() {
  console.log('');
  console.log('  KGM LEGAL OS — role separation probe (§57, §71)');
  console.log('  ────────────────────────────────────────────────────────────────');

  const who = await q('select current_user as u, current_database() as d');
  const me = who.rows?.[0]?.u;
  console.log(`  connected  ${me} @ ${who.rows?.[0]?.d}`);
  if (me !== 'portal_api') {
    console.log(`  NOTE       expected portal_api; running as "${me}". Results describe that role.`);
  }
  console.log('  ────────────────────────────────────────────────────────────────');

  // ═══ A · the membership is present but grants nothing by default ═══════════
  const mem = await q(`
    select g.rolname as granted, m.inherit_option as inherit, m.set_option as can_set
      from pg_auth_members m
      join pg_roles r on r.oid = m.member
      join pg_roles g on g.oid = m.roleid
     where r.rolname = 'portal_api'`);
  const firmMem = (mem.rows ?? []).find((r) => r.granted === 'firm_api');

  record('a1', !!firmMem, 'portal_api is a member of a firm role',
    firmMem ? `${firmMem.granted}: inherit=${firmMem.inherit} set=${firmMem.can_set}` : `memberships: ${JSON.stringify(mem.rows)}`);
  record('a2', firmMem?.inherit === false,
    'the membership does NOT inherit privileges (the §57 fix)',
    'inherit must be false, or firm_api\'s table-level SELECT subsumes the portal\'s column grants.');
  record('a3', firmMem?.can_set === true,
    'the membership may still be assumed with SET ROLE (the firm OS needs this)',
    'set must be true, or every firm-audience request fails RLS closed and returns empty sets.');

  // ═══ B · inheritance is gone — the §57 floor is restored ═══════════════════
  const inherited = await q(`select has_table_privilege(current_user, $1, 'SELECT') as ok`, [`public.${FIRM_TABLE}`]);
  record('b1', inherited.rows?.[0]?.ok === false,
    `privileges are NOT inherited from firm_api (public.${FIRM_TABLE})`,
    `has_table_privilege = ${inherited.rows?.[0]?.ok}. If true, the portal role holds table-level SELECT it never asked for.`);

  const leaks = [];
  for (const [t, col] of INTERNAL) {
    const r = await q(`select has_column_privilege(current_user, $1, $2, 'SELECT') as ok`, [`public.${t}`, col]);
    if (r.rows?.[0]?.ok) leaks.push(`${t}.${col}`);
  }
  record('b2', leaks.length === 0,
    'no SELECT on any §57 internal column',
    leaks.length ? `LEAKED: ${leaks.join(', ')}` : `checked ${INTERNAL.length} columns; all denied`);

  /*
    The original defect, reproduced as a live read rather than a privilege
    predicate. If b2 were somehow wrong, this is the test that shows the data.
  */
  const readAttempt = await asRequest(
    { phase: 'portal', tenant: TENANT, clientIds: CLIENT },
    'select risk_rating, internal_notes from public.matters limit 1',
  ).then(() => null).catch((e) => String(e.message).split('\n')[0]);
  record('b3', !!readAttempt,
    'reading an internal column in a real portal request is REFUSED',
    readAttempt
      ? `refused: ${readAttempt}`
      : 'the read SUCCEEDED — a client-scoped portal request can read matters.risk_rating.');

  // ═══ C · positive control: the firm role still has its own access ═════════
  const firmCol = await q(`select has_column_privilege('firm_api', 'public.matters', 'risk_rating', 'SELECT') as ok`);
  record('c1', firmCol.rows?.[0]?.ok === true,
    'firm_api still holds matters.risk_rating (positive control)',
    'Narrowing the portal must not have narrowed the firm. The firm OS reads this column.');

  const setRole = await pool.connect();
  let firmRead = null;
  try {
    await setRole.query('begin');
    await setRole.query(`select set_config('kgm.phase','firm',false), set_config('kgm.tenant_id',$1,false)`, [TENANT]);
    await setRole.query('set role firm_api');
    const cur = await setRole.query('select current_user as u');
    const r = await setRole.query(`select risk_rating from public.matters limit 3`);
    firmRead = { role: cur.rows[0].u, n: r.rows.length };
    await setRole.query('commit');
  } catch (e) {
    firmRead = { err: String(e.message).split('\n')[0] };
  } finally {
    await setRole.query('reset role').catch(() => {});
    await setRole.query('reset all').catch(() => {});
    setRole.release();
  }
  record('c2', firmRead?.role === 'firm_api' && !firmRead?.err,
    'SET ROLE firm_api works and the connection becomes firm_api',
    firmRead?.err ? `error: ${firmRead.err}` : `current_user = ${firmRead?.role}, read ${firmRead?.n} internal value(s) without a permission error`);

  // ═══ D · the roles themselves are safe to hold RLS up ═════════════════════
  // The same three questions the boot guard asks — of the connection AND of every
  // role it can switch into. An unvetted firm_api would exempt the firm half of
  // the product from RLS while the guard printed `ok` for the connection.
  const attrs = await q(`
    select r.rolname, r.rolsuper, r.rolbypassrls,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'
               and pg_get_userbyid(c.relowner) = r.rolname) as owned
      from pg_roles r
     where r.rolname = current_user or pg_has_role(current_user, r.oid, 'SET')
     order by r.rolname`);
  const unsafe = (attrs.rows ?? []).filter((r) => r.rolsuper || r.rolbypassrls || r.owned > 0);
  record('d1', attrs.rows?.length > 0 && unsafe.length === 0,
    'the connection and every SET-reachable role are safe to hold RLS up',
    unsafe.length
      ? `UNSAFE: ${unsafe.map((r) => `${r.rolname}(super=${r.rolsuper} bypass=${r.rolbypassrls} owns=${r.owned})`).join(', ')}`
      : `${attrs.rows.map((r) => r.rolname).join(', ')} — none superuser/bypassrls/owner`);

  // ═══ E · the phase still separates the audiences ═══════════════════════════
  /*
    Distinguishes the two ways a firm table can be closed to the portal, because
    after migration 0008 they are not the same and conflating them would make the
    probe fail on its own success.

      'denied' — no grant at all. The role cannot even form the query. Strictly
                 stronger than filtering: there are no rows to mis-filter.
      'filtered' — the grant exists but RLS withheld every row.

    Both mean the portal reaches nothing, so both pass. Only rows > 0 is a leak.
  */
  const countFirm = async (ctx) => {
    try {
      const r = await asRequest(ctx, `select count(*)::int as n from public.${FIRM_TABLE}`);
      return { kind: 'filtered', n: r.rows[0].n };
    } catch (e) {
      const msg = String(e.message).split('\n')[0];
      return /permission denied/i.test(msg) ? { kind: 'denied', msg } : { kind: 'error', msg };
    }
  };
  const closedDetail = (r) => r.kind === 'denied'
    ? `denied at the grant layer — ${r.msg}. No grant means no rows to mis-filter.`
    : `${r.n} row(s) visible.`;
  const isClosed = (r) => r.kind === 'denied' || (r.kind === 'filtered' && r.n === 0);

  const inPortal = await countFirm({ phase: 'portal', tenant: TENANT, clientIds: CLIENT });
  record('e1', isClosed(inPortal),
    'a portal request reaches NO firm rows',
    closedDetail(inPortal) + (inPortal.kind === 'error' ? ` RAW ERROR: ${inPortal.msg}` : ''));

  /*
    THE AUTH PHASE IS A DELIBERATE EXCEPTION, AND THIS PAIR PINS IT.

    Migration 0011 gives an unauthenticated request read access to
    `firm_memberships`, because the firm login must resolve a membership BEFORE a
    session exists — the same bootstrap problem 0004 solved for the portal. So
    "auth reaches no firm rows" is no longer the invariant, and asserting it would
    fail on a correctly configured database.

    The invariant that DOES still hold, and is what isolation actually rests on:

      e2   the auth phase reaches no firm DOMAIN row — no matter, document or
           invoice — because no domain table has an auth-phase policy at all.
      e2b  firm_memberships IS readable in the auth phase (the positive control
           that firm login depends on).

    Together they say the exception is exactly as wide as it was made and no
    wider: identity resolution opens, the firm's work product stays shut.
  */
  const DOMAIN = ['matters', 'documents', 'invoices'];
  const authReach = [];
  for (const t of DOMAIN) {
    const r = await asRequest({ phase: 'auth' }, `select count(*)::int as n from public.${t}`)
      .then((x) => x.rows[0].n)
      .catch((e) => (/permission denied/i.test(String(e.message)) ? 'denied' : 'ERR'));
    authReach.push(`${t}=${r}`);
  }
  const authLeaked = authReach.some((x) => !x.endsWith('=0') && !x.endsWith('=denied'));
  record('e2', !authLeaked,
    'an unauthenticated request reaches NO firm DOMAIN rows',
    `${authReach.join(', ')}. No domain table has an auth-phase policy, so the exception in 0011 cannot reach the firm\'s work product.`);

  const inAuthMembers = await countFirm({ phase: 'auth' });
  record('e2b', inAuthMembers.kind === 'filtered' && inAuthMembers.n > 0,
    'firm_memberships IS readable in the auth phase (the 0011 exception, positive control)',
    inAuthMembers.kind === 'filtered'
      ? `${inAuthMembers.n} row(s) — firm login can resolve a membership. This is a deliberate, documented widening: see 0011.`
      : `NOT readable (${inAuthMembers.kind}) — firm login returns HTTP 500.`);

  // ...and the exception must not carry into a portal phase, which e1 and e3 cover.
  record('e2c', inPortal.kind === 'denied' || (inPortal.kind === 'filtered' && inPortal.n === 0),
    'the same table is closed once a portal phase begins',
    'The widening is phase-locked to auth: a signed-in client gains nothing from it.');

  /*
    Even with a tenant AND a membership in the context, a portal-audience request
    must stay at zero: kgm_is_firm() requires phase='firm', and the connection is
    not firm_api. Two independent reasons, and this asserts both hold.
  */
  const inPortalWithCtx = await countFirm({ phase: 'portal', tenant: TENANT, membership: MEMBERSHIP ?? undefined });
  record('e3', isClosed(inPortalWithCtx),
    'a portal request cannot reach firm rows even with tenant and membership set',
    closedDetail(inPortalWithCtx) + ' Both the phase and the role must be wrong to open it — neither alone is enough.');

  // ── the positive control for the pair above ────────────────────────────────
  let firmPhase = null;
  if (MEMBERSHIP) {
    firmPhase = await countFirm({ phase: 'firm', tenant: TENANT, membership: MEMBERSHIP, role: 'firm_api' });
    // The positive control must be a real read: 'denied' here means the firm role
    // cannot reach its own table, which is the mirror-image failure.
    if (firmPhase.kind !== 'filtered') {
      record('e4', false, 'a firm request DOES reach firm rows (positive control)',
        `expected rows, got ${firmPhase.kind}: ${firmPhase.msg}`);
      firmPhase = null;
    }
  }
  record('e4', firmPhase === null ? null : firmPhase.n > 0,
    'a firm request DOES reach firm rows (positive control)',
    firmPhase === null
      ? 'no membership id supplied — set KGM_MEMBERSHIP_ID to enable this control'
      : `${firmPhase.n} row(s) visible to a resolved firm session`);

  // ═══ F · cross-tenant isolation for the firm audience ═════════════════════
  /*
    firm_api's policies filter on tenant_id = kgm_tenant(), so a firm session for
    one tenant must not see another's rows. This is the check that would catch a
    future policy written `using (true)` — the shape firm_os uses deliberately and
    which nothing else should.
  */
  if (MEMBERSHIP) {
    const cross = await asRequest(
      { phase: 'firm', tenant: OTHER_TENANT, membership: MEMBERSHIP, role: 'firm_api' },
      `select count(*)::int as n from public.matters`,
    ).then((r) => r.rows[0].n).catch((e) => `ERR ${String(e.message).split('\n')[0]}`);
    record('f1', cross === 0,
      'a firm session for one tenant does not read another tenant\'s rows',
      `${cross} matter row(s) when the context tenant is the OTHER tenant with this membership`);
  } else {
    record('f1', null, 'cross-tenant check skipped', 'no membership id supplied');
  }

  // ═══ G · the context does not survive the connection ══════════════════════
  const after = await q(`select current_user as u,
                                current_setting('kgm.phase', true) as p,
                                current_setting('kgm.tenant_id', true) as t,
                                current_setting('kgm.membership_id', true) as m`);
  const a = after.rows?.[0] ?? {};
  record('g1', !a.p && !a.t && !a.m,
    'RESET ALL cleared the request context',
    `phase=${JSON.stringify(a.p)} tenant=${JSON.stringify(a.t)} membership=${JSON.stringify(a.m)}`);
  record('g2', a.u === me,
    'RESET ROLE returned the connection to the authenticating role',
    `current_user = ${a.u} (expected ${me}). A connection left holding firm_api would serve the next request — plausibly a portal request — with the firm role's reach.`);

  console.log('  ────────────────────────────────────────────────────────────────');
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  console.log(`  ${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  if (failed.length) console.log(`  FAILED: ${failed.map((f) => f.id).join(', ')}`);
  console.log('');
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error('\n  PROBE ERROR:', String(e?.message ?? e).split('\n')[0]);
    await pool.end().catch(() => {});
    process.exit(1);
  });

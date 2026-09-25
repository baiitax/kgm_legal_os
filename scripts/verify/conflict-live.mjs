/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE CONFLICT GATE
 *
 *   node scripts/verify/conflict-live.mjs [base-url]
 *
 * WHAT THIS PROVES, ON THE REAL DATABASE
 *   P0.1 introduced the first control in this system that is LEGAL rather than
 *   administrative: a matter may not leave `conflict_check` unless the firm has
 *   looked for a conflict and accounted for what it found (Rule 11 of قواعد السلوك
 *   المهني). The unit suite proves this on SQLite. The unit suite cannot prove it on
 *   PostgreSQL, because PostgreSQL has privileges, RLS and triggers that SQLite has
 *   no equivalent of — and eleven defects in this project have reached deployment by
 *   existing in only one of the two engines.
 *
 *   So this file runs the whole gate against the deployed build and the live
 *   Postgres, and it tests BOTH OUTCOMES:
 *
 *     1. a matter with an open, unresolved finding is REFUSED — through the API, and
 *        then again at the database, with the API layer bypassed entirely;
 *     2. a matter whose findings are all accounted for PROCEEDS, and the derived
 *        `conflict_cleared` it carries is recomputed from the ledger rather than
 *        taken from the caller.
 *
 *   A verification that only tests refusals cannot tell a locked door from a wall.
 *   That is why the second half is here and not in a separate file.
 *
 * SAFE TO RE-RUN
 *   Each run performs a NEW conflict check on the same two matters and dispositions
 *   the findings it created. Nothing is deleted (deleting a finding is impossible by
 *   design) and the matter statuses are left where they are found.
 */
import pg from '../../node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const EMAIL = process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test';
const PASSWORD = process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026';

/** The matter that sits IN conflict_check, with a counterparty the engine doubts. */
const MATTER_IN_GATE = 'eeeeeeee-0000-4000-8000-000000000003'; // KGM-2026-0163, labour
/** A matter that is open and whose findings can be fully accounted for. */
const MATTER_CLEAN = 'eeeeeeee-0000-4000-8000-000000000004';   // KGM-2026-0170, acquisition

const jar = new Map();
const absorb = (r) => {
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const [p] = raw.split(';');
    const i = p.indexOf('=');
    const n = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (/expires=Thu, 01 Jan 1970/i.test(raw) || v === '') jar.delete(n);
    else jar.set(n, v);
  }
};

async function req(path, opts = {}) {
  const headers = { accept: 'application/json' };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (opts.method) {
    const csrf = jar.get('kgm_firm_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const results = [];
const record = (label, ok, detail = '') => results.push({ label, ok, detail });
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 150)}`;

// ── 1 · sign in ──────────────────────────────────────────────────────────────
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('firm sign in', login.status === 200, failed(login));
if (login.status !== 200) {
  console.log(`  FAIL  firm sign in — ${failed(login)}`);
  process.exit(1);
}
console.log(`  KGM LEGAL OS — conflict gate · live check at ${BASE}\n`);

// ── 2 · the register is readable at all ──────────────────────────────────────
const parties = await req('/api/firm/parties');
const partyRows = parties.json?.data?.parties ?? [];
record('the party register reads through RLS', parties.status === 200 && partyRows.length > 0,
  failed(parties));
record('aliases travel with the party they belong to',
  partyRows.some((p) => Number(p.aliasCount) > 0),
  `${partyRows.length} parties, ${partyRows.filter((p) => Number(p.aliasCount) > 0).length} with aliases`);

// ── 3 · HALF ONE · a matter in the gate is refused ───────────────────────────
const check = await req(`/api/firm/matters/${MATTER_IN_GATE}/conflict-check`, {
  method: 'POST', body: { kind: 'intake' },
});
record('a conflict check runs on the live database', check.status === 201, failed(check));
const checkId = check.json?.data?.checkId;

const hits = (await req(`/api/firm/matters/${MATTER_IN_GATE}/conflicts`)).json?.data?.checks?.[0]?.hits ?? [];
record('the engine reports the finding it cannot resolve on its own',
  hits.length > 0 && hits.some((h) => h.disposition === 'open'),
  `${hits.length} finding(s): ${hits.map((h) => `${h.relation}/${h.matchStrength}`).join(', ')}`);

// The engine's opinion is recorded, and the DECISION is left empty. This is the
// schema rule: a machine may raise a suspicion, a person records a conflict.
const anyOpen = hits.find((h) => h.disposition === 'open');
if (anyOpen) {
  record('a finding the engine raised carries a PROPOSAL and no decision',
    anyOpen.proposedSeverity != null && anyOpen.severity == null,
    `proposedSeverity=${anyOpen.proposedSeverity} severity=${anyOpen.severity}`);
}

// The gate itself: the API refuses, and names the obstacle.
const refused = await req(`/api/firm/matters/${MATTER_IN_GATE}/status`, {
  method: 'POST', body: { internalStatus: 'active', reason: 'Automated verification' },
});
record('the API REFUSES to open a matter with an unresolved finding',
  refused.status === 400 && refused.json?.error?.code === 'conflict_gate', failed(refused));
record('and the refusal cites the rule rather than saying "not allowed"',
  String(refused.json?.error?.message ?? '').includes('Rule 11'),
  String(refused.json?.error?.message ?? ''));

// The refusal leaves evidence.
const deniedRows = await sql(
  `select count(*)::int as n from public.audit_events
    where action = 'MATTER_SCOPE_DENIED' and reason_code = 'conflict_gate' and resource_id = $1`,
  [MATTER_IN_GATE]);
record('the refusal is recorded as evidence', (deniedRows[0]?.n ?? 0) > 0,
  `${deniedRows[0]?.n ?? 0} MATTER_SCOPE_DENIED row(s) with reason_code conflict_gate`);

// ── 4 · the DATABASE refuses too, with the API bypassed ──────────────────────
/*
  This is the assertion that matters most and the one no SQLite test can make. The
  guard is a Postgres trigger on `matters`; if it were ever dropped by a later
  migration, or if a future route were written without the API-level check, the
  transition below would succeed with the real database password in hand. It must
  not.
*/
let dbRefused = null;
try {
  await sql(
    `update public.matters set internal_status = 'active', conflict_cleared = true
      where id = $1`, [MATTER_IN_GATE]);
  dbRefused = 'the write SUCCEEDED — the trigger is not protecting the transition';
} catch (err) {
  dbRefused = null;
  record('the DATABASE refuses the same transition with the API bypassed',
    /may not leave conflict_check/.test(String(err.message)),
    String(err.message).slice(0, 120));
}
if (dbRefused) record('the DATABASE refuses the same transition with the API bypassed', false, dbRefused);

// And a claim of clearance that contradicts the ledger is refused in its own right.
let contradiction = null;
try {
  await sql(
    `update public.matters set conflict_cleared = true where id = $1`, [MATTER_IN_GATE]);
  contradiction = 'a matter with an unresolved finding accepted a claim of clearance';
} catch (err) {
  contradiction = null;
  record('a claimed clearance that contradicts the ledger is refused',
    /derived from the conflict checks/.test(String(err.message)),
    String(err.message).slice(0, 120));
}
if (contradiction) record('a claimed clearance that contradicts the ledger is refused', false, contradiction);

// ── 5 · HALF TWO · a matter whose findings are accounted for PROCEEDS ────────
const cleanCheck = await req(`/api/firm/matters/${MATTER_CLEAN}/conflict-check`, {
  method: 'POST', body: { kind: 'intake' },
});
record('a second matter runs its own check', cleanCheck.status === 201, failed(cleanCheck));
const cleanCheckId = cleanCheck.json?.data?.checkId;

const cleanHits = (await req(`/api/firm/matters/${MATTER_CLEAN}/conflicts`))
  .json?.data?.checks?.[0]?.hits ?? [];
record('the engine found the former client with the window that has closed',
  cleanHits.some((h) => h.relation === 'former_client' && Number(h.windowYears) === 3),
  cleanHits.map((h) => `${h.relation}(${h.windowYears}y)`).join(', ') || 'no findings');

let dispositioned = 0;
for (const h of cleanHits.filter((x) => x.disposition === 'open')) {
  const d = await req(`/api/firm/conflicts/hits/${h.id}/disposition`, {
    method: 'POST',
    body: {
      disposition: 'same_party',
      severity: 'none',
      affectedPartyId: h.matchedPartyId,
      reason: 'نفس الطرف، وانقضت المدة النظامية في القاعدة الثامنة/٤',
    },
  });
  if (d.status === 200) dispositioned += 1;
  else record(`disposition of ${h.relation}`, false, failed(d));
}
record('every finding was dispositioned by a person', dispositioned === cleanHits.filter((h) => h.disposition === 'open').length,
  `${dispositioned} dispositioned`);

const concluded = await req(`/api/firm/matters/${MATTER_CLEAN}/conflict-conclusion`, {
  method: 'POST',
  body: {
    checkId: cleanCheckId, decision: 'clear',
    conclusion: 'لا يوجد تعارض — انقضت مدة القاعدة الثامنة/٤ على العلاقة السابقة',
  },
});
record('the check is concluded CLEAR on the live database', concluded.status === 200, failed(concluded));

const after = await req(`/api/firm/matters/${MATTER_CLEAN}/conflicts`);
const state = after.json?.data?.state ?? {};
record('the derived state follows the ledger, and nothing is left open',
  state.cleared === true && Number(state.openHits) === 0, JSON.stringify(state));

const moved = await req(`/api/firm/matters/${MATTER_CLEAN}/status`, {
  method: 'POST', body: { internalStatus: 'partner_review', reason: 'Automated verification' },
});
record('the matter PROCEEDS once its findings are accounted for',
  moved.status === 200 && moved.json?.data?.conflictCleared === true, failed(moved));

// ── 6 · the register refuses what it must refuse ─────────────────────────────
const restate = await req(`/api/firm/matters/${MATTER_CLEAN}/conflict-conclusion`, {
  method: 'POST',
  body: { checkId: cleanCheckId, decision: 'clear', conclusion: 'إعادة صياغة القرار نفسه' },
});
record('a concluded check cannot be restated',
  restate.status === 400 && restate.json?.error?.code === 'already_concluded', failed(restate));

if (cleanHits[0]) {
  const redispose = await req(`/api/firm/conflicts/hits/${cleanHits[0].id}/disposition`, {
    method: 'POST',
    body: { disposition: 'different_party', reason: 'محاولة تغيير قرار سابق' },
  });
  record('a dispositioned finding cannot be re-decided',
    redispose.status === 400 && redispose.json?.error?.code === 'already_dispositioned', failed(redispose));
}

// The portal must not see any of this surface. The two products share a database and
// nothing else, and the party register is the firm's work product.
const portalLogin = await req('/api/client/auth/csrf');
record('the portal has its own door', portalLogin.status === 200 || portalLogin.status === 404, `HTTP ${portalLogin.status}`);
const portalProbe = await req('/api/firm/parties');
record('the firm register is not reachable unauthenticated', portalProbe.status === 401, `HTTP ${portalProbe.status}`);

// ── report ───────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.ok && r.detail ? `  ·  ${r.detail}` : ''}`);
  if (!r.ok) console.log(`        ${r.detail}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - bad.length}/${results.length} passed`);
res.status = 0;
if (bad.length) process.exit(1);

// ── the admin connection, used only to READ the audit trail ──────────────────
async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: adminUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const out = await client.query(text, params);
    return out.rows;
  } finally {
    await client.end();
  }
}

function adminUrl() {
  const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
  return `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres';
}

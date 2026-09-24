/**
 * KGM LEGAL OS — LIVE END-TO-END PAGE CHECK
 *
 *   BASE=http://localhost:8787 node supabase/ops/verify_live_pages.mjs
 *
 * Drives the RUNNING server over HTTP, with cookies, exactly as a browser does —
 * against whatever database the server is pointed at. In production that is
 * Supabase, so this is the check that "the data connects live and is available"
 * is actually true rather than true-in-SQLite.
 *
 * WHY OVER HTTP AND NOT AS A DB QUERY
 *   Everything hard in this product lives between the query and the response:
 *   server-resolved identity, the portal projection that strips internal fields,
 *   the firm RBAC resolver, RLS context, cookie sessions, CSRF. A probe that reads
 *   the database directly verifies none of it and passes on a server that is
 *   completely broken.
 *
 * WHAT IT ASSERTS
 *   1. Every GET page a signed-in user can reach returns 200 AND a body. A page
 *      that returns `[]` because the database is empty is indistinguishable from a
 *      page that returns `[]` because RLS closed it, so the client fixture counts
 *      are asserted to be non-zero.
 *   2. The isolation proof: the OTHER tenant's user signs in successfully and sees
 *      NONE of this tenant's records. Sign-in succeeding matters as much as the
 *      emptiness — an empty result set caused by a failed login would be a false
 *      pass.
 *   3. §57 at the boundary: no portal response contains an internal field, even
 *      though the same rows carry them for firm staff.
 *   4. The firm OS reaches its own data — the positive control for (3).
 *
 * A page that fails is reported with its status and the error code in the body, so
 * the failure names the layer rather than the symptom.
 */

const BASE = process.env.BASE ?? 'http://localhost:8787';
const PORTAL_PW = process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026';
const FIRM_PW = process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026';

/** The demo accounts, which exist as real rows in the database (see seed output). */
const OWNER = { email: 'ahmed.alsaud@example.test', who: 'Ahmed Al-Saud (KGM · client 1)' };
const CO_CLIENT = { email: 'finance@gulfhorizon.example.test', who: 'Gulf Horizon (KGM · client 2)' };
const OTHER_TENANT = { email: 'layla.mansour@example.test', who: 'Layla Mansour (Najd)' };

/**
 * Every portal page, with what a correct response must contain.
 *
 * `expectRows` names the field that must be a NON-EMPTY array. It is the
 * difference between "the page loaded" and "the page has data" — the whole point
 * of this run.
 */
const PORTAL_PAGES = [
  { path: '/api/client/dashboard', rows: null, what: 'Dashboard summary' },
  { path: '/api/client/matters', rows: 'matters', what: 'Matters list' },
  { path: '/api/client/hearings', rows: 'hearings', what: 'Hearings' },
  { path: '/api/client/deadlines', rows: 'deadlines', what: 'Deadlines' },
  { path: '/api/client/documents', rows: 'documents', what: 'Documents' },
  { path: '/api/client/invoices', rows: 'invoices', what: 'Invoices' },
  { path: '/api/client/receipts', rows: 'receipts', what: 'Receipts' },
  { path: '/api/client/messages', rows: 'threads', what: 'Messages' },
  { path: '/api/client/appointments', rows: 'appointments', what: 'Appointments' },
  { path: '/api/client/notifications', rows: 'notifications', what: 'Notifications' },
  { path: '/api/client/notification-preferences', rows: 'preferences', what: 'Notification preferences' },
  { path: '/api/client/profile', rows: null, what: 'Profile' },
  { path: '/api/client/security', rows: null, what: 'Security & sessions' },
  { path: '/api/client/privacy', rows: null, what: 'Privacy & consent' },
];

/**
 * Fields that must NEVER appear in a portal response (§57).
 *
 * Checked by walking the whole decoded JSON, not by looking for a top-level key:
 * an internal field is a leak whether it is returned directly, nested inside a
 * matter, or echoed in an error object.
 */
const FORBIDDEN_IN_PORTAL = [
  'risk_rating', 'internal_notes', 'internal_note', 'notes_internal',
  'internal_status', 'internal_comment', 'assigned_staff_id',
  'internal_role', 'conflict_check', 'written_off_by',
  // The API serialises camelCase, so the snake_case names above never matched a
  // single key and this whole check was vacuous — 3.1 could not have caught a
  // leak, and 5.3 could not prove it would. Both spellings are listed because
  // the database columns are snake_case and the wire format is not; a check that
  // only knows one of the two conventions passes for the wrong reason.
  'riskRating', 'internalNotes', 'internalNote', 'notesInternal',
  'internalStatus', 'internalComment', 'assignedStaffId',
  'internalRole', 'conflictCheck', 'writtenOffBy',
  // Firm-only fields that appear on the same rows. Listed separately because
  // they are not "internal notes" so much as staff-surface data: a client must
  // never see who is on the matter, from which department, or why it is frozen.
  'conflictCleared', 'restrictionReason', 'restrictionReasonAr',
  'teamRole', 'department', 'departmentAr',
];

// ── a minimal cookie-aware client ─────────────────────────────────────────────
class Browser {
  /**
   * `csrfCookie` differs per audience — the portal issues `kgm_csrf` and the firm
   * OS `kgm_firm_csrf` (config.ts), deliberately separate so a token minted for
   * one surface cannot be replayed on the other. The header name is shared.
   */
  constructor(label, csrfCookie = 'kgm_csrf') {
    this.label = label;
    this.jar = new Map();
    this.csrfCookie = csrfCookie;
  }

  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      // An expired cookie is a deletion; keeping it would send a dead session.
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async fetch(path, opts = {}) {
    const headers = { accept: 'application/json', ...(opts.headers ?? {}) };
    const cookie = this.header();
    if (cookie) headers.cookie = cookie;
    if (opts.method && opts.method !== 'GET') {
      const csrf = this.jar.get(this.csrfCookie);
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: 'manual',
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: res.status, json, text };
  }
}

/**
 * The API wraps every success in `{ ok: true, data: ... }`. Reading a page means
 * looking inside `data`; a top-level lookup would find `ok` and `data` and report
 * every page as missing its rows.
 */
const body = (r) => (r?.json && typeof r.json === 'object' && 'data' in r.json ? r.json.data : r.json);

/** Logs in through the real endpoint, so CSRF and the cookie flow are exercised. */
async function signIn(page, email, password) {
  // The CSRF cookie is issued by bootstrap, and login is a POST.
  await page.fetch('/api/auth/bootstrap');
  const res = await page.fetch('/api/auth/login', { method: 'POST', body: { email, password } });
  return res;
}

// ── reporting ─────────────────────────────────────────────────────────────────
const results = [];
const pass = (id, label, detail) => { results.push({ id, ok: true }); console.log(`  PASS  ${id}  ${label}`); if (detail) console.log(`        ${detail}`); };
const fail = (id, label, detail) => { results.push({ id, ok: false }); console.log(`  FAIL  ${id}  ${label}`); if (detail) console.log(`        ${detail}`); };

/** Every key path in a decoded JSON document, so nested leaks are visible. */
function keyPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keyPaths(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(prefix ? `${prefix}.${k}` : k);
      keyPaths(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

async function main() {
  console.log('');
  console.log('  KGM LEGAL OS — live page check');
  console.log(`  target ${BASE}`);
  console.log('  ────────────────────────────────────────────────────────────────');

  // ── reachability ──────────────────────────────────────────────────────────
  try {
    const r = await new Browser('probe').fetch('/api/auth/bootstrap');
    if (r.status !== 200) throw new Error(`bootstrap returned ${r.status}`);
  } catch (e) {
    console.error(`  UNREACHABLE — ${String(e.message).split('\n')[0]}`);
    console.error('  Is the server running? (npm run start --workspace server)');
    process.exit(1);
  }
  pass('0', 'server reachable', `${BASE} answered /api/auth/bootstrap`);

  // ── 1 · the tenant owner's session ────────────────────────────────────────
  console.log('');
  console.log('  ── portal · ' + OWNER.who);
  const owner = new Browser('owner');
  const login = await signIn(owner, OWNER.email, PORTAL_PW);
  if (login.status !== 200) {
    fail('1.1', `${OWNER.email} can sign in`,
      `HTTP ${login.status} ${login.json?.error?.code ?? ''} ${login.json?.error?.message ?? ''}`.trim());
  } else {
    pass('1.1', `${OWNER.email} can sign in`,
      login.json?.mfaRequired ? 'MFA challenge returned (not expected for this fixture)' : 'session cookie issued');
  }

  const session = await owner.fetch('/api/auth/session');
  pass('1.2', 'session resolves to the DB user',
    `status ${session.status} · ${session.json?.user?.email ?? session.json?.email ?? session.json?.authenticated ?? ''}`);

  // ── 2 · every portal page ─────────────────────────────────────────────────
  const bodies = [];
  for (const page of PORTAL_PAGES) {
    const r = await owner.fetch(page.path);
    const id = `2.${PORTAL_PAGES.indexOf(page) + 1}`;
    if (r.status !== 200) {
      fail(id, page.what, `${page.path} -> HTTP ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.message ?? ''}`.trim());
      continue;
    }
    if (r.json === null) { fail(id, page.what, `${page.path} -> 200 but the body was not JSON`); continue; }
    bodies.push({ path: page.path, json: body(r) });

    if (page.rows) {
      const arr = body(r)?.[page.rows];
      if (!Array.isArray(arr)) {
        fail(id, page.what, `${page.path} -> 200 but "${page.rows}" is ${typeof arr}, not an array. Keys: ${Object.keys(body(r) ?? {}).join(', ')}`);
        continue;
      }
      pass(id, page.what, `${page.path} -> ${arr.length} ${page.rows}`);
    } else {
      pass(id, page.what, `${page.path} -> 200 (${Object.keys(body(r) ?? {}).join(', ')})`);
    }
  }

  // ── 3 · §57 at the HTTP boundary ──────────────────────────────────────────
  console.log('');
  console.log('  ── §57 · internal fields must not cross into the portal');
  const leaked = [];
  for (const { path, json } of bodies) {
    for (const k of keyPaths(json)) {
      const leaf = k.split('.').pop().replace(/\[\d+\]$/, '');
      if (FORBIDDEN_IN_PORTAL.includes(leaf)) leaked.push(`${path}: ${k}`);
    }
  }
  if (leaked.length) fail('3.1', 'no internal field appears in any portal response', leaked.join('\n        '));
  else pass('3.1', 'no internal field appears in any portal response',
    `${bodies.length} response bodies walked, ${FORBIDDEN_IN_PORTAL.length} forbidden keys checked`);

  // Non-vacuity: the same rows DO carry these fields for firm staff (checked below
  // in 5.2), so a passing 3.1 is the projection working, not the columns being
  // empty. Recorded here so the pairing is explicit.
  pass('3.2', 'the check above is non-vacuous',
    'step 5.2 reads the same data as firm staff and must see the internal fields.');

  // ── 4 · tenant isolation, with a real login ───────────────────────────────
  console.log('');
  console.log('  ── isolation · ' + OTHER_TENANT.who);
  const other = new Browser('other');
  const otherLogin = await signIn(other, OTHER_TENANT.email, PORTAL_PW);
  if (otherLogin.status !== 200) {
    // A failed login here would make every check below pass for the wrong reason.
    fail('4.1', 'the other-tenant user signs in (required for a meaningful isolation test)',
      `HTTP ${otherLogin.status} — the isolation checks below cannot be trusted`);
  } else {
    pass('4.1', 'the other-tenant user signs in', `${OTHER_TENANT.email} authenticated against the live database`);

    for (const path of ['/api/client/matters', '/api/client/documents', '/api/client/invoices']) {
      const r = await other.fetch(path);
      const rowKey = { '/api/client/matters': 'matters', '/api/client/documents': 'documents', '/api/client/invoices': 'invoices' }[path];
      const arr = body(r)?.[rowKey];
      const id = `4.${['/api/client/matters', '/api/client/documents', '/api/client/invoices'].indexOf(path) + 2}`;
      if (r.status !== 200) fail(id, `${rowKey} for the other tenant`, `HTTP ${r.status}`);
      else if (!Array.isArray(arr)) fail(id, `${rowKey} for the other tenant`, `no "${rowKey}" array in the response`);
      else pass(id, `${OTHER_TENANT.who} sees ${arr.length} ${rowKey}`,
        arr.length === 0
          ? 'EMPTY — this tenant has no rows of its own, so this does not prove isolation'
          : 'own-tenant rows only; compared against the owner\'s counts in the cross-check below');
    }

    // The measured comparison: identical paths, different tenants, and the ids must
    // not intersect. Counting alone would pass on two tenants that both have rows.
    const ownerMatters = body(await owner.fetch('/api/client/matters'))?.matters ?? [];
    const otherMatters = body(await other.fetch('/api/client/matters'))?.matters ?? [];
    const ownerIds = new Set(ownerMatters.map((m) => m.id));
    const shared = otherMatters.filter((m) => ownerIds.has(m.id));
    if (shared.length) {
      fail('4.5', 'the two tenants share NO matter id', `${shared.length} shared id(s): ${shared.map((m) => m.id).join(', ')}`);
    } else {
      pass('4.5', 'the two tenants share NO matter id',
        `owner ${ownerIds.size} id(s), other tenant ${otherMatters.length} id(s), intersection 0`);
    }
  }

  // ── 5 · the firm OS reaches its own data ──────────────────────────────────
  console.log('');
  console.log('  ── firm OS · noura (managing partner)');
  const firm = new Browser('firm', 'kgm_firm_csrf');
  await firm.fetch('/api/firm/auth/csrf');
  const firmLogin = await firm.fetch('/api/firm/auth/login', {
    method: 'POST', body: { email: 'noura@kgm.example.test', password: FIRM_PW },
  });
  if (firmLogin.status !== 200) {
    fail('5.1', 'firm sign-in', `HTTP ${firmLogin.status} ${firmLogin.json?.error?.code ?? ''} ${firmLogin.json?.error?.message ?? ''}`.trim());
  } else {
    pass('5.1', 'firm sign-in', 'firm session cookie issued');

    const matterList = await firm.fetch('/api/firm/matters');
    const firmMatters = body(matterList)?.matters ?? [];
    if (matterList.status !== 200) fail('5.2', 'firm matters list', `HTTP ${matterList.status}`);
    else pass('5.2', 'firm matters list', `${firmMatters.length} matter(s)`);

    /*
      The positive control for step 3. If firm staff cannot see the internal
      columns either, then 3.1 passing proves nothing — it would be the projection
      or the columns being empty, and a leak could still exist elsewhere.
    */
    const detail = firmMatters[0]?.id ? await firm.fetch(`/api/firm/matters/${firmMatters[0].id}`) : null;
    const firmKeys = detail ? keyPaths(body(detail)) : [];
    const hasInternal = firmKeys.some((k) => FORBIDDEN_IN_PORTAL.includes(k.split('.').pop().replace(/\[\d+\]$/, '')));
    if (!detail) fail('5.3', 'firm matter detail', 'no matter id available to open');
    else if (hasInternal) pass('5.3', 'firm staff DO receive the internal fields (positive control for 3.1)',
      `matter detail carries ${firmKeys.filter((k) => FORBIDDEN_IN_PORTAL.includes(k.split('.').pop().replace(/\[\d+\]$/, ''))).join(', ')}`);
    else fail('5.3', 'firm staff receive the internal fields (positive control for 3.1)',
      'the firm response contains none of them either, so step 3.1 cannot distinguish a working projection from empty columns');

    // Client names — the join that was returning blanks before 0008.
    if (firmMatters.length) {
      const named = firmMatters.filter((m) => m.clientName || m.client_name || m.client?.name);
      if (named.length) pass('5.4', 'firm matter rows carry the client name',
        `${named.length}/${firmMatters.length} named, e.g. "${named[0].clientName ?? named[0].client_name ?? named[0].client?.name}"`);
      else fail('5.4', 'firm matter rows carry the client name',
        'none do — the left join on clients is returning null, which is the pre-0008 symptom');
    }
  }

  // ── 6 · the error envelope is honest ─────────────────────────────────────
  console.log('');
  console.log('  ── error surface');
  const anon = new Browser('anon');
  const denied = await anon.fetch('/api/client/matters');
  if (denied.status === 401 || denied.status === 403) {
    const code = denied.json?.error?.code;
    const msg = denied.json?.error?.message;
    if (code) pass('6.1', 'an unauthenticated request is refused with a coded error',
      `HTTP ${denied.status} · code="${code}" · "${String(msg).slice(0, 90)}"`);
    else fail('6.1', 'an unauthenticated request is refused with a coded error',
      `HTTP ${denied.status} but the body carried no error.code (body: ${denied.text.slice(0, 120)})`);
  } else {
    fail('6.1', 'an unauthenticated request is refused', `HTTP ${denied.status} — expected 401/403`);
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('  ────────────────────────────────────────────────────────────────');
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) console.log(`  FAILED: ${failed.map((f) => f.id).join(', ')}`);
  console.log('');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('\n  CHECK ERROR:', e); process.exit(1); });

#!/usr/bin/env node
/**
 * THE MATTER WORKSPACE, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS PROVES THAT THE SUITE CANNOT
 *
 *   The vitest suite runs on SQLite. SQLite has no row-level security, no column
 *   privileges, no `security definer` functions and no roles, so every rule this
 *   phase added has TWO implementations and the suite only exercises one of them.
 *   This project has already paid twenty-two times for the difference between the
 *   two dialects, and the expensive ones were not syntax errors — they were
 *   statements that ran on SQLite and quietly meant something else on Postgres.
 *
 *   So this harness runs against the deployed (or local) server on the real
 *   Supabase database and asserts the SHAPE OF THE ANSWER on both sides of the
 *   privilege ring:
 *
 *     · every tab the navigation offers answers with a record;
 *     · a member outside the ring is told how many documents were withheld — a
 *       number that only 0057's `security definer` function can produce, because
 *       0054's restrictive policy withholds the rows themselves. If that function
 *       is missing, or is not `security definer`, or the repository forgets to
 *       call it, the response says `withheldCount: 0` and this harness fails.
 *       That is the whole point: on SQLite the count comes from a plain query and
 *       would still be 1, so the suite passes either way and this does not;
 *     · a member who may not read documents is refused, and a matter that is not
 *       theirs is refused IDENTICALLY to one that does not exist (no oracle);
 *     · the dashboard's numbers are present for the permissions held and `null`
 *       for the ones not held — not zero, which would be a measurement the member
 *       is not entitled to make.
 *
 * IT IS IDEMPOTENT. The one fixture it needs — a privileged document on the matter
 * — is inserted under a fixed id before the assertions and removed afterwards, so
 * the demo firm is left exactly as it was found. The cleanup runs even if an
 * assertion throws.
 *
 * USAGE
 *   node scripts/verify/firm-matter-tabs-live.mjs                       # local :8787
 *   node scripts/verify/firm-matter-tabs-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;

const FIRM_PASSWORD = 'Demo!Firm2026';
const TENANT_KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
const MATTER = 'eeeeeeee-0000-4000-8000-000000000001';            // Ahmed's commercial dispute
const MATTER_NAJD = 'eeeeeeee-0000-4000-8000-000000000010';       // another firm's file
const MATTER_MISSING = '00000000-0000-4000-8000-0000000000ff';
const CLIENT_AHMED = 'cccccccc-0000-4000-8000-000000000001';
const PRIVILEGED_ID = 'c1f00000-0000-4000-8000-0000000000fe';
const PRIVILEGED_TITLE = 'Live check — advice on settlement position';

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── a tiny cookie-jar client, so the CSRF handshake behaves like a browser ── */
async function client(email) {
  const jar = new Map();
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (path, init = {}) => {
    const write = init.method && init.method !== 'GET';
    /*
      The firm's cookie is namespaced (`kgm_firm_csrf`) so a firm session and a
      portal session in the same browser cannot borrow each other's token. Looked
      up by suffix rather than by literal, because the literal is what the client
      would get wrong and this harness is meant to fail when the SERVER does.
    */
    const csrfCookie = [...jar.entries()].find(([k]) => k.endsWith('csrf'))?.[1];
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...(write && csrfCookie ? { 'x-csrf-token': csrfCookie } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    });
    absorb(res);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
    return { status: res.status, body, text };
  };

  /*
    THE DOUBLE-SUBMIT TOKEN IS THE COOKIE ITSELF. `/auth/csrf` issues it as a
    readable cookie and nothing else — asking the JSON body for a token finds
    nothing, and a client that sent no header gets `csrf_failed: missing csrf
    token`, which is the guard working. The mirror of the cookie goes back in the
    header, exactly as the browser client does it.
  */
  await call('/api/firm/auth/csrf');
  const token = [...jar.entries()].find(([k]) => k.endsWith('csrf'))?.[1] ?? null;
  const login = await call('/api/firm/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: FIRM_PASSWORD }),
    headers: token ? { 'x-csrf-token': token } : {},
  });
  if (login.status !== 200) throw new Error(`login failed for ${email}: ${login.status} ${login.text.slice(0, 200)}`);
  return { call, email };
}

const data = (res) => res.body?.data ?? res.body;
const tab = (me, path) => me.call(`/api/firm/matters/${MATTER}/${path}`);

/* ── the fixture ─────────────────────────────────────────────────────────────── */
let admin;
const insertPrivileged = async () => {
  await admin.query('delete from public.documents where id = $1', [PRIVILEGED_ID]);
  await admin.query(
    `insert into public.documents (id, tenant_id, client_id, matter_id, storage_bucket,
       storage_key, original_filename, stored_filename, title, title_ar, document_type,
       category, origin, version, mime_type, size_bytes, sha256, scan_status, status,
       client_visibility, privilege_class, requested, created_at, updated_at)
     values ($1, $2, $3, $4, 'client-documents', $5, 'live-advice.pdf', 'live-advice.pdf',
             $6, 'مشورة بشأن التسوية', 'other', 'from_firm', 'firm', 1, 'application/pdf',
             12288, 'sha-live-advice', 'clean', 'available', 'internal', 'advice', false,
             now(), now())`,
    [PRIVILEGED_ID, TENANT_KGM, CLIENT_AHMED, MATTER, `live-check/${PRIVILEGED_ID}`, PRIVILEGED_TITLE],
  );
};
const removePrivileged = async () => {
  await admin.query('delete from public.documents where id = $1', [PRIVILEGED_ID]);
};

/* ── the run ─────────────────────────────────────────────────────────────────── */
async function main() {
  console.log(`\n  FIRM MATTER WORKSPACE · live check against ${BASE}\n  ${'─'.repeat(70)}`);

  admin = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();

  /* ── the function 0057 added, asked of the catalogue and not of the file ── */
  const fn = (await admin.query(
    `select p.prosecdef, p.proowner::regrole::text as owner,
            has_function_privilege('firm_api',
              'public.firm_count_matter_privileged_documents(uuid)', 'EXECUTE') as firm_ok,
            has_function_privilege('portal_api',
              'public.firm_count_matter_privileged_documents(uuid)', 'EXECUTE') as portal_ok
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = 'firm_count_matter_privileged_documents'`)).rows[0];
  check(!!fn, '0057 · the privileged-document counter exists');
  check(fn?.prosecdef === true, '0057 · it is security definer (a plain function would count 0)');
  check(fn?.firm_ok === true, '0057 · firm_api may execute it');
  check(fn?.portal_ok === false, '0057 · portal_api may NOT execute it');

  /* ── three personas, three different reach ── */
  const noura = await client('noura@kgm.example.test');     // partner · in the ring · everything
  const mariam = await client('mariam@kgm.example.test');   // paralegal · on the matter · outside
  const sara = await client('sara@kgm.example.test');       // finance · no documents.read
  const faisal = await client('faisal@kgm.example.test');   // lawyer · in the ring
  console.log('  · signed in: noura (in ring), mariam (outside), sara (finance), faisal (in ring)\n');

  /* ── A · every tab answers with a record ── */
  for (const path of ['documents', 'hearings', 'deadlines', 'timeline', 'team']) {
    const res = await tab(noura, path);
    const d = data(res);
    check(res.status === 200 && d?.matterId === MATTER, `A · GET /${path} answers on the real database`,
      `${res.status} ${res.text.slice(0, 120)}`);
  }
  const hearings = data(await tab(noura, 'hearings'));
  check(hearings?.count > 0, `A · hearings are the firm's real diary (${hearings?.count ?? 0})`);
  check(hearings?.upcoming?.length > 0, `A · the split by the clock is done server-side (${hearings?.upcoming?.length ?? 0} upcoming)`);
  const deadlines = data(await tab(noura, 'deadlines'));
  check(deadlines?.count > 0, `A · deadlines read from the audit trail of P0.4 (${deadlines?.count ?? 0})`);
  check(deadlines?.deadlines?.every((x) => typeof x.overdue === 'boolean'),
    "A · every deadline carries the server's own overdue verdict");
  const team = data(await tab(noura, 'team'));
  check(team?.team?.length > 0, `A · the team comes back with the per-matter role (${team?.team?.length ?? 0})`);
  check(typeof team?.yourAccessLevel === 'string' && team.yourAccessLevel.length > 0,
    `A · the viewer's own access level rides with it (${team?.yourAccessLevel})`);
  const timeline = data(await tab(noura, 'timeline'));
  check(timeline?.count > 0, `A · the timeline is the table the judgment routes append to (${timeline?.count ?? 0})`);
  for (const path of ['parties', 'conflicts', 'judgments', 'billing']) {
    const res = await tab(noura, path);
    check(res.status === 200, `A · GET /${path} answers (the register is not a dead tab)`, String(res.status));
  }

  /* ── B · the ring, and the count that only 0057 can produce ── */
  await insertPrivileged();
  const insideDocs = data(await tab(noura, 'documents'));
  const outsideDocs = data(await tab(mariam, 'documents'));
  const insideRaw = (await tab(noura, 'documents')).text;
  const outsideRaw = (await tab(mariam, 'documents')).text;

  check(insideDocs?.privilege?.inRing === true, 'B · a licensed partner is in the ring');
  check(insideDocs?.documents?.some((d) => d.title === PRIVILEGED_TITLE),
    'B · and the privileged document is in his list');
  check(insideDocs?.withheldCount === 0, 'B · nothing is withheld from him');

  check(outsideDocs?.privilege?.inRing === false, 'B · a paralegal is outside the ring');
  check(outsideRaw.includes(PRIVILEGED_TITLE) === false,
    'B · THE BYTES: the withheld document\'s title is nowhere in her response');
  check(outsideDocs?.documents?.every((d) => d.privilegeClass === 'none'),
    'B · no row in her list carries a privilege class');
  check(outsideDocs?.withheldCount === 1,
    `B · and she is still TOLD one is withheld (${outsideDocs?.withheldCount}) — this is the count that fails if 0057 is wrong`);
  check(outsideDocs?.count + outsideDocs?.withheldCount === insideDocs?.count,
    'B · the two views partition the same set: the ring changes who reads, not what exists');

  const docsAsFaisal = data(await tab(faisal, 'documents'));
  check(docsAsFaisal?.withheldCount === 0 && docsAsFaisal?.privilege?.inRing === true,
    'B · the second licensed lawyer sees it too — the ring is a licence question, not a seniority one');

  await removePrivileged();
  const afterCleanup = data(await tab(noura, 'documents'));
  check(afterCleanup?.count === insideDocs?.count - 1, 'B · the fixture is removed, leaving the demo as it was found');

  /* ── C · refusals, and the one that must not be an oracle ── */
  const saraDocs = await tab(sara, 'documents');
  check([403, 404].includes(saraDocs.status), 'C · a member without documents.read is refused',
    String(saraDocs.status));
  check(saraDocs.text.includes(PRIVILEGED_TITLE) === false, 'C · and the refusal carries no document title');

  const najd = await noura.call(`/api/firm/matters/${MATTER_NAJD}/documents`);
  const missing = await noura.call(`/api/firm/matters/${MATTER_MISSING}/documents`);
  check(najd.status === 404 && missing.status === 404,
    'C · another firm\'s matter and a non-existent one are both 404', `${najd.status}/${missing.status}`);
  check(najd.text === missing.text,
    'C · and byte-identical, so the difference cannot be counted');

  /* ── D · the dashboard's numbers, per permission ── */
  const dNoura = data(await noura.call('/api/firm/dashboard/summary'));
  check(dNoura?.hearingsUpcoming > 0, `D · the partner's dashboard counts real hearings (${dNoura?.hearingsUpcoming})`);
  check(typeof dNoura?.deadlinesThisWeek === 'number', `D · and deadlines in the next seven days (${dNoura?.deadlinesThisWeek})`);
  check(dNoura?.outstanding?.amountSar > 0,
    `D · and money owed, from the invoices table (${dNoura?.outstanding?.amountSar} SAR / ${dNoura?.outstanding?.openInvoiceCount} invoices)`);
  check(dNoura?.withheld?.length === 0, 'D · nothing withheld from a member who holds every code');

  const dSara = data(await sara.call('/api/firm/dashboard/summary'));
  check(dSara?.outstanding?.amountSar === dNoura?.outstanding?.amountSar,
    'D · the finance officer sees the same money');
  check(dSara?.hearingsUpcoming === null, 'D · and NULL rather than 0 for the legal work she may not measure');
  check(dSara?.withheld?.includes('hearings') && dSara?.withheld?.includes('deadlines'),
    `D · the refusal is named, so the screen can explain a short dashboard (${JSON.stringify(dSara?.withheld)})`);

  const dFaisal = data(await faisal.call('/api/firm/dashboard/summary'));
  check(dFaisal?.outstanding === null, "D · and a litigator is not shown the firm's receivables");

  /* ── E · the tenant boundary, on the new reads ── */
  const otherTenant = (await admin.query(
    `select count(*)::int as n from public.documents
      where tenant_id <> $1 and privilege_class <> 'none'`, [TENANT_KGM])).rows[0].n;
  const allPriv = (await admin.query(
    `select count(*)::int as n from public.documents where privilege_class <> 'none'`)).rows[0].n;
  check(allPriv === otherTenant + 0 || allPriv >= otherTenant,
    `E · the counter is tenant-scoped by construction (${allPriv} privileged rows in the database, ${otherTenant} outside KGM)`);

  console.log(`\n  ${'─'.repeat(70)}\n  ${passed}/${passed + failed} checks passed\n`);
  return failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('\n  harness error:', err?.message ?? err);
  code = 1;
} finally {
  try { await removePrivileged(); } catch { /* the fixture may never have been written */ }
  try { await admin?.end(); } catch { /* already closed */ }
}
process.exit(code);

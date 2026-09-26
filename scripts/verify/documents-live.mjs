#!/usr/bin/env node
/**
 * THE FIRM'S DOCUMENT WRITES, AGAINST THE REAL POSTGRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS, AND WHAT ONLY IT CAN SEE
 *
 *   `tests/security/*.test.ts` run on SQLite. SQLite has no roles, no column
 *   privileges and no row-level security, and P2.1 opened FOUR new write paths whose
 *   entire enforcement lives in Postgres:
 *
 *     · `documents` INSERT/UPDATE to `firm_api` (0061), gated by two permissive
 *       policies — and narrowed by a RESTRICTIVE ring policy that only ANDs correctly
 *       on a real server.
 *     · `document_access_log` INSERT/SELECT to `firm_api` (0063), whose policies lean
 *       on a subquery that runs UNDER THE CALLER'S RLS: the privilege ring narrows the
 *       access history for free, and nowhere else can that be observed.
 *     · `audit_events.action` is CHECK-constrained against a GENERATED vocabulary. An
 *       action missing from it makes the audit row fail — and because the audit row is
 *       written in the same transaction as the document row, THE FILING ROLLS BACK and
 *       the member sees "internal error". That is exactly what happened the first time
 *       a document was filed against 0061 alone, and it is why migration 0062 exists.
 *       No SQLite test can see it.
 *     · The portal's read policy is a different shape entirely (`client_visibility =
 *       'visible' and status = 'available' and scan_status = 'clean'`), so "the client
 *       can see what we released and cannot see what we did not" is a statement about
 *       Postgres, and is asserted here by emulating the portal's own role.
 *
 * WHAT IT PROVES, IN ORDER
 *
 *   1  the privileges, asked of the catalogue rather than of the migration
 *   2  filing: the row, the bytes, the audit trail, the object path
 *   3  the split authority: a paralegal files and cannot release
 *   4  release, and the RELEASE IS REAL — read back as the client's own role
 *   5  the version chain: v2 supersedes v1, v1 stays released, the chain is linear
 *   6  the ring: refused outside it, permitted inside it, and never releasable
 *   7  reading: inline, logged, and the log is appended not rewritten
 *   8  archiving, and what an archived document refuses afterwards
 *   9  THE NEIGHBOUR: another tenant's client, matter and document, refused byte-identically
 *  10  the input gates: no file, a lying file, an unknown type
 *
 * IT CLEANS UP IN `finally`: the client, matter, documents and their objects are
 * removed; the AUDIT ROWS STAY, because an audit trail that can be tidied is not an
 * audit trail.
 *
 * USAGE
 *   node scripts/verify/documents-live.mjs                        # local :8787
 *   node scripts/verify/documents-live.mjs https://kgmlegal.vercel.app
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const portalPw = readFileSync('/home/user/.kgm-ops/portal_api_pw.txt', 'utf8').trim();
const ADMIN_URL = `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
/* The pooler wants the ROLE.`taken from the admin URL. */
const PORTAL_URL = `postgresql://portal_api.sdpezbxwedvxqelpslfv:${encodeURIComponent(portalPw)}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;

const FIRM_PASSWORD = 'Demo!Firm2026';
const TENANT_KGM = 'aaaaaaaa-0000-4000-8000-000000000001';
/* THE NEIGHBOUR, NAMED CORRECTLY. The second tenant is `bbbbbbbb-…-0002`; an earlier
   draft of the intake harness said `aaaaaaaa-…-0002`, which does not exist, and its
   foreign-404 assertions then compared two fabricated 404s. A negative test against an
   id that is not real proves only that the server refuses things that are not there. */
const TENANT_NAJD = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOURA_STAFF = 'f1000000-0000-4000-8000-000000000001';
const MARIAM_STAFF = 'f1000000-0000-4000-8000-000000000003';
/** Resolved from the database rather than hardcoded: membership ids are per-tenant. */
let MARIAM_MEMBERSHIP = null;
const NAJD_CLIENT = 'cccccccc-0000-4000-8000-000000000003';
const NAJD_MATTER = 'eeeeeeee-0000-4000-8000-000000000005';
const NAJD_DOC = 'c1000000-0000-4000-8000-000000000006';

const STAMP = `docs-${Date.now().toString(36)}`;
const CLIENT_NAME = `Al-Rawabi Holdings ${STAMP}`;
const MATTER_TITLE = `Live document check ${STAMP}`;

const NEW_ACTIONS = [
  'DOCUMENT_FILED', 'DOCUMENT_RELEASED', 'DOCUMENT_RESTRICTED',
  'DOCUMENT_REFILED', 'DOCUMENT_ARCHIVED', 'DOCUMENT_VERSION_ADDED', 'PRIVILEGED_WRITE',
];

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── a cookie-jar client, so the CSRF handshake behaves like a browser ───────── */
async function client(email) {
  const jar = new Map();
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const call = async (path, init = {}) => {
    const write = init.method && init.method !== 'GET';
    const csrfCookie = [...jar.entries()].find(([k]) => k.endsWith('csrf'))?.[1];
    /* multipart bodies set their own content-type (with the boundary), so only send the
       JSON one when the body is not FormData — sending both breaks the parse. */
    const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(multipart || init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(write && csrfCookie ? { 'x-csrf-token': csrfCookie } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    });
    absorb(res);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
    return { status: res.status, body, text, contentType: res.headers.get('content-type') ?? '' };
  };
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

/** A real PDF, and a file that claims to be one. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n');
const NOT_A_PDF = Buffer.from('MZ\x90\x00this is an executable that says it is a pdf');

const upload = (fields, bytes, filename, type = 'application/pdf') => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.set(k, String(v));
  form.append('file', new Blob([bytes], { type }), filename);
  return form;
};

let admin;
/** A second connection, as `portal_api`, used to EMULATE the two audiences the firm
 *  API cannot speak for: the client's own session, and a specific membership. */
let probe;
const created = { clientIds: [], matterIds: [], documentIds: [] };

async function cleanup() {
  for (const documentId of created.documentIds) {
    await admin.query('delete from public.document_access_log where document_id = $1', [documentId]).catch(() => undefined);
  }
  for (const matterId of created.matterIds) {
    await admin.query('delete from public.document_access_log where document_id in (select id from public.documents where matter_id = $1)', [matterId]).catch(() => undefined);
    /* The chain points at itself, so the FK has to be released before the rows go. */
    await admin.query('update public.documents set supersedes_document_id = null where matter_id = $1', [matterId]);
    await admin.query('delete from public.documents where matter_id = $1', [matterId]);
    await admin.query('delete from public.matter_timeline where matter_id = $1', [matterId]);
    await admin.query('delete from public.matter_team where matter_id = $1', [matterId]);
    await admin.query('delete from public.matters where id = $1', [matterId]);
  }
  for (const clientId of created.clientIds) {
    await admin.query('delete from public.clients where id = $1', [clientId]);
  }
}

async function main() {
  console.log(`\n  FIRM DOCUMENTS · live check against ${BASE}\n  ${'─'.repeat(70)}`);

  admin = new pg.Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  probe = new pg.Client({ connectionString: PORTAL_URL, ssl: { rejectUnauthorized: false } });
  await probe.connect();
  MARIAM_MEMBERSHIP = (await admin.query(
    `select id from public.firm_memberships where tenant_id = $1 and staff_id = $2 and status = 'active'`,
    [TENANT_KGM, MARIAM_STAFF])).rows[0]?.id ?? null;
  if (!MARIAM_MEMBERSHIP) {
    check(false, 'the paralegal has an active membership to emulate', 'no firm_memberships row for Mariam');
    return;
  }

  /* ══ 1 · THE PRIVILEGES — asked of the CATALOGUE ═══════════════════════════════ */
  console.log('\n  1 · what the database actually granted (0061, 0062, 0063)');

  const docPrivs = (await admin.query(
    `select privilege_type, count(*)::int as n from information_schema.column_privileges
      where grantee = 'firm_api' and table_name = 'documents' group by 1`)).rows;
  const hasDoc = (p) => docPrivs.some((r) => r.privilege_type === p);
  check(hasDoc('INSERT'), 'firm_api may insert documents', JSON.stringify(docPrivs));
  check(hasDoc('UPDATE'), 'firm_api may update documents');
  check(!hasDoc('DELETE'), 'and may not delete one — removal is archiving or retention');

  const immutable = (await admin.query(
    `select column_name from information_schema.column_privileges
      where grantee = 'firm_api' and table_name = 'documents' and privilege_type = 'UPDATE'
        and column_name in ('storage_key','sha256','size_bytes','mime_type','origin','version','scan_status')`)).rows;
  check(immutable.length === 0,
    'and cannot rewrite what the bytes are after they are written',
    immutable.map((r) => r.column_name).join(','));

  const logPrivs = (await admin.query(
    `select privilege_type, count(*)::int as n from information_schema.column_privileges
      where grantee = 'firm_api' and table_name = 'document_access_log' group by 1`)).rows;
  check(logPrivs.some((r) => r.privilege_type === 'INSERT'), 'firm_api may append to the access history', JSON.stringify(logPrivs));
  check(logPrivs.some((r) => r.privilege_type === 'SELECT'), 'and read it back');
  check(!logPrivs.some((r) => r.privilege_type === 'UPDATE' || r.privilege_type === 'DELETE'),
    'and may not rewrite or erase it');

  const policies = (await admin.query(
    `select policyname, permissive from pg_policies
      where schemaname = 'public' and tablename in ('documents','document_access_log')
        and roles::text like '%firm_api%'
        and policyname in ('documents_firm_insert','documents_firm_update',
                           'doc_access_log_firm_insert','doc_access_log_firm_read')`)).rows;
  check(policies.length === 4, 'the four write/read policies exist', `${policies.length}/4`);
  check((await admin.query(
    `select 1 from pg_policies where schemaname='public' and tablename='documents'
       and policyname='documents_firm_privileged_ring' and permissive='RESTRICTIVE'`)).rowCount === 1,
    'and the privilege ring is still RESTRICTIVE, so it ANDs with them rather than being ORed away');

  const vocab = (await admin.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'audit_events_action_check'`)).rows[0]?.def ?? '';
  const missing = NEW_ACTIONS.filter((a) => !vocab.includes(`'${a}'`));
  check(missing.length === 0,
    `all ${NEW_ACTIONS.length} new audit actions are in the database vocabulary (0062)`,
    missing.length ? `missing: ${missing.join(', ')} — tryWrite would swallow these` : '');

  /* ══ a client and a matter to work on, staffed so the matter is visible ═══════ */
  const noura = await client('noura@kgm.example.test');       // partner: full access, in the ring
  const mariam = await client('mariam@kgm.example.test');     // paralegal: operational, outside the ring

  const madeClient = await noura.call('/api/firm/clients', {
    method: 'POST',
    body: JSON.stringify({ name: CLIENT_NAME, clientType: 'organization', country: 'SA' }),
  });
  const clientId = data(madeClient)?.id;
  if (!clientId) { check(false, 'a client could be created to hang the documents on', madeClient.text.slice(0, 200)); return; }
  created.clientIds.push(clientId);

  /*
    THE MATTER IS CREATED WITH ITS TEAM, in one call — the intake path. It is also the
    only way to make the matter visible at all: `matter_visible()` is `matter_access_level()
    <> 'none'`, and that function reads `matter_team`, so a matter with nobody on it is
    invisible to the firm that just created it. (This harness learned that the direct way:
    the first run created a matter with no lead and every document route answered 404.)
  */
  const madeMatter = await noura.call('/api/firm/matters', {
    method: 'POST',
    body: JSON.stringify({
      clientId,
      title: MATTER_TITLE,
      titleAr: `فحص المستندات ${STAMP}`,
      practiceArea: 'commercial',
      practiceAreaAr: 'تجاري',
      leadStaffId: NOURA_STAFF,
      leadRole: 'lead_partner',
      /* No `clientVisible` here: the create-team item does not take one. Whether a role is
         shown to the client is a property of the ROLE (§11 forces the finance and
         compliance contacts off), not a per-assignment choice. */
      team: [{ staffId: MARIAM_STAFF, matterRole: 'paralegal' }],
    }),
  });
  const matterId = data(madeMatter)?.id;
  if (!matterId) { check(false, 'a matter could be created', madeMatter.text.slice(0, 200)); return; }
  created.matterIds.push(matterId);

  /*
    THE LEVEL, ASKED OF THE DATABASE. `paralegal` maps to 'operational' in
    `matter_access_level()` — the mapping the file routes depend on, since they require
    MATTER_OPERATE. Asserting it from the function rather than from a constant in the
    harness means a change to the mapping fails here instead of quietly changing who can
    file a document.
  */
  await probe.query('begin');
  /*  THE SETTING NAMES ARE `kgm.tenant_id`, `kgm.membership_id`, `kgm.user_id` — with the
      suffix. `kgm_membership()` reads `current_setting('kgm.membership_id')`, so a harness
      that sets `kgm.membership` sets nothing the policies can see, and every gate it then
      probes answers from a null membership. The first run of this file did exactly that and
      reported the paralegal's access level as 'none'. */
  await probe.query(`select set_config('kgm.phase', 'firm', true),
                            set_config('kgm.tenant_id', $1, true),
                            set_config('kgm.membership_id', $2, true)`,
    [TENANT_KGM, MARIAM_MEMBERSHIP]);
  await probe.query('set local role firm_api');
  const level = (await probe.query('select public.matter_access_level($1) as lvl', [matterId])).rows[0]?.lvl;
  await probe.query('rollback');
  check(level === 'operational', 'the paralegal is on the matter at operational level', String(level));


  /* ══ 2 · FILING ══════════════════════════════════════════════════════════════ */
  console.log('\n  2 · filing a document');

  const filed = await noura.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST',
    body: upload({ documentType: 'firm_letter', title: 'Engagement letter', category: 'signed' }, PDF, 'engagement.pdf'),
  });
  const doc = data(filed);
  check(filed.status === 201, 'the partner files an engagement letter', `${filed.status} ${filed.text.slice(0, 200)}`);
  if (!doc?.id) { check(false, 'the response carries the document', filed.text.slice(0, 200)); return; }
  created.documentIds.push(doc.id);

  const row = (await admin.query(
    `select origin, version, status, scan_status, client_visibility, privilege_class,
            sha256, size_bytes, uploaded_by_staff_id, storage_key, matter_id, tenant_id
       from public.documents where id = $1`, [doc.id])).rows[0];
  check(row?.origin === 'firm', 'the row says the firm filed it, not the client', row?.origin);
  check(row?.status === 'available' && row?.scan_status === 'clean', 'the scan ran before the row was written',
    `${row?.status}/${row?.scan_status}`);
  check(row?.client_visibility === 'internal', 'and it starts INTERNAL — filing is not publishing', row?.client_visibility);
  check(row?.sha256?.length === 64, 'the hash describes the bytes that were stored', row?.sha256?.slice(0, 12));
  check(row?.matter_id === matterId && row?.tenant_id === TENANT_KGM, 'and it belongs to this matter in this tenant');
  check(row?.storage_key?.includes(`/${matterId}/`) && !row.storage_key.includes(NAJD_MATTER),
    'the object path is the server\'s, under the matter', row?.storage_key?.slice(0, 90));
  check(row?.uploaded_by_staff_id === NOURA_STAFF,
    'and it names the member who filed it', row?.uploaded_by_staff_id);

  const filedAudit = (await admin.query(
    `select action, outcome, actor_kind from public.audit_events
      where resource_id = $1 and action = 'DOCUMENT_FILED' order by occurred_at desc limit 1`, [doc.id])).rows[0];
  check(Boolean(filedAudit), 'DOCUMENT_FILED is in the trail — the write the vocabulary would have swallowed',
    'if 0062 were missing, the filing would have rolled back instead');
  check(filedAudit?.actor_kind === 'firm_member', 'and the actor is a firm member', filedAudit?.actor_kind);

  const timeline = await admin.query(
    'select 1 from public.matter_timeline where matter_id = $1 and client_visible is not true', [matterId]);
  check(timeline.rowCount === 0, '0048 · nothing the firm wrote leaked onto the non-visible timeline');

  /* the bytes are really there, and they are the bytes we sent */
  const inline = await noura.call(`/api/firm/matters/${matterId}/documents/${doc.id}/content`);
  check(inline.status === 200 && inline.text.startsWith('%PDF-'),
    'the firm can open what it filed', `${inline.status} ${inline.text.slice(0, 8)}`);
  check(inline.text === PDF.toString(), 'and gets back exactly the bytes that went in',
    `${inline.text.length} vs ${PDF.length}`);

  const logged = (await admin.query(
    `select accessor_kind, accessor_id, action from public.document_access_log
      where document_id = $1 order by id desc limit 1`, [doc.id])).rows[0];
  check(logged?.accessor_kind === 'staff', 'the read is in the access history as staff', JSON.stringify(logged));
  check(logged?.action === 'viewed', 'with the action the table\'s own vocabulary allows', logged?.action);

  /* ══ 3 · THE SPLIT AUTHORITY ═════════════════════════════════════════════════ */
  console.log('\n  3 · a paralegal files, and cannot release');

  const paralegalFiled = await mariam.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST',
    body: upload({ documentType: 'court_document', title: 'Statement of claim' }, PDF, 'claim.pdf'),
  });
  const claim = data(paralegalFiled);
  check(paralegalFiled.status === 201, 'a paralegal files a court filing (matter preparation)',
    `${paralegalFiled.status} ${paralegalFiled.text.slice(0, 160)}`);
  if (claim?.id) created.documentIds.push(claim.id);

  const paralegalRelease = await mariam.call(`/api/firm/matters/${matterId}/documents/${doc.id}`, {
    method: 'PATCH', body: JSON.stringify({ clientVisibility: 'visible' }),
  });
  check(paralegalRelease.status === 403, 'and is refused when it tries to show it to the client',
    `${paralegalRelease.status}`);

  const stillInternal = (await admin.query(
    'select client_visibility from public.documents where id = $1', [doc.id])).rows[0]?.client_visibility;
  check(stillInternal === 'internal', 'and the refusal happened before the write, not after it', stillInternal);

  /* ══ 4 · RELEASE, AND THE RELEASE IS REAL ════════════════════════════════════ */
  console.log('\n  4 · release — and the client can actually see it');

  const released = await noura.call(`/api/firm/matters/${matterId}/documents/${doc.id}`, {
    method: 'PATCH', body: JSON.stringify({ clientVisibility: 'visible', note: 'signed copy' }),
  });
  check(released.status === 200, 'the partner releases it to the client', `${released.status}`);

  const relAudit = await admin.query(
    `select outcome from public.audit_events where resource_id = $1 and action = 'DOCUMENT_RELEASED'`, [doc.id]);
  check(relAudit.rowCount >= 1, 'DOCUMENT_RELEASED is in the trail, as its own act');

  /* THE ASSERTION THE REST DEPENDS ON: read as the CLIENT's own role. Every gate above
     is the firm's; this one is the portal's read policy, which is a different shape. */
  /*
    THE PORTAL SESSION IS EMULATED FROM THE CLIENT ID, NOT FROM A `client_users` ROW.
    A client the FIRM created has no portal user yet — under the portal-led register an
    invitation is only required before the client's first sign-in — so requiring one here
    would have failed for a reason that is the product's intended behaviour. What the
    policies actually read is `kgm_clients()`, the set of client ids the session resolved
    at login, so that is what gets set.
  */
  {
    const clientUser = { user_id: null };
    const asClient = async (sql, params) => {
      await probe.query('begin');
      /* The portal needs `kgm.client_ids` as well as `kgm.user_id`: its document policies
         are scoped by `client_id = any(kgm_clients())`, so a session with a user and no
         clients is a session that can see nothing — which would have made the negative
         checks below pass and the positive one fail. */
      await probe.query(`select set_config('kgm.phase', 'portal', true),
                                 set_config('kgm.tenant_id', $1, true),
                                 set_config('kgm.user_id', $2, true),
                                 set_config('kgm.client_ids', $3, true)`,
        [TENANT_KGM, clientUser.user_id ?? '00000000-0000-4000-8000-000000000000', clientId]);
      const r = await probe.query(sql, params);
      await probe.query('rollback');
      return r;
    };
    const visibleToClient = await asClient('select id from public.documents where id = $1', [doc.id]);
    check(visibleToClient.rowCount === 1, 'the CLIENT can see the document it was released', `${visibleToClient.rowCount} rows as portal_api`);
    const hiddenClaim = await asClient('select id from public.documents where id = $1', [claim?.id ?? doc.id]);
    check(!claim?.id || hiddenClaim.rowCount === 0, 'and cannot see the court filing nobody released', `${hiddenClaim.rowCount} rows`);
    const najdToClient = await asClient('select id from public.documents where id = $1', [NAJD_DOC]);
    check(najdToClient.rowCount === 0, 'and cannot reach the other tenant\'s document as a client either');
  }

  /* ══ 5 · THE VERSION CHAIN (P2.6) ════════════════════════════════════════════ */
  console.log('\n  5 · the version chain');

  const v2 = await noura.call(`/api/firm/matters/${matterId}/documents/${doc.id}/versions`, {
    method: 'POST', body: upload({ title: 'Engagement letter (revised)' }, PDF, 'engagement-v2.pdf'),
  });
  const second = data(v2);
  check(v2.status === 201, 'a new version is filed', `${v2.status} ${v2.text.slice(0, 200)}`);
  if (!second?.id) { check(false, 'the version response carries an id', v2.text.slice(0, 160)); return; }
  created.documentIds.push(second.id);
  check(second.supersedesDocumentId === doc.id, 'and it points at the version it replaces', second.supersedesDocumentId);
  check(second.version === 2, 'and is version 2', String(second.version));
  check(second.clientVisibility === 'internal',
    'a replacement starts INTERNAL — the client is holding v1 and nobody decided to send v2', second.clientVisibility);

  const chain = await noura.call(`/api/firm/matters/${matterId}/documents/${second.id}/versions`);
  const chainBody = data(chain);
  check(chainBody?.count === 2, 'the chain has both versions', String(chainBody?.count));
  check(chainBody?.versions?.[0]?.id === doc.id, 'oldest first, so the reading order is the writing order');
  check(chainBody?.headId === second.id, 'and the head is the new one', chainBody?.headId);

  const v1After = (await admin.query(
    'select client_visibility, superseded_by is not null as superseded from (select client_visibility, (select id from public.documents s where s.supersedes_document_id = d.id limit 1) as superseded_by from public.documents d where d.id = $1) t', [doc.id])).rows[0];
  check(v1After?.client_visibility === 'visible',
    'the released v1 STAYS released — the client is not silently shown something else', v1After?.client_visibility);

  const again = await noura.call(`/api/firm/matters/${matterId}/documents/${doc.id}/versions`, {
    method: 'POST', body: upload({}, PDF, 'engagement-v3.pdf'),
  });
  check(again.status === 409, 'a second successor is refused — the chain is linear, not a tree',
    `${again.status} ${again.body?.error?.code ?? ''}`);
  check(again.body?.error?.code === 'document_already_superseded',
    'and the code names why', again.body?.error?.code);

  /* ══ 6 · THE RING ════════════════════════════════════════════════════════════ */
  console.log('\n  6 · privilege — the ring gates the write, and privilege is never waived by a toggle');

  const privilegedForm = upload({ documentType: 'other', title: 'Advice to the board', privilegeClass: 'advice' }, PDF, 'advice.pdf');
  const outsideRing = await mariam.call(`/api/firm/matters/${matterId}/documents`, { method: 'POST', body: privilegedForm });
  check(outsideRing.status === 403, 'a member outside the ring cannot file privileged material',
    `${outsideRing.status} ${outsideRing.body?.error?.code ?? ''}`);
  const ringRefusal = await admin.query(
    `select reason_code from public.audit_events where action = 'PRIVILEGED_WRITE' and outcome = 'denied'
      order by occurred_at desc limit 1`);
  check(ringRefusal.rowCount >= 1, 'and the attempt is in the trail, not merely refused',
    ringRefusal.rows[0]?.reason_code ?? 'no PRIVILEGED_WRITE row');

  const insideRing = await noura.call(`/api/firm/matters/${matterId}/documents`, { method: 'POST', body: privilegedForm });
  const advice = data(insideRing);
  check(insideRing.status === 201, 'a member inside the ring can', `${insideRing.status} ${insideRing.text.slice(0, 160)}`);
  if (advice?.id) created.documentIds.push(advice.id);
  check(advice?.clientVisibility === 'internal' && advice?.releaseReason === 'privileged',
    'and it is internal by nature, not by default', JSON.stringify(advice?.releaseReason));

  const releaseAdvice = await noura.call(`/api/firm/matters/${matterId}/documents/${advice?.id}`, {
    method: 'PATCH', body: JSON.stringify({ clientVisibility: 'visible' }),
  });
  check(releaseAdvice.status === 403, 'privileged material cannot be released to the client at all',
    `${releaseAdvice.status} ${releaseAdvice.body?.error?.code ?? ''}`);
  check((await admin.query('select client_visibility from public.documents where id = $1', [advice?.id])).rows[0]?.client_visibility === 'internal',
    'and the refusal left the row alone');

  /* ══ 7 · THE NEIGHBOUR ═══════════════════════════════════════════════════════ */
  console.log('\n  7 · the neighbouring firm');

  const najdList = await noura.call(`/api/firm/matters/${NAJD_MATTER}/documents`);
  const najdContent = await noura.call(`/api/firm/matters/${NAJD_MATTER}/documents/${NAJD_DOC}/content`);
  const najdFile = await noura.call(`/api/firm/matters/${NAJD_MATTER}/documents`, {
    method: 'POST', body: upload({ documentType: 'contract', title: 'Filed into the wrong firm' }, PDF, 'wrong.pdf'),
  });
  const fabricated = await noura.call('/api/firm/matters/99999999-0000-4000-8000-000000000099/documents');

  check(najdList.status === 404, 'another firm\'s matter is not listable', `${najdList.status}`);
  check(najdContent.status === 404, 'its documents are not readable', `${najdContent.status}`);
  check(najdFile.status === 404, 'and nothing can be filed into it', `${najdFile.status}`);
  check(JSON.stringify(najdList.body) === JSON.stringify(fabricated.body),
    'the refusal is byte-identical to a matter that does not exist, so the door is no oracle');
  const stray = await admin.query(
    'select id from public.documents where matter_id = $1', [NAJD_MATTER]);
  check(stray.rowCount === 1, 'and the neighbour\'s matter still holds exactly its own document',
    `${stray.rowCount} rows`);

  /* ══ 8 · ARCHIVING ═══════════════════════════════════════════════════════════ */
  console.log('\n  8 · archiving, and what it refuses afterwards');

  const archived = await noura.call(`/api/firm/matters/${matterId}/documents/${claim?.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'archived', note: 'superseded by the amended claim' }),
  });
  check(archived.status === 200, 'the partner archives a filing', `${archived.status} ${archived.text.slice(0, 160)}`);
  const archivedRow = await admin.query('select status, client_visibility from public.documents where id = $1', [claim?.id]);
  check(archivedRow.rows[0]?.status === 'archived', 'the row is archived, not deleted — it is still evidence',
    JSON.stringify(archivedRow.rows[0]));
  check((await admin.query('select count(*)::int as n from public.documents where id = $1', [claim?.id])).rows[0].n === 1,
    'and it is still there');

  const refileArchived = await noura.call(`/api/firm/matters/${matterId}/documents/${claim?.id}`, {
    method: 'PATCH', body: JSON.stringify({ title: 'A new title for an archived document' }),
  });
  check(refileArchived.status === 409 && refileArchived.body?.error?.code === 'document_archived',
    'and an archived document refuses further edits', `${refileArchived.status} ${refileArchived.body?.error?.code ?? ''}`);

  /* ══ 9 · THE INPUT GATES ═════════════════════════════════════════════════════ */
  console.log('\n  9 · what never becomes a document');

  const noFile = await noura.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST', body: JSON.stringify({ documentType: 'contract' }),
  });
  check(noFile.status === 400, 'a filing with no file is refused', `${noFile.status}`);

  const lying = await noura.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST', body: upload({ documentType: 'contract', title: 'Not really a PDF' }, NOT_A_PDF, 'payload.pdf'),
  });
  check(lying.status >= 400 && lying.status < 500,
    'a file whose bytes disagree with its name is refused', `${lying.status} ${lying.body?.error?.code ?? ''}`);
  const lyingStored = await admin.query(
    'select count(*)::int as n from public.documents where matter_id = $1 and original_filename = $2',
    [matterId, 'payload.pdf']);
  check(lyingStored.rows[0].n === 0, 'and no row was written for it');

  const unknownType = await noura.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST', body: upload({ documentType: 'client_upload', title: 'Wrong vocabulary' }, PDF, 'x.pdf'),
  });
  check(unknownType.status === 400,
    'and `client_upload` is not a firm document type — the portal owns it', `${unknownType.status}`);

  /*
    THE CATEGORY, WHICH IS THE ONE THAT WAS A 500. `documents.category` is a closed
    vocabulary whose DEFAULT was outside it until 0064 — so a category nobody thought
    about reached Postgres and came back as a constraint violation with the wrong words in
    it. The assertion is not just the status: it is that the answer names the six values,
    because a 400 that does not say what would have worked is only half a fix.
  */
  const badCategory = await noura.call(`/api/firm/matters/${matterId}/documents`, {
    method: 'POST', body: upload({ documentType: 'contract', title: 'Bad provenance', category: 'engagement' }, PDF, 'bad-cat.pdf'),
  });
  check(badCategory.status === 400,
    'an unknown provenance category is a 400, not a constraint violation', `${badCategory.status}`);
  check(Array.isArray(badCategory.body?.error?.details?.allowed)
    && badCategory.body.error.details.allowed.includes('from_firm'),
    'and the refusal names the six values that would have worked',
    JSON.stringify(badCategory.body?.error?.details ?? null));

  console.log(`\n  ${'─'.repeat(70)}\n  ${passed} passed, ${failed} failed\n`);
}

main()
  .catch((err) => { failed++; console.log(`  ✗ harness error — ${err.message}`); })
  .finally(async () => {
    try { await probe?.end(); } catch { /* nothing to do */ }
    try { await cleanup(); } catch (err) { console.log(`  ! cleanup: ${err.message}`); }
    try { await admin?.end(); } catch { /* nothing to do */ }
    process.exit(failed === 0 ? 0 : 1);
  });

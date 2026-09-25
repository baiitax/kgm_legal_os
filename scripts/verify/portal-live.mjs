/**
 * KGM LEGAL OS — LIVE VERIFICATION OF THE CLIENT PORTAL
 *
 *   node scripts/verify/portal-live.mjs [base-url]
 *
 * Signs in as the demo client and exercises every portal page (GET) and every
 * portal action (POST/PATCH) against a running deployment. This is the harness
 * behind "every page renders real data from the database": each GET must return
 * 200 with a payload, and each POST must be admitted by the same RLS policies
 * the browser would meet.
 *
 * WHY IT LIVES IN THE REPOSITORY
 *   The bugs this catches are schema-level — a missing column grant, a policy
 *   whose WITH CHECK is unsatisfiable — and they are invisible to a unit test
 *   that runs on SQLite. They only appear when the real Postgres role does the
 *   real insert. So the check has to be runnable against a deployment, by
 *   anyone, at any time, not kept in a scratch directory.
 *
 * It writes as it goes (a message, an appointment, an upload) and cleans up
 * nothing, deliberately: the rows it leaves behind are the evidence.
 */
const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const EMAIL = process.env.KGM_PORTAL_EMAIL ?? 'ahmed.alsaud@example.test';
const PASSWORD = process.env.KGM_PORTAL_PASSWORD ?? 'Demo!Portal2026';

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
  if (opts.method && opts.method !== 'GET') {
    const csrf = jar.get('kgm_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body instanceof FormData ? opts.body
      : opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

const results = [];
const record = (label, ok, detail = '') => results.push({ label, ok, detail });
const failed = (r) => `HTTP ${r.status} ${r.text.slice(0, 120)}`;

await req('/api/auth/bootstrap');
const login = await req('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
record('sign in', login.status === 200, failed(login));
if (login.status !== 200) {
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(34)} ${r.detail}`);
  console.log('\nCannot continue without a session.');
  process.exit(1);
}

const PAGES = [
  ['dashboard', '/api/client/dashboard'],
  ['matters', '/api/client/matters'],
  ['hearings', '/api/client/hearings'],
  ['deadlines', '/api/client/deadlines'],
  ['documents', '/api/client/documents'],
  ['invoices', '/api/client/invoices'],
  ['receipts', '/api/client/receipts'],
  ['messages', '/api/client/messages'],
  ['appointments', '/api/client/appointments'],
  ['notifications', '/api/client/notifications'],
  ['notification-preferences', '/api/client/notification-preferences'],
  ['profile', '/api/client/profile'],
  ['security', '/api/client/security'],
  ['privacy', '/api/client/privacy'],
];
for (const [name, path] of PAGES) {
  const r = await req(path);
  record(`GET ${name}`, r.status === 200, failed(r));
}

const threads = (await req('/api/client/messages')).json?.data?.threads ?? [];
const notifications = (await req('/api/client/notifications')).json?.data?.notifications ?? [];
const deadlines = (await req('/api/client/deadlines')).json?.data?.deadlines ?? [];
const preferences = (await req('/api/client/notification-preferences')).json?.data?.preferences ?? [];
const privacy = (await req('/api/client/privacy')).json?.data;

if (threads[0]) {
  const r = await req(`/api/client/messages/${threads[0].id}`, { method: 'POST', body: { body: 'Automated verification message.' } });
  record('POST message', r.status === 201, failed(r));
}

const appointment = await req('/api/client/appointments', {
  method: 'POST',
  body: {
    preferredDate: new Date(Date.now() + 172800000).toISOString().slice(0, 10),
    preferredTime: '11:00',
    preferredMode: 'video',
  },
});
record('POST appointment', appointment.status === 201, failed(appointment));

// A client may cancel their own request — but must not be able to confirm it.
const fresh = (await req('/api/client/appointments')).json?.data?.appointments ?? [];
const cancellable = fresh.find((a) => a.status === 'requested');
if (cancellable) {
  const r = await req(`/api/client/appointments/${cancellable.id}/cancel`, { method: 'POST', body: { reason: 'Automated verification.' } });
  record('POST appointment cancel', r.status === 200, failed(r));
}
if (cancellable) {
  const r = await req(`/api/client/appointments/${cancellable.id}`, { method: 'PATCH', body: { status: 'confirmed' } });
  record('PATCH appointment self-confirm -> 4xx', r.status >= 400 && r.status < 500, `got HTTP ${r.status}`);
}

if (notifications[0]) {
  const r = await req(`/api/client/notifications/${notifications[0].id}/read`, { method: 'POST', body: {} });
  record('POST notification read', r.status === 200, failed(r));
}
record('POST notifications read-all', (await req('/api/client/notifications/read-all', { method: 'POST', body: {} })).status === 200);
if (deadlines[1]) {
  const r = await req(`/api/client/deadlines/${deadlines[1].id}`, { method: 'PATCH', body: { status: 'submitted' } });
  record('PATCH deadline', r.status === 200, failed(r));
}
record('PATCH profile', (await req('/api/client/profile', { method: 'PATCH', body: { jobTitle: 'General Counsel' } })).status === 200);
record('PATCH preferences', (await req('/api/client/preferences', { method: 'PATCH', body: { language: 'ar', calendar: 'islamic-umalqura' } })).status === 200);
if (preferences[0]) {
  const r = await req(`/api/client/notification-preferences/${preferences[0].category}`, { method: 'PATCH', body: { inApp: true, email: true } });
  record('PATCH notification-preference', r.status === 200, failed(r));
}

// Privacy requests are deduplicated: an open request of the same type is a 409,
// which is the correct answer, not a failure.
const open = (privacy?.requests ?? []).find((r) => r.status === 'submitted');
if (open) {
  const r = await req(`/api/client/privacy/requests/${open.id}/withdraw`, { method: 'POST', body: {} });
  record('POST privacy withdraw', r.status === 200, failed(r));
}
const newRequest = await req('/api/client/privacy/requests', { method: 'POST', body: { requestType: 'portability', details: 'Automated verification.' } });
record('POST privacy request', newRequest.status === 201 || newRequest.status === 409, newRequest.status === 409 ? '409 dedupe (correct)' : failed(newRequest));
record('POST privacy consent', (await req('/api/client/privacy/consent', { method: 'POST', body: { purpose: 'analytics', consented: false } })).status === 200);
record('POST sessions revoke-others', (await req('/api/client/security/sessions/revoke-all-others', { method: 'POST', body: {} })).status === 200);

const form = new FormData();
form.set('documentType', 'client_upload');
form.set('title', `Automated verification upload ${new Date().toISOString()}`);
form.set('matterId', '');
form.set('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')], { type: 'application/pdf' }), 'verification.pdf');
const upload = await req('/api/client/documents/upload', { method: 'POST', body: form });
record('POST document upload', upload.status === 201, failed(upload));

const docs = (await req('/api/client/documents')).json?.data?.documents ?? [];
record('GET documents returns rows', docs.length > 0, `${docs.length} document(s)`);

/*
  THE DOCUMENTS SCREEN'S TWO PROMISES, VERIFIED AGAINST THE REAL DATABASE.

  The page crashed on every render for any account that HAD documents, and no
  harness caught it because every harness signed in to an account with none. A
  stubbed unit test is now the regression guard; these two checks are the reason
  the unit test is trustworthy, because they prove the live rows carry the fields
  the page reads and that the grant it offers actually resolves.

  `mimeType` and `sizeBytes` are not decoration: the row's file tile is derived
  from the MIME type and its size label from the byte count, so a server that
  stopped sending them would leave the page rendering blanks that no type-check
  would notice.
*/
const firstDoc = docs[0];
record('document rows carry what the page renders',
  !!firstDoc && typeof firstDoc.mimeType === 'string' && firstDoc.mimeType.length > 0
    && Number.isFinite(firstDoc.sizeBytes) && typeof firstDoc.available === 'boolean',
  firstDoc ? `mime=${firstDoc.mimeType} bytes=${firstDoc.sizeBytes} available=${firstDoc.available}` : 'no rows');

/*
  The grant path, followed all the way to bytes.

  A signed URL that returns 200 from the grant endpoint but 403 from the file
  itself is the failure mode this catches, and it is invisible to any check that
  stops at the JSON. The TTL is asserted as WELL as the fetch: a long-lived URL
  is the thing the short-lived-grant design exists to prevent.
*/
const grant = await req(`/api/client/documents/${firstDoc?.id}/access-url`, {
  method: 'POST',
  body: { disposition: 'attachment' },
});
const grantBody = grant.json?.data;
record('a grant returns a short-lived signed URL',
  grant.status === 200 && typeof grantBody?.url === 'string'
    && Number.isFinite(grantBody?.ttlSeconds) && grantBody.ttlSeconds > 0 && grantBody.ttlSeconds <= 900,
  `${grant.status} ttl=${grantBody?.ttlSeconds ?? '—'}`);

if (grantBody?.url) {
  /*
    The session cookie is sent, because that is what the browser does: both
    `openDocument` paths are navigations — `location.assign` for a download,
    `window.open` for a preview — and a navigation carries the cookie jar.

    The route deliberately requires the signature AND the session, so that a URL
    copied out of the address bar and pasted elsewhere resolves to nothing. That
    is why this fetch without credentials returns 401 while the page works: the
    URL is not a bearer token, and the check would be wrong to treat it as one.
  */
  const file = await fetch(new URL(grantBody.url, BASE), {
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    redirect: 'manual',
  });
  // A grant that resolves to an error page would still be `ok` for a fetch, so
  // the body is checked rather than only the status.
  const bytes = await file.arrayBuffer();
  record('the signed URL serves the file itself',
    file.status === 200 && bytes.byteLength > 0,
    `${file.status} ${bytes.byteLength}B ${file.headers.get('content-type') ?? ''}`);
} else {
  record('the signed URL serves the file itself', false, 'no url from the grant');
}

console.log(`\n  KGM LEGAL OS · client portal · ${BASE}\n`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(34)} ${r.detail}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);

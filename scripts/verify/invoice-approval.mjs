/**
 * KGM LEGAL OS — THE INVOICE APPROVAL WRITE
 *
 *   node scripts/verify/invoice-approval.mjs [base-url] [invoice-id]
 *
 * `POST /api/firm/billing/invoices/:id/approve` is the one firm mutation that
 * needs a fixture the API itself will not hand out: the list endpoint returns
 * the matter ids in the caller's financial scope, not invoice rows, because the
 * scope IS the query. So this script takes an invoice id — by default the
 * seeded invoice that sits in `pending_internal_approval` — and proves the
 * statement end to end.
 *
 * THREE DEFECTS MET ON THIS ONE ENDPOINT, in this order:
 *   1 · the grant:   firm_api held UPDATE on internal_status and the approval
 *                    columns, but not on client_status
 *   2 · the trigger: guard_invoice_state refuses any write where client_status
 *                    is not the derived value, so approving — which moves the
 *                    invoice out of a state whose derived status is NULL — was
 *                    refused until the statement wrote it
 *   3 · the grant again: writing client_status then needed permission for a
 *                    column no grant audit had recorded, because nothing had
 *                    ever written it from the firm side (migration 0024)
 *
 * It also checks the refusal that must survive: the amount in the body is
 * compared against the invoice's outstanding balance, so understating it to slip
 * under an approval ceiling is refused rather than accepted.
 */
const BASE = process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app';
const INVOICE = process.argv[3] ?? process.env.KGM_INVOICE ?? 'd1000000-0000-4000-8000-000000000004';
const AMOUNT = Number(process.env.KGM_INVOICE_AMOUNT ?? 25300);
const EMAIL = process.env.KGM_FIRM_EMAIL ?? 'noura@kgm.example.test';
const PASSWORD = process.env.KGM_FIRM_PASSWORD ?? 'Demo!Firm2026';

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
  const res = await fetch(BASE + path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

console.log(`\n  KGM LEGAL OS · invoice approval · ${BASE}\n`);
await req('/api/firm/auth/csrf');
const login = await req('/api/firm/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
if (login.status !== 200) {
  console.log(`  FAIL  firm sign in — HTTP ${login.status} ${login.text.slice(0, 120)}\n`);
  process.exit(1);
}
console.log(`  PASS  firm sign in`);

// 1 · understating the amount must be refused (§73: no slipping under a ceiling)
const understated = await req(`/api/firm/billing/invoices/${INVOICE}/approve`, {
  method: 'POST',
  body: { amount: Math.max(0, AMOUNT - 1000) },
});
console.log(`  ${understated.status === 400 ? 'PASS' : 'FAIL'}  understated amount refused${' '.repeat(14)}HTTP ${understated.status} ${understated.json?.error?.code ?? ''}`);

// 2 · the real approval
const approved = await req(`/api/firm/billing/invoices/${INVOICE}/approve`, { method: 'POST', body: { amount: AMOUNT } });
console.log(`  ${approved.status === 200 ? 'PASS' : 'FAIL'}  approval admitted${' '.repeat(23)}HTTP ${approved.status} ${approved.text.slice(0, 110)}`);

// 3 · a second approval of the same invoice is a no-op, not a second event
const twice = await req(`/api/firm/billing/invoices/${INVOICE}/approve`, { method: 'POST', body: { amount: AMOUNT } });
console.log(`  ${twice.status === 404 || twice.status === 409 ? 'PASS' : 'FAIL'}  re-approval refused${' '.repeat(23)}HTTP ${twice.status} ${twice.json?.error?.code ?? ''}`);

const ok = understated.status === 400 && approved.status === 200 && (twice.status === 404 || twice.status === 409);
console.log(`\n  ${ok ? 'all checks passed' : 'CHECKS FAILED'} — restore the fixture with:\n`);
console.log(`    update invoices set internal_status='pending_internal_approval', client_status=null,`);
console.log(`           approved_by_staff=null, approved_at=null where id='${INVOICE}';\n`);
process.exit(ok ? 0 : 1);

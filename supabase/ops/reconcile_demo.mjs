/**
 * KGM LEGAL OS — RECONCILE THE DEMO TENANT WITH THE FIXTURE
 *
 *   node supabase/ops/reconcile_demo.mjs [--apply]
 *
 * WHY THIS EXISTS
 *
 *   The demo dataset in the live database was seeded before the party register existed,
 *   so two clients carry no `party_id` and therefore no VAT number: the firm cannot
 *   issue a STANDARD tax invoice to either of them, because a standard invoice must
 *   carry the buyer's registration and there is nowhere to read it from.
 *
 *   That is a data gap, not a code gap — the fixture links every client to its party,
 *   and the live rows predate the links. This script repairs exactly that, by name,
 *   inside the demo tenants only, and reports everything else it finds without inventing
 *   any of it.
 *
 * WHAT IT WILL NOT DO
 *
 *   It does not touch money, it does not issue anything, it does not backfill a fiscal
 *   identity onto a historical invoice — a document that was never stamped cannot be
 *   stamped retroactively, and pretending otherwise would be the one thing this system
 *   is built to make impossible. It changes `clients.party_id` where the client and the
 *   party have the SAME NAME in the SAME TENANT and the party is unambiguous, and
 *   nothing else.
 *
 *   Without `--apply` it prints what it would do and changes nothing.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
const db = new pg.Client({
  connectionString:
    `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const TENANTS = [
  ['aaaaaaaa-0000-4000-8000-000000000001', 'KGM Legal (Riyadh)'],
  ['bbbbbbbb-0000-4000-8000-000000000002', 'Najd Legal Consultancy'],
];

console.log(`\n  reconciling the demo tenants ${APPLY ? '(APPLYING)' : '(dry run — nothing will change)'}\n`);

// ── 1 · the clients with no party behind them ─────────────────────────────
const orphans = (await db.query(
  `select c.id, c.tenant_id, c.name, c.name_ar
     from clients c
    where c.tenant_id = any($1::uuid[]) and c.party_id is null
    order by c.tenant_id, c.name`,
  [TENANTS.map(([id]) => id)])).rows;

if (orphans.length === 0) {
  console.log('  every client already has a party behind it.');
} else {
  console.log(`  ${orphans.length} client(s) with no party:`);
  for (const c of orphans) {
    /*
      ONE CANDIDATE OR NONE. A name that matches two parties is not a link this script
      is entitled to guess at, and the fixture's names are unique per tenant — so an
      ambiguous match is reported and left alone rather than resolved by resemblance.
    */
    const candidates = (await db.query(
      `select p.id, p.kind, coalesce(p.vat_number, '') as vat
         from parties p
        where p.tenant_id = $1 and p.merged_into_party_id is null
          and (p.name = $2 or ($3::text is not null and p.name_ar = $3))
        order by p.created_at`,
      [c.tenant_id, c.name, c.name_ar ?? null])).rows;

    if (candidates.length !== 1) {
      console.log(`    · ${c.name.padEnd(28)} ${candidates.length} candidate(s) — left alone`);
      continue;
    }
    const [p] = candidates;
    console.log(`    · ${c.name.padEnd(28)} → party ${p.id} (${p.kind}`
      + `${p.vat ? `, VAT ${p.vat}` : ', no VAT number'})`);
    if (APPLY) {
      await db.query(`update clients set party_id = $1, updated_at = now() where id = $2`,
        [p.id, c.id]);
    }
  }
}

// ── 2 · the fiscal identity, reported not invented ────────────────────────
const identities = (await db.query(
  `select tenant_id, registered_name, vat_registration_number, environment, onboarding_status,
          (select count(*) from fiscal_devices d where d.fiscal_identity_id = f.id and d.is_active) as devices
     from fiscal_identity f where superseded_by is null order by tenant_id`)).rows;

console.log('\n  fiscal identity, as the database has it:');
for (const [id, label] of TENANTS) {
  const row = identities.find((r) => r.tenant_id === id);
  console.log(`    · ${label.padEnd(26)} ${row
    ? `${row.registered_name} · VAT ${row.vat_registration_number} · ${row.onboarding_status} · `
      + `${row.devices} active device(s)`
    : 'NOT ONBOARDED — no tax invoice can be issued by this firm'}`);
}

// ── 3 · the invoices that predate the integration ─────────────────────────
const unstamped = (await db.query(
  `select tenant_id, count(*)::int as n
     from invoices
    where tenant_id = any($1::uuid[]) and invoice_uuid is null
      and internal_status not in ('draft','pending_internal_approval','cancelled')
    group by tenant_id`, [TENANTS.map(([id]) => id)])).rows;

if (unstamped.length > 0) {
  console.log('\n  documents sent before the firm was ZATCA-integrated (left exactly as they are):');
  for (const r of unstamped) {
    console.log(`    · ${r.tenant_id} — ${r.n} invoice(s) with no fiscal identity`);
  }
  console.log('    They cannot be stamped retroactively, and this script will not pretend to.');
}

await db.end();
console.log('');

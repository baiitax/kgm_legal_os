/**
 * KGM LEGAL OS — SEED THE REMOTE DATABASE
 *
 *   DATABASE_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
 *     npx tsx supabase/ops/seed.ts
 *
 * Loads the synthetic demo dataset into Supabase Postgres.
 *
 * WHY THIS IS A SEPARATE TOOL AND NOT A BOOT FLAG
 *   The server seeds itself on boot, but only for SQLite (`index.ts` gates on
 *   `db instanceof SqliteDb`). Letting a deployed server seed on boot would mean
 *   a production restart could insert three demo client logins and a firm-wide
 *   demo tenant into a live database — a data-integrity incident triggered by an
 *   environment variable. Seeding is a deliberate operator action, so it lives
 *   here, runs once, by hand, over an admin connection.
 *
 * WHY IT CONNECTS AS AN ADMIN
 *   The dataset writes `tenants`, `users`, `client_users`, `roles`, `permissions`
 *   and `firm_memberships`. The restricted `portal_api` role is granted none of
 *   those inserts — by design, since the portal must never create a tenant or a
 *   user row. Seeding therefore runs over the same privileged connection the
 *   migrations use, and the API never sees these credentials.
 *
 * IDEMPOTENT
 *   Every id is derived from a stable label and every insert uses
 *   `on conflict do nothing`, so re-running is safe and inserts nothing new.
 *
 * FORCED, UNLIKE THE BOOT PATH
 *   The in-process boot seed skips its inserts when `tenants` is non-empty, to
 *   make a restart cheap. That gate is a presence check on ONE table, so it
 *   cannot tell a complete dataset from an interrupted one — and an interrupted
 *   one is exactly what happened the first time this tool ran: the load died
 *   partway through `invoices`, leaving tenants/clients/users/matters in place
 *   and `firm_memberships` empty. A second run then reported "already present"
 *   and quietly did nothing.
 *
 *   So this tool always passes `force`, which skips that gate and replays every
 *   insert. Because ids are derived from stable labels and every statement is
 *   `on conflict do nothing`, a replay fills in precisely the rows that are
 *   missing and overwrites nothing that exists. The per-table census printed at
 *   the end is the actual check on completeness.
 */


import { seedDemoData } from '../../server/src/db/seed.js';
import { PostgresDb } from '../../server/src/db/postgres.js';
import { DEMO_ACCOUNTS, DEMO_FIRM_ACCOUNTS, DEMO_PASSWORD, DEMO_FIRM_PASSWORD } from '../../server/src/db/demo-data.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (admin connection string).');
  process.exit(1);
}

/*
  Build the driver through the real PostgresDb so the pinned Supabase CA and the
  sslmode-stripping behave exactly as they do in production. A bespoke `new Pool`
  here would silently use different TLS settings and could pass while the server
  fails.

  `assertSafeRole()` is deliberately NOT called. This connection is expected to
  bypass RLS — that is the one place it is legitimate — and the guard exists to
  stop the *server* doing it, not the operator tooling.
*/
const db = new PostgresDb(url, 2);

/** Tables the census reports on — the ones a page actually reads from. */
const CENSUS = [
  'tenants', 'clients', 'users', 'staff', 'client_users', 'matters', 'matter_team',
  'matter_timeline', 'hearings', 'deadlines', 'documents', 'messages',
  'appointments', 'invoices', 'invoice_lines', 'payments', 'receipts',
  'notifications', 'consent_records', 'permissions', 'roles', 'role_permissions',
  'departments', 'firm_memberships', 'membership_roles', 'matter_permissions',
  'tenant_settings',
];

/** Tables that must be non-empty for the portal and firm OS to render at all. */
const REQUIRED = [
  'tenants', 'clients', 'users', 'staff', 'client_users', 'matters',
  'documents', 'invoices', 'notifications', 'roles', 'permissions',
  'role_permissions', 'departments', 'firm_memberships', 'tenant_settings',
];

async function main() {
  console.log('');
  console.log('  KGM LEGAL OS — seed');
  console.log('  ────────────────────────────────────────────────');

  await seedDemoData(db, { verbose: true, force: true });
  /*
    No storage driver is passed. The database rows are what the portal reads;
    the demo document *bytes* live in Supabase Storage, which needs the service
    role key. Without it, document rows exist and their metadata is correct, but
    a download would 404 — reported here rather than left as a surprise.
  */
  console.log('  storage          skipped (no service-role key in this environment)');

  const counts = new Map<string, number>();
  for (const t of CENSUS) {
    const r = await db.get<{ n: string }>(`select count(*)::text as n from public.${t}`);
    counts.set(t, Number(r?.n ?? -1));
  }

  console.log('');
  console.log('  ────────────────────────────────────────────────');
  for (const t of CENSUS) {
    const n = counts.get(t) ?? -1;
    // A required table at zero is the visible signature of a partial seed,
    // which is precisely the failure this tool has to be able to report.
    const flag = REQUIRED.includes(t) && n === 0 ? '   <-- EMPTY, EXPECTED ROWS' : '';
    console.log(`  ${String(n).padStart(6)}  ${t}${flag}`);
  }
  console.log('  ────────────────────────────────────────────────');

  const empties = REQUIRED.filter((t) => (counts.get(t) ?? 0) === 0);
  if (empties.length) {
    console.log('');
    console.log('  INCOMPLETE — required tables with no rows: ' + empties.join(', '));
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('  COMPLETE — every table the portal reads from has rows.');
  }

  console.log('');
  console.log('  PORTAL LOGINS');
  for (const a of DEMO_ACCOUNTS) console.log(`    ${a.email.padEnd(38)} ${DEMO_PASSWORD}   ${a.who}`);
  console.log('');
  console.log('  FIRM OS LOGINS');
  for (const a of DEMO_FIRM_ACCOUNTS) console.log(`    ${a.email.padEnd(38)} ${DEMO_FIRM_PASSWORD}   ${a.who}`);
  console.log('');
}

main()
  .then(() => db.close())
  .catch(async (e) => {
    console.error('\n  SEED FAILED:', String(e?.message ?? e).split('\n')[0]);
    await db.close().catch(() => {});
    process.exit(1);
  });

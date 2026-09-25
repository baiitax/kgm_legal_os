/**
 * Verifies that the phase P-1 SQLite mirror applies to a database that already
 * has data in it.
 *
 * WHY THIS SCRIPT EXISTS, AND WHY THE UNIT SUITE DOES NOT REPLACE IT
 *   Every test boots a fresh in-memory database, so the firm suite proves the DDL
 *   parses and that `create table if not exists` creates the four new tables. It
 *   cannot prove the path that matters for the deployed demo: that database has
 *   rows in it, the tables do NOT exist yet, and `roles` needs a column added and
 *   backfilled. `create table if not exists` silently skips a new column on an
 *   existing table, so without `ensureColumns()` the new gate would read a column
 *   that is not there on every existing database while passing every test.
 *
 *   That is the same class of failure as the eleven Postgres-only defects: a
 *   mechanism that is exercised only on the clean-install path. So this runs
 *   against `server/data/kgm-portal.sqlite` — the real file — and asserts on the
 *   transition rather than on the end state.
 *
 * Run:  npx tsx scripts/verify/sqlite-mirror.ts server/data/kgm-portal.sqlite
 */
import { SqliteDb } from '../../server/src/db/sqlite.js';

const NEW_TABLES = [
  'professional_licences',
  'prior_office',
  'tenant_relationships',
  'eligibility_checks',
] as const;

async function count(db: SqliteDb, sql: string, params: unknown[] = []): Promise<number> {
  const row = await db.get<{ n: number }>(sql, params as never);
  return Number(row?.n ?? 0);
}

/** Reads a column that may not exist yet — the whole point of the exercise. */
async function columnOrNull(db: SqliteDb, sql: string): Promise<string> {
  try {
    const rows = await db.all<Record<string, unknown>>(sql);
    return rows.length ? JSON.stringify(rows.slice(0, 4)) : '(no rows)';
  } catch (err) {
    return `ABSENT — ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'server/data/kgm-portal.sqlite';
  const db = new SqliteDb(file);

  const tenants = await count(db, `select count(*) as n from tenants`);
  const matters = await count(db, `select count(*) as n from matters`);
  console.log(`database      : ${file}`);
  console.log(`existing data : ${tenants} tenants, ${matters} matters`);

  console.log('\n--- BEFORE ---');
  console.log(`tables        : ${await count(db, `select count(*) as n from sqlite_master where type='table'`)}`);
  console.log(`roles column  : ${await columnOrNull(db, `select code, requires_practising_licence from roles limit 4`)}`);
  for (const t of NEW_TABLES) {
    const present = await count(db, `select count(*) as n from sqlite_master where type='table' and name=?`, [t]);
    console.log(`  ${present ? 'present' : 'absent '}  ${t}`);
  }

  db.migrate();

  console.log('\n--- AFTER ---');
  console.log(`tables        : ${await count(db, `select count(*) as n from sqlite_master where type='table'`)}`);
  console.log(`roles column  : ${await columnOrNull(db, `select code, requires_practising_licence from roles limit 4`)}`);
  let ok = true;
  for (const t of NEW_TABLES) {
    const present = await count(db, `select count(*) as n from sqlite_master where type='table' and name=?`, [t]);
    if (!present) ok = false;
    console.log(`  ${present ? 'OK    ' : 'MISSING'}  ${t}`);
  }

  /*
    The backfill is asserted by DECISION, not by count: the migration must have
    written `1` for the four practising templates and `0` for the rest. A count
    alone would pass even if every role were set to the same value.
  */
  const roles = await db.all<{ code: string; requires_practising_licence: number }>(
    `select code, requires_practising_licence from roles
      where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001' order by code`,
  );
  const practising = new Set(['MANAGING_PARTNER', 'PARTNER', 'ASSOCIATE', 'LAWYER']);
  for (const r of roles) {
    const want = practising.has(r.code) ? 1 : 0;
    const got = Number(r.requires_practising_licence);
    if (got !== want) ok = false;
    console.log(`  ${got === want ? 'OK    ' : 'WRONG '}  ${r.code.padEnd(18)} requires_practising_licence=${got} (want ${want})`);
  }

  /*
    The data that was already there must survive. A migration that rebuilt
    `roles` or dropped rows would show up here, and a foreign-key reset would
    orphan the memberships that reference these role ids.
  */
  const memberships = await count(db, `select count(*) as n from firm_memberships`);
  const orphanRoles = await count(
    db,
    `select count(*) as n from membership_roles mr
      where not exists (select 1 from roles r where r.id = mr.role_id)`,
  );
  console.log(`\nmemberships   : ${memberships} (role links intact: ${orphanRoles === 0 ? 'yes' : `NO — ${orphanRoles} orphans`})`);
  if (orphanRoles !== 0) ok = false;

  console.log(`\n${ok ? 'PASS' : 'FAIL'} — the mirror applies to an existing database`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

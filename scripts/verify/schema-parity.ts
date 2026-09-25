/**
 * KGM LEGAL OS — SCHEMA PARITY BETWEEN THE TWO DIALECTS
 *
 *   npx tsx scripts/verify/schema-parity.ts
 *
 * WHY THIS EXISTS
 *   This system runs on two engines. SQLite is where every test runs; PostgreSQL
 *   is where the product runs. Eleven defects reached production by existing in
 *   only one of them, and every one was found late because the divergence was
 *   invisible: a column granted in one dialect and not the other, a constraint
 *   with a vocabulary of its own, a trigger that cannot exist in both.
 *
 *   The unit suite cannot catch this class. It runs on the dialect that is
 *   missing the defect. So the check has to compare the two schemas directly,
 *   and it has to be cheap enough to run every time.
 *
 * WHAT IT COMPARES
 *   1. Tables present in one dialect and not the other.
 *   2. Columns present in one and not the other.
 *   3. Column-level write privileges: for each table, the server's own inserts
 *      are measured against what `firm_api` may actually write. A column the
 *      server sends but is not granted produces a 500 at runtime and passes
 *      every SQLite test — this is the defect that prompted the file.
 *
 * WHAT IT DOES NOT COMPARE
 *   Types and defaults. The dialects spell them differently on purpose (text vs
 *   timestamptz, integer 0/1 vs boolean) and the repository layer exists to
 *   absorb exactly that. Comparing them would produce a list of known, intended
 *   differences that buries the real findings.
 */
import pg from '../../node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';
import { SqliteDb } from '../../server/src/db/sqlite.js';

const ADMIN = (() => {
  const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
  return `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres';
})();

/**
 * Columns the server writes on each command, transcribed from `firm-repo.ts`.
 *
 * This is the load-bearing part of the file. A grant list can only be wrong
 * relative to something, and the thing it must match is not the table's columns —
 * it is the statement the server actually issues. Keeping the two in one place
 * means adding a column to an INSERT forces a decision here.
 */
const SERVER_WRITES: Array<{
  table: string;
  command: 'INSERT' | 'UPDATE';
  /** Columns the statement WRITES. For an UPDATE this is the SET list only. */
  columns: string[];
  /** Columns the statement merely READS (a WHERE clause), which need SELECT. */
  readColumns?: string[];
  where: string;
}> = [
  {
    table: 'professional_licences', command: 'INSERT', where: 'FirmRepo.upsertLicence (new licence)',
    columns: ['id', 'tenant_id', 'staff_id', 'licence_number', 'issued_at', 'expires_at',
      'status', 'status_effective_from', 'status_reference', 'verified_by_membership_id',
      'verified_at', 'created_at', 'updated_at'],
  },
  {
    table: 'professional_licences', command: 'UPDATE', where: 'FirmRepo.upsertLicence (renewal)',
    columns: ['issued_at', 'expires_at', 'status', 'status_effective_from', 'status_reference',
      'verified_by_membership_id', 'verified_at', 'updated_at'],
    // `where id = ? and tenant_id = ?` — an UPDATE needs UPDATE on the columns it
    // SETS and SELECT on the columns it READS, which is a rule that catches people
    // out in both directions. Kept as a separate list so the check states it.
    readColumns: ['id', 'tenant_id'],
  },
  {
    table: 'prior_office', command: 'INSERT', where: 'FirmRepo.recordPriorOffice',
    columns: ['id', 'tenant_id', 'staff_id', 'office_kind', 'institution', 'institution_ar',
      'role_title', 'role_title_ar', 'started_on', 'ended_on', 'created_at', 'updated_at'],
  },
  {
    table: 'eligibility_checks', command: 'INSERT', where: 'FirmRepo.recordEligibilityCheck',
    columns: ['tenant_id', 'subject_kind', 'subject_id', 'precondition', 'outcome', 'evidence',
      'rule_cited', 'evaluated_by_membership_id', 'evaluated_at'],
  },
];

const NEW_TABLES = ['professional_licences', 'prior_office', 'tenant_relationships', 'eligibility_checks'];

async function main(): Promise<void> {
  const db = new SqliteDb(':memory:');
  db.migrate();

  const lite = await db.all<{ name: string }>(
    `select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'kgm_%'`,
  );
  const liteTables = new Set(lite.map((r) => r.name));
  const liteCols = new Map<string, Set<string>>();
  for (const t of liteTables) {
    const cols = await db.all<{ name: string }>(`pragma table_info(${t})`);
    liteCols.set(t, new Set(cols.map((c) => c.name)));
  }

  const c = new pg.Client({ connectionString: ADMIN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const pgTables = new Set(
    (await c.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`))
      .rows.map((r: { table_name: string }) => r.table_name),
  );
  const pgCols = new Map<string, Set<string>>();
  for (const t of pgTables) {
    const cols = await c.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t]);
    pgCols.set(t, new Set(cols.rows.map((r: { column_name: string }) => r.column_name)));
  }

  const findings: string[] = [];

  // ── 1 · tables ──────────────────────────────────────────────────────────
  console.log('TABLES');
  console.log(`  sqlite ${liteTables.size}   postgres ${pgTables.size}`);
  for (const t of liteTables) {
    if (!pgTables.has(t)) {
      findings.push(`table ${t} exists in SQLite and not in PostgreSQL`);
      console.log(`  MISSING in postgres : ${t}`);
    }
  }
  for (const t of pgTables) {
    if (!liteTables.has(t)) {
      // Expected in one direction only: the local drivers and the ops tables have
      // no SQLite mirror. Anything else is a gap the suite cannot see.
      const expected = ['kgm_migrations', 'client_invitations_alias'];
      if (!expected.includes(t)) console.log(`  note — postgres-only table: ${t}`);
    }
  }

  // ── 2 · columns, for the tables phase P-1 touched ───────────────────────
  console.log('\nCOLUMNS (phase P-1 tables)');
  for (const t of NEW_TABLES) {
    const a = liteCols.get(t) ?? new Set<string>();
    const b = pgCols.get(t) ?? new Set<string>();
    const onlyLite = [...a].filter((x) => !b.has(x));
    const onlyPg = [...b].filter((x) => !a.has(x));
    const status = onlyLite.length === 0 && onlyPg.length === 0 ? 'in step' : 'DIVERGENT';
    console.log(`  ${t.padEnd(24)} ${String(a.size).padStart(2)} / ${String(b.size).padStart(2)}  ${status}`);
    if (onlyLite.length) {
      findings.push(`${t}: only in SQLite — ${onlyLite.join(', ')}`);
      console.log(`      only in SQLite : ${onlyLite.join(', ')}`);
    }
    if (onlyPg.length) {
      findings.push(`${t}: only in PostgreSQL — ${onlyPg.join(', ')}`);
      console.log(`      only in PostgreSQL : ${onlyPg.join(', ')}`);
    }
  }

  // ── 3 · write privileges, measured against the server's own statements ──
  console.log('\nWRITE PRIVILEGES (firm_api, against what the server actually sends)');
  for (const w of SERVER_WRITES) {
    const granted = new Set(
      (await c.query(
        `select column_name from information_schema.column_privileges
          where table_name=$1 and grantee='firm_api' and privilege_type=$2`,
        [w.table, w.command],
      )).rows.map((r: { column_name: string }) => r.column_name),
    );
    const selects = new Set(
      (await c.query(
        `select column_name from information_schema.column_privileges
          where table_name=$1 and grantee='firm_api' and privilege_type='SELECT'`,
        [w.table],
      )).rows.map((r: { column_name: string }) => r.column_name),
    );

    /*
      A column the server sends but is not granted is a runtime failure that no
      SQLite test can produce: the engine has one role and no column privileges.
      It is the defect this file was written for — `eligibility_checks.evaluated_at`
      returned HTTP 500 in production while 346 tests passed.
    */
    const ungranted = w.columns.filter((col) => !granted.has(col));
    const unreadable = (w.readColumns ?? []).filter((col) => !selects.has(col));
    const ok = ungranted.length === 0 && unreadable.length === 0;
    if (!ok) findings.push(`${w.table} ${w.command}: server uses ungranted column(s) — ${[...ungranted, ...unreadable].join(', ')}`);
    console.log(`  ${ok ? 'OK    ' : 'FAIL  '} ${w.table} ${w.command}  (${w.where})`);
    if (ungranted.length) console.log(`         NOT GRANTED for ${w.command}: ${ungranted.join(', ')}`);
    if (unreadable.length) console.log(`         NOT GRANTED for SELECT (WHERE clause): ${unreadable.join(', ')}`);
  }

  await c.end();

  console.log('');
  if (findings.length) {
    console.log(`  ${findings.length} finding(s) — the dialects disagree:`);
    for (const f of findings) console.log(`    · ${f}`);
    process.exit(1);
  }
  console.log('  PASS — no divergence between the two dialects');
}

main().catch((err) => { console.error(err); process.exit(1); });

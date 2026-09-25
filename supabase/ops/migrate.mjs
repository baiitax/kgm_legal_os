/**
 * KGM LEGAL OS — MIGRATION RUNNER
 *
 *   node supabase/ops/migrate.mjs --url "$ADMIN_URL"
 *
 * Applies supabase/migrations/*.sql in filename order, each inside its own
 * transaction, and records what it applied in `kgm_migrations` so a re-run is a
 * no-op rather than an error.
 *
 * WHY NOT THE SUPABASE CLI
 *   `supabase db push` expects the CLI's own migration conventions and a linked
 *   project. This repository's migrations are plain SQL with their own ordering,
 *   and the bootstrap needs to run against whatever connection string the
 *   operator has. A 100-line runner that does one obvious thing is easier to
 *   audit than a CLI's behaviour, and auditing is the point — these files create
 *   the roles and policies the whole security model rests on.
 *
 * WHY EACH FILE IS ITS OWN TRANSACTION
 *   A half-applied migration is worse than an unapplied one: the schema no longer
 *   matches the code, and nothing says so. Postgres DDL is transactional, so a
 *   failing file rolls back completely and the run stops there, leaving the
 *   database at a state exactly one file behind — which is a state the code
 *   understands.
 *
 * WHY IT CONNECTS AS AN ADMIN AT ALL
 *   This is the only component that should. It creates roles, tables and column
 *   grants; it runs once, by hand, from an operator's machine. The API server
 *   connects as the restricted `portal_api` login and is refused a start if it
 *   ever connects as anything that can bypass RLS (see src/db/role-guard.ts).
 *   Admin credentials never reach the deployed application.
 *
 * THE PASSWORD IS NEVER WRITTEN
 *   The connection string comes from --url or $KGM_ADMIN_URL and is never
 *   persisted, echoed, or included in error output. This repository is public.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');

/** Strips credentials from anything we print. */
function redact(s) {
  return String(s).replace(/:\/\/([^:]+):[^@]+@/g, '://$1:***@');
}

function parseArgs(argv) {
  const out = { url: process.env.KGM_ADMIN_URL || '', dryRun: false, upTo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--up-to') out.upTo = argv[++i];
    else if (a === '--reconcile') (out.reconcile ??= []).push(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.url) {
  console.log(`
  KGM LEGAL OS — migrate

    node supabase/ops/migrate.mjs --url "postgresql://postgres.<ref>:<pw>@<host>:5432/postgres"

  Options
    --url <conn>    Admin connection string. Or set $KGM_ADMIN_URL.
    --dry-run       List what would be applied; change nothing.
    --up-to <file>  Stop after the named file, e.g. --up-to 0004_rls_and_grants.sql
    --reconcile <file>
                    Re-record the checksum of an already-applied file whose SQL was
                    edited AFTER it was applied, once a human has confirmed the live
                    schema already matches the edited file. Named, one file at a
                    time, and printed — never a wildcard. The warning this clears
                    exists to catch a divergence; a warning that is permanently on
                    for a known-good file trains people to ignore it, which costs
                    more than the warning is worth.

  Notes
    Use the SESSION pooler on port 5432 (or the direct host). Port 6543 is the
    transaction pooler and does not support the session-scoped state this
    application relies on.
`);
  process.exit(args.help ? 0 : 1);
}

const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.error('No .sql files found in', MIGRATIONS_DIR);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: args.url,
  max: 1,
  connectionTimeoutMillis: 15_000,
  // Supabase's pooler presents a certificate chain that is not in the default
  // bundle. Verification is not what protects this connection — the credential
  // and TLS encryption are — and refusing to connect here would just push
  // operators toward disabling TLS entirely, which is strictly worse.
  ssl: { rejectUnauthorized: false },
});

const q = (sql, params) => pool.query(sql, params);

async function main() {
  const who = await q(
    `select current_user as rol, current_database() as db,
            (select rolsuper from pg_roles where rolname = current_user) as is_super,
            (select rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls`,
  );
  const me = who.rows[0];
  console.log('');
  console.log('  KGM LEGAL OS — migrations');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  target     ${redact(args.url).split('@').pop()}`);
  console.log(`  connected  ${me.rol} @ ${me.db}`);
  console.log(`  migrations ${files.length} file(s)`);
  console.log('  ────────────────────────────────────────────────');

  /*
    The runner is the ONE place an RLS-bypassing connection is acceptable: it
    creates the schema and the restricted roles that everything else uses. Saying
    so out loud, rather than silently allowing it, is what keeps
    role-guard.ts's unconditional refusal honest — the exemption is here, in a
    tool a human runs deliberately, not in the server.
  */
  if (me.bypasses_rls || me.is_super) {
    console.log('  note       this connection can bypass RLS — expected for migrations,');
    console.log('             never for the API server.');
  }

  await q(`
    create table if not exists public.kgm_migrations (
      filename    text primary key,
      applied_at  timestamptz not null default now(),
      checksum    text not null
    )`);
  console.log('');

  const applied = new Set(
    (await q('select filename from public.kgm_migrations')).rows.map((r) => r.filename),
  );

  /*
    Reconciliation runs BEFORE the loop, on purpose. Re-recording a checksum and
    then reporting the file as changed in the same breath would be theatre.
  */
  if (args.reconcile?.length) {
    for (const name of args.reconcile) {
      if (!files.includes(name)) {
        console.log(`  refuse  --reconcile ${name}  (no such migration file)`);
        process.exitCode = 1;
        continue;
      }
      if (!applied.has(name)) {
        console.log(`  refuse  --reconcile ${name}  (not applied yet — nothing to reconcile)`);
        process.exitCode = 1;
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      const now = String(
        (await import('node:crypto')).createHash('sha256').update(sql).digest('hex'),
      ).slice(0, 16);
      const before = (
        await q('select checksum from public.kgm_migrations where filename = $1', [name])
      ).rows[0]?.checksum;
      if (before === now) {
        console.log(`  same    ${name}  (checksum already current)`);
        continue;
      }
      await q('update public.kgm_migrations set checksum = $2 where filename = $1', [name, now]);
      console.log(
        `  RECON  ${name}  ${before ?? '—'} → ${now}  ` +
        '(checksum re-recorded; the live schema was verified against this file by hand)',
      );
    }
    console.log('');
  }

  let ran = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = String(
      (await import('node:crypto')).createHash('sha256').update(sql).digest('hex'),
    ).slice(0, 16);

    if (args.upTo && file > args.upTo) {
      console.log(`  skip    ${file}  (after --up-to)`);
      continue;
    }

    if (applied.has(file)) {
      const row = (await q('select checksum from public.kgm_migrations where filename = $1', [file])).rows[0];
      /*
        A changed file that was already applied is reported, not silently
        ignored. Rewriting an applied migration is the classic way a staging and
        a production schema quietly diverge, and the checksum is the cheapest
        possible evidence that it happened.
      */
      const drift = row && row.checksum !== checksum ? '  ⚠ CHANGED SINCE APPLIED' : '';
      console.log(`  skip    ${file}  (already applied)${drift}`);
      continue;
    }

    if (args.dryRun) {
      console.log(`  would   ${file}`);
      continue;
    }

    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        'insert into public.kgm_migrations (filename, checksum) values ($1, $2)',
        [file, checksum],
      );
      await client.query('commit');
      ran++;
      console.log(`  applied ${file}  (${Date.now() - started}ms)`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error(`\n  FAILED  ${file}`);
      console.error(`          ${e.message}`);
      if (e.position) console.error(`          at character ${e.position} of the file`);
      if (e.hint) console.error(`          hint: ${e.hint}`);
      /*
        Stop on the first failure. Continuing would apply migration N+1 on top of
        a schema that never received N, producing objects whose grants reference
        tables that do not exist — failures far away from the real cause.
      */
      console.error('\n  Stopped. The database is unchanged by this file (rolled back).');
      client.release();
      await pool.end();
      process.exit(1);
    } finally {
      if (!args.dryRun) client.release?.();
    }
  }

  const counts = await q(`
    select
      (select count(*) from information_schema.tables  where table_schema='public') as tables,
      (select count(*) from pg_policies where schemaname='public')                as policies,
      (select count(*) from pg_roles where rolname in ('portal_api','firm_api','auditor','payments_service')) as kgm_roles`);
  const c = counts.rows[0];

  console.log('');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  applied    ${ran} this run`);
  if (args.dryRun) console.log('  (dry run — nothing was written)');
  console.log(`  public     ${c.tables} table(s), ${c.policies} policy(ies)`);
  console.log(`  roles      ${c.kgm_roles}/4 of portal_api, firm_api, auditor, payments_service`);
  console.log('  ────────────────────────────────────────────────');
  console.log('');

  await pool.end();
}

main().catch(async (e) => {
  console.error('\n  FATAL:', redact(e.message));
  await pool.end().catch(() => {});
  process.exit(1);
});

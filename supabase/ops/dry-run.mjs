#!/usr/bin/env node
/**
 * DRY-RUN A MIGRATION AGAINST THE REAL DATABASE, WITHOUT APPLYING IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *   Every migration in this project is written against a dialect that the test
 *   suite does not run: SQLite has no `create policy`, no `plpgsql`, no
 *   `for update` in a trigger, no role grants. So a migration's SQL is, until the
 *   moment it is applied for real, UNEXECUTED — and the only place it has ever run
 *   is the one place a mistake costs a production schema.
 *
 *   This runs the file inside a transaction and ROLLS IT BACK. DDL is transactional
 *   in PostgreSQL, so every table, function, policy and trigger the file creates is
 *   created for real, executed for real, and then discarded. What it catches is not
 *   a simulation: it is the actual server parsing the actual SQL against the actual
 *   current schema.
 *
 * WHAT IT CANNOT CATCH
 *   A migration whose effect depends on rows that do not exist yet, and anything
 *   that is not transactional (`create index concurrently`, `vacuum`, `alter type …
 *   add value` on older servers). It also cannot prove a GUARD works: a `before
 *   insert` trigger that is correctly installed and never fires is exactly what this
 *   reports success for. That is what the security tests and the live harness are
 *   for, and the three are meant to be run together.
 *
 * USAGE
 *   node supabase/ops/dry-run.mjs --url "$KGM_ADMIN_URL" 0034 0035 0036
 *   node supabase/ops/dry-run.mjs --url "$KGM_ADMIN_URL" --all
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');

const args = (() => {
  const out = { url: process.env.KGM_ADMIN_URL ?? '', files: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') out.url = argv[++i];
    else if (argv[i] === '--all') out.all = true;
    else out.files.push(argv[i]);
  }
  return out;
})();

if (!args.url) {
  console.error('  refuse  --url is required (the migration connection, not the API one)');
  process.exit(1);
}
if (!args.all && args.files.length === 0) {
  console.error('  refuse  name at least one migration file, or pass --all');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: args.url,
  ssl: args.url.includes('localhost') || args.url.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
});

const redact = (s) => s.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');

const all = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
/*
  A migration is named by its NUMBER in every conversation anyone has ever had about
  it, so the number is what this accepts. An argument that is not a file is treated as
  the leading number of one, and a number that matches nothing is reported as such
  rather than silently expanding to the whole set.
*/
const resolveArg = (arg) => {
  if (arg.endsWith('.sql')) return [arg];
  const matches = all.filter((f) => f.startsWith(arg));
  return matches.length > 0 ? matches : [arg];
};
const files = args.all ? all : args.files.flatMap(resolveArg);

console.log('');
console.log('  KGM LEGAL OS — migration dry run');
console.log('  ────────────────────────────────────────────────');
console.log(`  target     ${redact(args.url).split('@').pop()}`);
console.log(`  files      ${files.length}`);
console.log('  mode       begin → run → ROLLBACK (nothing is kept)');
console.log('  ────────────────────────────────────────────────');
console.log('');

await client.connect();

let failures = 0;
for (const file of files) {
  const full = path.join(MIGRATIONS_DIR, file);
  if (!fs.existsSync(full)) {
    console.log(`  ✗  ${file}  — no such file`);
    failures += 1;
    continue;
  }
  const sql = fs.readFileSync(full, 'utf8');
  const started = Date.now();
  try {
    await client.query('begin');
    /*
      The notices the migration raises are the useful output — a VERIFY block that
      passes says so, and one that fails raises an exception this catch will see.
    */
    await client.query(sql);
    await client.query('rollback');
    console.log(`  ✓  ${file}  (${Date.now() - started} ms — rolled back)`);
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    failures += 1;
    console.log(`  ✗  ${file}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
    if (err.detail) console.log(`        detail: ${err.detail}`);
    if (err.where) console.log(`        at:     ${err.where}`);
    if (err.position) {
      /* Print the offending region rather than making somebody count characters. */
      const at = Number(err.position);
      const before = sql.slice(0, at);
      const line = before.split('\n').length;
      const context = sql.split('\n').slice(Math.max(0, line - 3), line + 2)
        .map((l, i) => `        ${Math.max(0, line - 2) + i}| ${l}`).join('\n');
      console.log(`        line ${line}:`);
      console.log(context);
    }
  }
}

console.log('');
console.log(`  ${files.length - failures}/${files.length} parsed and executed against the real server`);
console.log('');

await client.end();
process.exit(failures === 0 ? 0 : 1);

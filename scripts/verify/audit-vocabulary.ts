/**
 * KGM LEGAL OS — THE AUDIT VOCABULARY, IN TWO PLACES, CHECKED
 *
 *   npx tsx scripts/verify/audit-vocabulary.ts
 *
 * WHY THIS EXISTS
 *   `AuditAction` in server/src/audit/logger.ts is a TypeScript union. The database
 *   constraint `audit_events_action_check` is a hand-written list of literals. They
 *   must say exactly the same thing, and nothing made them.
 *
 *   Migration 0029 was written with the list typed out by hand. It contained three
 *   plausible actions that do not exist and OMITTED eighteen that do:
 *
 *     invented : MATTER_CREATED, INVOICE_SENT, CLIENT_VIEWED
 *     omitted  : INVITATION_CREATED, MFA_ENABLED, AUTHZ_DENIED, SIGNED_URL_ISSUED,
 *                LICENCE_VERIFIED, ELIGIBILITY_EVALUATED, MULTI_FIRM_AFFILIATION_DENIED …
 *
 *   It would have NARROWED a live constraint. That is worse than it sounds: the
 *   dropped actions were still being written by working code, so the next write of
 *   one of them would raise a CHECK violation at runtime, in production, in the one
 *   subsystem whose failures are not supposed to be possible. The migration refused
 *   to apply — a CHECK cannot be added over existing rows that violate it — and the
 *   refusal is the only reason this was caught before deployment.
 *
 *   The lesson is not "be careful typing". It is that a list which must agree with
 *   another list is a place the codebase will drift, and drift in this particular
 *   list is silent in one direction (a rejected write is loud; a missing action that
 *   was never added is not) and catastrophic in the other.
 *
 * WHAT IT CHECKS
 *   1. Every action in the union is admitted by the live constraint.
 *   2. Every action the constraint admits is in the union — an action nobody can
 *      write is a vocabulary entry that lies about what the system records.
 *   3. Every action already present in `audit_events` is still admitted. This is the
 *      historical half: a narrowing that happens to be self-consistent today would
 *      still refuse to write next month's rows correctly.
 *   4. No duplicate literals in the union, because a duplicate is usually a rename
 *      that was half done.
 */
import pg from '../../node_modules/pg/lib/index.js';
import { readFileSync } from 'node:fs';

const ADMIN = (() => {
  const pw = readFileSync('/home/user/.kgm-ops/pw.txt', 'utf8').trim();
  return `postgresql://postgres.sdpezbxwedvxqelpslfv:${encodeURIComponent(pw)}@` +
    'aws-0-us-east-1.pooler.supabase.com:5432/postgres';
})();

const LOGGER = 'server/src/audit/logger.ts';

/** The union, read out of the source rather than imported. */
export function unionActions(): { actions: string[]; duplicates: string[] } {
  // Comments are stripped from the WHOLE file before anything else, because the
  // union carries long explanations — and those explanations contain semicolons and
  // quoted words. Locating the end of the union by searching for ';' before stripping
  // them finds a semicolon in a sentence and silently returns a TRUNCATED union. The
  // first run of this checker did exactly that and reported 23 actions as missing
  // from the union when it had simply stopped reading at the wrong character.
  const src = readFileSync(LOGGER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
  const start = src.indexOf('export type AuditAction');
  if (start < 0) throw new Error(`${LOGGER}: AuditAction union not found`);
  const end = src.indexOf(';', start);
  if (end < 0) throw new Error(`${LOGGER}: AuditAction union has no terminator`);
  const body = src.slice(start, end);
  const actions = [...body.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const a of actions) {
    if (seen.has(a)) duplicates.push(a);
    seen.add(a);
  }
  return { actions, duplicates };
}

async function main(): Promise<void> {
  const { actions, duplicates } = unionActions();
  const union = new Set(actions);

  const c = new pg.Client({ connectionString: ADMIN, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const def = (
    await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'audit_events_action_check'`,
    )
  ).rows[0]?.def as string | undefined;
  if (!def) {
    console.log('  FAIL — audit_events_action_check does not exist in the live database');
    process.exitCode = 1;
    await c.end();
    return;
  }
  const admitted = [...def.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  const admittedSet = new Set(admitted);

  const inUse = (
    await c.query(`select distinct action from public.audit_events order by action`)
  ).rows.map((r: { action: string }) => r.action);

  const findings: string[] = [];

  console.log('AUDIT VOCABULARY');
  console.log(`  union ${union.size}   constraint ${admittedSet.size}   in use ${inUse.length}`);

  if (duplicates.length) {
    findings.push(`declared more than once in the union: ${duplicates.join(', ')}`);
    console.log(`  DUPLICATE   ${duplicates.join(', ')}`);
  }

  // ── 1 · declared but not admitted: a write that will fail at runtime ─────
  const refused = [...union].filter((a) => !admittedSet.has(a));
  if (refused.length) {
    findings.push(`declared in the union but refused by the database: ${refused.join(', ')}`);
    console.log(`  REFUSED BY DB`);
    for (const a of refused) console.log(`      ${a}`);
  }

  // ── 2 · admitted but not declared: vocabulary nobody can write ──────────
  const orphan = [...admittedSet].filter((a) => !union.has(a));
  if (orphan.length) {
    findings.push(`admitted by the database and absent from the union: ${orphan.join(', ')}`);
    console.log(`  NOT IN UNION`);
    for (const a of orphan) console.log(`      ${a}`);
  }

  // ── 3 · the historical half: a narrowing would strand existing rows ─────
  const stranded = inUse.filter((a) => !admittedSet.has(a));
  if (stranded.length) {
    findings.push(`already recorded but no longer admitted: ${stranded.join(', ')}`);
    console.log(`  STRANDED (would make deletion of old rows — forbidden — the only fix)`);
    for (const a of stranded) console.log(`      ${a}`);
  }

  await c.end();

  if (findings.length) {
    console.log(`\n  ${findings.length} finding(s):`);
    for (const f of findings) console.log(`    · ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  PASS — the union and the constraint say the same thing');
}

if (process.argv[1] && process.argv[1].includes('audit-vocabulary')) {
  main().catch((e: Error) => {
    console.error(`  FAIL — ${e.message}`);
    process.exit(1);
  });
}

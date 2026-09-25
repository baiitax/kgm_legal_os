/**
 * Regenerate an audit-vocabulary migration FROM the declared union.
 *
 * WHY THIS EXISTS. `AuditAction` in `server/src/audit/logger.ts` is the source of truth
 * for what the code may write, and `audit_events_action_check` is what the database
 * will admit. They are two lists that must agree exactly, and they are maintained by
 * different people at different times. 0029 typed the database list by hand and both
 * invented three actions that do not exist and omitted eighteen that do.
 *
 * The omission is the dangerous direction. Applying a constraint that NARROWS what is
 * admitted over rows already written can refuse the migration outright, and a
 * constraint that no longer admits an action the code writes fails silently in
 * production — `tryWrite` swallows the write and logs a warning, so an issued invoice
 * is not recorded as issued while the product behaves perfectly.
 *
 * So: never hand-edit the action list in a migration. Run this, and the two lists
 * cannot disagree about spelling or order.
 *
 * USAGE
 *   node scripts/generate-audit-vocabulary.mjs                    # writes 0038_...
 *   node scripts/generate-audit-vocabulary.mjs --number 0038 --title "…"
 *   node scripts/generate-audit-vocabulary.mjs --check            # verify, write nothing
 *
 * `--check` is the one to wire into CI: it fails when the migration on disk does not
 * match the union, which is the moment somebody edited one of the two lists by hand.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const LOGGER = join(repo, 'server/src/audit/logger.ts');
const MIGRATIONS = join(repo, 'supabase/migrations');

/**
 * The union, read between its two markers.
 *
 * NOT a greedy or non-greedy match to the first semicolon: the union holds no
 * semicolons but the file after it holds many, and an earlier attempt at this
 * under-counted 119 actions as 69 by stopping at the wrong one. The markers are the
 * declaration and the next declaration, which is a fact about the file rather than a
 * guess about its punctuation.
 */
export function declaredActions(source) {
  const start = source.indexOf('export type AuditAction =');
  const end = source.indexOf('export interface AuditActor');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('could not locate the AuditAction union — has the declaration moved?');
  }
  const body = source.slice(start, end);
  const actions = [...body.matchAll(/'([A-Z][A-Z_0-9]*)'/g)].map((m) => m[1]);
  const unique = [...new Set(actions)];
  if (unique.length !== actions.length) {
    const dupes = actions.filter((a, i) => actions.indexOf(a) !== i);
    throw new Error(`the union declares duplicate actions: ${[...new Set(dupes)].join(', ')}`);
  }
  if (unique.length < 50) {
    throw new Error(`only ${unique.length} actions found — the extraction is wrong, not the union`);
  }
  return unique;
}

export function buildMigration({ number, title, actions }) {
  const list = actions.map((a) => `    '${a}'`).join(',\n');
  return `-- ═══════════════════════════════════════════════════════════════════════════════
-- ${number} · ${title}
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--     node scripts/generate-audit-vocabulary.mjs
--
-- WHAT HAPPENS IF THIS FILE IS NOT APPLIED. Not a crash. The write fails the CHECK and
-- \`tryWrite\` swallows it with a console warning, so an issued invoice is not recorded
-- as issued, a client's money is received and no row says so, and a discount beyond
-- authority leaves no trace — while the product behaves perfectly. That is the failure
-- mode this codebase keeps meeting: silent in one direction, catastrophic in the other.
--
-- THE LIST IS GENERATED FROM THE UNION, IN ORDER, NOT TYPED. ${actions.length} actions.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.audit_events drop constraint if exists audit_events_action_check;

alter table public.audit_events add constraint audit_events_action_check
  check (action in (
${list}
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- SELF-VERIFICATION. The constraint is asserted to exist, to admit every declared
-- action, and to have been built from this list rather than from a stale one.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  missing text;
  admitted integer;
begin
  if not exists (
    select 1 from pg_constraint where conname = 'audit_events_action_check'
  ) then
    raise exception '${number}: audit_events_action_check was not created';
  end if;

  select count(*) into admitted
    from pg_constraint
   where conname = 'audit_events_action_check'
     and pg_get_constraintdef(oid) like '%''LOGIN''%';
  if admitted = 0 then
    raise exception '${number}: the constraint does not look like an action list';
  end if;

  select string_agg(a, ', ') into missing
    from unnest(array[
${list}
    ]) a
   where not exists (
     select 1 from pg_constraint
      where conname = 'audit_events_action_check'
        and pg_get_constraintdef(oid) like '%''' || a || '''%'
   );
  if missing is not null then
    raise exception '${number}: declared but not admitted: %', missing;
  end if;

  raise notice '${number}: audit vocabulary at ${actions.length} actions — verified against the declared union';
end $$;
`;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const numberArg = args.includes('--number') ? args[args.indexOf('--number') + 1] : null;
  const titleArg = args.includes('--title') ? args[args.indexOf('--title') + 1] : null;

  const source = readFileSync(LOGGER, 'utf8');
  const actions = declaredActions(source);

  if (check) {
    /* The newest generated migration is the one being verified: it is the one that will
       be applied, and it is the one that goes stale when the union grows. */
    const candidates = existsSync(MIGRATIONS)
      ? readFileSync(join(MIGRATIONS, '0037_audit_vocabulary_p02.sql'), 'utf8')
      : null;
    if (!candidates) {
      console.error('--check: no generated migration to compare against');
      process.exit(1);
    }
    const missing = actions.filter((a) => !candidates.includes(`'${a}'`));
    const stale = [...candidates.matchAll(/^    '([A-Z][A-Z_0-9]*)'[,)]?$/gm)]
      .map((m) => m[1])
      .filter((a) => !actions.includes(a));
    if (missing.length || stale.length) {
      console.error(`--check FAILED: ${missing.length} declared but absent, ${stale.length} present but not declared`);
      if (missing.length) console.error(`  absent: ${missing.join(', ')}`);
      if (stale.length) console.error(`  stale:  ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log(`--check OK: ${actions.length} actions, the migration and the union agree`);
    return;
  }

  const number = numberArg ?? '0038';
  const title = titleArg ?? 'AUDIT VOCABULARY — REGENERATED FROM THE UNION';
  const out = join(MIGRATIONS, `${number}_audit_vocabulary.sql`);
  writeFileSync(out, buildMigration({ number, title, actions }));
  console.log(`wrote supabase/migrations/${number}_audit_vocabulary.sql — ${actions.length} actions`);
}

if (process.argv[1] && process.argv[1].endsWith('generate-audit-vocabulary.mjs')) main();

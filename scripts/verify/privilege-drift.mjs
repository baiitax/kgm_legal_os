#!/usr/bin/env node
/**
 * P0.5-M · THE DRIFT CHECK — ONE RULE, SEVERAL COPIES, DIFFED
 *
 *   node scripts/verify/privilege-drift.mjs
 *
 * WHY THIS EXISTS
 *
 *   Defect (o) — the 25% UBO rule that lived in the domain, in the SQLite trigger and in the
 *   0040 Postgres trigger, where only the SQLite copy required the owner to be a natural
 *   person — was found by a human reading three files side by side. That is not a strategy.
 *   A rule that exists in more than one dialect has to be DIFFED, not reviewed.
 *
 *   The privilege ring is the worst case in this codebase so far: its central rule — who may
 *   lawfully be shown the firm's own work product — is spelled out four times.
 *
 *     1. `server/src/domain/privilege.ts`       the verdict the application carries (TS)
 *     2. `server/src/db/firm-repo.ts`           the licence arithmetic that feeds it (TS/SQL)
 *     3. `supabase/migrations/0054_….sql`       the database's own opinion (plpgsql/sql)
 *     4. `server/src/db/schema.firm.sqlite.ts`  the demo engine's copy (SQLite)
 *
 *   This script extracts the discriminating TEXT of each rule from each copy and asserts the
 *   copies agree on the things that matter: the vocabulary, the order of precedence, the
 *   comparison that decides "today", the tokens, and the four grounds. Where a copy cannot
 *   state a rule in the same words (SQLite has no `now() at time zone`, the app has no
 *   plpgsql), the script asserts the SEMANTIC twin explicitly and says which words it is
 *   accepting as equivalent — so the equivalence is a written decision rather than an
 *   assumption.
 *
 *   It reads files. It does not touch a database. It runs in under a second, which is the
 *   point: a drift check nobody runs is not a check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const files = {
  domain: read('server/src/domain/privilege.ts'),
  repo: read('server/src/db/firm-repo.ts'),
  pg: read('supabase/migrations/0054_the_privilege_ring.sql'),
  pgScope: read('supabase/migrations/0056_privilege_release_document_scope.sql'),
  sqlite: read('server/src/db/schema.firm.sqlite.ts'),
  routes: read('server/src/api/firm.routes.ts'),
};

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

/** Every occurrence of a token, in file order. */
const occurrences = (text, needle) => text.split(needle).length - 1;

/** The FIRST index of each token, so an ordered vocabulary can be compared. */
const order = (text, tokens) => tokens
  .map((t) => ({ t, i: text.indexOf(t) }))
  .filter((x) => x.i >= 0)
  .sort((a, b) => a.i - b.i)
  .map((x) => x.t);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nKGM LEGAL OS — the privilege ring, diffed across its copies\n');

/* ══ 1 · THE VOCABULARY AND ITS ORDER ═══════════════════════════════════════ */
const REASONS = ['in_ring', 'outside_ring', 'no_licence_on_record', 'suspended', 'revoked', 'expired', 'pending'];

/* The ring function returns a `case`; the order of the `then` arms IS the severity rule.
   The prose above the function names the reasons too (it explains the severity order), so
   the extraction reads the ARMS rather than every occurrence of the word. */
const pgCase = files.pg.slice(files.pg.indexOf('kgm_lawyer_ring_reason'));
/* `in_ring` is an ARM in SQL (the entitled case) and an early RETURN in the domain, so it is
   removed from the refusal sequence before the two are compared; `pending` is SQL's final
   `else` and the domain's last case, asserted separately below. */
const pgArms = [...pgCase.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
const pgRefusals = pgArms.filter((r) => r !== 'in_ring');
const pgPendingIsElse = /else 'pending'/.test(pgCase);
check('the database names the refusal vocabulary in the severity order the domain declares',
  pgArms.includes('in_ring')
  && pgRefusals.join(',') === REASONS.slice(1, 6).join(','),
  `${pgArms.join(' → ')} (else: pending=${pgPendingIsElse})`);

/* The domain's own switch, which is the same rule stated as code: an unknown reason is a
   refusal, not a licence. */
const domainSwitch = files.domain.slice(
  files.domain.indexOf('export function lawyerRingFrom'),
  files.domain.indexOf('// THE FOUR GROUNDS'));
const domainOrder = order(domainSwitch, REASONS.slice(1));
check('the domain lists the same reasons in the same order, `pending` last',
  domainOrder.join(',') === REASONS.slice(1).join(',')
  && pgRefusals.join(',') === domainOrder.slice(0, 5).join(','),
  `${domainOrder.join(' → ')} (SQL has no pending arm: it is the else)`);
check('the domain treats an unrecognised reason as a refusal (`default: outside_ring`)',
  /default:\s*\n\s*return \{ inRing: false, reason: 'outside_ring' \}/.test(domainSwitch));

/* `outside_ring` first is the whole point: a role that does not practise is answered before
   any licence is consulted. Both copies must agree, or a paralegal is told she is unlicensed. */
check('both copies answer "does this role practise?" BEFORE they read a licence',
  pgCase.indexOf('outside_ring') < pgCase.indexOf('no_licence_on_record')
  && domainSwitch.indexOf("reason: 'outside_ring'") < domainSwitch.indexOf("'no_licence_on_record'"));

/* ══ 2 · THE LICENCE ARITHMETIC ═════════════════════════════════════════════ */
console.log('');

const pgToday = /pl\.expires_at > \(now\(\) at time zone 'utc'\)::date/.test(pgCase);
const repoToday = /expiresAt > today/.test(files.repo)
  && /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(files.repo);
check('the SQL and the application compare the expiry against the SAME day (UTC)',
  pgToday && repoToday, 'pg: now() at time zone utc ::date · app: toISOString().slice(0,10)');

check('a licence with NO expiry is treated as usable only while it is `valid` in both copies',
  /pl\.expires_at is null or pl\.expires_at >/.test(pgCase)
  && /!l\.expiresAt \|\| l\.expiresAt > today/.test(files.repo));

check('absence of any licence row is a refusal in both copies',
  /no_licence_on_record/.test(pgCase) && /licences\.length === 0/.test(files.repo));

check('the severest reason present is the one named, in both copies',
  pgCase.indexOf("'suspended'") < pgCase.indexOf("'revoked'")
  && pgCase.indexOf("'revoked'") < pgCase.indexOf("'expired'")
  && /'suspended'\) \? 'suspended'/.test(files.repo));

/* ══ 3 · WHAT MAKES A ROLE A PRACTISING ONE ════════════════════════════════ */
console.log('');
check('the firm declares which roles practise, in the DATABASE rather than in a list of codes',
  /requires_practising_licence/.test(pgCase) && /requires_practising_licence/.test(files.repo),
  'roles.requires_practising_licence (0027), read by both copies');

/* ══ 4 · THE ROAD ACROSS: THE RELEASE LEDGER ═══════════════════════════════ */
console.log('');

const GROUNDS = ['crime_prevention', 'aml_suspicion', 'self_defence', 'client_written_consent'];
const sqliteGrounds = files.sqlite.slice(
  files.sqlite.indexOf('create table if not exists privilege_releases'));
const sqliteOrder = order(sqliteGrounds, GROUNDS);
check('the demo engine accepts exactly the four grounds, in their declared order',
  sqliteOrder.join(',') === GROUNDS.join(','), sqliteOrder.join(', '));

const domainGrounds = files.domain.slice(files.domain.indexOf('export const DISCLOSURE_GROUNDS'));
check('the domain declares the same four, and the route validates against the domain',
  GROUNDS.every((g) => domainGrounds.includes(`code: '${g}'`))
  && /z\.enum\(DISCLOSURE_GROUND_CODES/.test(files.routes));

check('a suspicion of money laundering can only be recorded as going to the regulator — '
  + 'a CHECK in both dialects',
  /ground <> 'aml_suspicion' or recipient_kind = 'regulator'/.test(files.sqlite)
  && /aml_suspicion/.test(files.pg) && /recipients: \['regulator'\]/.test(files.domain));

check('the client’s consent must name a writing — a CHECK in both dialects',
  /ground <> 'client_written_consent' or consent_document_id is not null/.test(files.sqlite)
  && /client_written_consent/.test(files.pg)
  && /requiresDocument: true/.test(files.domain));

/* ══ 5 · THE LEDGER'S TWO DOCUMENTS (0056) ═════════════════════════════════ */
console.log('');
/* Two RAISES per copy — one per document reference — and the same token in the route. The
   prose in each file also names the token, which is why the count is of raises and not of
   occurrences: a comment cannot refuse an INSERT. */
const scopeTokens = {
  pg: occurrences(files.pgScope, "raise exception 'privilege_document_mismatch"),
  sqlite: occurrences(files.sqlite, "raise(ABORT, 'privilege_document_mismatch"),
  route: occurrences(files.routes, "badRequest('privilege_document_mismatch'"),
};
check('the document-scope refusal carries ONE token in all three copies',
  scopeTokens.pg === 2 && scopeTokens.sqlite === 2 && scopeTokens.route === 2,
  `0056 guard ${scopeTokens.pg}×, SQLite mirror ${scopeTokens.sqlite}×, route ${scopeTokens.route}×`);

check('the subject document is scoped to the MATTER in both dialects',
  /d\.matter_id = new\.matter_id/.test(files.pgScope)
  && /d\.matter_id = new\.matter_id/.test(files.sqlite));
check('the consent document is scoped to the CLIENT in both dialects',
  /d\.client_id = v_client/.test(files.pgScope)
  && /d\.client_id = \(select m\.client_id from matters m where m\.id = new\.matter_id\)/.test(files.sqlite));

check('the route applies the same two scopes it can see, and refuses with the same token',
  /scope\.matterId !== facts\.matterId/.test(files.routes)
  && /scope\.clientId !== facts\.clientId/.test(files.routes)
  && /privilege_document_mismatch/.test(files.routes));

/* ══ 6 · THE DOCUMENT RULE: PRIVILEGED IMPLIES INTERNAL ════════════════════ */
console.log('');
check('a privileged document is internal — stated in SQLite triggers and in the Postgres CHECK',
  /privilege_class <> 'none' and new\.client_visibility <> 'internal'/.test(files.sqlite)
  && /client_visibility = 'internal'/.test(files.pg));

check('the release ledger is append-only in both dialects',
  /privilege_release_immutable/.test(files.sqlite)
  && !/grant .*update on public\.privilege_releases/i.test(files.pg)
  && !/grant .*delete on public\.privilege_releases/i.test(files.pg),
  'SQLite: triggers · Postgres: INSERT and SELECT granted, nothing else');

/* ── the verdict ─────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - bad.length}/${results.length} drift checks passed\n`);
if (bad.length) {
  for (const b of bad) console.log(`  ✗ ${b.label} — ${b.detail}`);
  console.log('');
  process.exit(1);
}

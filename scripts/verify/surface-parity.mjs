#!/usr/bin/env node
/**
 * SURFACE PARITY · the four descriptions of the same system, compared
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 *   This system is described four times over, and each description is maintained
 *   somewhere else:
 *
 *     the ROUTES      server/src/api/*.routes.ts     what the server ANSWERS
 *     the CLIENT      firm/src/api/firm.ts · web/src/api/client.ts   what the UI ASKS
 *     the SCREENS     firm/src/**, web/src/**        what the UI SHOWS
 *     the CATALOGUE   server/src/domain/firm-catalogue.ts   what any of it MEANS
 *
 *   A disagreement between them is never a crash. It is a screen that is never
 *   shown, a route nobody can reach, or a permission that means nothing — and
 *   because none of those throw, none of them are noticed. Four rounds of "the
 *   list and the build disagree" happened because this comparison was done by
 *   reading. It is mechanical now.
 *
 * WHAT IT CANNOT SEE
 *
 *   Whether a route that HAS a caller is any good, whether a screen that has a
 *   route is reachable from the nav, or anything at all about a route that is
 *   called correctly from a screen that is never rendered. It finds ORPHANS. The
 *   judgement about which orphans are deliberate is a human's, and the report is
 *   written so that a human can make it quickly.
 *
 * USAGE
 *   node scripts/verify/surface-parity.mjs             # the report
 *   node scripts/verify/surface-parity.mjs --strict    # exit 1 on any finding
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => (existsSync(`${ROOT}/${p}`) ? readFileSync(`${ROOT}/${p}`, 'utf8') : '');
/*
  COMMENTS ARE NOT CODE, AND THIS FILE IS LARGELY COMMENTS.

  The nav's own explanation of why `clients` carries a gate quotes the gate it
  does NOT carry — "`permissions: []` would mean every authenticated member sees
  Clients" — and a scanner that reads comments found that first and reported the
  Clients module as ungated. Every extraction below reads the stripped source.
  The prose stays in the file; it is simply not evidence of what the code does.
*/
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/** The path up to the first query string or interpolated helper. A route is
 *  consumed when the call's BASE matches it, because `/clients${q({...})}` is a
 *  call to `/clients` and nothing else. */
const baseOf = (p) => {
  /*
    WHERE A PATH STOPS BEING A PATH.

    A query string ends it (`/clients?a=b`), but an interpolation does NOT — the
    distinction is what precedes the `${`:
        `/matters/${id}/documents`   a PATH PARAMETER — part of the route
        `/clients${q({ limit })}`    a QUERY SUFFIX   — not part of the route
    Cutting at every `${` turned the first into `/matters` and reported four
    working methods as broken. A slash before the brace means a segment, anything
    else means a suffix.
  */
  const q = p.indexOf('?');
  const cut = q === -1 ? p.length : q;
  const m = p.slice(0, cut).match(/[^/]\$\{/);
  return p.slice(0, m ? m.index + 1 : cut).replace(/\/+$/, '');
};
const norm = (p) => p
  .replace(/\?[^`'"]*$/, '')
  .replace(/\$\{[^}]*\}/g, ':x')
  .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, ':x')
  .replace(/\/+$/, '')
  .replace(/^\/+/, '');

function walk(dir, exts, out = []) {
  if (!existsSync(`${ROOT}/${dir}`)) return out;
  for (const entry of readdirSync(`${ROOT}/${dir}`)) {
    const rel = `${dir}/${entry}`;
    if (statSync(`${ROOT}/${rel}`).isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => rel.endsWith(e))) out.push(rel);
  }
  return out;
}

/* ══ 1 · THE ROUTES, BY MOUNT ═══════════════════════════════════════════════ */
const APPS = {
  firm: { mount: '/api/firm', routeFile: 'server/src/api/firm.routes.ts', clientFile: 'firm/src/api/firm.ts', uiDir: 'firm/src' },
  portal: { mount: '/api/client', routeFile: 'server/src/api/client.routes.ts', clientFile: 'web/src/api/client.ts', uiDir: 'web/src' },
};

const routes = new Map(); // `${app} ${METHOD} ${path}` -> file
for (const [app, cfg] of Object.entries(APPS)) {
  const src = read(cfg.routeFile);
  for (const m of src.matchAll(/\br\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    routes.set(`${app} ${m[1].toUpperCase()} ${norm(m[2])}`, cfg.routeFile);
  }
  /* The multer-mounted upload routes are still `r.post`; nothing extra to catch. */
}

/* ══ 2 · THE FIRM'S CLIENT: method name → route, and who uses each method ═══ */
const firmClientSrc = read(APPS.firm.clientFile);
const firmMethods = new Map(); // name -> `${METHOD} ${path}`
const firmMethodAliases = new Map(); // name -> the full path when a query one exists
{
  /*
    SPLIT ON METHOD BOUNDARIES, NOT ON A WHOLE-METHOD REGEX.
    A signature in this file can carry an object type in its arguments and a union
    in its return type, and a regex that tries to swallow `(args) { ... }` whole
    either fails on those or silently matches the wrong close. Splitting at each
    two-space-indented `name(` and reading forward to the next one cannot: a
    method's body is whatever lies between it and its neighbour.
  */
  /*
    A BOUNDARY IS `name(`, AND ONLY `name(`.
    Accepting `name:` or `name<` as a boundary looked harmless and was not: this
    file wraps long signatures, so a return type on its own line —
        async updateMatterReport(id: string, patch: MatterReportPatch)
        Promise<{ ... }> {
    — registered `Promise` as a method, and the real method's body was cut short
    before the `request(` it ends with. The caller then looked like a screen that
    never asks for the report, which is the opposite of the truth. Requiring the
    parenthesis, and skipping the language keywords, fixes both halves.
  */
  const boundaries = [...firmClientSrc.matchAll(/\n  (?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/g)];
  for (let i = 0; i < boundaries.length; i++) {
    const name = boundaries[i][1];
    if (/^(if|for|while|switch|catch|else|return|await|const|let|var|Promise|function|new|throw|describe|it|test)$/.test(name)) continue;
    const body = firmClientSrc.slice(boundaries[i].index, boundaries[i + 1]?.index ?? firmClientSrc.length);
    const path = body.match(/request(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)[`'"]/);
    if (!path) continue;
    const mm = body.match(/method:\s*'([A-Z]+)'/);
    const full = norm(path[1]);
    const base = norm(baseOf(path[1]));
    /* A method that builds a query string calls its BASE route: `/clients?a=b`
       must not read as a call to a route named `clients:a:b`. */
    firmMethods.set(name, `${mm ? mm[1] : 'GET'} ${base === full ? full : base}`);
    if (base !== full) firmMethodAliases.set(name, `${mm ? mm[1] : 'GET'} ${full}`);
  }
}
const firmUsed = new Set();
for (const f of walk(APPS.firm.uiDir, ['.ts', '.tsx'])) {
  const src = read(f);
  for (const m of src.matchAll(/\bfirmApi\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g)) firmUsed.add(m[1]);
}
/* A method reached only through the auth provider or a hook still counts as used;
   the scan above covers every file under the app directory. */

const firmConsumed = new Set();
for (const name of firmUsed) {
  const route = firmMethods.get(name);
  if (route) firmConsumed.add(`firm ${route}`);
}
/*
  METHODS THAT RETURN A URL INSTEAD OF CALLING ONE.
  `matterDocumentContentUrl()` exists so the browser carries the httpOnly session
  cookie on a navigation — a link, not a fetch — and a scanner that only follows
  `request(` reports the content route as unreachable when a screen links to it.
  So: for every method a screen USES, take any template literal in its body that
  looks like a path and count that route as consumed.
*/
{
  const boundaries = [...firmClientSrc.matchAll(/\n  (?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*[(:<]/g)];
  for (let i = 0; i < boundaries.length; i++) {
    const name = boundaries[i][1];
    if (!firmUsed.has(name)) continue;
    const body = firmClientSrc.slice(boundaries[i].index, boundaries[i + 1]?.index ?? firmClientSrc.length);
    /*
      A URL BUILDER IS READ AS ONE STRING, NOT AS ITS LITERALS.
      `matterDocumentContentUrl` writes `${API_BASE}/matters/${id}/documents/` on one
      line and `/content?disposition=` on the next, joined by a `+`. A per-literal
      scan sees `matters` and `content` separately and reports the route
      unreachable. So the literals are concatenated first, then the path is taken
      from the first ROOT segment onwards — which also copes with whatever prefix
      the next builder chooses.
    */
    const joined = [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join('');
    const roots = /\/(matters|clients|documents|session|admin|billing|trust|parties|eligibility|rate-cards|time-entries|expenses|judgments|court-calendar|compliance|due-diligence|str-reports|conflicts|screening-matches|engagement-letters|dashboard)\//;
    const at = joined.match(roots);
    if (at) {
      firmConsumed.add(`firm GET ${norm(joined.slice(at.index + 1))}`);
    }
  }
}

/* ══ 3 · THE PORTAL'S CLIENT: literal paths, and who uses each ═════════════ */
/*
  THE PORTAL'S CALL SITES ARE PATHS, NOT METHODS — `get('/api/client/invoices')`,
  `post(...)`. So a route counts as consumed when its PATH is called by any
  method. That under-reports a dead METHOD and never over-reports a dead route,
  which is the right way round for a report whose findings a human acts on.
*/
const portalPathsCalled = new Set();
let portalCallSites = 0;
{
  for (const f of walk('web/src', ['.ts', '.tsx'])) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:get|post|patch|del)(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const raw = m[1];
      if (!raw.startsWith('/api/client')) continue;
      portalCallSites++;
      const bare = raw.replace(/^\/api\/client\/?/, '');
      const p = norm(bare);
      const base = norm(baseOf(bare));
      if (p) portalPathsCalled.add(p);
      if (base) portalPathsCalled.add(base);
    }
    if (/\bupload\(/.test(src)) { portalPathsCalled.add('documents'); portalCallSites++; }
    if (/\bopenDocument\(/.test(src)) { portalPathsCalled.add('documents/:x/access-url'); portalCallSites++; }
  }
}

/* ══ 4 · THE CATALOGUE ═════════════════════════════════════════════════════ */
const catalogueSrc = read('server/src/domain/firm-catalogue.ts');
const catalogue = new Set([...catalogueSrc.matchAll(/code:\s*"([a-z][a-z0-9_.]*\.[a-z0-9_.]+)"/g)].map((m) => m[1]));
const granted = new Set();
{
  const block = catalogueSrc.slice(catalogueSrc.indexOf('TEMPLATE_GRANTS'));
  for (const m of block.matchAll(/"([a-z][a-z0-9_.]*\.[a-z0-9_.]+)"/g)) granted.add(m[1]);
}

/* Who NAMES a permission: the server enforces, the UI checks.
 *
 * ACCURACY, TAKE FOUR. The first version looked for a code as the literal
 * argument of a known gate — `assertCan(p, 'billing.writeoff')`. That is one of
 * the ways this server names a permission and not the only one: a route that
 * branches on the direction of the money writes
 *
 *     assertCan(p, outgoing ? 'billing.writeoff' : 'billing.record_payment', …)
 *
 * and the pattern, requiring a quote right after the comma, matched neither — so
 * two codes that ARE enforced were reported as names nothing. An audit that
 * over-reports is worse than no audit, because the real findings drown.
 *
 * So the rule is now positional and module-aware: in a file that enforces
 * permissions, any quoted `module.code` whose FIRST segment is a real catalogue
 * module counts as named. Nothing else in these files wears that shape — error
 * codes are snake_case with no dot, audit actions are UPPER_SNAKE, and a filename
 * like 'scan.pdf' can only be mistaken for a permission if `scan` were a module.
 */
const modules = new Set([...catalogue].map((c) => c.split('.')[0]));
const codeShape = new RegExp(`'((?:${[...modules].join('|')})\\.[a-z0-9_.]+)'`, 'g');
/*
 * …and the wide shape is for the SERVER only. The firm app's i18n dictionary is
 * keyed `module.word` — `clients.title`, `users.col.name`, `audit.outcome.success`
 * — so the same rule there matches hundreds of translation keys and drowns the
 * section. In the UI a permission is only a permission when it is inside a gate:
 * `can(…)`, `canAny([…])`, `has(…)`, or a nav entry's `permissions: [ … ]`.
 */
const gateShape = /(?:can\(|canAny\(\s*\[\s*|has\(|permissions:\s*\[\s*)'([a-z][a-z0-9_.]*\.[a-z0-9_.]+)'/g;

const enforced = new Map();
const uiChecks = new Map();
const add = (bag, code, where) => {
  if (!bag.has(code)) bag.set(code, new Set());
  bag.get(code).add(where);
};
for (const f of ['server/src/api/firm.routes.ts', 'server/src/api/client.routes.ts', 'server/src/domain/permissions.ts',
  'server/src/auth/firm-middleware.ts', 'server/src/domain/firm-documents.ts']) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(codeShape)) add(enforced, m[1], f.split('/').pop());
}
for (const f of walk('firm/src', ['.ts', '.tsx'])) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(gateShape)) add(uiChecks, m[1], f.replace('firm/src/', ''));
}

/* ══ 5 · THE NAV ═══════════════════════════════════════════════════════════ */
const navSrc = stripComments(read('firm/src/app/nav.ts'));
const navItems = [];
{
  /* The tree, object by object. Group-level entries (`to:` with no leaves) and
     childless groups both appear, because both are destinations in the rail. */
  const tree = navSrc.slice(navSrc.indexOf('const GROUP_DEFS'), navSrc.indexOf('Derives a group'));
  const objects = tree.match(/\n  \{\n([\s\S]*?)\n  \},/g) ?? [];
  for (const obj of objects) {
    const id = obj.match(/id:\s*'([^']+)'/)?.[1];
    const to = obj.match(/to:\s*'([^']+)'/)?.[1];
    const leaves = [...obj.matchAll(/\{ id: '([^']+)', to: '([^']+)'[^}]*permissions:\s*\[([^\]]*)\]/g)]
      .map((m) => ({ id: m[1], to: m[2], permissions: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]) }));
    if (leaves.length) { navItems.push(...leaves); continue; }
    if (to) {
      const perms = obj.match(/permissions:\s*\[([^\]]*)\]/);
      navItems.push({ id, to, permissions: perms ? [...perms[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [] });
    }
  }
}
const appRoutes = new Set();
{
  const app = read('firm/src/App.tsx');
  for (const m of app.matchAll(/(?:case\s+|path\s*===\s*|path\.startsWith\()'([^']+)'/g)) appRoutes.add(m[1]);
}

/* ══ 5b · WHICH FIRM ROUTES CHECK A PERMISSION ═════════════════════════════ */
const ungated = [];
{
  const src = stripComments(read(APPS.firm.routeFile));
  const hits = [...src.matchAll(/\br\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)];
  for (let i = 0; i < hits.length; i++) {
    const body = src.slice(hits[i].index, hits[i + 1]?.index ?? src.length);
    /*
      DELIBERATELY GENEROUS. This is a list of routes that check NOTHING, so it is
      better to miss one than to accuse a route that is in fact gated — an audit
      report with a false accusation gets ignored, which costs more than the one
      finding it would have made. Every form the permission engine is used in:
      `assertCan`, `assertCanAny`, `assertAny`, `permissions.can`, `permissions.has`,
      `requireMatter` (which is the access-level gate), and the `MATTER_*` level
      constants those calls pass.
    */
    const gated = /c\.permissions\.|requireMatter\(|assertCan|assertAny|MATTER_[A-Z]+/.test(body);
    if (!gated) ungated.push(`${hits[i][1].toUpperCase()} ${norm(hits[i][2])}`);
  }
}

/* ══ 6 · THE REPORT ════════════════════════════════════════════════════════ */
const out = [];
const L = (s = '') => out.push(s);
L('');
L('  SURFACE PARITY — routes · clients · screens · catalogue');
L(`  ${'─'.repeat(76)}`);
L(`  routes      firm ${[...routes.keys()].filter((k) => k.startsWith('firm ')).length}` +
  `   portal ${[...routes.keys()].filter((k) => k.startsWith('portal ')).length}`);
L(`  client      firm ${firmMethods.size} methods (${firmUsed.size} used by a screen)` +
  `   portal ${portalCallSites} call sites`);
L(`  catalogue   ${catalogue.size} permission codes`);

/* (1) Firm routes no screen asks for. */
L('');
L('  1 · FIRM ROUTES NO FIRM SCREEN REQUESTS');
L('      (the API can do this and the product cannot reach it)');
const deadFirm = [...routes.entries()].filter(([k]) => k.startsWith('firm ') && !firmConsumed.has(k));
const group = (list) => {
  const byPrefix = new Map();
  for (const [k] of list) {
    const key = k.split(' ')[2].split('/')[0] || '(root)';
    byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
  }
  return [...byPrefix.entries()].sort((a, b) => b[1] - a[1]);
};
if (deadFirm.length === 0) L('    (none)');
for (const [prefix, n] of group(deadFirm)) L(`    ${String(n).padStart(3)}  ${prefix}`);
L('');
for (const [k] of deadFirm) L(`         ${k.replace('firm ', '')}`);

/* (2) Portal routes no portal screen asks for. */
L('');
L('  2 · PORTAL ROUTES NO PORTAL SCREEN REQUESTS');
const deadPortal = [...routes.entries()].filter(([k]) => {
  if (!k.startsWith('portal ')) return false;
  const path = k.replace(/^portal [A-Z]+ /, '');
  if (portalPathsCalled.has(path)) return false;
  /* A nested route is reached when a prefix of it is; `/documents/:x` under `/documents`. */
  return ![...portalPathsCalled].some((c) => path.startsWith(`${c.split('/:x')[0]}/`));
});
if (deadPortal.length === 0) L('    (none)');
for (const [k] of deadPortal) L(`         ${k.replace('portal ', '')}`);

/* (3) Client methods pointing at routes that do not exist. */
L('');
L('  3 · CLIENT METHODS CALLING A ROUTE THAT DOES NOT EXIST');
const missing = [];
for (const [name, route] of firmMethods) {
  if (!routes.has(`firm ${route}`)) missing.push(`${route}  ← firmApi.${name}()`);
}
if (missing.length === 0) L('    (none)');
for (const m of missing) L(`    ${m}`);

/* (4) Client methods no screen calls. */
L('');
L('  4 · FIRM CLIENT METHODS NO SCREEN CALLS');
const unusedMethods = [...firmMethods.keys()].filter((n) => !firmUsed.has(n));
if (unusedMethods.length === 0) L('    (none)');
for (const n of unusedMethods) L(`    firmApi.${n}()`);

/* (5) A permission the UI checks that the catalogue lacks. */
L('');
L('  5 · PERMISSION CODES THE UI CHECKS THAT THE CATALOGUE DOES NOT DEFINE');
L('      (the control using one can never render, and nothing logs a complaint)');
const ghost = [...uiChecks.entries()].filter(([c]) => !catalogue.has(c));
if (ghost.length === 0) L('    (none)');
for (const [c, where] of ghost) L(`    ${c.padEnd(34)} ${[...where].join(', ')}`);

/* (6) A gate no role is granted. */
L('');
L('  6 · GATES THE SERVER ENFORCES THAT NO ROLE TEMPLATE GRANTS');
L('      (the route refuses everyone, including the managing partner)');
const unreachable = [...enforced.entries()]
  .filter(([c]) => catalogue.has(c) && !granted.has(c) && !c.startsWith('dev.'));
if (unreachable.length === 0) L('    (none)');
for (const [c, where] of unreachable) L(`    ${c.padEnd(34)} ${[...where].join(', ')}`);

/* (7) Catalogue codes nothing names. */
L('');
L('  7 · CATALOGUE CODES NOTHING ENFORCES AND NO SCREEN CHECKS');
const unused = [...catalogue].filter((c) => !enforced.has(c) && !uiChecks.has(c));
L(`    ${unused.length} of ${catalogue.size}`);
for (const c of unused) L(`    ${c}`);

/* (8) Nav entries with no route in the app. */
L('');
L('  8 · NAV ENTRIES WHOSE PATH THE APP DOES NOT ROUTE');
const orphans = navItems.filter((n) => !appRoutes.has(n.to) && n.to !== '/');
if (orphans.length === 0) L('    (none)');
for (const o of orphans) L(`    ${o.id.padEnd(16)} ${o.to}`);

/* (8b) Firm routes with no permission check in their own body. */
L('');
L('  8b · FIRM ROUTES THAT CHECK NO PERMISSION');
L('       (authentication only — some are deliberate: whoami, CSRF, health)');
if (ungated.length === 0) L('    (none)');
for (const r of ungated) L(`    ${r}`);

/* (9) The nav, for cross-checking by eye. */
L('');
L('  9 · THE NAV AS DECLARED');
for (const n of navItems) {
  const has = appRoutes.has(n.to) || n.to === '/';
  L(`    ${has ? '·' : '?'} ${n.to.padEnd(18)} ${n.id.padEnd(12)} ${n.permissions.join(', ') || '(every member)'}`);
}

L('');
const findings = deadFirm.length + deadPortal.length + missing.length + unusedMethods.length
  + ghost.length + unreachable.length + orphans.length;
L(`  ${findings} finding(s). ${unused.length} catalogue code(s) that nothing names.`);
L('  A finding is not automatically a defect — see docs/GAP-ANALYSIS-III.md for which are deliberate.'.replace(/^/, '  '));
L('');

console.log(out.join('\n'));
if (process.argv.includes('--strict') && findings > 0) process.exit(1);

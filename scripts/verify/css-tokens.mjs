#!/usr/bin/env node
/**
 * CSS TOKEN INTEGRITY · every `var(--x)` that nothing defines
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 *   A CSS custom property that nothing defines is not an error anywhere. The
 *   declaration is dropped, the element renders with whatever it inherited or with
 *   nothing at all, and the browser reports nothing. Two real defects in this
 *   codebase were exactly that:
 *
 *     · `.kgm-overlay__panel` carried no `background` at all, so every dialog,
 *       drawer and bottom sheet in the Firm OS was a translucent wash over the
 *       blurred page — and the tiles inside it were LESS opaque than the panel
 *       behind them, which is why the More sheet's modules looked like plain text.
 *     · `.sheet` in the portal sets `background: var(--bg)` and `--bg` is defined
 *       nowhere in that stylesheet, so the portal's More sheet is a full-screen
 *       fixed layer with no surface of its own.
 *
 *   Neither is a typo a linter catches: `--bg` is a perfectly well-formed name.
 *
 * WHAT IT CHECKS
 *
 *   For each BUNDLE (the set of stylesheets an app actually imports), every
 *   `var(--x)` reference must resolve to a definition in that bundle. A use with
 *   a FALLBACK (`var(--x, #fff)`) is reported separately — it degrades on purpose,
 *   so it is a decision rather than a defect.
 *
 * USAGE
 *   node scripts/verify/css-tokens.mjs
 *   node scripts/verify/css-tokens.mjs --strict
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const ROOT = process.cwd();
const read = (p) => (existsSync(`${ROOT}/${p}`) ? readFileSync(`${ROOT}/${p}`, 'utf8') : '');

/**
 * TOKENS SET AT RUNTIME, WHICH ARE DEFINED EVEN THOUGH NO STYLESHEET SAYS SO.
 *
 * The bottom nav's sliding lamp is positioned by React — `style={{ '--lamp-start':
 * `${x}px` }}` — because only the layout knows where the active slot is. That is a
 * definition; a checker that only reads CSS would call it a defect and teach
 * everyone to ignore the report. So the app's own source is scanned for inline
 * custom properties and those count as defined.
 */
function runtimeTokens(dirs) {
  const found = new Set();
  const walk = (dir) => {
    if (!existsSync(`${ROOT}/${dir}`)) return;
    for (const entry of readdirSync(`${ROOT}/${dir}`)) {
      const rel = `${dir}/${entry}`;
      if (statSync(`${ROOT}/${rel}`).isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(rel)) {
        const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of src.matchAll(/['"]--([a-z0-9-]+)['"]\s*:/gi)) found.add(m[1]);
      }
    }
  };
  for (const d of dirs) walk(d);
  return found;
}

const BUNDLES = {
  'firm OS': [
    'packages/ui/src/styles/tokens.css',
    'packages/ui/src/styles/fonts.css',
    'packages/ui/src/styles/base.css',
    'packages/ui/src/styles/primitives.css',
    'packages/ui/brand/logo.css',
    'firm/src/shell/shell.css',
  ],
  portal: [
    'web/src/styles.css',
  ],
};

let failed = 0;
const strict = process.argv.includes('--strict');

for (const [name, files] of Object.entries(BUNDLES)) {
  const defined = new Set();
  for (const t of runtimeTokens(name === 'portal' ? ['web/src'] : ['firm/src'])) defined.add(t);
  const uses = new Map(); // token -> [{ file, hasFallback }]
  const perFile = new Map();

  for (const file of files) {
    const src = read(file);
    if (!src) continue;
    const own = new Set();
    /* A definition is `--x:` at the start of a declaration. Comments are stripped
       first: this codebase explains itself at length, and prose about a token is
       not a definition of one. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/(^|[;{\s])--([a-z0-9-]+)\s*:/gi)) {
      defined.add(m[2]);
      own.add(m[2]);
    }
    perFile.set(file, own);
    for (const m of code.matchAll(/var\(\s*--([a-z0-9-]+)\s*(,)?/gi)) {
      const token = m[1];
      if (!uses.has(token)) uses.set(token, []);
      uses.get(token).push({ file, fallback: Boolean(m[2]) });
    }
  }

  const missing = [];
  const fallbacked = [];
  for (const [token, sites] of uses) {
    if (defined.has(token)) continue;
    const anyFallback = sites.every((s) => s.fallback);
    const where = [...new Set(sites.map((s) => s.file.replace(/^(packages\/ui\/src\/styles\/|firm\/src\/|web\/src\/)/, '')))];
    (anyFallback ? fallbacked : missing).push({ token, count: sites.length, where });
  }

  console.log('');
  console.log(`  ${name.toUpperCase()} · ${files.length} stylesheet(s), ${defined.size} tokens defined (stylesheet + runtime)`);
  console.log(`  ${'─'.repeat(72)}`);

  if (missing.length === 0) {
    console.log('  ✓ every var(--…) reference resolves');
  } else {
    failed += missing.length;
    console.log(`  ✗ ${missing.length} token(s) referenced with NO definition anywhere in the bundle:`);
    console.log('    (the declaration is dropped silently — the element renders with no value)');
    for (const m of missing.sort((a, b) => b.count - a.count)) {
      console.log(`      --${m.token.padEnd(26)} ${String(m.count).padStart(3)} use(s)  ${m.where.join(', ')}`);
    }
  }

  if (fallbacked.length > 0) {
    console.log(`  · ${fallbacked.length} token(s) used only with a fallback (deliberate, reported for the record):`);
    for (const m of fallbacked.sort((a, b) => b.count - a.count).slice(0, 12)) {
      console.log(`      --${m.token.padEnd(26)} ${String(m.count).padStart(3)} use(s)  ${m.where.join(', ')}`);
    }
  }
}
console.log('');
if (strict && failed > 0) process.exit(1);

/**
 * KGM LEGAL OS — ASSEMBLE THE SINGLE DEPLOYMENT
 *
 *   node scripts/build-vercel.mjs
 *
 * Builds both SPAs and lays them out as ONE site:
 *
 *     public/               the client portal      served at  /
 *     public/firm/          the internal Firm OS   served at  /firm
 *     api/[...path].ts      the API                served at  /api/*
 *
 * WHY ONE OUTPUT DIRECTORY AND NOT TWO PROJECTS
 *   The portal, the firm OS and the API must share an origin. The portal's API
 *   client calls relative paths with `credentials: 'same-origin'` and the firm
 *   session cookie is `SameSite=strict`, so a second domain would mean the browser
 *   never attaches the session cookie and authentication would fail by design.
 *   Serving them from one project is what makes the cookies work without loosening
 *   any of that.
 *
 * WHY THE FIRM OS GOES UNDER A SUBPATH
 *   `firm/` is a separate Vite app with its own absolute asset URLs. Vite prefixes
 *   them with `base`, so the firm build is produced with `--base=/firm/` and the
 *   assets land at `/firm/assets/...`. Without that, the firm SPA's bundles would
 *   be requested from the portal's `/assets/` and the two apps would collide on
 *   hashed filenames from different builds.
 *
 * WHY AN EMPTY `public/` IS CLEANED FIRST
 *   A stale `public/` from a previous run would ship a mixture of two builds'
 *   hashed assets. The HTML would reference the new hashes and the old ones would
 *   simply sit there — harmless but shipped, and eventually an old build's HTML
 *   gets served for a path the new build no longer emits.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const step = (msg) => console.log(`\n  ${msg}`);
const run = (cmd, args) => {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else fs.copyFileSync(src, dest);
  }
}

/**
 * Vercel serves `/firm` and `/firm/` as a directory index only if the file is
 * `index.html` inside it — which the Vite build already produces. This is a
 * sanity check that the build actually emitted both entry points, because a
 * missing `index.html` produces a 404 that looks like a routing bug in
 * `vercel.json` and is actually a build that silently did nothing.
 */
function assertEntry(dir, label) {
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error(`${label}: no index.html at ${index} — the build did not produce a bundle.`);
  }
  const html = fs.readFileSync(index, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+|\/firm\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !fs.existsSync(path.join(PUBLIC, r.replace(/^\//, ''))));
  if (missing.length) {
    throw new Error(`${label}: index.html references asset(s) that were not emitted: ${missing.join(', ')}`);
  }
  return refs.length;
}

step('KGM LEGAL OS — building the single deployment');

step('1/4  client portal  (web)');
run('npm', ['run', 'build', '--workspace', 'web']);

step('2/4  firm OS  (firm, base=/firm/)');
/*
  `--base=/firm/` is passed on the command line rather than written into the Vite
  config, so the firm app keeps working at `/` when it is run standalone
  (`npm run dev:firm`) — which it still is, during development and in its own
  test suite. Hardcoding the base would break that for no benefit.
*/
run('npm', ['run', 'build:demo', '--workspace', 'firm', '--', '--base=/firm/']);

step('3/4  assembling public/');
fs.rmSync(PUBLIC, { recursive: true, force: true });
copyDir(path.join(ROOT, 'web', 'dist'), PUBLIC);
copyDir(path.join(ROOT, 'firm', 'dist'), path.join(PUBLIC, 'firm'));

const portalRefs = assertEntry(PUBLIC, 'portal');
const firmRefs = assertEntry(path.join(PUBLIC, 'firm'), 'firm OS');
console.log(`  portal  ${portalRefs} asset reference(s), firm OS ${firmRefs} — all present`);

step('4/4  done');
const size = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
};
const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(`  public/       ${kb(size(PUBLIC))}`);
console.log(`  public/firm/  ${kb(size(path.join(PUBLIC, 'firm')))}`);
console.log('  API           /api/*  ->  api/[...path].ts');
console.log('');

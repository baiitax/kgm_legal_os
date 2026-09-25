/**
 * DEPLOY CHECK · does what is actually being served contain what was built?
 *
 *   node scripts/verify/deploy-check.mjs [base-url]
 *
 * WHY THIS EXISTS
 *   Two faults this turn were invisible to every other check:
 *
 *     1. The demo credentials were absent from the shipped bundle. `SHOW_DEMO_ACCOUNTS`
 *        is a build-time constant, so with the flag unset the entire list is dead
 *        code and the bundler removes it — passwords and all. The build succeeded,
 *        typecheck passed, every test passed, the page loaded and rendered a
 *        perfectly good sign-in form. It was simply not the form the demo needed.
 *
 *     2. A CSS fix can be present in the source, pass a stylesheet test, survive
 *        the build, and still be the wrong declaration in the artefact a browser
 *        receives — or be dropped by a minifier that disagrees with the syntax.
 *
 *   So this asserts on the SERVED bytes, followed transitively to the hashed
 *   chunk that holds them. It is the only check that can catch "the deployment
 *   does not contain the change", which is otherwise indistinguishable from
 *   "the change did not work".
 */
const BASE = (process.argv[2] ?? process.env.KGM_BASE ?? 'https://kgmlegal.vercel.app').replace(/\/$/, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
};

/**
 * Every byte the browser will execute or apply for a page, followed to the end.
 *
 * A BREADTH-FIRST CRAWL, because a single pass is not enough. The page's HTML
 * names one entry chunk; that chunk names the rest with RELATIVE dynamic imports
 * (`import("./Login-DKuKrF7C.js")`), which carry no `assets/` prefix and are
 * resolved against the importing chunk's own directory. A scan that only looked
 * for `assets/*.js` found seventeen chunks, missed the login route, and reported
 * a working deployment as missing its credentials — a false alarm that would
 * have been worse than no check at all, because it trains you to ignore it.
 */
async function assetsFor(path) {
  const seen = new Set();
  const bodies = [];
  const queue = [new URL(path, BASE)];

  while (queue.length) {
    const url = queue.shift();
    const key = url.href;
    if (seen.has(key) || seen.size > 80) continue;
    seen.add(key);

    let res;
    try {
      res = await fetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const body = await res.text();
    bodies.push(body);

    // Scripts and stylesheets the browser would load, in any of the forms a
    // bundler emits: a static src/href, a bare relative import, a quoted path.
    const refs = [
      ...[...body.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]),
      ...[...body.matchAll(/import\(\s*["'`]([^"'`]+\.js)["'`]\s*\)/g)].map((m) => m[1]),
      ...[...body.matchAll(/["'`](\.?\/?[A-Za-z0-9_./-]*assets\/[A-Za-z0-9_.-]+\.(?:js|css))["'`]/g)].map((m) => m[1]),
    ];
    for (const ref of refs) {
      if (ref.startsWith('http') || ref.startsWith('//')) continue;
      queue.push(new URL(ref, url));
    }
  }
  return bodies.join('\n');
}

console.log(`\n  KGM LEGAL OS · deployment contents · ${BASE}\n`);

// ---- the portal -----------------------------------------------------------
const portal = await assetsFor('/login');

check('central sign-in offers both audiences',
  portal.includes('Firm staff') && portal.includes('Client portal'), '');
check('demo credentials reach the shipped bundle',
  portal.includes('Demo!Portal2026') && portal.includes('Demo!Firm2026'),
  'build:demo on web — a plain build compiles these out');
check('both audiences have their accounts listed',
  portal.includes('ahmed.alsaud@example.test') && portal.includes('noura@kgm.example.test'), '');
check('a refused sign-in is headed as a sign-in failure, not a fault',
  portal.includes('Sign-in failed'), '');

// ---- the firm OS ----------------------------------------------------------
const firm = await assetsFor('/firm');

check('firm OS defers to the central sign-in',
  firm.includes('/login?as=firm'), '');
check('bottom nav is centred by one edge, not both',
  firm.includes('inset-inline-start:50%') && !/\.kgm-bottomnav\{[^}]*inset-inline:50%/.test(firm),
  'the collapsed-pill defect');
check('bottom nav items may shrink below their comfortable floor',
  /* min-inline-size:0 on the item, with the 56px floor restored in a media query */
  /kgm-bottomnav__item\{[^}]*min-inline-size:0/.test(firm), '');
check('bottom nav truncates a long label rather than growing the bar',
  firm.includes('kgm-bottomnav__label') && firm.includes('text-overflow:ellipsis'), '');
check('the two previously dead nav destinations now have screens',
  firm.includes('mywork.title') && firm.includes('clients.title'), '');

// ---- behaviour ------------------------------------------------------------
const csrf = await fetch(`${BASE}/api/firm/auth/csrf`, { headers: { accept: 'application/json' } });
check('firm door answers a CSRF bootstrap', csrf.status === 200, `HTTP ${csrf.status}`);

/*
  The two doors refuse an anonymous caller DIFFERENTLY, and both are deliberate.

    client API  → 401 unauthenticated. The portal is a public product; there is
                  nothing to conceal about it existing.
    firm API    → 404 not_found, uniformly. A caller holding only a client
                  cookie, or no cookie, is told the same thing a request for a
                  path that does not exist would be told — so a portal user
                  cannot enumerate the firm's endpoints (`firm-middleware.ts`,
                  which states this rule at the top).

  Asserting 401 on both would have been a plausible-sounding check that the
  product fails on purpose.
*/
const firmSignedOut = await fetch(`${BASE}/api/firm/matters`, { headers: { accept: 'application/json' } });
const firmBody = await firmSignedOut.json().catch(() => null);
check('the firm API hides itself from an anonymous caller',
  firmSignedOut.status === 404 && firmBody?.error?.code === 'not_found',
  `HTTP ${firmSignedOut.status} ${firmBody?.error?.code ?? ''}`);

const clientSignedOut = await fetch(`${BASE}/api/client/dashboard`, { headers: { accept: 'application/json' } });
check('the client API states plainly that a session is needed',
  clientSignedOut.status === 401, `HTTP ${clientSignedOut.status}`);

const passed = results.filter(Boolean).length;
console.log(`\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.every(Boolean) ? 0 : 1);

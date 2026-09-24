/**
 * VERCEL FUNCTION MOUNT FOR THE WHOLE API  (CommonJS — see below)
 *
 * WHY THIS FILE IS JAVASCRIPT AND NOT TYPESCRIPT
 *   Vercel compiles each `api/**` entry point according to the module system of
 *   the NEAREST package.json. The repository root declares no `"type"`, so a
 *   `.ts` entry here is emitted as CommonJS — while `server/` declares
 *   `"type": "module"`, so its emitted JavaScript is ESM. A CommonJS entry that
 *   statically `require()`s an ESM file dies at load with ERR_REQUIRE_ESM, and
 *   because the failure is at module scope it 500s EVERY request, including
 *   ones the app would have answered with a 404. Keeping the mount as a plain
 *   CommonJS file and pulling the app in through a dynamic `import()` is the one
 *   shape that is valid under both module systems.
 *
 * WHY THE FILENAME IS `[...path]`
 *   `/api/index.ts` maps only to `/api`, so every nested route 404s. The
 *   dynamic segment makes the file the mount point for the whole `/api` tree.
 *   Vercel's generated route for it is single-segment (`^/api/([^/]+)$`), which
 *   is why `vercel.json` carries an explicit `/api/:path*` rewrite ahead of the
 *   SPA fallback; see server/src/vercel.ts for how the path is restored.
 */
let appPromise;

module.exports = async function handler(req, res) {
  if (!appPromise) {
    // Cached per warm instance: the container, the database handle and the
    // safety check in server/src/vercel.ts are all built once, not per request.
    appPromise = import('../server/src/vercel.js').then((m) => m.default);
  }
  const app = await appPromise;
  return app(req, res);
};

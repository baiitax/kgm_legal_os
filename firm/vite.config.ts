import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Firm OS SPA.
 *
 * SERVED AT /firm ON THE SAME ORIGIN AS THE API — and that is a security
 * requirement, not a deployment convenience. The firm session cookie is
 * `path: '/'` with `SameSite=strict`, and CSRF is a signed double-submit token
 * read from a sibling cookie. Both only work when the document and the API share
 * an origin. Serving this app from a different host would mean either relaxing
 * SameSite or dropping the CSRF pairing, and neither is a trade worth making for
 * a cleaner dev URL.
 *
 * `base: '/firm/'` keeps every asset path absolute under that mount, so the SPA
 * fallback and the hashed-asset cache rules can both key off the prefix.
 *
 * NOT SHARED WITH THE PORTAL
 *   This config, the API client, the auth context and the route table are all
 *   separate from web/'s. The only shared code is @kgm/ui, which is presentational
 *   and cannot authorize anything. A shared fetch wrapper would be a shared idea
 *   of what a request looks like; a shared auth context would be a shared idea of
 *   who the caller is.
 */
export default defineConfig({
  base: '/firm/',
  plugins: [react()],
  /*
   * NO ALIAS FOR @kgm/ui.
   *
   * An earlier version aliased '@kgm/ui' straight to packages/ui/src/index.ts.
   * That resolves the bare import and silently breaks every subpath, because
   * '@kgm/ui/styles/tokens.css' becomes 'index.ts/styles/tokens.css' — a path
   * through a FILE, which fails with ENOTDIR.
   *
   * The workspace symlink in node_modules plus the package's `exports` map
   * resolves the bare import AND the subpaths correctly on its own, so the alias
   * is not merely unnecessary here, it is actively wrong. The primitives are
   * consumed as TypeScript source (no build step to keep in sync) because the
   * exports map points at ./src/index.ts.
   */
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No source maps in the served bundle. They would publish the internal
    // authorization vocabulary — permission codes, route guards, withheld-field
    // handling — to anyone who opens devtools on a firm session.
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        // Split the design system from app code so a screen change does not
        // invalidate the cached primitives.
        manualChunks: {
          ui: ['@kgm/ui'],
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA is built once and served as static files by the Express API server,
 * so the browser only ever talks to one origin. `connect-src 'self'` in the CSP
 * depends on that: there is no second host to allow.
 *
 * `vite dev` is still usable — it proxies /api to the server so a developer can
 * get HMR without weakening the same-origin model.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No source maps in the served bundle: they would publish the client-side
    // structure and any comments about the security model.
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});

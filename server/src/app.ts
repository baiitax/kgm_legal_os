/**
 * APPLICATION ASSEMBLY.
 *
 * Middleware order is the security architecture, so it is written out here in
 * one place and commented:
 *
 *   1  requestId            correlation id, strips x-powered-by
 *   2  securityHeaders      CSP, HSTS, frame/ MIME / referrer policies
 *   3  denyInternalRoutes   §2 — refuses /admin, /audit, /firm-settings...
 *                           BEFORE authentication and before any handler
 *   4  express.raw          webhook bodies, verified as exact bytes
 *   5  express.json         hard 64 KB body limit on everything else
 *                            (JSON only — no urlencoded parser is mounted)
 *   6  cookieParser
 *   7  attachPrincipal      resolves the session, opens the DB scope, sets the
 *                           RLS phase (auth → portal)
 *   8  apiRateLimit
 *   9  routes
 *  10  static SPA           only for non-API, non-internal paths
 *  11  notFound / errorHandler  the only place an error is serialized
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Container } from './container.js';
import { config, isProd } from './config.js';
import {
  apiRateLimit, attachPrincipal, denyInternalRoutes, errorHandler, notFoundHandler, requestId,
} from './auth/middleware.js';
import { authRouter } from './api/auth.routes.js';
import { firmRouter } from './api/firm.routes.js';
import { clientRouter } from './api/client.routes.js';
import { webhookRouter } from './api/webhooks.routes.js';
import { devRouter } from './api/dev.routes.js';
import { ok } from './lib/http.js';

const BODY_LIMIT = '64kb';

export interface AppOptions {
  /** Directory of the built SPA. Falls back to web/dist. */
  webRoot?: string;
  /** Disable static serving (API-only mode, used by tests). */
  apiOnly?: boolean;
}

export function createApp(c: Container, opts: AppOptions = {}): express.Express {
  const app = express();

  // Trust the platform proxy only when explicitly told to; otherwise a caller
  // could spoof X-Forwarded-For and defeat per-IP rate limiting.
  app.set('trust proxy', c.trustProxy);
  app.disable('x-powered-by');
  app.disable('etag');

  // ---- 1 · request id -----------------------------------------------------
  app.use(requestId(c));

  // ---- 2 · security headers (§47) ----------------------------------------
  app.use(securityHeaders());

  // ---- 3 · internal route denial (§2) ------------------------------------
  app.use(denyInternalRoutes(c));

  // ---- 4 · webhook bodies as raw bytes -----------------------------------
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '256kb' }));

  // ---- 5/6 · body + cookies ----------------------------------------------
  app.use(express.json({ limit: BODY_LIMIT }));

  // express.urlencoded is deliberately NOT mounted. The API is JSON-only; the
  // two non-JSON shapes it accepts are multipart uploads (multer, on one route)
  // and raw webhook bytes (express.raw, signature-verified). Accepting
  // form-encoded writes would add a second parsing surface for the same
  // endpoints, which is where HTTP parameter pollution and form/JSON ambiguity
  // bugs live. A form-encoded request now parses to no body at all and is
  // refused, rather than being quietly accepted through a second door.
  app.use(cookieParser());

  // ---- 7 · principal + request-scoped DB context -------------------------
  app.use(attachPrincipal(c));

  // ---- 8 · coarse API budget --------------------------------------------
  app.use('/api', apiRateLimit(c));

  // ---- health -----------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    ok(res, {
      status: 'ok',
      env: config.env,
      driver: c.db.driver,
      storage: c.storage.name,
      time: new Date().toISOString(),
      // Deliberately reveals nothing about versions, hosts or configuration.
    });
  });

  // ---- 9 · routes -------------------------------------------------------
  app.use('/api/auth', authRouter(c));
  app.use('/api/client', clientRouter(c));
  app.use('/api/webhooks', webhookRouter(c));

  /**
   * The Firm OS. A separate router, a separate session cookie, a separate
   * authorization engine (§6). It shares this process and this database with the
   * portal and nothing else — in particular, no portal middleware runs on these
   * routes except the ones that are audience-agnostic (request id, headers, body
   * limits, cookie parsing, rate limiting and the error serializer).
   */
  app.use('/api/firm', firmRouter(c));

  if (!isProd) {
    // Not mounted at all in production — there is no flag that could be left on.
    app.use('/api/dev', devRouter(c));
  }

  // ---- 10 · static SPA --------------------------------------------------
  if (!opts.apiOnly) {
    const webRoot = opts.webRoot ?? path.resolve(process.cwd(), '../web/dist');
    if (fs.existsSync(webRoot)) {
      app.use(
        express.static(webRoot, {
          index: false,               // we control the fallback ourselves
          dotfiles: 'ignore',
          setHeaders: (res, filePath) => {
            if (/\/assets\//.test(filePath)) {
              // Hashed build artefacts are immutable.
              res.setHeader('cache-control', 'public, max-age=31536000, immutable');
            } else {
              res.setHeader('cache-control', 'no-cache');
            }
          },
        }),
      );

      /**
       * SPA fallback. Internal paths are already refused in step 3; anything
       * else that is not /api and not a real file gets index.html so the
       * client router can render its own 404 page.
       */
      app.get(/^\/(?!api\/).*/, (req, res, next) => {
        if (req.method !== 'GET') return next();
        const index = path.join(webRoot, 'index.html');
        if (!fs.existsSync(index)) return next();
        res.setHeader('cache-control', 'no-cache');
        res.sendFile(index);
      });
    }
  }

  // ---- 11 · terminal handlers -------------------------------------------
  app.use('/api', notFoundHandler());
  app.use(notFoundHandler());
  app.use(errorHandler(c));

  return app;
}

/**
 * Security headers (§47: security headers + CSP implemented).
 *
 * CSP notes:
 *   - script-src is 'self' with a per-response nonce. No 'unsafe-inline' and no
 *     'unsafe-eval' anywhere: an XSS that injects a <script> has no way to run.
 *   - style-src allows 'unsafe-inline' because the design system sets a small
 *     number of dynamic inline styles. Moving those to CSS custom properties
 *     would let this be tightened to 'self' + nonce; it is called out in the
 *     README hardening list.
 *   - connect-src 'self' — the SPA can only call this origin. There is no
 *     third-party script, no analytics beacon, no external font CDN.
 *   - object-src/ base-uri/ form-action are locked down; frame-ancestors is
 *     'none' in production.
 */
export function securityHeaders(): express.RequestHandler {
  return (req, res, next) => {
    const nonce = crypto.randomBytes(config.security.cspNonceLength).toString('base64');
    res.locals.cspNonce = nonce;

    // Framing: production is 'none'. In development the sandbox preview renders
    // this app inside an iframe, so it is configurable — and never shipped.
    const frameAncestors = isProd ? "'none'" : process.env.ALLOW_FRAME_ANCESTORS || '*';

    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data: blob:`,
      `font-src 'self' data:`,
      `connect-src 'self'`,
      `media-src 'self' blob:`,
      `object-src 'none'`,
      `frame-src 'none'`,
      `frame-ancestors ${frameAncestors}`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `manifest-src 'self'`,
      `worker-src 'self' blob:`,
      `upgrade-insecure-requests`,
    ].join('; ');

    const header = config.security.reportOnlyCsp
      ? 'content-security-policy-report-only'
      : 'content-security-policy';
    res.setHeader(header, csp);

    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()',
    );
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-permitted-cross-domain-policies', 'none');
    res.setHeader('origin-agent-cluster', '?1');

    if (isProd) {
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader(
        'strict-transport-security',
        `max-age=${config.security.hstsMaxAge}; includeSubDomains; preload`,
      );
    }

    // Never let a document be opened by an attacker-controlled opener.
    if (req.method === 'GET') res.setHeader('x-download-options', 'noopen');

    next();
  };
}

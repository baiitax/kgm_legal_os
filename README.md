# KGM LEGAL OS

Arabic-first legal practice operating system for a Saudi law firm.

Two products, one repository, **no shared authorization surface**:

| | Client Portal | Internal Firm OS |
|---|---|---|
| Who | The firm's clients | Partners, lawyers, finance, compliance, admin |
| Status | **Complete** — 185 passing tests, SPA built and served | **P0 security foundation complete** — 97 passing tests, API live, UI next. See [`FIRM_OS_PLAN.md`](./FIRM_OS_PLAN.md) |
| API prefix | `/api/client/*`, `/api/auth/*` | `/api/firm/*` |
| Identity | `client_users` + `client_sessions` | `users` + `firm_memberships` + `firm_sessions` |

The separation in §3 of the spec is enforced structurally, not by convention: the
client role has no grant on internal tables, the client API has no route that
reaches them, and the two session types are different tables with different
cookie names. A client session presented to an internal route is not
"insufficient privileges" — it is not a session at all.

---

## Run it

```bash
npm install
npm run dev          # API on :8787 with tsx watch
npm run build        # SPA → web/dist, served by the API
npm start            # production-shaped start (API + built SPA)
```

Then open `http://localhost:8787`. The database seeds itself on first boot.

**Demo accounts** (synthetic data only — no real identifiers anywhere):

*Client portal* — password `Demo!Portal2026` for all three:

| Email | Tenant | Proves |
|---|---|---|
| `ahmed.alsaud@example.test` | KGM · client 1 | primary contact, full matter set |
| `finance@gulfhorizon.example.test` | KGM · client 2 | second client **in the same firm** — cross-client isolation |
| `layla.mansour@example.test` | Najd · client 1 | second tenant — cross-tenant isolation |

*Internal Firm OS* — password `Demo!Firm2026` for all five:

| Email | Role | Proves |
|---|---|---|
| `noura@kgm.example.test` | Managing Partner | 69 permissions, all practice areas, 500,000 SAR approval ceiling |
| `faisal@kgm.example.test` | Lawyer | scoped to Commercial Litigation + Real Estate |
| `mariam@kgm.example.test` | Paralegal | 18 permissions, one matter at `operational` level |
| `omar@kgm.example.test` | Compliance | `audit.read`, assigned matters only |
| `sara@kgm.example.test` | Finance | `billing.read_all`, 25,000 SAR ceiling that actually refuses a larger invoice |

Signing in as Ahmed and then asking for Gulf Horizon's matter by id returns
`404 not_found`, not `403`. The portal never confirms that a resource exists for
someone who may not see it. The same holds inside the firm: Mariam asking for a
matter she is not on gets `404`, and a client cookie presented to `/api/firm/*`
is not "insufficient privileges" — every firm route returns `404`, and the
attempt is audited as `ESCALATION_ATTEMPT` with reason `cross_audience`.

### Environment

Everything has a working default. The ones worth knowing:

```
PORT=8787  HOST=0.0.0.0
DB_DRIVER=sqlite                # sqlite | postgres
SQLITE_FILE=<server>/data/kgm-portal.sqlite
DATABASE_URL=                   # postgres DSN when DB_DRIVER=postgres
STORAGE_DRIVER=local            # local | supabase
LOCAL_STORAGE_DIR=<server>/data/storage
DEMO_MODE=true                  # enables /api/dev and the mock payment provider
ALLOW_FRAME_ANCESTORS=*         # dev only; production sends frame-ancestors 'none'
```

Both filesystem defaults are anchored to the **server package root**, resolved
from `config.ts`'s own location rather than from `process.cwd()`. That is a
deliberate choice with a boring reason: a relative default means running a seed,
a migration check or a one-off query from the repository root instead of
`server/` silently creates a *second, empty* database. Every query succeeds,
returns nothing, and the failure looks like a bug in the code under test rather
than a path. An explicit `SQLITE_FILE` or `LOCAL_STORAGE_DIR` still wins and is
resolved against cwd, so a deployment can point at an absolute path or a volume
mount.

`DB_DRIVER=postgres` plus a Supabase connection string switches the whole
app to Postgres with RLS. **No application code changes** — the repository layer
is the only thing that knows which driver is live, and the two are held to the
same contract by the same test suite.

One deliberate detail: when running on Supabase the API connects as the
restricted `portal_api` role through `pg`, **not** with `supabase-js` and a
service key. A service role key bypasses RLS, which would turn the database
layer from a control into a decoration.

---

## Tests

```bash
npm test              # 282 tests, 7 files
npm run test:security # authorization + negative-mutation suites only
npm run test:e2e      # full client journey
```

| Suite | Tests | What it proves |
|---|---|---|
| `authentication` | 42 | sessions, lockout, MFA, CSRF, invitation binding |
| `authorization` | 23 | tenant/client isolation, projection of internal data |
| `documents` | 35 | upload pipeline, signed URLs, storage keys |
| `financial` | 31 | intent-only payments, webhook-verified state changes |
| `negative-mutations` | 46 | §45/§46: every forged field, tampered id and smuggled parameter |
| `firm-rbac` | 97 | §72 escalation matrix, §73 financial ceilings, §71 non-recursive RLS, cross-audience refusal |
| `e2e` | 8 | invitation → sign-in → matter → document → invoice → receipt |

The negative suites are the ones that matter. Each test attempts something a
determined user would actually attempt — `tenant_id` in a login body, another
client's document id, `?status=paid` on an invoice, a raw JSON body with
`__proto__`, a form-encoded write to a JSON endpoint — and asserts both the
refusal **and** the audit record that refusal produces.

`firm-rbac` does the same job for the internal side and is the more paranoid of
the two. It drives the §72 escalation matrix (`paralegal→managing_partner`,
`associate→partner`, `finance→admin`, `admin→managing_partner`,
`lawyer→compliance`) through four independent channels each — the API, a direct
URL, a crafted payload and a database mutation — and asserts that no channel
succeeds where another fails. It also proves the Postgres and SQLite access
resolvers agree by extracting both and comparing precedence branch by branch
(§71), that no RLS policy calls `current_setting` recursively, and that a role
revoked mid-session stops working on the *next* request rather than the next
login.

---

## Security model

The operating assumption is that the user will try to bypass the interface.
Every sensitive request passes through the same chain, and each link is
independently enforced:

```
UI  →  API  →  DOMAIN  →  DATABASE  →  STORAGE  →  AUDIT
```

- **Identity.** scrypt (N=2¹⁵, r=8, p=1); opaque 256-bit session tokens stored
  only as SHA-256 hashes; `httpOnly` + `SameSite=Lax` + `Secure` cookies; dual
  absolute/idle expiry; RFC 6238 TOTP with single-use recovery codes; AES-256-GCM
  for secrets at rest.
- **Authorization.** Resolved from the session on **every** request, never from
  the request body. `tenant_id`, `client_id` and `portal_role` are read from the
  invitation row at binding time and cannot be restated by the client —
  attempting it returns `403 field_not_writable` and writes a
  `FIELD_TAMPER_ATTEMPT` audit event.
- **Two audiences, two doors.** Client and firm sessions are different tables,
  different cookie names, different CSRF header names and different route trees.
  Neither audience can be widened into the other: a client token presented to
  `/api/firm/*` matches no session, so every firm route answers `404` and the
  attempt is audited as a cross-audience escalation. Firm logins additionally
  require an *active* `firm_membership` row — the right password with a
  deactivated or never-invited membership is `401 no_active_membership`.
- **Internal permissions.** A role is a set of permission codes, and a
  membership's effective set is the union of its roles intersected with the
  tenant's enabled modules. Matter visibility is a separate axis: `full` /
  `view` / `operational` / `restricted` resolved per matter from an explicit
  grant, the matter team, practice-area scope and the restricted flag — with
  explicit grants winning over inheritance, and "no rule matches" resolving to
  *no access* rather than to a default level.
- **Money has a ceiling, not just a permission.** Each membership carries
  `financial_authority_sar`, `writeoff_authority_sar` and
  `discount_authority_pct`. Holding `billing.approve` is necessary but not
  sufficient: approving 40,000 SAR with a 25,000 SAR ceiling is refused with
  `403 authority_ceiling_exceeded` and audited with the amount and the ceiling.
- **Critical actions require a live MFA step.** For destructive or money-moving
  operations the resolver demands `mfaEnabled && mfaVerified`. Not enrolled is
  treated as *not satisfied* — a firm member who never enrolled cannot ride the
  portal's "no MFA configured means no MFA required" convenience into a
  privileged action.
- **Projection.** Responses are assembled field by field. Internal notes,
  conflict work, risk flags, AML state and the firm's internal financial
  position have no path to the wire. Unknown query parameters are ignored rather
  than honoured, so `?include=internal_notes` cannot widen a projection.
- **Storage.** Keys are server-generated; the browser never supplies a path.
  Files are private, written `0o600` locally, and reached only through HMAC-signed
  URLs with a 60-second TTL. Access is logged per grant.
- **Money.** The browser can create a payment *intent* and nothing else. Only a
  signature-verified provider webhook moves an invoice to paid, and the receipt
  is written in the same transaction as the state change.
- **Audit.** Append-only. The client role has no `UPDATE` or `DELETE` grant on
  `audit_events`; actor identity and timestamp come from the server.
- **Transport.** CSP with per-request nonce, no third-party scripts or fonts,
  HSTS, `nosniff`, strict referrer policy, `object-src 'none'`,
  `frame-ancestors 'none'` in production.
- **Abuse.** Rate limiting per route class, progressive lockout, upload limits by
  size/extension/sniffed MIME, and a scan step before a file becomes readable.

---

## Client Portal

React 18 + Vite, no UI kit, no CDN, ~81 kB gzipped for the whole app including
React. Routes are code-split per screen.

```
web/src/
  api/client.ts      fetch wrapper: CSRF double-submit, one retry, signed URLs
  api/types.ts       response shapes, transcribed from the server's projections
  lib/format.ts      Intl formatters: Hijri/Gregorian, SAR, relative time, bytes
  i18n/index.tsx     ~560 keys, Arabic and English, both directions complete
  components/ui.tsx  icons, cards, badges, forms, modal, password meter, useAsync
  pages/             16 screens
```

Arabic is the default and the source of truth; English is a peer, not a
fallback. Layout uses CSS logical properties throughout, so RTL is not a
transform of an LTR design. Calendars and currency go through `Intl`
(`ar-SA-u-ca-islamic-umalqura`, `SAR`) rather than a hand-rolled conversion.
Mobile-first: bottom tab bar under 900px, 264px sidebar above. Dark mode follows
the system. Print styles for invoices and receipts.

Screens: Dashboard · Matters · Matter detail (lifecycle, team, timeline,
hearings, deadlines, documents, invoices, threads) · Hearings · Deadlines ·
Documents (upload, request fulfilment, signed download) · Invoices · Invoice
detail (lines, payments, intent) · Receipts · Messages · Thread · Appointments ·
Notifications (+ channel preferences) · Profile · Security centre (password, MFA
enrolment, sessions, devices, alerts) · Privacy centre (requests, consents,
retention).

### Things the portal deliberately does not do

- No public sign-up. Accounts exist only by firm invitation.
- No self-service account deletion. Deletion is a *request* routed to compliance
  review, because professional retention obligations are a human judgement.
- No new-conversation button. Threads are opened by the firm against a matter.
- No password-echo endpoint. The strength checker returns rule outcomes only.
- No QR image for TOTP enrolment. The CSP allows no external image source and the
  bundle ships no encoder, so enrolment offers the `otpauth://` URI and the manual
  key. Adding a local QR encoder is on the list; weakening the CSP is not.

---

## Internal Firm OS

Phase P0 — the security foundation — is built and proven. Everything above the
foundation (the workspace screens, finance, compliance, BI) is staged in
[`FIRM_OS_PLAN.md`](./FIRM_OS_PLAN.md).

What exists now:

```
server/src/
  auth/firm-auth.ts        login: active membership required, lockout, audit
  auth/firm-session.ts     issue/verify/revoke; own cookie, own idle+absolute TTL
  auth/firm-middleware.ts  requireFirm(), requirePermission(), requireMfaForCritical()
  domain/permissions.ts    the resolver: role union → matter access level → ceilings
  domain/firm-catalogue.ts §8 permission catalogue, parsed once and frozen
  db/firm-repo.ts          driver-swappable queries for the RBAC graph
  db/schema.firm.sqlite.ts SQLite mirror of migration 0006
  api/firm.routes.ts       /api/firm/* — session, matters, billing, admin, audit
supabase/migrations/
  0006_firm_rbac.sql       10 tables, RLS, firm_api grants, matter_access_level()
```

The permission model has four independent axes, and a request must satisfy all
of them:

1. **Role permissions** — the union of the membership's roles, intersected with
   the tenant's enabled modules.
2. **Matter access level** — `full` / `view` / `operational` / `restricted`,
   resolved per matter from explicit grant → matter team → practice-area scope →
   restricted flag. Explicit wins; no match means no access.
3. **Practice-area scope** — a partner sees the practice areas they are scoped
   to, on top of the departments tree. `['*']` is a stored value, not a wildcard
   that leaks into a query.
4. **Financial ceilings** — numeric per membership, consulted by the resolver on
   approve / write-off / discount.

Roles marked `is_system` are protected by database trigger: `MANAGING_PARTNER`
cannot be deleted or have its permissions rewritten, so an admin who can grant
roles cannot first hollow one out and then inherit it.

The UI is deliberately not started yet. P0's whole point is that the
authorization surface exists and is tested before any screen is built on top of
it — a dashboard written against an unproven resolver gets rewritten.

---

## Layout

```
server/src/
  config.ts          env parsing, every default in one place (paths anchored to the package root)
  lib/               crypto, ids, time, validation, errors
  db/                driver interface · sqlite · postgres · schema · seed · firm-repo
  auth/              sessions, passwords, TOTP, invitations, email · firm-auth/session/middleware
  storage/           local + supabase drivers, signed URLs
  domain/            client-service, dto projections, protected-fields · permissions, firm-catalogue
  api/               auth.routes, client.routes, webhooks.routes, dev.routes · firm.routes
supabase/migrations/ 0001–0005 portal DDL, RLS, grants, storage policies
                     0006 firm RBAC — roles, permissions, matter access, sessions, audit
tests/               security (portal + firm-rbac), e2e
web/                 the client SPA
firm/                the internal Firm OS SPA — separate app, shares only packages/ui
```

The firm SPA and the client SPA share **presentational primitives only** — icons,
cards, tables, formatters, the i18n runtime. No shared API client, no shared auth
context, no shared route table. A component that knows how to fetch is a
component that knows which door to knock on, and the two doors must stay
unaware of each other.

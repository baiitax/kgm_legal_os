# Internal Firm OS — build plan

Mapped against the 83-section master spec. This is a working document: every item
names the module that will own it, what already exists in this repository, and
what has to be written.

The Client Portal is finished and is the reference implementation for the
security patterns the Firm OS reuses. Nothing below re-litigates those patterns;
it says where they apply.

---

## 0. What already exists and is reusable

Built for the portal, driver-agnostic, and directly load-bearing for the Firm OS:

| Asset | Where | Reuse |
|---|---|---|
| Repository interface + SQLite/Postgres drivers | `server/src/db/` | Same interface gains firm-side methods; both drivers stay under one test suite |
| Session issuing, hashing, dual expiry, revocation | `server/src/auth/` | New `firm_sessions` table, same code path, **different cookie name** |
| Password hashing, policy, lockout, TOTP, recovery codes | `server/src/auth/` | Identical for staff; §52 needs no new crypto |
| CSRF double-submit, rate limiting, tamper guard | `server/src/api/`, `server/src/domain/protected-fields.ts` | Applied to `/api/firm/*` with a firm-side forbidden-field list |
| Signed URL issuance + access log | `server/src/storage/` | §59 already satisfied; internal authorization wraps it |
| Append-only audit with server-side actor | `server/src/domain/audit.ts` | §51 needs new action constants, not a new mechanism |
| Postgres DDL + two-phase RLS + grants | `supabase/migrations/0001–0005` | §70 extends; the `portal_api` restricted-role pattern is copied for `firm_api` |
| Intl formatting, i18n dictionaries, design system | `web/src/` | §61–§64: extracted to a shared package (below) |
| 185-test harness including negative-mutation suites | `tests/` | §72–§75 test matrix runs in the same rig |

**Schema that already exists** and will be extended rather than replaced:
`tenants, clients, users, staff, matter_team, matters, hearings, deadlines,
documents, internal_notes, message_threads, messages, invoices, invoice_lines,
payments, receipts, notifications, audit_events, appointment_types,
appointments, login_attempts, auth_tokens, mfa_recovery_codes, security_alerts`.

`users` is an unused authentication identity and `staff` carries a single
`internal_role` string. §6 explicitly rejects that model, so P0 replaces the
string with a real graph. `staff` stays as the personnel record; authority moves
to `firm_memberships` + `roles`.

---

## 1. Architectural decisions

### 1.1 Two SPAs, one design system (§3)

```
web/      Client Portal   — exists, complete
firm/     Internal Firm OS — new Vite app, own bundle, own routes
packages/ui/               presentational primitives shared by both
```

`packages/ui` contains **pixels only**: icons, cards, badges, tables, forms,
modal, the Intl formatter, the i18n runtime. It contains no API client, no auth
context, no route table and no permission logic. Sharing a button cannot leak a
capability; sharing an auth module could. Both apps build separately, are served
from different path prefixes, and neither bundle contains the other's endpoints.

The Express app serves both, but from separate static roots with separate
`index.html` files, so a client-side route in one can never resolve a chunk from
the other.

### 1.2 One server process, two authorization universes (§3, §4)

```
/api/auth/*    shared authentication primitives (login differs per audience)
/api/client/*  portal — existing, unchanged
/api/firm/*    internal — new router, new guards, new principal type
/api/webhooks/*
```

Two principal types, deliberately not a union:

```ts
ClientPrincipal { userId, tenantId, clientIds[], portalRole, language, calendar }
FirmPrincipal   { userId, tenantId, membershipId, staffId, roleIds[], departmentIds[],
                  permissions: Set<string>, matterScope: Map<matterId, AccessLevel> }
```

A `ClientPrincipal` is not a `FirmPrincipal` with fewer permissions; there is no
code path that converts one to the other. `requireFirm()` reads the firm session
cookie and rejects anything else before any handler runs.

### 1.3 Permission resolution (§6, §8, §17)

Effective access is computed **per request** on the server, never cached in the
browser and never derived from a JWT claim:

```
membership (active?)
  → roles → role_permissions            (base set)
  → departments → department scope      (narrows by practice group)
  → matter_team assignment              (narrows to assigned matters)
  → matter_permissions explicit grants  (widens or narrows per matter)
  → resource state                      (restricted matter? approved doc? paid invoice?)
  → field-level classification (§57)    (projection, applied at DTO build time)
```

The resolver is one function with one test suite. Handlers call
`assertCan(principal, 'billing.approve', { matterId, invoiceId })` and the
resolver decides. No handler inspects a role string.

Access levels per §17: `FULL, EDIT, OPERATIONAL, VIEW, FINANCIAL, COMPLIANCE,
NONE` — stored in `matter_permissions`, defaulting from `matter_team.matter_role`.

### 1.4 Non-recursive RLS (§71)

The failure mode the spec calls out is a `matters` policy that reads
`matter_team`, whose own policy reads `matters`. Avoided structurally:

```sql
create function public.is_matter_member(p_matter uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from matter_team mt
    where mt.matter_id = p_matter
      and mt.staff_id = public.current_staff_id()
      and mt.is_active
  );
$$;
```

`SECURITY DEFINER` + a query against **one** table with no policy of its own.
`matter_team` itself is guarded by `tenant_id = current_tenant_id()` only — it
never calls back into `matters`. Every role is tested against this in P0, and the
test asserts the query plan does not re-enter the `matters` policy.

### 1.5 Classification drives projection (§57)

`INTERNAL / CONFIDENTIAL / RESTRICTED / HIGHLY_RESTRICTED` becomes a column on
the sensitive tables plus a DTO-layer filter. The portal already proves the
technique: responses are assembled field by field, and unknown query parameters
are ignored rather than honoured. The Firm OS uses the same rule, with the added
wrinkle that field visibility now varies by role — so projections become
functions of `(row, principal)` rather than `(row)`.

---

## 2. Phases

Ordered per §81. Each phase ends runnable, with tests, on the same demo dataset.

### P0 — Security foundation ✅ **complete**

**Schema** (`supabase/migrations/0006_firm_rbac.sql` + `server/src/db/schema.firm.sqlite.ts`)

```
roles                    (id, tenant_id, code, name, name_ar, is_system, scope)
permissions              (id, code, module, description)          -- global catalogue
role_permissions         (role_id, permission_id)
firm_memberships         (id, tenant_id, user_id, staff_id, status, joined_at, left_at,
                          financial_authority_sar, writeoff_authority_sar, discount_authority_pct)
membership_roles         (membership_id, role_id, granted_by, granted_at)
departments              (id, tenant_id, code, name, name_ar, parent_id)
department_members       (department_id, membership_id, is_lead)
matter_permissions       (matter_id, membership_id, access_level, granted_by, reason)
firm_sessions            (id, membership_id, token_hash, created/expires/idle, mfa_verified, device)
firm_invitations         (id, tenant_id, email, staff_id, role_ids[], token_hash, expires, status)
```

Plus the §8 permission catalogue seeded as data (69 codes granted to the top
role, across `clients`, `matters`, `documents`, `billing`, `compliance`, `users`,
`audit`, `settings`).

**Code** — all built:
- `server/src/domain/permissions.ts` — the resolver + `assertCan` + `assertMfaForCritical`
- `server/src/domain/firm-catalogue.ts` — §8 catalogue, parsed once and frozen
- `server/src/auth/firm-session.ts` — issue/verify/revoke, separate cookie
- `server/src/auth/firm-middleware.ts` — `requireFirm()`, `requirePermission()`
- `server/src/db/firm-repo.ts` — driver-swappable RBAC queries
- RLS for all ten tables + `matter_access_level()` + grants for a `firm_api` role
- `server/src/api/firm.routes.ts` — session, matters, billing, admin, audit

**Tests (§72)** — `tests/security/firm-rbac.test.ts`, **97 passing**. The
escalation matrix driven through API, direct URL, crafted payload and database
mutation: `paralegal→managing_partner`, `associate→partner`, `finance→admin`,
`admin→managing_partner`, `lawyer→compliance`. Plus: a deactivated membership
mid-session, a role revoked mid-session, a matter restricted mid-session, and a
client session replayed against `/api/firm/*`.

**Exit criteria — all met:**

| Criterion | Status |
|---|---|
| No staff member can read a matter they are not assigned to | ✅ `404 matter_scope_denied`, indistinguishable from non-existent |
| No role change takes effect without an audit entry | ✅ `ADMIN_MUTATION` + `FIELD_TAMPER_ATTEMPT` written in the same transaction |
| RLS is non-recursive and proven so | ✅ §71 suite extracts both resolvers and compares precedence branch by branch |
| The portal's 185 tests still pass untouched | ✅ 282/282 across 7 files |

**Two defects found and fixed while proving it, both worth recording because
they are the kind that survive review:**

1. *A denylist that was too clever.* `AUDIT_METADATA_DENYLIST` matched by
   substring, so the entry `code` — there to keep an MFA challenge out of the
   audit log — also silently redacted `roleCode` and `statusCode`. Security
   filters that over-match do not fail loudly; they erase the evidence you need
   while looking like they are working. Split into an exact-match list
   (`code`, `codes`, `challenge`, `credential`, `credentials`) and a substring
   list (`password`, `token`, `secret`, `authorization`, `cvv`, `national_id`,
   …), i.e. short dangerous words matched exactly, compound patterns matched
   loosely.
2. *"No MFA configured" read as "MFA satisfied".* The portal treats an account
   with no MFA enrolled as having met the MFA step, which is correct for a client
   reading their own invoices and wrong for a partner approving 25,000 SAR.
   `assertMfaForCritical` now requires `mfaEnabled && mfaVerified`, and returns a
   distinct `details.step` — `enroll_mfa` versus `mfa` — so the UI can send the
   member to the right screen instead of a dead end.

**Also in this phase, though it is infrastructure rather than RBAC:** filesystem
defaults in `config.ts` (`SQLITE_FILE`, `LOCAL_STORAGE_DIR`) were resolved
against `process.cwd()`. Running any script from the repository root instead of
`server/` quietly created a second, empty database — queries succeeded, returned
nothing, and the symptom looked like missing audit rows. Both defaults now
resolve from `config.ts`'s own location. An explicit env value still wins.

### P1 — Core legal operations (§18–§20, §28–§32)

Internal shell (permission-generated navigation), executive dashboard with
traceable KPIs only (§19), personal workspace (§20), client directory and intake
workflow (§21–§23), matter command centre with the §26 state machine, tasks with
dependencies (§28), unified calendar (§29), hearings with outcome permissions
(§30), deadline engine with escalation (§31), document centre with independent
authorization (§32).

The matter state machine is the load-bearing piece: transitions declared as data,
enforced in the domain layer, each transition audited with previous and new state
(§83's six questions).

### P2 — Legal workspace (§33–§35, §40–§41, §47)

Version control where every edit creates a version and an approved document is
never overwritten (§33); the RTL/LTR legal editor with **server-resolved**
template variables (§34) — variables resolve server-side because a
client-resolved variable is an injection point into a legal document; approval
workflow with approver/timestamp/version/decision (§35); engagement contracts
(§40); POA register with expiry alerts and explicit `VALID/EXPIRING/EXPIRED/
MISSING/UNVERIFIED/SUSPENDED` where NULL is never read as valid (§41, §44);
communication centre keeping internal notes and client communication in separate
tables with separate visibility rules (§47) — the portal already enforces the
client side of that wall.

### P3 — Finance (§36–§39)

Time entries with no silent deletion of invoiced time — corrections are
adjustment/void/correction records with history (§36); expense workflow (§37);
billing command centre (§38); and §39, which the portal already implements from
the other side: intent → verification → webhook → transaction → invoice state →
receipt → audit. The firm side adds approval, write-off and collections, each
gated by a permission and each refusing browser-supplied `status`, `approved_by`,
`approved_at`, `paid_at` (§69). §73's financial attack matrix runs against both
sides.

### P4 — Compliance (§42–§46)

Conflict engine returning `CLEAR/POTENTIAL/CONFLICT/REQUIRES_REVIEW` with
restricted investigations (§43); KYC/AML; licence register (§44); CLE tracking
(§45); complaint workflow with restricted sensitive content (§46); compliance
dashboard (§42). Compliance gets what it needs without inheriting the firm's
financial or strategic records (§15) — which is a permission-graph question, not
a screen question.

### P5 — Management intelligence (§55, §56)

Firm analytics and the risk centre. Two rules from the spec are non-negotiable
and shape the implementation: every metric traceable to underlying rows (§19 —
no manufactured numbers, so each KPI ships with the query that produces it), and
risk results are computed server-side with no browser input (§56).

### P6 — Administration (§49–§54)

User management, role administration where nobody edits their own privilege set
(§50), audit centre with search and export against an append-only store (§51),
security centre with org-wide visibility for administrators (§52),
permission-aware global search where authorization is applied **before** results
are returned (§53 — never fetch-then-filter), and the command palette where every
command is authorized like any other action (§54).

### P7 — Hardening (§65–§79)

Pagination and saved views so no tenant dataset is ever loaded whole (§65),
empty/error states with request ids and no leaked SQL (§66–§67), security headers
(§68 — already in place), observability and alerting on 5xx/401/403/slow queries
(§76), backup and recovery with documented RPO/RTO (§77), three environments with
no production secret in a bundle or a repo (§78), and the full test pyramid with
authorization tests blocking CI (§79).

---

## 3. Open questions worth settling before P1

Three of these were settled during P0 and are recorded as decisions, not
questions — the schema already reflects them.

1. ~~**Multi-firm or single-firm?**~~ **Settled: multi-firm SaaS from day one.**
   Tenant switching ships in the UI, per-tenant config and branding, and
   firm-admin roles that manage their own tenant and no other. The Najd tenant in
   the demo dataset exists to prove the boundary rather than to decorate it.
2. ~~**Department scope vs practice-group scope?**~~ **Settled: two independent
   scopes that intersect.** A departments tree (§5 — Legal, Finance, Compliance,
   Admin, Operations) governs organisational reporting; practice-area tags on
   matters govern what a partner may see. A partner's scope is the list of
   practice areas they hold, applied on top of the department tree. Conflating
   them would make a finance partner's visibility depend on an org chart.
3. ~~**Billing authority as a number or a permission?**~~ **Settled: numbers,
   three of them.** `financial_authority_sar`, `writeoff_authority_sar` and
   `discount_authority_pct` live on `firm_membership`. The resolver refuses
   `billing.approve` when the amount exceeds the ceiling — holding the permission
   is necessary and not sufficient. A role is a bad place for a limit, because
   the limit is per person and a role is per group.
4. **Editor storage model.** §34's editor needs a document model with versions,
   comments and links (the §70 table list already names
   `editor_documents/_comments/_versions/_links/_approvals`). Whether the editor
   stores structured JSON or HTML affects versioning, diffing and export.
5. **Notification channels actually configured.** §48 says in-app, email, SMS and
   WhatsApp "only where the integration is actually configured and operational".
   Which are real at go-live? The outbox is already built for email; SMS and
   WhatsApp need a provider decision before the code exists.

---

## 4. Next concrete step

P0 is done: 282/282 tests green, the firm API live on `/api/firm/*`, five demo
memberships spanning Managing Partner → Finance, and every escalation path in
§72 refused and audited.

**Next is P1 — core legal operations (§18–§20, §28–§32).** Concretely, in order:

1. `firm/` workspace scaffolded, sharing only `packages/ui` primitives. The
   navigation is generated from the resolved permission set, never hardcoded — a
   member who cannot read audit must not be shown an audit tab, because a tab
   that 404s on click teaches people that the UI lies.
2. Matter list + matter detail behind the resolver already built, so P1 writes
   screens and no new authorization logic. This is the point of doing P0 first.
3. Document security (§74) and field-level classification (§57) — the two
   remaining security pieces that P1's screens depend on. §57 in particular,
   because a matter detail screen cannot render until it knows which fields are
   classified at which level for which role.

§74 and §57 are the only security work that should land before more screens
exist; everything else in §65–§79 can harden behind a working product.

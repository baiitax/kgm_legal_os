# Credential & Deployment Review — KGM LEGAL OS

**Date:** 2026-09-24
**Scope:** Vercel project, Supabase connection, backend configuration readiness.

---

## 1 · Summary

The Vercel side is in good shape and does exactly what you said: it builds and
serves **only the client portal SPA**, from `web/`. The Supabase side is **not yet
connected to anything**, and the connection string supplied in the brief would
break the security model rather than complete it.

| Item | Status |
|---|---|
| Vercel token | ✅ Valid, scoped to project `kgm_legal` |
| Vercel build config | ✅ Correct — Vite, root directory `web` |
| Portal live at `kgmlegal.vercel.app` | ✅ HTTP 200, serving current build |
| Supabase host reachable | ✅ `aws-0-us-east-1.pooler.supabase.com:5432` |
| Supabase database password | ❌ **Not supplied — this is the blocker** |
| Backend deployed | ❌ Nothing deployed anywhere |
| Backend safe to run against Supabase | ⚠️ Guard added; wiring needs the password |

---

## 2 · 🔴 CRITICAL — the supplied connection identity disables all database security

The brief gives:

```
user=postgres.sdpezbxwedvxqelpslfv
```

That username is the **`postgres` superuser** through the pooler (`postgres.<ref>`
is the pooler naming convention for the default superuser role).

**PostgreSQL exempts superusers from Row Level Security entirely.** Not
"mostly", not "unless forced" — a superuser always bypasses RLS, and no SQL can
change that.

What that means concretely, if `DATABASE_URL` is pointed at it:

- The **64 tables with RLS enabled** in migrations `0004` and `0006` would have
  policies that are present, syntactically correct, and **completely inert**.
- Every **column-level `GRANT`** protecting `matters.risk_rating`,
  `invoices.notes_internal`, `hearings.internal_status` and the rest would be
  bypassed.
- The server would **start cleanly, serve every request successfully, and log no
  errors.** There is no symptom. The first sign would be a cross-tenant leak.

This is not a theoretical hazard — it is the *default* outcome of copying the
connection string from the Supabase dashboard, which is where connection strings
come from.

### What I did about it

Since a guard is worth more than a warning, I added a **fail-closed boot check**:

- `server/src/db/role-guard.ts` — pure policy function, refuses on superuser,
  `BYPASSRLS`, or table ownership.
- `server/src/db/postgres.ts` — `assertSafeRole()` queries `pg_roles` and the
  ownership of public tables, then applies the policy.
- `server/src/index.ts` — runs it **before binding the port**, so a dangerous
  connection is a startup failure rather than a silent loss of the boundary.

A server that will not boot gets fixed in minutes. A server that boots without
its backstop is discovered during an incident. The check refuses in **every**
environment, including development — a guard that is lenient where nobody is
watching is first genuinely tested on the day it matters.

**11 tests**, and verified non-vacuous: disabling `shouldRefuseToStart` makes
exactly the three enforcement tests fail.

---

## 3 · 🟠 The schema claims FORCE RLS but never applies it

`server/src/db/postgres.ts` documented the `portal_api` role as *"(e) is subject
to FORCED Row Level Security."*

That is not true of this schema:

| Statement | Count |
|---|---|
| `ENABLE ROW LEVEL SECURITY` | **64** |
| `FORCE ROW LEVEL SECURITY` | **0** |

The distinction matters: **RLS does not apply to a table's owner** unless the
table is marked `FORCE`. Since the owner here is `postgres`, an owner connection
is unconstrained for the same reason a superuser is.

The isolation in this codebase has always come from the **role**, not from
`FORCE` — `portal_api` is a non-owner, so policies apply to it normally. So this
is a **documentation defect, not a live hole**, and I corrected the comment
rather than changing the schema. Adding `FORCE` is worth considering separately,
but it is not free: the owner becomes subject to the policies, which would affect
migration and seeding paths that currently run as the owner. That is a change to
make deliberately, with the seed flow re-tested — not as a side effect of a
comment fix.

---

## 4 · 🟠 The pooler port decides whether tenant isolation holds

The brief specifies **port 5432**, which is correct — that is the session pooler.
Please keep it. Port **6543** (the transaction pooler) would be a serious bug:

The driver injects caller identity per request with:

```sql
select set_config('kgm.tenant_id', $1, false)
```

Third argument `false` makes the setting **session-scoped**, cleared with
`RESET ALL` only when the connection is released back to the pool. Transaction
pooling multiplexes many clients across one backend session between
transactions, so a setting written for one caller can be **observed by another**.
That is a cross-tenant read happening *below* the application, which no
application-layer care can prevent.

This is the single highest-consequence setting in the deployment, so it is called
out in `.env.example` and in the bootstrap SQL.

---

## 5 · 🟠 16 Supabase secrets are readable by this Vercel token

The token can list **all 16 environment variables** on the project, including
`SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD` and `SUPABASE_JWT_SECRET`.

**The values themselves are safe.** Vercel returns them as v2 ciphertext
(`{"v":"v2","c":"…","k":[…]}`, base64-wrapped) and only decrypts inside its own
build runtime — I verified this by decoding them, and I could **not** obtain any
plaintext.

The exposure is the **listing**: anyone holding this token can enumerate your
secret *names* and targets. For a project this size that is a useful map. The
token should still be scoped down or rotated.

---

## 6 · What is missing, and why work is paused

**The Supabase database password.** It is required to:

1. run migrations `0001`–`0006` against the real project, and
2. create the restricted `portal_api` login via `supabase/ops/create_api_login.sql`.

It is **not** recoverable from Vercel (ciphertext, §5) and was not in the brief.
Until it exists, nothing can connect.

The password is a deliberate omission on your side, and that instinct is right —
pasting a production database password into a chat is a real exposure. Two better
options, in order of preference:

- **You run the bootstrap yourself.** One command, password never leaves your
  machine:
  ```bash
  psql "$ADMIN_URL" -v pw="$KGM_DB_PASSWORD" -f supabase/ops/create_api_login.sql
  ```
  then send me only the resulting `portal_api` connection string shape.
- **Create a dedicated password for `portal_api`** if you do send one — scoped to
  a restricted role, so a leak does not hand over the database owner.

Note that `portal_api` is currently created `nologin` by migration `0004`, so it
**cannot authenticate as-is** — the bootstrap step is not optional.

---

## 7 · ⚠️ Architectural finding — the portal cannot reach a backend as deployed

This is the thing to decide before anything else, because it shapes the
deployment.

The portal's API client calls **relative paths with `credentials:
'same-origin'`**:

```ts
// web/src/api/client.ts
await fetch('/api/auth/session', { credentials: 'same-origin' })
```

Two consequences:

1. On `kgmlegal.vercel.app` there is **no API** — a static Vite SPA has no
   `/api` route. Every call currently 404s.
2. Even if the API were on another host, `same-origin` means the browser would
   **not attach the session cookie**, and the firm OS cookie is set
   `SameSite=strict`, which is never sent cross-site. Authentication would fail
   by design, which is correct — a session cookie crossing origins is a CSRF
   surface, not a convenience.

So the backend cannot simply be deployed "somewhere else" and pointed at. It must
be **same-origin with the portal**, achieved with a Vercel rewrite:

```json
{ "rewrites": [{ "source": "/api/:path*", "destination": "https://<backend>/api/:path*" }] }
```

The browser then sees one origin, cookies work, and no CORS relaxation is needed.
I have **not** written this file yet because the destination depends on where the
backend lands.

### On where the backend should run

Worth stating plainly: **this Express server is a poor fit for Vercel serverless
functions.** It assumes a long-lived process.

- Rate limiting is **in-process memory** (`RATE_LIMIT_STORE: 'memory'`) — each
  serverless invocation gets its own store, so limits stop meaning anything.
- It **seeds demo data on boot** and holds a Postgres pool; serverless would
  exhaust Supabase's connection limit.
- It serves the built SPAs statically, which Vercel already does.

A small always-on host (Railway, Render, Fly) plus the rewrite above is the
low-friction path that keeps the security model intact. That is a decision for
you, so I have left it open rather than guessing.

---

## 8 · 🔴 Credentials pasted in this conversation

Both credentials in the brief are now in this chat transcript:

| Credential | Risk | Recommendation |
|---|---|---|
| Vercel token `vcp_7i5LY…` | Reads 16 Supabase secret names; can deploy | **Revoke** |
| Supabase host/user | Enumerates the project | Low; keep |

The Vercel token is the one to act on. It also determines who can deploy
arbitrary code to your live portal.

Separately: **the GitHub repository is public.** It contains the full
authorization model. If that is not intentional, make it private.

---

## 9 · What I completed this turn

Despite the blocker, everything that does not require the password is done:

| Artifact | Purpose |
|---|---|
| `server/src/db/role-guard.ts` | Fail-closed policy on connection identity |
| `server/src/db/postgres.ts` | `assertSafeRole()` + corrected FORCE-RLS claim |
| `server/src/index.ts` | Check runs before `listen()` |
| `tests/security/db-role-isolation.test.ts` | 11 tests, verified non-vacuous |
| `supabase/ops/create_api_login.sql` | Bootstrap, password via psql variable |
| `server/.env.example` | Every variable, with the two dangerous ones documented |

**362 tests pass** (323 server + 39 firm); all four workspaces typecheck clean.

---

## 10 · Next step

Two answers unblock the rest:

1. **The database password** — or run the bootstrap yourself (§6).
2. **Where the backend should run** (§7).

Then: migrate `0001`–`0006`, create the `portal_api` login, prove the boot guard
passes on a real connection, deploy, add the rewrite, and verify the portal
authenticates end to end.

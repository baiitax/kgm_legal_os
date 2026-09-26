# NAVIGATION REDESIGN · REPORT

**Both portals.** The client portal (`web/`) and the Firm OS (`firm/`) had their
rail/sidebar, topbar and bottom nav reviewed against the pages that exist and the roles the
server resolves, then rebuilt to one model per product. The review, the findings and the
decisions are in `docs/NAV-DESIGN-REVIEW.md`; this file records what was done, what was
measured, and what is deliberately still open.

---

## 1 · The client portal

### 1.1 One model, and it is the only list

`web/src/nav.ts` is new and is now the portal's single source for navigation:
groups, items, icons, label keys, the capability each item needs, badge sources, the mobile
slot order, and the parameterised route shapes. Read by:

| surface | what it reads |
|---|---|
| the route table (`App.tsx`) | `DESTINATIONS` + `DETAIL_ITEMS` — the routes are *built from* the model |
| the sidebar | `visibleNav(role).groups` |
| the header's orientation line | `groupFor(path)` / the longest match in the model |
| the tab bar | `slotCandidates(nav)` — Home and More fixed, three flexible |
| the More sheet | every visible destination the bar could not hold |

Before this, the portal held `NAV_GROUPS` and the `<Routes>` block as two independent
literals 400 lines apart, and nothing kept them in step.

### 1.2 The portal's two roles, finally used

`client_users.portal_role` has been resolved into every session since the portal was built and
read by no screen and no route. The model now maps the roles to capabilities:

```
client_primary  work · billing · account_admin · self · privacy
client_contact  work ·            —            · self · privacy
```

`billing` is the whole distinction: the holder has the money, the contact has the work. The
rule is stated in three places, on purpose —

* **the menu** (`web/src/nav.ts`) — a contact's rail has no Invoices group, and the More sheet
  shows a disabled tile that explains the rule rather than hiding it;
* **the router** (`Shell` / `RequireCapability`) — a typed URL yields a sentence, not a page
  that loads and then fails;
* **the server** (`requireAccountHolder` in `server/src/auth/middleware.ts`, mounted on four
  routes) — 403 `role_not_permitted`, audited.

Only the third is a control, which is why it exists.

### 1.3 One defect worth recording: the join that passed on SQLite

The first cut of the entity name rode on a LEFT JOIN added to
`getClientUsersForUser` — the query that already loaded the caller's `client_users` rows. It
passed the whole suite and returned **null on the live database**, for the reason this project
has now been bitten by twenty-odd times:

> `getClientUsersForUser` runs while the session is being **resolved** — the `auth` phase,
> before the request has a tenant or a client scope. `clients` has no RLS policy for that phase,
> so the join matched nothing. SQLite has no RLS, so the same join passed every test.

The name is now read by the session **route**, in the portal phase
(`ClientService.getEntityName` → `repo.getClientEntityName`), where the tenant and client ids
are set and the policy applies. The live harness catches this and the suite cannot, which is why
the harness exists: `scripts/verify/portal-roles-live.mjs` asserts `clientName` is a string, not
that a query was written.

### 1.4 One header at every width

`.topbar` was `display: none` above 1024 px, so the desktop portal had no orientation line and
no visible unread count. It now renders at every width: **the section you are in and the client
entity the session acts for** on the inline-start edge, then the unread count, the language and
the account menu. The sidebar begins below it, in the same grid.

The entity name is new on the wire: `GET /api/auth/session` now returns `clientName`,
`clientNameAr` and `jobTitle`, sourced from a LEFT JOIN added to the query that already loaded
the caller's `client_users` rows — no extra round-trip, names only, and the identifiers stay
server-side exactly as §35 requires.

### 1.5 Five slots and a sheet

Home · three flexible slots · More. The three are the highest-priority destinations **this
member's capability set actually contains**, so a contact's bar never reserves a slot for a
screen the server refuses. More opens a full-height sheet with every remaining destination
grouped, the language control, the account panel and sign-out; Escape closes it and focus
returns to the slot that opened it.

This is the fix for the defect the review was commissioned over: **nine of fourteen
destinations were unreachable on a phone.**

### 1.6 One lie removed

`AuthProvider.adopt` optimistically set `portalRole: 'client_primary'` on the login response
before the authoritative session read landed, so a contact's rail briefly contained Invoices.
The optimistic role is now the narrow one.

---

## 2 · The Firm OS

§50 was already honoured — the tree is a permission projection and both the guard and the nav
come from one call. Three presentation defects were fixed and nothing about the authorization
model was touched.

### 2.1 The rail says whose reach it describes

The rail header gains an identity block: **name, role(s), then department · at firm**. It is
multi-tenant from day one, the same person holds different roles per firm, and a lawyer's ring
depends on their licence — a rail that omits the member, the role and the firm asks the reader
to guess which of their several selves is signed in. Two roles render as two, rather than a job
title plus one of them, because a member who holds both grants holds both.

### 2.2 Built modules first

Most of the tree is `planned` (Legal, Finance and Compliance are entirely so), and interleaved
with the four modules that work the rail read as a product that is mostly broken. Within each
group the built leaves now come first and the planned ones follow under one quiet
**قيد التطوير · In development** divider. Nothing is hidden, nothing is filtered, and the order
within each half is the tree's own.

### 2.3 The bar's default is per persona

`SLOT_PRIORITY` remains the global fallback; a new `PERSONA_PRIORITY` table supplies the
first-day order for the five role families (finance, compliance, administration, partner,
legal). Precedence is by specificity, so a finance director who is also a lawyer gets the
finance bar. The invariant is unchanged and still tested: usage outranks the default, the
authorised set bounds both, five slots, frozen while the app is open.

Because planned modules are not destinations, a persona's difference is felt today among the
modules that exist — an administrator's bar opens on Users, Settings and Audit; a lawyer's on
Matters, My Work and Clients.

### 2.4 The More sheet knows where you are

The sheet was the one surface that lit nothing: opening it to find the module you were already
standing in looked identical to every other tile. The current tile now carries `data-active`
and `aria-current`, marked by the same `isPathAllowed` the guard uses.

---

## 3 · Verification

| check | result |
|---|---|
| `web/src/test/nav.test.tsx` (new, 19) | **19/19** — capability model, unknown-role default, reachability per role over the whole model, sheet behaviour, header orientation, role chip |
| web suite (`npm run test:web`) | **49/49**, 6 files |
| `firm/src/test/rail-and-persona.test.tsx` (new, 14) | **14/14** — identity block (en/ar), built/planned split, divider placement, persona defaults, usage precedence, authorised-set bound |
| firm suite (`npm run test:firm`) | **68/68**, 7 files — `shell-layout`, `authorization`, `bottomnav`, `roles`, `sessions`, `language` all still green, untouched |
| `tests/security/portal-roles.test.ts` (new, 10) | **10/10** — the gate refuses all four surfaces by name, is no oracle, audits once with the reason, leaves nine work surfaces open, and the session names the entity |
| server suite (`npm run test:server`) | **577/577**, 17 files — run twice, before and after the RLS fix |
| `scripts/verify/portal-roles-live.mjs` (new) | **26/26** against the production server on the live database |
| `tsc --noEmit` server / web / firm | clean |
| `npm run build:all` | clean |
| deployed origin (`https://kgmlegal.vercel.app`) | **26/26** — see §3.2 |

### 3.1 The live harness, and what it found

`scripts/verify/portal-roles-live.mjs` runs against `http://localhost:8787` in the same
configuration production runs (`NODE_ENV=production`, `SEED_ROUTES` disabled, the live Supabase
database) and covers six things the suite structurally cannot:

1. the holder's session carries `clientName` — **the check that caught the RLS-phase defect**;
2. a contact is provisioned through the real invitation flow, on a development-mode instance
   (the dev router is not mounted in production and there is no flag to forget);
3. all four billing surfaces answer `403 role_not_permitted` over HTTPS, and a real invoice and a
   fabricated one are refused with byte-identical bodies;
4. six work surfaces stay open to the contact;
5. exactly one `AUTHZ_DENIED` row per attempt, read back out of Postgres, with
   `{capability: 'billing', portalRole: 'client_contact'}` and no denylisted key;
6. the served bundle carries the role model and **not** the server's error codes.

It is idempotent — the contact is created on the first run and reused afterwards — so it can be
re-run against the deployed origin, which is the plan once the push lands.

The demo contact it leaves behind is `ops.contact@gulfhorizon.example.test` on Gulf Horizon,
password `Demo!Contact2026` (synthetic, like every other demo credential). It exists so the two
portal roles can be shown side by side without editing the database.

---

### 3.2 On the deployed origin

Commit `8e69aa4`, pushed to `main`, deployed by Vercel (`kgmlegal-ayi2ft6gp…`, READY at
11:15Z). `scripts/verify/portal-roles-live.mjs https://kgmlegal.vercel.app` — **26/26** against
the live Supabase database:

* the holder's session carries `clientName = "Gulf Horizon Trading Co."`, and the client's
  identifier appears nowhere in the body;
* a contact authenticates, resolves to `client_contact`, and is refused all four billing surfaces
  with `403 role_not_permitted` — a REAL invoice and a fabricated one byte-identically;
* six work surfaces stay open to the contact;
* the trail holds one `AUTHZ_DENIED` row per attempt with
  `{capability: 'billing', portalRole: 'client_contact'}`;
* the served bundle carries the role model and not the server's error codes.

The deployed stylesheets were checked by reading them rather than trusting the build: the portal's
grid keeps the header at ≥1024 px (`grid-template-areas: "sidebar topbar" "sidebar main"`), the
print block hides the sheet with the other two surfaces, and the firm's rail carries
`.kgm-rail__identity`, `.kgm-rail__divider` and the More sheet's active tile.

## 4 · What is deliberately not done

* **Firm-side badge counts.** `NavLeaf.badgeKey` exists and `BottomNav` renders badges, and no
  route returns a task or notification count for the signed-in member. The prop stays declared
  and unused; wiring it to an invented endpoint would be worse than no badge.
* **Portal nav administration.** `account_admin` is in the capability model and has no route
  because the portal has no user-management screen. It is named so the capability set does not
  need editing when that screen arrives — not because it is wired.
* **Client search in the firm command palette.** The palette's entries come from the
  permission-filtered tree, and the global search routes are the ones the previous phase
  authorized. Nothing here changed it.
* **A second client role.** The rejected alternative — a finance contact who sees invoices but
  not advice — needs a third role and a migration. The capability table is written as a
  `Record<PortalRole, Capability[]>` so it is one entry when somebody needs it.

## 5 · Open items carried forward

* The cold-fleet sign-in wedge (self-heals at ~277 s; warm 90/90) is unchanged and unrelated.
* The live database keeps the probe artifacts from earlier phases by design
  (`PROBE-PRV-*` matters, the P0.4/P0.5 anchors).
* The demo contact account created during live verification is documented in §3 of the session
  notes; it is a demo-only login on the published demo credentials list's terms.

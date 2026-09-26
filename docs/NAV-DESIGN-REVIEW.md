# NAVIGATION REVIEW — BOTH PORTALS

**Scope.** The three navigation surfaces of each product: the **rail/sidebar** (desktop), the
**topbar** (context, account, global controls), and the **bottom nav** (≤899 px). Reviewed
against what each portal actually *has* — the routes that exist, the roles the server
resolves — rather than against the module lists in the two specifications.

**Method.** The route tables were read (`web/src/App.tsx`, `firm/src/App.tsx`), the nav models
were read (`firm/src/app/nav.ts`, and the `NAV_GROUPS`/`TABS` constants in `web/src/App.tsx`),
the live session payloads were inspected for both audiences, and each surface was asked the
four questions below.

1. **Reachability.** Can every destination be reached at every width, by every persona who may
   reach it?
2. **Truthfulness.** Does the surface ever offer a destination the server will refuse, or
   withhold one the member may use?
3. **Orientation.** Does the member always know which account they are in, as whom, and where
   they are?
4. **Fit.** Is the surface organised by the work the persona actually does?

---

## 1 · The client portal — what the review found

| # | Finding | Evidence |
|---|---|---|
| **C1** | **Nine of fourteen destinations are unreachable on a phone.** The bottom tab bar was a fixed five: Home, Matters, Documents, Invoices, Profile. | `TABS` in `web/src/App.tsx` vs the 14 authenticated routes |
| **C2** | **The portal has a role and does not use it.** `client_users.portal_role ∈ {client_primary, client_contact}` is resolved into every session and then ignored by every screen and every route. | `principal.clientUser.portalRole`; no other reader in `server/src` or `web/src` |
| **C3** | **Desktop has no topbar at all.** `.topbar` is `display: none` above 1024 px, so notifications, the language toggle and the account menu are reachable only from the sidebar footer — and the notification *count* is not shown at any width on desktop. | `@media (min-width:1024px) { .topbar { display: none } }` in `web/src/styles.css` |
| **C4** | **No orientation.** The topbar shows the client's *name* where a product would show the section, so "where am I" is answered only by the highlighted rail item — and only on desktop. | `TopBar` renders `name ?? t('app.portal')` |
| **C5** | **The account menu is the only way to sign out on mobile**, correctly — but it lives outside the tab bar's five slots while four lower-value destinations have slots. | `TABS` vs `AccountMenu` |
| **C6** | **Nav is hardcoded, not derived.** `NAV_GROUPS` is a literal in `App.tsx`; the route table is a second literal 400 lines below it. Nothing prevents a screen existing without a nav entry or the reverse. | `web/src/App.tsx` |

**What the portal is good at.** The account menu (keyboard-complete, inline-anchored in both
directions), the language toggle on anonymous screens, and the mobile-first page bodies.

---

## 2 · The Firm OS — what the review found

| # | Finding | Evidence |
|---|---|---|
| **F1** | **The rail never says who you are, in what role, at which firm.** The topbar carries the avatar; the rail carries the logo. A multi-tenant product whose members hold different roles per tenant has to answer that question in the surface that decides what they can do. | `AppRail` brand block |
| **F2** | **Built and unbuilt modules are interleaved.** Legal shows five leaves, all planned; Finance four, all planned; Compliance four, all planned. A rail in which most entries are inert reads as broken, not as honest. | `NAV_TREE` leaves with `planned: true` |
| **F3** | **The bottom bar's default order is one order for every persona.** `SLOT_PRIORITY` is a single array; a finance officer and a litigator get the same three flexible slots on their first day. | `SLOT_PRIORITY` in `firm/src/shell/BottomNav.tsx` |
| **F4** | **Badges are declared and never supplied.** `NavLeaf.badgeKey` exists (`notifications`, `tasks`, `messages`), `BottomNav` accepts a `badges` prop and renders them, and `App.tsx` passes nothing — so the count never appears anywhere. | `App.tsx` → `<BottomNav path=… onNavigate=… onOpenMore=… />` |
| **F5** | **The More sheet is better than the rail in one respect and worse in another.** It flattens groups into tiles (good) but has no notion of "where am I" (no active tile). | `MoreSheetBody` |

**What the Firm OS is good at.** §50 is genuinely honoured — the tree is filtered from
permissions, the guard and the nav come from one call, and the bottom bar is user-driven
*within* the authorised set with the invariant tested. Nothing here proposes to change that.

---

## 3 · Decisions

### 3.1 The portal gets a nav model, and the model is the only list

`web/src/nav.ts` becomes the single source: groups, items, icons, labels, **capability**, and
the mobile slot order. The route table and the nav read the same file, so a screen cannot ship
without a nav entry or vice versa (C6). *(Same discipline the Firm OS already has.)*

### 3.2 The portal gets two roles, and the server enforces them

`client_primary` and `client_contact` are mapped to a small capability set. The distinction
drawn is **authority over the account**, not seniority:

| surface | primary | contact |
|---|---|---|
| matters, hearings, deadlines, documents, messages, appointments, notifications | ✔ | ✔ |
| profile, security, privacy (own data, own sessions) | ✔ | ✔ |
| **invoices, receipts, recording a payment** | ✔ | — |
| **administering the client's portal users** (when it exists) | ✔ | — |

A contact is a colleague the client's account holder has given access to the *work*, not to the
*money*. The alternative reading — a financier contact who sees invoices but not advice — was
considered and rejected: it needs a third role, and inventing one to justify a menu is the
wrong order of work.

**Enforced server-side, not merely hidden.** `POST/GET /api/client/invoices*`,
`/api/client/receipts` and the payment route require `client_primary` and answer **403
`forbidden`** with `reason: role_not_permitted` on the audit trail. This is a role decision
about a surface the caller's client owns, not an existence oracle: the client id is already
theirs, so refusing by name discloses nothing they do not know. Without this, the role-filtered
nav would be exactly the "hide functionality" the project rejected.

### 3.3 Desktop keeps a topbar; the portal's is the same at every width

The portal's topbar becomes sticky at all widths and carries **context on the inline-start
side, controls on the inline-end**: the section you are in (from the nav model), then
notifications (with count), language, account. The sidebar moves *below* the topbar on desktop,
so the product has one header rather than two different ones (C3, C4).

### 3.4 The portal's bottom nav holds five slots and a sheet

Home · three persona-relevant destinations · **More**. More opens a sheet containing every
remaining destination, grouped, plus language, security, privacy and sign-out — which is how a
phone gets the nine destinations it could not reach (C1), and how sign-out stops being the one
thing hidden behind an avatar.

Slot selection is by capability-filtered priority, so a contact's bar never reserves a slot for
Invoices it cannot open.

### 3.5 The Firm OS rail states the identity, and separates what is built

The rail header gains a **member chip**: display name, role(s) and department, with the tenant
name beneath — the three facts that decide what the rail is showing (F1). Inside each group,
built destinations render first; planned ones are collected under a quiet "قيد التطوير · In
development" label so the rail reads as a product with a roadmap rather than a product that is
broken (F2). Nothing is hidden: every planned item stays visible and inert.

### 3.6 The Firm OS bottom bar gets persona defaults

`SLOT_PRIORITY` remains the global fallback; a new persona table supplies the *default three*
per role family (legal, finance, compliance, operations, administration), derived from the
member's roles in the session. Usage still outranks it, the authorised set still bounds it, and
the frozen-while-open rule is unchanged (F3).

### 3.7 What is deliberately not changed

- **The Firm OS nav tree, its group ids, its permission gates and its `planned` flags.** They
  are asserted by four test files and encode §12's structure. This review re-orders and
  re-labels presentation; it does not re-litigate the tree.
- **The portal's account-menu contract** (`.topbar`, `.acct__trigger`, `.acct__panel`,
  `inset-inline-end`): the sign-out accessibility work from an earlier phase is preserved
  exactly, because it is load-bearing.
- **Badge counts on the firm side** (F4): there is no firm-side endpoint that returns a task or
  notification count for the signed-in member. Wiring a badge to an invented endpoint is worse
  than no badge, so the prop stays declared, unused, and recorded here as an open item.
- **The route tables' shape.** The portal keeps `react-router`; the firm keeps its own switch.

---

## 4 · Acceptance criteria for the redesign

1. Every authenticated portal destination is reachable on a 360 px viewport, by a member with
   the capability for it. *(Fixes C1.)*
2. No nav entry renders for a member whose role cannot open it, and every nav entry has a
   route. *(C2, C6.)*
3. The four account surfaces that a contact may not use are refused **by the server** with a
   named 403 and an audit row. *(C2.)*
4. The portal shows a header at every width carrying orientation and the account control.
   *(C3, C4.)*
5. The Firm OS rail states member, role, department and tenant, and separates built modules
   from planned ones. *(F1, F2.)*
6. The Firm OS bottom bar's default three differ by persona, and every existing invariant —
   five slots, authorised set only, usage promotes, frozen while open — still holds. *(F3.)*
7. Both suites stay green, both products build, and the live deployment serves the result.

Findings, decisions and the outcome measured against these criteria are reported in
`docs/NAV-DESIGN-REPORT.md`.

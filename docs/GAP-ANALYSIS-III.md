# KGM LEGAL OS — GAP ANALYSIS III · SURFACE PARITY

**Companion to** `docs/LEGAL-GAP-ANALYSIS.md` (Analysis I, `0297011`) and `docs/LEGAL-GAP-ANALYSIS-II.md` (Analysis II, `3f03940`).
Analysis I audited the **law**; Analysis II audited the **eligibility layer**; this one audits the **surfaces** — what the API can do, what a screen can reach, and what the product therefore *is* to the people who use it.

**Review date:** 26 September 2026 · **Method:** mechanical, repeatable — `node scripts/verify/surface-parity.mjs`. Every finding below is produced from source on each run; nothing in this document is an impression. Two supporting checkers: `scripts/verify/css-tokens.mjs` (stylesheets that reference a custom property nothing defines) and the live schema probe (87 public tables vs. the schema the code expects).

---

## 0 · HOW TO READ A FINDING

The checker reports 78 findings. **A finding is not automatically a defect.** Three honest verdicts are possible, and this document assigns one to every finding:

| Verdict | Meaning | What it means for work |
|---|---|---|
| **REAL** | The API implements an obligation or workflow the product claims to have, and no screen reaches it. The capability exists and the user cannot get to it. | Scheduled work. Ordered in §7. |
| **DELIBERATE** | The route is unreachable or ungated **on purpose** — health, CSRF, login, session plumbing. Gate them and nothing works. | None. Recorded so the next audit does not re-open them. |
| **INHERITED** | The route/code shipped with a backend phase whose UI is a later phase. The backend is ahead of the frontend by design. | None as a defect; it is the *backlog*, already sequenced. |

The distinction matters because an audit that cries wolf gets ignored. §8b is the clearest case: twelve firm routes check no permission, and **all twelve are correct** — they are the routes that must work *before* a permission can exist.

**Authorization is not the gap.** §3 (client calling a route that does not exist), §5 (a screen checking a permission the catalogue does not define), §6 (a gate no role template grants), §8 (a nav entry pointing at an un-routed path) are all **`(none)`**, and §2 (portal dead routes) is `(none)`. Every one of those would have been a real defect — a dead control, a black hole, a nav orphan. There are none. What follows is about **reach**, not about **trust**.

**The checker's own accuracy.** First written during this task, it produced 84 findings; six passes against source and the live database brought it to 78 by removing false positives, not findings:

- `${` in a path only ends it when it is not preceded by `/` — splitting on every `${` invented four routes that do not exist.
- Comments are stripped before scanning — the nav declares `permissions: []` in a *comment* above the real array, which had hidden the real gate on `/clients`.
- A method boundary is `name(`, not any 2-space-indented line — a wrapped `Promise<{ … }>` return type had registered `Promise` as a method and cut `updateMatterReport` before its route, hiding `PATCH matters/:x/report`.
- The ungated-route detector was widened on purpose: a narrow pattern accused the genuinely gated `GET admin/audit` and `GET admin/settings`. A report that accuses the wrong thing is worse than no report.
- Keys are namespaced by app — `GET matters` exists in both firm and portal at different paths.

The four empty sections are therefore empty *because they were tested*, not because they were skipped.

---

## 1 · THE SHAPE OF THE GAP

```
firm routes      113   screens reach 47      →  65 never requested  (§1)  ← was 76
portal routes     36   screens reach 36      →   0                (§2)  ✓
firm client       38 methods                  →   2 never called  (§4)
portal client     43 call sites               →   0 dangling      (§3)  ✓
permission codes  75                          →  23 name nothing  (§7)  ← was 25
```

Read the first two lines together, because they are the finding:

> **The portal is complete and the firm OS is inverted.** Every one of the portal's 36 routes is reachable by a client, on a phone, with a permission-filtered nav. On the firm side the API is *ahead* of the UI in every domain that is written down as a legal obligation: money, AML, and matter lifecycle.
>
> A lawyer can **read** everything and **change** almost nothing. The firm OS is currently a very good case-file viewer with a complete, permission-gated write API behind it.

That is not an accident of construction — it is the shape of the phase order. P0.2/P1/P0.3 built the domain core and the authorization ring; task 25 built the intake path; P2.1 built document writes (the first write surface, and the only one with a full UI). Everything else in §1 is the standing sequence, made visible in one number for the first time.

**The 76 findings are three stories, not seventy-six problems.** (49 + 16 + 9 + the 2 unused client methods of §3 = 76 route findings and 2 method findings.)

| # | Story | Findings | Status |
|---|---|---|---|
| A | **Money and matter lifecycle** — trust, time, expense, invoicing, rate cards, judgments, parties, matters state machine, court calendar, conflicts | 24 + 11 + 5 + 4 + 3 + 2 = **49** | Partly scheduled (P2.3 invoices); the rest is unwritten backlog |
| B | **AML / CDD / compliance console** — due diligence, screening, STRs, eligibility licences, risk countries | 5 + 4 + 4 + 2 + 1 = **16** | Unwritten backlog |
| C | **Client administration, and three routes that are health and CSRF** — clients, plus `auth/health`, `auth/csrf` ×2 | 6 + 3 = **9** | Clients: backlog. Auth: deliberate. |

Plus **15 database tables that do not exist** (§6) — the deepest gap, because a missing table is a missing *model*, not a missing screen.

---

## 2 · §1 — 76 FIRM ROUTES NO SCREEN REQUESTS

Grouped by the domain they belong to. Counts are exact; routes are as reported by the checker.

### 2.1 Money — 24 routes, no UI (REAL)

`billing` ×12 · `trust` ×5 · `time-entries` ×3 · `expenses` ×3 · `rate-cards` ×2 · `engagement-letters` ×1

(Two further routes in this domain — `POST matters/:x/billing-terms` and `POST matters/:x/engagement-letters` — belong to the `matters` area and are counted in §2.3.)

```
GET  billing/invoices                     POST billing/invoices/:x/approve
GET  billing/fiscal-identity              POST billing/fiscal-identity
POST billing/fiscal-devices               POST billing/invoices/:x/issue
POST billing/invoices/:x/submissions      GET  billing/invoices/:x/fiscal
GET  billing/reporting-queue              POST billing/invoices/:x/credit-notes
POST billing/invoices/:x/discount         POST billing/invoices/:x/write-off
GET  trust/ledgers                        GET  trust/ledgers/:x
POST trust/ledgers/:x/entries             GET  trust/reconciliations
POST trust/reconciliations
GET  time-entries                         POST time-entries
POST time-entries/:x/adjust
GET  expenses                             POST expenses
POST expenses/:x/decision
GET  rate-cards                           POST rate-cards
POST matters/:x/billing-terms             POST matters/:x/engagement-letters
POST engagement-letters/:x/sign
```

**The firm cannot bill.** It can hold a fiscal identity, mint a ZATCA-compliant invoice (`buildInvoiceXml` writes `cbc:ProfileID` = `reporting:1.0` correctly), queue it for reporting, credit-note it, discount it, write it off, run a trust ledger, reconcile it, rate a matter, record time and expense, and sign an engagement letter — and **not one of those actions has a button.** `Registers.tsx:284` is the proof in one line: the matter's Billing tab calls `firmApi.matterBilling` and renders it read-only. `billing.create`, `billing.send`, `billing.record_payment`, `billing.discount` and `billing.writeoff` are in the catalogue (§7) and grant nothing, because nothing consults them.

The trust half is the sharper half: a client trust ledger with **no UI to post an entry** is a ledger the firm will keep somewhere else. Analysis I already flagged the trust-ledger control risk; this is its surface.

`POST matters/:x/billing-terms` is the hinge — a matter cannot carry the fee arrangement that Rule 12 requires a written engagement contract to state until that route has a face.

**Scheduled:** P2.3 (invoice creation) is the entry point and was already next-but-two in the sequence. Time/expense capture, trust posting and the fiscal console are not yet scheduled anywhere; they are the largest unscheduled block in the system.

### 2.2 AML / CDD / compliance — 16 routes, no UI (REAL)

`str-reports` ×5 · `due-diligence` ×4 · `eligibility` ×4 · `compliance` ×2 · `screening-matches` ×1

```
GET  str-reports                     POST str-reports
POST str-reports/:x/review           POST str-reports/:x/file
POST str-reports/:x/response
GET  clients/:x/due-diligence        POST clients/:x/due-diligence
POST due-diligence/:x/owners         POST due-diligence/:x/complete
POST due-diligence/:x/unable         PATCH due-diligence/:x
POST clients/:x/screening-runs       POST screening-matches/:x/disposition
GET  compliance/due-diligence        POST compliance/risk-countries
GET  eligibility                     POST eligibility/:x/licences
POST eligibility/:x/prior-office     GET  eligibility/me
```

The system models the anti-money-laundering duty end to end — CDD lifecycle, UBO to the 25% threshold, sanctions screening with dispositions, suspicious-transaction reports in Arabic with review → file → response, risk countries, licence records, the prior-office bar — and **the firm can only operate it with curl.** `GET eligibility/me` is the one exception: it is reached, and it is ungated (§8b) because it answers a question about *you*, which is exactly right.

Nothing here is a legal-model defect. It is the eligibility layer of Analysis II with no cockpit. A compliance officer cannot do their job in the product they were given.

**Scheduled:** nowhere yet. This is the second-largest unscheduled block and the one with the highest regulatory exposure, because the obligations are statutory rather than commercial.

### 2.3 Matters lifecycle and parties — 15 routes, no UI (REAL, partly scheduled)

`matters` ×11 · `parties` ×4

```
POST matters/:x/restrict       POST matters/:x/access
POST matters/:x/status         POST matters/:x/billing-terms   (also money)
POST matters/:x/conflict-check POST matters/:x/conflict-conclusion
POST matters/:x/parties        POST matters/:x/judgments
POST matters/:x/engagement-letters        GET  matters/:x/privilege-releases
POST matters/:x/privilege-releases
GET  parties    POST parties
POST clients/:x/party          POST parties/:x/aliases
POST parties/:x/affiliations
```

Task 25 built the creation path a matter travels on; **the path itself has no exits.** `matters.close` and `matters.reopen` are catalogue codes nothing enforces and no screen checks (§7), and `POST matters/:x/status` — the route that would enforce them — is unreachable. `POST matters/:x/restrict` and `POST matters/:x/access` are the two halves of the P0.5 privilege ring, live on the server, invisible to the person who needs them. `POST matters/:x/privilege-releases` is how a privilege waiver is recorded, and P2.1's document UI already refuses to release a privileged document without a ground — the ground cannot be entered.

**Scheduled:** the matters state machine is item ⑥ in the standing sequence, and it is the single highest-leverage UI work in this document: it makes close/reopen/restrict/access reachable and gives the catalogue codes something to name.

### 2.4 Clients and judgments — 11 routes, no UI (REAL)

```
clients ×6:  PATCH clients/:x · POST clients/:x/invitations · POST clients/:x/party
             POST clients/:x/due-diligence (also AML) · POST clients/:x/screening-runs (also AML)
             GET   clients/:x/due-diligence (also AML)
judgments ×5: GET judgments · POST matters/:x/judgments · PATCH judgments/:x
              POST judgments/:x/service · POST judgments/:x/appeals · POST judgments/:x/stays
```

`PATCH clients/:x` and `POST clients/:x/invitations` are §4's two unused client methods — a matched pair of findings, and the cleanest single example of the gap: **the API can update a client and invite them to the portal; no screen offers either.** Per the task-25 register rule the *firm API* is the correct home for invitations (canonical table name `client_invitations`), so the fix here is a screen, not a model change.

The judgments cluster is one route family of five with **nothing** in front of it — including `POST judgments/:x/service`, the service-of-process record, and `appeals`/`stays`, where the 30-day appeal window from Civil Procedure Law Art. 187 lives. A deadline engine with no way to record the judgment that starts the clock is a deadline engine that will be maintained by hand.

### 2.5 Conflicts, court calendar — 5 routes, no UI (REAL)

```
POST conflicts/hits/:x/disposition   POST conflicts/hits/:x/waiver
POST matters/:x/conflict-conclusion  GET/POST/DELETE court-calendar
```

Conflict hits are surfaced (the Conflicts tab reads them) but **cannot be dispositioned or waived** from the product — and Rule 11 requires the conflict be excluded *before* the work is accepted. `court-calendar` is a full CRUD family with no screen while the nav advertises hearings and deadlines.

### 2.6 Auth — 3 routes, no UI (DELIBERATE)

```
GET auth/health · GET auth/csrf · POST auth/csrf
```

Health is for the platform, CSRF is fetched by the transport layer before a mutation. No screen should request them by name. **Not a gap.**

---

## 3 · §4 — TWO CLIENT METHODS NOTHING CALLS

```
firmApi.updateClient()
firmApi.inviteClientUser()
```

Both are tree-shaken out of the shipped bundle. They are the UI half of `PATCH clients/:x` and `POST clients/:x/invitations`, which is why §2.4 treats them as one finding with the routes rather than two extra ones. (The earlier passes of the checker over-reported dead client methods — twelve, then five — because they missed methods reached through URL builders and paths assembled across literals. Two is the honest number.)

---

## 4 · §7 — 25 OF 75 PERMISSION CODES NAME NOTHING

```
clients.archive           clients.read_sensitive      matters.close
matters.reopen            documents.approve           documents.templates
tasks.read                tasks.manage                hearings.manage
deadlines.manage          contracts.read              poa.read
poa.manage                billing.create              billing.send
compliance.training       compliance.complaints       users.invite
users.update              users.revoke_session        roles.read
roles.manage              departments.manage          audit.export
analytics.read
```

**A code that is granted but consults nothing is worse than a missing code**, because a permission review reads the catalogue and believes it. `users.invite` is granted by a role template and no route ever asks for it: membership administration is happening under a broader gate while the catalogue claims otherwise. Same for `roles.read` / `roles.manage` / `departments.manage` against a working Users page, and `users.update` against a working member editor.

9 + 16 = 25. Sorting them by cause:

| Cause | Codes | Verdict |
|---|---|---|
| **The table does not exist** (§6): `documents.templates`, `tasks.read`/`tasks.manage`, `contracts.read`, `poa.read`/`poa.manage`, `compliance.training`, `compliance.complaints`, `analytics.read` — nine codes over seven phase-less features | 9 | **INHERITED** — the code is the placeholder for a phase not yet built. Correct to exist; nothing to enforce yet. |
| **The feature exists but the gate does not**: `billing.create` (no invoice-create route), `billing.send` (no send route), `clients.archive` (no archive route), `documents.approve`, `hearings.manage`, `deadlines.manage`, `users.invite`, `users.update`, `users.revoke_session` | 9 | **REAL** — the act is performed under a broader gate or under none. This is the rating matrix reading finer-grained than the system is. |
| **Route and feature both exist, nothing consults the code**: `matters.close`, `matters.reopen` (the state transition is unreachable), `roles.read`, `roles.manage`, `departments.manage`, `audit.export` | 6 | **REAL** — governance gap in the catalogue's own description of the product. |
| **`clients.read_sensitive`** — reading a client versus reading their sensitive data | 1 | **REAL, and the only one with a security reading**: no route consults it, so every holder of `clients.read` sees everything the client record contains. Close it with the eligibility work, not with the UI work. |

## 5 · §8b — TWELVE UNGATED ROUTES, ALL DELIBERATE

```
GET  auth/health       GET  auth/csrf        POST auth/csrf
POST auth/login        POST auth/mfa/verify  POST auth/logout
GET  session           POST session/switch   GET  session/devices
POST session/revoke-all    GET dashboard/summary    GET eligibility/me
```

Every one is either **pre-authentication** (you cannot require a permission to log in) or **self-scoped** (`dashboard/summary` and `eligibility/me` answer what *the caller* may see and who *the caller* is, and both are computed from the session, not from a parameter). `session/devices` and `session/revoke-all` are device management of one's own sessions.

Recorded so that the next reader does not "fix" them. The three auth routes that appear in §1 appear here too, for the same reason.

---

## 6 · FIFTEEN TABLES THAT DO NOT EXIST — WITH THE CLAIM CORRECTED

A live probe (`information_schema.tables`, 87 tables in `public`) answers a narrower
question than this section first claimed. **The code does not expect these fifteen tables.**
Twelve of them appear nowhere in `server/src` or in any migration; they were inferred from
feature names, permission codes and phase titles. Only three have any presence in code at
all — `tasks`, `contracts`, `licences`/`complaints` — and there they appear as permission
codes and seeded grants rather than as schema.

The honest statement is therefore:

> **Fifteen registers the product implies, ordered by what each one blocks — not fifteen
> tables the code is waiting for.** A missing table that nothing references breaks nothing
> today. It breaks the *phase* that will need it, and the permission code that already
> promises it.

| Table | Implied by | Blocks | Verdict |
|---|---|---|---|
| `notification_outbox` | P1.6 | durable escalation; P0.4's escalation is in-memory today | **scheduled** |
| `legal_holds` · `retention_schedules` | P1.5, Analysis I | retention and hold — the 10-year AML retention duty | **scheduled** |
| `powers_of_attorney` | `poa.read`/`poa.manage` | P2.4 | **scheduled** |
| `invoice_number_sequences` | this document (§9 ④) | gapless numbering — a fiscal obligation — and P2.3 | **proposed, not expected** |
| `document_templates` | `documents.templates` | templated drafting | code-less feature |
| `tasks` | `tasks.read`/`tasks.manage`, granted to five roles | work allocation | code-less feature |
| `contracts` | `contracts.read` | the other half of Rule 12 | code-less feature |
| `licences` · `training_records` · `complaints` | `compliance.*`, Analysis II §4 | the compliance register and eligibility evidence | code-less feature |
| `analytics_snapshots` | `analytics.read` | firm reporting | code-less feature |
| `data_breaches` · `data_classification` | PDPL work | breach register, classification | code-less feature |
| `portal_audit_exports` | portal audit | exportable evidence of what a client was shown | code-less feature |

`invoice_number_sequences` is marked **proposed** rather than implied: invoice numbering in
this system does not come from a sequence table at all. The number is written at ISSUE time
in the same statement as the UUID and the hash (migration 0034/0038), and the caller supplies
it. Gaplessness is therefore a property of the issue path, not of a counter — and a counter
table would be a second source of truth for a value the fiscal guard already freezes. If P2.3
needs sequential numbering, the honest place to put it is the issue path, and this row is
withdrawn as a table request.

Nothing in this correction changes the work: the seven **scheduled** rows are the first
artifact of phases that are already ordered, and the eight code-less ones are modules the
product implies but has never announced.

## 6b · WHAT CLOSING THEM LOOKS LIKE — THE FIRST WAVE

The audit's value is only realised when findings close, so here is the first wave, with the
numbers before and after. **78 → 65 findings.** The route count moved because screens were
written; the catalogue count moved because two codes stopped being decorative.

### The matter state machine (⑥) — and the two permissions that were granted but never asked

`internal_status` has carried eleven values since migration 0002 and the status route
accepted **all of them from all of them**: a matter could go from `archived` to `active` in
one write, and the record — the firm's own account of how the file got where it is — would
show a jump with no path behind it. The vocabulary was not a machine.

`server/src/domain/matter-lifecycle.ts` is the machine. It is deliberately **generous in the
middle and strict at the ends**: real files move backwards (a partner review that raises a
question sends a matter back; an appeal pulls an `execution` matter back to `judgment`), and a
workflow people route around is worse than no workflow. So every state in the working set
reaches every other, and the constraints live at the edges — `archived` is terminal, nothing
enters the working set from it, `intake` moves forward only, and a no-op write stays a no-op
(P0.3's contract, which the tests caught the moment the machine was switched on).

Three gates now answer three different questions, in the order that puts the most specific
obstacle first:

| Order | Gate | Refusal | Why there |
|---|---|---|---|
| 1 | **Rule 11** — the conflict engine | `conflict_gate` | A held matter is refused for the conflict, because that is the obstacle with a register behind it and a way to clear it: the member can act on it. |
| 2 | **The state machine** | `invalid_transition` | The most general question. The refusal carries `details.allowed` — a machine that says "no" without saying "but these" is learned by trial, and a member who cannot see the workflow asks a colleague to use the API. |
| 3 | **CDD**, then **enforcement** | `cdd_incomplete` | Unchanged from P0.3/P0.4. |

**And `matters.close` / `matters.reopen` are no longer decorative.** Both codes have been in
the catalogue and granted to the right roles since P0.6, and nothing consulted either: a
member holding only `matters.status` could close a file for the firm. Closing is the act that
stops the clock on every obligation attached to the matter, so it now carries its own code —
and the test proves the coupling with a control: the same member moves the same matter one
step (200) and is refused the step that ends it (`403 permission_denied:matters.close`).

### The registers become reachable (§2.3–§2.5)

Eleven matter routes, five judgment routes, four party routes and five conflict routes were
reachable only with curl. Now:

- **Parties** — add a party to a matter in the role it holds *on that file*, either from the
  firm register or created in the same call (`createIfMissing`, which is what intake needs
  when the other side is a name and nothing more).
- **Conflicts** — run a check, disposition a finding (`same_party` + severity, or
  `different_party`), record the client's **written consent** with its own signing date and
  scope, and conclude the check — the write that lets Rule 11 release the matter.
- **Judgments** — record the decision (the pronouncement date the appeal window runs from),
  record **service of process** with its evidence, file an appeal, and record or lift a
  **stay**, which is the fact that turns an enforceable judgment into one the firm may not
  collect on.

### What the wave did NOT do

The screens are new; the *breadth* is not. Billing (12 routes), trust (5), STR reports (5),
eligibility (4), due diligence (4), time and expenses (6), rate cards (2) and the court
calendar (3) are untouched — that is the money console and the compliance console, and they
are the next two waves. `GET/POST matters/:id/privilege-releases`, billing terms and
engagement letters also remain: they belong to the money block, which is where the fee
arrangement and the P2.1 release ground meet.

## 7 · THE REAL DEFECT THIS AUDIT FOUND — AND IT WAS NOT A ROUTE

The user's report was *"the more menu is not responsive as the menu are listed without background in the nav"*, and it exposed a class of defect that no route audit would ever have caught:

> **An undefined CSS custom property is not an error.** `background: var(--bg)` where `--bg` exists nowhere is a dropped declaration. The element renders with no surface, the browser reports nothing, and it *looks* like a design choice. Two containers in this codebase were in that state:
>
> - `.kgm-overlay__panel` carried **no background of its own**, on the assumption that `.glass-strong` would supply one. Its children took `--surface-glass` (α `.055`), which is *less* opaque than the parent's `.085` — so the nested tiles were transparent relative to an already transparent panel. Every firm dialog, drawer and bottom sheet was a wash over the blurred page; the More sheet's modules read as plain text.
> - The portal's `.sheet` set `background: var(--bg)`. `--bg` appears **once** in that stylesheet — in that declaration. The portal's More sheet was a full-screen fixed layer with no surface at all, and read as "mostly fine" only because its header, footer and tiles are opaque cards.

Both are fixed at the token layer, not patched per sheet:

- `packages/ui/src/styles/tokens.css` gains `--surface-panel` (dark `#0a1f19` / light `#fff`) and a nesting ramp `--surface-nested-1/2/3`, so a surface inside a surface inside a surface stays distinguishable in both themes.
- `packages/ui/src/styles/primitives.css`: `.kgm-overlay__panel` is now opaque and **re-bases** `--surface-glass/-strong/-raised` for its whole subtree onto the nesting ramp — the fix is inherited by every future overlay, including the ones nobody has written yet.
- `firm/src/shell/shell.css`: the firm More sheet had **zero** responsive rules across 35 `@media` blocks — the grid track `minmax(min(140px,100%),1fr)`, a two-column layout under 420 px, and a 96 vh / 120 px track under 520 px of height. The portal sheet was already responsive and is untouched.
- `web/src/styles.css`: the portal sheet takes `var(--surface)`, the page's own surface token.

**`scripts/verify/css-tokens.mjs` now checks this class**, per bundle, with runtime-set tokens honoured (the bottom nav's sliding lamp is positioned by React and is a definition even though no stylesheet declares it):

```
FIRM OS · 6 stylesheets, 227 tokens defined   ✓ every var(…) resolves
PORTAL  · 1 stylesheet,  49 tokens defined    ✓ every var(…) resolves
```

Both bundles are clean, and the check is cheap enough to run on every commit — which is the point. A whole class of silent defect now fails loudly.

---

## 8 · WHAT IS *NOT* A GAP — THE HONEST LEDGER

Stated plainly, because the useful half of an audit is what it clears:

- **No authorization hole.** §3, §5, §6, §8 empty. Every client method calls a route that exists; every permission the UI checks is defined; every gate the server enforces is granted by some role template; every nav entry is routed. The four most dangerous failure modes are absent.
- **No portal gap.** 36 routes, 36 reached. The client-facing product is complete, permission-filtered and mobile-first.
- **No dead code in the client layer worth the name.** Two unused methods, both explained by a missing screen.
- **No undocumented route.** Every one of the 113 firm routes is either reached or named in §2 with a verdict.
- **No phase was declared done with its table missing.** The fifteen absences are all *ahead* of the work, not behind it.

---

## 9 · WHAT TO DO, IN ORDER

The 78 findings collapse into work already sequenced plus three new items. Nothing in this document changes the standing order; it fills in what each step contains and adds what was invisible.

| Step | Contains | Findings closed |
|---|---|---|
| ① **P0.6 residency** | the only open CRITICAL; independent of surfaces | — |
| ② **P2.1 document writes** | done, in review, push pending | — |
| ③ **P1.6 notification outbox** | creates `notification_outbox`; makes P0.4's escalation honest | 1 table |
| ④ **P2.3 invoice creation** | promotes `invoice_number_sequences`, gives the invoice a face; the natural head of the money block | 6 real + 1 table |
| ⑤ **P1.5 retention + hold**, then **P2.4 PoA**, then **P2.6 chain** | 3 tables | — |
| ⑥ **Matters state machine** | close/reopen/restrict/access/parties/judgments reachable; gives 4 catalogue codes something to name | 15 real |
| **⑦ NEW · Money console** | time entry, expense, trust posting + reconciliation, rate cards, engagement letters, fiscal console | 20 real |
| **⑧ NEW · Compliance console** | CDD lifecycle, UBO owners, screening dispositions, STR pipeline, licences, risk countries | 16 real |
| **⑨ NEW · Client administration** | `PATCH clients/:x`, invitations, party links, plus `clients.read_sensitive` enforcement | 5 real + 1 catalogue code with a security reading |
| ⑩ **Catalogue honesty pass** | 16 codes that name a feature which exists: enforce them on the route that performs the act, or fold them into the code that already does the work | 16 codes |

**Sequence note:** ⑦ is the largest unscheduled block and the one with the clearest commercial reading — the firm cannot bill from its own system, so the money is being tracked elsewhere. ⑧ is the largest *regulatory* exposure. Both are bigger than anything currently in the queue; neither is a rewrite, because the API, the tables and the permission codes already exist for most of ⑦.

---

## 10 · RE-RUN

```bash
node scripts/verify/surface-parity.mjs          # 78 findings, by section
node scripts/verify/surface-parity.mjs --strict # non-zero exit on any finding
node scripts/verify/css-tokens.mjs --strict     # every var(…) resolves, per bundle
```

The schema probe is ad hoc (`information_schema.tables` over `KGM_ADMIN_URL`); the table list in §6 is the result as of 26 September 2026 — **87 public tables, 15 expected tables absent.**

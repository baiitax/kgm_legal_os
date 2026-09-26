# Task 24 · The navigation stops promising, and the tabs start answering

**Date:** 26 September 2026 · **Status:** complete · **Verified on:** the real Postgres
(db), 595/595 SQLite suite, 69/69 firm suite, 49/49 portal suite, 43/43 live harness

---

## 1 · What was actually wrong

The user's message carried a screenshot of the deployed firm app's **All modules**
sheet and three sentences. Each one named a defect that the previous phases had been
carrying without deciding to:

| The complaint | What the code was doing | Verdict |
|---|---|---|
| *"If the pages are not accessible for the logged in user then update the nav by removing it"* | `firm/src/app/nav.ts` listed **17 modules** with `planned: true`. They rendered as inert tiles — dimmed, unclickable, with a dot beside the label | The nav was a survey of the §12 spec, not of the build. On a real sign-in, ~85% of what a partner saw was something they could not open |
| *"Improve the design to make the portal fully responsive and Glassphomiris and use consistent color"* | The panels below the matter header were unstyled; the new read surfaces had no responsive rules at all | Panels now sit on the glass tokens, and every rule is fluid down to 360 px |
| *"The matters page … the other tablink are not working"* | `MatterTabs` rendered **13 tabs**, 12 with `data-disabled` and the body showing an "in development" card | The §22 tab list had been treated as a specification to display rather than a set of destinations to build |

The three complaints are one defect class: **a surface that describes more than it can
do**. An inert row and a broken row are indistinguishable to the member, and either
reading teaches them that the working rows are equally provisional.

---

## 2 · What changed

### 2.1 The navigation lists only destinations (`firm/src/app/nav.ts`)

Seventeen `planned` leaves and two `planned` groups are **deleted**, along with the
mechanism that rendered them: `NavLeaf.planned`, `NavGroup.planned`, the built/planned
split in `AppRail`, the rail's "in development" divider, the dot beside a planned
label, the `data-planned` branch in the More sheet and in the command palette, and the
`PlannedScreen` fallback whose copy said "in development".

The rail is now Dashboard · My Work · Clients · Matters · Admin (Users, Settings,
Audit) — filtered, as before, by the member's own permission codes.

Three §12 groups disappear entirely rather than emptying: **Legal, Finance and
Compliance**. Their modules are *implemented inside a matter* — hearings, deadlines,
documents, parties, conflicts, judgments, time, expenses and billing all render on the
matter's tabs — and an empty group would have been a rail row that routes nowhere,
which is the same lie in a different shape. Contracts, POA, messages, licences,
training and complaints are implemented nowhere, so they are not offered.

**The bottom bar lost its fixed five.** It used to render Home + three flexible slots +
More regardless of what the member could reach; a member entitled to two modules got
one padded slot. It now renders Home + up to three + More, and the suite pins the
smaller shape for a member with fewer permissions. A padded slot would have
reintroduced exactly the defect the rail just lost.

### 2.2 Twelve working tabs, four new endpoints, five new panels

**Server** (`server/src/api/firm.routes.ts`, `server/src/db/firm-repo.ts`):

| Route | Module gate | Matter gate | Reads |
|---|---|---|---|
| `GET /matters/:id/documents` | `documents.read` | `MATTER_OPERATE` | documents, minus the ring's, plus a withheld count |
| `GET /matters/:id/hearings` | `hearings.read` | `MATTER_OPERATE` | hearings, split upcoming/past against one server clock |
| `GET /matters/:id/deadlines` | `deadlines.read` | `MATTER_OPERATE` | deadlines with a server-computed `overdue` |
| `GET /matters/:id/timeline` | `matters.read` | `MATTER_READ` | the table P0.4's judgment routes append to |
| `GET /matters/:id/team` | `matters.read` | `MATTER_READ` | `matter_team` ⋈ `staff`, with the viewer's own access level |

**Two gates, not one.** Each route runs the module permission and *then* the matter's
access level, in that order, and the two fail differently: no module permission is a
refusal (403/404 with the reason), a matter outside the member's scope is a **404
byte-identical to a matter that does not exist**, because a 403 on someone else's file
is an existence oracle (bite (i)).

**Client** (`firm/src/pages/matter/Panels.tsx`, `Registers.tsx`): five new panels plus
four that now have screens (Parties, Conflicts, Judgments, Billing). Every panel
renders four distinct states — loading skeleton, refused, empty, data — because "there
is nothing here" and "this is not yours to read" are different facts and the second is
the one that needs saying.

The tab set itself changed shape: twelve destinations, and the three §22 modules the
firm has no system for (Contracts, POA, Messages) are gone rather than inert.

### 2.3 The dashboard stops apologising

Four metric cards rendered `—` and the words "in development". They now show the
member's real load from `GET /firm/dashboard/summary`, one SQL statement, four
scalars:

| Metric | Counts |
|---|---|
| Pending hearings | `hearings` still scheduled/postponed/prep |
| Deadlines this week | `deadlines` due in the next 7 days and still open |
| Documents pending | `documents` the firm requested and has not received |
| Outstanding | Σ(`total` − `amount_paid`) over sent/partially-paid/overdue invoices |

**`null` is a first-class answer.** A member who lacks the permission for a card gets
`null`, not `0` — a zero is a measurement, and "0 overdue" that means "not yours to
see" is a lie with a number's authority. The response also names what was withheld.

### 2.4 The count the ring could not produce (migration 0057)

Building the documents tab surfaced a real defect in the P0.5 design, and it is the
interesting one.

0054 makes the privilege ring a **database** rule: a restrictive policy on `documents`
means a member outside the ring does not receive the rows at all. That is the right
place for the rule. It also meant the application could not tell a matter that holds
nothing from a matter whose documents it is not allowed to count — so the panel could
not say *"one document is restricted to licensed lawyers"*, and the member would read a
short list as a thin file.

The fix follows the door P0.5 already built for `matters.internal_notes`:

**`0057_the_count_the_ring_withholds.sql`** adds
`firm_count_matter_privileged_documents(uuid)` — `security definer`, phase-asserted
(`kgm_is_firm()`), `matter_visible()`-gated, returning **a count and nothing else**.
EXECUTE is revoked from `PUBLIC` and granted to `firm_api` only; the migration refuses
to apply unless that ACL state holds, because `security definer` without the revoke is
a function every role in the cluster can call.

On SQLite the same predicate is a plain count in the repository. The dialect asymmetry
is the one this project already carries for `readMatterPrivilege`, and it is written
down rather than assumed — which is exactly why the live harness asserts the *number*
and not the mechanism.

**The ring predicate therefore moved into the query, not the answer.** An
application-side filter would have been a second copy of the rule that only ever ran
on SQLite (defect (o)); the row set is now the same on both engines, and the withheld
count is fetched deliberately.

### 2.5 The Glassphomiris pass

`firm/src/shell/shell.css` gained ~340 lines of panel styling and lost every rule that
only existed to decorate an unbuilt module. Four constraints, each a decision:

1. **Every colour is a token.** A script checks the block for hex literals: **zero**.
   KGM Green for accents, Saudi Gold for the privileged/internal and for overdue,
   `--kgm-critical` for the blocked.
2. **Glass is the surface, not the decoration** (§03). Panels sit on `--surface-1`,
   which *is* the glass token, so they lift off the atmosphere without a second blur
   pass each; the only element paying for `backdrop-filter` is the sticky matter
   header, because it is the only one content scrolls under.
3. **Fluid at every width** (§43). Rows wrap rather than `nowrap`; date columns move
   above their content below 900 px; tag clusters drop to their own line; every flex
   child that sits in a grid is `min-inline-size: 0`.
4. **Logical properties only.** No `left`, no `margin-left`. The firm ships Arabic
   first-class, and a physical property is a bug the English eye cannot see.

Overdue deadlines and the operative judgment share one visual grammar — a gold edge on
the inline-start edge plus a badge — so a list of twenty rows is scannable for the one
that is late, and neither state relies on colour alone (§30).

---

## 3 · Verification

### 3.1 The suites

| Suite | Result | Note |
|---|---|---|
| `tests/security/matter-workspace.test.ts` | **18/18** | new: the five tabs, both gates, the oracle, the ring's count, the dashboard's nulls |
| Server (17 files + the new one) | **595/595** | 577 → 595 |
| Firm (vitest) | **69/69** | six tests rewritten to the new policy rather than deleted |
| Portal (vitest) | **49/49** | untouched — the portal's own nav was task 23 |
| `tsc --noEmit` ×3 | clean | server · firm · |
| `npm run build:all` | clean | portal CSS `index-BBTMHyUr.css` unchanged; firm now `index-DXoskADD.css` |

The test changes are worth naming, because a test rewritten to pass is a test that has
stopped testing. Each one was **re-aimed at the new policy**:

* `shell-layout.test.tsx` — was "every unplanned leaf has a screen, and every planned
  leaf is inert"; now "every leaf in the tree has a screen, and the modules the firm has
  not built are not in the tree", with the eighteen absent paths enumerated so a future
  re-introduction fails at the first one.
* `rail-and-persona.test.tsx` — the built/planned split tests became "no inert row and
  no in-development rule", asserting `data-planned` appears **zero** times in the DOM.
* `bottomnav.test.tsx` — the fixed-five assertion became "shrinks to the reachable set
  rather than padding a slot", with the four-slot shape pinned for a member with two
  modules.
* `authorization.test.tsx` — the "Communication renders inert" test became "Messages is
  not offered at all"; the finance persona's "Billing is planned" note became "Billing
  is not a firm-wide screen".

### 3.2 The real Postgres (43/43)

`scripts/verify/firm-matter-tabs-live.mjs`, idempotent, accepts a base URL:

```
node scripts/verify/firm-matter-tabs-live.mjs http://127.0.0.1:8787
```

It inserts one privileged document under a fixed id, asserts on both sides of the ring,
and removes it — including on failure.

| Group | Checks | What it proves that SQLite cannot |
|---|---|---|
| 0057 | 4 | the function exists, is `security definer`, `firm_api` may execute it, `portal_api` may not |
| A | 17 | every tab answers with a record on the real database (hearings 2, deadlines 2, team 4, timeline 5, plus parties/conflicts/judgments/billing) |
| B | 9 | the partner sees the privileged document; the paralegal's response contains **no trace of its title** and still reports `withheldCount: 1` — the number that silently becomes `0` if 0057 is missing, not definer, or not called |
| C | 4 | a member without `documents.read` is refused; another firm's matter and a non-existent one are both 404 **and byte-identical** |
| D | 7 | the partner's dashboard counts real data (3 hearings, 4 deadlines, 101,225 SAR over 3 invoices); finance sees the money and `null` for the legal work; a litigator is not shown receivables |
| E | 1 | the counter is tenant-scoped |

The `withheldCount` assertion is the reason this harness exists. On SQLite it comes from
a plain query and would read 1 whether or not 0057 works; on Postgres it is a
`security definer` call, and only a live run can tell the difference.

---

## 4 · What is deliberately *not* here

* **No firm-wide Hearings, Deadlines, Documents, Billing, Time or Expenses screen.**
  Those modules are built inside a matter and that is where the nav now points. Adding
  a firm-wide diary is a real feature (P0.4 built the court calendar behind it) and not
  a nav row.
* **No Contracts, POA or Messages.** They have no system behind them, so they have no
  tab and no rail entry.
* **The portal was not re-styled.** Its navigation and glass pass landed in task 23 and
  its suite is untouched; the screenshot in the brief was the firm app. Say the word
  and the same panel treatment goes across.

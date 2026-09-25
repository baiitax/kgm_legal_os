# PHASE P0.4 — JUDGMENTS, SERVICE AND ENFORCEMENT

**Status:** complete and verified against the live PostgreSQL. Two commits (`2da7009`,
`3fa8be0`), nine migrations (0045–0052 plus the regenerated 0047), 54 new tests, 536 in the
suite, and **35/35 checks passing in the live harness**.

---

## 1 · What the phase is about

A judgment is a piece of paper until somebody is told about it. Everything the firm does after
a صك is issued — appealing it in time, collecting it, advising the client — turns on two facts
that are easy to record wrongly and impossible to repair afterwards:

- **when the party was served**, and
- **whether that service started a period, and which one**.

So P0.4 builds the register (`judgments`), the service register (`service_events`), the
challenges (`judgment_appeals`), the court calendar (`court_calendar`), the one piece of
arithmetic that turns a delivery date into a deadline, and the gate that refuses to let a
matter move into **execution** until every one of those facts is right.

The gate reads, in this order, and refuses with the first thing that is true:

| # | refusal | what the reader must do |
|---|---|---|
| 1 | `judgment_missing` | record the صك and its delivery |
| 2 | `judgment_not_enforceable` | the operative judgment orders nothing to execute |
| 3 | `judgment_not_served` | serve it — no period has started |
| 4 | `service_defective` | an attempt exists and none of them took effect: serve lawfully, or apply for substituted service |
| 5 | `execution_stayed` | a court said stop |
| 6 | `appeal_pending` | the matter is before a court |
| 7 | `appeal_window_open` | wait until the date carried on the refusal |
| — | admitted | the judgment follows the matter; it moves to `under_enforcement` |

**The order is the contract.** Seven of these overlap by construction — an unserved judgment
that orders nothing fails two of them — so the first true reason is the only one that tells a
person what to do next. Route, domain and database all speak the same sequence, and the
database enforces it whether or not the application asked.

---

## 2 · Where the arithmetic lives — the P0.3 lesson, applied in advance

`server/src/domain/judgments.ts` contains the only copy. The Postgres trigger and the SQLite
mirror **read** `appeal_deadline_at`, `appeal_rule_cited` and `appeal_rule_days` off the row;
neither re-derives them. If a served judgment arrives with no computed period, the database
refuses the write (`appeal_window_uncomputed`) because that is the state in which a system
believes it has diarised an appeal and has not.

P0.3 shipped the 25% ownership rule three times and only one copy was right. This phase
deliberately stores the answer instead of computing it again — and, because storing it is how
a rule gets frozen, adds **§P0.4-M**: a suite that reads the enforcement matrix out of the
domain, the SQLite trigger and the Postgres function and diffs all three as text, transition
by transition. The rule, not the schema.

The three rules as implemented:

1. **The period runs from the day AFTER delivery**, 30 days (10 urgent; cassation 30/15;
   التماس إعادة النظر 30 from knowledge) — نظام المرافعات الشرعية، المادة ١٨٧.
2. **The last day moves to the next day the courts sit**, past Friday and Saturday and past
   anything declared in `court_calendar`. The first day does not move.
3. **The window closes at 23:59:59.999+03:00** on the last day — the Kingdom's end of day, not
   UTC midnight, which would close a deadline three hours early.

Service semantics, each one asserted in both engines:

| outcome | is it service? | why |
|---|---|---|
| `served` | yes | the copy was delivered |
| `refused` | **yes** | a documented refusal is service |
| `substituted` | yes, at the **end** of the publication period | the court's period is recorded on the row, never defaulted silently |
| `unclaimed` | no | an uncollected letter is an attempt; the period runs from nothing |
| `untraceable` | no | an attempt that reached nobody |
| `pending` | no | it has not happened yet |

The database holds the same line as one equivalence:
`(outcome in (served,refused,substituted)) = (effective_at is not null)`.

---

## 3 · The nine migrations, and which of them were defects

0045 is the phase. The rest exist because the real database said no.

| file | what it carries |
|---|---|
| `0045_judgments_and_service.sql` | the four tables, the clock guard, the enforcement matrix, the gate, retention, RLS, and the **first** `firm_api` write grants on `deadlines` |
| `0046_judgment_permissions.sql` | six permissions, declared in the shapes the catalogue generator parses; `serve` is separate from `record` |
| `0047_audit_vocabulary.sql` | regenerated (148 actions) |
| `0048_the_firms_writes_beyond_its_own_tables.sql` | **defect (j), again**: `deadlines.client_status` was named in an INSERT and not granted for INSERT. Plus `matter_timeline`, which the firm could only read until now — append, client-visible rows only |
| `0049_the_judgment_follows_the_matter.sql` | the edge the matrix was missing: `awaiting_finality → under_enforcement`. A status column is a *record*, and a record can lag the facts: a period closes on a Thursday, nobody opens the file for a month, and the judgment is enforceable in law while its row still says it is waiting |
| `0050_the_browser_facing_roles_get_nothing.sql` | **the serious one — see §4** |
| `0051_the_procedure_the_firm_diarises.sql` | `deadlines` had a column grant and no policy: the firm's own procedural deadline was `new row violates row-level security policy` |
| `0052_the_function_the_trigger_calls.sql` | the trigger is `matter_execution_gate`; the function it calls is `matter_execution_guard`. 0049 replaced a function named after the *trigger* — which did not exist, so `create or replace` made one — and its verification asked the catalogue for the name it had just written. Both the replacement and the check were satisfied by the same mistake |

Two more found by the harness, in code rather than schema:

- **A boolean column written as an integer** — `client_visible = 0` in an INSERT, refused by
  Postgres with `column "client_visible" is of type boolean but expression is of type integer`
  and accepted by SQLite. This is defect **(c)** of the running list, met a twenty-second time.
  Every boolean in the P0.4 writers is now passed as a boolean and coerced by the driver.
- **A membership id passed into `deadlines.assigned_staff_id`**, which references `staff`. The
  demo engine never caught it because the SQLite mirror declared that column *without* the
  foreign key that Postgres has — so the mirror now carries it (`on delete set null`), and the
  same class of mistake fails locally from here on.

---

## 4 · The exposure: `anon` and `authenticated` held the whole schema

The live harness asked the deployed database a question no unit test can ask — *which roles
hold privileges on the judgment register?* — and the answer was not the two application roles.

```
anon:judgments:SELECT, anon:judgments:INSERT, anon:judgments:UPDATE, …
authenticated:service_events:DELETE, authenticated:court_calendar:TRUNCATE, …
```

**Forty-eight tables.** `firm_sessions`, `firm_memberships`, `client_due_diligence`, `str_reports`
and forty-four more. `anon` is the Supabase key that ships in a browser bundle.

Why it happened is the interesting part: **0004 did revoke these roles** —
`revoke all on all tables in schema public` — but that statement covers the tables that exist
*when it runs*. Supabase carries a default privilege granting ALL on new tables in `public` to
`anon` and `authenticated`, so every table created by every migration since then arrived with
the grant. Forty-four of the forty-eight had row level security enabled and no policy naming
either role, which is why this never showed up as a functional failure. **Four had no RLS at
all**: `eligibility_checks`, `prior_office`, `professional_licences`, `tenant_relationships`.
On those, the browser key could read, insert, update and delete every row.

0050 revokes on every table (what exists), revokes the **default privileges** (what will exist
next — the durable half that was missing), and walks the catalogue to enable and force RLS on
every table that lacked it. The harness now asserts all three, asked of the whole schema rather
than of the four tables this phase added, because a check that asks only about the tables you
just wrote answers your question and not the important one.

---

## 5 · What was verified, and how

**Suite — 536 tests, 15 files, green.** The P0.4 file is 54 of them, in thirteen suites:

- §A · the arithmetic asserted **against dates**, not against itself: the day after delivery,
  the last day pushed off a Friday, pushed again by a declared closure, and the window closing
  at 20:59:59.999Z.
- §B · service semantics as semantics.
- §C · the operative judgment (latest pronounced, tie broken by creation) and the matrix.
- §D · the permission split: a lawyer may record and serve and may **not** open enforcement.
- §E–§G · recording the صك, service starting the clock, and the challenges.
- §H · the gate on the matter lifecycle, **including the database's own refusal** beneath it.
- §I · six writes the database refuses that the route would never send.
- §J · the court calendar, including a declared holiday moving a computed deadline.
- §K · the register as a screen reads it.
- §L · the portal is shown none of the firm's posture.
- §M · **the drift gate** — the matrix read out of all three copies and diffed.

**Live harness — `scripts/verify/judgment-gate-live.mjs`, 35 checks, all passing** against real
PostgreSQL through the real routes, plus raw SQL as `postgres` where the question is about the
trigger rather than the route. It walked a probe matter through every refusal in order,
recorded a judgment, served it 70 days ago, checked the computed deadline against its own
arithmetic, watched the procedural deadline appear with `client_visible = false`, watched the
judgment reach the client timeline, opened enforcement, and then tried every illegal move
underneath the route. It found four of the six defects in §3 and the exposure in §4.

**Schema parity** — all 17 new statements pinned against the live grants
(`scripts/verify/schema-parity.ts`), statement-versus-grant, which is how 0048 was found before
the code ever reached Postgres.

---

## 6 · The permission matrix

| role | read | record | serve | manage (enforcement) | calendar |
|---|---|---|---|---|---|
| MANAGING_PARTNER | ✔ | ✔ | ✔ | ✔ | read + manage |
| PARTNER | ✔ | ✔ | ✔ | ✔ | read |
| LAWYER | ✔ | ✔ | ✔ | · | read |
| ASSOCIATE | ✔ | · | · | · | read |
| PARALEGAL | ✔ | · | · | · | read + manage |
| OPERATIONS | ✔ | · | · | · | read + manage |
| COMPLIANCE | ✔ | · | · | · | read |
| FINANCE | · | · | · | · | · |
| ADMIN | · | · | · | · | · |

Three lines carry the design:

- **`serve` is separate from `record`.** Recording a صك is reading a court document back into
  the file. Recording its *delivery* is the fact that starts a statutory period running — the
  one that has to be right, so it is the one with its own permission.
- **`manage` is where enforcement opens**, and a lawyer does not hold it. A lawyer who could
  record, serve and enforce could commit the firm to using the state's power to collect while
  the client was still deciding. Same instinct as `billing.create` versus `billing.approve`.
- **Paralegals and operations keep the calendar**, lawyers read it. Entering the Eid recess is
  clerical work, and a period computed against an incomplete calendar is wrong in the direction
  that hurts — the system would think a window had closed.

---

## 7 · Deliberately not in this phase

- **No `deadline_rules` catalogue table.** The three rules are a typed constant with the article
  they cite, and the arithmetic that uses them. A table would be a fourth place to store the
  same rule; the escrow/escalation work (P1.6) is where a firm-editable catalogue earns its keep.
- **No Najiz or portal integration.** Client-visible enforcement state is a projection question,
  and the projection was widened only by one timeline event.
- **No judgment on the client's side of the wall.** The portal timeline learns that the court
  decided. It does not learn the period, the service attempts or the enforcement posture — those
  are the firm's legal assessment, and §L asserts the absence.
- **No UI yet.** The routes, the register payload and the rules travelled to the client are built
  and verified; the firm screens (a Judgments tab in the matter workspace, and a court-calendar
  admin screen) are the next increment, and `appealRulesCatalogue()` is already on the wire so a
  screen can explain a date without hard-coding an article.

---

## 8 · Open, and honest

- **`matters` has no state machine.** Any status may follow any other, so `intake → execution` is
  reachable. The enforcement gate makes it harmless (a matter cannot enter execution without a
  served, unchallenged, enforceable judgment, which takes weeks of real work to be true), but the
  lifecycle is still a permission rather than a shape. A transition matrix on `matters` belongs
  in the same migration that gives the firm a matter-creation route.
- **The cold-fleet sign-in wedge** from the previous phase is unchanged and still documented: warm
  fleet 90/90 with zero refusals, cold fleet self-heals in ~277 s. P0.4 added no database work to
  the sign-in path.
- **`client_visible` on `matter_timeline` is a `boolean` in Postgres and an integer in SQLite**,
  which is exactly the divergence that cost the 500 in §3. The driver's `coerce` bridges it, but
  the mirror and the real schema should agree; a pass over every boolean column is worth a
  session of its own rather than a footnote in this one.

---

## 9 · The live deployment

Migrations 0045–0052 are **applied to the production database** (86 tables, 274 policies), and
the local server runs P0.4 against it. The two commits are local; the push needs the GitHub
credential, which does not survive between sessions — the portable bundle and patches in
`/home/user/github-push/` carry the history until it is supplied.

# KGM LEGAL OS — THE STATUS LEDGER
## Why the deep audit still lists things as missing

**Date:** 26 September 2026 · **Method:** every deliverable in `docs/LEGAL-GAP-ANALYSIS.md`
(Analysis I) and `docs/LEGAL-GAP-ANALYSIS-II.md` (Analysis II), checked against the
repository as it stands at commit `be5bde8` — migrations 0001–0060, the routes, the
domain, and each phase's own "what this phase did not do" section.

---

## 1 · The short answer

**Nothing on the list was forgotten, and nothing on it is missing for want of a decision.**
The audits describe a *sequence* of four obligations of professional diligence plus the
modules that make them usable, and roughly **five of eight phases are done**. Everything
still missing falls into exactly six buckets, and for each item below the bucket is named:

| # | Why it is missing | Count |
|---|---|---|
| **1** | **Not reached yet** — later in the agreed sequence, next on the list | 14 |
| **2** | **Delivered under a different name** — the plan's table name was replaced by a better one, in a migration that says so | 3 |
| **3** | **Deliberately deferred, with the reason written into the phase report** | 4 |
| **4** | **A decision, not code** — nothing in this repository can make it | 1 (+3 documents) |
| **5** | **Found by a later audit, then built** — the "missing" was real and is now closed | 1 |
| **6** | **Open and honest** — known defects each phase recorded and did not fix | 3 |

The one-sentence version: **the audit is not a defect list, it is a queue, and the queue is
in the order the audits argued for — legal exposure first, then record integrity, then
capability.** The reason more of it is not built is that each phase is gated on the one
before it: an invoice cannot be issued on a model with no fiscal identity, a deadline is
worthless without the judgment and service registers that start its clock, and every tab in
the matter workspace has to respect the privilege ring.

---

## 2 · What is built (the phases that closed)

| Phase | Deliverable | Status | Evidence |
|---|---|---|---|
| **P‑1** | Eligibility layer — `professional_licences`, `prior_office`, `eligibility_checks`, `MATTER_VIEWED`, single-firm guard | **built** | `0027`, `0028`; `docs/PHASE-P1-REPORT.md` |
| **P0.1** | Party model + conflict engine, Rule 8 windows, derived `conflict_cleared` | **built** | `0029`…; `docs/PHASE-P0.1` work, live-verified |
| **P0.2** | Fiscal identity, ICV/hash chain, UBL 2.1 XML, clearance/reporting, credit notes | **built** | `fiscal_identity`, `invoice_submissions`; `POST /billing/invoices/:id/{approve,issue,submissions,credit-notes}` |
| **P0.3** | AML/CDD — `client_due_diligence`, `beneficial_owners` (25 % UBO), `screening_runs`/`matches`, `str_reports`, activation gate | **built** | `0040`; `assertCddAdmits` in the route layer |
| **P0.4** | Judgments, service register, appeal arithmetic with the article carried, court calendar | **built** (no UI) | `0045`; `docs/PHASE-P0.4-REPORT.md` §7 |
| **P0.5** | Privilege ring, withheld-count mechanism, Rule 21 as data | **built** | `0054`–`0057`; 43/43 live |
| **Task 24** | Nav that lists only destinations, twelve working matter tabs | **built** | `7957dc3` |
| **Task 25** | The intake workflow: add client, open the case, assign, report | **built** | `1192440`, `0060`; 52/52 live |
| **P1.1–P1.4** | Trust ledger (أمانات), time/expenses/rate cards/billing terms, the two ceilings, the engagement gate | **built** | `0036`, `0037`; `engagement_gate` refusals in `firm.routes.ts` |

---

## 3 · Reason 1 — not reached yet (the queue)

Fourteen items, in the order the audits set. Each is a real absence; none is a surprise.

| Item | What is absent | Blocked by / why it is here |
|---|---|---|
| **P0.6 · Data residency** | the database runs in **`aws-0-us-east-1`** — US East — not in-Kingdom | **nothing**: it is independent of every feature and gets harder after go-live |
| **P1.5 · Retention & legal hold** | `retention_schedules`, `legal_holds` — **zero mentions** in any migration | the audit put it after trust money; it is now the first genuinely unbuilt P1 item |
| **P1.6 · Durable notification outbox** | delivery is a **process-local array** (`server/src/auth/email.ts`: `const outbox: OutboundEmail[] = []`), dev-only, lost on restart | P0.4 deliberately did not build it; the audit says build it *with* the deadline engine |
| **P1.7 · Real malware scanning** | `SCAN_DRIVER=stub` by default; `clamav` is configured in `config.ts` and never runs | operations, not code |
| **P2.1 · Firm document writes** | no `POST /documents` anywhere in the firm API — the documents tab is **read-only**; upload, release, restrict are absent | unblocks the conflict waiver attachment, the engagement letter and the version chain |
| **P2.3 · Invoice creation** | approve, issue, submit and credit-note exist; **nothing creates an invoice** | depends on P1.1/P1.2, both now built — so this is unblocked |
| **P2.4 · PoA register (وكالة)** | nothing, beyond a `poa.read`/`poa.manage` permission pair | sequence |
| **P2.5 · Najiz mapping** | schema hints only (`0029`, `demo-data.ts`); **no integration, no reconciliation table** | the audit explicitly required the mapping *before* any integration |
| **P2.6 · Document version chain** | no `supersedes_document_id` | sequence; cheap |
| **P2.7 · Sanctions-list management** | `screening_runs` exist; **no list ingestion, refresh cadence or false-positive disposition** | sequence |
| **N4 · Client complaints register** | `compliance.complaints` is a permission with no table and no route | Analysis II added it to P2 |
| **N5 · Forward fee disclosure** | no estimate/quoted-fee field surfaced to the client on the matter | Analysis II added it to P2 |
| **N6 · Gifts & government-interaction register** | nothing | Analysis II rated it LOW |
| **P3** | e-signature with legal weight (Nafath/Etimad), multi-jurisdiction regimes, realisation/WIP analytics, client-facing conflict consent capture | the audits put these last on purpose |

**Firm-side Messages and Contracts** belong in this bucket too: the client portal has
threads (`client.routes.ts /messages`), the firm has no messages route, and the Contracts
module is a permission pair with no implementation. Task 24 removed both from the
navigation rather than showing them dead — which is why they no longer look missing in the
UI, and are missing in the API.

---

## 4 · Reason 2 — delivered under a different name (not missing)

A grep for the plan's own table names reports three false gaps. Each rename is written
into the migration that did it, with the argument:

| Plan said | What exists | Where, and why the name changed |
|---|---|---|
| `service_records` | **`service_events`** | `0045:188` — *"records notices as well as judgments"*: a service register that cannot hold a notice is half a register |
| `str_flags` | **`str_reports`** | `0040:36` — *"a flag is the internal signal that something happened; a report is the filing to SAFIU"*: the obligation is the report, and the system records the obligation |
| `deadline_rules` (catalogue table) | **a typed constant + `appeal_rule_cited` on every computed date** | `PHASE-P0.4-REPORT.md` §7 — a table would be a fourth place to store the same rule; the firm-editable catalogue belongs with the escalation work (P1.6), where a firm can actually change a period |

This matters for the reading of the audit: **three of the "missing" items are the audit's
own placeholder names, superseded by better ones.** Any future ledger should grep for the
*obligation*, not the table name.

---

## 5 · Reason 3 — deferred deliberately, reason on record

| Deferred | The reason, as written |
|---|---|
| Judgments **UI** (a Judgments tab, a court-calendar admin screen) | `PHASE-P0.4-REPORT.md` §7 — the routes, register payload and the rules catalogue are built and on the wire (`appealRulesCatalogue()`); the screens are the next increment |
| Najiz / portal enforcement integration | same section — client-visible enforcement state is a projection question, and the projection was widened by exactly one timeline event |
| The appeal period on the client's side of the wall | §L of the P0.4 report asserts the **absence**: the client's timeline learns that the court decided, never the firm's posture |
| A `matters` **state machine** | §8 "Open, and honest": any status may follow any other; the enforcement gate makes `intake → execution` harmless but not impossible. Slated for the migration that added matter creation — which is task 25, and task 25 did not add it |

---

## 6 · Reason 4 — a decision, not code (P0.6)

`P0.6` is the only **CRITICAL-severity** item with no code at all, and it cannot be closed
from this repository:

* **The region.** Every migration, probe and harness connects to
  `aws-0-us-east-1.pooler.supabase.com`. Moving the project to an in-Kingdom region — or
  documenting a lawful transfer mechanism — is a Supabase/legal decision with a migration
  project attached. The audit's own words: *"a region change now is a migration; a region
  change after go-live is an incident."* This is the cheapest serious finding still open.
* **Three artefacts are documents, not software**: the DPIA, the data-classification
  register, and the breach-notification workflow with a record of the notification. The
  system can hold them (and `privacy_requests` already exists); it cannot write them.

---

## 7 · Reason 5 — found by a later audit, then built

Analysis II's central finding was that Analysis I had listed six defects which were
**one defect with six faces**: the system models *authority* ("may this actor do this
thing?") and never *eligibility* ("is this actor legally permitted to be doing this at
all?"). That was a genuine gap the first audit had not named, and it is now closed:
`P‑1` shipped `professional_licences`, `prior_office`, the Article 16 single-firm guard,
`MATTER_VIEWED` and the generic `eligibility_checks` gate record (`0027`, `0028`).

**This is the strongest argument for keeping the audits running.** Every phase since has
found defects its own suite could not: P0.4 found `anon`/`authenticated` holding the whole
schema; P0.5 found four errors in itself; task 25's live harness found three more today —
the read window 0060 closes, `client_status = 'active'`, and the internal row 0048's
policy refuses. Each was invisible to the SQLite suite and visible only against the real
database.

---

## 8 · Reason 6 — open and honest (recorded, unfixed)

Each phase ends with what it did **not** fix. These are known, written down, and not yet
scheduled:

| Open item | Where it is recorded | Consequence |
|---|---|---|
| `matters` has no state machine | `PHASE-P0.4-REPORT.md` §8 | `intake → execution` is reachable; the enforcement gate makes it harmless but the lifecycle is a permission, not a shape |
| SQLite/Postgres boolean divergence (`client_visible` is an integer in one dialect and a boolean in the other) | same | the driver's `coerce` bridges it; the audit calls for a pass over every boolean column |
| The cold-fleet sign-in wedge | P0.3/P0.4 reports | warm fleet 90/90, cold fleet self-heals in ~277 s; not re-opened by agreement |

---

## 9 · What this means to do next, in order

1. **P0.6 · residency decision** — one meeting, then either a migration project or a
   documented transfer mechanism. It is the only CRITICAL item open, it is independent of
   all feature work, and it appreciates.
2. **P2.1 · firm document writes** — upload, release, restrict. It is the single largest
   unblocker: the conflict waiver attachment, the engagement letter, the version chain
   and half the matter workspace are all waiting on it.
3. **P1.6 · durable notification outbox** — small, and it makes P0.4's escalation honest
   rather than in-memory. The audit paired them for this reason.
4. **P2.3 · invoice creation** — the fiscal model, the ceilings and the trust ledger are all
   built; the firm still cannot produce the invoice it approves.
5. **P1.5 · retention and legal hold**, then **P2.4 PoA** and **P2.6 version chain** — the
   remaining register work.
6. **The `matters` state machine**, as its own migration, precisely because task 25 built
   the creation path the P0.4 report said it should travel with.

---

## 10 · How to re-run this ledger

The check is cheap and should travel with every phase:

```bash
# tables the audits planned, by obligation rather than by name
for t in professional_licences prior_office eligibility_checks parties matter_parties \
         conflict_checks conflict_hits client_due_diligence beneficial_owners screening_runs \
         str_reports fiscal_identity invoice_submissions judgments service_events court_calendar \
         client_ledgers ledger_entries time_entries expenses rate_cards engagement_letters \
         retention_schedules legal_holds; do
  printf '%-24s %s\n' "$t" "$(grep -rl "create table if not exists public\.$t\b" supabase/migrations/*.sql | wc -l)"
done

# and the things that are a route, not a table
grep -rn "r\.post('/documents\|r\.post('/billing/invoices'\|'/poa\|'/contracts" server/src/api/*.ts
```

At `be5bde8` that second grep returns **nothing**, which is precisely items P2.1, P2.3,
P2.4 and the firm's Messages/Contracts module.

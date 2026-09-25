# Phase P0.3 — client due diligence, beneficial ownership, screening, and the report

**Status: complete, verified against the live PostgreSQL.**
Migrations `0040`–`0044` · 6 tables · 22 refusal tokens · 18 new audit actions · 45 new tests · 50 live checks · 31 refusal tokens with a status in total.

---

## What the phase was for

The Firm OS could open a matter for anyone. It knew who was allowed to act on a matter and
what they were allowed to do to it, and it knew nothing at all about the client the matter
was for — whether the firm had identified them, who stood behind them, whether any of those
people appeared on a list, and whether the firm had ever looked.

In Saudi practice that is not a missing feature, it is a missing obligation. Lawyers are
**DNFBPs under the Anti-Money Laundering Law (Royal Decree M/20 of 2017)**: customer due
diligence, beneficial ownership to a **25% threshold**, identification of politically
exposed persons, screening against the consolidated lists, a **suspicious transaction report
to SAFIU in Arabic within three working days**, and **ten years** of records. The
professional-conduct rules add the other half in **Rule 11**: verify the client's capacity,
the client's identity, and that there is no conflict — *before* the engagement, and
therefore before the matter is a live file.

So the phase has one invariant:

> **A matter does not become active for a client the firm has not identified — and where it
> is refused, the refusal names the thing that is missing, points at whoever can supply it,
> and leaves a record that the refusal happened.**

---

## What was built

**`0040_client_due_diligence.sql`** — applied to the real database.

- **`client_due_diligence`** — versioned. A record is superseded, never edited, because the
  thing a regulator asks for is what the firm *knew at the time*, and an editable record
  cannot answer that.
- **`beneficial_owners`** — with the 25% rule as a CHECK-backed rule and not a convention:
  an owner recorded by shareholding carries the share, a natural person carries a date of
  birth and a nationality, and a control right carries the document that creates it.
- **`screening_runs` / `screening_matches`** — a run names its provider and **which list
  sets it was run against**, because "screened" without "against what" is not an answer.
- **`str_reports`** — narrative, indicators, the filing clock, and the authority's response.
- **`aml_risk_countries`** — the firm's own register of jurisdictions, per list source.
- **`matter_cdd_gate()`**, a trigger on `matters`: the same refusal the route gives, in the
  database's own words, for a caller that is not this application.
- **`guard_aml_retention()`** and six `*_retention` guards: **nothing deletes an AML record
  for ten years** — not the firm role, not the superuser.

**`server/src/domain/aml.ts`** — the rules, in one place, as functions: `screeningState`,
`screeningSubjects`, `assessCdd`, `ownershipCoverage`, `deriveRisk`, `activationOutcome`,
`reviewDueAt` (24 / 12 / 6 months by rating), `strDueAt` (three working days, skipping the
Saudi weekend and a supplied holiday calendar), `strReadiness`.

**Routes** — twelve, all behind `firmCsrfGuard()` and an explicit permission:

```
GET  | POST /api/firm/clients/:clientId/due-diligence
PATCH        /api/firm/due-diligence/:id
POST         /api/firm/due-diligence/:id/{complete,unable,owners}
POST         /api/firm/clients/:clientId/screening-runs
POST         /api/firm/screening-matches/:matchId/disposition
GET  | POST /api/firm/str-reports
POST         /api/firm/str-reports/:id/{review,file,response}
GET          /api/firm/compliance/due-diligence
POST         /api/firm/compliance/risk-countries
```

Permissions are `clients.kyc` and `compliance.read|create|review|approve`. **FINANCE and
LAWYER hold neither**, which is the point: the person who bills the client is not the person
who clears them, and the test suite proves the 403 rather than assuming it.

**The gate** — `POST /api/firm/matters/:id/status`, entering `active`:

```
missing → unable to complete → incomplete → PEP (senior_approval_required)
        → cdd_beneficial_owner_missing → screening_incomplete
        → screening_unresolved → sanctions_match
```

The order is part of the answer. A file that is unfinished **and** has an unresolved hit is
refused for the unfinished file, because that is the thing to fix first; and the refusal is
written to the audit trail as `CDD_GATE_DENIED` with the code that was returned, so that the
sentence a compliance officer reads is the sentence that was recorded.

---

## What is verified, and how

| what | how | result |
|---|---|---|
| the register, the permissions, the gate matrix | `scripts/verify/cdd-gate-live.mjs` against the live API | **50/50** |
| the gate in the DOMAIN and in the DATABASE, for every fixture | the same harness, twice per client: route and direct SQL | 5/5 agree |
| the rules, the routes, the triggers, the refusals | `tests/security/client-due-diligence.test.ts` | **45/45** |
| nothing else was broken | the whole suite from the repository root | **461/461** (13 files) |
| the write paths and their grants agree | `npm run verify:parity` | **PASS** |

The live matrix, as the harness asks it — for each client, what the route says and what the
database says, because a rule that exists in one and not the other is the defect this phase
was written to remove:

| client | the facts | the answer |
|---|---|---|
| Ahmed Al-Saud | a complete record for an individual | **admitted** |
| Qadim | a 12% holder with a recorded control right | **admitted** — a control right is ownership below the threshold |
| Al-Nukhba | a 100% owner that is a *legal person* | refused `cdd_beneficial_owner_missing` |
| Gulf Horizon | a PEP, process left at standard | refused `senior_approval_required` |
| Al-Fajr | due diligence could not be completed | refused `cdd_unable_to_complete` — the prohibition |
| a client with no record | nothing | refused `cdd_missing` |

---

## The defects it found

These are the reasons the phase took the shape it did. Every one was found by running the
thing against the real database, not by reading it.

**1. The gate read the screen's facts, not the record.** The display shape always has a
facts object — a screen has to render empty fields — and feeding it to the gate made a
client with **no record at all** read as a record with missing evidence: the route said
`cdd_incomplete` while the database said `cdd_missing`. Two names for one situation, and the
actionable one is the one that says there is nothing to act on yet. Fixed with a separate
`gateFacts` that is `null` when there is no record.

**2. One rule, three copies, drifted.** The 25% beneficial-ownership rule lived in the
domain, in the SQLite mirror and in the 0040 trigger — and only the SQLite copy required
`owner_kind = 'natural_person'`. Postgres therefore counted a 100%-owned **holding company**
as an identified owner, and the live gate said `screening_incomplete` where the matrix
expected `cdd_beneficial_owner_missing`. When a rule exists in more than one dialect, the
rule is what has to be diffed — not the schema.

**3. An audit metadata key on the denylist silently dropped the event.** The gate refused
correctly and recorded **nothing**, because the metadata key was named `code` and the audit
writer's denylist refuses it. The refusal happened and no one could see that it had. The log
line said so; the control did not. Metadata key renamed to `refusal`.

**4. A subject nobody had screened was reported as an incomplete file.** `screening_incomplete`
existed in the database's trigger and was unreachable in the domain: the route fell through
to `cdd_incomplete` and listed the screening among the missing fields. "Nobody has looked at
this person" and "somebody looked and the hit is still open" are different sentences to a
compliance officer, so the domain now says which.

**5. THE FORM WROTE NOTHING AND SAID 200.** The repository's write takes **column** names
through an allow-list; the route passed the parsed body straight through in camelCase. Every
field was filtered out inside the repository, `updateDueDiligence` returned early, and the
route answered `200` listing the fields it had "updated". A due-diligence form that stores
no answers, with the gate downstream reporting every record as incomplete and nothing on
screen to explain why. Fixed three ways: an explicit `CD_COLUMNS` translation in the route,
a guard that fails the request when a body field has no column, and a repository that
**throws** on a column it does not own instead of dropping it.

**6. The completion answered about the state before it wrote.** `POST /due-diligence/:id/complete`
read the gate outcome from a load taken *before* the rating, the review clock and the
completion were written — so the response said `cdd_incomplete` about the record it had just
completed. The screen and the register disagreeing, in the reply to the request that made
them agree.

**7. The rating counted ownership for everybody.** The completion route assembled its own
facts object with `ownershipCoverage([])` and a client kind guessed from an empty string: it
produced `opaque_ownership` on individuals that own nothing, and never consulted the
jurisdiction register — so a client resident in a listed country rated high for a different
reason, and the reason list did not name the country. A reason that is true of everybody is
not a reason.

**8. A near-miss trigger name is a silent duplicate.** `0043` restated the gate as
`matters_cdd_gate` beside `0040`'s `matter_cdd_gate`, and both fired. When restating a rule,
the replaced object is dropped **by exact name** — `0044` does exactly that.

**9. The retention rule arrived in the harness.** The verification sweep deleted the probe
clients it had created; the next run died on `client_due_diligence_client_id_fkey`, because
the retention guard refuses the record's deletion for ten years and the foreign key carries
that refusal up to the client. That is not an obstacle to route around — it is the obligation
working, and it now decides what the sweep may delete.

---

## What P0.3 did not do

- **No screening provider is integrated.** A run records its provider, its list sets and its
  list date, and matches are recorded against it. Wiring a commercial provider in is a
  delivery task, not a design one — and the gate deliberately does not care who ran the
  screening, only that it ran, against a named list, and that every hit has been decided.
- **No FIU filing channel.** Filing records that the report left, when, and what came back.
  The channel to SAFIU is a separate integration.
- **The client portal's half of CDD** — a client uploading an identity document — is not
  part of this phase; the portal has its own document flow, and the due-diligence record
  already stores an identity number as a keyed hash and a mask rather than as text.
- **P0.4's court calendar** is not here. `strDueAt` already accepts a holiday list so that
  the answer does not change shape when the calendar arrives.

---

## What this changes about how the phases are verified

The P1 report ended with the Postgres-only defects. P0.3 adds a second family, and it is the
more dangerous one:

> **A write that silently does nothing looks exactly like a write that worked.**

Item 5 above passed 44 of 45 tests while the form stored nothing, because every assertion
was made against a *response*. The tests that now hold the line read the **row**. Item 2 was
found by diffing one rule across three dialects rather than diffing their schemas; item 3 by
reading a log that nobody had a reason to open; item 9 by a cleanup step that hit the law and
stopped. The pattern across all of them is the same: the enforcement was right and the
**evidence** of the enforcement was missing — which, in a compliance system, is the same as
having no enforcement at all.

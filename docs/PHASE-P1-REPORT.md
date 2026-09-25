# Phase P‑1 — the eligibility layer

**Status: complete, deployed, verified against the live PostgreSQL.**
Migrations `0027`, `0028` · 1 migration to fix what 0027 broke in production · 13 new tests · 26 live checks · 3 new verifiers.

---

## What the phase was for

Every control this system had, and there were many, answered one question:

> *May this actor do this thing?*

None answered the prior one:

> *Is this actor legally permitted to be doing this at all?*

That is not a gap in coverage, it is a gap in kind. Saudi professional obligations
are **status conditions on the person**, not limits on an action. A licence that has
been suspended does not make a particular matter-grant wrong; it makes the lawyer
unable to practise, and therefore makes *every* grant wrong. The system modelled
authority and not eligibility, so the two cases that matter most were both invisible:

| the case | what the system did before |
|---|---|
| a lawyer whose licence is suspended (قواعد السلوك المهني, Rule 10) | granted them matter access, and recorded nothing about whether anyone had asked |
| a lawyer employed by two firms (Article 16, اللائحة التنفيذية) | permitted it — `firm_memberships` was unique per tenant, which is exactly the arrangement the article prohibits |

---

## What was built

**`0027_eligibility_layer.sql`** — applied to the real database.

- `roles.requires_practising_licence`, declared **per role as data**, not hardcoded in
  a function. `PARALEGAL` is deliberately `false`: legal work under supervision is not
  practice, and a gate that demanded a licence from a paralegal would block a
  legitimate hire and teach the firm to route around the gate — the way compliance
  controls actually die.
- `professional_licences`, `prior_office`, `tenant_relationships`, `eligibility_checks`.
  The last is append-only, enforced by triggers rather than documented: *a check that
  can be edited is not evidence.*
- `assert_single_firm_affiliation()` — a second **active** membership for a licensed
  lawyer at an unrelated firm is refused, citing Article 16. A membership that has been
  **left** stays recordable, because that history is precisely what conflict checks
  need, and a guard that forbade it would stop the firm documenting its own past.
- The audit vocabulary recreated with `MATTER_VIEWED` and eight eligibility actions.
  This was not optional: migration 0023 makes the TypeScript union the database's
  contract, so until the constraint changed, **no call site could have written the
  action even if someone had tried.**

### One decision worth recording, because it was reversed

An earlier draft of 0027 stored `restriction_ends_on`, derived it in a trigger, and
exposed `prior_office_bar()` as a database function. **All three were removed.**

A derived value needs no storing — the `invoices.client_status` precedent — and a
trigger on one dialect would have meant two expressions of one rule, which is the
divergence behind the eleven Postgres-only defects. The five-year window now exists in
exactly one place, `priorOfficeBar()` via `addYears()`, which clamps to the target
month's last day so that 2020‑02‑29 + 5 years is 2025‑02‑28 and not 1 March.

The refusals live in the database; the predicates live in one shared repo query. SQLite
has no functions, so it mirrors the refusals only — and a tenant that invents a
"Legal Consultant" role is a data change, not a migration.

### `0028_eligibility_write_privileges.sql` — the fix for what 0027 broke

0027 granted `firm_api` the columns that **carry meaning** — the licence number, the
dates, the outcome, the evidence — reasoning that the database should own identity and
audit metadata. The reasoning was sound. The result was a production `HTTP 500` on the
first request that refused a matter grant to a suspended lawyer: the exact path the
phase was built for.

PostgreSQL requires a column privilege for **every column named in a statement**,
including one that has a default. `FirmRepo` names `id`, `created_at`, `updated_at` and
`verified_at` because SQLite has no `gen_random_uuid()` and because every other write
path in this codebase writes its own timestamps. The grant list and the statement
disagreed, the refusal surfaced as a permission error rather than a constraint
violation, and **SQLite could not see any of it** — one role owns the file and column
privileges do not exist there. 346 tests passed while the feature was broken.

That is the twelfth instance of this class of defect, and the first one a check now
precedes.

---

## What is verified, and how

### The test suite — 430 tests

346 server · 30 web · 54 firm. The 13 new ones in `tests/security/eligibility.test.ts`
pin the four claims that matter, in the belief that **the default is the thing worth
guarding, not the feature**:

1. **Absence is a refusal, not permission.** A practising role with no licence row
   reads `no_licence_on_record`. This is the inverse of every other nullable field in
   every other system, and it is the single most likely way this layer rots — a new
   joiner with no paperwork is the common case, and letting them through is convenient.
2. **Suspended outranks revoked outranks expired outranks pending**, and the reason is
   typed, so a refusal can be explained rather than merely suffered.
3. **A non-practising role is never gated.**
4. **A grant to an ineligible member is refused with the same response a member of
   another firm gets** — a distinct error would turn eligibility into a probe for who
   holds a licence, and licence status is health-adjacent personal data. The refusal is
   *recorded as evidence*, because a gate that refuses silently cannot be audited.

### Live, against the real PostgreSQL — 26 checks

`npm run verify:live`. Beyond the rules themselves, three things only the real database
can refute:

- **grants *and* policies admit `firm_api`** on all four tables — a grant with no policy
  and a policy with no grant both read as the same error, so only an end-to-end request
  distinguishes *secured* from *broken*;
- **`portal_api` can touch no column of any of them**, asked with `has_column_privilege`
  because `has_table_privilege` returns false for a role holding column grants — the
  first version of that check passed by being blind, which is worse than failing;
- **`MATTER_VIEWED` is written to PostgreSQL**, which is the only place the CHECK
  constraint built from the TypeScript union is exercised. If the vocabulary did not
  contain it, the read would still return 200 and `tryWrite` would swallow the
  violation.

And the negative control that keeps the file honest: **the same grant to an entitled
member is admitted.** Without it, a gate that refused everyone would pass every other
check in the file.

### The two dialects, compared directly

`npm run verify:parity` creates an in-memory SQLite database from the application's own
DDL, reads the live Postgres catalogue, and compares tables, columns, and — the part
that would have caught 0028 before deployment — **every column the server's statements
name, measured against the privileges it holds.**

It found three further defects of the same shape on first run: the INSERT branch of the
licence write (`id`, `verified_at`, `created_at`, `updated_at`), of the prior-office
write, and of the eligibility check (`evaluated_at`). None had ever executed live — the
suspension test takes the UPDATE branch, because the seeded licence already exists. The
live script now creates a licence and a prior office for a member who has none.

`npm run verify:sqlite` covers the path a fresh in-memory database cannot: `create table
if not exists` **silently skips a new column** on an existing table, so without
`ensureColumns()` the gate would read a column that is not there on every existing
database while passing every test. Asserted on the real demo file: 53 → 57 tables, all
nine roles backfilled correctly, existing rows and role links intact.

---

## Also in this phase

**`MATTER_VIEWED` on every matter read**, carrying the access level in `reasonCode`. Its
absence is why this system cannot answer a disqualification motion: imputed knowledge
attaches to the lawyer who read the matter, whatever any register says. The firm could
prove which PDFs were opened and could not prove who had looked at the case. Written
with `tryWrite` — deliberately the opposite of the rule for writes: a mutation whose
audit is lost must fail, a read whose audit is lost must not.

**The gate on matter assignment**, and four new routes: `GET /eligibility`,
`GET /eligibility/me`, `POST /eligibility/:id/licences`, `POST /eligibility/:id/prior-office`.
They reach a `compliance.licences` permission that has sat in the catalogue since
migration 0006 granting two roles the authority to manage something that did not exist.

**Revocation is deliberately not gated.** Removing a member from a matter is how a firm
responds to a suspended licence, so requiring the licence to be valid in order to revoke
would make the remedy unavailable in exactly the case it exists for.

**Seeded licences** on both dialects, dated so the demo exercises the expiry branch with
no code change when Faisal's licence lapses on 30 November 2026.

---

## What P‑1 did not do

Six items from the revised sequence remain, in the order the plan set:

| | | why it is where it is |
|---|---|---|
| **P0.1** | party model + conflict | the highest-severity gap: there is no *party* — counterparties, related entities and adverse parties exist only as free text, so no conflict check can be computed |
| **P0.2** | fiscal identity | `tenants` has no VAT or CR column, and ZATCA Phase 2 requires a UUID and a cryptographic stamp on every invoice |
| **P0.3** | CDD | lawyers are DNFBPs under Royal Decree M/20; five mandatory procedures, and the system has none |
| **P0.4** | judgments + service registers | **before** `deadline_rules`, because the appeal period runs from delivery of the صك — a deadline engine cannot cite a trigger it cannot record |
| **P0.5** | privilege ring | |
| **P0.6** | residency | |

P‑1 was placed first because it is the only one that changes the meaning of the
*membership*, and every later gate reads a member.

---

# Live verification — 25 September 2026

`scripts/verify/invoice-fiscal-live.mjs` · **40/40 checks, against the migrated
production database** (`aws-0-us-east-1.pooler.supabase.com`, 76 tables, 230 policies,
migrations 0001–0039 applied), driving the deployed API on `0.0.0.0:8787` and then
attacking the same rows directly with SQL.

    node scripts/verify/invoice-fiscal-live.mjs http://localhost:8787

It exists because the 416 behavioural tests run on SQLite, where a refusal is a trigger's
`raise(ABORT)`, one role owns every file and every column is writable by it. The deployed
system has two restricted roles, column-level grants, row-level security, and triggers
that exist in one dialect only — and it has now been wrong **four more times** in ways the
SQLite suite could not see.

| what the run proves | why it needs the real engine |
|---|---|
| the six new read doors answer with **data** | a grant with no policy and a policy with no grant read identically from outside; only an end-to-end request separates *secured* from *broken* |
| `portal_api` holds **no privilege at all** on the ten firm-only tables, and SELECT-but-never-write on the two client-facing ones | privileges are a Postgres fact; SQLite has none |
| `firm_api` may INSERT a ledger entry and may **not** UPDATE or DELETE it | the append-only rule has a trigger *and* an absent privilege, and the absent privilege is the half that survives someone disabling a trigger |
| a draft is issued through the API: official number, next ICV, hash recomputed from the returned XML, QR decoded, chain linked to the device's head | the ICV, the chain and the guards are Postgres objects |
| the issued document is then attacked **directly**: amend it, amend its lines, add a line, delete it — all four refused by the database, with `postgres` as the caller | refusals must hold against a caller who is not the server |
| the authority's answer is recorded against the invoice it clears | the answer route is the only way an invoice becomes `cleared` |
| **the policies narrow**: one client sees its own credit note and its own engagement letter and the other sees neither, **read as `portal_api`** | `postgres` is not a member of `portal_api` (`set role` is refused, 42501), so the proof needs a session that is the portal role — and it checks itself: the run reports the role it read as |
| every refusal arrives as a **refusal**: overdrawing the client's money, spending it with no evidence, naming a client the firm has no record of, issuing standard with no buyer VAT | a legitimate refusal that reaches the client as HTTP 500 is the worst of both answers |

## The four defects it found

**1 · Every standard invoice was refused.** `FirmRepo.getClientForInvoice` returned the
driver's raw row (`vat_number`) while the route read `client?.vatNumber`, so every buyer
looked VAT-less and `buyer_vat_required` was returned for invoices the firm was obliged
to issue. *The 41 tests that existed passed because they issue only simplified invoices:
the negative test was healthy while the gate was fully dead.* Repaired in `firm-repo.ts`
(one mapped projection) and pinned by the positive test that was missing.

**2 · A credit note against a standard invoice could never be shared.** 0034's
`guard_credit_note_fiscal_issue` looked the clearance up with `s.invoice_id = new.id`,
where `new` is a row of `credit_notes` — a comparison that can never be true, so the
guard raised `credit_note_not_cleared` even after ZATCA had cleared the invoice. A firm
could not correct a B2B tax invoice at all, and correcting it by credit note is the only
lawful way to reverse an issued invoice. SQLite's mirror of that guard did not implement
the rule at all, so nothing in the suite compared the two dialects. Repaired by
**migration 0039** (the function replaced, the wrong comparison named in the source), the
rule mirrored into the SQLite schema, and pinned both by a test that refuses-then-admits
and by the live harness.

**3 · The overdraft guard could not compute the balance.** `ledgerBalance` asked
`where ledger_id = ? and (? is null or entry_at <= ?)`. Postgres refuses to infer a type
for a parameter that is only ever tested for nullness (`could not determine data type of
parameter $2`), so the check that decides whether a client's money may be spent returned
500 instead of an answer. SQLite accepts it happily. Repaired as two statements — the
running balance and the balance as of a date are different questions.

**4 · An unknown client was a 500.** `POST /trust/ledgers/:clientId/entries` opened the
ledger on first movement, so a client id the firm has no record of reached the insert and
failed its foreign key. Repaired: the route refuses with a tenant-scoped 404 before it
writes anything, and the harness keeps that refusal pinned.

Two **data** gaps were repaired separately, and neither was a code defect: the live
clients predated the party register (`clients.party_id` was NULL, so a standard invoice
had no buyer VAT to name), which `supabase/ops/reconcile_demo.mjs` links by exact
same-name party and refuses to guess; and the demo's invoices predate the fiscal columns,
so they carry no UUID and are left exactly as they are.

## What this changes about how the phases are verified

The gate this project wrote into the plan of record — *real Postgres reconciled ·
projections not filters · audit union and DB admission · live harness · drift test* — is
now met for P0.2 and P1, and the harness is the artefact that meets it. The rule to carry
into P0.3 is the one those four defects keep teaching, in the order they were found:
**a rule that exists in one dialect is not a rule**, and a negative test that passes is
not evidence that the positive path works.

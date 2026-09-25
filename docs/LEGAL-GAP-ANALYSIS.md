# KGM LEGAL OS — LEGAL GAP ANALYSIS & PRIORITISED UPGRADE PLAN

**Reviewer role:** legal-systems consultant (Saudi practice, professional conduct, AML/CFT, e-invoicing, judicial procedure)
**Review date:** 25 September 2026
**Scope reviewed:** 26 migrations / 52 tables, 69 permission codes, 69 admitted audit actions, 9 roles, 21 firm API routes, 9 firm pages, 22 portal pages, 6 verification harnesses, 333 server + 84 front-end tests.
**Method:** schema and route inventory read directly from the repository, then measured against the obligations the system is *designed to serve*. Regulatory positions verified against current published sources (cited inline).

---

## 1 · VERDICT

The security architecture is the strongest part of this system and I would not change it. The authorization model — server-side resolution, projection of internal state into client-safe columns, RLS at the database, append-only audit, a §50 rule that no visual layer may widen access — is better than what most commercial legal platforms ship, and the drift tests that stop the navigation tree and the router from disagreeing are genuinely uncommon.

**But the system is a very good authorization engine for a law practice whose actual legal obligations it does not yet model.**

It knows, with precision, *who is allowed to see what*. It does not know **who is on the other side**, **what the client's actual risk is**, **when the appeal period expires**, **what the firm has to do to be allowed to act at all**, **whether the invoice it issues is a legally valid tax invoice**, or **whose money is sitting in it**. Those are the questions a Saudi law firm can be struck off, fined, or sued for answering wrongly.

The single most important finding: **there is no party model, and therefore no conflict-of-interest capability.** Everything else on this list is serious; that one is structural.

---

## 2 · THE CENTRAL FINDING — NO PARTY, THEREFORE NO CONFLICTS

### What exists

- `matters.conflict_cleared` — a nullable boolean.
- `matters.internal_status` — includes `'conflict_check'` as a lifecycle state.
- `firm_memberships` → permission code `compliance.review`.
- Audit action `CONFLICT…` — **absent from the 69-action vocabulary**; there is no `CONFLICT_CHECK_RUN`, `CONFLICT_CLEARED` or `CONFLICT_DECLINED`.
- A demo seed note reading *"INTERNAL: awaiting conflict clearance on counterparty."*

### What is missing

**The word "counterparty" appears in this system only as free text inside a demo note.** There is no table for parties, no link between a matter and an adverse party, no register of persons the firm must not act against, no screening history, and no record of who cleared what and why.

A grep across all 26 migrations and 16,556 lines of server code returns **zero** occurrences of `adverse`, `opposing` or `counterparty` as a modelled concept.

### The legal basis

Under the **قواعد السلوك المهني للمحامين** (Professional Conduct Rules for Lawyers, issued by MOJ decision 3453 of 1442H):

- **Rule 8/1** — a lawyer is prohibited from any act constituting an actual or potential conflict with the interests of *current or former clients* without the written consent of the affected client.
- **Rule 8/3** — acting against a former employer is not a conflict after **five years** from the end of that relationship.
- **Rule 8/4** — acting against a *former client* is not a conflict after **three years** from the end of that engagement.
- **Rule 11/2** — *before agreeing to take the work*, the lawyer must verify there is no conflict between the prospective client and the lawyer's current or former clients.
- **Rule 11/3** — the lawyer must verify the **identity and legal capacity of the client** before accepting instructions.
- **Article 10/4 of the Implementing Regulation** — partners in a firm may not represent *opposing parties in the same case* unless all affected parties consent in writing.
- **Article 14 of نظام المحاماة** — a lawyer may not accept a case against an entity for which they worked, except after five years.

Conflicts are also *imputed* across a firm: if one partner is conflicted, the firm generally is. That means screening must be firm-wide across all tenants of the practice, not matter-local. ([source](https://www.uqn.gov.sa/details?p=18214))

### Why the current design is worse than having nothing

`conflict_cleared = true` is a claim of professional diligence that **nothing in the system computes**. A boolean nobody derives can only be set by a human deciding to set it. In an audit, a disciplinary complaint, or a malpractice claim, that column is not a record of a conflict check — it is evidence that a checkbox was ticked. The system's own finest instinct is visible elsewhere: `client_status` on invoices is *derived* by `derive_invoice_client_status()` from the internal state, and the database **refuses** a value that contradicts the derivation. That is the correct pattern. Conflict clearance must be derived the same way, from a real run, or it must not exist.

### Severity: **CRITICAL** — this is the exposure that ends a practice, not a defect that degrades a feature.

### What the fix looks like

```sql
-- Parties are shared ACROSS matters and ACROSS tenants of the practice,
-- because the conflict question is "has this firm ever acted for or against
-- this person", not "does this matter mention them".
create table public.parties (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id),
  party_type         text not null check (party_type in ('individual','organization')),
  name               text not null,
  name_ar            text,
  name_normalised    text not null,          -- lowercased, ال/أ/إ/ة folded, spaces collapsed
  national_id_masked text,
  national_id_hash   text,                   -- screened by hash; plaintext never stored (§I3)
  commercial_reg_masked text,
  country            text not null default 'SA',
  is_pep             boolean,                -- null = not screened, not false
  sanctions_status   text check (sanctions_status in ('clear','potential_match','match')),
  sanctions_checked_at timestamptz,
  created_at         timestamptz not null default now()
);

-- The link. `role` is what makes the model useful: a CLIENT party is the
-- engagement, an ADVERSE party is the conflict, and the distinction is what
-- the screening query joins on.
create table public.matter_parties (
  matter_id  uuid not null references public.matters(id) on delete cascade,
  party_id   uuid not null references public.parties(id) on delete restrict,
  tenant_id  uuid not null references public.tenants(id),
  role       text not null check (role in ('client','adverse','counterparty',
                                           'witness','guarantor','beneficial_owner','third_party')),
  is_active  boolean not null default true,
  primary key (matter_id, party_id, role)
);

-- The run. Append-only. Never updated except to record a decision.
create table public.conflict_checks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id),
  matter_id     uuid not null references public.matters(id) on delete cascade,
  run_at        timestamptz not null default now(),
  run_by_membership_id uuid not null references public.firm_memberships(id),
  search_terms  jsonb not null,              -- exactly what was searched, reproducible
  result        text not null check (result in ('clear','hits','waived','declined')),
  rationale     text,
  waiver_document_id uuid references public.documents(id),  -- Rule 8: consent must be WRITTEN
  decided_by_membership_id uuid references public.firm_memberships(id),
  decided_at    timestamptz
);

create table public.conflict_hits (
  check_id    uuid not null references public.conflict_checks(id) on delete cascade,
  party_id    uuid references public.parties(id),
  matched_matter_id uuid references public.matters(id),
  match_kind  text not null check (match_kind in ('exact_name','fuzzy_name','national_id','commercial_reg','sanctions')),
  match_score numeric(4,3),
  within_window boolean,                     -- Rule 8/3–4: 5 years employer, 3 years client
  resolution  text check (resolution in ('no_conflict','waived','declined','referred')),
  primary key (check_id, party_id, match_kind)
);
```

And the rule, mirroring the invoice precedent exactly: **`matters.conflict_cleared` stops being a free boolean and becomes derived** from the latest decided check. A trigger refuses any transition of `internal_status` out of `'conflict_check'` unless a decided check exists, and refuses `conflict_cleared = true` when the latest run has unresolved hits inside the Rule 8 window.

**Also required by the same rule:** the screening query must be able to see **closed matters**, because Rule 8 is about *former* clients. Today `matters` has no index or view for that question, and the firm API cannot list a closed matter's opposing party because no such data exists.

---

## 3 · FINDINGS BY AREA

Severity: **CRITICAL** = legal exposure today · **HIGH** = integrity of the professional or financial record · **MEDIUM** = operational capability · **LOW** = depth/scale.

### A · Anti-money laundering and client due diligence — **CRITICAL**

**Exists:** `clients.identity_verified` boolean, `clients.verification_note` text, permission code `compliance.kyc`.
**Missing:** everything the obligation actually consists of.

Lawyers in Saudi Arabia are **Designated Non-Financial Businesses and Professions (DNFBPs)** under the Anti-Money Laundering Law (Royal Decree M/20). The MOJ/MOCI AML-CFT manual sets out the obligations for DNFBPs explicitly: customer due diligence (CDD), record-keeping, reporting of suspicious operations, training, and an independent compliance officer. ([source](https://www.aml.gov.sa/en-us/Rules%20and%20Instructions/Manual%20on%20AML-CFT%20issued%20by%20MOCI.pdf))

Specifically required and absent:

| Obligation | System state |
|---|---|
| CDD before establishing the relationship; **prohibited from acting if CDD cannot be completed** | One boolean. Nothing blocks matter activation. |
| Identification: full name, DOB, nationality, address, government ID (individuals); CR extract, AoA, **Beneficial Ownership Register** (legal persons) | `clients` has name, masked ID, CR-masked, email, phone, city. **No UBO model, no DOB, no nationality, no source of funds.** |
| **Enhanced DD for PEPs**, high-risk countries, high-risk transactions | Nothing. `risk_rating` exists on `matters` but is internal free-choice. |
| **Sanctions screening** — UN Consolidated, EU Consolidated, Saudi designations (SAMA circular 3/2025 obliges screening against these lists) | Nothing. Compliance is a permission code. |
| Ongoing monitoring for material change in risk profile | Nothing. |
| **STR to SAFIU, in Arabic**, plus a record that it was filed and a prohibition on tipping off | Nothing. |

The `is_pep` / `sanctions_status` columns sketched above are **deliberately nullable**: `null` means "not screened", `false`/`'clear'` means "screened and clear". A default of `false` on a screening column is the same defect class as the conflict boolean — a claim nothing computed.

### B · Procedural deadlines and limitation periods — **CRITICAL**

**Exists:** `deadlines` with `kind in ('client_action','internal_task')`, `due_at`, `priority`.
**Missing:** the rule engine, the calendar, and the classification that matters legally.

Saudi appeal periods are short and unforgiving, and the system has no representation of them:

| Path | Period | Basis |
|---|---|---|
| Appeal / review (ordinary) | **30 days** | نظام المرافعات الشرعية م187 |
| Appeal / review (urgent matters) | **10 days** | م187 |
| Cassation to the Supreme Court | **30 days** (15 urgent) | م193–194 |
| Reconsideration (التماس إعادة النظر) | **30 days from knowledge of the cause** — not from the judgment | م200–201 |
| Criminal appeal / review | **30 days** from delivery of the judgment copy | نظام الإجراءات الجزائية م194 |
| Criminal cassation | **30 days** | م199 |
| Administrative (Board of Grievances) | **30 days** (10 urgent) | اللائحة التنفيذية م33 |

Three mechanics the system does not model at all:

1. **The period starts the day *after* delivery**, not the day of delivery.
2. **If the last day falls on the weekend (Fri–Sat) or a holiday, the period extends to the next working day.** There is **no holiday calendar anywhere** in the 52 tables.
3. **Counting is by Hijri calendar for court purposes.** The portal has `islamic-umalqura` formatting for display, but no Hijri-aware date arithmetic. A deadline engine that computes in Gregorian will silently disagree with what Najiz shows the lawyer.

A missed appeal is malpractice with a determinate victim. Today the `deadlines` table cannot even *represent* an appeal period, because `kind` has no `limitation`, `appeal`, `cassation` or `reconsideration` value, and nothing stores the rule or the trigger event that produced the date. **A deadline with no citation is an assertion.**

Required: `deadline_rules` (jurisdiction, forum, procedure, trigger, duration, calendar, urgent flag), `court_calendar` (weekend + holidays, Hijri and Gregorian), `deadline_instances` storing `rule_id` + `trigger_event` + `computed_due_at` + the article cited, and escalation with acknowledgement.

### C · ZATCA e-invoicing — **CRITICAL (already overdue for most firms)**

**Exists:** `invoices` with SAR-only currency, `subtotal`, `vat_rate` defaulting 0.1500, `vat_amount`, `total`, `invoice_lines`, and a `storage_key` that would hold a "rendered PDF".
**Missing:** every field and artefact that makes an invoice a *tax* invoice.

- **No fiscal identity anywhere.** There is no seller VAT registration number, no seller CR number, and no buyer VAT number. A tax invoice without the seller's VAT number is not a tax invoice.
- **No UUID, no cryptographic stamp, no QR code, no XML, no PDF/A-3.** Phase 2 requires the invoice in XML or PDF/A-3 with an embedded XML, carrying a UUID and a cryptographic stamp.
- **No clearance/reporting state.** Phase 2 requires integration with the Fatoora platform: standard (B2B) invoices must be *cleared* before issue; simplified (B2C) invoices must be *reported* within 24 hours. There is no column recording that a submission happened, succeeded, or was retried.
- **No invoice counter (ICV)** or hash chain, which Phase 2 requires per device.
- **No invoice type classification** (standard vs simplified), which determines the whole submission path.
- **The client cannot obtain the invoice.** The portal's invoice screen offers `window.print()` and nothing else — there is no download of the compliant artefact. Under the mandate the buyer must receive it. A `storage_key` column exists and nothing renders to it.
- **`vat_rate` is hard-coded as a default and in `tenant_settings`.** A law firm's supplies are not uniformly one rate; the model cannot express exempt or zero-rated lines.

**Deadlines that have already passed or are imminent.** Wave 23 (>SAR 750,000 revenue) was due **31 March 2026**; Wave 24 (>SAR 375,000) was due **30 June 2026**; Wave 25 (>SAR 187,500) is due **1 February 2027**. Penalties begin at **SAR 5,000** per non-compliant invoice, and failure to integrate runs to **SAR 50,000**. ([source](https://taxnews.ey.com/news/2026-1705-saudi-arabia-announces-25th-wave-of-phase-2-e-invoicing-integration)) A functioning law firm today is almost certainly already in scope. This is not a roadmap item — it is a live exposure.

### D · Trust money and client funds (أمانات) — **HIGH**

**Exists:** `invoices`, `payments`, `receipts`. All of it is the firm's own revenue cycle.
**Missing:** any concept of **money the firm holds on the client's behalf**.

Client advances, retainers and unearned fees held in a client account are fiduciary funds. They are not revenue, must be segregated from the firm's operating money, must be reconcilable per client at any moment, and must not be applied to fees the client has not been invoiced for. There is no client ledger, no deposit/withdrawal record, no three-way reconciliation, and — importantly — `payments` records money against an **invoice**, so an advance paid before any invoice exists has nowhere to go in this model.

### E · Fees, time recording and the engagement contract — **HIGH**

**Exists:** permission codes for the whole domain (`time.read/create/adjust`, `expenses.read/create/approve`, `billing.discount`, `billing.writeoff`, `billing.record_payment`) and three numeric ceilings on `firm_membership`.
**Missing:** the tables and the operations.

- **No time entries table and no expenses table**, despite 8 permission codes governing them. This is the inverse of the usual problem: the authorization surface exists for capability that does not.
- **Two of the three ceilings have nothing to guard.** `financial_authority_sar` is genuinely enforced on invoice approval (`firm.routes.ts` — permission, then matter scope, then the numeric ceiling, which is exactly right). But **`writeoff_authority_sar` and `discount_authority_pct` are loaded into every session, displayed in the profile drawer, and enforced nowhere**, because no write-off or discount operation exists. A ceiling shown but not applied is worse than no ceiling: it tells the member they are bounded when they are not.
- **No billing basis per matter.** `invoice_lines` has `quantity` and `unit_price` only. There is no way to record whether a matter is hourly, fixed-fee, capped, or staged — and therefore no way to know what an invoice *should* have been.
- **No engagement letter gating.** Rule 12 requires the lawyer to prepare a written contract with the client stating the parties, the work, the fee and how it is calculated. `documents.document_type` has `'firm_letter'`, but nothing links a signed engagement to the matter as a precondition. Rule 11 requires verifying capacity and conflict **before agreeing to the work** — so the engagement letter is the natural gate, and it is not one.
- **No note of Rule 16/3**: a lawyer may not promise a result outside their control. Worth a UI constraint on expected-outcome fields, not a table.

### F · Privilege as an access class — **HIGH**

**Exists:** `internal_notes.is_privileged` boolean; `internal_notes` is a separate table with no client grant at all — which is genuinely excellent design.
**Missing:** privilege as a *ring*, enforced.

`internal_notes` is readable by any member with matter access, including a **paralegal, a finance officer and a compliance officer**. Professional confidentiality under نظام المحاماة attaches to the lawyer; the firm's non-lawyer staff are not covered by the same duty, and in a dispute over disclosure the firm will be asked who could read what. The system's own §57 "withheld field" mechanism and the `accessLevel` model already contain the vocabulary to fix this — the classification exists, the enforcement of a *licensed-lawyer* ring on it does not.

Related: `matters.risk_rating`, `conflict_cleared` and `internal_notes` are marked INTERNAL in comments. `matters.internal_notes` is a **column on a table the portal reads** — the projection layer excludes it today, which is correct, but a single careless `select *` in a future repository method exposes it. `internal_notes` as a separate table is the safe pattern; the column on `matters` is the same class of hazard that the file's own projection comment warns about.

### G · Records, retention, privacy and data residency — **HIGH**

**Exists:** append-only `audit_events` with a 69-action vocabulary derived from a declared union and verified by a DO-block; `privacy_requests` with a `retention_block` and a trigger preventing a requester from approving their own request.
**Missing:**

- **No retention schedule.** Nothing states how long each record class is kept. AML record-keeping is a statutory duty; PDPL requires deletion or anonymisation when the purpose ends. The two pull in opposite directions and no code decides which wins.
- **No legal hold.** Once litigation is anticipated, destruction must stop. A `retention_block` exists on the *privacy request*, not on the *record*.
- **No archival or purge job**, so retention is a policy with no mechanism.
- **No DPIA, data classification register, or breach-notification workflow.** PDPL imposes obligations on a controller when personal data is breached. `security_alerts` exists for the technical alert; there is no artefact for the regulatory notification or the record of who was notified when.
- **Data residency is a live question.** PDPL restricts cross-border transfer of personal data absent an approved mechanism. This system runs on Vercel with Supabase in **`aws-0-us-east-1`** — United States. For a Saudi firm holding privileged client material *and* statutory AML records, that is either a documented transfer mechanism and an NDMO approval, or an in-Kingdom region. It is currently neither, and it is the cheapest serious finding on this list to act on: change the Supabase region and write the transfer assessment.

### H · Notification reliability — **HIGH**

**Exists:** `auth/email.ts` with a driver switch (`log` default, `http` optional) and an in-memory outbox.
**Missing:** durability.

The outbox is a **process-local array**. Nothing persists a notification, nothing retries, nothing records delivery, and a failed send is caught and logged while the request returns success. The consequences are not cosmetic: an invitation that never arrives, a client never told a document was released, a hearing reminder lost — and, once the deadline engine exists, a **deadline escalation that silently fails to send**. An escalation is the mechanism that stops a malpractice event; it must be durable and its failure must be visible.

### I · The firm OS authorises work it cannot perform — **MEDIUM**

This is the §50 rule working exactly as designed, and it has produced a product that is secure and empty.

- **12 of the 13 matter tabs are `planned`**: timeline, team, documents, hearings, deadlines, contracts, PoA, time, expenses, billing, messages, compliance. Only `overview` renders.
- **18 nav leaves are `planned`.**
- **The firm has no document capability at all.** There is no `/api/firm/documents` route in the 21 firm routes, and no firm page touches documents. The permission code `documents.release` exists — a member can be *granted* the authority to release a document to a client and there is no code path that does it.
- **Billing is approve-and-list only.** No create, no edit, no send, no credit note. The firm can approve an invoice that nothing in the firm OS can produce.
- Consequently the **firm cannot be the system of record for the work it authorises**, and the portal is projecting from data that only the seed script writes.

The honest framing: the client portal is a functioning product; the firm OS is an authorization engine with a dashboard.

### J · Registers that do not exist — **MEDIUM**

- **No Power of Attorney register (وكالة).** `poa` is a permission code, a planned nav leaf and a planned tab. Agent authority is the gate on who may act for whom before Saudi courts and government platforms, and its scope and expiry are operational facts the firm must track.
- **No court/Najiz mapping.** Litigation's actual system of record is Najiz; the system holds `case_number` as free text on `matters` and cannot reconcile a hearing with what the court shows.
- **No document version chain.** `documents.version` increments, but nothing links version *n* to version *n−1*, so "the current signed contract" is not answerable.
- **No counterparty-served notices register**, which matters for service and for limitation triggers.

### K · Depth items — **LOW**

- **The malware gate is a stub by default.** Signature heuristics with a ClamAV driver available. The fail-closed design is correct (an unreachable scanner never marks a file clean) and this is honestly documented — it is a deployment task, not a design defect.
- **No e-signature.** Engagement letters and contracts need a signature with legal weight (Nafath/Etimad-backed); today a signature is a PDF someone uploaded.
- **No multi-jurisdiction regime.** `country` defaults to SA and `tenant_settings` has one fiscal year; a firm with GCC matters cannot express a different governing law, limitation rule or VAT treatment per matter.
- **No conflict/sanctions list management** — list ingestion, refresh cadence, false-positive disposition.
- **No analytics.** Realisation, WIP, recovery against role and ceiling — the ceilings and roles are all in place to support it.

---

## 4 · WHAT IS GENUINELY STRONG AND MUST NOT BE DISTURBED

Stating this is not politeness; several of the fixes below will be tempting to implement in ways that break these.

1. **The projection principle.** Internal status and client status as separate columns, an `internal_notes` table with no client grant, deadlines split into two lanes with a trigger that forbids an internal task from becoming client-visible. This is the correct architecture and it is executed better than in most legal products. Every new table must follow it.
2. **Derivation over free assertion.** `derive_invoice_client_status()` plus a trigger that refuses a contradictory value is the pattern the conflict model should copy. Extend it; do not replace it.
3. **The audit vocabulary derived from a declared type union, verified in the database.** Extending the 69-action list will be required by every P0 item below. The existing discipline — declare in TypeScript, verify in SQL, fail loudly — is what keeps a security log trustworthy.
4. **The financial ceiling check on invoice approval** (permission → matter scope → numeric ceiling, in that order). Correct. Extend it to write-offs and discounts rather than inventing a second mechanism.
5. **§50 and the drift tests.** The rule that the visual system never overrides authorization, and the test that fails when the nav tree and the router disagree, should be extended to the new registers — a conflict flag must not become a UI hint that anyone can set.
6. **Short-lived signed URLs bound to the session**, with signature covering document, session, expiry and disposition. Do not add a permanent URL for the ZATCA artefact; route it through the same mechanism.
7. **Fail-closed scanning**, and the honest labelling of the stub.

---

## 5 · THE PRIORITISED IMPLEMENTATION PLAN

Ordered by legal exposure first, then record integrity, then capability. Each phase is independently shippable and each ends with the same gate: migrations on real Postgres, RLS and grant reconciliation, a live harness assertion, and a drift test.

### P0 — LEGAL EXPOSURE · do first, in this order

| # | Deliverable | Why first | Build |
|---|---|---|---|
| **P0.1** | **Party model + conflict engine.** `parties`, `matter_parties`, `conflict_checks`, `conflict_hits`; normalised Arabic name matching; firm-wide search across **open and closed** matters; the Rule 8 three/five-year windows as data; written-waiver document required for a `waived` result; trigger making `matters.conflict_cleared` **derived** and blocking progress out of `conflict_check`; new audit actions (`CONFLICT_CHECK_RUN`, `CONFLICT_HIT`, `CONFLICT_CLEARED`, `CONFLICT_DECLINED`, `CONFLICT_WAIVED`). | Rule 8 and Rule 11 are the obligations that end a practice. Nothing else on this list has that severity. | **L** |
| **P0.2** | **Fiscal identity and a legally valid invoice.** Seller VAT + CR, buyer VAT, invoice UUID, ICV + hash chain, invoice type (standard/simplified), QR, XML and PDF/A-3 generation, clearance/reporting state with retry, and **per-line VAT treatment**. Then expose the artefact in the client portal through the existing signed-URL path. | The compliance deadline has already passed for firms above SAR 375,000; Wave 25 is 1 Feb 2027. Penalties are per invoice. | **L** |
| **P0.3** | **AML/CDD workflow.** `client_due_diligence`, `beneficial_owners`, `screening_runs`, `screening_matches`, `str_flags`; PEP and sanctions screening with a nullable "not screened" state; risk rating derived from the DD record; a **hard gate on matter activation** when CDD is incomplete or screening is unresolved; new audit actions per obligation. | The AML rule is explicit that a lawyer **may not act** if CDD cannot be completed. The system currently lets a matter open with `identity_verified = false`. | **L** |
| **P0.4** | **Procedural deadline engine.** `deadline_rules` and `court_calendar` (weekend + Saudi holidays, Hijri-aware); extend `deadlines.kind` to `limitation`, `appeal`, `cassation`, `reconsideration`; store `rule_id`, trigger event and the **article cited** on every computed date; day-after-delivery start; extend-to-next-working-day rule; escalation ladder with acknowledgement. | A missed 30-day appeal is malpractice with an identifiable victim, and 10-day urgent periods leave no room for a manual calendar. | **L** |
| **P0.5** | **Privilege ring.** Add a `privileged` access class to `internal_notes`, matter risk and advice documents, restricted to licensed-lawyer roles; explicit denial tests; extend the §57 withheld mechanism to it. | Cheap, and it closes a disclosure question the firm will be asked. | **S** |
| **P0.6** | **Data residency decision and PDPL baseline.** In-Kingdom Supabase region or a documented transfer mechanism; DPIA; data-classification register; breach-notification workflow with a record of the notification. | Cheapest serious finding on the list. A region change now is a migration; a region change after go-live is an incident. | **M** |

### P1 — INTEGRITY OF THE PROFESSIONAL AND FINANCIAL RECORD

| # | Deliverable | Build |
|---|---|---|
| **P1.1** | **Trust/client-money ledger (أمانات).** `client_ledgers`, `ledger_entries`, `ledger_reconciliations`; advances accepted with no invoice; application to fees only against an issued invoice; per-client balance derivable at any point; three-way reconciliation; separation from operating funds as a schema boundary, not a convention. | **L** |
| **P1.2** | **Time, disbursements and billing basis.** `time_entries`, `expenses`, `matter_billing_terms` (hourly / fixed / capped / staged), `rate_cards`; wire the existing `time.*` and `expenses.*` permission codes to real operations. | **L** |
| **P1.3** | **Enforce the two unguarded ceilings.** Write-off and discount operations that check `writeoff_authority_sar` and `discount_authority_pct` through the same three-step gate as invoice approval; `CEILING_EXCEEDED` audit retained. Until this exists, **remove the ceilings from the profile drawer** — a displayed limit that is not enforced is misleading. | **S** |
| **P1.4** | **Engagement letter as a gate.** Written contract per Rule 12 (parties, scope, fee, calculation method); matter cannot become billable or `active` without a signed engagement linked to it; Rule 11 checks (identity, capacity, conflict) recorded as the preconditions of that gate. | **M** |
| **P1.5** | **Retention and legal hold.** `retention_schedules` per record class, `legal_holds` at record level, archival/purge jobs that respect holds and audit every action, and the reconciliation with `privacy_requests.retention_block`. | **M** |
| **P1.6** | **Durable notification outbox.** Persisted outbox, retries with backoff, delivery status, dead-letter queue, and honest failure state in the UI. A failed deadline escalation must be visible, not logged. | **M** |
| **P1.7** | **Real malware scanning.** ClamAV in-cluster with the fail-closed behaviour already designed; keep the type allowlist. | **S** |

### P2 — OPERATIONAL CAPABILITY (make the firm OS usable)

Ordered by which makes the professional record complete first.

| # | Deliverable | Build |
|---|---|---|
| **P2.1** | **Firm-side documents.** `/api/firm/documents` — list, upload, release to client, restrict. Wires the orphaned `documents.*` permission codes. Reuses the portal's proven storage and signed-URL path under the firm permission model. Unblocks the documents tab and the conflict waiver attachment. | **L** |
| **P2.2** | **Matter workspace tabs**, in dependency order: documents, hearings, deadlines, billing, then messages and the rest. Each tab must be permission-filtered and must fail closed when its permission is absent. | **L** |
| **P2.3** | **Billing surfaces.** Create, edit, send, credit note; the firm can produce the invoices it approves. Depends on P0.2 and P1.2. | **L** |
| **P2.4** | **PoA register (وكالة)** — scope, issuing authority, expiry, revocation, and the link to the matter it authorises. | **M** |
| **P2.5** | **Najiz/court mapping** — a mapping table first (case number, case type, circuit, hearing reconciliation), integration later. | **M** |
| **P2.6** | **Document version chain** — `supersedes_document_id`, so "the current signed contract" is answerable. | **S** |
| **P2.7** | **Conflict/sanctions list management** — list ingestion, refresh cadence, false-positive disposition, and the audit trail of each refresh. | **M** |

### P3 — DEPTH AND SCALE

E-signature with legal weight (Nafath/Etimad) for engagement letters and contracts · multi-jurisdiction regime (governing law and limitation rules per matter) · analytics on realisation, WIP and recovery against role and ceiling · client-facing conflict disclosure and consent capture in the portal.

---

## 6 · SEQUENCING, DEPENDENCIES AND GATES

```
P0.1 conflicts ──┐
                 ├─→ P2.1 firm documents ─→ P2.2 tabs ─→ P2.3 billing
P0.3 AML ────────┘            │
                              └─→ P1.4 engagement gate
P0.2 ZATCA ──→ P0.2b portal artefact ──→ P2.3 billing
P0.4 deadlines ──→ P1.6 durable outbox (escalation must not fail silently)
P0.5 privilege ──→ P2.2 tabs (every tab respects the ring)
P0.6 residency ──→ independent, but BEFORE go-live
P1.1 trust ledger ──→ P1.2 time/expenses ──→ P1.3 ceilings ──→ P2.3 billing
```

**Dependency notes that matter:**
- **P0.4 before P1.6 is the wrong order in isolation** — the deadline engine is useless if its escalation can be lost. Build P1.6 as soon as P0.4 lands, and until then make escalations visible in-app rather than relying on email.
- **P0.2 blocks P2.3.** Do not build invoice creation on a model that cannot produce a valid tax invoice.
- **P0.1 blocks P2.1** only in one direction: the conflict waiver needs an attached document, so either P2.1 lands first or the waiver column stays nullable for one phase.
- **P0.6 (residency) is independent of everything and should not be deferred behind feature work.** A region migration after client data exists is materially harder than before.

**Gate that every phase must pass** (the existing standard, restated so it is not softened):
1. Migration applied to the **real Postgres**, not only SQLite — grants *and* RLS policies reconciled, not just tables.
2. Every new table follows the projection principle: what a client may read is a different column, or a different table, never a filter.
3. New audit actions added to the declared union **and** admitted by the database, with the DO-block verification extended.
4. A live harness assertion against the deployment, because the defects this system has produced have consistently been invisible to stubs.
5. A drift test for anything the UI can suggest but the API must refuse.

---

## 7 · EXPLICITLY OUT OF SCOPE — DO NOT BUILD THESE YET

Naming these is part of the plan. Each is defensible in a demo and each would be waste today.

- **AI drafting, summarisation or legal research.** Nothing in the P0 list becomes easier with a language model, and the projection principle would have to be re-proven against generative output.
- **Court e-filing integration.** P2.5 (mapping) must exist first, or the integration has no stable key to file against.
- **LEDES / e-billing export.** There is no time-recording system to export from yet (P1.2).
- **A general-purpose workflow builder.** The three workflows that actually need gating — conflict, CDD, engagement — should be hard-coded, auditable and few.
- **Mobile applications.** The bottom nav and the responsive shells already serve this; a native client multiplies the authorization surface for no legal gain.

---

## 8 · CLOSING ASSESSMENT

If I were advising the firm as a client rather than reviewing the code, my advice would be:

> The platform's security work is done to a standard that will withstand scrutiny. What it cannot yet do is demonstrate **professional diligence** — that conflicts were checked before the firm took the work, that client identity and funds were verified before the firm acted, that the appeal period was diarised against the article that creates it, and that the invoice the client received is a valid tax invoice. Those four things are the substance of a legal practice's obligations, and they are currently represented by a boolean, a boolean, nothing, and a PDF that was never generated.
>
> Fix those four, and the system stops being a secure document platform and becomes a defensible professional record.

**Priority order, in one line:** conflicts → fiscal validity → CDD → deadlines → privilege ring → residency, then trust money, then make the firm OS actually perform the work it authorises.

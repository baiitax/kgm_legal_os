# KGM LEGAL OS — LEGAL GAP ANALYSIS II · THE ELIGIBILITY LAYER

**Companion to** `docs/LEGAL-GAP-ANALYSIS.md` (commit `0297011`). This document supersedes nothing in that one; it **reframes** it. Every finding in Analysis I stands. What follows is the architectural reading underneath those findings, five new findings verified at line level, and a revised sequence.

**Review date:** 25 September 2026 · **Method:** line-level inspection of the schema, the permission catalogue and the audit vocabulary, read against the professional-conduct and procedural obligations the product exists to serve.

---

## 1 · THE STRUCTURAL GAP — THE SYSTEM MODELS AUTHORITY, NOT ELIGIBILITY

Analysis I listed six separate defects. They are one defect with six faces.

Every control in this system answers one question:

> **"May this actor do this thing?"**

None of them answer the prior question:

> **"Is this actor legally permitted to be doing this at all?"**

In a general-purpose system those are the same question. In a legal system they are different, and the second one dominates — because the obligations of a Saudi law firm are overwhelmingly **status conditions on the actor**, not limits on the action:

| The system will grant | While the law may prohibit the holder |
|---|---|
| `matters.update` to a member | who is **suspended from practice** (Rule 10 prohibits practising under a final suspension order) |
| an active membership in a second firm | where **Article 16 of the Implementing Regulation** prohibits a lawyer from being a partner in, or working for, more than one law firm |
| matter access to a member | who is **disqualified by prior judicial service** (Article 14 of نظام المحاماة; قواعد الحد من تعارض المصالح لمن سبق له العمل في السلك القضائي) |
| an unlimited financial ceiling to a member | who holds **no valid practising licence** |
| matter activation for a client | whose **CDD is incomplete** — where the AML rule prohibits acting at all |
| matter activation with a conflict flag set | where **Rule 11** requires the conflict be excluded *before* the work is accepted |
| an invoice approval | where the resulting **invoice has no fiscal identity** and cannot legally be issued |

The consequence is precise and it is not a security hole: **the system cannot be relied on to establish that the firm was entitled to do the work it recorded.** It has an outstanding record of *who did what*. It has no record of *whether anyone was allowed to be there*.

That is the gap. It is architectural, it explains all of Analysis I, and it produces a specific, checkable primitive that the codebase has already half-invented (§4).

---

## 2 · FIVE NEW FINDINGS, VERIFIED AT LINE LEVEL

### N1 · No professional-eligibility model — **CRITICAL**

**Evidence — the complete `staff` table (migration 0002):**

```sql
create table if not exists public.staff (
  ...
  internal_role     text not null check (internal_role in
                    ('managing_partner','partner','lawyer','paralegal',
                     'finance','compliance','admin')),
  bar_number        text,
  client_visible    boolean not null default true,
  is_active         boolean not null default true,
  ...
);
```

`bar_number` is **free text**. There is no licence status, no issue or expiry date, no suspension, no restoration, and — a grep across all 26 migrations returns **zero** — no field for prior judicial or government service.

So the system knows a person is a lawyer because someone typed a number into a text column. It cannot represent:

- **a suspended licence.** Rule 10: a lawyer may not practise while a final suspension order is in force. The system would keep granting the work.
- **prior judicial service.** Article 14 of نظام المحاماة and the dedicated implementing rules restrict a former judge, prosecutor, or court officer from acting in a matter connected to their office for **five years**; Rule 8/3 sets the same five-year window generally. This is *imputed* to the firm. With no field recording where a lawyer worked before, the screening query has nothing to screen.
- **the single-firm obligation.** See below — the system's headline architecture invites its breach.

**And the second half, which is architecture-specific to this product.** Confirmed from migration 0006:

```sql
create table if not exists public.firm_memberships (
  ...
  unique (tenant_id, user_id)
);
```

The uniqueness is **per tenant**. A user may therefore hold memberships in **unlimited tenants**, and the product is built around exactly that: this is a multi-firm SaaS with a tenant switcher in the profile drawer, decided "from day one" as a product requirement.

**Article 16 of the اللائحة التنفيذية لنظام المحاماة** states: *«لا يجوز أن يكون المحامي شريكاً في أكثر من شركة مهنية للمحاماة، كما لا يجوز أن يعمل المحامي لدى أكثر من مكتب أو شركة مهنية للمحاماة.»* — a lawyer may not be a partner in more than one professional law firm, nor work for more than one law office or law firm. ([source](https://nezams.com/%D9%86%D8%B8%D8%A7%D9%85-%D8%A7%D9%84%D9%85%D8%AD%D8%A7%D9%85%D8%A7%D8%A9/))

The system's flagship capability is therefore the one arrangement the governing regulation prohibits, and the tenant switcher presents it as a feature. Multi-tenancy itself is correct — a SaaS serves many firms, and a *firm* may legitimately have several related entities. What is missing is the guard: a constraint or attested eligibility record preventing a **licensed lawyer** from holding active practising memberships at two unrelated firms, with the exemption recorded where one exists.

### N2 · The triggers of legal time do not exist — **CRITICAL**

Analysis I said there is no deadline engine. That undersold it. **There is nothing to compute a deadline *from*.**

**Evidence — a search for the records that start a legal clock:**

| Record | Occurrences across 26 migrations |
|---|---|
| `judgments` table | **0** |
| service of process / تبليغ | **0** |
| pleadings / لوائح | **0** |
| session minutes / ضبط الجلسات | **0** |
| expert reports / خبراء | **0** |

"Judgment" exists in this system as **three string literals** and nothing else — twice as a lifecycle state on `matters` (`internal_status` and `client_status`) and once as a `matter_timeline.event_type`. There is no judgment record: no صك number, no circuit, no issuing court, no judgment type (ابتدائي / استئناف / عليا), no finality, and **no date of delivery to the party**.

That last omission is fatal to the whole deadline project, because **the appeal period runs from service, not from pronouncement**:

- *«تبدأ المدة من تاريخ تسليم صك الحكم إلى المحكوم عليه»* — the period runs from delivery of the judgment copy.
- For an absentia judgment (حكم غيابي), it runs from **notification** or from the defendant's knowledge of it.
- The last day extends to the next working day if it falls on a weekend or holiday. ([source](https://hd-criminal-law.com.sa/blog/%D8%A7%D8%B3%D8%AA%D8%A6%D9%86%D8%A7%D9%81-%D8%A7%D9%84%D8%AD%D9%83%D9%85-%D8%A7%D9%84%D8%BA%D9%8A%D8%A7%D8%A8%D9%8A-%D9%81%D9%8A-%D8%A7%D9%84%D8%B3%D8%B9%D9%88%D8%AF%D9%8A%D8%A9))

**You cannot diarise an appeal period without a صك and its delivery date.** Deadline engine P0.4 of Analysis I is therefore *blocked* on a judgment register and a service register — a dependency I did not identify the first time.

The wider point: this system holds the **firm's client-facing view of a case** — a status, a friendly timeline, upcoming hearings. It does not hold the **case file**. The core object of a legal practice is the file; the core object of this product is the client record. That is why an accomplished authorization model sits on top of a case-management surface a lawyer cannot actually litigate from.

### N3 · Reading a matter is not auditable — **HIGH**

**Evidence — the 69-action vocabulary contains `DOCUMENT_VIEWED`, `DOCUMENT_DOWNLOADED`, `INVOICE_VIEWED`, `MESSAGE_READ`, `RECEIPT_VIEWED` — and no `MATTER_VIEWED`.**

Confirmed by grep: zero occurrences of `MATTER_VIEWED`, `MATTER_READ` or `MATTER_ACCESSED` anywhere in the migrations.

The mechanism that makes this structural rather than an oversight: migration 0023 derives the database's allowlist from the TypeScript `AuditAction` union and adds a DO-block that **fails if any declared action is not admitted**, with the stated principle that *"the union IS the contract"* — a call site cannot invent an action because the database would reject it. That discipline is one of the best things in the codebase. It also means that **as long as `MATTER_VIEWED` is not in the union, no route can record a matter view even if someone writes the call.**

Why this matters legally — **imputed knowledge and disqualification.** When a conflict surfaces late, the first question a court or the opposing firm asks is not "was the screen clean in March" but **"who here had actually seen that file, and when."** A lawyer who read Client A's matter, then moves to Client B acting against A, is conflicted *because of what they saw*, independent of any register. The firm's answer is the access record.

Today the firm can prove which **documents** were opened and by whom. It cannot prove **who looked at the matter** — its parties, its case number, its risk rating, its internal notes. In a disqualification motion that is the difference between a defensible answer and no answer.

### N4 · No client complaints register — **MEDIUM**

`compliance.complaints` is granted to MANAGING_PARTNER and COMPLIANCE — it appears **three times as a permission code and zero times as a table**. There is no register, and grep across `web/src/` returns **nothing**: the client portal offers no complaint channel at all.

Professional conduct expects a firm to receive and handle client grievances, and the disciplinary route (لجنة التأديب under the Implementing Regulation) treats an unaddressed complaint as an aggravating fact. A firm whose only route for a dissatisfied client is a message thread is not recording that it handled the grievance.

### N5 · Fees are never disclosed forward — **MEDIUM**

Rules 13 and 15 of the Professional Conduct Rules require the fee to be measured against the nature of the work, the lawyer's standing, local comparable fees, and **the client's financial and social circumstances**; Rule 12 requires the written contract to state the fee **and the method of calculating it**.

The portal shows a client what they have been billed. It never shows what they will be billed — there is no estimate, no fee ceiling disclosure, no budget-versus-actual, and (per Analysis I) no billing basis per matter from which an estimate could be derived. A client-facing system that only ever speaks about fees retrospectively cannot evidence compliance with Rules 13 and 15, and is a standing source of fee disputes.

### N6 · No gifts, hospitality or government-interaction register — **LOW**

Saudi anti-corruption expectations (Nazaha-era) and the conduct rules' prohibition on exploiting the profession make a hospitality/gift register standard for firms with government counterparties. Nothing in 52 tables records an offer, a gift, or a conflict-arising interaction with a public official.

---

## 3 · WHAT I SHOULD ALSO CREDIT, BECAUSE THE PLAN MUST NOT BREAK IT

Named so that the fixes below do not casually undo good work:

- **`consent_records` is genuinely well built** — `purpose` is an enumerated, purpose-bound value and `policy_version` is recorded, so consent is tied to the notice the client actually saw. Most systems record a boolean. Do not regress this when adding PDPL lawful-basis records.
- **`data_exports` is a real artefact**, not a flag: `sha256`, a short expiry, and `downloaded_at`. The right shape for a subject-access fulfilment.
- **The projected document lane guards** (`assert_document_readable`, `assert_deadline_lane`) refuse illegal *combinations* of columns, not just illegal values. That is the primitive §4 builds on.
- **The audit vocabulary verification DO-block**, and the refusal to let a call site invent an action.
- **`matter_permissions` with explicit `accessLevel`** — the vocabulary needed for the eligibility gates below already exists.

---

## 4 · THE PRIMITIVE THE CODEBASE ALREADY INVENTED — THE GATE

Three existing mechanisms are the same idea in three places:

1. `derive_invoice_client_status()` + `guard_invoice_state()` — `client_status` is **derived** from internal state, and a trigger **refuses** any value that contradicts the derivation.
2. `assert_deadline_lane()` — refuses `internal_task` that is `client_visible`.
3. `assert_document_readable()` — refuses `available` before a clean scan.

Each is a **precondition that the database refuses to let you past**, backed by evidence, with the derivation stored rather than asserted. That is exactly the shape an eligibility layer needs. It is not a new idea for this codebase; it is the existing idea, generalised from *columns* to *authority*.

### The gate matrix

Every authority in the product, the legal precondition for holding it, what evidences that precondition, and what must refuse. **This table is the plan.**

| Authority | Legal precondition | Evidence (new) | The refusal |
|---|---|---|---|
| A member may act on matters | licence valid · not suspended · no prior-office bar in window · single-firm obligation met | `professional_licences`, `prior_office`, `eligibility_checks` | `firm_memberships.status → 'active'`; matter assignment |
| A matter may leave `conflict_check` | conflict excluded before the work was accepted (Rule 11) | `conflict_checks`, `conflict_hits` *(Analysis I · P0.1)* | `internal_status` transition |
| A client may be acted for | CDD complete · screening clear · UBO identified | `client_due_diligence`, `beneficial_owners`, `screening_runs` *(Analysis I · P0.3)* | matter activation |
| A document may be released | clean scan · correct version · not privileged into a non-lawyer's hands | scan gate · version chain · privilege ring *(Analysis I · P0.5)* | signed-URL mint |
| An invoice may be sent | fiscal identity complete · cleared/reported to ZATCA | `fiscal_identity`, `invoice_submissions` *(Analysis I · P0.2)* | `internal_status → 'sent'` |
| A fee may be charged | engagement letter signed · within the fee agreement | `engagement_letters`, `matter_billing_terms` *(Analysis I · P1.4)* | time entry · invoice line |
| **A deadline may be relied on** | **computed from a cited article, from a recorded trigger** | **`deadline_rules`, `judgments`, `service_records`** | **deadline marked satisfied without evidence** |
| **A case may be closed** | **periods expired or judgment final** | **judgment finality** | **`internal_status → 'closed'`** |
| **Matter access may be granted** | **and every view of it is recorded** | **`MATTER_VIEWED` in the union** | **the audit write itself** |

The last three rows are the new work in this document.

---

## 5 · REVISED SEQUENCE

**Three changes to the plan in Analysis I.**

**1. A new prerequisite phase — P‑1 · ELIGIBILITY.** Insert before P0. Small, self-contained, and it strengthens four downstream items:

| # | Deliverable | Build |
|---|---|---|
| **P‑1.1** | `professional_licences` (number, status, issued, expires, suspended, restored) and a derived `is_entitled_to_practise`; grant of an active membership refuses when false. | **S** |
| **P‑1.2** | `prior_office` (judicial / prosecutorial / government / court administration, with dates and the five-year window) feeding the conflict screen from P0.1. | **S** |
| **P‑1.3** | The Article 16 single-firm guard: a licensed lawyer may not hold active practising memberships at two unrelated firms; related entities are declared, not assumed; the attestation recorded where an exemption exists. | **S** |
| **P‑1.4** | `MATTER_VIEWED` added to the declared union, admitted by the database, and written on every matter read — with `resource_type='matter'` and the access level at the time. | **S** |
| **P‑1.5** | `eligibility_checks` — the generic gate record: subject, precondition, evidence, outcome, actor, timestamp. One table the other gates reuse rather than six bespoke mechanisms. | **M** |

**2. P0.4 (deadlines) gains a hard dependency.** It cannot be built before a **judgment register** and a **service register**:

- `judgments` — صك number, issuing court and circuit, judgment type, pronouncement date, **delivery date to each party**, finality, appeal status.
- `service_records` — what was served, on whom, on what date, by what channel, with the proof attached.
- Then `deadline_rules` (with the cited article), `court_calendar` (Hijri-aware weekend and holidays), the day-after-service start, and the extend-to-next-working-day rule.

Revised order inside P0: **judgments + service → deadline_rules + court_calendar → deadline instances + escalation.** This is a larger phase than Analysis I implied, and it is the phase that converts the product from a client-relationship system into a litigation system.

**3. P2 gains two small items and one reframing.** Add a client complaints register and channel (N4), and a forward fee disclosure on the matter (N5). Reframe P2.2: the matter tabs should be ordered not by convenience but by **which one makes the gate matrix true** — documents, hearings, **judgments and service**, deadlines, billing, then the rest.

**Unchanged and still first:** Analysis I P0.1 (party + conflict model) remains the highest-severity single item. P‑1.1–P‑1.3 feed it and should be built alongside it in the same phase.

---

## 6 · REVISED PRIORITY ORDER, IN ONE LINE

**Eligibility and conflicts together** (P‑1 + P0.1 — who may practise, who may act, who is on the other side) → **fiscal validity** (P0.2) → **CDD** (P0.3) → **judgments, service, then deadlines** (P0.4 revised) → **privilege ring + matter-read auditing** (P0.5, P‑1.4) → **residency** (P0.6) → **trust money, engagement gate, retention, durable notification** (P1) → **make the firm OS able to perform the work it authorises** (P2).

---

## 7 · THE ASSESSMENT, RESTATED FOR THE FIRM

> The software is unusually good at deciding who may see what, and it is scrupulously audited for the things it knows about. What it cannot do is establish that the firm was **entitled** to act: that the lawyer held a valid licence and belonged to only this firm, that no one here had seen the other side's file, that the client was verified before the engagement began, that the conflict was excluded before the work was accepted, that the invoice was a valid tax invoice, or that the appeal period was diarised from the date the judgment was served.
>
> Those are not features. They are the substance of professional diligence, and each of them is currently a state the software will happily record without ever having checked the condition it stands for.
>
> The remedy is not six projects. It is one pattern, four times already present in the codebase, applied to authority instead of to columns: **derive the precondition, store what evidences it, and make the database refuse to move past it.**

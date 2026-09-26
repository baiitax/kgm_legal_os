# PHASE P0.5 — THE PRIVILEGE RING

**Status:** complete and verified against the live PostgreSQL. Three migrations (0054, 0055 and
0056), 28 new tests, **567 in the suite**, **36/36 checks in the live harness**, and **19/19
in the drift gate**. The API at `:8787` is running the built server, and the whole run was
made against real PostgreSQL with the two restricted roles in place.

---

## 1 · What the phase is about

A lawyer may not disclose what was entrusted to him, or what he learned through his profession,
**even after the mandate ends** — نظام المحاماة، المادة الثالثة والعشرون. The duty attaches to
the *lawyer*, and that has a consequence the gap analysis had to write down before it could be
fixed:

> `internal_notes` was reachable by a paralegal, a finance officer and a compliance officer.

Not through a bug. Through the design: the notes were classified `confidential`, which every
member with write access satisfies, and a matter team is exactly the set of people who can
write to a matter. The field was protected by an access level, when the question the statute
asks is not *how much of this file may you see* but *may you lawfully practise at all*.

P0.5 answers that question once, and makes three things true:

1. **The ring is a licence question, not a role.** `requires_practising_licence ∧ entitled` —
   the verdict P‑1 already computes for every membership.
2. **The firm's own work product leaves the ordinary read path.** Two columns on `matters` are
   out of the application role's reach, and are readable only through a function that decides
   the ring and writes the read to the audit trail.
3. **There is a door, and it has a ledger.** القاعدة الحادية والعشرون names the only grounds on
   which disclosure is permitted, each release records which one was relied on, to whom, and —
   where the ground is the client's consent — which document carries the writing.

---

## 2 · The ring, and why it is not a role

| | |
|---|---|
| **What it is** | `LawyerRing = { inRing, reason }`, resolved once in `permissions.fromMembership()` and carried on `FirmPrincipal.ring` |
| **What it reads** | `roles.requires_practising_licence` (0027, data rather than a list of role codes) and `eligibilityFor()` (P‑1): role → licence on record → valid today |
| **The reasons** | `in_ring` · `outside_ring` · `no_licence_on_record` · `suspended` · `revoked` · `expired` · `pending` |
| **The order** | Does this role practise? → is there a licence? → is one good enough TODAY? → otherwise name the **severest** reason present |
| **Where it is not** | Not in the projection, not in the screen, not re-derived at the field (§50: the projector receives the verdict, never the inputs) |

Three decisions in that table are the design:

- **A non-practising role is answered before any licence is read.** A paralegal is not
  "unlicensed" — the question does not arise for her, and a refusal message that said otherwise
  would send her to the bar association for a licence she does not need.
- **Absence is not permission.** A practising role with no licence row is refused, the same
  inverse default the financial ceilings follow ("NULL = no authority; never read NULL as
  unlimited").
- **The ring is not frozen at sign-in.** The principal is re-resolved on every request, so a
  licence suspended at 11:00 narrows the session that was opened at 09:00. The suite proves it
  by suspending a licence and asking the *same* session again.

Live, from the database's own mouth (`kgm_lawyer_ring_reason()` with the request's GUCs set):

```
  COMPLIANCE        omar@kgm.example.test          licences=0 (—)      → outside_ring
  FINANCE           sara@kgm.example.test          licences=0 (—)      → outside_ring
  LAWYER            faisal@kgm.example.test        licences=1 (valid)  → in_ring
  MANAGING_PARTNER  noura@kgm.example.test         licences=1 (valid)  → in_ring
  PARALEGAL         mariam@kgm.example.test        licences=0 (—)      → outside_ring
  MANAGING_PARTNER  partner@najd.example.test      licences=0 (—)      → no_licence_on_record
```

The last line is the one that matters: a **managing partner** is outside the ring because there
is no licence on record. Rank is not the question.

---

## 3 · The two columns leave the ordinary read path

`matters.internal_notes` and `matters.risk_rating` were readable by `firm_api` until 0054.
Now:

- **0054 §3 walks the catalogue** and revokes SELECT on those two columns — the other **21 of 23
  columns stay granted**, so the screens that need titles and statuses are untouched.
  (`has_column_privilege('firm_api','public.matters','internal_notes','SELECT') = false`, live.)
- **The only door is `firm_read_matter_privilege(uuid)`** — `security definer`, explicit
  `kgm_tenant()` filter, raising `privilege_ring_refused: matter_out_of_scope|<reason>` rather
  than returning null for the wrong caller. A definer function that quietly returned nothing
  would be indistinguishable, from the application, from a matter with no notes.
- **The repository no longer selects them at all.** `getMatterRow` and `listVisibleMatters`
  stopped naming the columns, so there is no query in the application that could leak them —
  including the list endpoint, which is where a leak is easiest to miss.
- **The route consults the ring before it consults the database**, then merges the two fields
  and records the read. If the database disagrees with the application (a suspension that
  landed a moment ago, or a bug in the ring), the fields stay withheld and the disagreement is
  written down — `PRIVILEGED_READ`, `outcome: denied`, `reasonCode` = the database's own message.
  It is never a 500.

**The two risk ratings are kept apart, deliberately.** `client_due_diligence.risk_rating` is
the AML assessment of the *client* and remains readable by compliance — it is compliance's own
work product and the AML gates depend on it. `matters.risk_rating` is the firm's assessment of
its own exposure, which is advice. The suite asserts both in one test, because a rule that
withheld both would look exactly like a rule that withheld neither.

---

## 4 · The documents: a privileged document is internal, by construction

`documents` gains `privilege_class ∈ {none, advice, work_product, litigation}` with a CHECK in
both dialects — *a privileged document is internal* — plus two **RESTRICTIVE** policies:

```
  documents_firm_privileged_ring      RESTRICTIVE/ALL   using: privilege_class = 'none' OR kgm_lawyer_ring(kgm_membership())
  documents_portal_never_privileged   RESTRICTIVE/ALL   using: privilege_class = 'none'
```

Restrictive is the whole point: a permissive ring policy would OR with the firm's existing
`for all` policy and change nothing whatsoever — a policy that gets written, reviewed, and
never fires.

And the portal's own rule closes the other half. `document_path_guard` makes a document's
tenant, client, matter, storage path **and visibility** immutable, so a document the client is
already receiving cannot be quietly re-classified:

```
  update documents set privilege_class = 'work_product' …   → privilege_class_internal
  update documents set client_visibility = 'internal'  …   → ownership and storage path are immutable
```

The one direction material crosses that line is a **release**, with a ground, in the ledger.

---

## 5 · The door: القاعدة الحادية والعشرون, as data

Four grounds, each in the words the rule uses, checked by the route, by the database's CHECKs
and by the demo engine's copy:

| ground | to whom it may go | carries a writing |
|---|---|---|
| `crime_prevention` — منع حدوث جريمة | `authority` | no |
| `aml_suspicion` — الاشتباه بغسل الأموال أو تمويل الإرهاب | **`regulator` only** | no |
| `self_defence` — دفاع المحامي عن نفسه | `court`, `authority`, `regulator` | no |
| `client_written_consent` — موافقة العميل المكتوبة | `court`, `authority`, `regulator`, `third_party`, `client` | **yes — a document** |

- **An AML suspicion cannot be recorded as told to the other side.** A schema that permitted
  it would let a firm tell the counterparty what it suspected and cite the ground as authority.
- **Consent is a writing, not a flag.** `client_written_consent` must name the document that
  carries it; a boolean saying "the client agreed" does not insert.
- **The ledger is append-only.** SQLite: triggers. Postgres: `firm_api` holds `SELECT, INSERT`
  and nothing else — verified in the catalogue, not in the intent.
- **Reading the ledger is itself a privileged read.** That a note went to the Public Prosecution
  on a crime-prevention ground is a fact the client would pay to know and an adverse party would
  like to have. The `GET` is ring-gated and records `PRIVILEGED_READ`.

---

## 6 · The four things the phase got wrong, and where they were caught

This is the section worth reading twice, because none of these were caught by reading.

**(a) The only lawful path out of the ring was a 500 in the demo engine.** `privilege_releases`
was created in the SQLite literal without a default on `released_at`, and
`insertPrivilegeRelease` did not write the column. Postgres has `default now()` (0054) and was
fine; the demo engine refused every release with `NOT NULL constraint failed` — surfacing as
`500 internal_error` on a route whose whole purpose is to let a lawyer discharge a duty. The
first three tests written against the ledger found it. Fixed in the repository (the application
writes the timestamp in both dialects) **and** in the literal (the default is mirrored), so two
clocks cannot disagree about when a disclosure happened.

**(b) Five refusals shipped their details one level too deep.** `badRequest(code, message,
details)` takes the details object as its third argument. The P0.5 call sites passed
`{ details: { … } }`, which type-checks and serialises as `error.details.details` — so the
screen could not find `permittedRecipients`, and the refusal read as merely negative instead of
saying which recipient the ground *does* permit. This is the same shape as the earlier
`forbidden(code, msg, details)` mistake, and it was caught by asserting the *contents* of a
refusal rather than only its code.

**(c) A foreign key proved a document existed, not that it was the document.** 0054's ledger
referenced the subject document and the consent document by id; nothing said the subject
document had to be **on this matter**, or the consent to belong to **this client**. A release
could have recorded the disclosure of another firm's document, and the ledger a regulator reads
would have said a disclosure happened that did not. Fixed by **0056** — the guard function
extended, the same refusal token in the route, the SQLite mirror and Postgres
(`privilege_document_mismatch`), and the drift gate now counts the raises in all three copies.

**(d) The door was locked and the doorway was made of glass.** The ledger's `GET` required only
`matters.read`, so the paralegal the ring exists to keep out could read *what the firm had
disclosed, to whom, and on which ground*. Now ring-gated, with the refusal recorded.

**And one that was not a defect but a trap:** a backtick inside a SQL comment inside a template
literal broke `tsc` with four `TS1005`s (`` `check (privilege_class …)` `` in
`schema.firm.sqlite.ts`). It has now happened twice in this project; the rule is written into
the error ledger: **SQL prose inside a template literal carries no backticks** — the JS comment
above it may.

---

## 7 · What was verified, and how

**The suite — 567 tests, 16 files, green** (`npx vitest run`). P0.5 is 28 of them, in five
suites:

- **§A · the ring is a licence question.** The verdict table as a unit test; the five live
  sessions; a suspension answered on the *next request*; expiry, revocation, and the severity
  order; a practising role with its licence row **deleted**; and the managing partner confirmed
  to hold no exemption.
- **§B · the two columns are off the wire.** The lawyer receives the note word for word and the
  read is recorded; the paralegal keeps the matter and loses the work product; finance and
  compliance lose it too; compliance keeps the AML rating; the client's endpoints carry neither
  the key nor the value.
- **§C · the ledger and its only door.** A lawful release, recorded with who/whom/why; a refused
  release carrying the ring's reason; a paralegal who cannot reach the door at all and cannot
  read the ledger; an AML suspicion against a counterparty refused at the route *and* underneath
  it; consent refused as a flag and accepted as a writing; a release naming another file's
  document refused in both dialects; append-only proven by trying to edit and delete; the four
  grounds asserted as data.
- **§D · a privileged document is internal by construction.** Classification predicates; the
  client losing a document the moment it would become advice; the portal's immutability rule;
  a privileged document that is client-visible refused at INSERT.
- **§E · the trail.** No privileged-read event for a member who never asked; the read, the
  refusal and the release distinguishable in one ledger; the ring announced on the session and
  deciding nothing.

**The live harness — `scripts/verify/privilege-live.mjs`, 36 checks, all passing** against
PostgreSQL through the running server (`npm run start` in `server/`, port 8787). It asks the
catalogue what `firm_api` may read; asks `kgm_lawyer_ring_reason()` about six real memberships;
asks `firm_read_matter_privilege()` for the note as a lawyer and takes the refusal as a
paralegal; reads the policy and grant tables for the RESTRICTIVE policies and the ledger's
append-only privilege; creates a probe matter with a note, a privileged document and three
members on its team — **one resource, three members, three different answers** — and then walks
the whole thing through the application: the lawyer is handed the note and can record a release,
the paralegal opens the matter with the note withheld *by name* and never in the bytes, the
client's document list does not contain the advice and asking for its bytes is the same 404 a
stranger gets, and a lawyer whose licence is suspended between two requests is refused at the
door on the next one (the suspension is lifted in a `finally`). It found (c) above.

**The drift gate — `scripts/verify/privilege-drift.mjs`, 19 checks, all passing.** Defect (o) —
one rule, three copies, drifted — was found by a human reading three files. This is that reading,
automated: the ring vocabulary and its severity order in the domain against the plpgsql `case`
arms (including the `pending`-is-the-`else` asymmetry), the UTC-day arithmetic in SQL against
`toISOString().slice(0,10)`, the four grounds in the domain against both dialects' CHECKs, the
document-scope token counted as *raises* in all three copies (a comment cannot refuse an INSERT),
and the ledger's append-only rule in both engines. It runs in a quarter of a second, which is
the point.

---

## 8 · The matrix, as it now stands

| role | licence | ring | `internal_notes` / `risk_rating` | advice documents | ledger read | ledger write |
|---|---|---|---|---|---|---|
| MANAGING_PARTNER | required | **in** | ✔ | ✔ | ✔ | ✔ |
| PARTNER | required | **in** | ✔ | ✔ | ✔ | ✔ |
| LAWYER | required | **in** | ✔ | ✔ | ✔ | ✔ |
| ASSOCIATE | required | **in** | ✔ | ✔ | ✔ | ✔ |
| PARALEGAL | — | out | withheld by name | · | 403 | 404 (no write on the matter) |
| OPERATIONS | — | out | withheld | · | 403 | 404 |
| COMPLIANCE | — | out | withheld (keeps the AML rating) | · | 403 | 404 |
| FINANCE | — | out | withheld | · | 403 | 404 |
| ADMIN | — | out | withheld | · | 403 | 404 |

Two lines carry the design:

- **A practising role without a valid licence falls out of the ring.** Partner, lawyer and
  associate are not in the ring because of what they are called; they are in it because the
  firm declares those roles practise law *and* a licence good enough to practise is on record.
  Suspended, revoked, expired, pending or absent — each is refused, and each says so.
- **Being outside the ring is not being outside the file.** Every one of these members still
  opens the matters they work; what they lose is the firm's own view of it. That separation is
  what keeps the ring from becoming an access-level argument in disguise.

---

## 9 · Deliberately not in this phase

- **No screens.** The firm SPA already renders both fields through the §57 withheld mechanism
  (`isWithheld('internalNotes')` renders a lock), so nothing was needed — and nothing was
  invented. A lock that *explains* itself from `privilege.reason` ("يحتاج ترخيصاً سارياً") is
  small and worth doing; it is P2 polish, next to the release UI.
- **No release UI.** The API exists and is tested; the screen that drives it belongs with the
  conflicts-and-disclosure work rather than here.
- **No legal hold.** A privileged document's retention and hold behaviour is P1.5's problem, and
  a half-built hold is worse than none.
- **Declassification is unlegislated, on purpose.** Setting `privilege_class` back to `none` is
  not refused by the database. It removes no client protection (the portal rule still holds the
  document internal) and it is the kind of decision that belongs with retention policy rather
  than with a CHECK written in a hurry. Recorded here so it is a decision, not an oversight.
- **The notes remain read-only in the API.** Reading is what this phase had to protect;
  authoring privileged notes is P2's editor.

---

## 10 · Open, and honest

- **The demo seed ships no privileged documents.** The class exists, the rules are live and the
  harness creates one — but a fresh demo database has every document at `none`, so a reviewer
  clicking around will not see a withheld advice document without running the harness. Adding
  one to the seed would be truer to a firm's file.
- **The live harness leaves its evidence behind**: matters named `PROBE-PRV-…` with a privileged
  document in them, and the releases it recorded. That is deliberate — an immutable ledger
  cannot be swept by the tool that wrote it, and neither can a served document — and the names
  are the sweep label.
- **Push is still pending a credential.** Three local commits from P0.4 and the P0.5 work are
  in the repository; the portable bundle at `/home/user/github-push/` is refreshed to match.
- **The cold-fleet sign-in wedge** (P0.4-era, self-healing in ~277 s) is untouched by this phase
  and remains the one open robustness item.

---

## 11 · The live state after the phase

```
  migrations   0001–0056 applied (0054 419 ms · 0055 · 0056 275 ms)
  database     87 tables · 281 policies · roles 4/4 (portal_api, firm_api, auditor, payments_service)
  firm_api     matters: SELECT 21 of 23 columns · UPDATE 3 · NO privilege on internal_notes/risk_rating
               documents: SELECT 30 columns including privilege_class
               privilege_releases: SELECT, INSERT — and nothing else, ever
  policies     documents: 2 RESTRICTIVE ring policies + the firm/portal scope policies
               privilege_releases: RLS enabled AND forced, portal denied outright
  audit        150 actions, including PRIVILEGED_READ and PRIVILEGE_RELEASED (0055)
```

How to reproduce every claim in this document:

```
  npx vitest run                                   # 567 tests, 16 files
  cd server && npm run start                       # the API on :8787 (0.0.0.0)
  node scripts/verify/privilege-live.mjs           # 36/36 against the running server
  node scripts/verify/privilege-drift.mjs          # 19/19, no database needed
  npx tsc --noEmit -p server/tsconfig.json         # clean
```

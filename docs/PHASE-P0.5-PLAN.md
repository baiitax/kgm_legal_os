# PHASE P0.5 — THE PRIVILEGE RING

**Why this phase is next.** P0.1–P0.4 taught the system to refuse to act without a lawful
basis: who may practise, who may be billed, who may act at all, and whether a judgment can be
enforced. P0.5 is the first phase about something the firm must *not be able to do* — read its
own material too widely.

**The obligation, and its article.** A lawyer may not disclose a secret entrusted to him or
learned through his profession, **even after the mandate ends** — نظام المحاماة، المادة الثالثة
والعشرون. The professional-conduct rules state the same duty and name the only exits —
القاعدة الحادية والعشرون: preventing a crime, a suspicion of money laundering or terrorism
financing, the lawyer's own defence against a claim or complaint, and the client's **written**
consent.

Two consequences follow, and they shape the whole phase:

1. **The duty attaches to the lawyer.** Not to the firm, not to the role, not to the screen.
   A paralegal, a finance officer and a compliance officer are not covered by it, so they are
   not entitled to read what it protects. The gap analysis measured this: `internal_notes` is
   readable today by *any* member with matter access, including all three.
2. **Where there is a ring, there must be a door with a ledger.** Rule 21 permits disclosure
   on four grounds. A system that can only say "refused" cannot serve a firm that must report
   a suspicious transaction, answer a complaint against itself, or release a document on the
   client's written instruction. So the ring is built with its exits, each of which names a
   ground, and each of which is recorded.

---

## 1 · The ring is not a role, and not an access level

An access level answers "how much of this matter may you see". A role answers "what are you
for". Neither answers "may you lawfully practise", and that is the fact the duty attaches to.

The system already has the right question, from P‑1: `roles.requires_practising_licence` is the
firm's own declaration that a role means practising law (LAWYER, ASSOCIATE, PARTNER,
MANAGING_PARTNER today), and `eligibilityFor()` already decides whether the person holding it
has a licence good enough to practise — including the two rules that matter:

- **absence is not permission**: no licence on record is `no_licence_on_record`, not a pass;
- **a suspension outranks an expiry**, and the reason named is the most serious one present.

So the ring is exactly `requiresPractisingLicence ∧ entitled` — and it is resolved **once**, at
principal resolution, never re-derived in the projector. A lawyer whose licence is suspended
this morning loses the ring this morning, without anybody editing a role.

## 2 · Three layers, because the browser is not the only untrusted party

| layer | what refuses | what it cannot do |
|---|---|---|
| **domain** (`classification.ts`, `privilege.ts`) | the field is not projected; its name is withheld | cannot stop a query |
| **API** | a privileged resource is a 403 with a named reason; a release needs a ground | cannot survive a repository bug |
| **database** (0054) | `firm_api` **has no SELECT privilege on the columns**; the values are reachable only through a `security definer` function that checks the ring and writes the read to the ledger | cannot be bypassed by the application at all |

The third layer is the interesting one, and it is what makes this phase more than a projection
rule. `server/src/db/postgres.ts` has described the intended shape of the `firm_api` role since
P‑1 — "(a) has NO SELECT grant on internal columns (matters.risk_rating, matters.internal_notes,
…)" — and the role does not, in fact, lack them. It has table-level SELECT on `matters` and 23
column-level grants including both. P0.5 makes the comment true:

```sql
revoke select on public.matters from firm_api;
grant select (…every column except internal_notes and risk_rating…) to firm_api;
```

After that, a repository bug that selects the column does not leak it — it fails. The values
come back through `firm_read_matter_privilege(p_matter uuid)`, a `security definer` function
which (1) reads the tenant and membership from the same `kgm.*` settings RLS uses, (2) checks
the ring, (3) writes the read to `audit_events`, and (4) returns the values — or raises
`privilege_ring_refused: <reason>` and writes the refusal.

**A definer function is a hole with a lock on it, and the tenant filter is manual.** The
function does not inherit RLS, so it filters by `kgm_tenant()` explicitly and says so in a
comment, because the next person to edit it will otherwise assume the policies apply.

## 3 · What is in the ring

| resource | today | after P0.5 |
|---|---|---|
| `matters.internal_notes` | `confidential` — anyone with write access, i.e. a partner and an associate | **`privileged`** — the lawyer ring only |
| `matters.risk_rating` | `confidential` | **`privileged`** — the firm's exposure assessment is advice |
| advice documents | no marker at all | new `privilege_class` on `documents` (`none` · `advice` · `work_product` · `litigation`), with lawyers-only read |

**On `risk_rating`, because two ratings exist and they are not the same question.**
`client_due_diligence.risk_rating` (P0.3) is the AML assessment of the *client*, and a
compliance officer must read it to do her job — that is the point of P0.3 and it does not
change. `matters.risk_rating` is the firm's assessment of its *own* exposure on the matter. The
gap analysis asks for the second; conflating them would either hand the AML verdict to lawyers
only or hand the firm's legal-risk view to everyone. The phase separates the two in prose *and*
in the registry, and a test asserts the compliance officer keeps the first while losing the
second.

**And the client.** The privilege belongs to the client, so a privileged document is not
"firm-only because the client must not know" — it is *internal work product*: the note the
lawyer writes to himself, the assessment, the litigation strategy. The advice the client
receives is a document the firm issues to the client, and that is a different artefact with
`client_visibility` on it. `documents.privilege_class <> 'none'` rows are therefore never
readable by `portal_api`, enforced as a **restrictive** policy so that no future permissive
policy can widen it back by accident.

## 4 · The ledger, and the door

`privilege_releases` records every deliberate exit: which matter or document, **which of the
four grounds**, who received it, on whose instruction, and which document carries the client's
written consent. Two CHECKs are legal rules rather than housekeeping:

- a release on `client_written_consent` **must** name the document that carries it (Rule 21
  says written; a flag saying "the client agreed" is not a writing);
- a release on `aml_suspicion` **must** go to `regulator` — a suspicion of money laundering is
  reported to the financial intelligence unit, not disclosed to a counterparty, and a schema
  that permits the second while meaning the first is a schema that will be read wrongly.

A trigger refuses a release by a member outside the ring, and every release is audited
(`PRIVILEGE_RELEASED`). Reads are audited too (`PRIVILEGED_READ`, success *and* denied), which
completes the read-auditing story P‑1.4 began with `MATTER_VIEWED`.

## 5 · The withheld mechanism, extended

`§57` already reports the **names** it withheld rather than values, and the firm app already
renders a lock (`firm/src/components/FieldLock.tsx`). `privileged` is a new classification, not
a new mechanism — the member sees `internalNotes` in `withheld` and a lock where the note was,
with no value and no inference available. **§50 holds**: the server withholds whether or not
the screen renders it, and the screen has nothing to override.

## 6 · What is verified, and how

- **Suite** (`tests/security/privilege-ring.test.ts`): the denial matrix — paralegal,
  operations, finance, compliance, admin, and **a lawyer whose licence is suspended** — plus the
  two ratings kept apart, the portal kept out, the release grounds, and the refusal reasons.
- **Live harness** (`scripts/verify/privilege-live.mjs`): asks the real database what `firm_api`
  may select (the column grant is absent), what the definer function does for a member inside
  the ring and for one outside it, whether the refusal is recorded, whether a privileged
  document is invisible to `portal_api`, and whether the AML-ground CHECK actually refuses a
  disclosure to a counterparty.
- **Drift** (§P0.5-M): the ring's definition read out of three copies — the domain, the SQLite
  mirror and the SQL function — and diffed as text, the way §P0.4-M diffs the enforcement
  matrix. The rule is `requiresPractisingLicence ∧ entitled`, and it now lives in three places.

## 7 · Deliberately not in this phase

- **No new screens.** The lock, the withheld strip and the matter workspace already exist; P0.5
  is the enforcement behind them. A privileged-materials panel belongs with P2's tab work.
- **No legal-hold integration.** `retention_block` and legal holds are P1.5, and a hold is a
  different question from a ring (a hold freezes a record against deletion; a ring decides who
  may read it).
- **No UI for releases.** The table and the route are the record; a partner who must disclose
  under Rule 21 does it once, with a form, in P2.
- **Notes stay read-only in the API.** The firm can read a note through the ring; there is no
  route that writes one yet, so the write side of the classification is asserted at the
  database (the column is not updatable by the application role either) rather than invented
  for a screen that does not exist.

## 8 · Sequence

1. domain: `privilege.ts` + the `privileged` classification + the ring in the projection context
2. migration 0054: the function, the column revokes, the document class, the releases table
3. migration 0055: the audit vocabulary, regenerated
4. repo + routes: the privileged read, the documents refusal, the release
5. SQLite mirror and the drift suite
6. the suite, the live harness, the report

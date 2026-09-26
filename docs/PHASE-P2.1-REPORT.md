# P2.1 — THE FIRM WRITES ITS OWN DOCUMENTS

**Item ② of the user's build order · 26 September 2026**

Five migrations, five routes, one service, one repository, one panel, one live harness.
The firm can now file a document, release it to the client, take it back, correct its
name, replace it with a new version, archive it, and read it — and every one of those
acts is gated by a permission, a policy and an audit row rather than by a UI flag.

---

## 1 · Why this was the biggest unblocker

The documents tab could list and could not write. Everything downstream of that gap
was stuck behind it, and the gap analysis named them:

| what was blocked | why the block was here |
| --- | --- |
| the conflict waiver | Rule 8's waiver is a value in a column; the document it rests on had nowhere to live |
| the engagement letter (Rule 12) | the gate reads `engagement_letters`; the paper it rests on could not be uploaded |
| "the current signed contract" | unanswerable — a new version of a document could not be written either |
| half the matter workspace | every tab that ends in "...and here is the document" ended in a list with no way in |

---

## 2 · What was built

### Migrations

| # | what | verification |
| --- | --- | --- |
| **0061** | `documents.supersedes_document_id` + partial index; firm INSERT (30 cols) and UPDATE (11 cols); `documents_firm_insert` / `documents_firm_update`; **no DELETE** | dry-run ✓ → applied, 313 ms |
| **0062** | audit vocabulary regenerated from the union — **163 actions** | dry-run ✓ → applied, 349 ms |
| **0063** | `document_access_log` INSERT/SELECT to `firm_api`; two policies whose subquery runs under the caller's RLS; append-only (no UPDATE/DELETE) | dry-run ✓ → applied, 280 ms |
| **0064** | `documents.category` — **the default the CHECK refuses** | dry-run ✓ → applied, 244 ms |

### The write surface

`server/src/domain/firm-documents.ts` — `FirmDocumentService`:

```
file()               the pipeline the portal already uses: name → size → sniff →
                     scan BEFORE the row → object → row + audit in one transaction
setClientVisibility() release, restrict; privileged → visible refused (403)
refile()             title, title_ar, type, category — metadata, never bytes
archive()            settles the row; never deletes it
read()               the bytes, with the access history appended before they leave
```

Five routes in `firm.routes.ts`:

```
POST   /matters/:id/documents                      documents.create + MATTER_OPERATE
POST   /matters/:id/documents/:docId/versions      documents.create
GET    /matters/:id/documents/:docId/versions      documents.read
PATCH  /matters/:id/documents/:docId               documents.release | .edit | .delete
GET    /matters/:id/documents/:docId/content       documents.read
```

### Why the authority is split the way it is

The firm's own catalogue already answered this, so no new permission was invented:

* **`documents.create` + `MATTER_OPERATE`, not `MATTER_WRITE`.** A paralegal's access
  level is `operational` — §13's "matter preparation and operations" — and filing the
  papers *is* that. Requiring `edit` would mean the person whose job is assembling the
  file is the one person who cannot put anything in it, and the behaviour that follows is
  that documents stay on a desktop instead.
* **Release is `documents.release`, a separate act.** A paralegal files a court document
  and cannot show it to the client. Release is audited apart from filing, because "do we
  have it" and "does the client have it" are different questions.
* **Privilege is not a toggle.** A privileged document is `internal` from birth (0054's
  CHECK makes that the only value it can hold), and releasing one is refused outright:
  the P0.5 release ledger is the only lawful door.
* **The new version inherits the privilege class.** A "v2" filed as `none` would have
  been a way to walk the same advice out of the ring with one upload.

---

## 3 · Four defects the work found

Each was found by running the thing against the real database, and each is now fixed
with an assertion that fails if it comes back.

1. **The audit vocabulary, which fails by rolling back.** `DOCUMENT_FILED` was in
   `logger.ts` and not in Postgres. Because the audit row is written in the same
   transaction as the document row, the first filing returned `500 internal error` and
   **the document was not filed**. This is migration 0062, and it is the failure mode the
   ledger has been warning about since policy 0059.

2. **Archiving that did not mean anything.** `setClientVisibility` refused an archived
   document; `refile` did not. The live harness archived a filing and then re-filed it,
   and the re-file **succeeded**. Since 0061 grants no DELETE anywhere, archive is the
   firm's only removal — a document that can still be edited after archiving has no
   settled state at all. Now 409 `document_archived` on both paths.

3. **The default that the CHECK refuses.** `documents.category` was declared
   `default 'other'` with a CHECK admitting `from_firm | requested | uploaded | signed |
   court | financial`. Any INSERT omitting the column fails with a constraint name and no
   list of the values that would have worked. 0064 drops the default; the service now
   answers 400 with `allowed: [...]` before the database is reached.

4. **The neighbour that was never real.** `intake-live.mjs` had the second tenant as
   `aaaaaaaa-…-0002`. The tenant is `bbbbbbbb-…-0002`. Its neighbouring-firm block asked
   for a client that does not exist, got the same 404 a foreign client gets, and compared
   **two fabricated 404s** to each other and reported a pass. Fixed; the assertion is now
   real and still green (52/52).

A fifth, smaller one is worth naming because of its shape: `accessor_kind` was written as
`firm_member`, a word the table's CHECK does not know (`client | staff | system`). The
read route failed on its own audit row. A word that reads better and does not exist is
still a 500.

---

## 4 · The evidence

```
scripts/verify/documents-live.mjs                 65 passed, 0 failed
scripts/verify/intake-live.mjs                    52 passed, 0 failed
scripts/verify/deploy-check.mjs                   27 passed, 0 failed
npm run test:server                              618 passed
npm run test:firm                                 69 passed
npm run test:web                                  49 passed
tsc --noEmit (server, firm)                       clean
build:all + build-vercel                          clean
i18n AR = EN                                      648 keys
migrations live                                   0001–0064
```

The live harness does not trust the API's own answers. It asks Postgres for the grants,
the policies and the rows; it emulates **the client's own session** (`kgm_phase=portal`,
`kgm_client_ids`) to prove that a released document is readable by the client and an
unreleased one is not; it emulates **a specific membership** (`kgm_membership_id`) to
prove that a paralegal's derived access level is `operational`; and it uses the real
neighbouring tenant's client, matter and document to prove cross-tenant refusal is
byte-identical to a matter that does not exist.

---

## 5 · What is open

* **P0.6 residency** — item ①, still a decision awaiting its meeting, still the only open
  CRITICAL, still independent of feature work.
* **Document type and category labels are English enums** in both languages. The values
  are the server's; a proper Arabic pass belongs with the billing vocabulary in P2.3.
* **The firm cannot file an `invoice` or a `receipt`** — `FIRM_DOCUMENT_TYPES` excludes
  them on purpose, because they will be written by the invoice path rather than by a
  person with a file picker (P2.3).
* **`document_access_log` is now readable by the firm** and nothing renders it yet. The
  "who has opened what we sent" panel is a real, cheap follow-up.
* **P1.6 durable outbox, P2.3 invoice creation, P1.5 retention, P2.4 PoA** — items ③–⑤ of
  the build order, untouched by this phase.

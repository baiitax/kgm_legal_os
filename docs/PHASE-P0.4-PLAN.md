# Phase P0.4 — judgments, service, and the appeal period

**Status: plan of record, being built.**

---

## Why this phase exists, in one paragraph

The system holds the firm's **client-facing view of a case** — a status, a friendly timeline,
upcoming hearings — and it does not hold the **case file**. There is no judgment record: no
صك number, no issuing court or circuit, no judgment type, no finality, and no date of delivery
to the party. `LEGAL-GAP-ANALYSIS-II.md` §N1 states the consequence exactly:

> *«تبدأ المدة من تاريخ تسليم صك الحكم إلى المحكوم عليه»* — the period runs from delivery of
> the judgment copy, not from pronouncement. **You cannot diarise an appeal period without a
> صك and its delivery date.**

A missed thirty-day appeal is malpractice with an identifiable victim. So the phase has one
invariant, in the same shape as P0.3's:

> **Enforcement does not begin on a judgment that is not yet enforceable, and it never begins
> against a party who has not been served — and where it is refused, the refusal names the
> thing that is missing, says when it will stop being missing, and leaves a record that the
> refusal happened.**

---

## What is built

**Four tables**, and the reason for each:

| table | what it is | why it is not something else |
|---|---|---|
| `judgments` | the register: صك number, court, circuit, kind, pronouncement, delivery, relief, finality, enforcement posture | `matters.internal_status='judgment'` is a state, not a record. A matter has several judgments over its life (first instance, appeal, cassation); a state cannot hold them. |
| `service_events` | what was served, on whom, when, by what channel, with the proof, and **what clock it started** | The plan of record said `service_records`. It records notices too — a court notice, an execution notice — and a notice that was served is an event on a timeline, so the name follows the thing. |
| `judgment_appeals` | each challenge: استئناف, تمييز, التماس إعادة النظر, with its own filing clock and outcome | An appeal is not a boolean on a judgment. It has a filing date, a deadline it was filed against, a court, and an outcome that changes what may be enforced. |
| `court_calendar` | the firm's non-working days, Hijri date alongside the Gregorian one | The extend-to-the-next-working-day rule needs to know which days the courts sit. Without it the rule is a guess about Fridays. |

**The periods**, with the article carried on every computed date (the gap analysis asks for
exactly this — a rule identifier and the article cited, not a bare timestamp):

| route | days | urgent | cited |
|---|---|---|---|
| first instance → appeal (استئناف) | 30 | 10 | نظام المرافعات الشرعية — المادة ١٨٧ |
| appeal judgment → cassation (تمييز) | 30 | 15 | نظام المرافعات الشرعية — المادة ١٨٧ |
| petition for rehearing (التماس إعادة النظر) | 30 | 30 | from the day the ground became known |

Three rules that decide the arithmetic, stated once and implemented once:

1. **The period runs from the day AFTER delivery** of the judgment copy to the party.
2. **The last day extends** to the next working day when it falls on the weekend or a day in
   `court_calendar`. The start never extends; only the end.
3. **The moment is the end of the working day in the Kingdom** — 23:59:59+03:00, which has no
   daylight saving — because a window that closes at 20:59:59 UTC is a window that closed three
   hours early.

**Service is what starts the clock, and not every recorded attempt is service.** The domain
draws the line, and the line is stored on the row as an `effective_at` the database itself
refuses to accept where it does not belong:

| outcome | efective? | why |
|---|---|---|
| `served` | yes | it was delivered |
| `refused` | **yes** | a refusal recorded by the judicial officer is service; the party does not get to stop time by refusing the envelope |
| `substituted` (publication) | yes, **after the publication period** | the period is recorded on the row (`publication_days`) and stored, never assumed |
| `unclaimed` | no | a registered letter nobody collected is not service; the lawful route is a second attempt or substituted service |
| `untraceable` | no | an unknown address is not service either — it is the application for substituted service |
| `pending` | no | there is nothing to diarise from an attempt that has not happened |

**Recording service creates the diarised deadline.** A `deadlines` row of kind `appeal`,
`cassation` or `reconsideration`, internal (a statutory period is the firm's obligation, not
something a client can be assigned), carrying `rule_cited`, `rule_days`, `trigger_event` and
the id of the service event it came from. Filing the appeal closes it. This is the point of
the phase: the date exists because the service exists, and both are on the record.

**The gate**, on `matters.internal_status → 'execution'`, in the three places P0.3 established
— the route (a named code), the domain (`executionOutcome`, the same function the register on
the screen uses), and the database (a trigger, for a caller who is not this application):

```
judgment_missing → judgment_not_enforceable → judgment_not_served → service_defective
                 → execution_stayed → appeal_pending → appeal_window_open → admitted
```

The order is part of the answer, and it is ordered by what the person can act on: first, is
there a judgment and does it order anything to enforce; second, **may the state's power be used
against this person at all** — has the صك been delivered to them; third, may it still be
challenged, has it been, and has a court stopped it.

**The operative judgment is the latest one pronounced**, in the domain and in the SQL, because
a matter with an appealed judgment has two and enforcement is not a matter of choosing the
friendlier. The register names the judgment the answer is about, so a screen never has to
guess which one it is displaying.

---

## What this phase deliberately does not do

- **No `deadline_rules` catalogue and no escalation ladder.** The three appeal periods are
  constants with their articles attached, and the deadline instance is created. A general
  engine for every period in the law, and the escalation when one approaches, is P1.6 —
  and `LEGAL-GAP-ANALYSIS.md` says why the order matters: *an escalation that can be lost is
  worse than no escalation*, and the durable outbox is not built yet. Until then transitions
  are visible in the register rather than emailed.
- **No Najiz integration.** Service dates, صك numbers and case numbers are typed by the firm,
  which is how they arrive today.
- **No client-facing judgment register.** The client's window onto a judgment is the matter
  timeline and the released document, both of which already exist and are projections. The
  firm's appeal plan is advice; advice is not a projection of a court document.
- **No enforcement-file management** (the execution court's own numbers and steps beyond the
  open/satisfy lifecycle). The register says whether enforcement may begin and records that it
  did; running the execution file is the next phase's work.

---

## How it will be verified

| what | how |
|---|---|
| the register, the permissions, the gate matrix | `scripts/verify/judgment-gate-live.mjs` against the live API and the live PostgreSQL |
| the gate in the DOMAIN and in the DATABASE, per fixture | the same harness, twice per matter: the route and raw SQL as `postgres` |
| the arithmetic — day-after, extend, +03:00 end of day | `tests/security/judgments-and-service.test.ts`, with the boundary cases as values rather than as prose |
| the new grants against the new statements | `npm run verify:parity` |
| nothing else was broken | the whole suite from the repository root |

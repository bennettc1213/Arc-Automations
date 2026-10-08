# The proof ledger: what evidence makes a job count

**Roadmap step:** `ARC-MK-210`. **Status:** built. The owner's own answer button is the next
step's (`ARC-MK-220`).

ARC bills a pilot client only for jobs it can prove it brought back. This document is the
rule that decides that: which events are the evidence, how a job's status is read off them,
and how the fee is worked out. The rule is one function, and every screen that says "counts"
reads it.

Where this file and the code disagree, the code is right:
[`src/portal/lib/ledger.js`](../../src/portal/lib/ledger.js) (the rule),
[`supabase/functions/_shared/ledger/model.ts`](../../supabase/functions/_shared/ledger/model.ts)
(the vocabulary) and [`tests/ledger.test.js`](../../tests/ledger.test.js).

---

## 1. The chain

A recovered job needs every link, in this order.

| # | Link | Evidence in `events` |
|---|---|---|
| 1 | A call or a form arrived | `call_missed`, `lead_received` |
| 2 | Nobody answered it live | a `call_missed` is only written when the forward rang out; a form has nobody to pick up |
| 3 | ARC's text went out | `sms_sent`, success, and not refused by the carrier |
| 4 | The customer replied, or booked it themselves | `reply_received`, or a `lead_booked` with `booked_by: customer` |
| 5 | A visit was booked for a time, and the time has passed | `lead_booked.payload.appointment_at` |
| 6 | The owner said it happened, or was asked and the dispute window passed | `lead_outcome_recorded`, or `lead_outcome_requested` plus the terms |

The first missing link is the job's status and its reason. A later link with an earlier one
missing is `unverified`: shown, never counted, never billed.

Order is part of the proof. A reply or a booking that came before ARC's text is `unverified`,
because ARC cannot show it caused it.

## 2. The nine statuses

| Status | The owner reads | When | Billed |
|---|---|---|---|
| `answered` | you answered it | a person at the business picked up | no |
| `unverified` | cannot be proven | a later link exists without an earlier one; a booking with no visit time | no |
| `not_billable` | does not count | no reply, wrong number, opted out, out of area, nothing booked, a duplicate, ruled out before the visit, an accepted dispute | no |
| `handed_off` | handed to you | ARC stopped and gave it to a person | no |
| `booked` | not counted yet | the visit time is still ahead | no |
| `needs_owner` | waiting on you | the visit time has passed and nobody has answered | no |
| `disputed` | disputed | the owner said it should not count, after the visit, and no operator has settled it | no |
| `confirmed` | counts | the owner said the job happened, or that the visit happened and a quote is open | yes |
| `billable` | counts | asked, unanswered and past the window; or a dispute an operator did not accept | yes |

Two statuses bill and they print the same word, because to an owner they are the same thing.

## 3. Five decisions, and why

1. **Silence counts only after the owner was asked.** A job nobody answered about becomes
   `billable` when the dispute window has passed *since ARC asked*. With no
   `lead_outcome_requested` on record, or no terms, it waits on the owner for ever. Nothing
   writes that event until `ARC-MK-220`, so today no job is billed by silence.
2. **A lead handed to a person is never billed**, even if the owner then books it. The demo
   and the portal already promise that.
3. **An operator settles a dispute.** One of the seven listed reasons, given after the visit,
   stops billing until it is settled. A dispute that arrives after the window is recorded and
   flagged, and does not unbill the job by itself; an operator can still concede it.
4. **A website form counts like a missed call.**
5. **Answered calls are a count**, with no lead and no number kept.

Two more that the build settled:

- **"Quoted, not sold yet" counts.** The homepage's rule is about the visit, not the sale.
- **A booking a person typed in is not the customer answering.** Link 4 needs the customer's
  reply, or a booking the customer made themselves. Every booking today is one a person
  recorded, so today link 4 is the reply.

## 4. The evidence that was added

Five event types, and one field. All are in `event-validation.ts`, `types.js`, `format.js`
and [`EVENT_CONTRACT.md`](../../EVENT_CONTRACT.md).

| Type | Written by | Claims |
|---|---|---|
| `call_answered` | the phone webhook, on `DialCallStatus: completed` | the business picked up |
| `lead_outcome_requested` | nothing yet (`ARC-MK-220`) | ARC asked the owner |
| `lead_outcome_recorded` | `recordOutcome` | `happened`, `quoted`, or `not_counted` with a reason |
| `lead_dispute_settled` | `settleDispute` | an operator `accepted` or `rejected` one answer |
| `pilot_terms_recorded` | `recordPilotTerms` | base, per job, cap and window, in cents and days |

`lead_booked` gained `payload.appointment_at`. A rescheduled visit is a second row and the
latest is read.

`pilot_terms_recorded` is in its own group (`account`), not lead capture. A module is "live"
when one of its business events is seen, and terms agreed on a call are not a phone line
that works.

**Why the terms are an event.** The fee is a figure, and every figure is derived from
`events`. Its terms are the numbers that figure multiplies, recorded by a person with a
date, so they are evidence in the same log. A price change is a new row, and the latest
whole row is in force. No number lives in this public repository.

## 5. The derivation

```
events ─► buildThreads ─► buildLeadCapture ─► buildLedger ─► data.threads[i].ledger
                          (folds the new                     data.ledger { totals, month, terms }
                           evidence onto each lead)
```

- `ledgerStatus(facts)` is the rule. It takes plain facts and knows nothing about events,
  clocks or screens.
- `factsFromLead` reads those facts off a lead as `buildLeadCapture` folded it.
- `buildLedger` runs it over every lead, not the capped list, and works out the month.

The demo's seven written examples are converted to the same facts (`ledgerFacts`) and go
through the same `ledgerStatus`. A test writes each example as an event log and checks both
paths give the same status and the same reason.

Nothing here reads an operational table, and no status is stored.

**Duplicates.** A second lead from the same number that arrives before the visit the first
one booked is the same job, and is `not_billable`. It is read off times, so a status does
not change back once the first visit is over.

## 6. The fee

```
fee = min(cap, base + per job × jobs that became billable this month)
```

- The month is the calendar month in the business's own timezone.
- A job belongs to the month it became billable: the later of the owner's yes and the visit
  time, the end of the window, or the day a dispute was settled against the owner.
- No terms on record: the fee is null, and the screen prints a dash and the reason.
- A cap of null is "no cap agreed".
- There is no invoice, no payment and no credit here. A job conceded after its month is
  simply no longer in that month's count.

## 7. Idempotency

| Write | Key |
|---|---|
| a booking | `lr:booking:<correlation>:booked:<appointment_at>` |
| an answer | `ledger:outcome:<correlation>:<id of the answer it replaces, or "first">` |
| a settlement | `ledger:settled:<correlation>:<id of the answer being settled>` |
| terms | `ledger:terms:<id of the terms it replaces, or "first">` |
| an answered call | `lr:call_answered:<CallSid>` |

An answer names the row it replaces, not its own content. A double tap collides. A changed
mind is a new row and the old one stays. Two people answering the same question at once
write one row.

## 8. Tenant isolation

- Events are scoped by row level security, and `buildDashboardData` drops any row stamped
  with another tenant before deriving anything.
- Every write looks the lead up by tenant and id, so another client's id finds nothing.
- The operator's actions run through `ops`, gated on `arc_admins`. The owner's own write
  path, with the tenant taken from `tenant_members`, is `ARC-MK-220`.

## 9. What is not built

- **No button yet.** The three operator actions exist in `ops`
  (`lead-recovery-record-outcome`, `lead-recovery-settle-dispute`,
  `lead-recovery-record-terms`) and `lead-recovery-book` takes `appointment_at`, but no
  console screen calls them. The owner's answer screen and the operator's view are
  `ARC-MK-220`.
- **Nothing asks the owner**, so no job is billed by silence.
- **No customer-made booking** writes `booked_by: customer` yet.
- **The window in hand is 61 days.** A statement for an older month would need a wider read.
- **Not deployed.** `ingest`, `ops` and `twilio` must be redeployed before the new types are
  accepted or written. Until then the portal shows every real job as waiting or not counted,
  which is true.

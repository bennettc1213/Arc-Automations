# The proof ledger: what evidence makes a job count

**Roadmap steps:** `ARC-MK-210` (the rule) and `ARC-MK-220` (the owner's answers and
disputes, section 9). **Status:** built.

ARC bills a pilot client only for jobs it can prove it brought back. This document is the
rule that decides that: which events are the evidence, how a job's status is read off them,
and how the fee is worked out. The rule is one function, and every screen that says "counts"
reads it.

Where this file and the code disagree, the code is right:
[`src/portal/lib/ledger.js`](../../src/portal/lib/ledger.js) (the rule),
[`supabase/functions/_shared/ledger/model.ts`](../../supabase/functions/_shared/ledger/model.ts)
(the vocabulary),
[`supabase/functions/_shared/ledger/service.ts`](../../supabase/functions/_shared/ledger/service.ts)
(the owner's write), [`tests/ledger.test.js`](../../tests/ledger.test.js) and
[`tests/owner-answers.test.js`](../../tests/owner-answers.test.js).

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
   `lead_outcome_requested` on record, or no terms, it waits on the owner for ever. What
   counts as asking is section 9.
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
| `lead_outcome_requested` | `requestOutcome`, through `markAsked` | ARC asked the owner |
| `lead_outcome_recorded` | `recordOutcome`, through `answerOutcome` for an owner | `happened`, `quoted`, or `not_counted` with a reason |
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
| an asking | `ledger:asked:<correlation>` |

An answer names the row it replaces, not its own content. A double tap collides. A changed
mind is a new row and the old one stays. Two people answering the same question at once
write one row.

## 8. Tenant isolation

- Events are scoped by row level security, and `buildDashboardData` drops any row stamped
  with another tenant before deriving anything.
- Every write looks the lead up by tenant and id, so another client's id finds nothing.
- The operator's actions run through `ops`, gated on `arc_admins`. The owner's own write
  path is the `ledger` function, with the tenant taken from `tenant_members` (section 9).

## 9. The owner's answer (`ARC-MK-220`)

The owner answers one question per booked visit, on the needs-you screen. It is the portal's
first client write.

**Six taps, no new vocabulary.** `OWNER_ANSWERS` groups the three outcomes and seven reasons
the way a person answers on a phone:

| The owner taps | Recorded as |
|---|---|
| sold, or the job happened | `happened` |
| quoted, not sold yet | `quoted` |
| did not happen | `not_counted`, `did_not_happen` |
| not a real job | `not_counted`, then one of `spam`, `wrong_number`, `out_of_area` |
| customer cancelled | `not_counted`, `customer_cancelled` |
| duplicate, or already handled | `not_counted`, then `duplicate` or `owner_first` |

The first two count. Any other answer after the visit is a dispute: not billed until an
operator settles it. The screen says so before the tap.

**The door.** `POST /functions/v1/ledger`, actions `outcome-answer` and `outcome-asked`. The
actor is the verified sign-in. Their membership is read from `tenant_members`. A body cannot
claim a tenant, a role or `answered_by`. An operator does not answer here.

**What `answerOutcome` checks before it appends one row:**

- the lead belongs to this client. Another client's reference is "not found", the same
  answer as one that does not exist;
- there is a booked visit, and for "it happened" or "quoted" the visit time has passed;
- the answer it replaces is the standing one. Otherwise somebody else answered first, and
  nothing is written over them (`conflict`). The same answer again is a double tap: one row;
- an operator has not already settled the standing answer (`settled`).

It changes no lead, run or queue. The page reloads and the status is read off the log again.

**Changing an answer.** An owner's own answer from the last 24 hours that nobody has settled
is listed under "you answered" with a "change my answer" button. The new answer names the
old one, and both stay on the record. After a day it is on the jobs screen and changing it
is a conversation.

**What counts as asking.** Showing the question to a signed-in member of the client is the
asking. The page posts `outcome-asked` and `markAsked` writes `lead_outcome_requested` once
per lead, only when all of these hold: pilot terms are on record, the visit time has passed,
nobody has answered. So the dispute window cannot open before there are terms to open it
under, and the screen prints the date the job counts by itself.

**The owner sees their dispute** on the jobs screen: the status, the reason they gave and,
once settled, which way it went.

**The operator sees it per client.** The console's client page has a proof ledger panel
(`LedgerPanel.jsx`) drawn from the same dashboard object the client sees: what counts, what
is disputed, what is waiting on the owner, the month's count and fee. From it an operator
settles a dispute (a rejection needs a note), records an answer the owner gave some other
way (marked as the operator's entry) and records the pilot terms.

**The pattern.** `buildLedger` counts the owner's answers about good leads (every earlier
link held and the visit had passed) by how each dispute ended: open, accepted, rejected,
late. `disputePattern` flags a client when at least three were disputed and they are half or
more of the answers. It is a prompt for a conversation. It is not an input to the rule and
changes no status.

**Answering by replying to a text: considered, not built.** ARC cannot send to an owner yet
(real telephony is `ARC-GO-330`). When it can, the text is the asking
(`asked_via: 'sms'`), the reply is read by fixed rules, never a model (`1` happened, `2`
quoted, `3` did not happen), and it lands through the same `recordOutcome` with the same
idempotency key. A reply that is not one of those is not an answer: the question stays open
and the owner is pointed at the screen. Reasons with a second choice stay on the screen.

## 10. What is not built

- **No text or email asks the owner.** A question is asked when they open the screen. An
  owner who never signs in is never asked, so their jobs are never billed by silence.
- **No customer-made booking** writes `booked_by: customer` yet.
- **The window in hand is 61 days.** A statement for an older month would need a wider read.
- **A dispute is settled per client.** There is no list of open disputes across clients.
- **Not deployed.** `ledger` is a new function, and `ingest`, `ops` and `twilio` must be
  redeployed before the `ARC-MK-210` types are accepted or written. Until then a
  signed-in owner's first tap is answered with "not switched on for your account yet" and the
  mailbox, and nothing is recorded.

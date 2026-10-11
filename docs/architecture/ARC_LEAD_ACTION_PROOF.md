# Lead action proof (`ARC-SAAS-040`)

The owner Jobs card expands to a time-ordered history for that lead. Each line comes from
an append-only `events` row and carries the row ID and actual `occurred_at`. It shows no
customer message body or phone number. A retry uses the effect's stable event key, so one
accepted effect is one line. Canary rows never appear.

The job's `counts` verdict and fee remain derived by `lib/ledger.js`; the action history
does not create a second billing rule. The owner sees only the currently loaded event
window. Older events remain in Postgres and the event contract.

| Roadmap action | Evidence now |
|---|---|
| Lead received, missed call detected, form submitted | `lead_received`, `call_missed`; a form is `lead_received` with `source: web_form` |
| First response, follow-up, acknowledgements | `sms_sent` with `payload.purpose`; provider acceptance is not carrier delivery |
| Message delivered or failed | `message_delivered`, `message_failed` from the callback |
| Customer replied; qualification assessed | `reply_received`, then `lead_qualified` for the classifier's reading |
| Owner alerted | `owner_alerted`, one per accepted staff SMS, without the destination or body |
| Handoff requested or accepted | `handoff_requested`; `handoff_accepted` only on human takeover |
| Follow-up stopped | `followup_stopped` only when a queued follow-up is cancelled |
| Opt-out; unsafe or unclear lead | `lead_suppressed`; `handoff_requested` with a reason and safety flag |
| Booking and owner outcome | `lead_booked`, `lead_outcome_recorded` |
| Dispute and its settlement | `lead_outcome_recorded` with `not_counted`, `lead_dispute_settled` |
| Billable status | Derived from the existing six-link rule, not written as a new event |

The launch engine does not ask a scripted qualification question or receive a distinct
answer to one, compute a lead score,
send a standalone booking link, or identify a booking request from free text. Those four
roadmap actions have no honest event writer yet. Adding the action requires its own
reviewed template or deterministic detection rule and an event at the actual effect or
input boundary; writing a placeholder event would falsely claim that it happened.

All internal writers use `store.emit` and `event-validation.ts`. External workflows use
`/ingest`, which applies the same validation and idempotent event writer. No migration is
needed for a new event type because `event_type` is validated at the boundary, not by a
database enum.

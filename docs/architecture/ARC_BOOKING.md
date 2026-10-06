# ARC Booking: Scheduling, Availability, Appointments

Status: built and tested (`ARC-380`). Migration `0027_crm_booking.sql`, the `native-booking`
edge function, and the booking actions on `crm` and `ops`. See "Before it is live" for what a
deployment needs.

## What it is

A lead becomes a time on a day, without another booking product.

- A **hosted booking page** at `/book/<key>`, or the same page framed on the business's own
  site. A customer chooses what the appointment is for, a time that is free, and leaves their
  details. They are given their own link to move or cancel it.
- **Booking from a lead** in the workspace: a person picks a type and a free time for a
  customer already on file.
- A **bookings view** in the lead inbox (`CrmBooking.jsx`): what is waiting for an answer, the
  week, and — for the account owner or an operator — the setup.

It is drawn in the same three places as the rest of the workspace (a client's dashboard through
`crm`, the console through `ops`, the demo over generated rows) and runs the same action table
(`_shared/crm/actions.ts`).

## What it is not

- **Not evidence.** Nothing here writes `events`, and no figure reads these tables. A confirmed
  or completed appointment is a calendar entry a person set. It is not a proven job.
- **Not dispatch.** No routes, crews, technician schedules, time tracking, inventory, estimates,
  invoices or job costing. `capacity` is a number and `assigned_user_id` is a name.
- **Not a message.** Nothing here tells the customer anything. Confirming, moving or cancelling
  an appointment changes the calendar; saying so to the customer is a message, and messages are
  ARC-370's, behind its own gate. Every button on the screen says so before it is pressed.
- **Not a reminder system.** No reminder, confirmation text or follow-up is queued. That is
  Lead Recovery's (`ARC-LR-420`, `ARC-LR-430`).
- **Not a calendar connector.** The contract an external calendar reports through exists and
  is tested; no adapter calls it yet (`google_calendar` is registered with no adapter).

## The model (0027)

| Table | Holds |
| --- | --- |
| `crm_booking_settings` | One row per client: which hours bookings follow, the step between offered times, notice, how far ahead, buffers, capacity, what a customer may change from their link. No row means the defaults. |
| `crm_appointment_types` | What can be booked: a name, a length, its own buffers, whether a customer's booking of it needs approval, whether it is on booking pages. |
| `crm_booking_pages` | A hosted page: an opaque public key (`arcb_` and 32 characters), a status, a version, a definition. |
| `crm_appointments` | One row per appointment. |
| `crm_appointment_links` | The SHA-256 of a customer's own link. No browser role reads this table. |
| `crm_appointment_events` | Append-only: requested, confirmed, declined, rescheduled (from, to), cancelled, completed, no-show, assigned, and what an external calendar reported. |

0027 also adds `appointment` to ARC-340's kinds of record (`crm_source_policies`,
`crm_external_mappings`) and seven `appointment_*` entries to the timeline's vocabulary, so a
lead's history says an appointment was made, moved or called off.

### Statuses

`requested` and `confirmed` hold their time. `declined`, `cancelled`, `completed` and `no_show`
have let it go and are final for a person.

```
requested → confirmed | declined | cancelled
confirmed → cancelled | completed | no_show
confirmed → requested      only together with a new time: a customer moved an appointment
                           that needs approval
```

`APPOINTMENT_TRANSITIONS` (`booking/model.ts`) is that list. The guard in 0027 enforces it, and
a test holds the two to each other. `completed` and `no_show` are refused before the
appointment has started.

**Requested vs confirmed.** A customer's booking of a type with `requires_approval` is
`requested`: the time is held, and a person confirms or declines it. A type without it is
`confirmed` at once. A person booking from the workspace books `confirmed`.

## Which times are offered

Three things decide it, and each has one home.

| | Where | |
| --- | --- | --- |
| The rules | `availableSlots` (`booking/model.ts`), and again in `crm_booking_check_time` (0027) | Inside one open period of one open day **in the business's own timezone**; on the step grid; far enough ahead (`min_lead_minutes`); not too far (`max_days_ahead`); not on a closed date. |
| The calendar | offered from a read of the held appointments; **decided** by the appointment's own guard | Nobody else holds the time. |
| Whose calendar it is | ARC-340's policy for `appointment` | See below. |

- **Hours** are the business profile's opening hours, or hours kept only for bookings
  (`hours_source`). No hours means nothing is offered, and the screen says so.
- **Timezone** is the tenant's. Nine is nine on both sides of a clock change. A wall-clock time
  that does not exist (the hour a spring-forward skips) is not offered; one that happens twice
  is offered once.
- **Buffers.** An appointment stores its time and its time-with-buffers. Each one's buffer is
  kept clear of the other's actual time, so the gap between two is the larger of the two
  buffers, not their sum.
- **Capacity** is how many appointments may overlap. One crew is 1.
- **Service area**, when the client switches it on: a hosted booking with an address outside the
  business's ZIPs, cities or states is refused. An address that cannot be checked (none given, no
  areas, or only county and radius areas) is never turned away.

A person in the workspace may book outside the hours or the notice on purpose
(`outside_rules`). Nobody may book on top of another appointment.

## Conflict protection

The check is in `crm_appointments_guard`, behind one advisory lock per client
(`crm_booking_lock`). It runs whenever a row takes or moves a held time, whichever path wrote
it: the hosted page, a person, a reschedule, a reconciliation, or a plain insert. Two people
choosing the same time at once are one booking and one refusal (`slot_taken`), and the page that
lost says "that time is no longer available" and reads the times again.

A retried request is the same booking: a booking page makes a submission id when it renders,
and `crm_book_appointment` returns the appointment that id already made.

## The hosted page

`/book/<key>` (`PublicBooking.jsx`). The page knows only its key. It reads the published page
and its free times from `native-booking` and posts the booking back.

A stranger's booking goes through ARC-350's own `crm_intake_arrival`, inside the same
transaction as the appointment: the source record, the customer (found by phone or email, or
made), the lead (or the open lead that person already has), and the consent rows. An existing
customer is never edited. The lead's source is `web_form`; which page it came through is on
the source record (`detail.booking_page`) and on the appointment (`booking_page_id`).

What protects the public door, in order:

1. **The key.** An unknown, draft or archived one is one 404.
2. **The origin.** Anything that writes is accepted only from ARC's own site (`ARC_SITE_URL`,
   plus `ARC_FORM_ORIGINS`). No origin configured means refuse.
3. **Rate limits.** Per address and per page in the function instance; per page per hour in the
   database (`hourly_cap`).
4. **Honeypot and dwell time.** Silent: answered like a real booking, with a link that opens
   nothing.
5. **Validation.** `parseSubmission`, against the page's own definition.
6. **The calendar.** 0027's guard.

A stranger is told the time they now have, whether the business still has to confirm it, and
their own link. Never the lead, the customer record, or whether they were already on file.

A booking page is validated data with a closed list of keys (`parsePageDefinition`): a title, a
line under it, whether to ask for an address, whether to offer a notes box, which types it
offers, and the consent wording. It cannot hold a condition, a script or markup. The embed is
an `<iframe>` around the page; no script runs on the business's site.

### A customer's own link

`/book/<key>/manage#<token>`. The token (`arcm_` and 40 characters) is shown once, on the page
that made the booking. Only its hash is kept. It rides in the address's fragment, which a
browser does not send to a server, and goes to the function in a request body.

From it a customer can move or cancel their appointment while it still holds its time, if the
client allows it (`customer_may_reschedule`, `customer_may_cancel`) and it is not closer than
`customer_change_cutoff_minutes`. Otherwise the page says to call. Moving an appointment that
needs approval makes it `requested` again. The link keeps working after the page that made the
booking is archived.

## Whose calendar it is

`crm_source_policies` with `object_type = 'appointment'`, set by an operator with the existing
`crm-policy-set`. No row means ARC keeps the calendar.

Where the client's own calendar owns the time (`external`, or `hybrid` with `starts_at` theirs):

- **ARC offers no times.** It does not know what is free there, and saying so would be
  inventing availability. The booking page asks for a preferred time and says it is a request.
- A booking from the page is `requested` with `sync_state = 'pending'`.
- **Nobody on ARC's side books, confirms, moves or cancels.** `writeDecision` refuses it in the
  service and 0027 refuses it again. Who has the appointment in ARC can still be set.
- A client on ARC Native cannot be given an external calendar (0023's route guard).

### What their calendar reports

`reportExternalAppointment` (service) → `crm_appointment_external_report` (0027). The actor is
the connector (`external`); which system it is comes from the connection, never the payload.

| Outcome | Meaning |
| --- | --- |
| `created` | Their calendar is the authority and this entry is new to ARC. |
| `applied` | ARC's copy now says what theirs says. |
| `unchanged` | It already did. |
| `stale` | An older observation than one already applied. Nothing is written. |
| `conflict` | It disagrees with a field ARC owns. **Not applied.** |

A conflict freezes the appointment (`sync_state = 'conflict'`): no move and no change of status
until the account owner or an operator settles it (`crm-appointment-reconcile`).

- `keep_ours`: ARC's record stands, and reads as waiting on their calendar.
- `accept_theirs`: what their calendar reported is applied, as that person's decision. It is
  still refused if another appointment holds that time.

Nothing is merged and nothing is "latest wins". There is no action a signed-in person can use
to report on a calendar's behalf.

## Who may do what

ARC-340's `can`, checked again in SQL.

| | Operator | Client owner | Client staff |
| --- | --- | --- | --- |
| Read the calendar | yes | own client | own client |
| Book, confirm, decline, move, cancel, close, hand over | yes | yes | yes |
| Rules, appointment types, booking pages | yes | yes | no |
| Settle a disagreement with their calendar | yes | yes | no |
| Say whose calendar it is | yes | no | no |

## The inbox

The workspace read includes the appointments still holding a time. `inbox.ts` reads a lead's
next one as a next step (the lead is no longer "no next step"), and a `requested` one as
something to answer (the lead needs attention). Neither is stored.

A contact merge (`crm_merge_contacts`) moves the loser's appointments to the winner in the same
transaction.

## Code

- `supabase/migrations/0027_crm_booking.sql`
- `supabase/functions/_shared/booking/model.ts` — vocabularies, availability, parsers, what may
  happen next. Portal-safe.
- `supabase/functions/_shared/booking/service.ts` — every operation.
- `supabase/functions/_shared/booking/public.ts` — the public routes as a plain function.
- `supabase/functions/_shared/booking/supabase-booking-store.ts` — the store.
- `supabase/functions/native-booking/index.ts` — the Deno wrapper.
- `supabase/functions/_shared/crm/actions.ts` — the `crm-booking*` and `crm-appointment-*` actions.
- `src/portal/components/CrmBooking.jsx` — the bookings view, an appointment, booking from a record.
- `src/portal/pages/PublicBooking.jsx` — the hosted page and a customer's own link.

## Tests

- `tests/booking.test.js` — the model and the rendered screens, with no database.
- `tests/booking-db.test.js` — 0027 applied to real Postgres (PGlite): the public handler, the
  service and the action table over it. Skipped, and reported as skipped, without PGlite.

## Before it is live

1. Apply `0027_crm_booking.sql` (after `0026`).
2. Redeploy `ops` and `crm`.
3. `supabase functions deploy native-booking --no-verify-jwt`.
4. `native-booking` reads the same `ARC_SITE_URL` / `ARC_FORM_ORIGINS` secrets as
   `native-intake`. With neither set it refuses every booking.
5. For a test client: set opening hours on the business profile, add an appointment type, make
   and publish a booking page, book from the hosted page, and check the appointment, the lead,
   the source record and the customer's link.

## Not built here

- A calendar adapter. `google_calendar` has no adapter, so no report arrives and nothing is
  pushed to an external calendar.
- Telling the customer. No confirmation, reminder or cancellation message is sent.
- Resources. One calendar per client: no per-person or per-crew calendars, and `capacity` does
  not know who is free.
- A location's own timezone. Every time is in the tenant's.
- Recurring appointments, waitlists, deposits and payments.

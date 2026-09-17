# The event contract

What an automation has to POST to `/functions/v1/ingest` for each portal module
to work. This is the whole integration surface — there is no other write path
into the portal, and nothing else needs to be built for a module to light up.

`validate.ts` in this directory enforces everything below. If a field is not
listed here, it is not read; if a value is not in a list here, it is a `400`
with the reason in the body.

---

## The envelope

```jsonc
POST /functions/v1/ingest
Authorization: Bearer <the tenant's ingest token>
Content-Type: application/json

{
  "event_type":   "estimate_created",     // required, from the lists below
  "occurred_at":  "2026-09-17T14:02:11Z", // required, ISO 8601, when it REALLY happened
  "status":       "success",              // "success" | "failure", default "success"

  "event_key":    "wf_estimates-run-8841",// strongly recommended — see Idempotency
  "correlation_id": null,                 // UUID. threads one LEAD's pipeline only
  "workflow_id":  "wf_estimate_recovery_v2",
  "execution_id": "exec_774120",
  "latency_ms":   840,

  "entity_type":  "estimate",             // lead|estimate|job|review|membership|install|task
  "entity_id":    "EST-10422",            // the record's id in YOUR system
  "source_system":"jobber",               // gohighlevel|jobber|housecall_pro|servicetitan|twilio|n8n|manual|other
  "external_id":  "EST-10422",
  "actor":        "automation",           // automation|human|system — default "automation"
  "error_class":  null,                   // auth|delivery|schema|rate_limit|timeout|upstream|config|unknown

  "payload":      { }                     // per-module, below. max 16KB, strings max 512 chars
}
```

Batches: `{"events": [ ... ]}`, max 200 per request.

### Five rules that are not negotiable

1. **`occurred_at` is when it really happened.** Never `now()`. A retry replaying
   an hour-old event must land on its true timestamp or every timeline lies.
2. **`entity_id` is what groups a record.** An estimate's five events must all
   carry the same one. Without it they cannot be folded into a row.
   `correlation_id` is *not* a substitute — that threads one lead's pipeline over
   minutes; a record lives for weeks and one lead can produce several.
3. **`entity_type` without `entity_id` is rejected.** Such an event could never
   be shown anywhere, and failing loudly beats writing a row nothing reads.
4. **`actor: "human"` is a claim.** Default it and you are saying an automation
   did it. The reviews module treats "a person approved this" as something that
   had to be asserted.
5. **Never send a credential, an access token or a raw secret in `payload`.**
   The portal scrubs credential-shaped keys before rendering, but that is the
   second line, not permission.

### Idempotency

Set `event_key` to something stable and unique per logical event — workflow id +
execution id + step is ideal. Rows with one go through
`ON CONFLICT (tenant_id, event_key) DO NOTHING`, so n8n's retry-on-failure and a
replayed webhook are both absorbed without double-counting. Rows without one are
inserted as-is and **will** duplicate on retry.

The response is `202 {accepted, written, duplicates}`. `duplicates > 0` is
success, not a problem.

---

## Lead capture

Already running for every client. The five original events are unchanged.

| event | when | key payload |
|---|---|---|
| `call_missed` | a call rang out | `from`, `caller`, `ring_seconds` |
| `lead_received` | a lead arrived | `source` (`missed_call`/`web_form`/`gbp_message`), `caller`, `phone`, `loss_type` |
| `sms_sent` | the text-back left | `to`, `body`; set `latency_ms` to the ms from lead to send, `status: "failure"` + `error_class` if the carrier rejected it |
| `routed` | pushed to a person | `tech`, `acknowledged_at` (ISO, once they accept), `queue` |
| `reply_received` | the customer replied | `from`, `body` |

All five share one `correlation_id` per lead.

### `lead_qualified` — the qualifier's verdict

```jsonc
"payload": {
  "outcome": "qualified",        // qualified | out_of_area | no_capacity | not_a_fit
  "job_type": "water — burst supply line",
  "zip": "43231",
  "in_service_area": true,
  "property_type": "single family",
  "customer_status": "new customer",
  "urgency": "emergency",        // emergency | same day | this week | scheduling
  "scope": "basement, approx 600 sq ft",
  "capacity_ok": true,
  "preferred_time": "as soon as possible",
  "consent": { "sms": true, "email": false },
  "source_attribution": "google_lsa",
  "safety_flags": ["gas"]        // see below
}
```

Carry the lead's `correlation_id`.

### `handoff_requested` — automation stopped, a person took it

```jsonc
"payload": { "reason": "gas concern — on-call notified directly",
             "assigned_to": "marcus whitfield",
             "resolved_at": null }
```

**This is required, not optional.** A lead carrying any `safety_flags` value, or
`urgency: "emergency"`, and no `handoff_requested` against its `correlation_id`
is counted as a **safety breach** and shown to the client as one.

Recognised flags: `electrical`, `gas`, `fire`, `smoke`, `flood_safety`,
`medical`, `distressed`, `complaint`, `ambiguous_scope`, `human_only`. Anything
else is ignored rather than trusted.

---

## Estimate recovery

One `entity_id` per estimate, on all five.

| event | payload |
|---|---|
| `estimate_created` | `customer`, `phone`, `work_type`, **`amount_cents`** (integer cents), `estimate_date`, `crm_status`, `assigned_to`, `consent: {sms,email}`, `duplicate_of` |
| `estimate_followup_sent` | `stage`, `channel`. `status: "failure"` + `error_class` if it did not leave |
| `estimate_reply_received` | `classification`, `body` |
| `estimate_decision` | `decision`, **`amount_cents`**, `gross_margin_pct` *or* `gross_profit_cents` |
| `estimate_suppressed` | `reason`, `by`; set `actor: "human"` when your team did it |

`classification`: `interested` · `question` · `objection` · `declined` ·
`deferred` · `wrong_contact` · `opt_out`.
`decision`: `approved` · `declined` · `deferred`.
`reason`: `already_approved` · `declined` · `duplicate` · `disputed` ·
`sensitive` · `no_consent` · `opted_out` · `cannot_fulfil` · `client_rule` ·
`paused_by_staff` · `closed_by_staff`. Any other reason is shown to the client
as an exclusion nobody can explain.

**Stop on reply.** Once `estimate_reply_received` exists, no further
`estimate_followup_sent` may be emitted for that estimate. The portal counts
every one that is and shows it as a broken promise.

**To make revenue attributable**, all four must be present: `estimate_created`
with `amount_cents`; at least one `estimate_followup_sent` that did **not**
fail; an `estimate_decision` of `approved` whose `occurred_at` is **after** that
follow-up; and `amount_cents` on the decision. Miss any one and the estimate is
reported as approved and explicitly *not* recovered. Gross profit additionally
needs `gross_margin_pct` or `gross_profit_cents`.

---

## Reviews & service recovery

One `entity_id` per completed job — the review and any recovery case hang off
the same one.

| event | payload |
|---|---|
| `job_completed` | `customer`, `phone`, `email`, `work_type`, `tech`, `completed_at`, `review_request_skipped` |
| `review_request_sent` | `channel`. `status: "failure"` if undelivered |
| `review_received` | `rating` (1–5), `platform`, `text`, `draft_response` |
| `review_response_published` | `by`; **set `actor: "human"`** when a person approved it |
| `service_recovery_opened` | `reason`, `priority`, `assigned_to` |
| `service_recovery_resolved` | `resolution` |

**Do not gate.** Send a request for every eligible completed customer. The only
acceptable values for `review_request_skipped` are mechanical:
`opted_out` · `no_consent` · `duplicate` · `wrong_contact` · `no_contact` ·
`client_rule`. Anything expressing an expectation about sentiment —
`low_rating`, `unhappy`, `negative_sentiment`, `bad_review_risk`, `detractor`,
`sentiment`, `poor_survey` — is detected, counted as a compliance breach, shown
on the row and put in the client's queue. Review gating violates every major
platform's terms and the client carries the risk of it.

A response on a rating of 3 or below, or on a job with an open recovery case,
published with `actor` anything but `human` is counted as an auto-published
sensitive response. Put those through a person.

---

## Memberships

One `entity_id` per membership.

| event | payload |
|---|---|
| `membership_recorded` | `customer`, `plan`, `price_cents`, `renewal_date`, `status`, `assigned_to` |
| `membership_payment_failed` | `attempt`, `amount_cents`, **`provider_retry_state`** |
| `membership_payment_recovered` | **`recovered_by`**, `amount_cents` |
| `membership_visit_due` | `due_date`, `visit_type` |
| `membership_visit_booked` | `appointment_at` |
| `membership_cancellation_requested` | `reason`, `resolved_at` |

`provider_retry_state` is the field this module turns on: `scheduled` /
`retrying` means the billing provider is still working and Arc leaves it alone;
`exhausted` / `none` means it has given up and a person is needed.

`recovered_by`: `provider` (their own retry — counted, not claimed), `arc`, or
`staff`. Send `amount_cents` or no retained-revenue figure can be shown.

`membership_recorded` is a snapshot; the newest one per membership wins. Emit it
when a membership first appears or changes, not on every nightly sync — a
hundred identical rows a day buries a week of real events.

---

## Install & warranty

One `entity_id` per installation.

| event | payload |
|---|---|
| `install_completed` | `customer`, `job`, `installed_at`, `address`, `jurisdiction`, `tech` |
| `install_closeout_updated` | merged oldest-first; newest value of each field wins |
| `warranty_registration_submitted` | — |
| `warranty_registration_verified` | **`confirmation_number`** and **`certificate_url`** (or `proof_ref`) |
| `warranty_registration_blocked` | `reason` |

`install_closeout_updated` fields: `manufacturer`, `category`, `model_number`,
`serial_number`, `photos[]`, `registration_required` (bool),
`registration_deadline` (ISO date), `packet_sent` (bool),
`maintenance_scheduled_at` or `maintenance_not_required`, `responsible`.

**A registration is not complete because a workflow finished.**
`warranty_registration_verified` without a non-blank `confirmation_number` *and*
a non-blank `certificate_url`/`proof_ref` does not advance the record — it stays
at `submitted` with the gap named, and is counted. When the compressor fails in
year four, the difference between "our system said it was done" and "here is the
confirmation number" is a warranty claim the contractor wins or pays for.

---

## Human tasks — anything the rules cannot infer

The queue is derived from record state, so most work needs no task event. Use
these only for something the log does not show.

```jsonc
{ "event_type": "task_opened",
  "entity_type": "task", "entity_id": "adjuster-call-8841",
  "payload": { "module": "estimates", "customer": "greg vasquez",
               "reason": "call the adjuster before Friday",
               "priority": "urgent",            // urgent | high | normal
               "due_at": "2026-09-19T16:00:00Z",
               "assigned_to": "priya raghunathan",
               "link": "estimates?record=EST-10422" } }
```

`task_resolved` with the same `entity_id` removes it.

---

## Verification — what lets a module say "working"

A module producing events with nothing checking it reads **not verified** in the
portal, deliberately. A green workflow execution means the workflow did not
throw; it does not mean anything reached a customer. To earn "working", send at
least one of these, scoped with `payload.module`:

| event | proves |
|---|---|
| `canary_check` | a synthetic job went through the live pipeline and came out. Set `is_canary: true` |
| `schema_assert` | the fields we read are still the fields arriving |
| `watermark_check` | volume has not silently collapsed |

`payload: { "module": "estimates", "reason": "<why it failed>" }`. A check with
no `module` is treated as lead capture's, which is what the hourly canary has
always traversed.

**Synthetic canary events must never create a real CRM contact, message a real
customer, or page a real technician.** Always set `is_canary: true` so they can
never reach a client-facing count.

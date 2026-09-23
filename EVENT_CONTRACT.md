# The Arc event contract

Everything the Arc portal claims is derived from one append-only table. This
document is the contract that table is written under: what an event is, what
every field means, which types exist, and which promises the pipeline keeps on
both sides of the boundary.

Companion to [CLAUDE.md](CLAUDE.md) (orientation),
[PORTAL_CONTEXT.md](PORTAL_CONTEXT.md) (what exists now) and
[CHANGELOG.md](CHANGELOG.md) (why each piece arrived). Where this file and the
code disagree, the code is right and this file is a bug — the two places that
actually enforce it are
[`supabase/functions/_shared/event-validation.ts`](supabase/functions/_shared/event-validation.ts)
and [`src/portal/lib/types.js`](src/portal/lib/types.js).

---

## 1. The one rule

**Operational tables describe what must happen next. `events` records what
happened.** Nothing reads `events` to make a decision, and nothing reads an
operational table to produce a figure.

That split is why the ops console and a client's dashboard cannot disagree:
there is one derivation chain
(`event-row.js → metrics.js → derive.js → lifecycle.js → dashboard-data.js`)
and every surface runs it over the same rows.

Before migration 0010 there were no operational tables at all, because every
module *observed* somebody else's system. Lead Recovery is the first module Arc
*runs*, so it has state of its own — `leads`, `automation_runs`,
`scheduled_actions` and the rest. None of them is read by any figure on any
page.

---

## 2. An event

| field | required | meaning |
|---|---|---|
| `event_type` | yes | one of the values in §3. Validated at the boundary, not by a DB constraint — a new automation needs a deploy, not a migration. |
| `occurred_at` | yes | when it **really** happened, ISO 8601. **Never defaulted to `now()`.** A retry replaying an hour-old event must land on its true time or every timeline lies. |
| `status` | no (`success`) | `success │ failure`. |
| `correlation_id` | no | UUID. Threads one lead's pipeline over minutes. |
| `workflow_id` | no | which automation wrote it. `arc_lead_recovery` is the engine itself. |
| `execution_id` | no | one run of that automation. The automations page counts distinct executions, not rows. |
| `latency_ms` | no | for `sms_sent`, the time from the lead landing to the text leaving — the figure the whole product is sold on. |
| `is_canary` | no (`false`) | a synthetic record. Traverses the live pipeline and is excluded from every client-facing count. |
| `payload` | no (`{}`) | ≤ 16 384 bytes, strings ≤ 512 chars. |
| `event_key` | no | the idempotency key. See §4. |
| `entity_type` | no | `lead │ estimate │ job │ review │ membership │ install │ task`. |
| `entity_id` | no | free-form: whatever identifies the record in the system that owns it. |
| `source_system` | no | `gohighlevel │ jobber │ housecall_pro │ servicetitan │ twilio │ n8n │ manual │ other`. |
| `actor` | no (`automation`) | `automation │ human │ system`. |
| `error_class` | no (`unknown` on failure) | `auth │ delivery │ schema │ rate_limit │ timeout │ upstream │ config │ unknown`. |

**There is no `module` column.** A module is derived from `event_type` by one
map in `types.js`. Storing it too would be a second source of truth able to
disagree with the type beside it.

**`entity_type` without `entity_id` is a 400.** Such an event cannot be folded
into a record and would land as a row no page will ever show.

**`correlation_id` vs `entity_id`.** Correlation threads one lead's pipeline
over minutes. An entity is a record with a life measured in weeks, and one lead
can produce several of them. `buildThreads` groups by the first;
`foldByEntity` groups by the second.

---

## 3. The vocabulary

41 types, grouped by module. The grouping in `types.js` **is** the module
definition.

### lead capture (13)

The original five, plus qualification and handoff (0009), plus the six the
execution layer added (0010).

| type | what it claims |
|---|---|
| `call_missed` | a call rang out. `payload.from`, `payload.caller`. |
| `lead_received` | an opportunity exists. `payload.source` ∈ `missed_call │ web_form │ inbound_sms │ gbp_message`. |
| `sms_sent` | **handed to the provider.** `latency_ms` is the response time. Not a claim that it arrived. |
| `routed` | it reached a person or a queue. `payload.tech`, optional `payload.acknowledged_at`. |
| `reply_received` | the customer wrote back. |
| `lead_qualified` | the classifier's verdict. `payload.outcome`, `job_type`, `zip`, `in_service_area`, `urgency`, `safety_flags`, `consent`, and `classifier` metadata (provider, model, confidence, ms — never the prompt, never the key). |
| `handoff_requested` | automation stopped, a person was put in front of it. `payload.reason`, `reason_code`, `safety`. |
| `message_delivered` | **the carrier confirmed arrival.** A separate fact from `sms_sent`, arriving later by callback. |
| `message_failed` | it did not arrive. `status: failure`, `error_class`, `payload.provider_code`. |
| `lead_booked` | it turned into work. The only conversion claim in the product, and `actor: human` always — never inferred from an enthusiastic reply. |
| `lead_suppressed` | this contact must not be messaged again. `payload.reason` ∈ `opt_out │ wrong_contact │ …`. |
| `automation_completed` | the run reached a terminal state cleanly. `payload.stop_reason`. With `payload.started: false` and `stop_reason: not_permitted`, no run began at all: the tenant had no valid configuration to pin one to. |
| `automation_failed` | the run exhausted its retries or hit a permanent error. `status: failure`. |

### estimate recovery (5)
`estimate_created`, `estimate_followup_sent`, `estimate_reply_received`,
`estimate_decision`, `estimate_suppressed`.

### reviews & service recovery (6)
`job_completed`, `review_request_sent`, `review_received`,
`review_response_published`, `service_recovery_opened`,
`service_recovery_resolved`.

### memberships (6)
`membership_recorded`, `membership_payment_failed`,
`membership_payment_recovered`, `membership_visit_due`,
`membership_visit_booked`, `membership_cancellation_requested`.

### install & warranty (5)
`install_completed`, `install_closeout_updated`,
`warranty_registration_submitted`, `warranty_registration_verified`,
`warranty_registration_blocked`.

### cross-cutting (2)
`task_opened`, `task_resolved` — the escape hatch for something no rule could
infer. May name their module in `payload.module`.

### verification (4)
`canary_expectation`, `canary_check`, `watermark_check`, `schema_assert`.
**Never in a client-facing feed.** These are how a module earns the word
`healthy` — a module producing events with nothing checking it reads
`unverified`, not `healthy`.

### Three lists, three jobs

- **`CLIENT_VISIBLE_EVENT_TYPES`** — still exactly the original five. It gates
  `buildThreads`, which produces the rows of the leads table. **Deliberately
  not widened by 0009 or 0010**: adding the estimate types would put a
  half-drawn "lead" in that table for every quote in the CRM, and adding
  `message_delivered` would add a row for a delivery receipt. The modules thread
  their own records by `entity_id`; the execution layer's events fold onto the
  thread they already belong to.
- **`CLIENT_FACING_EVENT_TYPES`** — every business event across every module.
  The activity feed's filter set. The verification types are its complement.
- **`VERIFICATION_EVENT_TYPES`** — the four above.

---

## 4. Idempotency

`event_key` + the unique index `events_tenant_event_key_uniq (tenant_id,
event_key)` + `ON CONFLICT … DO NOTHING`. n8n retries on transient failure and
Twilio redelivers anything it did not get a 2xx for, so the same event arriving
twice is routine rather than exceptional.

Rows **with** a key go through an upsert that ignores duplicates. Rows
**without** one cannot be deduplicated and are plain-inserted.

Internal events derive their key from what the event is *about*, never from
randomness, so a redelivered callback collides:

```
lr:call_missed:<correlation_id>
lr:sms:<action idempotency key>:<attempt>
lr:delivered:<provider message id>
lr:run_end:<run id>:<stop reason>
```

This depends on **migration 0002**: the partial index from 0001 is not usable
as an `ON CONFLICT` target from PostgREST and every upsert fails against it.

---

## 5. Two writers, one door

```
n8n / any external adapter ──► POST /functions/v1/ingest ──┐
                                                            ├─► validateEvent()
Arc's own functions (twilio, lead-intake, dispatch) ────────┘        │
                                                                     ▼
                                                        writeEvents() → events
```

`/ingest` remains the **only external** ingestion endpoint. Arc's own functions
do not post to it over HTTP — they call the same validator and the same writer
in-process, from
[`_shared/event-validation.ts`](supabase/functions/_shared/event-validation.ts)
and [`_shared/event-writer.ts`](supabase/functions/_shared/event-writer.ts).

The implementation moved there from `ingest/validate.ts` in 0010;
`ingest/validate.ts` re-exports it so the boundary keeps its documented name.

An internally emitted event that fails validation is a **bug in Arc**, logged
loudly. It is not silently corrected. `tests/lead-recovery.test.js` asserts the
engine emits no invalid event across a full lead lifecycle.

### Authentication per endpoint

| endpoint | who may call it | how it is authenticated |
|---|---|---|
| `ingest` | an external adapter | per-tenant bearer token, SHA-256 hashed at rest |
| `twilio/*` | Twilio only | `X-Twilio-Signature`, HMAC-SHA1 over the configured public URL |
| `lead-intake` | a member of the public on a client's website | opaque intake key + origin allowlist + honeypot + rate limit |
| `dispatch` | the scheduler, or an operator | `x-arc-dispatch-key` (constant-time), or a JWT checked against `arc_admins` |
| `ops` | an operator | JWT → `is_arc_admin()` |
| `client-login` | a signed-out client | none; rate-limited per IP |

---

## 6. What must never appear in an event

- **Credentials.** Not masked, not truncated, not behind a disclosure. The
  activity feed's `safeMeta()` strips anything credential-shaped from a payload
  before it reaches a browser, and the config validator refuses anything
  credential-shaped before it reaches the database.
- **The classifier's prompt or key.** A `lead_qualified` event carries provider,
  model, confidence and latency. Nothing else about the call.
- **More customer contact detail than the claim needs.** The record tables carry
  phone and email where they belong; a staff alert carries the last four digits.
- **A status somebody typed.** Every figure is a count or is derived from one.
  `pipelineVerdict`, `buildProgress` and `computeStatus` are recomputed on every
  render and never persisted.

---

## 7. Adding an event type

Six places, in one change, or the type is half-added:

1. `supabase/functions/_shared/event-validation.ts` — the `EVENT_TYPES` list.
2. `src/portal/lib/types.js` — the module group it belongs to.
3. `src/portal/lib/format.js` — `eventLabel()`, so the feed reads as a sentence.
4. The derivation that consumes it (`lifecycle.js`, usually).
5. `src/portal/demo/generate.js` — so `/demo` and the smoke test exercise it.
6. This file, and `PORTAL_CONTEXT.md`.

Then redeploy `ingest` **before** anything starts sending the new type: until
then it is rejected at the door with a 400 naming it, which is the correct
failure but a loud one.

Ask first whether the type makes a claim nothing else can. `message_delivered`
earned its place because "we handed it to Twilio" and "it arrived" are
different facts. A type that restates an existing one is a second source of
truth for one fact.

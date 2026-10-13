# ARC Tenant Settings — What One Client Can Change

**Prompt:** `ARC-SAAS-020` · **Checked:** October 11, 2026, against the working tree at `1.42.1`
**Built:** one setting, the follow-up's limits. No table changed and there is no migration.

The question this answers: where does ARC keep how one client should behave, who reads it,
and which of the nineteen settings the SaaS prompt asks for exist?

---

## 1. The short answer

The settings store was already built. It is the versioned configuration from `0014`: one
document for the client and one for Lead Recovery, validated, published as numbered versions,
and never rewritten. Sixteen of the nineteen settings were in it or are fixed by the engine on
purpose.

One was missing and is now built: **whether a quiet customer gets the follow-up, and how long
after the first text.** One is not stored, and section 5 says why. One does not apply to this
product.

---

## 2. Where a setting lives

| Document | Schema | Holds |
|---|---|---|
| Tenant settings | `tenant_settings` | The business's name and timezone. Shared by every module. |
| Lead Recovery | `lead_recovery_config` | Everything else in section 4. |

Three rules the validator enforces (`_shared/lead-recovery-config.ts`):

- A key it does not know is refused by name. Configuration cannot grow a field quietly.
- No expressions, callbacks or template syntax beyond four placeholders.
- No credentials. A value shaped like a token is refused wherever it is pasted.

Only an operator can change a setting. A client reads theirs and asks for a change.

---

## 3. Who reads it

| Reader | How | What it gets |
|---|---|---|
| The engine, for a new lead | `resolveEffectiveConfig` | The two published versions composed and validated again. |
| The engine, for a lead in progress | `loadPinnedConfig` | The snapshot that lead started under. A later change never reaches it. |
| The owner's account screen | the `crm` function's `account-settings` | A field-by-field projection, every address reduced to a hint. |
| The operator's settings page | the `ops` function's `config-scope` | The whole document, its fields from the registry, and its history. |
| A runner such as n8n | a signed, one-time envelope | Only what one action needs. Lead Recovery is never dispatched to one. |

The prompt asks that n8n workflows can read tenant settings. They cannot read the store, and
that is deliberate: a workflow receives identifiers and opens an envelope ARC prepared for that
one action. Lead Recovery is registered `direct`, so none of this is in its path
(`ARC_PRODUCT_SCOPE.md`, section 5.1).

---

## 4. The nineteen settings

**Stored** means a field an operator edits. **Fixed** means the engine decides it the same way
for every client. **Not stored** means it has no home, with the reason in section 5.

| # | Setting asked for | Reads | Where | What the engine does with it |
|---|---|---|---|---|
| 1 | Business name | Stored | `company_name` | The name in every text. |
| 2 | Trade / niche | Not stored | — | Nothing reads it. See 5.1. |
| 3 | Service area | Stored | `service_area` | ZIP codes and cities. A reply's ZIP is checked against it. |
| 4 | Business hours | Stored | `business_hours`, `holidays`, `timezone` | Decides open or closed for every send. |
| 5 | Emergency hours | Fixed | — | An emergency reply alerts every contact at any hour. See 5.2. |
| 6 | Emergency keywords | Stored | `safety.emergency_keywords` | Added to the built-in word lists. They can only add caution. |
| 7 | Services offered | Stored | `services` | What a reply is matched against. |
| 8 | Services not offered | Stored, differently | `services`, `safety.always_handoff_services`, `safety.handoff_on_ambiguous_scope` | No decline list. Anything not on `services` is unclear and goes to a person. |
| 9 | Owner alert phone | Stored | `staff_alerts` | Texted on every handoff that asks for an alert. |
| 10 | Backup contact | Stored | `staff_alerts` | A second row. Every row is texted; there is no order. |
| 11 | Preferred handoff method | Fixed | — | Text only. An email recipient is refused until something sends one. |
| 12 | Booking link or instructions | Stored | `booking_url`, `templates.reply_ack`, `templates.reply_ack_booking` | The link, and the sentence the customer gets after replying. |
| 13 | First response template | Stored | `templates.first_response`, `templates.after_hours_response` | The reviewed words of the first text. A website-form lead gets `templates.first_response_form` instead where one is set; it has no default, so its absence means this one. It, this one and the follow-up's words and timing are what an owner may publish themselves (`config/owner-wording.ts`, 0034); every other setting is still an operator's. |
| 14 | Qualification questions | Stored | `questions`, `templates.question_service`, `templates.question_location`, `templates.question_urgency`, `templates.question_timing` | Which of four reviewed questions are asked after the first reply, in order, one at a time. Section 8. |
| 15 | Follow-up limits | Stored | `followup`, `templates.followup` | **New.** Section 6. |
| 16 | Quiet hours | Stored | `after_hours`, `business_hours` | The first text follows `after_hours.behaviour`. The follow-up never leaves opening hours. |
| 17 | Opt-out and stop list | Stored and fixed | `compliance.opt_out_language` | The sentence is stored. The words that stop everything and the stop list are the engine's. |
| 18 | Twilio number and forwarding status | Stored, and derived | `twilio`, `forwarding`, `compliance` | The identifiers are stored. Whether they work is the activation checklist. |
| 19 | n8n workflow status | Does not apply | — | Whether the module may act is its lifecycle. See 5.4. |

The configuration also holds one thing the prompt does not ask for: `ai`, whether a model
helps read replies.

`tests/tenant-settings.test.js` holds this table to the code: every path above exists in the
validator's defaults, every field the configuration has is placed here, and each "fixed" row is
checked against the constant that fixes it.

---

## 5. What is not a setting, and why

### 5.1 Trade

ARC does not store what trade a client is in. The missed-call count form asks a prospect, and
that is a sales note. Nothing in the engine behaves differently for a plumber and an HVAC
company: the safety word lists are the same and the templates are generic.

A stored setting that nothing reads looks like it does something. It is added when the first
thing reads it, most likely a starting set of emergency words per trade.

### 5.2 Emergency hours

The prompt implies a window in which emergencies are handled. ARC never promises emergency
service on a business's behalf. A reply that trips a safety rule goes to a person and texts
every alert contact, at any hour. What the customer is told outside opening hours is
`after_hours`.

### 5.3 Qualification questions

The first text asks one open question, and its wording is the client's template. The reply is
read against services, service area and the safety rules. Since 2026-10-13 a client can also
have up to four questions asked in turn (section 8). What is still not a setting is a question
of the client's own invention: the list is closed, because each question is a reviewed
template and three of them are answered by a fact the reply is already read for. A key such as
`qualification_questions` is refused.

### 5.4 n8n workflow status

There is no workflow per client and none for Lead Recovery. The status that matters is the
module lifecycle (`tenant_modules`): configuring, testing, shadow, active or paused, with a
health overlay. The operator's activation page shows it.

---

## 6. The follow-up's limits

```json
"followup": { "enabled": true, "after_minutes": 60 }
```

- `enabled` — whether a customer who has not replied gets the follow-up at all.
- `after_minutes` — how long after the first text, from 15 to 1440. The follow-up still waits
  for opening hours, so this is the earliest it can go.

What is not a setting: **there is one follow-up, never two.** A key such as `count` is refused.
More than one is the follow-up engine's work (`ARC-SAAS-090`) and needs its own stop rules.

Behaviour worth knowing:

- A configuration published before this field existed means what it always meant: one
  follow-up, an hour later. Nothing has to be republished.
- With the follow-up off, none is queued. The lead still closes itself three days after the
  first text.
- A lead already in progress keeps the limits it started under. A change reaches new leads.
- Changing it is a retest: new leads wait until the module has been tested on the new version.
  It does not pause a live client.
- Turning it off prints a warning to whoever saves it.
- The owner's account screen says which it is, in a sentence.

Where: the validator and its constants in `_shared/lead-recovery-config.ts`, `followupDueAt` in
`_shared/engine/templates.ts`, the field's metadata in `registry/schemas.ts`, its layout in
`registry/layouts.ts`, the owner's sentence in `_shared/account/model.ts`.

Tests: `tests/lead-recovery-readiness.test.js` (section 5b) and two scenarios in
`tests/lead-recovery-gate.test.js`, which run on the in-memory store and on real Postgres.

---

## 7. What needs deploying

Nothing was deployed. The setting takes effect on a hosted project when its functions are next
deployed: `ops` and `crm`, which are live today, and the five Lead Recovery functions that
`ARC-GO-330` deploys for the first time.

Until `ops` is redeployed the console still works. The older settings form sends the follow-up
only when it differs from the default, so an untouched save is accepted by the older function.
A changed follow-up is refused by name until the function is current.

---

## 8. The questions

```json
"questions": { "ask": ["service", "location"], "wait_minutes": 30 }
```

- `ask` — which questions ARC asks after the customer's first reply, in this order. Drawn from
  `service`, `location`, `urgency` and `timing`, each at most once. An empty list asks none.
- `wait_minutes` — how long ARC waits for an answer before the lead goes to the business with
  what is known, from 5 to 240.

The words of each question are a template: `templates.question_service`, `question_location`,
`question_urgency` and `question_timing`. Each has a reviewed default and takes the same
placeholders as every other template. The opt-out line is appended by the engine.

What the engine does with them:

- A question is asked only of a lead ARC would otherwise have passed to the business as it
  stood. A reply that needs a person, for a safety word, an unclear job, low confidence or an
  address outside the service area, still goes to a person at once and is asked nothing.
- A question whose answer is already known is skipped: the service, the ZIP and how soon are
  read from everything the customer has written. `timing` has no fact behind it, so it is asked
  whenever it is listed, and the answer is kept in the customer's own words.
- A question is asked once. The exchange is never longer than the list.
- Every answer is read by the deterministic safety rules first, like any reply. "Right now" in
  answer to "how soon" hands the lead to a person.
- If the customer does not answer within `wait_minutes`, the lead goes to the business with
  what it has. If they write again before the question has gone, the question is dropped and
  their newer message decides what is asked.
- STOP, a takeover, a booking and a pause stop it like everything else.

What is not a setting: a question of the client's own. A fifth key is refused.

Behaviour worth knowing:

- A configuration published before this field existed asks nothing, as before.
- A lead already in progress keeps the questions it started under.
- Changing it is a retest when an operator does it. An owner may publish which questions are
  asked and their words themselves (`config/owner-wording.ts`, 0036); `wait_minutes` stays an
  operator's.

Where: the validator and its constants in `_shared/lead-recovery-config.ts`; `nextQuestion` and
`renderQuestion` in `_shared/engine/templates.ts`; the `ask_question` action in
`_shared/engine/runtime.ts`; the field's metadata in `registry/schemas.ts` and its layout in
`registry/layouts.ts`.

Tests: `tests/lead-recovery-conversation.test.js`, on the in-memory store and on real Postgres.

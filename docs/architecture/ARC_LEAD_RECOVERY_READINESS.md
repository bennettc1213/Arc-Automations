# ARC Lead Recovery — Readiness Map

**Prompt:** `ARC-GO-300` · **Checked:** October 8, 2026, against the working tree at `1.39.0`
**Kind:** read-only. Nothing in the engine, the schema or a hosted project was changed.

The question this answers: what stands between the code and a real homeowner's phone?

Each item reads one of three ways.

- **Done** — the code does it and a test named after the promise holds it.
- **Gap** — the code does not do it, or does it wrongly. These are the scope of `ARC-GO-310`.
- **Hosted check** — the code is written, and only a real Twilio account, a real handset or the
  hosted Supabase project can prove it. These belong to `ARC-GO-330`.

---

## 1. The short answer

The safety core is sound. Opt-out, send-once, the canary, the compliance gate, the pause and the
handling of a provider that does not answer are all built, and 370 tests across the six Lead
Recovery and ledger files pass.

What is missing is the ordinary path. Today a customer can be texted, can reply, and then the
loop stops being a product:

1. **No job can count.** Nothing on any screen records that a visit was booked, so the ledger's
   fifth link is never written and every lead stays short of "counts".
2. **Only the customer's first reply is read.** A second text is dropped or makes the webhook
   fail, and its words never reach the safety rules.
3. **The owner is told about some handoffs and not others,** and the link in the alert opens a
   page the owner cannot sign in to.
4. **The site says "your unanswered calls are forwarded to ARC". The engine is built the other
   way round:** the ARC number rings first and forwards to the business.

Thirteen gaps are listed in section 4, and the four decisions they depended on are made
(section 5). None needs a new engine, a per-client workflow or the CRM.

---

## 2. The map

| # | Item | Reads | In one line |
|---|---|---|---|
| 1 | Telephony path | **Gap** and hosted check | Built for an ARC number in front of the business. The setup the site promises is not supported, and a voicemail pickup reads as answered. |
| 2 | Business-text registration per client | Done, and hosted check | Nothing sends or activates unless the client's status is `approved`. The status is typed by an operator; the registration itself has never been filed. |
| 3 | Opt-out | **Done** | STOP and its plain-language forms suppress the number, cancel the queue and end the run. Checked again at the moment of sending. |
| 4 | Stop on reply | Done, with a **gap** | Any reply cancels the chasing. A bare "yes" then goes nowhere, and a second reply is not handled. |
| 5 | Human takeover | Done, with a **gap** | Taking over cancels everything and silences the run. The console offers it only on a lead that is already a handoff. |
| 6 | Safety classification | Done, with a **gap** | Rules run before any model and a model cannot clear them. They run on the first reply only. |
| 7 | Send-once | **Done** | One claim per action, one reserved effect per message, one event per send. |
| 8 | A canary that cannot reach a handset | **Done**, and hosted check | The sender is chosen from the lead's canary flag in one place. A production canary has not been run. |
| 9 | The owner's alert on a handoff | **Gap** | Sent for a safety or classifier handoff. Not sent for a failed, undeliverable or unknown send. Wrong link. Email recipients ignored. |
| 10 | How a lead is booked | **Gap** | No message after the customer replies, no booking link, and no screen that records a visit time. |
| 11 | Ambiguous provider outcomes | Done, with a **gap** | An unknown outcome is held and never resent. Nothing lets an operator settle it afterwards. |
| 12 | Deployment checklist | **Gap** and hosted check | `DEPLOYMENT.md` is wrong about when the first text is sent and stops at migration 0024. Nothing Lead Recovery needs is deployed to live. |

---

## 3. Item by item

File references are from the repository root. Line numbers are as of the date above.

### 3.1 Telephony path — gap, and hosted check

**What is built.** Four signed webhooks in `supabase/functions/twilio/index.ts`. A request with a
missing or wrong signature is refused before its body is read (`:117-132`). The tenant is found
from the number that was called and nothing else (`:146`). `voice` forwards the call to
`forwarding.destination` and asks Twilio to report how it went (`:142-173`). `dial-status` turns
`no-answer`, `busy`, `failed` or `canceled` into one lead, keyed on the call's own id, so a
redelivered webhook makes one lead (`:176-220`). An answered call makes no lead and no text, only
a count.

**Gap A — the setup the site promises is not the setup the engine supports.** The homepage says
"your unanswered calls are forwarded to arc" (`src/data/site.js:502`), and the roadmap's goal
says the same. That is the business keeping its number and its phone company sending unanswered
calls on. The engine assumes the opposite: the ARC number is the one customers dial, and it rings
the business. Point a phone company's no-answer forwarding at today's `voice` webhook and the
caller, who has already listened to the business's phone ring out, hears it ring a second time
before anything happens. The validator only refuses the case where the two numbers are identical
(`lead-recovery-config.ts:781`).

**Gap B — a voicemail pickup reads as an answered call.** `completed` is the only status treated
as answered (`_shared/twilio.ts`, `MISSED_DIAL_STATUSES`). If the owner's mobile voicemail picks
up inside the ring time, Twilio reports `completed`, no text is sent, and the call is counted as
one the business answered. There is no check on who or what answered. A ring time shorter than
the voicemail delay hides this; a phone that is switched off does not, because voicemail answers
at once.

**Gap C — the caller's network name is used as their name.** `CallerName` is passed in as the
customer's name (`twilio/index.ts:210`) and the first word of it opens the text. Where Twilio
supplies it, it is often a placeholder such as a carrier label or a town.

**A risk worth knowing.** With the ARC number in front, a client whose published configuration
stops resolving has callers told "we are unable to take your call" (`:153-156`). A paused or
unselected module still forwards, by design; an unresolvable configuration does not.

**Hosted checks.** The signature check has only met Twilio's published example. No number has
been bought, no call forwarded and no text sent. To prove on a real line: the signature over the
real URL, that the dial result carries the ARC number and the caller's number in the fields the
handler reads, that the caller hears ringing while the business phone rings, and what the caller's
number looks like when a phone company forwards a call on.

### 3.2 Business-text registration per client — done, and hosted check

**Done.** `compliance.status` must be `approved` for the first text to be decided
(`engine/templates.ts:88`), again at every send (`engine/runtime.ts:458`), and for activation
(`lead-recovery-config.ts:862`). `approved` with `brand_registered` false is refused as a
contradiction. There is no override. The provider's "campaign not registered" codes are classed
as a configuration problem and treated as permanent.

**Hosted check.** The status is what an operator typed. Nothing reads it back from the provider.
The registration has to be filed and approved for the pilot client before `ARC-GO-340`, and its
lead time is outside ARC's control.

### 3.3 Opt-out — done

- The mandated stop words and what people really type are recognised as a whole message or a
  clear sentence, so "stop by tomorrow at 3" is not an opt-out (`engine/rules.ts:199-231`).
- A stop writes the suppression, cancels every pending action and ends the run
  (`engine/runtime.ts:1027-1060`).
- The suppression list is read at intake, again before a queued action runs, and again
  immediately before the provider is called (`:746`, `:1375`, `:468`).
- A stop the carrier handled without ARC seeing a message (provider code 21610) is honoured too
  (`:1193`).
- The opt-out sentence is appended by the engine and cannot be edited out of a template
  (`engine/templates.ts:62`).
- A suppression belongs to one client.

Tests: "STOP creates a suppression and cancels everything", "the suppression is checked again at
the moment of sending", "a suppression belongs to one tenant and never leaks to another".

One gap on the operator's side: suppressing a number by hand exists in `ops`
(`lead-recovery-suppress`) and has no button. See gap 12.

### 3.4 Stop on reply — done, with a gap

**Done.** Any inbound text cancels the queued first response, the follow-up and the auto-close
before anything is classified (`engine/runtime.ts:1064-1070`). The send path asks again whether
the customer has replied, immediately before the provider call (`:452-455`). A redelivered
inbound webhook records one message.

**Gap D — a bare "yes" is a dead end.** "yes", "ok" and "thanks" are treated as acknowledgements:
the chasing stops and nothing else happens (`:1090`). The auto-close was cancelled with the
follow-up, so the run stays in `awaiting_reply` for good, nobody is told, and the lead never
closes. A customer who answers "yes" to "sorry we missed your call" has asked to be called.
Confirmed by running it: no pending actions, no alert, no handoff.

**Gap E — a second reply is not handled.** See 3.6; it is the same defect.

### 3.5 Human takeover — done, with a gap

**Done.** `takeOverLead` cancels first and changes state second (`engine/runtime.ts:2257`). A run
with a person on it is not in a sending state, so the send path refuses on the run's state and
again on the open handoff (`:418`, `:447`). An auto-close does not close a lead a person still
has. Tests: "a person taking over stops the automation", "a follow-up already on the queue is
refused after a takeover".

**Gap.** In the console the take-over button appears only on a lead that is already an open
handoff (`LeadRecoveryPanel.jsx:664`). An operator who sees an ordinary lead going wrong has no
button to stop it. See gap 12. The owner has no takeover of their own; for the pilot the owner
picks up the phone and the operator presses the button.

### 3.6 Safety classification — done, with a gap

**Done.** The deterministic rules run on the customer's words before any model, and can only add
caution (`engine/rules.ts`). A message that tries to instruct the classifier is itself a reason
to fetch a person. The model's answer is combined with the rules as an OR, a low confidence is a
handoff, and with no model key every reply goes to a person with the reason stated
(`_shared/classifier.ts`). A model never writes a customer-facing message: the four texts are
reviewed templates with a closed list of placeholders.

**Gap E — only the first reply is ever read.** The rules run inside the queued `classify_reply`
action, and a run queues that action once.

- A second text while the first is waiting to be classified is recorded and never read. Run with
  "my furnace stopped" then "there is smoke coming out of it": the lead was handed off for an
  unrelated reason and the word *smoke* was never assessed.
- A second text after the first was classified makes the webhook throw: `qualified → qualifying`
  is not a legal move (`engine/state-machine.ts`, called at `engine/runtime.ts:1094`). Twilio is
  answered 500, redelivers, and the redelivery is treated as a duplicate. Run with "actually I
  can smell gas in the basement": no safety flag, no handoff, no alert.

This is the most serious finding. A customer's second message is exactly where "actually, it's
worse than I said" arrives.

### 3.7 Send-once — done

- One worker gets an action: `claim_scheduled_actions`, `for update skip locked`, with a lease
  token that fences every later write.
- One effect per message: `reserveEffect` is a unique reservation, and only the caller that wins
  it may call the provider (`engine/runtime.ts:478-512`).
- One action per run and type: the idempotency key is the run and the action type (`:2239`).
- One `sms_sent` per message, keyed on the effect and not the attempt.

Tests: "two dispatchers cannot execute the same action", "the same message is never sent twice",
"only the worker holding the lease may change an action", and the same on real SQL in
`tests/scheduler-db.test.js` when PGlite is available.

### 3.8 A canary that cannot reach a handset — done, and hosted check

**Done.** `senderFor` is the only way to get a sender and it switches on the lead's canary flag
(`engine/runtime.ts:303`). With no canary sender configured a synthetic run refuses to send
rather than fall back. The console's canary is also given a recording sender in both slots and
Twilio's reserved test number as its customer (`ops/lead-recovery.ts:142-163`, `:91`). The claim
is limited to that client and to synthetic leads, so pressing it cannot drain anyone's real
queue. Every event a canary writes is flagged and no figure counts it.

**Hosted check.** A canary has never been run in production. `ARC-GO-330` asks for one.

### 3.9 The owner's alert on a handoff — gap

**What works.** A handoff opened by the safety rules or by the classifier texts every `sms`
recipient in `staff_alerts`, once each, with the customer's number masked. A qualified lead
routed to the contractor sends the same alert.

**Gap F — three kinds of handoff alert nobody.** `openHandoffFor` only sends when it is given the
configuration (`engine/runtime.ts:2061-2062`), and three callers do not pass it: a permanent
delivery failure reported by the provider (`:1214`), an unknown outcome or a permanent send
failure (`:1435`, `:1447`), and retries running out (`:1622`). Each asks for `notifyStaff: true`
and gets silence. These are the cases whose reason reads "this customer has not heard from
anyone". Confirmed by running both: a handoff opens, zero alerts.

**Gap G — the link is to the operator console.** The alert ends with
`/ops/console/clients/<id>` (`twilio/index.ts:94`, `dispatch/index.ts:124`,
`ops/lead-recovery.ts:158`). An owner cannot open that page. It should be the owner's needs-you
screen.

**Gap H — an email recipient is accepted and never alerted.** The validator accepts
`channel: email` (`lead-recovery-config.ts:59`), and the engine alerts `sms` recipients only
(`engine/runtime.ts:1927`). The "nobody is on staff_alerts" warning does not fire for an
email-only list. Confirmed by running it.

**Smaller.** A failed alert leaves an attempt row and nothing else: no retry, no event, nothing
on a screen.

### 3.10 How a lead is booked — gap

This is the gap that stops the product being a product.

**Gap I — the customer hears nothing after replying.** After a reply is classified and routed,
the owner is texted and the customer gets no message at all. Only a handoff sends an
acknowledgement. There is no "we've got it, here is what happens next" template, and although
`{{booking_url}}` is an allowed placeholder and the validator refuses a template that uses it
with no URL set, no default template uses it.

**Gap J — nothing records the visit.** The ledger counts a job only when `lead_booked` carries a
visit time that has passed. The engine can write that (`markBooked`,
`engine/runtime.ts:2336`), and `ops` exposes it (`lead-recovery-book`). No screen calls it:
`recordLeadOutcome` in `src/portal/lib/ops.js` is used by no component, and the owner's portal
has no "I booked this for Tuesday at 2" at all. The owner's answer screen
(`ARC-MK-220`) refuses to ask about a lead with no booked visit, correctly. So today the chain
breaks at its fifth link for every lead.

**What exists and is not connected.** The hosted booking page (`/book/<key>`, `ARC-380`) gives a
time to one booking in the CRM's tables. It writes no `events` row and does not know about Lead
Recovery's lead, deliberately. The roadmap's "hosted booking page or the owner confirming a
time" is a choice still to be made; the second is the smaller build and does not depend on the
paused CRM track.

### 3.11 Ambiguous provider outcomes — done, with a gap

**Done.** A timeout or a thrown request is recorded as unknown, never as a failure
(`_shared/twilio.ts`, `ambiguous`). The attempt is parked as `reconciliation_required`, no
`sms_sent` is written, a handoff opens and the action is not retried
(`engine/runtime.ts:1720-1754`, `:1434-1444`). A later attempt at the same message is refused
while the earlier one is unresolved (`:504-510`). An attempt left mid-send by a dead worker is
treated the same way. Tests: "an unanswered provider is not a failure and is never retried
blindly". Confirmed by running it: one provider call, none on the next pass.

**Gap K — nothing settles one.** There is no Lead Recovery action that records "I checked the
provider: it went" or "it did not". The console's retry button puts the action back, and the
reservation refuses it again for the same reason. The lead is safe and stuck; the only way out
is SQL. The owner is not alerted either (gap F).

### 3.12 Deployment checklist — gap, and hosted check

**Done.** `DEPLOYMENT.md` covers the functions, the secrets and what breaks without each, the
exact webhook URLs, the dispatcher's schedule, the eleven-step checklist, and says plainly what
has never met a real Twilio account. Activation is fail-closed against that checklist and against
a passing canary on exactly the versions being authorised.

**Gap L — the first text is not sent when the documents say.** `DEPLOYMENT.md` section 5 and the
header of `dispatch/index.ts` both say the first response "is normally sent by the webhook's own
dispatch call". Neither `twilio` nor `lead-intake` calls the dispatcher. The first text waits for
the next once-a-minute schedule. Either the webhook should run that client's due work or the
documents should say "within about a minute". It matters because the site may claim no speed
that has not been measured.

**Gap M — the guide stops at 0024.** Migrations 0025 to 0028 have no entry, and section 4 still
says the Twilio references live in `module_configs.config.twilio`, which has been frozen since
0014.

**Hosted checks.** Last known state of live: only `ops`, `crm`, `native-intake` and
`native-booking` are deployed. `twilio`, `dispatch`, `lead-intake`, `ingest` and `ledger` are
not, no Twilio secret is set, and the dispatcher's schedule does not exist. Staging is behind
live. Before any `db push`: `supabase/migrations/0029_crm_sync_quality.sql` is a half-drafted
file from the paused `ARC-395` sitting in the migrations folder, and a push would apply it.

---

## 4. The gaps — the scope of `ARC-GO-310`

In the order they should be closed. Sizes are relative.

| # | Gap | From | Size | Kind |
|---|---|---|---|---|
| 1 | Every reply is read by the safety rules, whatever the run's state; a second reply never makes the webhook fail | E | Small | Engine |
| 2 | Every handoff that says to alert the owner does | F | Small | Engine |
| 3 | The alert links to the owner's needs-you screen | G | Small | Engine |
| 4 | A bare "yes" tells the owner and leaves the lead able to close | D | Small | Engine |
| 5 | The follow-up respects the business's hours | below | Small | Engine |
| 6 | A booked visit can be recorded: by the owner on needs-you, and by an operator in the console | J | Medium | Portal, console, `ledger` function |
| 7 | The customer gets one reviewed message after replying, with the booking link where one is set | I | Medium | Template and config schema |
| 8 | The telephony setup is chosen, and the engine supports it | A | Medium | Engine and config schema |
| 9 | A voicemail pickup does not read as answered | B | Small to medium | Engine, depends on 8 |
| 10 | An unknown send can be settled by an operator | K | Small | `ops` and console |
| 11 | An alert recipient on email is alerted or refused | H | Small | Validator, or a second channel |
| 12 | The operator's minimum: stop any lead, suppress a number, book or close a lead | 3.3, 3.5 | Small | Console only; the actions exist |
| 13 | The documents match the code: first-text timing, 0025 to 0028, the caller-name greeting | L, M, C | Small | Docs, one line of engine |

**The follow-up's timing (gap 5).** `FOLLOWUP_AFTER_MINUTES` is a fixed 60
(`engine/runtime.ts:109`, queued at `:1465`). A call missed at 10:30pm with the default
out-of-hours behaviour gets its first text at once and its follow-up at 11:30pm. Confirmed by
running it. The stop conditions are all in place: a reply, a stop, a takeover, a booking, a close
and a pause each cancel it or refuse it at the send. Only the time is wrong. The engine has no
notion of quiet hours beyond the business's opening hours and the four out-of-hours behaviours.

Gaps 1 to 5 are safety and honesty. Gaps 6 to 9 follow the decisions in section 5, which are
made.

Not gaps, and not to be built: a new engine, a per-client workflow, anything that depends on the
CRM, a model writing a message, or the owner answering by text.

---

## 5. Decisions — made

Bennett approved all four recommendations on October 9, 2026. They are the brief for
`ARC-GO-310`, and nothing in section 4 waits on a decision any more.

1. **Which telephony setup does the pilot use?**
   *Decided: the business keeps its number and forwards unanswered calls to ARC,* because
   that is what the site says, it needs no number change, and "nobody answered" is true of every
   call that arrives. It costs one figure: ARC never sees the calls the business did answer, so
   "calls you answered yourself" becomes a dash with its reason. The alternative is the ARC
   number in front, which is what is built, keeps that count, and makes ARC a single point of
   failure for the business's phone.
2. **How is a visit booked?**
   *Decided: the owner confirms a time on the needs-you screen,* with the operator able to do
   the same. It is the smaller build and has no dependency on paused work. The hosted booking
   page stays available as a link in the reply.
3. **May a text go out at any hour?**
   The first text answers a call the customer just made, so sending it at once is defensible. The
   follow-up is unprompted. *Decided: the first text follows the client's out-of-hours
   setting as now; the follow-up waits for opening hours.*
4. **Is email a real alert channel for the pilot?**
   *Decided: no. Refuse it in the validator until it exists,* so nobody believes an alert is
   set up when it is not.

---

## 6. Hosted checks — for `ARC-GO-330`

Nothing below can be closed from the repository. Each is its own authorised action.

- Staging brought level with live. The paused 0029 draft moved out of the migrations folder
  first.
- `twilio`, `dispatch`, `lead-intake` and `ledger` deployed; `ingest` and `ops` redeployed so the
  five ledger event types are accepted and written.
- Secrets set: the Twilio pair, the public functions URL, the dispatch key, the site URL, and the
  model key if replies are to be classified rather than all handed to a person.
- The dispatcher's once-a-minute schedule created, and a first run seen in the logs.
- A real number bought and pointed at the three webhook URLs.
- A real inbound webhook passes the signature check.
- A call placed and left unanswered produces one lead and one text on a handset ARC owns; an
  answered call produces neither.
- A reply, a STOP, a second reply and a redelivered webhook each behave as the tests say.
- The delivery callback arrives and settles the message.
- The time from the missed call to the text, measured. Until then the site claims no speed.
- Business-text registration filed for the pilot client, and its approval recorded.
- A canary run in production.
- The check that notices a client gone silent. Alerts are raised by hand today.

---

## 7. How this was checked

- Read end to end: `supabase/functions/twilio/index.ts`, `dispatch/index.ts`,
  `_shared/engine/` (`runtime`, `rules`, `templates`, `state-machine`), `_shared/twilio.ts`,
  `_shared/lead-recovery-config.ts`, `ops/lead-recovery.ts`, `DEPLOYMENT.md`, and the console and
  owner screens that call them.
- Ran `tests/lead-recovery.test.js`, `lead-recovery-safety`, `lead-recovery-pinning`,
  `scheduler`, `ledger` and `owner-answers`: 370 passed, none failed.
- Ran six short scenarios against the in-memory engine with recording senders, to confirm each
  gap marked "confirmed by running it" rather than infer it from the code. They were scratch
  scripts and are not in the repository. `ARC-GO-310` should turn each into a test named after
  the promise before fixing it.
- Not checked: anything hosted. The state of the live project in 3.12 is the last recorded
  state, not a fresh reading.

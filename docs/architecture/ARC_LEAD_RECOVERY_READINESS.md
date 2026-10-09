# ARC Lead Recovery — Readiness Map

**Prompt:** `ARC-GO-300` · **Checked:** October 8, 2026, against the working tree at `1.39.0`
**Kind:** read-only. Nothing in the engine, the schema or a hosted project was changed.

**Updated:** October 9, 2026, by `ARC-GO-310` (`1.40.0`). Every code gap below is closed, and
each has a test named after its promise in `tests/lead-recovery-readiness.test.js`. Section 2
reads as it stands now. Section 3 is kept as the finding of October 8, so the file and line
references in it describe the code before the fix. Section 4 says how each gap was closed.
Nothing hosted has changed: section 6 is still all to do.

**Tested:** October 9, 2026, by `ARC-GO-320` (`1.40.1`). Section 7 says what the safety test
pass walked through, the two defects it found and fixed, and what it left for a decision.

The question this answers: what stands between the code and a real homeowner's phone?

Each item reads one of three ways.

- **Done** — the code does it and a test named after the promise holds it.
- **Gap** — the code does not do it, or does it wrongly. These were the scope of `ARC-GO-310`.
- **Hosted check** — the code is written, and only a real Twilio account, a real handset or the
  hosted Supabase project can prove it. These belong to `ARC-GO-330`.

---

## 1. The short answer

The safety core was sound on October 8: opt-out, send-once, the canary, the compliance gate, the
pause and the handling of a provider that does not answer were all built.

What was missing was the ordinary path. A customer could be texted, could reply, and then the
loop stopped being a product. Four things stood out, and each is now closed:

1. **No job could count,** because no screen recorded a booked visit. The owner now saves the
   visit time on the needs-you screen, and an operator can do the same in the console.
2. **Only the customer's first reply was read.** Every reply is now read by the safety rules
   when it arrives, whatever the run is doing, and a second reply no longer makes the webhook
   fail.
3. **The owner was told about some handoffs and not others,** with a link they could not open.
   Every handoff that says to alert the owner now does, and the link is their own needs-you
   screen.
4. **The site says "your unanswered calls are forwarded to ARC" and the engine was built the
   other way round.** Both setups are now supported, chosen per client.

What stands between the code and a real phone is now only hosted work: section 6.

---

## 2. The map

| # | Item | Reads | In one line |
|---|---|---|---|
| 1 | Telephony path | Done, and hosted check | Either setup, chosen per client: the business keeps its number and forwards unanswered calls, or the ARC number is in front. Neither has met a real line. |
| 2 | Business-text registration per client | Done, and hosted check | Nothing sends or activates unless the client's status is `approved`. The status is typed by an operator; the registration itself has never been filed. |
| 3 | Opt-out | Done | STOP and its plain-language forms suppress the number, cancel the queue and end the run. Checked again at the moment of sending. An operator can suppress a number from the console. |
| 4 | Stop on reply | Done | Any reply cancels the chasing. A bare "yes" tells the owner, and the lead still closes itself. |
| 5 | Human takeover | Done | Taking over cancels everything and silences the run. The console offers it on any open lead. |
| 6 | Safety classification | Done | Rules run before any model and a model cannot clear them. They run on every reply. |
| 7 | Send-once | Done | One claim per action, one reserved effect per message, one event per send. |
| 8 | A canary that cannot reach a handset | Done, and hosted check | The sender is chosen from the lead's canary flag in one place. A production canary has not been run. |
| 9 | The owner's alert on a handoff | Done | Sent for every handoff that asks for it, by text, with a link to the owner's own screen. An email recipient is refused at validation. |
| 10 | How a lead is booked | Done | The customer gets one reviewed message after replying, with the booking link where one is set. The owner or an operator records the visit time. |
| 11 | Ambiguous provider outcomes | Done | An unknown outcome is held and never resent, and an operator settles it by saying what the provider shows. |
| 12 | Deployment checklist | Done, and hosted check | `DEPLOYMENT.md` matches the code. Nothing Lead Recovery needs is deployed to live. |

---

## 3. Item by item — as found on October 8

This section is the finding, kept as written. Every gap it names is closed; section 4 says
how. File references are from the repository root. Line numbers are as of October 8.

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

## 4. The gaps, and how `ARC-GO-310` closed each

In the order they were closed. No table changed and there is no migration.

| # | Gap | From | How it was closed |
|---|---|---|---|
| 1 | Every reply is read by the safety rules, whatever the run's state; a second reply never makes the webhook fail | E | The rules run in `handleInboundMessage` on every message, before anything else is decided. A hit goes to a person: a new handoff, a second alert on a lead a person already has, or a lead of its own when the run had finished. The model then reads everything the customer wrote, not one message. |
| 2 | Every handoff that says to alert the owner does | F | `openHandoffFor` reads the recipients from the run's own pinned configuration when it is given none. An undelivered text, reported by a callback that holds no lease, queues its alert. |
| 3 | The alert links to the owner's needs-you screen | G | `urls.ownerNeedsYou`, in all four functions. |
| 4 | A bare "yes" tells the owner and leaves the lead able to close | D | The acknowledgement queues an alert, and every reply puts the self-closing deadline back, keyed on the message. |
| 5 | The follow-up respects the business's hours | below | `followupAt`: an hour later, or the next opening time. The lead's deadline runs from when the follow-up will go. |
| 6 | A booked visit can be recorded: by the owner on needs-you, and by an operator in the console | J | `ledger` action `visit-booked` → `recordVisit` → the engine's own `markBooked`. A "book the visit" group on needs-you, derived on every load. The console's recent leads carry the same control. |
| 7 | The customer gets one reviewed message after replying, with the booking link where one is set | I | Templates `reply_ack` and `reply_ack_booking`, sent once per lead from `route_to_contractor` through the one effect gate. |
| 8 | The telephony setup is chosen, and the engine supports it | A | `forwarding.mode`: `business_first` or `arc_first`. `voiceResponse` decides what the voice webhook answers, and a forwarded call is recorded as the missed call it is. |
| 9 | A voicemail pickup does not read as answered | B | In `business_first`, which the pilot uses, ARC dials nobody, so there is no pickup to misread. `arc_first` cannot tell the two apart from the dial result; it now says so as a warning every time it is validated. See the note below. |
| 10 | An unknown send can be settled by an operator | K | `ops` action `lead-recovery-settle-send` → `settleUnknownSend`. It records what the provider shows and resends nothing. |
| 11 | An alert recipient on email is alerted or refused | H | Refused by the validator, with the reason. |
| 12 | The operator's minimum: stop any lead, suppress a number, book or close a lead | 3.3, 3.5 | Buttons on every open lead in the console's Lead Recovery panel, each with what it will do printed before the press. |
| 13 | The documents match the code: first-text timing, 0025 to 0028, the caller-name greeting | L, M, C | `DEPLOYMENT.md` and the dispatcher's header say "within about a minute". The guide lists 0025 to 0028. The caller's network name is no longer used. |

**One finding made along the way.** A send refused at the last moment because the sequence had
rightly stopped (the customer replied, opted out or was booked, a person took the lead, or the
message had already gone) was recorded as a failed send and opened a handoff. While those
handoffs told nobody it did little harm. With every failed send now alerting the owner it would
have told them a customer was left unanswered who was not. Those refusals now cancel the
action and open nothing.

**What gap 9 leaves.** `arc_first` still reads a voicemail that picks up inside the ring time
as an answered call. The fix there is to make whoever answers press a key, which changes what
the business hears on every call and needs a real line to prove. It was not built, because the
pilot does not use that setup. A client put on `arc_first` should be told, and the ring time
kept shorter than their voicemail delay.

**Smaller, and left as it was.** A failed alert leaves an attempt row and no retry. An alert
whose outcome is unknown is now on the operator's list of sends to settle.

Not gaps, and not built: a new engine, a per-client workflow, anything that depends on the
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

- `npm run gate` passing on the commit being deployed. It is the whole suite on real SQL and
  fails unless every test ran (section 7).
- Staging brought level with live. The paused 0029 draft moved out of the migrations folder
  first.
- `twilio`, `dispatch`, `lead-intake` and `ledger` deployed; `ingest` and `ops` redeployed so the
  five ledger event types are accepted and written. All of them carry the `ARC-GO-310` engine.
- The pilot client's configuration published with `forwarding.mode` set to `business_first`.
- A call sent on by a phone company's no-answer forwarding reaches the voice webhook with the
  customer's own number as the caller, and the caller hears the one sentence.
- Secrets set: the Twilio pair, the public functions URL, the dispatch key, the site URL, and the
  model key if replies are to be classified rather than all handed to a person.
- The dispatcher's once-a-minute schedule created, and a first run seen in the logs.
- A real number bought and pointed at the three webhook URLs.
- A real inbound webhook passes the signature check.
- A call placed and left unanswered produces one lead and one text on a handset ARC owns; an
  answered call produces neither.
- A reply, a STOP, a second reply and a redelivered webhook each behave as the tests say.
- Two dispatcher runs overlapping on the hosted database send one text. The suite can only
  run them one after the other.
- With the model key left unset, a reply reaches the owner as a handoff with its reason.
- The delivery callback arrives and settles the message.
- The time from the missed call to the text, measured. Until then the site claims no speed.
- Business-text registration filed for the pilot client, and its approval recorded.
- A canary run in production.
- The check that notices a client gone silent. Alerts are raised by hand today.

---

## 7. The safety test pass — `ARC-GO-320`

The suite is `tests/lead-recovery-gate.test.js`. The gate is `npm run gate`.

### 7.1 What it does differently

Every earlier suite tests a part: the engine on its in-memory store, one migration, one rule.
This one goes in by the doors a request really uses and reads the result where the owner
reads it.

- **The phone door.** A webhook signed the way Twilio signs it, posted at
  `twilio/handler.ts`. The handlers used to live inside `Deno.serve`, where a test could not
  reach them; `index.ts` now holds only the secrets, the database client and the senders.
- **The queue.** `runDueActions` for every client, as the `dispatch` function calls it.
- **The owner's door.** `ledger/handler.ts`, as whoever the sign-in verified as.
- **The owner's screen.** The portal's own `buildDashboardData` over the `events` rows.

Each scenario runs twice: on the in-memory store, and on real Postgres with every migration
applied, through the production adapter. The two must agree.

### 7.2 What it proves

| The roadmap asked for | Proved by |
|---|---|
| One run end to end, missed call to confirmed job | A forwarded call, one text, a delivery receipt, a reply, the owner alerted and the customer told, the owner saving the visit, the question asked once the visit has passed, "it happened", then the ledger reading *confirmed* with the fee from the terms on record. Every link is on the log once. A website-form lead takes the same path. |
| STOP between queueing and sending | Three moments: before the dispatcher ran, between the first text and the follow-up, and after a worker had already claimed the send. Nothing is sent after any of them. A stop belongs to one client. |
| Two workers | Two dispatchers at once send one text. A worker that stalls is replaced, and when it wakes it can neither send nor close the action. |
| A provider timeout | Asked once, never resent by the queue or by an operator's retry, counted as no send, handed to a person, the owner told, and settled by an operator without sending anything. A number refused for good and an undelivered text are handed over once. |
| A paused module | The queued follow-up does not go. A new call is still answered on the phone and recorded, with no run and no text. Time passing un-pauses nothing. |
| A safety message | In the first reply, and after the lead was already routed. A model that says "routine" cannot clear it. With no model key every reply goes to a person. |
| A duplicate webhook | A call, a reply, a STOP, a delivery receipt and a dial result, each delivered more than once, each counted once. |
| Tenant isolation | The number that was called owns the request, whatever else the request says. A test press for one client leaves another's customer waiting for the real dispatcher. |
| The new client write path | No sign-in is refused. A member of another client is refused before anything is read, and finds nothing under their own client. A body cannot claim a client, a role or who answered. |
| The signature | Seven kinds of forged request are refused, and the database client is never built for any of them. |
| A canary | The production dispatcher picks it up with the live sender in its hands, and the live sender is not used. No figure counts it. |
| What a browser can reach | Asked of real Postgres as a signed-in member: their own rows and nobody else's, nothing of the queue, no write of any kind, none of the worker's functions. |

### 7.3 What it found, and fixed

1. **With no model key set, a reply left the lead with nobody on it.** The handoff's reason
   read "ANTHROPIC_API_KEY is not set". The queue refuses a payload shaped like a credential,
   and that name is. The action was refused, the run had already been marked as needing a
   person, and the retry saw that state and cancelled itself. No handoff, no alert. Running
   without the key is a supported setup and the likeliest one for a first pilot.
   *Fixed:* the queue keeps the action and withholds the words; the reason no longer names the
   variable; the step is queued before the run changes state. The same fix covers a provider
   error whose text reads like a credential, and a customer whose own words do.
2. **A webhook that failed halfway was dropped when the provider sent it again.** Twilio
   redelivers when it gets no success, and a fault partway through the handler looks the same.
   By then the message was on record, so the redelivery was read as a duplicate. An opt-out
   could be left with no suppression, a safety word with nobody told.
   *Fixed:* a redelivery is finished unless what the message called for is provably there.

Both passed every earlier test, for the same reason: the in-memory store did not enforce the
queue's credential check, and nothing made a write fail partway. The in-memory store now
enforces the check.

Three smaller things in the tests themselves: a settings test that only runs on real SQL was
still expecting four message templates; the SQL test harness handed back date objects where
the real API sends text, which made correct code fail there; and `npm test` passes with every
database suite skipped. `npm run gate` is the answer to the last one.

### 7.4 What it found, and left

Each needs a decision or a hosted project, not a test.

1. **The event log has no database guard against the service role.** A browser cannot write
   `events` at all: that is row level security, and the suite proves it. Code holding the
   service key can update or delete a row, and nothing in the schema refuses it. Other
   append-only tables have a trigger. Adding one here is a migration, and the test-client purge
   would need its exception.
2. **A paused client's owner gets no alert text.** While a client is paused, a reply that says
   "I can smell gas" still reaches a person's list on the needs-you screen and in the console.
   No text goes to the owner, because a paused client sends nothing. That is the existing
   rule, and the suite states it rather than hiding it. Whether a safety alert to the owner
   should be exempt from a pause is a decision.
3. **A missed call whose own recording fails halfway is not picked up again.** The fix in 7.3
   covers messages. If the database fails during the few writes that record a new call, the
   lead can be on record with no text queued, and a redelivery finds the lead and stops. In
   the pilot's setup the caller still hears their sentence.
4. **Two connections at once.** The claim's `for update skip locked` is exercised one call
   after another, because the test database has one connection. Section 6 asks for it on the
   hosted one.

### 7.5 Running it

```
ARC_PGLITE_DIR=<a directory holding @electric-sql/pglite> npm run gate
```

It prints the count and either "PASSED, on real SQL, with nothing skipped" or what failed or
was skipped. Without PGlite it does not run and says so. On October 9 it ran 2,338 tests.

It does not prove anything in section 6. No test here has met Twilio, a handset or the hosted
project.

---

## 8. How this was checked

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

# ARC SaaS foundation: where it stands

The one handoff for `ARC_SAAS_FOUNDATION_IMPLEMENTATION_PROMPT.md` (the brief, at the repository
root). It says what is built, how each part was proven, what is not built and why, and what
has to happen outside this repository. It replaces nothing: the order of work is still
`ARC_IMPLEMENTATION_ROADMAP.md`, and what the launch product is is still
`ARC_PRODUCT_SCOPE.md` (section 7 there records what this work reopened).

Last checked: 2026-10-13 (`1.49.1`). The code is on `main`, except the sign-up door
(`/signup`, `Signup.jsx`, `CreateBusiness.jsx` and their routes), which is still held in the
working tree: the live database has the migrations now, and shipping the door is its own
decision (section 4).

**Read this first.** Nothing below has run against a real Stripe account or a real Twilio
number. "Locally tested" means the repository's own test suite on real SQL (PGlite), with a
recording sender in place of the carrier, a fake classifier in place of the model and a Stripe
snapshot written by the same SQL function the webhook calls. No delivery has been observed.

**What is on the live project** (`ekrszulekvvhbfemcrsl`, since 2026-10-13, at Bennett's
instruction): migrations `0029` to `0036`, applied in one push with no staging run before it,
and `crm`, `ops` and `ledger` redeployed from `main` at `53ddecc`. Each of the three answered a
request in its own words afterwards, and the new tables answer through the API. That is all
that was checked there: no signed-in owner has used a new screen against it. `billing`,
`twilio`, `lead-intake` and `dispatch` have never been deployed to live and were not deployed
then, because the project holds no Twilio or Stripe secret for them to run with. So on live an
owner can pause, publish, take over, queue a reply and hand back, and **nothing can send a
text**: there is no dispatcher and no carrier.

## 1. Status by capability

Stages: **planned** (not written) → **implemented** (written, no test of its own) →
**locally tested** → **staging verified** → or **blocked** on something outside the code.

| Capability | Existing evidence | Missing behaviour | Stage | Verification |
| --- | --- | --- | --- | --- |
| Accounts and business isolation | `0029` (`self_service_create_business`), `Signup.jsx`, `CreateBusiness.jsx`, RLS on every new table | Password recovery does not apply (sign-in is by emailed link). The sign-up door is held off the live site until the database has `0029`+. | Locally tested | `tests/self-service-db.test.js`: two owners, one business each on retry, neither reads nor writes the other's setup, drafts, form, billing or readiness |
| Setup and settings | `0029` (`self_service_save_setup`, optimistic revision), `Setup.jsx` | Setup has five steps, not the brief's six: "review activation requirements and subscription" is the last step's readiness list rather than a step of its own. | Locally tested | `tests/self-service-db.test.js`, `tests/saas-journey-db.test.js` |
| Readiness from real checks | `0033` `self_service_readiness`: configuration, source, sender, routing, test, subscription, active, each a boolean and a closed code; `production.js`, `guide.js` | None of the seven is ticked by the owner. Sender, routing and test are the operator's checklist and lifecycle, read back. | Locally tested | `tests/saas-operations-db.test.js` ("readiness is read off what is true"), `tests/saas-readiness.test.js` |
| Website form (speed-to-lead) | `lead-intake`, `0030` (`consume_public_intake_capacity`), `0032` (owner-made key, one origin) | No CAPTCHA: protection is the origin allowlist, a honeypot, a dwell time, 30 submissions an hour per form and 3 a day per recipient. No measured response time. | Locally tested | `tests/public-intake-db.test.js`, `tests/lead-recovery.test.js` ("an inquiry without SMS permission…"), the journey test |
| Messaging gateway and duplicates | The engine's one effect gate (`authorizeLeadRecoveryEffect` → `reserve_lead_recovery_effect`), wrapped by `0031` (subscription, cap) and `0033` (emergency stop) | Nothing new: this was built and gated before the brief (`npm run gate`). | Locally tested | `tests/lead-recovery-gate.test.js` on memory and SQL |
| Missed-call text-back | `twilio/handler.ts`; official Twilio SDK signature check; `MISSED_CALL_PERMISSION` | Voicemail cannot be told from a person: a pickup of either kind is `completed`. A failed or cancelled ring texts nobody. Never run on a real line. | Locally tested | Gate: "each dial result is read on its own" (seven results, both stores) |
| Qualification | `engine/rules.ts`, `classify_reply`: each reply read against services, area and safety rules. Since `0036`, up to four reviewed questions asked one at a time (`questions.ask`, the `ask_question` action): service, ZIP, how soon, when to call. One already answered is skipped, each is asked once, and an unanswered one passes the lead on after `questions.wait_minutes`. | The list of questions is closed: an owner picks from four and writes their words, and cannot invent a fifth. Only a lead ARC would have passed on as it stood is asked anything; one that needs a person goes to a person. The model's structured output is unchanged, so "when to call" is kept in the customer's words and not interpreted. | Locally tested | Gate suite, five scenarios on memory and SQL ("a client's questions are asked one at a time…") |
| Follow-up | One follow-up, `followup.enabled` / `after_minutes`, waits for opening hours, stops on reply, opt-out, booking, takeover | A campaign draft's follow-up fields are unread. One follow-up, never a sequence. | Locally tested | Gate suite |
| Owner takeover, reply and hand-back | `crm` actions `lead-takeover`, `lead-reply`, `lead-resume` → engine `takeOverLead`, `sendOwnerReply`, `resumeAutomation` (`0036`) | A reply is queued and sent on the dispatcher's next pass, so it can take up to a minute; the screen says so. An owner cannot text a customer with no SMS permission on record, or one who opted out. Handing back sends nothing by itself and does not put a cancelled check-in back. A lead that reached a person for a safety reason cannot be handed back. ARC-370's hub still has no channel: this is the Lead Recovery engine's own path, not a second one. The reply box and the hand-back dialog were not looked at against a live account. | Locally tested (engine path, memory and SQL); the HTTP door has no test of its own | Gate suite ("the owner takes a lead over, writes to the customer…", "the owner hands the lead back…"), `tests/saas-operations-db.test.js` |
| Campaigns: drafts | `0029` drafts (`self_service_save_campaign`), guided builder in the portal | A draft changes nothing ARC sends until its owner switches it on. | Locally tested | `tests/self-service-db.test.js`, `tests/campaign-guide.test.js` |
| Campaigns: an owner publishing | `0034`, `config/owner-wording.ts`, `publishOwnerWording`, `_shared/campaigns/`, `crm` `campaign-preview` / `campaign-publish`, `Publish.jsx` | Wording only: the first text (calls and website forms separately), the one check-in and, since `0036`, which questions are asked and their words. See section 3 for what a campaign carries that is not applied. Needs an account ARC has already configured. No undo short of an operator's rollback. The dialog was not looked at in a browser. | Locally tested | `tests/owner-publishing.test.js`: what the owner saved is what the next customer receives; the database refuses anything but wording |
| Subscriptions | `billing/handler.ts` + `index.ts`, `0031` (accounts, usage, events, the gate) | Test mode only: `billingSettings` refuses a live key. No price is chosen. Past-due has no grace period: it stops new texts at once. | Locally tested | `tests/billing.test.js` (real Stripe SDK signature check), `tests/saas-operations-db.test.js` |
| Usage cap | `0031`: one unit per text reserved, counted per paid period, refused at the cap | The unit is a message, not a carrier segment; the billing page says so. Two workers at once are serialised by a row lock that the in-process test database cannot exercise in parallel. | Locally tested, serially | `tests/saas-operations-db.test.js` ("the cap is a ceiling") |
| Emergency stop and operator view | `0033` (`platform_controls`, `set_platform_sending_stop`), `ops` `platform-*`, `PlatformPanel.jsx` on the console's alerts page | The stop on a person-written message (`crm_message_begin_send`) is written and has no test: no client can send one yet. | Locally tested | `tests/saas-operations-db.test.js` ("the emergency stop", "the operator's platform actions") |
| An owner pausing their texts | `0035` (`owner_sending_pauses`, `self_service_set_sending_pause`) for every text; `0036` (`owner_campaign_pauses`, `self_service_set_campaign_pause`) for one campaign. Both checked at the send reservation; `Pause.jsx` on the campaigns page | A campaign is paused by how the customer arrived: missed calls, or website inquiries. A lead that arrives by a text of its own belongs to neither and is stopped only by the pause of everything. Neither pause stops a reply the owner writes themselves. The owner is still alerted to each lead. Neither control was looked at against a live account. | Locally tested | `tests/saas-operations-db.test.js` ("an owner's own pause", "an owner pausing one campaign"), `tests/saas-readiness.test.js` |
| n8n workflows | `arc-runner-error-handler-v1`, registered. Four **drafts** in `n8n/drafts/`: a new inquiry, an inbound reply, a missed call, due follow-up work | **Drafts only.** Each is the reviewed frame around a step that checks the work is its own kind and reports it as `skipped`. None is registered, none can be assigned, and none sends anything. See section 3. | Locally tested as drafts; blocked on a decision | `tests/n8n-drafts.test.js`: each runs in the local simulator against ARC's real verifiers. No real n8n has imported one. |
| First customer journey | Sign-up → setup → draft → operator publishes and activates → inquiry → text → reply → qualified → owner takeover → portal record | The operator step in the middle is by hand. | **Locally verified, simulated providers.** Staging: not run | `tests/saas-journey-db.test.js` |

## 2. What a subscription state means

| Stripe says | New texts | Inquiries | Notes |
| --- | --- | --- | --- |
| `active`, `trialing`, inside the paid period, under the cap | Sent | Recorded | The only two states that send |
| `active` with cancel-at-period-end | Sent until the period ends | Recorded | Then as `canceled` |
| `past_due`, `unpaid`, `canceled`, `paused`, `incomplete`, `incomplete_expired`, none | Refused | Recorded, handed to the owner | No grace period |
| Period ended, or cap reached | Refused | Recorded, handed to the owner | The count does not move on a refusal |

A refused text is cancelled, not queued: nothing goes out later when the subscription
recovers. Reaching the checkout success page grants nothing; only the webhook, which re-reads
the subscription from Stripe, changes access. An operator-managed client (not self-signed-up)
is not gated on a subscription.

## 3. Not built, and why

1. **Parts of a campaign the engine has no setting for.** Publishing is built (section 1), and
   it applies the first text, the check-in text, whether and when the check-in goes, and the
   questions. A campaign's wait before the first text, its out-of-hours choice and its
   repeat-contact limits are saved and unused, and the owner is told so before they confirm.
   Whether a question is "needed" or "optional" is not applied either: every question is asked,
   and an unanswered one still passes the lead on. A check-in campaign to existing contacts
   cannot be published at all. An owner cannot undo a publication; an operator can roll the
   configuration back.
2. **n8n as the execution layer.** The brief asks for five workflow exports. The error handler
   is built and registered. The other four exist as drafts (`n8n/drafts/`, section 1) that
   perform nothing, because three things each stop a workflow from running and none was
   changed: the bridge refuses production until a licensing decision is recorded
   (ADR ARC-010 §26); Lead Recovery v1 is registered `direct` with n8n `prohibited`, so a
   workflow cannot be registered for it; and the connector gateway a workflow would ask to act
   has no route on the bridge. `ARC_PRODUCT_SCOPE.md` §5.1 still freezes launch on ARC's own
   dispatcher. The founder asking for the workflows, or reporting authorisation from n8n, is
   not the recorded licensing decision, and this work did not treat it as one. Everything the
   workflows would do, the dispatcher does, tested. `n8n/drafts/README.md` lists what has to
   exist first, in order.
3. **A question of the owner's own invention, and a reading of "when to call".** Section 1.
4. **A general inbox for texting any contact.** An owner replies on a lead they took over.
   ARC-370's conversation hub, which would cover contacts with no lead, still has no channel.
5. **A sixth setup step, a CAPTCHA on the public form, a measured response time.**

## 4. Outside this repository

Each is one action, in order. The first two rows were done on 2026-10-13; nothing below them was.

| Needed | For | Tested so far | Smallest next action |
| --- | --- | --- | --- |
| `0029`–`0036` on a hosted database | Everything in section 1 | **Done on live, 2026-10-13.** All eight applied cleanly on Postgres 17, the first time they ran outside PGlite. Staging has none of them. | None on live. |
| `crm`, `ops`, `ledger` redeployed | Takeover, the owner's reply and hand-back as far as queueing, campaign publishing and pauses, the emergency stop | **Done on live, 2026-10-13**, from `main` at `53ddecc`. Each boots and refuses an unsigned caller. | A signed-in owner walking the new screens once. |
| `billing`, `twilio`, `lead-intake`, `dispatch` deployed for the first time | Sign-up, billing, any lead arriving, any text leaving | Handlers under `node --test`. Never deployed to any hosted project. | Set their secrets first (the next two rows), then `supabase functions deploy` each; `billing`, `twilio` and `lead-intake` take `--no-verify-jwt` (each file's header says why), and `dispatch` needs its schedule (`DEPLOYMENT.md`). |
| Stripe test-mode product and price | Checkout | The handler against the real SDK's signature check, no API call | Create a price; set `STRIPE_SECRET_KEY`, `ARC_STRIPE_WEBHOOK_SECRET`, `ARC_STRIPE_PRICE_ID`, `ARC_STRIPE_MONTHLY_ACTION_CAP`, `ARC_SITE_URL` on `billing`; point a webhook at `…/billing/webhook` |
| A Twilio number with A2P registration | Any real text | Nothing | The hosted actions in `ARC_LEAD_RECOVERY_READINESS.md` §6.3 |
| Email sign-ups allowed on the hosted auth project | `/signup` | Nothing hosted | Check the project's auth settings before the sign-up door is shipped |

## 5. Operating it

- **Stop everything.** Console → alerts → "stop all sending", with a reason. Every real text
  for every business is refused from then on. Calls, forms and replies are still recorded, each
  refused text is cancelled and its lead handed to a person. Resuming sends none of them.
- **Stop one business.** Pause its module on its activation page. An owner can also pause the
  texts to their own customers from their campaigns page, all of them or one campaign; that is
  their switch, it is audited (`owner.sending_paused`, `owner.campaign_paused`), and it does
  not change the module's state. Neither stops a reply the owner writes themselves; the
  module's pause and the emergency stop do.
- **An owner says their reply did not go.** The conversation shows it as not sent, with the
  reason. If the reason is that the carrier did not answer, the send is held as unknown like
  any other and is settled from the console; it is never resent by itself.
- **Cannot be undone:** a text the carrier has already accepted. Stopping does not recall it.
- **A business says it paid and cannot send.** Console → alerts → self-signup businesses: read
  the subscription status and "used this period". The row is what Stripe last reported; if
  Stripe's dashboard disagrees, resend the latest subscription event from Stripe and it is
  re-read. Never edit `saas_billing_accounts` by hand.
- **An unused Stripe customer.** Two checkouts started at once bind the first customer and
  leave the second in Stripe with no subscription. Delete it there.
- **Connection failures, a missing reply, an opt-out, a stalled queue:** unchanged, in
  `ARC_INCIDENT_NOTE.md`.

Where data lives: Supabase Postgres. Retention, export and deletion are as they were before
this work (`purge_test_tenant` for a business that never did anything real, deboarding
otherwise). No backup or restore of the hosted project has been exercised by this work.

## 6. Reproduce

```
ARC_PGLITE_DIR=<a directory holding @electric-sql/pglite> npm test
npm run build
```

Without `ARC_PGLITE_DIR` the database suites are skipped and `npm test` still reads green,
which proves nothing about `0029`–`0036`. `npm run gate` fails unless every test ran.

## 7. What stops a first paying customer

Not code in this list alone: no text has reached a real handset, the functions that receive a
lead and send a text are not deployed, and no price exists. An owner's campaign can only be switched on after ARC has
configured the account (number, hours, compliance), which is still an operator's work per client.

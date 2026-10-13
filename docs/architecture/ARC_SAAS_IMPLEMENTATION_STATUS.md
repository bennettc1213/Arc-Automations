# ARC SaaS foundation: where it stands

The one handoff for `ARC_SAAS_FOUNDATION_IMPLEMENTATION_PROMPT.md` (the brief, at the repository
root). It says what is built, how each part was proven, what is not built and why, and what
has to happen outside this repository. It replaces nothing: the order of work is still
`ARC_IMPLEMENTATION_ROADMAP.md`, and what the launch product is is still
`ARC_PRODUCT_SCOPE.md` (section 7 there records what this work reopened).

Last checked: 2026-10-13 (`1.46.0`). The code is on `main`, except the sign-up door
(`/signup`, `Signup.jsx`, `CreateBusiness.jsx` and their routes), which is held in the working
tree until a hosted database has the migrations.

**Read this first.** Nothing below has run against a real Stripe account, a real Twilio number
or a hosted database. "Locally tested" means the repository's own test suite on real SQL
(PGlite), with a recording sender in place of the carrier, a fake classifier in place of the
model and a Stripe snapshot written by the same SQL function the webhook calls. No delivery has
been observed. Migrations `0029` to `0033` and the `billing` function are not deployed.

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
| Qualification | `engine/rules.ts`, `classify_reply`: one reply read against services, area and safety rules | **Not the brief's design.** No second question is ever asked; the question list an owner writes in a campaign draft is stored and unread. See section 3. | Locally tested as built | Gate suite |
| Follow-up | One follow-up, `followup.enabled` / `after_minutes`, waits for opening hours, stops on reply, opt-out, booking, takeover | A campaign draft's follow-up fields are unread. One follow-up, never a sequence. | Locally tested | Gate suite |
| Owner takeover | `crm` action `lead-takeover` → engine `takeOverLead` | No resume. No owner-written reply: no channel adapter exists (`PRODUCTION_CHANNEL_ADAPTERS` is empty). | Locally tested (engine path); the HTTP door has no test of its own | Journey test |
| Campaigns | `0029` drafts (`self_service_save_campaign`), guided builder in the portal | **A draft changes nothing ARC sends.** Publishing one to live is decided (2026-10-13) and not built. No owner pause or resume. See section 3. | Drafts locally tested; publish planned | `tests/self-service-db.test.js`, `tests/campaign-guide.test.js` |
| Subscriptions | `billing/handler.ts` + `index.ts`, `0031` (accounts, usage, events, the gate) | Test mode only: `billingSettings` refuses a live key. No price is chosen. Past-due has no grace period: it stops new texts at once. | Locally tested | `tests/billing.test.js` (real Stripe SDK signature check), `tests/saas-operations-db.test.js` |
| Usage cap | `0031`: one unit per text reserved, counted per paid period, refused at the cap | The unit is a message, not a carrier segment; the billing page says so. Two workers at once are serialised by a row lock that the in-process test database cannot exercise in parallel. | Locally tested, serially | `tests/saas-operations-db.test.js` ("the cap is a ceiling") |
| Emergency stop and operator view | `0033` (`platform_controls`, `set_platform_sending_stop`), `ops` `platform-*`, `PlatformPanel.jsx` on the console's alerts page | The stop on a person-written message (`crm_message_begin_send`) is written and has no test: no client can send one yet. | Locally tested | `tests/saas-operations-db.test.js` ("the emergency stop", "the operator's platform actions") |
| n8n workflows | Only `arc-runner-error-handler-v1` | **Not built, by a recorded decision.** See section 3. | Blocked on a decision | — |
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

1. **Publishing an owner's campaign to live.** Decided: what an owner publishes is what gets
   sent, and they can edit it at any time. It is not built because it cannot be a button. Two
   rules the engine enforces stand in the way and each needs a designed change, not a
   bypass: publishing configuration is operator-only in both `config/engine.ts` and `0014`'s
   SQL, and a change of wording is recorded as needing a retest, which holds new texts until an
   operator records a passing test (`record_test` is operator-only in `0015`'s immutable rule
   table). The intended build: a closed set of owner-publishable wording fields, validated by
   the existing template validator, published under the owner's name, followed by an automatic
   synthetic test that re-authorises sending when it passes. A draft's fields also have to be
   mapped onto the engine's: `{{business}}`/`{{first_name}}` against `{{company}}`/
   `{{customer_name}}`, a STOP line the engine already appends, and questions, a repeat-contact
   limit and a response delay the engine has no setting for.
2. **n8n as the execution layer.** The brief asks for five workflow exports. Lead Recovery is
   registered `direct` with n8n `prohibited`, the bridge refuses production until a licensing
   decision is recorded, and `ARC_PRODUCT_SCOPE.md` §5.1 freezes launch on ARC's own
   dispatcher. The founder reporting authorisation from n8n is not that recorded decision, and
   this work did not treat it as one. Everything the five workflows would do, the dispatcher
   does, tested.
3. **A multi-question qualification exchange.** Frozen as a later improvement
   (`ARC_PRODUCT_SCOPE.md` §5.3): it needs a new engine action and reviewed templates for each
   question.
4. **An owner replying by text from ARC.** Needs a channel adapter that sends through ARC's
   Twilio; none exists.
5. **Resuming automation after a takeover**, and **an owner pausing their own campaign**.
6. **A sixth setup step, a CAPTCHA on the public form, a measured response time.**

## 4. Outside this repository

Each is one action, in order. Nothing here was done by this work.

| Needed | For | Tested so far | Smallest next action |
| --- | --- | --- | --- |
| `0029`–`0033` on a hosted database | Everything in section 1 | All five apply cleanly on PGlite in `npm test` | `supabase db push` to staging |
| `billing`, `twilio`, `lead-intake`, `crm`, `ops` redeployed | Sign-up, billing, takeover, the emergency stop | Handlers under `node --test` | `supabase functions deploy` each; `billing`, `twilio` and `lead-intake` take `--no-verify-jwt` (each file's header says why) |
| Stripe test-mode product and price | Checkout | The handler against the real SDK's signature check, no API call | Create a price; set `STRIPE_SECRET_KEY`, `ARC_STRIPE_WEBHOOK_SECRET`, `ARC_STRIPE_PRICE_ID`, `ARC_STRIPE_MONTHLY_ACTION_CAP`, `ARC_SITE_URL` on `billing`; point a webhook at `…/billing/webhook` |
| A Twilio number with A2P registration | Any real text | Nothing | The hosted actions in `ARC_LEAD_RECOVERY_READINESS.md` §6.3 |
| Email sign-ups allowed on the hosted auth project | `/signup` | Nothing hosted | Check the project's auth settings before the sign-up door is shipped |

## 5. Operating it

- **Stop everything.** Console → alerts → "stop all sending", with a reason. Every real text
  for every business is refused from then on. Calls, forms and replies are still recorded, each
  refused text is cancelled and its lead handed to a person. Resuming sends none of them.
- **Stop one business.** Pause its module on its activation page.
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
which proves nothing about `0029`–`0033`. `npm run gate` fails unless every test ran.

## 7. What stops a first paying customer

Not code in this list alone: no text has reached a real handset, the migrations and functions
are not deployed, no price exists, and a campaign an owner writes does not change what is sent.

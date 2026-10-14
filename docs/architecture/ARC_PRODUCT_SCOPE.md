# ARC Lead Recovery — Launch Scope

> **Scope reopened October 11, 2026:** The owner-approved
> `ARC_PORTAL_REBUILD_MASTER_PROMPT.md` supersedes this document's four-screen,
> operator-led product direction for the client/demo frontend. The new primary views
> are Overview, Leads, Campaigns and Inbox, with guided setup and an isolated interactive
> demo. The old decisions below remain historical context. Server authorization,
> reviewed-message restrictions, provider readiness and execution safety remain binding.
> Client campaign persistence, real activation, bulk outreach and deployment are not
> implemented or authorized by this frontend phase. See `ARC_PORTAL_REBUILD_HANDOFF.md`.

**Prompt:** `ARC-SAAS-010` · **Frozen:** October 11, 2026, against the working tree at `1.42.0`
**Kind:** a decision document. No code, table or hosted project was changed.

The question this answers: what is ARC Lead Recovery at launch, and what is it not?

The boundary is frozen. Moving something across it is a new, recorded decision that edits
this file. It is never a side effect of another prompt.

---

## 1. The product, in one sentence

> ARC answers a missed call or a website request with a text, reads the reply, follows up
> once the customer goes quiet, hands the lead to the owner when a person is needed, and shows
> every step in a ledger that decides what counts.

One product, one codebase, one deployment. A client differs only in its published
configuration. Onboarding is done with the founder on a call, because phone forwarding and
business-text registration need a person. There is no self-serve sign-up at launch.

---

## 2. In at launch

Nine things. Each is one part of the single Lead Recovery module, not a product of its own.

| # | In | What it is at launch | Where it lives | Stands |
|---|---|---|---|---|
| 1 | Missed-call text-back | An unanswered call becomes a lead and one reviewed text. | `twilio`, `_shared/engine/` | Built and gated. Never run on a real line. |
| 2 | Speed-to-lead for form leads | A website request enters by the same `intakeLead` and gets the same first text. | `lead-intake` | Built and gated. Not deployed to live. |
| 3 | Qualification | The reply is read against the client's services, service area and safety rules, then routed or handed off. | `engine/rules.ts`, `classify_reply` | Built. See 5.3 for its limit. |
| 4 | Follow-up | One follow-up when the customer goes quiet. It waits for opening hours and stops on any reply, opt-out, booking or takeover. A client can turn it off or set the wait. | `send_followup`, `followupDueAt` | Built and gated. |
| 5 | Owner handoff | Every handoff that asks for an alert sends the owner a text linking to their needs-you screen. | `openHandoffFor` | Built and gated. |
| 6 | Proof ledger | Six links read off the event log decide each lead's status and whether it is billed. | `lib/ledger.js`, `_shared/ledger/` | Built. Live once `ledger` and `ingest` are redeployed. |
| 7 | Simple portal | Four screens: this month, jobs, needs you, account. | `OWNER_NAV_GROUPS` | Built, on `main`. |
| 8 | Tenant settings | One validated configuration per client, versioned, edited by an operator. The owner reads theirs on the account screen. Each setting is listed in `ARC_TENANT_SETTINGS.md`. | `_shared/config/`, `ClientSettings.jsx` | Built, on `main`. |
| 9 | Execution configuration | Which actions run, and when, comes from the client's published configuration and the module lifecycle. | `_shared/lifecycle/`, `dispatch` | Built. See 5.1: this is not n8n. |

The fee arithmetic is part of the ledger (item 6). Sending an invoice or taking a payment is
out (section 3).

**What "launch" means.** The code for all nine is written and passes `npm run gate`. Launch
is the first approved client completing the loop on a real phone, which is the hosted half of
`ARC-GO-330` and then `ARC-GO-340`.

---

## 3. Out at launch

Eight things. Most of them are already built or planned in this repository. None is deleted.
"Out" means a launch client cannot see it, cannot select it and is not sold it.

| Out | What exists today | How it is kept out |
|---|---|---|
| Full CRM | Built: contacts, leads, pipelines, lead inbox, conversations, hosted forms. | A launch client's nav is the four screens (`isLaunchClient`). Further CRM work is paused. |
| Custom workflow builder | Not built. | No client ever gets a workflow of its own. |
| Estimate recovery | A reporting bucket, `planned` in the registry. | Cannot be selected (`moduleCatalog`). Shown on the site as "next", never as live. |
| Review automation | The same: `planned`. | The same. |
| Memberships | The same: `planned`. | The same. Also blocked on consent records. |
| Dispatching | Not built. A booking's `capacity` is a number and `assigned_user_id` a name. | Nothing to hide. |
| Invoicing | Not built. The ledger works out a fee and stops there. | No invoice or payment code exists. |
| Many visible AI agents | Not built as an offer. | The owner-copy test fails on the word. A model never writes a customer message. |

Also out, and already stated in the roadmap's paused list: CRM connectors, a client sending
messages by hand, a calendar adapter, customer appointment notices, client self-serve
onboarding, the n8n bridge in production, payments, voice AI.

---

## 4. The test for anything new

Before building something, ask in this order:

1. **Is it one of the nine?** If not, it is out. Stop, or reopen this document first.
2. **Does every client get it from configuration alone?** If it needs a per-client workflow,
   branch, schema or deploy, it is out whatever it is called.
3. **Can the ledger show what it did?** If its result cannot be read off the event log, it is
   not ready to be sold.
4. **Would a launch client see a new screen or a new choice?** Then it is a scope change, not
   a feature.

A bug fix, a hosted check, or a clearer word on one of the four screens is always in.

---

## 5. Where this differs from the SaaS roadmap prompts

`ARC_SAAS_LEAD_ENGINE_ROADMAP_PROMPT_IDS.md` describes the same product. In four places it
says something the repository does not do. This document follows the repository. Each is a
decision for Bennett, listed so that a later prompt does not settle it by accident.

### 5.1 n8n is not the execution layer for Lead Recovery

The prompts make n8n the execution layer and list "n8n execution configuration" as a launch
item. In the repository, Lead Recovery v1 is registered `direct` with n8n `prohibited`: ARC's
own dispatcher claims and sends every action. The n8n bridge is built and refuses to run in
production until a licensing decision is recorded.

**Frozen as:** launch runs on ARC's dispatcher. Item 9 means the client's published
configuration and lifecycle, read by that dispatcher. Putting n8n in the launch path would
need the licensing gate closed and a new module version, and would discard a tested send path
for an untested one.

### 5.2 "SaaS" is how it is built, not what the owner is told

The prompts call ARC a SaaS. The roadmap says it is sold as a service with a simple portal,
and the homepage test fails on the word. Both hold: one shared product configured per client
is the build, and an owner is sold missed calls texted back.

**Frozen as:** shared product, founder-led setup, no self-serve sign-up, no public plan
picker.

### 5.3 Qualification is one reply read by rules, not a scripted exchange

The prompts describe collecting service type, urgency, location, timeline and job fit. The
engine reads what the customer wrote against the client's services, service area and
emergency keywords, and routes it or hands it to a person. It has no action that asks a
second question, and a model never writes a message.

**Frozen as:** what is built. A multi-question exchange is new engine work with new reviewed
templates. It is in scope as a later improvement to item 3 and is not required for launch.

### 5.4 No speed is promised until one is measured

The prompts promise a reply "in under 60 seconds". No text has yet left for a real handset,
and the site may claim no speed that has not been measured on a real line.

**Frozen as:** no number in any copy until `ARC-GO-330` has timed it.

One more difference belongs to a later prompt and is only noted here: the prompts list
fourteen stored lead states, while the ledger derives nine statuses from the event log and
stores none.

---

## 6. What this changes

Nothing in the code. The registry, the launch nav, the homepage's staged map and the roadmap's
paused list already enforce this boundary. This document is the one place that states it
whole.

---

## 7. Reopened on 2026-10-12 and 2026-10-13

Bennett reopened part of this boundary with `ARC_SAAS_FOUNDATION_IMPLEMENTATION_PROMPT.md` and
in two decisions the day after. Each line is a decision, recorded here so the sections above
are not read as still holding where they no longer do. Where the work stands is
`ARC_SAAS_IMPLEMENTATION_STATUS.md`.

| Was | Now | Built |
| --- | --- | --- |
| No self-serve sign-up (5.2, section 3) | A business may create its own account and save its own setup. | Yes, not deployed. The sign-up door stays off the live site until the database has it. |
| Payments out (section 3) | A subscription, through Stripe, decides whether a self-signed-up business may send. Invoicing a customer's customers is still out. | Yes, test mode only, not deployed. |
| An owner reads settings and edits none (item 8) | A campaign an owner publishes is what gets sent, and they may edit it at any time. | Yes, for wording only: the first text and the one check-in (`config/owner-wording.ts`, 0034). Every other setting is still an operator's. Not deployed. |
| A voice call was implied consent, then (in the first draft of this work) no consent at all | A missed call may be texted back about that call. A website form still needs the box ticked. | Yes. |

**Not reopened.** 5.1 stands: launch runs on ARC's dispatcher, and n8n is not in the path. The
brief reports an authorisation from n8n; closing the licensing gate is still its own recorded
decision. 5.3 stands as a later improvement. 5.4 stands: no speed is claimed.

---

## 8. Reopened on 2026-10-13, second decision

Bennett asked for five more things to be built. Four move across the boundary and are built.
The fifth does not move, and what was built toward it is stated below so that it is not read
as more than it is. The migrations and the `crm`, `ops` and `ledger` functions were put on the
live project the same day; what that does and does not make work is at the top of
`ARC_SAAS_IMPLEMENTATION_STATUS.md`.

| Was | Now | Built |
| --- | --- | --- |
| Qualification is one reply read by rules (5.3) | ARC may ask up to four reviewed questions after the first reply, one at a time: the service, the ZIP, how soon, and when to call. The list is closed and a model writes none of them. A reply that needs a person still goes to a person at once. | Yes. `questions` in the configuration, the `ask_question` action, `ARC_TENANT_SETTINGS.md` §8. An owner may publish which are asked and their words. |
| A client sending messages by hand is out (section 3) | An owner who has taken a lead over may text that customer from ARC. Their words, queued and sent by the dispatcher through the one send gate. Not a second messaging system: ARC-370's hub still has no channel. | Yes. `sendOwnerReply`, `send_owner_reply`, `owner_sms` (0036). |
| A takeover is final | An owner may hand a lead they took over back to ARC. Nothing cancelled is sent; ARC reads the customer's next message. A lead that reached a person for a safety reason stays with a person. | Yes. `resumeAutomation`. |
| The owner's pause covers every text | An owner may also pause one campaign: missed calls, or website inquiries. | Yes. `owner_campaign_pauses` (0036). |

**Not reopened: 5.1.** Launch runs on ARC's dispatcher and n8n is not in the path. Bennett
asked for the n8n workflows; three things in this repository each stop one from running, by
design, and none of the three was changed:

1. The licensing gate (ADR ARC-010 §26) is closed. It opens on a recorded decision with the
   written confirmation behind it, and asking for the workflows is not that record.
2. Lead Recovery v1 is registered `direct` with n8n `prohibited`, so no workflow can be
   registered for it or assigned to it.
3. The connector gateway a workflow would ask to act (ADR §20) has no route on the bridge.

What was built is four draft exports in `n8n/drafts/`: the reviewed frame around a step that
checks the work is its own kind and reports it as skipped. They prove the contract in the local
simulator and send nothing. `n8n/drafts/README.md` lists what has to exist, in order, before
one could run for a client.

Related: `ARC_IMPLEMENTATION_ROADMAP.md` (the order of work), `ARC_LEAD_RECOVERY_READINESS.md`
(what stands between the code and a real phone), `ARC_PROOF_LEDGER.md` (what counts).

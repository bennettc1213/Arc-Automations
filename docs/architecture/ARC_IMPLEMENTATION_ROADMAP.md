# ARC Roadmap — Missed-Job Recovery First

**Roadmap revision date:** October 8, 2026  
**Project:** ARC / Arc Automations  
**Owner:** Bennett Church  
**Last reported application version:** `1.39.0`  
**Primary niche:** small HVAC companies, 2 to 10 trucks  
**Direction:** simple automations first. One company, one phone line, missed calls texted back, every step shown in a proof ledger.  
**Immediate next implementation prompt:** `ARC-GO-310` — Close the Readiness Gaps

This revision replaces the October 1 roadmap. The platform work it described is finished and
stays in place. What changes is the order of everything after it: the CRM track and the other
complex work are paused, and the remaining steps have new, shorter prompt IDs. The old
revision is in git history, and the full cards for the old steps are still in the
`ARC_MASTER_ROADMAP_*` files at the repository root.

---

## 1. Current position

- **Built and on `main`:** the whole platform (`ARC-000` to `ARC-390`). See section 9.
- **Paused:** the rest of the CRM track, performance intelligence, CRM connectors and the n8n
  bridge. See section 8.
- **Shipped from section 3:** `ARC-MK-100` (`1.34.0`), `ARC-MK-110` (`1.35.0`) and `ARC-MK-120`
  (`1.36.0`): the site offer, the missed-call count request and the proof ledger demo. The site
  as it was before is kept on the branch `archive/site-before-arc-mk-100`.
- **Mapped:** `ARC-GO-300`, the Lead Recovery readiness map
  (`docs/architecture/ARC_LEAD_RECOVERY_READINESS.md`). The safety core is sound; thirteen gaps
  stand between the code and a real phone, and the four decisions they needed are made.
- **Not started:** the rest of section 3.
- **The gap that matters:** the Lead Recovery engine is built and tested but has never texted a
  real phone, and the site and portal explain the machine instead of the result.

The goal has not changed, only the path to it:

> One HVAC company forwards its missed calls to ARC. ARC texts back safely, captures the job,
> books it or hands it to the owner, shows every step in a ledger, and bills only for jobs that
> can be proven.

ARC is sold as a productized service with a simple portal, not as self-serve software. Every
client runs the same system and differs only in configuration. Setup still includes a call, for
trust and phone forwarding, never for custom engineering.

---

## 2. Immediate next step

`ARC-GO-310` — close the readiness gaps. `ARC-GO-300` is done: the map is
`docs/architecture/ARC_LEAD_RECOVERY_READINESS.md`, and its section 4 is this step's scope. The four
decisions in its section 5 are made: the business keeps its number and forwards unanswered
calls to ARC, the owner confirms a visit time on the needs-you screen, the follow-up waits for
opening hours, and email is refused as an alert channel until it exists. Phase 2 is built:
`ARC-MK-200` (the four-screen owner portal) shipped in `1.37.0`, `ARC-MK-210` (the counting
rule) in `1.38.0` and `ARC-MK-220` (the owner's answers and disputes, `ARC_PROOF_LEDGER.md`
section 9) in `1.39.0`. Its edge functions are not deployed yet: `ledger` is new, and `ingest`,
`ops` and `twilio` need redeploying. That is a hosted action and waits for authorisation.

`ARC-MK-130` (sales assets and pilot terms) is drafted: the kit is in `sales/`, kept out of
this public repository. Its pilot numbers are proposed, not agreed. Once Bennett agrees them
they go in `site.price.terms`, which prints words until they are set.

---

## 3. Implementation sequence

Fifteen steps in four phases. Phases 1 and 2 make ARC understandable. Phase 3 makes the first
automation real. Phase 4 adds the next automations one at a time.

| ID | Step | Kind | Status |
|---|---|---|---|
| **Phase 1 — a clear offer** | | | |
| `ARC-MK-100` | Public site offer rewrite | Site | Done (`1.34.0`) |
| `ARC-MK-110` | Missed-call count intake | Site | Done (`1.35.0`) |
| `ARC-MK-120` | Proof ledger demo | Site | Done (`1.36.0`) |
| `ARC-MK-130` | Sales assets and pilot terms | Documents | Drafted, numbers to agree |
| **Phase 2 — the owner portal** | | | |
| `ARC-MK-200` | Four-screen owner portal | Portal | Done (`1.37.0`) |
| `ARC-MK-210` | Proof ledger events and counting rules | Backend, design first | Done (`1.38.0`) |
| `ARC-MK-220` | Owner outcome answers and disputes | Portal and backend | Done (`1.39.0`) |
| **Phase 3 — missed-call text-back, live** | | | |
| `ARC-GO-300` | Lead Recovery readiness map | Read-only | Done |
| `ARC-GO-310` | Close the readiness gaps | Backend | Next |
| `ARC-GO-320` | Safety test pass | Tests | To do |
| `ARC-GO-330` | Live backend and real telephony | Hosted, each action authorised | To do |
| `ARC-GO-340` | First HVAC pilot | Pilot | To do |
| **Phase 4 — the next automations** | | | |
| `ARC-AUTO-400` | Quiet estimate follow-up | Automation | After the pilot |
| `ARC-AUTO-410` | Review requests | Automation | After `ARC-AUTO-400` |
| `ARC-AUTO-420` | Come-back reminders | Automation | Blocked on consent records |

Order inside a phase is the order to build in. Phase 2 can start while Phase 1 is in review.
Phase 3's hosted steps (`ARC-GO-330` onward) wait for Phase 2, because a pilot needs the
ledger and the owner's answers. Phase 4 does not start until the pilot has run.

Three working rules for every step:

1. A step that changes the public site is built on a branch and reaches `main` only after
   Bennett approves it. Pushing `main` is the deploy.
2. A step marked "design first" stops for approval after the design, before any code.
3. No step applies a migration, deploys a function, or contacts a real customer without
   explicit authorisation for that action.

---

## 4. Phase 1 — a clear offer

The five-second test for the whole phase: a stranger reading only the top of the homepage can
say what ARC does, what it costs, and when they pay.

### ARC-MK-100 — Public Site Offer Rewrite

**Goal.** A small HVAC owner understands the homepage without scrolling.

- Hero, subhead, process, price and footer rewritten around missed calls, the text back, and
  the proof ledger. Main button: "get my missed-call count". Second button: "see the proof
  ledger".
- The four places jobs slip away stay as a staged map, each with its real status: missed calls
  (launch), quiet estimates (next), missing reviews (later), past customers (blocked). Nothing
  past the first is shown as live.
- The three-route section and its quiz leave the public homepage. The route model and operator
  onboarding are kept; cold visitors are no longer asked to choose a route.
- The nine extra services stop rendering and are kept as parked data.
- A copy test fails on owner-facing jargon: n8n, workflow, automation (outside the company
  name), agent, route, native, hybrid, connected, lifecycle, module, orchestration, SaaS,
  integration, or any CRM requirement. No unsourced statistic.
- Copy stays in `src/data/site.js`.

**Done when.** Tests and the smoke pass are green and the five-second test passes.

### ARC-MK-110 — Missed-Call Count Intake

**Goal.** The pilot overlay becomes a request for a free missed-call count.

- Asks: trade, company, service area, rough weekly calls, whether calls are missed after
  hours, phone system, whether call history can be exported or screenshotted, what software
  they use today (or none), and best contact.
- The booking calendar is never blocked by a failed post.
- Route mapping stays internal. The owner never sees or picks one.

**Done when.** The form matches the homepage button and offers no menu of automations.

### ARC-MK-120 — Proof Ledger Demo

**Goal.** `/demo` shows why each lead is or is not billable. It sells the ledger, not magic.

- Seven deterministic leads: recovered and booked; texted with no reply; spam or wrong number;
  booked but not yet confirmed; booked and confirmed; customer cancelled; safety handoff to a
  person.
- Each shows its source, arrival time, whether the owner answered, ARC's first text, the
  reply, the booking or handoff, the owner's confirmation, and its billable status with the
  reason.
- The demo client becomes an HVAC company.

**Done when.** A non-technical owner can explain each lead's status, and nothing claims to be
live data.

### ARC-MK-130 — Sales Assets and Pilot Terms

**Goal.** Everything a solo founder needs to sign the first design partner. Not code.

- One-page offer, missed-call audit checklist, outreach emails, call script, objections and
  answers, a proof ledger explainer.
- Pilot terms: one company, one line, 30 to 60 days; a small monthly base plus a fee per
  proven recovered job; a monthly cap; a dispute window with a fixed list of valid reasons
  (spam, wrong number, out of area, customer cancelled, job did not happen, owner got there
  first, duplicate). The numbers live in the terms and in one config object in the site copy.
- Who to approach first, and who to avoid (mature ServiceTitan shops, full-time call staff,
  owners who will not confirm outcomes).

**Done when.** Bennett can run outreach and a first call from the assets alone.

---

## 5. Phase 2 — the owner portal

The portal is read on a phone in a truck. It should feel like a statement, not software.

### ARC-MK-200 — Four-Screen Owner Portal

**Goal.** A launch client sees four screens instead of thirteen.

| Screen | Answers | Shows |
|---|---|---|
| This month | Is ARC working? | Jobs brought back, jobs waiting on the owner, fee owed, one card per leak |
| Jobs | Prove it | Each lead's timeline: call, text, reply, booking, visit, outcome, billable or not |
| Needs you | What do I have to do? | Outcome questions, safety handoffs, odd leads |
| Account | What is ARC allowed to do? | Hours, service area, who gets alerts, quiet hours, stop list, export my data |

- Plan first: map every existing page to keep, merge, move behind "details", or operator-only.
  Stop for approval before hiding anything.
- No page is deleted. The lead inbox, bookings and the machine pages stay built and are hidden
  for launch clients. `tests/ux-clarity.test.js` keeps passing.
- Built over demo data first. Mobile first: thumb-sized buttons, no wide tables.
- Every figure comes through the one derivation chain. A figure that cannot be shown is a dash
  and the reason, never a zero. State names keep their `Term` and glossary entry.
- "Export my data" is a plain download of the client's own ledger. It is the one piece of the
  paused `ARC-395` kept in view, so ARC is never a data trap.

**Done when.** A Lead Recovery client's nav is the four screens, in the portal and in `/demo`.

### ARC-MK-210 — Proof Ledger Events and Counting Rules

**Goal.** Decide exactly what evidence makes a job count. Design, stop, then build.

- A recovered job needs every link: a call or form arrived; nobody answered live; ARC's text
  went out; the customer replied or booked; the visit happened; the owner confirmed it or the
  dispute window passed under the pilot terms.
- Statuses: answered, booked, handed off, needs owner, confirmed, disputed, billable, not
  billable, unverified. A missing link means unverified: shown, never counted, never billed.
- The design names the existing events reused, any new event types (mirrored in the portal's
  types, the ingest validator and `EVENT_CONTRACT.md`), the derivation, idempotency and tenant
  isolation.
- The fee owed is arithmetic over confirmed results. No payment or invoicing code.

**Done when.** Every figure on the four screens is derived from `events` by rules with tests.

### ARC-MK-220 — Owner Outcome Answers and Disputes

**Goal.** The owner answers one question per booked visit, in one place.

- Answers: sold or happened; quoted, not sold yet; did not happen; not a real job; customer
  cancelled; duplicate or already handled.
- This is the portal's first client write path. It goes through an edge function, takes the
  actor from the verified sign-in, appends evidence and never edits a past event.
- A dispute is visible to the owner and to operators, with its reason. A pattern of disputes
  on good leads is visible in the console.
- Considered in the design: answering by replying to a text.

**Done when.** Operators see billable, disputed and needs-owner per client, and tests cover
repeat answers and tenant isolation.

---

## 6. Phase 3 — missed-call text-back, live

The engine exists: a call reaches an ARC number, is forwarded, and an unanswered one becomes a
lead, a text back, a classified reply and a handoff. This phase proves it and turns it on. It
uses Lead Recovery's own tables as they are; it does not wait for the CRM.

### ARC-GO-300 — Lead Recovery Readiness Map

**Goal.** A checklist of exactly what stands between the code and a real homeowner's phone.
Read-only.

Checks each item against the repository: telephony path, business-text registration per
client, opt-out, stop on reply, human takeover, safety classification, send-once, a canary
that cannot reach a handset, the owner's alert when a lead is handed off, how a lead is booked
(the hosted booking page or the owner confirming a time), ambiguous provider outcomes, and the
deployment checklist.

**Done when.** Each item reads done, gap, or hosted check, and the gaps are the scope of
`ARC-GO-310`.

**Done.** The map is `docs/architecture/ARC_LEAD_RECOVERY_READINESS.md`.

### ARC-GO-310 — Close the Readiness Gaps

**Goal.** Build only what `ARC-GO-300` found missing: the thirteen gaps in section 4 of
`ARC_LEAD_RECOVERY_READINESS.md`, in its order. Every reply read by the safety rules, every
handoff alerting the owner with a link the owner can open, the follow-up kept to opening hours,
a way to record a booked visit, one reviewed message after the customer replies, the telephony
setup the site promises, and the minimum an operator needs to stop a lead or settle an unknown
send.

No new engine, no per-client workflow, no CRM dependency. A model still never writes a
customer-facing message, and safety is still decided by rules.

**Done when.** The readiness map has no code gaps left.

### ARC-GO-320 — Safety Test Pass

**Goal.** Prove the whole path under failure, with no real customer contact.

- Tenant isolation and the new client write path.
- One synthetic run end to end: missed call to confirmed job in the ledger.
- Failure cases: STOP arriving between queueing and sending, two workers, a provider timeout,
  a paused module, a safety message, a duplicate webhook.

**Done when.** The suite is green and is the gate for `ARC-GO-330`.

### ARC-GO-330 — Live Backend and Real Telephony

**Goal.** The first step that touches the hosted projects. Every action is authorised one at a
time.

- Staging brought level with live; outstanding migrations and functions deployed.
- Twilio verified with a real account: a real inbound webhook, a forwarded call, a text to a
  test handset owned by ARC.
- Business-text registration understood and filed for the pilot client.
- A canary run in production, a check that notices a client gone silent, and a one-page
  incident note: how to pause, who to call, what to tell the owner.

**Done when.** A test number completes the loop in production and the ledger shows it.

### ARC-GO-340 — First HVAC Pilot

**Goal.** One approved HVAC company, one line, 30 to 60 days.

Before it starts: offer clear, terms signed, forwarding set, hours and service area and
emergency rules configured, alert contacts set, the eleven-step activation checklist passed,
canary green, the support promise honest.

**Done when.** The pilot has run and produced a written list of what actually went wrong.
That list, not this roadmap, decides what Phase 4 builds first.

---

## 7. Phase 4 — the next automations

One at a time, each as design, stop, build. Each rides on the ledger and the owner's answers
from Phase 2, uses the same engine, and is not shown as live or made selectable until it works
end to end. The four planned modules in the registry stay `planned` until then.

### ARC-AUTO-400 — Quiet Estimate Follow-Up

Starts when the owner answers "quoted, not sold yet". A short timed sequence that stops on a
reply, sold, lost or opt-out, and honours safety and takeover at once. Counts as revived only
with the quote, a follow-up that left, a reply after it, and the owner marking it sold.

### ARC-AUTO-410 — Review Requests

One request after a confirmed completed job, one reminder at most. Never to someone who opted
out or whose job did not happen. Reports "requests sent"; claims no reviews gained unless
verified.

### ARC-AUTO-420 — Come-Back Reminders

Tune-up reminders to past customers. Blocked until consent can be proven: the consent record
is designed first, and a bought or shared list is never valid.

Possible later additions, undecided and without IDs: a weekly summary text to the owner, and
an appointment reminder to the customer.

---

## 8. Paused work, and what happened to the old IDs

Nothing here is deleted. Built pieces stay in the repository and on `main`, tested, and simply
are not shown to launch clients or extended.

| Old ID | What it was | Now |
|---|---|---|
| `ARC-395` | CRM sync, data quality, reporting, portability | Paused. Partly drafted in the working tree, not shipped. Only "export my data" continues, in `ARC-MK-200`. |
| `ARC-LR-400` | Lead Recovery on the universal CRM | Paused. Lead Recovery keeps its own tables for the pilot. |
| `ARC-LR-410` | Qualification, messaging policy, reply handling | Replaced by `ARC-GO-300` and `ARC-GO-310`. |
| `ARC-LR-420` | Provider actions and booking coordination | Reduced to a booking link or owner handoff in `ARC-GO-310`. Connector actions paused. |
| `ARC-LR-430` | Follow-up sequences and stop conditions | Replaced by `ARC-GO-310`. |
| `ARC-LR-440` | Operator console, evidence timeline, manual controls | Reduced to the minimum in `ARC-GO-310`. |
| `ARC-LR-450` | Outcome proof, reporting, health | Replaced by `ARC-MK-210` and `ARC-MK-220`. |
| `ARC-OPT-460` | Outcome attribution and anomaly detection | Paused until real pilot data exists. |
| `ARC-OPT-470` | Diagnosis and recommendation engine | Paused. |
| `ARC-OPT-480` | Client recommendations and guided experiments | Paused. |
| `ARC-QA-500` | Security, RLS and idempotency suite | Replaced by `ARC-GO-320`. |
| `ARC-QA-510` | Synthetic end-to-end and failure scenarios | Replaced by `ARC-GO-320`. |
| `ARC-OPS-520` | Deployment, monitoring, incident readiness | Replaced by `ARC-GO-330`. |
| `ARC-PILOT-530` | First HVAC design-partner pilot | Replaced by `ARC-GO-340`. |

Also paused, with no ID:

- New CRM screens: locations, service areas, field-by-field record policy.
- Connectors to Jobber, Housecall Pro, ServiceTitan or GoHighLevel, until the manual path is
  proven.
- A client sending messages by hand from the conversation screen.
- A calendar adapter and customer appointment notices.
- Client-facing self-serve onboarding.
- The n8n bridge in production. It stays built and disabled; Lead Recovery never needed it.
- Named AI agents as a customer-facing offer, and the internal 3D operations view. Internal
  ideas only; neither is on the path to the pilot.
- Dispatch, invoicing, payments, payroll, inventory, voice AI, a workflow builder.

Bring a paused item back only when the pilot's own evidence asks for it.

---

## 9. Already built

All complete and on `main`. The detail for each is in `docs/architecture/` and `CLAUDE.md`.

| ID | What it delivered |
|---|---|
| `ARC-000`, `ARC-010` | Repository audit and the ARC–n8n boundary decision |
| `ARC-015`, `ARC-015B` | Lead Recovery safety and configuration pinning |
| `ARC-100` | Module and connector registries |
| `ARC-110` | Versioned client configuration |
| `ARC-120` | Module lifecycle and the activation gate |
| `ARC-130` | Provider connections, credentials in Vault |
| `ARC-200`, `ARC-210` | Durable runs, actions, scheduling and the runner contract |
| `ARC-220`, `ARC-230`, `ARC-240` | The n8n bridge, workflow manifest and shared workflows (disabled in production) |
| `ARC-300`, `ARC-310`, `ARC-320` | Client creation, settings and the activation page in the console |
| `ARC-330` | The three-route model |
| `ARC-340` | The CRM core, and the portal clarity pass |
| `ARC-350` | Native lead capture: hosted forms, API, typed-in leads, CSV |
| `ARC-360` | Lead inbox, pipeline and CRM workspace |
| `ARC-370` | Conversations and messages |
| `ARC-380` | Scheduling and the hosted booking page |
| `ARC-390` | Route-aware onboarding for operators |

The Lead Recovery engine itself predates these IDs (migration `0010`).

---

## 10. Gates that code alone does not close

| Gate | What closes it | Needed for |
|---|---|---|
| Real telephony | Verification against a live Twilio account | `ARC-GO-330` |
| Business-text registration | An approved registration per client | `ARC-GO-340` |
| Live backend | Remaining functions deployed, staging level with live | `ARC-GO-330` |
| Silent-client detection | An automatic check; alerts are raised by hand today | `ARC-GO-330` |
| Provider connections in production | The hosted Vault checklist | Paused connectors only |
| n8n bridge in production | A recorded licensing decision | Nothing on this roadmap |

Owner tasks, independent of the build: find and sign the design partner; agree the pilot
numbers; supply the real screenshots the site still shows as placeholders; move the public and
operator addresses to a domain mailbox; turn on MFA for the operator account.

---

## 11. Rules that still hold

1. Build once, configure per company. A client is configuration, never a copied workflow.
2. Only provable results. "Not enough evidence" is a valid answer, and it is never billed.
3. Stop after a reply. Honour opt-outs at once. A person taking over blocks automation.
4. Safety is decided by rules; a model can only add caution, and never writes a message.
5. Every send is durable and happens once. An unknown outcome is never resent.
6. Every figure is derived from the `events` log. A figure that is not available is a dash and
   the reason, never a zero.
7. Words on screen are the system's words, each with its meaning attached.
8. Owner-facing copy is plain: missed call, text back, booked job, needs you, proof.
9. Customer data is exportable.
10. Breadth waits. The business must be understandable, and one loop must work in the real
    world, before anything is added.

---

## 12. How to use this file

- Run one prompt ID at a time. Read `CLAUDE.md` first; where it and this file disagree on
  repository conventions, follow `CLAUDE.md` and say so.
- For each ID, report the files changed, the tests run, whether it is visible on the live site
  or backend only, what needs deploying, and what Bennett should click through by hand.
- Keep this file current when a step ships: change its status in section 3, and update
  sections 1 and 2. The console's Roadmap Assistant answers from this file as it is on `main`.

# Changelog

All notable changes to this site (portfolio + the Arc client portal) are
documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versioned with
[Semantic Versioning](https://semver.org/) via `package.json`.

## [Unreleased]

## [1.17.1] - 2026-09-22

The marketing site was smooth on a desktop and heavy on everything else. The
cause was not one expensive animation — it was cheap ones that never stopped.
Three marquees wrote a transform every frame for the life of the tab; the nav's
two glow rings and the film's live dot ran their keyframes whether or not
anyone could see them; five demos kept their CSS going after their JavaScript
had correctly stopped; and the speed-to-lead spark travelled by animating
`left`, which lays the whole document out again sixty times a second.

Measured on a 390×844 viewport, sitting still at five points down the page,
median of five alternating runs against the previous build:

| | before | after |
|---|---|---|
| style recalculation | 175 ms/s | 77 ms/s (−56%) |
| script | 65 ms/s | 30 ms/s (−54%) |
| layout | 20 ms/s | 5 ms/s (−75%) |
| forced layouts, projects section | 170 /s | 9 /s (−95%) |

Nothing was removed from the design. Every animation that was there is still
there, on the devices that were already running it well.

### Changed

- Every decorative loop on the site now runs behind one gate (`useAnimate` in
  `src/lib/hooks.js`): on screen, in a tab someone is looking at, and not
  overridden by a motion preference. Marquees, the headline cycler, the pixel
  guy's blink and cursor-tracking, the roamer, the walker and all five project
  demos were each holding a timer or a frame request open permanently.
- CSS keyframes are parked alongside the JavaScript that drives them. A demo
  that scrolls away pauses its caret, chip scan and call ring (`.demo.is-idle`);
  the portal film parks its live dot (`.pf.is-idle`). Paused, not removed — a
  demo that comes back carries on rather than snapping.
- `WarmGrid` draws its dot grid as one repeating pattern instead of seventeen
  hundred `fillStyle`/`fillRect` pairs per frame, caps the backing store below
  the panel's pixel ratio, and parks its frame loop when the grid has settled
  rather than asking for frames forever.
- Lenis is not built on a touch device. It never smoothed touch scrolling —
  that is off by default and deliberately so — but it held a `gsap.ticker`
  frame loop open and routed every scroll event through `ScrollTrigger.update`.
- The glow button's ring and dot get their own compositor layers, and the ring
  stops spinning on a coarse pointer, where the nav is on screen the whole way
  down the page and nobody is hovering to see it.
- On a device that reports few cores, little memory, data saver or a coarse
  pointer (`useWeakDevice`), the portal film moves its hand with a CSS
  transition instead of a framer-motion spring, and steps its nine counters
  with a CSS keyframe instead of a measured `popLayout` swap. The demos that
  type lay down three characters per tick over the same wall-clock time rather
  than one, cutting their render rate by two thirds.
- `PixelGuy` measures its own box on scroll and resize and caches it, instead
  of calling `getBoundingClientRect` inside a `mousemove` handler — which
  forced a layout every frame the mouse moved, once per guy, with up to four
  on screen at a time.

### Fixed

- The speed-to-lead spark animated `left`, a layout property, so every frame of
  every spark laid out the whole document. It now travels on `transform`, which
  the compositor owns: 170 forced layouts a second in that section became 9.
- The missed-call ring pulsed on `box-shadow` spread, which cannot be
  composited. It is a scaling ring now — same picture, no main-thread paint.

### Changed (deployment)

- Site moves off the `github.io/Arc-Automations` subpath onto the custom
  domain `arcautomation.site`: `vite.config.js` builds from `/` instead of
  `/Arc-Automations/`, and `public/CNAME` tells GitHub Pages the new domain on
  every deploy.

## [1.17.0] - 2026-09-19

Needs `supabase/migrations/0010_lead_recovery.sql` applied (after 0009), the
`twilio`, `lead-intake` and `dispatch` functions deployed, and `ingest` and
`ops` redeployed. Until then the portal runs exactly as it did: the console's
Lead Recovery panel answers 501 naming the migration, and nothing else changes.
Full runbook, including the exact webhook URLs to paste into Twilio, in the new
[DEPLOYMENT.md](DEPLOYMENT.md).

Every module before this one **observed**. An adapter watched somebody else's
system and posted evidence of what it saw; the portal folded that evidence back
into records. Nothing in this repository had ever decided what happens next.

**ARC Lead Recovery decides.** A call reaches an ARC/Twilio number, is
forwarded to the contractor, and the one that rings out becomes a lead, an
automation run and a text back — then the reply is read, classified, and either
routed to the contractor or stopped and put in front of a person. Website-form
leads go through the same engine, not a copy of it.

It is one shared system. One module, one prompt, one set of templates, one
deployment. A customer differs only in `module_configs.config`, and there is
no per-client workflow, schema, branch or deploy anywhere in it.

### Added

- **The execution layer's schema (`0010`).** Ten tables — `module_configs`,
  `intake_keys`, `leads`, `conversations`, `messages`, `automation_runs`,
  `scheduled_actions`, `handoffs`, `suppressions`, `module_onboarding` — and
  one function, `claim_scheduled_actions`.

  0009 deliberately added no tables, because the client's CRM was the system of
  record for an estimate and a synced copy of it would be stale between syncs.
  That reasoning does not transfer: nobody but Arc knows that a follow-up is due
  at 14:20, that two workers must not both send it, or that this run stopped
  because the customer texted STOP. So the split is explicit and is the rule for
  everything new — **operational tables hold current state and what must happen
  next; `events` stays append-only evidence, and no figure on any page reads an
  operational table.** The one derivation chain the whole product rests on is
  untouched.

  RLS on all ten. Clients read their own rows, operators read everything, and
  **no insert, update or delete policy is created for any role** — that absence
  is the write protection, exactly as `admin_actions` has been append-only since
  0004. Every relationship between two of them is a composite foreign key
  through `(id, tenant_id)`, the trick 0008 used for service steps, so a
  cross-tenant link is structurally impossible rather than merely prohibited.

- **A deterministic state machine** (`_shared/engine/state-machine.ts`), not a
  collection of timers. Eleven states, an explicit transition map, and an
  invalid transition **throws** rather than clamping to the nearest legal state
  — a run that tried to go from `suppressed` back to `awaiting_reply` would text
  somebody who opted out. `maySend(state)` is asked once, in one place;
  `handoff_required` and `handed_off` are not on the list, which is the entire
  point of them. The state list is duplicated as a check constraint in the
  schema, and a test asserts the two are identical.

- **A durable action queue and a dispatcher.** Everything the engine will do in
  the future is a row with a time, an idempotency key and an attempt count —
  never a `setTimeout`, never a sleeping workflow, never a cron that re-derives
  intent from the log. The dispatcher claims work under `for update skip
  locked`, then **re-reads the world before acting**: is the run terminal, is
  the contact suppressed, did the customer reply, has a person taken over. Each
  is asked of the database rather than of the action's payload, because the
  payload is a snapshot of the past — and the gap between queueing tomorrow's
  follow-up and sending it is exactly where the STOP arrives.

  Transient failures retry with bounded exponential backoff (60s → 30 min,
  deliberately un-jittered so an operator can read the retry time off the
  queue). When the retries are gone the work does not disappear into a failed
  row: it opens a handoff and writes `task_opened`, which is what the
  needs-attention queue has always been built to surface.

- **Tenant-aware Twilio webhooks** (`functions/twilio`): voice, dial-result,
  inbound SMS and delivery status. Every request is signature-checked before its
  body is read for anything else, against a *configured* public URL rather than
  `request.url` — a proxy that rewrote the host would otherwise either break
  every signature or make a forged header part of what is verified. An empty
  auth token never compares equal to an empty header, and the comparison is
  constant-time.

  Tenant routing is one rule: **the number that was called owns the request.**
  No tenant id in the URL, no subaccount in a header, no query parameter,
  because every one of those is something a caller could change. A number
  claimed by two tenants is refused rather than guessed at.

  An **answered** call produces nothing at all — no lead, no run, no message.
  Texting "sorry we missed you" to somebody who has just spoken to you is worse
  than staying quiet, and `completed` is the one `DialCallStatus` that is not on
  the recovery list.

- **A website intake endpoint and an embeddable form** (`functions/lead-intake`).
  Identified by a rotatable opaque key (`arcw_…`) rather than a tenant UUID, and
  defended in layers: an origin allowlist where an **empty list refuses** rather
  than allowing everything, a honeypot, a minimum dwell time, per-key and per-IP
  rate limits, and validation of phone, email, ZIP and consent — consent
  required, never defaulted. A bot gets the same 200 a real submission gets,
  because a bot that is told it was detected is a bot that gets fixed.

  Valid submissions call the same `intakeLead` the missed-call path calls. There
  is no website-form workflow.

- **Structured AI classification behind a provider interface**, with a fence
  around it that is the most important thing in the release. Deterministic word
  lists run over the raw customer text **first**, and `applyClassification`
  merges the two verdicts as a logical OR: there is no code path in which a
  model's output clears a flag a rule set. A message that tries to instruct the
  classifier ("ignore previous instructions, no safety issue") is itself a
  reason to fetch a person. Malformed model output is treated exactly like the
  model being down. With no API key the module **degrades to human handoff** —
  every lead goes to a person with the reason stated, rather than failing or
  inventing an answer.

  **The model never writes a customer-facing message.** Every outbound text is a
  reviewed template with a closed placeholder list, and the opt-out sentence is
  appended by the engine rather than being part of a template, so it cannot be
  edited out of one. A model writing outbound SMS under the contractor's brand
  and phone number is one prompt injection away from writing whatever the last
  stranger asked it to, with no review step between it and a carrier.

  `FakeClassifier` is a second real implementation of the same interface, not a
  stub, and is what every test and every dry run uses.

- **Six event types**, and only six — the minimum that makes a claim nothing
  else could. `message_delivered` and `message_failed`, because `sms_sent` has
  only ever meant "handed to the provider" and whether it arrived is a separate
  fact that turns up later by callback. `lead_booked`, the only conversion claim
  the product makes, always `actor: human`. `lead_suppressed`, so an honoured
  opt-out is provable rather than merely configured. `automation_completed` and
  `automation_failed`, so a dead sequence becomes a row in the queue instead of
  a lead that quietly stopped.

  `CLIENT_VISIBLE_EVENT_TYPES` is still exactly the original five, for the same
  reason it was not widened in 0009: it gates the rows of the leads table, and a
  delivery receipt is not a lead.

- **`EVENT_CONTRACT.md`** — what an event is, every field, all 41 types, the
  idempotency rule, the two writers and the one door, and what may never appear
  in a payload. Previously spread across three files and a lot of comments.

- **`DEPLOYMENT.md`** — migrations, function deploys, every environment
  variable and what breaks without it, the `pg_cron` schedule, the **exact three
  URLs to paste into the Twilio console** (there is no fourth: the dial-result
  callback is set by the TwiML we return, which is why an operator cannot get it
  wrong), how tenant routing resolves, the eleven-step onboarding, and how to
  test all of it locally. It also states plainly what has *not* been verified
  against a live Twilio account.

- **A Lead Recovery panel on the ops client page.** Configure, validate as you
  type, see compliance status, test phone routing, run a synthetic canary,
  pause or resume, retry failed actions, take a lead over, resolve a handoff,
  issue or rotate the website form's key. Two controls can touch the outside
  world and neither can reach a member of the public: *test routing* is a
  computation that returns the TwiML that would be produced, and *canary* runs a
  synthetic lead with a recording sender in both sender slots, addressed to
  Twilio's reserved test number. The panel says so beside each of them rather
  than expecting anyone to take it on trust.

  Deliberately absent: a drag-and-drop workflow builder, and a button that buys
  a phone number. Provisioning is billable and externally visible, so a person
  does it in the Twilio console and records the reference.

- **A fail-closed onboarding checklist.** Eleven steps, eight required.
  Activation re-validates the configuration, re-checks compliance and the
  Twilio references, and re-reads the checklist from the database. There is no
  override parameter: the way to activate a module whose campaign is not
  registered is to register the campaign. When it refuses it returns every
  reason at once, because an operator working through onboarding wants the list,
  not a door that opens one inch per attempt.

- **130 tests**, each named after the promise it keeps rather than the function
  it calls: cross-tenant isolation, invalid and tampered Twilio signatures,
  duplicate webhooks, an answered call creating nothing, a missed call queueing
  exactly one response, the form and the call being the same engine, a reply
  cancelling pending automation, STOP creating a suppression, safety language
  forcing a handoff, low confidence forcing a handoff, delivery failure being
  recorded, transient failure retrying, permanent failure creating a human task,
  two dispatchers not executing the same action, a disabled or unapproved tenant
  not sending, a canary not reaching a handset, and no secret appearing in any
  event. Plus a set that reads the migration itself and asserts RLS is enabled
  on every new table, that no write policy exists, and that the schema's state
  list matches the engine's.

### Changed

- **The event validator moved to `functions/_shared/event-validation.ts`**, and
  the idempotent write to `_shared/event-writer.ts`. Arc now emits events as
  well as receiving them — the engine writes `sms_sent`, `message_delivered`,
  `lead_booked` and the rest from inside three functions — and those rows must
  be identical in shape and discipline to the ones an outside workflow posts. An
  internal writer with its own looser path would be a second door into the only
  append-only table in the system, and the first event with a defaulted
  `occurred_at` would make every figure derived from the log arguable.
  `ingest/validate.ts` re-exports the new home, so the boundary keeps its
  documented name; `/ingest` remains the only *external* ingestion endpoint.

- **The client Leads page shows outcomes rather than implementation noise.**
  The stat rows are now opportunities in, median response, customers who
  replied and booked; then qualified, handed to a person, messages that failed
  (sends *and* carrier rejections, with the delivered count beside them) and
  opted out. Three new filter chips — booked, not delivered, opted out — and a
  row that says which of those happened. An expanded row carries the delivery
  time, the carrier's refusal if there was one, the booking and its value, and
  the opt-out if there was one.

  Booked and opted out are gated the way `qualified` already was: a client whose
  leads arrive through an observing adapter has no bookings because nothing is
  recording them, and the card reads `—` with the reason rather than `0`. That
  is the same rule `modules.js` enforces one level up.

- **`ops` gained fourteen Lead Recovery actions**, delegated whole to
  `ops/lead-recovery.ts` behind the existing admin check and audit helper.
  `capabilities` now also reports, as booleans only, whether the Twilio
  credentials, the classifier key and the dispatch key are set.

- **A failed edge-function call carries its whole body on the error.** Some
  refusals are a list rather than a sentence — activation answers 409 with every
  unmet condition — and a caller that only saw `.message` would show the
  operator one of five reasons and make them press the button again to learn the
  next. `.message` is unchanged, so nothing that reads only that behaves
  differently.

- **The demo generates the execution layer too**, as a fourth pass that runs
  after everything else and only reads the finished threads back — so not one
  draw above it moves and every figure on every page that existed before this
  release is identical. Roughly 4% of sends are refused by the carrier with a
  real Twilio code and end the run on a failure; a few customers opt out; the
  ones who replied get booked with a real amount. A demo in which every text
  arrives would demonstrate the wrong thing, on exactly the logic as the two
  baked-in incidents.

### Fixed

- **An ops disclosure header no longer pushes the page sideways on a phone.**
  `.ops-disclosure__summary` was `white-space: nowrap` with `margin-left: auto`
  in a flex row that could not shrink, so a summary longer than about four words
  overflowed the viewport. Existing sections all had short ones and never showed
  it. The header now wraps, and on a phone the summary drops under the title,
  indented past the chevron so the two lines read as one header.


## [1.16.1] - 2026-09-18

### Changed
- **The hero's portal film shows the portal as it is now.** It was still
  cutting the speed-to-lead dashboard from before 1.16.0 — a five-item rail, an
  overview of four cards and a feed, a leads table with no routing — so the
  loop on the homepage no longer matched the demo it links to. It now walks the
  revenue-lifecycle workspace: the rail's six modules with their needs-you
  counts on hairline tiles, the top bar, "all systems operational", the
  needs-a-person queue, both stat rows (open quoted work, recovered revenue),
  the lifecycle strip, and the chart beside the activity feed. The page scrolls
  as a person would; the demo's own newest lead lands in the feed and steps
  captured and then qualified up to the demo's figures; then lead capture is
  opened, narrowed to "needs you", and an emergency is opened to show it was
  texted back in 6.8s and handed to a person 92 seconds later. Every figure is
  the one `/demo` renders, so the film finishes on the dashboard a visitor
  lands on when they click through. Reduced motion still gets the last frame.
- The film's rail and table columns are sized off its type scale rather than
  fixed pixels, so nothing truncates at 1920 that fits at 1440, and on short
  (≤800px) screens the queue shows two items so the first frame keeps the stat
  row.

## [1.16.0] - 2026-09-17

Needs `supabase/migrations/0009_lifecycle_modules.sql` applied (after 0008),
and the `ingest` function redeployed so it accepts the new event types. Until
then the portal runs exactly as it did: the browser detects the missing columns
and falls back to the old read, and the new pages stay out of the rail for every
client until an operator lists their modules.

The portal was a speed-to-lead dashboard. It is now the whole revenue
lifecycle — what came in, what got quoted, what got decided, what got reviewed,
what got retained, and what still needs a person — without a second architecture
underneath it. Every figure still comes out of the same `events` log through the
same derivation chain, and the demo still runs the real product against
generated data.

### Added
- **Four new pages: estimate recovery, reviews & service recovery,
  memberships, and install & warranty.** Each one is the same shell, the same
  components and the same `ws-*` design language the dashboard already had. The
  leads page grew into **lead capture** — qualification, routing destination,
  consent and human handoff — without gaining a column, because it is the page
  people open from a truck and its phone layout is hand-placed.
- **The lifecycle strip on the overview**: captured → qualified → estimated →
  approved → installed → retained, as real record counts, each linking into the
  table behind it. No percentages between stages: they come from separate
  systems over different windows, and a conversion rate drawn between two
  unrelated populations is arithmetic, not a fact.
- **One needs-attention queue across every module**, sorted by urgency, then by
  what is already late, then oldest first. Derived from the state of the records
  rather than stored, so an item leaves the queue the moment the thing it is
  about stops being true — no write anywhere, nothing to go stale.
- **Per-module automation health, derived from verification evidence only** —
  the canary, the schema assert, the volume watermark, delivery failures,
  authentication failures and silence. A module producing events with nothing
  checking it reads **not verified**, in its own colour, with the missing check
  named. A workflow platform reporting a green execution is never enough on its
  own.
- **The activity feed spans every module**, filterable by module, by failures,
  by human actions, and — behind its own filter — by the internal verification
  rows that are still kept out of the default view.
- **An event contract at the ingest boundary**: `entity_type`, `entity_id`,
  `source_system`, `external_id`, `actor` and `error_class`, all optional, all
  validated. An `entity_type` with no `entity_id` is now a loud 400 rather than
  a row no page will ever show.
- **`npm test`** — 122 tests on node's built-in runner, no new dependencies.
  They test the promises rather than the arithmetic: stop-on-reply, review
  gating, safety handoff, registration evidence, attribution, tenant isolation,
  idempotency, and that none of it broke the pipeline that came first.
- **`npm run smoke`** — renders all fourteen pages in a real browser at desktop
  and phone widths and fails on an uncaught error, a blank render or a layout
  that scrolls sideways. Drives an installed Chrome or Edge through
  `playwright-core`; skips cleanly when it is not installed, so it is not a
  dependency.

### Changed
- **The demo now runs all five modules** — an estimate book, completed jobs and
  reviews, a membership roll and install closeouts for Halstead Restoration, on
  the same seed and the same deterministic generator. Two things in it are
  deliberately not clean: one review request withheld for a sentiment reason,
  and one registration reported complete with no confirmation number. Both are
  caught, named and queued, which is the product working.
- **Money is only ever claimed with the whole chain behind it.** "Recovered"
  needs the original estimate with an amount, a follow-up that actually left,
  the customer's answer after it, and the approved value from the client's own
  system. An approval with no follow-up behind it is reported as approved and
  explicitly **not** attributed. Gross profit additionally needs a margin the
  client's system sent, and where it covers only some of the jobs the card says
  how many.
- **A module that is not connected renders as unknown, never as zero.** Three
  states — live, awaiting connection, not part of your plan — decided from the
  tenant's declared modules and what the log actually shows, with observation
  always winning. A missing tick-box can never hide a client's own data.
- Estimate flow figures (created, contacted, decided, recovered) are now
  windowed by when they happened, and state figures (open, held back) are not.
  Mixing the two had the funnel reporting more approvals than estimates.
- The rail's module counters show what needs doing, not how much exists.
- Customer contact details and anything credential-shaped are stripped from the
  activity feed's metadata before it reaches the browser.

### Fixed
- A duplicate event can no longer inflate the count of follow-ups sent to a
  customer. The database's unique index was already the real defence; the fold
  now dedupes as well, because that count is one of the four links the word
  "recovered" depends on.
- `buildDashboardData` drops any event carrying another tenant's id before
  deriving anything. RLS is still what enforces isolation — this fails closed if
  a future caller ever assembles events from more than one source.

## [1.15.0] - 2026-09-16

Needs `supabase/migrations/0008_client_services.sql` applied (after 0007).
Until then the console loads as before, each client page says the checklist
is not set up, and the Supabase page names the migration.

### Added
- **Choose what a client bought when adding them.** "Add a client" has a
  **what we're building** picker listing every service Arc sells (the ids,
  names and stacks come from `site.js`, core offers first), and the account
  cannot be created without at least one. The services and their checklists
  are written right after the account in one transaction
  (`add_client_services`); if that write fails, the page says so and offers a
  retry, since the account itself already exists.
- **A build checklist for every service.** Each client page has a **what
  we're building** panel: one section per service, with its steps in two
  phases, **build it** (on Arc's side) and **integrate it** (into their
  business, on real traffic). Tick steps as the work gets done, add a step
  just for this client, remove one that doesn't apply, add another service
  later, or remove one. The stage (not started → building → integrating →
  delivered), the progress bar and the delivered date all come from the
  ticked steps, never from a status someone set.
- **Steps the console can confirm show what it sees.** Under steps like "a
  real lead answered", "it posts its events to their portal" or "their
  texting number is live and recorded", the checklist shows what the event
  log, the ingest tokens or the services panel says. A ticked box the
  evidence doesn't back up is marked, and the service header counts them
  ("1 to check"). A service's header also lists the accounts it runs on,
  marked where they are recorded.
- The account column on the roster and clients list shows each client's build
  progress under the status pill: `build 14/30`, `3 delivered` or
  `no services`.
- Catalog of checklists for all twelve services in
  `src/portal/lib/service-catalog.js`. Steps are copied into the database when
  a service is added, so later catalog edits only affect new builds.
- Migration 0008: `client_services` and `client_service_steps`, readable and
  writable only by operators. A composite foreign key stops a step from being
  attached to another client's service, and a trigger records when a step was
  ticked and by whom using the database's clock, so the browser cannot
  backdate a tick.

### Changed
- Ticking a step refreshes only the checklists rather than the whole roster
  (`reloadBuilds`). Only the newest refresh is applied, so rapid ticks don't
  flicker.

### Fixed
- In the clients table, the leads cell no longer stops short of the row's
  height. `ws-table__strong` on a `<td>` was `display: block`, the same bug
  1.14.0 fixed for `ws-table__sub`.

## [1.14.0] - 2026-09-16

Needs, before the new console features work on the live site:
`supabase/migrations/0007_client_offboarding.sql` applied,
`supabase functions deploy ops`, and (for the workflow checks)
`supabase secrets set N8N_API_URL=… N8N_API_KEY=…`. Until then the console
says which step is missing, and the pipeline column falls back to the event log.

### Added
- **A live pipeline check.** The console asks, when it opens, every five
  minutes after, and on demand ("checked 15:11" in the top bar, "check again"
  on a client), whether each client's pipeline is actually connected: the
  ingest endpoint answers, the client holds a token n8n is using and when it
  last did, the last event is inside that client's normal quiet stretch, their
  n8n instance answers `/healthz`, and each workflow is switched on in n8n with
  its last execution's result. The facts come from a new `probe-pipelines`
  action on the `ops` function (the n8n key stays a function secret); one
  function, `pipelineVerdict` in `lib/ops.js`, turns them into **connected**,
  **partly connected**, **not connected** or **not set up**, with the cause
  named — "Speed-to-Lead: switched off in n8n", not just a red pill. The roster's
  pipeline column, the "needs looking at" list, the rail lamp and a new
  checklist panel on each client page all read that one verdict.
- **Deboarding.** A "deboard this client" panel at the foot of every client
  page lists exactly what will change for that client, asks why they are
  leaving, and takes their typed name as confirmation. One transaction
  (`deboard_tenant`, migration 0007) revokes every ingest token, removes every
  login's access, retires every connection and archives the tenant with the
  date, reason and a note; the `ops` function wraps it and writes
  `client.deboarded` to the audit log. Optionally deletes the login from auth
  when it belongs to no other client and is not an operator. Nothing is
  deleted — events, incidents and reports stay — and subscriptions Arc pays
  for are listed with billing links, because deboarding cancels nothing.
- **Past clients** page (`/ops/console/past-clients`): when each client left,
  why, how long they were with Arc, their last event, a report from their
  history, and restore. Restoring (`restore_tenant`) puts them back as paused,
  onboarding or active with old tokens still revoked and access not re-granted.
- Plain-words `?` hints on the terms that needed one (account vs pipeline,
  median reply, marked as vs actually sending, typical reply time), a "how to
  read the pipeline column" legend on the roster, each nav item's description
  on hover, and the page's description inside the page when the top bar is too
  narrow to show it.
- The Supabase page says when migration 0007 is missing, when the deployed
  `ops` function predates the new actions, and whether n8n access is set.

### Changed
- **The `/ops` door no longer looks like the client portal.** It was a copy of
  `/portal` with different words — same ASCII wordmark hero, headline, sales
  panels and stylesheet. It is now a staff entrance built from the console's
  own parts: a `restricted` bar, a strip of readouts, a square access panel
  with the password as a `>` prompt, and an index of every console page read
  from `ops-nav.js`. The supabase readout is a real round trip to the project's
  auth health endpoint with its response time, not "configured"; the session
  readout says "signed in" rather than "active". Styles moved to `OpsHome.css`.
- **Icons are bigger and easier to find.** Nav icons are 18px on their own
  square tile in `--muted` instead of 16px scratches in `--faint`, every icon
  is drawn at a 1.5 stroke, top-bar icons are 19px in bordered buttons, button
  glyphs are 16px, and the rail's type is a size up. Applies to the client
  portal too — it is the same shell.
- **No checks is no longer "operational".** A client that has never run an
  end-to-end check used to show a green "all systems operational" on their
  dashboard and "live" in the console. `computeStatus` now returns
  `unchecked`, shown in grey as "no end-to-end check has run yet" — on both
  sides, so the console and the dashboard still agree.
- The roster's "pipelines down" card is "pipelines connected", from the live
  check; the rail reads "N connected" instead of counting clients typed active.
- Ingest tokens show **in use**, **never used** or **revoked** instead of an
  "active" that only meant not-revoked.
- "archived" is gone from the status dropdowns — archiving by hand left tokens
  valid. Past clients are out of every total, the clients list and the live
  check.

### Fixed
- **The "raise an alert" fields were white.** They were the only bare
  `<select>`/`<textarea>` in the console; they now use the console's inputs,
  and every console field is a step darker than the panel it sits in.
  `color-scheme: dark` on the portal keeps native dropdowns and pickers dark.
- The clients page export produced a file of empty cells — it passed header
  strings to a CSV helper that takes column objects.
- A table cell classed `ws-table__sub` was `display: block`, which pulled it out
  of the table and stacked columns under each other.

## [1.13.0] - 2026-09-16

### Added
- **Client reports as a PDF, from the ops console.** Every row of the client
  list (roster and clients page) has a **generate report** button, and so does
  the header of each client page. It opens a report builder over the page:
  - **period** -- last 7, 15, 30, 60 or 90 days, this month, last month, or a
    custom range of up to 366 days, each compared with the same-length span
    before it.
  - **who it is for** -- *for the client*, where a service Arc pays for reads
    "covered by arc" with no cost; or *internal*, which adds every cost, the
    account on each service, whether each connection is still sending, and
    the monitoring workflows.
  - **what goes in it** -- lead volume, response speed, where leads came from,
    when they arrived, who the work went to, automations, reliability and
    incidents, services and subscriptions, a lead log (off by default: it
    carries customer names and numbers) and a how-to-read page. The cover,
    headline figures and a written summary are always included.
  - a "prepared for" name and a note from Arc, both printed on the report.
  - a live preview that redraws as the choices change, **download pdf**, and
    **open to print**.
- **The summary is written from the report's own figures**: leads and the
  change, median and 9-in-10 reply time, share answered inside a minute,
  missed calls answered, the after-hours share, customer replies, failed sends
  and the usual reason, the end-to-end check pass rate, incidents, failing
  automations, and any subscription that is past due, cancelled while still
  connected, or renewing within 7 days.
- Every figure runs through `statsForRange` and the `derive.js` readouts, so a
  report's "last 30 days" prints the same numbers as the roster and the
  client's own dashboard. The events are read fresh from Supabase for the
  chosen window (`lib/report-data.js`) rather than taken from the roster's
  61 days, so August or the last quarter can be reported on.
- `jspdf` dependency, loaded only when the report builder opens. The PDF embeds
  Latin subsets of Space Grotesk and IBM Plex Mono, renamed "Arc Report Sans"
  and "Arc Report Mono" as the Open Font License requires of a modified copy;
  both licences sit beside the files in `src/portal/report-fonts/`.

### Changed
- `derive.js` exports `comparison` and a new `windowCovered` (previously inline
  in `computeDeltas`), so a report's period comparison is held back under the
  same coverage rule as the dashboard's.

## [1.12.1] - 2026-09-16

### Fixed
- **A client whose n8n workflows are sending no longer shows n8n as
  "connect".** The service cards only looked at connections entered by hand,
  so a client with months of events from n8n still showed a connect button
  if nobody had added an n8n row. Every event arrives from an n8n workflow,
  so any workflow activity now marks n8n connected. The card shows how many
  workflows, how many events and when the last one was. If no row exists
  yet, its button is **record it**: it opens the form already set to
  connected, with no sign-up tab. Other services are not inferred this way,
  because a Twilio send arrives as an n8n event, not as proof of the Twilio
  account.

## [1.12.0] - 2026-09-16

### Added
- **Services & subscriptions on every ops client page.** A table of the
  accounts each client's automation runs on (n8n, Twilio, OpenAI, ...) showing
  whose account it is, the key by its last four characters, where the real key
  is stored and when it was last checked, the subscription state, cost, who
  pays, and when it renews. Renewals within 7 days are flagged amber. Past-due
  and cancelled-but-still-connected are flagged red. A renewal date that has
  passed asks you to confirm the charge rather than claiming a lapse. **paid**
  rolls the renewal forward one cycle and **key ok** stamps the key as checked.
  Monthly totals are split into what Arc pays and what the client pays.
- **Connect a service.** A grid of 15 services, each marked *connected* or
  showing **connect**. Connect opens the provider's sign-up in a new tab and
  opens a form on the page to record the account, key hint and billing. Cards
  that are already connected show **manage** instead. Each row links straight
  to the provider's billing and API-key pages.
- Migration `0006_connection_billing.sql`: `provider`, `account_ref`,
  `credential_hint` (limited to 4 characters, so a full key cannot be saved),
  `credential_location`, `verified_at`, `billing_status`, `paid_by`,
  `cost_cents`, `billing_cycle` and `renews_at` on `connections`. The console's
  Supabase page now says when it is missing.

### Fixed
- Editing a connection no longer resets its `expected_quiet_hours` to empty.
  The form never passed the value back, so every save cleared it.

## [1.10.6] - 2026-09-16

### Removed
- The "northern utah" location chip from the hero, its ticker entry, and the
  "Northern Utah" mention in the meta description.

## [1.10.5] - 2026-09-16

### Changed
- **The headline is big again.** 1.10.4 fixed the words breaking apart but
  sized the type at 11% of its column, which put it at 50-63px -- a third of
  the 156px billboard it was before the split. It is now as large as the
  column allows with "we don't just" still on one line: that line measures
  5.762em in Space Grotesk at weight 600 with this letter-spacing, read off
  the font file's advance widths rather than estimated, so `16cqw` fills 92%
  of the column. 122px on a 1920px screen, 82px at 1440.
- **The copy column grows faster to make room** --
  `clamp(380px, 60% - 280px, 760px)` -- and the hero now uses the full
  viewport width up to 2200px rather than sitting in a centred 1560px box, so
  most of that room comes out of the side margins rather than the film. The
  film is unchanged at 1180px (675px), about 9% narrower at 1440-1920px, and
  at its full 1160px on wider screens.
- **The location chip is back** where the column fits the button row, and
  wraps under the buttons where it does not.

### Removed
- `overflow-wrap: anywhere` on the headline. It is what split "don't" and
  "templates." mid-letter. An overflowing line now breaks at a space.

## [1.10.4] - 2026-09-16

### Fixed
- **The headline was rendering at its full billboard size inside a 360px
  column, and breaking words apart to fit.** Not the `ch` unit this time --
  that was real but it was the second bug, not the first. The `@media
  (min-width: 1180px)` block sat *above* the base rules in `Hero.css`, and a
  media query adds no specificity: `.hero__title` inside one and
  `.hero__title` outside it are the same weight, so the later of the two wins,
  and the later one was always the base rule. The split layout's
  `font-size` never applied once, at any point since it was introduced in
  1.10.0. Four rules were affected the same way -- `.hero__title`,
  `.hero__sub`, `.hero__foot` and `.hero__row`. The ones that did work
  (`.hero__grid`, `.hero__copy`, `.hero__stage`, `.hero__roam`) are exactly
  the ones whose base declarations come *before* the block, which is why the
  film kept moving and growing correctly while the headline never shrank.

  Every breakpoint block now lives at the bottom of the file, after the rules
  it overrides, with a note at the top saying why the order is load-bearing.

### Changed
- **The headline is sized against its column, not the viewport.** `11cqw` --
  eleven percent of the copy column, which is the ratio the full-width
  headline always had to the hero around it (156.8px of type in a 1432px
  container). Stating the ratio directly means the type and the column cannot
  drift apart at some width nobody checked, which is what every version of
  this bug has been. The column is `clamp(380px, 33%, 580px)`: a share of the
  grid rather than of the viewport, because between 1600px and 1680px a
  vw-sized column kept growing while the hero's capped width did not, and the
  film got *smaller* as the window got wider. It now grows monotonically from
  675px to 1104px across the whole range.
- **The hero's width cap is a clamp, not a breakpoint.**
  `clamp(1560px, 100vw - 120px, 1860px)` instead of a jump to a fixed wider
  value at 1680px, which snapped the hero 120px wider -- and the film a
  hundred pixels with it -- the moment you dragged a window past that mark.

## [1.10.3] - 2026-09-15

### Fixed
- **The headline was clipping words at the 1180px+ breakpoint.** The previous
  patch capped `.hero__copy` at `max-width: 30ch` meaning to give the shrunken
  column a floor. `ch` is the width of "0" in the element's *own* font, and
  `.hero__copy` never sets one -- it inherits the page's 16px, not the
  headline's 2.6-5.2rem. So the cap was a box sized for 16px text wrapped
  around 40-80px text: roughly a third the width the headline actually needed.
  The reveal masks around each line clip whatever doesn't fit, silently, so
  the failure was a word missing letters with nothing pointing at why.
  `.hero__title` now carries `overflow-wrap: anywhere` as a standing backstop
  -- a wrap nobody planned is a visible, harmless surprise; a clip is neither.

### Changed
- **The film's column is a fixed band now, not a fraction of the row, and
  claims everything past it.** `0.72fr`/`1.28fr` sounds pinned but isn't -- a
  fraction is a share of whatever space is left, so widening the hero itself
  (the 1680px rule two patches back) quietly widened the copy column right
  along with the film, undoing the point of narrowing it. The copy column is
  `minmax(260px, 360px)` now: a real ceiling that does not drift with the
  container. Everything past it -- `minmax(0, 1fr)` -- is the film's, which on
  a wide monitor is well over a thousand pixels, a much larger jump right than
  the fraction ever produced. The headline's clamp came down again to fit the
  new fixed column (`2.7rem` max, down from `5.2rem`), and the roaming pixel
  guy's floor is pinned to the same fixed width rather than a percentage of
  the hero that stopped meaning anything the moment the column did.

## [1.10.2] - 2026-09-15

### Changed
- **The hero's film sits further right, and bigger.** The two-column split
  above 1180px was `0.9fr`/`1.1fr`; it is `0.72fr`/`1.28fr` now, so the film's
  column -- and the card pinned to the end of it -- claims noticeably more of
  the row. Its own max-width grew with it, `1000px` to `1160px`. On monitors
  wide enough to spare it (1680px+), the hero's overall cap grew too, from
  `1560px` to `1760px`, so the extra room comes from space that was previously
  just margin rather than from squeezing the copy column further than it
  needs to shrink.

  The copy column paid for some of this: the headline's clamp came down again
  (`5.8rem` max to `5.2rem`), and the sub and copy column both capped at 30ch
  instead of 40-46ch. At that width the button row and the location chip no
  longer fit on one line, so the row wraps and the chip drops -- the same trade
  the phone layout already makes once things get this tight.

## [1.10.1] - 2026-09-15

### Fixed
- **Leaving the portal no longer flashes the homepage before the veil covers
  it.** The canvas that draws the crossing was created and given its first
  frame inside an ordinary effect, which runs after the browser has already
  painted. Going into the portal that gap was hidden behind the door's own
  `opacity: 0` starting state, but coming back out to the site the marketing
  page is already fully rendered underneath a veil that is transparent by
  design -- so for one frame the home page showed through an overlay that
  hadn't drawn anything onto it yet. Moved to a layout effect, which runs
  before paint, so the canvas's first frame (already fully covering the
  screen) is there from the moment the veil is visible at all.

## [1.10.0] - 2026-09-15

### Added
- **The hero runs a film of the portal.** A sixteen-second loop, played in a
  window card beside the headline, of somebody actually using `/demo`: a missed
  call lands in the live feed and the "missed calls answered" counter moves,
  the cursor crosses to `leads` in the rail and clicks it, the page swaps to the
  table, a row is opened to show the exact timeline underneath it -- lead,
  text, routed, replied, to the second -- and then the `replied` filter is
  clicked. Fade, loop.

  The path is chosen, not a tour. The claim above it is that leads get answered
  in seconds, and the one screen in the product that proves that claim is an
  expanded lead row with timestamps on it. Everything before the expansion
  exists to get there believably.

  It is a replica of the workspace rather than the workspace itself
  (`src/components/PortalFilm.jsx`, with its own stylesheet). The real thing is
  a lazy route carrying a Supabase client, a router and a hundred kilobytes of
  generated data; hauling all of that into the marketing bundle to play a loop
  nobody can click would cost more than the hero is worth. What it does share is
  the numbers -- 115 missed calls answered, 11.0s median, 253 leads, 99.44%
  uptime, Halstead Restoration -- which are the figures `/demo` actually
  renders, so clicking through from the film lands on the dashboard it just
  showed you.

  Every visual is derived from the current scene index rather than accumulated
  by side effects, so the loop restarts by setting a number back to zero. The
  cursor's targets are measured off the live DOM on each scene rather than
  written down as coordinates, so it keeps landing on the thing it is pointing
  at whether the card is 560px wide or 880px.

  It is the site's own square cursor, not a borrowed arrow -- an arrow here
  would be the only one on a site that replaced its pointer with a square. The
  clock stops when the film scrolls off screen, and `prefers-reduced-motion`
  gets the last frame of the film held still rather than no film at all.

### Changed
- **The hero is two columns above 1180px, and the film takes the larger half.**
  Copy left at `0.9fr`, film right at `1.1fr`, pinned to the right gutter with
  `justify-self: end` and centred on the headline's own axis. The headline gives
  up its billboard scale to make room -- `clamp(2.9rem, 4.9vw, 5.8rem)` instead
  of `clamp(3.1rem, 11.4vw, 9.8rem)` -- because eleven-and-a-half vw across half
  a screen is a word per line. The sub and the buttons stack instead of sharing a
  row, and the roaming pixel guy is kept to the copy column, since the window
  card is opaque and a mark that walks behind it has simply disappeared. Below
  1180px nothing changes except that the film stacks underneath at full width.

  The card is sized in `svh`, not pixels: `clamp(400px, 52svh, 560px)`. A fixed
  height generous enough to be worth looking at on a 1080p monitor is a hero
  taller than the fold on a 1366x768 laptop, which is the machine a contractor
  is most likely reading this on. The feed carries seven entries and the table
  seven leads to match the taller box -- a live feed with four rows and a hand of
  empty space under them is a product that looks quiet.

  The film's own breakpoints are container queries, not media queries: the card
  is about 55% of the viewport in the split hero and 100% of it when the hero
  stacks, so viewport width says nothing useful about how much room its table
  has. Under 660px the rail collapses to glyphs and the table sheds columns,
  exactly as the real workspace does.

### Added
- **The hero runs a film of the portal.** A sixteen-second loop, played in a
  window card beside the headline, of somebody actually using `/demo`: a missed
  call lands in the live feed and the "missed calls answered" counter moves,
  the cursor crosses to `leads` in the rail and clicks it, the page swaps to the
  table, a row is opened to show the exact timeline underneath it -- lead,
  text, routed, replied, to the second -- and then the `replied` filter is
  clicked. Fade, loop.

  The path is chosen, not a tour. The claim above it is that leads get answered
  in seconds, and the one screen in the product that proves that claim is an
  expanded lead row with timestamps on it. Everything before the expansion
  exists to get there believably.

  It is a replica of the workspace rather than the workspace itself
  (`src/components/PortalFilm.jsx`, with its own stylesheet). The real thing is
  a lazy route carrying a Supabase client, a router and a hundred kilobytes of
  generated data; hauling all of that into the marketing bundle to play a loop
  nobody can click would cost more than the hero is worth. What it does share is
  the numbers -- 115 missed calls answered, 11.0s median, 253 leads, 99.44%
  uptime, Halstead Restoration -- which are the figures `/demo` actually
  renders, so clicking through from the film lands on the dashboard it just
  showed you.

  Every visual is derived from the current scene index rather than accumulated
  by side effects, so the loop restarts by setting a number back to zero. The
  cursor's targets are measured off the live DOM on each scene rather than
  written down as coordinates, so it keeps landing on the thing it is pointing
  at whether the card is 560px wide or 880px.

  It is the site's own square cursor, not a borrowed arrow -- an arrow here
  would be the only one on a site that replaced its pointer with a square. The
  clock stops when the film scrolls off screen, and `prefers-reduced-motion`
  gets the last frame of the film held still rather than no film at all.

### Changed
- **The hero is two columns above 1180px, and the film takes the larger half.**
  Copy left at `0.9fr`, film right at `1.1fr`, pinned to the right gutter with
  `justify-self: end` and centred on the headline's own axis. The headline gives
  up its billboard scale to make room -- `clamp(2.9rem, 4.9vw, 5.8rem)` instead
  of `clamp(3.1rem, 11.4vw, 9.8rem)` -- because eleven-and-a-half vw across half
  a screen is a word per line. The sub and the buttons stack instead of sharing a
  row, and the roaming pixel guy is kept to the copy column, since the window
  card is opaque and a mark that walks behind it has simply disappeared. Below
  1180px nothing changes except that the film stacks underneath at full width.

  The card is sized in `svh`, not pixels: `clamp(400px, 52svh, 560px)`. A fixed
  height generous enough to be worth looking at on a 1080p monitor is a hero
  taller than the fold on a 1366x768 laptop, which is the machine a contractor
  is most likely reading this on. Row counts were raised to match the taller box
  -- seven feed entries and seven leads -- because a live feed with four rows and
  a hand of empty space under them is a product that looks quiet.

  The film's own breakpoints are container queries, not media queries: the card
  is about 46% of the viewport in the split hero and 100% of it when the hero
  stacks, so viewport width says nothing useful about how much room its table
  has. Under 660px the rail collapses to glyphs and the table sheds columns,
  exactly as the real workspace does.

## [1.9.0] - 2026-09-15

### Added
- **Leaving the portal plays the crossing in reverse.** Going in, the entrance
  sheet leaves to the right. Coming back out to the marketing site it now leaves
  to the left -- the same sheet, the same fray, the same seam and falling
  digits, mirrored about the vertical axis -- so the two halves of the product
  sit on either side of you and the transition says which way you just moved.

  It is modelled as an *arrival* on the site rather than an exit from the
  portal, which is what makes the browser's back button work. An exit animation
  has to hold the navigation open while it plays and there is no holding a
  popstate open -- by the time you hear about it the URL has already changed. An
  arrival that knows where it came from needs no such cooperation, so the back
  button, the link in the portal's bar, the one in its button row, the one in
  the ops door and the one in the workspace account menu are all one code path
  with nothing to intercept.

  It plays only for visitors who actually came from over there. `src/lib/crossing.js`
  remembers the last route; an arrival at `/` from a search result or a bookmark
  gets no wipe at all, because putting a full-screen animation in front of every
  first visit is the same mistake the tunnel made.

### Changed
- **The veil sits at `z-index: 1500`, up from 60.** 60 cleared the portal door
  (which tops out at 20) but not the marketing site's nav (100) or its pilot
  overlay (1000), so the sheet would have swept *under* the nav on the way out.
  Still below the cursor square and focus ring at 9990/9999, which are the one
  pair of layers that should keep drawing over a transition.

## [1.8.1] - 2026-09-15

### Changed
- **The wordmark comes back three seconds after it is broken, down from six.**
  End to end, from the cursor leaving the letters to the wordmark standing
  again: ~4.4s, against ~7.1s before and ~32.5s two versions ago.

  This is close to the floor, and the floor is set by the fall rather than by
  taste. A grain knocked off the wordmark in the top right corner takes about
  nine tenths of a second to reach the drift, so a quiet time much under 2.5s is
  mostly spent watching sand that is still in the air -- the pile it lands in
  never gets a moment to exist, and the erode half of the effect gets paid for
  and then thrown away.

## [1.8.0] - 2026-09-15

### Changed
- **The wordmark is small now, and it stands in the upper right.** It used to
  be the size of the hero -- roughly 1150x410px of "arc automations" across the
  middle of the field. It is about a third of that area now, tucked into the
  top right corner, with the gap between the two lines pulled in from 0.42 cap
  heights to 0.20.

  The corner is the upper one on purpose. The effect needs two things from
  wherever the wordmark lives: cursor traffic, and a drop. The upper right has
  both -- it sits on the diagonal between the nav in the top corner and the
  sign-in button down on the left, which is the path nearly every visitor's
  cursor actually takes, and it leaves the whole height of the hero underneath
  it for the sand to fall through. The lower right has the traffic and none of
  the drop: grains knocked off a wordmark already sitting on the floor fall a
  few pixels and stop.

  Placement and size are five named constants at the top of the file
  (`WORD_W`, `ARC_RATIO`, `WORD_X`, `WORD_Y`, `LINE_GAP`) rather than numbers
  buried in the rasteriser, so this is now tunable without reading the mask
  code.

- **The character cell is finer: 10px on desktop, 9px on phones, down from
  12/11/10.** This is what makes the small wordmark possible rather than a
  separate decision. These are letters drawn out of character cells, so
  legibility is a function of cells-per-letter, not of pixels -- at the old
  cell size a corner-sized "automations" had about three cells of cap height
  and came out as texture rather than as a word. The finer cell buys back the
  rows the smaller wordmark gave away. The drift is finer grained for it too,
  which reads rather more like sand and rather less like gravel.

- **Letterform coverage is gamma-corrected (`INK_GAMMA`).** A cell a stroke only
  half fills scores 0.5 and drew a `;`, and a word built out of `;` does not
  resolve as a word. The curve lifts the middle of the density ramp and leaves
  both ends alone, so the fringe stays soft and the interior stays at `@`. This
  is most of what makes "automations" readable at the new size.

## [1.7.0] - 2026-09-15

### Changed
- **The entrance is a slide now, not a tunnel.** Both front doors (`/portal`
  and `/ops`) used to fly you down a WebGL tunnel on every arrival. It was the
  right amount of spectacle for a thing you see once and the wrong amount for a
  thing you cross several times a session -- and the portal is a place people
  go back and forth from, so it got crossed a lot.

  What replaces it: a sheet the colour of the page slides off to the right in
  760ms, led by a lit orange seam. Behind the seam the sheet frays into
  character cells and comes apart, and what breaks off is left behind as a trail
  of digits that drift back, fall, and burn out -- the same ramp, the same
  accent stops and the same "the wordmark is made of numbers" conceit as the
  character field the door hands off to. The page settles in from the left as
  the seam crosses to the right, so the wipe and the reveal are one movement.

  There is no progress bar, no scroll-to-advance and no skip button, because at
  760ms there is nothing to skip. `prefers-reduced-motion` still bypasses it
  entirely.

### Removed
- **three.js, and the machinery that existed to load it.** The tunnel was the
  only thing in the project using it; the new entrance is one canvas-2d file
  drawing a character grid, which is what the rest of the portal's motion is
  already made of. Knock-on effects:
  - the ~470 kB `HoleTunnel` chunk is gone from the build, along with `three`
    as a dependency;
  - `lib/entrance.js` loses the dynamic import, the stale-deploy chunk retry and
    the eight-second "a slow chunk must not become a locked door" deadline --
    the entrance is now bundled, so there is no fetch that can stall in front of
    it. The two-second safety that drops a veil which never asked to be removed
    stays;
  - the `.ph__veil` placeholder (what you looked at while the tunnel chunk
    downloaded) has nothing left to stand in for.

### Fixed
- **The wordmark's pour is no longer half over before you can see it.** Both
  doors armed the character field on `entered` -- the moment the door *began* to
  open -- so the pour played its first 600ms under an opaque overlay. It is
  armed on `flown` now, the frame the veil actually leaves, and `POUR_LEAD`
  drops from 620ms to 150ms accordingly: just enough to keep the wave clear of
  the wipe's last falling debris.

## [1.6.1] - 2026-09-15

### Changed
- **The wordmark comes back a lot sooner after it is broken.** The quiet time
  before the field gathers itself up was thirty seconds, which was long enough
  that a visitor who brushed past the letters got a pile of sand and a page
  that looked broken -- nothing on screen says the state is temporary, so the
  only way to learn it recovers was to wait half a minute and find out. Six
  seconds now. The gather itself is tightened to match (the wave crosses in
  620ms rather than 900ms, and the flight home is shorter), so it still reads
  as a wave sweeping the field rather than a snap.

  End to end, from the cursor leaving the letters to the wordmark standing
  again: ~7.4s, down from ~32.5s. The clock still restarts on every bond that
  breaks, so this is never a countdown anybody is fighting -- it only begins
  once they have stopped.

## [1.6.0] - 2026-09-14

### Added
- **The portal's wordmark is made of sand.** The character field behind both
  front doors (`/portal` and `/ops`) still says "arc automations" and still
  bulges away from the cursor, but the wordmark is now a few thousand
  independent grains with a life of their own:
  - **it pours in.** The letters assemble out of a wave of falling digits,
    staggered left-to-right across the field, each grain flipping from a number
    to its letter on the frame it lands. Held back until the entrance tunnel
    has actually cleared -- an arrival played under an opaque overlay is an
    arrival nobody sees.
  - **it comes apart.** Running the cursor over the letters breaks the bonds it
    passes through. Loose grains take a kick, fall under gravity, bounce off
    the walls, and pile into a drift along the bottom of the hero that slumps
    when it gets too steep. The drift is kickable too. The old membrane push
    survives as the outer ring of the same model: drift near the letters and
    they bulge, cross them and they break.
  - **it gathers itself back up.** Thirty seconds after the last bond breaks,
    everything still loose is thrown back to its slot in a second wave and the
    wordmark reassembles exactly -- the return is a timed flight, not a spring,
    so every grain lands *on* its cell rather than asymptotically near it.

  The simulation is a new module, `src/portal/lib/sand.js`, with no DOM and no
  React in it. `AsciiField.jsx` keeps what is actually about characters -- the
  glyphs, the palette, and the starfield "room" the wordmark stands in. The two
  meet only through an occupancy grid, which is what now lets the room show
  through the holes as the letters are eroded away.

### Fixed
- The field read its pointer position straight from `clientY`, ignoring that
  the canvas starts below the page's own header, so every interaction was off
  by the height of the bar. It reads the canvas rect now. Invisible when the
  whole wordmark answered to a soft falloff; not invisible now that a radius
  decides what comes apart.
- `AsciiField` rebuilt its entire grid on every `ResizeObserver` callback, even
  when the cell count had not changed. The entrance toggles `body` overflow,
  which moves the scrollbar, which fired one halfway through the arrival; a
  phone's address bar does the same thing on scroll. It now rebuilds only when
  the grid actually changes.

### Changed
- On coarse pointers the field pours and stands but no longer erodes. A scroll
  gesture arrives as a `pointermove` across the hero and used to tear the
  wordmark down on the way past -- leaving sand with no visible cause, since
  the mobile scrim covers the wordmark almost entirely anyway.

## [1.5.4] - 2026-09-13

### Added
- **Booking is wired up (part of S3/pilot flow).** `pilot.booking` now points at
  a real Cal.com event (`provider: 'calcom'`, `embedUrl` set). A completed pilot
  intake now lands on an actual calendar, prefilled with the visitor's name,
  email, and answers, instead of the "pick a provider" placeholder. This was the
  last gap between a filled-out pilot form and a booked call.

## [1.5.3] - 2026-09-13

### Added
- **The pilot form now actually captures leads.** `pilot.captureUrl` was empty
  since 1.5.0, so every completed intake was thrown away. It now points at a
  live n8n webhook (`arc-pilot-intake`) that emails the full submission --
  trade, pain, volume, name, business, email, phone, page and timestamp --
  the moment someone finishes the form. Built and verified end to end: a test
  payload matching the site's exact shape returned HTTP 200 and all three
  workflow nodes reported success.

### Security
- Gitignored `n8n.env`. A file holding a live n8n API key had been dropped into
  `src/portal/n8n.env/` inside this **public** repo. It was still untracked so
  nothing leaked, but a single `git add -A` would have published a credential
  granting full control of the n8n account. Ignored now -- though it should be
  moved out of the repo entirely, and the key rotated if there is any doubt.

## [1.5.2] - 2026-09-11

### Changed
- "What we build with" shows all 18 tools again instead of the 7 core ones
  behind a "the rest of the stack" toggle. The toggle is gone. Core tools (n8n,
  Claude Code, GoHighLevel, Twilio, webhooks, REST APIs, RAG) keep the accent
  style so they still stand out. matter.js still loads lazily, so the 1.5.0
  bundle saving is unaffected.

## [1.5.1] - 2026-09-11

### Changed
- The nine services cut from "what we build" in 1.5.0 are back, behind a
  "see 9 more services" toggle under the three core tabs, so the full menu is
  one click away. Warranty tracker, workflow automations, AI chat bots, websites,
  CRM & data, business process, marketing automation, AI analytics and custom
  SaaS render as normal selectable tabs when it's open. They moved from
  commented-out blocks in `site.js` to a live `site.workflowsMore` array. The
  one-line "we also build..." footnote is gone, since the toggle does its job.
- The workflows CTA opens a tab's own intake when it has one (marketing
  automation), and the generic trade/pain/volume intake otherwise.

## [1.5.0] - 2026-09-09

Phase 1 of the honesty pass (`ARC_FIX_CHECKLIST.md`): the marketing site, the
demo, the client dashboard and the operator console, worked in order of damage.
18 of 21 items. Three are blocked on things no code change can produce — real
n8n screenshots (S1), a domain mailbox (S7), and a Supabase dashboard setting
(O5) — and are listed at the bottom.

### Added
- **Lead capture on the pilot overlay (S2).** A completed intake now POSTs the
  full payload — answers, contact, page, timestamp — to `site.pilot.captureUrl`
  before the visitor reaches the booking step. Fire-and-forget with `keepalive`,
  so a failed capture never blocks anyone and a closed tab still sends. Paste an
  n8n production webhook URL into `captureUrl` and it is live. **Until that
  string is filled in nothing is captured**, and the overlay says so honestly
  rather than claiming a send it did not make.
- **A price on the page (S3).** "flat $1,500 to build it — then $500/mo if it
  earns its keep" now sits under *one pilot, one week*, rendered outside the
  accordion body — a price you have to click to find is the same as no price.
- **Early-data and empty states on every dashboard page (P1A).** `EarlyData` was
  rendered on Overview and nowhere else, so a client on day three clicked Leads,
  Activity, Automations, Reliability and Reports and got five blank screens. It
  now takes per-page copy and appears on all of them, with the tenant's age
  always attached — the fact that turns an empty page from "broken" into "new".
  Two genuinely wrong states went with it: a zero-event tenant was told to
  "clear the search or widen the filters" on a table with nothing behind it, and
  an empty uptime strip rendered as thirty grey cells that read as thirty days
  of outage.
- **Alert write path and operator UI (P2A, Phase 1 half).** `alerts` was the
  only mutable table in the schema, the reliability page rendered incidents from
  it, the support page promised clients "we get paged" — and nothing anywhere
  inserted a row. `raise-alert`, `acknowledge-alert` and `resolve-alert` are now
  actions on the `ops` edge function (service-role, admin-checked, audited),
  with a console page at `/ops/alerts`. **Detection is still not built** — the
  poller that finds a silent tenant is N4 and needs n8n — and the page carries a
  banner saying exactly that rather than implying the monitoring is live.
- **Audit log (O4).** `supabase/migrations/0004_audit_log.sql` adds an
  append-only `admin_actions` table: actor, action, target, metadata, timestamp.
  Written from inside the edge functions rather than the browser, so an action
  cannot succeed and go unlogged; the actor is read from the caller's verified
  token, never from the request body. Append-only is enforced rather than
  promised — there is no update policy and no delete policy for any role, and
  RLS denies by default. Readable at `/ops/audit`.
- **Per-connection staleness thresholds (O3).** `connectionLiveness()` used a
  flat 48 hours for every client. It now derives the threshold from each
  workflow's own observed cadence — twice its p90 quiet stretch, floored at 6h —
  so a restoration client taking four leads a day flags in hours rather than
  days, while a plumber who genuinely sleeps through a weekend does not cry wolf
  every Monday. `expected_quiet_hours` (migration 0005) is the fallback when
  there is too little history to describe a cadence, and the ceiling, so a
  hand-set value always tightens rather than loosens.
- **"Changing the operator email" runbook** in the console, next to "adding
  another operator". The ordered procedure for S7, written down because the
  change looks like editing one string and the wrong order locks the only
  operator out of the only console.

### Changed
- **The demo rebuilds nightly (D1).** `deploy.yml` only ran on push, and the
  demo is generated against `DateTime.now()` at build time — so six days without
  a commit published a demo reading "last check 6 days ago", every automation
  badged `quiet`, and every trend negative. A prospect opening it saw an
  abandoned, declining system. Now on a `0 9 * * *` schedule.
- **The demo trends the right way (D2).** Freshness alone did not fix it: with a
  flat generator the rolling 30-day deltas landed negative on roughly half of
  all possible build dates, and it rebuilds nightly, so "roughly half" means a
  prospect eventually opens it on a bad day. Three changes, each verified by
  simulating **every build date the cron could fire on for the next 70 days**: a
  gentle upward volume drift (~+11% median, deliberately not a hockey stick);
  the missed-call/form channel mix modelled as a stable share of each day rather
  than a per-lead coin flip, which was manufacturing ±10% swings in the headline
  figure that said nothing about the business; and a higher weekend floor plus a
  higher reply rate on missed calls, because at the old volumes *missed-call
  text-back* genuinely went 26 hours quiet every Saturday and *reply capture*
  every Sunday — that yellow badge was correct behaviour reporting a generator
  that understated weekend emergencies. Result across all 70 dates: leads and
  missed-calls deltas non-negative on every one, every automation `healthy`,
  exactly one resolved incident in the window, last check under 5 minutes old.
  `generateDemoData()` now takes an injectable `now`, which is what made any of
  this testable.
- **Overview leads with the number that maps to money (P1D).** The largest
  figure was "leads this month" — a partial month, and a number their CRM
  already tells them. Missed calls answered now leads and carries the hero tone:
  every one is a job that would have gone to voicemail and died. Median response
  stays second, since it is the number the system exists to move.
- **Plain language on the client dashboard (P1C).** `p90 31.1s` → "9 in 10
  answered within 31.1s". `130 sends` → "130 texts sent". "pipeline uptime"
  keeps its name but never appears without the sentence that says what it
  measures — *not "the server is up" — a lead sent right now would have been
  answered* — on Overview and Reports, not only Reliability. The raw event
  strings stay on the Activity run log, which is the raw log and should read
  like one. The new wording lives in `format.js`, so two pages cannot come to
  write the same statistic two different ways.
- **Eleven service tabs cut to three (S4).** Speed-to-lead, missed-call
  text-back, lead qualification. A full-service agency menu from a solo operator
  undercut the "one narrow offer, in production" position the rest of the site
  works to establish. The other eight are commented out in `site.js`, not
  deleted — each comes back the day there is a case study behind it — and
  everything they covered is now one quiet line under the tabs. This exposed a
  bug: every tab's CTA opened the *marketing automation* intake, which asks
  about ad channels and photo libraries. All three now open the generic
  trade/pain/volume intake.
- **Work index trimmed from seven rows to five (S5).** `pale ember espresso` is
  gone — a local-only coffee build means nothing to a restoration contractor —
  and so is `home-service crm`. One row now carries a not-yet-live label instead
  of four; the cumulative read of the old list was "mostly hasn't happened". A
  side effect worth having: S1 is five screenshots now, not seven.
- **Toolkit split by audience (S6).** Seven core chips show by default — n8n,
  Claude Code, GoHighLevel, Twilio, webhooks, REST APIs, RAG — and the rest of
  the stack sits behind a toggle. A restoration owner reading "rapier" and
  "lenis" learns only that somebody likes graphics libraries.
- **The ops door moved out of the primary nav (S10).** It is in the footer now.
  Not a security change — `/ops` is gated on `arc_admins` and RLS, and hiding a
  link has never guarded anything — but a staff entrance advertised on every
  page of a sales site is furniture the customer did not come to look at. The
  nav is down to two actions: portal, and start a pilot.
- **The contact address is read from `site.js` everywhere.** `Login.jsx` and
  `Portal.jsx` had the gmail address hardcoded in three `mailto:` links, so S7
  would have left them pointing at the old inbox. `grep -rn "gmail" src/` is now
  the two lines in `site.js` itself.
- **`ASSETS.md` rewritten.** It listed files nothing references any more
  (`rue-noir-01..04.jpg`, stats that no longer exist on the page). Only
  `WorkGrid` renders slots, so the manifest is now exactly the five files the
  site is actually waiting on, plus the console check to verify it.
- **School line removed from the footer (S8).** Landed in 1.4.5; recorded here
  as the deliberate call the checklist asked for. It is a positioning decision,
  not an honesty one — nobody is owed an enrollment status in an agency footer,
  and it belongs on a personal page if anywhere.

### Fixed
- **Physics engine off the marketing critical path (S9).** `matter-js` — a full
  2D physics engine, loaded for a decorative chip effect — was in the initial
  bundle on a site contractors open on phones on bad service. It is now a
  dynamic import that fires only when the toolkit scrolls into view, on a device
  that is not mobile, not reduced-motion, and not asking for data saver.
  **Initial JS: 804.87 kB → 719.87 kB raw, 257.65 kB → 230.17 kB gzipped**
  (−85 kB / −27.5 kB, −10.7%). The engine is an 85.96 kB chunk fetched on
  demand, or never.
- **"Direct booking is being wired up" is gone (S2).** An automation company
  telling a prospect its own booking is not wired up is self-refuting copy, and
  the `mailto:` behind it did nothing for anyone reading webmail in a browser —
  which is most contractors on a phone.
- **Tables restack as cards under 720px (P1B).** `overflow-x: auto` was the
  entire mobile strategy and the leads table has seven columns. Leads is the
  page a contractor actually opens, and they open it from a truck. Rows are now
  cards — customer and phone as the heading, source and loss type as a subline,
  response, outcome and tech as a footer — each value carrying its own label,
  since the header row is hidden once the table is unstacked. Same treatment for
  the ops clients table.
- **Expandable rows look expandable (P1E).** The per-lead timeline is the most
  persuasive thing in the product and the only affordance was a chevron painted
  in `--faint`, the colour this system uses for text nobody needs to read. The
  chevron is `--muted` now, the row has a pointer cursor and a left accent rule
  on hover, and a one-line hint sits above the table until a row has been opened
  once.

### Still open — nothing in this repo can close these
- **S1:** the five n8n canvas screenshots. See `ASSETS.md`. Until they exist,
  `document.querySelectorAll('.slot').length` is 5, not 0.
- **S7:** register the domain mailbox, create the Supabase auth user, add it to
  `arc_admins`, verify sign-in, *then* edit `site.js`. Runbook in the console.
- **O5:** enable MFA on the Supabase account.
- **Migrations 0004 and 0005** need applying before `/ops/audit` and the derived
  staleness thresholds do anything. Both are safe to run on an existing project.

## [1.4.5] - 2026-09-09

### Changed
- Nav wordmark reads "arc" instead of "ben" — the site is Arc Automations
  branding now, not a personal mark.
- Removed the footer meta bar entirely (`ben* — arc automations`, the
  university/AI-minor line, `northern utah, mst`, and the copyright line) —
  personal-brand and school copy that didn't belong on a business site.

## [1.4.4] - 2026-09-08

### Security
- Removed the magic-link fallback from `/ops`. It needed no password to fire —
  any visitor could trigger a real sign-in email with no credentials at all —
  and the "not you? sign in as someone else" toggle added in 1.4.2 made it
  worse by pre-filling that action's target with the primary operator's real
  address the instant the toggle was clicked, before any login. Both are gone:
  the toggle now reveals a blank field, and there is no email-sending code path
  left anywhere on the page.
- A wrong password now shows one flat message ("that password is wrong.") and
  stops — no navigation, no email, no further page. Recovering a forgotten or
  never-set password happens directly in Supabase (authentication → users),
  documented in the console's "adding another operator" panel and in
  OperatorAccount's own copy.

## [1.4.3] - 2026-09-08

### Added
- "Adding another operator" — a closed-by-default reference panel on the
  console's Supabase page (`Disclosure` in `ops-ui.jsx`), spelling out the
  4-step procedure end to end: create their auth user, confirm migration 0003
  is applied, add them to `arc_admins`, sign in as them at `/ops`.

### Fixed
- The `/ops` door authenticated against a fixed address (`site.opsEmail`) no
  matter who was added to `arc_admins` — a second operator could be granted
  access and still never get past the door. Added a "not you? sign in as
  someone else" toggle that reveals an email field, so any admin can sign in
  as themselves; the single-field fast path stays the default.

## [1.4.2] - 2026-09-08

### Changed
- The operator door at `/ops` is now a single password field. The account the
  password belongs to is a constant (`site.opsEmail`) rather than an input —
  there is one operator, and the address is already public in the footer and
  every mailto on the site, so it was never acting as a second factor.
- The magic-link fallback is one click instead of a second form, since there is
  no longer an address to type into it.

## [1.4.1] - 2026-09-08

### Added
- Password sign-in for the operator console at `/ops` — email and password via
  `signInWithPassword`, with the magic link kept as the first-time and
  forgotten-password path.
- "Your operator account" panel on the console's Supabase page, for setting
  that password without touching the Supabase dashboard.

### Security
- The password is a real Supabase auth credential, set on the auth user and
  hashed server-side. It is deliberately **not** in this repository: the site
  is a static bundle served from a public repo, so a password compared in
  front-end code would be a published one — and it would protect nothing
  anyway, since `arc_admins` plus row level security are what actually empty
  the console for a non-admin.

## [1.4.0] - 2026-09-08

Client IDs replace email sign-in, and the operator console arrives alongside
the portal workspace rearchitecture.

### Changed
- Rebuilt the signed-in dashboard around a shared `Workspace` shell
  (`Sidebar`, `Topbar`, `CommandPalette`) instead of a single
  `Dashboard`/`Metrics` pair; the eight dashboard pages now live under
  `src/portal/pages/dash/`.
- Reworked the portal data layer: `derive.js` and `dashboard-data.js` now sit
  between `metrics.js` and the pages, with `nav.js` as the single source of
  truth for sidebar, topbar, and command-palette entries.
- Routed the dashboard and demo bundle through `src/lib/lazyRoute.jsx` so the
  marketing site no longer loads them.
- Extracted the portal entrance into `lib/entrance.js` so `/portal` and `/ops`
  share one transition rather than two copies of it.
- Generalised `Sidebar`, `Topbar` and `CommandPalette` over a nav declaration
  and a record set, so the console renders the same shell as the client
  workspace instead of growing its own.
- `/auth/callback` now resolves where to land: an explicit `?next=`, a
  remembered destination, then an admin check — so an operator is not dropped
  on "no portal linked yet".

### Added
- **Client IDs.** Clients sign in at `/login` with an `ARC-XXXX-XXXX` ID
  instead of an email address. Resolution from ID to mailbox happens in the
  `client-login` edge function under the service role, so the browser is never
  handed an address — only a masked hint. Crockford base32 minus I, L, O and U;
  40 bits, generated with `crypto.getRandomValues`.
- **The operator console** at `/ops` (door) and `/ops/console` (workspace) —
  eight pages behind an `arc_admins` check in Postgres: roster, clients, client
  detail, add-a-client, client IDs, connections & servers, a live Supabase
  probe, and a cross-client activity log.
- Per-client detail: identity and reissue, an editable account row, the
  client's own dashboard figures, declared connections checked against the
  event log, ingest-token minting, and their activity feed.
- `connections` table and registry — what each client is wired to (n8n,
  Twilio, GHL, webhooks), with declared status shown beside observed liveness
  matched on `workflow_id`.
- `ops` edge function: invites a client's address into auth and links it to a
  tenant, the one step that cannot run in the browser.
- Migration `0003_client_ids_and_ops.sql`: `client_id` and contact columns on
  `tenants`, `arc_admins`, `is_arc_admin()`, `gen_client_id()`, an `archived`
  status, and admin policies layered onto the existing per-tenant ones.
- A small `ops` chip in the site nav, left of the portal button.
- Command palette (⌘K) for jumping between dashboard pages.
- CSV export (`src/portal/lib/csv.js`) and a per-source unit breakdown
  (`SourceUnits.jsx`).
- Hour-of-day activity chart (`HourChart.jsx`) and an uptime strip
  (`UptimeStrip.jsx`).

## [1.3.2] - 2026-09-07

### Changed
- Sped up the portal entrance animation further.

## [1.3.1] - 2026-09-07

### Changed
- Reordered the "our specialty" and "five things we shipped" homepage
  sections.
- Removed the self-taught/receipts section from the homepage.

## [1.3.0] - 2026-09-06

### Added
- Client portal: magic-link auth, tenant dashboard, n8n event ingest.
- WebGL tunnel entrance animation for the portal front door at `/portal`.
- Animated glow nav buttons and a portal link in the site nav.

### Changed
- Drove the entrance on elapsed time instead of frame count, then tuned it to
  be steadier, more cinematic, and faster.

### Fixed
- Entrance overlay could outlive itself.
- A negative first frame drove the entrance scale to NaN, causing a black
  screen.

## [1.2.0] - 2026-08-13

### Changed
- Replaced the Embertithe portfolio card (which had replaced the YouTube
  card) with a home-service CRM card and an animated missed-call
  text-back demo.

## [1.1.0] - 2026-08-12

### Changed
- Rebuilt the workflows section as a full offering list with per-tab
  descriptions, renamed to "our specialty."
- Presets the marketing-automation pilot flow from the workflows CTA and
  adds a website field.
- Pointed the rue noir card at its live site with an accessible visit
  button, and linked it to its GitHub repo.

## [1.0.0] - 2026-08-12

### Added
- Initial commit: portfolio site deployed to GitHub Pages via Actions.

[Unreleased]: https://github.com/bennettc1213/Arc-Automations/compare/a63ad8a...HEAD
[1.4.5]: https://github.com/bennettc1213/Arc-Automations/compare/a63ad8a...HEAD
[1.4.4]: https://github.com/bennettc1213/Arc-Automations/compare/a3d6e43...a63ad8a
[1.4.3]: https://github.com/bennettc1213/Arc-Automations/compare/59f982c...a3d6e43
[1.4.2]: https://github.com/bennettc1213/Arc-Automations/compare/d2db0cc...59f982c
[1.4.1]: https://github.com/bennettc1213/Arc-Automations/compare/a3b23eb...d2db0cc
[1.4.0]: https://github.com/bennettc1213/Arc-Automations/compare/21bb26b...HEAD
[1.3.2]: https://github.com/bennettc1213/Arc-Automations/commit/21bb26b
[1.3.1]: https://github.com/bennettc1213/Arc-Automations/compare/4ff072f...7437bb8
[1.3.0]: https://github.com/bennettc1213/Arc-Automations/compare/3e61cd8...4ff072f
[1.2.0]: https://github.com/bennettc1213/Arc-Automations/compare/386398e...3e61cd8
[1.1.0]: https://github.com/bennettc1213/Arc-Automations/compare/4d55b04...386398e
[1.0.0]: https://github.com/bennettc1213/Arc-Automations/commit/4d55b04

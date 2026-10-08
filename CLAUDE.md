# ben-portfolio

Portfolio site plus the Arc client portal (`src/portal`) — a Supabase-backed
dashboard for Arc Automations clients, mirrored at `/demo` for sales.

Two sides, laid out to mirror each other:

- **Client** — `/portal` is the door, `/portal/dashboard/*` the workspace it
  guards, `/demo/*` the same workspace over generated data. Clients sign in at
  `/login` with a **client ID** (`ARC-XXXX-XXXX`); the `client-login` edge
  function resolves it to a mailbox and mails the link.
- **Operator** — `/ops` is the door, `/ops/console/*` the workspace, gated on
  `arc_admins` in Postgres. Every client, what they are wired to, and the
  buttons that put a new one into the system.

Both doors share one entrance animation (`portal/lib/entrance.js`) but not a
page: `/portal` is a sales hero, `/ops` is a staff entrance built from the
console's own panels, and the two should never look alike. Both workspaces
share one shell (`Sidebar`, `Topbar`, `CommandPalette`) over
different nav declarations. Every figure on either side is derived by the same
code from the `events` log — there is one derivation chain, so the console and
a client's dashboard cannot disagree.

## ARC Lead Recovery (`0010`)

The first module Arc **runs** rather than watches. A call reaches an ARC/Twilio
number, is forwarded to the contractor, and an unanswered one becomes a lead,
an automation run and a text back — then the reply is classified, and the lead
is routed to the contractor or stopped and handed to a person. Website-form
leads go through the **same** `intakeLead`; there is no second engine.

One shared system: one module, one prompt, one set of templates, one
deployment. A tenant differs only in its published configuration versions
(`0014`, `_shared/config/`) — validated JSON with no executable logic, read only
through `resolveEffectiveConfig`; `module_configs.config` is frozen legacy. Never a
per-client workflow, schema, branch or deploy.

The split the whole thing rests on: **operational tables** (`leads`,
`automation_runs`, `scheduled_actions`, …) hold current state and what must
happen next; **`events`** stays append-only evidence, and no figure on any page
reads an operational table.

Four rules the code enforces:

- **Safety is decided by deterministic rules, and a model can only add to them**
  (`_shared/engine/rules.ts`). No path lets a classifier clear a flag a rule set.
  No AI key means human handoff, never a guess.
- **A model never writes a customer-facing message.** Reviewed templates, a
  closed placeholder list, and an opt-out line the engine appends.
- **Nothing sends without re-reading state first** — the gap between queueing
  tomorrow's follow-up and sending it is where the STOP arrives.
- **Two workers cannot send the same message** (`claim_scheduled_actions`,
  `for update skip locked`), and a canary cannot reach a handset.

Activation is fail-closed against an eleven-step checklist. Deploy and Twilio
setup: [DEPLOYMENT.md](DEPLOYMENT.md). The event contract:
[EVENT_CONTRACT.md](EVENT_CONTRACT.md).

**Whether a module may act is its lifecycle** (`0015`, `_shared/lifecycle/`,
ARC-120): `tenant_modules` holds the operator's decision (unselected → configuring →
testing → shadow → active ⇄ paused), what a published change requires, the exact
configuration versions it was tested and **authorised** on, and a separate health
overlay. `module_configs.enabled` is a mirror — writing it is refused. One authoriser,
`authorizeModuleExecution`, decides at run start, at every action and before every
effect; the run insert and the effect reservation re-check it in SQL. A new live run
needs the module active on exactly its authorised versions; a publication is priced by
the registry's recorded impact (`CHANGE_IMPACT_POLICY`) — consequence-free carries
forward, retest holds new runs, compliance/number/safety pauses. Publication never
activates, the system never un-pauses, and no run is ever repinned. Legal transitions
live in one list (`LIFECYCLE_TRANSITIONS`), drift-tested against 0015.

**A tenant's provider credentials live in Supabase Vault and nowhere else** (`0016`,
`_shared/connections/`, ARC-130; decision ADR ARC-010 §20a). `provider_connections` holds
metadata only; the Vault references and OAuth sessions are in `arc_private`, which no API
role can reach; browser roles reach nothing in `vault` either, while `service_role` keeps the
Vault grants Supabase makes and a project cannot revoke (ADR §20a amended; neither schema may be
Data-API exposed). 0016 asserts all of it (`credential_isolation_problems()`), and refuses to
apply without Vault. There is no "get secret" —
`withProviderCredential` resolves one credential for one named operation on a connection
verified for that capability. A token is not readiness: only `verified`/`degraded` serve,
and ARC-120 reads the live connection rows at every check. A lost connection pauses the
active modules that needed it; recovery never resumes one. Tests use the synthetic providers
on `.invalid` hosts and `TestCredentialStore`, both refusing production, and an unset
`ARC_ENVIRONMENT` counts as production. Log only through `safeLog`; hold secrets only as
`SecretValue`. Not production-ready until the hosted Vault checklist
(docs/architecture/ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md §15) passes.

**ARC's durable execution is one queue with two dispatchers** (`0017`, `_shared/scheduler/`,
ARC-200). `automation_runs` / `scheduled_actions` are 0010's tables, now platform-wide: runs
that are not lead conversations, a reviewed vocabulary of action types
(`automation_action_types`, drift-tested against `scheduler/model.ts`), and an attempt row
per claim (`automation_action_attempts`), which is never deleted or rewritten. Each type names
its dispatcher, and each claim path takes only its own. The Lead Recovery engine claims its
seven types and decides a pause at execution, cancelling contact. The scheduler's claim
re-reads a gate (run, tenant, lifecycle for the run's mode, health, connection) at the claim
and again at the start, and holds paused work rather than cancelling it. An external effect
is recorded as started before its outcome is accepted, and an ambiguous outcome, including
a lease that expired mid-effect, blocks the action until an operator reconciles it. Retries
back off by type and dead-letter at the cap. There is no in-memory scheduler store; test it
on real SQL (`tests/scheduler-db.test.js`).

**A runner moves authorised work; it never decides, configures, holds a credential or writes
state** (`_shared/runner/`, ARC-210, ADR ARC-010 §30). The orchestrator claims → starts →
dispatches a references-only `RunnerRequest` with a deadline → settles through the scheduler
service; `settlementFor` is the only place a runner's report becomes an outcome, and an
external effect whose outcome is unknown (timeout, exception, garbled result) is ambiguous,
never failed. An unknown runner kind is refused, never substituted. Every runner passes
`tests/runner-contract.js`; `FakeTestRunner` refuses production like ARC-130's doubles.

**The n8n bridge is built and disabled in production** (`0018`, `_shared/n8n-runner/`,
`runner-bridge`, ARC-220; ADR §15/§18/§19/§26). `N8nRunner` and the inbound handlers refuse
production, including an unset `ARC_ENVIRONMENT`, until the licensing gate is closed by a
recorded decision — never by editing code quietly. A dispatch is identifiers only, recorded
before it leaves; n8n learns the payload only from a signed, one-time envelope that
`open_runner_envelope` refuses (and voids) once the gate no longer allows the action. So a
voided dispatch whose envelope never opened provably did nothing, and is retried; anything
else unknown is ambiguous. Inbound: n8n's own JWT node signs (ADR §18 as amended by ARC-240 —
never an HMAC secret in a workflow); ARC checks signature, route, window and body hash before
parse, the nonce once, and takes the tenant from its own rows.

**Which workflow runs is ARC's assignment, never the runner's config** (`0019`,
`n8n/manifest.json`, `_shared/n8n-runner/{manifest,workflows,sync}.ts`, ARC-230; ADR §21/§29).
A version is registered from the source-controlled manifest, approved, deployed per environment
(the only table holding an n8n id) and assigned to one action type of one module version; a
reassignment retires the old row, and every dispatch records the assignment, checksum and error
handler it ran under, immutably. A module registered `direct` or n8n-`prohibited` — Lead
Recovery v1 — is never assigned one, so it can never be dispatched to n8n. The checksum is over
behaviour, not ids or layout; `checkWorkflowSync` reports drift and changes nothing.

**A shared workflow is a fixed frame around one module step** (`n8n/workflows/`,
`_shared/n8n-runner/{exports,failures}.ts`, `0020`, ARC-240). `workflowExportProblems` is the
frame, checked without n8n: ARC's JWT-verified webhook → answer the execution id → fetch the
envelope → the step → call back; only reviewed node types; every HTTP call to the bridge URL in
the one "ARC environment" node (a placeholder in the repo, set at import, left out of the
checksum); no credential but ARC's two JWT ones, no tenant id, no `$env`/`$vars`, no retained
execution data. A failed execution reaches ARC only through `arc-runner-error-handler-v1`, which
reports a category and the execution id — never the error's text — and ARC decides the outcome
(`failureOutcome`) from its own rows. `tests/n8n-sim.js` runs the real exports locally; conformance
with a real n8n is a hosted gate. After editing an export, `node scripts/n8n-manifest.mjs --write`.

**A client is created by one operator action, and its modules come from the registry** (`0021`,
`_shared/tenants/`, `ops` `tenant-create` / `tenant-modules`, ARC-300). `create_tenant()` writes
the tenant, selects each chosen module through 0015's own transition function (configuring —
never active), ticks `tenant_created`, and records who in `tenant_creations` and `admin_actions`,
in one transaction; 0021 drops the browser insert policy on `tenants`. `parseTenantInput` and
`moduleCatalog` (`tenants/model.ts`, portal-safe) are the one definition the form, the function
and the SQL agree on: a planned module, an alias, or one whose blocking requirements no connector
offers (`unsupportedRequirements`, also checked by `selectModule`) cannot be chosen. The client
page's modules panel (`ModuleSelection.jsx`) reads ARC-120's status and uses its select/deselect —
there is no second way to change a lifecycle. No client ever gets a workflow of its own.
A client that never did anything real can be deleted (`0022`, `purge_test_tenant`, `ops`
`tenant-purge`); the append-only guards make exactly one exception, inside that function for the
client it recorded in `tenant_purges`. Any client with history is refused and deboarded instead.

**A client's settings are edited on one page, drawn from the registry** (`ClientSettings.jsx`,
`ConfigEditor` / `ConfigHistory` / `ConfigReview`, ARC-310): a tab per configuration scope, each
a draft → server preview → publish, with history, compare and restore (a restore is the next
version; no row is rewritten). The screen decides nothing: `config-scope` sends the registry's
fields and `registry/layouts.ts` (presentation only — its options are the validator's constants,
drift-tested against the schema defaults), the engine validates, and `config-draft-preview`'s
`lifecycle_effect` is ARC-120's own classification (`config/settings.ts`). `lib/config-form.js`
only converts inputs to the document and back.

**A module goes live from one page that decides nothing** (`ActivationPanel.jsx`,
`_shared/activation/`, `ops` `activation-overview` / `connection-test`, ARC-320;
docs/architecture/ARC_ACTIVATION_CONSOLE.md). Readiness, transitions and history are ARC-120's
answers, and its buttons are ARC-120's `module-*` actions; connections are ARC-130's safe
summaries, worded by `activation/model.ts` (portal-safe, shared with the server), and connecting
or disconnecting is the `connections` function. A connection test is durable: a `connector_test`
run and a `test_connection` action, written first, then run through the ARC-210 orchestrator by
`ConnectionTestRunner`, which verifies through ARC-130 and holds no credential. The console's
pass runs only when everything the scheduler could claim for that client is a connection test;
otherwise the test stays queued. The page shows a credential's four-character hint and nothing
else of it, and the OAuth return page strips `code`/`state` before the Supabase client exists.

**A company takes one of three routes into ARC, and the words for them live in one file**
(`_shared/routes/model.ts`, `YourRoute.jsx`, ARC-330): `native` (no CRM — ARC provides it),
`hybrid` (keep some tools, ARC fills the gaps), `connected` (keep the stack, ARC is the layer on
top). The model is portal-safe, imports nothing and stores nothing; the `Your Route`
section, the pilot intake's route note and later onboarding read the same keys. Since ARC-MK-100
the section is parked — kept and tested, but not on the public homepage. `suggestRoute`
only suggests, and only when all five questions are answered — a route is confirmed in
authenticated onboarding; the route an operator records is `business_profiles.route` (0023). Customer-facing route copy never names n8n
or makes a CRM a requirement (`routeCopyProblem`). The section is read by a business owner, so
it shows one answer at a time: three choices in the owner's words (`situation`), one short panel
(three points at most), and the comparison and the questions folded away. Section chrome and each route's "today"
status are `site.routes`; `lib/track.js` is the site's analytics hook, a window event with no
listener and no vendor.

**The public homepage sells one thing, in an owner's words** (ARC-MK-100, `src/Site.jsx`,
`Leaks` / `Ledger` / `Price`, `tests/site-offer.test.js`). Missed calls texted back, with the
proof shown: the four leaks are a staged map (`site.leaks`, each `stage` a claim about today —
only move one when the thing behind it works end to end), the ledger's leads are labelled
examples, and every pilot number lives in `site.price.terms`, where null prints the row's words
and never a zero. The test reads the *rendered* page, so a word hardcoded in a component is
caught too: `ownerCopyProblem` (`src/lib/owner-copy.js`) fails on the machine's words, an
unsourced statistic or a CRM requirement, and the page may claim no speed that has not been
measured on a real line. Every "get my missed-call count" button opens one form
(ARC-MK-110, `PilotOverlay.jsx`, `site.pilot`, `lib/count-intake.js`,
`tests/count-intake.test.js`): six taps and a contact screen, no choice of services, and no
route shown or picked — a route reaches us only as a note in the post. The post is never
awaited, so a capture that fails cannot keep anyone from the calendar. The film in the hero and the past-builds sections are read separately.
The service menu (`site.workflows*`, still the key of `service-catalog.js`), the toolkit and the
route section are parked, not deleted.

**`/demo` opens on a proof ledger, and a status there is derived, never typed** (ARC-MK-120,
`src/portal/demo/proof-ledger.js`, `ProofLedger.jsx`, `tests/proof-ledger.test.js`). Seven
written example leads for a made-up heating and cooling company (`DEMO_TENANT` is HVAC now), each
with the same seven lines and a status with its reason. A lead states only what happened;
`ledgerVerdict` turns it into the ledger's facts (`ledgerFacts`) and reads the status with the
ledger's own rule (ARC-MK-210), the one a real lead goes through; only a status that reads
`counts` is billed. They are examples, not events — no figure reads them. Only the arrival and the
appointment carry a clock time. Since ARC-MK-200 the ledger is the demo's `jobs` screen, not its front page; a workspace
handed `data.proofLedger` that is *not* an owner workspace still opens on it
(`navGroupsFor(…, { ledgerHome })`). Only `Demo.jsx` hands one, and `NAV_ITEMS` is still thirteen.

**A launch client sees four screens, and which client that is is derived** (ARC-MK-200,
`lib/owner.js`, `OWNER_NAV_GROUPS` in `lib/nav.js`, `ThisMonth` / `Jobs` / `NeedsYou` /
`OwnerAccount`, `OwnerTabs`, `tests/owner-portal.test.js`). `isLaunchClient` reads it off
availability — lead capture and every other module `unavailable` — and `/demo` asks for it with
the `owner` prop; nobody sets it. The four are a second nav declaration beside `NAV_GROUPS`, never
a replacement: every original page keeps a route (only `overview` and the old account page, now
`account/details`, moved), and the ones still offered are listed under account → details. One
list feeds the jobs screen, the tally and "export my data" (`ownerJobs`): the demo's seven
examples with their verdicts, or the client's own threads drawn with the same card, each carrying
the verdict the ledger gave it (`thread.ledger`). `ownerMonth` returns a figure as null with its
reason when it cannot be shown; the fee is the ledger's (`data.ledger.month`), null until terms are
on record, and `owner.js` words figures without working any out. Needs-you is derived — the
outcome question is a lead whose status is `needs_owner` — and has no answer button until
ARC-MK-220. The account screen reads the client's settings through the `crm` function's
`account-settings` (`_shared/account/`): a field-by-field projection of the *published* Lead
Recovery configuration and `suppressions`, every address reduced to a hint server-side, for a
member of that tenant or an operator. It is a read; nothing in the portal edits a setting.

**Whether a job counts is one rule, read off the event log** (ARC-MK-210, `src/portal/lib/ledger.js`,
`_shared/ledger/model.ts`, `tests/ledger.test.js`; docs/architecture/ARC_PROOF_LEDGER.md). Six links
in order: a call or form arrived, nobody answered it live, ARC's text went out, the customer replied
(or booked it themselves), a visit was booked for a time that has passed, and the owner said it
happened — or was asked and the dispute window passed. The first missing link is the status and its
reason; a later link over a missing earlier one is `unverified`, shown and never billed. Nine
statuses, two billed, both reading "counts". `ledgerStatus` takes plain facts, so the demo's examples
and a real lead cannot disagree; `buildDashboardData` runs it over every lead, and nothing stores a
status. The new evidence is five event types — `call_answered` (a count: no lead, no number),
`lead_outcome_requested`, `lead_outcome_recorded`, `lead_dispute_settled`, and
`pilot_terms_recorded` in its own `account` group so terms never make a line read as live — plus
`lead_booked.payload.appointment_at`. The fee is `min(cap, base + per job × jobs that became
billable this month)` in the business's timezone, from terms that are themselves an event; no terms
is null, never zero, and there is no invoice or payment code. An answer is keyed on the row it
replaces, so a double tap is one row and a changed mind is a new one. A handoff is never billed,
silence never counts until something has asked the owner (nothing does before ARC-MK-220), and an
operator settles a dispute. The `ops` actions that write the evidence exist with no console button.

**There is one customer and lead model, for every route** (`0023`, `_shared/crm/`, `ops`
`crm-*`, ARC-340; docs/architecture/ARC_CRM_CORE.md). `crm_contacts`, `crm_leads`, pipelines,
notes, tasks, source records and external mappings, plus the business profile, locations,
service areas and services. On Native it is the CRM; on Hybrid and Connected it is ARC's working
copy, and `crm_source_policies` says which side owns each kind of record or field —
`writeDecision` refuses a write from the other side, and nothing is ever merged or "latest wins".
These are operational tables: no figure reads them, a contact holds no consent or opt-out
(`suppressions` is still the truth, read by reference), and no field accepts a secret-shaped
value. Every write names its actor and 0023 checks it again; the timeline (`crm_activities`) is
written by triggers and records field names, never values. Lead Recovery's `leads` stays the
engine's row — a CRM lead points at it; never build a second contact model. The business's name
and timezone stay the tenant's. Hours, public contact details and services are edited on the
onboarding page (ARC-390); locations, service areas and a field-by-field policy have no screen yet.

**A lead enters the CRM through one function, whichever door it came by** (`0024`,
`_shared/intake/`, `native-intake`, `ops` `intake-*`, ARC-350; docs/architecture/ARC_NATIVE_INTAKE.md).
A hosted form (`/form/<key>`, `PublicForm.jsx`; the embed is an iframe of it, never a script), an
API post with a hashed bearer token, a typed-in lead and a CSV all end in `crm_intake_arrival`:
source record, contact, lead and consent rows in one transaction behind one lock per client. It
returns `created`, `duplicate` (this person's open lead, inside the window) or `replayed`; it
never edits an existing contact and never guesses between two who share a number. Capturing is
not following up — nothing here writes `events`, `leads` or a run, and `lead-intake` stays Lead
Recovery's own door. A form is validated data with a closed field list and no logic
(`parseFormDefinition`, portal-safe, shared by the page, the console and the function). What ARC
knows about an arrival is on `crm_source_events`' own columns; what a browser claimed is under
`detail.claimed` and decides nothing. A consent record is evidence of what was shown and ticked,
not permission to send. A stranger is told only that it arrived; the form's key is not the
tenant's id. The console page is `IntakePanel.jsx` (`/ops/console/clients/:id/intake`).

**A business works its leads in one workspace, drawn for both sides** (`0025`, `_shared/crm/{inbox,workspace,actions}.ts`,
`crm`, `CrmWorkspace.jsx`, ARC-360; docs/architecture/ARC_CRM_WORKSPACE.md). The client's `lead inbox`
(`/portal/dashboard/inbox`, through the `crm` function as a `client_user` whose role is read from
`tenant_members`), the console's per-client page (`/ops/console/clients/:id/crm`, through `ops`) and
`/demo/inbox` (generated rows, read-only) are one component over one action table, so they cannot
disagree. Which leads need attention is `inbox.ts` — portal-safe, never stored: "not contacted" is the
pipeline's entry stage, "waiting on the customer" is the stage's `waits_on` (never its name), and blocked
is the suppression list and Lead Recovery's own row, by reference. Every write is still ARC-340's service
or ARC-350's `createManualLead`; a bulk change is each lead's own update. A stage keeps its key and kind,
and `crm_save_stages` is the only way to change a pipeline. A won stage is what a person set — it writes
no `events` row and no figure reads it.

**A conversation is kept by address, and a message a person writes is one action on the one queue**
(`0026`, `_shared/communications/`, `CrmConversation.jsx`, ARC-370; docs/architecture/ARC_COMMUNICATIONS_HUB.md).
`crm_conversations` is one thread per client, channel and address — like `suppressions`, so a merge moves
nothing; which customer it belongs to is read from the contacts holding that address, and two is never
guessed between. `crm_queue_message` writes the message, a `crm_message` run and a `send_message` action
(0017's own type) in one transaction, or nothing. The run is a module's: the service asks the registry for
a module that **requires** the channel's capability and is active (`modulesRequiring`) and never names
one, so pausing it holds a person's messages too. `crm_message_gate` — the do-not-contact list, consent
evidence, Lead Recovery still talking (`automation_active`: take the lead over first) and unread safety
flags — is read at queueing and again under the message's lock in `crm_message_begin_send`; the action's
payload is `{ message_id }` only. `MessageSendRunner` reports a send as sent, provably-not-sent (retryable
or not) or **unknown**, and an unknown outcome is never resent until an operator reconciles it
(`deliveryState` shows one truth from the message and its action). Inbound is `ingestInboundMessage` →
`crm_message_arrival`: once per provider id, STOP read by `engine/rules.ts` and written to `suppressions`
in the same transaction, a credential-shaped body withheld rather than refused; no signed-in person can
post one. Lead Recovery's own `messages` are shown in the timeline by reference, never copied, and a
note is a different table with no path to a send. Nothing here writes `events`. **No client can send
yet**: `PRODUCTION_CHANNEL_ADAPTERS` is empty (Twilio is `arc_managed`, not a client connection), so the
screen says there is no channel; a send through ARC's Twilio is ARC-LR-420's. `synthetic-channel.ts` is
the test adapter and refuses production.

**A lead becomes an appointment, and a time is given to one booking** (`0027`, `_shared/booking/`,
`native-booking`, `CrmBooking.jsx`, `PublicBooking.jsx`, ARC-380; docs/architecture/ARC_BOOKING.md).
A hosted page (`/book/<key>`; the embed is an iframe of it), a person booking from a lead, and the
workspace's `bookings` view all end in `crm_book_appointment`; a stranger's booking goes through
ARC-350's own `crm_intake_arrival` in the same transaction, so there is no second way to make a
customer or a lead. Which times are offered is `availableSlots` (portal-safe: opening hours in the
business's own timezone, notice, horizon, buffers, capacity) and is only an offer — the time is given
by `crm_appointments_guard` under one lock per client, whichever path wrote the row. `requested` and
`confirmed` hold a time; the legal changes are `APPOINTMENT_TRANSITIONS`, drift-tested against the
guard, and the screen's buttons are `nextActions` over that list. Whose calendar it is is ARC-340's
policy with `object_type: appointment`: where theirs owns the time ARC offers none, takes a
`requested`/`pending` preferred time, and nobody on ARC's side confirms or moves it; a report that
disagrees with a field ARC owns (`crm_appointment_external_report`) is never applied and never
dropped — the appointment is frozen until a person settles it. A customer's own link is a token kept
only as its hash, in the address's fragment and a request body, never a query string. Nothing here
writes `events`, sends a message or queues a reminder: a confirmed appointment is a calendar entry,
not a result, and telling the customer is ARC-370's. Not dispatch — `capacity` is a number,
`assigned_user_id` a name. No calendar adapter exists, so nothing reports and nothing is pushed.

**A company is put on a route from one page, and a plan is only a plan** (`0028`,
`_shared/onboarding/`, `ops` `onboarding-*`, `OnboardingPanel.jsx`, ARC-390;
docs/architecture/ARC_ONBOARDING.md). Three things kept apart: what the business said
(`answers`), an operator's decision (`plan`: a route and, per capability, `arc` / `external` /
`not_needed`), and the capability matrix — derived on every read, never stored, so a capability
is `arc` only once the ARC piece exists and `external` only once ARC can reach their system;
everything between is `blocked` with the reason. A capability is something a business does,
never a product (`CAPABILITIES`, portal-safe; not the registry's adapter capabilities), and the
route rules are `parsePlanInput`'s, checked again by 0028's guard. Saving a plan writes the plan:
it selects no module, records no route, publishes nothing and moves no record
(`recommendPlan` returns data). The route and who keeps each kind of record
(`business_profiles.route`, `crm_source_policies`) change only in `onboarding_apply_authority`,
which re-derives the change and refuses unless the caller sends back the digest of what it
read; nothing is deleted in either direction, so a route can change later with every record,
mapping and history line kept. Steps are read off `onboarding_facts` — never ticked — and
`onboarding-enable` makes ARC pieces as drafts through the services that own them. Operators
only; a client does not see it yet. Going live is still ARC-120's gate.

**The words on screen are the system's words, each with its meaning attached** (ARC-340 clarity
pass, `lib/glossary.js`, `Term` / `Consequence` in `ui.jsx`). A state name is never renamed or
hidden to make a page simpler: wrap it in `<Term k="…">` and add the gloss to the glossary.
`ActionButton` prints what a confirmed action will do before it is pressed (`consequenceOf` takes
it from the `confirm` text; pass `consequence` when the confirmation is only a question) and the
confirmation itself never changes. An icon-only shell button needs an `aria-label`, and a figure
that is not available is a dash, a spoken "not available" and the reason. `tests/ux-clarity.test.js`
holds all of it, including that no page was removed from either nav.

Requires `supabase/migrations/0003_client_ids_and_ops.sql` plus the
`client-login` and `ops` edge functions; the console's Supabase page probes for
all of it and says what is missing. Deboarding and restore need `0007`; service
checklists need `0008`; the live pipeline check's workflow rows need
`N8N_API_URL` and `N8N_API_KEY` set as secrets on `ops`.

Arc sells services, not hours. What each client bought, and the build checklist
behind each service, is `client_services` / `client_service_steps` (`0008`),
seeded from `lib/service-catalog.js` (keyed on the `site.js` workflow ids) and
tracked in `BuildPanel`. A build's stage is read off its ticked steps
(`buildProgress` in `lib/builds.js`), never stored; "delivered" means the
checklist is done, not that anything is sending — that is still
`pipelineVerdict`.

## The revenue lifecycle (`0009`)

The client workspace covers five modules, not one pipeline: **lead capture**
(`/leads`), **estimates**, **reviews**, **memberships**, **installs**. Each one
folds its records out of the same `events` log by `entity_id` — the same trick
`buildThreads` plays with `correlation_id` — in `lib/lifecycle.js`. There are no
tables for estimates, reviews, memberships or installs, deliberately: the
client's CRM is the system of record and a synced copy of it would be stale
between syncs and wrong after a failed one.

Three rules the code enforces rather than asserts, each with tests named after
the promise:

- **A module is live, awaiting connection, or not part of the plan**
  (`lib/modules.js`), from `tenants.modules` plus what the log shows —
  observation always wins. A module that is not live renders `—` and the
  reason. **It must never render 0.**
- **"Recovered" needs all four links** — the estimate with an amount, a
  follow-up that actually left, the answer after it, and the approved value
  from their system. An approval with no follow-up is approved, not recovered.
  Gross profit additionally needs a margin they sent us.
- **"Working" needs evidence** (`lib/health.js`) — a canary, a schema assert or
  a volume watermark. A module with events and no check reads `unverified`.
  A green n8n execution is never enough.

The needs-attention queue (`lib/attention.js`) is derived from record state, not
stored. Stop-on-reply, review gating, safety handoff and registration evidence
are each counted as breaches from the log, so the portal shows a rule held
rather than claiming it.

Event vocabulary lives in `lib/types.js` and is mirrored at the ingest boundary
in `functions/_shared/event-validation.ts` (which `functions/ingest/validate.ts`
re-exports, so the documented name still points at the door); an event's
**module is derived from its `event_type`**, never stored. Arc's own functions
emit through the same validator — there is one door into `events`, not two.
Run `npm test` (node's runner, no deps — it strips the edge functions'
TypeScript natively, which is why `functions/_shared/**` imports nothing from
`jsr:`) and `npm run smoke` (renders every public page in a real browser; needs
`npm i --no-save playwright-core`).

A client's pipeline status in the console is `pipelineVerdict` (`lib/ops.js`)
and nothing else: green only on evidence from the live check or the event log,
never from a status somebody typed. Past (archived) clients are split off in
`OpsWorkspace` and left out of every total.

## The roadmap (`docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md`)

The canonical ARC implementation roadmap, and the primary document of the console's
**Roadmap Assistant** (`ops` actions `roadmap-status` / `roadmap-ask`,
`_shared/roadmap/`, `RoadmapAssistant.jsx`). A new revision replaces this file in place.
The function reads it from `main` at request time, so pushing is the update and there is
nothing to regenerate. Alongside it, every question is also searched against the other
architecture docs (`_shared/roadmap/corpus.ts`, `CORPUS_DOCS`) — best-effort, so one missing
or not yet pushed simply contributes nothing, never an error. Never write a roadmap fact into
the assistant's code: a test fails on any `ARC-nnn` identifier there. Answers that cite
nothing, or name an ID or date the excerpts lack, are withheld. The model is Anthropic,
OpenAI, Google's Gemini or Groq (`ARC_ROADMAP_PROVIDER`; Groq's free tier is the one that has
actually asked no account for billing). With no model (no
key, `ARC_ROADMAP_PROVIDER=search`, or a model that fails) it shows the matching documents'
own passages (`search.ts`, status `excerpts`) and never writes a sentence. See
[docs/architecture/ARC_ROADMAP_ASSISTANT.md](docs/architecture/ARC_ROADMAP_ASSISTANT.md).

## Shipping

Pushing `main` **is** the deploy (`.github/workflows/deploy.yml`), and this repo
is public. A `Stop` hook (`.claude/settings.json` → `scripts/autoship.mjs`, see
the `ship-to-live` skill) runs after every finished prompt: it runs `npm test`
and, only if that passes, commits and pushes just the files this session edited.
So don't push by hand at the end of a turn, and never `git add -A` here — other
sessions share this working tree. Edit through Write/Edit; files changed via Bash
are not tracked. If the hook reports `NOT pushed`, fix the failure first.

**Say what a change means for arcautomation.site.** Whenever a turn edited files,
end the reply with a line stating whether it is **visible on the live site** (and
which page) or **backend only** (a migration or edge function, which reaches GitHub
but not the database or Supabase until deployed). Get it from
`node scripts/site-impact.mjs <files you edited>` — never from the folder name,
because `src/` imports files under `supabase/` — see the `site-impact` skill.
`autoship` prints the same verdict after it pushes.

## Versioning

This repo is versioned with [SemVer](https://semver.org/), tracked in the
root `version` field of [package.json](package.json) and logged in
[CHANGELOG.md](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/)
format).

- As you make changes in a session, add bullets under the `## [Unreleased]`
  section at the top of `CHANGELOG.md` (Added / Changed / Fixed / Removed).
- When a unit of work is done — a feature, a fix, a batch of related
  changes — bump `version` in `package.json` and turn `[Unreleased]` into a
  dated version section: **patch** for fixes/tweaks/copy, **minor** for new
  features or pages, **major** for breaking changes (routes, data shape,
  auth). Leave a fresh empty `[Unreleased]` section above it.
- **At the end of every chat, state the current version number and a short
  summary of what changed in that session**, as the closing line(s) of the
  final response — even if the version didn't bump.

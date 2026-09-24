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

The canonical ARC implementation roadmap, and the only knowledge of the console's
**Roadmap Assistant** (`ops` actions `roadmap-status` / `roadmap-ask`,
`_shared/roadmap/`, `RoadmapAssistant.jsx`). A new revision replaces this file in place.
The function reads it from `main` at request time, so pushing is the update and there is
nothing to regenerate. Never write a roadmap fact into the assistant's code: a test fails
on any `ARC-nnn` identifier there. Answers that cite nothing, or name an ID or date the
excerpts lack, are withheld. See [docs/architecture/ARC_ROADMAP_ASSISTANT.md](docs/architecture/ARC_ROADMAP_ASSISTANT.md).

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

# Portal rebuild handoff

Frontend implementation, October 11, 2026. This release performs no campaign activation,
messages, migrations, provider purchases or credential changes.
The previous prompt-ID sequence is paused; its historical roadmap remains intact.

## Routes and implementation

`/portal` retains the existing entrance, branding, authentication link and visual behavior,
with updated product guidance. `/portal/dashboard/*` retains authenticated tenant loading.
`/demo/*` supplies an isolated synthetic adapter to the same product components.
Primary paths: index (Overview), `leads`, `campaigns`, `inbox`. Secondary paths:
`setup`, `leads/sources`, `connections`, `settings`, `billing`, `help`.
Campaign and conversation details use `campaigns/:id` and `inbox/:id`.

Existing `jobs`, `needs-you`, `account`, `account/details`, `activity`, `automations`,
`reliability`, `reports`, and other valid account-tool routes preserve their working
implementation. They have a return link to the new product. Their old demo archive is
explicitly labeled separately from the interactive scenario. Public homepage, public
navigation, marketing/pricing, global cursor and hover/falling-text code were not edited.
`account/records` retains the original contact/task/pipeline workspace and
`account/summary` retains the original monthly fee evidence, both linked from Business Settings.

## Action to backend map

| UI action | Current production capability | Demo behavior / next integration |
|---|---|---|
| Sign in, load account | Existing Supabase session, tenant membership and RLS | Demo never authenticates |
| View Overview and Leads | Existing authenticated dashboard event/thread projection; unknown permission remains unknown | Counts derive from one dated synthetic event ledger |
| View qualification, source evidence, activity | Shows facts actually present; absence is not manufactured | Coherent synthetic evidence, answers, campaign membership and messages |
| Save business/setup | Published settings read via existing `crm/account-settings`; configuration writes and onboarding remain staff-only | In-memory edits; safe sample progress resumes in the tab |
| Create/edit/duplicate campaign | In-memory configuration preview only; no client campaign save endpoint | Editable shared builder; edits of running versions become separate drafts |
| Preview/test campaign | No production activation or execution request | Explicit sample scenarios, first response, question-by-question qualification and owner summary |
| Pause/resume campaign | New builder blocks unsupported runtime changes; existing operations tools retained | Review dialog changes synthetic runtime only |
| Connect source / number | Existing staff setup, connection verification and activation console remain authoritative | Explicit simulated verification/failure; no URL-as-proof or network transport |
| CSV mapping and preview | Shared existing intake parser, mapper and validation run locally; no import endpoint invoked | Local only; duplicates in file detected, eligibility stays unverified |
| Production inbox/read/reply | Existing `crm-conversations`, `crm-thread`, message/mark-read methods and server-gated composer reused | Separate synthetic messages, unread state and authorship |
| Take over/resume automation | No client acknowledgment endpoint connected; unavailable notice, never inferred from assignment | Explicit confirmation, stop/resume policy and recorded demo-owner actions |
| Owner-reported booking | Existing outcome/job tools retained | Labeled owner report; stops automation without verified booking/revenue evidence |
| Billing | No subscription/payment provider data exists in this projection; existing pilot fee evidence remains reachable | No fabricated price or balance |

OPS already has tenant setup, connections, configuration versions, onboarding, readiness,
activation, mission control and support diagnosis. No new OPS controls were necessary;
staff authorization and all execution boundaries remain unchanged. Client preview edits
are deliberately not visible in OPS as if they had been saved.
The existing dashboard loader now explicitly filters events and alerts to the selected
tenant in addition to RLS, preventing mixed-business displays for users with multiple memberships.

## Contracts and the next backend connection

`src/portal/product/contracts.d.ts` documents projections for business, connections,
campaign configuration/version, readiness, permission evidence, leads, answers, messages,
events and metrics. `model.js` owns preview validation and deterministic demo decisions.
`production.js` projects existing authenticated data and imports no fixtures or storage.
`demo/product-demo.js` has no transport, credentials or production adapter imports.

Do not persist this UI object wholesale into a new database. Add a server-authorized
client projection/save operation over the existing versioned configuration store, with
schema validation, optimistic version checks, audit author, timestamps and idempotency.
Server-derived tenant and actor must be checked independently of the client's tenant hint.
Return structured readiness blockers from the existing lifecycle/connection services.
Publishing is separate from activation; reviewed changes never silently alter existing runs.

Future ARC-to-n8n work must use the existing runner boundary: pinned configuration version,
tenant-scoped event IDs, authenticated trigger and callback, one-time payload envelope,
idempotent effect reservation and deduplication, suppression/cooldown/contact-limit checks
immediately before each effect, delivery updates that separate accepted/sent/delivered,
and acknowledged owner handoff. A timeout is unknown, not permission to retry a send.
Lead Recovery remains the current direct engine; this frontend does not move it to n8n.
The bridge's production gates remain unchanged. These are contracts, not a live integration.

## Data and preview limits

- Demo fixtures use one fictional company and reserved fictional phone numbers, with a
  fixed October 11, 2026 clock advanced only by explicit actions. No random render-time counts.
- Session storage contains only known fictional business values, step number, source-state
  enums and campaign kinds. Contacts, imported CSV, messages and arbitrary free text are
  never stored. Text/configuration edits remain in memory; after refresh, sample campaign
  templates restore as drafts. Each tab has its own storage scope; reset is explicit.
- Production preview drafts are in memory only. Existing published settings remain the source
  of truth. No public self-signup was invented; the existing authenticated handoff is retained.
- New metrics with insufficient permission/qualification evidence are withheld. Legacy
  evidence reports remain available. No assumed job value, revenue generated or hours saved.
- Follow-up policy checks are simulations, not the scheduler. No bulk sending, new provider,
  new prospect database, live campaign activation or payment integration was implemented.
- Provider requirements were checked against [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy)
  and [ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv).
  US registration/approval and purpose-specific recipient permission are separate requirements.
  Recheck them and validate real forwarding/voicemail behavior before any live implementation.

## Verification

Baseline: `npm test`, 2,033 passing tests. Added focused tests in
`tests/portal-product.test.js`. `scripts/portal-rebuild-smoke.mjs` checks responsive layouts,
the new-account journey, qualification, takeover, opt-out, imports, modal keyboard handling,
and blocks/records every external request from the demo. Screenshots and logs are local in
`dist-smoke/rebuild/`. `scripts/portal-capture.mjs` records homepage, entry and demo comparisons.
Final check results are recorded in the delivery response. This repository has no lint or
typecheck script. Authenticated hosted data and real provider behavior require a test account
and were not exercised; no live campaign was activated for verification.
`npm run gate` was attempted but reported NOT RUN because PGlite is not installed. The ordinary
test runner's passing summary is not a substitute for that SQL gate; no SQL-gate success is claimed.

Final local checks: 2,050 unit/contract tests passed; production build passed (existing large-chunk
warning remains); existing browser smoke passed 48/48 renders; the new browser journey passed
with 27 screenshots across 360/768/1440px and zero external requests. Built-route checks verified
demo isolation, compatibility routes, auth gating and the homepage cursor. Homepage screenshots
kept identical dimensions at all three widths with 0% of pixels differing by more than 20/255
in any color channel. No standalone lint/typecheck command exists in `package.json`.

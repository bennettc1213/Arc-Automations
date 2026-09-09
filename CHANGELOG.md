# Changelog

All notable changes to this site (portfolio + the Arc client portal) are
documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versioned with
[Semantic Versioning](https://semver.org/) via `package.json`.

## [Unreleased]

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

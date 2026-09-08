# Changelog

All notable changes to this site (portfolio + the Arc client portal) are
documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versioned with
[Semantic Versioning](https://semver.org/) via `package.json`.

## [Unreleased]

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

[Unreleased]: https://github.com/bennettc1213/Arc-Automations/compare/21bb26b...HEAD
[1.4.0]: https://github.com/bennettc1213/Arc-Automations/compare/21bb26b...HEAD
[1.3.2]: https://github.com/bennettc1213/Arc-Automations/commit/21bb26b
[1.3.1]: https://github.com/bennettc1213/Arc-Automations/compare/4ff072f...7437bb8
[1.3.0]: https://github.com/bennettc1213/Arc-Automations/compare/3e61cd8...4ff072f
[1.2.0]: https://github.com/bennettc1213/Arc-Automations/compare/386398e...3e61cd8
[1.1.0]: https://github.com/bennettc1213/Arc-Automations/compare/4d55b04...386398e
[1.0.0]: https://github.com/bennettc1213/Arc-Automations/commit/4d55b04

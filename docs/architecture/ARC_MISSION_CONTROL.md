# ARC Mission Control · ARC-ECO v1

Internal route: `/ops/console/ecosystem`. Open **AI Ecosystem** on the OPS roster or sidebar, then select a client. The existing `Ops` gate checks `is_arc_admin`; all event and provider reads retain Supabase RLS and an explicit tenant filter. No new service-role endpoint, migration or production runner is required.

## Scope

One agent, Damon Reid, represents the existing missed-call recovery engine. Eleven stations cover signals, qualification, Twilio messaging, booking, proof, safety, business configuration, command, Obsidian, and reserved n8n/voice facilities. The n8n runner remains gated, and outbound AI calling is not implemented. No additional customer-facing agents or modules are enabled.

Three.js renders original voxel geometry with a gently following camera. **2D free cam** opens a draggable top-down map with the same stations and event-driven agent. Zoom, reset, reduced motion, keyboard panning and automatic WebGL fallback are provided. The route and Three.js are lazy-loaded.

## Evidence and connection semantics

- `useMissionFeed` reads the selected tenant’s latest 300 events, subscribes to tenant-filtered inserts and reconciles every 8 seconds. Realtime publication can be unavailable: the screen then says **polling**. Polling pauses when the tab is hidden and resumes on visibility.
- Client changes remount the feed, scene and local memory session; old responses are discarded. Event IDs deduplicate stream and poll deliveries.
- Historical reads never animate work. Only newly observed, recent events move Damon; after 25 seconds without a fresh task he waits at command. Events are evidence of backend actions, not commands to an agent.
- Station indicators distinguish errors, review, evidence received and unverified readiness. No activity is not proof of a healthy system. The global health label stays **unverified**; client activation remains authoritative.
- The footer counts events in the explicitly labeled loaded window, not business totals or revenue. Bookings and completed runs do not establish billability. Queue depth and confirmed recovered jobs are not available in this view.
- The station’s configuration links use the existing versioned editor and activation checks. A graphical connection never activates an automation.
- A closed metadata allowlist omits raw contact data, message bodies and credentials from the scene and memory export.
- The simulated client has a distinct tenant ID and persistent simulation labeling. Three deterministic replays cover recovery, safety stop and delivery failure; they make no network writes or customer contacts.

## Connecting Obsidian

Obsidian stores Markdown notes in a local vault folder: https://help.obsidian.md/vault and https://help.obsidian.md/data-storage.

1. Open Obsidian and create a vault, or locate your existing vault folder.
2. In ARC, open **OPS → AI Ecosystem → your client → Memory**.
3. In Chrome or Edge, click **Connect vault folder**, select the vault’s root folder, and allow write access.
4. ARC creates exactly `Damon Read Memory/<tenant-uuid>/`, with `Index.md`, `Context.md`, and `Events/<event-id>.md`.
5. Check that the memory panel reports notes written and that they appear in Obsidian. Folder access is local to this browser session; reconnect after reopening the page. Demo notes go under `demo-hvac`, separately from real clients.

The browser mirrors its loaded 300-event window and subsequent observed events while open. **Download loaded journal** is a fallback for browsers without folder access. It is not a complete historical backup.

### Full history and ongoing logging

The included local bridge backfills the complete event ledger for one client and continues every 10 seconds without requiring the portal tab. From this repository in a terminal:

```powershell
npm run memory:sync -- --vault "C:\Users\you\Documents\ARC Vault" --tenant "CLIENT-UUID-FROM-MEMORY-PANEL"
```

The project’s `.env.local` supplies `VITE_SUPABASE_URL` and the browser-safe `VITE_SUPABASE_ANON_KEY`. Sign in using your existing OPS email and password at the terminal prompt. The password is hidden, credentials are never written to the vault, and no service-role key is needed. `--once` does a backfill and exits. Keep the terminal and computer running for continuous logging; after a restart run the command again. It rescans history without duplicating event files and preserves operator edits to `Context.md`. There is also an hourly full reconciliation for late commits.

### Memory boundaries

This version builds the persistent **evidence memory** and connection workflow. It logs every available event, including structured decision/outcome codes when the backend records them. It cannot log a decision that was never emitted. It does not expose private model reasoning.

Production classifier retrieval from Obsidian is **not enabled**. The browser cannot make a local vault available to a hosted runtime while the computer is offline. A later reviewed backend adapter must retrieve only the selected tenant’s approved context, handle untrusted text as data, retain deterministic safety rules, and record source references. Editing Obsidian does not change active workflows. Current business rules must be edited in ARC’s versioned settings.

## Verification and deployment

`npm test`, `npm run build`, `npm run smoke`, and `npm run smoke:ecosystem`. The ecosystem smoke uses a temporary local-only harness to render the actual protected feature over demo fixtures; no authentication bypass is shipped. It checks client selection, both cameras, replay, station details, memory export, reduced motion, mobile layout and a forced WebGL failure. The public production route remains behind the OPS gate.

Deploy the frontend through the existing main-branch GitHub Pages workflow. No unrelated migrations are part of this feature.

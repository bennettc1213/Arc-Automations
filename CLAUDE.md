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

Both doors share one entrance animation (`portal/lib/entrance.js`) and both
workspaces share one shell (`Sidebar`, `Topbar`, `CommandPalette`) over
different nav declarations. Every figure on either side is derived by the same
code from the `events` log — there is one derivation chain, so the console and
a client's dashboard cannot disagree.

Requires `supabase/migrations/0003_client_ids_and_ops.sql` plus the
`client-login` and `ops` edge functions; the console's Supabase page probes for
all of it and says what is missing.

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

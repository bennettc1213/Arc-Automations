---
name: ship-to-live
description: >
  Ships finished work to the live site. In this repo pushing main IS the deploy
  (.github/workflows/deploy.yml publishes GitHub Pages), and a Stop hook does it
  automatically after every prompt. Use when the user says ship, deploy, push
  live, "is it live", "why didn't that go out", asks to turn auto-shipping on or
  off, or when a turn ended with an "autoship:" message.
---

# ship-to-live

Every finished prompt is committed and pushed to `main`, which deploys the site.
Nothing here is done by remembering to: two hooks in
[.claude/settings.json](../../settings.json) run [scripts/autoship.mjs](../../../scripts/autoship.mjs).

## What happens

1. **Track** (PostToolUse on `Write|Edit|NotebookEdit`): the edited path is
   appended to `.claude/autoship/<session_id>.txt` (gitignored).
2. **Ship** (Stop, when the turn ends), only if that session edited something:
   - keep only paths that changed, are inside the repo, and are not gitignored
     or secret-shaped (`.env*`, `n8n.env`, keys, the two private working docs)
   - stop if not on `main`
   - run `npm test`. **Any failure means nothing is committed or pushed.** The
     files stay local and the list is kept, so the next finished prompt retries
   - `git add` and `git commit` **only those paths**, then `git push origin main`

The staging is scoped because several sessions edit this checkout at once.
`git add -A` here would publish someone else's half-finished work, and this repo
is **public**: whatever ships is immediately live and readable by anyone.

## Reading the result

The hook prints one `autoship:` line at the end of the turn.

| Message | Meaning |
| --- | --- |
| `shipped N file(s) as <sha>` | Live. Pages is building; the link goes to the Actions run. |
| `NOT pushed. npm test failed` | Fix the failure (tail is shown), then finish any prompt. |
| `not shipping ... on "<branch>"` | Only `main` deploys. |
| `committed <sha> locally but the push FAILED` | Usually the remote moved. `git pull --rebase`, then finish a prompt. |
| (nothing) | Nothing this session edited had changed. |

Under it, a second line says what the change means for the live site:
`arcautomation.site: VISIBLE`, or `NO VISIBLE CHANGE. This is backend code.` (which also
names the `supabase db push` or function redeploy it waits on). "Shipped" only means
the code reached GitHub; backend code is not deployed by it. See the `site-impact` skill.

## Limits worth knowing

- Files created or changed through Bash (`mv`, `sed -i`, generators) are not
  tracked. Edit through the Write/Edit tools, or ship them by hand.
- If two sessions edit the **same file**, whichever finishes first ships both
  sessions' changes to it.
- Commit messages are generated (`Update a.js, b.js` plus the file list). For a
  descriptive message, commit by hand.
- Version bump and changelog (see CLAUDE.md) are still a per-unit-of-work
  decision, not per-prompt: they ship only when edited in that session.

## Manual run and switching off

- Dry run, everything except add/commit/push:
  `echo '{"session_id":"<id>"}' | AUTOSHIP_DRY_RUN=1 node scripts/autoship.mjs ship`
- Off for one machine: put `"disableAllHooks": true` in
  `.claude/settings.local.json`. Off for everyone: delete the two hook entries.
- Hooks load at session start. After editing `settings.json` open `/hooks` once
  or restart.

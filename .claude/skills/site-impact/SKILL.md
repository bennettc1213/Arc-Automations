---
name: site-impact
description: >
  Says whether a change is visible on arcautomation.site or is backend-only code.
  Use at the end of every turn in which you edited files, and whenever the user asks
  "can I see this on the site", "is that live", "is this just backend", "will this
  change anything on the website", or "why can't I see it". Reads the answer off the
  import graph with scripts/site-impact.mjs, because folder names get it wrong here.
---

# site-impact

The owner cannot tell from a diff whether a prompt changed something they can go and
look at, or only code that runs on a server. Every turn that edits files ends by
saying which.

## At the end of a turn that edited files

1. List the repo-relative paths you changed with Write/Edit this turn. Include files
   you changed through Bash too. autoship does not track those, so say they will not
   ship by themselves.
2. Run:

   ```
   node scripts/site-impact.mjs <path> <path> ...
   ```

3. Put the result in the closing lines of your reply, as one to three plain
   sentences, above the version line CLAUDE.md asks for:

   > **On arcautomation.site:** visible at /demo and /ops/console. Live about 2
   > minutes after the tests pass and autoship pushes.

   > **On arcautomation.site:** no visible change. Backend only. It reaches GitHub,
   > but the database and edge functions don't change until you run `supabase db push`
   > and redeploy `ops`.

   A turn that edited nothing needs no line.

The hook prints the same verdict after it pushes (or fails to). It runs after your
reply is finished, so it can confirm what you predicted, but it cannot replace saying
it.

## Reading the verdicts

| Verdict | Means | What to tell the user |
| --- | --- | --- |
| `VISIBLE` | A page's bundle, or the demo data built into it, contains the file. | Where to look, and whether it needs a sign-in (the script names it). |
| `NO VISIBLE CHANGE. This is backend code.` | Only migrations or edge-function files. | It is on GitHub, not in the database or the running functions. Say which deploy: `supabase db push`, or redeploy the named functions. |
| `NO PAGE CHANGE. Build/deploy config only` | `vite.config.js`, workflow files, the lockfile. | The site rebuilds the same way. Nothing new to see. |
| `NO CHANGE. Tests, docs or tooling only` | Nothing the site or the backend runs. | Say so plainly. |
| `Not imported by any page` | A `src/` file nothing reaches. | It is dead code as far as visitors go. Say so. |

A change can be both: **visible and also backend**. `supabase/functions/_shared/registry/modules.ts`
is imported by the portal, so the site shows it, and the `ops` function also needs
redeploying for the backend to agree. Report both.

## Why it reads imports, not folders

`src/portal/lib/modules.js` imports files from `supabase/functions/_shared/`, and
`OpsHome.jsx` imports `package.json` to print the version. So "under `supabase/` means
backend" and "under `src/` means visible" are both wrong. The script walks the imports
from `index.html`, from each route's page and from each edge function, the same way the
build does. Add a route to `src/App.jsx` and it is still classified visible, just
labelled "every page" until its entry is added to `ROUTES` in `scripts/site-impact.mjs`.

## Limits, say so if they matter

- It reads the code, not the deployment. It cannot tell you the Pages build succeeded,
  or that a migration was already applied. For the first, the link in the autoship
  message goes to the Actions run. For the second,
  `npx supabase migration list` and `npx supabase functions list` are read-only.
- "Visible" on `/portal/dashboard` or `/ops/console` means visible **after signing in**.
  `/demo` mirrors the client dashboard with generated data and needs no account, so it
  is the place to send someone to look.
- Demo numbers are regenerated at build time, so a change to the code that computes them
  shows on `/demo` even though the page never imports that code.
- A change can be visible and still wrong if the database behind it lacks a migration.
  The site falls back for some of that (see CLAUDE.md), so "visible" does not mean
  "working end to end".

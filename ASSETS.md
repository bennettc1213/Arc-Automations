# ASSETS.md — drop your real media here

Put files in **`src/assets/media/`** using these exact filenames. They are
picked up automatically on the next dev-server reload or build — no code
changes needed (`src/lib/media.js` globs the directory). Until a file exists,
its spot renders as a designed slot naming the file it is waiting for. That is
deliberate: an honest placeholder beats stock imagery. It is still a
placeholder, though, and a prospect should never see one.

## The only files the site is currently waiting on

Every `.slot` on the site comes from one place — the work index
(`site.workIndex` → `WorkGrid.jsx`). Five rows, five files:

| File | Row | Spec |
| --- | --- | --- |
| `speed-to-lead-canvas.png` | n8n speed-to-lead | full-res n8n canvas screenshot |
| `lead-qualification-canvas.png` | lead qualification agent | full-res n8n canvas screenshot |
| `warranty-tracker-canvas.png` | warranty expiration tracker | full-res n8n canvas screenshot |
| `rue-noir-cover.jpg` | rue noir coffee | hero frame, 1920×1080 |
| `missed-call-canvas.png` | missed-call text-back | full-res n8n canvas screenshot |

Export the canvas screenshots **wide and readable**. The row's reveal panel
scrolls rather than squashing, so do not crop a wide flow to fit — a legible
n8n canvas is the single most persuasive image on the site, because it is the
one thing a competitor's template-built page cannot show.

**Verify:** load the deployed site, scroll the whole page, and run
`document.querySelectorAll('.slot').length` in the console. It must be `0`.

## Also edit (in `src/data/site.js`)

- **Lead capture** — `pilot.captureUrl` is empty. Until it holds an n8n
  production webhook URL, a visitor who completes the intake overlay is not
  recorded anywhere and the final step falls back to a `mailto:`. This is the
  highest-value string in the file.
- **Booking backend** — `pilot.booking`: set `provider` to `'ghl'` or
  `'calcom'` and paste your calendar/event link as `embedUrl`.
  `buildEmbedSrc()` already prefills name, email, phone and the intake answers
  for both providers; it simply never runs while `provider` is `null`.
- **Email** — `site.email` is still a gmail address. Swap it for the domain
  mailbox when it exists. `site.opsEmail` is a **login**, not display text:
  read the S7 runbook in `ARC_FIX_CHECKLIST.md` before touching it, or you
  will lock yourself out of `/ops`.
- **Live URLs** — when a private build goes public, set its `url` field and the
  index row links out instead of printing the status label. Never point `url`
  at something that is not live.

Everything is lazy-loaded (`loading="lazy"` / `preload="metadata"`), so
full-res files are fine.

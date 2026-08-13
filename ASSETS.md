# ASSETS.md — drop your real media here

Put files in **`src/assets/media/`** using these exact filenames. They are
picked up automatically on the next dev-server reload or build — no code
changes needed. Until a file exists, its spot renders as a designed slot
naming the file it's waiting for.

## Featured project cards

| File | Used in | Spec |
| --- | --- | --- |
| `rue-noir-01.jpg` … `rue-noir-04.jpg` | 03 rue noir demo — frames crossfade behind the live type echo | hero frames, 1600×1200+, exported dark-ish so the ink type stays readable |
| `youtube-thumb-01.jpg` … `youtube-thumb-06.jpg` | 05 youtube grid | 1280×720 thumbnails |
| `youtube-clip-01.mp4` … `youtube-clip-06.mp4` | optional — hover-to-play over the matching thumb | short muted clips, ≤10 s |

## Work index (hover-reveal grid)

| File | Row | Spec |
| --- | --- | --- |
| `speed-to-lead-canvas.png` | n8n speed-to-lead — also tab 01 of "the workflows" | full-res n8n canvas screenshot |
| `lead-qualification-canvas.png` | lead qualification agent — also tab 03 of "the workflows" | full-res n8n canvas screenshot |
| `warranty-tracker-canvas.png` | warranty expiration tracker — also tab 02 of "the workflows" | full-res n8n canvas screenshot |
| `rue-noir-cover.jpg` | rue noir coffee | hero frame, 1920×1080 |
| `pale-ember-cover.jpg` | pale ember espresso | hero frame, 1920×1080 |
| `crm-cover.jpg` | home-service crm | crm board, 1920×1080 |
| `youtube-cover.jpg` | youtube channel | best thumbnail, 1280×720 |

> The three canvas files are the hero of "the workflows" section — export them
> wide and readable (the panel scrolls horizontally if the flow is wider than
> the viewport). Real screenshots only; the section renders honest slots
> until they exist.

## Also edit (in `src/data/site.js`)

- **Booking backend** — `pilot.booking`: set `provider` to `'ghl'` or
  `'calcom'` and paste your calendar/event link as `embedUrl`. Until then the
  BOOK NOW step falls back to a pre-filled email (never a dead end).
- **Rue Noir live URL** — live at `https://bennettc1213.github.io/rue-noir-coffee`;
  the portfolio card and index row already link there. Pale ember still uses
  the status label until it deploys.

- **Stats** — the four numbers under “the receipts” are stand-ins
  (`12`, `1,400+`, `<60s`, `18`). Replace with your real figures.
- **Email** — currently your gmail; swap for a domain address when it exists.
- **YouTube URL** — add it to the `youtube channel` row in `workIndex`
  (`url: 'https://…'`) and to `footer.links`.
- **Live URLs** — when rue noir / pale ember deploy, set their `url` fields
  so the grid rows link out instead of showing the status label.

Everything is lazy-loaded (`loading="lazy"` / `preload="metadata"`), so
full-res files are fine.

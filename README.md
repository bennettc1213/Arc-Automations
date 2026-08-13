# ben* — portfolio

Personal site for Ben Chu / Arc Automations. Dark, high-contrast, signal-orange
accent. React + GSAP ScrollTrigger + Lenis + Framer Motion + matter.js.

## Run

```bash
npm install
npm run dev        # http://localhost:5199
npm run build      # production bundle → dist/
npm run preview    # serve the built bundle locally
```

## Deploy

The build is a static site — `dist/` deploys anywhere:

- **Vercel**: `vercel` in this folder (framework auto-detects Vite), or import
  the repo in the dashboard. Build command `npm run build`, output `dist`.
- **Netlify**: drag `dist/` into the dashboard, or connect the repo with the
  same build settings.
- **Cloudflare Pages**: same — `npm run build` / `dist`.

No environment variables, no server.

## Content

- All copy, numbers, projects, chips and links: `src/data/site.js`
- Real screenshots/clips: drop into `src/assets/media/` — see `ASSETS.md`
  for the exact filenames. Missing files render as designed slots, so the
  site is safe to deploy before every asset exists.

## The pixel layer

- **Pixel guy** (`src/components/PixelGuy.jsx`) — the mark next to `ben*`,
  bigger in the footer, tiny walker on the ticker. Pure `<rect>` SVG from a
  10×10 map. He blinks (randomized 4–7s), faces the cursor in 3 snapped
  states, compresses a pixel-row on fast scroll, and hops on click with a
  1px overshoot. He never tweens.
- **Warm grid** (`WarmGrid.jsx`) — fixed canvas under everything: faint
  orange dot grid (cursor-reactive within 200px on desktop) plus a heat
  bloom that lags the scroll. Dirty-flag rendering. Opaque surfaces
  (project covers, footer) carry the same dots via CSS so the texture
  never drops out.
- **Circuit lines** — one per project panel, drawn in on pin via scrubbed
  dashoffset, index → visual, like an n8n edge.
- **Interaction details** — square orange cursor (never a dot), orange
  pixel-corner focus rings, mechanical tick counters on panel indices,
  type-in URL labels in the work grid, 1px down-right press offsets on
  hover, thin orange scrollbar, orange selection.

## Behavior notes

- Every animation respects `prefers-reduced-motion` (Lenis off, marquees
  frozen, stats render final values, demos show their end state).
- The physics toolkit is desktop-only; under 768 px it renders static chips.
- Project panels are sticky-stacked on desktop, plain stacked cards ≤900 px.
- Demo loops pause when offscreen (IntersectionObserver).

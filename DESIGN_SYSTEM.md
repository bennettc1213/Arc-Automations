# Design system — "ben*" / Arc Automations

A reference doc for reusing this site's look, feel, and interaction patterns
on another project. Written from the actual source in `src/`, not from
memory — every value here is copy-pasteable.

**The one-line summary:** dark, high-contrast, one aggressive accent color,
lowercase everything, oversized type, and a cast of small "earned" motion
details instead of decoration. Nothing fades in just to fade in.

---

## 1. Design philosophy (read this before copying anything)

- **One accent, no exceptions.** A single saturated color carries every
  highlight, CTA, glow, cursor, and focus state. Never a second accent hue.
- **Lowercase as a signature.** All body copy, headings, nav labels, and
  buttons are lowercase. It reads as deliberate, not lazy — pair it with
  large type so it doesn't read as low-effort.
- **Every animation earns its place.** No fade-in-on-scroll for its own
  sake. Motion either communicates state (a counter ticking, a line
  drawing in to show progress) or personality (the mascot). If you'd cut
  it and nothing would be lost, cut it.
- **Snap, don't always tween.** Some things (a mascot, a counter, a tab
  switch) change state in a single frame — no easing. This reads as
  "mechanical" / "pixel-art" and contrasts nicely with the smooth GSAP
  scroll elsewhere. Mixing snapped and eased motion is a deliberate choice,
  not an inconsistency.
- **Honesty over placeholder mockups.** Missing content renders as an
  explicitly-labeled dashed slot (see §7), never a stock photo or fake
  data. If you don't have the real number, don't show a number.
- **Respect `prefers-reduced-motion` completely.** Every effect below has a
  reduced-motion fallback that keeps the *content* fully usable — it just
  loses the animation. This is not optional polish; it's load-bearing.

---

## 2. Color tokens

```css
:root {
  /* surfaces — a near-black stack, not pure #000 */
  --bg: #0a0a0b;
  --bg-2: #0f0f11;
  --surface: #141416;
  --surface-2: #1a1a1d;

  /* hairlines — translucent white, never a flat gray hex */
  --line: rgba(237, 237, 239, 0.09);
  --line-strong: rgba(237, 237, 239, 0.18);

  /* text */
  --text: #ededef;   /* primary */
  --muted: #96969e;  /* body copy on dark */
  --faint: #5c5c64;  /* captions, disabled, secondary labels */

  /* the one accent — signal orange */
  --accent: #ff4d00;
  --accent-hot: #ff6b2b;   /* hover state */
  --accent-lite: #ffa366;  /* the "eye" pixel, soft highlights */
  --accent-dim: rgba(255, 77, 0, 0.13);   /* fills, badges */
  --accent-glow: rgba(255, 77, 0, 0.45);  /* box-shadow glows */

  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-inout: cubic-bezier(0.76, 0, 0.24, 1);
}
```

**Why this works:** surfaces step up in ~5% lightness increments
(`#0a0a0b → #0f0f11 → #141416 → #1a1a1d`), so cards read as "slightly
raised" without a single box-shadow. Hairlines are alpha-white rather than
a flat gray so they inherit whatever's behind them. The accent has exactly
three strengths (solid / dim-fill / glow) — reuse those three everywhere
instead of inventing new opacities per component.

**To reuse on a new site:** swap `--accent` for your own color and keep
everything else. The system was built to make that a one-line change —
grep for `#ff4d00` / `rgba(255, 77, 0` / `--accent` and you're done. Pick
a saturated, high-contrast color; pastel accents don't survive this
much near-black.

---

## 3. Typography

```css
--font-sans: 'Space Grotesk Variable', 'Space Grotesk', system-ui, sans-serif;
--font-mono: 'IBM Plex Mono', ui-monospace, 'Cascadia Mono', monospace;
--font-garamond: 'EB Garamond', Georgia, serif; /* one project-specific echo, see §9 */
```

- **Display/body:** Space Grotesk (variable weight) — geometric, slightly
  quirky, reads well oversized. Loaded via `@fontsource-variable`.
- **Everything technical:** IBM Plex Mono — nav labels, eyebrows, stats
  labels, tech tags, code-adjacent UI, timestamps. This is what makes the
  site feel "engineered" rather than "designed."
- **Scale:** headlines use `clamp()` so they're fluid, not breakpointed:
  ```css
  .section-title { font-size: clamp(2.2rem, 5.4vw, 4.4rem); font-weight: 600; letter-spacing: -0.03em; }
  .hero__title   { font-size: clamp(3.1rem, 11.4vw, 9.8rem); font-weight: 600; letter-spacing: -0.045em; }
  ```
  Tight negative letter-spacing (−0.03 to −0.045em) at large sizes is what
  keeps oversized type from looking loose.
- **The "eyebrow" label:** every section opens with a small mono kicker —
  a short orange tick-mark, then `NN — section name` in muted mono. This
  is the single most repeated typographic pattern on the site:
  ```css
  .eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: .08em; color: var(--faint); display:flex; align-items:center; gap:12px; }
  .eyebrow::before { content:''; width:28px; height:1px; background:var(--accent); }
  ```

---

## 4. Layout primitives

```css
--nav-h: 72px;
--gutter: clamp(20px, 4vw, 64px); /* fluid page margin */

.wrap { padding-inline: var(--gutter); max-width: 1560px; margin-inline: auto; }
```

One wide max-width (1560px), one fluid gutter variable used everywhere
instead of per-component padding. Sections default to `position: relative`
so absolutely-positioned decoration (roamers, circuit lines, sweep
animations) can be scoped without extra wrapper divs.

---

## 5. The mascot — "pixel guy"

The single most distinctive element on the site: a tiny pixel-art
character built entirely from SVG `<rect>` elements on a 10×10 grid (no
image files, no anti-aliasing — `shape-rendering="crispEdges"`).

**Construction:** a handful of row-strings (`'...xxxx...'` etc.) define
head/body/feet; `x` marks a filled pixel. One pixel is designated the
"eye" and rendered in `--accent-lite` instead of `--accent` — that's the
only two-tone moment he ever has. Facing (left/center/right) is done by
shifting the head rows ±1 column and moving the eye column, *not* by
transforming/flipping the SVG — this keeps every pose looking authored
rather than mirrored.

```jsx
const HEAD = ['...xxxx...', '..xxxxxx..', '..xxxxxx..', '..xxxxxx..', '..xxxxxx..', '...xxxx...'];
const BODY = ['..xxxxxx..', '.xxxxxxxx.', '.xxxxxxxx.'];
const FEET_A = '..xx..xx..';
const FEET_B = '.xx....xx.'; // alternate frame for walking
```

**Golden rule: he never tweens.** Every state change is a hard cut —
`transition` is intentionally absent on his transform. This is what makes
him read as a "character" instead of a "UI element." Contrast this with
literally everything else on the site, which eases.

**His behaviors, and where they live:**
| Behavior | Trigger | Notes |
|---|---|---|
| Idle blink | random 4–7s timer | randomized so it never feels metronomic — a fixed interval reads as robotic |
| Face the cursor | `mousemove`, 3 discrete zones | left / center / right based on cursor x vs. his bounding box center — snaps, never rotates smoothly |
| Squash | scroll delta > threshold | loses one pixel-row for ~150ms on a fast scroll, "springs" back by removing the class |
| Hop | click | a 7-frame keyframe sequence (`[-2u,-3u,-3u,-2u,0,1,0]`) — note the final `1` is a 1px *overshoot* past rest before settling, which is what sells the "landing" |
| Walk cycle | `PixelWalker` variant | alternates `FEET_A`/`FEET_B` on an interval while translating x — used in the footer ticker |
| Roam | `PixelRoamer` variant | a tiny state machine (walk / idle / hop) with randomized transition probabilities, paces a "floor line" behind hero content at low opacity |
| Physics body | dropped into `matter-js` | he's a real rigid body in the toolkit section — draggable, collides, rotates — while *still* blinking/tracking independently of the physics loop |

**Placements used:** nav (small, next to wordmark), footer (large),
footer ticker (walking, looping), hero background (roaming, ~0.45
opacity, `z-index: -1` so text always wins), toolkit physics pit (as a
throwable body), a static glyph swapped in for every 4th separator in the
marquees, and a "confirmation" hop on a form-success state.

**Reuse note:** this pattern generalizes to *any* brand mark — swap the
pixel map for your own mascot/logo shape and every behavior (blink, face-
cursor, hop, walk, physics-drop) ports over unchanged, since none of it
is specific to this particular character's shape.

---

## 6. Background — "the grid gets warm"

A fixed full-viewport `<canvas>` (`z-index: -1`, `pointer-events: none`)
sits behind literally everything and renders two things, both extremely
subtle (opacity budget: 0.05–0.12 total — if you can consciously see the
background pattern, it's tuned too hot):

1. **A dot grid**, spaced ~28px (46px on mobile — density drops for
   performance and to avoid moiré on small screens), scroll-anchored so
   it feels attached to the page rather than the viewport.
2. **Cursor-reactive brightening** — dots within a 200px radius of the
   mouse brighten and grow (desktop + fine pointer only). Falloff is
   linear by distance.
3. **A scroll-lagged "heat bloom"** — a soft horizontal gradient band
   that eases toward the current scroll position (`bloom += (scrollY -
   bloom) * 0.055` per frame) rather than snapping to it, so it visibly
   *trails* during fast scrolling — like a heat trail.

**Performance pattern worth stealing:** the render loop uses a dirty
flag. It only calls `draw()` when the mouse moved, scroll changed, or the
bloom hasn't caught up yet — and it stops requesting frames entirely once
the bloom settles (`Math.abs(bloom - scrollY) < 0.5`). This is a canvas
that costs ~0% CPU while idle instead of running a 60fps loop forever.

```js
const loop = () => {
  if (Math.abs(bloom - scrollY) > 0.5) { bloom += (scrollY - bloom) * 0.055; dirty = true; }
  if (dirty) { draw(); dirty = false; }
  raf = requestAnimationFrame(loop);
};
```

Killed entirely (`return null`) under `prefers-reduced-motion`.

---

## 7. Custom cursor + trail

Replaces the native cursor (`* { cursor: none !important }`, gated to
`(pointer: fine) and (prefers-reduced-motion: no-preference)`) with:

- **A core:** a small solid square (10px, 18px over interactive
  elements) that snaps size instantly — no transition. Never a circle,
  never a dot — squares reinforce the pixel-art motif.
- **A trail:** 10 progressively smaller/fainter squares chasing the core
  via a real spring simulation (not CSS transitions):
  ```js
  vx[i] = (vx[i] + (target - px[i]) * k) * damping; // k≈0.22 idle, 0.42 near interactive
  px[i] += vx[i];
  ```
  Each square chases the one ahead of it, so fast movement visibly
  stretches the chain and stopping lets it "settle" with real inertia.
  The loop self-stops (`running = false`) once total velocity drops below
  a threshold — same idle-cost trick as the background canvas.
- Trail sits at `z-index: 1` — above the background canvas, below page
  content (`z-index: 2`) — so it reads as riding *on* the page.

Killed outright under reduced motion or on touch/coarse pointers.

---

## 8. Motion language — the rules that keep it coherent

| Pattern | Used for | Implementation note |
|---|---|---|
| **Mask-slide reveal** | hero line-by-line entrance, word-cycling headline | `overflow:hidden` wrapper + inner `transform: translateY` — the classic "type rises out of its own baseline" reveal |
| **Word-cycler** | rotating last word in a headline | Framer Motion `AnimatePresence mode="popLayout"`, `y: '105%' → 0 → '-105%'`, `ease: [0.76,0,0.24,1]`. **Must set `position: relative` on the wrapper** — `popLayout` absolutely-positions the exiting element, and it'll escape an unpositioned mask. |
| **Direction-aware marquee** | capability-tag tickers | Not CSS `@keyframes` — a `requestAnimationFrame` loop tracking scroll delta: direction flips on scroll-up, speed gets a temporary "kick" proportional to scroll velocity that decays back to cruise (`targetSpeed += (base - targetSpeed) * 0.045`). Reduced motion: freezes into a static wrapped row. |
| **Count-up stats** | any stat block | GSAP + ScrollTrigger, `once: true`, tween a plain `{v:0}` object and write `.textContent` in `onUpdate` — cheaper than re-rendering React state every frame. |
| **Sticky-stacked panels** | project/portfolio showcase | Each panel `position: sticky; top: 0; height: 100svh`, then GSAP scrubs the *previous* panel's scale/opacity down as the next one arrives — this is what sells "cards stacking," not z-index tricks. Falls back to plain stacked cards under 900px via `gsap.matchMedia()`. |
| **Circuit-line draw-in** | connecting an index number to its visual | An SVG `<path>` with `pathLength="1"`, animate `stroke-dashoffset 1→0` scrubbed to scroll position — classic "line draws itself in," but tied to pin progress instead of a fixed duration. |
| **Mechanical tick counter** | index numbers, tab counters | *Not* eased — literally increments the integer on an interval (`cur += Math.sign(target - cur)`) so it visually "counts" rather than crossfading. Reads as machinery, pairs well with the mono font. |
| **Type-in label** | URL labels appearing on hover | `setInterval` revealing one more character of a string, with a blinking `<i>` caret block. Same "mechanical, not smooth" family as the tick counter. |
| **1px press offset** | every hover state on buttons/links | `translate: 1px 1px` on `:hover`, no transition. Reads as "physically pressed," costs nothing, and is the *opposite* motion-language from the smooth GSAP entrances — the contrast is the point. |
| **Pixel-corner focus ring** | keyboard focus, replacing `outline` | Four small `<i>` corner-brackets positioned via `getBoundingClientRect()` on `focusin`, styled as `border` L-shapes instead of a rounded outline. Ties focus states into the pixel-art language instead of looking like a browser default. |

---

## 9. Content-card patterns

- **Honest media slots** (`.slot`): any spot expecting a real
  screenshot/video that hasn't been supplied yet renders a dashed-border
  box with a diagonal hatch background, the exact expected filename in
  mono, and a spec line (e.g. "1920×1080, hero frame"). *Never* a gray
  placeholder or lorem-picsum stock image. This means the site is
  deploy-safe before every asset exists — nothing looks broken, it looks
  intentionally unfinished.
- **Hover-reveal rows**: a collapsed list row expands via
  `grid-template-rows: 0fr → 1fr` on hover (no JS height calc needed) to
  reveal a full preview + a live-URL label. Falls back to tap-to-expand
  on touch.
- **Click-to-view-live pattern**: when a project has a real URL, the
  *entire visual* becomes one `<a target="_blank" rel="noopener
  noreferrer">` — not just a small "view" button — with a low-opacity
  accent-color wash on hover and the URL label brightening + an arrow
  sliding in. Projects without a real URL stay inert; never fake a link.
- **One brand echo, used sparingly**: one card in the showcase (a coffee
  brand called Rue Noir) borrows *that* brand's actual palette/typeface
  inside its own card (`--rn-paper`, `--rn-ink`, `EB Garamond`) as a
  live "echo" rather than a screenshot. This is a nice trick if you're
  showcasing other branded work: prove you can hold someone else's
  design language for a few square inches without it clashing with the
  parent site.

---

## 10. Full-screen overlay pattern (conversion flow)

A takeover panel (not a modal card) for anything conversion-critical
(here: a lead-intake + booking flow):

- `position: fixed; inset: 0`, same dot-grid background as the rest of
  the site (visual continuity — an overlay should never look like a
  different product), pixel-corner focus rings carry through.
- Body scroll locks via the smooth-scroll library's own `.stop()`
  method (not just `overflow: hidden` on body — if you're running Lenis/
  Locomotive, lock *that*, or wheel events leak through).
- One question per screen, big tap targets, square corners (no
  `border-radius` — rounded corners would break the pixel-art language
  here), filled-accent on selection, auto-advance on choice (no separate
  "next" click for single-select questions).
- **Nothing in this flow animates over ~200ms.** This is a conversion
  path, not a showcase — the rule above ("every animation earns its
  place") gets stricter, not looser, once money/leads are on the line.
- Always ships a non-JS-dependent fallback (here: `mailto:` with the
  answers pre-filled in the body) so a failed integration never dead-ends
  the user.

---

## 11. Tech stack (if porting the actual implementation, not just the look)

```
React 18 + Vite
GSAP 3 + ScrollTrigger    → scroll-scrubbed animation, count-ups, matchMedia breakpoints
Lenis                     → smooth-scroll (drives ScrollTrigger's update on its own rAF)
Framer Motion             → component-level transitions (word-cycler, accordion)
matter-js                 → physics (draggable toolkit chips + the mascot as a body)
@fontsource-variable      → self-hosted variable fonts, no Google Fonts network call
```

`Lenis` + `ScrollTrigger` wiring (the one non-obvious integration point):

```js
const lenis = new Lenis({ duration: 1.1, easing: t => Math.min(1, 1.001 - 2**(-10*t)) });
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((time) => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);
```

All decorative layers (`WarmGrid`, `CursorSquare`, `PixelRoamer`, the
marquee `requestAnimationFrame` loop) are hand-rolled rAF loops rather
than library-driven — kept dependency-free since they're each <150 lines
and benefit from tight control over the idle/dirty-flag optimization.

---

## 12. Quick-start checklist for a new site in this style

1. Copy `--bg/--bg-2/--surface/--surface-2`, swap `--accent` for your color.
2. Load a geometric sans (variable weight) + a mono for all-caps/technical
   labels. Lowercase everything in copy.
3. Build the `.eyebrow` + `.section-title` primitives first — they're used
   on every section and set the visual rhythm immediately.
4. Pick **one** mascot/mark and give it 3–4 snapped (non-eased) behaviors
   before anything else — it does more for "personality" than every other
   effect combined.
5. Add the background canvas last, tuned to the point of being barely
   perceptible. If a first-time visitor mentions the background
   unprompted, turn it down further.
6. Audit every animation against the one rule: *does cutting this lose
   information or personality?* If no, cut it.

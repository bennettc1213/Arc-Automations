# Build prompt — orange grid background, mascot, and core UI

Paste everything below this line into a new Claude Code chat for the other
project. It's written as a standalone brief — no context from this
conversation is assumed. Scroll-driven effects (sticky panels, scroll-lagged
heat bloom, marquee direction-reversal, scroll-triggered count-ups, circuit
lines that draw in on pin) are intentionally **left out** — this brief only
covers the background, the logo/mascot, and general UI/button styling.

---

## Prompt starts here

Build four things for this site: an orange dot-grid background with cursor
reactivity, a pixel-art mascot/logo mark with a few idle behaviors, a custom
square cursor, and the general button/UI language (colors, type, focus
states). Everything below is a full spec — implement it as-is, then adjust
to fit the existing codebase's file structure.

### 0. Foundation — color tokens & type

Add these CSS custom properties to the global stylesheet (root/body level):

```css
:root {
  --bg: #0a0a0b;
  --bg-2: #0f0f11;
  --surface: #141416;
  --surface-2: #1a1a1d;

  --line: rgba(237, 237, 239, 0.09);
  --line-strong: rgba(237, 237, 239, 0.18);

  --text: #ededef;
  --muted: #96969e;
  --faint: #5c5c64;

  /* the ONE accent color — swap this hex for the brand's actual color,
     keep everything else. never introduce a second accent hue. */
  --accent: #ff4d00;
  --accent-hot: #ff6b2b;   /* hover state */
  --accent-lite: #ffa366;  /* soft highlight, e.g. the mascot's eye */
  --accent-dim: rgba(255, 77, 0, 0.13);   /* fills, badges */
  --accent-glow: rgba(255, 77, 0, 0.45);  /* box-shadow glow */
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Space Grotesk', system-ui, sans-serif; /* or the project's chosen sans */
}
```

Use a monospace font (IBM Plex Mono or similar) for anything technical:
nav labels, small kickers/eyebrows, timestamps, tags. That mono/sans split
is what makes the UI read as "engineered" rather than "designed."

Lowercase all copy in buttons, nav, and labels — it's a deliberate stylistic
signature, not an oversight.

---

### 1. Orange dot-grid background with cursor crosshair reactivity

A fixed full-viewport `<canvas>` that sits behind all page content and
renders a faint grid of orange dots. Dots near the cursor brighten and grow
— that's the "crosshair" effect: a soft radius of light that follows the
mouse across the grid, like a targeting reticle made of dots instead of
lines.

**Requirements:**

- `position: fixed; inset: 0; z-index: -1; pointer-events: none;` — always
  behind content, never intercepts clicks.
- Dot spacing ~28px on desktop, wider (~46px) on mobile — density drops on
  small screens for performance and to avoid a busy/noisy look.
- Base dot opacity is very low — **0.06 to 0.09** on the base grid. This
  background should be almost subliminal. If someone looks at the page and
  immediately comments on the background pattern, it's tuned too strong —
  turn it down further.
- **Cursor reactivity (desktop + fine-pointer only):** any dot within a
  ~200px radius of the cursor brightens and scales up slightly, with linear
  falloff by distance — full brightness right at the cursor, fading to the
  base 0.06–0.09 opacity at the edge of the radius. This is the "crosshair."
- Disable cursor reactivity on touch devices / coarse pointers — check
  `(pointer: fine)` in a media query or `window.matchMedia`.
- **Performance — this matters:** don't run the render loop unconditionally
  every frame forever. Track a "dirty" flag and only redraw when the mouse
  actually moved, the window resized, or the grid needs to reflect a state
  change. An idle page with a static cursor should cost ~0% CPU from this
  canvas.
- Kill the entire component under `prefers-reduced-motion: reduce` — return
  null / don't mount the canvas at all. A single static low-opacity dot
  pattern (as a CSS `background-image: radial-gradient(...)` tile) can
  stand in for reduced-motion users if you still want texture there.

**Reference implementation (React + canvas 2D, adapt to the target stack):**

```jsx
function WarmGrid() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const spacing = window.innerWidth < 768 ? 46 : 28;
    const R = 200; // cursor falloff radius in px
    const fine = window.matchMedia('(pointer: fine)').matches;

    let W, H, raf, dirty = true;
    const mouse = { x: -9999, y: -9999 };

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    }
    resize();
    window.addEventListener('resize', resize);

    function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; dirty = true; }
    if (fine) window.addEventListener('mousemove', onMove, { passive: true });

    function draw() {
      ctx.clearRect(0, 0, W, H);
      for (let y = spacing / 2; y < H; y += spacing) {
        for (let x = spacing / 2; x < W; x += spacing) {
          let a = 0.07, s = 2;
          if (fine) {
            const dx = x - mouse.x, dy = y - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < R * R) {
              const t = 1 - Math.sqrt(d2) / R;
              a = 0.07 + t * 0.25;
              s = 2 + Math.round(t * 2);
            }
          }
          ctx.fillStyle = `rgba(255,77,0,${a})`;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
    }

    function loop() {
      if (dirty) { draw(); dirty = false; }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      if (fine) window.removeEventListener('mousemove', onMove);
    };
  }, []);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' }} />;
}
```

Mount this once near the root of the app, before/behind all other content.

---

### 2. The logo / mascot mark — pixel-art character

A small, blocky pixel-art character built entirely from `<rect>` elements
in an SVG on a 10×10 grid — no image files, hard edges, no anti-aliasing
(`shape-rendering="crispEdges"`). This is the brand mark; it appears small
in the nav next to the wordmark, and larger in the footer.

**Grid definition** (`x` = filled pixel, one designated pixel is the
"eye" and rendered in `--accent-lite` instead of `--accent` — the only
two-tone moment the character has):

```js
const HEAD = ['...xxxx...', '..xxxxxx..', '..xxxxxx..', '..xxxxxx..', '..xxxxxx..', '...xxxx...'];
const BODY = ['..xxxxxx..', '.xxxxxxxx.', '.xxxxxxxx.'];
const FEET_A = '..xx..xx..';
const FEET_B = '.xx....xx.'; // alternate frame, used for walking
const EYE_ROW = 3;
const EYE_COL = { left: 2, center: 4, right: 7 };
```

Facing direction (left/center/right) is achieved by **shifting the head
rows ±1 column** (not by flipping/mirroring the SVG) and moving the eye
column to match — this keeps every pose looking hand-authored instead of
mechanically mirrored:

```js
function shiftRow(row, dx) {
  if (dx === 0) return row;
  return dx > 0 ? '.' + row.slice(0, 9) : row.slice(1) + '.';
}

function buildRects(facing, { feet = FEET_A } = {}) {
  const dx = facing === 'left' ? -1 : facing === 'right' ? 1 : 0;
  const head = HEAD.map(r => shiftRow(r, dx));
  const rows = [...head, ...BODY, feet];
  const rects = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < 10; x++) {
      if (row[x] !== 'x') continue;
      rects.push({ x, y, eye: y === EYE_ROW && x === EYE_COL[facing] });
    }
  });
  return rects;
}
```

Render as:

```jsx
<svg viewBox="0 0 10 10" width={size} height={size} shapeRendering="crispEdges">
  {rects.map(r => (
    <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width="1" height="1"
          fill={r.eye ? 'var(--accent-lite)' : 'var(--accent)'} />
  ))}
</svg>
```

**The golden rule: this character never tweens.** No CSS `transition` on
his transform, ever. Every state change (facing, blink, hop) is a hard
instant cut. That snappy, non-eased quality is what makes him read as a
"character" instead of "a UI element that happens to be shaped like a
character." Everything else in the UI can ease smoothly — he specifically
should not.

**Non-scroll-tied behaviors to implement:**

| Behavior | Trigger | How |
|---|---|---|
| Idle blink | randomized timer, 4–7 seconds | On mount, `setTimeout` a random 4000–7000ms, swap in a `blink` state (drop the eye rect, or render it as background color) for ~130ms, then schedule the next blink. **Randomize the interval each cycle** — a fixed interval reads as robotic and mechanical in a bad way. |
| Face the cursor | `mousemove`, whole-window listener | Compare `event.clientX` to the character's own bounding-box center. If cursor is left of (center − half element width), face left; if right of (center + half width), face right; otherwise center. Snap between the three states — no rotation, no easing, just swap which `facing` value is passed to `buildRects`. |
| Hop | `click` on the character | A short keyframe sequence stepping through Y-offsets, e.g. `[-2u, -3u, -3u, -2u, 0, 1, 0]` (u = a small unit like `size/10`) at ~55ms per frame, applied via `style.transform = translateY(...)`. Note the second-to-last frame is `1` — a **1px overshoot past the resting position** before settling back to `0`. That tiny overshoot is what sells "landing" instead of just "stopping." Guard against re-triggering mid-hop. |
| Walk cycle | continuous, on an interval, while a "walking" variant is mounted (e.g. in a footer strip) | Alternate `FEET_A` / `FEET_B` every ~90ms while translating the character's x position across its container, looping back to the start when it exits. |

Optional but nice: a "roaming" variant that idles in a wide empty area of
the layout (e.g. behind a hero headline, at low opacity like 0.4–0.5, sent
behind the text with `z-index: -1`) — a tiny state machine that alternates
between walking a few steps, pausing to blink, occasionally turning around,
and occasionally hopping, each transition picked with a small random
probability per tick. Not required, but it's the single highest-charm
addition if there's an empty background area to fill.

Kill all of the above under `prefers-reduced-motion: reduce` — render the
character in a single static center-facing pose with no listeners attached.

---

### 3. Custom cursor — small square, never a dot

Replace the native cursor (desktop + fine pointer + motion-ok only) with a
small solid square:

```css
@media (pointer: fine) and (prefers-reduced-motion: no-preference) {
  * { cursor: none !important; }
}

.cursor-square {
  position: fixed;
  top: 0; left: 0;
  width: 10px; height: 10px;
  background: var(--accent);
  border: 1px solid var(--bg);
  z-index: 9999;
  pointer-events: none;
  opacity: 0; /* fade in on first mouse move, not visible at (0,0) on load */
  /* no transition — it SNAPS between sizes, does not tween */
}
```

In JS: track `mousemove`, position the square at the cursor (`translate3d`
for GPU compositing), and grow it to ~18px whenever the cursor is over an
interactive element (`a, button, [role="button"], input`, etc. — check
via `event.target.closest(selector)`). The size change is instant, not
animated. Set `opacity: 1` only after the first real mouse-move event so
it doesn't flash at the top-left corner on page load.

*(Optional, more advanced — skip if the target project wants something
simpler: a chase-trail of several smaller, fainter squares following the
core with a spring/damping simulation rather than CSS transitions, for
extra visual weight. Only worth it if the base cursor already feels good
and there's appetite for the extra complexity.)*

---

### 4. Buttons & general UI language

- **Corners:** favor sharp or barely-rounded corners on interactive
  elements (buttons, tags, cards) — 0 to 4px radius. Full pill shapes
  (`border-radius: 999px`) are reserved for pill/badge-style CTAs, not
  general UI. Avoid the generic "rounded SaaS card" look (12–20px radii
  everywhere).
- **Primary button:** solid `--accent` fill, dark text (`var(--bg)` or
  near-black), medium font weight, mono or sans depending on context.
  Hover state: swap fill to `--accent-hot`, no other transition.
- **Ghost/secondary button:** `1px solid var(--line-strong)` border,
  transparent fill, `--muted` text. Hover: border and text brighten to
  `--accent` or `--text`.
- **The 1px press offset — apply this to every clickable element's hover
  state:**
  ```css
  .btn:hover, a:hover, .nav-link:hover {
    translate: 1px 1px;
    /* no transition — instant, reads as a physical press */
  }
  ```
  This is a small but important detail: it's the *opposite* motion
  language from anything eased elsewhere on the page (word reveals,
  panel transitions), and that contrast is intentional — it makes buttons
  feel physically pressable rather than just "hovering."
- **Focus states — replace the default outline with pixel-corner
  brackets** instead of a rounded `outline`:
  ```css
  :focus-visible { outline: none; }

  .focus-ring { position: absolute; pointer-events: none; z-index: 9990; }
  .focus-ring i { position: absolute; width: 8px; height: 8px; border: 2px solid var(--accent); }
  .focus-ring i:nth-child(1) { top: 0; left: 0; border-right: none; border-bottom: none; }
  .focus-ring i:nth-child(2) { top: 0; right: 0; border-left: none; border-bottom: none; }
  .focus-ring i:nth-child(3) { bottom: 0; left: 0; border-right: none; border-top: none; }
  .focus-ring i:nth-child(4) { bottom: 0; right: 0; border-left: none; border-top: none; }
  ```
  On `focusin`, measure the focused element with `getBoundingClientRect()`,
  position one `.focus-ring` wrapper (containing those four corner `<i>`
  elements) around it with a small ~5px outset, and remove it on
  `focusout`. Four L-shaped corner brackets instead of a full rectangle
  outline — ties keyboard focus into the same pixel-art language as the
  mascot.
- **Selection color:**
  ```css
  ::selection { background: var(--accent); color: var(--bg); }
  ```
- **Scrollbar (WebKit + Firefox):**
  ```css
  html { scrollbar-width: thin; scrollbar-color: var(--accent) var(--bg); }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--accent); }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent-hot); }
  ```
- **Small mono "eyebrow" label** — the recurring pattern above section
  headings or nav groupings: a short horizontal tick mark in `--accent`,
  then a small mono label in `--faint`:
  ```css
  .eyebrow { font-family: monospace; font-size: 12px; letter-spacing: .08em; color: var(--faint); display: flex; align-items: center; gap: 12px; }
  .eyebrow::before { content: ''; width: 28px; height: 1px; background: var(--accent); }
  ```

---

### What NOT to include from this brief

Do not build scroll-triggered or scroll-scrubbed behavior as part of this
task — no sticky/pinned panels, no scroll-position-driven background
effects, no elements that reveal or animate specifically *because* the
user scrolled to them, no scroll-direction-aware marquees. If the target
project wants those later, that's a separate, follow-up brief. This pass
is background + logo + mascot + cursor + buttons only.

---

## End of prompt

Open this file in VS Code (`File → Open File…`, or drag it into the
editor) to copy the prompt text above the "Prompt starts here" divider,
or select from "Prompt starts here" down to "End of prompt" and paste it
directly into the new chat.

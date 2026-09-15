import { useEffect, useRef } from 'react';
import createSand, { HOME, LOOSE } from '../lib/sand';
import './AsciiField.css';

/**
 * the portal's background: "arc automations" standing in a black 3D space,
 * drawn as a field of monospace characters that the cursor pushes around — and
 * that the cursor can now take apart.
 *
 * built rather than embedded. the usual way to get this look is to drop in a
 * pre-rendered video of somebody else's ASCII art, which cannot be recoloured,
 * cannot say your own name, cannot react to a pointer, and dies the day the CDN
 * hosting it does. this is a live character field, so it does all four.
 *
 * canvas 2d on purpose. ASCII is a character grid, which is what canvas text is
 * good at, and the tunnel that hands off to this page has just released a WebGL
 * context — standing a second one up to draw letters would be worse on every
 * axis that matters.
 *
 * there are two things on the canvas and they are drawn by two different rules:
 *
 *   the room   a sparse starfield of characters on the grid, in three depth
 *              layers each breathing at its own rate. anchored: a room does not
 *              move because you moved your hand in it. this is what reads as
 *              space, not the character set.
 *   the sand   the wordmark, as a few thousand grains that pour in, come apart
 *              under the cursor, drift to the bottom, and gather themselves
 *              back up. the physics is lib/sand.js; what stays here is the part
 *              that is actually about characters — which glyph a grain shows
 *              and what colour it burns at.
 *
 * the two meet exactly once, in the occupancy grid: the room is not drawn in
 * any cell a grain is standing in. that is what makes the letters read as solid
 * while they are assembled, and — the better half of the deal — what lets the
 * room show through the holes as they are eroded away.
 */

/* sparse → dense. index 0 is never drawn, so it doubles as "empty". */
const RAMP = ' .,:;=+*7#%@';
/* a grain that is not standing in a letter shows a digit. the wordmark comes
   apart into the numbers it is made of and puts itself back together out of
   them, which is the whole conceit of the thing stated in one character. */
const DIGITS = '0123456789';
const GLYPHS = RAMP + DIGITS;
const DIGIT0 = RAMP.length;

/* orange for the wordmark, cold grey for the space it stands in. the warm end
   is the site's own --accent / --accent-lite, unmodified. */
const INK = [
  '#5c2712',
  '#93380f',
  '#cc4409',
  '#ff4d00',
  '#ff6b2b',
  '#ffa366',
  '#ffd0ad',
];
const VOID = ['#191920', '#24242d', '#33333e', '#474756'];
const COLORS = [...VOID, ...INK];
const VOID_N = VOID.length;

/* how much of a cell the wordmark has to fill before it is worth a grain. low
   enough to keep the soft edge the box filter below works for — the fringe is
   what stops the letters looking like a stencil. */
const COVER_MIN = 0.09;
/* a ceiling on the simulation, not on the design. at 4k the wordmark touches
   enough cells to cost ten thousand fillText calls a frame, and the honest fix
   is to take every nth cell: an even stride through a letterform dithers it,
   where a crop would eat a leg off the R. */
const MAX_GRAINS = 4600;

/* stable per-cell randomness — no allocation, same value every frame. */
function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * `armed` holds the arrival until the caller says the field is actually on
 * screen. both doors that mount this one put a full-screen tunnel over it for
 * the better part of a second, and a pour played under an opaque overlay is an
 * entrance the visitor never gets. defaults to true so the component still
 * works on its own.
 */
export default function AsciiField({ armed = true }) {
  const canvasRef = useRef(null);
  const armedRef = useRef(armed);

  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* the erosion is a hover, and a touch screen has no hover. what it has
       instead is a scroll, which arrives as a pointermove across the hero and
       would tear the wordmark down on the way past — sand with no visible
       cause, since the mobile scrim covers the wordmark almost completely
       anyway. so on a coarse pointer the field pours and stands, and that is
       all it does. */
    const hoverable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const sand = createSand();

    let raf = 0;
    let disposed = false;
    let poured = false;
    let last = 0;
    let cols = 0;
    let rows = 0;
    let cellW = 0;
    let cellH = 0;
    let fontPx = 0;
    let wide = false;
    /* coverage of the wordmark per cell, 0..1 */
    let mask = new Float32Array(0);
    /* which cells a grain is standing in this frame */
    let occ = new Uint8Array(0);

    const buckets = COLORS.map(() => []);

    /* the pointer, in canvas coordinates. the field sits below the page's own
       bar, so a raw clientY is off by the height of it — which did not show
       when the whole wordmark answered to a soft falloff, and shows badly now
       that a radius decides what comes apart. */
    const ptr = { x: -9999, y: -9999, active: false };
    let left = 0;
    let top = 0;

    const readRect = () => {
      const r = canvas.getBoundingClientRect();
      left = r.left;
      top = r.top;
    };

    /* ── the wordmark, rasterised once per resize ──────────────
       drawn at 3x the grid and box-filtered down, so each cell gets a real
       coverage value instead of a hard aliased edge. the coverage is what
       chooses the character, so a soft ramp is the point. */
    const buildMask = () => {
      const ss = 3;
      const w = cols * ss;
      const h = rows * ss;
      mask = new Float32Array(cols * rows);
      if (w <= 0 || h <= 0) return;

      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const o = off.getContext('2d', { willReadFrequently: true });
      if (!o) return;

      o.fillStyle = '#000';
      o.fillRect(0, 0, w, h);
      o.fillStyle = '#fff';
      o.textAlign = 'center';
      o.textBaseline = 'alphabetic';

      /* a grid cell is roughly twice as tall as it is wide, so a glyph drawn in
         grid space has to be SQUASHED vertically to come back out square on
         screen. stretching instead of squashing makes the wordmark several
         times too tall to fit, which reads as noise rather than as letters. */
      const squash = cellW / cellH;
      const face = (weight, px) =>
        `${weight} ${px}px "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`;

      /* font size that makes `text` exactly targetW wide */
      const sizeFor = (text, weight, targetW) => {
        o.font = face(weight, 100);
        const unit = o.measureText(text).width / 100;
        return unit > 0 ? targetW / unit : 0;
      };

      /* on a wide screen the copy owns the left third, so the wordmark is
         pushed off-centre to stand in the clear half rather than being read
         through a paragraph. narrow layouts centre their copy, so it recentres. */
      const bias = wide ? 0.58 : 0.5;

      const lines = [
        { text: 'arc', weight: 700, px: sizeFor('arc', 700, w * 0.36) },
        { text: 'automations', weight: 500, px: sizeFor('automations', 500, w * 0.8) },
      ];

      /* Space Grotesk sits about 0.72em from baseline to cap. */
      const capOf = (px) => px * 0.72 * squash;
      const gap = capOf(lines[1].px) * 0.42;
      const block = capOf(lines[0].px) + gap + capOf(lines[1].px);

      /* the block is lifted off centre by a little, because the drift it comes
         apart into needs somewhere to lie. the bottom tenth of the field is the
         floor, and a wordmark centred on the full height sits close enough to
         it that a full collapse has the sand piling into its own feet. */
      let y = (h - block) / 2 - h * 0.06;
      for (const line of lines) {
        const cap = capOf(line.px);
        y += cap;
        o.save();
        /* translate to the baseline first, then squash, so the scale does not
           drag the baseline off its mark. */
        o.translate(w * bias, y);
        o.scale(1, squash);
        o.font = face(line.weight, line.px);
        o.fillText(line.text, 0, 0);
        o.restore();
        y += gap;
      }

      const data = o.getImageData(0, 0, w, h).data;
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          let sum = 0;
          for (let sy = 0; sy < ss; sy++) {
            const row = (gy * ss + sy) * w;
            for (let sx = 0; sx < ss; sx++) {
              sum += data[(row + gx * ss + sx) * 4];
            }
          }
          mask[gy * cols + gx] = sum / (ss * ss * 255);
        }
      }
    };

    /* every cell the wordmark touches becomes one grain, with the slot it
       stands in, how much of that cell it fills, and a stable scrap of
       randomness it keeps for life. */
    const buildHomes = () => {
      let hits = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] > COVER_MIN) hits++;

      const stride = Math.max(1, Math.ceil(hits / MAX_GRAINS));
      const room = Math.ceil(hits / stride);
      const homes = {
        count: 0,
        hx: new Float32Array(room),
        hy: new Float32Array(room),
        cover: new Float32Array(room),
        rnd: new Float32Array(room),
      };

      let seen = 0;
      let k = 0;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cover = mask[y * cols + x];
          if (cover <= COVER_MIN) continue;
          if (seen++ % stride !== 0) continue;
          if (k >= room) break;
          homes.hx[k] = x * cellW;
          homes.hy[k] = y * cellH + cellH * 0.5;
          homes.cover[k] = cover;
          homes.rnd[k] = hash(x, y);
          k++;
        }
      }
      homes.count = k;
      return homes;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return;

      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      /* matches the 1100px breakpoint where PortalHome stops centring its copy */
      wide = w >= 1100;
      fontPx = w < 640 ? 10 : w < 1100 ? 11 : 12;
      ctx.font = `${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      cellW = ctx.measureText('M').width || fontPx * 0.6;
      /* near-solid leading. ASCII art wants its rows to touch — generous
         line-height would cost the wordmark half the rows it has to draw with. */
      cellH = Math.max(fontPx + 1, Math.round(fontPx * 1.06));

      const nextCols = Math.ceil(w / cellW) + 1;
      const nextRows = Math.ceil(h / cellH) + 1;

      /* a few pixels is not a resize. the backing store above has to follow the
         element exactly or the field stretches, but the *grid* only changes when
         the cell count does — and almost nothing that fires a ResizeObserver
         here changes the cell count. the entrance toggles body overflow, which
         moves the scrollbar; a phone's address bar slides away and 100dvh with
         it; a scroll can do it on its own. each of those used to rebuild the
         wordmark and send every grain home, so the arrival was cut off halfway
         by the door that was still opening in front of it. */
      if (nextCols === cols && nextRows === rows && occ.length) {
        readRect();
        return;
      }

      cols = nextCols;
      rows = nextRows;
      occ = new Uint8Array(cols * rows);
      buildMask();

      /* three moods, and which one applies is a question about what has already
         happened on screen: nothing yet (hold the arrival), the arrival already
         spent (carry everything across and re-aim it), or motion refused
         (stand the wordmark up finished and leave it alone). */
      const mode = reduced ? 'set' : poured ? 'keep' : 'park';
      sand.adopt(buildHomes(), { width: w, height: h, cellW, cellH }, mode);
      readRect();
    };

    const onPointer = (e) => {
      ptr.x = e.clientX - left;
      ptr.y = e.clientY - top;
      /* a pointer well clear of the field is not a pointer the field has to
         think about, and the panels below the hero are a long way clear. */
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ptr.active = ptr.x > -240 && ptr.x < w + 240 && ptr.y > -240 && ptr.y < h + 240;
    };
    const onLeave = () => {
      ptr.active = false;
    };

    /* ── the room ──────────────────────────────────────────────
       three depth layers of sparse characters, each breathing at its own rate,
       and none of them touched by the pointer. shifting the grid by a fraction
       of a cell to fake parallax made every character on screen jitter between
       two positions as the mouse moved, and the field looked like it was
       shaking; the wordmark carries the whole interaction instead. */
    const drawRoom = (time) => {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (occ[y * cols + x]) continue;

          const layer = (hash(x * 7 + 3, y * 13 + 5) * 3) | 0;
          const depth = (layer + 1) / 3;
          const seed = hash(x, y);
          if (seed > 0.055 + depth * 0.045) continue;

          const twinkle = 0.5 + 0.5 * Math.sin(time * 0.0007 + seed * 90);
          const level = depth * 0.55 + twinkle * 0.25;
          if (level < 0.18) continue;

          const ci = Math.min(VOID_N - 1, Math.floor(level * VOID_N));
          buckets[ci].push(x * cellW, y * cellH + cellH * 0.5, 1 + ((seed * 40) % 4 | 0));
        }
      }
    };

    /* ── the sand ──────────────────────────────────────────────
       the one place the simulation is turned back into characters. a grain
       standing in the wordmark is a density character lit by how much of its
       cell the letter fills; a grain anywhere else is a digit lit by how far
       through its own journey it is. that is the whole mapping. */
    const drawSand = (time) => {
      const g = sand.grains;
      if (!g) return;
      for (let i = 0; i < g.count; i++) {
        const state = g.state[i];
        let lit;
        let gi;

        if (state === HOME) {
          const shimmer = 0.12 * Math.sin(time * 0.0013 + g.hx[i] * 0.02 + g.hy[i] * 0.017);
          lit = Math.min(1, g.cover[i] + shimmer + g.glow[i] * 0.6);
          gi = Math.min(RAMP.length - 1, 2 + Math.floor(Math.max(0, lit) * (RAMP.length - 3)));
        } else {
          lit = Math.min(1, g.heat[i] + g.glow[i] * 0.4);
          /* a falling grain tumbles through the digits; a settled one has
             stopped, and holds the one it stopped on. the phase is per-grain,
             or the whole drift would flicker in lockstep. */
          const tumble = state === LOOSE ? time * 0.012 : 0;
          gi = DIGIT0 + (((g.rnd[i] * 97 + tumble) | 0) % 10);
        }

        const ci = VOID_N + Math.min(INK.length - 1, Math.floor(Math.max(0, lit) * INK.length));
        buckets[ci].push(g.x[i], g.y[i], gi);
      }
    };

    const draw = (time, dt) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      sand.step(time, dt, ptr);

      ctx.fillStyle = '#0a0a0b';
      ctx.fillRect(0, 0, w, h);
      for (let b = 0; b < buckets.length; b++) buckets[b].length = 0;

      occ.fill(0);
      const g = sand.grains;
      if (g) {
        for (let i = 0; i < g.count; i++) {
          const cx = (g.x[i] / cellW) | 0;
          const cy = (g.y[i] / cellH) | 0;
          if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) occ[cy * cols + cx] = 1;
        }
      }

      drawRoom(time);
      drawSand(time);

      /* one fillStyle change per colour instead of one per character — the
         state change is the expensive part, not the glyph. */
      ctx.font = `${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
      for (let b = 0; b < buckets.length; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        ctx.fillStyle = COLORS[b];
        for (let i = 0; i < list.length; i += 3) {
          ctx.fillText(GLYPHS[list[i + 2]], list[i], list[i + 1]);
        }
      }
    };

    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) {
        last = t;
        return;
      }
      /* the arrival is released on the first frame after the door opens, not on
         mount — see the note on `armed`. */
      if (!poured && armedRef.current) {
        poured = true;
        sand.pour(t);
      }
      const dt = last ? t - last : 16.667;
      last = t;
      draw(t, dt);
    };

    const startup = () => {
      if (disposed) return;
      resize();
      if (reduced) {
        /* one static frame, the wordmark already standing, no loop and no
           pointer tracking. */
        draw(0, 16.667);
        return;
      }
      if (hoverable) {
        window.addEventListener('pointermove', onPointer, { passive: true });
        window.addEventListener('pointerleave', onLeave);
      }
      window.addEventListener('scroll', readRect, { passive: true });
      raf = requestAnimationFrame(frame);
    };

    /* metrics measured before IBM Plex Mono lands would size the grid to a
       fallback font and never correct itself. */
    if (document.fonts?.ready) document.fonts.ready.then(startup);
    else startup();

    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw(0, 16.667);
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', readRect);
    };
  }, []);

  return <canvas className="ascii" ref={canvasRef} aria-hidden="true" />;
}

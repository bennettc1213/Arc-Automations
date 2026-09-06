import { useEffect, useRef } from 'react';
import './AsciiField.css';

/**
 * the portal's background: "arc automations" standing in a black 3D space,
 * drawn as a field of monospace characters that the cursor pushes around.
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
 * depth is faked honestly: every cell gets a stable pseudo-random layer, and
 * the layers parallax against the pointer at different rates. that is what
 * reads as space, not the character set.
 */

/* sparse → dense. index 0 is never drawn, so it doubles as "empty". */
const RAMP = ' .,:;=+*7#%@';

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

/* stable per-cell randomness — no allocation, same value every frame. */
function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export default function AsciiField() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let disposed = false;
    let cols = 0;
    let rows = 0;
    let cellW = 0;
    let cellH = 0;
    let fontPx = 0;
    let wide = false;
    /* coverage of the wordmark per cell, 0..1 */
    let mask = new Float32Array(0);

    /* pointer in grid coordinates; starts off-field so nothing is disturbed
       until the visitor actually moves. */
    let px = -999;
    let py = -999;
    let tx = -999;
    let ty = -999;

    const buckets = COLORS.map(() => []);

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

      let y = (h - block) / 2;
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
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let sum = 0;
          for (let sy = 0; sy < ss; sy++) {
            const row = (y * ss + sy) * w;
            for (let sx = 0; sx < ss; sx++) {
              sum += data[(row + x * ss + sx) * 4];
            }
          }
          mask[y * cols + x] = sum / (ss * ss * 255);
        }
      }
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

      cols = Math.ceil(w / cellW) + 1;
      rows = Math.ceil(h / cellH) + 1;
      buildMask();
    };

    const onPointer = (e) => {
      tx = e.clientX / cellW;
      ty = e.clientY / cellH;
    };
    const onLeave = () => {
      tx = -999;
      ty = -999;
    };

    const draw = (time) => {
      /* the pointer is chased rather than followed, so a fast flick leaves a
         wake in the field instead of teleporting the deformation. */
      if (px < -900) {
        px = tx;
        py = ty;
      } else {
        px += (tx - px) * 0.12;
        py += (ty - py) * 0.12;
      }

      ctx.fillStyle = '#0a0a0b';
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      for (let b = 0; b < buckets.length; b++) buckets[b].length = 0;

      /* no pointer parallax. shifting the whole grid by a fraction of a cell
         made every character on screen jitter between two positions as the
         mouse moved — the field looked like it was shaking. only the wordmark
         responds to the pointer now, and only within the cursor's radius. */
      const radius = Math.max(9, cols * 0.09);

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const dx = x - px;
          const dy = (y - py) * (cellH / cellW);
          const dist = Math.sqrt(dx * dx + dy * dy);
          /* smooth falloff, and no influence at all before first pointer move */
          const infl = tx < -900 ? 0 : Math.max(0, 1 - dist / radius) ** 2;

          /* ── the wordmark ──────────────────────────────
             sampled through an outward displacement, so the letters bulge away
             from the cursor like a membrane being pushed. */
          /* the whole of the pointer interaction now lives in this one branch,
             so it carries what the void used to add. */
          const spread = infl * 5.4;
          const nx = dist > 0.001 ? dx / dist : 0;
          const ny = dist > 0.001 ? dy / dist : 0;
          const mx = Math.round(x + nx * spread);
          const my = Math.round(y + ny * spread);

          let cover = 0;
          if (mx >= 0 && mx < cols && my >= 0 && my < rows) cover = mask[my * cols + mx];

          if (cover > 0.06) {
            const shimmer = 0.12 * Math.sin(time * 0.0013 + x * 0.14 + y * 0.22);
            const lit = Math.min(1, cover + shimmer + infl * 0.72);
            const ci = VOID_N + Math.min(INK.length - 1, Math.floor(lit * INK.length));
            const ri = Math.min(RAMP.length - 1, 2 + Math.floor(lit * (RAMP.length - 3)));
            buckets[ci].push(x * cellW, y * cellH + cellH * 0.5, ri);
            continue;
          }

          /* ── the space it stands in ────────────────────
             three depth layers of sparse characters, each breathing at its own
             rate. every cell here is anchored: the field is the room, and a
             room does not move because you moved your hand in it. */
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

      /* one fillStyle change per colour instead of one per character — the
         state change is the expensive part, not the glyph. */
      ctx.font = `${fontPx}px "IBM Plex Mono", ui-monospace, monospace`;
      for (let b = 0; b < buckets.length; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        ctx.fillStyle = COLORS[b];
        for (let i = 0; i < list.length; i += 3) {
          ctx.fillText(RAMP[list[i + 2]], list[i], list[i + 1]);
        }
      }
    };

    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      draw(t);
    };

    const startup = () => {
      if (disposed) return;
      resize();
      if (reduced) {
        /* one static frame, centred, no loop and no pointer tracking. */
        draw(0);
        return;
      }
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerleave', onLeave);
      raf = requestAnimationFrame(frame);
    };

    /* metrics measured before IBM Plex Mono lands would size the grid to a
       fallback font and never correct itself. */
    if (document.fonts?.ready) document.fonts.ready.then(startup);
    else startup();

    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw(0);
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <canvas className="ascii" ref={canvasRef} aria-hidden="true" />;
}

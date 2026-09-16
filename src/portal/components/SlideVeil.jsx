import { useEffect, useRef } from 'react';
import './SlideVeil.css';

/**
 * the doorway between the marketing site and the portal.
 *
 * a sheet the colour of the page slides off and comes apart as it goes: a lit
 * seam leads it, the sheet crumbles into character cells behind that seam, and
 * what breaks off is left behind as a trail of digits that fall and burn out.
 * the page is already laid out underneath, so the seam is not covering a reveal
 * — it *is* the reveal.
 *
 * it runs in both directions, and the direction is the whole point. going into
 * the portal the sheet leaves to the right; coming back out to the site it
 * leaves to the left, so the two halves of the product sit on either side of
 * you and the transition says which way you just moved. `reverse` mirrors the
 * entire effect about the vertical axis — solid, fray, seam and trail — through
 * a single sign, `dir`, rather than through a canvas transform, because a
 * flipped canvas would draw every digit in the trail backwards.
 *
 * this replaces a WebGL tunnel. the tunnel was good work that you had to watch
 * every single time you crossed between the site and the portal, and a
 * transition crossed several times a session has to be the cheapest thing on
 * the screen rather than the most expensive. 760ms, one canvas, no input asked
 * for and none needed — there is nothing here to skip, which is why there is no
 * skip button.
 *
 * canvas 2d, deliberately. the whole effect is a character grid, which is what
 * canvas text is for, and the page it hands off to (AsciiField) is another one.
 * standing up a WebGL context to draw a wipe and tearing it down a second later
 * was the single most expensive thing either front door did.
 *
 * nothing here holds per-grain state. every cell's fate is a hash of its own
 * coordinates read against the seam's distance, so the entire effect is a pure
 * function of one number — where the seam is — and a dropped frame costs a
 * frame rather than desynchronising a particle system.
 */

/* the whole crossing. short enough that it never becomes something to sit
   through, long enough that the trail has somewhere to fall. */
const DURATION = 760;

/* how wide the sheet frays: all holes at the seam, solid at the far side. */
const BAND = 132;
/* ...and how far the debris lags behind before it is gone. */
const TAIL = 168;

/* the grid, in css pixels. fine enough to read as grain rather than as tiles. */
const CELL_W = 9;
const CELL_H = 15;

const BG = '#0a0a0b';
const MONO = '"IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace';

/* sparse → dense, the same ramp the character field uses. a grain that has only
   just broken off is a digit; as it falls it thins out through the ramp until
   there is nothing left of it. */
const RAMP = '.,:;=+*7#%@';
const DIGITS = '0123456789';

/* hot at the seam, cold by the end of the trail. the warm stops are the site's
   own accent tokens, unmodified. */
const INK = [
  '#ffd0ad',
  '#ffa366',
  '#ff6b2b',
  '#ff4d00',
  '#cc4409',
  '#93380f',
  '#5c2712',
  '#474756',
];

/* stable per-cell randomness — no allocation, same value every frame. */
function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* slow off the mark, quick through the middle, settled at the end. an ease-out
   would put the seam three-quarters across in the first two hundred ms and then
   spend the rest of the time crawling the last of the sheet off screen, which
   is exactly where a wipe starts reading as slow. */
function ease(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export default function SlideVeil({ reverse = false, onReveal, onDone }) {
  const hostRef = useRef(null);
  /* read through refs so a re-rendering parent cannot restart the wipe. */
  const revealRef = useRef(onReveal);
  const doneRef = useRef(onDone);
  revealRef.current = onReveal;
  doneRef.current = onDone;

  /* the effect is built once and never rebuilt, so the direction is read into
     it rather than tracked: a veil that changed direction halfway across would
     be a bug, not a feature. */
  const dirRef = useRef(reverse ? -1 : 1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const dir = dirRef.current;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      /* no 2d context is close to impossible, but this host is a full-screen
         element and leaving it up would black out the page it exists to
         reveal. open the door and ask to be taken off it. */
      revealRef.current?.();
      doneRef.current?.();
      return undefined;
    }
    host.appendChild(canvas);

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;

    const measure = () => {
      width = host.clientWidth || window.innerWidth;
      height = host.clientHeight || window.innerHeight;
      cols = Math.ceil(width / CELL_W);
      rows = Math.ceil(height / CELL_H);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `${CELL_H - 3}px ${MONO}`;
    };
    measure();

    let raf = 0;
    let start = 0;
    let disposed = false;

    /* the seam's whole journey: from the far side of a fully covered screen to
       far enough past the near side that the last of the trail has gone with
       it. mirrored, the two ends swap. */
    const span = () => width + BAND + TAIL;
    const origin = () => (dir > 0 ? -BAND : width + BAND);

    const draw = (edge) => {
      ctx.clearRect(0, 0, width, height);

      /* ── what is left of the sheet ─────────────────────────────────
         a hair lighter towards its leading side, so it reads as something
         lifting off the page rather than as the page itself. */
      const solid = edge + dir * BAND;
      const near = dir > 0 ? Math.max(0, solid) : 0;
      const far = dir > 0 ? width : Math.min(width, solid);
      if (far > near) {
        /* the light end is always the one against the seam. */
        const grad =
          dir > 0 ? ctx.createLinearGradient(near, 0, width, 0) : ctx.createLinearGradient(far, 0, 0, 0);
        grad.addColorStop(0, '#0d0d10');
        grad.addColorStop(1, BG);
        ctx.fillStyle = grad;
        ctx.fillRect(near, 0, far - near, height);
      }

      /* ── the fray ─────────────────────────────────────────────────
         a cell survives with a probability running from nothing at the seam to
         certainty at the far edge of the band. the coarse term is what keeps it
         from reading as television static: grains come away in small clumps,
         the way a solid thing actually breaks. */
      const wob = edge * 0.012;
      const c0 = Math.max(0, Math.floor(Math.min(edge, solid) / CELL_W));
      const c1 = Math.min(cols, Math.ceil(Math.max(edge, solid) / CELL_W));
      ctx.fillStyle = BG;
      for (let cx = c0; cx < c1; cx++) {
        const x = cx * CELL_W;
        const base = ((x - edge) * dir) / BAND;
        for (let cy = 0; cy < rows; cy++) {
          /* the seam is not a ruled line — it undulates down the screen, and
             the undulation travels with it. */
          const f = base + Math.sin(cy * 0.19 + wob) * 0.09;
          const r = 0.55 * hash(cx, cy) + 0.45 * hash(cx >> 1, cy >> 1);
          /* half-pixel overdraw: at a fractional dpr, exactly-adjacent rects
             leave hairlines between them and the sheet looks gauzy. */
          if (r < f) ctx.fillRect(x, cy * CELL_H, CELL_W + 0.5, CELL_H + 0.5);
        }
      }

      /* ── the seam ─────────────────────────────────────────────────
         the one bright thing on screen, and the whole reason a sheet the exact
         colour of the page behind it is legible as a moving object at all. */
      if (edge > -60 && edge < width + 60) {
        const g0 = edge - 30 * dir;
        const g1 = edge + 90 * dir;
        const glow = ctx.createLinearGradient(g0, 0, g1, 0);
        glow.addColorStop(0, 'rgba(255, 77, 0, 0)');
        glow.addColorStop(0.25, 'rgba(255, 77, 0, 0.22)');
        glow.addColorStop(1, 'rgba(255, 77, 0, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(Math.min(g0, g1), 0, 120, height);

        /* drawn per row with its own jitter and weight. one clean rect reads as
           a loading bar; a broken line reads as an edge under strain. */
        for (let cy = 0; cy < rows; cy++) {
          const h = hash(cy, 7);
          ctx.globalAlpha = 0.34 + h * 0.52;
          ctx.fillStyle = h > 0.74 ? '#ffd0ad' : '#ff4d00';
          ctx.fillRect(edge + (h - 0.5) * 5, cy * CELL_H, 1.6, CELL_H + 0.5);
        }
        ctx.globalAlpha = 1;
      }

      /* ── what came off ───────────────────────────────────────────
         everything behind the seam, falling. position is derived from the
         seam's distance rather than integrated, so a grain's whole arc is fixed
         the moment the seam passes it — the trail can never smear or drift out
         of step with the edge that produced it. */
      const spent = edge - dir * TAIL;
      const t0 = Math.max(0, Math.floor(Math.min(edge, spent) / CELL_W));
      const t1 = Math.min(cols, Math.ceil(Math.max(edge, spent) / CELL_W));
      for (let cx = t0; cx < t1; cx++) {
        const x = cx * CELL_W;
        const d = (edge - x) * dir;
        if (d < 0 || d > TAIL) continue;
        const a = (1 - d / TAIL) ** 1.7;
        /* thins out as it goes, so the trail ends by running out of grains
           rather than by fading a full field of them to zero. */
        const cut = 0.32 + a * 0.5;
        ctx.fillStyle = INK[Math.min(INK.length - 1, Math.floor((1 - a) * INK.length))];
        for (let cy = 0; cy < rows; cy++) {
          const h = hash(cx, cy);
          if (h > cut) continue;
          const h2 = hash(cx + 91, cy + 17);
          /* drifts back against the sheet's travel and accelerates downwards,
             which is the only part of this that has to look like gravity. */
          const ox = -d * 0.07 * (0.4 + h2) * dir;
          const oy = ((d * d) / (TAIL * 5)) * (0.35 + h * 1.3);
          ctx.globalAlpha = Math.min(1, a * (0.5 + h2 * 0.7));
          const ch =
            a > 0.66
              ? DIGITS[(cx * 7 + cy * 3) % 10]
              : RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.floor(a * RAMP.length * 1.4)))];
          ctx.fillText(ch, x + ox, cy * CELL_H + oy);
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now) => {
      if (disposed) return;
      /* seeded from the frame's own timestamp, not from performance.now() up
         here: rAF stamps a callback with the time the frame began, which is
         before this effect ran, and seeding from here makes the first step
         negative. */
      if (!start) start = now;
      const t = Math.min(1, Math.max(0, (now - start) / DURATION));
      draw(origin() + dir * ease(t) * span());
      if (t >= 1) {
        doneRef.current?.();
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    /* the sheet covers the screen on the first painted frame, so the page
       underneath can start arriving immediately — by the time the seam is over
       it, it is finished type rather than something fading in under a wipe. */
    draw(origin());
    revealRef.current?.();
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      if (disposed) return;
      measure();
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, []);

  return <div className="veil" data-dir={reverse ? 'left' : 'right'} ref={hostRef} aria-hidden="true" />;
}

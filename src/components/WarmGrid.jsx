import { useEffect, useRef } from 'react';
import { useIsMobile, useMedia, usePageVisible, useReducedMotion } from '../lib/hooks';
import './WarmGrid.css';

/**
 * "The grid gets warm" — fixed canvas under everything. Faint orange dot
 * grid (cursor-reactive on desktop) plus a heat bloom that lags the scroll.
 * Killed entirely under prefers-reduced-motion.
 *
 * The grid is drawn as a repeating pattern, not as dots. Drawing it a dot at a
 * time meant roughly seventeen hundred fillStyle assignments and fillRects per
 * frame on a laptop, every frame the page scrolled, over a canvas the full size
 * of the window — which is the most expensive thing on the page that nobody can
 * see. A pattern fill is one draw call for the same picture. Only the dots
 * inside the cursor's falloff differ from their neighbours, so only that one
 * box is cleared and redrawn by hand, and only on a machine with a cursor.
 */

const R = 200; // cursor falloff radius
const ACCENT = '255,77,0';
const BASE_A = 0.075;

/* a single grid cell with one dot at its centre, rendered once and repeated.
   kept at device resolution so the dot stays crisp on a retina panel, then
   scaled back down by the pattern transform. */
function buildTile(spacing, dpr) {
  const tile = document.createElement('canvas');
  tile.width = Math.max(1, Math.round(spacing * dpr));
  tile.height = Math.max(1, Math.round(spacing * dpr));
  const tctx = tile.getContext('2d');
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.fillStyle = `rgba(${ACCENT},${BASE_A})`;
  tctx.fillRect(spacing / 2 - 1, spacing / 2 - 1, 2, 2);
  return tile;
}

export default function WarmGrid() {
  const reduced = useReducedMotion();
  const isMobile = useIsMobile();
  const fine = useMedia('(pointer: fine)');
  const visible = usePageVisible();
  const ref = useRef(null);

  useEffect(() => {
    if (reduced || !visible) return undefined;
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: true });

    const spacing = isMobile ? 46 : 28; // density drops on mobile
    const track = fine && !isMobile; // cursor reaction disabled on mobile

    let W = 0;
    let H = 0;
    let dpr = 1;
    let pattern = null;
    let patternScaled = false;
    let raf = 0;
    let dirty = true;
    let scrollY = window.scrollY;
    let bloom = scrollY;
    const mouse = { x: -9999, y: -9999 };

    const resize = () => {
      /* the grid is a two-pixel dot at seven percent opacity. rendering it at 3x
         on a phone quadruples the raster cost of a full-screen canvas to describe
         a difference nobody can resolve, so the backing store is capped well below
         the panel. */
      dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const tile = buildTile(spacing, dpr);
      pattern = ctx.createPattern(tile, 'repeat');
      patternScaled = false;
      if (pattern && typeof pattern.setTransform === 'function' && typeof DOMMatrix === 'function') {
        try {
          pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
          patternScaled = true;
        } catch {
          patternScaled = false;
        }
      }
      /* no pattern transform available: fall back to a tile built in css pixels so
         the grid still lands on the right spacing, just a touch softer. */
      if (!patternScaled) {
        pattern = ctx.createPattern(buildTile(spacing, 1), 'repeat');
      }
      dirty = true;
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);

      // heat bloom — trails the scroll, brightest toward the section you left
      const cy = bloom - scrollY + H * 0.35;
      const g = ctx.createLinearGradient(0, cy - H * 0.55, 0, cy + H * 0.55);
      g.addColorStop(0, `rgba(${ACCENT},0)`);
      g.addColorStop(0.5, `rgba(${ACCENT},0.05)`);
      g.addColorStop(1, `rgba(${ACCENT},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, cy - H * 0.55, W, H * 1.1);

      // dot grid, scroll-anchored so it belongs to the page — one fill, not N
      const oy = -(((scrollY % spacing) + spacing) % spacing);
      ctx.save();
      ctx.translate(0, oy - spacing / 2);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, -oy + spacing / 2 - spacing, W, H + spacing * 2);
      ctx.restore();

      if (!track || mouse.x < -1000) return;

      /* the cursor's falloff is the only place the dots are not identical. clear
         that one box and lay its dots down individually — a couple of hundred,
         against the whole screen's worth before. */
      const x0 = Math.max(0, mouse.x - R);
      const x1 = Math.min(W, mouse.x + R);
      const y0 = Math.max(0, mouse.y - R);
      const y1 = Math.min(H, mouse.y + R);
      if (x1 <= x0 || y1 <= y0) return;
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      /* clearing takes the bloom out with the dots, and a 400px square with no
         warmth in it follows the cursor around the page as a dark block. the
         gradient is in canvas coordinates, so painting it back over just this box
         lands exactly on the bloom around it. */
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

      const startX = spacing / 2 + Math.ceil((x0 - spacing / 2) / spacing) * spacing;
      const startY = oy + Math.ceil((y0 - oy) / spacing) * spacing;
      for (let y = startY; y < y1; y += spacing) {
        for (let x = startX; x < x1; x += spacing) {
          const dx = x - mouse.x;
          const dy = y - mouse.y;
          const d2 = dx * dx + dy * dy;
          let a = BASE_A;
          let s = 2;
          if (d2 < R * R) {
            const t = 1 - Math.sqrt(d2) / R;
            a = BASE_A + t * 0.25;
            s = 2 + Math.round(t * 2);
          }
          ctx.fillStyle = `rgba(${ACCENT},${a})`;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
    };

    /* the loop parks itself. before, it asked for a frame forever and checked a
       flag inside it, which keeps the compositor awake for the life of the tab to
       do nothing; now a settled grid schedules no frames at all and the next
       scroll or mouse move starts it again. */
    let running = false;
    const loop = () => {
      if (Math.abs(bloom - scrollY) > 0.5) {
        bloom += (scrollY - bloom) * 0.055;
        dirty = true;
      } else {
        bloom = scrollY;
      }
      if (dirty) {
        draw();
        dirty = false;
        raf = requestAnimationFrame(loop);
        return;
      }
      running = false;
      raf = 0;
    };
    const wake = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };

    const onResize = () => {
      resize();
      wake();
    };
    const onScroll = () => {
      scrollY = window.scrollY;
      dirty = true;
      wake();
    };
    const onMove = (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      dirty = true;
      wake();
    };

    resize();
    wake();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
    if (track) window.addEventListener('mousemove', onMove, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      if (track) window.removeEventListener('mousemove', onMove);
    };
  }, [reduced, isMobile, fine, visible]);

  if (reduced) return null;
  return <canvas className="warmgrid" ref={ref} aria-hidden="true" />;
}

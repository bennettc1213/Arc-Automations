import { useEffect, useRef } from 'react';
import { useIsMobile, useMedia, useReducedMotion } from '../lib/hooks';
import './WarmGrid.css';

/**
 * "The grid gets warm" — fixed canvas under everything. Faint orange dot
 * grid (cursor-reactive on desktop) plus a heat bloom that lags the scroll.
 * Dirty-flag rendering: draws only when something actually changed.
 * Killed entirely under prefers-reduced-motion.
 */
export default function WarmGrid() {
  const reduced = useReducedMotion();
  const isMobile = useIsMobile();
  const fine = useMedia('(pointer: fine)');
  const ref = useRef(null);

  useEffect(() => {
    if (reduced) return undefined;
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');

    const spacing = isMobile ? 46 : 28; // density drops on mobile
    const R = 200; // cursor falloff radius
    const track = fine && !isMobile; // cursor reaction disabled on mobile

    let W = 0;
    let H = 0;
    let raf = 0;
    let dirty = true;
    let scrollY = window.scrollY;
    let bloom = scrollY;
    const mouse = { x: -9999, y: -9999 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    };
    resize();
    window.addEventListener('resize', resize);

    const onScroll = () => {
      scrollY = window.scrollY;
      dirty = true;
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const onMove = (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      dirty = true;
    };
    if (track) window.addEventListener('mousemove', onMove, { passive: true });

    const draw = () => {
      ctx.clearRect(0, 0, W, H);

      // heat bloom — trails the scroll, brightest toward the section you left
      const cy = bloom - scrollY + H * 0.35;
      const g = ctx.createLinearGradient(0, cy - H * 0.55, 0, cy + H * 0.55);
      g.addColorStop(0, 'rgba(255,77,0,0)');
      g.addColorStop(0.5, 'rgba(255,77,0,0.05)');
      g.addColorStop(1, 'rgba(255,77,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, cy - H * 0.55, W, H * 1.1);

      // dot grid, scroll-anchored so it belongs to the page
      const oy = -(((scrollY % spacing) + spacing) % spacing);
      for (let y = oy; y < H + spacing; y += spacing) {
        for (let x = spacing / 2; x < W; x += spacing) {
          let a = 0.075;
          let s = 2;
          if (track) {
            const dx = x - mouse.x;
            const dy = y - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < R * R) {
              const t = 1 - Math.sqrt(d2) / R;
              a = 0.075 + t * 0.25;
              s = 2 + Math.round(t * 2);
            }
          }
          ctx.fillStyle = `rgba(255,77,0,${a})`;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
    };

    const loop = () => {
      if (Math.abs(bloom - scrollY) > 0.5) {
        bloom += (scrollY - bloom) * 0.055;
        dirty = true;
      }
      if (dirty) {
        draw();
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', onScroll);
      if (track) window.removeEventListener('mousemove', onMove);
    };
  }, [reduced, isMobile, fine]);

  if (reduced) return null;
  return <canvas className="warmgrid" ref={ref} aria-hidden="true" />;
}

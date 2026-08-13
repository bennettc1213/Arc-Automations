import { useEffect, useRef } from 'react';
import { useMedia, useReducedMotion } from '../lib/hooks';

const INTERACTIVE =
  'a, button, [role="button"], input, .wrow__bar, .acc__head, .demo-yt__cell, .chip--physics, .toolkit__pit';

// trail: 10 squares, shrinking and fading as they fall behind
const TRAIL = [
  { s: 8, o: 0.5 },
  { s: 7, o: 0.44 },
  { s: 6, o: 0.38 },
  { s: 6, o: 0.32 },
  { s: 5, o: 0.26 },
  { s: 4, o: 0.2 },
  { s: 4, o: 0.15 },
  { s: 3, o: 0.11 },
  { s: 3, o: 0.08 },
  { s: 2, o: 0.05 },
];

/**
 * Small orange square cursor (snaps, never a dot) + a heavy spring trail.
 * Each trail square chases the one ahead of it — real damping, real
 * overshoot. Fast movement stretches it; stopping settles it back into
 * the core. Desktop only, killed under 768px and reduced motion.
 */
export default function CursorSquare() {
  const fine = useMedia('(pointer: fine)');
  const wide = useMedia('(min-width: 769px)');
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;
  const trailOn = enabled && wide;
  const coreRef = useRef(null);
  const trailRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const core = coreRef.current;
    const trailEls = trailOn ? [...trailRef.current.children] : [];
    const N = trailEls.length;

    let mx = -100;
    let my = -100;
    let size = 10;
    let press = false;
    let tight = false;
    let seeded = false;
    let raf = 0;
    let running = false;

    const px = new Array(N).fill(-100);
    const py = new Array(N).fill(-100);
    const vx = new Array(N).fill(0);
    const vy = new Array(N).fill(0);

    const applyCore = () => {
      const s = press ? size - 2 : size;
      core.style.width = `${s}px`;
      core.style.height = `${s}px`;
      core.style.transform = `translate3d(${mx - s / 2}px, ${my - s / 2}px, 0)`;
    };

    const tick = () => {
      // spring chain: head chases the cursor, each square chases the last
      const k = tight ? 0.42 : 0.22;
      const d = tight ? 0.55 : 0.66;
      let energy = 0;
      for (let i = 0; i < N; i++) {
        const tx = i === 0 ? mx : px[i - 1];
        const ty = i === 0 ? my : py[i - 1];
        vx[i] = (vx[i] + (tx - px[i]) * k) * d;
        vy[i] = (vy[i] + (ty - py[i]) * k) * d;
        px[i] += vx[i];
        py[i] += vy[i];
        energy += Math.abs(vx[i]) + Math.abs(vy[i]);
        const el = trailEls[i];
        const half = TRAIL[i].s / 2;
        el.style.transform = `translate3d(${px[i] - half}px, ${py[i] - half}px, 0)`;
        el.style.opacity = tight ? Math.min(TRAIL[i].o * 1.7, 0.85) : TRAIL[i].o;
      }
      if (energy < 0.05) {
        running = false; // settled into the core — stop burning frames
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (N && !running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    };

    const onMove = (e) => {
      mx = e.clientX;
      my = e.clientY;
      core.style.opacity = '1';
      if (trailRef.current) trailRef.current.style.opacity = '1';
      if (!seeded) {
        seeded = true;
        px.fill(mx);
        py.fill(my);
      }
      applyCore();
      wake();
    };
    const onOver = (e) => {
      tight = !!e.target.closest?.(INTERACTIVE);
      size = tight ? 18 : 10;
      applyCore();
      wake();
    };
    const onDown = () => {
      press = true;
      applyCore();
    };
    const onUp = () => {
      press = false;
      applyCore();
    };
    const onLeave = () => {
      core.style.opacity = '0';
      if (trailRef.current) trailRef.current.style.opacity = '0';
    };

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseover', onOver, { passive: true });
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [enabled, trailOn]);

  if (!enabled) return null;
  return (
    <>
      {trailOn && (
        <div className="cursor-trail" ref={trailRef} aria-hidden="true">
          {TRAIL.map((t, i) => (
            <span key={i} style={{ width: t.s, height: t.s, opacity: t.o }} />
          ))}
        </div>
      )}
      <div className="cursor-square" ref={coreRef} aria-hidden="true" />
    </>
  );
}

import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../lib/hooks';
import { PixelMark } from './PixelGuy';
import './Marquee.css';

/**
 * Infinite marquee. Base direction via `reverse`; flips with scroll direction
 * and gets a small velocity kick, both eased back to cruise speed.
 */
export default function Marquee({ items, separator = '✦', reverse = false, className = '' }) {
  const trackRef = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return undefined;
    const track = trackRef.current;
    if (!track) return undefined;

    const base = 60; // px/s cruise speed
    const dirBase = reverse ? 1 : -1;
    let dir = dirBase;
    let speed = base;
    let targetSpeed = base;
    let pos = 0;
    let half = track.scrollWidth / 2;
    let lastY = window.scrollY;
    let lastT = performance.now();
    let raf;

    const onResize = () => {
      half = track.scrollWidth / 2;
    };
    window.addEventListener('resize', onResize);

    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      if (dy !== 0) dir = dy > 0 ? dirBase : -dirBase;
      targetSpeed = base + Math.min(Math.abs(dy) * 6, 340);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const tick = (t) => {
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      targetSpeed += (base - targetSpeed) * 0.045; // decay the kick
      speed += (targetSpeed - speed) * 0.12;
      pos += dir * speed * dt;
      if (half > 0) {
        // wrap into (-half, 0]
        pos = ((pos % half) + half) % half;
        track.style.transform = `translate3d(${pos - half}px,0,0)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [reduced, reverse]);

  const row = items.map((item, i) => (
    <span className="marquee__item" key={i}>
      <span className="marquee__sep" aria-hidden="true">
        {i % 4 === 2 ? <PixelMark size={13} /> : separator}
      </span>
      {item}
    </span>
  ));

  return (
    <div className={`marquee ${className}`} aria-hidden="true">
      <div className="marquee__track" ref={trackRef}>
        <div className="marquee__group">{row}</div>
        <div className="marquee__group">{row}</div>
      </div>
    </div>
  );
}

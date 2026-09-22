import { useEffect, useRef } from 'react';
import { useAnimate } from '../lib/hooks';
import { PixelMark } from './PixelGuy';
import './Marquee.css';

/**
 * Infinite marquee. Base direction via `reverse`; flips with scroll direction
 * and gets a small velocity kick, both eased back to cruise speed.
 *
 * It runs only while it is on screen. That sounds obvious and was not true: the
 * three marquees on this page each wrote a transform every frame for as long as
 * the tab was open, which measured at 180 style recalculations a second while
 * parked at the footer, nine thousand pixels from the nearest one. Desktops
 * absorbed it; laptops and phones wore it as a permanent tax on every other
 * animation on the page.
 */
export default function Marquee({ items, separator = '✦', reverse = false, className = '' }) {
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const active = useAnimate(rootRef);

  useEffect(() => {
    if (!active) return undefined;
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

    /* the transform is only written when it would actually move the strip by a
       visible amount. at cruise speed on a 120hz panel a frame is half a pixel,
       and a sub-pixel rewrite costs a full style recalculation to render the same
       thing twice. */
    let written = -1;
    const tick = (t) => {
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      targetSpeed += (base - targetSpeed) * 0.045; // decay the kick
      speed += (targetSpeed - speed) * 0.12;
      pos += dir * speed * dt;
      if (half > 0) {
        // wrap into (-half, 0]
        pos = ((pos % half) + half) % half;
        const next = Math.round(pos);
        if (next !== written) {
          written = next;
          track.style.transform = `translate3d(${next - half}px,0,0)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [active, reverse]);

  const row = items.map((item, i) => (
    <span className="marquee__item" key={i}>
      <span className="marquee__sep" aria-hidden="true">
        {i % 4 === 2 ? <PixelMark size={13} /> : separator}
      </span>
      {item}
    </span>
  ));

  return (
    <div className={`marquee ${className}`} ref={rootRef} aria-hidden="true">
      <div className="marquee__track" ref={trackRef}>
        <div className="marquee__group">{row}</div>
        <div className="marquee__group">{row}</div>
      </div>
    </div>
  );
}

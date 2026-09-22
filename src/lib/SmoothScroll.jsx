import { useEffect } from 'react';
import Lenis from 'lenis';
import { gsap, ScrollTrigger } from './gsap';
import { useMedia, useReducedMotion } from './hooks';

/** shared handle so Nav links can lenis.scrollTo */
export const lenisRef = { current: null };

export function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return;
  if (lenisRef.current) {
    lenisRef.current.scrollTo(target, { offset: -72, duration: 1.2 });
  } else {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * Lenis smooths the wheel. It does not smooth touch — that is off by default and
 * deliberately left off, because fighting a phone's own scroll physics is how a
 * site starts feeling broken. Which means that on a touch device lenis was doing
 * nothing at all while holding a requestAnimationFrame loop open through the gsap
 * ticker for the entire life of the tab, and routing every scroll event through
 * ScrollTrigger.update on top. So it does not get built there.
 */
export default function SmoothScroll({ children }) {
  const reduced = useReducedMotion();
  const coarse = useMedia('(pointer: coarse)');

  useEffect(() => {
    if (reduced || coarse) return undefined;

    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });
    lenisRef.current = lenis;

    lenis.on('scroll', ScrollTrigger.update);
    const raf = (time) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [reduced, coarse]);

  return children;
}

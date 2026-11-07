import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useMedia, useReducedMotion } from '../lib/hooks';

/* what the outline wraps. links that read as buttons, never every inline link in a paragraph. */
const TARGETS = [
  'button:not([disabled])',
  '.ap-button',
  '.ap nav a',
  '.ap-dialog nav a',
  '.ap-tool-links a',
  '.ap-list-row',
  '.ph-btn',
  '.ph-nav a',
  '.pt-btn',
  '[role="button"]',
].join(', ');

/**
 * The client portal's cursor: the browser's own pointer, and an outline that snaps around a
 * button the moment you reach it, takes its corner radius, and lets the button lean a little
 * toward the pointer before springing back. The marketing site keeps its square; a client
 * filling in settings gets a cursor they already know how to use.
 *
 * Desktop pointers only, and nothing under reduced motion.
 */
export default function MagneticCursor({ pull = 0.1, pad = 5 }) {
  const ring = useRef(null);
  const fine = useMedia('(pointer: fine)');
  const reduced = useReducedMotion();
  const on = fine && !reduced;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('cursor-native');
    return () => root.classList.remove('cursor-native', 'magnetic-cursor-active');
  }, []);

  useEffect(() => {
    const el = ring.current;
    if (!on || !el) return undefined;
    const root = document.documentElement;
    let target = null;

    const release = () => {
      if (target) gsap.to(target, { x: 0, y: 0, duration: 0.45, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' });
      target = null;
      root.classList.remove('magnetic-cursor-active');
      gsap.to(el, { opacity: 0, duration: 0.12, overwrite: 'auto' });
    };

    const enter = (node) => {
      if (node.matches(':disabled, [aria-disabled="true"]')) return;
      target = node;
      root.classList.add('magnetic-cursor-active');
      const box = node.getBoundingClientRect();
      gsap.set(el, { xPercent: -50, yPercent: -50 });
      gsap.to(el, {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        width: box.width + pad * 2,
        height: box.height + pad * 2,
        borderRadius: getComputedStyle(node).borderRadius,
        opacity: 1,
        duration: 0.18,
        ease: 'power3.out',
        overwrite: 'auto',
      });
    };

    /* one delegated listener: pages here mount and unmount rows constantly, and a listener
       per element would need an observer to keep up. */
    const onOver = (e) => {
      const node = e.target.closest?.(TARGETS);
      if (node === target) return;
      if (target) release();
      if (node) enter(node);
    };
    const onMove = (e) => {
      if (!target) return;
      if (!target.isConnected) return release();
      const box = target.getBoundingClientRect();
      const dx = (e.clientX - box.left - box.width / 2) * pull;
      const dy = (e.clientY - box.top - box.height / 2) * pull;
      gsap.to(target, { x: dx, y: dy, duration: 0.25, ease: 'power3.out', overwrite: 'auto' });
      gsap.set(el, { x: box.left + box.width / 2 + dx, y: box.top + box.height / 2 + dy });
    };
    const onLeaveWindow = () => release();

    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeaveWindow);
    window.addEventListener('blur', release);
    window.addEventListener('scroll', release, { passive: true, capture: true });
    return () => {
      release();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeaveWindow);
      window.removeEventListener('blur', release);
      window.removeEventListener('scroll', release, { capture: true });
    };
  }, [on, pull, pad]);

  if (!on) return null;
  return <div ref={ring} className="magnetic-cursor" aria-hidden="true" />;
}

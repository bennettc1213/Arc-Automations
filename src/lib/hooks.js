import { useEffect, useState, useRef } from 'react';

export function useMedia(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useReducedMotion() {
  return useMedia('(prefers-reduced-motion: reduce)');
}

export function useIsMobile() {
  return useMedia('(max-width: 768px)');
}

/** true while the element is on screen — used to pause demo loops offscreen */
export function useInView(ref, rootMargin = '0px') {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/** true when the browser is asking us to send less: data saver, or a connection
    slow enough that a decorative physics engine is an insult. read once — it is a
    device setting, not something that changes mid-scroll. */
export function useSaveData() {
  const [save] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    const c = navigator.connection;
    if (!c) return false;
    return Boolean(c.saveData) || /^(slow-2g|2g)$/.test(c.effectiveType ?? '');
  });
  return save;
}

/** interval that automatically pauses when `active` is false */
export function useLoop(callback, delay, active) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  });
  useEffect(() => {
    if (!active || delay == null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay, active]);
}

/** true while the tab is actually being looked at. a decorative loop that keeps
    writing transforms in a background tab is pure battery burn — browsers throttle
    rAF there but not timers, and the wake-up repaint when you come back is worse
    for having kept the work queued. */
export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** the gate every decorative loop on the site runs behind: on screen, in a tab
    somebody is looking at, and not overridden by a motion preference.

    this exists because the cost we measured was not any one animation being
    expensive — it was cheap animations running everywhere at once, forever. three
    marquees writing a transform per frame cost 180 style recalcs a second at the
    *footer*, nine thousand pixels from the nearest marquee. a phone pays for that
    in frames it never had to spare. */
export function useAnimate(ref, rootMargin = '200px') {
  const inView = useInView(ref, rootMargin);
  const visible = usePageVisible();
  const reduced = useReducedMotion();
  return inView && visible && !reduced;
}

/** a device that will struggle with the decorative layer: a phone or tablet, a
    machine that told us to send less, or one with too few cores to spare any for
    an ornament. read once — none of it changes mid-session.

    deliberately NOT keyed on viewport width. a narrow window on a desktop is still
    a desktop, and a 1280px laptop with four cores is the machine that complained. */
export function useWeakDevice() {
  const [weak] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    const c = navigator.connection;
    if (c && (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType ?? ''))) return true;
    if ((navigator.hardwareConcurrency ?? 8) <= 4) return true;
    if ((navigator.deviceMemory ?? 8) <= 4) return true;
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
    return false;
  });
  return weak;
}

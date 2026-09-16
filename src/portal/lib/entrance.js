import { useCallback, useEffect, useState } from 'react';
import SlideVeil from '../components/SlideVeil';

/**
 * the doorway, as a hook.
 *
 * there are two doors — the client portal at /portal and the ops console at
 * /ops — and they have to be the same door. two copies of this would drift
 * within a month, and the way you would find out is that walking into your own
 * console felt subtly unlike walking into the product you sell.
 *
 * imported statically. the entrance used to carry three.js, so it was fetched
 * on demand behind a retry-on-stale-chunk dance and an eight-second deadline
 * for the fetch; the wipe that replaced it is one small canvas file, and paying
 * a round trip to avoid bundling it would cost more than it saves — including a
 * blank hold on a slow connection at exactly the moment the door should open.
 *
 * returns two flags, not one. `entered` reveals the page; `flown` drops the
 * veil from the tree. the gap between them is the length of the wipe, which is
 * what lets the page be finished and standing still by the time the seam passes
 * over it.
 */

/* the entrance plays on every arrival. it is under a second, and it is the
   transition between the two halves of the product — suppressing it after the
   first visit made the door only exist once. */
export function shouldSkipEntrance() {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function useEntrance() {
  const [entered, setEntered] = useState(shouldSkipEntrance);
  const [flown, setFlown] = useState(shouldSkipEntrance);

  const enter = useCallback(() => setEntered(true), []);
  const finish = useCallback(() => setFlown(true), []);

  /* the last word on the overlay.
     the veil is a full-screen element and it is responsible for asking to be
     removed. if it ever fails to — a canvas that never gets a frame, a tab
     suspended mid-wipe and restored wrong — it would sit on top of the page it
     just revealed and the door would look like a black screen. the wipe is
     760ms of wall clock, so anything still up at two seconds has stopped being
     a transition. */
  useEffect(() => {
    if (flown) return undefined;
    const t = window.setTimeout(() => {
      enter();
      finish();
    }, 2000);
    return () => window.clearTimeout(t);
  }, [flown, enter, finish]);

  /* coming back with the browser's back button can restore this page from the
     back/forward cache, which hands back the live DOM and never remounts the
     component — so the entrance would be skipped precisely when someone is
     re-entering. a restore replays it. */
  useEffect(() => {
    const onShow = (e) => {
      if (!e.persisted) return;
      const skip = shouldSkipEntrance();
      setEntered(skip);
      setFlown(skip);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /* nothing behind the veil should scroll while it is still crossing: the page
     is revealed from the first frame, so unlike the old tunnel there is real
     content under there for a stray wheel to move. */
  useEffect(() => {
    if (flown) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [flown]);

  return { entered, flown, Veil: SlideVeil, enter, finish };
}

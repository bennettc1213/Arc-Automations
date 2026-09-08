import { useCallback, useEffect, useState } from 'react';

/**
 * the doorway, as a hook.
 *
 * lifted out of PortalHome verbatim because there are now two doors — the client
 * portal at /portal and the ops console at /ops — and they have to be the same
 * door. two copies of this would drift within a month, and the way you would find
 * out is that walking into your own console felt subtly unlike walking into the
 * product you sell.
 *
 * the entrance carries three.js, so it is fetched on demand rather than bundled
 * into a marketing site that will mostly never show it. if that fetch fails or
 * stalls, the page opens anyway — an animation is never allowed to be the reason
 * somebody cannot reach a dashboard.
 *
 * returns two flags, not one. `entered` reveals the page; `flown` drops the
 * tunnel from the tree. they are separated by the length of the fade —
 * collapsing them would unmount the canvas on the same frame it commits to
 * flying through, and the transition would end in a hard cut.
 */

/* guards the one-shot reload used to recover from a stale deploy. one key for
   both doors: the question it answers is "has this tab already tried a reload",
   which is not per-route. */
const RELOAD_KEY = 'arc.portal.chunkRetry';

/* the entrance plays on every arrival. it is short, it skips on a click or a
   keypress, and it is the transition between the two halves of the product —
   suppressing it after the first visit made the door only exist once. */
export function shouldSkipEntrance() {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function useEntrance() {
  const [entered, setEntered] = useState(shouldSkipEntrance);
  const [flown, setFlown] = useState(shouldSkipEntrance);
  const [Tunnel, setTunnel] = useState(null);

  const enter = useCallback(() => setEntered(true), []);
  const finish = useCallback(() => setFlown(true), []);

  /* fetched imperatively rather than through React.lazy so a failed chunk is a
     branch we handle, not an unhandled rejection that takes the tree down. */
  useEffect(() => {
    if (flown) return undefined;
    let live = true;
    import('../components/HoleTunnel')
      .then((mod) => live && setTunnel(() => mod.default))
      .catch(() => {
        if (!live) return;
        /* a chunk that fails to load almost always means this tab is running an
           index.html from an earlier deploy, naming asset files that no longer
           exist — every build renames them. one reload picks up the current
           build. the flag is what stops that becoming a loop when the failure is
           something else, and sessionStorage is right for it because the question
           is only ever "in this tab, already tried?". */
        let retried = false;
        try {
          retried = window.sessionStorage.getItem(RELOAD_KEY) === '1';
          window.sessionStorage.setItem(RELOAD_KEY, '1');
        } catch {
          /* storage unavailable: treat as already retried and open the door */
          retried = true;
        }
        if (!retried) {
          window.location.reload();
          return;
        }
        enter();
        finish();
      });
    return () => {
      live = false;
    };
  }, [flown, enter, finish]);

  /* a slow chunk must not become a locked door — but this only guards the wait
     for the chunk. once the tunnel is actually on screen the timer is dropped:
     from that point the visitor is in control and has a cue telling them so, and
     a timeout would yank the entrance out from under someone still reading it. */
  useEffect(() => {
    if (entered || Tunnel) return undefined;
    const t = window.setTimeout(() => {
      enter();
      finish();
    }, 8000);
    return () => window.clearTimeout(t);
  }, [entered, Tunnel, enter, finish]);

  /* coming back with the browser's back button can restore this page from the
     back/forward cache, which hands back the live DOM and never remounts the
     component — so the entrance would be skipped precisely when someone is
     re-entering. a restore replays it. */
  useEffect(() => {
    const onShow = (e) => {
      if (!e.persisted) return;
      const skip = shouldSkipEntrance();
      setTunnel(null);
      setEntered(skip);
      setFlown(skip);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /* the last word on the overlay.
     the tunnel is an opaque full-screen element and it is responsible for asking
     to be removed. if it ever fails to — no WebGL, a lost context, a frame loop
     that never gets a frame — it would sit on top of the page it just revealed
     and the door would look like a black screen. the reveal itself is 560ms of
     wall clock, so anything still up at two seconds has stopped being a
     transition. */
  useEffect(() => {
    if (!entered || flown) return undefined;
    const t = window.setTimeout(finish, 2000);
    return () => window.clearTimeout(t);
  }, [entered, flown, finish]);

  /* nothing behind the tunnel should scroll while it is still the whole screen. */
  useEffect(() => {
    if (entered) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [entered]);

  return { entered, flown, Tunnel, enter, finish };
}

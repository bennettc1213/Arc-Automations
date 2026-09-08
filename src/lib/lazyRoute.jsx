import { lazy } from 'react';

/**
 * route-level code splitting, with the one failure mode that actually happens handled.
 *
 * a chunk that fails to load almost always means this tab is running an index.html from an
 * earlier deploy, naming asset files that no longer exist — every build renames them. one
 * reload picks up the current build. the sessionStorage flag is what stops that becoming a
 * reload loop when the failure is something else, and session scope is right because the
 * question is only ever "in this tab, already tried?".
 *
 * this is the same recovery PortalHome performs by hand for the tunnel chunk. it is a
 * helper here because the reason to split these routes is size, and the portal is now most
 * of the application by weight: the dashboard, its eight pages and the demo dataset together
 * are larger than the marketing site they would otherwise be bundled into, for visitors who
 * will mostly never open them.
 */

const RELOAD_KEY = 'arc.chunkRetry';

export default function lazyRoute(load) {
  return lazy(() =>
    load().catch((error) => {
      let retried = false;
      try {
        retried = window.sessionStorage.getItem(RELOAD_KEY) === '1';
        window.sessionStorage.setItem(RELOAD_KEY, '1');
      } catch {
        /* storage unavailable: treat as already retried rather than reloading blind */
        retried = true;
      }

      if (!retried) {
        window.location.reload();
        /* a promise that never settles, so nothing renders in the moment before the
           reload takes the page. rejecting here would flash an error first. */
        return new Promise(() => {});
      }

      throw error;
    }),
  );
}

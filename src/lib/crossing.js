/**
 * which side of the product you were last on.
 *
 * the site and the portal are one deployment and one router, so moving between
 * them is a re-render rather than a page load. that is what makes the crossing
 * animation possible at all — and it is also why the direction it plays cannot
 * be read off the page being entered. `/` looks identical whether you arrived
 * from a search result, from a bookmark, or from the portal's "back to the
 * site"; only the route you left says which.
 *
 * one module-level string, deliberately. this is not state anything renders
 * from — nothing re-renders when it changes, and no component owns it — so a
 * context would be four files of ceremony around a value that is only ever read
 * once, during the first render of the page that just mounted.
 *
 * the browser's back button comes out in the wash, which is the real reason the
 * transition is modelled this way round. an exit animation has to hold the
 * navigation open while it plays, and there is no holding a popstate open: by
 * the time you hear about it the URL has already changed. an *arrival* that
 * knows where it came from needs no such cooperation, so the back button, the
 * back-to-the-site link in the portal's bar, the one in its button row and the
 * one in the workspace account menu are all the same code path.
 */

/* every route on the portal side of the product. /auth is in here because a
   magic-link landing belongs to the portal even though it renders almost
   nothing — bouncing out of it to the site should still read as leaving. */
const PORTAL = /^\/(portal|ops|demo|login|auth)(\/|$)/;

let last = null;

export function noteRoute(pathname) {
  last = pathname;
}

/** did we just come out of the portal onto a page that is not part of it? */
export function leftThePortal(pathname) {
  return last !== null && PORTAL.test(last) && !PORTAL.test(pathname);
}

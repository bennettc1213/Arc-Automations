/* where a magic link should land, remembered across the round trip.
 *
 * there are two destinations now — a client's dashboard and the ops console — and
 * the link itself is the only thing that crosses between requesting one and
 * following it. so the destination is carried twice, deliberately:
 *
 *   ?next=/ops/console  on the redirect url, read first because somebody asked
 *                       for it explicitly
 *   localStorage        the belt, for the case supabase drops the query string on
 *                       the way through
 *
 * localStorage rather than sessionStorage because a magic link routinely opens in
 * a new tab, and a session-scoped hint would be gone precisely when it is needed.
 *
 * its own module so the sign-in surfaces can import it without pulling in the
 * callback route they are sending people to.
 */

const NEXT_KEY = 'arc.auth.next';

export function rememberDestination(path) {
  try {
    localStorage.setItem(NEXT_KEY, path);
  } catch {
    /* private mode. the ?next= param and the admin check downstream still get the
       operator to the right place. */
  }
}

export function takeDestination() {
  try {
    const value = localStorage.getItem(NEXT_KEY);
    localStorage.removeItem(NEXT_KEY);
    return safePath(value);
  } catch {
    return null;
  }
}

/* only same-origin paths, and never a protocol-relative one: `//evil.com` is a
   valid argument to navigate() and an open redirect. */
export function safePath(value) {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : null;
}

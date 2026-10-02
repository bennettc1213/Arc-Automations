/* the id both workspaces give their <main>, and the handler behind "skip to the page".
 *
 * it moves focus without putting a fragment in the address bar — the url is the page
 * somebody bookmarks, and "#ws-page" is not part of it. the href stays on the link so it is
 * still a link with somewhere to go if this never runs. */

export const PAGE_ID = 'ws-page';

export function skipToPage(event) {
  event.preventDefault();
  document.getElementById(PAGE_ID)?.focus();
}

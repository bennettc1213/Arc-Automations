/* the workspace's map of itself.
 *
 * one declaration, read by the sidebar, the page title in the top bar and the command
 * palette. three places that each kept their own list would drift within a week, and the
 * failure mode is a page that exists but cannot be found from the search box.
 *
 * grouped the way an owner thinks about the product rather than the way it is built:
 * "what came in" first, then "what is running it", then "the account".
 */

export const NAV_GROUPS = [
  {
    label: 'the work',
    items: [
      {
        to: '',
        end: true,
        icon: 'overview',
        label: 'overview',
        title: 'overview',
        blurb: 'the numbers and the live feed',
      },
      {
        to: 'leads',
        icon: 'leads',
        label: 'leads',
        title: 'leads',
        blurb: 'every lead, what happened to it, and how fast',
      },
      {
        to: 'activity',
        icon: 'activity',
        label: 'activity',
        title: 'activity',
        blurb: 'the raw run log, newest first',
      },
    ],
  },
  {
    label: 'the machine',
    items: [
      {
        to: 'automations',
        icon: 'automations',
        label: 'automations',
        title: 'automations',
        blurb: 'what is running for you and how it is doing',
      },
      {
        to: 'reliability',
        icon: 'reliability',
        label: 'reliability',
        title: 'reliability',
        blurb: 'end-to-end checks, uptime and past incidents',
      },
    ],
  },
  {
    label: 'account',
    items: [
      {
        to: 'reports',
        icon: 'reports',
        label: 'reports',
        title: 'reports',
        blurb: 'month by month, and the export',
      },
      {
        to: 'account',
        icon: 'account',
        label: 'account',
        title: 'account & configuration',
        blurb: 'what is wired up, who gets notified',
      },
      {
        to: 'support',
        icon: 'support',
        label: 'support',
        title: 'support',
        blurb: 'how to reach a person, and how fast',
      },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);

/* resolves the page a path is on. matched longest-first so `/leads` does not lose to the
   empty index path, which is a prefix of everything — and so `clients/new` in the ops
   console does not lose to `clients`, which is a prefix of it.

   `items` is a parameter because the ops console renders the same shell over a different
   map of itself. it is the shell that is shared, not the list of pages. */
export function activeItem(pathname, base, items = NAV_ITEMS) {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, '') : '';
  return (
    [...items]
      .sort((a, b) => b.to.length - a.to.length)
      .find((item) => (item.to === '' ? rest === '' : rest === item.to || rest.startsWith(`${item.to}/`))) ??
    items[0]
  );
}

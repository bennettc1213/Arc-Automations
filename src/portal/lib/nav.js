/* the workspace's map of itself.
 *
 * one declaration, read by the sidebar, the page title in the top bar and the command
 * palette. three places that each kept their own list would drift within a week, and the
 * failure mode is a page that exists but cannot be found from the search box.
 *
 * grouped the way an owner thinks about the product rather than the way it is built: the
 * work the business does, then the machine running it, then the account.
 *
 * the lifecycle modules each carry a `module` key. that key is what `navGroupsFor` filters
 * on, so a client who does not sell memberships never sees a memberships tab — a nav item
 * leading to a page of dashes is a worse answer than no nav item. the full list stays
 * exported for `activeItem` and the palette, because a page reached by a pasted url still
 * needs a title and a blurb even when it is not in this client's rail.
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
        blurb: 'the lifecycle, what needs you, and whether it is all running',
      },
      {
        /* the route keeps its original path. this page grew from "every lead" into the
           whole capture stage — qualification, routing, escalation — but a client who
           bookmarked /leads two years ago still lands where they meant to. */
        to: 'leads',
        module: 'lead_capture',
        icon: 'leads',
        label: 'lead capture',
        title: 'lead capture',
        blurb: 'every opportunity, how fast it was answered, and where it went',
      },
      {
        to: 'estimates',
        module: 'estimates',
        icon: 'reports',
        label: 'estimates',
        title: 'estimate recovery',
        blurb: 'open quotes waiting on a decision, and what came back',
      },
      {
        to: 'reviews',
        module: 'reviews',
        icon: 'reliability',
        label: 'reviews',
        title: 'reviews & service recovery',
        blurb: 'requests sent, reviews received, and the cases that need a person',
      },
      {
        to: 'memberships',
        module: 'memberships',
        icon: 'account',
        label: 'memberships',
        title: 'memberships',
        blurb: 'renewals, failed payments and the visits still owed',
      },
      {
        to: 'installs',
        module: 'installs',
        icon: 'automations',
        label: 'install & warranty',
        title: 'install & warranty',
        blurb: 'closeout, serial capture and registration proof',
      },
    ],
  },
  {
    label: 'the machine',
    items: [
      {
        to: 'activity',
        icon: 'activity',
        label: 'activity',
        title: 'activity & system health',
        blurb: 'the raw run log, newest first, and what is checking it',
      },
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

/* the rail this client actually gets.
 *
 * "unavailable" is the only state that hides a page. a module that is declared but has
 * never produced an event stays in the nav on purpose — the page it leads to says it is
 * awaiting connection, which is a thing the client should be able to find and ask about. */
export function navGroupsFor(availability) {
  if (!availability) return NAV_GROUPS;

  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.module || availability[item.module]?.state !== 'unavailable',
    ),
  })).filter((group) => group.items.length > 0);
}

export function navItemsFor(availability) {
  return navGroupsFor(availability).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label })),
  );
}

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

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
        /* ARC-360: the team's own working list. not a lifecycle module — it has no `module`
           key, so it is in every client's rail — and not read off the event log: it is who
           owns a lead and what is due, where lead capture below is what provably happened. */
        to: 'inbox',
        icon: 'clients',
        label: 'lead inbox',
        title: 'lead inbox & pipeline',
        blurb: 'your leads to work: who owns each, what stage it is in, and what is due',
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

/* ARC-MK-120: the proof ledger. not in `NAV_GROUPS`, because no client's portal has one
   yet — it is the demo's front page, over seven written examples. where a workspace is
   given a ledger it takes the front door and the overview moves one step in; every other
   page keeps its address. */
export const LEDGER_ITEM = {
  to: '',
  end: true,
  icon: 'check',
  label: 'proof ledger',
  title: 'proof ledger',
  blurb: 'seven example leads, and why each one counts or does not',
};

function withLedgerHome(groups) {
  return groups.map((group, index) => {
    const items = group.items.map((item) =>
      item.to === '' ? { ...item, to: 'overview', end: false } : item,
    );
    return index === 0 ? { ...group, items: [LEDGER_ITEM, ...items] } : { ...group, items };
  });
}

/* ARC-MK-200: the owner portal's four screens.
 *
 * a second declaration beside `NAV_GROUPS`, not a replacement for it: a launch client (and
 * the demo) gets these four, every other client keeps the map above, and no page is removed
 * from either. each screen is named for the question an owner asks, in the order they ask.
 * `short` is the word under the glyph in the phone's tab bar. */
export const OWNER_NAV_GROUPS = [
  {
    label: 'your account',
    items: [
      {
        to: '',
        end: true,
        icon: 'overview',
        label: 'this month',
        short: 'month',
        title: 'this month',
        blurb: 'is arc working: jobs brought back, what is waiting on you, and what you owe',
      },
      {
        to: 'jobs',
        icon: 'check',
        label: 'jobs',
        short: 'jobs',
        title: 'jobs',
        blurb: 'every lead, step by step, and why it counts or does not',
      },
      {
        to: 'needs-you',
        icon: 'bell',
        label: 'needs you',
        short: 'needs you',
        title: 'needs you',
        blurb: 'what only you can answer: outcomes, handoffs and the odd lead',
      },
      {
        to: 'account',
        end: true,
        icon: 'account',
        label: 'account',
        short: 'account',
        title: 'account',
        blurb: 'what arc is allowed to do, who it tells, and your data',
      },
    ],
  },
];

export const OWNER_NAV_ITEMS = OWNER_NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);

/* where a page of the full workspace lives once the four screens have the front door. only
   two move: the overview gives up the index, and the old account page steps under the new
   one. every other page keeps its address, so a bookmark still lands where it was meant to. */
const OWNER_MOVED = { '': 'overview', account: 'account/details' };

/* the pages an owner can still reach, listed on the account screen under "details". the
   lead inbox and the four not-yet-sold services are left out of the list — their routes
   still resolve, they are just not offered. */
const OWNER_DETAIL_PATHS = ['', 'leads', 'activity', 'automations', 'reliability', 'reports', 'account'];

export const OWNER_DETAIL_ITEMS = OWNER_DETAIL_PATHS.map((path) => {
  const item = NAV_ITEMS.find((entry) => entry.to === path);
  return { ...item, to: OWNER_MOVED[path] ?? path, end: false };
});

/* every page a path can resolve to in an owner workspace: the four, then the whole original
   map at its owner address. what `activeItem` reads, so a pasted link to a hidden page still
   gets its own title rather than borrowing "this month". */
export const OWNER_ALL_ITEMS = [
  ...OWNER_NAV_ITEMS,
  ...NAV_ITEMS.map((item) => ({ ...item, to: OWNER_MOVED[item.to] ?? item.to, end: false })),
];

/* the rail this client actually gets.
 *
 * "unavailable" is the only state that hides a page. a module that is declared but has
 * never produced an event stays in the nav on purpose — the page it leads to says it is
 * awaiting connection, which is a thing the client should be able to find and ask about.
 *
 * with no availability the whole map comes back, which is what `activeItem` resolves a
 * pasted url against. */
export function navGroupsFor(availability, { ledgerHome = false } = {}) {
  const groups = ledgerHome ? withLedgerHome(NAV_GROUPS) : NAV_GROUPS;
  if (!availability) return groups;

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.module || availability[item.module]?.state !== 'unavailable',
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export function navItemsFor(availability, options) {
  return navGroupsFor(availability, options).flatMap((group) =>
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

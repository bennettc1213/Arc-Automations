/* the ops console's map of itself.
 *
 * the same shape nav.js declares for the client workspace, read by the same sidebar, top
 * bar and command palette. one declaration for the same reason: three lists that each knew
 * their own version of the pages would drift within a week, and the failure mode is a page
 * that exists but cannot be found from the search box.
 *
 * grouped the way Ben actually uses it: who the clients are, what they are wired to, and
 * the two things onboarding a new one needs.
 */

export const OPS_NAV_GROUPS = [
  {
    label: 'the book',
    items: [
      {
        to: '',
        end: true,
        icon: 'roster',
        label: 'roster',
        title: 'roster',
        blurb: 'every client at once, and which one needs looking at',
      },
      {
        to: 'clients',
        icon: 'clients',
        label: 'clients',
        title: 'clients',
        blurb: 'the full list, with the numbers behind each one',
      },
      {
        to: 'activity',
        icon: 'activity',
        label: 'activity',
        title: 'activity',
        blurb: 'every run across every client, newest first',
      },
    ],
  },
  {
    label: 'the wiring',
    items: [
      {
        to: 'servers',
        icon: 'servers',
        label: 'connections',
        title: 'connections & servers',
        blurb: 'what each client is wired to, and whether it is actually sending',
      },
      {
        to: 'alerts',
        icon: 'bell',
        label: 'alerts',
        title: 'alerts',
        blurb: 'raise, acknowledge and resolve what a client sees on reliability',
      },
      {
        to: 'supabase',
        icon: 'database',
        label: 'supabase',
        title: 'supabase',
        blurb: 'the project all of this runs on, probed live',
      },
      {
        to: 'audit',
        icon: 'clock',
        label: 'audit log',
        title: 'audit log',
        blurb: 'who did what, appended from inside the edge functions',
      },
    ],
  },
  {
    label: 'onboarding',
    items: [
      {
        to: 'clients/new',
        icon: 'plus',
        label: 'add a client',
        title: 'add a client',
        blurb: 'name them, generate an id, wire them up',
      },
      {
        to: 'identity',
        icon: 'identity',
        label: 'client ids',
        title: 'client ids',
        blurb: 'generate, assign and reissue the ids clients sign in with',
      },
    ],
  },
];

export const OPS_NAV_ITEMS = OPS_NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);

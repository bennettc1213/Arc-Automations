/**
 * what the hero film says — the owner portal's own words, on the demo's own seven leads.
 *
 * the film is a picture, not the product: the real workspace carries a supabase client, a
 * router and luxon, and none of that belongs in the marketing bundle to play a loop nobody
 * can click. so the film holds its figures here, as plain text, and
 * `tests/portal-film.test.js` reads the same figures back off `buildProofLedger`,
 * `ownerMonth` and `ownerNeeds` — the code `/demo` renders — and fails if the two ever
 * disagree. change the demo and that test says what to copy here.
 */

export const FILM_COMPANY = 'Halstead Heating & Air';

/* the four screens a launch client gets (`OWNER_NAV_GROUPS`). */
export const FILM_NAV = [
  { key: 'month', icon: 'overview', label: 'this month' },
  { key: 'jobs', icon: 'check', label: 'jobs' },
  { key: 'needs', icon: 'bell', label: 'needs you' },
  { key: 'account', icon: 'account', label: 'account' },
];

export const FILM_PAGES = {
  month: {
    path: '',
    title: 'this month',
    blurb: 'is arc working: jobs brought back, what is waiting on you, and what you owe',
  },
  needs: {
    path: '/needs-you',
    title: 'needs you',
    blurb: 'what only you can answer: outcomes, handoffs and the odd lead',
  },
  jobs: {
    path: '/jobs',
    title: 'jobs',
    blurb: 'every lead, step by step, and why it counts or does not',
  },
};

/* `ownerMonth(...).figures`, as the demo draws them. the fee is a dash with its reason:
   no terms are on record for an example, and a figure that cannot be shown is never a zero. */
export const FILM_FIGURES = [
  { key: 'brought_back', label: 'jobs brought back', value: '1', note: 'every step on record, and you said it happened' },
  { key: 'waiting', label: 'waiting on you', value: '2', note: 'open “needs you” to see them' },
  { key: 'fee', label: 'fee owed', value: null, note: 'your pilot terms are not entered yet' },
];

/* `ownerMonth(...).proven` */
export const FILM_PROVEN = [
  { label: 'calls and forms in', value: '7' },
  { label: 'texted back', value: '7' },
  { label: 'customers replied', value: '6' },
  { label: 'handed to a person', value: '1' },
];

/* the first question `ownerNeeds` puts on the screen, and the answers (`OWNER_ANSWERS`). */
export const FILM_NEED = {
  kind: 'did the job happen?',
  title: 'the visit booked for monday · 1:30 pm',
  detail: '“no heat this morning. 43221”',
  reason: 'the visit time has passed. one question is waiting for you: did the job happen?',
};

/* the second group on the same screen: the lead arc stopped on and gave to a person. */
export const FILM_HANDOFF = {
  kind: 'handed to you',
  title: '“i smell gas near the furnace”',
  detail: 'monday · 11:36 pm · the reply sounded unsafe',
};

export const FILM_ANSWERS = [
  'sold, or the job happened',
  'quoted, not sold yet',
  'did not happen',
  'not a real job',
  'customer cancelled',
  'duplicate, or already handled',
];

export const FILM_DONE = 'recorded. this job counts.';

/* three of the ledger's seven cards, in the ledger's order. the third is the one the film
   answers: it reads `then` once the owner has said the job happened. */
export const FILM_JOBS = [
  {
    key: 'confirmed',
    title: 'booked, and you confirmed it',
    arrived: 'tuesday · 7:42 pm',
    label: 'counts',
    tone: 'ok',
    reason: 'every step is on record, and you said the job happened.',
  },
  {
    key: 'booked',
    title: 'brought back and booked',
    arrived: 'thursday · 12:17 pm',
    label: 'not counted yet',
    tone: 'idle',
    reason: 'the visit has not happened yet. a booking alone is never billed.',
  },
  {
    key: 'unconfirmed',
    title: 'booked, waiting on your answer',
    arrived: 'monday · 6:05 am',
    label: 'waiting on you',
    tone: 'warn',
    reason: 'the visit time has passed. one question is waiting for you: did the job happen?',
    then: { label: 'counts', tone: 'ok', reason: 'every step is on record, and you said the job happened.' },
  },
];

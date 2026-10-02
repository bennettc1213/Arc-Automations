/**
 * ARC-330 — the three routes a company can take into ARC, and the words for them.
 *
 * **Portal-safe, and imports nothing.** The public homepage draws its `Your Route` section
 * from this file, the pilot intake carries a route key from it, and the onboarding prompts
 * that follow read the same keys — so the site, the sales call and the console name a route
 * one way.
 *
 * A route is product vocabulary, not configuration. Nothing here writes a tenant, and
 * `suggestRoute` is a suggestion a visitor sees: the route a client is actually on is
 * confirmed in authenticated onboarding, and object-level source-of-truth settings — not
 * the route — decide how anything syncs. The route an operator records for a client is kept
 * on `business_profiles.route` (0023); confirming it with the client is still onboarding's.
 *
 * Every string below can reach a customer. `routeModelProblems` refuses the name of the
 * workflow runner and any phrasing that makes a CRM a condition of using ARC.
 */

export const ROUTE_KEYS = ['native', 'hybrid', 'connected'] as const;
export type RouteKey = typeof ROUTE_KEYS[number];

export interface RouteDefinition {
  key: RouteKey;
  name: string;
  /** the owner's side of it, as they would say it. the homepage's three choices. */
  situation: string;
  /** who it is for, in one sentence. */
  audience: string;
  /** two short sentences an owner can read in one look. */
  summary: string;
  /** three things at most — a fourth is a list nobody reads. */
  arcProvides: string[];
  youKeep: string;
}

export const ROUTES: readonly RouteDefinition[] = Object.freeze([
  {
    key: 'native',
    name: 'ARC Native',
    situation: 'We have no system yet',
    audience: 'For companies without a CRM or a real way to track leads.',
    summary: 'We bring the whole thing: where leads land, who your customers are, the follow-up and the booking. There is nothing to buy first.',
    arcProvides: ['One place every lead lands', 'Customer records and follow-up', 'Online booking and reports'],
    youKeep: 'Your phone number and your customers. That is all we need.',
  },
  {
    key: 'hybrid',
    name: 'ARC Hybrid',
    situation: 'We have a few tools we like',
    audience: 'For companies with some systems worth keeping.',
    summary: 'Keep what works. We fill the gaps and connect the pieces, so nothing gets typed in twice.',
    arcProvides: ['Whatever is missing: lead inbox, booking or follow-up', 'Connections to the tools you keep', 'One home for each record, agreed up front'],
    youKeep: 'The tools you like: your calendar, your phone system, your accounting.',
  },
  {
    key: 'connected',
    name: 'ARC Connected',
    situation: 'We already run a full system',
    audience: 'For companies with an established CRM or field-service platform.',
    summary: 'Your system stays in charge. We plug into it to catch missed leads, follow up on its own and show you proof of what it did.',
    arcProvides: ['Missed-lead recovery and follow-up', 'Proof of every message sent and job recovered', 'Reports on where leads slip away'],
    youKeep: 'Your CRM, your field-service platform and everything in them.',
  },
]);

/** true on every route. short enough to read as one line under the routes. */
export const ROUTE_PRINCIPLES: readonly string[] = Object.freeze([
  'No CRM needed to start.',
  'Keep the tools that work.',
  'Same automation on every route.',
  'Switch routes later and keep your history.',
]);

export interface ComparisonRow {
  key: string;
  label: string;
  values: Record<RouteKey, string>;
}

export const ROUTE_COMPARISON: readonly ComparisonRow[] = Object.freeze([
  {
    key: 'records',
    label: 'Where leads and customers are kept',
    values: { native: 'In ARC', hybrid: 'In ARC or your tool', connected: 'In your CRM' },
  },
  {
    key: 'booking',
    label: 'Online booking',
    values: { native: 'ARC booking', hybrid: 'Yours or ARC booking', connected: 'Your calendar' },
  },
  {
    key: 'follow_up',
    label: 'Text and email follow-up',
    values: { native: 'ARC sends it', hybrid: 'ARC, through your provider', connected: 'ARC, through your provider' },
  },
  {
    key: 'automation',
    label: 'Lead recovery and automation',
    values: { native: 'Included', hybrid: 'Included', connected: 'Included' },
  },
  {
    key: 'reporting',
    label: 'Proof and reporting',
    values: { native: 'Included', hybrid: 'Included', connected: 'Included' },
  },
  {
    key: 'to_start',
    label: 'What you need to start',
    values: { native: 'Just your business', hybrid: 'The tools you want to keep', connected: 'Access to your existing system' },
  },
]);

export function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === 'string' && (ROUTE_KEYS as readonly string[]).includes(value);
}

/** a route key from anything a request or a URL might carry, or null. */
export function parseRouteKey(raw: unknown): RouteKey | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return isRouteKey(value) ? value : null;
}

export function getRoute(key: unknown): RouteDefinition | null {
  return ROUTES.find((route) => route.key === key) ?? null;
}

/* ── discovery ──────────────────────────────────────────── */

export interface DiscoveryOption {
  value: string;
  label: string;
}

export interface DiscoveryQuestion {
  key: string;
  question: string;
  options: DiscoveryOption[];
}

/** about what the business can do today, never about which product it bought. */
export const ROUTE_DISCOVERY: readonly DiscoveryQuestion[] = Object.freeze([
  {
    key: 'crm',
    question: 'Do you have software for tracking customers and jobs (a CRM)?',
    options: [
      { value: 'established', label: 'Yes, and it works' },
      { value: 'partial', label: 'Sort of' },
      { value: 'none', label: 'No' },
    ],
  },
  {
    key: 'lead_tracking',
    question: 'Does every new lead get written down somewhere?',
    options: [
      { value: 'yes', label: 'Every one' },
      { value: 'partial', label: 'Some' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    key: 'online_booking',
    question: 'Can customers book online?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    key: 'follow_up',
    question: 'Do follow-up texts and emails go out on their own?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'partial', label: 'Some' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    key: 'keep',
    question: 'How much of what you use today do you want to keep?',
    options: [
      { value: 'everything', label: 'All of it' },
      { value: 'some', label: 'Some of it' },
      { value: 'nothing', label: 'None, start fresh' },
    ],
  },
]);

/** printed with every suggestion. */
export const ROUTE_SUGGESTION_NOTICE = 'Just a suggestion. Nothing is set up until we confirm it with you.';

export type DiscoveryAnswers = Record<string, string>;

export interface RouteSuggestion {
  /** every question answered. a route is suggested only then. */
  complete: boolean;
  route: RouteKey | null;
  /** the answers that counted — unknown questions and values are dropped. */
  answers: DiscoveryAnswers;
  /** keys of the questions still unanswered, in order. */
  remaining: string[];
  reasons: string[];
}

const GAP_NAMES: Record<string, string> = {
  lead_tracking: 'lead tracking',
  online_booking: 'online booking',
  follow_up: 'automated follow-up',
};

/** Only the answers this file's questions offer; anything else is ignored, never an error. */
export function cleanDiscoveryAnswers(raw: unknown): DiscoveryAnswers {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const answers: DiscoveryAnswers = {};
  for (const question of ROUTE_DISCOVERY) {
    const value = Object.hasOwn(source, question.key) ? source[question.key] : undefined;
    if (typeof value === 'string' && question.options.some((option) => option.value === value)) {
      answers[question.key] = value;
    }
  }
  return answers;
}

/**
 * The route these answers point to, or none while any question is open.
 *
 * Deterministic and small on purpose: wanting to start fresh, or having nothing to build
 * on, is Native; an established system kept whole is Connected; everything between is
 * Hybrid. It reads capabilities and never a product name.
 */
export function suggestRoute(raw: unknown): RouteSuggestion {
  const answers = cleanDiscoveryAnswers(raw);
  const remaining = ROUTE_DISCOVERY.filter((q) => !(q.key in answers)).map((q) => q.key);
  if (remaining.length > 0) return { complete: false, route: null, answers, remaining, reasons: [] };

  const capabilities = Object.keys(GAP_NAMES);
  const gaps = capabilities.filter((key) => answers[key] !== 'yes');
  const nothingInPlace = answers.crm === 'none' && capabilities.every((key) => answers[key] === 'no');

  if (answers.keep === 'nothing') {
    return {
      complete: true,
      route: 'native',
      answers,
      remaining,
      reasons: ['You want to start fresh, so ARC provides the lead and customer system.'],
    };
  }
  if (nothingInPlace) {
    return {
      complete: true,
      route: 'native',
      answers,
      remaining,
      reasons: ['There is no CRM, booking or follow-up in place to build on, so ARC provides them.'],
    };
  }
  if (answers.crm === 'established' && answers.keep === 'everything') {
    const reasons = ['You have a system that works and want to keep all of it, so ARC connects to it.'];
    if (gaps.length > 0) reasons.push(`ARC adds on top of it: ${gaps.map((key) => GAP_NAMES[key]).join(', ')}.`);
    return { complete: true, route: 'connected', answers, remaining, reasons };
  }
  const reasons = [
    answers.crm === 'none'
      ? 'You have no CRM but tools you want to keep, so ARC provides the CRM and connects to the rest.'
      : 'You have tools worth keeping and gaps around them, so ARC fills the gaps and connects the rest.',
  ];
  if (gaps.length > 0) reasons.push(`ARC can cover: ${gaps.map((key) => GAP_NAMES[key]).join(', ')}.`);
  return { complete: true, route: 'hybrid', answers, remaining, reasons };
}

/* ── the check ──────────────────────────────────────────── */

/** the workflow runner is infrastructure; a customer is never asked to know its name. */
const INFRASTRUCTURE_TERMS = /\bn8n\b|\bworkflow (?:editor|node)s?\b/i;
/** a CRM is never a condition of using ARC. "do not need to own a CRM" is the opposite claim. */
const CRM_REQUIRED = /(?<!\b(?:not|never) )\b(?:requires?|must have|need(?:s)? to (?:have|own|buy))\b[^.]*\bCRM\b/i;

/** why a line may not be shown to a customer, or null. onboarding copy is held to the same check. */
export function routeCopyProblem(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim() === '') return 'is empty';
  if (INFRASTRUCTURE_TERMS.test(text)) return 'names implementation infrastructure';
  if (CRM_REQUIRED.test(text)) return 'makes a CRM a requirement';
  return null;
}

/** every customer-facing string in this file, with where it came from. */
export function routeCopy(): { where: string; text: string }[] {
  return [
    ...ROUTES.flatMap((route) => [
      { where: `${route.key}.name`, text: route.name },
      { where: `${route.key}.situation`, text: route.situation },
      { where: `${route.key}.audience`, text: route.audience },
      { where: `${route.key}.summary`, text: route.summary },
      { where: `${route.key}.youKeep`, text: route.youKeep },
      ...route.arcProvides.map((text, i) => ({ where: `${route.key}.arcProvides[${i}]`, text })),
    ]),
    ...ROUTE_PRINCIPLES.map((text, i) => ({ where: `principles[${i}]`, text })),
    ...ROUTE_COMPARISON.flatMap((row) => [
      { where: `comparison.${row.key}.label`, text: row.label },
      ...ROUTE_KEYS.map((key) => ({ where: `comparison.${row.key}.${key}`, text: row.values[key] })),
    ]),
    ...ROUTE_DISCOVERY.flatMap((q) => [
      { where: `discovery.${q.key}.question`, text: q.question },
      ...q.options.map((option) => ({ where: `discovery.${q.key}.${option.value}`, text: option.label })),
    ]),
    { where: 'suggestion.notice', text: ROUTE_SUGGESTION_NOTICE },
  ];
}

/** Everything wrong with the route model, or an empty list. */
export function routeModelProblems(): string[] {
  const problems: string[] = [];
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';

  const keys = ROUTES.map((route) => route.key);
  if (keys.length !== ROUTE_KEYS.length || ROUTE_KEYS.some((key, i) => keys[i] !== key)) {
    problems.push(`routes are ${keys.join(', ')}, expected ${ROUTE_KEYS.join(', ')} in that order`);
  }
  for (const route of ROUTES) {
    if (route.arcProvides.length === 0) problems.push(`${route.key} lists nothing ARC provides`);
    if (route.arcProvides.length > 3) problems.push(`${route.key} lists more than three things ARC provides`);
  }

  for (const row of ROUTE_COMPARISON) {
    for (const key of ROUTE_KEYS) {
      if (blank(row.values[key])) problems.push(`comparison row ${row.key} says nothing for ${key}`);
    }
  }
  const rowKeys = ROUTE_COMPARISON.map((row) => row.key);
  if (new Set(rowKeys).size !== rowKeys.length) problems.push('comparison row keys repeat');
  if (!ROUTE_COMPARISON.some((row) => new Set(ROUTE_KEYS.map((key) => row.values[key])).size === 1)) {
    problems.push('no comparison row shows what every route shares');
  }

  const questionKeys = ROUTE_DISCOVERY.map((q) => q.key);
  if (new Set(questionKeys).size !== questionKeys.length) problems.push('discovery question keys repeat');
  for (const q of ROUTE_DISCOVERY) {
    const values = q.options.map((option) => option.value);
    if (values.length < 2) problems.push(`discovery question ${q.key} offers no choice`);
    if (new Set(values).size !== values.length) problems.push(`discovery question ${q.key} repeats an option`);
  }
  for (const key of Object.keys(GAP_NAMES)) {
    if (!questionKeys.includes(key)) problems.push(`suggestRoute reads ${key}, which is not asked`);
  }

  for (const { where, text } of routeCopy()) {
    const problem = routeCopyProblem(text);
    if (problem) problems.push(`${where} ${problem}`);
  }
  return problems;
}

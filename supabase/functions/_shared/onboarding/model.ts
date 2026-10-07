/**
 * ARC-390 — route-aware onboarding: what a business can do today, which side provides each
 * part of it from now on, and what is still missing.
 *
 * **Portal-safe.** No database, no network, no Deno API; the imports below are themselves
 * portal-safe. The console's onboarding page draws from this file, the `ops` function checks
 * a plan with the same functions, and `0028_onboarding.sql` checks the parts that protect
 * data a third time where they cannot be skipped. The vocabularies here are drift-tested
 * against that migration.
 *
 * Three things, kept apart:
 *
 *   answers   what the business said it has. evidence of a conversation; decides nothing.
 *   the plan  an operator's decision: a route (`routes/model.ts`) and, for each capability,
 *             ARC, their own system, or not part of this setup.
 *   the matrix  what is actually so, derived every time from the plan and the live rows —
 *             never stored. a capability the plan gives to ARC is `arc` only once the ARC
 *             piece exists; one it leaves with their system is `external` only once ARC can
 *             reach that system. everything between is `blocked`, with the reason.
 *
 * A capability is something a business does, never a product: "where customers are kept",
 * not the name of the software they are kept in. A product enters only as the connector an
 * `external` choice names, from the registry (`registry/connectors.ts`), or as a name the
 * business uses for a tool ARC has no connector for.
 *
 * What this model deliberately cannot do: select a module, activate one, publish a form,
 * connect a provider or hand a record's authority to anybody. `recommendPlan` is a
 * suggestion; saving a plan writes the plan. Authority moves only through
 * `onboarding_apply_authority` (0028), with what it will change acknowledged first, and
 * going live is still ARC-120's gate on the activation page.
 */

import { looksSecret } from '../connections/redact.ts';
import { getConnector, isTenantCredentialed, latestSelectableConnectorVersion, type ProviderCategory } from '../registry/connectors.ts';
import {
  cleanDiscoveryAnswers,
  getRoute,
  parseRouteKey,
  ROUTE_DISCOVERY,
  ROUTE_SUGGESTION_NOTICE,
  routeCopyProblem,
  type RouteKey,
  suggestRoute,
} from '../routes/model.ts';

/* ── vocabularies (mirrored by 0028) ────────────────────── */

export const CAPABILITY_KEYS = [
  'customer_records', 'lead_intake', 'lead_pipeline', 'website_form', 'messaging',
  'email', 'calendar', 'booking', 'field_service', 'accounting',
] as const;
export type CapabilityKey = typeof CAPABILITY_KEYS[number];

/** what an operator may choose for one capability. */
export const SOURCES = ['arc', 'external', 'not_needed'] as const;
export type Source = typeof SOURCES[number];

/** what a capability turns out to be. `blocked` is never chosen — it is found. */
export const PROVISION_STATES = ['arc', 'external', 'not_needed', 'blocked'] as const;
export type ProvisionState = typeof PROVISION_STATES[number];
/** what the matrix can show: those four, or nobody having said yet. */
export const MATRIX_STATES = [...PROVISION_STATES, 'undecided'] as const;
export type MatrixState = typeof MATRIX_STATES[number];

/** the CRM records (ARC-340 `OBJECT_TYPES`) whose authority a capability decides. */
export type OwnedObject = 'contact' | 'lead' | 'appointment';

export const EVENT_TYPES = ['answers_saved', 'plan_saved', 'route_changed', 'authority_changed', 'capability_enabled'] as const;

export const EXISTING_RECORDS = ['none', 'spreadsheet', 'their_system'] as const;
export type ExistingRecords = typeof EXISTING_RECORDS[number];

export const LIMITS = Object.freeze({ tool: 80 });

export interface BusinessCapability {
  key: CapabilityKey;
  label: string;
  /** asked of the business, about what it does today. */
  question: string;
  /** what ARC brings when ARC provides it — or null: ARC never does this. */
  arc: string | null;
  /** said in place of `arc` when ARC never does this. */
  outside: string | null;
  /** the kind of record whose source of truth this decides, when it decides one. */
  object: OwnedObject | null;
  /** what those records are called in a sentence. */
  noun: string;
  /** the kinds of provider that could be the other side of it. */
  providers: readonly ProviderCategory[];
  /** whether something ARC does stops working until ARC can reach their system. */
  arcReliesOnIt: boolean;
}

export const CAPABILITIES: readonly BusinessCapability[] = Object.freeze([
  {
    key: 'customer_records',
    label: 'Customer records',
    question: 'Where is your customer list kept today?',
    arc: 'ARC keeps every customer, with their history.',
    outside: null,
    object: 'contact',
    noun: 'customer records',
    providers: ['crm', 'fsm'],
    arcReliesOnIt: true,
  },
  {
    key: 'lead_intake',
    label: 'Lead intake',
    question: 'When a new lead comes in, where does it get written down?',
    arc: 'Every lead lands in one inbox in ARC, however it arrived.',
    outside: null,
    object: null,
    noun: 'new leads',
    providers: ['crm', 'fsm', 'intake'],
    arcReliesOnIt: true,
  },
  {
    key: 'lead_pipeline',
    label: 'Lead pipeline',
    question: 'How do you follow a lead from first contact to booked or lost?',
    arc: 'ARC follows each lead through stages you name.',
    outside: null,
    object: 'lead',
    noun: 'leads',
    providers: ['crm', 'fsm'],
    arcReliesOnIt: true,
  },
  {
    key: 'website_form',
    label: 'Website form',
    question: 'Does your website have a form that sends you leads?',
    arc: 'ARC hosts a form you link to, or frame on your own site.',
    outside: null,
    object: null,
    noun: 'form requests',
    providers: ['intake', 'crm', 'fsm'],
    arcReliesOnIt: true,
  },
  {
    key: 'messaging',
    label: 'Text messaging',
    question: 'What do you text customers from?',
    arc: 'ARC sends texts from a number it provides.',
    outside: null,
    object: null,
    noun: 'text messages',
    providers: ['messaging', 'telephony'],
    arcReliesOnIt: true,
  },
  {
    key: 'email',
    label: 'Email',
    question: 'What do you email customers from?',
    arc: 'ARC sends email on the business’s behalf.',
    outside: null,
    object: null,
    noun: 'emails',
    providers: ['messaging'],
    arcReliesOnIt: true,
  },
  {
    key: 'calendar',
    label: 'Calendar',
    question: 'Where is your schedule kept?',
    arc: 'ARC keeps the calendar and gives each time to one booking.',
    outside: null,
    object: 'appointment',
    noun: 'appointments',
    providers: ['calendar', 'fsm'],
    arcReliesOnIt: true,
  },
  {
    key: 'booking',
    label: 'Online booking',
    question: 'Can customers book a time online?',
    arc: 'ARC hosts a booking page that offers your free times.',
    outside: null,
    object: null,
    noun: 'online bookings',
    providers: ['calendar', 'fsm'],
    arcReliesOnIt: true,
  },
  {
    key: 'field_service',
    label: 'Field-service management',
    question: 'Do you dispatch crews and track jobs in software?',
    arc: null,
    outside: 'ARC does not dispatch crews or track jobs.',
    object: null,
    noun: 'jobs',
    providers: ['fsm'],
    arcReliesOnIt: false,
  },
  {
    key: 'accounting',
    label: 'Accounting',
    question: 'What do you invoice and keep the books in?',
    arc: null,
    outside: 'ARC does not invoice or keep books.',
    object: null,
    noun: 'invoices',
    providers: ['accounting'],
    arcReliesOnIt: false,
  },
]);

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key as string, c]));

export function getCapability(key: unknown): BusinessCapability | null {
  return typeof key === 'string' ? BY_KEY.get(key) ?? null : null;
}

export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return typeof value === 'string' && BY_KEY.has(value);
}

/** the three capabilities that decide who owns a kind of record, in 0028's order. */
export const OWNING_CAPABILITIES: readonly { capability: CapabilityKey; object: OwnedObject }[] = Object.freeze(
  CAPABILITIES.filter((c) => c.object).map((c) => ({ capability: c.key, object: c.object as OwnedObject })),
);

/* ── shapes ─────────────────────────────────────────────── */

export interface CapabilityChoice {
  source: Source;
  /** `external` only: the registry connector that is the other side, when ARC has one. */
  connector_key: string | null;
  /** `external` only: what the business calls the tool, when ARC has no connector for it. */
  tool: string | null;
}

export interface OnboardingPlan {
  route: RouteKey;
  /** a capability left out is not decided yet. */
  capabilities: Partial<Record<CapabilityKey, CapabilityChoice>>;
}

export interface ToolAnswer {
  uses: 'nothing' | 'own_tool';
  /** `own_tool` only: whether they want to go on using it. */
  keep: boolean;
  connector_key: string | null;
  tool: string | null;
}

export interface StackAnswers {
  /** ARC-330's five questions, by the same keys. */
  discovery: Record<string, string>;
  tools: Partial<Record<CapabilityKey, ToolAnswer>>;
  /** whether there is a customer list to bring in, and where it is. */
  existing_records: ExistingRecords | null;
}

export const EMPTY_ANSWERS: StackAnswers = Object.freeze({ discovery: {}, tools: {}, existing_records: null });

export interface FieldError { field: string; message: string }
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

type Raw = Record<string, unknown>;
const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : {});
const isObject = (raw: unknown): raw is Raw => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);

/* ── connectors, as onboarding sees them ────────────────── */

/**
 * `none`       ARC has a name for the system and no adapter. nothing can be connected.
 * `arc_owned`  ARC's own account (its telephony, its intake door): not a system the client has.
 * `client`     a provider the client connects with their own credential (ARC-130).
 */
export type ConnectorReach = 'none' | 'arc_owned' | 'client';

export function registryReach(connectorKey: string): ConnectorReach {
  const version = latestSelectableConnectorVersion(connectorKey);
  if (!version) return 'none';
  return isTenantCredentialed(version) ? 'client' : 'arc_owned';
}

export interface ConnectorView {
  known(key: string): boolean;
  name(key: string): string;
  category(key: string): ProviderCategory | null;
  reach(key: string): ConnectorReach;
}

/** the registry. a test passes its own view to stand in a provider the registry lacks. */
export const REGISTRY_VIEW: ConnectorView = Object.freeze({
  known: (key: string) => getConnector(key) !== null,
  name: (key: string) => getConnector(key)?.displayName ?? key,
  category: (key: string) => getConnector(key)?.category ?? null,
  reach: registryReach,
});

const providerName = (choice: { connector_key: string | null; tool: string | null }, view: ConnectorView) =>
  (choice.connector_key ? view.name(choice.connector_key) : choice.tool) ?? 'their system';

/* ── parsing ────────────────────────────────────────────── */

function toolName(raw: unknown, field: string, errors: FieldError[]): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') { errors.push({ field, message: 'is the name of a tool' }); return null; }
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value === '') return null;
  if (value.length > LIMITS.tool) { errors.push({ field, message: `is longer than ${LIMITS.tool} characters` }); return null; }
  if (looksSecret(value)) { errors.push({ field, message: 'looks like a credential — a tool is named here, never signed into' }); return null; }
  return value;
}

/** the connector a capability's other side may be, or why not. */
function connectorFor(
  raw: unknown, capability: BusinessCapability, field: string, errors: FieldError[], view: ConnectorView,
): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !view.known(raw)) {
    errors.push({ field, message: 'is not a system ARC has a connector entry for — name the tool instead' });
    return null;
  }
  if (view.reach(raw) === 'arc_owned') {
    errors.push({ field, message: `${view.name(raw)} is ARC's own account here, not a system this business has — choose ARC for ${capability.label.toLowerCase()}` });
    return null;
  }
  const category = view.category(raw);
  if (!category || !capability.providers.includes(category)) {
    errors.push({ field, message: `${view.name(raw)} is not a place ${capability.noun} are kept` });
    return null;
  }
  return raw;
}

/**
 * What the business said about what it has. Strict, because it is kept: an unknown question
 * or an answer the question does not offer is a problem, not something to drop quietly.
 */
export function parseAnswersInput(raw: unknown, view: ConnectorView = REGISTRY_VIEW): Parsed<StackAnswers> {
  const errors: FieldError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'answers', message: 'is an object' }] };
  for (const key of Object.keys(raw)) {
    if (!['discovery', 'tools', 'existing_records'].includes(key)) errors.push({ field: key, message: 'is not part of the questionnaire' });
  }

  const given = asObject(raw.discovery);
  const discovery = cleanDiscoveryAnswers(given);
  for (const key of Object.keys(given)) {
    if (!(key in discovery)) errors.push({ field: `discovery.${key}`, message: 'is not an answer this question offers' });
  }

  const tools: StackAnswers['tools'] = {};
  for (const [key, value] of Object.entries(asObject(raw.tools))) {
    const field = `tools.${key}`;
    const capability = getCapability(key);
    if (!capability) { errors.push({ field, message: 'is not a capability' }); continue; }
    const answer = asObject(value);
    for (const k of Object.keys(answer)) {
      if (!['uses', 'keep', 'connector_key', 'tool'].includes(k)) errors.push({ field: `${field}.${k}`, message: 'is not part of this answer' });
    }
    if (answer.uses !== 'nothing' && answer.uses !== 'own_tool') {
      errors.push({ field: `${field}.uses`, message: 'is "nothing" or "own_tool"' });
      continue;
    }
    if (answer.uses === 'nothing') {
      if (answer.keep === true || answer.connector_key || answer.tool) errors.push({ field, message: 'has nothing in place, so there is no tool to name or keep' });
      tools[capability.key] = { uses: 'nothing', keep: false, connector_key: null, tool: null };
      continue;
    }
    if (answer.keep !== undefined && typeof answer.keep !== 'boolean') errors.push({ field: `${field}.keep`, message: 'must be true or false' });
    tools[capability.key] = {
      uses: 'own_tool',
      keep: answer.keep === true,
      connector_key: connectorFor(answer.connector_key, capability, `${field}.connector_key`, errors, view),
      tool: toolName(answer.tool, `${field}.tool`, errors),
    };
  }

  let existing: ExistingRecords | null = null;
  if (raw.existing_records !== undefined && raw.existing_records !== null && raw.existing_records !== '') {
    if ((EXISTING_RECORDS as readonly unknown[]).includes(raw.existing_records)) existing = raw.existing_records as ExistingRecords;
    else errors.push({ field: 'existing_records', message: `is one of: ${EXISTING_RECORDS.join(', ')}` });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { discovery, tools, existing_records: existing } };
}

/** every question answered: the five about the business, one per capability, and the list. */
export function answersRemaining(answers: StackAnswers | null | undefined): string[] {
  const a = answers ?? EMPTY_ANSWERS;
  return [
    ...ROUTE_DISCOVERY.filter((q) => !(q.key in (a.discovery ?? {}))).map((q) => `discovery.${q.key}`),
    ...CAPABILITIES.filter((c) => !a.tools?.[c.key]).map((c) => `tools.${c.key}`),
    ...(a.existing_records ? [] : ['existing_records']),
  ];
}

/**
 * A plan: a route, and a choice for each capability decided so far. Every problem at once,
 * by field. The rules a route imposes are here and nowhere softer:
 *
 *   native     ARC keeps every record — no capability that owns one may be `external`.
 *   connected  their system keeps the customer list — it may not be ARC, or left out.
 *   hybrid     something is kept in another system; once everything is decided, a plan
 *              with nothing external is Native by another name.
 */
export function parsePlanInput(raw: unknown, view: ConnectorView = REGISTRY_VIEW): Parsed<OnboardingPlan> {
  const errors: FieldError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'plan', message: 'is an object' }] };
  for (const key of Object.keys(raw)) {
    if (key !== 'route' && key !== 'capabilities') errors.push({ field: key, message: 'is not part of a plan' });
  }
  const route = parseRouteKey(raw.route);
  if (!route) errors.push({ field: 'route', message: 'is native, hybrid or connected' });

  const capabilities: OnboardingPlan['capabilities'] = {};
  if (raw.capabilities !== undefined && !isObject(raw.capabilities)) errors.push({ field: 'capabilities', message: 'is an object keyed by capability' });
  for (const [key, value] of Object.entries(asObject(raw.capabilities))) {
    const field = `capabilities.${key}`;
    const capability = getCapability(key);
    if (!capability) { errors.push({ field, message: 'is not a capability' }); continue; }
    const choice = asObject(value);
    for (const k of Object.keys(choice)) {
      if (!['source', 'connector_key', 'tool'].includes(k)) errors.push({ field: `${field}.${k}`, message: 'is not part of a choice' });
    }
    const source = choice.source as Source;
    if (!SOURCES.includes(source)) { errors.push({ field: `${field}.source`, message: `is one of: ${SOURCES.join(', ')}` }); continue; }

    if (source !== 'external') {
      if (choice.connector_key || choice.tool) errors.push({ field, message: 'names another system, so it is not ARC’s and not left out — choose "external"' });
      if (source === 'arc' && !capability.arc) errors.push({ field: `${field}.source`, message: `${capability.outside} Keep the tool they have, or leave it out.` });
      if (route === 'connected' && capability.key === 'customer_records') {
        errors.push({ field: `${field}.source`, message: 'on ARC Connected the customer list stays in their system — name it, or choose ARC Hybrid or ARC Native' });
      }
      capabilities[capability.key] = { source, connector_key: null, tool: null };
      continue;
    }

    const connector = connectorFor(choice.connector_key, capability, `${field}.connector_key`, errors, view);
    const tool = toolName(choice.tool, `${field}.tool`, errors);
    if (!connector && !tool && !errors.some((e) => e.field.startsWith(field))) {
      errors.push({ field, message: 'name the system: pick one ARC knows, or type what they call it' });
    }
    if (route === 'native' && capability.object) {
      errors.push({ field: `${field}.source`, message: `ARC Native keeps ${capability.noun} in ARC — choose ARC Hybrid or ARC Connected to keep them in another system` });
    }
    capabilities[capability.key] = { source, connector_key: connector, tool: connector ? null : tool };
  }

  if (route === 'hybrid' && CAPABILITIES.every((c) => capabilities[c.key]) && !Object.values(capabilities).some((c) => c?.source === 'external')) {
    errors.push({ field: 'route', message: 'nothing is kept in another system, which is ARC Native — name the tool they keep, or choose ARC Native' });
  }
  if (errors.length > 0 || !route) return { ok: false, errors };
  return { ok: true, value: { route, capabilities } };
}

/* ── the recommendation ─────────────────────────────────── */

export interface PlanRecommendation {
  /** the five questions about the business are answered. a route is suggested only then. */
  complete: boolean;
  route: RouteKey | null;
  reasons: string[];
  plan: OnboardingPlan | null;
  /** keys of the questions still open, in order. */
  remaining: string[];
  notice: string;
}

/**
 * The plan these answers point to. A suggestion and nothing else: it returns data, an
 * operator may change every line of it, and nothing exists until a plan is saved — which
 * still selects no module and moves no record.
 */
export function recommendPlan(answers: StackAnswers | null | undefined, view: ConnectorView = REGISTRY_VIEW): PlanRecommendation {
  const a = answers ?? EMPTY_ANSWERS;
  const suggestion = suggestRoute(a.discovery);
  const remaining = answersRemaining(a);
  if (!suggestion.complete || !suggestion.route) {
    return { complete: false, route: null, reasons: [], plan: null, remaining, notice: ROUTE_SUGGESTION_NOTICE };
  }
  const route = suggestion.route;
  const capabilities: OnboardingPlan['capabilities'] = {};
  for (const capability of CAPABILITIES) {
    const tool = a.tools?.[capability.key];
    if (!tool) continue;
    const kept = tool.uses === 'own_tool' && tool.keep && (tool.connector_key || tool.tool);
    /* on Native every record is ARC's, whatever they used before. */
    if (kept && !(route === 'native' && capability.object)) {
      capabilities[capability.key] = { source: 'external', connector_key: tool.connector_key, tool: tool.connector_key ? null : tool.tool };
    } else if (capability.arc) {
      /* on Connected the customer list is theirs: without a named system it stays undecided. */
      if (route === 'connected' && capability.key === 'customer_records') continue;
      capabilities[capability.key] = { source: 'arc', connector_key: null, tool: null };
    } else {
      capabilities[capability.key] = { source: 'not_needed', connector_key: null, tool: null };
    }
  }
  const plan: OnboardingPlan = { route, capabilities };
  const checked = parsePlanInput(plan, view);
  return {
    complete: true,
    route,
    reasons: [
      ...suggestion.reasons,
      ...(checked.ok ? [] : checked.errors.map((e) => `Still to settle: ${e.message}.`)),
    ],
    plan,
    remaining,
    notice: ROUTE_SUGGESTION_NOTICE,
  };
}

/* ── what is actually so ────────────────────────────────── */

export interface PolicyFact { object_type: string; authority: string; connector_key: string | null }
export interface RecordCount { total: number; mapped: Record<string, number> }

/** the live rows the matrix is read off. counted by 0028's `onboarding_facts`, once. */
export interface OnboardingFacts {
  /** the route recorded on `business_profiles` (0023). */
  route: RouteKey | null;
  policies: PolicyFact[];
  /** the client's live provider connections (ARC-130): which provider, and its status. */
  connections: { connector_key: string; status: string }[];
  /** every module the client has a lifecycle for (ARC-120), and its state. */
  modules: { module_key: string; state: string }[];
  hours_set: boolean;
  public_phone: boolean;
  services: number;
  pipeline: boolean;
  forms: { total: number; published: number };
  endpoints: number;
  imports: { completed: number };
  appointment_types: number;
  booking_pages: { total: number; published: number };
  records: Record<OwnedObject, RecordCount>;
  /** channels this deployment can send a person's message on (ARC-370). */
  channels: string[];
}

export const EMPTY_FACTS: OnboardingFacts = Object.freeze({
  route: null, policies: [], connections: [], modules: [], hours_set: false, public_phone: false,
  services: 0, pipeline: false, forms: { total: 0, published: 0 }, endpoints: 0, imports: { completed: 0 },
  appointment_types: 0, booking_pages: { total: 0, published: 0 },
  records: { contact: { total: 0, mapped: {} }, lead: { total: 0, mapped: {} }, appointment: { total: 0, mapped: {} } },
  channels: [],
});

export const STEP_KEYS = [
  'stack', 'route', 'capabilities', 'business', 'authority', 'connections',
  'mapping', 'lead_capture', 'import', 'booking', 'modules', 'activation',
] as const;
export type StepKey = typeof STEP_KEYS[number];

export interface MatrixRow {
  capability: CapabilityKey;
  label: string;
  choice: CapabilityChoice | null;
  state: MatrixState;
  /** who provides it, as it would be said. */
  provider: string;
  reason: string;
  /** the step that closes a gap, when there is one. */
  next: StepKey | null;
}

const CONNECTED = ['verified', 'degraded'];

/** the authority recorded for one kind of record. no row is ARC (ARC-340). */
export function policyOf(facts: OnboardingFacts, object: OwnedObject): { authority: string; connector_key: string | null } {
  const row = facts.policies.find((p) => p.object_type === object);
  return row ? { authority: row.authority, connector_key: row.connector_key ?? null } : { authority: 'arc', connector_key: null };
}

/** the authority a choice asks for. their system owns a record only where ARC has a connector entry to name. */
export function targetPolicy(choice: CapabilityChoice | null | undefined): { authority: 'arc' | 'external'; connector_key: string | null } {
  return choice?.source === 'external' && choice.connector_key
    ? { authority: 'external', connector_key: choice.connector_key }
    : { authority: 'arc', connector_key: null };
}

/** a field-by-field split an operator made (`hybrid`) with the same system satisfies `external`. */
export function policyMatches(current: { authority: string; connector_key: string | null }, target: { authority: string; connector_key: string | null }): boolean {
  if (target.authority === 'arc') return current.authority === 'arc';
  return (current.authority === 'external' || current.authority === 'hybrid') && current.connector_key === target.connector_key;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function arcRow(capability: BusinessCapability, facts: OnboardingFacts, plan: OnboardingPlan, view: ConnectorView): Pick<MatrixRow, 'state' | 'reason' | 'next'> {
  const blocked = (reason: string, next: StepKey): Pick<MatrixRow, 'state' | 'reason' | 'next'> => ({ state: 'blocked', reason, next });
  const ready = (reason: string): Pick<MatrixRow, 'state' | 'reason' | 'next'> => ({ state: 'arc', reason, next: null });

  if (capability.object) {
    const current = policyOf(facts, capability.object);
    if (current.authority !== 'arc') {
      return blocked(`${view.name(current.connector_key ?? '')} is still recorded as where ${capability.noun} are kept. The change of authority has not been applied.`, 'authority');
    }
  }
  switch (capability.key) {
    case 'customer_records':
      return ready('Customers are kept in ARC.');
    case 'lead_intake': {
      const doors = ['typed in', 'imported from a file'];
      if (facts.forms.published > 0) doors.push(plural(facts.forms.published, 'published form'));
      if (facts.endpoints > 0) doors.push(plural(facts.endpoints, 'endpoint'));
      return ready(`Leads land in ARC’s inbox: ${doors.join(', ')}.`);
    }
    case 'lead_pipeline':
      return facts.pipeline ? ready('ARC follows leads through its pipeline.') : blocked('No pipeline exists for this client yet.', 'lead_capture');
    case 'website_form':
      if (facts.forms.published > 0) return ready(`${plural(facts.forms.published, 'form')} published.`);
      return blocked(facts.forms.total > 0 ? 'A form is drafted and not published yet.' : 'No form has been made yet.', 'lead_capture');
    case 'messaging':
      return facts.channels.includes('sms')
        ? ready('ARC sends texts for this client.')
        : blocked('No channel is switched on for a message a person writes. Automated follow-up texts go out through ARC’s number once that module is live.', 'activation');
    case 'email':
      return facts.channels.includes('email')
        ? ready('ARC sends email for this client.')
        : blocked('ARC cannot send email for this client yet: no channel is switched on.', 'activation');
    case 'calendar':
      return facts.hours_set ? ready('ARC keeps the calendar, inside the opening hours.') : blocked('No opening hours are set, so ARC has no times to give.', 'business');
    case 'booking': {
      if (facts.appointment_types === 0) return blocked('Nothing can be booked yet: there is no appointment type.', 'booking');
      if (facts.booking_pages.published === 0) {
        return blocked(facts.booking_pages.total > 0 ? 'A booking page is drafted and not published yet.' : 'No booking page has been made yet.', 'booking');
      }
      const theirs = plan.capabilities.calendar?.source === 'external';
      return ready(theirs
        ? 'ARC’s booking page takes a preferred time. Their own calendar answers it.'
        : `${plural(facts.booking_pages.published, 'booking page')} published.`);
    }
    default:
      return blocked(`${capability.outside ?? 'ARC does not provide this.'}`, 'capabilities');
  }
}

function externalRow(
  capability: BusinessCapability, choice: CapabilityChoice, facts: OnboardingFacts, view: ConnectorView,
): Pick<MatrixRow, 'state' | 'reason' | 'next'> {
  const name = providerName(choice, view);
  const key = choice.connector_key;
  const reach = key ? view.reach(key) : 'none';
  const connection = key ? facts.connections.find((c) => c.connector_key === key) : undefined;
  const connected = Boolean(connection && CONNECTED.includes(connection.status));
  const ready = (reason: string): Pick<MatrixRow, 'state' | 'reason' | 'next'> => ({ state: 'external', reason, next: null });
  const blocked = (reason: string, next: StepKey): Pick<MatrixRow, 'state' | 'reason' | 'next'> => ({ state: 'blocked', reason, next });

  /* nothing ARC does waits on this: it is theirs, and ARC stays out of it. */
  if (!capability.arcReliesOnIt) {
    return ready(connected ? `Kept in ${name}, which is connected.` : `Kept in ${name}. ARC does not read or write it.`);
  }
  /* their own form or lead system can post into ARC without a connector: ARC-350's endpoint. */
  if ((capability.key === 'lead_intake' || capability.key === 'website_form') && facts.endpoints > 0) {
    return ready(`${name} posts leads to ARC through ${plural(facts.endpoints, 'endpoint')}.`);
  }
  if (capability.key === 'lead_intake' || capability.key === 'website_form') {
    if (!connected) return blocked(`${name} does not send leads to ARC yet. Give it an endpoint to post to.`, 'lead_capture');
    return ready(`${name} is connected.`);
  }
  if (reach === 'none') {
    return blocked(capability.object
      ? `ARC has no connection to ${name} yet. Until it has, ARC keeps its own copy of ${capability.noun} and cannot read or change them there.`
      : `ARC has no connection to ${name} yet, so it cannot use it for ${capability.noun}.`, 'connections');
  }
  if (capability.object && !policyMatches(policyOf(facts, capability.object), targetPolicy(choice))) {
    return blocked(`The plan keeps ${capability.noun} in ${name}. The change of authority has not been applied.`, 'authority');
  }
  if (!connected) {
    return blocked(connection ? `${name} is connected but not verified (${connection.status.replace(/_/g, ' ')}).` : `${name} is not connected yet.`, 'connections');
  }
  return ready(`${name} is connected and is where ${capability.noun} are kept.`);
}

/**
 * Every capability, and what it is right now. A capability the plan has not reached is
 * `undecided`; one whose provider is not ready is `blocked`. Both are gaps, and both are
 * listed — nothing is left out of the table to make it look finished.
 */
export function capabilityMatrix(plan: OnboardingPlan | null | undefined, facts: OnboardingFacts, view: ConnectorView = REGISTRY_VIEW): MatrixRow[] {
  return CAPABILITIES.map((capability) => {
    const choice = plan?.capabilities?.[capability.key] ?? null;
    const base = { capability: capability.key, label: capability.label, choice };
    if (!plan || !choice) {
      return { ...base, state: 'undecided' as const, provider: 'not decided', reason: 'Nobody has said who provides this yet.', next: plan ? 'capabilities' as const : 'route' as const };
    }
    if (choice.source === 'not_needed') {
      return { ...base, state: 'not_needed' as const, provider: 'not part of this setup', reason: capability.outside ?? 'Left out of this client’s setup on purpose.', next: null };
    }
    if (choice.source === 'arc') return { ...base, provider: 'ARC', ...arcRow(capability, facts, plan, view) };
    return { ...base, provider: providerName(choice, view), ...externalRow(capability, choice, facts, view) };
  });
}

export const isGap = (row: MatrixRow) => row.state === 'blocked' || row.state === 'undecided';

/* ── the steps ──────────────────────────────────────────── */

export const STEP_STATUSES = ['done', 'todo', 'blocked', 'not_needed'] as const;
export type StepStatus = typeof STEP_STATUSES[number];

/** where in the console a step is done. the page turns these into links; nothing else does. */
export type StepPlace = 'here' | 'lead_capture' | 'workspace' | 'activation' | 'client';

export interface OnboardingStep {
  key: StepKey;
  label: string;
  status: StepStatus;
  detail: string;
  place: StepPlace;
}

const STEP_LABELS: Readonly<Record<StepKey, [label: string, place: StepPlace]>> = Object.freeze({
  stack: ['What they have today', 'here'],
  route: ['Route', 'here'],
  capabilities: ['Who provides what', 'here'],
  business: ['Business profile, hours and services', 'here'],
  authority: ['Where each record is kept', 'here'],
  connections: ['Connect the systems they keep', 'activation'],
  mapping: ['Link existing records', 'workspace'],
  lead_capture: ['Lead sources and forms', 'here'],
  import: ['Bring in their customer list', 'lead_capture'],
  booking: ['Calendar and booking', 'here'],
  modules: ['What ARC runs for them', 'client'],
  activation: ['Test, shadow and go live', 'activation'],
});

/** what a pending change of route or authority will do, counted by 0028 and worded here. */
export interface PendingAuthority {
  digest: string | null;
  route: { from: RouteKey | null; to: RouteKey } | null;
  changes: {
    object_type: OwnedObject;
    capability: CapabilityKey;
    from: { authority: string; connector_key: string | null };
    to: { authority: string; connector_key: string | null };
    records: number;
    mapped: number;
  }[];
}

export const NOTHING_PENDING: PendingAuthority = Object.freeze({ digest: null, route: null, changes: [] });

/**
 * The steps of onboarding, each read off what exists. Nothing here is ticked by hand: a
 * step is done because the form is published, the hours are set, the authority matches the
 * plan — so closing the page loses nothing, and reopening it cannot show a stale tick.
 */
export function onboardingSteps(
  input: { answers: StackAnswers | null; plan: OnboardingPlan | null; facts: OnboardingFacts; pending?: PendingAuthority | null },
  view: ConnectorView = REGISTRY_VIEW,
): OnboardingStep[] {
  const { answers, plan, facts } = input;
  const pending = input.pending ?? NOTHING_PENDING;
  const matrix = capabilityMatrix(plan, facts, view);
  const row = (key: CapabilityKey) => matrix.find((r) => r.capability === key)!;
  const rollup = (keys: CapabilityKey[]): { status: StepStatus; detail: string } => {
    const rows = keys.map(row);
    if (rows.every((r) => r.state === 'not_needed')) return { status: 'not_needed', detail: 'Not part of this setup.' };
    const open = rows.filter(isGap);
    return open.length > 0 ? { status: 'todo', detail: open.map((r) => r.reason).join(' ') } : { status: 'done', detail: rows.filter((r) => r.state !== 'not_needed').map((r) => r.reason).join(' ') };
  };
  const out = new Map<StepKey, { status: StepStatus; detail: string }>();

  const remaining = answersRemaining(answers);
  out.set('stack', remaining.length === 0
    ? { status: 'done', detail: 'Every question is answered.' }
    : { status: 'todo', detail: `${plural(remaining.length, 'question')} still open.` });

  const routeName = (key: RouteKey | null) => getRoute(key)?.name ?? 'no route';
  out.set('route', !plan
    ? { status: 'todo', detail: 'No route has been chosen.' }
    : facts.route === plan.route
      ? { status: 'done', detail: `${routeName(plan.route)}, recorded.` }
      : { status: 'todo', detail: `The plan says ${routeName(plan.route)}; ${facts.route ? routeName(facts.route) : 'nothing'} is recorded. It is recorded when the plan is applied.` });

  const undecided = matrix.filter((r) => r.state === 'undecided').length;
  out.set('capabilities', plan && undecided === 0
    ? { status: 'done', detail: 'Every capability has a provider, or is left out on purpose.' }
    : { status: 'todo', detail: `${plural(undecided, 'capability', 'capabilities')} not decided.` });

  const missing = [!facts.hours_set && 'opening hours', facts.services === 0 && 'at least one service'].filter(Boolean);
  out.set('business', missing.length === 0
    ? { status: 'done', detail: `Opening hours set, ${plural(facts.services, 'service')}.` }
    : { status: 'todo', detail: `Still needed: ${missing.join(' and ')}.` });

  const waiting = pending.changes.length + (pending.route ? 1 : 0);
  out.set('authority', !plan
    ? { status: 'todo', detail: 'Waiting on a plan.' }
    : waiting === 0
      ? { status: 'done', detail: 'Every record is kept where the plan says.' }
      : { status: 'todo', detail: `${plural(waiting, 'change')} waiting to be applied.` });

  const kept = matrix.filter((r) => r.choice?.source === 'external' && getCapability(r.capability)!.arcReliesOnIt);
  const unreachable = kept.filter((r) => r.state === 'blocked' && r.next === 'connections' && (!r.choice?.connector_key || view.reach(r.choice.connector_key) === 'none'));
  const unconnected = kept.filter((r) => r.state === 'blocked' && r.next === 'connections');
  out.set('connections', kept.length === 0
    ? { status: 'not_needed', detail: 'Nothing they keep has to be connected.' }
    : unreachable.length > 0
      ? { status: 'blocked', detail: unreachable.map((r) => r.reason).join(' ') }
      : unconnected.length > 0
        ? { status: 'todo', detail: unconnected.map((r) => r.reason).join(' ') }
        : { status: 'done', detail: 'Every system they keep is connected, or posts to ARC.' });

  const handed = OWNING_CAPABILITIES
    .map(({ capability, object }) => ({ capability, object, policy: policyOf(facts, object) }))
    .filter((o) => o.policy.authority !== 'arc' && o.policy.connector_key);
  const unlinked = handed.map((o) => ({ ...o, left: facts.records[o.object].total - (facts.records[o.object].mapped[o.policy.connector_key!] ?? 0) }));
  out.set('mapping', handed.length === 0
    ? { status: 'not_needed', detail: 'ARC is where every record is kept, so there is nothing to link.' }
    : unlinked.some((o) => o.left > 0)
      ? { status: 'todo', detail: unlinked.filter((o) => o.left > 0).map((o) => `${o.left} of ${facts.records[o.object].total} ${getCapability(o.capability)!.noun} ${o.left === 1 ? 'is' : 'are'} not linked to a record in ${view.name(o.policy.connector_key!)}.`).join(' ') }
      : { status: 'done', detail: 'Every record ARC holds is linked to its counterpart.' });

  out.set('lead_capture', rollup(['lead_intake', 'lead_pipeline', 'website_form']));

  out.set('import', answers?.existing_records !== 'spreadsheet'
    ? { status: 'not_needed', detail: answers?.existing_records === 'their_system' ? 'Their customer list stays in their system.' : 'There is no list to bring in.' }
    : facts.imports.completed > 0
      ? { status: 'done', detail: `${plural(facts.imports.completed, 'file')} imported.` }
      : { status: 'todo', detail: 'They have a customer list in a file. It has not been imported.' });

  out.set('booking', rollup(['calendar', 'booking']));

  const selected = facts.modules.filter((m) => m.state !== 'unselected');
  out.set('modules', selected.length > 0
    ? { status: 'done', detail: `${plural(selected.length, 'module')} selected: ${selected.map((m) => m.module_key).join(', ')}.` }
    : { status: 'todo', detail: 'Nothing is selected for this client yet.' });

  out.set('activation', selected.length > 0 && selected.every((m) => m.state === 'active')
    ? { status: 'done', detail: 'Everything selected is live.' }
    : { status: 'todo', detail: selected.length === 0 ? 'Nothing to take live yet.' : `Not live yet: ${selected.filter((m) => m.state !== 'active').map((m) => `${m.module_key} is ${m.state}`).join(', ')}. Going live is decided on the activation page.` });

  return STEP_KEYS.map((key) => ({ key, label: STEP_LABELS[key][0], place: STEP_LABELS[key][1], ...out.get(key)! }));
}

export interface OnboardingSummary {
  done: number;
  /** steps that apply to this client. */
  total: number;
  gaps: number;
  /** keys of the steps before going live that are still open. */
  outstanding: StepKey[];
  /** nothing is outstanding. says nothing about whether a module may go live — ARC-120 does. */
  ready_for_handoff: boolean;
}

export function onboardingSummary(steps: OnboardingStep[], matrix: MatrixRow[]): OnboardingSummary {
  const applies = steps.filter((s) => s.status !== 'not_needed');
  const outstanding = applies.filter((s) => s.key !== 'activation' && s.status !== 'done').map((s) => s.key);
  return {
    done: applies.filter((s) => s.status === 'done').length,
    total: applies.length,
    gaps: matrix.filter(isGap).length,
    outstanding,
    ready_for_handoff: outstanding.length === 0,
  };
}

/* ── a change of authority, in words ────────────────────── */

/**
 * What applying the pending changes will do, said before it is done. The counts are 0028's;
 * a line never promises that anything is copied, sent or deleted, because nothing is.
 */
export function impactLines(pending: PendingAuthority, view: ConnectorView = REGISTRY_VIEW): string[] {
  const lines: string[] = [];
  if (pending.route) {
    const from = getRoute(pending.route.from)?.name;
    lines.push(`${from ? `The route changes from ${from} to` : 'The route is recorded as'} ${getRoute(pending.route.to)!.name}. No customer, lead, message or appointment is deleted.`);
  }
  for (const change of pending.changes) {
    const noun = getCapability(change.capability)!.noun;
    const none = change.records === 0;
    /* the three nouns a change can be about are plain plurals. */
    const have = none ? `ARC holds no ${noun} yet.` : `ARC holds ${change.records} ${change.records === 1 ? noun.replace(/s$/, '') : noun}.`;
    if (change.to.authority === 'arc') {
      const was = view.name(change.from.connector_key ?? '');
      const kept = none ? '' : ` What ARC holds can be changed in ARC again, and ${change.mapped} of them ${change.mapped === 1 ? 'keeps its' : 'keep their'} link to ${was} as history.`;
      lines.push(`ARC becomes where ${noun} are kept, in place of ${was}. ${have}${kept} A change arriving from ${was} is refused from now on. Nothing is sent to ${was}.`);
      if (change.object_type === 'appointment') lines.push('ARC starts offering times from the opening hours it has.');
    } else {
      const to = view.name(change.to.connector_key ?? '');
      const left = change.records - change.mapped;
      const stays = none ? '' : ` What ARC holds stays in ARC and can still be read, but the fields ${to} owns can no longer be changed from ARC. ${left === 0 ? `Every one is linked to a record in ${to}.` : `${left} of them ${left === 1 ? 'is' : 'are'} not linked to a record in ${to} yet.`}`;
      lines.push(`${to} becomes where ${noun} are kept. ${have}${stays}`);
      if (change.object_type === 'appointment') lines.push('ARC stops offering times: it does not know what is free in their calendar, and a booking becomes a preferred time for them to answer.');
      if (view.reach(change.to.connector_key ?? '') === 'none') lines.push(`ARC has no connection to ${to} yet, so nothing will arrive from it until one exists.`);
    }
  }
  return lines;
}

/* ── the check ──────────────────────────────────────────── */

/** every string here that an owner could be read, with where it came from. */
export function onboardingCopy(): { where: string; text: string }[] {
  return [
    ...CAPABILITIES.flatMap((c) => [
      { where: `${c.key}.label`, text: c.label },
      { where: `${c.key}.question`, text: c.question },
      { where: `${c.key}.noun`, text: c.noun },
      ...(c.arc ? [{ where: `${c.key}.arc`, text: c.arc }] : []),
      ...(c.outside ? [{ where: `${c.key}.outside`, text: c.outside }] : []),
    ]),
    ...STEP_KEYS.map((key) => ({ where: `step.${key}`, text: STEP_LABELS[key][0] })),
  ];
}

/** Everything wrong with the onboarding model, or an empty list. */
export function onboardingModelProblems(): string[] {
  const problems: string[] = [];
  const keys = CAPABILITIES.map((c) => c.key);
  if (keys.length !== CAPABILITY_KEYS.length || CAPABILITY_KEYS.some((key, i) => keys[i] !== key)) {
    problems.push(`capabilities are ${keys.join(', ')}, expected ${CAPABILITY_KEYS.join(', ')} in that order`);
  }
  for (const c of CAPABILITIES) {
    if ((c.arc === null) === (c.outside === null)) problems.push(`${c.key} must say either what ARC brings or that it does not`);
    if (c.providers.length === 0) problems.push(`${c.key} names no kind of provider`);
    if (c.object && !c.arc) problems.push(`${c.key} owns ${c.object} records, which ARC always can keep`);
    if (c.object && !c.arcReliesOnIt) problems.push(`${c.key} owns records ARC works from, so ARC relies on it`);
  }
  const objects = OWNING_CAPABILITIES.map((o) => o.object);
  if (new Set(objects).size !== objects.length) problems.push('two capabilities decide the same kind of record');
  if (STEP_KEYS.some((key) => !STEP_LABELS[key])) problems.push('a step has no label');
  for (const { where, text } of onboardingCopy()) {
    const problem = routeCopyProblem(text);
    if (problem) problems.push(`${where} ${problem}`);
  }
  return problems;
}

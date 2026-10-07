/**
 * ARC-390 — the onboarding service: one read that says where a client's onboarding stands,
 * and the three things an operator can do from it.
 *
 *   getOnboarding      what was said, the plan, the capability matrix, the steps, what a
 *                      change of authority would do, and the history
 *   saveOnboarding     answers, a plan, or both — and nothing else. it selects no module,
 *                      records no route and moves no record
 *   applyAuthority     the route and who keeps each kind of record, as the plan has them,
 *                      for the exact change the operator read (`digest`)
 *   enableCapability   the ARC piece behind a capability the plan gives to ARC: the pipeline,
 *                      a draft form, an appointment type and a draft booking page — each
 *                      through the service that owns it, never published, never switched on
 *
 * Every one is an operator's (`can(actor, 'policy')`, and 0028 checks `arc_admins` again).
 * The matrix and the steps are computed here from 0028's `onboarding_facts` on every read;
 * nothing about progress is stored, so nothing about progress can be stale.
 *
 * Rows travel as the database's own columns (snake_case), as every `ops` response does.
 */

import * as booking from '../booking/service.ts';
import type { BookingStore } from '../booking/service.ts';
import { defaultPageDefinition } from '../booking/model.ts';
import { actorStamp, can, type CrmActor } from '../crm/model.ts';
import * as crm from '../crm/service.ts';
import { CRM_ERROR_STATUS, type CrmOutcome, type CrmStore, CrmStoreError, type Row } from '../crm/service.ts';
import { defaultFormDefinition } from '../intake/model.ts';
import * as intake from '../intake/service.ts';
import type { IntakeStore } from '../intake/service.ts';
import {
  capabilityMatrix,
  type ConnectorView,
  EMPTY_ANSWERS,
  EMPTY_FACTS,
  type FieldError,
  getCapability,
  impactLines,
  isGap,
  type MatrixRow,
  NOTHING_PENDING,
  type OnboardingFacts,
  type OnboardingPlan,
  type OnboardingStep,
  onboardingSteps,
  type OnboardingSummary,
  onboardingSummary,
  parseAnswersInput,
  parsePlanInput,
  type PendingAuthority,
  type PlanRecommendation,
  recommendPlan,
  REGISTRY_VIEW,
  type StackAnswers,
} from './model.ts';

/* ── the store ──────────────────────────────────────────── */

export const ONBOARDING_TABLES = ['tenant_onboarding', 'tenant_onboarding_events'] as const;

export interface OnboardingStore {
  /** the client's one onboarding row, or null before anything was saved. */
  get(tenantId: string): Promise<Row | null>;
  /** 0028's onboarding_facts: what exists, counted. */
  facts(tenantId: string): Promise<Omit<OnboardingFacts, 'channels'>>;
  /** 0028's onboarding_authority_pending: what the plan asks for that is not yet so. */
  pendingAuthority(tenantId: string): Promise<PendingAuthority>;
  save(request: { tenantId: string; actorId: string; expectedRevision: number; answers?: StackAnswers; plan?: OnboardingPlan }): Promise<Row>;
  applyAuthority(request: { tenantId: string; actorId: string; digest: string }): Promise<PendingAuthority & { revision: number }>;
  record(request: { tenantId: string; actorId: string; detail: Row }): Promise<void>;
  events(tenantId: string, limit: number): Promise<Row[]>;
}

export interface OnboardingDeps {
  onboarding: OnboardingStore;
  crm: CrmStore;
  intake: IntakeStore;
  booking: BookingStore;
  /** the channels this deployment can send a person's message on (ARC-370's adapters). */
  channels?: readonly string[];
  /** the connectors onboarding may name. the registry, unless a test stands one in. */
  view?: ConnectorView;
  now?: () => Date;
}

export const ONBOARDING_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 422,
  stale: 409,
  impact_changed: 409,
  nothing_to_apply: 409,
  tenant_inactive: 409,
  immutable: 409,
});

/** the status for a refusal: onboarding's own codes, then the CRM's it can pass on. */
export function onboardingErrorStatus(code: string): number {
  return ONBOARDING_ERROR_STATUS[code] ?? (CRM_ERROR_STATUS as Record<string, number>)[code] ?? 409;
}

/** A refusal the database made on purpose, as opposed to a failure. */
export class OnboardingStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type OnboardingOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; message: string; fieldErrors?: FieldError[] };

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const asObject = (raw: unknown): Row => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {});
const has = (raw: Row, key: string) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined && raw[key] !== null;

const refuse = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });
const invalid = (errors: FieldError[]): { ok: false; code: string; message: string; fieldErrors: FieldError[] } => ({
  ok: false, code: 'invalid', message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: errors,
});

/** an operator, a client that exists, and a store refusal turned into an outcome. */
async function act<T>(
  deps: OnboardingDeps,
  actor: CrmActor | null,
  tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor & { kind: 'operator' }) => Promise<OnboardingOutcome<T>>,
): Promise<OnboardingOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  /* the route and who keeps what are `policy`: an operator's, on every route. */
  const allowed = can(actor, 'policy', tenantId);
  if (!allowed.ok) return refuse(allowed.code, allowed.message);
  if (actor.kind !== 'operator') return refuse('forbidden', 'onboarding is set up by ARC');
  try {
    if (!(await deps.crm.getTenant(tenantId))) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor);
  } catch (error) {
    if (error instanceof OnboardingStoreError || error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

/** a refusal from a service onboarding called, as onboarding's own. */
function passed<T>(outcome: CrmOutcome<T>): { ok: false; code: string; message: string; fieldErrors?: FieldError[] } | null {
  return outcome.ok ? null : { ok: false, code: outcome.code, message: outcome.message, ...(outcome.fieldErrors ? { fieldErrors: outcome.fieldErrors } : {}) };
}

function storedAnswers(row: Row | null): StackAnswers {
  const answers = asObject(row?.answers);
  return {
    discovery: { ...asObject(answers.discovery) },
    tools: { ...asObject(answers.tools) },
    existing_records: answers.existing_records ?? null,
  };
}

/* ── the read ───────────────────────────────────────────── */

export interface OnboardingOverview {
  tenant: { id: string; name: string; timezone: string; status: string };
  /** 0 until something is saved. sent back with every write. */
  revision: number;
  updated_at: string | null;
  answers: StackAnswers;
  plan: OnboardingPlan | null;
  /** what the answers point to. a suggestion: nothing was set up because of it. */
  recommendation: PlanRecommendation;
  facts: OnboardingFacts;
  matrix: MatrixRow[];
  /** the rows of the matrix nobody provides yet. */
  gaps: MatrixRow[];
  steps: OnboardingStep[];
  summary: OnboardingSummary;
  /** what applying the plan's route and authorities would change, and the digest that names it. */
  pending: PendingAuthority & { lines: string[] };
  history: Row[];
  /** what the business step edits, through ARC-340's own actions. */
  business: { profile: Row | null; services: Row[]; service_areas: Row[]; locations: Row[] };
}

async function overview(deps: OnboardingDeps, tenantId: string, actor: CrmActor): Promise<OnboardingOutcome<OnboardingOverview>> {
  const view = deps.view ?? REGISTRY_VIEW;
  const [tenant, row, counted, waiting, history, business] = await Promise.all([
    deps.crm.getTenant(tenantId),
    deps.onboarding.get(tenantId),
    deps.onboarding.facts(tenantId),
    deps.onboarding.pendingAuthority(tenantId),
    deps.onboarding.events(tenantId, 50),
    crm.getBusinessOverview(deps.crm, actor, tenantId),
  ]);
  const refused = passed(business);
  if (refused || !business.ok) return refused!;

  const answers = storedAnswers(row);
  const plan = (row?.plan as OnboardingPlan | null) ?? null;
  const facts: OnboardingFacts = { ...EMPTY_FACTS, ...counted, channels: [...(deps.channels ?? [])] };
  const pending: PendingAuthority = { ...NOTHING_PENDING, ...waiting };
  const matrix = capabilityMatrix(plan, facts, view);
  const steps = onboardingSteps({ answers, plan, facts, pending }, view);
  return {
    ok: true,
    result: {
      tenant: { id: tenantId, name: tenant!.name, timezone: tenant!.timezone, status: tenant!.status },
      revision: row?.revision ?? 0,
      updated_at: row?.updated_at ?? null,
      answers,
      plan,
      recommendation: recommendPlan(row ? answers : EMPTY_ANSWERS, view),
      facts,
      matrix,
      gaps: matrix.filter(isGap),
      steps,
      summary: onboardingSummary(steps, matrix),
      pending: { ...pending, lines: impactLines(pending, view) },
      history,
      business: {
        profile: business.result.profile,
        services: business.result.services,
        service_areas: business.result.service_areas,
        locations: business.result.locations,
      },
    },
  };
}

export function getOnboarding(deps: OnboardingDeps, actor: CrmActor | null, tenantId: unknown): Promise<OnboardingOutcome<OnboardingOverview>> {
  return act(deps, actor, tenantId, (id, who) => overview(deps, id, who));
}

/* ── the writes ─────────────────────────────────────────── */

const revisionOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

/**
 * Keep what the business said, the plan, or both. Every problem with either comes back at
 * once, by field (`answers.…`, `plan.…`). A plan is a decision on paper: this writes the
 * plan and its history line, and that is all it writes.
 */
export function saveOnboarding(deps: OnboardingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<OnboardingOutcome<OnboardingOverview>> {
  return act(deps, actor, tenantId, async (id, who) => {
    const body = asObject(input);
    const view = deps.view ?? REGISTRY_VIEW;
    const errors: FieldError[] = [];
    const expected = revisionOf(body.expected_revision);
    if (expected === null) errors.push({ field: 'expected_revision', message: 'is the revision this page was drawn from (0 before anything is saved)' });

    let answers: StackAnswers | undefined;
    let plan: OnboardingPlan | undefined;
    if (has(body, 'answers')) {
      const parsed = parseAnswersInput(body.answers, view);
      if (parsed.ok) answers = parsed.value;
      else errors.push(...parsed.errors.map((e) => ({ field: `answers.${e.field}`, message: e.message })));
    }
    if (has(body, 'plan')) {
      const parsed = parsePlanInput(body.plan, view);
      if (parsed.ok) plan = parsed.value;
      else errors.push(...parsed.errors.map((e) => ({ field: `plan.${e.field}`, message: e.message })));
    }
    if (!has(body, 'answers') && !has(body, 'plan')) errors.push({ field: 'plan', message: 'send the answers, a plan, or both' });
    if (errors.length > 0) return invalid(errors);

    await deps.onboarding.save({ tenantId: id, actorId: who.userId, expectedRevision: expected!, answers, plan });
    return overview(deps, id, who);
  });
}

/**
 * Record the plan's route and hand each kind of record to the side the plan names — for the
 * change the operator read. `digest` is the one `getOnboarding` returned with what would
 * change; 0028 works the change out again and refuses if it is no longer that one.
 */
export function applyAuthority(
  deps: OnboardingDeps, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<OnboardingOutcome<OnboardingOverview & { applied: PendingAuthority }>> {
  return act(deps, actor, tenantId, async (id, who) => {
    const digest = asObject(input).acknowledged;
    if (typeof digest !== 'string' || !/^[0-9a-f]{32}$/.test(digest)) {
      return invalid([{ field: 'acknowledged', message: 'send back the digest shown with what this will change — it is how ARC knows you read it' }]);
    }
    const applied = await deps.onboarding.applyAuthority({ tenantId: id, actorId: who.userId, digest });
    const after = await overview(deps, id, who);
    return after.ok ? { ok: true, result: { ...after.result, applied } } : after;
  });
}

export interface EnableResult {
  capability: string;
  /** what was made just now. empty when it was all there already. */
  made: string[];
}

/**
 * Set up the ARC piece behind a capability the plan gives to ARC. Each piece is made by the
 * service that owns it, as a draft where a draft exists: nothing is published, nothing is
 * selected, nothing is switched on. Asking twice makes it once.
 */
export function enableCapability(
  deps: OnboardingDeps, actor: CrmActor | null, tenantId: unknown, capabilityKey: unknown,
): Promise<OnboardingOutcome<OnboardingOverview & { enabled: EnableResult }>> {
  return act(deps, actor, tenantId, async (id, who) => {
    const capability = getCapability(capabilityKey);
    if (!capability) return invalid([{ field: 'capability', message: 'is not a capability' }]);
    const row = await deps.onboarding.get(id);
    const plan = (row?.plan as OnboardingPlan | null) ?? null;
    if (plan?.capabilities?.[capability.key]?.source !== 'arc') {
      return invalid([{ field: 'capability', message: `${capability.label} is not provided by ARC in this client's plan — save the plan first` }]);
    }
    const tenant = await deps.crm.getTenant(id);
    if (tenant?.status === 'archived') return refuse('tenant_inactive', 'this client is archived — nothing new is set up for them');

    const made: string[] = [];
    const stores = { crm: deps.crm, intake: deps.intake, booking: deps.booking, now: deps.now };
    switch (capability.key) {
      case 'customer_records':
      case 'lead_intake':
      case 'lead_pipeline': {
        const before = await deps.crm.rows('crm_pipelines', id, { isNull: ['archived_at'], limit: 1 });
        await deps.crm.ensureDefaultPipeline(id);
        if (before.length === 0) made.push('pipeline');
        break;
      }
      case 'website_form': {
        const forms = (await deps.intake.rows('crm_intake_forms', id)).filter((f) => f.status !== 'archived');
        if (forms.length === 0) {
          const saved = passed(await intake.saveForm(stores, who, id, { name: 'Website form', definition: defaultFormDefinition('Request service') }));
          if (saved) return saved;
          made.push('form (draft)');
        }
        break;
      }
      case 'booking': {
        const types = (await deps.booking.rows('crm_appointment_types', id)).filter((t) => !t.archived_at);
        if (types.length === 0) {
          const saved = passed(await booking.saveAppointmentType(stores, who, id, { key: 'visit', name: 'Visit', duration_minutes: 60 }));
          if (saved) return saved;
          made.push('appointment type');
        }
        const pages = (await deps.booking.rows('crm_booking_pages', id)).filter((p) => p.status !== 'archived');
        if (pages.length === 0) {
          const saved = passed(await booking.saveBookingPage(stores, who, id, { name: 'Website booking', definition: defaultPageDefinition('Book a visit') }));
          if (saved) return saved;
          made.push('booking page (draft)');
        }
        break;
      }
      case 'calendar':
        return refuse('invalid', 'ARC keeps the calendar from the opening hours — set them under the business profile');
      default:
        /* messaging, email: a channel is a provider connection and a module, not a draft. */
        return refuse('no_channel', `nothing here switches ${capability.noun} on — that is a provider connection and a module, on the activation page`);
    }
    if (made.length > 0) {
      await deps.onboarding.record({ tenantId: id, actorId: actorStamp(who).id!, detail: { capability: capability.key, made } });
    }
    const after = await overview(deps, id, who);
    return after.ok ? { ok: true, result: { ...after.result, enabled: { capability: capability.key, made } } } : after;
  });
}

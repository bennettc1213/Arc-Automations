import { getSupabase } from './supabase';
import { INTEGRATION_BY_KEY, connectionsFor, observedFor } from './integrations';
import { SERVICE_BY_KEY } from './service-catalog';
import { formatCount, formatRelative } from './format';

/* the services a client bought, and how far each build has got.
 *
 * a "build" here is one service for one client — speed-to-lead for cascade
 * restoration — with the checklist that was copied in when it was sold (see
 * service-catalog.js and migration 0008). everything below the writes is pure: the
 * stage a build is at and what the evidence says about a step are computed from
 * the rows, never stored, so a service cannot read "delivered" while a box on it
 * is still open.
 */

const PHASE_ORDER = { build: 0, integrate: 1 };

/* postgrest says "could not find the table … in the schema cache" (or, older,
   42P01) when 0008 has not been applied. that has one fix, so it gets one
   sentence instead of the raw message. */
const MIGRATION = 'supabase/migrations/0008_client_services.sql';

function buildsError(error) {
  const missing =
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    error.code === 'PGRST202' ||
    /client_service|add_client_services|schema cache/i.test(error.message ?? '');
  return new Error(missing ? `the service checklist tables are not there yet — apply ${MIGRATION}` : error.message);
}

function toStep(row, serviceKey) {
  const template = SERVICE_BY_KEY.get(serviceKey)?.steps.find((step) => step.key === row.step_key);
  return {
    id: row.id,
    serviceId: row.service_id,
    tenantId: row.tenant_id,
    key: row.step_key,
    phase: row.phase,
    position: row.position,
    label: row.label,
    detail: row.detail,
    doneAt: row.done_at,
    doneBy: row.done_by,
    /* read from the catalog by key rather than stored: what the console can check
       is a property of this build of the console, not of the row. a step added by
       hand has no key and so no evidence. */
    evidence: template?.evidence ?? null,
  };
}

function byPhaseThenPosition(a, b) {
  return (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9) || a.position - b.position;
}

/* ── reads ─────────────────────────────────────────────────── */

/**
 * every build for every client, grouped by tenant.
 *
 * never throws for a missing migration: the roster has to load on a project
 * where 0008 has not run, so that comes back as `error` and each client's builds
 * as null, which the panel turns into the fix.
 */
export async function loadBuilds(supabase = getSupabase()) {
  const [services, steps] = await Promise.all([
    supabase
      .from('client_services')
      .select('id, tenant_id, service_key, name, created_at')
      .order('created_at', { ascending: true }),
    supabase
      .from('client_service_steps')
      .select('id, service_id, tenant_id, step_key, phase, position, label, detail, done_at, done_by')
      .order('position', { ascending: true }),
  ]);

  const failed = services.error ?? steps.error;
  if (failed) return { byTenant: null, error: buildsError(failed).message };

  const keyOf = new Map((services.data ?? []).map((row) => [row.id, row.service_key]));
  const stepsByService = new Map();
  for (const row of steps.data ?? []) {
    const step = toStep(row, keyOf.get(row.service_id));
    const bucket = stepsByService.get(step.serviceId);
    if (bucket) bucket.push(step);
    else stepsByService.set(step.serviceId, [step]);
  }

  const byTenant = new Map();
  for (const row of services.data ?? []) {
    const catalog = SERVICE_BY_KEY.get(row.service_key);
    const build = {
      id: row.id,
      tenantId: row.tenant_id,
      key: row.service_key,
      name: row.name,
      tag: catalog?.tag ?? null,
      needs: catalog?.needs ?? [],
      createdAt: row.created_at,
      steps: (stepsByService.get(row.id) ?? []).sort(byPhaseThenPosition),
    };
    const bucket = byTenant.get(build.tenantId);
    if (bucket) bucket.push(build);
    else byTenant.set(build.tenantId, [build]);
  }

  return { byTenant, error: null };
}

/* hangs each client's builds off the roster. `builds` is null — not an empty
   list — when they could not be read, because "this client bought nothing" and
   "the table is not there" want different things on screen. */
export function withBuilds(roster, { byTenant, error }) {
  return {
    ...roster,
    buildsError: error,
    clients: roster.clients.map((client) => ({
      ...client,
      builds: error ? null : byTenant.get(client.tenant.id) ?? [],
      buildsError: error,
    })),
  };
}

/* ── writes ────────────────────────────────────────────────── */

/**
 * adds services to a client, each with its catalog checklist, in one transaction
 * (add_client_services). a service the client already has is skipped and named.
 */
export async function addClientServices(tenantId, keys) {
  const services = keys
    .map((key) => SERVICE_BY_KEY.get(key))
    .filter(Boolean)
    .map((service) => ({
      key: service.key,
      name: service.name,
      steps: service.steps.map(({ key, phase, label, detail }) => ({ key, phase, label, detail })),
    }));

  if (services.length === 0) return { added: [], skipped: [] };

  const { data, error } = await getSupabase().rpc('add_client_services', {
    p_tenant: tenantId,
    p_services: services,
  });
  if (error) throw buildsError(error);
  return { added: data?.added ?? [], skipped: data?.skipped ?? [] };
}

/* the browser only says done or not done. the time and the operator are stamped
   by a trigger, so a tick cannot be backdated from a laptop with the wrong clock. */
export async function setStepDone(stepId, done) {
  const { error } = await getSupabase()
    .from('client_service_steps')
    .update({ done_at: done ? new Date().toISOString() : null })
    .eq('id', stepId);
  if (error) throw buildsError(error);
}

export async function addStep(build, { phase, label }) {
  const position =
    Math.max(-1, ...build.steps.filter((step) => step.phase === phase).map((step) => step.position)) + 1;
  const { error } = await getSupabase().from('client_service_steps').insert({
    service_id: build.id,
    tenant_id: build.tenantId,
    phase,
    position,
    label: label.trim(),
  });
  if (error) throw buildsError(error);
}

export async function removeStep(stepId) {
  const { error } = await getSupabase().from('client_service_steps').delete().eq('id', stepId);
  if (error) throw buildsError(error);
}

/* the steps go with it (on delete cascade). */
export async function removeService(buildId) {
  const { error } = await getSupabase().from('client_services').delete().eq('id', buildId);
  if (error) throw buildsError(error);
}

/* ── where a build stands ──────────────────────────────────── */

export const STAGE = {
  empty: { label: 'no checklist', tone: 'idle' },
  'not-started': { label: 'not started', tone: 'idle' },
  building: { label: 'building', tone: 'neutral' },
  integrating: { label: 'integrating', tone: 'neutral' },
  /* green because the checklist is finished, and only that. the pipeline check
     is what says it is working; the panel says so beside this pill. */
  delivered: { label: 'delivered', tone: 'ok' },
};

/**
 * one build's progress, read off its steps.
 *
 * building until every build step is ticked, then integrating until every step
 * is, then delivered. a ticked integrate step on a build that is not built yet
 * still reads as building: the order is the work's, not the boxes'.
 */
export function buildProgress(build, done = (step) => Boolean(step.doneAt)) {
  const phase = (key) => {
    const steps = build.steps.filter((step) => step.phase === key);
    return { total: steps.length, done: steps.filter(done).length };
  };
  const total = build.steps.length;
  const finished = build.steps.filter(done).length;
  const builtPhase = phase('build');

  const stage =
    total === 0
      ? 'empty'
      : finished === total
        ? 'delivered'
        : finished === 0
          ? 'not-started'
          : builtPhase.done === builtPhase.total
            ? 'integrating'
            : 'building';

  return {
    total,
    done: finished,
    build: builtPhase,
    integrate: phase('integrate'),
    stage,
    deliveredAt:
      stage === 'delivered'
        ? build.steps
            .map((step) => step.doneAt)
            .filter(Boolean)
            .sort()
            .pop() ?? null
        : null,
  };
}

/* the whole client, for a roster cell: how many services, how many delivered,
   how many steps are left across all of them. */
export function buildsSummary(builds) {
  if (!builds) return null;
  const progress = builds.map((build) => buildProgress(build));
  return {
    services: builds.length,
    delivered: progress.filter((entry) => entry.stage === 'delivered').length,
    steps: progress.reduce((sum, entry) => sum + entry.total, 0),
    done: progress.reduce((sum, entry) => sum + entry.done, 0),
  };
}

/* ── what the console can see for itself ───────────────────── */

/**
 * what the evidence says about one step, or null when there is nothing to check.
 *
 * `met` is whether the thing the step describes can be seen: a token n8n has
 * posted with, a lead in the log, an account recorded as connected. it is shown
 * beside the tick, never instead of it — the operator still ticks the box, and a
 * box ticked against evidence that says otherwise is the row worth reading.
 *
 * an account "recorded as connected" is itself something somebody typed, and the
 * wording says so. only n8n can be proved from the log, because every event
 * arrives from an n8n workflow.
 */
export function stepEvidence(step, client) {
  if (!step.evidence || !client) return null;
  const zone = client.tenant.timezone;
  const [kind, arg] = step.evidence.split(':');

  if (kind === 'account') {
    const integration = INTEGRATION_BY_KEY.get(arg);
    if (!integration) return null;
    const observed = observedFor(integration, client.workflowActivity);
    if (observed) {
      return { met: true, detail: `${integration.name} is sending · last event ${formatRelative(observed.lastAt, zone)}` };
    }
    const best = connectionsFor(integration, client.connections ?? [])[0];
    if (best?.status === 'connected') return { met: true, detail: `${integration.name} recorded as connected` };
    if (best) return { met: false, detail: `${integration.name} is recorded as ${best.status}` };
    return { met: false, detail: `no ${integration.name} account recorded under services & subscriptions` };
  }

  if (kind === 'token') {
    const tokens = client.tokens;
    if (!tokens) return null;
    if (tokens.active > 0 && tokens.lastUsedAt) {
      return { met: true, detail: `n8n last posted with their token ${formatRelative(tokens.lastUsedAt, zone)}` };
    }
    if (tokens.active > 0) return { met: false, detail: 'a token is minted, but n8n has never posted with it' };
    return { met: false, detail: tokens.total > 0 ? 'every ingest token is revoked' : 'no ingest token minted yet' };
  }

  if (kind === 'events') {
    return client.lastEventAt
      ? { met: true, detail: `last event ${formatRelative(client.lastEventAt, zone)}` }
      : { met: false, detail: 'no event has arrived in the loaded window' };
  }

  const metrics = client.data?.metrics;

  if (kind === 'leads' && metrics) {
    const leads = metrics.leadsLast30Days ?? 0;
    return leads > 0
      ? { met: true, detail: `${formatCount(leads)} lead${leads === 1 ? '' : 's'} in the last 30 days` }
      : { met: false, detail: 'no lead in the last 30 days' };
  }

  if (kind === 'missed' && metrics) {
    const answered = metrics.missedCallsAnswered ?? 0;
    return answered > 0
      ? { met: true, detail: `${formatCount(answered)} missed call${answered === 1 ? '' : 's'} answered in the last 30 days` }
      : { met: false, detail: 'no missed call answered in the last 30 days' };
  }

  if (kind === 'canary' && client.data?.status) {
    const status = client.data.status;
    if (status.status === 'unchecked') return { met: false, detail: 'no end-to-end check has run for this client' };
    return {
      met: true,
      detail:
        status.status === 'operational'
          ? `end-to-end check passing · last ran ${formatRelative(status.lastCheckedAt, zone)}`
          : `end-to-end check running · last result ${status.status}`,
    };
  }

  return null;
}

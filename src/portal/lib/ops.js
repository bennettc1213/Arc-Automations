import { DateTime } from 'luxon';
import { getSupabase, isConfigured, functionUrl, anonKey } from './supabase';
import { buildDashboardData } from './dashboard-data';
import { readEvents, toEvent } from './event-row';
import { generateIngestToken, sha256Hex, generateClientId } from './client-id';
import { formatSpan } from './format';
import { loadBuilds, withBuilds } from './builds';

/* the ops console's data layer.
 *
 * one rule governs this file, and it is the same rule the client portal is built
 * on: every number Ben reads about a client is computed by the code that computes
 * the number the client reads. the roster does not have its own idea of "leads in
 * the last 30 days" — it runs buildDashboardData per tenant over the same event
 * window, so a figure in the console and the figure in that client's dashboard
 * cannot disagree. a second derivation path would be a second answer, and being
 * told two different numbers by your own product is how you stop trusting it.
 *
 * scoping is still the database's job. these reads carry the anon key and Ben's
 * own session; they return every tenant because migration 0003 added
 * `or is_arc_admin()` to the select policies, not because this file remembered to
 * ask for all of them.
 */

const WINDOW_DAYS = 61;
const PAGE_SIZE = 1000;

/* the console fetches every tenant's window in one pass, so the ceiling is the
   whole book of business rather than one client. past this, the roster wants a
   sql rollup rather than a bigger fetch — and it must say so out loud instead of
   quietly rendering a truncated month. */
const MAX_EVENTS = 200_000;

/* how much of the cross-client tail the activity page keeps. it is a tail, not an
   archive — the full log for one client is on that client's own activity page,
   scoped and paged. */
const RECENT_EVENTS = 600;

export class TruncatedWindow extends Error {
  constructor() {
    super(
      `more than ${MAX_EVENTS.toLocaleString('en-US')} events in the window — the roster ` +
        'needs a sql rollup before it can be trusted at this size.',
    );
    this.name = 'TruncatedWindow';
  }
}

export function toTenant(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    slug: row.slug,
    company: row.company,
    timezone: row.timezone,
    status: row.status,
    plan: row.plan,
    notes: row.notes,
    loginEmail: row.login_email,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    createdAt: row.created_at,
    onboardedAt: row.onboarded_at,
    /* 0007: when and why a client was deboarded. null on every row until that
       migration is applied, and on every client still on the books after it. */
    archivedAt: row.archived_at ?? null,
    archiveReason: row.archive_reason ?? null,
    archiveNote: row.archive_note ?? null,
  };
}

export function toConnection(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    label: row.label,
    endpoint: row.endpoint,
    status: row.status,
    workflowId: row.workflow_id,
    /* the backstop and ceiling for the staleness check. null until migration
       0004 is applied, and connectionLiveness treats null as the old 48. */
    expectedQuietHours: row.expected_quiet_hours ?? null,
    notes: row.notes,
    /* 0006: the account behind the wiring, and what it costs. every one reads
       as unset until that migration is applied. */
    provider: row.provider ?? null,
    accountRef: row.account_ref ?? null,
    credentialHint: row.credential_hint ?? null,
    credentialLocation: row.credential_location ?? null,
    verifiedAt: row.verified_at ?? null,
    billingStatus: row.billing_status ?? 'none',
    paidBy: row.paid_by ?? null,
    costCents: row.cost_cents ?? null,
    billingCycle: row.billing_cycle ?? null,
    renewsAt: row.renews_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toToken(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/* every column rather than a list. a list naming 0007's archive columns would
   take the whole roster down on a project where that migration has not run yet,
   and toTenant already reads each newer column as null when it is absent. */
const TENANT_COLUMNS = '*';

/* ── who is asking ─────────────────────────────────────────── */

/**
 * signed in, and an arc admin?
 *
 * two separate facts with two separate answers on screen, which is why they are
 * two fields rather than one boolean. "you are not signed in" and "you are signed
 * in as somebody who is not an admin" want different buttons underneath them, and
 * collapsing them produces the worst screen in any admin tool: a login form shown
 * to somebody who is already logged in.
 */
export async function getOpsSession() {
  if (!isConfigured) return { configured: false, signedIn: false, isAdmin: false, email: null };

  const supabase = getSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { configured: true, signedIn: false, isAdmin: false, email: null };

  /* asks postgres rather than reading a claim, so revoking admin takes effect on
     the next query instead of whenever the current token happens to expire. */
  const { data, error } = await supabase.rpc('is_arc_admin');

  return {
    configured: true,
    signedIn: true,
    /* an error here is treated as "not an admin". the failure mode of guessing
       the other way is a console that renders every client's data to whoever
       triggered the error. */
    isAdmin: !error && data === true,
    email: user.email ?? null,
    userId: user.id,
    /* surfaced rather than swallowed: the overwhelmingly likely cause is that
       migration 0003 has not been applied, and that is worth saying. */
    checkFailed: Boolean(error),
    checkError: error?.message ?? null,
  };
}

/* ── the roster ────────────────────────────────────────────── */

async function fetchAllEvents(supabase, since) {
  const events = [];

  for (let from = 0; from < MAX_EVENTS; from += PAGE_SIZE) {
    const { data, error } = await readEvents((columns) =>
      supabase
        .from('events')
        /* tenant_id is already in the column set, which is what makes one pass over
           the whole book possible instead of one query per client. */
        .select(columns)
        .gte('occurred_at', since)
        .order('occurred_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
    );

    if (error) throw new Error(`event read: ${error.message}`);

    const rows = data ?? [];
    events.push(...rows.map(toEvent));
    if (rows.length < PAGE_SIZE) return events;
  }

  throw new TruncatedWindow();
}

/**
 * every client, with their real dashboard hanging off each one.
 *
 * the events are fetched once for the whole book and then grouped, rather than
 * queried per tenant. with ten clients that is one round trip instead of ten, and
 * more importantly it is one window: two tenants read a second apart would
 * otherwise be measured over two slightly different thirty-day spans, and the
 * roster totals would not add up to the sum of its rows.
 */
export async function loadRoster() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('supabase is not configured');

  const since = DateTime.now().minus({ days: WINDOW_DAYS }).toUTC().toISO();

  const [
    { data: tenantRows, error: tenantError },
    { data: connectionRows },
    { data: alertRows },
    { data: tokenRows },
    builds,
  ] = await Promise.all([
    supabase.from('tenants').select(TENANT_COLUMNS).order('created_at', { ascending: true }),
    supabase.from('connections').select('*').order('created_at', { ascending: true }),
    supabase
      .from('alerts')
      .select('id, tenant_id, check_type, severity, message, fired_at, acknowledged_at, resolved_at')
      .gte('fired_at', since)
      .order('fired_at', { ascending: false })
      .limit(500),
    /* only whether each client holds a usable token and when n8n last used one.
       it is what the pipeline verdict falls back on when the live check cannot
       run, and it never includes the hash. */
    supabase.from('ingest_tokens').select('tenant_id, revoked_at, last_used_at'),
    /* the services each client bought and their checklists (0008). a project
       without that migration still loads — every client's builds are null. */
    loadBuilds(supabase),
  ]);

  if (tenantError) throw new Error(`tenant read: ${tenantError.message}`);

  const events = await fetchAllEvents(supabase, since);

  const byTenant = new Map();
  for (const event of events) {
    const bucket = byTenant.get(event.tenantId);
    if (bucket) bucket.push(event);
    else byTenant.set(event.tenantId, [event]);
  }

  const alertsByTenant = new Map();
  for (const row of alertRows ?? []) {
    const alert = {
      id: row.id,
      tenantId: row.tenant_id,
      checkType: row.check_type,
      severity: row.severity,
      message: row.message,
      firedAt: row.fired_at,
      acknowledgedAt: row.acknowledged_at,
      resolvedAt: row.resolved_at,
    };
    const bucket = alertsByTenant.get(alert.tenantId);
    if (bucket) bucket.push(alert);
    else alertsByTenant.set(alert.tenantId, [alert]);
  }

  const connections = (connectionRows ?? []).map(toConnection);

  const clients = (tenantRows ?? []).map((row) => {
    const tenant = toTenant(row);
    const own = byTenant.get(tenant.id) ?? [];
    const now = DateTime.now().setZone(tenant.timezone);

    return {
      tenant,
      /* the identical object the client sees behind their own sign-in. every
         figure the console prints about this client is read off it. */
      data: buildDashboardData(tenant, own, now, alertsByTenant.get(tenant.id) ?? []),
      connections: connections.filter((c) => c.tenantId === tenant.id),
      /* rolled up here, once, so no page has to hold this client's raw events to
         decide whether a declared connection is still sending. */
      workflowActivity: workflowActivity(own),
      /* the same roll-up for the pipeline as a whole: how long this client is
         normally quiet, so "no events for 20 hours" can be judged against them
         rather than against a constant. */
      typicalQuietHours: p90GapHours(own.map((event) => event.occurredAt)),
      tokens: tokenFacts((tokenRows ?? []).filter((row) => row.tenant_id === tenant.id)),
      eventCount: own.length,
      lastEventAt: own.length ? own[0].occurredAt : null,
    };
  });

  /* a bounded cross-client tail for the activity page. events came back newest
     first, so this is a slice rather than a sort — and it is capped because the
     page is a tail, not an archive. anyone who needs the whole log has the
     client's own activity page, which is scoped and paged. */
  const names = new Map(clients.map((client) => [client.tenant.id, client.tenant]));
  const recentEvents = events.slice(0, RECENT_EVENTS).map((event) => ({
    ...event,
    tenantName: names.get(event.tenantId)?.name ?? 'unknown account',
    tenantTimezone: names.get(event.tenantId)?.timezone ?? 'UTC',
  }));

  return withBuilds(
    {
      clients,
      recentEvents,
      totalEvents: events.length,
      generatedAt: DateTime.now().toISO(),
      windowDays: WINDOW_DAYS,
    },
    builds,
  );
}

/**
 * the book of business as one line.
 *
 * summed from the per-client dashboards rather than recomputed from the raw
 * events, for the reason at the top of this file: a total that is not the sum of
 * the rows underneath it is a bug the reader finds before you do.
 *
 * the median across clients is a median of medians and is labelled as one
 * everywhere it appears. it is not the median response time across every lead in
 * the book, and printing it as though it were would be exactly the quiet
 * wrongness this product exists to rule out.
 */
export function rosterTotals(clients, past = []) {
  const live = clients.filter((c) => c.tenant.status === 'active');
  const verdicts = clients.map((c) => c.pipeline?.state).filter(Boolean);
  const responders = live
    .map((c) => c.data.metrics.medianResponseMs)
    .filter((ms) => ms !== null && ms !== undefined)
    .sort((a, b) => a - b);

  return {
    clients: clients.length,
    active: live.length,
    onboarding: clients.filter((c) => c.tenant.status === 'onboarding').length,
    paused: clients.filter((c) => c.tenant.status === 'paused').length,
    archived: past.length,
    leads: clients.reduce((sum, c) => sum + (c.data.metrics.leadsLast30Days ?? 0), 0),
    leadsThisMonth: clients.reduce((sum, c) => sum + (c.data.metrics.leadsThisMonth ?? 0), 0),
    answered: clients.reduce((sum, c) => sum + (c.data.metrics.missedCallsAnswered ?? 0), 0),
    sends: clients.reduce((sum, c) => sum + (c.data.metrics.sends ?? 0), 0),
    /* failing or degraded end-to-end checks. a client that has never run one is
       not counted here: nothing was measured, so nothing is down. */
    degraded: clients.filter((c) => ['failed', 'degraded'].includes(c.data.status.status)).length,
    /* the live pipeline verdicts, once they are in. */
    connected: verdicts.filter((state) => state === 'connected').length,
    partial: verdicts.filter((state) => state === 'partial').length,
    disconnected: verdicts.filter((state) => state === 'disconnected').length,
    unwired: verdicts.filter((state) => state === 'unwired').length,
    openIncidents: clients.reduce(
      (sum, c) => sum + c.data.incidents.filter((incident) => incident.open).length,
      0,
    ),
    connections: clients.reduce((sum, c) => sum + c.connections.length, 0),
    medianOfMedians: responders.length
      ? responders[Math.floor((responders.length - 1) / 2)]
      : null,
    silent: clients.filter((c) => c.tenant.status === 'active' && c.eventCount === 0).length,
    unlinked: clients.filter((c) => !c.tenant.loginEmail).length,
  };
}

/* ── writes ────────────────────────────────────────────────── */

/**
 * a new client.
 *
 * the ID is generated in the browser so it can be shown, regenerated and read
 * aloud before anything is written — an ID that only exists after a successful
 * insert cannot be part of the conversation you are having while you fill this
 * form in. the unique index is still what guarantees it: a collision comes back
 * as 23505 and is retried with a fresh one rather than being silently accepted.
 */
export async function createClient(fields) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('supabase is not configured');

  const row = {
    client_id: fields.clientId ?? generateClientId(),
    name: fields.name,
    slug: fields.slug,
    company: fields.company || null,
    timezone: fields.timezone,
    status: fields.status ?? 'onboarding',
    plan: fields.plan || null,
    notes: fields.notes || null,
    login_email: fields.loginEmail || null,
    contact_name: fields.contactName || null,
    contact_phone: fields.contactPhone || null,
    onboarded_at: fields.status === 'active' ? new Date().toISOString() : null,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from('tenants')
      .insert(attempt === 0 ? row : { ...row, client_id: generateClientId() })
      .select(TENANT_COLUMNS)
      .single();

    if (!error) return toTenant(data);

    /* 23505 on client_id: astronomically unlikely at 40 bits and handled anyway,
       because "unlikely" is not "impossible" and the alternative is an error
       message nobody can act on. any other 23505 is the slug, which is the
       operator's to fix. */
    const isIdCollision = error.code === '23505' && error.message.includes('client_id');
    if (!isIdCollision) throw new Error(error.message);
  }

  throw new Error('could not allocate a client id');
}

export async function updateClient(tenantId, patch) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .update(patch)
    .eq('id', tenantId)
    .select(TENANT_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return toTenant(data);
}

/** re-rolls a client's ID. the old one stops working the moment this returns. */
export async function reissueClientId(tenantId) {
  return updateClient(tenantId, { client_id: generateClientId() });
}

export async function isClientIdTaken(clientId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('tenants')
    .select('id')
    .eq('client_id', clientId)
    .limit(1);

  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/* ── ingest tokens ─────────────────────────────────────────── */

export async function listTokens(tenantId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ingest_tokens')
    .select('id, tenant_id, label, created_at, last_used_at, revoked_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map(toToken);
}

/**
 * mints a pipeline token and returns the raw value exactly once.
 *
 * the hashing happens here, in the browser, with the same SHA-256 the ingest
 * function uses to look it up. nothing but the digest is ever sent, so the
 * database never holds anything replayable — which is the reason the caller has
 * to deal with a value it can only show once, and why this returns it rather
 * than storing it somewhere convenient.
 */
export async function mintToken(tenantId, label) {
  const supabase = getSupabase();
  const raw = generateIngestToken();
  const tokenHash = await sha256Hex(raw);

  const { data, error } = await supabase
    .from('ingest_tokens')
    .insert({ tenant_id: tenantId, token_hash: tokenHash, label: label || 'n8n' })
    .select('id, tenant_id, label, created_at, last_used_at, revoked_at')
    .single();

  if (error) throw new Error(error.message);
  return { token: toToken(data), raw };
}

export async function revokeToken(tokenId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('ingest_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId);

  if (error) throw new Error(error.message);
}

/* ── connections ───────────────────────────────────────────── */

export const CONNECTION_KINDS = [
  { value: 'n8n', label: 'n8n instance' },
  { value: 'twilio', label: 'twilio number' },
  { value: 'gohighlevel', label: 'gohighlevel' },
  { value: 'webhook', label: 'webhook' },
  { value: 'crm', label: 'crm' },
  { value: 'calendar', label: 'calendar' },
  { value: 'database', label: 'database' },
  { value: 'ai', label: 'ai model' },
  { value: 'messaging', label: 'messaging' },
  { value: 'email', label: 'email' },
  { value: 'payments', label: 'payments' },
  { value: 'other', label: 'other' },
];

const BILLING_COLUMNS = [
  'provider',
  'account_ref',
  'credential_hint',
  'credential_location',
  'verified_at',
  'billing_status',
  'paid_by',
  'cost_cents',
  'billing_cycle',
  'renews_at',
];

/* postgrest names the column it could not find. when it is one of 0006's, the
   fix is a migration, and the message should say which one. */
function connectionWriteError(error) {
  const missing = BILLING_COLUMNS.find(
    (column) => error.message.includes(`'${column}'`) || error.message.includes(`"${column}"`),
  );
  return new Error(
    missing
      ? `the connections table has no ${missing} column — apply supabase/migrations/0006_connection_billing.sql`
      : error.message,
  );
}

export async function saveConnection(connection) {
  const supabase = getSupabase();
  const row = {
    tenant_id: connection.tenantId,
    kind: connection.kind,
    label: connection.label,
    endpoint: connection.endpoint || null,
    status: connection.status,
    workflow_id: connection.workflowId || null,
    expected_quiet_hours: connection.expectedQuietHours || null,
    notes: connection.notes || null,
    provider: connection.provider || null,
    account_ref: connection.accountRef || null,
    credential_hint: connection.credentialHint || null,
    credential_location: connection.credentialLocation || null,
    verified_at: connection.verifiedAt || null,
    billing_status: connection.billingStatus || 'none',
    paid_by: connection.paidBy || null,
    cost_cents: connection.costCents ?? null,
    billing_cycle: connection.billingCycle || null,
    renews_at: connection.renewsAt || null,
    updated_at: new Date().toISOString(),
  };

  const query = connection.id
    ? supabase.from('connections').update(row).eq('id', connection.id)
    : supabase.from('connections').insert(row);

  const { data, error } = await query.select('*').single();
  if (error) throw connectionWriteError(error);
  return toConnection(data);
}

/* the two one-click writes on a subscription row: "i just checked the key works"
   and "this renewal was paid". partial updates, so they cannot clobber an edit
   somebody else saved a minute ago. */
export async function patchConnection(id, patch) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('connections')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw connectionWriteError(error);
  return toConnection(data);
}

export async function deleteConnection(id) {
  const supabase = getSupabase();
  const { error } = await supabase.from('connections').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * what each workflow id has actually done, rolled up once per client.
 *
 * a map rather than the raw events, because the only question asked of it is
 * "has this thing run, when, and did it fail" — and keeping sixty days of every
 * client's events alive in component state to answer that would be holding the
 * whole log in memory to render a status pill.
 */
export function workflowActivity(events) {
  const activity = new Map();

  for (const event of events) {
    if (!event.workflowId) continue;
    const row = activity.get(event.workflowId) ?? {
      runs: 0,
      failed: 0,
      lastAt: null,
      /* every timestamp this workflow wrote, kept only long enough to derive the
         gap distribution below and then dropped. it never leaves this module. */
      stamps: [],
    };
    row.runs += 1;
    if (event.status === 'failure') row.failed += 1;
    if (row.lastAt === null || event.occurredAt > row.lastAt) row.lastAt = event.occurredAt;
    row.stamps.push(event.occurredAt);
    activity.set(event.workflowId, row);
  }

  /* collapse the stamps into the one number the liveness check needs: how long
     this workflow's own longest ordinary quiet stretch is. p90 rather than the
     maximum, so a single freak gap — a deploy, a holiday — does not permanently
     raise the bar and blind the check. */
  for (const row of activity.values()) {
    row.typicalQuietHours = p90GapHours(row.stamps);
    delete row.stamps;
  }

  return activity;
}

function p90GapHours(stamps) {
  if (!stamps || stamps.length < 8) return null; // too few to describe a cadence
  const sorted = stamps.slice().sort();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(
      DateTime.fromISO(sorted[i], { zone: 'utc' }).diff(
        DateTime.fromISO(sorted[i - 1], { zone: 'utc' }),
        'hours',
      ).hours,
    );
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.min(gaps.length - 1, Math.ceil(0.9 * gaps.length) - 1)] ?? null;
}

/**
 * a declared connection, checked against the event log.
 *
 * `status` is what Ben typed. `liveness` is what the pipeline has actually done,
 * and the two are shown side by side everywhere because the gap between them is
 * the whole point of the page: a connection marked "connected" that has not
 * produced an event in nine days is the single most useful row in the console.
 *
 * a connection with no workflow_id cannot be matched to events at all, and says
 * so rather than borrowing the tenant's overall activity and calling it proof.
 */
/* however chatty a workflow is, nothing is called stale before this. a canary on a
   five-minute cadence would otherwise flag on a twenty-minute blip. */
const MIN_STALE_HOURS = 6;

/* the one definition of "too quiet", shared by a single connection and by a
   client's pipeline as a whole: twice the observed p90 gap, floored so a chatty
   workflow is not flagged on a blip, and capped by what a human declared. */
function staleThreshold(typicalQuietHours, declaredHours) {
  return typicalQuietHours === null || typicalQuietHours === undefined
    ? declaredHours
    : Math.min(declaredHours, Math.max(MIN_STALE_HOURS, typicalQuietHours * 2));
}

export function connectionLiveness(connection, activity, now = DateTime.now()) {
  if (!connection.workflowId) {
    return { state: 'unmatched', lastAt: null, runs: 0, failed: 0, label: 'no workflow id' };
  }

  const row = activity?.get?.(connection.workflowId);
  if (!row) {
    return { state: 'silent', lastAt: null, runs: 0, failed: 0, label: 'never seen' };
  }

  const hours = now.diff(DateTime.fromISO(row.lastAt, { zone: 'utc' }), 'hours').hours;

  /* the threshold is the client's own normal, not a constant.
     a flat 48 hours was wrong in both directions at once. for a plumbing
     contractor whose speed-to-lead can genuinely sleep through a quiet weekend,
     24 would cry "down" every monday morning — and a console that does that is
     one Ben stops reading. but restoration is 24/7 emergency work: a shop taking
     four leads a day that goes silent gets found on day three, and those are
     exactly the jobs that pay.
     so: flag at twice this workflow's own p90 quiet stretch. a workflow that
     normally rests ten hours overnight is stale at twenty; one that legitimately
     rests two days is not. `expected_quiet_hours` on the connection is the
     backstop, used while there is too little history to describe a cadence, and
     the ceiling, so a per-client override always wins. */
  const threshold = staleThreshold(row.typicalQuietHours, connection.expectedQuietHours ?? 48);

  const state = hours > threshold ? 'stale' : row.failed > 0 ? 'flaky' : 'live';

  return {
    state,
    lastAt: row.lastAt,
    runs: row.runs,
    failed: row.failed,
    thresholdHours: threshold,
    typicalQuietHours: row.typicalQuietHours,
    /* below a day, say it in hours. "quiet 1d" for something nineteen hours late
       on a six-hour cadence understates it and reads as rounding. */
    label:
      state === 'live'
        ? 'live'
        : state === 'flaky'
          ? `${row.failed} failed`
          : hours < 48
            ? `quiet ${Math.max(1, Math.round(hours))}h`
            : `quiet ${Math.round(hours / 24)}d`,
  };
}

/* ── is the pipeline actually connected ────────────────────── */

function tokenFacts(rows) {
  const live = rows.filter((row) => !row.revoked_at);
  return {
    active: live.length,
    total: rows.length,
    lastUsedAt:
      live
        .map((row) => row.last_used_at)
        .filter(Boolean)
        .sort()
        .pop() ?? null,
  };
}

function hoursSince(iso, now) {
  return now.diff(DateTime.fromISO(iso, { zone: 'utc' }), 'hours').hours;
}

function ago(iso, now) {
  return `${formatSpan(now.diff(DateTime.fromISO(iso, { zone: 'utc' })).milliseconds).replace(/ 0h$/, '')} ago`;
}

/* when several things are wrong, the reason printed on the pill is the cause
   rather than the symptom: a switched-off workflow explains the silence, so it
   is named ahead of "no events for three days". */
const CAUSE_RANK = ['ingest', 'token', 'instance', 'wf', 'canary', 'events'];
const causeRank = (check) => {
  const index = CAUSE_RANK.indexOf(check.key.split(':')[0]);
  return index === -1 ? CAUSE_RANK.length : index;
};

/* a workflow that was switched off more than this long after it last sent
   anything reads as retired on purpose rather than as broken. */
const RECENTLY_SENDING_HOURS = 24 * 7;

const VERDICT_WORD = {
  connected: 'connected',
  partial: 'partly connected',
  disconnected: 'not connected',
  unwired: 'not set up',
  checking: 'checking…',
};

/**
 * what a client's pipeline adds up to, from the checks that could be made.
 *
 * `live` is this client's slice of the probe-pipelines response — facts the ops
 * function fetched from ingest, n8n and the database moments ago. without it
 * (the function is not deployed yet, or has not answered) the same checks are
 * made from the roster's own copy of the event log and tokens, and the verdict
 * says which it came from. both paths go through this function, so the pill on
 * the roster and the checklist on the client page can never disagree.
 *
 * the rule the whole thing exists to enforce: green only on evidence. every
 * "connected" is a token n8n is using, an event that arrived inside this
 * client's normal quiet stretch, and — when n8n could be asked — workflows that
 * are switched on. a client with nothing wired is "not set up", never green.
 */
export function pipelineVerdict(client, probe, now = DateTime.now()) {
  const live = probe?.tenants?.[client.tenant.id] ?? null;
  const checks = [];

  const tokens = live
    ? { active: live.tokens.active, total: live.tokens.total, lastUsedAt: live.tokens.last_used_at }
    : client.tokens ?? null;
  const lastEventAt = live ? live.last_event?.at ?? null : client.lastEventAt;

  const wired = client.connections.filter((c) => c.status !== 'retired');
  /* the tightest declared quiet stretch wins: if one connection is never meant to
     go twelve hours without sending, the pipeline as a whole cannot either. */
  const declared = wired.map((c) => c.expectedQuietHours).filter((hours) => hours > 0);
  const threshold = staleThreshold(client.typicalQuietHours, declared.length ? Math.min(...declared) : 48);

  /* nothing to connect yet: no token ever minted, nothing declared, nothing ever
     received. that is onboarding, and saying "not connected" in red about it
     would train the operator to ignore red. */
  if ((tokens?.total ?? 0) === 0 && wired.length === 0 && !lastEventAt) {
    return {
      state: 'unwired',
      word: VERDICT_WORD.unwired,
      summary: 'no token, no connection and no event yet',
      checks: [
        {
          key: 'setup',
          label: 'setup',
          tone: 'idle',
          detail: 'mint an ingest token and add the n8n connection on the client page',
        },
      ],
      evidence: live ? 'live' : 'events',
      threshold,
    };
  }

  // the door every event comes through. one answer for the whole book.
  if (probe?.ingest) {
    checks.push({
      key: 'ingest',
      label: 'ingest endpoint',
      tone: probe.ingest.ok ? 'ok' : 'fail',
      critical: true,
      detail: probe.ingest.ok ? `up · answered in ${probe.ingest.ms}ms` : probe.ingest.detail ?? 'not answering',
    });
  }

  if (tokens) {
    const stale = tokens.lastUsedAt && hoursSince(tokens.lastUsedAt, now) > threshold;
    checks.push({
      key: 'token',
      label: 'ingest token',
      tone: tokens.active === 0 ? 'fail' : !tokens.lastUsedAt ? 'warn' : stale ? 'warn' : 'ok',
      critical: tokens.active === 0,
      detail:
        tokens.active === 0
          ? tokens.total > 0
            ? `${tokens.total === 1 ? 'its only token is' : `all ${tokens.total} are`} revoked — n8n has nothing it can post with`
            : 'none minted — n8n has nothing it can post with'
          : !tokens.lastUsedAt
            ? `${tokens.active} active, never used by n8n`
            : `${tokens.active} active · last used ${ago(tokens.lastUsedAt, now)}`,
    });
  }

  if (!lastEventAt) {
    checks.push({
      key: 'events',
      label: 'last event',
      tone: 'fail',
      critical: true,
      detail: live ? 'nothing has ever arrived' : 'nothing in the last 61 days',
    });
  } else {
    const hours = hoursSince(lastEventAt, now);
    checks.push({
      key: 'events',
      label: 'last event',
      tone: hours > threshold ? 'fail' : 'ok',
      critical: hours > threshold,
      detail:
        hours > threshold
          ? `${ago(lastEventAt, now)} — longer than this client is ever normally quiet (${Math.round(threshold)}h)`
          : `${ago(lastEventAt, now)}`,
    });
  }

  const canary = client.data.status;
  if (canary.status !== 'unchecked') {
    checks.push({
      key: 'canary',
      label: 'end-to-end check',
      tone: canary.status === 'failed' ? 'fail' : canary.status === 'degraded' ? 'warn' : 'ok',
      critical: canary.status === 'failed',
      detail:
        canary.status === 'failed'
          ? canary.detail ?? 'the last check did not come out the far end'
          : canary.status === 'degraded'
            ? 'a recent check failed and the next one passed'
            : `passing · last ran ${ago(canary.lastCheckedAt, now)}`,
    });
  }

  for (const instance of live?.instances ?? []) {
    checks.push({
      key: `instance:${instance.origin}`,
      label: `n8n · ${new URL(instance.origin).host}`,
      tone: instance.ok ? 'ok' : 'fail',
      critical: !instance.ok,
      detail: instance.ok ? `answering /healthz · ${instance.ms}ms` : instance.detail ?? 'not answering',
    });
  }

  if (live) {
    const unknown = [];
    const found = [];

    for (const wf of live.workflows) {
      if (wf.found !== true) {
        unknown.push(wf);
        continue;
      }
      found.push(wf);
      const seen = client.workflowActivity.get(wf.id);
      const declared = wired.some((c) => c.workflowId === wf.id && c.status === 'connected');
      const recentlySending = seen?.lastAt && hoursSince(seen.lastAt, now) < RECENTLY_SENDING_HOURS;
      const name = wf.name ?? wf.id;

      if (!wf.active) {
        const matters = declared || recentlySending;
        checks.push({
          key: `wf:${wf.id}`,
          label: name,
          tone: matters ? 'fail' : 'idle',
          workflow: true,
          off: matters,
          detail: matters
            ? 'switched off in n8n — it will not run'
            : `switched off${seen?.lastAt ? ` · last sent ${ago(seen.lastAt, now)}` : ''}, likely retired`,
        });
        continue;
      }

      const failedRun = wf.last_run && !['success', 'running', 'waiting', 'new'].includes(wf.last_run.status);
      checks.push({
        key: `wf:${wf.id}`,
        label: name,
        tone: failedRun ? 'warn' : 'ok',
        workflow: true,
        on: true,
        detail: !wf.last_run
          ? 'on · no executions yet'
          : failedRun
            ? `on · last run ${wf.last_run.status} ${ago(wf.last_run.at, now)}`
            : `on · last run ${ago(wf.last_run.at, now)}`,
      });
    }

    /* every workflow that matters is off, and none is on: nothing can run. */
    const off = checks.filter((check) => check.off).length;
    if (off > 0 && !checks.some((check) => check.on)) {
      checks.find((check) => check.off).critical = true;
    }

    if (unknown.length > 0) {
      checks.push({
        key: 'wf:unknown',
        label: `${unknown.length} workflow id${unknown.length === 1 ? '' : 's'}`,
        tone: 'idle',
        detail:
          unknown[0].found === null
            ? `n8n could not be asked — ${probe?.n8n?.api?.detail ?? 'no api access'}`
            : `not on ${probe?.n8n?.host ?? 'arc’s n8n'} — ${unknown.map((wf) => wf.id).join(', ')}`,
      });
    }
  } else {
    /* no live answer: judge each declared workflow by its own events instead,
       which is what the connections page has always done. */
    for (const connection of wired) {
      if (!connection.workflowId) continue;
      const liveness = connectionLiveness(connection, client.workflowActivity, now);
      checks.push({
        key: `wf:${connection.workflowId}`,
        label: connection.label,
        tone: { live: 'ok', flaky: 'warn', stale: 'fail', silent: 'warn' }[liveness.state] ?? 'idle',
        detail: `${liveness.label} (from the event log)`,
      });
    }
  }

  const failing = checks.filter((check) => check.tone === 'fail');
  const warning = checks.filter((check) => check.tone === 'warn');

  const state = failing.some((check) => check.critical)
    ? 'disconnected'
    : failing.length > 0 || warning.length > 0
      ? 'partial'
      : 'connected';

  const byCause = (a, b) => causeRank(a) - causeRank(b);
  const lead =
    [...failing.filter((check) => check.critical)].sort(byCause)[0] ??
    [...failing].sort(byCause)[0] ??
    [...warning].sort(byCause)[0];

  return {
    state,
    word: VERDICT_WORD[state],
    summary: lead ? `${lead.label}: ${lead.detail}` : 'every check passed',
    checks,
    evidence: live ? 'live' : 'events',
    threshold,
  };
}

/** the verdict to show while the first live check is still out. */
export function checkingVerdict() {
  return { state: 'checking', word: VERDICT_WORD.checking, summary: 'asking ingest and n8n', checks: [], evidence: null };
}

/**
 * the live check for every client in one call.
 *
 * the workflow ids sent are the ones each client's events carry; the function
 * adds the ones declared on connections itself. an old deployment answers
 * "unknown action", which is turned into the fix rather than passed through.
 */
export async function probePipelines(clients) {
  try {
    return await callOps({
      action: 'probe-pipelines',
      tenants: clients.map((client) => ({
        tenant_id: client.tenant.id,
        workflow_ids: [...client.workflowActivity.keys()],
      })),
    });
  } catch (error) {
    throw staleDeploy(error, 'the live check');
  }
}

function staleDeploy(error, what) {
  return /unknown action/i.test(error.message)
    ? new Error(`the deployed ops function predates ${what} — run: supabase functions deploy ops`)
    : error;
}

/* ── deboarding ────────────────────────────────────────────── */

export const DEBOARD_REASONS = [
  'contract ended',
  'moved to another provider',
  'business closed or sold',
  'non-payment',
  'paused indefinitely',
  'other',
];

/**
 * takes a client out of the system: tokens revoked, access removed, connections
 * retired, tenant archived — one transaction, in the ops function, logged.
 * nothing is deleted, so the report for a past client still builds.
 */
export async function deboardClient({ tenantId, reason, note, deleteLogins }) {
  try {
    return await callOps({
      action: 'deboard-client',
      tenant_id: tenantId,
      reason,
      note: note || null,
      delete_logins: Boolean(deleteLogins),
    });
  } catch (error) {
    throw staleDeploy(error, 'deboarding');
  }
}

export async function restoreClient(tenantId, status = 'paused') {
  try {
    return await callOps({ action: 'restore-client', tenant_id: tenantId, status });
  } catch (error) {
    throw staleDeploy(error, 'restoring a client');
  }
}

/** what the deployed ops function can do, and whether it can reach n8n. */
export async function opsCapabilities() {
  return callOps({ action: 'capabilities' });
}

/* ── edge functions ────────────────────────────────────────── */

async function callFunction(name, body, accessToken) {
  const response = await fetch(functionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey ?? '',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* a function that is not deployed answers with html from the gateway, not
       json. that is a real state with a real fix, so it gets its own message
       rather than a parse error. */
  }

  if (!response.ok) {
    throw new Error(
      payload?.error ??
        (response.status === 404
          ? `the ${name} function is not deployed yet`
          : `${name} failed (${response.status})`),
    );
  }

  return payload;
}

/**
 * invites the client's address if it has no account, and attaches it to the
 * tenant. the one step that has to happen server-side, because it touches
 * auth.users and nothing holding an anon key ever should.
 */
export async function linkClientAccount(tenantId, email) {
  return callOps({ action: 'link-client', tenant_id: tenantId, email });
}

export async function unlinkClientAccount(tenantId, email) {
  return callOps({ action: 'unlink-client', tenant_id: tenantId, email });
}

/* ── alerts ────────────────────────────────────────────────────
   every one of these goes through the `ops` edge function rather than straight at
   the table, even acknowledge and resolve — which an admin policy would happily
   allow from the browser. the reason is the audit row: routing the write through
   the function is what makes "who resolved this" a fact the system records
   rather than a thing somebody remembers. */

async function callOps(body) {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return callFunction('ops', body, session?.access_token);
}

export async function raiseAlert({ tenantId, checkType, severity, message }) {
  return callOps({
    action: 'raise-alert',
    tenant_id: tenantId,
    check_type: checkType,
    severity,
    message,
  });
}

export async function acknowledgeAlert(alertId) {
  return callOps({ action: 'acknowledge-alert', alert_id: alertId });
}

export async function resolveAlert(alertId) {
  return callOps({ action: 'resolve-alert', alert_id: alertId });
}

/* ── the audit log ─────────────────────────────────────────────
   read-only from here. the insert side lives in the edge functions and there is
   no update or delete policy on the table at all, so this is the whole client
   surface. */
export async function fetchAdminActions(limit = 200) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('admin_actions')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    occurredAt: row.occurred_at,
  }));
}

/* ── the supabase panel ────────────────────────────────────── */

async function countRows(supabase, table) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  return error ? { table, count: null, error: error.message } : { table, count: count ?? 0 };
}

/**
 * probes the project rather than describing it.
 *
 * everything on the supabase page is the result of an actual round trip made
 * just now — a table that answers, a function that responds, a realtime socket
 * that opens. a page that listed what the schema is supposed to contain would
 * be a screenshot of a migration file, and it would keep saying everything was
 * fine while the project was down.
 */
export async function probeSupabase() {
  const supabase = getSupabase();
  if (!supabase) return { configured: false };

  const started = performance.now();
  const tables = await Promise.all(
    ['tenants', 'events', 'alerts', 'connections', 'ingest_tokens', 'arc_admins'].map((table) =>
      countRows(supabase, table),
    ),
  );
  const latencyMs = Math.round(performance.now() - started);

  /* migrations that only add columns cannot be seen in a row count. asking for
     the newest column by name, zero rows, is the cheapest question that fails
     exactly when the migration is missing. */
  const columns = await Promise.all(
    [
      {
        table: 'connections',
        column: 'billing_status',
        migration: '0006_connection_billing.sql',
        consequence: 'subscriptions, renewal dates and key hints on a client page cannot be saved',
      },
      {
        table: 'tenants',
        column: 'archived_at',
        migration: '0007_client_offboarding.sql',
        consequence: 'no client can be deboarded or restored',
      },
      {
        table: 'client_service_steps',
        column: 'done_at',
        migration: '0008_client_services.sql',
        consequence: 'no services can be chosen for a client and no build checklist can be kept',
      },
    ].map(
      async (probe) => {
        const { error } = await supabase.from(probe.table).select(probe.column).limit(0);
        return { ...probe, present: !error, error: error?.message ?? null };
      },
    ),
  );

  /* the functions are probed with a body they will reject. a 400 back from
     client-login means it is deployed, reachable and validating input — and no
     sign-in email was sent to anybody to find that out. */
  const functions = await Promise.all(
    ['client-login', 'ops', 'ingest'].map(async (name) => {
      try {
        const response = await fetch(functionUrl(name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anonKey ?? '' },
          body: JSON.stringify({}),
        });
        return {
          name,
          deployed: response.status !== 404,
          status: response.status,
        };
      } catch (error) {
        return { name, deployed: false, status: null, error: error.message };
      }
    }),
  );

  const realtime = await new Promise((resolve) => {
    const channel = supabase.channel(`ops-probe-${Date.now()}`);
    const timer = setTimeout(() => {
      supabase.removeChannel(channel);
      resolve({ ok: false, detail: 'no response in 6s' });
    }, 6000);

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer);
        supabase.removeChannel(channel);
        resolve({ ok: status === 'SUBSCRIBED', detail: status.toLowerCase() });
      }
    });
  });

  return {
    configured: true,
    projectRef: projectRef(),
    url: import.meta.env.VITE_SUPABASE_URL ?? null,
    latencyMs,
    tables,
    columns,
    functions,
    realtime,
    checkedAt: DateTime.now().toISO(),
  };
}

/* the ref out of the project URL — the thing the supabase dashboard is keyed on,
   so the console can link straight to the right project instead of the account
   picker. */
export function projectRef() {
  const url = import.meta.env.VITE_SUPABASE_URL ?? '';
  const match = url.match(/https?:\/\/([a-z0-9]+)\.supabase\./i);
  return match ? match[1] : null;
}

export function dashboardUrl(path = '') {
  const ref = projectRef();
  return ref ? `https://supabase.com/dashboard/project/${ref}${path}` : 'https://supabase.com/dashboard';
}

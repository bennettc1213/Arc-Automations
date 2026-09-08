import { DateTime } from 'luxon';
import { getSupabase, isConfigured, functionUrl, anonKey } from './supabase';
import { buildDashboardData } from './dashboard-data';
import { EVENT_COLUMNS, toEvent } from './event-row';
import { generateIngestToken, sha256Hex, generateClientId } from './client-id';

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
    notes: row.notes,
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

const TENANT_COLUMNS =
  'id, client_id, name, slug, company, timezone, status, plan, notes, login_email, ' +
  'contact_name, contact_phone, created_at, onboarded_at';

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
    const { data, error } = await supabase
      .from('events')
      /* tenant_id is already in EVENT_COLUMNS, which is what makes one pass over
         the whole book possible instead of one query per client. */
      .select(EVENT_COLUMNS)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

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

  const [{ data: tenantRows, error: tenantError }, { data: connectionRows }, { data: alertRows }] =
    await Promise.all([
      supabase.from('tenants').select(TENANT_COLUMNS).order('created_at', { ascending: true }),
      supabase.from('connections').select('*').order('created_at', { ascending: true }),
      supabase
        .from('alerts')
        .select('id, tenant_id, check_type, severity, message, fired_at, acknowledged_at, resolved_at')
        .gte('fired_at', since)
        .order('fired_at', { ascending: false })
        .limit(500),
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

  return {
    clients,
    recentEvents,
    totalEvents: events.length,
    generatedAt: DateTime.now().toISO(),
    windowDays: WINDOW_DAYS,
  };
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
export function rosterTotals(clients) {
  const live = clients.filter((c) => c.tenant.status === 'active');
  const responders = live
    .map((c) => c.data.metrics.medianResponseMs)
    .filter((ms) => ms !== null && ms !== undefined)
    .sort((a, b) => a - b);

  return {
    clients: clients.length,
    active: live.length,
    onboarding: clients.filter((c) => c.tenant.status === 'onboarding').length,
    paused: clients.filter((c) => c.tenant.status === 'paused').length,
    archived: clients.filter((c) => c.tenant.status === 'archived').length,
    leads: clients.reduce((sum, c) => sum + (c.data.metrics.leadsLast30Days ?? 0), 0),
    leadsThisMonth: clients.reduce((sum, c) => sum + (c.data.metrics.leadsThisMonth ?? 0), 0),
    answered: clients.reduce((sum, c) => sum + (c.data.metrics.missedCallsAnswered ?? 0), 0),
    sends: clients.reduce((sum, c) => sum + (c.data.metrics.sends ?? 0), 0),
    degraded: clients.filter((c) => c.data.status.status !== 'operational').length,
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
  { value: 'other', label: 'other' },
];

export async function saveConnection(connection) {
  const supabase = getSupabase();
  const row = {
    tenant_id: connection.tenantId,
    kind: connection.kind,
    label: connection.label,
    endpoint: connection.endpoint || null,
    status: connection.status,
    workflow_id: connection.workflowId || null,
    notes: connection.notes || null,
    updated_at: new Date().toISOString(),
  };

  const query = connection.id
    ? supabase.from('connections').update(row).eq('id', connection.id)
    : supabase.from('connections').insert(row);

  const { data, error } = await query.select('*').single();
  if (error) throw new Error(error.message);
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
    const row = activity.get(event.workflowId) ?? { runs: 0, failed: 0, lastAt: null };
    row.runs += 1;
    if (event.status === 'failure') row.failed += 1;
    if (row.lastAt === null || event.occurredAt > row.lastAt) row.lastAt = event.occurredAt;
    activity.set(event.workflowId, row);
  }

  return activity;
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
export function connectionLiveness(connection, activity, now = DateTime.now()) {
  if (!connection.workflowId) {
    return { state: 'unmatched', lastAt: null, runs: 0, failed: 0, label: 'no workflow id' };
  }

  const row = activity?.get?.(connection.workflowId);
  if (!row) {
    return { state: 'silent', lastAt: null, runs: 0, failed: 0, label: 'never seen' };
  }

  const hours = now.diff(DateTime.fromISO(row.lastAt, { zone: 'utc' }), 'hours').hours;

  /* 48 hours, not 24: a plumbing contractor's speed-to-lead workflow can
     legitimately go a quiet weekend without firing, and a console that cried
     "down" every monday morning would be one Ben stops reading. */
  const state = hours > 48 ? 'stale' : row.failed > 0 ? 'flaky' : 'live';

  return {
    state,
    lastAt: row.lastAt,
    runs: row.runs,
    failed: row.failed,
    label:
      state === 'live'
        ? 'live'
        : state === 'flaky'
          ? `${row.failed} failed`
          : `quiet ${Math.max(1, Math.round(hours / 24))}d`,
  };
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
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return callFunction(
    'ops',
    { action: 'link-client', tenant_id: tenantId, email },
    session?.access_token,
  );
}

export async function unlinkClientAccount(tenantId, email) {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return callFunction(
    'ops',
    { action: 'unlink-client', tenant_id: tenantId, email },
    session?.access_token,
  );
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

/* ARC-GO-320 — the safety test pass. The gate for ARC-GO-330.
 *
 * Every other Lead Recovery suite tests a part: the engine on its in-memory store, a
 * migration, a rule. This one walks the whole path the way a real line would — through the
 * doors a request actually comes in by — and then breaks it on purpose:
 *
 *   the doors      `twilio/handler.ts` (a signed webhook, verified before anything is opened),
 *                  the dispatcher's own call (`runDueActions`, every tenant), and
 *                  `ledger/handler.ts` (the portal's first client write).
 *   the proof      what the owner's screen then derives from `events`, with the portal's own
 *                  `buildDashboardData` — a job that counts, and the fee.
 *
 * Each scenario runs twice. Once on the in-memory store, so it runs everywhere. And once on
 * real Postgres through the production adapter (`supabaseStore` over PGlite, every migration
 * applied): the in-memory store keeps whole rows, so a field can pass every test there and
 * never reach the database. The two must agree. A third block is what only the database can
 * prove — which rows a signed-in browser can reach.
 *
 * Nothing here touches a network, Twilio or a model. Every text is "sent" to a double that
 * records it, and a canary's double is a different object from the live one.
 *
 * Without PGlite the real-SQL half is reported as skipped, never as passed. `npm run gate`
 * sets ARC_GATE=sql, which turns that skip into a failure: the gate is only the gate when it
 * ran on real SQL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';

import { asRole, freshDatabase, loadPglite, postgrestTimestamp, restClient, SKIP_REASON } from './pglite-harness.js';
import { FIXTURE_OPERATOR, leadRecoveryConfig, seedPublishedConfig } from './config-fixtures.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { REQUIRED_STEPS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import {
  authorizeLeadRecoveryEffect,
  deterministicUuid,
  intakeLead,
  leaseOf,
  listUnknownSends,
  loadPinnedConfig,
  recordPilotTerms,
  runDueActions,
  settleUnknownSend,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { activateModule, beginTesting, pauseModule, recordTestResult, selectModule } from '../supabase/functions/_shared/lifecycle/engine.ts';
import { classifierFor, FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import { eventKey } from '../supabase/functions/_shared/event-writer.ts';
import { RecordingSender, twilioSignature } from '../supabase/functions/_shared/twilio.ts';
import { supabaseLedgerReads } from '../supabase/functions/_shared/ledger/service.ts';
import { handleTwilioWebhook, messageTenantFrom, TWILIO_ROUTES } from '../supabase/functions/twilio/handler.ts';
import { handleLedgerAction, LEDGER_ACTIONS, MAX_BODY_BYTES, membershipFrom } from '../supabase/functions/ledger/handler.ts';
import { toEvent } from '../src/portal/lib/event-row.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { ownerNeeds } from '../src/portal/lib/owner.js';

/* ── fixtures ───────────────────────────────────────────── */

const LR = 'lead_recovery';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PUBLIC_BASE = 'https://arc.example/functions/v1';
const NEEDS_YOU = 'https://arc.example/portal/dashboard/needs-you';
/* the webhook's shared secret, as a test would hold it. built from parts so nothing in the
   repository is shaped like a credential. */
const AUTH_TOKEN = ['gate', 'test', 'token'].join('-');
const TERMS = { base_cents: 20000, per_job_cents: 9000, cap_cents: 100000, dispute_window_days: 7 };
const SHOP = '+16145550137';

const ALWAYS_OPEN = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, [{ open: '00:00', close: '23:59' }]]));

/* numbers and provider ids are never reused: the real-SQL scenarios share one database. */
let serial = 0;
const next = () => (serial += 1);
const arcNumber = () => `+1614${5_500_000 + next()}`;
const ownerNumber = () => `+1380${5_500_000 + next()}`;
const customerNumber = () => `+1740${5_500_000 + next()}`;
const sid = (prefix) => `${prefix}${String(next()).padStart(32, '0')}`;

/** A complete configuration for one client: open all week, so no scenario depends on the hour it runs at. */
function gateConfig({ number, ownerPhone, mode = 'business_first', ...overrides }) {
  const base = leadRecoveryConfig();
  return leadRecoveryConfig({
    business_hours: ALWAYS_OPEN,
    after_hours: { behaviour: 'same_response', callback_window: base.after_hours.callback_window },
    forwarding: { destination: SHOP, timeout_seconds: 20, mode },
    staff_alerts: [{ name: 'Dana', channel: 'sms', address: ownerPhone }],
    twilio: { ...base.twilio, phone_number: number },
    ...overrides,
  });
}

/**
 * The provider, as far as the engine can tell. It records every text, hands back an id no
 * other text has, and can be told to fail for one number the three ways a provider does.
 */
class Carrier {
  sent = [];

  failing = new Map();

  // deno-lint-ignore require-await
  async send(args) {
    this.sent.push(args);
    const ok = { ok: true, sid: sid('SM'), status: 'queued', errorCode: null, errorMessage: null, permanent: false, ambiguous: false, ms: 0 };
    const mode = this.failing.get(args.to);
    if (mode === 'timeout') return { ...ok, ok: false, sid: null, status: null, errorMessage: 'no answer in 10s', ambiguous: true };
    if (mode === 'refused') return { ...ok, ok: false, sid: null, status: null, errorCode: '21211', errorMessage: 'invalid number', permanent: true };
    return ok;
  }

  to(number) {
    return this.sent.filter((message) => message.to === number);
  }
}

/* ── the two worlds ─────────────────────────────────────── */

/**
 * What both worlds share: the doors, built over whichever store the world brought.
 *
 *   twilio(route, params)   a webhook, signed as Twilio signs it unless told otherwise
 *   dispatch()              what the `dispatch` function does on its schedule, until idle
 *   ledger(userId, body)    the owner's door, as whoever the token verified as
 */
function doors(world) {
  const engine = (worker = 'gate') => ({
    store: world.store,
    now: world.now,
    liveSender: world.carrier,
    canarySender: world.canary,
    classifierFor: (config) => (world.classifier ? world.classifier(config) : new FakeClassifier()),
    urls: { statusCallback: `${PUBLIC_BASE}/twilio/message-status`, ownerNeedsYou: () => NEEDS_YOU },
    uuid: () => crypto.randomUUID(),
    worker,
  });

  return Object.assign(world, {
    engine,
    /** how many signed requests the phone door has let through, and how many members the ledger's. */
    opened: 0,
    ledgerOpened: 0,

    async twilio(route, params, { signature, token = AUTH_TOKEN, method = 'POST', query = '' } = {}) {
      const header = signature === undefined ? await twilioSignature(AUTH_TOKEN, `${PUBLIC_BASE}/twilio/${route}${query}`, params) : signature;
      return await handleTwilioWebhook(
        {
          authToken: token,
          publicBase: PUBLIC_BASE,
          open: () => {
            world.opened += 1;
            return { deps: engine('twilio-webhook'), messageTenant: world.messageTenant };
          },
        },
        /* the request's own host is the platform's, not the public one: the signature is
           checked against the configured base, never against what the request claims. */
        { method, url: `https://edge-runtime.internal/twilio/${route}${query}`, body: new URLSearchParams(params).toString(), signature: header },
      );
    },

    async dispatch({ worker = 'scheduler:gate' } = {}) {
      const details = [];
      for (let round = 0; round < 12; round += 1) {
        const summary = await runDueActions(engine(worker), { limit: 25, worker, tenantId: null });
        if (summary.claimed === 0) break;
        details.push(...summary.details);
      }
      return details;
    },

    async ledger(userId, body) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return await handleLedgerAction(
        {
          userId,
          membership: world.membership,
          deps: () => {
            world.ledgerOpened += 1;
            /* as the function builds it: nothing at this door can reach a customer. */
            return {
              engine: { ...engine('ledger'), liveSender: new RecordingSender(), canarySender: new RecordingSender(), classifierFor: () => new FakeClassifier() },
              ...world.ledgerReads,
            };
          },
        },
        text,
      );
    },

    async dashboard(client, options) {
      const events = await world.events(client, options);
      return buildDashboardData(client.tenant, events, DateTime.fromJSDate(world.now(), { zone: 'utc' }));
    },
  });
}

/** The engine on its in-memory store. */
function memoryWorld() {
  const store = new MemoryStore();
  let clock = new Date('2026-09-16T14:00:00.000Z');
  const members = new Map();
  const ids = new Map();
  const idOf = (row) => {
    if (!ids.has(row)) ids.set(row, crypto.randomUUID());
    return ids.get(row);
  };
  const ofTenant = (tenantId) => store.events.filter((row) => row.tenantId === tenantId);

  return doors({
    kind: 'memory',
    store,
    operator: FIXTURE_OPERATOR,
    carrier: new Carrier(),
    canary: new Carrier(),
    now: () => clock,
    // deno-lint-ignore require-await
    async advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    invalid: () => store.invalidEvents,

    // deno-lint-ignore require-await
    async client({ mode, config = {}, role = 'owner' } = {}) {
      const tenantId = crypto.randomUUID();
      const number = arcNumber();
      const ownerPhone = ownerNumber();
      store.tenants.push({ id: tenantId, status: 'active' });
      seedPublishedConfig(store, { tenantId, config: gateConfig({ number, ownerPhone, mode, ...config }) });
      const owner = crypto.randomUUID();
      members.set(`${tenantId}:${owner}`, { role });
      return { tenantId, number, ownerPhone, owner, tenant: tenantOf(tenantId, clock) };
    },

    // deno-lint-ignore require-await
    membership: async (tenantId, userId) => members.get(`${tenantId}:${userId}`) ?? null,
    // deno-lint-ignore require-await
    messageTenant: async (providerMessageId) => store.messages.find((message) => message.providerMessageId === providerMessageId)?.tenantId ?? null,

    ledgerReads: {
      // deno-lint-ignore require-await
      evidence: async (tenantId, correlationId) =>
        ofTenant(tenantId)
          .filter((row) => row.event.correlation_id === correlationId && !row.event.is_canary)
          .map((row) => ({ id: idOf(row), eventType: row.event.event_type, occurredAt: row.event.occurred_at, payload: row.event.payload ?? null })),
      // deno-lint-ignore require-await
      hasTerms: async (tenantId) => ofTenant(tenantId).some((row) => row.event.event_type === 'pilot_terms_recorded'),
    },

    /* no row level security here: this is the store's own filter. the block at the end of
       this file asks the database the same question as a signed-in browser. */
    // deno-lint-ignore require-await
    events: async (client) => ofTenant(client.tenantId).map((row) => toEvent({ id: idOf(row), tenant_id: row.tenantId, ...row.event })),
  });
}

const tenantOf = (tenantId, at) => ({
  id: tenantId,
  name: 'Halstead Heating',
  slug: 'halstead',
  timezone: 'America/New_York',
  status: 'active',
  createdAt: new Date(at.getTime() - 30 * DAY).toISOString(),
  modules: ['lead_capture'],
});

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let database;
let operatorId;

/**
 * Real Postgres, every migration applied, through `supabaseStore` exactly as the functions
 * build it.
 *
 * Time is the one thing that differs. The queue's claim reads the database's own clock —
 * `run_at <= now()` — which is right, and cannot be moved from here. So this world moves
 * everything else: the engine's clock runs `offset` ahead of the database's, what it
 * schedules is stored in the database's time, and advancing ages the rows already queued.
 * A follow-up due "in an hour" is due after `advance(HOUR)`, in both worlds.
 */
async function sqlWorld() {
  if (!database) {
    database = await freshDatabase();
    operatorId = crypto.randomUUID();
    await database.query('insert into auth.users (id, email) values ($1, $2)', [operatorId, 'gate-operator@example.test']);
    await database.query('insert into public.arc_admins (user_id) values ($1)', [operatorId]);
  }
  const db = database;
  /* an earlier scenario's leftovers must not be picked up by this one's dispatcher. */
  await db.query(`update public.scheduled_actions set status = 'cancelled', last_error = 'left by an earlier scenario' where status in ('pending', 'claimed')`);

  const client = restClient(db);
  const base = supabaseStore(client);
  const invalid = [];
  let offset = 0;
  const inDatabaseTime = (iso) => new Date(Date.parse(iso) - offset).toISOString();
  const store = {
    ...base,
    scheduleAction: (row) => base.scheduleAction({ ...row, runAt: inDatabaseTime(row.runAt) }),
    rescheduleAction: (lease, runAt, error) => base.rescheduleAction(lease, inDatabaseTime(runAt), error),
    retryAction: (tenantId, actionId, runAt) => base.retryAction(tenantId, actionId, inDatabaseTime(runAt)),
    /* the adapter logs an event its own validator refused and carries on. kept here, so a
       scenario can say none was. */
    async emit(tenantId, events) {
      const result = await base.emit(tenantId, events);
      invalid.push(...result.invalid);
      return result;
    },
  };

  const world = doors({
    kind: 'sql',
    db,
    store,
    operator: operatorId,
    carrier: new Carrier(),
    canary: new Carrier(),
    now: () => new Date(Date.now() + offset),
    async advance(ms) {
      offset += ms;
      await db.query(
        `update public.scheduled_actions
            set run_at = run_at - make_interval(secs => $1),
                locked_at = locked_at - make_interval(secs => $1),
                lease_expires_at = lease_expires_at - make_interval(secs => $1)
          where status in ('pending', 'claimed')`,
        [ms / 1000],
      );
    },
    invalid: () => invalid,

    /** A client put live the way an operator does it: published, selected, onboarded, tested with a canary, activated. */
    async client({ mode, config = {}, role = 'owner' } = {}) {
      const number = arcNumber();
      const ownerPhone = ownerNumber();
      const { rows: [{ id: tenantId }] } = await db.query(
        `insert into public.tenants (name, slug, status, timezone) values ('Halstead Heating', $1, 'active', 'America/New_York') returning id`,
        [`gate-${crypto.randomUUID()}`],
      );
      const owner = crypto.randomUUID();
      await db.query('insert into auth.users (id, email) values ($1, $2)', [owner, `${owner}@example.test`]);
      await db.query('insert into public.tenant_members (user_id, tenant_id, role) values ($1, $2, $3)', [owner, tenantId, role]);

      const published = await publishEffectiveConfig(store, {
        tenantId, moduleKey: LR, config: gateConfig({ number, ownerPhone, mode, ...config }),
        expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: operatorId },
      });
      assert.equal(published.ok, true, published.message);

      const request = async (extra = {}) => ({
        tenantId, moduleKey: LR, actor: { type: 'operator', id: operatorId },
        expectedStateVersion: (await store.getLifecycle(tenantId, LR))?.stateVersion ?? 0, ...extra,
      });
      const must = (result, what) => assert.equal(result.ok, true, `${what}: ${result.code} ${result.message} ${JSON.stringify(result.blockers ?? [])}`);

      must(await selectModule(store, await request()), 'select');
      for (const step of REQUIRED_STEPS) {
        await db.query(`insert into public.module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, $2, $3, now())`, [tenantId, LR, step]);
      }
      must(await beginTesting(store, await request()), 'begin testing');
      const canary = await intakeLead(world.engine('ops-canary'), {
        tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006', customerName: 'Arc canary',
        serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary', consentSms: true, consentSource: 'operator', isCanary: true,
      });
      await runDueActions(world.engine('ops-canary'), { tenantId, canaryOnly: true, worker: 'ops-canary', limit: 10 });
      must(await recordTestResult(store, { ...(await request()), runId: canary.run.id, passed: true }), 'record the test');
      must(await activateModule(store, await request()), 'activate');

      return { tenantId, number, ownerPhone, owner, tenant: tenantOf(tenantId, world.now()) };
    },

    membership: membershipFrom(client),
    messageTenant: messageTenantFrom(client),
    ledgerReads: supabaseLedgerReads(client),

    /**
     * The events a dashboard is built from, as PostgREST would send them. With `as`, they
     * are read the way `dashboard.js` reads them: as that signed-in user, with no tenant
     * filter at all — row level security is the only thing choosing the rows.
     */
    async events(tenant, { as } = {}) {
      const rows = as
        ? await asRole(db, { role: 'authenticated', sub: as }, async (tx) => (await tx.query('select * from public.events order by occurred_at, created_at')).rows)
        : (await db.query('select * from public.events where tenant_id = $1 order by occurred_at, created_at', [tenant.tenantId])).rows;
      return rows.map((row) =>
        toEvent(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? postgrestTimestamp(value) : value]))),
      );
    },
  });
  return world;
}

/* ── what a scenario does ───────────────────────────────── */

/** A call the business did not answer, as it reaches ARC: Twilio's voice webhook. */
const call = (world, client, from, options = {}) =>
  world.twilio('voice', { CallSid: options.callSid ?? sid('CA'), From: from, To: client.number, CallStatus: 'ringing', Direction: 'inbound' }, options);

/** The customer texts the business's ARC number. */
const text = (world, client, from, body, options = {}) =>
  world.twilio('sms', { MessageSid: options.messageSid ?? sid('SM'), From: from, To: client.number, Body: body }, options);

/** The provider says what happened to something ARC sent. */
const delivery = (world, providerMessageId, status, extra = {}) =>
  world.twilio('message-status', { MessageSid: providerMessageId, MessageStatus: status, ...extra });

const pause = async (world, client) => {
  const lifecycle = await world.store.getLifecycle(client.tenantId, LR);
  const paused = await pauseModule(world.store, {
    tenantId: client.tenantId, moduleKey: LR, actor: { type: 'operator', id: world.operator }, expectedStateVersion: lifecycle.stateVersion,
  });
  assert.equal(paused.ok, true, `pause: ${paused.code} ${paused.message}`);
};

const leadOfCall = async (world, client, callSid) =>
  world.store.getLeadByCorrelation(client.tenantId, await deterministicUuid(client.tenantId, LR, 'missed_call', callSid));
const leadOfText = async (world, client, messageSid) =>
  world.store.getLeadByCorrelation(client.tenantId, await deterministicUuid(client.tenantId, LR, 'inbound_sms', messageSid));
const runOf = (world, client, lead) => world.store.getRunForLead(client.tenantId, lead.id, LR);
const stateOf = async (world, client, lead) => (await runOf(world, client, lead))?.state ?? null;
const suppressed = (world, client, number) => world.store.isSuppressed(client.tenantId, 'sms', number, world.now().toISOString());
const typesOf = (events, { canary = false } = {}) => events.filter((event) => event.isCanary === canary).map((event) => event.eventType);
const count = (events, type) => typesOf(events).filter((eventType) => eventType === type).length;
const unsent = async (world, client) =>
  (await listUnknownSends(world.engine(), { tenantId: client.tenantId })).filter((attempt) => attempt.effectType === 'customer_sms');
/** The identity of an action's one send — the key the engine reserves, which never varies by attempt. */
const effectKeyOf = (action) => eventKey('lr', 'effect', action.idempotencyKey);

/** The next call to one of the store's writes fails, the way a database that does not answer does. Once. */
function failOnce(world, method) {
  const { store } = world;
  const own = Object.hasOwn(store, method);
  const original = store[method];
  store[method] = async () => {
    if (own) store[method] = original;
    else delete store[method];
    throw new Error('the database did not answer');
  };
}

/** A worker claims this client's one due action, and keeps what it was handed: its own copy, lease and all. */
async function claimAs(world, client, worker) {
  const claimed = await world.store.claimActions({ limit: 5, worker, nowIso: world.now().toISOString(), leaseSeconds: 120, tenantId: client.tenantId });
  assert.equal(claimed.length, 1);
  return structuredClone(claimed[0]);
}

/** A worker, holding an action it claimed, asks the one gate every customer message passes. */
async function askToSend(world, client, lead, action, worker) {
  const run = await runOf(world, client, lead);
  const pinned = await loadPinnedConfig(world.store, run);
  assert.equal(pinned.ok, true, pinned.reason);
  return await authorizeLeadRecoveryEffect(world.engine(worker), {
    action, run, lead: await world.store.getLead(client.tenantId, lead.id), config: pinned.config,
    effectType: 'customer_sms', effectKey: effectKeyOf(action), destination: lead.phone, now: world.now(),
  });
}

/** A missed call whose first text has gone out. */
async function texted(world, client, customer = customerNumber()) {
  const callSid = sid('CA');
  assert.equal((await call(world, client, customer, { callSid })).status, 200);
  await world.dispatch();
  const lead = await leadOfCall(world, client, callSid);
  assert.equal(await stateOf(world, client, lead), 'awaiting_reply');
  assert.equal(world.carrier.to(customer).length, 1);
  return { customer, callSid, lead };
}

/* ── the scenarios, on both stores ──────────────────────── */

function gate(title, makeWorld, options = {}) {
  describe(`one missed call, end to end — ${title}`, options, () => {
    test('a missed call becomes a job that counts, and every step on the way is on the record', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      assert.equal(world.carrier.sent.length, 0, 'putting a client live reached no handset');

      /* 1. the business's phone company sends an unanswered call on to ARC. */
      const rang = await call(world, client, customer, { callSid });
      assert.equal(rang.status, 200);
      assert.match(rang.body, /<Say[^>]*>Thanks for calling Halstead Heating\. Sorry we missed you\./);
      assert.doesNotMatch(rang.body, /<Dial/, 'the caller is not made to hear a second phone ring');
      const lead = await leadOfCall(world, client, callSid);
      assert.equal(lead.phone, customer);
      assert.equal(await stateOf(world, client, lead), 'response_queued');
      assert.equal(world.carrier.sent.length, 0, 'the webhook queues and returns — only the dispatcher sends');

      /* 2. the dispatcher's next run sends the one text back. */
      await world.dispatch();
      const [first] = world.carrier.to(customer);
      assert.match(first.body, /sorry we missed your call/i);
      assert.match(first.body, /Reply STOP to opt out\.$/, 'the opt-out line is the engine\'s, on every message');
      assert.equal(await stateOf(world, client, lead), 'awaiting_reply');

      /* 3. the provider confirms it reached the handset. */
      const sentRow = (await world.events(client)).find((event) => event.eventType === 'sms_sent' && !event.isCanary);
      assert.equal(sentRow.payload.template, 'first_response');
      assert.ok(sentRow.latencyMs >= 0, 'the first text carries the time since the call');
      assert.equal((await delivery(world, sentRow.payload.provider_message_id, 'delivered')).status, 200);

      /* 4. ten minutes later the customer answers. */
      await world.advance(10 * MINUTE);
      assert.equal((await text(world, client, customer, 'furnace repair please, we are in 43215')).status, 200);
      await world.dispatch();
      assert.equal(await stateOf(world, client, lead), 'qualified');
      const [alert] = world.carrier.to(client.ownerPhone);
      assert.equal(world.carrier.to(client.ownerPhone).length, 1, 'the owner is told once');
      assert.ok(alert.body.includes(NEEDS_YOU), 'and sent to their own screen');
      assert.ok(!alert.body.includes(customer.slice(-7)), 'without the customer\'s full number in a text');
      const [, thanks] = world.carrier.to(customer);
      assert.match(thanks.body, /has your message and will call you to set a time/);
      assert.equal(world.carrier.to(customer).length, 2);

      /* the owner's screen now asks them to put the visit down. */
      const afterReply = await world.dashboard(client);
      assert.deepEqual(ownerNeeds(afterReply).groups.find((group) => group.key === 'visit').items.map((item) => item.lead), [lead.correlationId]);
      assert.notEqual(afterReply.threads.find((thread) => thread.id === lead.correlationId).ledger.status, 'confirmed');

      /* 5. the owner agrees a visit for tomorrow and saves the time. */
      await world.advance(30 * MINUTE);
      const visitAt = new Date(world.now().getTime() + DAY).toISOString();
      const booked = await world.ledger(client.owner, { action: 'visit-booked', tenant_id: client.tenantId, lead: lead.correlationId, appointment_at: visitAt });
      assert.deepEqual([booked.status, booked.body.ok, booked.body.appointmentAt], [200, true, visitAt]);
      assert.equal(await stateOf(world, client, lead), 'booked');
      const queued = await world.store.listActionsForRun(client.tenantId, (await runOf(world, client, lead)).id);
      assert.deepEqual(queued.filter((action) => action.status === 'pending' || action.status === 'claimed'), [], 'a booked lead has nothing left on the queue');

      /* the terms a fee is worked out under are an operator's to record. */
      assert.equal((await recordPilotTerms(world.engine('ops'), { tenantId: client.tenantId, input: TERMS, actorId: world.operator })).ok, true);

      /* before the visit there is no question to ask, and "it happened" is refused. */
      const early = await world.ledger(client.owner, { action: 'outcome-asked', tenant_id: client.tenantId, leads: [lead.correlationId] });
      assert.deepEqual([early.status, early.body.asked], [200, 0]);
      const tooEarly = await world.ledger(client.owner, { action: 'outcome-answer', tenant_id: client.tenantId, lead: lead.correlationId, answer: 'happened' });
      assert.deepEqual([tooEarly.status, tooEarly.body.code], [409, 'too_early']);
      assert.equal((await world.dashboard(client)).ledger.month.billed, 0, 'a visit that has not happened yet is not billed');

      /* 6. two days on, the visit has passed. nothing chased the customer in between. */
      await world.advance(2 * DAY);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 2, 'no follow-up, no reminder: the lead was booked');
      const waiting = await world.dashboard(client);
      assert.equal(waiting.threads.find((thread) => thread.id === lead.correlationId).ledger.status, 'needs_owner');

      /* 7. the needs-you screen shows the question, and the owner taps "it happened". */
      const asked = await world.ledger(client.owner, { action: 'outcome-asked', tenant_id: client.tenantId, leads: [lead.correlationId] });
      assert.deepEqual([asked.status, asked.body.asked], [200, 1]);
      const answered = await world.ledger(client.owner, { action: 'outcome-answer', tenant_id: client.tenantId, lead: lead.correlationId, answer: 'happened' });
      assert.deepEqual([answered.status, answered.body.written], [200, true]);
      const again = await world.ledger(client.owner, { action: 'outcome-answer', tenant_id: client.tenantId, lead: lead.correlationId, answer: 'happened' });
      assert.deepEqual([again.status, again.body.written], [200, false], 'a double tap is one row');

      /* 8. the ledger, read off the log by the portal's own code. */
      const data = await world.dashboard(client);
      const verdict = data.threads.find((thread) => thread.id === lead.correlationId).ledger;
      assert.equal(verdict.status, 'confirmed', verdict.reason);
      assert.deepEqual([data.ledger.totals.total, data.ledger.totals.billed, data.ledger.month.billed], [1, 1, 1], 'one job, and no canary among the figures');
      assert.equal(data.ledger.month.feeCents, TERMS.base_cents + TERMS.per_job_cents);

      /* and the evidence behind it: each link once, nothing the validator refused. */
      const events = await world.events(client);
      for (const [type, times] of Object.entries({
        call_missed: 1, lead_received: 1, sms_sent: 2, message_delivered: 1, reply_received: 1, lead_qualified: 1, routed: 1,
        lead_booked: 1, lead_outcome_requested: 1, lead_outcome_recorded: 1, pilot_terms_recorded: 1, handoff_requested: 0, message_failed: 0,
      })) {
        assert.equal(count(events, type), times, type);
      }
      const answer = events.find((event) => event.eventType === 'lead_outcome_recorded');
      assert.deepEqual([answer.payload.answered_by, answer.payload.recorded_by], ['owner', client.owner], 'who answered is the sign-in');
      assert.deepEqual(world.invalid(), []);
      assert.equal(world.canary.to(customer).length, 0);
    });

    test('a website-form lead goes through the same engine and reaches the same ledger', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const intake = await intakeLead(world.engine('lead-intake'), {
        tenantId: client.tenantId, source: 'web_form', externalRef: `form:${crypto.randomUUID()}`, phone: customer,
        customerName: 'Pat Example', serviceRequest: 'water heater is not heating', zip: '43215', consentSms: true, consentSource: 'web_form',
      });
      assert.equal(intake.ok, true, intake.outcome);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1);
      await text(world, client, customer, 'yes please, water heater, 43215');
      await world.dispatch();
      assert.equal(await stateOf(world, client, intake.lead), 'qualified');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.deepEqual(world.invalid(), []);
    });
  });

  describe(`the path under failure — ${title}`, options, () => {
    /* ── STOP ── */

    test('STOP arriving after the text was queued and before it was sent: nothing is ever sent', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      await call(world, client, customer, { callSid });
      const lead = await leadOfCall(world, client, callSid);
      assert.equal(await stateOf(world, client, lead), 'response_queued');

      await text(world, client, customer, 'STOP');
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 0);
      assert.equal((await suppressed(world, client, customer))?.reason, 'opt_out');
      assert.equal(await stateOf(world, client, lead), 'suppressed');

      /* and not later either: no follow-up, and a second missed call from that number is
         recorded and answered with silence. */
      await world.advance(3 * HOUR);
      const again = sid('CA');
      await call(world, client, customer, { callSid: again });
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 0);
      assert.ok(await leadOfCall(world, client, again), 'the second call is still on the record');
      const events = await world.events(client);
      assert.equal(count(events, 'sms_sent'), 0);
      assert.equal(count(events, 'lead_suppressed'), 1);
    });

    test('STOP arriving between the first text and the follow-up cancels the follow-up', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await world.advance(20 * MINUTE);
      await text(world, client, customer, 'please stop texting me');
      await world.advance(3 * HOUR);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'the one text that went before they asked');
      assert.equal(await stateOf(world, client, lead), 'suppressed');
      assert.equal(world.carrier.to(client.ownerPhone).length, 0, 'an opt-out is not an alert');
    });

    test('STOP arriving after a worker has already claimed the send: the send is refused at the last moment', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      await call(world, client, customer, { callSid });
      const lead = await leadOfCall(world, client, callSid);

      /* a worker takes the action and is about to send. */
      const action = await claimAs(world, client, 'stalled');
      assert.equal(action.actionType, 'send_first_response');
      await text(world, client, customer, 'STOP');

      /* it asks the one gate every message passes, with what it believed when it claimed. */
      const verdict = await askToSend(world, client, lead, action, 'stalled');
      assert.equal(verdict.ok, false);
      assert.ok(['run_terminal', 'suppressed'].includes(verdict.denial), verdict.denial);
      assert.equal(await world.store.getEffectByKey(client.tenantId, effectKeyOf(action)), null, 'a refused send reserves nothing');

      /* and when its lease runs out, the next worker cancels rather than sends. */
      await world.advance(10 * MINUTE);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 0);
    });

    test('a stop belongs to one client: the same person can still hear from another business', async () => {
      const world = await makeWorld();
      const first = await world.client();
      const second = await world.client();
      const customer = customerNumber();
      await texted(world, first, customer);
      await text(world, first, customer, 'STOP');
      assert.ok(await suppressed(world, first, customer));
      assert.equal(await suppressed(world, second, customer), null);

      await call(world, second, customer);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 2, 'one from each business, and nothing more from the first');
    });

    /* ── two workers ── */

    test('two dispatchers running at once send one text', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      await call(world, client, customer);
      await Promise.all([world.dispatch({ worker: 'scheduler:a' }), world.dispatch({ worker: 'scheduler:b' })]);
      assert.equal(world.carrier.to(customer).length, 1);
      assert.equal(count(await world.events(client), 'sms_sent'), 1);
    });

    test('a worker that stalls is replaced, and when it wakes it can neither send nor close the action', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      await call(world, client, customer, { callSid });
      const lead = await leadOfCall(world, client, callSid);

      const stale = await claimAs(world, client, 'scheduler:stalled');
      assert.equal((await world.dispatch({ worker: 'scheduler:other' })).length, 0, 'while the lease holds, nobody else takes it');

      await world.advance(10 * MINUTE);
      await world.dispatch({ worker: 'scheduler:other' });
      assert.equal(world.carrier.to(customer).length, 1);

      /* the first worker comes back and tries to finish what it thought it had. */
      assert.equal((await world.store.getEffectByKey(client.tenantId, effectKeyOf(stale))).state, 'accepted');
      const verdict = await askToSend(world, client, lead, stale, 'scheduler:stalled');
      assert.equal(verdict.ok, false, 'the message has gone: a second reservation is refused');
      assert.ok(['already_attempted', 'customer_replied', 'run_not_sendable'].includes(verdict.denial), verdict.denial);
      const closed = await world.store.completeAction(leaseOf(stale), 'failed', 'stale', world.now().toISOString());
      assert.equal(closed.ok, false, 'and its stale lease can change nothing');
      assert.equal(world.carrier.to(customer).length, 1);
      assert.equal(await stateOf(world, client, lead), 'awaiting_reply');
    });

    /* ── a provider that does not answer ── */

    test('a provider timeout is never retried: the lead goes to a person, the owner is told, and an operator settles it', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      world.carrier.failing.set(customer, 'timeout');
      await call(world, client, customer, { callSid });
      await world.dispatch();
      const lead = await leadOfCall(world, client, callSid);

      assert.equal(world.carrier.to(customer).length, 1, 'the provider was asked once');
      assert.equal(count(await world.events(client), 'sms_sent'), 0, 'a maybe is never counted as a send');
      const handoff = await world.store.getOpenHandoff(client.tenantId, lead.id);
      assert.equal(handoff.reasonCode, 'delivery_failed');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.match(world.carrier.to(client.ownerPhone)[0].body, /check the provider/);

      /* hours pass, the provider recovers, and an operator presses retry. still once. */
      world.carrier.failing.delete(customer);
      await world.advance(4 * HOUR);
      await world.dispatch();
      const run = await runOf(world, client, lead);
      const failed = (await world.store.listActionsForRun(client.tenantId, run.id)).find((action) => action.actionType === 'send_first_response');
      await world.store.retryAction(client.tenantId, failed.id, world.now().toISOString());
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'an unknown outcome is not resent, by the queue or by a retry');

      /* the operator checks the provider and says what it shows. */
      const [held] = await unsent(world, client);
      assert.equal(held.state, 'reconciliation_required');
      const settled = await settleUnknownSend(world.engine('ops'), {
        tenantId: client.tenantId, attemptId: held.id, verdict: 'sent', providerMessageId: sid('SM'), actorId: world.operator,
      });
      assert.equal(settled.ok, true, settled.outcome);
      const sent = (await world.events(client)).filter((event) => event.eventType === 'sms_sent' && !event.isCanary);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.reconciled, true);
      assert.deepEqual(await unsent(world, client), []);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'settling records the truth and sends nothing');
      assert.equal(await stateOf(world, client, lead), 'handoff_required', 'the lead stays with a person');
      assert.deepEqual(world.invalid(), []);
    });

    test('a number the provider refuses for good is handed to a person, with nothing counted as sent', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      world.carrier.failing.set(customer, 'refused');
      await call(world, client, customer, { callSid });
      await world.dispatch();
      const lead = await leadOfCall(world, client, callSid);
      assert.equal(count(await world.events(client), 'sms_sent'), 0);
      assert.equal((await world.store.getOpenHandoff(client.tenantId, lead.id)).reasonCode, 'delivery_failed');
      assert.match(world.carrier.to(client.ownerPhone)[0].body, /has not heard from anyone/);
      await world.advance(3 * HOUR);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1);
    });

    test('a text the carrier could not deliver is handed to a person once, however often the carrier says so', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { lead } = await texted(world, client);
      const providerMessageId = (await world.events(client)).find((event) => event.eventType === 'sms_sent' && !event.isCanary).payload.provider_message_id;
      for (let delivered = 0; delivered < 2; delivered += 1) {
        assert.equal((await delivery(world, providerMessageId, 'undelivered', { ErrorCode: '30003' })).status, 200);
      }
      await world.dispatch();
      assert.equal((await world.store.getOpenHandoff(client.tenantId, lead.id)).reasonCode, 'delivery_failed');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.equal(count(await world.events(client), 'message_failed'), 1);
    });

    /* ── a paused module ── */

    test('pausing a client stops the follow-up that was already queued', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer } = await texted(world, client);
      await pause(world, client);
      await world.advance(3 * HOUR);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'the text that went before the pause, and no follow-up');
    });

    test('while paused, a missed call is still answered on the phone and recorded, and nobody is texted', async () => {
      const world = await makeWorld();
      const client = await world.client();
      await pause(world, client);
      const customer = customerNumber();
      const callSid = sid('CA');
      const rang = await call(world, client, customer, { callSid });
      assert.equal(rang.status, 200);
      assert.match(rang.body, /Sorry we missed you/, 'pausing the module never changes what a caller hears');
      await world.dispatch();
      const lead = await leadOfCall(world, client, callSid);
      assert.ok(lead, 'somebody did try to reach this business');
      assert.equal(await runOf(world, client, lead), null, 'no run starts on a paused module');
      assert.equal(world.carrier.sent.length, 0);
      const events = await world.events(client);
      assert.equal(count(events, 'call_missed'), 1);
      assert.equal(count(events, 'sms_sent'), 0);

      /* and time passing un-pauses nothing. */
      await world.advance(2 * DAY);
      await world.dispatch();
      assert.equal(world.carrier.sent.length, 0);
      assert.equal((await world.store.getLifecycle(client.tenantId, LR)).state, 'paused');
    });

    test('while paused, a safety reply still reaches a person\'s queue — and nothing is texted to anyone', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await pause(world, client);
      assert.equal((await text(world, client, customer, 'actually I can smell gas in the basement')).status, 200);
      await world.dispatch();
      const handoff = await world.store.getOpenHandoff(client.tenantId, lead.id);
      assert.equal(handoff?.isSafety, true, 'the lead is on a person\'s list');
      assert.equal(world.carrier.to(customer).length, 1, 'the customer is sent nothing while the module is paused');
      /* stated, not hidden: a paused module sends no alert text either. the handoff is on
         the needs-you screen and in the console, and that is the only place it is. */
      assert.equal(world.carrier.to(client.ownerPhone).length, 0);
    });

    /* ── a safety message ── */

    test('a safety word in the first reply goes to a person, never to the ordinary route', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'there is smoke coming from the furnace');
      await world.dispatch();

      const handoff = await world.store.getOpenHandoff(client.tenantId, lead.id);
      assert.deepEqual([handoff.reasonCode, handoff.isSafety], ['safety', true]);
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.match(world.carrier.to(client.ownerPhone)[0].body, /SAFETY: .*smoke/);
      const texts = world.carrier.to(customer).map((message) => message.body);
      assert.equal(texts.length, 2);
      assert.match(texts[1], /picking this up now/, 'the customer is told a person has it');
      const events = await world.events(client);
      assert.equal(count(events, 'routed'), 0);
      assert.equal(count(events, 'handoff_requested'), 1);
      assert.equal((await world.dashboard(client)).threads.find((thread) => thread.id === lead.correlationId).ledger.status, 'handed_off', 'a handoff is never billed');

      /* a person has it now: nothing chases the customer afterwards. */
      await world.advance(4 * DAY);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 2);
    });

    test('"actually I can smell gas", sent after the lead was read and routed, still reaches a person', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'furnace repair please, we are in 43215');
      await world.dispatch();
      assert.equal(await stateOf(world, client, lead), 'qualified');

      assert.equal((await text(world, client, customer, 'actually I can smell gas in the basement')).status, 200, 'a second reply never makes the webhook fail');
      await world.dispatch();
      assert.equal(await stateOf(world, client, lead), 'handoff_required');
      assert.equal((await world.store.getOpenHandoff(client.tenantId, lead.id)).isSafety, true);
      assert.equal(world.carrier.to(client.ownerPhone).length, 2, 'the owner hears about the second message too');
      assert.match(world.carrier.to(client.ownerPhone).at(-1).body, /SAFETY: .*gas/);
      assert.ok((await world.store.getLead(client.tenantId, lead.id)).safetyFlags.includes('gas'));
    });

    test('a model that says "routine" cannot clear what the rules flagged', async () => {
      const world = await makeWorld();
      world.classifier = () => new FakeClassifier({ safety_flags: [], needs_human: false, confidence: 0.99, urgency: 'scheduling' });
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'the carbon monoxide alarm keeps going off');
      await world.dispatch();
      assert.equal((await world.store.getOpenHandoff(client.tenantId, lead.id))?.isSafety, true);
      assert.equal(count(await world.events(client), 'routed'), 0);
    });

    test('with no model key every reply goes to a person, with the reason — never a guess', async () => {
      const world = await makeWorld();
      world.classifier = (config) => classifierFor({ ...config, ai: { enabled: true, provider: 'anthropic', model: null } }, { anthropicKey: null });
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'furnace repair please, we are in 43215');
      await world.dispatch();
      const handoff = await world.store.getOpenHandoff(client.tenantId, lead.id);
      assert.match(handoff.reason, /classifier could not be reached/);
      assert.equal(count(await world.events(client), 'routed'), 0);
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
    });

    /* ── a duplicate webhook ── */

    test('a redelivered call is one lead and one text', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');
      for (let delivered = 0; delivered < 3; delivered += 1) assert.equal((await call(world, client, customer, { callSid })).status, 200);
      await world.dispatch();
      await call(world, client, customer, { callSid });
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1);
      const events = await world.events(client);
      assert.deepEqual([count(events, 'call_missed'), count(events, 'lead_received'), count(events, 'sms_sent')], [1, 1, 1]);
    });

    test('a redelivered reply is read once: one alert to the owner, one message back to the customer', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer } = await texted(world, client);
      const messageSid = sid('SM');
      await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid });
      await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid });
      await world.dispatch();
      await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid });
      await world.dispatch();
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.equal(world.carrier.to(customer).length, 2);
      const events = await world.events(client);
      assert.deepEqual([count(events, 'reply_received'), count(events, 'lead_qualified'), count(events, 'routed')], [1, 1, 1]);
    });

    test('a redelivered STOP and a redelivered delivery receipt each change nothing the second time', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer } = await texted(world, client);
      const providerMessageId = (await world.events(client)).find((event) => event.eventType === 'sms_sent' && !event.isCanary).payload.provider_message_id;
      await delivery(world, providerMessageId, 'delivered');
      await delivery(world, providerMessageId, 'delivered');
      const stop = sid('SM');
      await text(world, client, customer, 'STOP', { messageSid: stop });
      await text(world, client, customer, 'STOP', { messageSid: stop });
      const events = await world.events(client);
      assert.deepEqual([count(events, 'message_delivered'), count(events, 'lead_suppressed'), count(events, 'reply_received')], [1, 1, 1]);
      assert.deepEqual(world.invalid(), []);
    });

    test('where the ARC number is in front, a redelivered dial result is one lead, and an answered call is only a count', async () => {
      const world = await makeWorld();
      const client = await world.client({ mode: 'arc_first' });
      const customer = customerNumber();
      const missed = sid('CA');
      const rang = await call(world, client, customer, { callSid: missed });
      assert.match(rang.body, new RegExp(`<Number>\\${SHOP}</Number>`));
      assert.match(rang.body, /action="https:\/\/arc\.example\/functions\/v1\/twilio\/dial-status"/);
      assert.equal(await leadOfCall(world, client, missed), null, 'ringing the business is not a missed call yet');

      const result = { CallSid: missed, From: customer, To: client.number, DialCallStatus: 'no-answer' };
      await world.twilio('dial-status', result);
      await world.twilio('dial-status', result);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1);

      const answered = { CallSid: sid('CA'), From: customerNumber(), To: client.number, DialCallStatus: 'completed' };
      await world.twilio('dial-status', answered);
      await world.twilio('dial-status', answered);
      await world.dispatch();
      assert.equal(world.carrier.to(answered.From).length, 0, 'nobody who was answered is texted "sorry we missed you"');
      const events = await world.events(client);
      assert.deepEqual([count(events, 'call_answered'), count(events, 'call_missed')], [1, 1]);
    });

    /* ── a webhook that failed halfway ──
       Twilio redelivers when it gets no 2xx, and a fault partway through the handler looks
       exactly like that. the message is already on record by then, so its redelivery used
       to be read as a duplicate and dropped — with whatever the message called for undone. */

    test('an opt-out whose first delivery died before the number was suppressed is finished by the redelivery', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      const stop = sid('SM');

      failOnce(world, 'addSuppression');
      assert.equal((await text(world, client, customer, 'STOP', { messageSid: stop })).status, 500, 'the provider is told to try again');
      assert.equal(await suppressed(world, client, customer), null);

      assert.equal((await text(world, client, customer, 'STOP', { messageSid: stop })).status, 200);
      assert.equal((await suppressed(world, client, customer))?.reason, 'opt_out');
      assert.equal(await stateOf(world, client, lead), 'suppressed');
      await text(world, client, customer, 'STOP', { messageSid: stop });
      await world.advance(3 * HOUR);
      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'no follow-up');
      const events = await world.events(client);
      assert.deepEqual([count(events, 'reply_received'), count(events, 'lead_suppressed')], [1, 1]);
    });

    test('an opt-out whose first delivery suppressed the number and then died still stops the run', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      const stop = sid('SM');
      failOnce(world, 'cancelPendingActions');
      assert.equal((await text(world, client, customer, 'unsubscribe', { messageSid: stop })).status, 500);
      assert.ok(await suppressed(world, client, customer), 'the most important write went first');
      assert.equal(await stateOf(world, client, lead), 'awaiting_reply');
      assert.equal((await text(world, client, customer, 'unsubscribe', { messageSid: stop })).status, 200);
      assert.equal(await stateOf(world, client, lead), 'suppressed');
    });

    test('a safety reply whose first delivery died before a person was fetched is finished by the redelivery', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      const messageSid = sid('SM');

      failOnce(world, 'scheduleAction');
      assert.equal((await text(world, client, customer, 'I can smell gas by the furnace', { messageSid })).status, 500);
      await world.dispatch();
      assert.equal(await world.store.getOpenHandoff(client.tenantId, lead.id), null);

      for (let delivered = 0; delivered < 3; delivered += 1) {
        assert.equal((await text(world, client, customer, 'I can smell gas by the furnace', { messageSid })).status, 200);
      }
      await world.dispatch();
      assert.equal((await world.store.getOpenHandoff(client.tenantId, lead.id))?.isSafety, true);
      assert.equal(world.carrier.to(client.ownerPhone).length, 1, 'told once, however many times it was redelivered');
      assert.equal(count(await world.events(client), 'reply_received'), 1);
    });

    test('an ordinary reply whose first delivery died before it was queued to be read is still read', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      const messageSid = sid('SM');

      failOnce(world, 'scheduleAction');
      assert.equal((await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid })).status, 500);
      assert.equal((await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid })).status, 200);
      await world.dispatch();
      await text(world, client, customer, 'furnace repair please, we are in 43215', { messageSid });
      await world.dispatch();

      assert.equal(await stateOf(world, client, lead), 'qualified');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.equal(world.carrier.to(customer).length, 2);
      const run = await runOf(world, client, lead);
      const pending = (await world.store.listActionsForRun(client.tenantId, run.id)).filter((action) => action.status === 'pending');
      assert.deepEqual(pending.map((action) => action.actionType), ['close_run'], 'and the lead can still close itself');
    });

    /* ── words that read like a credential ──
       the queue refuses a payload shaped like a credential (0017). the engine puts other
       people's words on the queue, so the words are withheld — never the action. */

    test('a reason that reads like a credential does not lose the handoff', async () => {
      const world = await makeWorld();
      /* a provider's own error, the way one arrives. */
      const refusal = ['401 invalid x', 'api', 'key'].join('-');
      world.classifier = () => ({ provider: 'anthropic', model: null, classify: async () => ({ ok: false, provider: 'anthropic', model: null, ms: 0, reason: refusal }) });
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'furnace repair please, we are in 43215');
      const outcomes = await world.dispatch();

      assert.ok(outcomes.every((detail) => !/violates check constraint/.test(detail.outcome)), JSON.stringify(outcomes));
      const handoff = await world.store.getOpenHandoff(client.tenantId, lead.id);
      assert.ok(handoff, 'a person has the lead');
      assert.ok(!handoff.reason.includes(refusal), 'and the words that read like a credential are not kept');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.equal(await stateOf(world, client, lead), 'handoff_required');
    });

    test('a customer whose own words read like a credential is still read and routed', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const { customer, lead } = await texted(world, client);
      const words = 'sorry to be the bearer of bad news but the furnace is dead again — furnace repair, 43215';
      assert.equal((await text(world, client, customer, words)).status, 200);
      await world.dispatch();
      assert.equal(await stateOf(world, client, lead), 'qualified');
      assert.equal(world.carrier.to(client.ownerPhone).length, 1);
      assert.deepEqual(world.invalid(), []);
    });

    /* ── a canary ── */

    test('a canary runs the whole send path and cannot reach a handset or a figure', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const before = world.canary.sent.length;
      const canary = await intakeLead(world.engine('ops-canary'), {
        tenantId: client.tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006',
        customerName: 'Arc canary', serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary', consentSms: true, consentSource: 'operator', isCanary: true,
      });
      assert.ok(canary.run, canary.outcome);
      /* the production dispatcher itself picks it up, with the live sender in its hands. */
      await world.dispatch();
      assert.equal(world.carrier.sent.length, 0, 'the live sender was never used');
      assert.equal(world.canary.sent.length, before + 1);
      const events = await world.events(client);
      assert.ok(typesOf(events, { canary: true }).includes('sms_sent'));
      assert.equal(count(events, 'sms_sent'), 0, 'and it is not a send anybody counts');
      const data = await world.dashboard(client);
      assert.equal(data.ledger.totals.total, 0);

      /* nobody can answer for one, either. */
      const answer = await world.ledger(client.owner, { action: 'outcome-answer', tenant_id: client.tenantId, lead: canary.lead.correlationId, answer: 'happened' });
      assert.deepEqual([answer.status, answer.body.code], [404, 'not_found']);
    });
  });

  describe(`one client cannot reach another — ${title}`, options, () => {
    test('a request that is not signed by the provider opens nothing', async () => {
      const world = await makeWorld();
      const client = await world.client();
      const customer = customerNumber();
      const params = { CallSid: sid('CA'), From: customer, To: client.number, CallStatus: 'ringing' };
      const forSms = await twilioSignature(AUTH_TOKEN, `${PUBLIC_BASE}/twilio/sms`, params);
      const forItsOwnHost = await twilioSignature(AUTH_TOKEN, 'https://edge-runtime.internal/twilio/voice', params);
      const forOtherWords = await twilioSignature(AUTH_TOKEN, `${PUBLIC_BASE}/twilio/voice`, { ...params, From: customerNumber() });

      for (const [why, options] of [
        ['no signature', { signature: null }],
        ['an empty one', { signature: '' }],
        ['a made-up one', { signature: 'bm90LWEtc2lnbmF0dXJl' }],
        ['one for another route', { signature: forSms }],
        ['one over the host the request arrived on', { signature: forItsOwnHost }],
        ['one for a different body', { signature: forOtherWords }],
        ['a function with no token configured', { token: '' }],
      ]) {
        const answer = await world.twilio('voice', params, options);
        assert.equal(answer.status, 403, why);
        assert.deepEqual(JSON.parse(answer.body), { error: 'invalid signature' }, `${why}: a forger is told nothing more`);
      }
      assert.equal(world.opened, 0, 'the database and the senders were never built');
      await world.dispatch();
      assert.equal(world.carrier.sent.length, 0);
      assert.equal(count(await world.events(client), 'call_missed'), 0);

      assert.equal((await world.twilio('voice', params, { method: 'GET' })).status, 405);
      assert.equal((await world.twilio('status', params)).status, 404);
      assert.deepEqual([...TWILIO_ROUTES], ['voice', 'dial-status', 'sms', 'message-status']);

      /* the same request, signed, is let in. */
      assert.equal((await world.twilio('voice', params)).status, 200);
      assert.equal(world.opened, 1);
    });

    test('the number that was called owns the request, whatever else the request says', async () => {
      const world = await makeWorld();
      const first = await world.client();
      const second = await world.client();
      const customer = customerNumber();
      const callSid = sid('CA');

      /* a signed request with another client's id pushed into every place a caller controls. */
      await world.twilio('voice', {
        CallSid: callSid, From: customer, To: second.number, CallStatus: 'ringing',
        tenant_id: first.tenantId, TenantId: first.tenantId, AccountSid: first.tenantId, ForwardedFrom: first.number,
      });
      await world.dispatch();
      assert.ok(await leadOfCall(world, second, callSid));
      assert.equal(await leadOfCall(world, first, callSid), null);
      assert.equal(count(await world.events(first), 'call_missed'), 0);
      assert.equal(count(await world.events(second), 'call_missed'), 1);

      /* the reply is routed by the number it was sent to, and the alert goes to that owner. */
      await text(world, second, customer, 'furnace repair please, we are in 43215');
      await world.dispatch();
      assert.equal(world.carrier.to(second.ownerPhone).length, 1);
      assert.equal(world.carrier.to(first.ownerPhone).length, 0);

      /* a number nobody has is answered politely and writes nothing. */
      const stray = await world.twilio('voice', { CallSid: sid('CA'), From: customer, To: arcNumber(), CallStatus: 'ringing' });
      assert.match(stray.body, /This number is not configured/);
      const unknown = await world.twilio('message-status', { MessageSid: sid('SM'), MessageStatus: 'delivered' });
      assert.equal(unknown.status, 200, 'a receipt for a message ARC never sent is nothing');
    });

    test('a test press for one client leaves another client\'s customer waiting, not answered by a test', async () => {
      const world = await makeWorld();
      const tested = await world.client();
      const other = await world.client();
      const customer = customerNumber();
      await call(world, other, customer);

      await intakeLead(world.engine('ops-canary'), {
        tenantId: tested.tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006',
        serviceRequest: 'no heat', intakeRef: 'arc-canary', consentSms: true, consentSource: 'operator', isCanary: true,
      });
      const summary = await runDueActions(world.engine('ops-canary'), { tenantId: tested.tenantId, canaryOnly: true, worker: 'ops-canary', limit: 25 });
      assert.equal(summary.claimed, 1);
      assert.equal(world.carrier.to(customer).length, 0);
      assert.equal(world.canary.to(customer).length, 0, 'a real customer was not sent a test');

      await world.dispatch();
      assert.equal(world.carrier.to(customer).length, 1, 'the real dispatcher still sends it');
    });

    test('the owner\'s door: who is asking comes from the sign-in, and another client\'s member finds nothing', async () => {
      const world = await makeWorld();
      const mine = await world.client();
      const theirs = await world.client();
      const { lead } = await texted(world, mine);
      const visit = new Date(world.now().getTime() + DAY).toISOString();
      const book = (userId, tenantId, extra = {}) => world.ledger(userId, { action: 'visit-booked', tenant_id: tenantId, lead: lead.correlationId, appointment_at: visit, ...extra });

      const nobody = await book(null, mine.tenantId);
      assert.deepEqual([nobody.status, nobody.body.code], [401, 'unauthorized']);
      const stranger = await book(theirs.owner, mine.tenantId, { user_id: mine.owner, role: 'owner', actor: mine.owner });
      assert.deepEqual([stranger.status, stranger.body.code], [403, 'forbidden'], 'a body cannot claim a client');
      const noSuchClient = await book(theirs.owner, crypto.randomUUID());
      assert.deepEqual([noSuchClient.status, noSuchClient.body.code], [403, 'forbidden'], 'the same answer whether or not the client exists');
      assert.equal(world.ledgerOpened, 0, 'none of them got as far as the engine');

      const wrongLead = await book(theirs.owner, theirs.tenantId);
      assert.deepEqual([wrongLead.status, wrongLead.body.code], [404, 'not_found'], 'another client\'s lead is not found under your own');
      assert.equal(count(await world.events(mine), 'lead_booked'), 0);
      assert.equal(count(await world.events(theirs), 'lead_booked'), 0);
      assert.equal((await world.store.getLead(mine.tenantId, lead.id)).bookingOutcome, null);

      /* the member it does belong to, with a body that lies about who they are. */
      const real = await book(mine.owner, mine.tenantId, { answered_by: 'operator', recorded_by: theirs.owner, user_id: theirs.owner });
      assert.equal(real.status, 200);
      const [booked] = (await world.events(mine)).filter((event) => event.eventType === 'lead_booked');
      assert.equal(booked.payload.recorded_by, mine.owner);
    });

    test('the owner\'s door refuses what it does not understand before reading anything', async () => {
      const world = await makeWorld();
      const client = await world.client();
      for (const [body, status] of [
        ['not json', 400],
        ['[]', 400],
        [{ action: 'delete-everything', tenant_id: client.tenantId }, 400],
        [{ action: 'outcome-answer' }, 422],
        [{ action: 'outcome-answer', tenant_id: 'halstead' }, 422],
        [JSON.stringify({ action: 'outcome-asked', tenant_id: client.tenantId, leads: ['x'.repeat(MAX_BODY_BYTES)] }), 413],
      ]) {
        assert.equal((await world.ledger(client.owner, body)).status, status, JSON.stringify(body).slice(0, 60));
      }
      assert.equal(world.ledgerOpened, 0);
      assert.deepEqual((await world.ledger(client.owner, { action: 'capabilities' })).body.actions, [...LEDGER_ACTIONS]);
      assert.deepEqual([...LEDGER_ACTIONS], ['outcome-answer', 'outcome-asked', 'visit-booked']);
    });

    test('staff can answer too, and the question cannot be opened before there are terms to open it under', async () => {
      const world = await makeWorld();
      const client = await world.client({ role: 'staff' });
      const { customer, lead } = await texted(world, client);
      await text(world, client, customer, 'furnace repair please, we are in 43215');
      await world.dispatch();
      const visit = new Date(world.now().getTime() + HOUR).toISOString();
      assert.equal((await world.ledger(client.owner, { action: 'visit-booked', tenant_id: client.tenantId, lead: lead.correlationId, appointment_at: visit })).status, 200);
      await world.advance(DAY);

      const noTerms = await world.ledger(client.owner, { action: 'outcome-asked', tenant_id: client.tenantId, leads: [lead.correlationId] });
      assert.deepEqual([noTerms.status, noTerms.body.asked], [200, 0], 'no terms on record: the dispute window cannot start');
      assert.equal((await world.dashboard(client)).ledger.month.feeCents, null, 'and the fee is not a number yet — never a zero');

      await recordPilotTerms(world.engine('ops'), { tenantId: client.tenantId, input: TERMS, actorId: world.operator });
      const asked = await world.ledger(client.owner, { action: 'outcome-asked', tenant_id: client.tenantId, leads: [lead.correlationId, lead.correlationId] });
      assert.equal(asked.body.asked, 1);
      const dispute = await world.ledger(client.owner, { action: 'outcome-answer', tenant_id: client.tenantId, lead: lead.correlationId, answer: 'did_not_happen' });
      assert.deepEqual([dispute.status, dispute.body.outcome], [200, 'not_counted']);
      const data = await world.dashboard(client);
      assert.equal(data.threads.find((thread) => thread.id === lead.correlationId).ledger.status, 'disputed');
      assert.equal(data.ledger.month.billed, 0, 'a job the owner says did not happen is not billed');
    });
  });
}

gate('in memory', memoryWorld);
gate('on real Postgres, through the production adapter', sqlWorld, { skip });

/* ── what only the database can prove ───────────────────── */

describe('what a signed-in browser can reach, asked of real Postgres', { skip }, () => {
  /* two clients, each with a lead that was texted and answered. */
  async function pair() {
    const world = await sqlWorld();
    const mine = await world.client();
    const theirs = await world.client();
    const a = await texted(world, mine);
    const b = await texted(world, theirs);
    await text(world, mine, a.customer, 'furnace repair please, we are in 43215');
    await text(world, theirs, b.customer, 'STOP');
    await world.dispatch();
    return { world, db: world.db, mine, theirs };
  }
  const as = (db, sub, sql, params = []) => asRole(db, { role: sub ? 'authenticated' : 'anon', sub }, async (tx) => await tx.query(sql, params));

  test('a member reads their own client\'s rows and none of anyone else\'s', async () => {
    const { db, mine, theirs } = await pair();
    for (const table of ['events', 'leads', 'conversations', 'messages', 'automation_runs', 'handoffs', 'suppressions']) {
      const { rows } = await as(db, mine.owner, `select tenant_id, count(*)::int as n from public.${table} group by tenant_id`);
      assert.ok(rows.every((row) => row.tenant_id === mine.tenantId), `${table}: another client's rows were readable`);
    }
    const own = await as(db, mine.owner, 'select count(*)::int as n from public.leads where not is_canary');
    assert.equal(own.rows[0].n, 1);
    const stop = await as(db, theirs.owner, 'select count(*)::int as n from public.suppressions');
    assert.equal(stop.rows[0].n, 1, 'the other client reads their own opt-out');
    const theirStop = await as(db, mine.owner, 'select count(*)::int as n from public.suppressions');
    assert.equal(theirStop.rows[0].n, 0);
  });

  test('nobody signed in as a client can see the queue, a send attempt or a configuration snapshot', async () => {
    const { db, mine } = await pair();
    for (const table of ['scheduled_actions', 'lead_recovery_effect_attempts', 'lead_recovery_config_snapshots', 'automation_action_attempts']) {
      const visible = await as(db, mine.owner, `select count(*)::int as n from public.${table}`);
      assert.equal(visible.rows[0].n, 0, table);
      const really = await db.query(`select count(*)::int as n from public.${table} where tenant_id = $1`, [mine.tenantId]);
      assert.ok(really.rows[0].n > 0, `${table} does hold rows for this client`);
    }
  });

  test('somebody who is not signed in reads nothing at all', async () => {
    const { db } = await pair();
    for (const table of ['events', 'leads', 'messages', 'suppressions', 'handoffs', 'tenant_members', 'tenants']) {
      const outcome = await as(db, null, `select count(*)::int as n from public.${table}`).then((result) => result.rows[0].n, () => 0);
      assert.equal(outcome, 0, table);
    }
  });

  test('a browser can write none of it — not a lead, not an event, not its own opt-out', async () => {
    const { db, mine } = await pair();
    const { rows: [lead] } = await db.query('select id, correlation_id from public.leads where tenant_id = $1', [mine.tenantId]);
    const writes = [
      [`insert into public.events (tenant_id, event_type, occurred_at, event_key, status, payload) values ($1, 'lead_booked', now(), 'forged', 'success', '{}'::jsonb)`, [mine.tenantId]],
      [`insert into public.leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual')`, [mine.tenantId]],
      [`insert into public.suppressions (tenant_id, channel, address, reason, source) values ($1, 'sms', '+16145550199', 'opt_out', 'customer')`, [mine.tenantId]],
      [`update public.leads set booking_outcome = 'booked' where id = $1`, [lead.id]],
      [`update public.automation_runs set state = 'booked' where tenant_id = $1`, [mine.tenantId]],
      [`delete from public.suppressions where tenant_id = $1`, [mine.tenantId]],
      [`delete from public.handoffs where tenant_id = $1`, [mine.tenantId]],
      [`update public.scheduled_actions set status = 'cancelled' where tenant_id = $1`, [mine.tenantId]],
      /* the log itself. for a browser this is row level security; for the service role
         nothing in the schema stops it — see ARC_LEAD_RECOVERY_READINESS.md, section 7.4. */
      [`update public.events set status = 'failure' where tenant_id = $1`, [mine.tenantId]],
      [`delete from public.events where tenant_id = $1`, [mine.tenantId]],
    ];
    for (const [sql, params] of writes) {
      const changed = await as(db, mine.owner, sql, params).then((result) => result.affectedRows ?? 0, () => 0);
      assert.equal(changed, 0, sql);
    }
  });

  test('a browser cannot call the worker\'s functions', async () => {
    const { db, mine } = await pair();
    for (const call of [
      `select * from public.claim_scheduled_actions_global(10, 'browser', 120)`,
      `select * from public.claim_tenant_scheduled_actions('${mine.tenantId}', 10, 'browser', 120, false)`,
      `select public.complete_scheduled_action(gen_random_uuid(), '${mine.tenantId}', gen_random_uuid(), 'done', null)`,
      `select * from public.reserve_lead_recovery_effect('${mine.tenantId}', 'forged', 'customer_sms', 'forged', 'browser', gen_random_uuid(), null, null, null, null, null, false)`,
    ]) {
      for (const sub of [mine.owner, null]) {
        await assert.rejects(as(db, sub, call), /permission denied/, call);
      }
    }
  });

  test('the owner\'s own dashboard, read through row level security alone, holds their client and nothing else', async () => {
    const { world, mine, theirs } = await pair();
    const events = await world.events(mine, { as: mine.owner });
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.tenantId === mine.tenantId));
    const data = await world.dashboard(mine, { as: mine.owner });
    assert.equal(data.ledger.totals.total, 1);
    const other = await world.dashboard(theirs, { as: theirs.owner });
    assert.equal(other.threads.length, 1);
    assert.notEqual(other.threads[0].id, data.threads[0].id);
  });
});

/* ── the gate itself ────────────────────────────────────── */

describe('the gate', () => {
  test('is only the gate when it ran on real SQL', () => {
    if (process.env.ARC_GATE !== 'sql') return;
    assert.ok(pglite, `ARC_GATE=sql, but ${SKIP_REASON}`);
  });
});

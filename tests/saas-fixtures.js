/* a self-service business taken from sign-up to live, on real SQL (ARC SaaS foundation).
 *
 * The same steps `tests/saas-journey-db.test.js` walks, in pieces, so a suite can stop at
 * the stage it is about. Every provider is a double: `RecordingSender` for the carrier,
 * `FakeClassifier` for the model, and a Stripe snapshot written by the same SQL function
 * the webhook calls. Nothing here proves a real delivery.
 */

import { restClient } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { leadRecoveryConfig } from './config-fixtures.js';
import { REQUIRED_STEPS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { selectModule, beginTesting, recordTestResult, activateModule } from '../supabase/functions/_shared/lifecycle/engine.ts';
import { intakeLead, runDueActions } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';

export const OWNER = 'aaaaaaaa-0000-4000-8000-000000000011';
export const OTHER_OWNER = 'cccccccc-0000-4000-8000-000000000033';
export const OPERATOR = 'bbbbbbbb-0000-4000-8000-000000000022';
export const NOW = new Date('2026-09-16T14:00:00Z');
export const ARC_NUMBER = '+16145550770';

export const BUSINESS = Object.freeze({
  name: 'Fictional Glassworks', timezone: 'America/Denver', trade: 'Window cleaning',
  services: 'Window cleaning', area: '80202', days: 'Monday-Friday', open: '08:00', close: '17:00',
  alerts: 'Inbox only', ownerPhone: '',
});
export const DRAFT = Object.freeze({
  kind: 'inbound', name: 'New Lead Response', source: 'form', audience: 'inquiry', channel: 'sms',
  message: 'Hi, this is {{business}}. Thanks for reaching out. Reply STOP to opt out.', questions: [],
  cooldown: 24, delay: 1, followupHours: 24, maxContacts: 2,
});

/** One statement as a signed-in user, under RLS. */
export async function asUser(db, user, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    await tx.query('set local role authenticated');
    return (await tx.query(sql, params)).rows[0];
  });
}

export async function seedPeople(db) {
  await db.query('insert into auth.users (id,email) values ($1,$2),($3,$4),($5,$6)', [
    OWNER, 'owner@fictional-glassworks.test', OPERATOR, 'operator@example.test', OTHER_OWNER, 'owner@fictional-screens.test',
  ]);
  await db.query('insert into arc_admins (user_id) values ($1)', [OPERATOR]);
}

/** Sign-up: the owner's own call creates the business. */
export async function signUp(db, user = OWNER, name = BUSINESS.name) {
  return (await asUser(db, user, 'select public.self_service_create_business($1,$2) as id', [name, 'America/Denver'])).id;
}

export async function saveSetup(db, tenantId, user = OWNER) {
  await asUser(db, user, 'select public.self_service_save_setup($1,1,$2::jsonb,1::smallint)', [tenantId, JSON.stringify(BUSINESS)]);
}

export async function saveDraft(db, tenantId, user = OWNER) {
  return (await asUser(db, user, 'select public.self_service_save_campaign($1,null,0,$2::jsonb) as id', [tenantId, JSON.stringify(DRAFT)])).id;
}

/** The engine's dependencies over real SQL, with recording senders. */
export function engineFor(db) {
  const store = supabaseStore(restClient(db));
  const live = new RecordingSender();
  const canary = new RecordingSender();
  const deps = {
    store, now: () => NOW, liveSender: live, canarySender: canary,
    classifierFor: () => new FakeClassifier({ confidence: 0.95, service_type: 'window cleaning', zip: '80202' }),
    urls: { statusCallback: 'https://example.test/status' }, uuid: () => crypto.randomUUID(), worker: 'saas-fixture',
  };
  return { store, deps, live, canary };
}

const operator = { type: 'operator', id: OPERATOR };
const stateVersion = async (store, tenantId) => (await store.getLifecycle(tenantId, 'lead_recovery'))?.stateVersion ?? 0;

/** The operator's part, up to but not including the test: published configuration, module selected. */
export async function operatorConfigures(db, engine, tenantId) {
  const { store } = engine;
  const base = leadRecoveryConfig({
    company_name: BUSINESS.name, timezone: BUSINESS.timezone, services: ['window cleaning'],
    service_area: { zips: ['80202'], cities: [], note: null },
    twilio: { ...leadRecoveryConfig().twilio, phone_number: ARC_NUMBER },
  });
  const published = await publishEffectiveConfig(store, {
    tenantId, moduleKey: 'lead_recovery', config: base,
    expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: OPERATOR },
  });
  if (!published.ok) throw new Error(`fixture: publish failed: ${published.message}`);
  const selected = await selectModule(store, { tenantId, moduleKey: 'lead_recovery', actor: operator, expectedStateVersion: await stateVersion(store, tenantId) });
  if (!selected.ok) throw new Error(`fixture: select failed: ${selected.message}`);
}

/** Tick the activation checklist's required steps, or only the ones named. */
export async function tickSteps(db, tenantId, steps = REQUIRED_STEPS) {
  for (const step of steps) {
    await db.query(
      "insert into module_onboarding (tenant_id,module_key,step_key,done_at) values ($1,'lead_recovery',$2,now()) on conflict (tenant_id,module_key,step_key) do update set done_at=now()",
      [tenantId, step],
    );
  }
}

/** A synthetic lead run end to end and recorded as the module's passing test. */
export async function operatorTests(db, engine, tenantId) {
  const { store, deps } = engine;
  const begun = await beginTesting(store, { tenantId, moduleKey: 'lead_recovery', actor: operator, expectedStateVersion: await stateVersion(store, tenantId) });
  if (!begun.ok) throw new Error(`fixture: begin testing failed: ${begun.message}`);
  const check = await intakeLead(deps, {
    tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006',
    serviceRequest: 'window cleaning', consentSms: true, consentSource: 'operator', isCanary: true,
  });
  await runDueActions(deps, { tenantId, canaryOnly: true, worker: 'saas-fixture', limit: 10 });
  const recorded = await recordTestResult(store, {
    tenantId, moduleKey: 'lead_recovery', actor: operator, expectedStateVersion: await stateVersion(store, tenantId),
    runId: check.run.id, passed: true,
  });
  if (!recorded.ok) throw new Error(`fixture: record test failed: ${recorded.message}`);
}

export async function operatorActivates(db, engine, tenantId) {
  const { store } = engine;
  const activated = await activateModule(store, { tenantId, moduleKey: 'lead_recovery', actor: operator, expectedStateVersion: await stateVersion(store, tenantId) });
  if (!activated.ok) throw new Error(`fixture: activate failed: ${activated.message}`);
}

let serial = 0;
/**
 * What the Stripe webhook stores, through the function it calls (0031). `observedAt` is when
 * ARC read the subscription from Stripe, which is what orders two snapshots.
 */
export async function subscriptionSnapshot(db, tenantId, {
  status = 'active', cap = 10, customer = 'cus_FixtureOne', subscription = 'sub_FixtureOne',
  start = "now() - interval '1 day'", end = "now() + interval '30 days'", observedAt = 'now()',
  eventId = `evt_Fixture${++serial}`, type = 'customer.subscription.updated',
} = {}) {
  await db.query('select public.saas_bind_stripe_customer($1,$2)', [tenantId, customer]);
  return (await db.query(
    `select public.saas_apply_stripe_subscription($1,$2,$3,$4,'price_FixturePlan',$5,${start},${end},false,$6,${observedAt}) as applied`,
    [eventId, type, customer, subscription, status, cap],
  )).rows[0].applied;
}

/** Sign-up to live, with a paid subscription. Returns the ids and the engine. */
export async function liveBusiness(db, { cap = 10 } = {}) {
  await seedPeople(db);
  const tenantId = await signUp(db);
  await saveSetup(db, tenantId);
  await saveDraft(db, tenantId);
  const engine = engineFor(db);
  await operatorConfigures(db, engine, tenantId);
  await tickSteps(db, tenantId);
  await operatorTests(db, engine, tenantId);
  await operatorActivates(db, engine, tenantId);
  await subscriptionSnapshot(db, tenantId, { cap });
  return { tenantId, ...engine };
}

/** A real (not synthetic) website inquiry with recorded permission. */
export async function inquiry(engine, tenantId, phone, ref = `web:${crypto.randomUUID()}`) {
  return await intakeLead(engine.deps, {
    tenantId, source: 'web_form', externalRef: ref, phone, customerName: 'Robin',
    serviceRequest: 'window cleaning at 80202', zip: '80202', consentSms: true, consentSource: 'web_form',
    permissionEvidence: { disclosure_version: 'sms-inquiry-v1', affirmative: true, source: 'embedded_form' },
  });
}

export const dispatch = (engine, tenantId) => runDueActions(engine.deps, { tenantId, worker: 'saas-fixture', limit: 10 });

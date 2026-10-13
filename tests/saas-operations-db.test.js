/* the subscription gate, the emergency stop and readiness, on real SQL (0031, 0033).
 *
 * Each of these lives only in Postgres — `MemoryStore` has none of them — so they are proven
 * here, through the real `supabaseStore` and the engine's own dispatcher. Providers are
 * doubles (see tests/saas-fixtures.js): a text "sent" below reached a recording sender.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { handlePlatformAction, usageFlag } from '../supabase/functions/ops/platform.ts';
import { intakeLead, sendOwnerReply, takeOverLead } from '../supabase/functions/_shared/engine/runtime.ts';
import {
  OPERATOR, OTHER_OWNER, OWNER, asUser, dispatch, engineFor, inquiry, liveBusiness, operatorActivates,
  operatorConfigures, operatorTests, saveDraft, saveSetup, seedPeople, signUp, subscriptionSnapshot, tickSteps,
} from './saas-fixtures.js';

const skip = await loadPglite() ? false : SKIP_REASON;

const sentTo = (engine, phone) => engine.live.sent.filter((message) => message.to === phone).length;
const count = async (db, sql, params) => (await db.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n;
const handoffs = (db, tenantId, leadId) => count(db, 'handoffs where tenant_id=$1 and lead_id=$2', [tenantId, leadId]);
const usage = (db, tenantId) => count(db, 'saas_usage_actions where tenant_id=$1', [tenantId]);
let n = 0;
const phone = () => `+1614555${String(4000 + ++n)}`;

describe('a subscription decides whether a self-service business may send', { skip }, () => {
  test('every state but active and trialing keeps the inquiry and sends nothing', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
        await subscriptionSnapshot(db, tenantId, { status });
        const to = phone();
        const lead = await inquiry(engine, tenantId, to);
        assert.equal(lead.created, true, `${status}: the inquiry is still recorded`);
        await dispatch(engine, tenantId);
        assert.equal(sentTo(engine, to), 0, `${status}: no text`);
        assert.ok(await handoffs(db, tenantId, lead.lead.id) >= 1, `${status}: a person is asked to look`);
      }
      assert.equal(await usage(db, tenantId), 0, 'a refused send is not counted as used');

      for (const status of ['trialing', 'active']) {
        await subscriptionSnapshot(db, tenantId, { status });
        const to = phone();
        await inquiry(engine, tenantId, to);
        await dispatch(engine, tenantId);
        assert.equal(sentTo(engine, to), 1, `${status}: the first text goes`);
      }
      /* the earlier lead's follow-up may be due by now and is a message like any other: what
         is held is one unit for each text that left, never one for a refusal. */
      assert.ok(engine.live.sent.length >= 2);
      assert.equal(await usage(db, tenantId), engine.live.sent.length);
    } finally { await db.close(); }
  });

  test('a paid period that has ended sends nothing, whatever the status still says', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      await subscriptionSnapshot(db, tenantId, { status: 'active', start: "now() - interval '40 days'", end: "now() - interval '1 day'" });
      const to = phone();
      await inquiry(engine, tenantId, to);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, to), 0);
    } finally { await db.close(); }
  });

  test('a late event cannot roll back a newer reading, and a repeated one changes nothing', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId } = await liveBusiness(db);
      const status = async () => (await db.query('select status from saas_billing_accounts where tenant_id=$1', [tenantId])).rows[0].status;

      assert.equal(await subscriptionSnapshot(db, tenantId, { status: 'canceled', eventId: 'evt_Newer', observedAt: "now() + interval '1 minute'" }), true);
      /* an older reading arriving afterwards is recorded as received, and applied to nothing. */
      assert.equal(await subscriptionSnapshot(db, tenantId, { status: 'active', eventId: 'evt_Older', observedAt: "now() - interval '1 hour'" }), true);
      assert.equal(await status(), 'canceled');

      assert.equal(await subscriptionSnapshot(db, tenantId, { status: 'active', eventId: 'evt_Newer', observedAt: "now() + interval '5 minutes'" }), false,
        'the same event id is one change');
      assert.equal(await status(), 'canceled');
      assert.equal(await count(db, "saas_stripe_events where tenant_id=$1 and event_id in ('evt_Newer','evt_Older')", [tenantId]), 2);
    } finally { await db.close(); }
  });

  test('a snapshot for a customer nobody bound, or with a status Stripe does not have, is refused', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId } = await liveBusiness(db);
      const apply = (customer, status) => db.query(
        `select public.saas_apply_stripe_subscription('evt_Refused1','customer.subscription.updated',$1,'sub_FixtureOne','price_FixturePlan',$2,now()-interval '1 day',now()+interval '30 days',false,10,now())`,
        [customer, status]);
      await assert.rejects(apply('cus_Stranger', 'active'), /unknown_customer/);
      await assert.rejects(apply('cus_FixtureOne', 'comped'), /invalid_snapshot/);
      await assert.rejects(db.query('select public.saas_bind_stripe_customer($1,$2)', [tenantId, 'not-a-customer']), /invalid_customer/);
      /* the first binding is kept; a second checkout cannot move the business to another customer. */
      assert.equal((await db.query('select public.saas_bind_stripe_customer($1,$2) as c', [tenantId, 'cus_SecondAttempt'])).rows[0].c, 'cus_FixtureOne');
    } finally { await db.close(); }
  });

  test('the cap is a ceiling: one unit per message, the same message never twice, nothing past it', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db, { cap: 2 });
      const first = phone(); const second = phone(); const third = phone();
      await inquiry(engine, tenantId, first);
      await inquiry(engine, tenantId, second);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.deepEqual([sentTo(engine, first), sentTo(engine, second)], [1, 1]);
      assert.equal(await usage(db, tenantId), 2);

      const over = await inquiry(engine, tenantId, third);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, third), 0, 'the third message is past the cap');
      assert.equal(await usage(db, tenantId), 2, 'and the count did not move');
      assert.ok(await handoffs(db, tenantId, over.lead.id) >= 1, 'the inquiry is kept and put in front of the owner');

      /* an owner cannot write their own usage or subscription. */
      await assert.rejects(asUser(db, OWNER, 'delete from saas_usage_actions where tenant_id=$1', [tenantId]), /permission denied/);
      await assert.rejects(asUser(db, OWNER, "update saas_billing_accounts set status='active', action_cap=100000 where tenant_id=$1", [tenantId]), /permission denied/);
      /* and reads only their own. */
      const other = await signUp(db, OTHER_OWNER, 'Fictional Screens');
      assert.equal((await asUser(db, OTHER_OWNER, 'select count(*)::int as n from saas_usage_actions')).n, 0);
      assert.equal((await asUser(db, OTHER_OWNER, 'select count(*)::int as n from saas_billing_accounts where tenant_id=$1', [tenantId])).n, 0);
      assert.equal((await asUser(db, OTHER_OWNER, 'select count(*)::int as n from saas_billing_accounts where tenant_id=$1', [other])).n, 1);
    } finally { await db.close(); }
  });
});

describe('the emergency stop', { skip }, () => {
  const stop = (db, actor, stopped, reason) => db.query('select public.set_platform_sending_stop($1,$2,$3) as state', [actor, stopped, reason]);

  test('only an operator may use it, and stopping needs a reason', async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      await assert.rejects(stop(db, OWNER, true, 'carrier incident'), /forbidden/);
      await assert.rejects(stop(db, null, true, 'carrier incident'), /forbidden/);
      await assert.rejects(stop(db, OPERATOR, true, ''), /say why/);
      await assert.rejects(stop(db, OPERATOR, null, 'x'), /invalid/);
      /* nobody signed in to the browser can write the row, or call the function, directly. */
      await assert.rejects(asUser(db, OWNER, 'update platform_controls set sending_stopped=true, reason=$1', ['mine']), /permission denied/);
      await assert.rejects(asUser(db, OWNER, 'select public.set_platform_sending_stop($1,true,$2)', [OWNER, 'mine']), /permission denied/);
      assert.equal((await asUser(db, OWNER, 'select count(*)::int as n from platform_controls')).n, 0, 'an owner cannot read it either');

      const state = (await stop(db, OPERATOR, true, 'carrier incident')).rows[0].state;
      assert.equal(state.sending_stopped, true);
      assert.equal(state.reason, 'carrier incident');
      await stop(db, OPERATOR, true, 'carrier incident');
      await stop(db, OPERATOR, false, null);
      const audit = (await db.query("select action from admin_actions where target_type='platform'")).rows.map((r) => r.action);
      assert.deepEqual(audit.sort(), ['platform.sending_resumed', 'platform.sending_stopped'], 'one audit row per change, none for a repeat');
    } finally { await db.close(); }
  });

  test('while it is on nothing real is sent, every inquiry is kept, and resuming flushes nothing', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      const before = phone();
      await inquiry(engine, tenantId, before);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, before), 1, 'sending works before the stop');

      await stop(db, OPERATOR, true, 'carrier incident');
      const during = phone();
      const held = await inquiry(engine, tenantId, during);
      assert.equal(held.created, true, 'the inquiry is still recorded');
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, during), 0);
      assert.ok(await handoffs(db, tenantId, held.lead.id) >= 1, 'the lead is put in front of a person');
      assert.equal(await count(db, "events where tenant_id=$1 and event_type='lead_received' and not is_canary", [tenantId]), 2, 'evidence is still written');
      const sentBeforeResume = engine.live.sent.length;

      await stop(db, OPERATOR, false, 'carrier recovered');
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(engine.live.sent.length, sentBeforeResume, 'nothing queued during the stop goes out afterwards');
      assert.equal(sentTo(engine, during), 0);

      const after = phone();
      await inquiry(engine, tenantId, after);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, after), 1, 'a new inquiry after the stop is answered');
    } finally { await db.close(); }
  });

  test('a synthetic check still runs while it is on', async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      const tenantId = await signUp(db);
      const engine = engineFor(db);
      await operatorConfigures(db, engine, tenantId);
      await tickSteps(db, tenantId);
      await stop(db, OPERATOR, true, 'carrier incident');
      await operatorTests(db, engine, tenantId);
      assert.ok(engine.canary.sent.length >= 1, 'the canary reached its own recording sender');
      assert.equal(engine.live.sent.length, 0);
    } finally { await db.close(); }
  });
});

describe("an owner's own pause", { skip }, () => {
  const pause = (db, user, tenantId, paused) => asUser(db, user, 'select public.self_service_set_sending_pause($1,$2) as state', [tenantId, paused]);

  test('while it is on no customer is texted, the lead is kept and handed over, and resuming flushes nothing', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      assert.equal((await pause(db, OWNER, tenantId, true)).state.paused, true);

      const during = phone();
      const held = await inquiry(engine, tenantId, during);
      assert.equal(held.created, true);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, during), 0, 'the customer is not texted');
      assert.ok(await handoffs(db, tenantId, held.lead.id) >= 1, 'the lead is in front of the owner');
      /* the owner is still told: the alert is a text to staff, which the pause does not stop,
         and it is the only thing that was sent or counted. */
      const counted = (await db.query('select effect_type from saas_usage_actions where tenant_id=$1', [tenantId])).rows.map((r) => r.effect_type);
      assert.deepEqual(counted, ['staff_sms']);
      assert.equal(engine.live.sent.length, 1);
      assert.notEqual(engine.live.sent[0].to, during);
      const sentWhilePaused = engine.live.sent.length;

      assert.equal((await pause(db, OWNER, tenantId, false)).state.paused, false);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(engine.live.sent.length, sentWhilePaused, 'nothing held during the pause goes out afterwards');

      const after = phone();
      await inquiry(engine, tenantId, after);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, after), 1, 'a new inquiry after resuming is answered');
    } finally { await db.close(); }
  });

  test('it is the owner’s alone, it is recorded once per change, and it is not the module’s lifecycle', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      await signUp(db, OTHER_OWNER, 'Fictional Screens');
      await assert.rejects(pause(db, OTHER_OWNER, tenantId, true), /forbidden/);
      await assert.rejects(pause(db, OPERATOR, tenantId, true), /forbidden/, 'an operator pauses the module, not this');
      await assert.rejects(pause(db, OWNER, tenantId, null), /invalid/);
      await assert.rejects(asUser(db, OWNER, 'update owner_sending_pauses set paused=true where tenant_id=$1', [tenantId]), /permission denied/);

      await pause(db, OWNER, tenantId, true);
      await pause(db, OWNER, tenantId, true);
      await pause(db, OWNER, tenantId, false);
      const audit = (await db.query("select action from admin_actions where action like 'owner.sending_%' and target_id=$1", [tenantId])).rows.map((r) => r.action).sort();
      assert.deepEqual(audit, ['owner.sending_paused', 'owner.sending_resumed']);
      assert.equal((await asUser(db, OTHER_OWNER, 'select count(*)::int as n from owner_sending_pauses')).n, 0, 'another business cannot read it');

      await pause(db, OWNER, tenantId, true);
      const lifecycle = await engine.store.getLifecycle(tenantId, 'lead_recovery');
      assert.equal(lifecycle.state, 'active', 'the operator’s decision is untouched');
    } finally { await db.close(); }
  });
});

describe('an owner pausing one campaign (0036)', { skip }, () => {
  const pauseCampaign = (db, user, tenantId, kind, paused) =>
    asUser(db, user, 'select public.self_service_set_campaign_pause($1,$2,$3) as state', [tenantId, kind, paused]);
  const pauseAll = (db, user, tenantId, paused) => asUser(db, user, 'select public.self_service_set_sending_pause($1,$2) as state', [tenantId, paused]);
  const missedCall = (engine, tenantId, from) => intakeLead(engine.deps, {
    tenantId, source: 'missed_call', externalRef: `call:${crypto.randomUUID()}`, phone: from, consentSms: true, consentSource: 'inbound_call',
  });
  /* the fixture's two recording senders count from one each, so a live text and the test
     canary's can be handed the same provider id — and a message row is keyed on it. a real
     carrier's ids are unique; here the live sender's are made so. */
  const uniqueIds = (engine) => {
    const send = engine.live.send.bind(engine.live);
    engine.live.send = async (args) => ({ ...(await send(args)), sid: `SMlive${crypto.randomUUID().replaceAll('-', '')}` });
  };

  test('website inquiries are paused and missed calls are not: one is handed to the owner, the other is texted', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      assert.deepEqual((await pauseCampaign(db, OWNER, tenantId, 'inbound', true)).state.paused, true);

      const form = phone();
      const held = await inquiry(engine, tenantId, form);
      const caller = phone();
      await missedCall(engine, tenantId, caller);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);

      assert.equal(sentTo(engine, form), 0, 'the website inquiry is not texted');
      /* at least once: this fixture's engine clock is fixed, so the caller's check-in is due too. */
      assert.ok(sentTo(engine, caller) >= 1, 'the missed caller is, as usual');
      const [handoff] = (await db.query('select reason from handoffs where tenant_id=$1 and lead_id=$2', [tenantId, held.lead.id])).rows;
      assert.match(handoff.reason, /This campaign is paused, so no automatic reply was sent/, 'the paused lead is in front of the owner, with why');
      /* the owner is told about the lead they will have to answer: a staff text, not stopped. */
      const counted = (await db.query('select distinct effect_type from saas_usage_actions where tenant_id=$1 order by effect_type', [tenantId])).rows.map((r) => r.effect_type);
      assert.deepEqual(counted, ['customer_sms', 'staff_sms']);

      /* resuming sends nothing that was held, because nothing was held. */
      assert.equal((await pauseCampaign(db, OWNER, tenantId, 'inbound', false)).state.paused, false);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, form), 0);
      const after = phone();
      await inquiry(engine, tenantId, after);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, after), 1, 'a new website inquiry after resuming is answered');
    } finally { await db.close(); }
  });

  test('neither pause stops the owner’s own words: a text they wrote after taking the lead over still goes', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      uniqueIds(engine);
      await pauseCampaign(db, OWNER, tenantId, 'inbound', true);
      await pauseAll(db, OWNER, tenantId, true);

      const customer = phone();
      const { lead } = await inquiry(engine, tenantId, customer);
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, customer), 0, 'ARC texts nobody while paused');

      assert.equal((await takeOverLead(engine.deps, { tenantId, leadId: lead.id, actor: OWNER })).ok, true);
      const queued = await sendOwnerReply(engine.deps, { tenantId, leadId: lead.id, body: 'This is Robin from Fictional Glassworks. I can call you at 4.', actorId: OWNER, requestKey: crypto.randomUUID() });
      assert.deepEqual(queued, { ok: true, outcome: 'queued' });
      await dispatch(engine, tenantId);

      const [mine] = engine.live.sent.filter((message) => message.to === customer);
      /* the first text this customer has had from the number, so it carries the opt-out line. */
      assert.equal(mine.body, 'This is Robin from Fictional Glassworks. I can call you at 4. Reply STOP to opt out.');
      assert.equal(sentTo(engine, customer), 1);
      const [row] = (await db.query('select author_user_id, status, direction from messages where tenant_id=$1 and author_user_id is not null', [tenantId])).rows;
      assert.deepEqual([row.author_user_id, row.direction], [OWNER, 'outbound']);
      /* it is a text through ARC's number: it counts against the period like any other. */
      const counted = (await db.query("select count(*)::int as n from saas_usage_actions where tenant_id=$1 and effect_type='owner_sms'", [tenantId])).rows[0].n;
      assert.equal(counted, 1);
    } finally { await db.close(); }
  });

  test('the emergency stop does stop the owner’s own text, and they are shown why', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      uniqueIds(engine);
      const customer = phone();
      const { lead } = await inquiry(engine, tenantId, customer);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, customer), 1);
      await takeOverLead(engine.deps, { tenantId, leadId: lead.id, actor: OWNER });
      await sendOwnerReply(engine.deps, { tenantId, leadId: lead.id, body: 'On my way', actorId: OWNER, requestKey: crypto.randomUUID() });

      await db.query('select public.set_platform_sending_stop($1,true,$2)', [OPERATOR, 'carrier incident']);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, customer), 1, 'nothing more reaches the handset');
      const [row] = (await db.query('select status, error_detail, body from messages where tenant_id=$1 and author_user_id is not null', [tenantId])).rows;
      assert.deepEqual([row.status, row.body], ['failed', 'On my way']);
      assert.match(row.error_detail, /ARC has paused all texting/);
    } finally { await db.close(); }
  });

  test('it is the owner’s alone, one kind at a time, and recorded once per change', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      await signUp(db, OTHER_OWNER, 'Fictional Screens');
      await assert.rejects(pauseCampaign(db, OTHER_OWNER, tenantId, 'missed', true), /forbidden/);
      await assert.rejects(pauseCampaign(db, OPERATOR, tenantId, 'missed', true), /forbidden/, 'an operator pauses the module, not this');
      await assert.rejects(pauseCampaign(db, OWNER, tenantId, 'followup', true), /cannot be paused/);
      await assert.rejects(pauseCampaign(db, OWNER, tenantId, 'missed', null), /invalid/);
      await assert.rejects(asUser(db, OWNER, "insert into owner_campaign_pauses (tenant_id, kind, paused) values ($1,'missed',true)", [tenantId]), /permission denied/);

      await pauseCampaign(db, OWNER, tenantId, 'missed', true);
      await pauseCampaign(db, OWNER, tenantId, 'missed', true);
      await pauseCampaign(db, OWNER, tenantId, 'missed', false);
      const audit = (await db.query("select action, metadata->>'kind' as kind from admin_actions where action like 'owner.campaign_%' and target_id=$1 order by action", [tenantId])).rows;
      assert.deepEqual(audit, [{ action: 'owner.campaign_paused', kind: 'missed' }, { action: 'owner.campaign_resumed', kind: 'missed' }]);
      assert.equal((await asUser(db, OTHER_OWNER, 'select count(*)::int as n from owner_campaign_pauses')).n, 0, 'another business cannot read it');
      assert.deepEqual((await asUser(db, OWNER, 'select kind, paused from owner_campaign_pauses where tenant_id=$1', [tenantId])), { kind: 'missed', paused: false });

      /* a paused missed-call campaign leaves the form campaign alone, and the module's state too. */
      await pauseCampaign(db, OWNER, tenantId, 'missed', true);
      const form = phone();
      await inquiry(engine, tenantId, form);
      await dispatch(engine, tenantId);
      assert.equal(sentTo(engine, form), 1);
      assert.equal((await engine.store.getLifecycle(tenantId, 'lead_recovery')).state, 'active');
    } finally { await db.close(); }
  });
});

describe("the operator's platform actions", { skip }, () => {
  const call = (db, action, body = {}, actorId = OPERATOR) => handlePlatformAction(action, { db: restClient(db), body, actorId });

  test('stop and resume go through the same guarded function, and say what is wrong with a bad request', async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      assert.deepEqual((await call(db, 'platform-sending-status')).body.sending.sending_stopped, false);
      assert.equal((await call(db, 'platform-sending-stop', { stopped: 'yes' })).status, 422);
      assert.equal((await call(db, 'platform-sending-stop', { stopped: true, reason: ' ' })).status, 422);
      assert.equal((await call(db, 'platform-sending-stop', { stopped: true, reason: 'carrier incident' }, OWNER)).status, 403,
        'the database refuses an actor who is not an operator, whatever reached the function');

      const stopped = await call(db, 'platform-sending-stop', { stopped: true, reason: 'carrier incident' });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.sending.sending_stopped, true);
      const status = (await call(db, 'platform-sending-status')).body.sending;
      assert.deepEqual([status.sending_stopped, status.reason, status.changed_by], [true, 'carrier incident', OPERATOR]);
      assert.equal((await call(db, 'platform-sending-stop', { stopped: false })).body.sending.sending_stopped, false);
      assert.equal((await call(db, 'platform-nonsense')).status, 400);
    } finally { await db.close(); }
  });

  test('the self-signup list shows each business where it stands, and no customer in it', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db, { cap: 5 });
      await signUp(db, OTHER_OWNER, 'Fictional Screens');
      const to = phone();
      await inquiry(engine, tenantId, to);
      await dispatch(engine, tenantId);

      const { body } = await call(db, 'platform-self-service');
      assert.equal(body.businesses.length, 2);
      const live = body.businesses.find((b) => b.tenant_id === tenantId);
      assert.equal(live.name, 'Fictional Glassworks');
      assert.equal(live.setup.details_complete, true);
      assert.deepEqual(live.campaign_drafts.map((d) => d.kind), ['inbound']);
      assert.equal(live.module.state, 'active');
      assert.equal(live.subscription.status, 'active');
      assert.deepEqual(live.usage, { used: 1, cap: 5, flag: 'none' });

      const fresh = body.businesses.find((b) => b.tenant_id !== tenantId);
      assert.deepEqual([fresh.setup.details_complete, fresh.module.state, fresh.subscription.status, fresh.usage.used],
        [false, 'unselected', 'none', null], 'an unknown figure is null, never zero');
      assert.equal(JSON.stringify(body).includes(to), false, "no customer's number is on the list");
    } finally { await db.close(); }
  });

  test('usage is flagged before it runs out', () => {
    assert.equal(usageFlag(null, null), 'none');
    assert.equal(usageFlag(0, 10), 'none');
    assert.equal(usageFlag(7, 10), 'none');
    assert.equal(usageFlag(8, 10), 'near_cap');
    assert.equal(usageFlag(10, 10), 'at_cap');
    assert.equal(usageFlag(12, 10), 'at_cap');
  });
});

describe('readiness is read off what is true', { skip }, () => {
  const read = async (db, user, tenantId) => (await asUser(db, user, 'select public.self_service_readiness($1) as r', [tenantId])).r;
  const codes = (r) => Object.fromEntries(['configuration', 'source', 'sender', 'test', 'subscription', 'active'].map((k) => [k, r[k].code]));

  test('each check turns true only when its own evidence exists, in order', async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      const tenantId = await signUp(db);
      const stage = async () => codes(await read(db, OWNER, tenantId));

      assert.deepEqual(await stage(), {
        configuration: 'business_details_missing', source: 'no_form', sender: 'not_started',
        test: 'not_run', subscription: 'none', active: 'not_active',
      }, 'an account existing proves nothing');

      await saveSetup(db, tenantId);
      assert.equal((await stage()).configuration, 'no_campaign');
      await saveDraft(db, tenantId);
      assert.equal((await stage()).configuration, 'complete');

      await asUser(db, OWNER, 'select public.self_service_configure_form($1,$2)', [tenantId, 'https://fictional-glassworks.example']);
      assert.equal((await stage()).source, 'awaiting_first_inquiry', 'a form key is not a verified source');
      await db.query('update intake_keys set last_used_at=now() where tenant_id=$1', [tenantId]);
      assert.equal((await stage()).source, 'verified');

      const engine = engineFor(db);
      await operatorConfigures(db, engine, tenantId);
      assert.equal((await stage()).sender, 'pending_review');
      assert.equal((await read(db, OWNER, tenantId)).routing.code, 'not_tested');
      await tickSteps(db, tenantId, ['twilio_connected', 'compliance_approved']);
      assert.deepEqual([(await stage()).sender, (await read(db, OWNER, tenantId)).routing.code], ['ready', 'not_tested'],
        'an approved number is not a tested phone line');
      await tickSteps(db, tenantId);
      assert.deepEqual((await read(db, OWNER, tenantId)).routing, { ok: true, code: 'tested' });
      assert.equal((await stage()).test, 'not_run');

      await operatorTests(db, engine, tenantId);
      assert.deepEqual([(await stage()).test, (await stage()).active], ['passed', 'not_active'], 'a passed test is not live');
      await operatorActivates(db, engine, tenantId);
      assert.deepEqual([(await stage()).active, (await stage()).subscription], ['active', 'none'], 'live in the lifecycle, and still no subscription');

      await subscriptionSnapshot(db, tenantId, { cap: 1 });
      const ready = await read(db, OWNER, tenantId);
      assert.ok(Object.values(codes(ready)).every((code) => ['complete', 'verified', 'ready', 'passed', 'eligible', 'active'].includes(code)));
      assert.ok(['configuration', 'source', 'sender', 'test', 'subscription', 'active'].every((k) => ready[k].ok === true));
      assert.deepEqual(ready.usage, { used: 0, cap: 1 });

      await inquiry(engine, tenantId, phone());
      await dispatch(engine, tenantId);
      const capped = await read(db, OWNER, tenantId);
      assert.deepEqual([capped.subscription.code, capped.subscription.ok, capped.usage.used], ['usage_cap', false, 1]);

      await subscriptionSnapshot(db, tenantId, { status: 'past_due', cap: 5 });
      assert.equal((await stage()).subscription, 'past_due');

      await db.query('select public.set_platform_sending_stop($1,true,$2)', [OPERATOR, 'carrier incident']);
      assert.equal((await stage()).active, 'sending_stopped');
    } finally { await db.close(); }
  });

  test("an owner reads only their own; an operator may read any; a stranger's attempt says nothing", async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      const mine = await signUp(db);
      const theirs = await signUp(db, OTHER_OWNER, 'Fictional Screens');
      await assert.rejects(read(db, OWNER, theirs), /forbidden/);
      await assert.rejects(read(db, OTHER_OWNER, mine), /forbidden/);
      assert.equal((await read(db, OPERATOR, mine)).configuration.code, 'business_details_missing');
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query('set local role anon');
        return tx.query('select public.self_service_readiness($1)', [mine]);
      }), /permission denied/);
    } finally { await db.close(); }
  });
});

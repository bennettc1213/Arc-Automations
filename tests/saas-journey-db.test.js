import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { leadRecoveryConfig } from './config-fixtures.js';
import { REQUIRED_STEPS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { selectModule, beginTesting, recordTestResult, activateModule } from '../supabase/functions/_shared/lifecycle/engine.ts';
import { intakeLead, runDueActions, handleInboundMessage, takeOverLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import { productionState } from '../src/portal/product/production.js';

const skip = await loadPglite() ? false : SKIP_REASON;
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000011';
const OPERATOR = 'bbbbbbbb-0000-4000-8000-000000000022';
const NOW = new Date('2026-09-16T14:00:00Z');

async function ownerCall(db, sql, params) {
  return db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER]);
    await tx.query('set local role authenticated');
    return (await tx.query(sql, params)).rows[0];
  });
}

describe('first fictional customer journey with simulated providers', { skip }, () => {
  test('account → saved setup and draft → approved config → inquiry → response → reply → handoff → portal record', async () => {
    const db = await freshDatabase();
    try {
      await db.query('insert into auth.users (id,email) values ($1,$2),($3,$4)',
        [OWNER, 'owner@fictional-glassworks.test', OPERATOR, 'operator@example.test']);
      await db.query('insert into arc_admins (user_id) values ($1)', [OPERATOR]);
      const tenantId = (await ownerCall(db,
        'select public.self_service_create_business($1,$2) as id', ['Fictional Glassworks', 'America/Denver'])).id;
      const business = { name: 'Fictional Glassworks', timezone: 'America/Denver', trade: 'Window cleaning',
        services: 'Window cleaning', area: '80202', days: 'Monday-Friday', open: '08:00', close: '17:00',
        alerts: 'Inbox only', ownerPhone: '' };
      await ownerCall(db, 'select public.self_service_save_setup($1,1,$2::jsonb,1::smallint)', [tenantId, JSON.stringify(business)]);
      const draft = { kind: 'inbound', name: 'New Lead Response', source: 'form', audience: 'inquiry', channel: 'sms',
        message: 'Hi, this is {{business}}. Thanks for reaching out. Reply STOP to opt out.', questions: [],
        cooldown: 24, delay: 1, followupHours: 24, maxContacts: 2 };
      await ownerCall(db, 'select public.self_service_save_campaign($1,null,0,$2::jsonb)', [tenantId, JSON.stringify(draft)]);
      const saved = (await db.query('select * from tenant_setup_answers where tenant_id=$1', [tenantId])).rows[0];
      const proposal = (await db.query('select config from customer_campaign_drafts where tenant_id=$1', [tenantId])).rows[0].config;
      assert.equal(saved.services[0], 'Window cleaning');
      assert.equal(proposal.name, 'New Lead Response');

      // Founder review is explicit. A saved draft cannot activate the module by itself.
      const store = supabaseStore(restClient(db));
      const base = leadRecoveryConfig({ company_name: business.name, timezone: business.timezone,
        services: saved.services.map(service => service.toLowerCase()),
        service_area: { zips: saved.service_area, cities: [], note: null },
        twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145550770' } });
      const config = { ...base, templates: { ...base.templates,
        first_response: proposal.message.replace('{{business}}', '{{company}}') } };
      const published = await publishEffectiveConfig(store, { tenantId, moduleKey: 'lead_recovery', config,
        expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: OPERATOR } });
      assert.equal(published.ok, true, published.message);
      const actor = { type: 'operator', id: OPERATOR };
      const version = async () => (await store.getLifecycle(tenantId, 'lead_recovery'))?.stateVersion ?? 0;
      assert.equal((await selectModule(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await version() })).ok, true);
      for (const step of REQUIRED_STEPS) await db.query(
        "insert into module_onboarding (tenant_id,module_key,step_key,done_at) values ($1,'lead_recovery',$2,now()) on conflict (tenant_id,module_key,step_key) do update set done_at=now()",
        [tenantId, step]);
      assert.equal((await beginTesting(store, { tenantId, moduleKey: 'lead_recovery', actor, expectedStateVersion: await version() })).ok, true);
      const live = new RecordingSender();
      const canary = new RecordingSender();
      const deps = { store, now: () => NOW, liveSender: live, canarySender: canary,
        classifierFor: () => new FakeClassifier({ confidence: 0.95, service_type: 'window cleaning', zip: '80202' }),
        urls: { statusCallback: 'https://example.test/status' }, uuid: () => crypto.randomUUID(), worker: 'journey-simulator' };
      const check = await intakeLead(deps, { tenantId, source: 'web_form', externalRef: 'canary:journey',
        phone: '+15005550006', serviceRequest: 'window cleaning', consentSms: true,
        consentSource: 'operator', isCanary: true });
      await runDueActions(deps, { tenantId, canaryOnly: true, worker: 'journey-simulator', limit: 10 });
      assert.equal((await recordTestResult(store, { tenantId, moduleKey: 'lead_recovery', actor,
        expectedStateVersion: await version(), runId: check.run.id, passed: true })).ok, true);
      assert.equal((await activateModule(store, { tenantId, moduleKey: 'lead_recovery', actor,
        expectedStateVersion: await version() })).ok, true);

      // Simulated Stripe webhook snapshot, committed by the trusted server before live sends.
      await db.query('select public.saas_bind_stripe_customer($1,$2)', [tenantId, 'cus_JourneyTest1']);
      await db.query(`select public.saas_apply_stripe_subscription(
        'evt_JourneyTest1','customer.subscription.created','cus_JourneyTest1',
        'sub_JourneyTest1','price_JourneyTest1','active',
        now()-interval '1 day',now()+interval '30 days',false,10,now())`);

      const intake = await intakeLead(deps, { tenantId, source: 'web_form', externalRef: 'web:journey-1',
        phone: '+16145559924', customerName: 'Robin', serviceRequest: 'window cleaning at 80202', zip: '80202',
        consentSms: true, consentSource: 'web_form',
        permissionEvidence: { disclosure_version: 'sms-inquiry-v1', affirmative: true, source: 'embedded_form' } });
      assert.equal(intake.ok, true, intake.outcome);
      await runDueActions(deps, { tenantId, worker: 'journey-simulator', limit: 10 });
      assert.equal(live.sent.filter(message => message.to === '+16145559924').length, 1);
      await handleInboundMessage(deps, { tenantId, from: '+16145559924', to: '+16145550770',
        body: 'Window cleaning at 80202 this week', providerMessageId: 'SMjourney-reply' });
      await runDueActions(deps, { tenantId, worker: 'journey-simulator', limit: 10 });
      await runDueActions(deps, { tenantId, worker: 'journey-simulator', limit: 10 });
      assert.equal((await db.query("select count(*)::int as n from events where tenant_id=$1 and event_type='lead_qualified'", [tenantId])).rows[0].n, 1);
      assert.equal((await takeOverLead(deps, { tenantId, leadId: intake.lead.id, actor: 'owner' })).ok, true);
      const before = live.sent.length;
      await runDueActions(deps, { tenantId, worker: 'journey-simulator', limit: 10 });
      assert.equal(live.sent.length, before);

      const runtime = {};
      for (const table of ['leads','conversations','messages','handoffs'])
        runtime[table] = (await db.query(`select * from ${table} where tenant_id=$1`, [tenantId])).rows.map(row =>
          Object.fromEntries(Object.entries(row).map(([key,value]) => [key, value instanceof Date ? value.toISOString() : value])));
      const state = productionState({ tenant: { id: tenantId, name: business.name, timezone: business.timezone },
        generatedFor: NOW.toISOString(), threads: [], leadRecovery: { available: true, ...runtime } });
      const record = state.leads.find(lead => lead.id === intake.lead.id);
      assert.ok(record);
      assert.equal(record.ownerTakeover, true);
      assert.ok(record.messages.some(message => message.author === 'Customer'));
      assert.ok(record.permission?.evidence.includes('sms-inquiry-v1'));

      const used = (await db.query('select count(*)::int as n from saas_usage_actions where tenant_id=$1', [tenantId])).rows[0].n;
      assert.ok(used >= 1);
      const period = (await db.query('select period_start,period_end from saas_billing_accounts where tenant_id=$1', [tenantId])).rows[0];
      const apply = `select public.saas_apply_stripe_subscription($1,$2,'cus_JourneyTest1',
        'sub_JourneyTest1','price_JourneyTest1',$3,$4,$5,false,$6,now()) as applied`;
      assert.equal((await db.query(apply, ['evt_JourneyCap1','customer.subscription.updated','active',
        period.period_start,period.period_end,used])).rows[0].applied, true);
      assert.equal((await db.query(apply, ['evt_JourneyCap1','customer.subscription.updated','canceled',
        period.period_start,period.period_end,100])).rows[0].applied, false);
      assert.equal((await db.query('select status from saas_billing_accounts where tenant_id=$1', [tenantId])).rows[0].status, 'active');
      const capped = await intakeLead(deps, { tenantId, source: 'web_form', externalRef: 'web:journey-capped',
        phone: '+16145559925', serviceRequest: 'window cleaning', zip: '80202', consentSms: true,
        consentSource: 'web_form' });
      assert.equal(capped.created, true);
      await runDueActions(deps, { tenantId, worker: 'journey-simulator', limit: 10 });
      assert.equal(live.sent.some(message => message.to === '+16145559925'), false);
      assert.ok((await db.query('select id from handoffs where tenant_id=$1 and lead_id=$2',
        [tenantId, capped.lead.id])).rows.length);
      assert.equal((await db.query('select count(*)::int as n from saas_usage_actions where tenant_id=$1', [tenantId])).rows[0].n, used);
    } finally { await db.close(); }
  });
});

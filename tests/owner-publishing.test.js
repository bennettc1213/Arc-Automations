/* an owner publishes their own campaign (decided 2026-10-13; 0034, _shared/campaigns/,
 * _shared/config/owner-wording.ts).
 *
 * Publishing configuration is an operator action with one exception, and these hold its
 * edge: an owner's publication can only be wording, only on their own business, only onto a
 * version ARC published, and what a customer then receives is what the owner saved. The
 * database half runs on real SQL through the real `supabaseStore`; texts "sent" reached a
 * recording sender.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import {
  ARC_NUMBER, OPERATOR, OTHER_OWNER, OWNER, asUser, dispatch, engineFor, inquiry, liveBusiness, seedPeople, signUp,
} from './saas-fixtures.js';
import { intakeLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { firstResponseKey } from '../supabase/functions/_shared/engine/templates.ts';
import { moduleScope } from '../supabase/functions/_shared/config/model.ts';
import { configHash } from '../supabase/functions/_shared/canonical-json.ts';
import {
  applyOwnerWording, OWNER_WORDING_FIELDS, OWNER_WORDING_TEMPLATES, ownerWordingImpact, ownerWordingViolations,
} from '../supabase/functions/_shared/config/owner-wording.ts';
import { publishOwnerWording } from '../supabase/functions/_shared/config/engine.ts';
import { CAMPAIGN_FIRST_TEXT, publishPlan, toEngineTemplate } from '../supabase/functions/_shared/campaigns/model.ts';
import { handleCampaignAction } from '../supabase/functions/_shared/campaigns/service.ts';
import { supabaseCampaignStore } from '../supabase/functions/_shared/campaigns/supabase-campaign-store.ts';
import { leadRecoveryConfig } from './config-fixtures.js';

const skip = await loadPglite() ? false : SKIP_REASON;
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const campaign = (overrides = {}) => ({
  kind: 'inbound', name: 'New Lead Response', source: 'form', audience: 'inquiry', channel: 'sms',
  message: 'Hi {{first_name}}, this is {{business}}. Thanks for your request, we will call you today. Reply STOP to opt out.',
  followup: '{{business}} here again. Do you still need a hand? Reply STOP to opt out.',
  questions: [{ key: 'service', text: 'What do you need?', required: true }],
  cooldown: 24, delay: 1, followupHours: 24, maxContacts: 2, afterHours: 'next_open',
  ...overrides,
});

describe("turning an owner's campaign into what ARC sends", () => {
  test('their placeholders become the engine’s, and the name keeps its comma', () => {
    assert.deepEqual(toEngineTemplate('Hi {{first_name}}, this is {{business}}.'), { ok: true, template: 'Hi{{customer_name}}, this is {{company}}.' });
    assert.deepEqual(toEngineTemplate('Thanks, {{ first_name }}! {{business}} got it.'), { ok: true, template: 'Thanks{{customer_name}}! {{company}} got it.' });
    assert.deepEqual(toEngineTemplate('This is {{business}}.'), { ok: true, template: 'This is {{company}}.' });
  });

  test('words ARC could not fill, or could not send, are refused with the reason', () => {
    const refused = (value) => { const r = toEngineTemplate(value); assert.equal(r.ok, false, String(value)); return r.problems.join(' '); };
    assert.match(refused(''), /empty/);
    assert.match(refused('We got your {{service}} request.'), /cannot fill in a first text yet/);
    assert.match(refused('Hi {{nickname}}'), /cannot fill/);
    assert.match(refused('{{first_name}}, thanks for calling {{business}}.'), /begin with a greeting/);
    assert.match(refused('Hi {business}'), /brace/);
    assert.match(refused(`This is {{business}}. ${'x'.repeat(400)}`), /the most one text can carry/);
  });

  test('a plan says what goes live and what is saved but not used', () => {
    const plan = publishPlan(campaign());
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.wording, {
      templates: {
        first_response_form: 'Hi{{customer_name}}, this is {{company}}. Thanks for your request, we will call you today. Reply STOP to opt out.',
        followup: '{{company}} here again. Do you still need a hand? Reply STOP to opt out.',
      },
      followup: { enabled: true, after_minutes: 1440 },
    });
    assert.deepEqual(plan.applied.map((line) => line.id), ['message', 'followup']);
    assert.deepEqual(plan.notApplied.map((line) => line.id), ['questions', 'delay', 'afterHours', 'limits']);
    assert.match(plan.notApplied[0].text, /does not ask questions one by one yet/);
  });

  test('a missed-call campaign writes the call text, and a single contact turns the check-in off', () => {
    const plan = publishPlan(campaign({ kind: 'missed', maxContacts: 1, followup: '' }));
    assert.equal(plan.ok, true);
    assert.deepEqual(Object.keys(plan.wording.templates), ['first_response']);
    assert.deepEqual(plan.wording.followup, { enabled: false });
    assert.match(plan.applied[1].text, /No check-in text is sent/);
  });

  test('a longer wait than ARC supports is shortened, and the plan says so', () => {
    const plan = publishPlan(campaign({ followupHours: 72 }));
    assert.equal(plan.wording.followup.after_minutes, 1440);
    assert.match(plan.applied[1].text, /shorter than you asked for/);
    assert.doesNotMatch(publishPlan(campaign()).applied[1].text, /shorter than you asked for/);
  });

  test('what cannot be published says why', () => {
    const outreach = publishPlan(campaign({ kind: 'followup' }));
    assert.equal(outreach.ok, false);
    assert.match(outreach.problems[0].text, /cannot run a check-in campaign to existing contacts yet/);
    const noCheckIn = publishPlan(campaign({ followup: '' }));
    assert.deepEqual([noCheckIn.ok, noCheckIn.problems[0].id], [false, 'followup']);
    assert.equal(publishPlan(campaign({ message: 'Your {{service}} request' })).ok, false);
    assert.equal(publishPlan({}).ok, false);
  });

  test('each kind writes a different first text, and a form lead falls back to the call text only when it has none', () => {
    assert.deepEqual({ ...CAMPAIGN_FIRST_TEXT }, { missed: 'first_response', inbound: 'first_response_form' });
    const config = leadRecoveryConfig();
    assert.equal(firstResponseKey(config, 'web_form'), 'first_response', 'a configuration from before the key existed means what it meant');
    const withForm = { ...config, templates: { ...config.templates, first_response_form: 'Thanks for your request.' } };
    assert.equal(firstResponseKey(withForm, 'web_form'), 'first_response_form');
    assert.equal(firstResponseKey(withForm, 'missed_call'), 'first_response');
  });
});

describe('what an owner may publish is a closed list', () => {
  const base = leadRecoveryConfig();

  test('wording passes; anything else is named', () => {
    const worded = applyOwnerWording(base, { templates: { first_response: 'New words from {{company}}.', first_response_form: 'Form words.' }, followup: { enabled: false } });
    assert.deepEqual(ownerWordingViolations(base, worded), []);
    assert.equal(worded.twilio, base.twilio, 'nothing else is copied or touched');

    assert.deepEqual(ownerWordingViolations(base, { ...base, twilio: { ...base.twilio, phone_number: '+16145550999' } }), ['twilio']);
    assert.deepEqual(ownerWordingViolations(base, { ...base, templates: { ...base.templates, handoff_ack: 'changed' } }), ['templates.handoff_ack']);
    assert.deepEqual(ownerWordingViolations(base, { ...base, compliance: { ...base.compliance, status: 'approved' }, services: [] }).sort(),
      JSON.stringify(base.compliance.status) === '"approved"' ? ['services'] : ['compliance', 'services']);
    const removed = { ...base }; delete removed.forwarding;
    assert.deepEqual(ownerWordingViolations(base, removed), ['forwarding']);
  });

  test('null removes the form text and nothing else can be removed', () => {
    const withForm = applyOwnerWording(base, { templates: { first_response_form: 'Form words.' } });
    const without = applyOwnerWording(withForm, { templates: { first_response_form: null } });
    assert.equal('first_response_form' in without.templates, false);
    assert.equal(applyOwnerWording(base, { templates: { handoff_ack: 'x' } }).templates.handoff_ack, base.templates.handoff_ack);
  });

  test('the retest a wording change would ask for is waived in writing, and nothing heavier can be', () => {
    const waived = ownerWordingImpact({ requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [], changed_fields: ['templates'] });
    assert.equal(waived.ok, true);
    assert.equal(waived.impact.requires_retest, false);
    assert.deepEqual(waived.impact.owner_authored, { waived: ['retest'], fields: [...OWNER_WORDING_FIELDS] });
    assert.equal(ownerWordingImpact({ requires_retest: true, requires_shadow: true, requires_reactivation: false, unknown_fields: [] }).ok, false);
    assert.equal(ownerWordingImpact({ requires_retest: false, requires_shadow: false, requires_reactivation: true, unknown_fields: [] }).ok, false);
    assert.equal(ownerWordingImpact({ requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: ['mystery'] }).ok, false);
  });

  test('0034 lists the same templates, and redefines the publish function with one clause changed', () => {
    const sql = read('supabase/migrations/0034_owner_publishing.sql');
    const listed = /v_allowed constant text\[\] := array\[([^\]]+)\]/.exec(sql)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    assert.deepEqual(listed, [...OWNER_WORDING_TEMPLATES]);
    assert.match(sql, /\(p_after - 'templates' - 'followup'\)/);
    assert.deepEqual([...OWNER_WORDING_FIELDS], ['templates', 'followup']);

    const body = (text) => {
      const start = text.indexOf('create or replace function public.publish_config_draft(');
      return text.slice(start, text.indexOf('\n$fn$;', start));
    };
    const original = body(read('supabase/migrations/0014_versioned_configuration.sql'));
    const redefined = body(sql);
    const marked = redefined
      .replace(/  -- 0034: the one clause that differs from 0014\.[^\n]*\n  -- [^\n]*\n/, '')
      .replace('  perform public.config_require_publisher(p_actor, p_scope, p_tenant, p_module_key, p_draft_id, p_change_impact);',
        '  perform public.config_require_operator(p_actor);');
    assert.equal(marked, original, 'everything but the marked clause is 0014’s');
    assert.notEqual(redefined, original);
  });
});

describe('an owner publishing on real SQL', { skip }, () => {
  const saveCampaign = async (db, tenantId, config, user = OWNER) =>
    (await asUser(db, user, 'select public.self_service_save_campaign($1,null,0,$2::jsonb) as id', [tenantId, JSON.stringify(config)])).id;
  const deps = (db, engine) => ({ config: engine.store, campaigns: supabaseCampaignStore(restClient(db)) });
  const owner = (tenantId, userId = OWNER) => ({ kind: 'client', userId, tenantId });
  const act = (db, engine, tenantId, action, body, actor = owner(tenantId)) =>
    handleCampaignAction(action, deps(db, engine), { tenantId, actor, body });
  const bodies = (engine, phone) => engine.live.sent.filter((m) => m.to === phone).map((m) => m.body);
  const moduleRow = async (db, tenantId) => (await db.query(
    "select state, pending_requirements, authorized_module_config_version_id as authorized, observed_module_config_version_id as observed from tenant_modules where tenant_id=$1 and module_key='lead_recovery'", [tenantId])).rows[0];
  const headRow = async (db, tenantId) => (await db.query(
    "select id, version, config, change_impact, published_by from module_config_versions where tenant_id=$1 and module_key='lead_recovery' order by version desc limit 1", [tenantId])).rows[0];
  let n = 0;
  const phone = () => `+1614555${String(6000 + ++n)}`;

  test('what the owner saved is what the next customer receives, and the account stays live', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db, { cap: 50 });
      const before = phone();
      await inquiry(engine, tenantId, before);
      await dispatch(engine, tenantId);
      assert.match(bodies(engine, before)[0], /sorry we missed your call/, 'before publishing, a form lead gets the default call wording');

      const id = await saveCampaign(db, tenantId, campaign());
      const preview = await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.preview.sending.live, true);
      assert.equal(preview.body.preview.samples[0].text, 'Hi, Alex, this is Fictional Glassworks. Thanks for your request, we will call you today. Reply STOP to opt out.');
      assert.equal((await headRow(db, tenantId)).version, preview.body.preview.version, 'a preview publishes nothing');

      const published = await act(db, engine, tenantId, 'campaign-publish', {
        campaign_id: id, expected_revision: preview.body.preview.revision, expected_version: preview.body.preview.version,
      });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.deepEqual([published.body.published.changed, published.body.preview.already_live], [true, true]);

      const head = await headRow(db, tenantId);
      assert.equal(head.version, preview.body.preview.version + 1);
      assert.equal(head.published_by, OWNER, 'the version is recorded as the owner’s');
      assert.deepEqual(head.change_impact.owner_authored, { waived: ['retest'], fields: ['templates', 'followup'] });
      assert.equal(head.change_impact.requires_retest, false);
      const lifecycle = await moduleRow(db, tenantId);
      assert.deepEqual([lifecycle.state, lifecycle.pending_requirements], ['active', []], 'nothing is held for a retest');
      assert.equal(lifecycle.authorized, head.id, 'the live authorisation moved to the owner’s version');
      assert.equal(await (async () => (await db.query(
        "select count(*)::int as n from admin_actions where action='config.published' and actor_user_id=$1", [OWNER])).rows[0].n)(), 1);
      const row = (await db.query('select published_revision, published_version, published_by from customer_campaign_drafts where id=$1', [id])).rows[0];
      assert.deepEqual([row.published_revision, row.published_version, row.published_by], [1, head.version, OWNER]);

      const form = phone();
      await inquiry(engine, tenantId, form);
      await dispatch(engine, tenantId);
      assert.equal(bodies(engine, form)[0], 'Hi, Robin, this is Fictional Glassworks. Thanks for your request, we will call you today. Reply STOP to opt out.');

      /* a missed call still gets the call wording: the owner published the form campaign only. */
      const caller = phone();
      await intakeLead(engine.deps, { tenantId, source: 'missed_call', externalRef: `CA${crypto.randomUUID()}`, phone: caller, intakeRef: ARC_NUMBER, consentSms: true, consentSource: 'inbound_call' });
      await dispatch(engine, tenantId);
      assert.match(bodies(engine, caller)[0], /sorry we missed your call/);
    } finally { await db.close(); }
  });

  test('publishing the same campaign again changes nothing; editing it and publishing again is the next version', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      const id = await saveCampaign(db, tenantId, campaign({ kind: 'missed', source: 'phone', maxContacts: 1, followup: '' }));
      const first = await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id });
      const body = { campaign_id: id, expected_revision: first.body.preview.revision, expected_version: first.body.preview.version };
      const one = await act(db, engine, tenantId, 'campaign-publish', body);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      assert.equal((await headRow(db, tenantId)).config.followup.enabled, false, 'a single contact turned the check-in off');

      const again = await act(db, engine, tenantId, 'campaign-publish', { ...body, expected_version: one.body.published.version });
      assert.deepEqual([again.status, again.body.published.changed, again.body.published.version], [200, false, one.body.published.version]);
      assert.equal((await headRow(db, tenantId)).version, one.body.published.version);

      /* the owner edits the saved campaign: revision 2. the old review no longer stands. */
      await asUser(db, OWNER, 'select public.self_service_save_campaign($1,$2,1,$3::jsonb)', [tenantId, id,
        JSON.stringify(campaign({ kind: 'missed', source: 'phone', maxContacts: 1, followup: '', message: 'This is {{business}}. Sorry we missed you, we will ring back. Reply STOP to opt out.' }))]);
      const stale = await act(db, engine, tenantId, 'campaign-publish', { ...body, expected_version: one.body.published.version });
      assert.deepEqual([stale.status, stale.body.code], [409, 'stale']);
      const edited = await act(db, engine, tenantId, 'campaign-publish', { campaign_id: id, expected_revision: 2, expected_version: one.body.published.version });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.published.version, one.body.published.version + 1);

      const caller = phone();
      await intakeLead(engine.deps, { tenantId, source: 'missed_call', externalRef: `CA${crypto.randomUUID()}`, phone: caller, intakeRef: ARC_NUMBER, consentSms: true, consentSource: 'inbound_call' });
      await dispatch(engine, tenantId);
      await dispatch(engine, tenantId);
      assert.deepEqual(bodies(engine, caller), ['This is Fictional Glassworks. Sorry we missed you, we will ring back. Reply STOP to opt out.'], 'one text, in the new words, and no check-in');
    } finally { await db.close(); }
  });

  test('only one campaign of a kind is the published one', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      const publish = async (id) => {
        const p = await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id });
        return act(db, engine, tenantId, 'campaign-publish', { campaign_id: id, expected_revision: p.body.preview.revision, expected_version: p.body.preview.version });
      };
      const first = await saveCampaign(db, tenantId, campaign());
      const second = await saveCampaign(db, tenantId, campaign({ message: 'This is {{business}}. We have your request. Reply STOP to opt out.' }));
      assert.equal((await publish(first)).status, 200);
      assert.equal((await publish(second)).status, 200);
      const rows = (await db.query('select id, published_revision from customer_campaign_drafts where tenant_id=$1', [tenantId])).rows;
      assert.equal(rows.find((r) => r.id === first).published_revision, null);
      assert.equal(rows.find((r) => r.id === second).published_revision, 1);
    } finally { await db.close(); }
  });

  test('an account ARC has not set up, a campaign that cannot run and a stranger are each refused', async () => {
    const db = await freshDatabase();
    try {
      await seedPeople(db);
      const tenantId = await signUp(db);
      const engine = engineFor(db);
      const id = await saveCampaign(db, tenantId, campaign());
      const early = await act(db, engine, tenantId, 'campaign-publish', { campaign_id: id, expected_revision: 1, expected_version: 0 });
      assert.deepEqual([early.status, early.body.code], [409, 'not_configured']);
      assert.equal(await (async () => (await db.query('select count(*)::int as n from module_config_versions where tenant_id=$1', [tenantId])).rows[0].n)(), 0,
        'an owner’s words never create a first version');

      const outreach = await saveCampaign(db, tenantId, { ...campaign({ kind: 'followup', source: 'existing', audience: 'incomplete' }) });
      const refused = await act(db, engine, tenantId, 'campaign-preview', { campaign_id: outreach });
      assert.deepEqual([refused.status, refused.body.code], [422, 'not_publishable']);

      const other = await signUp(db, OTHER_OWNER, 'Fictional Screens');
      assert.equal((await act(db, engine, other, 'campaign-preview', { campaign_id: id }, owner(other, OTHER_OWNER))).status, 404, 'another business cannot see this campaign');
      assert.equal((await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id }, owner(other, OTHER_OWNER))).status, 403, 'nor act as this one');
      assert.equal((await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id }, { kind: 'operator', userId: OPERATOR })).status, 403);
      assert.equal((await act(db, engine, tenantId, 'campaign-preview', { campaign_id: 'nope' })).status, 422);
    } finally { await db.close(); }
  });

  test('the database refuses an owner anything but wording, whatever the caller skipped', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      const { store } = engine;
      const scope = moduleScope('lead_recovery');
      const head = await store.getConfigHead(tenantId, scope);
      const impact = { requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: [], affected_modules: [] };

      /* a draft written straight to the store, as a caller that never asked the engine would. */
      const attempt = async (config, actorId, changeImpact = impact) => {
        const open = await store.getOpenDraft(tenantId, scope);
        if (open) await store.closeDraft({ tenantId, scope, draftId: open.id, expectedRevision: open.revision, status: 'superseded', actorId: OPERATOR });
        const draft = await store.insertDraft({ tenantId, scope, schemaKey: head.schemaKey, schemaVersion: head.schemaVersion, baseVersionId: head.id, baseVersion: head.version, config: head.config, actorId });
        const written = await store.updateDraftContent({ tenantId, scope, draftId: draft.id, expectedRevision: draft.revision, config, actorId });
        return store.publishConfigDraft({ tenantId, scope, draftId: written.id, expectedDraftRevision: written.revision, expectedHeadVersion: head.version, configHash: await configHash(config), changeImpact, actorId, note: null });
      };
      const number = { ...head.config, twilio: { ...head.config.twilio, phone_number: '+16145550999' } };
      const otherTemplate = { ...head.config, templates: { ...head.config.templates, handoff_ack: 'An owner wrote this.' } };
      const wording = { ...head.config, templates: { ...head.config.templates, first_response: 'This is {{company}}. Sorry we missed you.' } };

      await assert.rejects(attempt(number, OWNER), /an owner may publish wording only \(a setting other than wording\)/);
      await assert.rejects(attempt(otherTemplate, OWNER), /an owner may publish wording only \(a template an owner may not change\)/);
      await assert.rejects(attempt(wording, OWNER, { ...impact, requires_reactivation: true }), /an owner may publish wording only/);
      await assert.rejects(attempt(wording, OWNER, {}), /an owner may publish wording only/, 'an impact that does not say is not taken as harmless');
      await assert.rejects(attempt(wording, OTHER_OWNER), /publishing configuration is an operator action/, 'an owner of another business is a stranger here');
      assert.equal((await store.getConfigHead(tenantId, scope)).version, head.version, 'none of them published');

      /* the engine refuses the same things first, and an operator cannot use the owner's door. */
      const actor = { kind: 'client', userId: OWNER, tenantId };
      const viaEngine = await publishOwnerWording(store, { tenantId, wording: { templates: { handoff_ack: 'x' } }, expectedVersion: head.version, actor });
      assert.deepEqual([viaEngine.ok, viaEngine.code], [false, 'no_change'], 'a template outside the list is not even applied');
      assert.equal((await publishOwnerWording(store, { tenantId, wording: { templates: { first_response: 'Hi {{nickname}}' } }, expectedVersion: head.version, actor })).code, 'validation_failed');
      assert.equal((await publishOwnerWording(store, { tenantId, wording: { templates: { first_response: 'x' } }, expectedVersion: head.version + 5, actor })).code, 'publication_conflict');
      assert.equal((await publishOwnerWording(store, { tenantId, wording: { templates: { first_response: 'x' } }, expectedVersion: head.version, actor: { kind: 'operator', userId: OPERATOR } })).code, 'forbidden');
      assert.equal((await publishOwnerWording(store, { tenantId, wording: { templates: { first_response: 'x' } }, expectedVersion: head.version, actor: { kind: 'client', userId: OTHER_OWNER, tenantId: 'someone-else' } })).code, 'tenant_mismatch');

      /* and the SQL rule answers as the TypeScript one does. */
      const sqlSays = async (after) => (await db.query('select public.config_owner_wording_violation($1::jsonb,$2::jsonb) as v', [JSON.stringify(head.config), JSON.stringify(after)])).rows[0].v;
      for (const [after, expected] of [[number, false], [otherTemplate, false], [wording, true], [head.config, true]]) {
        assert.equal((await sqlSays(after)) === null, expected);
        assert.equal(ownerWordingViolations(head.config, after).length === 0, expected);
      }
      /* an operator still publishes anything, exactly as before. */
      assert.equal((await attempt(number, OPERATOR, { ...impact, requires_reactivation: true })).version, head.version + 1);
    } finally { await db.close(); }
  });

  test('on an account that is not live the words are published and wait, and the answer says so', async () => {
    const db = await freshDatabase();
    try {
      const { tenantId, ...engine } = await liveBusiness(db);
      const state = async () => (await engine.store.getLifecycle(tenantId, 'lead_recovery'));
      const { pauseModule } = await import('../supabase/functions/_shared/lifecycle/engine.ts');
      const paused = await pauseModule(engine.store, { tenantId, moduleKey: 'lead_recovery', actor: { type: 'operator', id: OPERATOR }, expectedStateVersion: (await state()).stateVersion, reason: 'test' });
      assert.equal(paused.ok, true, paused.message);

      const id = await saveCampaign(db, tenantId, campaign());
      const preview = await act(db, engine, tenantId, 'campaign-preview', { campaign_id: id });
      assert.equal(preview.body.preview.sending.live, false);
      assert.match(preview.body.preview.sending.text, /paused/);
      const published = await act(db, engine, tenantId, 'campaign-publish', { campaign_id: id, expected_revision: 1, expected_version: preview.body.preview.version });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal((await state()).state, 'paused', 'publishing never switches an account on');

      const to = phone();
      await inquiry(engine, tenantId, to);
      await dispatch(engine, tenantId);
      assert.deepEqual(bodies(engine, to), [], 'a paused account still sends nothing');
    } finally { await db.close(); }
  });
});

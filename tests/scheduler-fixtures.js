/* Shared by the suites that run the ARC-200 scheduler against real Postgres
 * (`scheduler-db`, `runner-db`): users, operators, and tenants moved through the
 * lifecycle by the real engines — never by writing the state columns directly.
 */

import assert from 'node:assert/strict';

import { restClient } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { REQUIRED_STEPS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { intakeLead, runDueActions } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { activateModule, beginTesting, pauseModule, recordTestResult, resumeModule, selectModule } from '../supabase/functions/_shared/lifecycle/engine.ts';
import { leadRecoveryConfig } from './config-fixtures.js';

export const LR = 'lead_recovery';

let counter = 0;
const uuid = (prefix) => {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};
let numbers = 6000;
const freshNumber = () => `+1614558${String(numbers++).padStart(4, '0')}`;

export async function newUser(db) {
  const id = uuid('cccccccc');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
  return id;
}
export async function newOperator(db) {
  const id = await newUser(db);
  await db.query('insert into public.arc_admins (user_id) values ($1)', [id]);
  return id;
}
export async function newMember(db, tenantId) {
  const id = await newUser(db);
  await db.query('insert into public.tenant_members (user_id, tenant_id) values ($1, $2)', [id, tenantId]);
  return id;
}

const engineDeps = (store, { live = new RecordingSender(), canary = new RecordingSender() } = {}) => ({
  store, liveSender: live, canarySender: canary, now: () => new Date(),
  classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier' }) }),
  urls: {}, uuid: () => crypto.randomUUID(), worker: 'db-test',
});

/** A tenant configured and moved through the lifecycle by the real engines. */
export async function tenant(db, operator) {
  const { rows: [row] } = await db.query(`insert into public.tenants (name, slug, status) values ('T', $1, 'active') returning id`, [`t-${uuid('bbbbbbbb')}`]);
  const tenantId = row.id;
  const lr = supabaseStore(restClient(db));
  const config = leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: freshNumber() } });
  const published = await publishEffectiveConfig(lr, {
    tenantId, moduleKey: LR, config, expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: operator },
  });
  assert.equal(published.ok, true, published.message);
  const actor = { type: 'operator', id: operator };
  const at = async () => (await lr.getLifecycle(tenantId, LR))?.stateVersion ?? 0;
  const req = async () => ({ tenantId, moduleKey: LR, actor, expectedStateVersion: await at() });
  const must = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message} ${JSON.stringify(r.blockers ?? [])}`); return r.result; };
  let canaryRun = null;
  const t = {
    tenantId, lr, req, must,
    async underTest() {
      must(await selectModule(lr, await req()), 'select');
      for (const step of REQUIRED_STEPS) {
        await db.query(
          `insert into module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, 'lead_recovery', $2, now())
           on conflict (tenant_id, module_key, step_key) do update set done_at = now()`, [tenantId, step]);
      }
      must(await beginTesting(lr, await req()), 'begin testing');
      const d = engineDeps(lr);
      const intake = await intakeLead(d, {
        tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006', customerName: 'Arc canary',
        serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary', consentSms: true, consentSource: 'operator', isCanary: true,
      });
      await runDueActions(d, { tenantId, canaryOnly: true, worker: 'db-canary', limit: 10 });
      canaryRun = intake.run;
    },
    async live() {
      await t.underTest();
      must(await recordTestResult(lr, { ...(await req()), runId: canaryRun.id, passed: true }), 'record test');
      must(await activateModule(lr, await req()), 'activate');
    },
    async pause() { must(await pauseModule(lr, await req()), 'pause'); },
    async resume() { must(await resumeModule(lr, await req()), 'resume'); },
    get canaryRun() { return canaryRun; },
    /** the snapshot every run of this tenant is pinned to: the tested, authorised versions. */
    async snapshot() {
      return (await db.query('select config_snapshot_id from automation_runs where id = $1', [canaryRun.id])).rows[0].config_snapshot_id;
    },
  };
  return t;
}

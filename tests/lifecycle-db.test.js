/* ARC-120 — the database's half of the module lifecycle, against real Postgres.
 *
 * Two parts, as for 0014:
 *
 *   1. The text of 0015, always: no browser write policy, no browser execute grant,
 *      forward-only, and the backfill written down where it happens.
 *   2. The migration APPLIED, when PGlite is available (tests/pglite-harness.js): the
 *      conservative backfill over a real 0014 database, every structural rule by a
 *      statement that should succeed or be refused, RLS as the roles a browser holds,
 *      append-only history and evidence even for the service role, optimistic locking and
 *      idempotency in the one function, and the two just-in-time checks the database makes
 *      itself — a live run cannot be inserted, and a live effect cannot be reserved, unless
 *      the lifecycle allows it in that transaction.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshDatabase, loadPglite, refused, restClient, asRole, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { publishEffectiveConfig } from '../supabase/functions/_shared/config/engine.ts';
import { REQUIRED_STEPS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { intakeLead, runDueActions } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import {
  activateModule,
  beginTesting,
  deselectModule,
  enterShadow,
  pauseModule,
  recordShadowReview,
  recordTestResult,
  reportHealth,
  resumeModule,
  selectModule,
} from '../supabase/functions/_shared/lifecycle/engine.ts';
import { reconcileConfigChange } from '../supabase/functions/_shared/lifecycle/impact.ts';
import { expandedTransitionRules } from '../supabase/functions/_shared/lifecycle/model.ts';
import { classifyRecordedImpact } from '../supabase/functions/_shared/lifecycle/policy.ts';
import { leadRecoveryConfig } from './config-fixtures.js';

const SQL = readFileSync(new URL('../supabase/migrations/0015_tenant_module_lifecycle.sql', import.meta.url), 'utf8');
const LR = 'lead_recovery';

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0015 as written', () => {
  test('no browser role is given a write policy on any lifecycle table', () => {
    assert.doesNotMatch(SQL, /create policy [a-z_]+ on public\.(tenant_modules|tenant_module_transitions|tenant_module_evidence|lifecycle_transition_rules)\s+for (insert|update|delete|all)/i);
    for (const table of ['tenant_modules', 'tenant_module_transitions', 'tenant_module_evidence', 'lifecycle_transition_rules']) {
      assert.match(SQL, new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    }
  });

  test('the transition function and the reservation are the service role\'s alone', () => {
    assert.match(SQL, /revoke all on function public\.apply_tenant_module_transition\([^)]*\)\s+from public, anon, authenticated/);
    assert.match(SQL, /grant execute on function public\.apply_tenant_module_transition\([^)]*\)\s+to service_role/);
    assert.match(SQL, /revoke all on function public\.reserve_lead_recovery_effect\([^)]*\)\s+from public, anon, authenticated/);
    assert.doesNotMatch(SQL, /grant execute on function [^;]* to (anon|authenticated)/);
  });

  test('forward-only: nothing is dropped but triggers being replaced by name', () => {
    const drops = [...SQL.matchAll(/^\s*drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => d === 'trigger' || d === 'policy'), `unexpected drop: ${drops.join(', ')}`);
    assert.doesNotMatch(SQL, /\btruncate\b|\bdelete from\b/i);
  });

  test('the backfill never activates: switched-on rows become paused, and the switch is turned off', () => {
    assert.match(SQL, /case when h\.enabled then 'paused' else 'configuring' end/);
    assert.match(SQL, /array\['retest', 'review', 'reactivation'\]/);
    assert.match(SQL, /update public\.module_configs mc\s+set enabled = false/);
    assert.doesNotMatch(SQL, /insert into public\.tenant_modules[\s\S]{0,400}'active'/, 'no backfill writes active');
  });

  test('the new run guard is named to fire after the pin guard', () => {
    assert.ok('automation_runs_guard_snapshot' < 'automation_runs_lifecycle_guard');
    assert.ok('scheduled_actions_guard_snapshot' < 'scheduled_actions_lifecycle_guard');
  });
});

/* ══ 2. the database ══════════════════════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let counter = 0;
const uuid = (prefix = 'aaaaaaaa') => {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};
let numbers = 3000;
const freshNumber = () => `+1614557${String(numbers++).padStart(4, '0')}`;

async function newTenant(db, name = 'Tenant') {
  const { rows } = await db.query(`insert into public.tenants (name, slug, status) values ($1, $2, 'active') returning id`, [name, `t-${uuid('bbbbbbbb')}`]);
  return rows[0].id;
}
async function newUser(db) {
  const id = uuid('cccccccc');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
  return id;
}
async function newOperator(db) {
  const id = await newUser(db);
  await db.query('insert into public.arc_admins (user_id) values ($1)', [id]);
  return id;
}
async function newMember(db, tenantId) {
  const id = await newUser(db);
  await db.query('insert into public.tenant_members (user_id, tenant_id) values ($1, $2)', [id, tenantId]);
  return id;
}
async function onboard(db, tenantId) {
  for (const step of REQUIRED_STEPS) {
    await db.query(
      `insert into module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, 'lead_recovery', $2, now())
       on conflict (tenant_id, module_key, step_key) do update set done_at = now()`,
      [tenantId, step],
    );
  }
}

const deps = (store, { live = new RecordingSender(), canary = new RecordingSender() } = {}) => ({
  store, liveSender: live, canarySender: canary, now: () => new Date(),
  classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier' }) }),
  urls: {}, uuid: () => crypto.randomUUID(), worker: 'db-test',
});

/** A tenant configured through the real engine, with a lifecycle helper bound to it. */
async function tenant(db, operator, config = leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: freshNumber() } })) {
  const tenantId = await newTenant(db);
  const store = supabaseStore(restClient(db));
  const published = await publishEffectiveConfig(store, {
    tenantId, moduleKey: LR, config, expected: { tenant: 0, module: 0 }, actor: { kind: 'operator', userId: operator },
  });
  assert.equal(published.ok, true, published.message);
  const actor = { type: 'operator', id: operator };
  const at = async () => (await store.getLifecycle(tenantId, LR))?.stateVersion ?? 0;
  const req = async (extra = {}) => ({ tenantId, moduleKey: LR, actor, expectedStateVersion: await at(), ...extra });
  const must = (r, what) => { assert.equal(r.ok, true, `${what}: ${r.code} ${r.message} ${JSON.stringify(r.blockers ?? [])}`); return r.result; };
  const canary = async () => {
    const d = deps(store);
    const intake = await intakeLead(d, {
      tenantId, source: 'web_form', externalRef: `canary:${crypto.randomUUID()}`, phone: '+15005550006', customerName: 'Arc canary',
      serviceRequest: 'no heat upstairs', intakeRef: 'arc-canary', consentSms: true, consentSource: 'operator', isCanary: true,
    });
    await runDueActions(d, { tenantId, canaryOnly: true, worker: 'db-canary', limit: 10 });
    return intake.run;
  };
  const underTest = async () => {
    must(await selectModule(store, await req()), 'select');
    await onboard(db, tenantId);
    must(await beginTesting(store, await req()), 'begin testing');
  };
  const passTest = async () => must(await recordTestResult(store, { ...(await req()), runId: (await canary()).id, passed: true }), 'record test');
  const live = async () => {
    await underTest();
    await passTest();
    return must(await activateModule(store, await req()), 'activate');
  };
  const publish = async (patch) => {
    const heads = await Promise.all([store.getConfigHead(tenantId, { kind: 'tenant' }), store.getConfigHead(tenantId, { kind: 'module', moduleKey: LR })]);
    const result = await publishEffectiveConfig(store, {
      tenantId, moduleKey: LR, config: { ...heads[1].config, ...heads[0].config, ...patch },
      expected: { tenant: heads[0].version, module: heads[1].version }, actor: { kind: 'operator', userId: operator },
    });
    assert.equal(result.ok, true, result.message);
    return result;
  };
  const lifecycle = async () => (await db.query('select * from tenant_modules where tenant_id = $1', [tenantId])).rows[0];
  return { tenantId, store, actor, req, must, canary, underTest, passTest, live, publish, lifecycle, config };
}

describe('the backfill, over a real 0014 database', { skip }, () => {
  let db;
  let on;
  let off;
  let none;
  before(async () => {
    db = await freshDatabase({
      before: async (d, file) => {
        if (!file.startsWith('0015')) return;
        /* the world as 0014 left it: one client switched on, one configured and off, one with nothing. */
        const make = async (slug) => (await d.query(`insert into tenants (name, slug, status) values ($1, $1, 'active') returning id`, [slug])).rows[0].id;
        on = await make('legacy-on');
        off = await make('legacy-off');
        none = await make('legacy-none');
        await d.query(`insert into module_configs (tenant_id, module_key, enabled) values ($1, 'lead_recovery', true), ($2, 'lead_recovery', false)`, [on, off]);
        await d.query(`insert into module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, 'lead_recovery', 'canary_passed', now())`, [on]);
      },
    });
  });

  test('switched on becomes paused and needs retest, review and reactivation; switched off becomes configuring; nothing else is selected', async () => {
    const { rows } = await db.query('select tenant_id, state, state_version, pending_requirements, authorized_tenant_config_version_id from tenant_modules order by state');
    const byTenant = Object.fromEntries(rows.map((r) => [r.tenant_id, r]));
    assert.equal(byTenant[on].state, 'paused');
    assert.deepEqual(byTenant[on].pending_requirements, ['retest', 'review', 'reactivation']);
    assert.equal(byTenant[on].authorized_tenant_config_version_id, null, 'no authorisation is invented');
    assert.equal(byTenant[off].state, 'configuring');
    assert.equal(byTenant[none], undefined);
    assert.ok(rows.every((r) => r.state !== 'active'));
  });

  test('every backfilled lifecycle has its history row, by the system, with the evidence it was based on', async () => {
    const { rows } = await db.query('select tenant_id, transition, from_state, to_state, actor_type, actor_id, reason_code, metadata from tenant_module_transitions order by tenant_id');
    const on_ = rows.find((r) => r.tenant_id === on);
    assert.equal(on_.transition, 'backfill_paused');
    assert.equal(on_.actor_type, 'system');
    assert.equal(on_.actor_id, null);
    assert.equal(on_.reason_code, 'legacy_activation_unbound');
    assert.equal(on_.metadata.legacy_enabled, true);
    assert.deepEqual(on_.metadata.legacy_steps_done, ['canary_passed']);
    assert.equal(rows.find((r) => r.tenant_id === off).transition, 'backfill_selected');
  });

  test('no legacy switch is left on, and nobody was contacted', async () => {
    const { rows } = await db.query('select count(*)::int as n from module_configs where enabled');
    assert.equal(rows[0].n, 0);
    const { rows: effects } = await db.query('select count(*)::int as n from lead_recovery_effect_attempts');
    assert.equal(effects[0].n, 0);
  });

  test('re-applying 0015 changes nothing', async () => {
    const before = (await db.query('select count(*)::int as n from tenant_module_transitions')).rows[0].n;
    await db.exec(SQL);
    assert.equal((await db.query('select count(*)::int as n from tenant_module_transitions')).rows[0].n, before);
    assert.equal((await db.query('select count(*)::int as n from tenant_modules')).rows[0].n, 2);
  });
});

describe('the rules, as Postgres holds them', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('the seeded rules are exactly the typed policy', async () => {
    const { rows } = await db.query('select transition, from_state, to_state, actor_type from lifecycle_transition_rules');
    assert.deepEqual(
      rows.map((r) => `${r.transition}|${r.from_state}|${r.to_state}|${r.actor_type}`).sort(),
      expandedTransitionRules().map((r) => `${r.transition}|${r.from}|${r.to}|${r.actor}`).sort(),
    );
    assert.match(await refused(db, `update lifecycle_transition_rules set to_state = 'active' where transition = 'pause'`), /reviewed code and a migration/);
  });

  test('Postgres classifies a recorded impact exactly as the service does', async () => {
    const cases = [
      [{ requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: [] }, 'module'],
      [{ requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [] }, 'module'],
      [{ requires_retest: true, requires_shadow: true, requires_reactivation: true, unknown_fields: [] }, 'module'],
      [{ requires_retest: true, requires_shadow: false, requires_reactivation: true, unknown_fields: [] }, 'module'],
      [{ requires_retest: false, requires_shadow: false, requires_reactivation: false, unknown_fields: ['x'] }, 'module'],
      [{}, 'module'],
      [{ requires_retest: 'yes' }, 'module'],
      [{ requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [], affected_modules: ['lead_recovery'] }, 'tenant'],
      [{ requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [], affected_modules: [] }, 'tenant'],
      [{ requires_retest: true, requires_shadow: false, requires_reactivation: false, unknown_fields: [] }, 'tenant'],
    ];
    for (const [impact, scope] of cases) {
      const { rows } = await db.query('select lifecycle_impact_classes($1::jsonb, $2, $3) as c', [JSON.stringify(impact), scope, LR]);
      assert.deepEqual(rows[0].c, classifyRecordedImpact(impact, { scope, moduleKey: LR }), JSON.stringify({ impact, scope }));
    }
  });

  test('a lifecycle cannot name another tenant\'s versions, a requirement nobody defined, or a module the registry lacks', async () => {
    const a = await tenant(db, operator);
    const b = await tenant(db, operator);
    await a.underTest();
    const { rows: [theirs] } = await db.query('select id from tenant_config_versions where tenant_id = $1', [b.tenantId]);
    /* the guard refuses it first; with the guard switched off the composite key still does. */
    assert.match(await refused(db, `update tenant_modules set observed_tenant_config_version_id = $1 where tenant_id = $2`, [theirs.id, a.tenantId]), /moves by exactly one|history first/);
    let keyRefusal = null;
    try {
      await db.transaction(async (tx) => {
        await tx.query('alter table tenant_modules disable trigger tenant_modules_guard');
        await tx.query('update tenant_modules set observed_tenant_config_version_id = $1 where tenant_id = $2', [theirs.id, a.tenantId]);
      });
    } catch (error) {
      keyRefusal = error.message;
    }
    assert.match(keyRefusal ?? 'accepted', /violates foreign key/);
    assert.equal((await db.query(`select tgenabled from pg_trigger where tgname = 'tenant_modules_guard'`)).rows[0].tgenabled, 'O', 'the guard is back on');
    assert.match(await refused(db, `insert into tenant_modules (tenant_id, module_key, state, state_version, pending_requirements) values ($1, 'lead_recovery', 'configuring', 1, '{sometime}')`, [b.tenantId]), /check constraint|violates|begins selected/);
    assert.match(await refused(db, `insert into tenant_modules (tenant_id, module_key, state, state_version) values ($1, 'not_a_module', 'configuring', 1)`, [b.tenantId]), /foreign key/);
  });
});

describe('no path around the state machine', { skip }, () => {
  let db;
  let operator;
  let t;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    t = await tenant(db, operator);
    await t.underTest();
  });

  test('a lifecycle row cannot change without its history row — not even by the service role', async () => {
    assert.match(await refused(db, `update tenant_modules set state = 'active', state_version = state_version + 1 where tenant_id = $1`, [t.tenantId]), /history first/);
    assert.match(await refused(db, `update tenant_modules set health_status = 'healthy' where tenant_id = $1`, [t.tenantId]), /state version moves by exactly one/);
  });

  test('a lifecycle cannot be born active, or deleted', async () => {
    const other = await newTenant(db);
    assert.match(await refused(db, `insert into tenant_modules (tenant_id, module_key, state, state_version) values ($1, 'lead_recovery', 'active', 1)`, [other]), /begins selected|active_is_authorized/);
    assert.match(await refused(db, 'delete from tenant_modules where tenant_id = $1', [t.tenantId]), /never deleted/);
  });

  test('a lifecycle inserted with no history row does not survive the transaction', async () => {
    const other = await newTenant(db);
    assert.match(await refused(db, `insert into tenant_modules (tenant_id, module_key, state, state_version) values ($1, 'lead_recovery', 'configuring', 1)`, [other]), /has no history row/);
  });

  test('history is append-only, even for the service role, and names a real rule', async () => {
    assert.match(await refused(db, `update tenant_module_transitions set reason = 'rewritten' where tenant_id = $1`, [t.tenantId]), /append-only/);
    assert.match(await refused(db, 'delete from tenant_module_transitions where tenant_id = $1', [t.tenantId]), /append-only/);
    const { rows: [lc] } = await db.query('select id, state_version from tenant_modules where tenant_id = $1', [t.tenantId]);
    assert.match(
      await refused(db, `insert into tenant_module_transitions (tenant_id, module_key, lifecycle_id, state_version, transition, from_state, to_state, actor_type, reason_code, idempotency_key)
                         values ($1, 'lead_recovery', $2, $3, 'activate', 'configuring', 'active', 'system', 'forged', 'forged-1')`, [t.tenantId, lc.id, Number(lc.state_version) + 1]),
      /foreign key|illegal_transition/,
    );
  });

  test('a forged activation — a legal history row, then the update — is refused without a passing test of the current versions', async () => {
    const { rows: [lc] } = await db.query('select * from tenant_modules where tenant_id = $1', [t.tenantId]);
    const next = Number(lc.state_version) + 1;
    const { rows: [head] } = await db.query('select * from lifecycle_heads($1, $2)', [t.tenantId, LR]);
    /* two statements, so the guard sees the history row and reaches the evidence check. */
    let message = null;
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          `insert into tenant_module_transitions (tenant_id, module_key, lifecycle_id, state_version, transition, from_state, to_state, actor_type, actor_id, reason_code, idempotency_key)
           values ($1, 'lead_recovery', $2, $3, 'activate', 'testing', 'active', 'operator', $4, 'forged', 'forged-2')`,
          [t.tenantId, lc.id, next, operator],
        );
        await tx.query(
          `update tenant_modules set state = 'active', state_version = $2,
             authorized_tenant_config_version_id = $3, authorized_module_config_version_id = $4
            where id = $1`,
          [lc.id, next, head.tenant_version_id, head.module_version_id],
        );
      });
    } catch (error) {
      message = error.message;
    }
    assert.match(message ?? 'accepted', /arc_lifecycle:test_evidence_missing/);
    assert.equal((await t.lifecycle()).state, 'testing');
  });

  test('evidence is append-only, and a test must come from a synthetic run pinned to what it claims', async () => {
    await t.passTest();
    assert.match(await refused(db, `update tenant_module_evidence set outcome = 'failed' where tenant_id = $1`, [t.tenantId]), /append-only/);
    const { rows: [lc] } = await db.query('select id from tenant_modules where tenant_id = $1', [t.tenantId]);
    const { rows: [head] } = await db.query('select * from lifecycle_heads($1, $2)', [t.tenantId, LR]);
    const { rows: [real] } = await db.query(`insert into leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual') returning id`, [t.tenantId]);
    assert.match(
      await refused(db, `insert into tenant_module_evidence (tenant_id, module_key, lifecycle_id, kind, outcome, run_mode, tenant_config_version_id, module_config_version_id, config_hash, run_id, actor_type, recorded_by)
                         values ($1, 'lead_recovery', $2, 'test', 'passed', 'test', $3, $4, repeat('a', 64), $5, 'operator', $6)`, [t.tenantId, lc.id, head.tenant_version_id, head.module_version_id, real.id, operator]),
      /foreign key|no such run/,
    );
    assert.match(
      await refused(db, `insert into tenant_module_evidence (tenant_id, module_key, lifecycle_id, kind, outcome, run_mode, tenant_config_version_id, module_config_version_id, config_hash, actor_type, recorded_by)
                         values ($1, 'lead_recovery', $2, 'shadow_review', 'passed', null, $3, $4, repeat('a', 64), 'operator', $5)`, [t.tenantId, lc.id, head.tenant_version_id, head.module_version_id, operator]),
      /shadow_observations_missing/,
    );
  });

  test('the switch is a mirror: writing it is refused, and the lifecycle moves it', async () => {
    assert.match(await refused(db, 'update module_configs set enabled = true where tenant_id = $1', [t.tenantId]), /mirrors the lifecycle/);
    t.must(await activateModule(t.store, await t.req()), 'activate');
    assert.equal((await db.query('select enabled from module_configs where tenant_id = $1', [t.tenantId])).rows[0].enabled, true);
    assert.match(await refused(db, 'update module_configs set enabled = false where tenant_id = $1', [t.tenantId]), /mirrors the lifecycle/);
  });
});

describe('the one function: actors, locks and keys', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  const call = (db, args) => db.query(
    `select apply_tenant_module_transition($1, 'lead_recovery', $2, $3, $4, $5, $6, null, $7, $8::jsonb) as r`,
    [args.tenant, args.transition, args.expected, args.actorType ?? 'operator', args.actor, args.reasonCode ?? 'test', args.key ?? crypto.randomUUID(), JSON.stringify(args.change ?? { pending_requirements: [] })],
  );

  test('a stale expected version is refused and nothing is written', async () => {
    const t = await tenant(db, operator);
    await call(db, { tenant: t.tenantId, transition: 'select', expected: 0, actor: operator });
    await assert.rejects(call(db, { tenant: t.tenantId, transition: 'begin_testing', expected: 0, actor: operator }), /arc_lifecycle:stale_state/);
    assert.equal((await t.lifecycle()).state, 'configuring');
  });

  test('a repeated key replays the first answer, and a reused key for another transition is refused', async () => {
    const t = await tenant(db, operator);
    const first = (await call(db, { tenant: t.tenantId, transition: 'select', expected: 0, actor: operator, key: 'select-once' })).rows[0].r;
    const again = (await call(db, { tenant: t.tenantId, transition: 'select', expected: 0, actor: operator, key: 'select-once' })).rows[0].r;
    assert.equal(again.replayed, true);
    assert.equal(again.transition.id, first.transition.id);
    assert.equal((await db.query('select count(*)::int as n from tenant_module_transitions where tenant_id = $1', [t.tenantId])).rows[0].n, 1);
    await assert.rejects(call(db, { tenant: t.tenantId, transition: 'begin_testing', expected: 1, actor: operator, key: 'select-once' }), /arc_lifecycle:idempotency_conflict/);
  });

  test('a caller who is not an operator is refused; the system cannot select; a signed-in caller cannot name somebody else', async () => {
    const t = await tenant(db, operator);
    const nobody = await newUser(db);
    await assert.rejects(call(db, { tenant: t.tenantId, transition: 'select', expected: 0, actor: nobody }), /arc_lifecycle:forbidden/);
    await assert.rejects(call(db, { tenant: t.tenantId, transition: 'select', expected: 0, actorType: 'system', actor: null }), /arc_lifecycle:forbidden/);
    const other = await newOperator(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [other]);
        await tx.query(`select apply_tenant_module_transition($1, 'lead_recovery', 'select', 0, 'operator', $2, 'x', null, 'k-impersonate', '{"pending_requirements":[]}'::jsonb)`, [t.tenantId, operator]);
      }),
      /the actor must be the signed-in caller/,
    );
  });

  test('the migration\'s backfill transitions cannot be requested', async () => {
    const t = await tenant(db, operator);
    await assert.rejects(call(db, { tenant: t.tenantId, transition: 'backfill_paused', expected: 0, actorType: 'system', actor: null }), /the backfill is the migration's/);
  });

  test('two concurrent transitions on one version: one lands, the other is stale', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const version = Number((await t.lifecycle()).state_version);
    const results = await Promise.allSettled([
      pauseModule(t.store, { tenantId: t.tenantId, moduleKey: LR, actor: t.actor, expectedStateVersion: version }),
      deselectModule(t.store, { tenantId: t.tenantId, moduleKey: LR, actor: t.actor, expectedStateVersion: version }),
    ]);
    const outcomes = results.map((r) => r.value);
    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    assert.equal(outcomes.find((o) => !o.ok).code, 'stale_state');
    assert.equal(Number((await t.lifecycle()).state_version), version + 1);
  });

  test('each transition writes its own audit row, with no configuration in it', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const { rows } = await db.query(`select action, metadata from admin_actions where target_id = $1 and action like 'module.%' order by occurred_at`, [t.tenantId]);
    assert.deepEqual(rows.map((r) => r.action), ['module.select', 'module.begin_testing', 'module.record_test', 'module.activate']);
    assert.doesNotMatch(JSON.stringify(rows), /Halstead|\+1614/);
  });
});

describe('the database authorises runs and effects itself', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('a live run on a paused module is refused by the insert itself — the engine\'s check is not the only one', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const result = await intakeLead(deps(t.store), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-live-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.equal(result.ok, true, result.outcome);
    const { rows: [run] } = await db.query('select * from automation_runs where id = $1', [result.run.id]);
    assert.equal(run.run_mode, 'live');
    t.must(await pauseModule(t.store, await t.req()), 'pause');
    const { rows: [lead] } = await db.query(`insert into leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual') returning id`, [t.tenantId]);
    assert.match(
      await refused(db, `insert into automation_runs (tenant_id, lead_id, module_key, config_snapshot_id, run_mode) values ($1, $2, 'lead_recovery', $3, 'live')`, [t.tenantId, lead.id, run.config_snapshot_id]),
      /arc_lifecycle:module_paused/,
    );
    assert.match(
      await refused(db, `insert into automation_runs (tenant_id, lead_id, module_key, config_snapshot_id) values ($1, $2, 'lead_recovery', $3)`, [t.tenantId, lead.id, run.config_snapshot_id]),
      /arc_lifecycle:invalid_run_mode/,
    );
  });

  test('a live run must be pinned to exactly the authorised versions', async () => {
    const t = await tenant(db, operator);
    await t.live();
    await t.publish({ templates: { ...leadRecoveryConfig().templates, followup: '{{company}} again — checking in.' } });
    const lc = await t.lifecycle();
    assert.deepEqual(lc.pending_requirements, ['retest']);
    const held = await intakeLead(deps(t.store), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-held-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.equal(held.run, null);
    /* straight at the table, on the old snapshot: still refused. */
    const { rows: [snap] } = await db.query('select id from lead_recovery_config_snapshots where tenant_id = $1 and module_config_version_id = $2 limit 1', [t.tenantId, lc.authorized_module_config_version_id]);
    const { rows: [lead] } = await db.query(`insert into leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual') returning id`, [t.tenantId]);
    assert.match(await refused(db, `insert into automation_runs (tenant_id, lead_id, module_key, config_snapshot_id, run_mode) values ($1, $2, 'lead_recovery', $3, 'live')`, [t.tenantId, lead.id, snap.id]), /requirements_pending/);
  });

  test('with nothing pending, a live run on anything but the authorised versions is still refused', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const first = await intakeLead(deps(t.store), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-auth-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    const { rows: [old] } = await db.query('select config_snapshot_id from automation_runs where id = $1', [first.run.id]);
    await t.publish({ services: ['furnace repair'] });
    const lc = await t.lifecycle();
    assert.deepEqual(lc.pending_requirements, [], 'consequence-free: nothing pending, authorisation carried');
    const { rows: [lead] } = await db.query(`insert into leads (tenant_id, correlation_id, source) values ($1, gen_random_uuid(), 'manual') returning id`, [t.tenantId]);
    assert.match(
      await refused(db, `insert into automation_runs (tenant_id, lead_id, module_key, config_snapshot_id, run_mode) values ($1, $2, 'lead_recovery', $3, 'live')`, [t.tenantId, lead.id, old.config_snapshot_id]),
      /arc_lifecycle:authorization_stale/,
    );
  });

  test('the function itself refuses to carry authorisation across a change the registry says needs more', async () => {
    const t = await tenant(db, operator);
    await t.live();
    await t.publish({ templates: { ...leadRecoveryConfig().templates, followup: '{{company}} — still here if you need us.' } });
    const lc = await t.lifecycle();
    assert.deepEqual(lc.pending_requirements, ['retest']);
    const { rows: [head] } = await db.query('select * from lifecycle_heads($1, $2)', [t.tenantId, LR]);
    const forged = { pending_requirements: [], authorized: { tenant_version_id: head.tenant_version_id, module_version_id: head.module_version_id } };
    await assert.rejects(
      db.query(`select apply_tenant_module_transition($1, 'lead_recovery', 'apply_config_change', $2, 'system', null, 'forged', null, 'forged-carry', $3::jsonb)`, [t.tenantId, Number(lc.state_version), JSON.stringify(forged)]),
      /arc_lifecycle:requirements_pending: a change with consequences \(requires_retest\)/,
    );
  });

  test('a live effect cannot be reserved while the module is paused, and a real lead cannot be passed off as a canary', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const result = await intakeLead(deps(t.store), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-res-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    t.must(await pauseModule(t.store, await t.req()), 'pause');
    const reserve = (isCanary) => db.query(
      `select * from reserve_lead_recovery_effect($1, $2, 'customer_sms', $2, 'w', gen_random_uuid(), $3, $4, null, null, null, $5)`,
      [t.tenantId, `lr:effect:${crypto.randomUUID()}`, result.run.id, result.lead.id, isCanary],
    );
    await assert.rejects(reserve(false), /arc_lifecycle:module_paused/);
    await assert.rejects(reserve(true), /arc_lifecycle:mode_not_permitted/);
    assert.equal((await db.query('select count(*)::int as n from lead_recovery_effect_attempts where tenant_id = $1 and not is_canary', [t.tenantId])).rows[0].n, 0);
  });

  test('pausing cancels queued contact in the same transaction and leaves handoffs; the dispatcher then sends nothing', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const sender = new RecordingSender();
    await intakeLead(deps(t.store, { live: sender }), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-pause-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    await intakeLead(deps(t.store, { live: sender }), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-pause-2', phone: '+16145559912', serviceRequest: 'I smell gas', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    const paused = t.must(await pauseModule(t.store, await t.req()), 'pause');
    assert.equal(paused.cancelledActions, 1);
    const { rows } = await db.query(`select a.action_type, a.status from scheduled_actions a join automation_runs r on r.id = a.run_id where a.tenant_id = $1 and r.run_mode = 'live' order by a.action_type`, [t.tenantId]);
    assert.deepEqual(rows.map((r) => `${r.action_type}:${r.status}`), ['open_handoff:pending', 'send_first_response:cancelled']);
    /* scoped to this tenant: other tests in this database leave live work of their own. */
    await runDueActions(deps(t.store, { live: sender }), { tenantId: t.tenantId });
    assert.equal(sender.sent.length, 0);
    assert.equal((await db.query('select count(*)::int as n from handoffs where tenant_id = $1', [t.tenantId])).rows[0].n, 1, 'a person still has the gas lead');
  });

  test('nothing can be queued against a shadow run, and shadow evidence is simulated and version-bound', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    await t.passTest();
    t.must(await enterShadow(t.store, await t.req()), 'enter shadow');
    const sender = new RecordingSender();
    const observed = await intakeLead(deps(t.store, { live: sender }), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-shadow-1', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.match(observed.outcome, /^shadow mode — would have texted the customer/);
    assert.equal(sender.sent.length, 0);
    const { rows: [run] } = await db.query('select * from automation_runs where id = $1', [observed.run.id]);
    assert.equal(run.run_mode, 'shadow');
    assert.match(await refused(db, `insert into scheduled_actions (tenant_id, run_id, action_type, run_at, idempotency_key) values ($1, $2, 'send_followup', now(), 'shadow-1')`, [t.tenantId, run.id]), /shadow_no_effects/);
    const { rows: [evidence] } = await db.query(`select * from tenant_module_evidence where tenant_id = $1 and kind = 'shadow_observation'`, [t.tenantId]);
    assert.equal(evidence.simulated, true);
    assert.equal(evidence.summary.would_have, 'send_first_response');
    assert.equal((await db.query(`select count(*)::int as n from events where tenant_id = $1 and event_type = 'sms_sent' and not is_canary`, [t.tenantId])).rows[0].n, 0);
    t.must(await recordShadowReview(t.store, { ...(await t.req()), passed: true }), 'shadow review');
    t.must(await activateModule(t.store, await t.req()), 'activate from shadow');
  });
});

describe('change impact, over real SQL', { skip }, () => {
  let db;
  let operator;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
  });

  test('a consequence-free publication carries authorisation, recorded with both version pairs', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const before = await t.lifecycle();
    await t.publish({ services: ['furnace repair'] });
    const after = await t.lifecycle();
    assert.equal(after.state, 'active');
    assert.notEqual(after.authorized_module_config_version_id, before.authorized_module_config_version_id);
    const { rows: [decision] } = await db.query(`select * from tenant_module_transitions where tenant_id = $1 order by state_version desc limit 1`, [t.tenantId]);
    assert.equal(decision.transition, 'apply_config_change');
    assert.equal(decision.previous_module_config_version_id, before.authorized_module_config_version_id);
    assert.equal(decision.module_config_version_id, after.authorized_module_config_version_id);
  });

  test('a compliance publication pauses as the system, and the database refuses to carry authorisation across it', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const before = await t.lifecycle();
    await t.publish({ compliance: { ...leadRecoveryConfig().compliance, campaign_ref: 'CMP555' } });
    const after = await t.lifecycle();
    assert.equal(after.state, 'paused');
    assert.deepEqual(after.pending_requirements, ['retest', 'review', 'reactivation']);
    const { rows: [pause] } = await db.query(`select * from tenant_module_transitions where tenant_id = $1 and transition = 'system_pause'`, [t.tenantId]);
    assert.equal(pause.actor_type, 'system');

    const { rows: [head] } = await db.query('select * from lifecycle_heads($1, $2)', [t.tenantId, LR]);
    assert.deepEqual(
      (await db.query('select lifecycle_chain_classes($1, $2, $3, $4, $5, $6) as c', [t.tenantId, LR, before.authorized_tenant_config_version_id, before.authorized_module_config_version_id, head.tenant_version_id, head.module_version_id])).rows[0].c,
      ['requires_reactivation', 'requires_retest'],
    );

    const refusedResume = await resumeModule(t.store, await t.req());
    assert.equal(refusedResume.ok, false);
    await t.passTest();
    t.must(await resumeModule(t.store, await t.req()), 'resume');
    assert.equal((await t.lifecycle()).state, 'active');
  });

  test('a published version stays immutable through all of it', async () => {
    const t = await tenant(db, operator);
    await t.live();
    await t.publish({ compliance: { ...leadRecoveryConfig().compliance, campaign_ref: 'CMP556' } });
    assert.match(await refused(db, `update module_config_versions set config = '{}' where tenant_id = $1`, [t.tenantId]), /cannot|immutable|never/i);
  });

  test('reconciling twice is one decision; health moves only the overlay', async () => {
    const t = await tenant(db, operator);
    await t.live();
    await t.publish({ services: ['water heater'] });
    const count = (await db.query('select count(*)::int as n from tenant_module_transitions where tenant_id = $1', [t.tenantId])).rows[0].n;
    assert.equal((await reconcileConfigChange(t.store, { tenantId: t.tenantId, moduleKey: LR })).applied, false);
    assert.equal((await db.query('select count(*)::int as n from tenant_module_transitions where tenant_id = $1', [t.tenantId])).rows[0].n, count);
    t.must(await reportHealth(t.store, { ...(await t.req()), status: 'blocking', evidence: { source: 'monitor' } }), 'health');
    const lc = await t.lifecycle();
    assert.equal(lc.state, 'active');
    assert.equal(lc.health_status, 'blocking');
    const blocked = await intakeLead(deps(t.store), { tenantId: t.tenantId, source: 'missed_call', externalRef: 'CA-blocked', phone: '+16145559911', intakeRef: '+16145550100', consentSms: true, consentSource: 'inbound_call' });
    assert.equal(blocked.run, null);
  });
});

describe('RLS: a member sees their own lifecycle and nothing else', { skip }, () => {
  let db;
  let operator;
  let a;
  let b;
  let member;
  before(async () => {
    db = await freshDatabase();
    operator = await newOperator(db);
    a = await tenant(db, operator);
    b = await tenant(db, operator);
    await a.underTest();
    await b.underTest();
    member = await newMember(db, a.tenantId);
  });

  test('a member reads their own tenant\'s lifecycle row, not another tenant\'s', async () => {
    const rows = await asRole(db, { role: 'authenticated', sub: member }, async (tx) => (await tx.query('select tenant_id, state from tenant_modules')).rows);
    assert.deepEqual(rows.map((r) => r.tenant_id), [a.tenantId]);
  });

  test('history and evidence are operator material', async () => {
    const counts = await asRole(db, { role: 'authenticated', sub: member }, async (tx) => ({
      history: (await tx.query('select count(*)::int as n from tenant_module_transitions')).rows[0].n,
      evidence: (await tx.query('select count(*)::int as n from tenant_module_evidence')).rows[0].n,
    }));
    assert.deepEqual(counts, { history: 0, evidence: 0 });
    const operatorCount = await asRole(db, { role: 'authenticated', sub: operator }, async (tx) => (await tx.query('select count(*)::int as n from tenant_module_transitions')).rows[0].n);
    assert.ok(operatorCount >= 4);
  });

  test('an anonymous caller reads nothing', async () => {
    const n = await asRole(db, { role: 'anon' }, async (tx) => (await tx.query('select count(*)::int as n from tenant_modules')).rows[0].n);
    assert.equal(n, 0);
  });

  test('no browser role can write a lifecycle, history or evidence row, or call the function — not even an operator', async () => {
    for (const sub of [member, operator]) {
      await assert.rejects(asRole(db, { role: 'authenticated', sub }, (tx) => tx.query(`update tenant_modules set state = 'paused' where tenant_id = $1`, [a.tenantId]).then((r) => { if (r.affectedRows === 0) throw new Error('row-level security: nothing visible to update'); })));
      await assert.rejects(asRole(db, { role: 'authenticated', sub }, (tx) => tx.query(`select apply_tenant_module_transition($1, 'lead_recovery', 'pause', 2, 'operator', $2, 'x', null, 'k', '{}'::jsonb)`, [a.tenantId, operator])), /permission denied/);
      await assert.rejects(asRole(db, { role: 'authenticated', sub }, (tx) => tx.query(`insert into tenant_module_transitions (tenant_id, module_key, lifecycle_id, state_version, transition, from_state, to_state, actor_type, reason_code, idempotency_key) select tenant_id, module_key, id, state_version + 1, 'pause', state, 'paused', 'system', 'x', 'k' from tenant_modules where tenant_id = $1`, [a.tenantId])));
    }
  });
});

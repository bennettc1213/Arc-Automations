/* ARC-200 — the scheduler's vocabulary, its pure functions, the service's refusals, and
 * the text of 0017. None of this needs a database: `tests/scheduler-db.test.js` runs the
 * same promises against real Postgres.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  ACTION_TYPES,
  actionType,
  backoffSeconds,
  findSecretShaped,
  isAmbiguous,
  isDue,
  parseSchedulerError,
  schedulerActionTypes,
} from '../supabase/functions/_shared/scheduler/model.ts';
import {
  claimDueActions,
  completeFailure,
  completeSuccess,
  createAutomationRun,
  resumeRun,
  scheduleAutomationAction,
} from '../supabase/functions/_shared/scheduler/service.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0017_durable_scheduler.sql', import.meta.url), 'utf8');
const SQL_0015 = readFileSync(new URL('../supabase/migrations/0015_tenant_module_lifecycle.sql', import.meta.url), 'utf8');
const SCHEDULER_DIR = new URL('../supabase/functions/_shared/scheduler/', import.meta.url);

/** A store that fails the test if the service ever reaches it. */
const untouchable = new Proxy({}, {
  get: (_t, name) => () => { throw new Error(`the service reached the store (${String(name)}) with input it should have refused`); },
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const LEASE = { actionId: '33333333-3333-4333-8333-333333333333', tenantId: TENANT, leaseToken: '44444444-4444-4444-8444-444444444444' };

/* ══ the vocabulary ═══════════════════════════════════════ */

describe('there is one vocabulary of action types, and the database holds the same one', () => {
  test('0017 seeds exactly ACTION_TYPES — the build fails on drift', () => {
    const block = SQL.slice(SQL.indexOf('insert into public.automation_action_types'), SQL.indexOf('on conflict (key) do nothing'));
    const seeded = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*(\d+),\s*(\d+),\s*(\d+),/g)]
      .map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}|${m[5]}|${m[6]}|${m[7]}|${m[8]}`).sort();
    const typed = ACTION_TYPES
      .map((d) => `${d.key}|${d.dispatcher}|${d.effectClass}|${d.pausedPolicy}|${d.connectionRequirement}|${d.defaultMaxAttempts}|${d.retryBaseSeconds}|${d.retryCeilingSeconds}`)
      .sort();
    assert.equal(seeded.length, 16);
    assert.deepEqual(seeded, typed);
  });

  test('the Lead Recovery engine keeps its seven types, and only the engine decides their pause behaviour', () => {
    const engine = ACTION_TYPES.filter((d) => d.dispatcher === 'lead_recovery_engine').map((d) => d.key).sort();
    assert.deepEqual(engine, ['classify_reply', 'close_run', 'notify_staff', 'open_handoff', 'route_to_contractor', 'send_first_response', 'send_followup']);
    for (const d of ACTION_TYPES) assert.equal(d.dispatcher === 'lead_recovery_engine', d.pausedPolicy === 'engine', d.key);
    /* the same retry numbers the engine already uses. */
    for (const d of ACTION_TYPES.filter((x) => x.dispatcher === 'lead_recovery_engine')) {
      assert.equal(d.retryBaseSeconds, 60);
      assert.equal(d.retryCeilingSeconds, 1800);
    }
  });

  test('nothing that can reach the outside world proceeds while its module is paused', () => {
    for (const d of ACTION_TYPES) {
      if (d.pausedPolicy === 'proceed') assert.equal(d.effectClass, 'none', `${d.key} proceeds while paused, so it must touch nothing outside ARC`);
      if (d.effectClass === 'none') assert.equal(d.connectionRequirement, 'none', `${d.key} touches nothing outside ARC, so it needs no connection`);
    }
    assert.match(SQL, /constraint automation_action_types_effects_hold\s+check \(effect_class = 'none' or paused_policy <> 'proceed'\)/);
  });

  test('every action the scheduler can send or mutate is an external effect — the class that is never resent on an unknown outcome', () => {
    for (const key of ['send_message', 'call_provider_operation', 'enqueue_runner_execution', 'send_first_response', 'send_followup', 'notify_staff']) {
      assert.equal(actionType(key).effectClass, 'external_effect', key);
    }
  });

  test('the scheduler schedules observation windows and reminders without deciding anything about them', () => {
    for (const key of ['record_observation_checkpoint', 'remind_operator', 'request_human_review']) {
      const d = actionType(key);
      assert.equal(d.dispatcher, 'scheduler');
      assert.equal(d.effectClass, 'none');
    }
    assert.ok(schedulerActionTypes().includes('record_observation_checkpoint'));
  });

  test('the vocabulary changes by migration, never at run time', () => {
    assert.match(SQL, /create trigger automation_action_types_immutable\s+before update or delete on public\.automation_action_types/);
  });
});

/* ══ pure functions ═══════════════════════════════════════ */

describe('backoff is bounded, exponential and never jittered', () => {
  test('base × 2^(attempts−1), capped at the ceiling', () => {
    const t = actionType('send_message');
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => backoffSeconds(t, n)), [60, 120, 240, 480, 960, 1800, 1800]);
    assert.equal(backoffSeconds(t, 0), 60);
    assert.equal(backoffSeconds({ retryBaseSeconds: 86400, retryCeilingSeconds: 604800 }, 20), 604800, 'large attempt counts cap rather than overflow');
  });

  test('the database computes it the same way, in floating point before it is capped', () => {
    assert.match(SQL, /least\(v_type\.retry_ceiling_seconds::double precision,\s+v_type\.retry_base_seconds \* power\(2::double precision, least\(greatest\(v_row\.attempts - 1, 0\), 30\)\)\)::integer/);
  });
});

describe('claimable is derived, never stored', () => {
  test('due means pending and at or before now', () => {
    const now = '2026-09-25T12:00:00.000Z';
    assert.equal(isDue({ status: 'pending', runAt: '2026-09-25T11:59:59.000Z' }, now), true);
    assert.equal(isDue({ status: 'pending', runAt: now }, now), true);
    assert.equal(isDue({ status: 'pending', runAt: '2026-09-25T12:00:01.000Z' }, now), false, 'a future action is not due');
    for (const status of ['claimed', 'running', 'done', 'cancelled', 'failed', 'blocked', 'skipped', 'dead_letter']) {
      assert.equal(isDue({ status, runAt: '2020-01-01T00:00:00.000Z' }, now), false, status);
    }
    assert.doesNotMatch(SQL, /'claimable'/, 'no stored claimable status');
  });

  test('an ambiguous action is a blocked one whose gate says so', () => {
    assert.equal(isAmbiguous({ status: 'blocked', gate: { code: 'ambiguous_outcome' } }), true);
    assert.equal(isAmbiguous({ status: 'blocked', gate: { code: 'connection_revoked' } }), false);
    assert.equal(isAmbiguous({ status: 'pending', gate: null }), false);
  });
});

describe('secret-shaped values are found wherever they are', () => {
  test('credential-shaped values and credential-named keys', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
    assert.equal(findSecretShaped({ note: `Bearer ${'x'.repeat(20)}` }), '$.note');
    assert.equal(findSecretShaped({ nested: { list: ['fine', jwt] } }), '$.nested.list[1]');
    assert.equal(findSecretShaped({ access_token: 'anything' }), '$.access_token');
    assert.equal(findSecretShaped({ headers: { Authorization: 'x' } }), '$.headers.Authorization');
    assert.equal(findSecretShaped({ key: ['sk', 'live', 'abcdefgh12345678'].join('_') }), '$.key');
    assert.equal(findSecretShaped({ config: { service_role: 'x' } }), '$.config.service_role');
  });

  test('ordinary payloads pass — `code`, `state` and `status` are ordinary words here', () => {
    assert.equal(findSecretShaped({ template: 'followup_1', step: 2, code: 'no_answer', state: 'OH', status: 'queued', to: '+16145550137' }), null);
    assert.equal(findSecretShaped({}), null);
  });
});

describe('the database\'s refusals become typed codes', () => {
  test('arc_scheduler and arc_lifecycle prefixes both parse', () => {
    const a = parseSchedulerError('ERROR: arc_scheduler:idempotency_conflict: that idempotency key already names a different action');
    assert.equal(a.code, 'idempotency_conflict');
    assert.equal(parseSchedulerError('arc_lifecycle:module_paused: a live run needs the module active — it is paused').code, 'module_paused');
    assert.equal(parseSchedulerError('duplicate key value violates unique constraint'), null);
  });
});

/* ══ the service refuses before it writes ═════════════════ */

describe('the service refuses bad input without touching the store', () => {
  const base = { tenantId: TENANT, runId: RUN, actionType: 'record_observation_checkpoint', runAt: '2026-10-01T09:00:00.000Z', idempotencyKey: 'obs:1' };

  test('a secret-shaped payload is refused, and the refusal names where it is', async () => {
    const r = await scheduleAutomationAction(untouchable, { ...base, payload: { provider: { api_key: 'abc' } } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'secret_in_payload');
    assert.match(r.message, /\$\.provider\.api_key/);
  });

  test('the Lead Recovery engine\'s types, unknown types, and connection-dependent types without a connection', async () => {
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, actionType: 'send_followup' })).code, 'not_scheduler_action');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, actionType: 'launch_rocket' })).code, 'unknown_action_type');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, actionType: 'send_message' })).code, 'connection_required');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, runAt: 'tomorrow-ish' })).code, 'invalid_request');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, idempotencyKey: '' })).code, 'invalid_request');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, maxAttempts: 0 })).code, 'invalid_request');
    assert.equal((await scheduleAutomationAction(untouchable, { ...base, payload: ['not', 'an', 'object'] })).code, 'invalid_request');
  });

  test('a run is pinned, keyed and not a lead conversation', async () => {
    const run = { tenantId: TENANT, runKind: 'observation_window', moduleKey: 'lead_recovery', configSnapshotId: RUN, runMode: 'live', correlationId: RUN, idempotencyKey: 'obs' };
    assert.equal((await createAutomationRun(untouchable, { ...run, runKind: 'lead_conversation' })).code, 'invalid_request');
    assert.equal((await createAutomationRun(untouchable, { ...run, configSnapshotId: null })).code, 'invalid_request');
    assert.equal((await createAutomationRun(untouchable, { ...run, idempotencyKey: '' })).code, 'invalid_request');
    assert.equal((await createAutomationRun(untouchable, { ...run, runMode: 'yolo' })).code, 'invalid_request');
    assert.equal((await createAutomationRun(untouchable, { ...run, runnerKind: 'N8N Cloud' })).code, 'invalid_runner');
  });

  test('evidence is what happened, never how to authenticate', async () => {
    const r = await completeSuccess(untouchable, LEASE, { evidence: { response: { refresh_token: 'x' } } });
    assert.equal(r.code, 'secret_in_evidence');
    assert.equal((await completeFailure(untouchable, LEASE, { retryable: true, errorCode: 'Not A Code' })).code, 'invalid_code');
  });

  test('"every tenant" is written out, and the system never resumes', async () => {
    assert.equal((await claimDueActions(untouchable, { tenantId: 'somebody', worker: 'w' })).code, 'tenant_required');
    assert.equal((await claimDueActions(untouchable, { tenantId: TENANT, worker: '' })).code, 'invalid_request');
    assert.equal((await claimDueActions(untouchable, { tenantId: TENANT, worker: 'w', leaseSeconds: 5 })).code, 'invalid_request');
    assert.equal((await resumeRun(untouchable, { tenantId: TENANT, runId: RUN, operatorId: null })).code, 'forbidden');
  });
});

/* ══ the migration as written ═════════════════════════════ */

describe('0017 as written', () => {
  test('no browser role is given a write policy, or execute on anything', () => {
    assert.doesNotMatch(SQL, /create policy [a-z_]+ on public\.[a-z_]+\s+for (insert|update|delete|all)/i);
    assert.doesNotMatch(SQL, /grant [^;]* to (anon|authenticated|public)\b/i);
    for (const table of ['automation_action_types', 'automation_action_attempts']) {
      assert.match(SQL, new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    }
  });

  test('every function it defines is revoked from browser roles', () => {
    const defined = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    for (const name of new Set(defined)) {
      assert.match(SQL, new RegExp(`revoke all on function public\\.${name}\\(`), `${name} is not revoked from public, anon, authenticated`);
    }
  });

  test('forward-only: nothing is dropped but triggers, policies and constraints being replaced, and nothing deleted', () => {
    const drops = [...SQL.matchAll(/^\s*(?:alter table [^\n]+\n\s*)?drop\s+(\w+)/gim)].map((m) => m[1].toLowerCase());
    assert.ok(drops.every((d) => ['trigger', 'constraint', 'policy'].includes(d)), `unexpected drop: ${drops.join(', ')}`);
    assert.doesNotMatch(SQL, /\bdrop table\b|\bdrop column\b|\btruncate\b|\bdelete from\b/i);
  });

  test('the redefined transition function is 0015\'s, except the one marked clause', () => {
    const body = (sql) => {
      const start = sql.indexOf('create or replace function public.apply_tenant_module_transition(');
      return sql.slice(start, sql.indexOf('$fn$;', start));
    };
    const ours = body(SQL).replace(/\n\s*-- ── ARC-200: a pause holds[^\n]*\n\s*and \(p_transition = 'deselect' or exists \([\s\S]*?\)\)\n/, '\n');
    assert.equal(ours, body(SQL_0015));
  });

  test('the redefined Lead Recovery claim still takes only pinned, due, uncapped work — and now only its own types', () => {
    const start = SQL.indexOf('create or replace function public.claim_actions_internal(');
    const claim = SQL.slice(start, SQL.indexOf('$fn$;', start));
    assert.match(claim, /t\.dispatcher = 'lead_recovery_engine'/);
    assert.match(claim, /a\.config_snapshot_id = r\.config_snapshot_id/);
    assert.match(claim, /a\.attempts < a\.max_attempts/);
    assert.match(claim, /for update of a, r skip locked/, 'the action and its run, never the shared vocabulary row');
  });
});

describe('the scheduler is generic', () => {
  test('its code names no runner, no provider and no module', () => {
    for (const file of readdirSync(SCHEDULER_DIR)) {
      const code = readFileSync(new URL(file, SCHEDULER_DIR), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.doesNotMatch(code, /['"`](n8n|twilio|lead_recovery)['"`]/i, `${file} hard-codes a runner, provider or module`);
      assert.doesNotMatch(code, /from ['"](jsr:|npm:|https?:)/, `${file} imports from outside the repository`);
    }
  });
});

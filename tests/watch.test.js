/* ARC-GO-330 — the check that notices a live client gone quiet.
 *
 * The promises, each tested by name:
 *   - quiet is counted from the last thing that came in, or from when the module last went
 *     live if that is later, against the registry's own window;
 *   - only something from outside counts as an arrival: a text ARC sent does not;
 *   - a quiet client is alerted once, in words written for the owner, and the next run
 *     raises nothing while that alert is open;
 *   - one client that cannot be read does not stop the others;
 *   - the check writes no event and touches nothing but `alerts`.
 *
 * The same check on real Postgres, through the production reads, is in
 * `tests/lead-recovery-gate.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARRIVAL_EVENT_TYPES,
  QUIET_CHECK_TYPE,
  QUIET_SEVERITY,
  quietAfterHours,
  quietMessage,
  quietVerdict,
} from '../supabase/functions/_shared/watch/model.ts';
import { runQuietCheck } from '../supabase/functions/_shared/watch/service.ts';
import { EVENT_TYPES } from '../supabase/functions/_shared/event-validation.ts';
import { getModule } from '../supabase/functions/_shared/registry/modules.ts';
import { LEAD_CAPTURE_EVENT_TYPES } from '../src/portal/lib/types.js';
import { MODULE_META } from '../src/portal/lib/modules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const HOUR = 3_600_000;
const NOW = new Date('2026-10-09T18:00:00.000Z');
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const verdict = (facts) => quietVerdict({ now: NOW, quietAfterHours: 48, activeSince: ago(24 * 30), lastArrivalAt: null, ...facts });

describe('whether a client is quiet', () => {
  test('something that came in inside the window is arriving', () => {
    const result = verdict({ lastArrivalAt: ago(47) });
    assert.equal(result.kind, 'arriving');
    assert.equal(result.quiet, false);
  });

  test('nothing for longer than the window is quiet, counted from the last arrival', () => {
    const result = verdict({ lastArrivalAt: ago(49) });
    assert.equal(result.kind, 'quiet');
    assert.equal(result.quiet, true);
    assert.equal(result.since, ago(49));
    assert.equal(Math.round(result.hours), 49);
  });

  test('exactly the window is not yet quiet', () => {
    assert.equal(verdict({ lastArrivalAt: ago(48) }).quiet, false);
  });

  test('a client switched on yesterday is not two days quiet', () => {
    const result = verdict({ activeSince: ago(20), lastArrivalAt: null });
    assert.equal(result.kind, 'not_yet');
    assert.equal(result.quiet, false);
  });

  test('live for longer than the window with nothing in is its own answer', () => {
    const result = verdict({ activeSince: ago(60), lastArrivalAt: null });
    assert.equal(result.kind, 'never_arrived');
    assert.equal(result.quiet, true);
    assert.equal(result.since, ago(60));
  });

  test('an arrival from before a pause does not start the clock: going live again does', () => {
    const fresh = verdict({ activeSince: ago(10), lastArrivalAt: ago(200) });
    assert.equal(fresh.kind, 'not_yet', 'resumed ten hours ago');
    const stale = verdict({ activeSince: ago(50), lastArrivalAt: ago(200) });
    assert.equal(stale.kind, 'never_arrived', 'resumed fifty hours ago and nothing since');
    assert.equal(stale.since, ago(50));
  });

  test('a module nobody can date is not accused of anything', () => {
    assert.equal(verdict({ activeSince: null, lastArrivalAt: null }).quiet, false);
    assert.equal(verdict({ activeSince: 'not a date', lastArrivalAt: ago(500) }).quiet, false);
  });
});

describe('the window and what counts as an arrival', () => {
  test('the window is the registry\'s, the one the portal\'s own health uses', () => {
    assert.equal(quietAfterHours('lead_recovery'), getModule('lead_recovery').portal.quietAfterHours);
    assert.equal(quietAfterHours('lead_recovery'), MODULE_META.lead_capture.quietAfterHours);
  });

  test('a module with no arrival list is not watched', () => {
    assert.equal(quietAfterHours('estimate_recovery'), null);
    assert.equal(quietAfterHours('nonsense'), null);
  });

  test('every arrival type is a real lead-capture event', () => {
    for (const type of ARRIVAL_EVENT_TYPES.lead_recovery) {
      assert.ok(EVENT_TYPES.includes(type), `${type} is in the event contract`);
      assert.ok(LEAD_CAPTURE_EVENT_TYPES.includes(type), `${type} is a lead-capture event`);
    }
  });

  test('nothing ARC does itself counts as an arrival', () => {
    for (const ours of ['sms_sent', 'message_delivered', 'message_failed', 'routed', 'lead_qualified', 'handoff_requested', 'automation_completed', 'canary_check', 'watermark_check']) {
      assert.ok(!ARRIVAL_EVENT_TYPES.lead_recovery.includes(ours), `${ours} says nothing about the line`);
    }
  });

  test('the alert is the kind 0001 already allows', () => {
    const sql = source('supabase/migrations/0001_init.sql');
    assert.match(sql, new RegExp(`check_type in \\([^)]*'${QUIET_CHECK_TYPE}'`));
    assert.match(sql, new RegExp(`severity in \\([^)]*'${QUIET_SEVERITY}'`));
  });
});

describe('the words the owner reads', () => {
  test('a quiet line says what was seen, both things it can mean, and that somebody is looking', () => {
    const message = quietMessage(verdict({ lastArrivalAt: '2026-10-07T15:30:00.000Z' }), { timezone: 'America/New_York' });
    assert.match(message, /^Automatic check: no call or form has reached ARC from your line since Oct 7, 11 AM\./);
    assert.match(message, /slow stretch/);
    assert.match(message, /call forwarding has stopped/);
    assert.match(message, /we are checking\.$/);
  });

  test('a line nothing ever came in on says forwarding may not be set up', () => {
    const message = quietMessage(verdict({ activeSince: ago(60) }), { timezone: 'America/New_York' });
    assert.match(message, /has been on since Oct 7/);
    assert.match(message, /Call forwarding may not be set up/);
  });

  test('there is nothing to say about a client that is not quiet', () => {
    assert.equal(quietMessage(verdict({ lastArrivalAt: ago(2) })), null);
  });

  test('a timezone nobody recognises falls back rather than throwing', () => {
    assert.match(quietMessage(verdict({ lastArrivalAt: ago(49) }), { timezone: 'Mars/Olympus' }), /since Oct 7/);
  });

  test('none of the machine\'s words reach the owner', () => {
    for (const facts of [{ lastArrivalAt: ago(49) }, { activeSince: ago(60) }]) {
      assert.doesNotMatch(quietMessage(verdict(facts)), /watermark|tenant|module|webhook|lifecycle|dispatch|event/i);
    }
  });
});

/** What the check reads and writes, held in arrays. */
function world(modules, arrivals = {}) {
  const alerts = [];
  const asked = [];
  return {
    alerts,
    asked,
    reads: {
      // deno-lint-ignore require-await
      liveModules: async () => modules,
      // deno-lint-ignore require-await
      async lastArrival(tenantId, eventTypes) {
        asked.push({ tenantId, eventTypes });
        const at = arrivals[tenantId];
        if (at instanceof Error) throw at;
        return at ?? null;
      },
      // deno-lint-ignore require-await
      async raise(alert) {
        if (alerts.some((row) => row.tenantId === alert.tenantId && row.checkType === alert.checkType && !row.resolvedAt)) return false;
        alerts.push({ ...alert, resolvedAt: null });
        return true;
      },
    },
    run() {
      return runQuietCheck({ reads: this.reads, now: () => NOW });
    },
  };
}

const live = (tenantId, extra = {}) => ({ tenantId, moduleKey: 'lead_recovery', activeSince: ago(24 * 30), timezone: 'America/New_York', ...extra });

describe('the hourly check', () => {
  test('a quiet client is alerted, and a busy one is not', async () => {
    const check = world([live('quiet'), live('busy')], { quiet: ago(72), busy: ago(3) });
    const report = await check.run();

    assert.deepEqual({ checked: report.checked, quiet: report.quiet, raised: report.raised, unread: report.unread }, { checked: 2, quiet: 1, raised: 1, unread: 0 });
    assert.equal(check.alerts.length, 1);
    assert.equal(check.alerts[0].tenantId, 'quiet');
    assert.equal(check.alerts[0].checkType, 'watermark');
    assert.equal(check.alerts[0].severity, 'warning');
    assert.match(check.alerts[0].message, /^Automatic check: /);
    assert.deepEqual(report.results.find((row) => row.tenantId === 'busy'), { tenantId: 'busy', moduleKey: 'lead_recovery', kind: 'arriving', hours: 3, raised: false });
  });

  test('it asks only for arrivals, by the model\'s own list', async () => {
    const check = world([live('a')], { a: ago(1) });
    await check.run();
    assert.deepEqual(check.asked, [{ tenantId: 'a', eventTypes: ARRIVAL_EVENT_TYPES.lead_recovery }]);
  });

  test('the next run raises nothing while the alert is open', async () => {
    const check = world([live('quiet')], { quiet: ago(72) });
    await check.run();
    const again = await check.run();
    assert.equal(again.quiet, 1, 'still quiet');
    assert.equal(again.raised, 0, 'and already said');
    assert.equal(check.alerts.length, 1);
  });

  test('once a person resolves it, a client still quiet is alerted again', async () => {
    const check = world([live('quiet')], { quiet: ago(72) });
    await check.run();
    check.alerts[0].resolvedAt = NOW.toISOString();
    assert.equal((await check.run()).raised, 1);
    assert.equal(check.alerts.length, 2);
  });

  test('arrivals starting again do not close the alert: a person does', async () => {
    const arrivals = { quiet: ago(72) };
    const check = world([live('quiet')], arrivals);
    await check.run();
    arrivals.quiet = ago(1);
    const report = await check.run();
    assert.equal(report.quiet, 0);
    assert.equal(check.alerts[0].resolvedAt, null);
  });

  test('a client live for two days with nothing in is alerted; one live since this morning is not', async () => {
    const check = world([live('never', { activeSince: ago(50) }), live('new', { activeSince: ago(6) })]);
    const report = await check.run();
    assert.equal(report.results.find((row) => row.tenantId === 'never').kind, 'never_arrived');
    assert.equal(report.results.find((row) => row.tenantId === 'new').kind, 'not_yet');
    assert.deepEqual(check.alerts.map((row) => row.tenantId), ['never']);
  });

  test('one client that cannot be read does not stop the others, and nothing is decided about it', async () => {
    const check = world([live('broken'), live('quiet')], { broken: new Error('connection reset'), quiet: ago(72) });
    const report = await check.run();
    assert.equal(report.unread, 1);
    assert.equal(report.raised, 1);
    assert.deepEqual(report.results[0], { tenantId: 'broken', moduleKey: 'lead_recovery', kind: 'unread', hours: null, raised: false });
    assert.deepEqual(check.alerts.map((row) => row.tenantId), ['quiet']);
  });

  test('a module with no arrival list is reported as unwatched and never read', async () => {
    const check = world([live('other', { moduleKey: 'estimate_recovery' })]);
    const report = await check.run();
    assert.equal(report.checked, 0);
    assert.equal(report.results[0].kind, 'unwatched');
    assert.equal(check.asked.length, 0);
  });

  test('the report carries no words from the alert and nobody\'s number', async () => {
    const check = world([live('quiet')], { quiet: ago(72) });
    const report = await check.run();
    assert.deepEqual(Object.keys(report.results[0]).sort(), ['hours', 'kind', 'moduleKey', 'raised', 'tenantId']);
  });
});

describe('where the check lives', () => {
  const service = source('supabase/functions/_shared/watch/service.ts');
  const dispatch = source('supabase/functions/dispatch/index.ts');

  test('it writes to alerts and to nothing else', () => {
    const written = [...service.matchAll(/\.from\('(\w+)'\)\s*\.(insert|update|upsert|delete)/g)].map((match) => match[1]);
    assert.deepEqual(written, ['alerts']);
    assert.doesNotMatch(service, /\.rpc\(|emit\(|writeEvents|emitEvents/, 'no event, no function call');
  });

  test('it reads who is live from the lifecycle, never from the mirror switch', () => {
    assert.match(service, /from\('tenant_modules'\)[^;]*\.eq\('state', 'active'\)/s);
    assert.doesNotMatch(service, /module_configs/);
  });

  test('a canary and a failed event are never an arrival', () => {
    assert.match(service, /\.eq\('is_canary', false\)/);
    assert.match(service, /\.eq\('status', 'success'\)/);
  });

  test('the dispatcher runs it only when asked, after the caller is checked, and then does not run the queue', () => {
    const watch = dispatch.indexOf('body.watch === true');
    assert.ok(watch > dispatch.indexOf("caller = 'operator'"), 'the caller is known first');
    assert.ok(watch < dispatch.indexOf('runDueActions(deps'), 'and the queue is not run on a watch');
    assert.match(dispatch.slice(watch, dispatch.indexOf('const limit')), /return json\(\{ ok: true, \.\.\.report \}, 200\)/);
  });

  test('the console says what the check does and that nobody is paged', () => {
    const page = source('src/portal/pages/ops/Alerts.jsx');
    assert.doesNotMatch(page, /detection is not built/);
    assert.match(page, /nobody is paged/);
    assert.match(page, /quietAfterHours\('lead_recovery'\)/);
  });
});

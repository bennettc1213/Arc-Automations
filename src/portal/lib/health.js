/* whether each module is actually working, and what the answer is based on.
 *
 * the trap this file exists to avoid: a workflow platform reporting a green execution means
 * the workflow ran without throwing. it does not mean a text reached a customer, that the
 * upstream form still sends the field we read, or that anything arrived at all. a module
 * marked healthy on that basis is a green light wired to the wrong sensor, and the whole
 * value of this product is that its green lights are wired to the right one.
 *
 * so health is assembled from verification evidence only — the canary that traverses the
 * live pipeline, the schema assert that proves the payload shape, the watermark that proves
 * volume did not silently collapse — plus the module's own delivery failures and silence.
 *
 * and there is a state for "we have no evidence": `unverified`. a module producing events
 * with nothing checking them is not healthy, it is unmonitored, and saying so is the honest
 * answer. it is also the state that tells an operator exactly what to go and wire up.
 */

import { utc } from './metrics.js';
import { MODULE_EVENT_TYPES, MODULES, moduleForEvent } from './types.js';
import { MODULE_META } from './modules.js';

const RECENT_HOURS = 24;
/* a quarter of everything failing inside a day is an outage; one failure is a bad number
   or a carrier hiccup, and colouring the module red for it teaches people to ignore red. */
const FAILING_RATE = 0.25;

const STATE_WORD = {
  unavailable: 'not set up',
  awaiting: 'awaiting connection',
  failing: 'action required',
  degraded: 'degraded',
  quiet: 'quiet',
  unverified: 'not verified',
  healthy: 'working',
};

/* ranked worst-first. the summary names the worst thing that is true, because a status line
   that leads with the second-worst problem is one somebody acts on too late. */
const STATE_RANK = ['failing', 'degraded', 'quiet', 'unverified', 'awaiting', 'unavailable', 'healthy'];

export function computeModuleHealth(events, availability, now) {
  const byModule = new Map();
  for (const key of MODULES) {
    byModule.set(key, {
      business: [],
      canary: [],
      schema: [],
      watermark: [],
    });
  }

  for (const event of events) {
    const key = moduleForEvent(event);
    const bucket = byModule.get(key);
    if (!bucket) continue;

    if (event.eventType === 'canary_check') bucket.canary.push(event);
    else if (event.eventType === 'schema_assert') bucket.schema.push(event);
    else if (event.eventType === 'watermark_check') bucket.watermark.push(event);
    else if (!event.isCanary && MODULE_EVENT_TYPES[key]?.includes(event.eventType)) {
      bucket.business.push(event);
    }
  }

  const recentFrom = now.minus({ hours: RECENT_HOURS });
  const newestFirst = (list) =>
    list.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const result = {};

  for (const key of MODULES) {
    const meta = MODULE_META[key];
    const avail = availability[key];
    const bucket = byModule.get(key);

    const canary = newestFirst(bucket.canary);
    const schema = newestFirst(bucket.schema);
    const watermark = newestFirst(bucket.watermark);
    const business = newestFirst(bucket.business);

    const recent = business.filter((e) => utc(e.occurredAt) >= recentFrom);
    const recentFailures = recent.filter((e) => e.status === 'failure');
    const authFailure = recentFailures.find(
      (e) => (e.errorClass ?? e.payload?.error_class) === 'auth',
    );

    const checks = [];
    const push = (id, label, tone, detail) => checks.push({ key: id, label, tone, detail });

    /* ── the evidence, each stated whether or not it fired ── */

    if (canary.length) {
      const latest = canary[0];
      const failed = latest.status === 'failure';
      const recentlyFailed = canary.slice(0, 3).some((c) => c.status === 'failure');
      push(
        'canary',
        'end-to-end check',
        failed ? 'fail' : recentlyFailed ? 'warn' : 'ok',
        failed
          ? (latest.payload?.reason ?? 'the last check did not complete')
          : recentlyFailed
            ? 'a recent check failed and the next one passed'
            : 'a synthetic job went through the live pipeline and came out',
      );
    } else {
      push('canary', 'end-to-end check', 'idle', 'no check runs against this module yet');
    }

    if (schema.length) {
      const latest = schema[0];
      push(
        'schema',
        'payload shape',
        latest.status === 'failure' ? 'fail' : 'ok',
        latest.status === 'failure'
          ? (latest.payload?.reason ?? 'the incoming payload changed shape')
          : 'the fields we read are still the fields being sent',
      );
    }

    if (watermark.length) {
      const latest = watermark[0];
      push(
        'watermark',
        'volume',
        latest.status === 'failure' ? 'warn' : 'ok',
        latest.status === 'failure'
          ? (latest.payload?.reason ?? 'volume fell below the expected floor')
          : 'volume is inside the expected band',
      );
    }

    if (authFailure) {
      push(
        'auth',
        'connection credentials',
        'fail',
        'a connected account rejected us — the credential likely needs renewing',
      );
    }

    if (recent.length) {
      const rate = recentFailures.length / recent.length;
      push(
        'delivery',
        'delivery',
        recentFailures.length === 0 ? 'ok' : rate >= FAILING_RATE ? 'fail' : 'warn',
        recentFailures.length === 0
          ? `nothing failed in the last ${RECENT_HOURS} hours`
          : `${recentFailures.length} of ${recent.length} failed in the last ${RECENT_HOURS} hours`,
      );
    }

    if (avail.lastSuccessAt) {
      push(
        'freshness',
        'last activity',
        avail.isQuiet ? 'warn' : 'ok',
        avail.isQuiet
          ? `nothing has come through for ${Math.round(avail.quietHours)} hours`
          : 'recent',
      );
    }

    /* ── the verdict ──
       ordered so the worst true thing wins, and so "healthy" is only reachable with at
       least one piece of verification evidence behind it. */

    const verified = canary.length > 0 || schema.length > 0 || watermark.length > 0;
    const latestCanaryFailed = canary.length > 0 && canary[0].status === 'failure';
    const latestSchemaFailed = schema.length > 0 && schema[0].status === 'failure';
    const latestWatermarkFailed = watermark.length > 0 && watermark[0].status === 'failure';
    const canaryWobbled = canary.slice(0, 3).some((c) => c.status === 'failure');
    const failureRate = recent.length ? recentFailures.length / recent.length : 0;

    let state;
    if (avail.state === 'unavailable') state = 'unavailable';
    else if (avail.state === 'awaiting') state = 'awaiting';
    else if (latestCanaryFailed || latestSchemaFailed || authFailure) state = 'failing';
    else if (recentFailures.length > 0 && failureRate >= FAILING_RATE) state = 'failing';
    else if (recentFailures.length > 0 || canaryWobbled || latestWatermarkFailed) state = 'degraded';
    else if (avail.isQuiet) state = 'quiet';
    else if (!verified) state = 'unverified';
    else state = 'healthy';

    const worst = checks.find((c) => c.tone === 'fail') ?? checks.find((c) => c.tone === 'warn');

    result[key] = {
      key,
      label: meta.label,
      state,
      word: STATE_WORD[state],
      checks,
      verified,
      lastSuccessAt: avail.lastSuccessAt,
      lastCheckAt: canary[0]?.occurredAt ?? schema[0]?.occurredAt ?? watermark[0]?.occurredAt ?? null,
      summary:
        state === 'unavailable'
          ? 'not part of your plan'
          : state === 'awaiting'
            ? meta.awaiting
            : state === 'unverified'
              ? 'running, but nothing is checking it end to end yet'
              : state === 'quiet'
                ? `nothing has come through for ${Math.round(avail.quietHours ?? 0)} hours`
                : (worst?.detail ?? 'checked end to end and working'),
    };
  }

  return result;
}

/* the one word the shell puts in front of a client: the worst state any live module is in.
   deliberately not an average — four working modules do not cancel out a broken one. */
export function overallHealth(health) {
  const live = Object.values(health).filter(
    (m) => m.state !== 'unavailable' && m.state !== 'awaiting',
  );
  if (live.length === 0) return { state: 'awaiting', word: STATE_WORD.awaiting, modules: [] };

  const worst = STATE_RANK.find((state) => live.some((m) => m.state === state)) ?? 'healthy';
  return {
    state: worst,
    word: STATE_WORD[worst],
    modules: live.filter((m) => m.state === worst).map((m) => m.label),
  };
}

export { STATE_WORD as HEALTH_WORD };

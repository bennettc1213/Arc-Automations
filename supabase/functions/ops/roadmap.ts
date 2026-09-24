/**
 * The roadmap assistant's operator surface.
 *
 * Behind the `ops` function's admin check like everything else in this directory: by the time
 * a request reaches here the caller's JWT has been verified and `is_arc_admin()` has said yes.
 * It answers questions about docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md and does nothing
 * else — no write, no workflow, no deploy, no client data. The only thing it reads besides the
 * roadmap is the operator's own question.
 *
 *   roadmap-status   which roadmap is loaded (digest, revision date) and whether a model is
 *                    configured. never calls the model.
 *   roadmap-ask      { question, history? } → an answer, its status and the cited sections.
 *
 * Read-only, so not audited, like the pipeline probe. What is logged is operational metadata
 * only — the actor, the roadmap digest, the sections used, the outcome and the timing. Never
 * the question or the answer.
 *
 * Every figure in an answer comes from the roadmap file. Nothing here knows what it says.
 */

import {
  answerRoadmapQuestion,
  cleanHistory,
  QUESTION_MAX_CHARS,
  RoadmapAnswerError,
} from '../_shared/roadmap/answer.ts';
import type { RoadmapModel } from '../_shared/roadmap/model.ts';
import {
  type LoadedRoadmap,
  RoadmapSourceError,
  type RoadmapSource,
  sourceMeta,
} from '../_shared/roadmap/source.ts';

export const ROADMAP_ACTIONS = ['roadmap-status', 'roadmap-ask'];

/* ── in-process rate limit ──
   Per operator, per function instance, stated plainly as it is on the other functions: it
   stops a runaway loop or a stuck key spending on the model, not a determined caller — and the
   only callers who reach this are operators. */
export type RoadmapLimiter = { take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } };

export function createRoadmapLimiter(
  options: { perMinute?: number; perHour?: number; now?: () => number } = {},
): RoadmapLimiter {
  const perMinute = options.perMinute ?? 8;
  const perHour = options.perHour ?? 60;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, { minute: number[]; hour: number[] }>();

  return {
    take(key) {
      const t = now();
      const w = windows.get(key) ?? { minute: [], hour: [] };
      w.minute = w.minute.filter((at) => t - at < 60_000);
      w.hour = w.hour.filter((at) => t - at < 3_600_000);
      if (w.minute.length >= perMinute) {
        windows.set(key, w);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (t - w.minute[0])) / 1000)) };
      }
      if (w.hour.length >= perHour) {
        windows.set(key, w);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((3_600_000 - (t - w.hour[0])) / 1000)) };
      }
      w.minute.push(t);
      w.hour.push(t);
      windows.set(key, w);
      return { ok: true };
    },
  };
}

export type RoadmapActionDeps = {
  body: Record<string, unknown>;
  actorId: string | null;
  source: RoadmapSource;
  model: RoadmapModel;
  limiter: RoadmapLimiter;
  log?: (entry: Record<string, unknown>) => void;
};

export type RoadmapActionResult = { status: number; body: unknown; headers?: Record<string, string> };

const MODEL_FAILURE: Record<RoadmapAnswerError['kind'], { status: number; code: string; message: string }> = {
  unconfigured: {
    status: 503,
    code: 'provider_unconfigured',
    message: 'The roadmap assistant has no model configured: ANTHROPIC_API_KEY is not set on the ops function.',
  },
  refused: { status: 502, code: 'model_refused', message: 'The model declined to answer that question.' },
  truncated: { status: 502, code: 'model_failed', message: 'The answer ran past its length limit. Try a narrower question.' },
  timeout: { status: 504, code: 'model_timeout', message: 'The model did not answer in time. Try again.' },
  failed: { status: 502, code: 'model_failed', message: 'The model request failed. Try again.' },
};

function sourceFailure(error: unknown): RoadmapActionResult {
  if (error instanceof RoadmapSourceError) {
    return {
      status: 503,
      body: { error: `The roadmap source could not be used: ${error.message}.`, code: error.code },
    };
  }
  return { status: 503, body: { error: 'The roadmap source could not be loaded.', code: 'source_unavailable' } };
}

export async function handleRoadmapAction(action: string, deps: RoadmapActionDeps): Promise<RoadmapActionResult> {
  const { body, actorId, source, model, limiter } = deps;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));

  /* the gate in ops/index.ts has already run. this is the same refusal again, so the handler
     is safe to call from anywhere without it. */
  if (!actorId) return { status: 401, body: { error: 'not signed in', code: 'unauthenticated' } };

  if (action === 'roadmap-status') {
    try {
      const loaded = await source.load();
      return {
        status: 200,
        body: {
          ok: true,
          source: sourceMeta(loaded),
          assistant: { configured: model.configured, provider: model.provider, model: model.model },
        },
      };
    } catch (error) {
      return sourceFailure(error);
    }
  }

  if (action !== 'roadmap-ask') return { status: 400, body: { error: 'unknown action' } };

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return { status: 400, body: { error: 'Ask a question about the roadmap.', code: 'bad_question' } };
  if (question.length > QUESTION_MAX_CHARS) {
    return { status: 400, body: { error: `Questions are limited to ${QUESTION_MAX_CHARS} characters.`, code: 'bad_question' } };
  }
  const history = cleanHistory(body.history);

  const allowed = limiter.take(actorId);
  if (!allowed.ok) {
    return {
      status: 429,
      body: { error: 'Too many roadmap questions just now. Wait a moment and try again.', code: 'rate_limited' },
      headers: { 'Retry-After': String(allowed.retryAfterSeconds) },
    };
  }

  let loaded: LoadedRoadmap;
  try {
    loaded = await source.load();
  } catch (error) {
    log({ event: 'roadmap.ask', actor: actorId, outcome: 'source_unavailable' });
    return sourceFailure(error);
  }
  const meta = sourceMeta(loaded);

  try {
    const result = await answerRoadmapQuestion({ index: loaded.index, question, history, model });
    log({
      event: 'roadmap.ask',
      actor: actorId,
      roadmap: meta.short,
      sections: result.sections,
      outcome: result.status,
      withheld: result.withheld,
      model: result.model,
      ms: result.ms,
    });
    return {
      status: 200,
      body: {
        ok: true,
        status: result.status,
        answer: result.answer,
        citations: result.citations,
        missing: result.missing,
        withheld: result.withheld,
        source: meta,
        model: result.model,
      },
    };
  } catch (error) {
    if (error instanceof RoadmapAnswerError) {
      const failure = MODEL_FAILURE[error.kind];
      log({ event: 'roadmap.ask', actor: actorId, roadmap: meta.short, outcome: failure.code });
      return { status: failure.status, body: { error: failure.message, code: failure.code, source: meta } };
    }
    log({ event: 'roadmap.ask', actor: actorId, roadmap: meta.short, outcome: 'error' });
    return { status: 500, body: { error: 'The roadmap assistant failed. Try again.', code: 'internal' } };
  }
}

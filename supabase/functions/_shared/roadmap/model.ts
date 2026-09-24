/**
 * The model behind the roadmap assistant.
 *
 * The same provider and the same secret the Lead Recovery classifier uses
 * (`_shared/classifier.ts`): Anthropic over plain fetch, `ANTHROPIC_API_KEY` read by the
 * `ops` function and handed in here. No SDK, for the classifier's reason: one POST is not
 * worth a dependency, and without one this file loads in node's test runner. The key is
 * never logged, never returned and never put in an error — a provider error body can echo
 * request headers, so only its status and error type survive.
 *
 * The model is asked for JSON that matches ROADMAP_REPLY_SCHEMA (structured outputs), so
 * what comes back is a status, an answer and the excerpt labels it cites — which is what lets
 * `answer.ts` check the answer against the roadmap before anyone reads it.
 */

export const DEFAULT_ROADMAP_MODEL = 'claude-opus-5';

export type RoadmapModelRequest = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
};

export type RoadmapModelResult =
  | { ok: true; text: string; model: string; ms: number }
  | {
      ok: false;
      kind: 'unconfigured' | 'refused' | 'truncated' | 'timeout' | 'failed';
      reason: string;
      model: string | null;
      ms: number;
    };

export interface RoadmapModel {
  readonly provider: string;
  readonly model: string | null;
  readonly configured: boolean;
  complete(request: RoadmapModelRequest): Promise<RoadmapModelResult>;
}

/** no key on this deployment. says so, every time, and never guesses. */
export class UnconfiguredRoadmapModel implements RoadmapModel {
  readonly provider = 'none';
  readonly model = null;
  readonly configured = false;
  private readonly why: string;

  constructor(why = 'ANTHROPIC_API_KEY is not set on the ops function') {
    this.why = why;
  }

  // deno-lint-ignore require-await
  async complete(): Promise<RoadmapModelResult> {
    return { ok: false, kind: 'unconfigured', reason: this.why, model: null, ms: 0 };
  }
}

export class AnthropicRoadmapModel implements RoadmapModel {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly configured = true;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string | null = null, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_ROADMAP_MODEL;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async complete(request: RoadmapModelRequest): Promise<RoadmapModelResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    /* a safety classifier can decline a request outright. the server-side fallback re-runs
       it on the model Anthropic recommends for that category inside the same call, and is
       only sent for the default model, where it is known to be accepted. */
    const withFallback = this.model === DEFAULT_ROADMAP_MODEL;

    try {
      const response = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          ...(withFallback ? { fallbacks: 'default' } : {}),
          output_config: {
            /* a lookup in a few pages of text, not a research task. */
            effort: 'medium',
            format: { type: 'json_schema', schema: request.schema },
          },
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        }),
      });

      const ms = Date.now() - started;

      if (!response.ok) {
        let type = '';
        try {
          const body = (await response.json()) as { error?: { type?: unknown } };
          const t = body?.error?.type;
          if (typeof t === 'string' && /^[a-z_]{1,60}$/.test(t)) type = `: ${t}`;
        } catch {
          /* not json. the status alone is the report. */
        }
        return { ok: false, kind: 'failed', reason: `the model answered ${response.status}${type}`, model: this.model, ms };
      }

      const body = (await response.json()) as {
        model?: string;
        stop_reason?: string;
        content?: { type?: string; text?: string }[];
      };

      if (body.stop_reason === 'refusal') {
        return { ok: false, kind: 'refused', reason: 'the model declined the request', model: body.model ?? this.model, ms };
      }
      if (body.stop_reason === 'max_tokens') {
        return { ok: false, kind: 'truncated', reason: 'the answer ran past its length limit', model: body.model ?? this.model, ms };
      }

      const text = (body.content ?? [])
        .filter((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
        .trim();
      if (!text) {
        return { ok: false, kind: 'failed', reason: 'the model returned no text', model: body.model ?? this.model, ms };
      }
      return { ok: true, text, model: body.model ?? this.model, ms };
    } catch {
      /* the thrown error's own text is not repeated: it is a network message at best. */
      const ms = Date.now() - started;
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        kind: aborted ? 'timeout' : 'failed',
        reason: aborted ? `no answer in ${Math.round(this.timeoutMs / 1000)}s` : 'the request to the model failed',
        model: this.model,
        ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** the model for this deployment's secrets. no key is an honest refusal, not a fallback. */
export function roadmapModelFor(
  env: { anthropicKey?: string | null; model?: string | null },
  fetchImpl: typeof fetch = fetch,
): RoadmapModel {
  if (!env.anthropicKey) return new UnconfiguredRoadmapModel();
  return new AnthropicRoadmapModel(env.anthropicKey, env.model ?? null, fetchImpl);
}

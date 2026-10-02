/**
 * The model behind the roadmap assistant.
 *
 * Anthropic by default, with the same secret the Lead Recovery classifier uses
 * (`_shared/classifier.ts`); OpenAI when `ARC_ROADMAP_PROVIDER=openai`; Google's Gemini
 * (`=google`) or Groq (`=groq`), each with a free tier — Groq's the one that does not ask an
 * account for a payment method to use it. All four are plain fetch, no SDK, for the
 * classifier's reason: one POST is not worth a dependency, and without one this file loads
 * in node's test runner. The key is read by the `ops` function and handed
 * in here. It is never logged, never returned and never put in an error: a provider error can
 * echo request headers, so what an operator is shown of one is its status, its type and its
 * message with anything key-shaped removed (`redactProviderText`).
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

/* a key set from a terminal or a dashboard arrives with quotes, a trailing newline or a stray
   space more often than anyone admits, and any of them turns a valid key into a rejected one
   or a request that never leaves. */
export function cleanApiKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/* a model name copied from instructions arrives as `<gpt-x>` or `"gpt-x"`: the brackets mark
   where a value goes and were never part of it. stripped, so a pasted placeholder still works;
   what is left must look like a model id, and anything else is refused by name. */
export function cleanModelName(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/^[\s"'`<>]+|[\s"'`<>]+$/g, '');
}

const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,}$/;
const KEY_LIKE = /sk-[A-Za-z0-9_-]{6,}/g;

/**
 * provider and network error text for the operator, with anything key-shaped removed.
 *
 * the operator needs the real reason ("credit balance is too low", "invalid x-api-key") to fix
 * a deployment, so it is shown. a provider or runtime error can also echo request headers, so
 * the configured key and anything that looks like one is replaced first, control characters are
 * dropped, and the length is bounded.
 */
export function redactProviderText(text: unknown, secret?: string, max = 240): string {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('[key]');
  return out
    .replace(KEY_LIKE, '[key]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

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

/**
 * search-only, on purpose: `ARC_ROADMAP_PROVIDER=search`. no model is called, whatever keys
 * exist. it reports itself as unconfigured, which is how the handler knows to show the
 * roadmap's own passages (search.ts) instead of a written answer.
 */
export class SearchOnlyRoadmapModel implements RoadmapModel {
  readonly provider = 'search';
  readonly model = null;
  readonly configured = false;

  // deno-lint-ignore require-await
  async complete(): Promise<RoadmapModelResult> {
    return {
      ok: false,
      kind: 'unconfigured',
      reason: 'search-only mode is selected (ARC_ROADMAP_PROVIDER=search)',
      model: null,
      ms: 0,
    };
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
        let message = '';
        try {
          const body = (await response.json()) as { error?: { type?: unknown; message?: unknown } };
          const t = body?.error?.type;
          if (typeof t === 'string' && /^[a-z_]{1,60}$/.test(t)) type = `: ${t}`;
          if (typeof body?.error?.message === 'string') message = redactProviderText(body.error.message, this.apiKey);
        } catch {
          /* not json. the status alone is the report. */
        }
        return {
          ok: false,
          kind: 'failed',
          reason: `the model answered ${response.status}${type}${message ? ` — ${message}` : ''}`,
          model: this.model,
          ms,
        };
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
    } catch (error) {
      const ms = Date.now() - started;
      const aborted = controller.signal.aborted;
      /* what threw is named — a rejected header, a refused connection, a body that was not
         JSON — because "the request failed" alone sends the operator guessing. */
      const what = redactProviderText(`${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? ''}`, this.apiKey, 200);
      return {
        ok: false,
        kind: aborted ? 'timeout' : 'failed',
        reason: aborted ? `no answer in ${Math.round(this.timeoutMs / 1000)}s` : `the request to the model failed (${what})`,
        model: this.model,
        ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The OpenAI-compatible Chat Completions request both OpenAI and Groq accept, one call site
 * for both adapters below: same request shape, same `response_format: json_schema` strict
 * structured output, same error shape (`{ error: { type, code, message } }`), differing only
 * in which URL and key answer it.
 *
 * `max_completion_tokens` rather than `max_tokens`, because reasoning models reject the older
 * name and the rest accept the newer. No `temperature`, which reasoning models reject. Errors
 * carry a `code` as well as a `type` (`insufficient_quota` is OpenAI's "no credit"), so both
 * are reported.
 */
async function chatCompletionsComplete(
  baseUrl: string,
  apiKey: string,
  model: string,
  request: RoadmapModelRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RoadmapModelResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(baseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: request.maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'roadmap_reply', strict: true, schema: request.schema },
        },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });

    const ms = Date.now() - started;

    if (!response.ok) {
      let type = '';
      let message = '';
      try {
        const body = (await response.json()) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
        const words = [body?.error?.type, body?.error?.code].filter(
          (w, i, all): w is string => typeof w === 'string' && /^[a-z_]{1,60}$/.test(w) && all.indexOf(w) === i,
        );
        if (words.length) type = `: ${words.join(' / ')}`;
        if (typeof body?.error?.message === 'string') message = redactProviderText(body.error.message, apiKey);
      } catch {
        /* not json. the status alone is the report. */
      }
      return {
        ok: false,
        kind: 'failed',
        reason: `the model answered ${response.status}${type}${message ? ` — ${message}` : ''}`,
        model,
        ms,
      };
    }

    const body = (await response.json()) as {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
    };
    const choice = body.choices?.[0];
    const served = body.model ?? model;

    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      return { ok: false, kind: 'refused', reason: 'the model declined the request', model: served, ms };
    }
    if (choice?.finish_reason === 'length') {
      return { ok: false, kind: 'truncated', reason: 'the answer ran past its length limit', model: served, ms };
    }

    const text = (choice?.message?.content ?? '').trim();
    if (!text) return { ok: false, kind: 'failed', reason: 'the model returned no text', model: served, ms };
    return { ok: true, text, model: served, ms };
  } catch (error) {
    const ms = Date.now() - started;
    const aborted = controller.signal.aborted;
    const what = redactProviderText(`${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? ''}`, apiKey, 200);
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'failed',
      reason: aborted ? `no answer in ${Math.round(timeoutMs / 1000)}s` : `the request to the model failed (${what})`,
      model,
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * OpenAI (the ChatGPT API), over plain fetch, on Chat Completions.
 *
 * Chosen for reach: every current OpenAI chat model answers it. There is deliberately no
 * default model. OpenAI renames and retires models often enough that a name written here
 * would be a guess by the time it is read, so the operator names one (`ARC_ROADMAP_MODEL`),
 * and a wrong name comes back as the provider's own "model not found", which the panel shows.
 */
export class OpenAIRoadmapModel implements RoadmapModel {
  readonly provider = 'openai';
  readonly model: string;
  readonly configured = true;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  complete(request: RoadmapModelRequest): Promise<RoadmapModelResult> {
    return chatCompletionsComplete(OPENAI_URL, this.apiKey, this.model, request, this.fetchImpl, this.timeoutMs);
  }
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Groq, over the same OpenAI-compatible Chat Completions endpoint — chosen as the free-tier
 * option that does not ask for a payment method up front (Google AI Studio's Gemini does, in
 * at least some accounts and regions, despite advertising a free tier; this is the one that
 * actually let an operator through without one). Groq hosts open models (Llama, and others) at
 * high speed, with a free-tier rate limit rather than a bill. Like OpenAI and Gemini, there is
 * no default model — Groq's lineup and each model's own rate limit change, and only some
 * models support strict structured output, so a name that does not work comes back as Groq's
 * own error naming the model, which the panel shows.
 */
export class GroqRoadmapModel implements RoadmapModel {
  readonly provider = 'groq';
  readonly model: string;
  readonly configured = true;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  complete(request: RoadmapModelRequest): Promise<RoadmapModelResult> {
    return chatCompletionsComplete(GROQ_URL, this.apiKey, this.model, request, this.fetchImpl, this.timeoutMs);
  }
}

/* ROADMAP_REPLY_SCHEMA is JSON Schema (lowercase `type: 'object'`); Gemini's `responseSchema`
   is its own dialect, close to OpenAPI 3.0 (uppercase `type: "OBJECT"`, no `additionalProperties`,
   an optional `propertyOrdering`). converted once, here, so nothing upstream of the adapter needs
   to know the two dialects differ. */
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof schema.type === 'string') out.type = schema.type.toUpperCase();
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(props);
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items && typeof schema.items === 'object') out.items = toGeminiSchema(schema.items as Record<string, unknown>);
  return out;
}

/**
 * Google's Gemini API, over plain fetch — the free-tier option: Google AI Studio issues keys
 * with a free quota for current models, so a deployment with no budget can still get a written
 * answer, at the cost of that quota's own rate limits rather than a bill. There is deliberately
 * no default model, for the same reason as OpenAI's: Google's lineup changes over time, and a
 * name written into this file would be a guess by the time it is read. The operator names one
 * (`ARC_ROADMAP_MODEL`), and a name that does not exist comes back as Google's own `NOT_FOUND`.
 *
 * Uses `generateContent` with `responseMimeType: 'application/json'` and a translated
 * `responseSchema` (above). The key travels as the `x-goog-api-key` header, never the URL's
 * query string, so it never lands in a request log by way of the URL alone.
 */
export class GoogleRoadmapModel implements RoadmapModel {
  readonly provider = 'google';
  readonly model: string;
  readonly configured = true;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async complete(request: RoadmapModelRequest): Promise<RoadmapModelResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.user }] }],
            generationConfig: {
              maxOutputTokens: request.maxTokens,
              responseMimeType: 'application/json',
              responseSchema: toGeminiSchema(request.schema),
            },
          }),
        },
      );

      const ms = Date.now() - started;

      if (!response.ok) {
        let status = '';
        let message = '';
        try {
          const body = (await response.json()) as { error?: { status?: unknown; message?: unknown } };
          const s = body?.error?.status;
          if (typeof s === 'string' && /^[A-Z_]{1,60}$/.test(s)) status = `: ${s}`;
          if (typeof body?.error?.message === 'string') message = redactProviderText(body.error.message, this.apiKey);
        } catch {
          /* not json. the status alone is the report. */
        }
        return {
          ok: false,
          kind: 'failed',
          reason: `the model answered ${response.status}${status}${message ? ` — ${message}` : ''}`,
          model: this.model,
          ms,
        };
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
      };
      const candidate = body.candidates?.[0];

      /* a blocked prompt comes back with no candidate at all; anything else missing one is an
         empty reply to retry, not a decision to report as one. */
      if (!candidate) {
        return body.promptFeedback?.blockReason
          ? { ok: false, kind: 'refused', reason: 'the model declined the request', model: this.model, ms }
          : { ok: false, kind: 'failed', reason: 'the model returned no candidates', model: this.model, ms };
      }
      if (candidate.finishReason === 'MAX_TOKENS') {
        return { ok: false, kind: 'truncated', reason: 'the answer ran past its length limit', model: this.model, ms };
      }
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        return { ok: false, kind: 'refused', reason: 'the model declined the request', model: this.model, ms };
      }

      const text = (candidate.content?.parts ?? [])
        .map((part) => part?.text ?? '')
        .join('')
        .trim();
      if (!text) return { ok: false, kind: 'failed', reason: 'the model returned no text', model: this.model, ms };
      return { ok: true, text, model: this.model, ms };
    } catch (error) {
      const ms = Date.now() - started;
      const aborted = controller.signal.aborted;
      const what = redactProviderText(`${(error as Error)?.name ?? 'Error'}: ${(error as Error)?.message ?? ''}`, this.apiKey, 200);
      return {
        ok: false,
        kind: aborted ? 'timeout' : 'failed',
        reason: aborted ? `no answer in ${Math.round(this.timeoutMs / 1000)}s` : `the request to the model failed (${what})`,
        model: this.model,
        ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const ROADMAP_PROVIDERS = ['anthropic', 'openai', 'google', 'groq'] as const;
export type RoadmapProvider = (typeof ROADMAP_PROVIDERS)[number];

const KEY_NAME: Record<RoadmapProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
};

/* every provider but Anthropic needs a model name named explicitly — none of them get a
   default here, because a name written into this file is a guess the moment any of these
   providers renames or retires a model, and a wrong one comes back as that provider's own
   "model not found", which the panel shows. */
const NEEDS_MODEL: Record<Exclude<RoadmapProvider, 'anthropic'>, { label: string; docs: string; build: (key: string, model: string, fetchImpl: typeof fetch) => RoadmapModel }> = {
  openai: { label: 'OpenAI', docs: 'platform.openai.com/docs/models', build: (key, model, fetchImpl) => new OpenAIRoadmapModel(key, model, fetchImpl) },
  google: { label: 'Gemini', docs: 'ai.google.dev/gemini-api/docs/models', build: (key, model, fetchImpl) => new GoogleRoadmapModel(key, model, fetchImpl) },
  groq: { label: 'Groq', docs: 'console.groq.com/docs/models', build: (key, model, fetchImpl) => new GroqRoadmapModel(key, model, fetchImpl) },
};

export type RoadmapModelEnv = {
  anthropicKey?: string | null;
  openaiKey?: string | null;
  /** `GEMINI_API_KEY`, Google AI Studio's key — free tier, though some accounts and regions
      are asked for billing anyway despite it. */
  googleKey?: string | null;
  /** `GROQ_API_KEY` — free tier, no payment method asked for. */
  groqKey?: string | null;
  /** `ARC_ROADMAP_PROVIDER`. Unset means whichever key exists, checked in the order
      ROADMAP_PROVIDERS lists them: Anthropic, then OpenAI, then Google, then Groq. */
  provider?: string | null;
  /** `ARC_ROADMAP_MODEL`, for whichever provider is chosen. Required for every provider but
      Anthropic. */
  model?: string | null;
};

/**
 * the model for this deployment's secrets. a missing or malformed key, an unknown provider
 * and a setup with no model where one is required are each an honest refusal that says
 * which — never a fallback to some other provider, and never a guess.
 */
export function roadmapModelFor(env: RoadmapModelEnv, fetchImpl: typeof fetch = fetch): RoadmapModel {
  const asked = cleanModelName(env.provider).toLowerCase();
  if (asked === 'search') return new SearchOnlyRoadmapModel();
  if (asked && !(ROADMAP_PROVIDERS as readonly string[]).includes(asked)) {
    return new UnconfiguredRoadmapModel(
      `ARC_ROADMAP_PROVIDER is "${redactProviderText(asked, undefined, 40)}", which is not one of: ${[...ROADMAP_PROVIDERS, 'search'].join(', ')}`,
    );
  }

  const keys: Record<RoadmapProvider, string> = {
    anthropic: cleanApiKey(env.anthropicKey),
    openai: cleanApiKey(env.openaiKey),
    google: cleanApiKey(env.googleKey),
    groq: cleanApiKey(env.groqKey),
  };
  const provider: RoadmapProvider = (asked as RoadmapProvider) || ROADMAP_PROVIDERS.find((p) => keys[p]) || 'anthropic';
  const key = keys[provider];
  const name = KEY_NAME[provider];

  if (!key) return new UnconfiguredRoadmapModel(`${name} is not set on the ops function`);
  if (!KEY_SHAPE.test(key)) {
    return new UnconfiguredRoadmapModel(
      `${name} is set but does not look like a key (it contains spaces or other stray characters). Set it again with just the key`,
    );
  }

  const model = cleanModelName(env.model);
  if (model && !MODEL_SHAPE.test(model)) {
    return new UnconfiguredRoadmapModel(
      `ARC_ROADMAP_MODEL "${redactProviderText(env.model, undefined, 60)}" is not a model name (a model name has no spaces, quotes or < > brackets)`,
    );
  }
  if (provider !== 'anthropic') {
    const spec = NEEDS_MODEL[provider];
    if (!model) {
      return new UnconfiguredRoadmapModel(`ARC_ROADMAP_MODEL is not set. ${spec.label} needs a model name, such as one listed at ${spec.docs}`);
    }
    return spec.build(key, model, fetchImpl);
  }
  return new AnthropicRoadmapModel(key, model || null, fetchImpl);
}

/* the roadmap assistant, as the ops console holds it.
 *
 * everything the assistant knows lives server-side: the roadmap is read and searched inside
 * the `ops` edge function, and the model key never leaves it. this module only carries a
 * question there and an answer back — the browser never holds the roadmap, and nothing here
 * knows what it says. the starter questions are phrasings, not answers.
 *
 * the conversation is kept in memory only. a fresh page load starts a fresh chat, and still
 * answers correctly, because every question is answered from the roadmap again rather than
 * from what was said before. a short window of recent turns goes with each question, so
 * "and after that?" can be understood.
 *
 * no imports: the component hands in the endpoint, the anon key and the session, so this
 * file runs in node's test runner as it is.
 */

export const STARTER_QUESTIONS = [
  'What is the next prompt?',
  'When does n8n first connect to ARC?',
  'When is the Lead Recovery workflow built?',
  'When do we deploy to production?',
  'What do the optimization prompts do?',
];

/* mirrors QUESTION_MAX_CHARS and HISTORY_MAX_TURNS in _shared/roadmap/answer.ts; the server
   enforces both, this only keeps the textarea honest. */
export const QUESTION_LIMIT = 1000;
export const HISTORY_TURNS = 6;

/* what an operator reads when a request fails. each is the fix, not the status code. */
export function describeFailure(status, payload) {
  const code = payload?.code;
  if (status === 404) return { message: 'The ops function is not deployed, so there is nothing to ask.', retry: false };
  if (status === 400 && payload?.error === 'unknown action') {
    return {
      message: 'The deployed ops function predates the roadmap assistant. Redeploy it: supabase functions deploy ops.',
      retry: false,
    };
  }
  if (status === 401) return { message: 'Your session has ended. Sign in again to ask the roadmap.', retry: false };
  if (status === 403) return { message: 'Only ARC operators can use the roadmap assistant.', retry: false };
  if (code === 'provider_unconfigured') {
    return {
      message: `${payload.error} Nothing was answered, and nothing was guessed.`,
      retry: false,
    };
  }
  if (code === 'bad_question') return { message: payload.error, retry: false };
  if (payload?.error) return { message: payload.error, retry: status === 429 || status >= 500 };
  return { message: `The roadmap assistant failed (${status}).`, retry: status >= 500 || status === 0 };
}

export class RoadmapRequestError extends Error {
  constructor(message, { status, payload, retry }) {
    super(message);
    this.name = 'RoadmapRequestError';
    this.status = status;
    this.payload = payload ?? null;
    this.retry = Boolean(retry);
  }
}

/**
 * the two calls, bound to one ops endpoint and one operator's session.
 *
 *   endpoint   the ops function's url
 *   anonKey    the project's browser key, which the functions gateway wants as `apikey`
 *   getToken   resolves the operator's current access token (null when signed out)
 *
 * the function decides who may ask. a missing token is sent as no token, and refused there.
 */
export function createRoadmapClient({ endpoint, anonKey = '', getToken = async () => null, fetchImpl = globalThis.fetch }) {
  const call = (body) => callRoadmap(body, { endpoint, anonKey, getToken, fetchImpl });
  return {
    status: () => call({ action: 'roadmap-status' }),
    ask: (question, history = []) =>
      call({ action: 'roadmap-ask', question, history: history.slice(-HISTORY_TURNS) }),
  };
}

async function callRoadmap(body, { endpoint, anonKey, getToken, fetchImpl }) {
  let response;
  try {
    const accessToken = await getToken();
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey ?? '',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RoadmapRequestError('Could not reach the ops function. Check the connection and try again.', {
      status: 0,
      retry: true,
    });
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* a gateway error page, not json. the status is the message. */
  }
  if (!response.ok) {
    const { message, retry } = describeFailure(response.status, payload);
    throw new RoadmapRequestError(message, { status: response.status, payload, retry });
  }
  return payload;
}

/* the recent turns a question carries: what was asked and what was answered before it. the
   question being asked is not its own history — `messages` already ends with it once sent,
   and a retry sends it again — and an answer that was withheld is not context worth sending. */
export function historyFor(messages) {
  const before = messages.length && messages[messages.length - 1].role === 'user' ? messages.slice(0, -1) : messages;
  return before
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status !== 'unverified'))
    .map((m) => ({ role: m.role, content: m.role === 'user' ? m.text : m.answer }))
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_TURNS);
}

/* "Roadmap source updated: September 23, 2026 · 18baed92e367". */
export function sourceLine(source) {
  if (!source) return null;
  const when = source.revised ?? 'no revision date in the file';
  return `Roadmap source updated: ${when} · ${source.short}${source.stale ? ' (cached — the source is unreachable)' : ''}`;
}

export const STATUS_NOTE = {
  partial: 'Partly answered — the roadmap covers some of this.',
  not_in_roadmap: 'Not in the roadmap.',
  unverified: 'Withheld — the answer could not be checked against the roadmap.',
};

/* ── the conversation ─────────────────────────────────────────────── */

export const initialChat = { messages: [], pending: null, error: null, nextId: 1 };

export function chatReducer(state, action) {
  switch (action.type) {
    case 'send': {
      const text = String(action.question ?? '').trim();
      if (!text || state.pending) return state;
      return {
        ...state,
        messages: [...state.messages, { id: state.nextId, role: 'user', text }],
        pending: { question: text },
        error: null,
        nextId: state.nextId + 1,
      };
    }
    case 'answer': {
      const r = action.response ?? {};
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: state.nextId,
            role: 'assistant',
            status: r.status ?? 'answered',
            answer: String(r.answer ?? ''),
            citations: Array.isArray(r.citations) ? r.citations : [],
            missing: r.missing ?? null,
            withheld: r.withheld ?? null,
          },
        ],
        pending: null,
        nextId: state.nextId + 1,
      };
    }
    case 'fail':
      return {
        ...state,
        pending: null,
        error: { message: action.message, retry: Boolean(action.retry), question: state.pending?.question ?? null },
      };
    case 'retry':
      if (!state.error?.question || state.pending) return state;
      return { ...state, pending: { question: state.error.question }, error: null };
    case 'dismiss':
      return { ...state, error: null };
    case 'reset':
      return initialChat;
    default:
      return state;
  }
}

/* what a key does in the question box. enter asks; shift+enter is a new line; an IME still
   composing a character owns its enter; escape closes the panel. */
export function composerKey(event) {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === 'Escape') return 'close';
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) return 'send';
  return null;
}

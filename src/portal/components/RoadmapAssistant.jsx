import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import Icon from './Icon';
import { anonKey, functionUrl, getSupabase } from '../lib/supabase';
import {
  QUESTION_LIMIT,
  STARTER_QUESTIONS,
  STATUS_NOTE,
  chatReducer,
  composerKey,
  createRoadmapClient,
  historyFor,
  initialChat,
  sourceLine,
} from '../lib/roadmap-assistant';
import { parseSafeMarkdown } from '../lib/safe-markdown';
import './RoadmapAssistant.css';

/**
 * the roadmap assistant: a docked panel in the ops console that answers questions about the
 * canonical roadmap, and nothing else.
 *
 * it is mounted inside the console only, which renders for an arc_admins session and no one
 * else — and the ops function refuses any other caller regardless, so hiding it here is
 * manners, not the lock. it holds no roadmap: every question goes to the function, which
 * reads the roadmap from the repository and answers from it. the panel says which version
 * of the roadmap answered, and prints each answer's sources under it.
 *
 * it cannot act. there is no control here that changes anything but the conversation.
 */

async function operatorToken() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function Inline({ nodes }) {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'strong':
        return (
          <strong key={i}>
            <Inline nodes={node.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inline nodes={node.children} />
          </em>
        );
      case 'code':
        return <code key={i}>{node.text}</code>;
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            <Inline nodes={node.children} />
          </a>
        );
      default:
        return <span key={i}>{node.text}</span>;
    }
  });
}

/* model output, rendered from parsed data — never as html. */
export function SafeMarkdown({ text }) {
  const blocks = useMemo(() => parseSafeMarkdown(text), [text]);
  return blocks.map((block, i) => {
    if (block.type === 'code') {
      return (
        <pre key={i}>
          <code>{block.text}</code>
        </pre>
      );
    }
    if (block.type === 'list') {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List key={i}>
          {block.items.map((item, j) => (
            <li key={j}>
              <Inline nodes={item} />
            </li>
          ))}
        </List>
      );
    }
    return (
      <p key={i}>
        <Inline nodes={block.children} />
      </p>
    );
  });
}

function Answer({ message }) {
  const note = STATUS_NOTE[message.status];
  return (
    <div className={`rma-msg rma-msg--roadmap rma-msg--${message.status}`}>
      <span className="rma-msg__who">roadmap</span>
      {note && <p className="rma-msg__note">{note}</p>}
      <div className="rma-msg__body">
        <SafeMarkdown text={message.answer} />
      </div>
      {message.missing && (
        <p className="rma-msg__missing">
          <span>Open in the roadmap:</span> {message.missing}
        </p>
      )}
      {message.citations.length > 0 && (
        <ul className="rma-cites" aria-label="Sources">
          {message.citations.map((c) => (
            <li key={c.ref}>Source: {c.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RoadmapAssistant({
  open: openProp,
  onOpenChange,
  client: clientProp,
  initialState = initialChat,
  initialSource = null,
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (value) => {
      if (openProp === undefined) setOpenState(value);
      onOpenChange?.(value);
    },
    [openProp, onOpenChange],
  );

  const client = useMemo(
    () => clientProp ?? createRoadmapClient({ endpoint: functionUrl('ops'), anonKey, getToken: operatorToken }),
    [clientProp],
  );

  const [chat, dispatch] = useReducer(chatReducer, initialState);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState(initialSource ? { kind: 'ready', meta: initialSource } : { kind: 'idle' });

  const ids = useId();
  const titleId = `${ids}-title`;
  const sourceId = `${ids}-source`;
  const inputId = `${ids}-input`;
  const panelId = `${ids}-panel`;

  const inputRef = useRef(null);
  const launcherRef = useRef(null);
  const logRef = useRef(null);
  const wasOpen = useRef(open);

  /* which roadmap is loaded, asked the first time the panel opens. an answer also carries
     it, and the newest wins. a ref, not state, says it was asked: the request must survive
     the re-render its own "loading" causes. */
  const statusAsked = useRef(Boolean(initialSource));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || statusAsked.current) return;
    statusAsked.current = true;
    setSource({ kind: 'loading' });
    client
      .status()
      .then((payload) => mounted.current && setSource({ kind: 'ready', meta: payload.source, assistant: payload.assistant }))
      .catch((error) => {
        /* asked again the next time the panel opens. */
        statusAsked.current = false;
        if (mounted.current) setSource({ kind: 'error', message: error.message });
      });
  }, [open, client]);

  /* focus follows the panel: into the question box on open, back to the launcher on close. */
  useEffect(() => {
    if (open && !wasOpen.current) inputRef.current?.focus();
    if (!open && wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages.length, chat.pending, chat.error]);

  /* the request itself. one at a time: the reducer refuses a second send while one is out.
     each send or retry makes a new `pending` object, and that object is the request's
     identity — asked once however often the effect runs, and its answer dropped if the chat
     was reset while it was out. */
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const pendingRef = useRef(chat.pending);
  pendingRef.current = chat.pending;
  const requested = useRef(null);
  useEffect(() => {
    const pending = chat.pending;
    if (!pending || requested.current === pending) return;
    requested.current = pending;
    const current = () => mounted.current && pendingRef.current === pending;
    client
      .ask(pending.question, historyFor(messagesRef.current))
      .then((payload) => {
        if (!current()) return;
        if (payload?.source) setSource((prev) => ({ ...prev, kind: 'ready', meta: payload.source }));
        dispatch({ type: 'answer', response: payload });
      })
      .catch((error) => current() && dispatch({ type: 'fail', message: error.message, retry: error.retry }));
  }, [chat.pending, client]);

  const send = (question) => {
    const text = String(question ?? '').trim();
    if (!text || chat.pending) return;
    dispatch({ type: 'send', question: text.slice(0, QUESTION_LIMIT) });
    setDraft('');
  };

  const reset = () => {
    dispatch({ type: 'reset' });
    setDraft('');
    inputRef.current?.focus();
  };

  const onPanelKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const onInputKey = (event) => {
    const action = composerKey(event);
    if (action === 'send') {
      event.preventDefault();
      send(draft);
    }
  };

  const sourceText =
    source.kind === 'ready'
      ? sourceLine(source.meta)
      : source.kind === 'error'
        ? `Roadmap source unavailable: ${source.message}`
        : 'Checking the roadmap source…';

  const empty = chat.messages.length === 0 && !chat.pending;

  return (
    <div className="rma">
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          className="rma-launch"
          aria-expanded="false"
          aria-controls={panelId}
          onClick={() => setOpen(true)}
        >
          <Icon name="support" />
          <span>roadmap</span>
        </button>
      )}

      {open && (
        <section
          id={panelId}
          className="rma-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={sourceId}
          onKeyDown={onPanelKey}
        >
          <header className="rma-head">
            <div className="rma-head__text">
              <h2 id={titleId} className="rma-head__title">
                ARC Roadmap Assistant
              </h2>
              <p className="rma-head__knowledge">Knowledge: Current roadmap</p>
              <p id={sourceId} className={`rma-head__source rma-head__source--${source.kind}`}>
                {sourceText}
              </p>
            </div>
            <div className="rma-head__actions">
              <button
                type="button"
                className="rma-icon"
                onClick={reset}
                disabled={chat.messages.length === 0 && !chat.error}
                aria-label="Start a new chat"
                title="new chat"
              >
                <Icon name="refresh" />
              </button>
              <button
                type="button"
                className="rma-icon"
                onClick={() => setOpen(false)}
                aria-label="Close the roadmap assistant"
                title="close"
              >
                <Icon name="close" />
              </button>
            </div>
          </header>

          <div
            ref={logRef}
            className="rma-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-busy={chat.pending ? 'true' : 'false'}
          >
            {empty && (
              <div className="rma-empty">
                <p>
                  Ask about the current ARC implementation roadmap. Answers come from the roadmap file alone, with the
                  sections they rest on.
                </p>
                <ul className="rma-starters" aria-label="Starter questions">
                  {STARTER_QUESTIONS.map((q) => (
                    <li key={q}>
                      <button type="button" className="rma-starter" onClick={() => send(q)}>
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {chat.messages.map((message) =>
              message.role === 'user' ? (
                <div key={message.id} className="rma-msg rma-msg--you">
                  <span className="rma-msg__who">you</span>
                  <p>{message.text}</p>
                </div>
              ) : (
                <Answer key={message.id} message={message} />
              ),
            )}

            {chat.pending && (
              <div className="rma-pending" role="status">
                <span className="rma-pending__bar" aria-hidden="true" />
                Reading the roadmap…
              </div>
            )}

            {chat.error && (
              <div className="rma-error" role="alert">
                <p>{chat.error.message}</p>
                <div className="rma-error__actions">
                  {chat.error.retry && chat.error.question && (
                    <button type="button" className="ws-btn" onClick={() => dispatch({ type: 'retry' })}>
                      <Icon name="refresh" />
                      retry
                    </button>
                  )}
                  <button type="button" className="ws-btn" onClick={() => dispatch({ type: 'dismiss' })}>
                    dismiss
                  </button>
                </div>
              </div>
            )}
          </div>

          <form
            className="rma-compose"
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <label htmlFor={inputId} className="rma-sr">
              Ask a question about the roadmap
            </label>
            <textarea
              ref={inputRef}
              id={inputId}
              className="rma-compose__input"
              rows={2}
              maxLength={QUESTION_LIMIT}
              value={draft}
              placeholder="Ask about the roadmap…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKey}
              aria-describedby={`${ids}-hint`}
            />
            <button type="submit" className="ws-btn ws-btn--primary rma-compose__send" disabled={!draft.trim() || Boolean(chat.pending)}>
              send
            </button>
            <p id={`${ids}-hint`} className="rma-compose__hint">
              Enter to send · Shift+Enter for a new line · Esc to close. It answers questions; it cannot change anything.
            </p>
          </form>
        </section>
      )}
    </div>
  );
}

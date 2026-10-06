import { useCallback, useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Pill, Term } from './ui';
import { ActionButton, Field, Notice, SelectInput, TextArea } from './ops-ui';
import { formatPhone } from '../lib/format';
import { isNotDeployed } from '../lib/crm';
import {
  BLOCK_WORDS, CHANNEL_DEFINITIONS, CONSENT_WORDS, fillSnippet, SUPPRESS_REASONS, SUPPRESS_WORDS, threadEntries, threadTurn,
} from '../../../supabase/functions/_shared/communications/model.ts';

/**
 * ARC-370 — the conversation with one customer: what was said, by whom, on which channel,
 * and what ARC knows about whether it arrived.
 *
 * The screen decides nothing. Who said what and where each message has got to is
 * `communications/model.ts` (shared with the tests) read over the server's rows. Whether a
 * message can be sent is the server's answer, asked of the same gate the send itself asks
 * again — so the reason a message cannot go is on the page before anybody types one.
 *
 * Two things are kept apart on purpose. A message is what the customer saw. A note is what
 * the team wrote for itself: a different record, in its own section, with no path to a send.
 */

const STATE_WORDS = {
  received: 'received', queued: 'queued', held: 'held', sending: 'sending', sent: 'sent', delivered: 'delivered',
  read: 'read', failed: 'failed', blocked: 'blocked', unknown: 'unknown', cancelled: 'cancelled',
};
const STATE_TONE = {
  received: 'neutral', queued: 'idle', held: 'warn', sending: 'idle', sent: 'neutral', delivered: 'ok',
  read: 'ok', failed: 'fail', blocked: 'warn', unknown: 'warn', cancelled: 'neutral',
};
const TURN_WORDS = {
  ours: 'the customer wrote last — it is ours to answer',
  theirs: 'we wrote last — waiting on the customer',
  nobody: 'nothing has been said on this channel yet',
};

const at = (iso, timezone) => (iso ? DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('LLL d, h:mm a') : '—');
const showAddress = (channel, address) => (channel === 'sms' ? formatPhone(address) : address);
const nameOf = (people, userId) => (userId ? people.find((p) => p.user_id === userId)?.label ?? 'a team member' : null);

function speaker(entry, people, contact) {
  if (entry.speaker === 'customer') return contact?.display_name ?? 'the customer';
  if (entry.speaker === 'their_system') return `their system${entry.message?.connector_key ? ` (${entry.message.connector_key})` : ''}`;
  if (entry.speaker === 'automation') return entry.source === 'lead_recovery' ? 'lead recovery, automatically' : 'ARC, automatically';
  return nameOf(people, entry.author_id) ?? 'a team member';
}

/* ── one message ────────────────────────────────────────── */

function Entry({ entry, api, view, contact, timezone, readOnly, onChanged }) {
  const { state, detail, code } = entry.delivery;
  const mine = entry.source === 'crm' && entry.direction === 'outbound' && entry.message?.origin === 'manual';
  const attachments = entry.message?.attachments ?? [];
  return (
    <li className={`crm-msg crm-msg--${entry.direction}${entry.speaker === 'automation' ? ' crm-msg--auto' : ''}`}>
      <p className="crm-msg__who">
        <b>{speaker(entry, view.people, contact)}</b>
        <span className="crm-item__meta">
          {entry.direction === 'inbound' ? 'to us' : 'to the customer'} by {CHANNEL_DEFINITIONS[entry.channel].label} · {at(entry.at, timezone)}
        </span>
      </p>
      <p className="crm-msg__body">{entry.body}</p>
      {attachments.length > 0 && (
        <p className="crm-item__meta">
          {attachments.length} attachment{attachments.length === 1 ? '' : 's'} — kept by the provider, not shown here
        </p>
      )}
      <p className="crm-msg__state">
        <Pill tone={STATE_TONE[state] ?? 'neutral'}><Term k={`msg_${state}`}>{STATE_WORDS[state] ?? state}</Term></Pill>
        {detail && <span className="crm-item__meta" role={state === 'blocked' || state === 'unknown' ? 'note' : undefined}> {detail}</span>}
        {!detail && code && state !== 'sent' && <span className="crm-item__meta"> {String(code).replace(/_/g, ' ')}</span>}
        {entry.answered_at && <span className="crm-item__meta"> · answered {at(entry.answered_at, timezone)}</span>}
        {entry.message?.consent_basis === 'none_on_file' && mine && <span className="crm-item__meta"> · sent with no consent on file</span>}
      </p>
      {!readOnly && mine && (state === 'queued' || state === 'held') && view.viewer.may.send && (
        <ActionButton
          icon="close"
          confirm="call this message back? it has not been sent, and it will not be. it stays in the conversation, marked cancelled."
          onRun={async () => {
            await api.cancelMessage(entry.id);
            await onChanged();
            return 'cancelled';
          }}
        >
          cancel it
        </ActionButton>
      )}
      {!readOnly && mine && state === 'unknown' && (
        view.viewer.may.reconcile ? (
          <span className="ops-row">
            <ActionButton
              icon="check"
              confirm="confirm this was sent? only after checking with the provider. it is marked sent and nothing is sent again."
              onRun={async () => {
                await api.reconcileMessage(entry.id, 'effect_happened');
                await onChanged();
                return 'marked sent';
              }}
            >
              it was sent
            </ActionButton>
            <ActionButton
              icon="refresh"
              confirm="confirm this never left? only after checking with the provider. it is sent once more — if it did leave, the customer gets it twice."
              onRun={async () => {
                await api.reconcileMessage(entry.id, 'effect_absent');
                await onChanged();
                return 'sent again';
              }}
            >
              it never left
            </ActionButton>
          </span>
        ) : <p className="ws-note">ARC is checking with the provider. you do not need to do anything, and it is safest not to write the same thing again yet.</p>
      )}
    </li>
  );
}

/* ── writing one ────────────────────────────────────────── */

const freshKey = () => `msg-${globalThis.crypto.randomUUID()}`;

function Compose({ api, thread, view, contact, lead, businessName, onChanged }) {
  const [body, setBody] = useState('');
  const [key, setKey] = useState(freshKey);
  const [read, setRead] = useState(() => new Set());
  const { compose, channel } = thread;
  const snippets = view.snippets.filter((s) => s.channel === 'any' || s.channel === channel);
  const flags = compose.needs_acknowledgement;
  const confirmed = flags.every((flag) => read.has(flag));
  const max = CHANNEL_DEFINITIONS[channel].maxLength;

  return (
    <div className="ops-form crm-form crm-compose">
      {snippets.length > 0 && (
        <Field label="start from a canned reply" hint="it fills the box. read it and change it before sending.">
          <SelectInput
            value=""
            onChange={(e) => {
              const snippet = snippets.find((s) => s.key === e.target.value);
              if (snippet) setBody(fillSnippet(snippet.body, { first_name: contact?.first_name ?? null, business_name: businessName ?? null }));
            }}
            options={[{ value: '', label: 'choose one…' }, ...snippets.map((s) => ({ value: s.key, label: s.name }))]}
          />
        </Field>
      )}
      <Field label={`write a ${CHANNEL_DEFINITIONS[channel].label} to ${showAddress(channel, thread.address)}`} wide hint={`${body.length} of ${max} characters. the customer sees exactly this.`}>
        <TextArea value={body} maxLength={max} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {flags.length > 0 && (
        <div className="ops-form__row crm-compose__flags" role="group" aria-label="safety flags to read before writing">
          <p className="ws-note ws-note--loud"><Term k="safety_flag">flagged</Term> — read each one before writing to this customer:</p>
          {flags.map((flag) => (
            <label key={flag} className="crm-check">
              <input
                type="checkbox"
                checked={read.has(flag)}
                onChange={(e) => setRead((current) => {
                  const next = new Set(current);
                  if (e.target.checked) next.add(flag); else next.delete(flag);
                  return next;
                })}
              />
              <span>i have read the flag: <b>{flag.replace(/_/g, ' ')}</b></span>
            </label>
          ))}
        </div>
      )}
      <p className="ws-note">
        <Term k="consent_basis">consent</Term>: {CONSENT_WORDS[compose.consent_basis] ?? '—'}. the do-not-contact list is checked again the moment this is sent.
      </p>
      <div className="ops-form__row">
        <ActionButton
          variant="primary"
          icon="mail"
          disabled={!body.trim() || !confirmed}
          consequence={`sends this to ${showAddress(channel, thread.address)} through ${compose.through ?? 'the connected provider'}. a sent message cannot be taken back.`}
          onRun={async () => {
            const sent = await api.sendMessage({
              contact_id: contact.id,
              ...(lead ? { lead_id: lead.id } : {}),
              channel,
              body,
              client_key: key,
              acknowledged_safety: flags,
            });
            setBody('');
            setKey(freshKey());
            setRead(new Set());
            await onChanged();
            const status = sent.message?.status;
            if (status === 'sent') return 'sent';
            if (status === 'blocked') return 'not sent — it was stopped at the last check';
            return sent.pass?.deferred ? `queued — ${sent.pass.deferred.reason}` : `queued (${status})`;
          }}
        >
          send
        </ActionButton>
      </div>
    </div>
  );
}

function StopContact({ api, thread, contact, onChanged }) {
  const [reason, setReason] = useState('opt_out');
  const target = thread.conversation && !contact ? { conversation_id: thread.conversation.id } : { contact_id: contact?.id };
  return (
    <div className="ops-row crm-stop">
      <SelectInput
        aria-label="why this address should not be contacted"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        options={SUPPRESS_REASONS.map((r) => ({ value: r, label: SUPPRESS_WORDS[r] }))}
      />
      <ActionButton
        icon="warn"
        confirm={`put ${showAddress(thread.channel, thread.address)} on the do-not-contact list? nothing is sent to it again, by a person or automatically, and anything waiting to go is stopped. it cannot be taken off the list from here.`}
        onRun={async () => {
          await api.doNotContact({ ...target, channel: thread.channel, reason });
          await onChanged();
          return 'on the do-not-contact list';
        }}
      >
        do not contact
      </ActionButton>
    </div>
  );
}

/* ── one channel's thread ───────────────────────────────── */

function Thread({ api, thread, view, contact, lead, timezone, readOnly, businessName, onChanged }) {
  const entries = threadEntries(thread);
  const waiting = entries.some((e) => e.source === 'crm' && (e.delivery.state === 'queued' || e.delivery.state === 'held'));
  const { compose } = thread;
  const canWrite = !readOnly && view.viewer.may.send && Boolean(contact);
  return (
    <div className="crm-thread" aria-label={`${CHANNEL_DEFINITIONS[thread.channel].label} conversation with ${showAddress(thread.channel, thread.address)}`}>
      <p className="crm-thread__head">
        <Icon name={thread.channel === 'sms' ? 'phone' : 'mail'} size={13} />{' '}
        <b>{CHANNEL_DEFINITIONS[thread.channel].label}</b> · <span className="mono">{showAddress(thread.channel, thread.address)}</span>
        {thread.unread && <Pill tone="warn"><Term k="unread">unread</Term></Pill>}
        {thread.do_not_contact && <Pill tone="warn"><Term k="do_not_contact">do not contact</Term> · {String(thread.do_not_contact.reason).replace(/_/g, ' ')}</Pill>}
      </p>
      <p className="crm-item__meta">
        {TURN_WORDS[threadTurn(entries)]}
        {thread.shared_by > 1 ? ` · ${thread.shared_by} customers on file share this address, and each of them shows this conversation` : ''}
        {thread.truncated ? ' · only the latest messages are shown' : ''}
      </p>

      {entries.length === 0
        ? <p className="ops-muted">no messages.</p>
        : (
          <ol className="crm-msgs">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} api={api} view={view} contact={contact} timezone={timezone} readOnly={readOnly} onChanged={onChanged} />
            ))}
          </ol>
        )}
      {thread.recovery.length > 0 && (
        <p className="ws-note">messages marked &ldquo;lead recovery, automatically&rdquo; are that module&rsquo;s own record, shown here so the conversation reads in one place.</p>
      )}

      {!readOnly && view.viewer.may.send && (
        <div className="ops-row">
          {thread.unread && thread.conversation && (
            <ActionButton icon="check" onRun={async () => { await api.markRead(thread.conversation.id); await onChanged(); return 'marked read'; }}>
              mark as read
            </ActionButton>
          )}
          {waiting && (
            <ActionButton icon="refresh" onRun={async () => {
              const pass = await api.flushMessages();
              await onChanged();
              return pass.deferred ? `still waiting — ${pass.deferred.reason}` : `${pass.executed.length} checked`;
            }}
            >
              send what is waiting
            </ActionButton>
          )}
        </div>
      )}

      {canWrite && compose.can_send && (
        <Compose api={api} thread={thread} view={view} contact={contact} lead={lead} businessName={businessName} onChanged={onChanged} />
      )}
      {!readOnly && !compose.can_send && compose.block && compose.block.code !== 'forbidden' && (
        <Notice tone="warn" title={`a ${CHANNEL_DEFINITIONS[thread.channel].label} cannot be sent from here right now`}>
          <p><b>{BLOCK_WORDS[compose.block.code] ?? String(compose.block.code).replace(/_/g, ' ')}.</b> {compose.block.detail}</p>
        </Notice>
      )}
      {!readOnly && view.viewer.may.suppress && !thread.do_not_contact && (contact || thread.conversation) && (
        <StopContact api={api} thread={thread} contact={contact} onChanged={onChanged} />
      )}
    </div>
  );
}

/* ── the section a record shows ─────────────────────────── */

/**
 * `by` is `{ contact_id }` for a customer's conversations, or `{ conversation_id }` for a
 * thread nobody on file is tied to yet. `initial` draws from a known answer (the tests).
 */
export default function Conversation({ api, by, lead = null, timezone, readOnly = false, businessName = null, initial = null, onChanged }) {
  const [state, setState] = useState(initial ? { kind: 'ready', view: initial } : { kind: 'loading' });
  const target = by.contact_id ?? by.conversation_id;

  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', view: await api.thread(by.contact_id ? { contact_id: by.contact_id } : { conversation_id: by.conversation_id }) });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api, by.contact_id, by.conversation_id]);
  useEffect(() => {
    if (initial) return;
    setState({ kind: 'loading' });
    load();
  }, [initial, load, target]);

  const changed = useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the conversation…</p>;
  if (state.kind === 'error') {
    return isNotDeployed(state.error)
      ? <p className="ws-note">conversations are not switched on here yet. nothing is wrong with this record.</p>
      : <Notice tone="fail" title="the conversation could not be read"><p>{state.error?.message ?? 'unknown error'}</p></Notice>;
  }

  const { view } = state;
  if (view.threads.length === 0) {
    return <p className="ops-muted">no phone number or email on file, so there is nothing to show and nowhere to write to.</p>;
  }
  return (
    <>
      {view.threads.map((thread) => (
        <Thread
          key={`${thread.channel}:${thread.address}`}
          api={api}
          thread={thread}
          view={view}
          contact={view.contact}
          lead={lead}
          timezone={timezone}
          readOnly={readOnly || api.readOnly}
          businessName={businessName}
          onChanged={changed}
        />
      ))}
      {!view.contact && (
        <p className="ws-note"><Term k="unmatched_thread">nobody on file</Term> has this address. add a lead with it and this conversation appears on that customer.</p>
      )}
    </>
  );
}

/* ── every conversation, for the workspace's own tab ────── */

export function Conversations({ api, timezone, onOpenContact, onOpenThread }) {
  const [state, setState] = useState({ kind: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ kind: 'ready', inbox: await api.conversations() });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  if (state.kind === 'loading') return <p className="ops-muted">reading the conversations…</p>;
  if (state.kind === 'error') {
    return isNotDeployed(state.error)
      ? <Notice tone="warn" title="conversations are not switched on here yet"><p>nothing is wrong with your leads. this view appears once it is set up.</p></Notice>
      : <Notice tone="fail" title="the conversations could not be read"><p>{state.error?.message ?? 'unknown error'}</p></Notice>;
  }
  const { conversations, truncated } = state.inbox;
  if (conversations.length === 0) {
    return <Empty title="no conversations yet">a text or an email with a customer shows up here, the unread ones first.</Empty>;
  }
  return (
    <>
      <div className="ws-tablewrap">
        <table className="ws-table ws-table--dense crm-table">
          <thead>
            <tr><th>customer</th><th>last message</th><th>when</th><th>state</th></tr>
          </thead>
          <tbody>
            {conversations.map(({ conversation, unread, contacts, last }) => (
              <tr key={conversation.id}>
                <td>
                  {contacts.length === 1 ? (
                    <button type="button" className="crm-link" onClick={() => onOpenContact(contacts[0].id)}>{contacts[0].display_name}</button>
                  ) : (
                    <button type="button" className="crm-link" onClick={() => onOpenThread(conversation.id)}>
                      {contacts.length === 0 ? showAddress(conversation.channel, conversation.address) : contacts.map((c) => c.display_name).join(' / ')}
                    </button>
                  )}
                  <div className="crm-item__meta">{CHANNEL_DEFINITIONS[conversation.channel].label} · <span className="mono">{showAddress(conversation.channel, conversation.address)}</span></div>
                </td>
                <td>{last ? `${last.direction === 'inbound' ? 'them: ' : 'us: '}${last.body}` : '—'}</td>
                <td>{at(last?.at ?? conversation.last_message_at, timezone)}</td>
                <td>
                  <span className="crm-signals">
                    {unread && <Pill tone="warn"><Term k="unread">unread</Term></Pill>}
                    {contacts.length === 0 && <Pill tone="idle"><Term k="unmatched_thread">nobody on file</Term></Pill>}
                    {contacts.length > 1 && <Pill tone="neutral">shared address</Pill>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <p className="ws-note">only the most recent conversations are listed.</p>}
    </>
  );
}

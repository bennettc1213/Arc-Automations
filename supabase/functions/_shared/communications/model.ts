/**
 * ARC-370 — the communications hub's vocabulary: channels, messages, and what ARC knows
 * about where a message has got to.
 *
 * **Portal-safe.** No database, no network, no Deno API; the imports below are themselves
 * portal-safe. The conversation screen (`CrmConversation.jsx`) reads a thread with the same
 * functions the service and the tests use, and `0026_crm_communications.sql` checks the same
 * things again where they cannot be skipped. The vocabularies here are drift-tested against
 * that migration's check constraints.
 *
 * Four things this file deliberately does not do:
 *   - decide whether an address may be written to. That is `crm_message_gate`, read from
 *     current state when a message is queued and again immediately before it is sent. The
 *     codes it can answer with are listed here so the screen has words for them.
 *   - write a message. A person writes one; a canned reply is text they pick and read first.
 *   - carry a credential. A message names a connection by id, and `secretProblem` refuses a
 *     credential-shaped body before it is ever stored.
 *   - count anything. Nothing here is a figure, and a sent message is not a Lead Recovery outcome.
 */

import { type FieldError, type Parsed, secretProblem } from '../crm/model.ts';
import { normaliseEmail, normalisePhone } from '../phone.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Raw = Record<string, unknown>;

/* ── channels ───────────────────────────────────────────── */

export const CHANNELS = ['sms', 'email'] as const;
export type Channel = typeof CHANNELS[number];

export interface ChannelDefinition {
  key: Channel;
  /** what the screen calls it. */
  label: string;
  /** which field of a contact is this channel's address. */
  contactField: 'phone' | 'email';
  /**
   * The registry capability a connector must have verified for ARC to send on this channel
   * (`registry/capabilities.ts`). `null` means no adapter sends it yet: the channel can still
   * be read — a message the client's own system reports is normalised into the same thread —
   * but nothing can be written on it from here.
   */
  sendCapability: string | null;
  maxLength: number;
}

export const CHANNEL_DEFINITIONS: Readonly<Record<Channel, ChannelDefinition>> = Object.freeze({
  sms: { key: 'sms', label: 'text', contactField: 'phone', sendCapability: 'send_sms', maxLength: 1600 },
  email: { key: 'email', label: 'email', contactField: 'email', sendCapability: null, maxLength: 1600 },
});

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** an address in the one spelling the database accepts for its channel, or null. */
export function normaliseAddress(channel: Channel, value: unknown): string | null {
  return channel === 'sms' ? normalisePhone(value) : normaliseEmail(value);
}

/* ── messages (mirrored by 0026's check constraints) ────── */

export const DIRECTIONS = ['inbound', 'outbound'] as const;
export type Direction = typeof DIRECTIONS[number];

/** manual: a person wrote it in ARC. automation: an ARC module queued it. provider: it arrived
 *  through a connected provider. external_system: the client's own system reported it. */
export const ORIGINS = ['manual', 'automation', 'provider', 'external_system'] as const;
export type Origin = typeof ORIGINS[number];

export const MESSAGE_STATUSES = [
  'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked', 'unknown', 'cancelled', 'received',
] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

export const AUTHOR_TYPES = ['operator', 'client_user', 'system', 'external', 'customer'] as const;

export const EVENT_KINDS = [
  'received', 'queued', 'sending', 'retry', 'sent', 'delivered', 'read', 'failed',
  'blocked', 'unknown', 'cancelled', 'reconciled', 'do_not_contact', 'assigned',
] as const;

export const CONSENT_BASES = ['recorded_grant', 'inbound_message', 'none_on_file'] as const;
export type ConsentBasis = typeof CONSENT_BASES[number];

export const CONSENT_WORDS: Readonly<Record<ConsentBasis, string>> = Object.freeze({
  recorded_grant: 'this customer agreed to be contacted this way, and that is on file',
  inbound_message: 'this customer wrote to the business first',
  none_on_file: 'nothing on file says this customer asked to be contacted this way — make sure they did',
});

/** the reasons a person can give for putting an address on the do-not-contact list. */
export const SUPPRESS_REASONS = ['opt_out', 'wrong_contact', 'staff_suppressed', 'compliance', 'other'] as const;
export const SUPPRESS_WORDS: Readonly<Record<typeof SUPPRESS_REASONS[number], string>> = Object.freeze({
  opt_out: 'they asked us to stop',
  wrong_contact: 'wrong number or wrong person',
  staff_suppressed: 'we decided not to contact them',
  compliance: 'a compliance reason',
  other: 'another reason',
});

export const DELIVERY_REPORTS = ['delivered', 'read', 'failed'] as const;

/* ── why a message may not be sent ──────────────────────── */

/**
 * Every reason a send is refused or stopped, with the words for it. The first four are
 * `crm_message_gate`'s (current state, re-read at the send); the rest are about whether
 * there is anything to send through.
 */
export const BLOCK_CODES = [
  'do_not_contact', 'consent_declined', 'automation_active', 'safety_review',
  'contact_unavailable', 'no_address', 'no_channel', 'module_not_ready',
] as const;
export type BlockCode = typeof BLOCK_CODES[number];

export const BLOCK_WORDS: Readonly<Record<BlockCode, string>> = Object.freeze({
  do_not_contact: 'this address is on the do-not-contact list',
  consent_declined: 'this customer was asked and did not agree to be contacted this way',
  automation_active: 'lead recovery is still handling this conversation — take it over there first',
  safety_review: 'this customer\'s lead was flagged — read the flag and confirm before writing',
  contact_unavailable: 'this customer is archived or was merged',
  no_address: 'this customer has no address on file for this channel',
  no_channel: 'no provider is connected to send this through',
  module_not_ready: 'the module that sends for this client is not active',
});

export function isBlockCode(value: unknown): value is BlockCode {
  return typeof value === 'string' && (BLOCK_CODES as readonly string[]).includes(value);
}

/* ── where a message has got to ─────────────────────────── */

/**
 * What the screen shows for one message. `held` is the only word that is not a stored
 * status: the message is queued and its action is waiting on something a person can see —
 * a paused module, a connection that is not ready.
 */
export const DELIVERY_STATES = [
  'received', 'queued', 'held', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked', 'unknown', 'cancelled',
] as const;
export type DeliveryState = typeof DELIVERY_STATES[number];

export interface Delivery {
  state: DeliveryState;
  /** a code for why, when it is held, blocked, failed or unknown. */
  code: string | null;
  /** a sentence safe to show. */
  detail: string | null;
}

const UNKNOWN_DETAIL = 'ARC does not know whether this was sent. It will not be sent again unless an operator confirms it never left.';

/**
 * A message's state, from its own row and the durable action that sends it (0017's
 * `scheduled_actions` row, when it has one). The message row is what the sender last
 * recorded; the action is what the queue says. Where the queue knows more — the worker
 * vanished mid-send, the module was paused, an operator reconciled it — the queue wins.
 */
export function deliveryState(message: Row, action?: Row | null): Delivery {
  if (message.direction === 'inbound') return { state: 'received', code: null, detail: null };
  const status = message.status as MessageStatus;
  const own: Delivery = { state: status as DeliveryState, code: message.status_code ?? null, detail: message.status_detail ?? null };
  if (status !== 'queued' && status !== 'sending' && status !== 'unknown') return own;
  if (status === 'unknown') return { state: 'unknown', code: own.code ?? 'outcome_unknown', detail: UNKNOWN_DETAIL };
  if (!action) return own;
  if (action.status === 'blocked' && action.gate_code === 'ambiguous_outcome') {
    return { state: 'unknown', code: 'outcome_unknown', detail: UNKNOWN_DETAIL };
  }
  if (action.status === 'blocked') {
    return { state: 'held', code: action.gate_code ?? 'blocked', detail: action.gate_detail ?? 'a person needs to look at this before it can be sent' };
  }
  if (action.status === 'failed' || action.status === 'dead_letter') {
    return { state: 'failed', code: action.gate_code === 'attempts_exhausted' ? 'attempts_exhausted' : own.code ?? 'send_failed', detail: action.last_error ?? own.detail ?? 'it could not be sent' };
  }
  if (action.status === 'cancelled' || action.status === 'skipped') {
    return { state: 'cancelled', code: action.gate_code ?? 'cancelled', detail: action.last_error ?? null };
  }
  if (action.status === 'pending' && action.gate_code && action.gate_code !== 'ok') {
    return { state: 'held', code: action.gate_code, detail: action.gate_detail ?? null };
  }
  if (action.status === 'done') return { state: 'sent', code: null, detail: null };
  return own;
}

/** a timestamp as milliseconds, whether the driver handed over a string or a Date. */
export function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

const isoOf = (value: unknown): string => new Date(timeOf(value)).toISOString();

/** a thread nobody on the team has looked at since the customer last wrote. */
export function isUnread(conversation: Row): boolean {
  if (!conversation.last_inbound_at) return false;
  return !conversation.last_read_at || timeOf(conversation.last_read_at) < timeOf(conversation.last_inbound_at);
}

/* ── one timeline for a thread ──────────────────────────── */

export type Speaker = 'customer' | 'person' | 'automation' | 'their_system';

export interface ThreadEntry {
  id: string;
  /** where the row lives: ARC's own message table, or Lead Recovery's, read by reference. */
  source: 'crm' | 'lead_recovery';
  channel: Channel;
  direction: Direction;
  speaker: Speaker;
  /** the person who wrote it, when a person did. */
  author_id: string | null;
  body: string;
  body_withheld: boolean;
  at: string;
  delivery: Delivery;
  /** for something sent: when the customer next wrote, if they did before anything else went out. */
  answered_at: string | null;
  message: Row | null;
}

/** who a thread is waiting on, read off its last entry. `nobody` is an empty thread. */
export type ThreadTurn = 'ours' | 'theirs' | 'nobody';

/** The customer wrote last: it is ours to answer. We wrote last: we are waiting on them. */
export function threadTurn(entries: ThreadEntry[]): ThreadTurn {
  const last = entries.at(-1);
  if (!last) return 'nobody';
  return last.direction === 'inbound' ? 'ours' : 'theirs';
}

const RECOVERY_STATE: Record<string, DeliveryState> = {
  queued: 'queued', sending: 'sending', sent: 'sent', delivered: 'delivered', undelivered: 'failed',
  failed: 'failed', received: 'received', blocked: 'blocked',
};

function speakerOf(message: Row): Speaker {
  if (message.direction === 'inbound') return 'customer';
  if (message.origin === 'external_system') return 'their_system';
  return message.origin === 'automation' ? 'automation' : 'person';
}

/**
 * Everything said on a thread, oldest first: ARC's own messages and, for a text thread, the
 * messages Lead Recovery exchanged with the same number — its rows, shown here, never copied.
 * Internal notes are not in this list and cannot be: a note is a different table with no
 * path to a send.
 */
export function threadEntries(input: { messages: Row[]; actions?: Record<string, Row>; recovery?: Row[] }): ThreadEntry[] {
  const own: ThreadEntry[] = input.messages.map((m) => ({
    id: m.id,
    source: 'crm',
    channel: m.channel,
    direction: m.direction,
    speaker: speakerOf(m),
    author_id: m.author_id ?? null,
    body: m.body,
    body_withheld: m.body_withheld === true,
    at: isoOf(m.occurred_at ?? m.created_at),
    delivery: deliveryState(m, m.action_id ? input.actions?.[m.action_id] : null),
    answered_at: null,
    message: m,
  }));
  const theirs: ThreadEntry[] = (input.recovery ?? []).map((m) => ({
    id: `lr:${m.id}`,
    source: 'lead_recovery',
    channel: 'sms',
    direction: m.direction,
    speaker: m.direction === 'inbound' ? 'customer' : 'automation',
    author_id: null,
    body: m.body ?? '',
    body_withheld: false,
    at: isoOf(m.occurred_at),
    delivery: { state: RECOVERY_STATE[m.status] ?? 'sent', code: m.error_class ?? null, detail: null },
    answered_at: null,
    message: null,
  }));
  const all = [...own, ...theirs].sort((a, b) => timeOf(a.at) - timeOf(b.at) || a.id.localeCompare(b.id));
  /* a reply answers the last thing that went out before it, and only that. */
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].direction !== 'outbound') continue;
    const next = all[i + 1];
    if (next && next.direction === 'inbound') all[i].answered_at = next.at;
  }
  return all;
}

/* ── canned replies ─────────────────────────────────────── */

/** the closed list a canned reply may use. anything else in braces is left as typed. */
export const SNIPPET_PLACEHOLDERS = ['first_name', 'business_name'] as const;

/**
 * A canned reply with its placeholders filled, for the compose box — where a person reads it
 * and may change it before sending. A placeholder with nothing to fill it is removed rather
 * than sent as "{first_name}".
 */
export function fillSnippet(body: string, values: Partial<Record<typeof SNIPPET_PLACEHOLDERS[number], string | null>>): string {
  return body
    .replace(/\{(first_name|business_name)\}/g, (_, key: typeof SNIPPET_PLACEHOLDERS[number]) => (values[key] ?? '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    .trim();
}

/* ── parsing ────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CLIENT_KEY = /^[A-Za-z0-9:_-]{8,120}$/;

const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : {});
const present = (raw: Raw, key: string) => raw[key] !== undefined && raw[key] !== null && raw[key] !== '';
const done = <T>(errors: FieldError[], value: T): Parsed<T> => (errors.length > 0 ? { ok: false, errors } : { ok: true, value });

export interface OutboundInput {
  contact_id: string;
  lead_id: string | null;
  channel: Channel;
  body: string;
  client_key: string;
  snippet_key: string | null;
  acknowledged_safety: string[];
}

/** A message a person wrote. Every problem at once, by field. */
export function parseOutboundMessage(input: unknown): Parsed<OutboundInput> {
  const raw = asObject(input);
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  if (typeof raw.contact_id !== 'string' || !UUID.test(raw.contact_id)) fail('contact_id', 'is required');
  if (present(raw, 'lead_id') && (typeof raw.lead_id !== 'string' || !UUID.test(raw.lead_id))) fail('lead_id', 'is not an id');
  const channel = raw.channel ?? 'sms';
  if (!isChannel(channel)) fail('channel', `must be one of: ${CHANNELS.join(', ')}`);

  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  const max = isChannel(channel) ? CHANNEL_DEFINITIONS[channel].maxLength : 1600;
  if (!body) fail('body', 'is required');
  else if (body.length > max) fail('body', `is longer than ${max} characters`);
  else if (secretProblem(body)) fail('body', 'looks like it carries a credential — those are never sent from here');

  if (typeof raw.client_key !== 'string' || !CLIENT_KEY.test(raw.client_key)) fail('client_key', 'is required');
  if (present(raw, 'snippet_key') && (typeof raw.snippet_key !== 'string' || !KEY.test(raw.snippet_key))) fail('snippet_key', 'is not a canned reply');

  const acknowledged = raw.acknowledged_safety ?? [];
  if (!Array.isArray(acknowledged) || acknowledged.length > 20 || !acknowledged.every((f) => typeof f === 'string' && CODE.test(f))) {
    fail('acknowledged_safety', 'is a list of the flags that were read');
  }

  return done(errors, {
    contact_id: String(raw.contact_id).toLowerCase(),
    lead_id: present(raw, 'lead_id') ? String(raw.lead_id).toLowerCase() : null,
    channel: channel as Channel,
    body,
    client_key: raw.client_key as string,
    snippet_key: present(raw, 'snippet_key') ? raw.snippet_key as string : null,
    acknowledged_safety: Array.isArray(acknowledged) ? [...new Set(acknowledged as string[])] : [],
  });
}

export interface AttachmentRef {
  kind: 'provider_media';
  ref: string;
  content_type: string | null;
}

/** references only. a link or a file is refused: ARC has no approved store for one yet. */
function parseAttachments(raw: unknown, fail: (field: string, message: string) => void): AttachmentRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) {
    fail('attachments', 'is a list of at most 10 references');
    return [];
  }
  const out: AttachmentRef[] = [];
  raw.forEach((item, i) => {
    const a = asObject(item);
    const extra = Object.keys(a).filter((k) => !['kind', 'ref', 'content_type'].includes(k));
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    const type = typeof a.content_type === 'string' ? a.content_type.trim().toLowerCase() : null;
    if (a.kind !== 'provider_media' || extra.length > 0) return fail(`attachments.${i}`, 'is a provider media reference: kind, ref, content_type');
    if (!ref || ref.length > 200 || /[\s/:]/.test(ref) || secretProblem(ref)) return fail(`attachments.${i}.ref`, 'is the provider\'s id for the file — never a link');
    if (type !== null && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return fail(`attachments.${i}.content_type`, 'is a media type');
    out.push({ kind: 'provider_media', ref, content_type: type });
  });
  return out;
}

export interface ArrivalInput {
  channel: Channel;
  address: string;
  direction: Direction;
  connector_key: string;
  external_id: string;
  body: string;
  occurred_at: string | null;
  attachments: AttachmentRef[];
}

/**
 * A message that arrived through a provider, or that the client's own system reports. The
 * address is the customer's, as that side spelled it — normalised here, so "(614) 555-0137"
 * lands on the thread for "+16145550137". The body is not checked for credentials here: an
 * inbound message is never refused for what a customer typed, and 0026 withholds a
 * credential-shaped body instead.
 */
export function parseArrival(input: unknown): Parsed<ArrivalInput> {
  const raw = asObject(input);
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  const channel = raw.channel;
  if (!isChannel(channel)) fail('channel', `must be one of: ${CHANNELS.join(', ')}`);
  const address = isChannel(channel) ? normaliseAddress(channel, raw.address) : null;
  if (isChannel(channel) && !address) fail('address', channel === 'sms' ? 'is not a phone number' : 'is not an email address');
  const direction = raw.direction ?? 'inbound';
  if (direction !== 'inbound' && direction !== 'outbound') fail('direction', 'is inbound or outbound');
  if (typeof raw.connector_key !== 'string' || !KEY.test(raw.connector_key)) fail('connector_key', 'names the connector it came through');
  const external = typeof raw.external_id === 'string' ? raw.external_id.trim() : '';
  if (!external || external.length > 200) fail('external_id', 'is that side\'s id for the message');
  else if (secretProblem(external)) fail('external_id', 'looks like a credential');
  if (raw.body !== undefined && raw.body !== null && typeof raw.body !== 'string') fail('body', 'must be text');
  let occurred: string | null = null;
  if (present(raw, 'occurred_at')) {
    const at = typeof raw.occurred_at === 'string' ? Date.parse(raw.occurred_at) : Number.NaN;
    if (Number.isNaN(at)) fail('occurred_at', 'is a timestamp');
    else occurred = new Date(at).toISOString();
  }
  const attachments = parseAttachments(raw.attachments, fail);

  return done(errors, {
    channel: channel as Channel,
    address: address as string,
    direction: direction as Direction,
    connector_key: raw.connector_key as string,
    external_id: external,
    body: typeof raw.body === 'string' ? raw.body : '',
    occurred_at: occurred,
    attachments,
  });
}

export interface DeliveryReportInput {
  connector_key: string;
  external_id: string;
  state: typeof DELIVERY_REPORTS[number];
  event_id: string | null;
  occurred_at: string | null;
  code: string | null;
  opted_out: boolean;
}

/** What a provider says happened to something that was sent. */
export function parseDeliveryReport(input: unknown): Parsed<DeliveryReportInput> {
  const raw = asObject(input);
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  if (typeof raw.connector_key !== 'string' || !KEY.test(raw.connector_key)) fail('connector_key', 'names the connector it came through');
  const external = typeof raw.external_id === 'string' ? raw.external_id.trim() : '';
  if (!external || external.length > 200) fail('external_id', 'is that side\'s id for the message');
  if (!(DELIVERY_REPORTS as readonly unknown[]).includes(raw.state)) fail('state', `must be one of: ${DELIVERY_REPORTS.join(', ')}`);
  const event = typeof raw.event_id === 'string' && raw.event_id.trim() ? raw.event_id.trim() : null;
  if (event !== null && (event.length > 200 || secretProblem(event))) fail('event_id', 'is that side\'s id for the report');
  const code = present(raw, 'code') ? String(raw.code) : null;
  if (code !== null && !CODE.test(code)) fail('code', 'is a lower-case code');
  let occurred: string | null = null;
  if (present(raw, 'occurred_at')) {
    const at = typeof raw.occurred_at === 'string' ? Date.parse(raw.occurred_at) : Number.NaN;
    if (Number.isNaN(at)) fail('occurred_at', 'is a timestamp');
    else occurred = new Date(at).toISOString();
  }
  if (raw.opted_out !== undefined && typeof raw.opted_out !== 'boolean') fail('opted_out', 'must be true or false');

  return done(errors, {
    connector_key: raw.connector_key as string,
    external_id: external,
    state: raw.state as typeof DELIVERY_REPORTS[number],
    event_id: event,
    occurred_at: occurred,
    code,
    opted_out: raw.opted_out === true,
  });
}

export interface SuppressInput {
  /** the customer whose address it is, or — for a thread no customer is tied to — the thread. */
  contact_id: string | null;
  conversation_id: string | null;
  channel: Channel;
  reason: typeof SUPPRESS_REASONS[number];
  note: string | null;
}

export function parseSuppressRequest(input: unknown): Parsed<SuppressInput> {
  const raw = asObject(input);
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });
  const id = (key: string) => (typeof raw[key] === 'string' && UUID.test(raw[key] as string) ? (raw[key] as string).toLowerCase() : null);

  const contact = id('contact_id');
  const conversation = id('conversation_id');
  if (!contact && !conversation) fail('contact_id', 'name the customer or the conversation');
  const channel = raw.channel ?? 'sms';
  if (!isChannel(channel)) fail('channel', `must be one of: ${CHANNELS.join(', ')}`);
  const reason = raw.reason ?? 'opt_out';
  if (!(SUPPRESS_REASONS as readonly unknown[]).includes(reason)) fail('reason', `must be one of: ${SUPPRESS_REASONS.join(', ')}`);
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
  if (note !== null && note.length > 300) fail('note', 'is longer than 300 characters');
  else if (note !== null && secretProblem(note)) fail('note', 'looks like a credential — those are never kept on a customer record');

  return done(errors, {
    contact_id: contact,
    conversation_id: conversation,
    channel: channel as Channel,
    reason: reason as typeof SUPPRESS_REASONS[number],
    note,
  });
}

export interface SnippetInput {
  key: string;
  name: string;
  channel: 'any' | Channel;
  body: string;
  archived: boolean;
}

export function parseSnippetInput(input: unknown): Parsed<SnippetInput> {
  const raw = asObject(input);
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  if (typeof raw.key !== 'string' || !KEY.test(raw.key)) fail('key', 'is lowercase letters, digits and underscores, starting with a letter');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail('name', 'is required');
  else if (name.length > 120) fail('name', 'is longer than 120 characters');
  else if (secretProblem(name)) fail('name', 'looks like a credential');
  const channel = raw.channel ?? 'any';
  if (channel !== 'any' && !isChannel(channel)) fail('channel', 'is any, sms or email');
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body) fail('body', 'is required');
  else if (body.length > 1600) fail('body', 'is longer than 1600 characters');
  else if (secretProblem(body)) fail('body', 'looks like it carries a credential');
  else {
    const unknown = [...body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((p) => !(SNIPPET_PLACEHOLDERS as readonly string[]).includes(p));
    if (unknown.length > 0) fail('body', `can only fill in: ${SNIPPET_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`);
  }
  if (raw.archived !== undefined && typeof raw.archived !== 'boolean') fail('archived', 'must be true or false');

  return done(errors, { key: raw.key as string, name, channel: channel as 'any' | Channel, body, archived: raw.archived === true });
}

/**
 * ARC-370 — the communications service: every read and write of a conversation.
 *
 *   getThread            one customer's conversations: what was said, where each message has
 *                        got to, and — before anybody types — whether a message could be sent
 *                        and exactly why not
 *   listConversations    every thread for a client, the unread and the unmatched first
 *   sendMessage          a message a person wrote → one row and one durable action, or neither
 *   ingestInboundMessage the inbound contract: a provider's message, or one the client's own
 *                        system reports, onto the right thread — once
 *   recordDelivery       what a provider says happened to something that was sent
 *   suppressAddress      "this customer asked us to stop", from the screen
 *   markRead / assignConversation / cancelMessage / reconcileMessage / flushQueue
 *   listSnippets / saveSnippet
 *
 * Each is ARC-340's four steps: may this actor do this (`can`), parse every problem at once,
 * then one SQL function that decides under a lock (0026). This file never decides whether an
 * address may be written to — it asks `crm_message_gate`, and 0026 asks it again at the send.
 *
 * Sending rides ARC-200's queue. A message needs two things that are not about the message:
 *
 *   a channel   a connection of this client's, verified for the channel's capability
 *               (ARC-130), that an adapter in this runtime can send through;
 *   a module    one whose registry requirements include that capability, active for this
 *               client (ARC-120). The run is that module's and is pinned to its authorised
 *               configuration, so pausing it holds a person's messages too. Which module is
 *               read from the registry, never named here.
 *
 * Nothing here writes `events`, and nothing here is a figure.
 */

import { runConsolePass } from '../activation/connection-test.ts';
import { resolveEffectiveConfig } from '../config/engine.ts';
import type { ConfigStore } from '../config/store.ts';
import { can, type CrmActor, type CrmPermission, type FieldError } from '../crm/model.ts';
import { type CrmErrorCode, type CrmOutcome, type CrmStore, CrmStoreError, type Row, type RowQuery } from '../crm/service.ts';
import { peopleFor, type Person } from '../crm/workspace.ts';
import { classifyReply } from '../engine/rules.ts';
import type { ConfigSnapshotRow } from '../engine/store.ts';
import type { LifecycleStore } from '../lifecycle/store.ts';
import { latestSelectableModuleVersion, type ModuleDefinition, selectableModules } from '../registry/modules.ts';
import { requiredCapabilities } from '../registry/resolve.ts';
import { createRunnerRegistry } from '../runner/registry.ts';
import { resolveAmbiguousAction } from '../scheduler/service.ts';
import type { SchedulerStore } from '../scheduler/store.ts';
import type { ChannelGateway } from './channels.ts';
import {
  type BlockCode,
  type Channel,
  CHANNEL_DEFINITIONS,
  CHANNELS,
  type ConsentBasis,
  isUnread,
  parseArrival,
  timeOf,
  parseDeliveryReport,
  parseOutboundMessage,
  parseSnippetInput,
  parseSuppressRequest,
} from './model.ts';
import { MESSAGE_SEND_RUNNER, MessageSendRunner, type MessageSendStore } from './runner.ts';

/* ── the store ──────────────────────────────────────────── */

export const COMMUNICATION_TABLES = ['crm_conversations', 'crm_messages', 'crm_conversation_events', 'crm_snippets'] as const;
export type CommunicationTable = typeof COMMUNICATION_TABLES[number];

export interface GateVerdict { code: string; detail: string }

export interface ArrivalOutcome {
  outcome: 'recorded' | 'duplicate';
  message_id: string;
  conversation_id: string;
  contact_id: string | null;
  lead_id: string | null;
  suppressed: boolean;
}

/** Tenant-scoped like ARC-340's store: there is no unscoped read. */
export interface CommunicationsStore extends MessageSendStore {
  rows(table: CommunicationTable, tenantId: string, query?: RowQuery): Promise<Row[]>;
  row(table: CommunicationTable, tenantId: string, id: string): Promise<Row | null>;
  /** 0026's crm_message_gate: the first reason this address may not be written to, or null. */
  gate(tenantId: string, channel: Channel, address: string, acknowledged: string[]): Promise<GateVerdict | null>;
  queueMessage(tenantId: string, message: Row, actorType: string, actorId: string): Promise<{ outcome: 'queued' | 'replayed'; message: Row }>;
  arrival(tenantId: string, message: Row): Promise<ArrivalOutcome>;
  delivery(tenantId: string, report: Row): Promise<Row>;
  suppress(tenantId: string, request: Row, actorType: string, actorId: string): Promise<Row>;
  updateConversation(tenantId: string, conversationId: string, change: Row, actorType: string, actorId: string): Promise<Row>;
  cancelMessage(tenantId: string, messageId: string, actorType: string, actorId: string): Promise<Row>;
  reconciled(tenantId: string, messageId: string, resolution: string, actorId: string): Promise<Row>;
  saveSnippet(row: Row): Promise<Row>;
  /** the durable actions behind these messages (0017): status, gate, last error. */
  actions(tenantId: string, ids: string[]): Promise<Row[]>;
  /** this client's connection metadata (0016): id, connector, status, verified capabilities. never a credential. */
  connections(tenantId: string): Promise<Row[]>;
  /** the latest consent evidence for an address (0024), or null. */
  consent(tenantId: string, channel: Channel, address: string): Promise<Row | null>;
  /** Lead Recovery's own leads at this number (0010): status, safety flags, consent. by reference. */
  recoveryLeads(tenantId: string, phone: string): Promise<Row[]>;
  /** Lead Recovery's own messages with this number (0010). by reference; never copied. */
  recoveryMessages(tenantId: string, phone: string): Promise<Row[]>;
}

/** What sending needs beyond the message: the queue, the configuration to pin to, and a way out. */
export interface SendingDeps {
  engine: ConfigStore & Pick<LifecycleStore, 'getLifecycle'> & {
    createConfigSnapshot(row: Omit<ConfigSnapshotRow, 'id' | 'createdAt'>): Promise<ConfigSnapshotRow>;
  };
  scheduler: SchedulerStore;
  gateway: ChannelGateway;
  /** false leaves a queued message for a scheduler worker instead of running the pass here. */
  pass?: boolean;
  worker?: string;
}

export interface CommunicationsDeps {
  crm: CrmStore;
  comms: CommunicationsStore;
  /** null or absent: this deployment can read conversations but not send. */
  sending?: SendingDeps | null;
  now?: () => Date;
}

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const asObject = (raw: unknown): Row => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {});
const refuse = (code: CrmErrorCode, message: string) => ({ ok: false as const, code, message });
const invalid = (errors: FieldError[]) => ({
  ok: false as const, code: 'invalid' as CrmErrorCode, message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: errors,
});

type Human = Extract<CrmActor, { kind: 'operator' | 'client_user' }>;
const isPerson = (actor: CrmActor): actor is Human => actor.kind === 'operator' || actor.kind === 'client_user';

async function act<T>(
  deps: CommunicationsDeps, actor: CrmActor | null, permission: CrmPermission, tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  const allowed = can(actor, permission, tenantId);
  if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
  try {
    if (!(await deps.crm.getTenant(tenantId))) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor);
  } catch (error) {
    if (error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

/** a write only a signed-in person makes. */
function person<T>(
  deps: CommunicationsDeps, actor: CrmActor | null, permission: CrmPermission, tenantId: unknown,
  fn: (tenantId: string, actor: Human) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  return act(deps, actor, permission, tenantId, (id, who) =>
    isPerson(who) ? fn(id, who) : Promise.resolve(refuse('forbidden', 'this is a person\'s decision')));
}

/* ── can anything be sent, and through what ─────────────── */

export interface SendRoute {
  moduleKey: string;
  connectionId: string;
  connectorKey: string;
}

type RouteAnswer = { ok: true; route: SendRoute } | { ok: false; code: BlockCode; detail: string };

const USABLE = new Set(['verified', 'degraded']);

/** The selectable modules whose registry contract REQUIRES this capability: the ones an
 *  operator cleared to reach a customer this way when they activated them. */
export function modulesRequiring(capability: string): ModuleDefinition[] {
  return selectableModules().filter((module) => {
    const version = latestSelectableModuleVersion(module.key);
    return Boolean(version) && requiredCapabilities(version!).required.includes(capability);
  });
}

/**
 * The connection and the module a message on this channel would be sent through, read from
 * current rows — or the reason there is none. Nothing is created here.
 */
export async function resolveSendRoute(deps: CommunicationsDeps, tenantId: string, channel: Channel): Promise<RouteAnswer> {
  const definition = CHANNEL_DEFINITIONS[channel];
  const capability = definition.sendCapability;
  if (!capability) return { ok: false, code: 'no_channel', detail: `ARC cannot send ${definition.label} yet — a message their own system sent is still shown here` };
  const sending = deps.sending;
  if (!sending) return { ok: false, code: 'no_channel', detail: 'sending is not switched on in this deployment' };

  const connections = (await deps.comms.connections(tenantId))
    .filter((c) => USABLE.has(c.status) && Array.isArray(c.verified_capabilities) && c.verified_capabilities.includes(capability))
    .sort((a, b) => (a.status === 'verified' ? 0 : 1) - (b.status === 'verified' ? 0 : 1));
  if (connections.length === 0) {
    return { ok: false, code: 'no_channel', detail: `no ${definition.label} provider is connected for this client` };
  }
  const connection = connections.find((c) => sending.gateway.serves(c.connector_key, channel));
  if (!connection) {
    return { ok: false, code: 'no_channel', detail: `${connections[0].connector_key} is connected, but this build cannot send ${definition.label} through it yet` };
  }

  const modules = modulesRequiring(capability);
  let seen: string | null = null;
  for (const module of modules) {
    const lifecycle = await sending.engine.getLifecycle(tenantId, module.key);
    const state = lifecycle?.state ?? 'unselected';
    if (state === 'active') {
      return { ok: true, route: { moduleKey: module.key, connectionId: connection.id, connectorKey: connection.connector_key } };
    }
    seen ??= `${module.displayName.toLowerCase()} is ${state}`;
  }
  return {
    ok: false,
    code: 'module_not_ready',
    detail: seen
      ? `${seen} — a message is sent only while a module cleared to contact customers is active`
      : 'no module that contacts customers this way is available',
  };
}

/* ── one customer's conversations ───────────────────────── */

export const THREAD_LIMITS = Object.freeze({ messages: 200, recovery: 200, conversations: 200 });

export interface Compose {
  /** may this viewer queue a message on this thread right now. */
  can_send: boolean;
  /** the reason not, in the server's words. null when it can. */
  block: { code: string; detail: string } | null;
  /** safety flags the sender must confirm having read; sent back as `acknowledged_safety`. */
  needs_acknowledgement: string[];
  consent_basis: ConsentBasis | null;
  /** the connector a message would leave through. a name, never a credential. */
  through: string | null;
}

export interface Thread {
  channel: Channel;
  address: string;
  conversation: Row | null;
  unread: boolean;
  /** how many live customers on file share this address. more than one is said on the screen. */
  shared_by: number;
  messages: Row[];
  /** action id → the durable action behind a message (0017), for where it has got to. */
  actions: Record<string, Row>;
  /** Lead Recovery's own messages with this number, by reference. */
  recovery: Row[];
  /** is this address on the do-not-contact list, and why. */
  do_not_contact: { reason: string; since: string | null } | null;
  compose: Compose;
  truncated: boolean;
}

export interface ThreadView {
  contact: Row | null;
  threads: Thread[];
  snippets: Row[];
  /** whoever wrote a message here or holds a thread, named the way the workspace names people. */
  people: Person[];
  viewer: { kind: string; user_id: string | null; may: { send: boolean; suppress: boolean; assign: boolean; reconcile: boolean; snippets: boolean } };
  read_at: string;
}

function viewerOf(actor: CrmActor, tenantId: string): ThreadView['viewer'] {
  const allowed = (p: CrmPermission) => can(actor, p, tenantId).ok && isPerson(actor);
  return {
    kind: actor.kind,
    user_id: isPerson(actor) ? actor.userId : null,
    may: { send: allowed('record'), suppress: allowed('record'), assign: allowed('sensitive'), reconcile: allowed('policy'), snippets: allowed('business') },
  };
}

async function consentBasis(deps: CommunicationsDeps, tenantId: string, channel: Channel, address: string, conversation: Row | null, recovery: Row[]): Promise<ConsentBasis> {
  const latest = await deps.comms.consent(tenantId, channel, address);
  if (latest?.granted === true) return 'recorded_grant';
  if (channel === 'sms' && recovery.some((l) => l.consent_sms === true)) return 'recorded_grant';
  return conversation?.last_inbound_at ? 'inbound_message' : 'none_on_file';
}

async function buildThread(
  deps: CommunicationsDeps, tenantId: string, actor: CrmActor, channel: Channel, address: string,
  contact: Row | null, now: Date,
): Promise<Thread> {
  const store = deps.comms;
  const [conversation] = await store.rows('crm_conversations', tenantId, { eq: { channel, address } });
  const field = CHANNEL_DEFINITIONS[channel].contactField;
  const [messages, sharing, suppressions, leads, recovery] = await Promise.all([
    conversation
      ? store.rows('crm_messages', tenantId, { eq: { conversation_id: conversation.id }, order: ['occurred_at', 'desc'], limit: THREAD_LIMITS.messages })
      : Promise.resolve([]),
    deps.crm.rows('crm_contacts', tenantId, { eq: { [field]: address }, isNull: ['archived_at', 'merged_into_id'] }),
    deps.crm.suppressions(tenantId, [address]),
    channel === 'sms' ? store.recoveryLeads(tenantId, address) : Promise.resolve([]),
    channel === 'sms' ? store.recoveryMessages(tenantId, address) : Promise.resolve([]),
  ]);
  const actionIds = messages.map((m) => m.action_id).filter(Boolean) as string[];
  const actions = actionIds.length > 0 ? await store.actions(tenantId, actionIds) : [];
  const suppression = suppressions.find((s) => s.channel === channel && (!s.expires_at || timeOf(s.expires_at) > now.getTime())) ?? null;

  /* whether a message could be sent — asked of the same gate the send will ask. */
  const flags = [...new Set(leads
    .filter((l) => !['closed', 'booked', 'suppressed'].includes(l.status))
    .flatMap((l) => (Array.isArray(l.safety_flags) ? l.safety_flags as string[] : [])))];
  let block: Compose['block'] = null;
  let through: string | null = null;
  if (!isPerson(actor) || !can(actor, 'record', tenantId).ok) {
    block = { code: 'forbidden', detail: 'you can read this conversation but not write to it' };
  } else if (contact && (contact.archived_at || contact.merged_into_id)) {
    block = { code: 'contact_unavailable', detail: 'this customer is archived or was merged' };
  } else {
    /* with every current flag acknowledged, what is left is a reason no confirmation lifts. */
    const verdict = await store.gate(tenantId, channel, address, flags);
    if (verdict) block = verdict;
    else {
      const route = await resolveSendRoute(deps, tenantId, channel);
      if (!route.ok) block = { code: route.code, detail: route.detail };
      else through = route.route.connectorKey;
    }
  }

  return {
    channel,
    address,
    conversation: conversation ?? null,
    unread: conversation ? isUnread(conversation) : false,
    shared_by: sharing.length,
    messages: [...messages].reverse(),
    actions: Object.fromEntries(actions.map((a) => [a.id, a])),
    recovery,
    do_not_contact: suppression ? { reason: suppression.reason, since: suppression.created_at ?? null } : null,
    compose: {
      can_send: block === null,
      block,
      needs_acknowledgement: block === null ? flags : [],
      consent_basis: await consentBasis(deps, tenantId, channel, address, conversation ?? null, leads),
      through,
    },
    truncated: messages.length >= THREAD_LIMITS.messages,
  };
}

/**
 * The conversations of one customer (`contact_id`), or one thread nobody is tied to yet
 * (`conversation_id`). A thread belongs to an address: it is shown on every live customer who
 * holds that address, and says so when more than one does.
 */
export function getThread(
  deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, by: { contact_id?: unknown; conversation_id?: unknown },
): Promise<CrmOutcome<ThreadView>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const now = deps.now?.() ?? new Date();
    let contact: Row | null = null;
    const targets: [Channel, string][] = [];
    if (isId(by.contact_id)) {
      contact = await deps.crm.row('crm_contacts', id, by.contact_id);
      if (!contact) return refuse('not_found', 'no such customer for this client');
      for (const channel of CHANNELS) {
        const address = contact[CHANNEL_DEFINITIONS[channel].contactField];
        if (address) targets.push([channel, address]);
      }
    } else if (isId(by.conversation_id)) {
      const conversation = await deps.comms.row('crm_conversations', id, by.conversation_id);
      if (!conversation) return refuse('not_found', 'no such conversation for this client');
      targets.push([conversation.channel, conversation.address]);
    } else {
      return refuse('invalid', 'name the customer or the conversation');
    }
    const threads: Thread[] = [];
    for (const [channel, address] of targets) threads.push(await buildThread(deps, id, who, channel, address, contact, now));
    const snippets = await deps.comms.rows('crm_snippets', id, { isNull: ['archived_at'], order: ['name', 'asc'] });
    const named = threads.flatMap((t) => [t.conversation?.assigned_user_id, ...t.messages.map((m) => m.author_id)]).filter(Boolean) as string[];
    return {
      ok: true,
      result: { contact, threads, snippets, people: await peopleFor(deps, id, who, named), viewer: viewerOf(who, id), read_at: now.toISOString() },
    };
  });
}

/* ── every thread for a client ──────────────────────────── */

export interface ConversationSummary {
  conversation: Row;
  unread: boolean;
  /** the live customers who hold this address. none: nobody on file — a person adds them. */
  contacts: { id: string; display_name: string }[];
  last: { body: string; direction: string; at: string } | null;
}

export function listConversations(
  deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown,
): Promise<CrmOutcome<{ conversations: ConversationSummary[]; truncated: boolean; viewer: ThreadView['viewer'] }>> {
  return act(deps, actor, 'read', tenantId, async (id, who) => {
    const conversations = (await deps.comms.rows('crm_conversations', id, { notNull: ['last_message_at'], order: ['last_message_at', 'desc'], limit: THREAD_LIMITS.conversations }));
    const recent = await deps.comms.rows('crm_messages', id, { order: ['occurred_at', 'desc'], limit: 500 });
    const last = new Map<string, Row>();
    for (const message of recent) if (!last.has(message.conversation_id)) last.set(message.conversation_id, message);

    const byChannel = (channel: Channel) => [...new Set(conversations.filter((c) => c.channel === channel).map((c) => c.address as string))];
    const holders = new Map<string, { id: string; display_name: string }[]>();
    for (const channel of CHANNELS) {
      const addresses = byChannel(channel);
      const field = CHANNEL_DEFINITIONS[channel].contactField;
      for (let i = 0; i < addresses.length; i += 100) {
        const rows = await deps.crm.rows('crm_contacts', id, { in: [field, addresses.slice(i, i + 100)], isNull: ['archived_at', 'merged_into_id'] });
        for (const row of rows) {
          const key = `${channel}:${row[field]}`;
          holders.set(key, [...(holders.get(key) ?? []), { id: row.id, display_name: row.display_name }]);
        }
      }
    }

    const summaries = conversations.map((conversation): ConversationSummary => {
      const message = last.get(conversation.id) ?? null;
      return {
        conversation,
        unread: isUnread(conversation),
        contacts: holders.get(`${conversation.channel}:${conversation.address}`) ?? [],
        last: message ? { body: String(message.body).slice(0, 160), direction: message.direction, at: message.occurred_at } : null,
      };
    });
    /* what a person has not seen, then what nobody is tied to, then the rest by recency. */
    const rank = (s: ConversationSummary) => (s.unread ? 0 : s.contacts.length === 0 ? 1 : 2);
    summaries.sort((a, b) => rank(a) - rank(b) || timeOf(b.conversation.last_message_at) - timeOf(a.conversation.last_message_at));
    return { ok: true, result: { conversations: summaries, truncated: conversations.length >= THREAD_LIMITS.conversations, viewer: viewerOf(who, id) } };
  });
}

/* ── sending ────────────────────────────────────────────── */

export interface SendPass {
  /** what the pass did with this client's due work. */
  executed: { action_id: string; outcome: string | null; code: string; action_status: string | null }[];
  /** set when the pass did not run, and why. the message stays queued. */
  deferred: { reason: string; waiting: number } | null;
}

async function pass(deps: CommunicationsDeps, tenantId: string): Promise<SendPass> {
  const sending = deps.sending;
  if (!sending) return { executed: [], deferred: { reason: 'sending is not switched on in this deployment', waiting: 0 } };
  if (sending.pass === false) return { executed: [], deferred: { reason: 'queued for the scheduler worker', waiting: 0 } };
  const runner = new MessageSendRunner({ store: deps.comms, gateway: sending.gateway });
  const result = await runConsolePass(
    { store: sending.scheduler, runners: createRunnerRegistry([runner], { defaultKind: runner.kind }), worker: sending.worker ?? 'crm-messages' },
    tenantId,
  );
  return {
    executed: result.executed.map((r) => ({ action_id: r.actionId, outcome: r.outcome, code: r.code, action_status: r.actionStatus })),
    deferred: result.deferred,
  };
}

/**
 * A message a person wrote. The route is resolved, the configuration snapshot it will run
 * under is named, and then 0026's `crm_queue_message` writes the message, its run and its
 * `send_message` action in one transaction — re-checking the gate, the module's lifecycle and
 * the connection as it goes. Any refusal there writes nothing. Then this client's due work
 * is run once, so a message that can leave now does.
 */
export function sendMessage(
  deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<CrmOutcome<{ outcome: 'queued' | 'replayed'; message: Row; pass: SendPass }>> {
  return person(deps, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseOutboundMessage(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const route = await resolveSendRoute(deps, id, parsed.value.channel);
    if (!route.ok) return refuse(route.code, route.detail);
    const sending = deps.sending!;

    const resolution = await resolveEffectiveConfig(sending.engine, id, route.route.moduleKey);
    if (!resolution.ok) return refuse('module_not_ready', `the configuration a message is sent under cannot be resolved: ${resolution.message}`);
    const snapshot = await sending.engine.createConfigSnapshot({
      tenantId: id,
      moduleKey: route.route.moduleKey,
      configVersion: resolution.moduleVersion.version,
      schemaVersion: resolution.moduleVersion.schemaVersion,
      config: resolution.config,
      configHash: resolution.configHash,
      tenantConfigVersionId: resolution.tenantVersion.id,
      moduleConfigVersionId: resolution.moduleVersion.id,
    });

    const queued = await deps.comms.queueMessage(id, {
      ...parsed.value,
      module_key: route.route.moduleKey,
      config_snapshot_id: snapshot.id,
      connection_id: route.route.connectionId,
      runner_kind: MESSAGE_SEND_RUNNER,
    }, who.kind, who.userId);

    const ran = queued.outcome === 'queued' ? await pass(deps, id) : { executed: [], deferred: null };
    const message = await deps.comms.row('crm_messages', id, queued.message.id) ?? queued.message;
    return { ok: true, result: { outcome: queued.outcome, message, pass: ran } };
  });
}

/** Run this client's due message work once. What a person presses when something was waiting. */
export function flushQueue(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<SendPass>> {
  return person(deps, actor, 'record', tenantId, async (id) => ({ ok: true, result: await pass(deps, id) }));
}

/** A message that has not started sending, called back by a person. */
export function cancelMessage(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, messageId: unknown): Promise<CrmOutcome<Row>> {
  return person(deps, actor, 'record', tenantId, async (id, who) => {
    if (!isId(messageId)) return refuse('not_found', 'no such message for this client');
    return { ok: true, result: await deps.comms.cancelMessage(id, messageId, who.kind, who.userId) };
  });
}

/**
 * An operator settles a send whose outcome nobody knows, after checking with the provider:
 * `effect_happened` closes it — nothing is resent; `effect_absent` puts it back for one more
 * attempt. The queue's own record is reconciled first (0017), then the message follows it.
 */
export function reconcileMessage(
  deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<CrmOutcome<{ message: Row; pass: SendPass }>> {
  return person(deps, actor, 'policy', tenantId, async (id, who) => {
    const raw = asObject(input);
    if (!isId(raw.message_id)) return refuse('not_found', 'no such message for this client');
    if (raw.resolution !== 'effect_happened' && raw.resolution !== 'effect_absent') {
      return invalid([{ field: 'resolution', message: 'is effect_happened or effect_absent' }]);
    }
    const message = await deps.comms.row('crm_messages', id, raw.message_id);
    if (!message) return refuse('not_found', 'no such message for this client');
    if (message.action_id && deps.sending) {
      const settled = await resolveAmbiguousAction(deps.sending.scheduler, {
        tenantId: id, actionId: message.action_id, resolution: raw.resolution, operatorId: who.userId,
        note: typeof raw.note === 'string' ? raw.note : null,
      });
      /* not ambiguous in the queue is not a refusal: the runner recorded "unknown" itself. */
      if (!settled.ok && settled.code !== 'not_ambiguous') return refuse('conflict', settled.message);
    }
    const updated = await deps.comms.reconciled(id, raw.message_id, raw.resolution, who.userId);
    const ran = raw.resolution === 'effect_absent' ? await pass(deps, id) : { executed: [], deferred: null };
    return { ok: true, result: { message: await deps.comms.row('crm_messages', id, updated.id) ?? updated, pass: ran } };
  });
}

/* ── arriving ───────────────────────────────────────────── */

/**
 * The inbound contract. A provider's message (`system`), or one the client's own system
 * reports through its connector (`external`), lands on the thread for its address — once,
 * however many times it is delivered. Whether the body is an opt-out is read by ARC's
 * deterministic rules, the same ones Lead Recovery uses and never a model; 0026 then writes
 * the suppression in the transaction that records the message.
 */
export function ingestInboundMessage(
  deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown,
): Promise<CrmOutcome<ArrivalOutcome>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    if (who.kind !== 'system' && who.kind !== 'external') return refuse('forbidden', 'a message arrives through a provider or the client\'s own system, not from a person');
    const parsed = parseArrival(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const arrival = parsed.value;
    if (who.kind === 'external' && who.connectorKey !== arrival.connector_key) {
      return invalid([{ field: 'connector_key', message: `this sync is ${who.connectorKey}, not ${arrival.connector_key}` }]);
    }
    if (arrival.direction === 'outbound' && who.kind !== 'external') {
      return invalid([{ field: 'direction', message: 'only the client\'s own system reports a message it sent' }]);
    }
    const verdict = arrival.direction === 'inbound' ? classifyReply(arrival.body) : null;
    return {
      ok: true,
      result: await deps.comms.arrival(id, {
        ...arrival,
        origin: who.kind === 'external' ? 'external_system' : 'provider',
        opt_out_reason: verdict?.suppressionReason ?? null,
      }),
    };
  });
}

/** What a provider says happened to something that was sent. Kept every time; applied forward only. */
export function recordDelivery(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    if (who.kind !== 'system' && who.kind !== 'external') return refuse('forbidden', 'a delivery report comes from a provider, not from a person');
    const parsed = parseDeliveryReport(input);
    if (!parsed.ok) return invalid(parsed.errors);
    if (who.kind === 'external' && who.connectorKey !== parsed.value.connector_key) {
      return invalid([{ field: 'connector_key', message: `this sync is ${who.connectorKey}, not ${parsed.value.connector_key}` }]);
    }
    return { ok: true, result: await deps.comms.delivery(id, parsed.value) };
  });
}

/* ── a person's decisions about a thread ────────────────── */

/**
 * "This customer asked us to stop." Anybody on the team can say so, at once: honouring an
 * opt-out must never wait for the account owner. It only ever adds to the list — nothing in
 * this workspace takes an address off it.
 */
export function suppressAddress(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return person(deps, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseSuppressRequest(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const request = parsed.value;
    let channel = request.channel;
    let address: string | null = null;
    if (request.conversation_id) {
      const conversation = await deps.comms.row('crm_conversations', id, request.conversation_id);
      if (!conversation) return refuse('not_found', 'no such conversation for this client');
      channel = conversation.channel;
      address = conversation.address;
    } else {
      const contact = await deps.crm.row('crm_contacts', id, request.contact_id!);
      if (!contact) return refuse('not_found', 'no such customer for this client');
      address = contact[CHANNEL_DEFINITIONS[channel].contactField] ?? null;
    }
    if (!address) return refuse('no_address', `this customer has no ${CHANNEL_DEFINITIONS[channel].label} address on file`);
    return { ok: true, result: await deps.comms.suppress(id, { channel, address, reason: request.reason, note: request.note }, who.kind, who.userId) };
  });
}

export function markRead(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, conversationId: unknown): Promise<CrmOutcome<Row>> {
  return person(deps, actor, 'record', tenantId, async (id, who) => {
    if (!isId(conversationId)) return refuse('not_found', 'no such conversation for this client');
    return { ok: true, result: await deps.comms.updateConversation(id, conversationId, { read: true }, who.kind, who.userId) };
  });
}

/** Taking a thread yourself is ordinary work; handing it to somebody else is the owner's call (0026 checks both). */
export function assignConversation(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return person(deps, actor, 'record', tenantId, async (id, who) => {
    const raw = asObject(input);
    if (!isId(raw.conversation_id)) return refuse('not_found', 'no such conversation for this client');
    const target = raw.assigned_user_id ?? null;
    if (target !== null && !isId(target)) return invalid([{ field: 'assigned_user_id', message: 'is not an id' }]);
    return { ok: true, result: await deps.comms.updateConversation(id, raw.conversation_id, { assigned_user_id: target }, who.kind, who.userId) };
  });
}

/* ── canned replies ─────────────────────────────────────── */

export function listSnippets(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<Row[]>> {
  return act(deps, actor, 'read', tenantId, async (id) => ({
    ok: true,
    result: await deps.comms.rows('crm_snippets', id, { order: ['name', 'asc'] }),
  }));
}

export function saveSnippet(deps: CommunicationsDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<Row>> {
  return person(deps, actor, 'business', tenantId, async (id, who) => {
    const parsed = parseSnippetInput(input);
    if (!parsed.ok) return invalid(parsed.errors);
    const { archived, ...fields } = parsed.value;
    return {
      ok: true,
      result: await deps.comms.saveSnippet({
        tenant_id: id, ...fields, archived_at: archived ? (deps.now?.() ?? new Date()).toISOString() : null,
        updated_by_type: who.kind, updated_by: who.userId,
      }),
    };
  });
}

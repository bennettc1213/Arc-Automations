/* ARC-370 — the communications hub, against real Postgres.
 *
 * Two parts, as for 0023–0025:
 *
 *   1. The text of 0026, always: RLS and a read policy on every table and no write policy,
 *      nothing granted to a browser role, its vocabulary the model's, and no path from a note
 *      to a send.
 *   2. The migration APPLIED, when PGlite is available: the real service and the real action
 *      table (the one both `ops` and the client's `crm` function run) over the real stores,
 *      the real ARC-200 scheduler and the real ARC-210 orchestrator. Only the last inch is a
 *      double: a channel gateway that records what it was asked to send and answers as told —
 *      every real messaging provider is still `planned`.
 *
 * Without PGlite part 2 is reported as skipped, never as passed.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { asRole, freshDatabase, loadPglite, refused, restClient, SKIP_REASON } from './pglite-harness.js';
import { LR, newOperator, newUser, tenant } from './scheduler-fixtures.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { supabaseCrmStore } from '../supabase/functions/_shared/crm/supabase-crm-store.ts';
import { supabaseIntakeStore } from '../supabase/functions/_shared/intake/supabase-intake-store.ts';
import { supabaseSchedulerStore } from '../supabase/functions/_shared/scheduler/supabase-scheduler-store.ts';
import { supabaseCommunicationsStore } from '../supabase/functions/_shared/communications/supabase-communications-store.ts';
import * as crm from '../supabase/functions/_shared/crm/service.ts';
import * as intake from '../supabase/functions/_shared/intake/service.ts';
import * as comms from '../supabase/functions/_shared/communications/service.ts';
import { ChannelSendError } from '../supabase/functions/_shared/communications/channels.ts';
import {
  AUTHOR_TYPES, CHANNELS, CONSENT_BASES, deliveryState, DIRECTIONS, EVENT_KINDS, MESSAGE_STATUSES, ORIGINS, SUPPRESS_REASONS, threadEntries,
} from '../supabase/functions/_shared/communications/model.ts';
import { handleWorkspaceAction, WORKSPACE_ACTIONS } from '../supabase/functions/_shared/crm/actions.ts';
import { RUN_KINDS, SCHEDULER_RUN_KINDS } from '../supabase/functions/_shared/scheduler/model.ts';
import { intakeLead, takeOverLead } from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0026_crm_communications.sql', import.meta.url), 'utf8');
const CODE = SQL.replace(/--.*$/gm, '');
const TABLES = ['crm_conversations', 'crm_messages', 'crm_conversation_events', 'crm_snippets'];

/** the values a check constraint allows: `column text … check (column in ('a', 'b'))`. */
const allowed = (column) => {
  const match = new RegExp(`${column}\\s[^;]*?check \\(\\s*${column} in \\(([^)]*)\\)`, 's').exec(CODE);
  assert.ok(match, `0026 constrains ${column}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

/* ══ 1. the file ══════════════════════════════════════════ */

describe('0026 as written', () => {
  test('every table has RLS and a read policy for members and operators, and no write policy', () => {
    assert.match(CODE, /foreach t in array array\['crm_conversations', 'crm_messages', 'crm_conversation_events', 'crm_snippets'\]/);
    assert.match(CODE, /enable row level security/);
    assert.match(CODE, /for select to authenticated using \(public\.is_tenant_member\(tenant_id\) or public\.is_arc_admin\(\)\)/);
    assert.doesNotMatch(CODE, /for (insert|update|delete|all) to/i);
    assert.match(CODE, /revoke insert, update, delete, truncate on public\.%I from anon, authenticated/);
  });

  test('no function here is executable by a browser role, and none is security definer', () => {
    const functions = [...CODE.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    assert.ok(functions.length >= 15);
    for (const name of functions) assert.match(CODE, new RegExp(`revoke all on function public\\.${name}\\(`), `${name} is revoked`);
    assert.doesNotMatch(CODE, /security definer/i);
    assert.doesNotMatch(CODE, /grant [^;]* to (anon|authenticated)/i);
  });

  test('the vocabularies are the model\'s', () => {
    assert.deepEqual(allowed('direction'), [...DIRECTIONS]);
    assert.deepEqual(allowed('origin'), [...ORIGINS]);
    assert.deepEqual(allowed('status'), [...MESSAGE_STATUSES]);
    assert.deepEqual(allowed('author_type'), [...AUTHOR_TYPES]);
    assert.deepEqual(allowed('kind'), [...EVENT_KINDS]);
    assert.deepEqual(allowed('channel'), [...CHANNELS]);
    assert.deepEqual([...CODE.matchAll(/consent_basis in \(([^)]*)\)/g)][0][1].match(/[a-z_]+/g), [...CONSENT_BASES]);
    assert.deepEqual(/v_reason not in \(([^)]*)\)/.exec(CODE)[1].match(/[a-z_]+/g), [...SUPPRESS_REASONS]);
  });

  test('a run that is one message is a kind the scheduler creates, in the migration and in the model', () => {
    assert.match(CODE, /run_kind in \('lead_conversation', 'connector_test', 'observation_window', 'crm_message'\)/);
    assert.ok(RUN_KINDS.includes('crm_message'));
    assert.ok(SCHEDULER_RUN_KINDS.includes('crm_message'));
  });

  test('forward-only: it creates tables and functions, widens two checks, and drops no table or column', () => {
    assert.doesNotMatch(CODE, /drop table|drop column|truncate table|delete from public\.(?!tenants)/i);
    assert.deepEqual([...CODE.matchAll(/drop constraint if exists ([a-z_]+)/g)].map((m) => m[1]), ['automation_runs_kind_check', 'suppressions_source_check']);
  });

  test('an internal note has no path to a send: nothing here reads the notes table', () => {
    assert.doesNotMatch(CODE, /crm_notes/);
    for (const file of ['service.ts', 'runner.ts', 'channels.ts', 'supabase-communications-store.ts']) {
      const source = readFileSync(new URL(`../supabase/functions/_shared/communications/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /crm_notes|addNote/, file);
    }
  });

  test('nothing here writes the evidence log, and the only write to the do-not-contact list adds to it', () => {
    assert.doesNotMatch(CODE, /insert into public\.events|update public\.events/);
    assert.equal([...CODE.matchAll(/insert into public\.suppressions/g)].length, 1);
    assert.doesNotMatch(CODE, /delete from public\.suppressions|update public\.suppressions/);
  });

  test('both doors run the conversation actions from one table', () => {
    for (const action of ['crm-thread', 'crm-conversations', 'crm-message-send', 'crm-message-cancel', 'crm-message-reconcile', 'crm-messages-flush',
      'crm-conversation-read', 'crm-conversation-assign', 'crm-do-not-contact', 'crm-snippets', 'crm-snippet-save']) {
      assert.ok(WORKSPACE_ACTIONS.includes(action), action);
    }
    /* a provider's message is not something a signed-in person can post. */
    assert.ok(!WORKSPACE_ACTIONS.some((a) => /ingest|arrival|delivery/.test(a)));
  });
});

/* ══ 2. the database ══════════════════════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

let phones = 7000;
const freshPhone = () => `+1614557${String(phones++).padStart(4, '0')}`;
let seq = 0;
const key = (prefix = 'k') => `${prefix}-${String(++seq).padStart(8, '0')}`;

describe('the communications hub on real SQL', { skip }, () => {
  let db;
  let client;
  let operator;
  let op;
  let acme;   // live Lead Recovery, a verified text connection
  let other;  // another client, also live
  let gateway;
  let deps;

  /** the last inch: records what it was asked to send, and answers as scripted. */
  function fakeGateway() {
    const g = {
      sent: [],
      script: [],
      serves: () => true,
      async send(request) {
        g.sent.push(request);
        const step = g.script.shift() ?? { do: 'ok' };
        if (step.do === 'ok') return { providerMessageId: step.id ?? `SM${String(g.sent.length).padStart(6, '0')}-${request.idempotencyKey.slice(-8)}` };
        if (step.do === 'refuse') throw new ChannelSendError('provider_refused', 'no');
        if (step.do === 'retry') throw new ChannelSendError('rate_limited', 'no', { retryable: true });
        if (step.do === 'unknown') throw new ChannelSendError('provider_outcome_unknown', 'unknown');
        throw new Error('the gateway broke in a way nobody planned for');
      },
    };
    return g;
  }

  const connect = async (tenantId) => (await db.query(
    `insert into provider_connections (tenant_id, connector_key, connector_version, auth_method, status, verified_capabilities, credential_version, last_verified_at)
     values ($1, 'synthetic_oauth', 1, 'oauth2', 'verified', array['send_sms','receive_sms'], 1, now()) returning id`, [tenantId])).rows[0].id;

  async function client_(t, { connected = true } = {}) {
    const owner = await newUser(db);
    const staff = await newUser(db);
    await db.query(`insert into tenant_members (user_id, tenant_id, role) values ($1, $3, 'owner'), ($2, $3, 'staff')`, [owner, staff, t.tenantId]);
    return {
      t, id: t.tenantId, owner, staff, connection: connected ? await connect(t.tenantId) : null,
      ownerActor: { kind: 'client_user', userId: owner, tenantId: t.tenantId, role: 'owner' },
      staffActor: { kind: 'client_user', userId: staff, tenantId: t.tenantId, role: 'staff' },
    };
  }

  const ok = (outcome) => {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome.result;
  };
  const count = async (table, where = 'true', params = []) =>
    Number((await db.query(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0].n);
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  /** a customer and their lead, typed in through ARC-350's door. */
  async function customer(c, name = 'Dana Reyes', phone = freshPhone()) {
    const arrival = ok(await intake.createManualLead(deps, c.ownerActor, c.id, { contact: { display_name: name, phone }, lead: { title: `${name}'s job` } }));
    return { contact_id: arrival.contact_id, lead_id: arrival.lead_id, phone, name };
  }
  const text = (who, body, extra = {}) => ({ contact_id: who.contact_id, lead_id: who.lead_id, channel: 'sms', body, client_key: key('send'), ...extra });
  const inbound = (phone, body, extra = {}) => ({ channel: 'sms', address: phone, connector_key: 'synthetic_oauth', external_id: key('IN'), body, ...extra });
  const SYSTEM = { kind: 'system' };
  /** deps that queue without running the pass: the message waits, as it would for a worker. */
  const queuedOnly = () => ({ ...deps, sending: { ...deps.sending, pass: false } });
  const message = (id) => one('select * from crm_messages where id = $1', [id]);
  const action = (id) => one('select * from scheduled_actions where id = $1', [id]);
  const threadOf = async (c, actor, who) => ok(await comms.getThread(deps, actor, c.id, { contact_id: who.contact_id })).threads.find((t) => t.channel === 'sms');
  /** Lead Recovery's own lead and run for a number, made by the real engine. */
  async function recoveryLead(c, phone) {
    const engine = {
      store: c.t.lr, liveSender: new RecordingSender(), canarySender: new RecordingSender(), now: () => new Date(),
      classifierFor: () => ({ classify: async () => ({ ok: false, reason: 'no classifier' }) }),
      urls: {}, uuid: () => crypto.randomUUID(), worker: 'db-comms',
    };
    const made = await intakeLead(engine, {
      tenantId: c.id, source: 'web_form', externalRef: key('form'), phone, customerName: 'From a form',
      serviceRequest: 'no heat', intakeRef: 'site', consentSms: true, consentSource: 'web_form',
    });
    assert.ok(made.lead && made.run, made.outcome);
    return { engine, lead: made.lead, run: made.run };
  }

  before(async () => {
    db = await freshDatabase();
    client = restClient(db);
    operator = await newOperator(db);
    op = { kind: 'operator', userId: operator };
    gateway = fakeGateway();
    deps = {
      crm: supabaseCrmStore(client),
      intake: supabaseIntakeStore(client),
      comms: supabaseCommunicationsStore(client),
      sending: { engine: supabaseStore(client), scheduler: supabaseSchedulerStore(client), gateway, worker: 'db-comms' },
      now: () => new Date(),
    };
    const a = await tenant(db, operator);
    await a.live();
    acme = await client_(a);
    const b = await tenant(db, operator);
    await b.live();
    other = await client_(b);
  });

  /* ── inbound ─────────────────────────────────────────── */

  test('an inbound message lands on the right client, the right customer and their one open lead', async () => {
    const dana = await customer(acme);
    /* the other client has a customer on the very same number. */
    const twin = await customer(other, 'Not Dana', dana.phone);

    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound('(614) 557-' + dana.phone.slice(-4), 'Is Thursday still good?')));
    assert.equal(arrival.outcome, 'recorded');
    assert.equal(arrival.contact_id, dana.contact_id);
    assert.equal(arrival.lead_id, dana.lead_id);
    assert.equal(arrival.suppressed, false);

    const row = await message(arrival.message_id);
    assert.deepEqual([row.tenant_id, row.direction, row.origin, row.status, row.author_type, row.address], [acme.id, 'inbound', 'provider', 'received', 'customer', dana.phone]);
    assert.equal(await count('crm_messages', 'tenant_id = $1', [other.id]), 0, 'nothing was written for the other client');

    const mine = await threadOf(acme, acme.ownerActor, dana);
    assert.deepEqual(mine.messages.map((m) => m.body), ['Is Thursday still good?']);
    assert.equal(mine.unread, true);
    const theirs = await threadOf(other, other.ownerActor, twin);
    assert.deepEqual(theirs.messages, []);
    assert.equal(theirs.conversation, null);
  });

  test('two customers on one number: the message is kept on the thread and tied to neither — never guessed', async () => {
    const phone = freshPhone();
    const first = await customer(acme, 'Pat One', phone);
    const second = ok(await crm.createContact(deps.crm, acme.ownerActor, acme.id, { display_name: 'Pat Two', phone }));
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(phone, 'which of you is coming?')));
    assert.deepEqual([arrival.contact_id, arrival.lead_id], [null, null]);
    for (const contactId of [first.contact_id, second.id]) {
      const thread = ok(await comms.getThread(deps, acme.ownerActor, acme.id, { contact_id: contactId })).threads[0];
      assert.equal(thread.shared_by, 2);
      assert.equal(thread.messages.length, 1);
    }
  });

  test('a number nobody has on file is still a conversation, listed for a person to match', async () => {
    const stranger = freshPhone();
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(stranger, 'do you do duct cleaning?')));
    assert.equal(arrival.contact_id, null);
    const inbox = ok(await comms.listConversations(deps, acme.staffActor, acme.id));
    const row = inbox.conversations.find((c) => c.conversation.id === arrival.conversation_id);
    assert.deepEqual(row.contacts, []);
    assert.equal(row.unread, true);
    assert.equal(row.last.body, 'do you do duct cleaning?');
    assert.ok(inbox.conversations.every((c) => c.conversation.tenant_id === acme.id));
    /* it opens by the thread, since there is no customer to open it by. */
    const view = ok(await comms.getThread(deps, acme.staffActor, acme.id, { conversation_id: arrival.conversation_id }));
    assert.equal(view.contact, null);
    assert.equal(view.threads[0].shared_by, 0);
  });

  test('a redelivered provider message is one message — and a redelivered STOP is one opt-out', async () => {
    const dana = await customer(acme);
    const first = inbound(dana.phone, 'running ten minutes late');
    const a = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, first));
    const b = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, first));
    assert.equal(b.outcome, 'duplicate');
    assert.equal(b.message_id, a.message_id);
    assert.equal(await count('crm_messages', 'tenant_id = $1 and external_id = $2', [acme.id, first.external_id]), 1);

    const stop = inbound(dana.phone, 'STOP');
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, stop));
    const again = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, stop));
    assert.equal(again.outcome, 'duplicate');
    assert.equal(await count('suppressions', 'tenant_id = $1 and address = $2', [acme.id, dana.phone]), 1);
    assert.equal(await count('crm_conversation_events', `tenant_id = $1 and kind = 'do_not_contact' and conversation_id = $2`, [acme.id, a.conversation_id]), 1);
  });

  test('STOP puts the address on the do-not-contact list in the same breath — by rule, not by a model', async () => {
    const dana = await customer(acme);
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, ' Stop ')));
    assert.equal(arrival.suppressed, true);
    const row = await one('select * from suppressions where tenant_id = $1 and address = $2', [acme.id, dana.phone]);
    assert.deepEqual([row.channel, row.reason, row.source, row.expires_at], ['sms', 'opt_out', 'customer', null]);

    const wrong = await customer(acme);
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(wrong.phone, 'you have the wrong number')));
    assert.equal((await one('select reason from suppressions where tenant_id = $1 and address = $2', [acme.id, wrong.phone])).reason, 'wrong_contact');

    const fine = await customer(acme);
    const plain = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(fine.phone, 'please stop by after 3pm')));
    assert.equal(plain.suppressed, false);
    assert.equal(await count('suppressions', 'tenant_id = $1 and address = $2', [acme.id, fine.phone]), 0);

    const thread = await threadOf(acme, acme.staffActor, dana);
    assert.deepEqual(thread.do_not_contact.reason, 'opt_out');
    assert.deepEqual([thread.compose.can_send, thread.compose.block.code], [false, 'do_not_contact']);
  });

  test('an inbound message that looks like a credential is kept, with its body withheld', async () => {
    const dana = await customer(acme);
    const secret = ['pass', 'word=', 'hunter2hunter2'].join('');
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, `my login is ${secret}`)));
    const row = await message(arrival.message_id);
    assert.equal(row.body_withheld, true);
    assert.doesNotMatch(row.body, /hunter2/);
    assert.match(row.body, /withheld/);
  });

  test('a person cannot post a provider\'s message; their own system can report both directions, as itself only', async () => {
    const dana = await customer(acme);
    for (const actor of [op, acme.ownerActor]) {
      const refusedAs = await comms.ingestInboundMessage(deps, actor, acme.id, inbound(dana.phone, 'hello'));
      assert.deepEqual([refusedAs.ok, refusedAs.code], [false, 'forbidden']);
    }
    const jobber = { kind: 'external', connectorKey: 'jobber' };
    const impostor = await comms.ingestInboundMessage(deps, jobber, acme.id, inbound(dana.phone, 'hello'));
    assert.deepEqual([impostor.ok, impostor.code], [false, 'invalid']);

    const sent = ok(await comms.ingestInboundMessage(deps, jobber, acme.id, { channel: 'sms', address: dana.phone, connector_key: 'jobber', external_id: 'job-msg-1', direction: 'outbound', body: 'Tech is on the way.' }));
    const row = await message(sent.message_id);
    assert.deepEqual([row.direction, row.origin, row.status, row.author_type, row.external_id], ['outbound', 'external_system', 'sent', 'external', 'job-msg-1']);
    const entries = threadEntries(await threadOf(acme, acme.ownerActor, dana));
    assert.equal(entries.find((e) => e.id === row.id).speaker, 'their_system');
    /* ARC's own provider never claims ARC sent something. */
    const claimed = await comms.ingestInboundMessage(deps, SYSTEM, acme.id, { ...inbound(dana.phone, 'x'), direction: 'outbound' });
    assert.deepEqual([claimed.ok, claimed.code], [false, 'invalid']);
  });

  /* ── sending ─────────────────────────────────────────── */

  test('a message a person writes is one row and one durable action, sent once through the queue', async () => {
    const dana = await customer(acme);
    const before = gateway.sent.length;
    const evidence = await count('events', 'tenant_id = $1', [acme.id]);
    const sent = ok(await comms.sendMessage(deps, acme.staffActor, acme.id, text(dana, 'We can be there at 9am Thursday.')));
    assert.equal(sent.outcome, 'queued');

    const row = sent.message;
    assert.deepEqual([row.direction, row.origin, row.author_type, row.author_id, row.status], ['outbound', 'manual', 'client_user', acme.staff, 'sent']);
    assert.ok(row.external_id, 'the provider\'s id is kept');
    assert.equal(row.connection_id, acme.connection);
    assert.equal(row.consent_basis, 'none_on_file');

    const run = await one('select * from automation_runs where id = $1', [row.run_id]);
    assert.deepEqual([run.run_kind, run.run_mode, run.module_key, run.status, run.runner_kind, run.lifecycle_state_at_start], ['crm_message', 'live', LR, 'completed', 'arc_message_sender', 'active']);
    assert.ok(run.config_snapshot_id, 'pinned');
    const queued = await action(row.action_id);
    assert.deepEqual([queued.action_type, queued.status, queued.connection_id, queued.connector_key, queued.attempts], ['send_message', 'done', acme.connection, 'synthetic_oauth', 1]);
    /* the action carries a reference. the words are on the message row, and nowhere else. */
    assert.deepEqual(queued.payload, { message_id: row.id });
    const attempts = (await db.query('select * from automation_action_attempts where action_id = $1', [row.action_id])).rows;
    assert.deepEqual(attempts.map((a) => [a.status, a.runner_kind, a.external_request_id]), [['succeeded', 'arc_message_sender', row.external_id]]);

    assert.equal(gateway.sent.length, before + 1);
    const request = gateway.sent.at(-1);
    assert.deepEqual([request.to, request.body, request.channel, request.connectionId, request.connectorKey], [dana.phone, 'We can be there at 9am Thursday.', 'sms', acme.connection, 'synthetic_oauth']);
    assert.equal(request.idempotencyKey, `send_message:${row.id}`);

    const kinds = (await db.query('select kind from crm_conversation_events where message_id = $1 order by occurred_at, kind', [row.id])).rows.map((r) => r.kind);
    assert.deepEqual([...kinds].sort(), ['queued', 'sending', 'sent']);
    assert.equal(await count('events', 'tenant_id = $1', [acme.id]), evidence, 'a person\'s text is not Lead Recovery evidence: nothing was written to the event log');
  });

  test('a double click is one message: the same key is answered from what exists', async () => {
    const dana = await customer(acme);
    const body = text(dana, 'Confirming Friday at 2.');
    const first = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, body));
    const calls = gateway.sent.length;
    const second = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, body));
    assert.equal(second.outcome, 'replayed');
    assert.equal(second.message.id, first.message.id);
    assert.equal(gateway.sent.length, calls);
    assert.equal(await count('crm_messages', 'client_key = $1', [body.client_key]), 1);
    assert.equal(await count('scheduled_actions', 'idempotency_key = $1', [`send_message:${first.message.id}`]), 1);
  });

  test('an operator sends through the same action table, and is named as the author', async () => {
    const dana = await customer(acme);
    const res = await handleWorkspaceAction('crm-message-send', { deps, actor: op, body: { tenant_id: acme.id, message: text(dana, 'ARC here on behalf of the office.') } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.sent.message.author_type, res.body.sent.message.author_id], ['operator', operator]);
    const run = await one('select created_by_type, created_by from automation_runs where id = $1', [res.body.sent.message.run_id]);
    assert.deepEqual([run.created_by_type, run.created_by], ['operator', operator]);
  });

  test('a bad message is refused field by field, and a credential is never sent', async () => {
    const dana = await customer(acme);
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBhcnQ'].join('.');
    const empty = await comms.sendMessage(deps, acme.ownerActor, acme.id, { contact_id: dana.contact_id, body: '  ' });
    assert.deepEqual(empty.fieldErrors.map((e) => e.field).sort(), ['body', 'client_key']);
    const secret = await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, `here is the token ${jwt}`));
    assert.deepEqual([secret.ok, secret.code], [false, 'invalid']);
    /* and the database refuses it too, for a caller that skipped the service. */
    const raw = await refused(db, `select public.crm_queue_message($1, $2::jsonb, 'client_user', $3)`, [acme.id, JSON.stringify({
      contact_id: dana.contact_id, channel: 'sms', body: `token ${jwt}`, client_key: key('raw'), module_key: LR, connection_id: acme.connection,
    }), acme.owner]);
    assert.match(raw, /arc_crm:invalid/);
    assert.equal(await count('crm_messages', 'contact_id = $1', [dana.contact_id]), 0);
  });

  /* ── do not contact ──────────────────────────────────── */

  test('a customer on the do-not-contact list cannot be messaged, and nothing is written trying', async () => {
    const dana = await customer(acme);
    const listed = ok(await comms.suppressAddress(deps, acme.staffActor, acme.id, { contact_id: dana.contact_id, channel: 'sms', reason: 'opt_out', note: 'asked on the phone' }));
    assert.equal(listed.outcome, 'added');
    const row = await one('select * from suppressions where tenant_id = $1 and address = $2', [acme.id, dana.phone]);
    assert.deepEqual([row.reason, row.source, row.note], ['opt_out', 'client_user', 'asked on the phone']);

    const [messages, runs, actions, calls] = [await count('crm_messages'), await count('automation_runs'), await count('scheduled_actions'), gateway.sent.length];
    const res = await handleWorkspaceAction('crm-message-send', { deps, actor: acme.ownerActor, body: { tenant_id: acme.id, message: text(dana, 'one more thing') } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'do_not_contact');
    assert.deepEqual([await count('crm_messages'), await count('automation_runs'), await count('scheduled_actions'), gateway.sent.length], [messages, runs, actions, calls]);

    /* saying it twice changes nothing, and nothing here takes an address off the list. */
    assert.equal(ok(await comms.suppressAddress(deps, acme.ownerActor, acme.id, { contact_id: dana.contact_id, channel: 'sms' })).outcome, 'already');
    assert.ok(!WORKSPACE_ACTIONS.some((a) => /unsuppress|allow-contact|contact-again/.test(a)));
  });

  test('a STOP that arrives after a message was queued stops it — at once, and again at the send', async () => {
    const dana = await customer(acme);
    const queued = ok(await comms.sendMessage(queuedOnly(), acme.ownerActor, acme.id, text(dana, 'your estimate is ready')));
    assert.equal(queued.message.status, 'queued');
    assert.equal((await action(queued.message.action_id)).status, 'pending');

    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'unsubscribe')));
    const stopped = await message(queued.message.id);
    assert.deepEqual([stopped.status, stopped.status_code], ['blocked', 'do_not_contact']);

    const calls = gateway.sent.length;
    const ran = ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls, 'nothing left for the provider');
    assert.deepEqual(ran.executed.map((r) => [r.outcome, r.action_status]), [['skipped', 'skipped']]);
  });

  test('the list is re-read at the send: an opt-out written by anything else still stops it', async () => {
    const dana = await customer(acme);
    const queued = ok(await comms.sendMessage(queuedOnly(), acme.ownerActor, acme.id, text(dana, 'see you tomorrow')));
    /* Lead Recovery, a carrier report, an operator at another screen — not this module. */
    await db.query(`insert into suppressions (tenant_id, channel, address, reason, source) values ($1, 'sms', $2, 'opt_out', 'customer')`, [acme.id, dana.phone]);
    const calls = gateway.sent.length;
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls);
    const row = await message(queued.message.id);
    assert.deepEqual([row.status, row.status_code], ['blocked', 'do_not_contact']);
    const thread = await threadOf(acme, acme.ownerActor, dana);
    assert.equal(deliveryState(thread.messages.at(-1), thread.actions[row.action_id]).state, 'blocked');
  });

  test('a customer who was asked and said no is not messaged — until they write themselves', async () => {
    const dana = await customer(acme);
    const source = await one(`insert into crm_source_events (tenant_id, source, contact_id) values ($1, 'web_form', $2) returning id`, [acme.id, dana.contact_id]);
    await db.query(`insert into crm_consent_records (tenant_id, source_event_id, contact_id, channel, address, granted, disclosure, captured_at)
      values ($1, $2, $3, 'sms', $4, false, 'Text me about my request.', now() - interval '1 hour')`, [acme.id, source.id, dana.contact_id, dana.phone]);
    const declined = await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'hi'));
    assert.deepEqual([declined.ok, declined.code], [false, 'consent_declined']);
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'actually text is fine, when can you come?')));
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'Thursday at 9.')));
    assert.equal(sent.message.consent_basis, 'inbound_message');
  });

  /* ── takeover and safety ─────────────────────────────── */

  test('while Lead Recovery is still talking to a number, a person must take it over before writing', async () => {
    const dana = await customer(acme);
    const { engine, lead, run } = await recoveryLead(acme, dana.phone);
    assert.ok(['new', 'response_queued', 'awaiting_reply'].includes(run.state), run.state);

    const blocked = await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'jumping in here'));
    assert.deepEqual([blocked.ok, blocked.code], [false, 'automation_active']);
    assert.equal((await threadOf(acme, acme.ownerActor, dana)).compose.block.code, 'automation_active');

    const took = await takeOverLead(engine, { tenantId: acme.id, leadId: lead.id, actor: 'office' });
    assert.equal(took.ok, true, took.outcome);
    const thread = await threadOf(acme, acme.ownerActor, dana);
    assert.equal(thread.compose.can_send, true);
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'This is Sam from the office — I have your request.')));
    assert.equal(sent.message.status, 'sent');
    /* the form's own consent is on Lead Recovery's row, read by reference. */
    assert.equal(sent.message.consent_basis, 'recorded_grant');
  });

  test('a safety flag must be read and confirmed, and one raised after queueing blocks the send', async () => {
    const dana = await customer(acme);
    const { engine, lead } = await recoveryLead(acme, dana.phone);
    await takeOverLead(engine, { tenantId: acme.id, leadId: lead.id, actor: 'office' });
    await db.query(`update leads set safety_flags = '{gas_smell}' where id = $1`, [lead.id]);

    const unread = await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'on our way'));
    assert.deepEqual([unread.ok, unread.code], [false, 'safety_review']);
    assert.match(unread.message, /gas smell/);
    const thread = await threadOf(acme, acme.ownerActor, dana);
    assert.deepEqual([thread.compose.can_send, thread.compose.needs_acknowledgement], [true, ['gas_smell']]);

    const confirmed = ok(await comms.sendMessage(queuedOnly(), acme.ownerActor, acme.id, text(dana, 'Leave the house and call the gas company — we are coming.', { acknowledged_safety: ['gas_smell'] })));
    assert.deepEqual(confirmed.message.safety_acknowledged, ['gas_smell']);

    /* something new was flagged while it waited. the sender never read that. */
    await db.query(`update leads set safety_flags = '{gas_smell,carbon_monoxide}' where id = $1`, [lead.id]);
    const calls = gateway.sent.length;
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls);
    const row = await message(confirmed.message.id);
    assert.deepEqual([row.status, row.status_code], ['blocked', 'safety_review']);
  });

  /* ── unknown outcomes ────────────────────────────────── */

  test('an unknown outcome is never resent: the action is blocked for a person, whatever runs next', async () => {
    const dana = await customer(acme);
    gateway.script.push({ do: 'unknown' });
    const calls = gateway.sent.length;
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'Your tech is Alex.')));
    assert.equal(gateway.sent.length, calls + 1);
    assert.deepEqual([sent.message.status, sent.message.status_code], ['unknown', 'provider_outcome_unknown']);
    const blocked = await action(sent.message.action_id);
    assert.deepEqual([blocked.status, blocked.gate_code], ['blocked', 'ambiguous_outcome']);
    const [attempt] = (await db.query('select status, ambiguous, retryable from automation_action_attempts where action_id = $1', [blocked.id])).rows;
    assert.deepEqual([attempt.status, attempt.ambiguous, attempt.retryable], ['ambiguous', true, false]);

    for (let i = 0; i < 3; i += 1) ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls + 1, 'nothing resent it');
    const thread = await threadOf(acme, acme.ownerActor, dana);
    const state = deliveryState(thread.messages.at(-1), thread.actions[blocked.id]);
    assert.equal(state.state, 'unknown');
    assert.match(state.detail, /will not be sent again/);

    /* settling it is an operator's decision, made after checking with the provider. */
    const asClient = await comms.reconcileMessage(deps, acme.ownerActor, acme.id, { message_id: sent.message.id, resolution: 'effect_absent' });
    assert.deepEqual([asClient.ok, asClient.code], [false, 'forbidden']);
    const settled = ok(await comms.reconcileMessage(deps, op, acme.id, { message_id: sent.message.id, resolution: 'effect_absent' }));
    assert.equal(gateway.sent.length, calls + 2, 'it never left, so it is sent — once');
    assert.equal(settled.message.status, 'sent');
    assert.equal(await count('automation_action_attempts', 'action_id = $1', [blocked.id]), 2, 'a new attempt; the ambiguous one is history');
  });

  test('"it did go" closes an unknown outcome without sending anything', async () => {
    const dana = await customer(acme);
    gateway.script.push({ do: 'unknown' });
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'Invoice attached to the email.')));
    const calls = gateway.sent.length;
    const settled = ok(await comms.reconcileMessage(deps, op, acme.id, { message_id: sent.message.id, resolution: 'effect_happened' }));
    assert.equal(gateway.sent.length, calls);
    assert.deepEqual([settled.message.status, settled.message.status_code], ['sent', 'confirmed_by_operator']);
    assert.equal((await action(sent.message.action_id)).status, 'done');
    assert.equal(await count('admin_actions', `action = 'crm.message.reconciled' and target_id = $1`, [sent.message.id]), 1);
  });

  test('a gateway that breaks in a way nobody planned for is treated as "it may have left"', async () => {
    const dana = await customer(acme);
    gateway.script.push({ do: 'explode' });
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'Running late, sorry.')));
    const calls = gateway.sent.length;
    assert.deepEqual([(await action(sent.message.action_id)).status, (await action(sent.message.action_id)).gate_code], ['blocked', 'ambiguous_outcome']);
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls);
    const thread = await threadOf(acme, acme.ownerActor, dana);
    assert.equal(deliveryState(thread.messages.at(-1), thread.actions[sent.message.action_id]).state, 'unknown');
  });

  test('a refusal that provably sent nothing is a failure; a temporary one waits for its backoff', async () => {
    const dana = await customer(acme);
    gateway.script.push({ do: 'refuse' });
    const refusedSend = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'first')));
    assert.deepEqual([refusedSend.message.status, refusedSend.message.status_code], ['failed', 'provider_refused']);
    assert.equal((await action(refusedSend.message.action_id)).status, 'failed');

    gateway.script.push({ do: 'retry' });
    const later = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'second')));
    assert.deepEqual([later.message.status, later.message.status_code], ['queued', 'rate_limited']);
    const waiting = await action(later.message.action_id);
    assert.equal(waiting.status, 'pending');
    assert.ok(new Date(waiting.run_at) > new Date(), 'due after the backoff, not now');
    const calls = gateway.sent.length;
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls, 'not retried early');
    /* when it is due, the same message goes under the same key. */
    await db.query(`update scheduled_actions set run_at = now() - interval '1 second' where id = $1`, [waiting.id]);
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls + 1);
    assert.equal(gateway.sent.at(-1).idempotencyKey, `send_message:${later.message.id}`);
    assert.equal((await message(later.message.id)).status, 'sent');
  });

  /* ── what there is to send through ───────────────────── */

  test('no connection, no adapter, or a module that is not active: refused before anything is written', async () => {
    const t = await tenant(db, operator);
    await t.underTest();
    const c = await client_(t, { connected: false });
    const dana = await customer(c);
    const rows = async () => [await count('crm_messages', 'tenant_id = $1', [c.id]), await count('automation_runs', `tenant_id = $1 and run_kind = 'crm_message'`, [c.id])];

    const none = await comms.sendMessage(deps, c.ownerActor, c.id, text(dana, 'hello'));
    assert.deepEqual([none.ok, none.code], [false, 'no_channel']);
    assert.match(none.message, /no text provider is connected/);

    c.connection = await connect(c.id);
    const testing = await comms.sendMessage(deps, c.ownerActor, c.id, text(dana, 'hello'));
    assert.deepEqual([testing.ok, testing.code], [false, 'module_not_ready']);
    assert.match(testing.message, /lead recovery is testing/);
    assert.equal((await threadOf(c, c.ownerActor, dana)).compose.block.code, 'module_not_ready');

    const noAdapter = await comms.sendMessage({ ...deps, sending: { ...deps.sending, gateway: { serves: () => false, send: gateway.send } } }, c.ownerActor, c.id, text(dana, 'hello'));
    assert.deepEqual([noAdapter.ok, noAdapter.code], [false, 'no_channel']);
    assert.match(noAdapter.message, /cannot send text through it yet/);

    const email = await comms.sendMessage(deps, c.ownerActor, c.id, { ...text(dana, 'hello'), channel: 'email' });
    assert.deepEqual([email.ok, email.code], [false, 'no_channel']);
    const readOnly = await comms.sendMessage({ ...deps, sending: null }, c.ownerActor, c.id, text(dana, 'hello'));
    assert.deepEqual([readOnly.ok, readOnly.code], [false, 'no_channel']);
    assert.deepEqual(await rows(), [0, 0]);

    /* and the database holds the line for a caller that skipped the route: 0015 refuses the run. */
    const snapshot = await t.snapshot();
    const raw = await refused(db, `select public.crm_queue_message($1, $2::jsonb, 'client_user', $3)`, [c.id, JSON.stringify({
      contact_id: dana.contact_id, channel: 'sms', body: 'hello', client_key: key('raw'), module_key: LR, config_snapshot_id: snapshot, connection_id: c.connection,
    }), c.owner]);
    assert.match(raw, /arc_crm:module_not_ready/);
    assert.deepEqual(await rows(), [0, 0]);
  });

  test('a module paused after a message was queued holds it — visibly — and a person can call it back', async () => {
    const t = await tenant(db, operator);
    await t.live();
    const c = await client_(t);
    const dana = await customer(c);
    const first = ok(await comms.sendMessage(queuedOnly(), c.ownerActor, c.id, text(dana, 'held one')));
    const second = ok(await comms.sendMessage(queuedOnly(), c.ownerActor, c.id, text(dana, 'held two')));
    await t.pause();

    const calls = gateway.sent.length;
    ok(await comms.flushQueue(deps, c.ownerActor, c.id));
    assert.equal(gateway.sent.length, calls, 'a paused module sends nothing');
    let thread = await threadOf(c, c.ownerActor, dana);
    const held = deliveryState(thread.messages[0], thread.actions[first.message.action_id]);
    assert.deepEqual([held.state, held.code], ['held', 'module_paused']);
    assert.equal(thread.compose.block.code, 'module_not_ready');

    const cancelled = ok(await comms.cancelMessage(deps, c.staffActor, c.id, first.message.id));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await one('select status from automation_runs where id = $1', [first.message.run_id])).status, 'cancelled');
    assert.equal((await action(first.message.action_id)).status, 'cancelled');

    await t.resume();
    ok(await comms.flushQueue(deps, c.ownerActor, c.id));
    assert.equal(gateway.sent.length, calls + 1, 'resumed: what was held goes, what was cancelled does not');
    assert.equal(gateway.sent.at(-1).body, 'held two');
    assert.equal((await message(second.message.id)).status, 'sent');
    thread = await threadOf(c, c.ownerActor, dana);
    assert.deepEqual(threadEntries(thread).map((e) => e.delivery.state), ['cancelled', 'sent']);
    const sentAlready = await comms.cancelMessage(deps, c.ownerActor, c.id, second.message.id);
    assert.deepEqual([sentAlready.ok, sentAlready.code], [false, 'conflict']);
  });

  /* ── delivery evidence ───────────────────────────────── */

  test('delivered and read are what the provider said, kept every time and applied forward only', async () => {
    const dana = await customer(acme);
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'On the way.')));
    const report = (state, extra = {}) => comms.recordDelivery(deps, SYSTEM, acme.id, { connector_key: 'synthetic_oauth', external_id: sent.message.external_id, state, ...extra });

    assert.equal(ok(await report('delivered', { event_id: 'evt-1' })).status, 'delivered');
    assert.equal(ok(await report('delivered', { event_id: 'evt-1' })).outcome, 'duplicate');
    assert.equal(ok(await report('read', { event_id: 'evt-2' })).status, 'read');
    /* out of order: a late "delivered", and a "failed" for something already read. */
    assert.equal(ok(await report('delivered', { event_id: 'evt-3' })).status, 'read');
    assert.equal(ok(await report('failed', { event_id: 'evt-4', code: 'carrier_violation' })).status, 'read');
    const row = await message(sent.message.id);
    assert.ok(row.delivered_at && row.read_at && !row.failed_at);
    assert.equal(await count('crm_conversation_events', `message_id = $1 and actor_type = 'provider'`, [row.id]), 4);

    assert.equal(ok(await comms.recordDelivery(deps, SYSTEM, acme.id, { connector_key: 'synthetic_oauth', external_id: 'SM-not-ours', state: 'delivered' })).outcome, 'unknown_message');
    /* another client reporting our message id reaches nothing. */
    assert.equal(ok(await comms.recordDelivery(deps, SYSTEM, other.id, { connector_key: 'synthetic_oauth', external_id: sent.message.external_id, state: 'failed' })).outcome, 'unknown_message');
    const person = await comms.recordDelivery(deps, op, acme.id, { connector_key: 'synthetic_oauth', external_id: sent.message.external_id, state: 'failed' });
    assert.deepEqual([person.ok, person.code], [false, 'forbidden']);
  });

  test('a carrier that reports the message failed, and that the customer opted out, does both', async () => {
    const dana = await customer(acme);
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'Reminder: tomorrow 9am.')));
    const report = ok(await comms.recordDelivery(deps, SYSTEM, acme.id, { connector_key: 'synthetic_oauth', external_id: sent.message.external_id, state: 'failed', code: 'recipient_opted_out', opted_out: true }));
    assert.equal(report.status, 'failed');
    const row = await one('select reason, source from suppressions where tenant_id = $1 and address = $2', [acme.id, dana.phone]);
    assert.deepEqual([row.reason, row.source], ['opt_out', 'provider']);
    assert.equal((await threadOf(acme, acme.ownerActor, dana)).compose.block.code, 'do_not_contact');
  });

  /* ── the timeline ────────────────────────────────────── */

  test('one timeline: the customer, a person, their own system and Lead Recovery\'s texts — each attributed', async () => {
    const dana = await customer(acme);
    const { engine, lead } = await recoveryLead(acme, dana.phone);
    /* what the engine itself recorded with this number: its own table, not ours. */
    const conversation = await engine.store.getOrCreateConversation(acme.id, lead.id);
    await engine.store.insertMessage({ tenantId: acme.id, conversationId: conversation.id, direction: 'outbound', providerMessageId: key('SMLR'), body: 'Sorry we missed you — how can we help?', status: 'delivered', errorClass: null, errorDetail: null, occurredAt: new Date(Date.now() - 60_000).toISOString() });
    await takeOverLead(engine, { tenantId: acme.id, leadId: lead.id, actor: 'office' });

    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'My furnace is out.')));
    ok(await comms.sendMessage(deps, acme.staffActor, acme.id, text(dana, 'We can come at 4.')));
    const thread = await threadOf(acme, acme.ownerActor, dana);
    const entries = threadEntries(thread);
    assert.deepEqual(entries.map((e) => [e.source, e.speaker, e.direction, e.delivery.state]), [
      ['lead_recovery', 'automation', 'outbound', 'delivered'],
      ['crm', 'customer', 'inbound', 'received'],
      ['crm', 'person', 'outbound', 'sent'],
    ]);
    assert.equal(entries[2].author_id, acme.staff);
    assert.equal(await count('crm_messages', 'tenant_id = $1 and body = $2', [acme.id, 'Sorry we missed you — how can we help?']), 0, 'read by reference, never copied');
  });

  test('an internal note stays inside: it is not a message, queues nothing, and is not on the thread', async () => {
    const dana = await customer(acme);
    const [messages, actions, calls] = [await count('crm_messages'), await count('scheduled_actions'), gateway.sent.length];
    ok(await crm.addNote(deps.crm, acme.staffActor, acme.id, { lead_id: dana.lead_id, body: 'Customer was rude on the phone — send two techs.' }));
    assert.deepEqual([await count('crm_messages'), await count('scheduled_actions'), gateway.sent.length], [messages, actions, calls]);
    ok(await comms.flushQueue(deps, acme.ownerActor, acme.id));
    assert.equal(gateway.sent.length, calls);
    const thread = await threadOf(acme, acme.ownerActor, dana);
    assert.doesNotMatch(JSON.stringify(thread), /two techs/);
    assert.deepEqual(threadEntries(thread), []);
  });

  test('conversations are isolated: another client\'s user is refused, and the database shows each their own', async () => {
    const dana = await customer(acme);
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'private to acme')));

    const stranger = await comms.getThread(deps, other.ownerActor, acme.id, { contact_id: dana.contact_id });
    assert.deepEqual([stranger.ok, stranger.code], [false, 'forbidden']);
    /* an operator naming the wrong client for a real customer finds nothing. */
    const crossed = await comms.getThread(deps, op, other.id, { contact_id: dana.contact_id });
    assert.deepEqual([crossed.ok, crossed.code], [false, 'not_found']);
    const send = await comms.sendMessage(deps, other.ownerActor, other.id, text(dana, 'hello from the wrong client'));
    assert.deepEqual([send.ok, send.code], [false, 'not_found']);
    assert.ok(ok(await comms.listConversations(deps, other.ownerActor, other.id)).conversations.every((c) => c.conversation.tenant_id === other.id));

    for (const table of ['crm_conversations', 'crm_messages', 'crm_conversation_events']) {
      const mine = await asRole(db, { role: 'authenticated', sub: acme.owner }, async (tx) => (await tx.query(`select tenant_id from public.${table}`)).rows);
      assert.ok(mine.length > 0 && mine.every((r) => r.tenant_id === acme.id), `${table}: a member reads their own client only`);
      const theirs = await asRole(db, { role: 'authenticated', sub: other.owner }, async (tx) => (await tx.query(`select tenant_id from public.${table} where tenant_id = $1`, [acme.id])).rows);
      assert.equal(theirs.length, 0, `${table}: another client's member reads none of it`);
      const anon = await refused(db, `set local role anon; select * from public.${table}`).catch(() => 'refused');
      assert.ok(anon);
    }
  });

  test('a browser role writes nothing here, whoever it is', async () => {
    const dana = await customer(acme);
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'hi')));
    for (const sql of [
      `update public.crm_messages set body = 'rewritten' where id = '${arrival.message_id}'`,
      `insert into public.crm_snippets (tenant_id, key, name, body, updated_by_type, updated_by) values ('${acme.id}', 'x_one', 'X', 'hi', 'client_user', '${acme.owner}')`,
      `select public.crm_queue_message('${acme.id}', '{}'::jsonb, 'client_user', '${acme.owner}')`,
      `select public.crm_message_arrival('${acme.id}', '{}'::jsonb)`,
      `select * from public.crm_message_gate('${acme.id}', 'sms', '${dana.phone}')`,
    ]) {
      await assert.rejects(asRole(db, { role: 'authenticated', sub: acme.owner }, (tx) => tx.query(sql)), /permission denied/, sql.slice(0, 60));
    }
  });

  test('what is stored is never rewritten: a message keeps its words, an event keeps everything', async () => {
    const dana = await customer(acme);
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'original words')));
    assert.match(await refused(db, `update crm_messages set body = 'other words' where id = $1`, [arrival.message_id]), /arc_crm:immutable/);
    assert.match(await refused(db, `update crm_messages set status = 'sent' where id = $1`, [arrival.message_id]), /check|immutable/i);
    assert.match(await refused(db, `delete from crm_messages where id = $1`, [arrival.message_id]), /arc_crm:immutable/);
    assert.match(await refused(db, `update crm_conversation_events set kind = 'sent' where message_id = $1`, [arrival.message_id]), /arc_crm:immutable/);
    assert.match(await refused(db, `update crm_conversations set address = '+16145550000' where id = $1`, [arrival.conversation_id]), /arc_crm:immutable/);
    const sent = ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'a reply')));
    assert.match(await refused(db, `update crm_messages set status = 'queued' where id = $1`, [sent.message.id]), /does not become queued/);
  });

  test('nothing in what the screen is given is a credential, a vault reference or a connection secret', async () => {
    const dana = await customer(acme);
    ok(await comms.sendMessage(deps, acme.ownerActor, acme.id, text(dana, 'plain words')));
    const view = ok(await comms.getThread(deps, acme.ownerActor, acme.id, { contact_id: dana.contact_id }));
    const inbox = ok(await comms.listConversations(deps, acme.ownerActor, acme.id));
    /* by field name, at any depth: a message's own words may say anything. */
    const names = (value, out = new Set()) => {
      if (Array.isArray(value)) value.forEach((v) => names(v, out));
      else if (value && typeof value === 'object' && !(value instanceof Date)) for (const [k, v] of Object.entries(value)) { out.add(k); names(v, out); }
      return out;
    };
    for (const payload of [view, inbox]) {
      const fields = [...names(payload)];
      assert.ok(fields.length > 10);
      assert.deepEqual(fields.filter((f) => /vault|token|credential|secret|password|authorization|lease|hint/i.test(f)), []);
    }
    assert.equal(view.threads[0].compose.through, 'synthetic_oauth', 'the connector is named; nothing about how it authenticates is');
  });

  /* ── read marks, hand-over, canned replies ───────────── */

  test('unread is the team\'s: it clears when somebody looks, and comes back when the customer writes again', async () => {
    const dana = await customer(acme);
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'first')));
    assert.equal((await threadOf(acme, acme.staffActor, dana)).unread, true);
    const read = ok(await comms.markRead(deps, acme.staffActor, acme.id, arrival.conversation_id));
    assert.equal(read.last_read_by, acme.staff);
    assert.equal((await threadOf(acme, acme.ownerActor, dana)).unread, false);
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'second', { occurred_at: new Date(Date.now() + 5_000).toISOString() })));
    assert.equal((await threadOf(acme, acme.ownerActor, dana)).unread, true);
  });

  test('staff can take a conversation; only the owner or an operator hands it to somebody else', async () => {
    const dana = await customer(acme);
    const arrival = ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'hello')));
    const taken = ok(await comms.assignConversation(deps, acme.staffActor, acme.id, { conversation_id: arrival.conversation_id, assigned_user_id: acme.staff }));
    assert.equal(taken.assigned_user_id, acme.staff);
    const pushed = await comms.assignConversation(deps, acme.staffActor, acme.id, { conversation_id: arrival.conversation_id, assigned_user_id: acme.owner });
    assert.deepEqual([pushed.ok, pushed.code], [false, 'forbidden']);
    const handed = ok(await comms.assignConversation(deps, acme.ownerActor, acme.id, { conversation_id: arrival.conversation_id, assigned_user_id: acme.owner }));
    assert.equal(handed.assigned_user_id, acme.owner);
    const outsider = await comms.assignConversation(deps, acme.ownerActor, acme.id, { conversation_id: arrival.conversation_id, assigned_user_id: other.owner });
    assert.deepEqual([outsider.ok, outsider.code], [false, 'invalid_owner']);
    assert.equal(await count('crm_conversation_events', `conversation_id = $1 and kind = 'assigned'`, [arrival.conversation_id]), 2);
  });

  test('canned replies: the owner writes them, anybody reads them, and only the closed placeholders are allowed', async () => {
    const snippet = { key: 'on_our_way', name: 'On our way', channel: 'sms', body: 'Hi {first_name}, {business_name} is on the way.' };
    const staff = await comms.saveSnippet(deps, acme.staffActor, acme.id, snippet);
    assert.deepEqual([staff.ok, staff.code], [false, 'forbidden']);
    const saved = ok(await comms.saveSnippet(deps, acme.ownerActor, acme.id, snippet));
    assert.equal(saved.updated_by, acme.owner);
    const bad = await comms.saveSnippet(deps, acme.ownerActor, acme.id, { ...snippet, key: 'bad_one', body: 'Your code is {password}' });
    assert.deepEqual(bad.fieldErrors.map((e) => e.field), ['body']);
    assert.deepEqual(ok(await comms.listSnippets(deps, acme.staffActor, acme.id)).map((s) => s.key), ['on_our_way']);
    assert.equal(ok(await comms.listSnippets(deps, other.staffActor, other.id)).length, 0);
    ok(await comms.saveSnippet(deps, op, acme.id, { ...snippet, archived: true }));
    const dana = await customer(acme);
    assert.deepEqual(ok(await comms.getThread(deps, acme.staffActor, acme.id, { contact_id: dana.contact_id })).snippets, []);
  });

  test('a client with conversations is not a test client, and cannot be purged', async () => {
    const dana = await customer(acme);
    ok(await comms.ingestInboundMessage(deps, SYSTEM, acme.id, inbound(dana.phone, 'hello')));
    const slug = (await one('select slug from tenants where id = $1', [acme.id])).slug;
    const message_ = await refused(db, 'select public.purge_test_tenant($1, $2, $3)', [operator, acme.id, slug]);
    assert.match(message_, /customer conversations/);
    assert.match(message_, /customer messages/);
  });
});

/* ARC-370 — the communications hub with no database.
 *
 *   - `communications/model.ts` as plain functions: parsing, where a message has got to,
 *     who said what, and the words the screen has for each;
 *   - `MessageSendRunner` against the ARC-210 runner contract, with a scripted store and
 *     gateway — what it reports for each thing that can happen to a send;
 *   - the channel gateway over ARC-130's real credential path and the synthetic provider;
 *   - the real conversation component rendered to static markup (esbuild, as
 *     tests/crm-workspace.test.js does): what a person is shown, and what is never printed.
 *
 * The same code through real SQL is tests/communications-db.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_CODES, BLOCK_WORDS, CHANNEL_DEFINITIONS, CHANNELS, CONSENT_BASES, CONSENT_WORDS, DELIVERY_STATES, deliveryState, fillSnippet, isBlockCode,
  isUnread, normaliseAddress, parseArrival, parseDeliveryReport, parseOutboundMessage, parseSnippetInput, parseSuppressRequest,
  SNIPPET_PLACEHOLDERS, SUPPRESS_REASONS, SUPPRESS_WORDS, threadEntries, threadTurn, timeOf,
} from '../supabase/functions/_shared/communications/model.ts';
import { ChannelSendError, connectionChannelGateway, PRODUCTION_CHANNEL_ADAPTERS } from '../supabase/functions/_shared/communications/channels.ts';
import { syntheticSmsAdapter } from '../supabase/functions/_shared/communications/synthetic-channel.ts';
import { MESSAGE_SEND_ACTION, MESSAGE_SEND_RUNNER, MessageSendRunner } from '../supabase/functions/_shared/communications/runner.ts';
import { modulesRequiring } from '../supabase/functions/_shared/communications/service.ts';
import { settlementFor, validateRunnerResult } from '../supabase/functions/_shared/runner/model.ts';
import { actionType } from '../supabase/functions/_shared/scheduler/model.ts';
import { getCapability } from '../supabase/functions/_shared/registry/capabilities.ts';
import { CRM_ERROR_STATUS } from '../supabase/functions/_shared/crm/service.ts';
import { glossFor } from '../src/portal/lib/glossary.js';
import { runnerContract } from './runner-contract.js';
import { connectOAuth, OWNER_A, TENANT_A, world } from './connection-fixtures.js';
import { leakedSentinels } from './synthetic-provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const SQL = read('supabase/migrations/0026_crm_communications.sql');

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONTACT = 'cccccccc-0000-4000-8000-000000000001';
const LEAD = 'dddddddd-0000-4000-8000-000000000001';
const ME = 'bbbbbbbb-0000-4000-8000-000000000001';
const fields = (parsed) => parsed.errors.map((e) => e.field).sort();
/* built from parts: a credential-shaped literal in a public repository trips push protection. */
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBhcnQ'].join('.');

/* ── the vocabulary ─────────────────────────────────────── */

describe('channels', () => {
  test('a channel names the contact field it reaches and the registry capability that sends it', () => {
    assert.deepEqual([...CHANNELS], ['sms', 'email']);
    assert.deepEqual([CHANNEL_DEFINITIONS.sms.contactField, CHANNEL_DEFINITIONS.email.contactField], ['phone', 'email']);
    assert.equal(CHANNEL_DEFINITIONS.sms.sendCapability, 'send_sms');
    assert.ok(getCapability('send_sms'), 'a real registry capability, not an invented one');
    /* no adapter sends email, so the channel claims no capability rather than a made-up one. */
    assert.equal(CHANNEL_DEFINITIONS.email.sendCapability, null);
  });

  test('an address has one spelling per channel', () => {
    assert.equal(normaliseAddress('sms', '(614) 555-0137'), '+16145550137');
    assert.equal(normaliseAddress('email', ' Dana@Example.COM '), 'dana@example.com');
    assert.equal(normaliseAddress('sms', 'not a number'), null);
  });

  test('the module a message runs under is read from the registry: one that REQUIRES the capability', () => {
    assert.deepEqual(modulesRequiring('send_sms').map((m) => m.key), ['lead_recovery']);
    assert.deepEqual(modulesRequiring('classify_text'), [], 'optional for a module is not cleared-to-contact');
    assert.doesNotMatch(read('supabase/functions/_shared/communications/service.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /'lead_recovery'/, 'never named in the service');
  });

  test('sending is the scheduler\'s own send_message: an external effect, held while paused, on a verified connection', () => {
    const type = actionType(MESSAGE_SEND_ACTION);
    assert.deepEqual([type.dispatcher, type.effectClass, type.pausedPolicy, type.connectionRequirement], ['scheduler', 'external_effect', 'hold', 'verified']);
    /* 0026 adds no action type: the vocabulary is 0017's, unchanged. */
    assert.doesNotMatch(SQL, /insert into public\.automation_action_types/);
  });
});

describe('a message a person writes', () => {
  const good = { contact_id: CONTACT, lead_id: LEAD, channel: 'sms', body: ' We can be there at 9. ', client_key: 'msg-00000001' };

  test('parses to exactly what will be queued', () => {
    const parsed = parseOutboundMessage(good);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { contact_id: CONTACT, lead_id: LEAD, channel: 'sms', body: 'We can be there at 9.', client_key: 'msg-00000001', snippet_key: null, acknowledged_safety: [] });
    assert.equal(parseOutboundMessage({ ...good, channel: undefined }).value.channel, 'sms');
  });

  test('every problem is said at once, by field', () => {
    assert.deepEqual(fields(parseOutboundMessage({})), ['body', 'client_key', 'contact_id']);
    assert.deepEqual(fields(parseOutboundMessage({ ...good, lead_id: 'x', channel: 'fax', body: 'x'.repeat(1601), client_key: 'short', acknowledged_safety: 'yes' })),
      ['acknowledged_safety', 'body', 'channel', 'client_key', 'lead_id']);
  });

  test('a credential is never sent, however it is dressed', () => {
    for (const body of [`here is the token ${JWT}`, `${'pass'}word=${'hunter2hunter2'}`, `Bearer ${'a1b2c3d4'}${'e5f6g7h8'}`]) {
      assert.deepEqual(fields(parseOutboundMessage({ ...good, body })), ['body'], body.slice(0, 16));
    }
    assert.equal(parseOutboundMessage({ ...good, body: 'The password to the gate is on the invoice we mailed.' }).ok, true, 'a sentence about a password is not one');
  });

  test('acknowledged flags are codes, deduplicated', () => {
    assert.deepEqual(parseOutboundMessage({ ...good, acknowledged_safety: ['gas_smell', 'gas_smell', 'flooding'] }).value.acknowledged_safety, ['gas_smell', 'flooding']);
    assert.deepEqual(fields(parseOutboundMessage({ ...good, acknowledged_safety: ['Gas Smell!'] })), ['acknowledged_safety']);
  });
});

describe('a message that arrives', () => {
  const good = { channel: 'sms', address: '614-555-0137', connector_key: 'synthetic_oauth', external_id: ' SM123 ', body: 'hello' };

  test('lands on the thread for the normalised address, inbound unless it says otherwise', () => {
    const parsed = parseArrival(good);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { channel: 'sms', address: '+16145550137', direction: 'inbound', connector_key: 'synthetic_oauth', external_id: 'SM123', body: 'hello', occurred_at: null, attachments: [] });
    assert.equal(parseArrival({ ...good, occurred_at: '2026-10-05T12:00:00-04:00' }).value.occurred_at, '2026-10-05T16:00:00.000Z');
  });

  test('it must say where it came from and what that side calls it', () => {
    assert.deepEqual(fields(parseArrival({})), ['channel', 'connector_key', 'external_id']);
    assert.deepEqual(fields(parseArrival({ ...good, address: 'nope', direction: 'sideways', occurred_at: 'yesterday' })), ['address', 'direction', 'occurred_at']);
    assert.deepEqual(fields(parseArrival({ ...good, external_id: JWT })), ['external_id']);
  });

  test('an inbound body is never refused for what a customer typed', () => {
    assert.equal(parseArrival({ ...good, body: `my login is ${'pass'}word=${'hunter2hunter2'}` }).ok, true, 'kept; 0026 withholds the body');
    assert.match(SQL, /if not public\.crm_text_is_clean\(v_body\) then\s+v_body := '\[withheld/);
  });

  test('an attachment is a reference to the provider\'s copy — never a link, never a file', () => {
    const ok = parseArrival({ ...good, attachments: [{ kind: 'provider_media', ref: 'ME123abc', content_type: 'image/JPEG' }] });
    assert.deepEqual(ok.value.attachments, [{ kind: 'provider_media', ref: 'ME123abc', content_type: 'image/jpeg' }]);
    for (const bad of [
      [{ kind: 'provider_media', ref: 'https://files.example.com/a.jpg' }],
      [{ kind: 'upload', ref: 'ME1' }],
      [{ kind: 'provider_media', ref: 'ME1', url: 'https://x.example' }],
      [{ kind: 'provider_media', ref: 'ME1', content_type: 'not a type' }],
      Array.from({ length: 11 }, (_, i) => ({ kind: 'provider_media', ref: `ME${i}` })),
      'a string',
    ]) assert.equal(parseArrival({ ...good, attachments: bad }).ok, false, JSON.stringify(bad).slice(0, 60));
    assert.match(SQL, /attachments::text !~\* '\(https\?:\|data:\|file:\)'/, 'and the database refuses a link too');
  });
});

describe('delivery reports, opt-outs and canned replies', () => {
  test('a delivery report names the message and one of three things that happened', () => {
    const parsed = parseDeliveryReport({ connector_key: 'synthetic_oauth', external_id: 'SM1', state: 'delivered' });
    assert.deepEqual(parsed.value, { connector_key: 'synthetic_oauth', external_id: 'SM1', state: 'delivered', event_id: null, occurred_at: null, code: null, opted_out: false });
    assert.deepEqual(fields(parseDeliveryReport({ state: 'bounced', code: 'Not A Code', opted_out: 'yes' })), ['code', 'connector_key', 'external_id', 'opted_out', 'state']);
  });

  test('an opt-out names the customer or the thread, and every reason has words', () => {
    assert.equal(parseSuppressRequest({ contact_id: CONTACT }).value.reason, 'opt_out');
    assert.deepEqual(fields(parseSuppressRequest({ reason: 'felt like it', note: 'x'.repeat(301) })), ['contact_id', 'note', 'reason']);
    assert.deepEqual(fields(parseSuppressRequest({ contact_id: CONTACT, note: JWT })), ['note']);
    for (const reason of SUPPRESS_REASONS) assert.ok(SUPPRESS_WORDS[reason], reason);
  });

  test('a canned reply fills only the closed placeholders, and drops one it cannot fill', () => {
    assert.deepEqual([...SNIPPET_PLACEHOLDERS], ['first_name', 'business_name']);
    assert.equal(fillSnippet('Hi {first_name}, {business_name} is on the way.', { first_name: 'Dana', business_name: 'Acme Heating' }), 'Hi Dana, Acme Heating is on the way.');
    assert.equal(fillSnippet('Hi {first_name}, we are on the way.', { first_name: null }), 'Hi, we are on the way.');
    assert.equal(fillSnippet('Total due: {amount}', {}), 'Total due: {amount}', 'anything else is left as typed');
    const ok = parseSnippetInput({ key: 'on_our_way', name: 'On our way', body: 'Hi {first_name}.' });
    assert.deepEqual(ok.value, { key: 'on_our_way', name: 'On our way', channel: 'any', body: 'Hi {first_name}.', archived: false });
    assert.deepEqual(fields(parseSnippetInput({ key: 'Bad Key', name: '', channel: 'fax', body: 'Your code is {password}' })), ['body', 'channel', 'key', 'name']);
    assert.deepEqual(fields(parseSnippetInput({ key: 'ok_key', name: 'x', body: `token ${JWT}` })), ['body']);
  });
});

/* ── where a message has got to ─────────────────────────── */

describe('delivery state', () => {
  const out = (status, extra = {}) => ({ direction: 'outbound', status, status_code: null, status_detail: null, ...extra });
  const action = (status, extra = {}) => ({ status, gate_code: null, gate_detail: null, last_error: null, ...extra });

  test('a settled message says what its own row says', () => {
    assert.equal(deliveryState({ direction: 'inbound', status: 'received' }).state, 'received');
    for (const status of ['sent', 'delivered', 'read', 'failed', 'blocked', 'cancelled']) {
      assert.equal(deliveryState(out(status), action('pending', { gate_code: 'module_paused' })).state, status, status);
    }
    assert.deepEqual(deliveryState(out('blocked', { status_code: 'do_not_contact', status_detail: 'on the list' })), { state: 'blocked', code: 'do_not_contact', detail: 'on the list' });
  });

  test('where the queue knows more than the message, the queue wins', () => {
    assert.equal(deliveryState(out('queued')).state, 'queued');
    assert.equal(deliveryState(out('queued'), action('pending')).state, 'queued');
    assert.deepEqual(deliveryState(out('queued'), action('pending', { gate_code: 'module_paused', gate_detail: 'the module is paused' })), { state: 'held', code: 'module_paused', detail: 'the module is paused' });
    assert.equal(deliveryState(out('queued'), action('blocked', { gate_code: 'connection_revoked', gate_detail: 'revoked' })).state, 'held');
    assert.equal(deliveryState(out('queued'), action('dead_letter', { gate_code: 'attempts_exhausted' })).code, 'attempts_exhausted');
    assert.equal(deliveryState(out('queued'), action('cancelled')).state, 'cancelled');
    /* the worker vanished after starting: the message still says "sending", the queue says nobody knows. */
    assert.equal(deliveryState(out('sending'), action('blocked', { gate_code: 'ambiguous_outcome' })).state, 'unknown');
    /* an operator settled it in the queue before the message row caught up. */
    assert.equal(deliveryState(out('sending'), action('done')).state, 'sent');
  });

  test('unknown always says the same thing: nobody knows, and it will not be sent again', () => {
    for (const state of [deliveryState(out('unknown', { status_code: 'provider_outcome_unknown' })), deliveryState(out('sending'), action('blocked', { gate_code: 'ambiguous_outcome' }))]) {
      assert.equal(state.state, 'unknown');
      assert.match(state.detail, /does not know whether this was sent/);
      assert.match(state.detail, /will not be sent again unless an operator confirms/);
    }
  });

  test('every state the screen can show has a word in the glossary, keyed apart from a lead\'s states', () => {
    for (const state of DELIVERY_STATES) {
      const entry = glossFor(`msg_${state}`);
      assert.ok(entry, `msg_${state}`);
      assert.equal(entry.label, state, 'the gloss never renames the state');
    }
    assert.match(glossFor('msg_sent').gloss, /not yet proof/);
    assert.match(glossFor('msg_unknown').gloss, /never sent again unless a person confirms/);
    assert.notEqual(glossFor('msg_blocked').gloss, glossFor('blocked').gloss);
    for (const key of ['internal_note', 'unread', 'unmatched_thread', 'consent_basis']) assert.ok(glossFor(key), key);
    assert.match(glossFor('internal_note').gloss, /never sent to the customer/);
  });

  test('every reason a send can be refused has words, a status, and — for the gate\'s — is one 0026 can answer', () => {
    for (const code of BLOCK_CODES) {
      assert.ok(BLOCK_WORDS[code], code);
      assert.ok(isBlockCode(code));
      assert.ok(CRM_ERROR_STATUS[code] >= 400, `${code} has a status`);
    }
    const gate = /create or replace function public\.crm_message_gate[\s\S]*?\$fn\$;/.exec(SQL)[0];
    assert.deepEqual([...gate.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1]), ['do_not_contact', 'consent_declined', 'automation_active', 'safety_review']);
    for (const basis of CONSENT_BASES) assert.ok(CONSENT_WORDS[basis], basis);
    assert.match(CONSENT_WORDS.none_on_file, /make sure they did/);
  });

  test('unread is the customer having written since anybody looked — whatever the driver hands back', () => {
    assert.equal(isUnread({ last_inbound_at: null, last_read_at: null }), false);
    assert.equal(isUnread({ last_inbound_at: '2026-10-05T12:00:00Z', last_read_at: null }), true);
    assert.equal(isUnread({ last_inbound_at: '2026-10-05T12:00:00.500Z', last_read_at: '2026-10-05T12:00:00.100Z' }), true);
    assert.equal(isUnread({ last_inbound_at: new Date('2026-10-05T12:00:00.100Z'), last_read_at: new Date('2026-10-05T12:00:00.500Z') }), false, 'a Date keeps its milliseconds');
    assert.equal(timeOf(new Date(5)), 5);
  });
});

describe('one timeline', () => {
  const message = (id, direction, at, extra = {}) => ({
    id, channel: 'sms', direction, origin: direction === 'inbound' ? 'provider' : 'manual', author_id: direction === 'inbound' ? null : ME,
    body: `body ${id}`, body_withheld: false, occurred_at: at, status: direction === 'inbound' ? 'received' : 'sent', action_id: null, ...extra,
  });
  const thread = {
    messages: [
      message('m2', 'inbound', '2026-10-05T12:02:00Z'),
      message('m3', 'outbound', '2026-10-05T12:03:00Z'),
      message('m5', 'outbound', '2026-10-05T12:05:00Z', { origin: 'external_system', author_id: null }),
      message('m6', 'outbound', '2026-10-05T12:06:00Z', { origin: 'automation', author_id: null }),
      message('m7', 'inbound', '2026-10-05T12:07:00Z'),
    ],
    recovery: [
      { id: 'r1', direction: 'outbound', body: 'Sorry we missed you', status: 'delivered', error_class: null, occurred_at: '2026-10-05T12:01:00Z' },
      { id: 'r4', direction: 'outbound', body: 'Still there?', status: 'undelivered', error_class: 'delivery', occurred_at: '2026-10-05T12:04:00Z' },
    ],
  };

  test('everything said, oldest first, each attributed: the customer, a person, an automation, their own system', () => {
    const entries = threadEntries(thread);
    assert.deepEqual(entries.map((e) => [e.id, e.source, e.speaker]), [
      ['lr:r1', 'lead_recovery', 'automation'],
      ['m2', 'crm', 'customer'],
      ['m3', 'crm', 'person'],
      ['lr:r4', 'lead_recovery', 'automation'],
      ['m5', 'crm', 'their_system'],
      ['m6', 'crm', 'automation'],
      ['m7', 'crm', 'customer'],
    ]);
    assert.equal(entries[2].author_id, ME);
    assert.equal(entries[3].delivery.state, 'failed', 'lead recovery\'s "undelivered" reads as failed');
    assert.ok(entries.every((e) => e.channel === 'sms'));
  });

  test('a reply answers the last thing sent before it, and only that', () => {
    const entries = threadEntries(thread);
    assert.deepEqual(entries.map((e) => (e.answered_at ? e.id : null)).filter(Boolean), ['lr:r1', 'm6']);
    assert.equal(entries[0].answered_at, '2026-10-05T12:02:00.000Z');
  });

  test('whose turn it is comes from who spoke last', () => {
    assert.equal(threadTurn(threadEntries(thread)), 'ours');
    assert.equal(threadTurn(threadEntries({ messages: thread.messages.slice(0, 2) })), 'theirs');
    assert.equal(threadTurn([]), 'nobody');
  });
});

/* ── the runner ─────────────────────────────────────────── */

const MESSAGE = 'eeeeeeee-0000-4000-8000-000000000001';
const CONNECTION = 'ffffffff-0000-4000-8000-000000000001';

function harness({ begin, send } = {}) {
  const calls = { begin: [], finish: [], sent: [] };
  const store = {
    async beginSend(tenantId, messageId, attemptId) {
      calls.begin.push({ tenantId, messageId, attemptId });
      return begin ?? { proceed: true, message_id: messageId, channel: 'sms', address: '+16145550137', body: 'We can be there at 9.', connection_id: CONNECTION, connector_key: 'synthetic_oauth' };
    },
    async finishSend(tenantId, messageId, outcome, detail) {
      calls.finish.push({ outcome, ...detail });
      return { recorded: true, status: outcome };
    },
  };
  const gateway = {
    serves: () => true,
    async send(request) {
      calls.sent.push(request);
      return send ? await send(request) : { providerMessageId: 'SM-provider-1' };
    },
  };
  const runner = new MessageSendRunner({ store, gateway });
  const request = (overrides = {}) => ({
    contractVersion: 1, runnerKind: MESSAGE_SEND_RUNNER, tenantId: T, runId: 'run-1', actionId: 'action-1', attemptId: 'attempt-1', attemptNumber: 1,
    moduleKey: 'lead_recovery', moduleVersion: 1, actionType: MESSAGE_SEND_ACTION, effectClass: 'external_effect', configSnapshotId: 'snapshot-1',
    runMode: 'live', correlationId: MESSAGE, idempotencyKey: `send_message:${MESSAGE}`,
    connection: { connectionId: CONNECTION, connectorKey: 'synthetic_oauth' }, payload: { message_id: MESSAGE },
    issuedAt: '2026-10-05T12:00:00.000Z', deadline: '2026-10-05T12:01:00.000Z', ...overrides,
  });
  const dispatch = async (overrides) => validateRunnerResult(await runner.dispatch(request(overrides), new AbortController().signal));
  return { runner, request, calls, dispatch };
}

runnerContract('MessageSendRunner', () => harness());

describe('the message runner', () => {
  test('re-reads first, sends once, records the provider\'s id — and is handed only references', async () => {
    const h = harness();
    const checked = await h.dispatch();
    assert.equal(checked.ok, true, checked.problem);
    assert.deepEqual([checked.result.status, checked.result.externalRequestId], ['succeeded', 'SM-provider-1']);
    assert.deepEqual(h.calls.begin, [{ tenantId: T, messageId: MESSAGE, attemptId: 'attempt-1' }]);
    assert.deepEqual(h.calls.sent, [{
      tenantId: T, connectionId: CONNECTION, connectorKey: 'synthetic_oauth', channel: 'sms', to: '+16145550137', body: 'We can be there at 9.',
      idempotencyKey: `send_message:${MESSAGE}`, correlationId: MESSAGE,
    }]);
    assert.deepEqual(h.calls.finish, [{ outcome: 'sent', externalId: 'SM-provider-1' }]);
    /* the words and the number came from the re-read, never from the request. */
    assert.doesNotMatch(JSON.stringify(h.request()), /6145550137|We can be there/);
    assert.doesNotMatch(JSON.stringify(checked.result.evidence), /We can be there/, 'evidence is what happened, not what was said');
  });

  test('the gate stopping it is a skip: nothing leaves, and the reason is the result\'s code', async () => {
    for (const code of ['do_not_contact', 'safety_review', 'automation_active', 'already_settled']) {
      const h = harness({ begin: { proceed: false, code, detail: 'because' } });
      const checked = await h.dispatch();
      assert.deepEqual([checked.result.status, checked.result.errorCode], ['skipped', code]);
      assert.equal(h.calls.sent.length, 0);
      assert.equal(h.calls.finish.length, 0);
      assert.deepEqual(settlementFor('external_effect', { kind: 'result', result: checked.result }).outcome, 'skipped');
    }
  });

  test('a provider that provably took nothing is a failure — retryable only when it said to wait', async () => {
    const refusedSend = harness({ send: () => { throw new ChannelSendError('provider_refused', 'no'); } });
    const a = (await refusedSend.dispatch()).result;
    assert.deepEqual([a.status, a.retryable, a.ambiguous, a.errorCode], ['failed', false, false, 'provider_refused']);
    assert.deepEqual(refusedSend.calls.finish.map((f) => f.outcome), ['failed']);

    const limited = harness({ send: () => { throw new ChannelSendError('rate_limited', 'no', { retryable: true }); } });
    const b = (await limited.dispatch()).result;
    assert.deepEqual([b.status, b.retryable, b.ambiguous], ['failed', true, false]);
    assert.deepEqual(limited.calls.finish.map((f) => f.outcome), ['retry']);
    assert.deepEqual(settlementFor('external_effect', { kind: 'result', result: b }), { outcome: 'failed', retryable: true, errorCode: 'rate_limited', message: null });
  });

  test('anything that may have left is ambiguous — and an ambiguous outcome is never retryable', async () => {
    const h = harness({ send: () => { throw new ChannelSendError('provider_outcome_unknown', 'unknown', { retryable: true }); } });
    const result = (await h.dispatch()).result;
    assert.deepEqual([result.status, result.ambiguous, result.retryable], ['failed', true, false]);
    assert.deepEqual(h.calls.finish.map((f) => f.outcome), ['unknown']);
    assert.equal(settlementFor('external_effect', { kind: 'result', result }).outcome, 'ambiguous');
    assert.equal(new ChannelSendError('x', 'unknown', { retryable: true }).retryable, false, 'the error type itself refuses the contradiction');
  });

  test('what it does not understand escapes, and is classified as "an effect was possible"', async () => {
    const broke = harness({ send: () => { throw new TypeError('socket hang up'); } });
    await assert.rejects(broke.runner.dispatch(broke.request(), new AbortController().signal), /socket hang up/);
    assert.equal(broke.calls.finish.length, 0);
    /* the send worked and the record of it failed: the message did leave. */
    const h = harness();
    h.runner.store ??= null;
    const store = { beginSend: async () => ({ proceed: true, message_id: MESSAGE, channel: 'sms', address: '+16145550137', body: 'x', connection_id: CONNECTION, connector_key: 'synthetic_oauth' }), finishSend: async () => { throw new Error('the database went away'); } };
    const runner = new MessageSendRunner({ store, gateway: { serves: () => true, send: async () => ({ providerMessageId: 'SM-2' }) } });
    await assert.rejects(runner.dispatch(h.request(), new AbortController().signal), /database went away/);
    const failure = runner.classifyFailure(new Error('the database went away'));
    assert.equal(failure.effectPossible, true);
    assert.equal(settlementFor('external_effect', { kind: 'threw', failure }).outcome, 'ambiguous');
  });

  test('a request it should never have been handed is refused before anything is read', async () => {
    for (const overrides of [
      { runMode: 'test' },
      { actionType: 'test_connection' },
      { payload: {} },
      { payload: { message_id: 'not-an-id' } },
      { connection: null },
    ]) {
      const h = harness();
      const checked = await h.dispatch(overrides);
      assert.deepEqual([checked.result.status, checked.result.errorCode], ['failed', 'runner_request_refused'], JSON.stringify(overrides));
      assert.equal(h.calls.begin.length, 0);
      assert.equal(h.calls.sent.length, 0);
    }
  });

  test('a message and an action that name different connections send nothing', async () => {
    const h = harness({ begin: { proceed: true, message_id: MESSAGE, channel: 'sms', address: '+16145550137', body: 'x', connection_id: 'ffffffff-0000-4000-8000-00000000dead', connector_key: 'synthetic_oauth' } });
    const result = (await h.dispatch()).result;
    assert.deepEqual([result.status, result.errorCode, result.retryable], ['failed', 'connection_mismatch', false]);
    assert.equal(h.calls.sent.length, 0);
  });

  test('it executes one action type, live only, and holds no credential', () => {
    const { runner } = harness();
    assert.deepEqual(runner.describeCapabilities(), { actionTypes: ['send_message'], runModes: ['live'] });
    const source = read('supabase/functions/_shared/communications/runner.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, /withProviderCredential|SecretValue|reveal\(|vault/i, 'the gateway resolves a credential; the runner never sees one');
  });
});

/* ── the channel gateway ────────────────────────────────── */

describe('the channel gateway', () => {
  /** the synthetic provider, with a /messages endpoint this suite owns. */
  async function setup({ messages } = {}) {
    const w = await world();
    const { done } = await connectOAuth(w, { capabilities: ['send_sms', 'receive_sms'] });
    const posted = [];
    const inner = w.deps.transport;
    w.deps.transport = async (request) => {
      if (!request.url.endsWith('/messages')) return await inner(request);
      posted.push(request);
      return messages ? await messages(request) : { status: 200, body: { id: `SM${posted.length}` } };
    };
    const gateway = connectionChannelGateway(w.deps, [syntheticSmsAdapter('test')]);
    const send = (extra = {}) => gateway.send({
      tenantId: TENANT_A, connectionId: done.connection.id, connectorKey: 'synthetic_oauth', channel: 'sms', to: '+16145550137', body: 'On our way.',
      idempotencyKey: 'send_message:abc', correlationId: 'corr-1', ...extra,
    });
    return { w, gateway, send, posted, connectionId: done.connection.id };
  }

  test('a send goes through ARC-130\'s credential path to the provider\'s registered host, and returns only the provider\'s id', async () => {
    const { w, send, posted, gateway } = await setup();
    assert.equal(gateway.serves('synthetic_oauth', 'sms'), true);
    const sent = await send();
    assert.deepEqual(sent, { providerMessageId: 'SM1' });
    assert.equal(posted.length, 1);
    assert.equal(new URL(posted[0].url).host, 'synthetic-oauth.invalid');
    assert.deepEqual(posted[0].form, { to: '+16145550137', body: 'On our way.' });
    assert.equal(posted[0].headers['Idempotency-Key'], 'send_message:abc');
    assert.match(posted[0].headers.Authorization, /^Bearer SENTINEL-/, 'the provider was given the access token');
    assert.deepEqual(leakedSentinels(JSON.stringify(sent), w.provider), [], 'and none of it came back');
  });

  test('a failure before the credential was handed over cannot have sent anything', async () => {
    const { send, posted, w } = await setup();
    const unknownConnection = await send({ connectionId: 'ffffffff-0000-4000-8000-00000000dead' }).catch((e) => e);
    assert.ok(unknownConnection instanceof ChannelSendError);
    assert.equal(unknownConnection.left, 'no');
    const otherTenant = await send({ tenantId: '22222222-2222-4222-8222-222222222222' }).catch((e) => e);
    assert.equal(otherTenant.left, 'no', 'another client\'s request reaches no credential');
    assert.equal(posted.length, 0);
    assert.deepEqual(leakedSentinels(`${unknownConnection.message} ${otherTenant.message}`, w.provider), []);
  });

  test('the provider\'s answer decides: a clear refusal is "no", a wait is retryable, silence is unknown', async () => {
    const cases = [
      [() => ({ status: 422, body: { error: 'bad number' } }), ['provider_refused', 'no', false]],
      [() => ({ status: 429, body: null }), ['rate_limited', 'no', true]],
      [() => ({ status: 401, body: null }), ['reauthorization_required', 'no', false]],
      [() => ({ status: 503, body: null }), ['provider_outcome_unknown', 'unknown', false]],
      [() => ({ status: 200, body: { accepted: true } }), ['provider_outcome_unknown', 'unknown', false]],
      [() => { throw new Error('ECONNRESET'); }, ['provider_outcome_unknown', 'unknown', false]],
    ];
    for (const [messages, expected] of cases) {
      const { send } = await setup({ messages });
      const error = await send().catch((e) => e);
      assert.ok(error instanceof ChannelSendError, String(error));
      assert.deepEqual([error.code, error.left, error.retryable], expected);
      assert.doesNotMatch(error.message, /bad number|ECONNRESET/, 'the provider\'s own words go no further');
    }
  });

  test('no adapter, no send: production registers none, and the synthetic one refuses production', async () => {
    assert.deepEqual([...PRODUCTION_CHANNEL_ADAPTERS], [], 'no real messaging provider is connected by a client yet');
    const { w, connectionId, posted } = await setup();
    const production = connectionChannelGateway(w.deps, PRODUCTION_CHANNEL_ADAPTERS);
    assert.equal(production.serves('synthetic_oauth', 'sms'), false);
    assert.equal(production.serves('twilio', 'sms'), false, 'ARC\'s own Twilio is not a client connection, and is not sent through here');
    const error = await production.send({ tenantId: TENANT_A, connectionId, connectorKey: 'synthetic_oauth', channel: 'sms', to: '+16145550137', body: 'x', idempotencyKey: 'k', correlationId: 'c' }).catch((e) => e);
    assert.deepEqual([error.code, error.left], ['channel_adapter_missing', 'no']);
    assert.equal(posted.length, 0);
    for (const environment of ['production', 'staging']) assert.throws(() => syntheticSmsAdapter(environment), /is a test double and may not run in/, environment);
    assert.doesNotMatch(read('supabase/functions/_shared/communications/wiring.ts'), /synthetic/, 'nothing a deployed function imports reaches the test adapter');
    assert.equal(OWNER_A.length, 36);
  });
});

/* ── the screen ─────────────────────────────────────────── */

async function loadComponents() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement as h } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import Conversation, { Conversations } from './src/portal/components/CrmConversation.jsx';",
        "import CrmWorkspace from './src/portal/components/CrmWorkspace.jsx';",
        "import { demoCrmApi } from './src/portal/demo/crm-demo.js';",
        'const C = { Conversation, Conversations, CrmWorkspace };',
        'export const render = (name, props) => renderToStaticMarkup(h(C[name], props));',
        'export { demoCrmApi };',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.svg': 'empty' },
    define: { 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '""' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-conversation-'));
  const file = path.join(dir, 'components.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const THEM = 'bbbbbbbb-0000-4000-8000-000000000002';
const row = (id, direction, at, extra = {}) => ({
  id, tenant_id: T, channel: 'sms', address: '+16145550137', direction, origin: direction === 'inbound' ? 'provider' : 'manual',
  author_type: direction === 'inbound' ? 'customer' : 'client_user', author_id: direction === 'inbound' ? null : ME, body: `words of ${id}`, body_withheld: false,
  status: direction === 'inbound' ? 'received' : 'sent', status_code: null, status_detail: null, consent_basis: direction === 'inbound' ? null : 'recorded_grant',
  attachments: [], action_id: null, connector_key: 'synthetic_oauth', occurred_at: at, ...extra,
});

function view(overrides = {}, thread = {}) {
  return {
    contact: { id: CONTACT, display_name: 'Dana Reyes', first_name: 'Dana', phone: '+16145550137', email: null },
    threads: [{
      channel: 'sms', address: '+16145550137',
      conversation: { id: 'conv-1', channel: 'sms', address: '+16145550137', last_inbound_at: '2026-10-05T12:02:00Z', last_read_at: null },
      unread: true, shared_by: 1,
      messages: [
        row('m2', 'inbound', '2026-10-05T12:02:00Z'),
        row('m3', 'outbound', '2026-10-05T12:03:00Z', { status: 'delivered' }),
        row('m4', 'outbound', '2026-10-05T12:04:00Z', { status: 'blocked', status_code: 'do_not_contact', status_detail: 'the address was put on the do-not-contact list before this was sent', author_id: THEM }),
        row('m5', 'outbound', '2026-10-05T12:05:00Z', { status: 'unknown', status_code: 'provider_outcome_unknown' }),
        row('m6', 'outbound', '2026-10-05T12:06:00Z', { status: 'queued', action_id: 'a6' }),
      ],
      actions: { a6: { id: 'a6', status: 'pending', gate_code: 'module_paused', gate_detail: 'the module is paused' } },
      recovery: [{ id: 'r1', direction: 'outbound', body: 'Sorry we missed your call.', status: 'delivered', error_class: null, occurred_at: '2026-10-05T12:01:00Z' }],
      do_not_contact: null,
      compose: { can_send: true, block: null, needs_acknowledgement: [], consent_basis: 'recorded_grant', through: 'synthetic_oauth' },
      truncated: false,
      ...thread,
    }],
    snippets: [{ key: 'on_our_way', name: 'On our way', channel: 'sms', body: 'Hi {first_name}.' }],
    people: [{ user_id: ME, label: 'me@acme.example — you', role: 'owner', assignable: true }, { user_id: THEM, label: 'them@acme.example', role: 'staff', assignable: true }],
    viewer: { kind: 'client_user', user_id: ME, may: { send: true, suppress: true, assign: true, reconcile: false, snippets: true } },
    read_at: '2026-10-05T12:10:00Z',
    ...overrides,
  };
}

describe('the conversation on screen', async () => {
  const ui = await loadComponents();
  const api = { door: 'crm', readOnly: false };
  const draw = (initial, props = {}) => ui.render('Conversation', { api, by: { contact_id: CONTACT }, timezone: 'America/New_York', initial, ...props });

  test('loading says so, and a deployment without conversations says that — not an error', () => {
    assert.match(ui.render('Conversation', { api, by: { contact_id: CONTACT }, timezone: 'UTC' }), /reading the conversation…/);
    assert.match(read('src/portal/components/CrmConversation.jsx'), /conversations are not switched on here yet\. nothing is wrong with this record\./);
  });

  test('every message shows who said it, on which channel, when, and where it has got to', () => {
    const html = draw(view());
    /* in order, each attributed. */
    const order = ['Sorry we missed your call.', 'words of m2', 'words of m3', 'words of m4', 'words of m5', 'words of m6'].map((s) => html.indexOf(s));
    assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), 'oldest first');
    assert.match(html, /lead recovery, automatically/);
    assert.match(html, /<b>Dana Reyes<\/b>/);
    assert.match(html, /<b>me@acme\.example — you<\/b>/);
    assert.match(html, /<b>them@acme\.example<\/b>/);
    assert.match(html, /to the customer by text · Oct 5, 8:03 AM/, 'in the business\'s own time');
    assert.match(html, /to us by text/);
    for (const state of ['received', 'delivered', 'blocked', 'unknown', 'held']) assert.match(html, new RegExp(`role="tooltip"[^>]*>[^<]*</span></span>|>${state}<`), state);
    for (const state of ['received', 'delivered', 'blocked', 'unknown', 'held']) assert.ok(html.includes(`>${state}<span class="ws-term__tip"`), `${state} carries its gloss`);
    assert.match(html, /crm-msg--auto/, 'an automated message is marked as one');
  });

  test('a blocked message says why, an unknown one says it will not be resent, a held one says what it waits on', () => {
    const html = draw(view());
    assert.match(html, /the address was put on the do-not-contact list before this was sent/);
    assert.match(html, /ARC does not know whether this was sent\. It will not be sent again unless an operator confirms it never left\./);
    assert.match(html, /the module is paused/);
    assert.match(html, /answered Oct 5, 8:02 AM/, 'lead recovery\'s text was answered');
    assert.match(html, /send what is waiting/);
    assert.match(html, /cancel it/);
  });

  test('an unknown outcome is reconciled by an operator only; a client is told nothing is needed from them', () => {
    const client = draw(view());
    assert.doesNotMatch(client, /it never left<\/button>|it was sent<\/button>/);
    assert.match(client, /ARC is checking with the provider/);
    const operator = draw(view({ viewer: { kind: 'operator', user_id: ME, may: { send: true, suppress: true, assign: true, reconcile: true, snippets: true } } }));
    assert.match(operator, /it was sent<\/button>/);
    assert.match(operator, /it never left<\/button>/);
    assert.match(operator, /if it did leave, the customer gets it twice/, 'what the button does is on the page before it is pressed');
  });

  test('writing: the box, the consent on file, what pressing send does — and a canned reply only as a starting point', () => {
    const html = draw(view());
    assert.match(html, /write a text to \(614\) 555-0137/);
    assert.match(html, /this customer agreed to be contacted this way, and that is on file/);
    assert.match(html, /the do-not-contact list is checked again the moment this is sent/);
    assert.match(html, /sends this to \(614\) 555-0137 through synthetic_oauth\. a sent message cannot be taken back\./);
    assert.match(html, /start from a canned reply/);
    assert.match(html, /read it and change it before sending/);
    assert.match(draw(view({}, { compose: { can_send: true, block: null, needs_acknowledgement: [], consent_basis: 'none_on_file', through: 'synthetic_oauth' } })), /nothing on file says this customer asked to be contacted this way — make sure they did/);
  });

  test('a safety flag has to be ticked as read before send is available', () => {
    const html = draw(view({}, { compose: { can_send: true, block: null, needs_acknowledgement: ['gas_smell'], consent_basis: 'recorded_grant', through: 'synthetic_oauth' } }));
    assert.match(html, /i have read the flag: <b>gas smell<\/b>/);
    assert.match(html, /read each one before writing to this customer/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>(<svg[\s\S]*?<\/svg>)?send<\/button>/, 'send is off until it is');
  });

  test('when nothing can be sent, the reason is on the page instead of the box — in the server\'s words', () => {
    for (const [code, detail] of [
      ['do_not_contact', 'this address is on the do-not-contact list (opt out)'],
      ['automation_active', 'lead recovery is still handling this conversation — take it over there before writing to this customer'],
      ['no_channel', 'no text provider is connected for this client'],
      ['module_not_ready', 'lead recovery is paused — a message is sent only while a module cleared to contact customers is active'],
      ['consent_declined', 'this customer was asked and did not agree to be contacted this way'],
    ]) {
      const html = draw(view({}, { compose: { can_send: false, block: { code, detail }, needs_acknowledgement: [], consent_basis: 'none_on_file', through: null } }));
      assert.match(html, /a text cannot be sent from here right now/, code);
      assert.ok(html.includes(detail.replace(/—/g, '—')), `${code}: the server's sentence`);
      assert.ok(html.includes(BLOCK_WORDS[code]), `${code}: the plain reason`);
      assert.doesNotMatch(html, /write a text to/, `${code}: no box to type into`);
    }
  });

  test('do not contact: shown on the thread, offered to anybody on the team, and says it cannot be undone from here', () => {
    const listed = draw(view({}, { do_not_contact: { reason: 'opt_out', since: '2026-10-05T12:00:00Z' }, compose: { can_send: false, block: { code: 'do_not_contact', detail: 'on the list' }, needs_acknowledgement: [], consent_basis: 'none_on_file', through: null } }));
    assert.match(listed, /do not contact<span class="ws-term__tip"/);
    assert.match(listed, /opt out/);
    assert.doesNotMatch(listed, /it cannot be taken off the list from here/, 'already listed: nothing to offer');
    const staff = draw(view({ viewer: { kind: 'client_user', user_id: THEM, may: { send: true, suppress: true, assign: false, reconcile: false, snippets: false } } }));
    assert.match(staff, /nothing is sent to it again, by a person or automatically, and anything waiting to go is stopped\. it cannot be taken off the list from here\./);
    assert.match(staff, /they asked us to stop/);
  });

  test('read-only shows the conversation and offers nothing: no box, no buttons, no opt-out', () => {
    for (const html of [draw(view(), { readOnly: true }), ui.render('Conversation', { api: { ...api, readOnly: true }, by: { contact_id: CONTACT }, timezone: 'UTC', initial: view() })]) {
      assert.match(html, /words of m3/);
      assert.doesNotMatch(html, /<textarea|<button|<select/);
    }
    const reader = draw(view({ viewer: { kind: 'client_user', user_id: ME, may: { send: false, suppress: false, assign: false, reconcile: false, snippets: false } } }, { compose: { can_send: false, block: { code: 'forbidden', detail: 'you can read this conversation but not write to it' }, needs_acknowledgement: [], consent_basis: null, through: null } }));
    assert.doesNotMatch(reader, /<textarea|cannot be sent from here/);
  });

  test('a shared address, an unread thread and a customer with no address each say so', () => {
    assert.match(draw(view({}, { shared_by: 2 })), /2 customers on file share this address, and each of them shows this conversation/);
    assert.match(draw(view()), /unread<span class="ws-term__tip"/);
    assert.match(draw(view()), /the customer wrote last|we wrote last/);
    assert.match(draw(view({ threads: [] })), /no phone number or email on file, so there is nothing to show and nowhere to write to/);
    const unmatched = ui.render('Conversation', { api, by: { conversation_id: 'conv-1' }, timezone: 'UTC', initial: view({ contact: null }) });
    assert.match(unmatched, /nobody on file<span class="ws-term__tip"/);
    assert.doesNotMatch(unmatched, /<textarea/, 'nobody to write to until a customer holds this address');
    assert.match(unmatched, /do not contact/, 'but a stranger who says STOP can still be listed');
  });

  test('a withheld body and a provider attachment are shown as what they are, never as content', () => {
    const html = draw(view({}, { messages: [row('m9', 'inbound', '2026-10-05T12:09:00Z', { body: '[withheld: this message looked like it carried a credential]', body_withheld: true, attachments: [{ kind: 'provider_media', ref: 'ME123', content_type: 'image/jpeg' }] })], recovery: [] }));
    assert.match(html, /\[withheld: this message looked like it carried a credential\]/);
    assert.match(html, /1 attachment — kept by the provider, not shown here/);
    assert.doesNotMatch(html, /ME123|<img|href=/);
  });

  test('nothing secret-shaped can be printed: the screen has no field for one, and names a connector only by its key', () => {
    const source = read('src/portal/components/CrmConversation.jsx');
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /token|secret|password|credential|vault|api_?key|authorization|connection_id|external_id|evidence/i);
    const html = draw(view());
    assert.doesNotMatch(html, /token|secret|vault|bearer/i);
    assert.equal((html.match(/synthetic_oauth/g) ?? []).length, 1, 'the connector is named once, where the send button says what it does');
  });

  test('notes are a separate, labelled section in both records, and say they are never sent', () => {
    const record = read('src/portal/components/CrmRecord.jsx');
    assert.equal((record.match(/<h4><Term k="internal_note">internal notes<\/Term><\/h4>/g) ?? []).length, 2);
    assert.match(record, /a note stays inside ARC and is never sent to the customer/);
    assert.match(record, /every message here is one the customer saw/);
    assert.doesNotMatch(read('src/portal/components/CrmConversation.jsx'), /addNote|crm-note/, 'the conversation component has no way to write a note, and a note no way into it');
  });

  test('the workspace lists conversations under their own tab: unread first, and the ones nobody is on file for', () => {
    assert.match(read('src/portal/components/CrmWorkspace.jsx'), /\['conversations', 'conversations'\]/);
    assert.match(ui.render('Conversations', { api: { ...api, conversations: async () => ({ conversations: [] }) }, timezone: 'UTC' }), /reading the conversations…/);
  });

  test('the demo draws the same component over generated conversations, and refuses every write in words', async () => {
    const demo = ui.demoCrmApi();
    const ws = await demo.workspace();
    const inbox = await demo.conversations();
    assert.ok(inbox.conversations.length >= 4);
    assert.ok(inbox.conversations[0].unread, 'unread first');
    const talking = inbox.conversations[0].contacts[0].id;
    const html = ui.render('Conversation', { api: demo, by: { contact_id: talking }, timezone: ws.tenant.timezone, initial: await demo.thread({ contact_id: talking }) });
    assert.match(html, /crm-msg/);
    assert.doesNotMatch(html, /<textarea|<button/, 'read-only');
    const stopped = ws.contacts[12].id;
    const blocked = await demo.thread({ contact_id: stopped });
    assert.equal(blocked.threads[0].do_not_contact.reason, 'opt_out');
    assert.match(ui.render('Conversation', { api: demo, by: { contact_id: stopped }, timezone: ws.tenant.timezone, initial: blocked }), /do not contact/);
    for (const call of ['sendMessage', 'cancelMessage', 'reconcileMessage', 'flushMessages', 'markRead', 'assignConversation', 'doNotContact', 'saveSnippet']) {
      await assert.rejects(demo[call]({}), /this is the demo/, call);
    }
    /* a customer nobody has texted still opens, with nothing in it. */
    const quiet = await demo.thread({ contact_id: ws.contacts[0].id });
    assert.deepEqual([quiet.threads[0].messages.length, quiet.threads[0].conversation], [0, null]);
  });
});

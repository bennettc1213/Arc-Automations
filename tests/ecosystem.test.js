import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  adaptEvent,
  mergeEvents,
  stationState,
  STATION_BY_ID,
  demoSequence,
  memoryNote,
  safeFilePart,
} from '../src/portal/ecosystem/model.js';
import { memoryDirectories, writeEventNote } from '../scripts/damon-memory-sync.mjs';

const raw = (id, tenant = 'one', type = 'call_missed', extra = {}) => ({
  id,
  tenant_id: tenant,
  event_type: type,
  occurred_at: '2026-10-07T10:00:00Z',
  status: 'success',
  ...extra,
});
test('mission feed rejects another tenant at adaptation and merge boundaries', () => {
  assert.equal(adaptEvent(raw('secret', 'two'), 'one'), null);
  assert.equal(adaptEvent(raw('secret'), null), null);
  const own = adaptEvent(raw('own'), 'one');
  const other = adaptEvent(raw('other', 'two'), 'two');
  assert.deepEqual(mergeEvents([other], [own, other], 'one'), [own]);
});
test('stream and polling deliveries are deduplicated, ordered and bounded', () => {
  const a = adaptEvent(raw('a'), 'one');
  const b = adaptEvent(raw('b', 'one', 'sms_sent', { occurred_at: '2026-10-07T10:00:01Z' }), 'one');
  assert.deepEqual(mergeEvents([a], [a, b], 'one'), [b, a]);
  assert.deepEqual(mergeEvents([a], [b], 'one', 1), [b]);
});
test('failed sends surface at Twilio and missing evidence never claims health', () => {
  const event = adaptEvent(
    raw('failure', 'one', 'message_failed', { payload: { error_code: '30007' } }),
    'one',
  );
  assert.equal(event.station, 'comms');
  assert.equal(event.status, 'error');
  assert.equal(stationState(STATION_BY_ID.comms, [event]).tone, 'error');
  assert.equal(stationState(STATION_BY_ID.signal, []).label, 'Awaiting evidence');
  assert.equal(stationState(STATION_BY_ID.comms, []).label, 'Readiness unverified');
  assert.equal(stationState(STATION_BY_ID.voice, []).label, 'Not enabled');
  assert.equal(stationState(STATION_BY_ID.n8n, []).label, 'Runner gated');
  const runnerError = adaptEvent(
    raw('n8n', 'one', 'automation_failed', { workflow_id: 'workflow-1' }),
    'one',
  );
  assert.equal(runnerError.station, 'n8n');
  assert.equal(stationState(STATION_BY_ID.n8n, [runnerError]).tone, 'error');
});
test('synthetic checks never earn a business station evidence indicator', () => {
  const e = adaptEvent(raw('canary', 'one', 'lead_received', { is_canary: true }), 'one');
  assert.equal(stationState(STATION_BY_ID.signal, [e]).label, 'Awaiting evidence');
  assert.match(memoryNote(e), /synthetic: true/);
});
test('booking and run completion never become verified billable outcomes', () => {
  assert.match(adaptEvent(raw('a', 'one', 'lead_booked'), 'one').summary, /needs proof/);
  assert.match(adaptEvent(raw('b', 'one', 'automation_completed'), 'one').summary, /not a billing claim/);
});
test('decision memory uses a closed metadata set and strips credential/contact-shaped values', () => {
  const e = adaptEvent(
    raw('a', 'one', 'handoff_requested', {
      payload: {
        reason_code: 'safety',
        token: 'secret',
        customer: 'Person',
        body: 'Private message',
        intent: 'Bearer secret123',
        error_code: 'https://secret.example',
        source: 'customer@example.com',
        nested: { password: 'secret' },
      },
    }),
    'one',
  );
  assert.deepEqual(e.meta, {
    reason_code: 'safety',
    intent: '[withheld]',
    error_code: '[withheld]',
    source: '[withheld]',
  });
  const text = memoryNote(e);
  assert.ok(!text.includes('secret123'));
  assert.ok(!text.includes('Private message'));
  assert.match(text, /reason_code: "safety"/);
  assert.throws(() => safeFilePart('../escape'));
  assert.throws(() => safeFilePart('C:\\escape'));
});
test('all demo scenarios have isolated data and actual station mappings', () => {
  for (const scenario of ['recovery', 'safety', 'failure']) {
    const sequence = demoSequence(scenario, 0);
    assert.ok(sequence.length > 2);
    assert.ok(sequence.every((e) => e.tenantId === 'demo-hvac' && STATION_BY_ID[e.station]));
    assert.ok(sequence.every((e) => memoryNote(e).includes('synthetic: true')));
  }
  assert.equal(demoSequence('safety').at(-1).status, 'attention');
  assert.ok(demoSequence('failure').some((e) => e.status === 'error'));
});
test('Obsidian bridge writes tenant-separated idempotent files and preserves existing notes', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'arc-memory-test-'));
  try {
    const a = await memoryDirectories(vault, 'client-a');
    const b = await memoryDirectories(vault, 'client-b');
    const e = adaptEvent(raw('same-id', 'client-a'), 'client-a');
    assert.equal(await writeEventNote(a.events, e), true);
    assert.equal(await writeEventNote(a.events, e), false);
    await writeFile(path.join(a.events, 'same-id.md'), 'operator annotation');
    assert.equal(await writeEventNote(a.events, e), false);
    assert.equal(await readFile(path.join(a.events, 'same-id.md'), 'utf8'), 'operator annotation');
    assert.equal(await writeEventNote(b.events, { ...e, tenantId: 'client-b' }), true);
    assert.match(await readFile(path.join(b.events, 'same-id.md'), 'utf8'), /tenant_id: "client-b"/);
    await assert.rejects(memoryDirectories(vault, '../escape'));
  } finally {
    assert.equal(path.dirname(vault), os.tmpdir());
    assert.ok(path.basename(vault).startsWith('arc-memory-test-'));
    await rm(vault, { recursive: true, force: true });
  }
});

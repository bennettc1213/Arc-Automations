import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLeadProof } from '../src/portal/lib/lead-proof.js';
import { eventLabel } from '../src/portal/lib/format.js';
import { buildDashboardData } from '../src/portal/lib/dashboard-data.js';
import { ownerJobs } from '../src/portal/lib/owner.js';
import { LEDGER_NOW, LEDGER_TENANT, chain, daysAgo, event } from './ledger-fixtures.js';

test('the owner history is ordered, scoped by lead, deduplicated and contains no message body', () => {
  const event = (id, type, at, extra = {}) => ({
    id, eventType: type, occurredAt: at, correlationId: 'lead-a',
    status: 'success', isCanary: false, eventKey: id, payload: {}, ...extra,
  });
  const rows = buildLeadProof([
    event('sent', 'sms_sent', '2026-10-11T12:01:00Z', { payload: { purpose: 'first_response', body: 'private words', to: '+15550000000' } }),
    event('arrival', 'lead_received', '2026-10-11T12:00:00Z', { payload: { source: 'web_form' } }),
    event('duplicate', 'sms_sent', '2026-10-11T12:01:01Z', { eventKey: 'sent' }),
    event('other', 'owner_alerted', '2026-10-11T12:02:00Z', { correlationId: 'lead-b' }),
    event('route', 'routed', '2026-10-11T12:03:00Z', { payload: { tech: '+15551111111' } }),
    event('handoff', 'handoff_requested', '2026-10-11T12:04:00Z', { payload: { reason: 'private customer words', safety: true } }),
    event('synthetic', 'sms_sent', '2026-10-11T12:03:00Z', { isCanary: true }),
    event('account', 'pilot_terms_recorded', '2026-10-11T12:04:00Z'),
  ]);

  assert.deepEqual(rows.get('lead-a').map((row) => row.id), ['arrival', 'sent', 'route', 'handoff']);
  assert.deepEqual(rows.get('lead-b').map((row) => row.id), ['other']);
  assert.equal(rows.get('lead-a')[0].label, 'website request submitted');
  assert.equal(rows.get('lead-a')[1].label, 'first response sent');
  assert.equal(JSON.stringify(rows.get('lead-a')).includes('private words'), false);
  assert.equal(JSON.stringify(rows.get('lead-a')).includes('+15550000000'), false);
  assert.equal(JSON.stringify(rows.get('lead-a')).includes('+15551111111'), false);
  assert.equal(JSON.stringify(rows.get('lead-a')).includes('private customer words'), false);
});

test('a sent text, delivery receipt and stopped follow-up make distinct claims', () => {
  assert.equal(eventLabel('sms_sent', { purpose: 'followup' }), 'follow-up sent');
  assert.equal(eventLabel('message_delivered'), 'text delivered');
  assert.equal(eventLabel('followup_stopped', { reason: 'customer_replied' }), 'follow-up stopped — customer replied');
});

test('a real owner job carries the lead history from the same event log as its verdict', () => {
  const events = [
    ...chain('proof-lead', { source: 'web_form', visitAt: daysAgo(1) }),
    event('owner_alerted', daysAgo(5), { correlationId: 'proof-lead', payload: { channel: 'sms' } }),
  ];
  const data = buildDashboardData(LEDGER_TENANT, events, LEDGER_NOW);
  const [job] = ownerJobs(data).jobs;
  assert.equal(job.key, 'proof-lead');
  assert.ok(job.verdict);
  assert.ok(job.proof.some((row) => row.type === 'owner_alerted'));
  assert.ok(job.proof.some((row) => row.label === 'website request submitted'));
});

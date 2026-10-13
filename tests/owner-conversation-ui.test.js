/* what an owner sees of 0036 in their own portal: the reply box, handing back, and one
 * campaign paused.
 *
 * The engine's half is the gate suite. These hold the screen to it: `productionState` reads
 * the same rows the engine writes, and the inbox and the campaigns page are *rendered* from
 * that state, so a control that is drawn where the engine would refuse it — a reply box on a
 * lead nobody took over, a hand-back on a safety lead, a pause button on an account that has
 * no such switch — fails here.
 *
 * Nothing here signs in or reaches a function. The pages were not looked at against a live
 * account.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { productionState } from '../src/portal/product/production.js';
import { newCampaign } from '../src/portal/product/model.js';
import { MAX_OWNER_REPLY_CHARS } from '../supabase/functions/_shared/engine/templates.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPages() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter, Route, Routes } from 'react-router-dom';",
        "import { Inbox } from './src/portal/product/LeadsInbox.jsx';",
        "import { Campaigns } from './src/portal/product/Campaigns.jsx';",
        'const PAGES = { Inbox, Campaigns };',
        'export const render = (name, props, at = "/") => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [at] },',
        '  createElement(Routes, null,',
        '    createElement(Route, { path: "/inbox/:id", element: createElement(PAGES[name], props) }),',
        '    createElement(Route, { path: "*", element: createElement(PAGES[name], props) }))));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.ts': 'ts', '.woff2': 'empty' },
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-conversation-'));
  const file = path.join(dir, 'pages.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadPages();
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const times = (text, needle) => text.split(needle).length - 1;

/* ── a business with three conversations, as the database would hand them over ── */

const tenant = { id: 'tenant-a', name: 'Fictional Glassworks', timezone: 'America/Denver' };
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000011';
const lead = (id, overrides = {}) => ({
  id, tenant_id: tenant.id, correlation_id: `corr-${id}`, customer_name: 'Robin Vale', phone: '+16145550101', service_request: 'window cleaning',
  source: 'missed_call', status: 'awaiting_reply', consent_sms: true, consent_source: 'inbound_call', consent_at: '2026-10-12T15:00:00Z',
  safety_flags: [], created_at: '2026-10-12T15:00:00Z', updated_at: '2026-10-12T15:05:00Z', ...overrides,
});
const message = (id, leadId, at, overrides = {}) => ({
  id, tenant_id: tenant.id, conversation_id: `conv-${leadId}`, direction: 'outbound', body: 'Sorry we missed your call.', status: 'delivered',
  error_detail: null, author_user_id: null, occurred_at: at, ...overrides,
});

function account({ leads, messages = [], handoffs = [], threads = [], campaigns = [], campaignPauses, sending = { available: true, paused: false, changedAt: null } }) {
  return productionState({
    tenant, generatedFor: '2026-10-13T00:00:00Z', threads,
    product: { available: true, campaigns, campaignPauses, sending, form: { available: true, module_state: 'active', module_health: 'healthy' } },
    leadRecovery: {
      available: true, error: null, leads, handoffs, messages,
      conversations: leads.map((row) => ({ id: `conv-${row.id}`, lead_id: row.id })),
    },
  });
}

const TAKEN = lead('lead-taken', { status: 'handed_off' });
const takenOver = () => account({
  leads: [TAKEN],
  handoffs: [{ id: 'h1', lead_id: TAKEN.id, status: 'open', reason: 'taken over by a person', is_safety: false }],
  messages: [
    message('m1', TAKEN.id, '2026-10-12T15:00:10Z'),
    message('m2', TAKEN.id, '2026-10-12T15:02:00Z', { direction: 'inbound', body: 'Can someone come today?', status: 'received' }),
    message('m3', TAKEN.id, '2026-10-12T15:04:00Z', { body: 'This is Robin. I can be there at 3.', author_user_id: OWNER, status: 'queued' }),
    message('m4', TAKEN.id, '2026-10-12T15:06:00Z', { body: 'On my way', author_user_id: OWNER, status: 'failed', error_detail: 'this customer asked not to be texted, so it was not sent' }),
  ],
});

describe('the portal reads the conversation off the same rows the engine writes', () => {
  test('a text with an author is the owner’s, and one of theirs that did not go carries why', () => {
    const [row] = takenOver().leads;
    assert.deepEqual(row.messages.map((m) => m.author), ['ARC automation', 'Customer', 'You', 'You']);
    assert.deepEqual(row.messages.map((m) => m.problem), [null, null, null, 'this customer asked not to be texted, so it was not sent']);
    assert.deepEqual([row.ownerTakeover, row.needsOwner, row.safety], [true, true, false]);
  });

  test('a failed text of ARC’s own is not presented as the owner’s problem', () => {
    const state = account({ leads: [lead('l')], messages: [message('m', 'l', '2026-10-12T15:00:10Z', { status: 'failed', error_detail: 'carrier refused' })] });
    assert.equal(state.leads[0].messages[0].problem, null);
  });

  test('a conversation handed back to ARC no longer reads as needing the owner, whatever the log’s first request said', () => {
    const back = lead('lead-back');
    /* the event log's handoff request is append-only: it never learns the handoff ended. */
    const thread = { id: back.correlation_id, name: 'Robin Vale', source: 'missed_call', steps: [], handoff: { resolvedAt: null } };
    const state = account({ leads: [back], threads: [thread], handoffs: [{ id: 'h', lead_id: back.id, status: 'resolved', reason: 'taken over by a person' }] });
    assert.deepEqual([state.leads[0].ownerTakeover, state.leads[0].needsOwner], [false, false]);
    /* with no row in hand, the log is all there is, and it still says a person is needed. */
    const logOnly = account({ leads: [], threads: [thread] });
    assert.equal(logOnly.leads[0].needsOwner, true);
  });

  test('a lead that reached a person for a safety reason is marked, from its flags or its handoff', () => {
    const flagged = account({ leads: [lead('s1', { status: 'handed_off', safety_flags: ['smoke'] })] });
    const handed = account({ leads: [lead('s2', { status: 'handed_off' })], handoffs: [{ id: 'h', lead_id: 's2', status: 'open', reason: 'smoke', is_safety: true }] });
    assert.deepEqual([flagged.leads[0].safety, handed.leads[0].safety], [true, true]);
  });
});

describe('the inbox, rendered for a real account', () => {
  const page = (state, id) => plain(render('Inbox', { state, base: '', dispatch() {}, onReload() {} }, `/inbox/${id}`));
  /* the page's standing note under the contact list says "Use Take over on their conversation
     above first", once, whatever is selected. anything beyond that is the button. */
  const NOTICE_ONLY = 1;

  test('on a conversation the owner took over: a reply box, a way to hand it back, and their own texts as theirs', () => {
    const text = page(takenOver(), TAKEN.id);
    assert.match(text, /You have taken this over, and ARC has stopped texting this customer/);
    assert.match(text, /Your reply/);
    assert.match(text, new RegExp(`0 of ${MAX_OWNER_REPLY_CHARS} characters`));
    assert.match(text, /Send reply/);
    assert.match(text, /Hand back to ARC/);
    assert.equal(times(text, 'Take over'), NOTICE_ONLY, 'there is nothing left to take over');
    assert.match(text, /This is Robin\. I can be there at 3\. You ·/, 'their own text is signed as theirs');
    assert.match(text, /On my way You · .* · Not sent Not sent: this customer asked not to be texted, so it was not sent\./);
  });

  test('on a conversation ARC still has: take over, and no reply box', () => {
    const waiting = lead('lead-arc');
    const text = page(account({ leads: [waiting], messages: [message('m', waiting.id, '2026-10-12T15:00:10Z')] }), waiting.id);
    assert.equal(times(text, 'Take over'), NOTICE_ONLY + 1, 'the button');
    assert.match(text, /Taking over stops ARC’s texts to this customer so you can reply yourself/);
    assert.doesNotMatch(text, /Your reply|Send reply|Hand back to ARC/);
  });

  test('a safety conversation can be replied to and cannot be handed back', () => {
    const safety = lead('lead-safety', { status: 'handed_off', safety_flags: ['smoke'] });
    const text = page(account({ leads: [safety], handoffs: [{ id: 'h', lead_id: safety.id, status: 'open', reason: 'smoke was mentioned', is_safety: true }] }), safety.id);
    assert.match(text, /It came to you for a safety reason, so it stays with you/);
    assert.match(text, /Send reply/);
    assert.doesNotMatch(text, /Hand back to ARC/);
  });

  test('a customer who opted out gets no box at all', () => {
    const gone = lead('lead-gone', { status: 'suppressed' });
    const text = page(account({ leads: [gone], messages: [message('m', gone.id, '2026-10-12T15:00:10Z')] }), gone.id);
    assert.match(text, /This customer opted out\. Nobody can text them from ARC/);
    assert.doesNotMatch(text, /Your reply|Send reply|Hand back to ARC/);
    assert.equal(times(text, 'Take over'), NOTICE_ONLY);
  });
});

describe('the campaigns page, rendered for a real account', () => {
  const live = (kind, id) => ({ ...newCampaign(kind, tenant.id, id), runtime: 'live', revision: 2, updatedAt: '2026-10-12T15:00:00Z', createdAt: '2026-10-12T15:00:00Z' });
  const page = (state) => plain(render('Campaigns', { state, base: '', dispatch() {}, onReload() {} }));
  const campaigns = [live('missed', 'c-missed'), live('inbound', 'c-inbound'), { ...live('inbound', 'c-draft'), runtime: 'draft', name: 'A second draft' }];

  test('each switched-on campaign has its own pause, and a paused one says so in the owner’s words', () => {
    const text = page(account({ leads: [], campaigns, campaignPauses: { available: true, kinds: { inbound: { paused: true, changedAt: '2026-10-12T16:00:00Z' } } } }));
    assert.equal(times(text, 'Paused by you'), 1);
    assert.match(text, /You paused this campaign\. Nobody who reaches you this way is being texted\. They still arrive in your inbox and you are still told about each one\./);
    assert.equal(times(text, 'Resume this campaign'), 1, 'the paused one can be resumed');
    assert.equal(times(text, 'Pause this campaign'), 1, 'the other one can be paused, and the draft offers neither');
    assert.match(text, /Pause all texts/, 'beside the pause of everything');
  });

  test('with nothing paused, both running campaigns offer a pause and none reads as paused', () => {
    const text = page(account({ leads: [], campaigns, campaignPauses: { available: true, kinds: {} } }));
    assert.equal(times(text, 'Pause this campaign'), 2);
    assert.equal(times(text, 'Paused by you'), 0);
  });

  test('on an account whose database has no such switch there is no button that would fail', () => {
    for (const campaignPauses of [undefined, { available: false }]) {
      const state = account({ leads: [], campaigns, campaignPauses });
      assert.equal(state.campaignPauses, null);
      const text = page(state);
      assert.equal(times(text, 'Pause this campaign') + times(text, 'Resume this campaign') + times(text, 'Paused by you'), 0);
    }
  });
});

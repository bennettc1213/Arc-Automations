/* ARC-360 — the lead inbox's derivation and the workspace screen, with no database.
 *
 *   - `inbox.ts` as plain functions: which queue a lead is in, search, filter, sort, locks;
 *   - the real components rendered to static markup (esbuild, as tests/ux-clarity.test.js does)
 *     over known rows: what a person is shown, what is disabled, and what is never printed.
 *
 * The same rows through real SQL are tests/crm-workspace-db.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_REASONS, createdElsewhere, entryStage, filterLeads, inboxStates, INBOX_QUEUES, inQueue, lockedFields, matchesText,
  nextTask, queueCounts, QUEUE_WORDS, sortLeads, taskBucket,
} from '../supabase/functions/_shared/crm/inbox.ts';
import { parsePipelineInput, parseStagesInput, STAGE_WAITS } from '../supabase/functions/_shared/crm/model.ts';
import { glossFor } from '../src/portal/lib/glossary.js';
import { NAV_ITEMS } from '../src/portal/lib/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

/* ── a small known workspace ────────────────────────────── */

const NOW = new Date('2026-10-02T15:00:00Z');
const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const ME = 'bbbbbbbb-0000-4000-8000-000000000001';
const THEM = 'bbbbbbbb-0000-4000-8000-000000000002';
const stage = (key, position, kind = 'open', waits_on = 'us') => ({ id: `stage-${key}`, pipeline_id: 'p1', key, name: key, position, kind, waits_on, archived_at: null });
const PIPELINE = { id: 'p1', name: 'Sales', is_default: true, stages: [stage('new', 10), stage('contacted', 20), stage('quoted', 30, 'open', 'customer'), stage('won', 40, 'won'), stage('lost', 50, 'lost')] };
const contact = (n, extra = {}) => ({ id: `c${n}`, tenant_id: T, display_name: `Person ${n}`, phone: `+1614555010${n}`, email: `p${n}@example.com`, created_at: '2026-09-01T00:00:00Z', ...extra });
const lead = (n, stageKey, extra = {}) => {
  const s = PIPELINE.stages.find((x) => x.key === stageKey);
  return {
    id: `l${n}`, tenant_id: T, contact_id: `c${n}`, title: `Job ${n}`, summary: null, source: 'web_form', pipeline_id: 'p1', stage_id: s.id, status: s.kind,
    owner_user_id: null, priority: 'normal', archived_at: null, recovery_lead_id: null,
    created_at: `2026-10-0${n}T10:00:00Z`, updated_at: `2026-10-0${n}T11:00:00Z`, ...extra,
  };
};
const task = (id, leadId, due, extra = {}) => ({ id, lead_id: leadId, title: `Task ${id}`, status: 'open', due_at: due, created_at: '2026-10-01T00:00:00Z', ...extra });

function workspace() {
  return {
    tenant: { id: T, name: 'Acme Heating', timezone: 'America/Denver' },
    viewer: { kind: 'client_user', user_id: ME, role: 'owner', may: { record: true, sensitive: true, business: true } },
    route: 'native',
    policies: Object.fromEntries(['contact', 'lead', 'task', 'note', 'location', 'service'].map((t) => [t, { objectType: t, authority: 'arc', connectorKey: null, fieldOwners: {} }])),
    pipelines: [PIPELINE],
    leads: [
      lead(1, 'new'),                                              // untouched, unowned, no next step
      lead(2, 'contacted', { owner_user_id: ME, priority: 'urgent' }), // has an overdue task
      lead(3, 'contacted', { owner_user_id: THEM }),                // has a task due later: nothing to do now
      lead(4, 'quoted', { owner_user_id: ME }),                     // waiting on the customer
      lead(5, 'won', { owner_user_id: ME, closed_at: '2026-10-01T00:00:00Z' }),
      lead(6, 'contacted', { owner_user_id: ME, recovery_lead_id: 'r6' }), // lead recovery handed it over
      lead(7, 'contacted', { owner_user_id: THEM }),                // opted out
    ],
    contacts: [1, 2, 3, 4, 5, 6, 7].map((n) => contact(n)),
    tasks: [
      task('t2', 'l2', '2026-10-02T12:00:00Z'),
      task('t3', 'l3', '2026-10-03T12:00:00Z'),
      task('t3b', 'l3', null),
      task('t6', 'l6', '2026-10-09T12:00:00Z'),
      task('t7', 'l7', '2026-10-09T12:00:00Z'),
    ],
    blocks: { c7: [{ channel: 'sms', reason: 'opt_out', expires_at: null }], c3: [{ channel: 'sms', reason: 'other', expires_at: '2026-10-01T00:00:00Z' }] },
    recovery: { r6: { status: 'handoff_required', safety_flags: ['emergency'] } },
    people: [{ user_id: ME, label: 'me@acme.example — you', role: 'owner', assignable: true }, { user_id: THEM, label: 'them@acme.example', role: 'staff', assignable: true }],
    services: [],
    truncated: { open: false, closed: false },
    read_at: NOW.toISOString(),
  };
}
const stateOf = (ws, n) => inboxStates(ws, NOW).find((s) => s.lead.id === `l${n}`);

/* ── the derivation ─────────────────────────────────────── */

describe('the inbox, read off the records', () => {
  const ws = workspace();

  test('a new lead nobody has moved is not contacted, unowned, and needs attention', () => {
    const s = stateOf(ws, 1);
    assert.deepEqual([s.untouched, s.unowned, s.overdue, s.waiting, s.closed, s.attention], [true, true, false, false, false, true]);
    assert.equal(s.next_task, null);
    assert.deepEqual(s.reasons, ['not contacted yet', 'no next step', 'nobody owns it']);
    assert.equal(entryStage(PIPELINE).key, 'new');
  });

  test('overdue is the clock against an open task; the next task is the one due first, dated before undated', () => {
    const s = stateOf(ws, 2);
    assert.equal(s.overdue, true);
    assert.equal(s.attention, true);
    assert.equal(stateOf(ws, 3).next_task.id, 't3');
    assert.equal(stateOf(ws, 3).open_tasks, 2);
    assert.equal(nextTask([task('a', 'x', null), task('b', 'x', '2026-10-05T00:00:00Z'), task('c', 'x', '2026-10-04T00:00:00Z', { status: 'done' })]).id, 'b');
  });

  test('a lead with an owner and a task due later is nobody\'s problem right now', () => {
    const s = stateOf(ws, 3);
    assert.equal(s.attention, false);
    assert.deepEqual(s.reasons, []);
    assert.deepEqual(s.blocked, [], 'a suppression that expired no longer blocks');
  });

  test('waiting on the customer comes from the stage, and is not chased until a task is overdue', () => {
    const s = stateOf(ws, 4);
    assert.equal(s.waiting, true);
    assert.equal(s.attention, false);
    const chased = { ...ws, tasks: [...ws.tasks, task('t4', 'l4', '2026-10-01T00:00:00Z')] };
    assert.equal(stateOf(chased, 4).attention, true);
    /* a stage's name decides nothing: rename "quoted" and it is still waiting. */
    const renamed = { ...ws, pipelines: [{ ...PIPELINE, stages: PIPELINE.stages.map((x) => (x.key === 'quoted' ? { ...x, name: 'Anything' } : x)) }] };
    assert.equal(stateOf(renamed, 4).waiting, true);
  });

  test('a won lead is closed and in no working queue — and nothing here calls it proven', () => {
    const s = stateOf(ws, 5);
    assert.deepEqual([s.closed, s.attention, s.untouched, s.unowned], [true, false, false, false]);
    for (const q of ['attention', 'untouched', 'overdue', 'unowned', 'waiting', 'blocked', 'mine', 'open']) assert.equal(inQueue(s, q, ME), false, q);
    assert.equal(inQueue(s, 'closed', ME), true);
    assert.match(glossFor('won').gloss, /not counted as a proven result/);
  });

  test('blocked says why: do-not-contact from the list, a handoff and a safety flag from lead recovery', () => {
    assert.deepEqual(stateOf(ws, 7).blocked, [{ reason: 'do_not_contact', detail: 'texts: opt out' }]);
    assert.deepEqual(stateOf(ws, 6).blocked.map((b) => b.reason), ['handed_to_person', 'safety_flag']);
    assert.equal(stateOf(ws, 6).attention, true);
    for (const reason of BLOCK_REASONS) assert.ok(glossFor(reason), reason);
  });

  test('the queue counts add up, "mine" is the viewer\'s open leads, and every queue has its words and a gloss', () => {
    const states = inboxStates(ws, NOW);
    assert.deepEqual(queueCounts(states, ME), { attention: 4, untouched: 1, overdue: 1, unowned: 1, waiting: 1, blocked: 2, mine: 3, open: 6, closed: 1 });
    assert.equal(queueCounts(states, null).mine, 0);
    for (const q of INBOX_QUEUES) {
      assert.ok(QUEUE_WORDS[q], q);
      if (!['mine', 'closed'].includes(q)) assert.ok(glossFor(q), `${q} is explained`);
    }
  });

  test('an archived lead is not in the inbox at all', () => {
    const archived = { ...ws, leads: ws.leads.map((l) => (l.id === 'l1' ? { ...l, archived_at: '2026-10-02T00:00:00Z' } : l)) };
    assert.equal(inboxStates(archived, NOW).some((s) => s.lead.id === 'l1'), false);
  });
});

describe('search, filter and sort', () => {
  const ws = workspace();
  const states = inboxStates(ws, NOW);
  const ids = (list) => list.map((s) => s.lead.id);

  test('search matches a name, an email, a title, and a phone by its digits however it was typed', () => {
    assert.deepEqual(ids(filterLeads(states, { text: 'person 3' }, ME)), ['l3']);
    assert.deepEqual(ids(filterLeads(states, { text: 'P4@EXAMPLE' }, ME)), ['l4']);
    assert.deepEqual(ids(filterLeads(states, { text: 'job 5' }, ME)), ['l5']);
    assert.deepEqual(ids(filterLeads(states, { text: '(614) 555-0102' }, ME)), ['l2']);
    assert.equal(matchesText(states[0], '55'), false, 'two digits are not a phone search');
    assert.deepEqual(filterLeads(states, { text: 'nobody by this name' }, ME), []);
  });

  test('filters combine: queue, stage, owner (or none), source, priority', () => {
    assert.deepEqual(ids(filterLeads(states, { queue: 'open', owner: 'none' }, ME)), ['l1']);
    assert.deepEqual(ids(filterLeads(states, { queue: 'open', owner: THEM }, ME)), ['l3', 'l7']);
    assert.deepEqual(ids(filterLeads(states, { stage_id: 'stage-contacted', priority: 'urgent' }, ME)), ['l2']);
    assert.deepEqual(filterLeads(states, { source: 'missed_call' }, ME), []);
    assert.deepEqual(ids(filterLeads(states, { queue: 'mine' }, ME)), ['l2', 'l4', 'l6']);
  });

  test('sorts: newest, oldest, next task due (none last), priority', () => {
    assert.equal(ids(sortLeads(states, 'newest'))[0], 'l7');
    assert.equal(ids(sortLeads(states, 'oldest'))[0], 'l1');
    assert.deepEqual(ids(sortLeads(states, 'next_due')).slice(0, 2), ['l2', 'l3']);
    assert.equal(ids(sortLeads(states, 'priority'))[0], 'l2');
    assert.equal(states[0].lead.id, 'l1', 'sorting returns a new list');
  });

  test('a task is overdue, due today, coming up or undated — in the business\'s own day', () => {
    assert.equal(taskBucket(task('a', 'x', '2026-10-02T14:59:00Z'), NOW, 'America/Denver'), 'overdue');
    assert.equal(taskBucket(task('a', 'x', '2026-10-03T05:00:00Z'), NOW, 'America/Denver'), 'today', '11pm Denver is still today');
    assert.equal(taskBucket(task('a', 'x', '2026-10-03T05:00:00Z'), NOW, 'UTC'), 'upcoming');
    assert.equal(taskBucket(task('a', 'x', null), NOW, 'UTC'), 'undated');
    assert.equal(taskBucket(task('a', 'x', null, { status: 'done' }), NOW, 'UTC'), 'done');
  });
});

describe('who may edit what', () => {
  test('ARC owns everything by default; an external or hybrid policy locks exactly the fields the other side owns', () => {
    assert.deepEqual(lockedFields({ objectType: 'lead', authority: 'arc', connectorKey: null, fieldOwners: {} }), []);
    assert.deepEqual(lockedFields(null), []);
    const hybrid = { objectType: 'lead', authority: 'hybrid', connectorKey: 'jobber', fieldOwners: { stage_id: 'external', title: 'external' } };
    assert.deepEqual(lockedFields(hybrid).sort(), ['stage_id', 'title']);
    const external = { objectType: 'contact', authority: 'external', connectorKey: 'jobber', fieldOwners: {} };
    assert.ok(lockedFields(external).includes('phone'));
    assert.equal(lockedFields(external).includes('owner_user_id'), false, 'who owns it in ARC is always ARC\'s');
    assert.equal(createdElsewhere(external), true);
    assert.equal(createdElsewhere(hybrid), false);
  });

  test('a stage list: an existing stage keeps its key and kind, a new one needs a key, and one must stay live', () => {
    const id = 'cccccccc-0000-4000-8000-000000000001';
    const ok = parseStagesInput({ pipeline_id: id, stages: [{ id, name: 'New', waits_on: 'us' }, { key: 'site_visit', name: 'Site visit', waits_on: 'customer' }] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.value.stages[1], { key: 'site_visit', kind: 'open', name: 'Site visit', waits_on: 'customer', marks_qualified: false, retired: false });
    for (const bad of [
      { pipeline_id: id, stages: [] },
      { pipeline_id: id, stages: [{ id, name: 'New', kind: 'won' }] },
      { pipeline_id: id, stages: [{ id, name: 'New', key: 'renamed' }] },
      { pipeline_id: id, stages: [{ name: 'No key' }] },
      { pipeline_id: id, stages: [{ id, name: 'New', waits_on: 'nobody' }] },
      { pipeline_id: id, stages: [{ id, name: 'A' }, { id, name: 'B' }] },
      { pipeline_id: id, stages: [{ id, name: 'Only', retired: true }] },
      { pipeline_id: 'nope', stages: [{ id, name: 'New' }] },
    ]) assert.equal(parseStagesInput(bad).ok, false, JSON.stringify(bad));
    assert.deepEqual([...STAGE_WAITS], ['us', 'customer']);
    const made = parsePipelineInput({ key: 'plans', name: 'Plans', stages: [{ key: 'quoted', name: 'Quoted', waits_on: 'customer' }, { key: 'signed', name: 'Signed', kind: 'won', waits_on: 'customer' }] });
    assert.deepEqual(made.value.stages.map((s) => s.waits_on), ['customer', 'us'], 'a closed stage waits on nobody');
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
        "import CrmWorkspace, { WorkspaceError } from './src/portal/components/CrmWorkspace.jsx';",
        "import { QuickAdd } from './src/portal/components/CrmRecord.jsx';",
        "import { demoCrmApi } from './src/portal/demo/crm-demo.js';",
        'const C = { CrmWorkspace, WorkspaceError, QuickAdd };',
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
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-workspace-'));
  const file = path.join(dir, 'components.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the workspace on screen', async () => {
  const ui = await loadComponents();
  const api = { door: 'crm', readOnly: false };
  const draw = (ws, props = {}) => ui.render('CrmWorkspace', { api, initial: ws, ...props });

  test('loading, and the two ways a read can fail, each say what is happening', () => {
    assert.match(ui.render('CrmWorkspace', { api }), /reading your leads…/);
    const missing = Object.assign(new Error('unknown action'), { status: 400, payload: { error: 'unknown action' } });
    const client = ui.render('WorkspaceError', { error: missing, door: 'crm' });
    assert.match(client, /not switched on here yet/);
    assert.doesNotMatch(client, /0025|migration|function/, 'a client is not shown deploy steps');
    const operator = ui.render('WorkspaceError', { error: Object.assign(new Error('x'), { status: 501 }), door: 'ops' });
    assert.match(operator, /0025_crm_workspace\.sql/);
    const failed = ui.render('WorkspaceError', { error: new Error('the network dropped'), door: 'crm' });
    assert.match(failed, /your leads could not be read/);
    assert.match(failed, /the network dropped/);
    assert.match(failed, /try again/);
  });

  test('an empty workspace says so, and says where a lead comes from', () => {
    const empty = { ...workspace(), leads: [], contacts: [], tasks: [], blocks: {}, recovery: {} };
    const html = draw(empty);
    assert.match(html, /no leads yet/);
    assert.match(html, /0 open/);
  });

  test('the inbox opens on what needs attention, with this client\'s leads and each queue\'s count', () => {
    /* the screen reads the clock itself, so the expectation is the same derivation at the same moment. */
    const ws = workspace();
    const html = draw(ws);
    const states = inboxStates(ws);
    const counts = queueCounts(states, ME);
    assert.ok(html.includes(`${counts.open} open · ${counts.attention} need attention · ${counts.waiting} waiting on the customer`));
    for (const s of states) {
      const shown = html.includes(`>${s.contact.display_name}<`);
      assert.equal(shown, s.attention, `${s.contact.display_name} is listed exactly when it needs attention`);
    }
    assert.ok(states.some((s) => s.attention) && states.some((s) => !s.attention));
    assert.match(html, /aria-pressed="true"[^>]*>(<[^>]+>)*needs attention/);
    assert.match(html, /do-not-contact list|asked not to be contacted/, 'blocked is explained where it is printed');
    assert.match(html, /add a lead/);
  });

  test('every state word on the page carries its meaning, and every control has a name', () => {
    const html = draw(workspace());
    assert.ok((html.match(/class="ws-term"/g) ?? []).length >= 9);
    for (const input of html.match(/<(input|select)\b[^>]*>/g) ?? []) assert.match(input, /aria-label=/, input);
  });

  test('staff see no bulk hand-over and no stage editor; a read-only workspace offers no writes at all', () => {
    const ws = workspace();
    const staff = draw({ ...ws, viewer: { ...ws.viewer, role: 'staff', may: { record: true, sensitive: false, business: false } } });
    assert.doesNotMatch(staff, />stages</);
    assert.match(draw(ws), />stages</);
    const readOnly = draw(ws, { readOnly: true });
    assert.doesNotMatch(readOnly, /add a lead/);
    assert.doesNotMatch(readOnly, /type="checkbox"/);
    assert.doesNotMatch(readOnly, />stages</);
  });

  test('leads kept in the client\'s own system: adding one here is off, and the page says where they live', () => {
    const ws = workspace();
    const html = draw({ ...ws, policies: { ...ws.policies, lead: { objectType: 'lead', authority: 'external', connectorKey: 'jobber', fieldOwners: {} } } });
    assert.match(html, /leads are kept in jobber/);
    assert.match(html, /<button[^>]*disabled=""[^>]*title="leads are created in jobber"/);
  });

  test('the demo is the same screen over generated rows, read-only, and refuses a write in words', async () => {
    const demo = ui.demoCrmApi();
    const ws = await demo.workspace();
    const html = ui.render('CrmWorkspace', { api: demo, initial: ws });
    assert.match(html, /the demo is read-only/);
    assert.doesNotMatch(html, /add a lead/);
    await assert.rejects(demo.updateLead('x', {}), /this is the demo/);
    const view = await demo.leadView(ws.leads[0].id);
    assert.equal(view.lead.id, ws.leads[0].id);
    assert.ok(ws.contacts.every((c) => /^\+1614555\d{4}$/.test(c.phone) && c.email.endsWith('@example.com')), 'fictional numbers and addresses only');
  });

  test('nothing secret-shaped can be printed: the screen has no field for one, and the view carries none', () => {
    for (const file of ['src/portal/components/CrmWorkspace.jsx', 'src/portal/components/CrmRecord.jsx']) {
      assert.doesNotMatch(read(file), /token_hash|service_role|\.token\b|api[_-]?key|password/i, file);
    }
    const quick = ui.render('QuickAdd', { api, services: [], onAdded() {}, onClose() {} });
    assert.match(quick, /sends nothing and starts nothing/);
  });

  test('the page is in the client\'s rail for every client, and the console reaches the same component', () => {
    const item = NAV_ITEMS.find((i) => i.to === 'inbox');
    assert.ok(item && !item.module, 'not gated on a lifecycle module');
    assert.match(read('src/portal/components/Workspace.jsx'), /<Route path="inbox" element=\{<Inbox \{\.\.\.pageProps\} \/>\} \/>/);
    assert.match(read('src/portal/components/OpsWorkspace.jsx'), /path="clients\/:tenantId\/crm" element=\{<ClientCrm/);
    assert.match(read('src/portal/pages/dash/Inbox.jsx'), /crmApi\('crm', data\.tenant\.id\)/);
    assert.match(read('src/portal/pages/ops/ClientCrm.jsx'), /crmApi\('ops', tenantId\)/);
  });
});

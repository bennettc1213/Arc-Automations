/* ARC-MK-200 — a launch client sees four screens instead of thirteen.
 *
 * The promises, each tested by name:
 *   - who gets the four screens is read off what the client has, never set;
 *   - no page is removed: every original page still resolves at an address;
 *   - a figure that cannot be shown is a dash and the reason, never a zero, and a real lead
 *     is never marked as counting before the counting rules exist;
 *   - the account screen shows a projection: no address whole, nothing that is not the
 *     owner's to read, and only to a member of that client;
 *   - the screens are written in an owner's words.
 *
 * The pages are rendered to static markup, so a word hardcoded in a component is read too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_ITEMS,
  OWNER_ALL_ITEMS,
  OWNER_DETAIL_ITEMS,
  OWNER_NAV_GROUPS,
  OWNER_NAV_ITEMS,
  activeItem,
} from '../src/portal/lib/nav.js';
import { NOT_COUNTED_YET, isLaunchClient, jobsTable, ownerJobs, ownerMonth, ownerNeeds } from '../src/portal/lib/owner.js';
import { buildProofLedger } from '../src/portal/demo/proof-ledger.js';
import { buildDemoAccountSettings } from '../src/portal/demo/owner-account.js';
import { ownerCopyProblem } from '../src/lib/owner-copy.js';
import { site } from '../src/data/site.js';
import {
  AFTER_HOURS_WORDS,
  STOP_LIST_SHOWN,
  STOP_REASON_WORDS,
  accountSettingsView,
  addressHint,
  hoursLines,
} from '../supabase/functions/_shared/account/model.ts';
import { readAccountSettings } from '../supabase/functions/_shared/account/service.ts';
import { AFTER_HOURS_BEHAVIOURS } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { leadRecoveryConfig, seedPublishedConfig } from './config-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const mod = (state) => ({ state, awaiting: 'your phone line is not connected yet' });
const launchAvailability = (state = 'live') => ({
  lead_capture: mod(state),
  estimates: mod('unavailable'),
  reviews: mod('unavailable'),
  memberships: mod('unavailable'),
  installs: mod('unavailable'),
});

const lead = (over = {}) => ({
  id: 'lead-1',
  startedAt: '2026-10-05T14:00:00.000Z',
  source: 'missed_call',
  sourceLabel: 'missed call',
  name: 'Pat Example',
  phone: '+16145550101',
  latencyMs: 4000,
  failed: false,
  replied: true,
  booked: true,
  deliveredAt: null,
  handoff: null,
  ...over,
});

const liveData = (over = {}) => ({
  tenant: { id: TENANT_A, name: 'Example Heating', slug: 'example', timezone: 'America/New_York', status: 'active' },
  availability: launchAvailability(),
  threads: [lead(), lead({ id: 'lead-2', name: null, replied: false, booked: false, handoff: { reason: 'smelled gas' } })],
  threadTotal: 2,
  attention: {
    total: 1,
    items: [{ key: 'k1', reasonKey: 'handoff', customer: 'Pat Example', reason: 'handed to a person', detail: 'smelled gas', openedAt: '2026-10-05T14:00:00.000Z', to: 'leads?record=lead-2' }],
  },
  leadCapture: { metrics: { opportunities: 2, answered: 2, replied: 1, escalations: 1 } },
  ...over,
});

const demoData = () => ({
  tenant: { id: TENANT_A, name: 'Halstead Heating & Air', slug: 'halstead', timezone: 'America/New_York', status: 'active' },
  proofLedger: buildProofLedger(),
  accountSettings: buildDemoAccountSettings(),
  threads: [],
});

const monthOptions = { terms: site.price.terms, leaks: site.leaks.items };

/* ── who gets the four screens ──────────────────────────── */

describe('who gets the four screens', () => {
  test('a client with lead capture and nothing else is a launch client', () => {
    assert.equal(isLaunchClient(launchAvailability('live')), true);
    assert.equal(isLaunchClient(launchAvailability('awaiting')), true, 'not connected yet is still their plan');
  });

  test('a client with a second service keeps the full workspace', () => {
    assert.equal(isLaunchClient({ ...launchAvailability(), estimates: mod('awaiting') }), false);
    assert.equal(isLaunchClient({ ...launchAvailability(), reviews: mod('live') }), false);
  });

  test('a client without lead capture, or with nothing known, is not one', () => {
    assert.equal(isLaunchClient(launchAvailability('unavailable')), false);
    assert.equal(isLaunchClient(null), false);
    assert.equal(isLaunchClient({}), false);
  });

  test('the workspace reads it off availability, and only the demo asks for it outright', () => {
    assert.match(read('src/portal/components/Workspace.jsx'), /const owner = ownerProp \?\? isLaunchClient\(data\.availability\);/);
    assert.match(read('src/portal/pages/Demo.jsx'), /\n\s+owner\r?\n/);
    assert.doesNotMatch(read('src/portal/pages/Portal.jsx'), /\bowner\b/);
  });
});

/* ── the map ────────────────────────────────────────────── */

describe('four screens, and no page removed', () => {
  test('the four are this month, jobs, needs you and account, in that order', () => {
    assert.deepEqual(OWNER_NAV_ITEMS.map((item) => item.label), ['this month', 'jobs', 'needs you', 'account']);
    assert.deepEqual(OWNER_NAV_ITEMS.map((item) => item.to), ['', 'jobs', 'needs-you', 'account']);
    assert.equal(OWNER_NAV_GROUPS.length, 1);
  });

  test('each says what it is for, and has a glyph that exists', () => {
    const icons = read('src/portal/components/Icon.jsx');
    for (const item of OWNER_NAV_ITEMS) {
      assert.ok(item.title && item.blurb.length >= 12 && item.short, item.label);
      assert.match(icons, new RegExp(`\\b${item.icon}:`), item.icon);
    }
  });

  test('the original map is untouched: still thirteen pages', () => {
    assert.equal(NAV_ITEMS.length, 13);
    assert.equal(NAV_ITEMS[0].label, 'overview');
  });

  test('every original page still has an address of its own in an owner workspace', () => {
    const original = OWNER_ALL_ITEMS.slice(OWNER_NAV_ITEMS.length);
    assert.deepEqual(original.map((item) => item.title), NAV_ITEMS.map((item) => item.title));
    assert.equal(new Set(OWNER_ALL_ITEMS.map((item) => item.to)).size, OWNER_ALL_ITEMS.length, 'no two pages share an address');

    const routes = read('src/portal/components/Workspace.jsx').split('{owner ? (')[1].split(') : (')[0];
    for (const item of OWNER_ALL_ITEMS) {
      if (item.to === '') assert.match(routes, /<Route index /);
      else assert.ok(routes.includes(`path="${item.to}"`), `owner route for ${item.to}`);
    }
  });

  test('only two pages moved, and a pasted link to a hidden page gets its own title', () => {
    const moved = NAV_ITEMS.filter((item, index) => OWNER_ALL_ITEMS[OWNER_NAV_ITEMS.length + index].to !== item.to);
    assert.deepEqual(moved.map((item) => item.label), ['overview', 'account']);
    const at = (rest) => activeItem(`/demo${rest}`, '/demo', OWNER_ALL_ITEMS).title;
    assert.equal(at(''), 'this month');
    assert.equal(at('/jobs'), 'jobs');
    assert.equal(at('/needs-you'), 'needs you');
    assert.equal(at('/account'), 'account');
    assert.equal(at('/account/details'), 'account & configuration');
    assert.equal(at('/overview'), 'overview');
    assert.equal(at('/inbox'), 'lead inbox & pipeline');
    assert.equal(at('/reliability'), 'reliability');
  });

  test('details offers the machine pages, and not the inbox or a service they have not bought', () => {
    const tos = OWNER_DETAIL_ITEMS.map((item) => item.to);
    assert.deepEqual(tos, ['overview', 'leads', 'activity', 'automations', 'reliability', 'reports', 'account/details']);
    for (const hidden of ['inbox', 'estimates', 'reviews', 'memberships', 'installs']) assert.equal(tos.includes(hidden), false);
  });
});

/* ── jobs ───────────────────────────────────────────────── */

describe('jobs', () => {
  test('in the demo they are the seven examples, with the verdicts they already carry', () => {
    const jobs = ownerJobs(demoData());
    assert.equal(jobs.example, true);
    assert.equal(jobs.jobs.length, 7);
    assert.equal(jobs.tally.counts, 1);
    assert.equal(jobs.jobs[0].verdict.status, 'counts');
  });

  test('a real lead is never marked as counting, and never billed', () => {
    const jobs = ownerJobs(liveData());
    assert.equal(jobs.example, false);
    assert.equal(jobs.tally.counts, null, 'not a zero: nothing may be counted yet');
    for (const job of jobs.jobs) {
      assert.notEqual(job.verdict.status, 'counts');
      assert.equal(job.verdict.billed, false);
    }
    assert.equal(jobs.jobs[0].verdict.reason, NOT_COUNTED_YET);
  });

  test('a real lead shows the same seven lines, and only what the record holds', () => {
    const [booked, handed] = ownerJobs(liveData()).jobs;
    const labels = buildProofLedger().leads[0].record.map((line) => line.label);
    assert.deepEqual(booked.record.map((line) => line.label), labels);
    assert.equal(booked.record[3].held, true);
    assert.equal(booked.record[6].held, null, 'the owner has not been asked');
    assert.equal(handed.verdict.status, 'handed');
    assert.match(handed.record[5].value, /handed to you — smelled gas/);
    assert.equal(handed.title, '••• ••• 0101', 'no name: the number is masked, not printed');
  });

  test('a text that failed is the gap, not a sent text', () => {
    const [job] = ownerJobs(liveData({ threads: [lead({ failed: true, latencyMs: null })] })).jobs;
    assert.equal(job.record[3].held, false);
  });

  test('the export is the jobs screen as a table', () => {
    const { jobs } = ownerJobs(demoData());
    const { columns, rows } = jobsTable(jobs);
    assert.equal(rows.length, 7);
    assert.deepEqual(columns.map((c) => c.label).slice(-3), ['status', 'billed', 'why']);
    assert.equal(columns.length, 1 + 7 + 3);
    assert.equal(columns.at(-2).value(rows[0]), 'yes');
    assert.equal(columns.at(-2).value(rows[1]), 'no');
    assert.deepEqual(jobsTable([]).columns.map((c) => c.label), ['job', 'status', 'billed', 'why']);
  });
});

/* ── this month ─────────────────────────────────────────── */

describe('this month', () => {
  const byKey = (month, key) => month.figures.find((figure) => figure.key === key);

  test('in the demo the figures are counted from the seven examples', () => {
    const month = ownerMonth(demoData(), monthOptions);
    assert.equal(month.example, true);
    assert.equal(byKey(month, 'brought_back').value, 1);
    assert.equal(byKey(month, 'waiting').value, 2);
    assert.deepEqual(month.proven.map((row) => row.value), [7, 7, 6, 1]);
  });

  test('the fee is never a number here — a dash and the reason', () => {
    for (const data of [demoData(), liveData()]) {
      const fee = byKey(ownerMonth(data, monthOptions), 'fee');
      assert.equal(fee.value, null);
      assert.equal(fee.available, false);
      assert.equal(fee.note, 'your pilot terms are not entered yet');
    }
    const entered = byKey(ownerMonth(liveData(), { ...monthOptions, terms: { monthlyBase: 1, perRecoveredJob: 1, monthlyCap: 1 } }), 'fee');
    assert.equal(entered.value, null);
    assert.match(entered.note, /proof rules/);
  });

  test('a signed-in client’s jobs brought back is unavailable, not zero', () => {
    const month = ownerMonth(liveData(), monthOptions);
    assert.equal(byKey(month, 'brought_back').value, null);
    assert.equal(byKey(month, 'waiting').value, 1);
    assert.deepEqual(month.proven.map((row) => row.value), [2, 2, 1, 1]);
  });

  test('a line that is not connected shows no figure at all', () => {
    const month = ownerMonth(liveData({ availability: launchAvailability('awaiting') }), monthOptions);
    for (const figure of month.figures) assert.equal(figure.value, null, figure.key);
    assert.equal(month.proven, null);
    assert.equal(month.leaks[0].running, false);
  });

  test('one card per leak, and only the first can be running', () => {
    const month = ownerMonth(liveData(), monthOptions);
    assert.equal(month.leaks.length, site.leaks.items.length);
    assert.deepEqual(month.leaks.map((leak) => leak.running), [true, false, false, false]);
    assert.equal(month.leaks[1].status, site.leaks.items[1].status);
  });
});

/* ── needs you ──────────────────────────────────────────── */

describe('needs you', () => {
  test('in the demo: one outcome question and one handoff', () => {
    const needs = ownerNeeds(demoData());
    assert.equal(needs.total, 2);
    assert.deepEqual(needs.groups.map((group) => [group.key, group.items.length]), [['outcome', 1], ['handoff', 1]]);
  });

  test('signed in, it is the attention queue, sorted into kinds', () => {
    const data = liveData();
    data.attention.items.push({ key: 'k2', reasonKey: 'unacknowledged', customer: 'Sam', reason: 'routed, nobody picked it up' });
    const needs = ownerNeeds(data);
    assert.equal(needs.total, 2);
    assert.deepEqual(needs.groups.map((group) => group.key), ['handoff', 'other']);
  });

  test('nothing waiting is an empty list, with no group drawn', () => {
    assert.deepEqual(ownerNeeds(liveData({ attention: { total: 0, items: [] } })).groups, []);
  });
});

/* ── account ────────────────────────────────────────────── */

describe('the account screen’s settings', () => {
  const config = leadRecoveryConfig();
  const stop = [{ channel: 'sms', address: '+16145550142', reason: 'opt_out', created_at: '2026-10-01T00:00:00Z' }];

  test('no address leaves whole', () => {
    const view = accountSettingsView(config, stop);
    const json = JSON.stringify(view);
    assert.doesNotMatch(json, /\+1614555/);
    assert.equal(view.alerts[0].address_hint, 'number ending 0188');
    assert.equal(view.stop_list.entries[0].address_hint, 'number ending 0142');
    assert.equal(addressHint('email', 'office@halstead.example'), 'o•••@ha•••');
    assert.equal(addressHint('sms', ''), 'not set');
  });

  test('it is a projection: nothing but the owner’s own settings', () => {
    const view = accountSettingsView(config, stop);
    assert.deepEqual(Object.keys(view).sort(), ['after_hours', 'alerts', 'available', 'hours', 'service_area', 'stop_list', 'timezone', 'versions']);
    const json = JSON.stringify(view);
    for (const withheld of ['template', 'twilio', 'MG0123', 'forwarding', 'compliance', 'CMP123', 'emergency_keywords']) {
      assert.equal(json.includes(withheld), false, withheld);
    }
  });

  test('hours read as an owner would say them', () => {
    const lines = hoursLines(accountSettingsView({ business_hours: { mon: [{ open: '07:30', close: '17:00' }], sun: [] } }, []));
    assert.equal(lines.length, 7);
    assert.deepEqual(lines[0], { day: 'monday', open: true, words: '7:30 am – 5:00 pm' });
    assert.deepEqual(lines[6], { day: 'sunday', open: false, words: 'closed' });
  });

  test('the stop list carries its true count and only the newest page', () => {
    const many = Array.from({ length: STOP_LIST_SHOWN + 5 }, (_, i) => ({ channel: 'sms', address: `+1614555${String(1000 + i)}`, reason: 'opt_out', created_at: null }));
    const view = accountSettingsView(config, many, { stopTotal: 400 });
    assert.equal(view.stop_list.entries.length, STOP_LIST_SHOWN);
    assert.equal(view.stop_list.total, 400);
  });

  test('every out-of-hours setting and every stop reason has words', () => {
    assert.deepEqual(Object.keys(AFTER_HOURS_WORDS).sort(), [...AFTER_HOURS_BEHAVIOURS].sort());
    const sql = read('supabase/migrations/0010_lead_recovery.sql');
    const reasons = /create table if not exists public\.suppressions[\s\S]*?reason in \(([\s\S]*?)\)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map((r) => r.slice(1, -1));
    assert.deepEqual(Object.keys(STOP_REASON_WORDS).sort(), reasons.sort());
  });

  test('the demo’s settings come through the same projection', () => {
    const view = buildDemoAccountSettings();
    assert.equal(view.available, true);
    assert.doesNotMatch(JSON.stringify(view), /\+1614555|office@/);
    assert.equal(view.stop_list.total, 2);
  });
});

describe('reading a client’s settings', () => {
  const deps = (store, rows = []) => ({ config: store, stopList: async () => ({ rows, total: rows.length }) });
  const member = (tenantId) => ({ kind: 'client_user', userId: 'u1', tenantId, role: 'owner' });
  const seeded = () => {
    const store = new MemoryStore();
    seedPublishedConfig(store, { tenantId: TENANT_A, config: leadRecoveryConfig() });
    return store;
  };

  test('nobody signed in is refused', async () => {
    assert.equal((await readAccountSettings(deps(seeded()), null, TENANT_A)).code, 'unauthorized');
  });

  test('a member of another client is refused before anything is read', async () => {
    let read = 0;
    const d = { config: seeded(), stopList: async () => { read += 1; return { rows: [], total: 0 }; } };
    const outcome = await readAccountSettings(d, member(TENANT_B), TENANT_A);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'forbidden');
    assert.equal(read, 0);
    assert.equal((await readAccountSettings(d, { kind: 'system' }, TENANT_A)).code, 'forbidden');
    assert.equal((await readAccountSettings(d, member(TENANT_A), 'not-an-id')).code, 'invalid');
  });

  test('a member reads the published settings, and an operator can too', async () => {
    const rows = [{ channel: 'sms', address: '+16145550142', reason: 'opt_out', created_at: null }];
    for (const actor of [member(TENANT_A), { kind: 'operator', userId: 'op' }]) {
      const outcome = await readAccountSettings(deps(seeded(), rows), actor, TENANT_A);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.result.available, true);
      assert.equal(outcome.result.timezone, 'America/New_York');
      assert.deepEqual(outcome.result.service_area.zips, ['43215']);
      assert.deepEqual(outcome.result.versions, { tenant: 1, module: 1 });
      assert.equal(outcome.result.stop_list.total, 1);
    }
  });

  test('nothing published is an answer with a reason, not an error and not a default', async () => {
    const outcome = await readAccountSettings(deps(new MemoryStore()), member(TENANT_A), TENANT_A);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.available, false);
    assert.ok(outcome.result.reason.length > 20);
    assert.equal('hours' in outcome.result, false);
  });

  test('the client’s door offers the read and nothing that writes settings', () => {
    const door = read('supabase/functions/crm/index.ts');
    assert.match(door, /const ACCOUNT_ACTION = 'account-settings';/);
    assert.match(door, /readAccountSettings\(/);
    const service = read('supabase/functions/_shared/account/service.ts');
    assert.doesNotMatch(service, /\.(insert|update|upsert|delete|rpc)\(/);
  });
});

/* ── the rendered screens ───────────────────────────────── */

async function loadPages() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import ThisMonth from './src/portal/pages/dash/ThisMonth.jsx';",
        "import Jobs from './src/portal/pages/dash/Jobs.jsx';",
        "import NeedsYou from './src/portal/pages/dash/NeedsYou.jsx';",
        "import OwnerAccount from './src/portal/pages/dash/OwnerAccount.jsx';",
        "import OwnerTabs from './src/portal/components/OwnerTabs.jsx';",
        'const PAGES = { ThisMonth, Jobs, NeedsYou, OwnerAccount, OwnerTabs };',
        'export const render = (name, props) => renderToStaticMarkup(createElement(MemoryRouter, null,',
        '  createElement(PAGES[name], props)));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.woff2': 'empty' },
    define: { 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-portal-'));
  const file = path.join(dir, 'pages.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadPages();
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

describe('the four screens, rendered', () => {
  const demo = { data: demoData(), base: '/demo', live: false };
  const live = { data: liveData(), base: '/portal/dashboard', live: false };

  test('this month prints a dash and the reason for the fee, in the demo and signed in', () => {
    for (const props of [demo, live]) {
      const html = render('ThisMonth', props);
      assert.match(html, /fee owed<\/span><span class="ws-stat__value"><span aria-hidden="true">—<\/span><span class="ws-sr">not available<\/span>/);
      assert.match(html, /your pilot terms are not entered yet/);
    }
  });

  test('signed in, jobs brought back is a dash — and the demo says its figures are examples', () => {
    assert.match(render('ThisMonth', live), /jobs brought back<\/span><span class="ws-stat__value"><span aria-hidden="true">—/);
    assert.match(render('ThisMonth', demo), /example figures, counted from seven example leads/);
    assert.doesNotMatch(render('ThisMonth', live), /example/);
  });

  test('the jobs screen is the proof ledger in the demo, and never says a real lead counts', () => {
    assert.match(render('Jobs', demo), /example 1 of 7/);
    const html = render('Jobs', live);
    assert.match(html, /lead 1 of 2/);
    assert.doesNotMatch(html, /example/);
    assert.doesNotMatch(html, /ws-pill--ok/);
    assert.match(html, /not switched on yet/);
  });

  test('needs you shows the question and how to answer it, with no button that does nothing', () => {
    const html = render('NeedsYou', demo);
    assert.match(html, /did the job happen\?/);
    assert.match(html, /answering from this screen is not switched on yet/);
    assert.doesNotMatch(html, /<button/);
    assert.match(render('NeedsYou', { ...live, data: liveData({ attention: { total: 0, items: [] } }) }), /nothing needs you/);
  });

  test('account shows the example settings in the demo, and the reason when there are none', () => {
    const html = render('OwnerAccount', demo);
    assert.match(html, /7:30 am – 5:00 pm/);
    assert.match(html, /number ending 0188/);
    assert.match(html, /export my data/);
    assert.match(html, /example settings for a made-up company/);
    const none = render('OwnerAccount', live);
    assert.match(none, /<span class="ws-sr">not available\. <\/span>settings are only shown for a signed-in account\./);
    assert.doesNotMatch(none, /7:30 am/);
  });

  test('account → details links every page it lists', () => {
    const html = render('OwnerAccount', demo);
    for (const item of OWNER_DETAIL_ITEMS) assert.ok(html.includes(`href="/demo/${item.to}"`), item.to);
  });

  test('the first three screens are written in an owner’s words', () => {
    for (const props of [demo, live]) {
      for (const page of ['ThisMonth', 'Jobs', 'NeedsYou']) {
        assert.equal(ownerCopyProblem(plain(render(page, props))), null, `${page} (${props.base})`);
      }
    }
  });

  test('the phone’s tab bar is the same four, with a count on needs you', () => {
    const html = render('OwnerTabs', { base: '/demo', items: OWNER_NAV_ITEMS, counts: { 'needs-you': 2 } });
    assert.match(html, /<nav class="ow-tabs" aria-label="your four screens">/);
    assert.equal([...html.matchAll(/<a /g)].length, 4);
    assert.match(html, /2<span class="ws-sr"> waiting<\/span>/);
  });

  test('buttons on the four screens are thumb-sized', () => {
    assert.match(read('src/portal/pages/dash/Owner.css'), /\.ow-tap \{\s*min-height: 48px;/);
    for (const page of ['ThisMonth', 'NeedsYou', 'OwnerAccount']) {
      const html = render(page, demo);
      for (const [tag] of html.matchAll(/<(?:a|button)[^>]*class="ws-btn[^"]*"/g)) assert.match(tag, /ow-tap/, `${page}: ${tag}`);
    }
  });
});

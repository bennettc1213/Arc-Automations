/* The portal and console clarity pass: the words are explained, the controls are reachable
 * and named, what a button will do is on the page before it is pressed, and a dash still is
 * not a zero.
 *
 * Three kinds of check:
 *   - the glossary and `consequenceOf`, as plain functions;
 *   - the source of the shell and the pages, read as text — every confirmation in the portal
 *     is found and held to the rule, so a new one cannot quietly skip it;
 *   - the real components rendered to static markup (esbuild, already here as vite's own
 *     dependency), for what a screen reader is actually given.
 *
 * What this pass may not do is tested too: it adds words and names, and removes nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { consequenceOf, GLOSSARY, glossFor } from '../src/portal/lib/glossary.js';
import { NAV_GROUPS, NAV_ITEMS } from '../src/portal/lib/nav.js';
import { OPS_NAV_GROUPS, OPS_NAV_ITEMS } from '../src/portal/lib/ops-nav.js';
import { HEALTH_STATUSES, LIFECYCLE_STATES } from '../supabase/functions/_shared/lifecycle/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

function portalFiles(dir = 'src/portal', out = []) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) portalFiles(rel, out);
    else if (/\.jsx$/.test(name)) out.push(rel);
  }
  return out;
}

/* ── the glossary ───────────────────────────────────────── */

describe('the glossary', () => {
  test('every state a module can be in, and every health it can have, is explained', () => {
    for (const state of LIFECYCLE_STATES) assert.ok(glossFor(state), `lifecycle state ${state}`);
    for (const status of HEALTH_STATUSES) assert.ok(glossFor(status), `health status ${status}`);
    /* the client side's own states (lib/health.js), which are not the operator's five. */
    const health = read('src/portal/lib/health.js');
    const words = /const STATE_WORD = \{([\s\S]*?)\};/.exec(health)[1];
    for (const [, state] of words.matchAll(/^\s*([a-z_]+):/gm)) {
      if (state === 'unavailable') continue; // never drawn as a pill: the nav filters it out
      assert.ok(glossFor(state), `health.js state ${state}`);
    }
  });

  test('a gloss is short, plain, and names no internals', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      assert.ok(entry.label && entry.gloss, key);
      assert.ok(entry.gloss.length <= 220, `${key} is ${entry.gloss.length} characters`);
      assert.match(entry.gloss, /^[A-Z].*\.$/s, `${key} is a sentence`);
      assert.doesNotMatch(entry.gloss, /\bn8n\b|\bRLS\b|\bARC-\d|postgres|supabase|webhook|idempot|\btenant\b|JSON|`/i, key);
    }
  });

  test('it does not rename what the system calls a state', () => {
    for (const state of LIFECYCLE_STATES) assert.equal(GLOSSARY[state].label, state);
    /* "not verified" is lib/health.js's own word for the client; the gloss keeps both honest halves. */
    assert.match(GLOSSARY.unverified.gloss, /not a failure/);
    assert.match(GLOSSARY.unverified.gloss, /not a pass/);
    assert.match(GLOSSARY.awaiting.gloss, /dash rather than a zero/);
    assert.match(GLOSSARY.paused.gloss, /never resumes on its own/);
    assert.match(GLOSSARY.shadow.gloss, /sends nothing/);
  });

  test('an unknown word has no gloss, rather than a guess', () => {
    assert.equal(glossFor('made_up'), null);
    assert.equal(glossFor('toString'), null);
    assert.equal(glossFor('constructor'), null);
  });
});

/* ── context before consequence ─────────────────────────── */

describe('what a button will do is said before it is pressed', () => {
  test('consequenceOf takes the half of a confirmation that is not the question', () => {
    assert.equal(consequenceOf('pause this module? no new live run starts.'), 'no new live run starts.');
    assert.equal(consequenceOf('this switches on live texting. continue?'), 'this switches on live texting.');
    assert.equal(consequenceOf('activate Lead Recovery?\n\nfirst line\nsecond line'), 'first line second line');
    assert.equal(consequenceOf('restore v3 as the new live version?'), null);
    assert.equal(consequenceOf('no question here'), null);
    assert.equal(consequenceOf(undefined), null);
    assert.equal(consequenceOf(null), null);
  });

  test('ActionButton prints it on the page and keeps the confirmation exactly as it was', () => {
    const source = read('src/portal/components/ops-ui.jsx');
    assert.match(source, /if \(confirm && !window\.confirm\(confirm\)\) return;/, 'the gate is unchanged');
    assert.match(source, /const why = consequence === false \? null : consequence \?\? consequenceOf\(confirm\);/);
    assert.match(source, /aria-describedby=\{why \? whyId : undefined\}/);
    assert.match(source, /className="ops-action__why" id=\{whyId\}/);
  });

  test('every confirmation in the portal has a consequence: its own second half, or one written out', () => {
    let found = 0;
    for (const file of portalFiles()) {
      const source = read(file);
      for (const match of source.matchAll(/\bconfirm=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        found += 1;
        const text = (match[1] ?? match[2]).replace(/\$\{[^}]*\}/g, 'x');
        if (consequenceOf(text)) continue;
        /* a confirmation that is only a question: the button says the consequence itself. */
        const after = source.slice(match.index, match.index + 900);
        assert.match(after, /^\S*confirm=[^\n]*\n\s*consequence=/, `${file}: "${text}" has no consequence`);
      }
    }
    assert.ok(found >= 10, `found ${found} literal confirmations`);
    /* nobody turns the note off without the panel saying it instead. */
    for (const file of portalFiles()) {
      if (file.endsWith('/ops-ui.jsx')) continue; // where the prop is defined and documented
      assert.doesNotMatch(read(file), /consequence=\{false\}/, file);
    }
  });

  test('the two that cannot be taken back still ask for the name to be typed', () => {
    const purge = read('src/portal/components/PurgeClientPanel.jsx');
    assert.match(purge, /const confirmed = typed\.trim\(\) === tenant\.slug;/);
    assert.match(purge, /disabled=\{!confirmed \|\| state\.kind === 'busy'\}/);
    assert.match(purge, /<Consequence tone="danger">\s*this cannot be undone\./);
    const detail = read('src/portal/pages/ops/ClientDetail.jsx');
    assert.match(detail, /const confirmed = typed\.trim\(\)\.toLowerCase\(\) === tenant\.name\.trim\(\)\.toLowerCase\(\);/);
    assert.match(detail, /const ready = Boolean\(reason\) && confirmed && state\.kind !== 'busy';/);
  });
});

/* ── the shell ──────────────────────────────────────────── */

describe('the shared shell', () => {
  const sidebar = read('src/portal/components/Sidebar.jsx');
  const topbar = read('src/portal/components/Topbar.jsx');
  const client = read('src/portal/components/Workspace.jsx');
  const ops = read('src/portal/components/OpsWorkspace.jsx');

  test('the two workspaces keep two nav declarations, and share no section name', () => {
    assert.notEqual(NAV_GROUPS, OPS_NAV_GROUPS);
    const mine = new Set(NAV_GROUPS.map((g) => g.label));
    for (const group of OPS_NAV_GROUPS) assert.equal(mine.has(group.label), false, group.label);
    assert.match(ops, /groups=\{OPS_NAV_GROUPS\}/);
    assert.match(ops, /navLabel="ops console sections"/);
    assert.match(sidebar, /navLabel = 'portal sections'/);
    assert.doesNotMatch(client, /OPS_NAV/);
  });

  test('every page in either nav still says what it is for', () => {
    for (const item of [...NAV_ITEMS, ...OPS_NAV_ITEMS]) {
      assert.ok(item.label && item.title && item.icon, item.to);
      assert.ok(item.blurb && item.blurb.length >= 12, `${item.label} has a blurb`);
    }
    assert.equal(NAV_ITEMS.length, 13, 'no client page was removed (the lead inbox, ARC-360, made thirteen)');
    assert.equal(OPS_NAV_ITEMS.length, 10, 'no console page was removed');
  });

  test('both workspaces start with a skip link to the same page landmark', () => {
    for (const source of [client, ops]) {
      assert.match(source, /<a className="ws-skip" href=\{`#\$\{PAGE_ID\}`\} onClick=\{skipToPage\}>/);
      assert.match(source, /<main className="ws__page" id=\{PAGE_ID\} tabIndex=\{-1\}>/);
      assert.ok(source.indexOf('ws-skip') < source.indexOf('<Sidebar'), 'the skip link comes before the rail');
    }
  });

  test('an icon-only button has a name, not only a tooltip', () => {
    let checked = 0;
    for (const [name, source] of [['Sidebar', sidebar], ['Topbar', topbar], ['OpsWorkspace', ops]]) {
      /* an opening tag ends at the `>` that closes a line; a `>` inside an attribute does not. */
      for (const match of source.matchAll(/<button\b[\s\S]*?>\r?\n/g)) {
        const kind = /className=(?:"|\{`)(ws-top__menu|ws-top__icon|ws-top__avatar|ws-rail__collapse)\b/.exec(match[0]);
        if (!kind) continue;
        checked += 1;
        assert.match(match[0], /aria-label=/, `${name}: ${kind[1]}`);
      }
    }
    assert.equal(checked, 5, 'menu, bell, account, collapse and the console\'s reload');
    assert.match(topbar, /aria-label=\{badge > 0 \? `alerts — \$\{badge\} open` : 'alerts — none open'\}/);
  });

  test('the quiet text is readable on every surface the workspaces draw on', () => {
    const base = read('src/styles/base.css');
    const workspace = read('src/portal/workspace.css');
    const token = (css, name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)[1];
    const faint = /\.portal\.ws \{\s*--faint:\s*(#[0-9a-f]{6})/i.exec(workspace)[1];
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    for (const surface of ['bg', 'bg-2', 'surface', 'surface-2']) {
      assert.ok(ratio(faint, token(base, surface)) >= 4.5, `--faint on --${surface} is ${ratio(faint, token(base, surface)).toFixed(2)}:1`);
    }
    assert.ok(luminance(faint) < luminance(token(base, 'muted')), 'and it stays quieter than --muted');
  });
});

/* ── what a screen reader is given ──────────────────────── */

async function loadComponents() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement as h } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import { Term, Consequence } from './src/portal/components/ui.jsx';",
        "import { ModuleStat, ModuleGate } from './src/portal/components/ModuleUI.jsx';",
        "import ModuleHealth from './src/portal/components/ModuleHealth.jsx';",
        "import Sidebar from './src/portal/components/Sidebar.jsx';",
        "import Topbar from './src/portal/components/Topbar.jsx';",
        "import { ActionButton } from './src/portal/components/ops-ui.jsx';",
        'const C = { Term, Consequence, ModuleStat, ModuleGate, ModuleHealth, Sidebar, Topbar, ActionButton };',
        /* the router's links use a layout effect, and react says so once per link when
           rendering to a string. that is noise here, not a finding. */
        'export const render = (name, props, children) => {',
        '  const error = console.error;',
        '  console.error = (...args) => { if (!/useLayoutEffect does nothing on the server/.test(String(args[0]))) error(...args); };',
        '  try { return renderToStaticMarkup(h(MemoryRouter, null, h(C[name], props, children))); } finally { console.error = error; }',
        '};',
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
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'ux-clarity-'));
  const file = path.join(dir, 'components.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadComponents();

describe('rendered', () => {
  test('a term prints the system\'s word, reachable by keyboard, described by its gloss', () => {
    const html = render('Term', { k: 'shadow' });
    const id = /aria-describedby="([^"]+)"/.exec(html)[1];
    assert.match(html, /^<span class="ws-term" tabindex="0" aria-describedby="[^"]+">shadow<span/);
    assert.match(html, new RegExp(`<span class="ws-term__tip" role="tooltip" id="${id}">A dry run on real leads`));
    /* the caller's own wording wins over the glossary's label; the gloss is the same. */
    assert.match(render('Term', { k: 'unverified' }, 'not verified'), />not verified<span class="ws-term__tip"/);
    /* a word nobody explained is plain text, with no underline promising an explanation. */
    assert.equal(render('Term', { k: 'nonsense' }, 'nonsense'), 'nonsense');
  });

  test('a figure that is not known is a dash, a spoken "not available", and the reason — never a zero', () => {
    const html = render('ModuleStat', { label: 'recovered', value: 0, available: false, unavailable: 'your CRM is not connected yet' });
    assert.match(html, /<span aria-hidden="true">—<\/span><span class="ws-sr">not available<\/span>/);
    assert.match(html, /<span class="ws-stat__unavail">your CRM is not connected yet<\/span>/);
    assert.doesNotMatch(html, />0</);
    /* and a real zero is still a zero. */
    assert.match(render('ModuleStat', { label: 'recovered', value: 0 }), /<span class="ws-stat__value">0<\/span>/);
  });

  test('a module that is not connected says so, with the gloss, and still refuses to show a zero', () => {
    const html = render('ModuleGate', { module: { state: 'awaiting', label: 'estimates', awaiting: 'waiting on your CRM' } }, 'figures');
    assert.match(html, /awaiting connection<span class="ws-term__tip"/);
    assert.match(html, /nothing is shown above as zero/);
    assert.doesNotMatch(html, /figures/);
    assert.equal(render('ModuleGate', { module: { state: 'live', label: 'estimates' } }, 'figures'), 'figures');
    assert.match(render('ModuleGate', { module: { state: 'unavailable', label: 'estimates' } }, 'figures'), /this is not part of your plan/);
  });

  test('module health keeps its own words and its own states, each now explained', () => {
    const module = (state, word) => ({ key: state, label: state, state, word, summary: 's', checks: [], verified: false, lastSuccessAt: null, lastCheckAt: null });
    const html = render('ModuleHealth', {
      timezone: 'America/Denver',
      health: {
        a: module('unverified', 'not verified'), b: module('healthy', 'working'), c: module('quiet', 'quiet'),
        d: module('awaiting', 'awaiting connection'), e: module('unavailable', 'not set up'),
      },
    });
    assert.match(html, /is-unverified[\s\S]*?ws-pill--idle[\s\S]*?>not verified<span class="ws-term__tip"[^>]*>It may be working, but nothing independent has proved it yet/);
    assert.match(html, /ws-pill--ok[\s\S]*?>working<span class="ws-term__tip"/);
    assert.doesNotMatch(html, /not set up/, 'a module that is not part of the plan is still left out');
    assert.match(html, /a workflow finishing without an error is not\s+evidence/);
  });

  test('the rail: a named landmark, and a status that is still a word when it is collapsed', () => {
    const props = { base: '/portal/dashboard', tenantName: 'Acme', status: { status: 'degraded' }, onToggleCollapse() {} };
    const open = render('Sidebar', { ...props, collapsed: false });
    assert.match(open, /<nav class="ws-rail" aria-label="portal sections">/);
    assert.match(open, /<span>degraded<\/span>/);
    const tight = render('Sidebar', { ...props, collapsed: true, navLabel: 'ops console sections' });
    assert.match(tight, /<nav class="ws-rail" aria-label="ops console sections">/);
    assert.match(tight, /<span class="ws-sr">status: degraded<\/span>/);
    assert.match(tight, /aria-label="expand sidebar"/);
    /* collapsed, every link still carries its label and what the page is for. */
    assert.match(tight, /title="overview — the lifecycle, what needs you, and whether it is all running"/);
    assert.equal([...tight.matchAll(/class="ws-nav__caption"/g)].length, NAV_ITEMS.length);
  });

  test('the top bar: every icon-only control is named, and the bell says how many', () => {
    const html = render('Topbar', {
      title: 'overview', timezone: 'America/Denver', email: 'pat@example.com',
      incidents: [{ id: 1, open: true, checkType: 'canary', message: 'm', firedAt: '2026-10-01T00:00:00Z' }],
    });
    assert.match(html, /class="ws-top__menu" aria-label="open navigation"/);
    assert.match(html, /aria-haspopup="true" aria-label="alerts — 1 open"/);
    assert.match(html, /aria-label="account — signed in as pat@example.com"/);
    assert.match(render('Topbar', { title: 'overview', timezone: 'UTC' }), /aria-label="alerts — none open"/);
  });

  test('a button with a confirmation shows what it will do, and one without shows nothing extra', () => {
    const html = render('ActionButton', { confirm: 'revoke this token? anything posting with it stops being accepted immediately.', onRun() {} }, 'revoke');
    const id = /aria-describedby="([^"]+)"/.exec(html)[1];
    assert.match(html, new RegExp(`<span class="ops-action__why" id="${id}">anything posting with it stops being accepted immediately\\.</span>`));
    assert.doesNotMatch(render('ActionButton', { onRun() {} }, 'save'), /ops-action__why|aria-describedby/);
    assert.match(render('ActionButton', { confirm: 'sure?', consequence: 'it is gone.', onRun() {} }, 'go'), />it is gone\.</);
  });

  test('a consequence is labelled, and a name inside it stays a name', () => {
    assert.equal(render('Consequence', { tone: 'danger' }, 'this cannot be undone.'),
      '<p class="ws-consequence ws-consequence--danger"><b>what this does:</b> this cannot be undone.</p>');
    assert.match(read('src/portal/workspace.css'), /\.ws-consequence > b:first-child \{/);
  });
});

/* ── nothing was taken away ─────────────────────────────── */

describe('presentation only', () => {
  test('the derivation chain is not something this pass imports into or edits around', () => {
    /* the glossary and the a11y helper are leaves: they import nothing. */
    for (const file of ['src/portal/lib/glossary.js', 'src/portal/lib/a11y.js']) {
      assert.doesNotMatch(read(file), /^\s*import\b/m, file);
    }
    /* and none of the libraries a figure is derived by knows the glossary exists. */
    for (const file of ['lifecycle', 'modules', 'health', 'attention', 'ops', 'derive', 'metrics']) {
      assert.doesNotMatch(read(`src/portal/lib/${file}.js`), /glossary|a11y/, file);
    }
  });

  test('the roadmap assistant says which kind of reply each one is, and decides nothing new', () => {
    const source = read('src/portal/components/RoadmapAssistant.jsx');
    assert.match(source, /excerpts: 'quoted passages · the documents’ own words, nothing written by a model'/);
    assert.match(source, /answered: 'written answer · checked against the sources below'/);
    assert.match(source, /const note = STATUS_NOTE\[message\.status\];/);
    assert.doesNotMatch(source.slice(source.indexOf('const ANSWER_KIND'), source.indexOf('function Answer')), /unverified|not_in_roadmap/,
      'a withheld or absent answer is not relabelled');
  });
});

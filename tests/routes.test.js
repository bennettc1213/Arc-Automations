/* ARC-330 — the three routes: the vocabulary, the suggestion, and the section that asks.
 *
 * Since ARC-MK-100 the section is parked: it is not on the public homepage, because a cold
 * visitor is no longer asked to choose a route. The model, the component and these tests
 * are kept — onboarding uses the model, and the section can come back as it was.
 *
 * The model is tested as data. The section is rendered to static markup the way
 * `roadmap-ui.test.js` renders its panel — esbuild (already here, under Vite) compiles the
 * JSX into a throwaway bundle — so "all three routes render" is read off real output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { siteImpact } from '../scripts/site-impact.mjs';
import { site } from '../src/data/site.js';
import {
  ROUTES,
  ROUTE_COMPARISON,
  ROUTE_DISCOVERY,
  ROUTE_KEYS,
  ROUTE_PRINCIPLES,
  ROUTE_SUGGESTION_NOTICE,
  cleanDiscoveryAnswers,
  getRoute,
  isRouteKey,
  parseRouteKey,
  routeCopy,
  routeCopyProblem,
  routeModelProblems,
  suggestRoute,
} from '../supabase/functions/_shared/routes/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const ALL = { crm: 'partial', lead_tracking: 'partial', online_booking: 'no', follow_up: 'no', keep: 'some' };

/* ── the vocabulary ─────────────────────────────────────────────────── */

describe('the route model', () => {
  test('is exactly native, hybrid and connected, and validates', () => {
    assert.deepEqual([...ROUTE_KEYS], ['native', 'hybrid', 'connected']);
    assert.deepEqual(ROUTES.map((r) => r.name), ['ARC Native', 'ARC Hybrid', 'ARC Connected']);
    assert.deepEqual(routeModelProblems(), []);
  });

  test('a route key is read from loose input, and anything else is not a route', () => {
    assert.equal(parseRouteKey(' Hybrid '), 'hybrid');
    assert.equal(getRoute('connected').name, 'ARC Connected');
    for (const bad of ['', 'crm', 'native ', null, undefined, 3, {}, ['native']]) {
      assert.equal(isRouteKey(bad), false, String(bad));
      assert.equal(getRoute(bad), null);
    }
    assert.equal(parseRouteKey({ route: 'native' }), null);
  });

  test('every comparison row answers for every route, and some rows are the same on all three', () => {
    for (const row of ROUTE_COMPARISON) {
      assert.deepEqual(Object.keys(row.values).sort(), [...ROUTE_KEYS].sort(), row.key);
    }
    const shared = ROUTE_COMPARISON.filter((row) => new Set(Object.values(row.values)).size === 1).map((r) => r.key);
    assert.deepEqual(shared, ['automation', 'reporting']);
  });
});

describe('what the route copy promises', () => {
  const text = routeCopy().map((c) => c.text).join('\n');

  test('a company with no CRM is told, in words, that it can use ARC', () => {
    assert.ok(ROUTE_PRINCIPLES.includes('No CRM needed to start.'));
    assert.equal(getRoute('native').situation, 'We have no system yet');
    assert.match(getRoute('native').audience, /without a CRM/);
    assert.match(getRoute('native').summary, /There is nothing to buy first\./);
  });

  test('no line makes a CRM a condition, and none tells a mature company to give its systems up', () => {
    for (const { where, text: line } of routeCopy()) {
      assert.equal(routeCopyProblem(line), null, where);
      assert.doesNotMatch(line, /\b(requires? an?|must have an?|only works with) [^.]*\bCRM\b/i, where);
      assert.doesNotMatch(line, /\b(replace|migrate|switch from|abandon) your\b/i, where);
    }
    assert.match(getRoute('connected').summary, /Your system stays in charge/);
    assert.ok(ROUTE_PRINCIPLES.includes('Keep the tools that work.'));
  });

  test('every route gets the automation layer, and a route can change', () => {
    assert.match(text, /Same automation on every route\./);
    assert.match(text, /Switch routes later and keep your history\./);
  });

  test('it is written for an owner: short lines, and the one piece of jargon is explained where it is asked', () => {
    for (const r of ROUTES) {
      assert.ok(r.situation.split(' ').length <= 7, r.situation);
      assert.ok(r.summary.split(' ').length <= 26, `${r.key} summary is ${r.summary.split(' ').length} words`);
      assert.doesNotMatch(`${r.situation} ${r.summary} ${r.arcProvides.join(' ')}`, /\b(stack|pipeline|layer|orchestrat|source of truth|sync)\w*/i, r.key);
    }
    for (const p of ROUTE_PRINCIPLES) assert.ok(p.split(' ').length <= 8, p);
    assert.match(ROUTE_DISCOVERY[0].question, /software for tracking customers and jobs \(a CRM\)/);
  });

  test('the workflow runner is never named to a customer — in the model or in the section\'s own words', () => {
    assert.doesNotMatch(text, /n8n/i);
    assert.doesNotMatch(JSON.stringify(site.routes), /n8n/i);
    assert.doesNotMatch(read('src/components/YourRoute.jsx'), /n8n/i);
  });

  test('the check itself catches both failures', () => {
    assert.equal(routeCopyProblem('Log in to n8n and import the workflow'), 'names implementation infrastructure');
    assert.equal(routeCopyProblem('ARC requires a CRM'), 'makes a CRM a requirement');
    assert.equal(routeCopyProblem('You need to have a working CRM first'), 'makes a CRM a requirement');
    assert.equal(routeCopyProblem('  '), 'is empty');
    assert.equal(routeCopyProblem('You do not need to own a CRM to use ARC.'), null);
    assert.ok(Object.isFrozen(ROUTES) && Object.isFrozen(ROUTE_PRINCIPLES), 'the model cannot be edited at runtime');
  });
});

/* ── the suggestion ─────────────────────────────────────────────────── */

describe('route discovery', () => {
  test('asks five capability questions and names no product', () => {
    assert.deepEqual(ROUTE_DISCOVERY.map((q) => q.key), ['crm', 'lead_tracking', 'online_booking', 'follow_up', 'keep']);
    const words = ROUTE_DISCOVERY.flatMap((q) => [q.question, ...q.options.map((o) => o.label)]).join(' ');
    assert.doesNotMatch(words, /gohighlevel|jobber|servicetitan|housecall|hubspot|salesforce/i);
  });

  test('nothing answered is no suggestion, and neither is anything short of all five', () => {
    for (const raw of [undefined, null, {}, 'native', 7, [], [{ crm: 'none' }]]) {
      const s = suggestRoute(raw);
      assert.equal(s.route, null);
      assert.equal(s.complete, false);
      assert.equal(s.remaining.length, 5);
      assert.deepEqual(s.reasons, []);
    }
    const keys = Object.keys(ALL);
    for (const missing of keys) {
      const partial = { ...ALL };
      delete partial[missing];
      const s = suggestRoute(partial);
      assert.equal(s.route, null, `without ${missing}`);
      assert.deepEqual(s.remaining, [missing]);
    }
  });

  test('an answer nobody offered is ignored rather than counted', () => {
    const s = suggestRoute({ ...ALL, keep: 'sell the company', crm: 5, extra: 'x', __proto__: { crm: 'none' } });
    assert.equal(s.route, null);
    assert.deepEqual(s.remaining, ['crm', 'keep']);
    assert.deepEqual(Object.keys(cleanDiscoveryAnswers({ extra: 'x', route: 'native' })), []);
  });

  test('no CRM and nothing in place is Native', () => {
    const s = suggestRoute({ crm: 'none', lead_tracking: 'no', online_booking: 'no', follow_up: 'no', keep: 'everything' });
    assert.equal(s.route, 'native');
    assert.equal(s.complete, true);
    assert.match(s.reasons[0], /ARC provides them/);
  });

  test('wanting to start fresh is Native, whatever is there today', () => {
    const s = suggestRoute({ crm: 'established', lead_tracking: 'yes', online_booking: 'yes', follow_up: 'yes', keep: 'nothing' });
    assert.equal(s.route, 'native');
  });

  test('an established system kept whole is Connected, and its gaps are what ARC adds', () => {
    const s = suggestRoute({ crm: 'established', lead_tracking: 'yes', online_booking: 'yes', follow_up: 'no', keep: 'everything' });
    assert.equal(s.route, 'connected');
    assert.deepEqual(s.reasons, [
      'You have a system that works and want to keep all of it, so ARC connects to it.',
      'ARC adds on top of it: automated follow-up.',
    ]);
  });

  test('everything between is Hybrid — including no CRM but tools worth keeping', () => {
    assert.equal(suggestRoute(ALL).route, 'hybrid');
    assert.equal(suggestRoute({ ...ALL, crm: 'established' }).route, 'hybrid');
    const noCrm = suggestRoute({ crm: 'none', lead_tracking: 'no', online_booking: 'yes', follow_up: 'no', keep: 'everything' });
    assert.equal(noCrm.route, 'hybrid');
    assert.match(noCrm.reasons[0], /ARC provides the CRM/);
    assert.equal(noCrm.reasons[1], 'ARC can cover: lead tracking, automated follow-up.');
  });

  test('every combination of answers lands on a route with a reason', () => {
    const combos = ROUTE_DISCOVERY.reduce(
      (acc, q) => acc.flatMap((a) => q.options.map((o) => ({ ...a, [q.key]: o.value }))),
      [{}],
    );
    assert.equal(combos.length, 3 * 3 * 2 * 3 * 3);
    const seen = new Set();
    for (const answers of combos) {
      const s = suggestRoute(answers);
      assert.ok(isRouteKey(s.route), JSON.stringify(answers));
      assert.ok(s.reasons.length > 0);
      seen.add(s.route);
    }
    assert.deepEqual([...seen].sort(), [...ROUTE_KEYS].sort());
  });

  test('a suggestion is words on a page: the model imports nothing and writes nothing', () => {
    const source = read('supabase/functions/_shared/routes/model.ts');
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\bfetch\(|supabase|\.from\(|\.rpc\(|localStorage|sessionStorage/);
    assert.match(ROUTE_SUGGESTION_NOTICE, /Nothing is set up until we confirm it with you\./);
    const section = read('src/components/YourRoute.jsx');
    assert.doesNotMatch(section, /\bfetch\(|supabase-js|getSupabase|localStorage|sessionStorage/);
  });
});

/* ── the call to action ─────────────────────────────────────────────── */

describe('the route-aware call to action', () => {
  const events = [];
  globalThis.window = new EventTarget();
  const loaded = import('../src/lib/pilot.js').then((pilot) => {
    pilot.onOpenPilot((detail) => events.push(detail));
    return pilot;
  });

  test('opens the pilot intake carrying the route and how it was arrived at', async () => {
    const { openPilot } = await loaded;
    events.length = 0;
    openPilot(undefined, { route: 'native', routeSource: 'chosen' });
    openPilot(undefined, { route: 'hybrid', routeSource: 'assessment' });
    assert.deepEqual(events, [
      { key: undefined, route: 'native', routeSource: 'chosen' },
      { key: undefined, route: 'hybrid', routeSource: 'assessment' },
    ]);
  });

  test('every other "start a pilot" button still opens the plain intake', async () => {
    const { openPilot } = await loaded;
    events.length = 0;
    openPilot();
    openPilot('marketing-automation');
    openPilot({ type: 'click' }); // the nav passes its click event straight through
    openPilot(undefined, { route: 'enterprise', routeSource: 'assessment' });
    assert.deepEqual(events.map((e) => [e.route, e.routeSource]), Array(4).fill([null, null]));
    assert.equal(events[1].key, 'marketing-automation');
  });

  test('the note for the call says the route is still to be confirmed', async () => {
    const { routeNote } = await loaded;
    assert.equal(routeNote({ route: 'connected' }), 'route: ARC Connected (picked on the site, to confirm)');
    assert.equal(
      routeNote({ route: 'native', routeSource: 'assessment' }),
      'route: ARC Native (suggested by the route questions, to confirm)',
    );
    assert.equal(routeNote({ route: 'nope' }), null);
    assert.equal(routeNote(), null);
  });

  test('the intake sends the route with the lead, and to the same place as before', () => {
    const overlay = read('src/components/PilotOverlay.jsx');
    assert.match(overlay, /sendCapture\(\s*site\.pilot\.captureUrl,/);
    assert.match(overlay, /route: routeContext,/);
    const intake = read('src/lib/count-intake.js');
    assert.match(intake, /route: route\?\.route \?\? null,\s*\n\s*routeSource: route\?\.routeSource \?\? null,/);
  });

  test('analytics is names and keys on a window event — no vendor, no personal data', async () => {
    const { ROUTE_EVENTS, TRACK_EVENT, onTrack, track } = await import('../src/lib/track.js');
    const seen = [];
    const off = onTrack((detail) => seen.push(detail));
    track(ROUTE_EVENTS.cta, { route: 'native', source: 'chosen', name: 'overwritten' });
    off();
    track(ROUTE_EVENTS.reset);
    assert.deepEqual(seen, [{ route: 'native', source: 'chosen', name: 'route_cta_clicked' }]);
    assert.equal(TRACK_EVENT, 'arc-track');
    const source = read('src/lib/track.js');
    assert.doesNotMatch(source, /\bfetch\(|sendBeacon|https?:\/\//);
    const section = read('src/components/YourRoute.jsx');
    for (const name of Object.keys(ROUTE_EVENTS)) assert.ok(section.includes(`ROUTE_EVENTS.${name}`), name);
  });
});

/* ── what renders ───────────────────────────────────────────────────── */

async function loadSection() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import YourRoute from './src/components/YourRoute.jsx';",
        'export const render = (props) => renderToStaticMarkup(createElement(YourRoute, props));',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'your-route-'));
  const file = path.join(dir, 'section.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadSection();
const count = (html, re) => [...html.matchAll(re)].length;

describe('the route section', () => {
  const html = render({});

  test('is parked: off the public homepage and out of the nav, with the model still in use', () => {
    assert.doesNotMatch(read('src/Site.jsx'), /YourRoute/);
    assert.ok(!site.nav.links.some((l) => l.id === 'route'), 'no link to a section that is not there');
    const impact = siteImpact(['src/components/YourRoute.jsx', 'supabase/functions/_shared/routes/model.ts']);
    assert.deepEqual(impact.visible.map((v) => v.file), ['supabase/functions/_shared/routes/model.ts']);
    /* the intake still carries a route note when it is handed one, so the model is on '/' */
    assert.ok(impact.visible[0].routes.some((r) => r.path === '/' && r.access === 'public'));
  });

  test('is a labelled region with one heading', () => {
    assert.match(html, /^<section class="route wrap" id="route" aria-labelledby="route-title">/);
    assert.match(html, /<h2 class="section-title route__title" id="route-title">start from where you are\.<\/h2>/);
    assert.equal(count(html, /<h2\b/g), 1);
    assert.equal(count(html, /<button\b(?![^>]*type="button")/g), 0, 'no button without a type');
  });

  test('all three routes are offered as the owner would say them, with the route named underneath', () => {
    assert.match(html, /<div class="route__tabs" role="tablist" aria-label="pick the one that sounds like you">/);
    assert.equal(count(html, /role="tab"/g), 3);
    for (const r of ROUTES) {
      const tab = new RegExp(`<button type="button" role="tab" id="route-tab-${r.key}" aria-selected="(true|false)" aria-controls="route-panel" data-route="${r.key}"[^>]*>(.*?)</button>`).exec(html);
      assert.ok(tab, r.key);
      assert.ok(tab[2].includes(`<span class="route__tab-label">${r.situation}</span>`), r.situation);
      assert.ok(tab[2].includes(`>${r.name}</span>`), r.name);
    }
    assert.equal(count(html, /aria-selected="true"/g), 1);
    for (const principle of ROUTE_PRINCIPLES) assert.ok(html.includes(`<li>${principle}</li>`), principle);
  });

  test('each route, picked, says what it is, what we bring, what stays, and has its own button into the intake', () => {
    for (const r of ROUTES) {
      const one = render({ initialRoute: r.key });
      assert.match(one, new RegExp(`id="route-tab-${r.key}" aria-selected="true"`));
      assert.match(one, new RegExp(`<div class="route__panel" role="tabpanel" id="route-panel" aria-labelledby="route-tab-${r.key}">`));
      assert.ok(one.includes(`<h3 class="route__name">${r.name}</h3>`));
      for (const line of [r.summary, r.youKeep, ...r.arcProvides]) assert.ok(one.includes(line), line);
      assert.ok(one.includes(site.routes.status[r.key]), `${r.key} status`);
      assert.match(one, new RegExp(`<button type="button" class="route__cta" data-route="${r.key}">talk through ${r.name} `));
      assert.equal(count(one, /class="route__cta"/g), 1, 'one call to action at a time');
    }
    assert.match(render({ initialRoute: 'enterprise' }), /id="route-tab-native" aria-selected="true"/, 'an unknown route opens the first');
  });

  test('it shows one answer at a time: at most three points a route, and the rest folded away', () => {
    for (const r of ROUTES) assert.ok(r.arcProvides.length <= 3, r.key);
    assert.equal(count(html, /<h3\b/g), 1);
    assert.equal(count(html, /class="route__summary"/g), 1);
    assert.doesNotMatch(html, /<table|route__question|route__resultname/);
    assert.match(html, /<button type="button" class="route__toggle mono " aria-expanded="false" aria-controls="route-quiz">not sure\? five quick questions/);
    assert.match(html, /<button type="button" class="route__toggle mono " aria-expanded="false" aria-controls="route-compare">compare all three/);
  });

  test('opened, the comparison is a real table: a column per route, a header per row, a label per cell', () => {
    const open = render({ initialOpen: 'compare', initialRoute: 'hybrid' });
    assert.match(open, /aria-expanded="true" aria-controls="route-compare"/);
    assert.match(open, /<table class="route__table" id="route-compare" aria-label="the three routes side by side">/);
    assert.equal(count(open, /<th scope="col"/g), 3);
    assert.equal(count(open, /<th scope="row"/g), ROUTE_COMPARISON.length);
    for (const row of ROUTE_COMPARISON) {
      for (const r of ROUTES) {
        const cls = r.key === 'hybrid' ? 'is-active' : '';
        assert.ok(open.includes(`<td data-label="${r.name}" class="${cls}">${row.values[r.key]}</td>`), `${row.key}.${r.key}`);
      }
    }
  });

  test('on a phone the choices and the comparison stack instead of scrolling sideways', () => {
    const css = read('src/components/YourRoute.css');
    const phone = css.slice(css.indexOf('@media (max-width: 900px)'));
    assert.match(phone, /\.route__tabs,\s*\n\s*\.route__cols \{\s*\n\s*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(phone, /\.route__table td \{[^}]*display: block;/s);
    assert.match(phone, /\.route__table td::before \{\s*\n\s*content: attr\(data-label\);/);
    assert.doesNotMatch(css, /overflow-x:\s*(auto|scroll)/);
    assert.ok(!/(?<![-\w])width:\s*\d{3,}px/.test(css), 'no fixed width wider than a phone');
    /* desktop keeps three columns */
    assert.match(css.slice(0, css.indexOf('@media')), /\.route__tabs \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s);
  });

  test('opened, the questions come one at a time, each a labelled group of real toggle buttons', () => {
    const first = render({ initialOpen: 'quiz' });
    const q = ROUTE_DISCOVERY[0];
    assert.match(first, /<div class="route__question" role="group" aria-labelledby="route-q">/);
    assert.ok(first.includes(`<p class="route__q" id="route-q">${q.question}</p>`));
    assert.equal(count(first, /class="route__q"/g), 1);
    assert.equal(count(first, /<button type="button" class="route__opt " aria-pressed="false">/g), q.options.length);
    assert.match(first, />01 \/ 05</);
    assert.doesNotMatch(first, /← back/, 'nothing to go back to on the first');
  });

  test('with nothing answered the result is an empty polite status that suggests nothing', () => {
    const first = render({ initialOpen: 'quiz' });
    assert.match(first, /<div class="route__result" role="status" aria-live="polite"><\/div>/);
    assert.doesNotMatch(first, /suggested for you|route__resultname/);
  });

  test('part-way through it picks up at the first open question, and still suggests nothing', () => {
    const partial = render({ initialOpen: 'quiz', initialAnswers: { crm: 'none', keep: 'nothing', online_booking: 'maybe' } });
    assert.ok(partial.includes(`id="route-q">${ROUTE_DISCOVERY[1].question}</p>`));
    assert.match(partial, />02 \/ 05</);
    assert.match(partial, /← back/);
    assert.match(partial, /<div class="route__result" role="status" aria-live="polite"><\/div>/);
    assert.doesNotMatch(partial, /suggested for you|route__resultname/);
  });

  test('all five answered names the route, why, that it is only a suggestion, and where to go', () => {
    const done = render({ initialOpen: 'quiz', initialAnswers: ALL });
    assert.match(done, /<p class="route__label mono">sounds like<\/p><p class="route__resultname">ARC Hybrid<\/p>/);
    assert.ok(done.includes(`<p class="route__reason">${suggestRoute(ALL).reasons[0]}</p>`));
    assert.ok(done.includes(ROUTE_SUGGESTION_NOTICE));
    assert.match(done, /<button type="button" class="route__cta" data-route="hybrid">book a call about ARC Hybrid /);
    assert.match(done, /<button type="button" class="route__back mono">start over<\/button>/);
    assert.doesNotMatch(done, /route__question/);
    /* and the route it suggests is the one now on show, flagged on its tab */
    assert.match(done, /id="route-tab-hybrid" aria-selected="true"/);
    assert.equal(count(done, /ARC Hybrid · suggested for you/g), 1);
    assert.equal(count(done, /suggested for you/g), 1);
  });

  test('junk handed in as answers starts from the first question', () => {
    for (const junk of ['native', 42, null, [], { crm: { $ne: null } }]) {
      const out = render({ initialOpen: 'quiz', initialAnswers: junk });
      assert.ok(out.includes(`id="route-q">${ROUTE_DISCOVERY[0].question}</p>`));
      assert.match(out, /<div class="route__result" role="status" aria-live="polite"><\/div>/);
    }
    assert.doesNotMatch(render({ initialOpen: 'everything' }), /<table|route__question/);
  });
});

describe('the rest of the homepage', () => {
  test('no step of how it works assumes a CRM the contractor already owns', () => {
    assert.equal(site.process.steps.length, 4);
    for (const step of site.process.steps) {
      assert.equal(routeCopyProblem(step.q), null, step.q);
      assert.equal(routeCopyProblem(step.a), null, step.q);
      assert.doesNotMatch(step.a, /\bcrm\b/i, step.q);
    }
  });
});

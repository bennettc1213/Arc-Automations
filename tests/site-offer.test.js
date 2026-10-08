/* ARC-MK-100 — the public homepage sells one thing, in an owner's words.
 *
 * The page is rendered to static markup the way `routes.test.js` renders its section —
 * esbuild (already here, under Vite) bundles `Site.jsx` — so every assertion is read off
 * what a visitor is actually served, including words a component hardcodes, not off the
 * copy file alone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { site } from '../src/data/site.js';
import { OWNER_JARGON, ownerCopyProblem } from '../src/lib/owner-copy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

async function loadSite() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import Site from './src/Site.jsx';",
        "export { priceValue } from './src/components/Price.jsx';",
        'export const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Site)));',
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
    /* `import.meta.glob` is Vite's; MediaSlot uses it to find the screenshots that exist.
       here it finds none, which is the honest-placeholder path the page already has. */
    define: { 'import.meta.glob': '__viteGlob' },
    banner: { js: 'var __viteGlob = () => ({});' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'site-offer-'));
  const file = path.join(dir, 'site.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render, priceValue } = await loadSite();

/* react warns that layout effects do nothing in a static render. true, and not news. */
const realError = console.error;
console.error = () => {};
const html = render();
console.error = realError;

const cut = (source, from, to) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `expected to find ${from} before ${to}`);
  return [source.slice(a, b), source.slice(0, a) + source.slice(b)];
};

/* two parts of the page are not the offer and are read separately:
   - the film in the hero is a picture of the portal, so its words are the portal's own
     page names. the owner portal's step changes those, not this one.
   - past builds and the index are a builder's portfolio, kept below everything an owner
     came to read. they name the tools each build used. */
const [film, withoutFilm] = cut(html, '<div class="hero__stage">', '<section class="leaks');
const [portfolio, offer] = cut(withoutFilm, '<section class="projects"', '<footer');

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/* every piece of text a visitor can read or hear: text nodes, and the attributes that
   are spoken or shown. */
const chunks = (source) => [
  ...source.replace(/<svg[\s\S]*?<\/svg>/g, ' ').split(/<[^>]+>/).map((t) => decode(t).trim()).filter(Boolean),
  ...[...source.matchAll(/\b(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((m) => decode(m[1])),
];
const offerText = chunks(offer);
const offerProse = offerText.join(' ');
const count = (source, re) => [...source.matchAll(re)].length;

describe('the owner-copy check', () => {
  test('catches every word on the list, in either number', () => {
    for (const [word] of OWNER_JARGON) {
      assert.equal(ownerCopyProblem(`we set up your ${word} for you`), `uses "${word}"`, word);
    }
    assert.equal(ownerCopyProblem('three workflows and two agents'), 'uses "workflow"');
    assert.equal(ownerCopyProblem('fully orchestrated'), 'uses "orchestration"');
  });

  test('lets the company keep its name, and nothing else by that word', () => {
    assert.equal(ownerCopyProblem('arc automations — for hvac shops'), null);
    assert.equal(ownerCopyProblem('ARC Automations'), null);
    assert.equal(ownerCopyProblem('arc automations builds automations'), 'uses "automation"');
  });

  test('catches a statistic, a CRM made a requirement, and words that only look close', () => {
    assert.equal(ownerCopyProblem('27% of calls go unanswered'), 'quotes a statistic with no source');
    assert.equal(ownerCopyProblem('1 in 4 callers never call back'), 'quotes a statistic with no source');
    assert.equal(ownerCopyProblem('this requires a CRM'), 'makes a CRM a requirement');
    for (const fine of ['30 to 60 days', 'one company, one phone line', 'we count the calls nobody answered', 'a routine tune-up', '']) {
      assert.equal(ownerCopyProblem(fine), null, fine);
    }
  });
});

describe('the homepage offer', () => {
  test('no line an owner reads uses the machine\'s words, a statistic, or a CRM requirement', () => {
    assert.ok(offerText.length > 60, 'the page rendered');
    for (const line of offerText) assert.equal(ownerCopyProblem(line), null, line);
  });

  test('the same holds for every word in the offer\'s copy, rendered or not yet', () => {
    const walk = (value, where, out = []) => {
      if (typeof value === 'string') out.push([where, value]);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`, out);
      return out;
    };
    const keys = ['cta', 'nav', 'hero', 'marqueeA', 'marqueeB', 'leaks', 'ledger', 'process', 'price', 'footer', 'ticker'];
    for (const key of keys) {
      /* ids and stage names are for the code, not the reader */
      for (const [where, text] of walk(site[key], key)) {
        if (/\.(key|id|stage|term)$/.test(where)) continue;
        assert.equal(ownerCopyProblem(text), null, `${where}: ${text}`);
      }
    }
  });

  test('promises no speed nobody has measured on a real phone line', () => {
    assert.doesNotMatch(offerProse, /\b\d+\s?(seconds?|secs?|minutes?|mins?)\b|under a minute|in seconds|instant/i);
    assert.doesNotMatch(offerProse, /\b(guarantee|never miss|every lead|24\/7)\b/i);
  });

  test('the top of the page says what arc does, what it costs and when you pay', () => {
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('<div class="hero__stage">'));
    const h1 = /<h1 class="hero__title">([\s\S]*?)<\/h1>/.exec(hero)[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(h1, 'missed calls become missed jobs. arc texts them back.');
    assert.equal(count(html, /<h1\b/g), 1);
    const sub = /<p class="hero__sub">([^<]*)<\/p>/.exec(hero)[1];
    assert.match(sub, /small hvac companies/);
    assert.match(sub, /texts the caller back/);
    assert.match(sub, /monthly base/, 'what it costs');
    assert.match(sub, /only for jobs we can prove/, 'when you pay');
    assert.match(sub, /missed-call count is free/);
    assert.ok(sub.split(' ').length <= 50, 'short enough to read at a glance');
  });

  test('the main button is the missed-call count and the second is the proof ledger', () => {
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('<div class="hero__stage">'));
    const buttons = [...hero.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].replace(/[→↓]/g, '').trim());
    assert.deepEqual(buttons, ['get my missed-call count', 'see the proof ledger']);
    assert.equal(site.cta.primary, 'get my missed-call count');
    assert.ok(count(offer, /get my missed-call count/g) >= 3, 'hero, price and footer');
    assert.doesNotMatch(offerProse, /start a pilot/);
    assert.match(read('src/components/Hero.jsx'), /scrollToId\('ledger'\)/);
    assert.match(html, /<section class="ledger wrap" id="ledger"/);
  });

  test('every link in the bar goes to a section that is on the page', () => {
    assert.ok(site.nav.links.length >= 4);
    for (const link of site.nav.links) {
      assert.ok(html.includes(`<a href="#${link.id}">${link.label}</a>`), link.label);
      assert.ok(new RegExp(`<section[^>]* id="${link.id}"`).test(html), `#${link.id}`);
    }
  });

  test('sections are numbered once each, in order', () => {
    const numbers = [...html.matchAll(/<p class="eyebrow">(\d\d) — /g)].map((m) => m[1]);
    assert.deepEqual(numbers, ['02', '03', '04', '05', '06', '07', '08']);
  });
});

describe('the four places jobs slip away', () => {
  const stages = site.leaks.items.map((l) => l.stage);

  test('are a staged map: missed calls first, then next, later and blocked', () => {
    assert.deepEqual(site.leaks.items.map((l) => l.key), ['missed-calls', 'quiet-estimates', 'missing-reviews', 'past-customers']);
    assert.deepEqual(stages, ['launch', 'next', 'later', 'blocked']);
  });

  test('each is on the page with its status in words, not only in colour', () => {
    assert.equal(count(html, /<li class="leak leak--/g), 4);
    for (const leak of site.leaks.items) {
      assert.ok(html.includes(`<li class="leak leak--${leak.stage}"`), leak.key);
      assert.ok(html.includes(`<p class="leak__status mono">${leak.status}</p>`), leak.status);
      assert.ok(leak.status.startsWith(leak.stage === 'launch' ? 'first' : leak.stage), leak.status);
    }
  });

  test('nothing is shown as live — the first is opening, the rest are not built or blocked', () => {
    for (const leak of site.leaks.items) {
      assert.doesNotMatch(`${leak.status} ${leak.what}`, /\blive\b|in production|available now|running/i, leak.key);
    }
    assert.match(site.leaks.items[0].status, /pilot/);
    for (const leak of site.leaks.items.slice(1)) assert.match(leak.status, /not built yet|blocked/, leak.key);
    assert.match(site.leaks.items[3].status, /consent/);
  });
});

describe('the proof ledger on the homepage', () => {
  test('says its leads are examples before it shows them', () => {
    const section = html.slice(html.indexOf('<section class="ledger'), html.indexOf('<section class="process'));
    assert.ok(section.indexOf(site.ledger.exampleNote) < section.indexOf('<article'), 'the note comes first');
    assert.match(site.ledger.exampleNote, /not real customers/);
    assert.equal(count(section, /<article class="lrow/g), site.ledger.leads.length);
  });

  test('each lead ends in a verdict and the reason for it', () => {
    assert.deepEqual(site.ledger.leads.map((l) => l.verdict), ['counts', 'does not count', 'handed to you']);
    for (const lead of site.ledger.leads) {
      assert.ok(lead.steps.length >= 3 && lead.reason, lead.key);
      assert.match(lead.steps[0], /nobody answered/, 'a lead starts as a call nobody answered');
      assert.ok(html.includes(`<strong>${lead.verdict}</strong><span>${lead.reason}</span>`), lead.key);
    }
    /* only the lead with every link counts */
    const counted = site.ledger.leads.filter((l) => l.verdict === 'counts');
    assert.equal(counted.length, 1);
    assert.match(counted[0].steps.at(-1), /you confirmed the visit happened/);
  });
});

describe('the price', () => {
  const { terms, rows } = site.price;

  test('every number lives in one object, and none is set until it is agreed', () => {
    assert.deepEqual(Object.keys(terms), ['monthlyBase', 'perRecoveredJob', 'monthlyCap']);
    for (const row of rows) assert.ok(row.value || (row.term in terms && row.unset), row.label);
  });

  test('a term with no number prints its words — never a zero, a blank or a made-up figure', () => {
    const section = html.slice(html.indexOf('<section class="price'), html.indexOf('</section>', html.indexOf('<section class="price')));
    for (const row of rows) {
      const shown = row.value ?? (terms[row.term] == null ? row.unset : null);
      if (shown) assert.ok(section.includes(`<dd>${shown}</dd>`), row.label);
    }
    assert.doesNotMatch(section, /\$0\b|null|undefined|NaN|<dd><\/dd>/);
    for (const junk of [null, undefined, 0, -5, NaN, '250', Infinity]) {
      assert.equal(priceValue(rows[1], { monthlyBase: junk }), rows[1].unset, String(junk));
    }
  });

  test('set in the one place, a number is what the page prints', () => {
    assert.equal(priceValue(rows[1], { monthlyBase: 250 }), '$250 a month');
    assert.equal(priceValue(rows[2], { perRecoveredJob: 1200 }), '$1,200 a job');
    assert.equal(priceValue(rows[0], {}), 'free');
  });

  test('says what makes a job count and what a job can be disputed for', () => {
    assert.match(site.price.counts, /call, the text, the reply, the booking and the visit/);
    assert.equal(site.price.disputeReasons.length, 7);
    for (const reason of site.price.disputeReasons) assert.ok(offer.includes(`<li>${reason}</li>`), reason);
  });
});

describe('what left the homepage, and what was kept', () => {
  test('the three-route section, the menu of services and the toolkit no longer render', () => {
    for (const id of ['route', 'workflows', 'toolkit']) {
      assert.doesNotMatch(html, new RegExp(`<section[^>]* id="${id}"`), id);
    }
    const page = read('src/Site.jsx');
    assert.doesNotMatch(page, /YourRoute|Workflows|Toolkit/);
    assert.doesNotMatch(html, /five quick questions|see \d+ more services|ARC (Native|Hybrid|Connected)/);
  });

  test('the nine extra services are parked data, with the ids the console\'s checklists key on', () => {
    assert.equal(site.workflows.length, 3);
    assert.equal(site.workflowsMore.length, 9);
    for (const label of [...site.workflows, ...site.workflowsMore].map((w) => w.label)) {
      assert.ok(!offer.includes(label), `${label} is not on the page`);
    }
    assert.match(read('src/portal/lib/service-catalog.js'), /site\.workflowsMore/);
  });

  test('the route model, its section and operator onboarding are all still in the repository', () => {
    for (const file of [
      'supabase/functions/_shared/routes/model.ts',
      'supabase/functions/_shared/onboarding/model.ts',
      'src/components/YourRoute.jsx',
      'src/components/Workflows.jsx',
      'src/components/Toolkit.jsx',
    ]) {
      assert.ok(existsSync(path.join(ROOT, file)), file);
    }
    assert.ok(site.routes.status.native && site.toolkit.length > 0);
  });

  test('past builds and the index stay, below everything an owner came to read', () => {
    assert.ok(html.indexOf('<section class="price') < html.indexOf('<section class="projects"'));
    assert.equal(count(portfolio, /<article class="panel"/g), site.projects.length);
    assert.match(portfolio, /id="index"/);
    assert.match(film, /pf-panel/, 'the film is still the hero\'s evidence');
  });
});

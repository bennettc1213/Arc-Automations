/* ARC-MK-120 — the proof ledger: seven example leads, each showing why it counts or does not.
 * (Since ARC-MK-200 it is the demo's `jobs` screen; `tests/owner-portal.test.js` covers that.)
 *
 * Three promises, each tested by name:
 *   - a status is read off what happened to the lead, never typed onto it;
 *   - the page is fit for an owner and claims nothing live and no speed;
 *   - only the demo gets the ledger — a signed-in portal's map is unchanged.
 *
 * The page is rendered to static markup the way `site-offer.test.js` renders the homepage,
 * so a word hardcoded in the component is read too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_STATUS,
  PROOF_LEDGER_COMPANY,
  PROOF_LEDGER_LEADS,
  buildProofLedger,
  ledgerRecord,
  ledgerVerdict,
} from '../src/portal/demo/proof-ledger.js';
import { DEMO_TENANT } from '../src/portal/demo/generate.js';
import { LEDGER_ITEM, NAV_ITEMS, activeItem, navGroupsFor, navItemsFor } from '../src/portal/lib/nav.js';
import { ownerCopyProblem } from '../src/lib/owner-copy.js';
import { site } from '../src/data/site.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

async function loadPage() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import ProofLedger from './src/portal/pages/dash/ProofLedger.jsx';",
        "import { buildProofLedger } from './src/portal/demo/proof-ledger.js';",
        'export const render = () => renderToStaticMarkup(createElement(MemoryRouter, null,',
        "  createElement(ProofLedger, { data: { proofLedger: buildProofLedger() }, base: '/demo' })));",
        "export const renderWithout = () => renderToStaticMarkup(createElement(MemoryRouter, null,",
        "  createElement(ProofLedger, { data: {}, base: '/portal/dashboard' })));",
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
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'proof-ledger-'));
  const file = path.join(dir, 'page.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render, renderWithout } = await loadPage();
const html = render();
const text = html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ');

const byKey = (key) => PROOF_LEDGER_LEADS.find((lead) => lead.key === key);
const status = (lead) => ledgerVerdict(lead).status;

/* ── the seven ──────────────────────────────────────────── */

describe('the seven example leads', () => {
  test('there are seven, and they are the seven the roadmap names', () => {
    assert.deepEqual(
      PROOF_LEDGER_LEADS.map((lead) => lead.key),
      ['confirmed', 'booked', 'unconfirmed', 'no-reply', 'wrong-number', 'cancelled', 'handoff'],
    );
  });

  test('each one lands on the status its story says', () => {
    assert.deepEqual(
      Object.fromEntries(PROOF_LEDGER_LEADS.map((lead) => [lead.key, status(lead)])),
      {
        confirmed: 'counts',
        booked: 'pending',
        unconfirmed: 'needs_you',
        'no-reply': 'no',
        'wrong-number': 'no',
        cancelled: 'no',
        handoff: 'handed',
      },
    );
  });

  test('every lead shows the same seven lines, in the same order, and none is blank', () => {
    const labels = ledgerRecord(PROOF_LEDGER_LEADS[0]).map((line) => line.label);
    assert.deepEqual(labels, [
      'came in from',
      'arrived',
      'did you answer',
      'arc’s first text',
      'the customer’s reply',
      'booking or handoff',
      'your confirmation',
    ]);
    for (const lead of PROOF_LEDGER_LEADS) {
      const record = ledgerRecord(lead);
      assert.deepEqual(record.map((line) => line.label), labels, lead.key);
      for (const line of record) {
        assert.ok(String(line.value).trim().length > 0, `${lead.key}: ${line.label}`);
        assert.ok([true, false, null].includes(line.held), `${lead.key}: ${line.label}`);
      }
    }
  });

  test('every status comes with its reason, in a sentence', () => {
    for (const lead of PROOF_LEDGER_LEADS) {
      const verdict = ledgerVerdict(lead);
      assert.ok(verdict.label, lead.key);
      assert.match(verdict.reason, /\.$|\?$/, lead.key);
      assert.ok(verdict.reason.length > 20, lead.key);
    }
  });

  test('the same seven every time: no clock and no dice in the file', () => {
    assert.deepEqual(buildProofLedger(), buildProofLedger());
    const source = read('src/portal/demo/proof-ledger.js').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /Date\b|Math\.random|DateTime|luxon/);
  });
});

/* ── a status is derived ────────────────────────────────── */

describe('a lead counts only when every link is on record', () => {
  const whole = byKey('confirmed');

  test('no lead carries its own verdict', () => {
    for (const lead of PROOF_LEDGER_LEADS) {
      for (const field of ['status', 'verdict', 'billable', 'billed', 'counts']) {
        assert.equal(field in lead, false, `${lead.key} must not state ${field}`);
      }
    }
  });

  test('the whole chain counts', () => {
    assert.equal(status(whole), 'counts');
    assert.equal(ledgerVerdict(whole).billed, true);
  });

  for (const [name, broken] of [
    ['you answered the call yourself', { answered: true }],
    ['arc never texted', { text: null }],
    ['the customer never replied', { reply: null }],
    ['nothing was booked', { booking: null }],
    ['the visit is still ahead', { visit: 'ahead' }],
    ['the customer cancelled', { visit: 'cancelled' }],
    ['you have not answered', { owner: null }],
    ['you said the job did not happen', { owner: 'did_not_happen' }],
    ['it was a wrong number', { ruledOut: 'wrong_number' }],
    ['it was handed to a person', { handoff: 'the reply sounded unsafe' }],
  ]) {
    test(`it stops counting when ${name}`, () => {
      const verdict = ledgerVerdict({ ...whole, ...broken });
      assert.notEqual(verdict.status, 'counts');
      assert.equal(verdict.billed, false);
    });
  }

  test('only one status is ever billed', () => {
    const billed = Object.entries(LEDGER_STATUS).filter(([, s]) => s.billed).map(([key]) => key);
    assert.deepEqual(billed, ['counts']);
  });

  test('a booking alone is never billed, and neither is a handoff', () => {
    assert.equal(ledgerVerdict(byKey('booked')).billed, false);
    assert.equal(ledgerVerdict(byKey('unconfirmed')).billed, false);
    assert.equal(ledgerVerdict(byKey('handoff')).billed, false);
  });

  test('a safety handoff wins over everything else on the lead', () => {
    const verdict = ledgerVerdict({ ...whole, handoff: 'the reply sounded unsafe' });
    assert.equal(verdict.status, 'handed');
  });

  test('the tally is counted from the verdicts', () => {
    const { tally, leads } = buildProofLedger();
    assert.deepEqual(tally, { total: 7, counts: 1, needsYou: 1, notBilled: 6 });
    assert.equal(tally.counts + tally.notBilled, leads.length);
    const fewer = buildProofLedger(PROOF_LEDGER_LEADS.filter((lead) => lead.key !== 'confirmed'));
    assert.deepEqual(fewer.tally, { total: 6, counts: 0, needsYou: 1, notBilled: 6 });
  });

  test('the words are the homepage’s own', () => {
    const homepage = new Set(site.ledger.leads.map((lead) => lead.verdict));
    const mine = new Set(Object.values(LEDGER_STATUS).map((s) => s.label));
    for (const word of homepage) assert.ok(mine.has(word), `the homepage says "${word}"`);
  });
});

/* ── the page ───────────────────────────────────────────── */

describe('the page an owner reads', () => {
  test('it shows all seven, each with its status and its reason', () => {
    for (const lead of buildProofLedger().leads) {
      assert.ok(text.includes(lead.title), lead.title);
      assert.ok(text.includes(lead.verdict.reason), `${lead.key} prints its reason`);
      assert.ok(text.includes(lead.arrived), `${lead.key} prints when it arrived`);
    }
    assert.equal((html.match(/<article /g) ?? []).length, 7);
  });

  test('it is fit for an owner: no machine words, no statistic', () => {
    assert.equal(ownerCopyProblem(text), null);
    assert.doesNotMatch(text, /\b(billable|unverified|event|payload|tenant|canary)\b/i);
  });

  test('nothing claims to be live or real', () => {
    assert.match(text, /example leads — not real customers/);
    assert.equal((text.match(/example \d of 7/g) ?? []).length, 7, 'every lead is labelled an example');
    assert.match(text, /made-up heating and cooling company/);
    assert.doesNotMatch(text, /\blive\b|real[- ]time|right now|\bclients?\b/i);
  });

  test('it claims no speed: only the arrival and the appointment carry a time', () => {
    const clock = /\d{1,2}:\d{2}/;
    for (const lead of PROOF_LEDGER_LEADS) {
      assert.match(lead.arrived, clock, lead.key);
      for (const field of ['text', 'reply', 'handoff']) {
        assert.doesNotMatch(String(lead[field] ?? ''), clock, `${lead.key}.${field}`);
      }
      assert.doesNotMatch(ledgerVerdict(lead).reason, clock, lead.key);
    }
    assert.doesNotMatch(text, /\b\d+\s?(seconds?|secs?|minutes?|mins?)\b|instant|within/i);
    assert.match(text, /measured on a real phone line/);
  });

  test('arc’s text is the reviewed wording, with the opt-out line', () => {
    const config = read('supabase/functions/_shared/lead-recovery-config.ts');
    const template = /first_response:\s*"([^"]+)"/.exec(config)[1];
    const expected = template.replace('{{customer_name}}', '').replace('{{company}}', PROOF_LEDGER_COMPANY);
    const optOut = /DEFAULT_OPT_OUT_LANGUAGE = '([^']+)'/.exec(config)[1];
    assert.equal(byKey('confirmed').text, `${expected} ${optOut}`);
    for (const lead of PROOF_LEDGER_LEADS) assert.ok(lead.text.endsWith(optOut), lead.key);
  });

  test('the rule and the dispute reasons are the homepage’s, not a second copy', () => {
    assert.ok(text.includes(site.price.counts));
    for (const reason of site.price.disputeReasons) assert.ok(text.includes(reason), reason);
    const page = read('src/portal/pages/dash/ProofLedger.jsx');
    assert.match(page, /site\.price/);
  });

  test('a missing step is said in words, not only drawn', () => {
    assert.match(html, /\(missing\)/);
    assert.match(html, /\(on record\)/);
    assert.match(html, /\(does not apply\)/);
  });

  test('with no ledger it renders nothing rather than an empty page', () => {
    assert.equal(renderWithout(), '');
  });
});

/* ── where it lives ─────────────────────────────────────── */

describe('the demo opens on the ledger, and only the demo', () => {
  test('a signed-in portal’s map is unchanged', () => {
    assert.equal(NAV_ITEMS.length, 13);
    assert.equal(NAV_ITEMS.some((item) => item.label === 'proof ledger'), false);
    assert.equal(navItemsFor(null)[0].label, 'overview');
    assert.equal(activeItem('/portal/dashboard', '/portal/dashboard').label, 'overview');
    assert.doesNotMatch(read('src/portal/pages/Portal.jsx'), /proof-ledger|proofLedger/);
  });

  test('with a ledger, it takes the front door and the overview moves one step in', () => {
    const items = navItemsFor(null, { ledgerHome: true });
    assert.equal(items.length, 14);
    assert.equal(items[0].label, LEDGER_ITEM.label);
    assert.equal(items[0].to, '');
    assert.equal(items.find((item) => item.label === 'overview').to, 'overview');
    assert.equal(activeItem('/demo', '/demo', items).label, 'proof ledger');
    assert.equal(activeItem('/demo/overview', '/demo', items).label, 'overview');
    assert.equal(activeItem('/demo/nowhere', '/demo', items).label, 'proof ledger');
  });

  test('every other page keeps its address', () => {
    const before = NAV_ITEMS.filter((item) => item.to !== '').map((item) => item.to);
    const after = navItemsFor(null, { ledgerHome: true })
      .map((item) => item.to)
      .filter((to) => to !== '' && to !== 'overview');
    assert.deepEqual(after, before);
    assert.equal(new Set(navItemsFor(null, { ledgerHome: true }).map((item) => item.to)).size, 14);
  });

  test('a module the company does not have is still left out', () => {
    const availability = { memberships: { state: 'unavailable' } };
    const tos = navGroupsFor(availability, { ledgerHome: true }).flatMap((g) => g.items.map((i) => i.to));
    assert.equal(tos.includes('memberships'), false);
    assert.equal(tos[0], '');
  });

  test('the ledger item says what it is for, like every other page', () => {
    assert.ok(LEDGER_ITEM.label && LEDGER_ITEM.title && LEDGER_ITEM.icon);
    assert.ok(LEDGER_ITEM.blurb.length >= 12);
    assert.match(read('src/portal/components/Icon.jsx'), new RegExp(`\\b${LEDGER_ITEM.icon}:`));
  });

  test('the demo page hands the workspace the ledger and says it is example data', () => {
    const demo = read('src/portal/pages/Demo.jsx');
    assert.match(demo, /proofLedger: buildProofLedger\(\)/);
    assert.match(demo, /example data for a made-up heating and cooling company/);
    assert.match(read('src/portal/components/Workspace.jsx'), /const ledgerHome = Boolean\(data\.proofLedger\);/);
  });
});

/* ── the company ────────────────────────────────────────── */

describe('the demo company is a heating and cooling company', () => {
  test('one name, on the ledger, the generated portal and the film', () => {
    assert.equal(DEMO_TENANT.name, PROOF_LEDGER_COMPANY);
    assert.match(DEMO_TENANT.name, /heating/i);
    assert.equal(DEMO_TENANT.isDemo, true);
    assert.match(read('src/portal/demo/crm-demo.js'), new RegExp(`name: '${PROOF_LEDGER_COMPANY}'`));
    assert.match(read('src/components/PortalFilm.jsx'), /Halstead Heating &amp; Air/);
  });

  test('no restoration job is left in what the demo shows', () => {
    const trade = /restoration|mitigation|mold|sewage|sump|adjuster|dry-?out|dehumidif|smoke damage|burst (pipe|supply)/i;
    for (const file of [
      'src/portal/demo/generate.js',
      'src/portal/demo/crm-demo.js',
      'src/portal/demo/proof-ledger.js',
      'src/portal/pages/Demo.jsx',
    ]) {
      assert.doesNotMatch(read(file), trade, file);
    }
    const film = read('src/components/PortalFilm.jsx');
    assert.doesNotMatch(film, /Halstead Restoration|water — |loss type/);
  });
});

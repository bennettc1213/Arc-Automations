/* ARC-MK-110 — the overlay behind "get my missed-call count" asks for a missed-call count.
 *
 * Each screen of the overlay is rendered to static markup, the way `site-offer.test.js`
 * renders the homepage, so the words are read off what an owner is shown. What is sent,
 * and what happens when sending fails, is `src/lib/count-intake.js`, run here directly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { site } from '../src/data/site.js';
import { ownerCopyProblem } from '../src/lib/owner-copy.js';
import { intakeAnswers, intakeLines, intakePayload, sendCapture, validateContact } from '../src/lib/count-intake.js';
import { ROUTES } from '../supabase/functions/_shared/routes/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

async function loadOverlay() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import PilotOverlay from './src/components/PilotOverlay.jsx';",
        'export const render = (initial) => renderToStaticMarkup(createElement(PilotOverlay, { initial }));',
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
  const dir = mkdtempSync(path.join(tmpdir(), 'count-intake-'));
  const file = path.join(dir, 'overlay.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render: renderRaw } = await loadOverlay();
/* react warns that layout effects do nothing in a static render. true, and not news. */
const render = (initial) => {
  const realError = console.error;
  console.error = () => {};
  try {
    return renderRaw(initial);
  } finally {
    console.error = realError;
  }
};

const { questions, fields, copy, label } = site.pilot;
const CONTACT = questions.length;
const BOOKING = questions.length + 1;
const NO_CALENDAR = { provider: null, embedUrl: '' };

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const chunks = (source) => [
  ...source.replace(/<svg[\s\S]*?<\/svg>/g, ' ').split(/<[^>]+>/).map((t) => decode(t).trim()).filter(Boolean),
  ...[...source.matchAll(/\b(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((m) => decode(m[1])),
];

/* every screen an owner can reach, including the three endings of the last one */
const screens = [
  ...questions.map((q, step) => [q.key, render({ open: true, step })]),
  ['contact', render({ open: true, step: CONTACT, errors: copy.errors })],
  ['calendar', render({ open: true, step: BOOKING })],
  ['no calendar, sent', render({ open: true, step: BOOKING, capture: 'sent', booking: NO_CALENDAR })],
  ['no calendar, not sent', render({ open: true, step: BOOKING, capture: 'failed', booking: NO_CALENDAR })],
  ['booked', render({ open: true, step: BOOKING, booked: true })],
];
const everything = screens.map(([, html]) => html).join('\n');

const filled = { name: 'Dana Ruiz', business: 'Ruiz Heating', serviceArea: 'Boise and Meridian', email: 'dana@ruizheating.example', phone: '(208) 555-0142' };
const picked = Object.fromEntries(questions.map((q) => [q.key, q.options[0]]));

describe('the missed-call count request', () => {
  test('is closed until a button opens it', () => {
    assert.equal(render(), '');
    assert.equal(render({}), '');
  });

  test('is named for the button that opens it', () => {
    assert.equal(copy.dialog, site.cta.primary);
    assert.equal(label, 'missed-call count');
    assert.ok(render({ open: true }).includes(`aria-label="${site.cta.primary}"`));
    assert.doesNotMatch(everything, /start a pilot|pilot build|pilot request/i);
  });

  test('asks the nine things, in order, and nothing else', () => {
    assert.deepEqual(questions.map((q) => q.key), ['trade', 'weekly_calls', 'after_hours', 'phone_system', 'call_history', 'software']);
    assert.deepEqual(fields.map((f) => f.key), ['name', 'business', 'serviceArea', 'email', 'phone']);
    assert.deepEqual(Object.keys(intakeAnswers(questions, picked, filled)), [
      'trade', 'weekly_calls', 'after_hours', 'phone_system', 'call_history', 'software', 'service_area',
    ]);
    for (const [index, q] of questions.entries()) {
      const html = screens[index][1];
      assert.ok(html.includes(`<h2 class="pilot__q">${q.q}</h2>`), q.key);
      assert.equal([...html.matchAll(/<button class="pilot__opt /g)].length, q.options.length, q.key);
      assert.ok(q.options.length >= 2 && new Set(q.options).size === q.options.length, q.key);
    }
    const byKey = Object.fromEntries(questions.map((q) => [q.key, q]));
    assert.equal(byKey.trade.options[0], 'hvac');
    assert.match(byKey.weekly_calls.q, /how many calls/);
    assert.match(byKey.after_hours.q, /after hours/);
    assert.match(byKey.call_history.options.join(' '), /export/);
    assert.match(byKey.call_history.options.join(' '), /screenshots/);
    assert.match(byKey.software.options[0], /^nothing/, 'using no software is an answer');
  });

  test('the last screen asks who they are, where they work and how to reach them', () => {
    const html = screens[CONTACT][1];
    assert.equal([...html.matchAll(/<input /g)].length, fields.length);
    for (const field of fields) assert.ok(html.includes(`<span class="mono">${field.label}</span>`), field.label);
    for (const message of Object.values(copy.errors)) assert.ok(html.includes(message), message);
    assert.ok(html.includes(copy.submit));
  });

  test('no screen uses the machine\'s words, a statistic or a CRM requirement', () => {
    for (const [name, html] of screens) {
      const lines = chunks(html);
      assert.ok(lines.length >= 3, name);
      for (const line of lines) assert.equal(ownerCopyProblem(line), null, `${name}: ${line}`);
    }
    const walk = (value, out = []) => {
      if (typeof value === 'string') out.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, out));
      return out;
    };
    for (const text of walk({ questions: questions.map((q) => [q.q, q.options]), labels: fields.map((f) => [f.label, f.placeholder ?? '']), copy })) {
      if (text) assert.equal(ownerCopyProblem(text), null, text);
    }
  });

  test('offers no menu of services', () => {
    assert.deepEqual(Object.keys(site.pilot), ['label', 'questions', 'fields', 'copy', 'captureUrl', 'booking']);
    const services = [...site.workflows, ...site.workflowsMore].map((w) => w.label);
    for (const service of services) assert.ok(!everything.includes(service), service);
    assert.doesNotMatch(everything, /what should it do for you|eating your week|marketing/i);
    /* a key left on the bus by a parked section opens the same form */
    assert.doesNotMatch(read('src/components/PilotOverlay.jsx'), /presets|pilotFor|pilotKey/);
  });

  test('the owner is never shown a route and never picks one', () => {
    for (const route of ROUTES) {
      assert.ok(!everything.includes(route.name), route.name);
      for (const q of questions) assert.ok(!q.options.includes(route.key), route.key);
    }
    /* the email fallback and the calendar's notes are both read by the owner */
    const lines = intakeLines(questions, picked, filled).join('\n');
    assert.doesNotMatch(lines, /route|native|hybrid|connected/i);
    assert.doesNotMatch(read('src/components/PilotOverlay.jsx'), /routeNote|getRoute/);
    /* it still reaches us, as a note for the call */
    const sent = intakePayload({ label, questions, answers: picked, contact: filled, route: { route: 'native', routeSource: 'chosen' } });
    assert.deepEqual([sent.route, sent.routeSource], ['native', 'chosen']);
    const plain = intakePayload({ label, questions, answers: picked, contact: filled });
    assert.deepEqual([plain.route, plain.routeSource], [null, null]);
  });
});

describe('what is sent', () => {
  test('keeps the shape the capture has always received', () => {
    const payload = intakePayload({ label, questions, answers: picked, contact: { ...filled, name: '  Dana Ruiz ' }, page: 'https://example.invalid/', submittedAt: '2026-10-08T00:00:00.000Z' });
    assert.deepEqual(Object.keys(payload), ['pilot', 'route', 'routeSource', 'answers', 'contact', 'page', 'submittedAt']);
    assert.equal(payload.pilot, 'missed-call count');
    assert.deepEqual(payload.contact, { name: 'Dana Ruiz', business: 'Ruiz Heating', email: filled.email, phone: filled.phone });
    assert.equal(payload.answers.service_area, 'Boise and Meridian');
    assert.equal(payload.answers.trade, 'hvac');
  });

  test('a request is not sent until it can be answered', () => {
    assert.deepEqual(validateContact(filled, copy.errors), {});
    assert.deepEqual(validateContact({}, copy.errors), copy.errors);
    assert.deepEqual(Object.keys(validateContact({ ...filled, serviceArea: '   ' })), ['serviceArea']);
    assert.deepEqual(Object.keys(validateContact({ ...filled, email: 'dana@' })), ['email']);
    assert.deepEqual(Object.keys(validateContact({ ...filled, phone: '555' })), ['phone']);
  });
});

describe('the booking calendar is never blocked by a failed post', () => {
  const payload = { pilot: label };

  test('a post that fails, in any way, resolves false — it never rejects and never throws', async () => {
    const failures = {
      'refused connection': () => Promise.reject(new TypeError('Failed to fetch')),
      'server error': () => Promise.resolve({ ok: false, status: 500 }),
      'throws before it starts': () => { throw new Error('blocked'); },
      'answers with nothing': () => Promise.resolve(undefined),
      'returns something that is not a promise': () => null,
    };
    for (const [name, fetchImpl] of Object.entries(failures)) {
      assert.equal(await sendCapture('https://capture.invalid/hook', payload, fetchImpl), false, name);
    }
    assert.equal(await sendCapture('', payload, () => assert.fail('nothing to post to')), false);
    assert.equal(await sendCapture('https://capture.invalid/hook', payload, null), false);
  });

  test('only a real 2xx counts as delivered, and it is posted once', async () => {
    const calls = [];
    const ok = await sendCapture('https://capture.invalid/hook', payload, (url, init) => {
      calls.push([url, init]);
      return Promise.resolve({ ok: true });
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].keepalive, true);
    assert.deepEqual(JSON.parse(calls[0][1].body), payload);
  });

  test('the overlay moves to the calendar without waiting for the post', () => {
    const overlay = read('src/components/PilotOverlay.jsx');
    const submit = overlay.slice(overlay.indexOf('const submitContact'), overlay.indexOf('return (', overlay.indexOf('const submitContact')));
    assert.doesNotMatch(overlay, /\bawait\b|async /);
    const then = submit.indexOf(').then((ok) => setCapture(');
    const advance = submit.indexOf('setStep(bookingStep);');
    assert.ok(then > 0 && advance > then, 'the step is set after the post is started');
    assert.equal(submit.slice(then, advance).split('\n')[0].trim(), ").then((ok) => setCapture(ok ? 'sent' : 'failed'));");
  });

  test('the calendar is on the screen whether the post was delivered, failed or is still out', () => {
    for (const capture of ['idle', 'sent', 'failed']) {
      const html = render({ open: true, step: BOOKING, capture });
      assert.match(html, /<div class="pilot__embed"><iframe src="https:\/\/cal\.com\//, capture);
      assert.ok(html.includes(copy.bring), capture);
      assert.match(html, /href="mailto:/, 'and an email is one tap away if the calendar itself is down');
    }
  });

  test('with no calendar set, it says it has the answers only when it does', () => {
    const sent = render({ open: true, step: BOOKING, capture: 'sent', booking: NO_CALENDAR });
    const failed = render({ open: true, step: BOOKING, capture: 'failed', booking: NO_CALENDAR });
    assert.ok(sent.includes(decodeless(copy.sent)) && !failed.includes(decodeless(copy.sent)));
    assert.match(failed, /href="mailto:/);
  });
});

/* react escapes an apostrophe; the copy's are typographic, so the text is found as written */
function decodeless(text) {
  return text.replace(/&/g, '&amp;');
}

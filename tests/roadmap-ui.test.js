/* The roadmap assistant, browser side — what ships, what renders, and what it cannot do.
 *
 * What ships is read off the same import graph `scripts/site-impact.mjs` uses to say what a
 * change means for arcautomation.site: the roadmap, the retrieval code and the model adapter
 * must be backend-only, and nothing the site bundles may carry the model key's name, the
 * provider's address or a line of the roadmap.
 *
 * What renders is checked by rendering the real component to static markup. esbuild (already
 * here, under Vite) compiles the JSX into a throwaway bundle, with the Supabase client
 * replaced by a stub — the component is always handed a client in these tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { siteImpact } from '../scripts/site-impact.mjs';
import {
  STARTER_QUESTIONS,
  chatReducer,
  composerKey,
  createRoadmapClient,
  describeFailure,
  historyFor,
  initialChat,
  sourceLine,
} from '../src/portal/lib/roadmap-assistant.js';
import { parseInline, parseSafeMarkdown, safeHref } from '../src/portal/lib/safe-markdown.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_SIDE = [
  'docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md',
  'supabase/functions/_shared/roadmap/markdown-index.ts',
  'supabase/functions/_shared/roadmap/answer.ts',
  'supabase/functions/_shared/roadmap/model.ts',
  'supabase/functions/_shared/roadmap/source.ts',
  'supabase/functions/_shared/operator-gate.ts',
  'supabase/functions/ops/roadmap.ts',
];
const BROWSER_SIDE = [
  'src/portal/components/RoadmapAssistant.jsx',
  'src/portal/components/RoadmapAssistant.css',
  'src/portal/lib/roadmap-assistant.js',
  'src/portal/lib/safe-markdown.js',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/* ── what ships ─────────────────────────────────────────────────────── */

describe('what reaches the browser bundle', () => {
  test('the roadmap and everything that reads it is backend-only, deployed with ops', () => {
    const impact = siteImpact([...SERVER_SIDE, ...BROWSER_SIDE]);
    const visible = impact.visible.map((v) => v.file);
    for (const file of SERVER_SIDE) assert.ok(!visible.includes(file), `${file} must not be in the site bundle`);
    for (const file of SERVER_SIDE.filter((f) => f.startsWith('supabase/'))) {
      const entry = impact.backend.find((b) => b.file === file);
      assert.ok(entry?.functions.includes('ops'), `${file} ships with the ops function`);
    }
  });

  test('the panel is on the operator console, and only reachable through it', () => {
    const impact = siteImpact(BROWSER_SIDE);
    for (const file of BROWSER_SIDE) {
      const v = impact.visible.find((x) => x.file === file);
      assert.ok(v, `${file} should be in the site`);
      assert.deepEqual(
        v.routes.map((r) => `${r.path} (${r.access})`),
        ['/ops/console (operator sign-in)'],
      );
    }
  });

  test('nothing the site bundles names the model key, the provider, or a line of the roadmap', () => {
    const everything = walk(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    const shipped = siteImpact([...everything, 'index.html']).visible.map((v) => v.file);
    assert.ok(shipped.length > 20);

    const roadmap = readFileSync(path.join(ROOT, SERVER_SIDE[0]), 'utf8');
    const distinctive = roadmap
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 60)
      .sort((a, b) => b.length - a.length)
      .slice(0, 12);
    assert.ok(distinctive.length > 0);

    const forbidden = [/ANTHROPIC_API_KEY/, /x-api-key/i, /api\.anthropic\.com/, new RegExp(['sk', 'ant'].join('-'))];
    for (const file of shipped) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const re of forbidden) assert.doesNotMatch(text, re, `${file} matches ${re}`);
      for (const line of distinctive) assert.ok(!text.includes(line), `${file} contains roadmap text`);
    }
  });
});

/* ── safe markdown ──────────────────────────────────────────────────── */

describe('safe markdown', () => {
  test('html in a reply is text, never markup', () => {
    const blocks = parseSafeMarkdown('<img src=x onerror=alert(1)> and <script>alert(2)</script>');
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].children, [{ type: 'text', text: '<img src=x onerror=alert(1)> and <script>alert(2)</script>' }]);
  });

  test('only https and mailto links survive', () => {
    assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
    assert.equal(safeHref('mailto:ops@example.com'), 'mailto:ops@example.com');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'http://plain.example', '//evil', 'https://x" onmouseover="y']) {
      assert.equal(safeHref(bad), null, bad);
    }
    assert.deepEqual(parseInline('[click](javascript:alert(1))'), [{ type: 'text', text: 'click' }]);
  });

  test('paragraphs, lists, code and emphasis come through as structure', () => {
    const blocks = parseSafeMarkdown(['**Next:** `ARC-nnn`', '', '- one', '- *two*', '', '1. a', '2. b', '', '```', '# kept', '```'].join('\n'));
    assert.deepEqual(
      blocks.map((b) => (b.type === 'list' ? `${b.ordered ? 'ol' : 'ul'}:${b.items.length}` : b.type)),
      ['p', 'ul:2', 'ol:2', 'code'],
    );
    assert.equal(blocks[0].children[0].type, 'strong');
    assert.equal(blocks[0].children[2].type, 'code');
    assert.equal(blocks[3].text, '# kept');
  });

  test('an underscore inside a word is not emphasis', () => {
    assert.deepEqual(parseInline('FILE_NAME_HERE'), [{ type: 'text', text: 'FILE_NAME_HERE' }]);
  });
});

/* ── the client ─────────────────────────────────────────────────────── */

describe('the request the console makes', () => {
  test('carries the operator\'s session to ops, and nothing else', async () => {
    const calls = [];
    const client = createRoadmapClient({
      endpoint: 'https://proj.example/functions/v1/ops',
      anonKey: 'anon-key',
      getToken: async () => 'operator-jwt',
      fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return Response.json({ ok: true, status: 'answered', answer: 'x', citations: [] });
      },
    });
    await client.ask('When do we deploy?', Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: `q${i}` })));
    assert.equal(calls[0].url, 'https://proj.example/functions/v1/ops');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer operator-jwt');
    assert.equal(calls[0].init.headers.apikey, 'anon-key');
    assert.equal(calls[0].body.action, 'roadmap-ask');
    assert.equal(calls[0].body.history.length, 6);
    await client.status();
    assert.deepEqual(calls[1].body, { action: 'roadmap-status' });
  });

  test('a signed-out console sends no token, and the refusal is explained', async () => {
    const client = createRoadmapClient({
      endpoint: '/ops',
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, undefined);
        return Response.json({ error: 'not signed in' }, { status: 401 });
      },
    });
    await assert.rejects(client.ask('hi'), (e) => e.status === 401 && /Sign in again/.test(e.message) && !e.retry);
  });

  test('each failure reads as its fix', () => {
    assert.match(describeFailure(403, { error: 'not an arc admin' }).message, /Only ARC operators/);
    assert.match(describeFailure(400, { error: 'unknown action' }).message, /supabase functions deploy ops/);
    assert.match(describeFailure(404, null).message, /not deployed/);
    const unconfigured = describeFailure(503, { code: 'provider_unconfigured', error: 'No model: ANTHROPIC_API_KEY is not set.' });
    assert.match(unconfigured.message, /nothing was guessed/);
    assert.equal(unconfigured.retry, false);
    assert.equal(describeFailure(429, { code: 'rate_limited', error: 'Too many.' }).retry, true);
    assert.equal(describeFailure(502, { code: 'model_failed', error: 'The model request failed.' }).retry, true);
  });
});

/* ── the conversation ───────────────────────────────────────────────── */

describe('the conversation', () => {
  const answered = { status: 'answered', answer: 'It is in §4.', citations: [{ ref: 'S4', label: '§4 Sequence', section_id: 's4' }] };

  test('ask, answer, fail, retry and reset', () => {
    let s = chatReducer(initialChat, { type: 'send', question: '  When do we deploy?  ' });
    assert.equal(s.messages[0].text, 'When do we deploy?');
    assert.deepEqual(s.pending, { question: 'When do we deploy?' });
    assert.equal(chatReducer(s, { type: 'send', question: 'another' }), s, 'one question at a time');

    s = chatReducer(s, { type: 'answer', response: answered });
    assert.equal(s.pending, null);
    assert.equal(s.messages[1].citations[0].label, '§4 Sequence');

    s = chatReducer(s, { type: 'send', question: 'And after that?' });
    s = chatReducer(s, { type: 'fail', message: 'The model request failed. Try again.', retry: true });
    assert.equal(s.error.question, 'And after that?');
    s = chatReducer(s, { type: 'retry' });
    assert.deepEqual(s.pending, { question: 'And after that?' });
    assert.equal(s.messages.filter((m) => m.role === 'user').length, 2, 'a retry does not repeat the question');

    assert.equal(chatReducer(s, { type: 'reset' }), initialChat);
  });

  test('a follow-up carries the turns before it, not itself, and not a withheld answer', () => {
    const messages = [
      { id: 1, role: 'user', text: 'first' },
      { id: 2, role: 'assistant', status: 'answered', answer: 'one' },
      { id: 3, role: 'user', text: 'second' },
      { id: 4, role: 'assistant', status: 'unverified', answer: 'withheld' },
      { id: 5, role: 'user', text: 'third' },
    ];
    assert.deepEqual(historyFor(messages), [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('enter sends, shift+enter does not, an IME keeps its enter, escape closes', () => {
    assert.equal(composerKey({ key: 'Enter' }), 'send');
    assert.equal(composerKey({ key: 'Enter', shiftKey: true }), null);
    assert.equal(composerKey({ key: 'Enter', isComposing: true }), null);
    assert.equal(composerKey({ key: 'Escape' }), 'close');
  });

  test('the source line is the revision date and the digest', () => {
    assert.equal(
      sourceLine({ revised: 'September 23, 2026', short: 'abc123def456', stale: false }),
      'Roadmap source updated: September 23, 2026 · abc123def456',
    );
    assert.match(sourceLine({ revised: null, short: 'abc', stale: true }), /no revision date.*cached/);
  });

  test('the starter questions are the five specified', () => {
    assert.deepEqual(STARTER_QUESTIONS, [
      'What is the next prompt?',
      'When does n8n first connect to ARC?',
      'When is the Lead Recovery workflow built?',
      'When do we deploy to production?',
      'What do the optimization prompts do?',
    ]);
  });
});

/* ── what renders ───────────────────────────────────────────────────── */

async function loadComponent() {
  const { build } = await import('esbuild');
  const stub = {
    name: 'supabase-stub',
    setup(b) {
      b.onResolve({ filter: /\/lib\/supabase$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: "export const anonKey = ''; export const functionUrl = (n) => '/functions/v1/' + n; export const getSupabase = () => null;",
        loader: 'js',
      }));
    },
  };
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import RoadmapAssistant from './src/portal/components/RoadmapAssistant.jsx';",
        'export const render = (props) => renderToStaticMarkup(createElement(RoadmapAssistant, props));',
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
    plugins: [stub],
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-ui-'));
  const file = path.join(dir, 'assistant.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { render } = await loadComponent();
const idle = { status: async () => ({}), ask: async () => ({}) };
const SOURCE = { revised: 'September 23, 2026', short: 'abc123def456', stale: false, path: 'x', sha256: 'abc', sections: 20 };

const attr = (html, tag, name) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => new RegExp(`${name}="([^"]*)"`).exec(m[0])?.[1] ?? null);

describe('the panel', () => {
  test('closed, it is one labelled launcher that says what it opens', () => {
    const html = render({ client: idle, open: false });
    assert.match(html, /<button type="button" class="rma-launch" aria-expanded="false" aria-controls="[^"]+">/);
    assert.match(html, /roadmap<\/span><\/button>/);
    assert.doesNotMatch(html, /role="dialog"/);
  });

  test('open, it is a labelled dialog titled ARC Roadmap Assistant, naming its knowledge and its source', () => {
    const html = render({ client: idle, open: true, initialSource: SOURCE });
    const labelledBy = /role="dialog" aria-modal="false" aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/.exec(html);
    assert.ok(labelledBy, 'a dialog with a label and a description');
    assert.match(html, new RegExp(`<h2 id="${labelledBy[1]}"[^>]*>ARC Roadmap Assistant</h2>`));
    assert.match(html, />Knowledge: Current roadmap</);
    assert.match(html, new RegExp(`id="${labelledBy[2]}"[^>]*>Roadmap source updated: September 23, 2026 · abc123def456<`));
  });

  test('every control is a real, named button or a labelled field', () => {
    const html = render({ client: idle, open: true, initialSource: SOURCE });
    const types = attr(html, 'button', 'type');
    assert.ok(types.length >= 8);
    assert.ok(types.every((t) => t === 'button' || t === 'submit'), 'no button defaults to submit by accident');
    assert.match(html, /aria-label="Start a new chat"/);
    assert.match(html, /aria-label="Close the roadmap assistant"/);
    const input = /<textarea[^>]*id="([^"]+)"/.exec(html);
    assert.match(html, new RegExp(`<label for="${input[1]}"[^>]*>Ask a question about the roadmap</label>`));
    assert.match(html, /<div[^>]*role="log" aria-live="polite"/);
    assert.match(html, /Enter to send · Shift\+Enter for a new line · Esc to close/);
  });

  test('empty, it offers the starter questions as buttons', () => {
    const html = render({ client: idle, open: true });
    for (const q of STARTER_QUESTIONS) assert.ok(html.includes(`<button type="button" class="rma-starter">${q.replace(/'/g, '&#x27;')}</button>`), q);
  });

  test('an answer renders with its sources, and model output cannot inject markup', () => {
    const state = [
      { type: 'send', question: 'When do we deploy? <b>now</b>' },
      {
        type: 'answer',
        response: {
          status: 'answered',
          answer: 'Deployment is **ARC-nnn**.\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1))',
          citations: [{ ref: 'S5', label: '§14 Deployment and repository boundary', section_id: 's14' }],
        },
      },
    ].reduce(chatReducer, initialChat);
    const html = render({ client: idle, open: true, initialSource: SOURCE, initialState: state });
    assert.match(html, /<strong><span>ARC-nnn<\/span><\/strong>/);
    assert.match(html, /<ul class="rma-cites" aria-label="Sources"><li>Source: §14 Deployment and repository boundary<\/li><\/ul>/);
    assert.doesNotMatch(html, /<img|<b>|javascript:/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('a partial, missing or withheld answer says so in words', () => {
    for (const [status, words] of [
      ['partial', 'Partly answered'],
      ['not_in_roadmap', 'Not in the roadmap.'],
      ['unverified', 'Withheld'],
    ]) {
      const state = chatReducer(chatReducer(initialChat, { type: 'send', question: 'q' }), {
        type: 'answer',
        response: { status, answer: 'a', citations: [], missing: status === 'partial' ? 'which prompt' : null },
      });
      const html = render({ client: idle, open: true, initialState: state });
      assert.ok(html.includes(words), status);
    }
  });

  test('a failure is an alert with a retry when a retry can help', () => {
    let state = chatReducer(initialChat, { type: 'send', question: 'q' });
    state = chatReducer(state, { type: 'fail', message: 'The model request failed. Try again.', retry: true });
    const html = render({ client: idle, open: true, initialState: state });
    assert.match(html, /<div class="rma-error" role="alert"><p>The model request failed\. Try again\.<\/p>/);
    assert.match(html, />retry<\/button>/);
  });

  test('while an answer is on its way the log is busy and says so', () => {
    const state = chatReducer(initialChat, { type: 'send', question: 'q' });
    const html = render({ client: idle, open: true, initialState: state });
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /role="status"[^>]*>.*Reading the roadmap…/);
    assert.match(html, /<button type="submit"[^>]*disabled=""/);
  });

  test('its styles give every control a visible focus ring, work at phone width and respect reduced motion', () => {
    const css = readFileSync(path.join(ROOT, 'src/portal/components/RoadmapAssistant.css'), 'utf8');
    for (const selector of ['.rma-launch:focus-visible', '.rma-icon:focus-visible', '.rma-starter:focus-visible', '.rma-compose__input:focus-visible']) {
      assert.ok(css.includes(selector), selector);
    }
    assert.match(css, /@media \(max-width: 600px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

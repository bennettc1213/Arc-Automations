/* Site impact — "is this change visible on arcautomation.site, or backend only?"
 *
 * The report is read off the import graph, not folder names, because the boundary
 * is not a folder: the site imports files that live under supabase/. Each test here
 * is a promise that would otherwise be answered wrongly in the direction that
 * matters: telling someone a change is backend-only when a page shows it (they never
 * look), or visible when nothing reaches a browser (they wait for a deploy that
 * changes nothing).
 *
 * It runs against a small throwaway repo built in a temp directory, so it says
 * nothing about, and cannot be broken by, whatever else is being edited in this one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { siteImpact, describeImpact } from '../scripts/site-impact.mjs';

const ROUTES = [
  { path: '/', access: 'public', entry: 'src/Site.jsx' },
  { path: '/demo', access: 'public', entry: 'src/pages/Demo.jsx' },
  { path: '/ops/console', access: 'operator sign-in', entry: 'src/pages/Ops.jsx' },
];

const FILES = {
  'index.html': '<html><script type="module" src="/src/main.jsx"></script></html>',
  'package.json': '{"version":"1.0.0"}',
  'package-lock.json': '{}',
  'vite.config.js': 'export default {}',
  'public/CNAME': 'example.test',
  'src/main.jsx': "import './style.css'\nimport App from './App.jsx'",
  'src/style.css': "@import './base.css';\n.hero { background: url(./hero.svg) }",
  'src/base.css': 'body {}',
  'src/hero.svg': '<svg/>',
  'src/App.jsx': [
    "import Site from './Site.jsx'",
    "import { version } from '../package.json'",
    "const Demo = lazy(() => import('./pages/Demo'))",
    "const Ops = lazy(() => import('./pages/Ops'))",
  ].join('\n'),
  'src/Site.jsx': [
    "// import ghost from './lib/commented.js'",
    "/* import ghost2 from './lib/commented.js' */",
    "import { hero } from './lib/hero.js'",
  ].join('\n'),
  'src/lib/hero.js': 'export const hero = 1',
  'src/lib/commented.js': 'export const ghost = 1',
  'src/lib/dead.js': 'export const dead = 1',
  'src/lib/media.js': "export const files = import.meta.glob('../assets/media/**/*')",
  'src/assets/media/clip.png': 'png',
  'src/pages/Demo.jsx': "import { registry } from '../../supabase/functions/_shared/registry.ts'\nimport data from '../demo/demo-data.json'",
  'src/pages/Ops.jsx': "import '../lib/media.js'\nimport { version } from '../../package.json'",
  // reached only through the build-time demo generator, never by a page
  'src/demo/generate.js': "import { gen } from '../lib/gen-helper.js'",
  'src/lib/gen-helper.js': 'export const gen = 1',
  'scripts/build-demo-data.mjs': "import { generate } from '../src/demo/generate.js'",
  // a shared module both the site and a function import
  'supabase/functions/_shared/registry.ts': "import { leaf } from './leaf.ts'",
  'supabase/functions/_shared/leaf.ts': 'export const leaf = 1',
  'supabase/functions/_shared/backend-only.ts': 'export const b = 1',
  'supabase/functions/_shared/orphan.ts': 'export const o = 1',
  'supabase/functions/ops/index.ts': "import { registry } from '../_shared/registry.ts'\nimport { b } from '../_shared/backend-only.ts'",
  'supabase/functions/twilio/index.ts': "import { b } from '../_shared/backend-only.ts'",
  'supabase/functions/twilio/notes.ts': 'export const n = 1',
  'supabase/migrations/0001_init.sql': 'create table t ();',
  'supabase/functions/ops/EVENT_CONTRACT.md': '# doc',
  'tests/a.test.js': '',
  'docs/notes.md': '# notes',
  'CHANGELOG.md': '# log',
  '.github/workflows/deploy.yml': 'name: deploy',
};

let root;
const impact = (...files) => siteImpact(files, { root, routes: ROUTES });
const one = (file) => {
  const r = impact(file);
  return {
    visible: r.visible[0],
    backend: r.backend[0],
    build: r.build.includes(file),
    unreachable: r.unreachable.includes(file),
    other: r.other.includes(file),
  };
};

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'site-impact-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('what reaches a browser', () => {
  test('a page and what it imports are visible, on the pages that reach them', () => {
    assert.deepEqual(one('src/pages/Demo.jsx').visible.routes, [{ path: '/demo', access: 'public' }]);
    assert.deepEqual(one('src/lib/hero.js').visible.routes, [{ path: '/', access: 'public' }]);
  });

  test('a file under supabase/ that the site imports is visible, not backend-only', () => {
    // the whole reason this reads the import graph instead of folder names
    const shared = one('supabase/functions/_shared/registry.ts');
    assert.ok(shared.visible, 'the demo page imports it, so a browser runs it');
    assert.deepEqual(shared.visible.routes, [{ path: '/demo', access: 'public' }]);
    assert.ok(one('supabase/functions/_shared/leaf.ts').visible, 'and so does what it imports');
  });

  test('a lazily imported page, a css @import and a url() asset are followed', () => {
    for (const f of ['src/pages/Ops.jsx', 'src/base.css', 'src/hero.svg']) {
      assert.ok(one(f).visible, `${f} should be part of the site`);
    }
  });

  test('import.meta.glob pulls in the files it matches', () => {
    assert.ok(one('src/assets/media/clip.png').visible);
  });

  test('package.json is visible when a page imports it (the /ops door prints the version)', () => {
    const r = one('package.json').visible;
    assert.ok(r);
    assert.deepEqual(
      r.routes.map((x) => x.path),
      ['/ops/console'],
    );
  });

  test('public/ and index.html are visible', () => {
    assert.ok(one('public/CNAME').visible);
    assert.ok(one('index.html').visible);
  });

  test('a page showing build-time demo data is credited for what generates it', () => {
    const gen = one('src/demo/generate.js').visible;
    assert.deepEqual(gen.routes, [{ path: '/demo', access: 'public' }]);
    assert.ok(one('src/lib/gen-helper.js').visible);
  });

  test('an operator-only page says so, so "visible" is not read as "anyone can see"', () => {
    const r = describeImpact(['src/pages/Ops.jsx'], { root, routes: ROUTES });
    assert.match(r, /\/ops\/console \(operator sign-in\)/);
  });
});

describe('what does not', () => {
  test('a mention in a comment is not an import', () => {
    assert.ok(one('src/lib/commented.js').unreachable);
  });

  test('a src file nothing imports is called out as unreachable, not visible', () => {
    const r = one('src/lib/dead.js');
    assert.ok(r.unreachable);
    assert.equal(r.visible, undefined);
  });

  test('tests, docs and changelogs are not part of the site', () => {
    for (const f of ['tests/a.test.js', 'docs/notes.md', 'CHANGELOG.md']) {
      assert.ok(one(f).other, f);
    }
  });

  test('build config rebuilds the site without changing a page', () => {
    for (const f of ['vite.config.js', 'package-lock.json', '.github/workflows/deploy.yml', 'scripts/build-demo-data.mjs']) {
      assert.ok(one(f).build, f);
    }
  });

  test('a markdown file under supabase/ is documentation, not a deploy', () => {
    assert.ok(one('supabase/functions/ops/EVENT_CONTRACT.md').other);
  });
});

describe('what has to be deployed to the backend', () => {
  test('a migration needs supabase db push', () => {
    const b = one('supabase/migrations/0001_init.sql');
    assert.equal(b.backend.kind, 'migration');
    assert.equal(b.visible, undefined);
  });

  test('a shared file names every function that imports it', () => {
    assert.deepEqual(one('supabase/functions/_shared/backend-only.ts').backend.functions, ['ops', 'twilio']);
  });

  test('a shared file the site also imports is both visible and a redeploy', () => {
    const r = one('supabase/functions/_shared/registry.ts');
    assert.ok(r.visible);
    assert.deepEqual(r.backend.functions, ['ops']);
  });

  test("a function's own file belongs to that function even if index.ts does not import it", () => {
    assert.deepEqual(one('supabase/functions/twilio/notes.ts').backend.functions, ['twilio']);
  });

  test('a shared file nothing imports is reported as used by no function', () => {
    const r = one('supabase/functions/_shared/orphan.ts');
    assert.deepEqual(r.backend.functions, []);
    assert.match(describeImpact(['supabase/functions/_shared/orphan.ts'], { root, routes: ROUTES }), /not imported by any function/);
  });
});

describe('the sentence that gets printed', () => {
  const say = (files, state) => describeImpact(files, { root, routes: ROUTES, state });

  test('backend only says so and names what to deploy', () => {
    const r = say(['supabase/migrations/0001_init.sql', 'supabase/functions/twilio/index.ts'], 'shipped');
    assert.match(r, /NO VISIBLE CHANGE/);
    assert.match(r, /backend code/);
    assert.match(r, /supabase db push/);
    assert.match(r, /redeploy: twilio/);
    assert.doesNotMatch(r, /VISIBLE\.|would be VISIBLE/);
  });

  test('a mixed change leads with the site and still mentions the backend', () => {
    const r = say(['src/pages/Demo.jsx', 'supabase/migrations/0001_init.sql'], 'shipped');
    assert.match(r, /^arcautomation\.site: VISIBLE/);
    assert.match(r, /Also backend/);
  });

  test('a held push never claims the site has changed', () => {
    const r = say(['src/pages/Demo.jsx'], 'held');
    assert.match(r, /nothing is pushed/);
    assert.doesNotMatch(r, /Live once/);
  });

  test('docs-only says nothing changes anywhere', () => {
    assert.match(say(['docs/notes.md', 'tests/a.test.js'], 'shipped'), /NO CHANGE\. Tests, docs or tooling only/);
  });

  test('a path that does not exist is classified by name and does not throw', () => {
    assert.doesNotThrow(() => say(['supabase/migrations/9999_new.sql', 'src/new/Page.jsx'], 'preview'));
  });

  test('absolute paths, as the edit hooks record them, give the same answer', () => {
    const abs = path.join(root, 'src', 'pages', 'Demo.jsx');
    assert.deepEqual(siteImpact([abs], { root, routes: ROUTES }).visible.map((v) => v.file), ['src/pages/Demo.jsx']);
  });

  test('a file outside the repo is ignored', () => {
    const r = siteImpact(['../elsewhere/x.js'], { root, routes: ROUTES });
    assert.deepEqual(Object.values(r).flat(), []);
  });
});

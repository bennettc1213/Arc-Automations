/* renders every workspace page in a real browser and fails on anything the build cannot see.
 *
 * `npm run build` proves the bundle compiles. it does not prove a page renders — a component
 * reading `data.estimates.metrics` on a tenant that has no estimates throws at runtime and
 * builds perfectly. this walks the demo workspace at a desktop and a phone width and fails
 * on: an uncaught exception, a console error, an empty render, or a layout that scrolls
 * sideways on a phone.
 *
 * it drives an already-installed chrome or edge through playwright-core, so it downloads no
 * browser and is not in the project's dependencies. it is a local and CI-optional check:
 *
 *   npm i --no-save playwright-core && npm run build && npm run smoke
 *
 * without playwright-core it exits 0 with a notice rather than failing, so it can sit in a
 * pipeline that does not have it.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4317;
const SHOTS = 'dist-smoke';

/* the site is published under a project path on github pages, so every route is served
   beneath it. read from the vite config rather than repeated here — a base that drifts out
   of sync would make this script 404 on everything and look like a broken app. */
const { default: viteConfig } = await import('../vite.config.js');
const BASE_PATH = (viteConfig.base ?? '/').replace(/\/$/, '');
const BASE = `http://localhost:${PORT}${BASE_PATH}`;

/* every page the workspace can render, at the route the demo serves it from. */
const PAGES = [
  ['overview', '/demo'],
  ['leads', '/demo/leads'],
  ['estimates', '/demo/estimates'],
  ['reviews', '/demo/reviews'],
  ['memberships', '/demo/memberships'],
  ['installs', '/demo/installs'],
  ['activity', '/demo/activity'],
  ['automations', '/demo/automations'],
  ['reliability', '/demo/reliability'],
  ['reports', '/demo/reports'],
  ['account', '/demo/account'],
  ['support', '/demo/support'],
  /* the two public doors, so the entrance animation and the marketing hero are covered by
     the same pass. */
  ['portal-door', '/portal'],
  ['ops-door', '/ops'],
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'mobile', width: 390, height: 844 },
];

/* noise a real browser makes that says nothing about our code. */
const IGNORE = [
  /favicon/i,
  /Failed to load resource.*404.*\.(ico|png|svg)/i,
  /supabase/i, // the demo never signs in; a missing anon key here is expected
  /Download the React DevTools/i,
];

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('  smoke: playwright-core is not installed — skipping.');
  console.log('  install it with:  npm i --no-save playwright-core');
  process.exit(0);
}

function findBrowser() {
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
    { executablePath: '/usr/bin/google-chrome' },
    { executablePath: '/usr/bin/chromium' },
    { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  ];
  return candidates;
}

async function launch() {
  for (const options of findBrowser()) {
    try {
      return await chromium.launch({ ...options, headless: true });
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/* vite's own binary, resolved from node_modules, rather than going through npx — npx on
   windows needs a shell, and a shell between here and the server is one more thing that can
   swallow a failure silently. */
const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

const server = spawn(
  process.execPath,
  [viteBin, 'preview', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
);

const shutdown = () => {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
};
process.on('exit', shutdown);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

if (!(await waitForServer())) {
  console.error('  smoke: preview server never came up. did you run `npm run build`?');
  shutdown();
  process.exit(1);
}

const browser = await launch();
if (!browser) {
  console.log('  smoke: no chrome or edge found to drive — skipping.');
  shutdown();
  process.exit(0);
}

mkdirSync(SHOTS, { recursive: true });

const failures = [];
let checked = 0;

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    /* the entrance wipe and the sand simulation are canvas animations that never settle.
       reduced motion makes every page reach a stable frame, which is what a screenshot and
       a "did this render" check both need. */
    reducedMotion: 'reduce',
  });

  for (const [name, path] of PAGES) {
    const page = await context.newPage();
    const problems = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORE.some((pattern) => pattern.test(text))) return;
      problems.push(`console: ${text}`);
    });
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await sleep(600);

      const state = await page.evaluate(() => ({
        text: (document.body.innerText ?? '').trim().length,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        /* react's error boundary and a blank root both render nothing useful. */
        rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      }));

      if (state.rootChildren === 0) problems.push('nothing rendered into #root');
      if (state.text < 40) problems.push(`page is effectively blank (${state.text} chars)`);

      /* a phone that scrolls sideways is the single most common responsive defect and the
         one screenshots hide, because a screenshot is taken at the layout width. */
      if (state.scrollWidth > state.clientWidth + 1) {
        problems.push(
          `scrolls sideways: content ${state.scrollWidth}px in a ${state.clientWidth}px viewport`,
        );
      }

      await page.screenshot({
        path: `${SHOTS}/${viewport.name}-${name}.png`,
        fullPage: viewport.name === 'desktop',
      });
    } catch (error) {
      problems.push(`navigation: ${error.message}`);
    }

    checked += 1;
    if (problems.length) {
      failures.push({ page: `${viewport.name} ${name}`, problems });
      console.log(`  ✖ ${viewport.name.padEnd(7)} ${name}`);
      for (const problem of problems) console.log(`      ${problem}`);
    } else {
      console.log(`  ✔ ${viewport.name.padEnd(7)} ${name}`);
    }

    await page.close();
  }

  await context.close();
}

await browser.close();
shutdown();

console.log(
  `\n  smoke: ${checked - failures.length}/${checked} page renders clean · screenshots in ${SHOTS}/`,
);
process.exit(failures.length ? 1 : 0);

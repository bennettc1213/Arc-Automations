import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// A local-only harness; it is never part of src, public, or the production build.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = path.join(root, 'node_modules/.cache/ecosystem-smoke');
await mkdir(harness, { recursive: true });
await mkdir(path.join(root, 'dist-smoke'), { recursive: true });
await writeFile(
  path.join(harness, 'index.html'),
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/node_modules/.cache/ecosystem-smoke/entry.jsx"></script></body></html>',
);
await writeFile(
  path.join(harness, 'entry.jsx'),
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import MissionControl from '/src/portal/pages/ops/MissionControl.jsx';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '/src/styles/base.css';
import '/src/portal/portal.css';
import '/src/portal/workspace.css';
const clients=[{tenant:{id:'11111111-1111-1111-1111-111111111111',name:'Client Alpha',company:'Alpha HVAC',status:'onboarding',clientId:'ARC-TEST-0001',timezone:'UTC'}},{tenant:{id:'22222222-2222-2222-2222-222222222222',name:'Client Beta',company:'Beta HVAC',status:'onboarding',timezone:'UTC'}}];
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><MissionControl clients={clients}/></BrowserRouter></React.StrictMode>);
`,
);
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 4329, strictPort: true, open: false },
});
await server.listen();
let browser;
const errors = [];
try {
  for (const option of [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    { executablePath: '/usr/bin/chromium' },
  ]) {
    try {
      browser = await chromium.launch({
        ...option,
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      });
      break;
    } catch {}
  }
  if (!browser) throw new Error('A local Chrome or Edge browser is required.');
  const base = 'http://127.0.0.1:4329';
  const url = base + '/node_modules/.cache/ecosystem-smoke/index.html';
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__memoryNotes = {};
      const folder = (parts) => ({
        name: parts.at(-1) || 'Smoke Vault',
        async getDirectoryHandle(name) {
          return folder([...parts, name]);
        },
        async getFileHandle(name, options = {}) {
          const key = [...parts, name].join('/');
          if (!(key in window.__memoryNotes) && !options.create)
            throw new DOMException('Not found', 'NotFoundError');
          return {
            async createWritable() {
              let body = '';
              return {
                async write(value) {
                  body = String(value);
                },
                async close() {
                  window.__memoryNotes[key] = body;
                },
                async abort() {},
              };
            },
          };
        },
      });
      window.showDirectoryPicker = async () => folder([]);
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !/WebGL|WebSocket|supabase|Failed to load resource/.test(message.text())
      )
        errors.push(message.text());
    });
    await page.route('**/*.supabase.co/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/events')) {
        const tenant = u.searchParams.get('tenant_id')?.replace('eq.', '');
        const beta = tenant?.startsWith('2222');
        await route.fulfill({
          json: [
            {
              id: beta ? 'beta-event' : 'alpha-event',
              tenant_id: tenant,
              event_type: beta ? 'lead_suppressed' : 'call_missed',
              occurred_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              status: 'success',
              payload: { reason_code: beta ? 'opt_out' : 'unanswered' },
              correlation_id: beta ? 'beta-lead' : 'alpha-lead',
            },
          ],
        });
      } else if (u.pathname.includes('/functions/v1/ops'))
        await route.fulfill({ status: 503, json: { error: 'Fixture: settings service unavailable' } });
      else await route.fulfill({ json: [] });
    });
    await page.routeWebSocket(/supabase/, (ws) => ws.close());
    await page.goto(url);
    await page.getByRole('heading', { name: 'Select a client ecosystem' }).waitFor();
    await page.screenshot({ path: `dist-smoke/ecosystem-launch-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: /Launch demo replay/ }).click();
    await page.locator('.mc-scene canvas').waitFor();
    await page.waitForTimeout(1700);
    await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
    await page.screenshot({ path: `dist-smoke/ecosystem-3d-${viewport.width}.png`, fullPage: true });
    assert.equal(await page.locator('.mc-scene-label').count(), 11);
    await page.getByRole('button', { name: /2D free cam/ }).click();
    await page.locator('.mc-map').waitFor();
    await page.locator('.mc-map').focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
    await page.screenshot({ path: `dist-smoke/ecosystem-map-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    await page.getByRole('heading', { name: 'Damon’s memory' }).waitFor();
    await page.getByRole('button', { name: /Connect vault folder/ }).click();
    await page.getByText('Folder connected', { exact: true }).waitFor();
    await page.waitForFunction(() =>
      Object.keys(window.__memoryNotes).some((k) => k.includes('demo-hvac/Events/')),
    );
    assert.ok(
      await page.evaluate(() =>
        Object.keys(window.__memoryNotes).every((k) => k.startsWith('Damon Read Memory/demo-hvac/')),
      ),
    );
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download loaded journal/ }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /Damon-Read-Memory-demo-hvac/);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Replay scenario').selectOption('failure');
    await page.waitForTimeout(12500);
    await page.getByLabel('Filter event display').selectOption('issues');
    assert.ok(
      (await page.locator('.mc-event').allTextContents()).some((s) => s.includes('Message delivery failed')),
    );
    await page.locator('.mc-event').first().click();
    await page.getByRole('heading', { name: 'Recovery Comms', exact: true }).waitFor();
    assert.ok((await page.locator('.mc-status').textContent()).includes('Error recorded'));
    await page.getByLabel('Select client ecosystem').selectOption('11111111-1111-1111-1111-111111111111');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByRole('heading', { name: 'Alpha HVAC', exact: true }).waitFor();
    await page.locator('.mc-feed').getByText('Missed call recorded', { exact: true }).waitFor();
    // Initial history never animates a live task.
    assert.ok((await page.locator('.mc-agent-strip').textContent()).includes('Standing by'));
    await page.getByLabel('Select client ecosystem').selectOption('22222222-2222-2222-2222-222222222222');
    await page.getByRole('heading', { name: 'Beta HVAC', exact: true }).waitFor();
    assert.ok(!(await page.locator('.mc-feed').textContent()).includes('Missed call recorded'));
    await page.locator('.mc-feed').getByText('Contact suppressed', { exact: true }).waitFor();
    assert.ok(!(await page.locator('.mc-feed').textContent()).includes('Missed call recorded'));
    await page.getByRole('button', { name: /Inspect Business Console/ }).click();
    await page.getByRole('button', { name: /Edit rules & filters in station/ }).click();
    await page.locator('dialog[open]').waitFor();
    await page.getByLabel('Close station editor').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close();
    console.log(
      `ecosystem: ${viewport.width}px selection, 3D, map, replay, evidence, memory export, tenant switch and editor passed`,
    );
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/.test(type) ? null : original.call(this, type, ...args);
    };
  });
  await page.goto(url + '?client=demo-hvac');
  await page.locator('.mc-map').waitFor();
  assert.equal(await page.getByLabel('Reduce motion').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: /3D follow/ }).isDisabled(), true);
  await page.screenshot({ path: 'dist-smoke/ecosystem-fallback.png', fullPage: true });
  await page.goto(base + '/ops/console/ecosystem');
  await page.getByText('sign in to the console', { exact: true }).waitFor();
  assert.equal(await page.locator('.mc').count(), 0);
  await context.close();
  assert.deepEqual(errors, []);
  console.log('ecosystem: reduced motion, forced WebGL fallback and unauthenticated route gate passed');
} finally {
  await browser?.close();
  await server.close();
}

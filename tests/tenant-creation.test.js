/* ARC-300 — creating a client and choosing its modules, everything but the database.
 *
 *   1. The form and the module choice (`_shared/tenants/model.ts`) — the one definition the
 *      console, the ops function and 0021 all agree on.
 *   2. The ops handler over a store that records what it is asked, for the refusals that
 *      must happen before the database is reached.
 *   3. What ships: the model is in the console bundle, the service and 0021 are not.
 *   4. What renders: the real NewClient page and module panel, drawn to static markup
 *      (esbuild compiles the JSX, as tests/roadmap-ui.test.js does).
 *
 * The transaction itself — tenant, lifecycle, audit, RLS — is tests/tenant-creation-db.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { siteImpact } from '../scripts/site-impact.mjs';
import {
  moduleCatalog,
  moduleSelectionProblem,
  parseModuleSelection,
  parseTenantInput,
} from '../supabase/functions/_shared/tenants/model.ts';
import { parseTenantStoreError, TenantStoreError } from '../supabase/functions/_shared/tenants/service.ts';
import { handleTenantAction } from '../supabase/functions/ops/tenants.ts';
import { MODULES, modulesInPortalOrder, selectableModules } from '../supabase/functions/_shared/registry/modules.ts';
import { getModuleVersion } from '../supabase/functions/_shared/registry/modules.ts';
import { unsupportedRequirements } from '../supabase/functions/_shared/registry/resolve.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const good = {
  name: 'Cascade Restoration',
  slug: 'cascade-restoration',
  timezone: 'America/Denver',
  status: 'onboarding',
  login_email: 'Owner@Cascade.example ',
};

/* ══ 1. the model ═════════════════════════════════════════ */

describe('the new-client form', () => {
  test('a good form is normalised: trimmed, lower-cased address, empty optionals null', () => {
    const parsed = parseTenantInput({ ...good, company: '  ', plan: 'pilot' });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.login_email, 'owner@cascade.example');
    assert.equal(parsed.value.company, null);
    assert.equal(parsed.value.plan, 'pilot');
    assert.equal(parsed.value.client_id, null);
  });

  test('every problem is reported at once, by field', () => {
    const parsed = parseTenantInput({ name: '', slug: 'Has Spaces', timezone: 'Mars/Olympus', status: 'archived', login_email: 'x', client_id: 'ARC-OOOO-0000', notes: 'n'.repeat(2001) });
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.errors.map((e) => e.field).sort(), ['client_id', 'login_email', 'name', 'notes', 'slug', 'status', 'timezone']);
  });

  test('a new client cannot be created archived — that is what deboarding is for', () => {
    assert.equal(parseTenantInput({ ...good, status: 'archived' }).ok, false);
    for (const status of ['onboarding', 'active', 'paused']) assert.equal(parseTenantInput({ ...good, status }).ok, true);
  });

  test('anything that is not an object is a form with every required field missing', () => {
    for (const raw of [null, 'x', 7, []]) {
      const parsed = parseTenantInput(raw);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.errors.some((e) => e.field === 'name'));
    }
  });
});

describe('module choice comes from the registry', () => {
  test('the catalog is every registered module in portal order, and only selectable ones can be chosen', () => {
    const catalog = moduleCatalog();
    assert.deepEqual(catalog.map((m) => m.key), modulesInPortalOrder().map((m) => m.key));
    assert.equal(catalog.length, MODULES.length);
    assert.deepEqual(catalog.filter((m) => m.selectable).map((m) => m.key), selectableModules().map((m) => m.key));
    for (const entry of catalog.filter((m) => !m.selectable)) {
      assert.equal(entry.problem.code, 'module_unavailable');
      assert.equal(entry.requirements.length, 0, `${entry.key} has no version to need anything`);
    }
  });

  test('Lead Recovery names what it needs and which connectors could provide each capability', () => {
    const lr = moduleCatalog().find((m) => m.key === 'lead_recovery');
    assert.equal(lr.selectable, true);
    assert.equal(lr.executionMode, 'direct');
    const conversation = lr.requirements.find((r) => r.key === 'conversation');
    assert.equal(conversation.kind, 'all_of');
    assert.deepEqual(conversation.capabilities.map((c) => c.key), ['send_sms', 'receive_sms']);
    assert.ok(conversation.capabilities.every((c) => c.connectors.some((x) => x.key === 'twilio')));
    assert.ok(lr.activationSteps.includes('tenant_created'));
  });

  test('an unknown key, an alias and a planned module are each refused with their own reason', () => {
    assert.equal(moduleSelectionProblem('crm_sync').code, 'module_not_found');
    const alias = moduleSelectionProblem('lead_capture');
    assert.equal(alias.code, 'module_not_found');
    assert.match(alias.message, /select lead_recovery/);
    assert.equal(moduleSelectionProblem('review_recovery').code, 'module_unavailable');
    assert.equal(moduleSelectionProblem('lead_recovery'), null);
  });

  test('a requirement no connector ARC offers could meet is unsupported; Lead Recovery has none', () => {
    assert.deepEqual(unsupportedRequirements(getModuleVersion('lead_recovery', 1)), []);
    const imaginary = {
      moduleKey: 'lead_recovery',
      version: 99,
      requirements: [
        { key: 'teleport', kind: 'all_of', capabilities: ['teleport_customer'], description: 'no such thing' },
        { key: 'nice_to_have', kind: 'optional', capabilities: ['teleport_customer'], description: 'optional never blocks' },
      ],
    };
    const unsupported = unsupportedRequirements(imaginary);
    assert.deepEqual(unsupported.map((o) => o.key), ['teleport']);
  });

  test('a selection is deduplicated and sorted, and every bad key is listed', () => {
    assert.deepEqual(parseModuleSelection(['lead_recovery', ' lead_recovery']).value, ['lead_recovery']);
    assert.deepEqual(parseModuleSelection(undefined).value, []);
    const bad = parseModuleSelection(['crm_sync', 'review_recovery']);
    assert.deepEqual(bad.errors.map((e) => [e.field, e.code]), [['modules.crm_sync', 'module_not_found'], ['modules.review_recovery', 'module_unavailable']]);
    assert.equal(parseModuleSelection('lead_recovery').ok, false);
  });
});

/* ══ 2. the handler ═══════════════════════════════════════ */

function recordingStore(behaviour = {}) {
  const calls = [];
  return {
    calls,
    async createTenant(request) {
      calls.push(request);
      if (behaviour.refuse) throw behaviour.refuse;
      return {
        replayed: false,
        tenant: { id: 't-1', slug: request.tenant.slug },
        creation: { tenantId: 't-1', actorUserId: request.actorId, idempotencyKey: request.idempotencyKey, slug: request.tenant.slug, modules: request.modules, createdAt: 'now' },
        lifecycles: [],
      };
    },
    async getTenantCreation() { return null; },
  };
}
const handle = (tenants, body, actorId = 'operator-1') => handleTenantAction('tenant-create', { store: {}, tenants, body, actorId });

describe('the tenant-create action', () => {
  test('without a signed-in actor nothing is attempted', async () => {
    const tenants = recordingStore();
    const res = await handle(tenants, { tenant: good, modules: [], idempotency_key: 'k'.repeat(12) }, null);
    assert.equal(res.status, 401);
    assert.equal(tenants.calls.length, 0);
  });

  test('a bad form is 422 with every field error, and the database is never asked', async () => {
    const tenants = recordingStore();
    const res = await handle(tenants, { tenant: { name: '' }, modules: ['review_recovery'], idempotency_key: 'x' });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'invalid');
    assert.ok(res.body.field_errors.length >= 3);
    assert.equal(tenants.calls.length, 0);
  });

  test('a module that is not on offer is named as such, not as a bad form', async () => {
    const tenants = recordingStore();
    const res = await handle(tenants, { tenant: good, modules: ['estimate_recovery'], idempotency_key: 'k'.repeat(12) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'module_unavailable');
    assert.equal(tenants.calls.length, 0);
  });

  test('a good request reaches the store normalised, with the actor from the token', async () => {
    const tenants = recordingStore();
    const res = await handle(tenants, { tenant: good, modules: ['lead_recovery'], idempotency_key: 'k'.repeat(12), actor: 'someone-else' });
    assert.equal(res.status, 201);
    assert.equal(tenants.calls[0].actorId, 'operator-1');
    assert.equal(tenants.calls[0].tenant.login_email, 'owner@cascade.example');
    assert.deepEqual(tenants.calls[0].modules, ['lead_recovery']);
  });

  test('the database\'s refusals keep their code and a status', async () => {
    for (const [code, status] of [['forbidden', 403], ['slug_taken', 409], ['idempotency_conflict', 409], ['module_unavailable', 422]]) {
      const res = await handle(recordingStore({ refuse: new TenantStoreError(code, 'no') }), { tenant: good, modules: [], idempotency_key: 'k'.repeat(12) });
      assert.equal(res.status, status, code);
      assert.equal(res.body.code, code);
    }
    const parsed = parseTenantStoreError('ERROR: arc_tenant:slug_taken: another client already uses the handle x');
    assert.equal(parsed.code, 'slug_taken');
    assert.equal(parseTenantStoreError('some other failure'), null);
  });
});

/* ══ 3. what ships ════════════════════════════════════════ */

describe('what reaches the browser bundle', () => {
  test('the form and the catalog ship with the console; the service, the store and 0021 do not', () => {
    const browser = ['supabase/functions/_shared/tenants/model.ts', 'src/portal/components/ModuleSelection.jsx'];
    const server = [
      'supabase/functions/_shared/tenants/service.ts',
      'supabase/functions/_shared/tenants/supabase-tenant-store.ts',
      'supabase/functions/ops/tenants.ts',
      'supabase/migrations/0021_ops_tenant_creation.sql',
    ];
    const impact = siteImpact([...browser, ...server]);
    const visible = impact.visible.map((v) => v.file);
    for (const file of browser) {
      const entry = impact.visible.find((v) => v.file === file);
      assert.ok(entry, `${file} should be in the site`);
      assert.ok(entry.routes.every((r) => r.path.startsWith('/ops')), `${file} is operator-only: ${entry.routes.map((r) => r.path)}`);
    }
    for (const file of server) assert.ok(!visible.includes(file), `${file} must not be in the site bundle`);
  });
});

/* ══ 4. what renders ══════════════════════════════════════ */

async function loadPages() {
  const { build } = await import('esbuild');
  const stub = {
    name: 'supabase-stub',
    setup(b) {
      /* `./supabase` from lib/ and `../lib/supabase` from a page: the one module that reads
         Vite's environment. */
      b.onResolve({ filter: /^\.\.?\/(\.\.\/)*(lib\/)?supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: "export const anonKey = ''; export const functionUrl = (n) => '/functions/v1/' + n; export const getSupabase = () => null; export const isConfigured = false;",
        loader: 'js',
      }));
    },
  };
  const out = await build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { MemoryRouter } from 'react-router-dom';",
        "import NewClient from './src/portal/pages/ops/NewClient.jsx';",
        "import TenantModulesPanel from './src/portal/components/ModuleSelection.jsx';",
        'const inRouter = (el) => renderToStaticMarkup(createElement(MemoryRouter, null, el));',
        'export const renderNewClient = (props) => inRouter(createElement(NewClient, { base: "/ops/console", clients: [], reload: async () => {}, ...props }));',
        'export const renderPanel = (props) => inRouter(createElement(TenantModulesPanel, { tenantId: "t-1", base: "/ops/console", ...props }));',
        "import PurgeClientPanel from './src/portal/components/PurgeClientPanel.jsx';",
        "import Sidebar from './src/portal/components/Sidebar.jsx';",
        "import { OPS_NAV_GROUPS } from './src/portal/lib/ops-nav.js';",
        'export const renderPurge = (props) => inRouter(createElement(PurgeClientPanel, { base: "/ops/console", reload: async () => {}, ...props }));',
        'export const renderRail = (collapsed) => inRouter(createElement(Sidebar, { base: "/ops/console", groups: OPS_NAV_GROUPS, mark: "ops", home: "/ops", collapsed, onToggleCollapse: () => {}, counts: {}, status: null }));',
        'export { OPS_NAV_GROUPS };',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.woff2': 'empty', '.ttf': 'empty' },
    plugins: [stub],
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'tenant-ui-'));
  const file = path.join(dir, 'pages.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { renderNewClient, renderPanel, renderPurge, renderRail, OPS_NAV_GROUPS } = await loadPages();
/* the page composes its welcome text from the address it is served at. */
globalThis.window ??= { location: { origin: 'https://arcautomation.site' } };

describe('the new-client page', () => {
  test('renders the form and a module picker drawn from the registry', () => {
    const html = renderNewClient();
    assert.match(html, /business name/);
    assert.match(html, /which modules/);
    assert.match(html, /role="group" aria-label="modules"/);
    for (const module of MODULES) assert.ok(html.includes(module.displayName.replace(/&/g, '&amp;')), module.displayName);
    /* the selectable module is a live button; a planned one is disabled. */
    const buttons = [...html.matchAll(/<button type="button" class="bld-pick__card[^"]*"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    const lr = buttons.find((b) => b.includes('Lead Recovery'));
    const reviews = buttons.find((b) => b.includes('review requests after a completed job') || b.includes('Review requests after a completed job'));
    assert.ok(lr && !/disabled=""/.test(lr), 'lead recovery can be chosen');
    assert.ok(reviews && /disabled=""/.test(reviews), 'a planned module cannot');
    assert.match(html, /create the account/);
  });

  test('a chosen module shows what it will need, and says it will not be switched on', () => {
    const html = renderNewClient({ initial: { modules: ['lead_recovery'] } });
    assert.match(html, /1 selected — none switched on/);
    assert.match(html, /Lead Recovery — what it will need before it can go live/);
    assert.match(html, /send_sms, receive_sms/);
    assert.match(html, /via Twilio/);
  });

  test('field problems show against their field as typed, with the server\'s own wording', () => {
    const html = renderNewClient({ initial: { form: { name: 'Cascade', slug: 'Bad Slug', loginEmail: 'nope', timezone: 'Mars/Olympus' } } });
    assert.match(html, /lowercase letters, digits and single dashes only/);
    assert.match(html, /not an email address/);
    assert.match(html, /&quot;Mars\/Olympus&quot; is not a timezone/);
    /* and the save button cannot be pressed on a form the server would refuse. */
    assert.match(html, /<button type="button" class="ws-btn ws-btn--primary" disabled=""[^>]*>[\s\S]{0,400}?create the account/);
  });

  test('a refusal from the server lands on its field and on the module list', () => {
    const html = renderNewClient({
      initial: {
        form: { name: 'Cascade', slug: 'cascade' },
        serverErrors: [
          { field: 'slug', message: 'another client already uses the handle cascade' },
          { field: 'modules.review_recovery', message: 'Review Recovery is planned — it cannot be given to a client yet' },
        ],
      },
    });
    assert.match(html, /another client already uses the handle cascade/);
    assert.match(html, /a module could not be given to them/);
    assert.match(html, /cannot be given to a client yet/);
  });
});

const OVERVIEW = {
  tenant_id: 't-1',
  creation: { tenant_id: 't-1', actor_user_id: 'abcdef12-0000-4000-8000-000000000001', slug: 'cascade', modules: ['lead_recovery'], created_at: '2026-09-29T15:00:00Z' },
  modules: moduleCatalog().map((entry) => ({
    key: entry.key,
    name: entry.name,
    description: entry.description,
    status: entry.status,
    selectable: entry.selectable,
    problem: entry.problem,
    version: entry.version,
    requirements: entry.requirements,
    configuration: entry.selectable
      ? [{ scope: 'tenant', schema_key: 'tenant_settings', published: null, draft: null }, { scope: 'module', schema_key: 'lead_recovery_config', published: { id: 'v', version: 2 }, draft: { id: 'd', revision: 1 } }]
      : [],
    lifecycle: entry.selectable
      ? {
          lifecycle: { state: 'configuring', state_version: 1 },
          effective: { headline: 'configuring · health unverified' },
          readiness: { ok: false, blockers: [{ code: 'config_not_ready', message: 'no published client settings' }, { code: 'onboarding_incomplete', message: 'business_rules not done' }] },
          transitions: ['begin_testing', 'deselect'],
          history: [{ id: 'h1', occurred_at: '2026-09-29T15:00:00Z', from_state: 'unselected', to_state: 'configuring', actor_type: 'operator', reason: 'selected when the client was created' }],
        }
      : null,
  })),
};

describe('the client page\'s module panel', () => {
  test('loading is said, not drawn as an empty list', () => {
    assert.match(renderPanel({ load: () => new Promise(() => {}) }), /reading the modules…/);
  });

  test('every registered module is a row: state, readiness, configuration, needs, history', () => {
    const html = renderPanel({ initial: OVERVIEW, timezone: 'America/Denver' });
    assert.match(html, /1 selected · 5 registered/);
    assert.match(html, /Lead Recovery/);
    assert.match(html, /configuring · health unverified/);
    assert.match(html, /2 things before it can go live/);
    assert.match(html, /client settings: not published yet · module settings: published v2 · draft open/);
    assert.match(html, /unselected → configuring · operator · selected when the client was created/);
    assert.match(html, /cannot be given to a client yet/);
    assert.match(html, /created Sep 29 · 09:00:00 by operator abcdef12 with lead_recovery/);
    assert.match(html, /href="\/ops\/console\/audit"/);
  });

  test('deselect is offered only where the lifecycle allows it, and select never on a planned module', () => {
    const html = renderPanel({ initial: OVERVIEW });
    assert.equal((html.match(/>deselect</g) ?? []).length, 1);
    assert.doesNotMatch(html, />select</);
    const unselected = { ...OVERVIEW, modules: OVERVIEW.modules.map((m) => (m.lifecycle ? { ...m, lifecycle: { ...m.lifecycle, lifecycle: null, transitions: ['select'], history: [] } } : m)) };
    const offered = renderPanel({ initial: unselected });
    assert.equal((offered.match(/>select</g) ?? []).length, 1, 'one select, on the one selectable module');
  });

  test('read-only for a deboarded client: no buttons at all', () => {
    const html = renderPanel({ initial: OVERVIEW, readOnly: true });
    assert.doesNotMatch(html, /<button type="button" class="ws-btn"/);
  });
});

describe('deleting a test client, on the client page', () => {
  test('closed, it says what it is for and that a client with history is deboarded instead', () => {
    const html = renderPurge({ tenant: { id: 't-1', name: 'Cascade', slug: 'cascade' } });
    assert.match(html, /delete this test client/);
    assert.match(html, /cannot be deleted: deboard it instead/);
    assert.match(html, /<button type="button" class="ws-btn">[\s\S]*?delete permanently<\/button>/);
  });
});

describe('the ops sidebar', () => {
  const labels = OPS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.label));

  test('expanded, every section is named', () => {
    const html = renderRail(false);
    for (const label of labels) assert.match(html, new RegExp(`<span class="ws-nav__text">${label}</span>`));
  });

  test('collapsed, every section is still named, under its icon — never a column of bare icons', () => {
    const html = renderRail(true);
    for (const label of labels) assert.match(html, new RegExp(`<span class="ws-nav__caption">${label}</span>`));
  });
});

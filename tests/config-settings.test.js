/* ARC-310 — the settings screen, and the reads it adds to ARC-110's engine.
 *
 *   1. The projections (`config/settings.ts`, `registry/layouts.ts`): fields from the registry,
 *      layouts that cannot drift from the validator, the lifecycle forecast.
 *   2. The form conversions (`lib/config-form.js`): pure, and deliberately dumb about rules.
 *   3. The ops actions over real Postgres: load, draft, validate, conflict, publish, compare,
 *      restore — history never rewritten.
 *   4. What renders: the real editor and history, drawn from the real projection.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDatabase, loadPglite, restClient, SKIP_REASON } from './pglite-harness.js';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { handleConfigAction } from '../supabase/functions/ops/config.ts';
import { handleLifecycleAction } from '../supabase/functions/ops/lifecycle.ts';
import { createDraft, updateDraft } from '../supabase/functions/_shared/config/engine.ts';
import { moduleScope } from '../supabase/functions/_shared/config/model.ts';
import { analyseChange } from '../supabase/functions/_shared/config/impact.ts';
import { lifecycleEffect, schemaProjection } from '../supabase/functions/_shared/config/settings.ts';
import { layoutsFor } from '../supabase/functions/_shared/registry/layouts.ts';
import { getConfigSchema, LEAD_RECOVERY_SCHEMA, tenantSettingsSchema } from '../supabase/functions/_shared/registry/schemas.ts';
import { leadRecoveryConfig } from './config-fixtures.js';
import {
  changedFields,
  documentFrom,
  errorsByField,
  fieldKind,
  inputsFor,
  patchFor,
  rangesToText,
  textToLines,
  textToRanges,
  valueFrom,
} from '../src/portal/lib/config-form.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPERATOR = { kind: 'operator', userId: 'op' };
const LR = LEAD_RECOVERY_SCHEMA;

/* ══ 1. projections ═══════════════════════════════════════ */

describe('what the screen is told about each field', () => {
  test('a module scope shows only the fields it stores; the tenant-wide ones are named as coming from client settings', () => {
    const projection = schemaProjection(LR, OPERATOR);
    const keys = projection.fields.map((f) => f.key);
    assert.ok(!keys.includes('company_name') && !keys.includes('timezone'));
    assert.deepEqual(projection.from_tenant.map((f) => f.key).sort(), ['company_name', 'timezone']);
    assert.ok(projection.fields.every((f) => f.editable), 'an operator may edit every Lead Recovery field');
    const tenant = schemaProjection(tenantSettingsSchema(), OPERATOR);
    assert.deepEqual(tenant.fields.map((f) => f.key), ['company_name', 'timezone']);
  });

  test('a client actor may edit nothing — the field-level permission comes from the registry', () => {
    const projection = schemaProjection(LR, { kind: 'client', tenantId: 't', userId: 'u' });
    assert.ok(projection.fields.every((f) => f.editable === false));
  });

  test('every layout names a real field, and every part and column a real key of it — checked against the validator\'s own documents', () => {
    const defaults = LR.defaults();
    for (const [fieldKey, layout] of Object.entries(layoutsFor(LR.key))) {
      assert.ok(LR.fields.some((f) => f.key === fieldKey), `${fieldKey} is a field`);
      for (const part of layout.parts ?? []) {
        assert.ok(Object.hasOwn(defaults[fieldKey], part.key), `${fieldKey}.${part.key} is in the default document`);
      }
    }
    /* a staff alert built from the layout's columns and first options is one the validator accepts. */
    const columns = layoutsFor(LR.key).staff_alerts.items.columns;
    const alert = Object.fromEntries(columns.map((c) => [c.key, c.options?.[0] ?? (c.key === 'address' ? '+16145550100' : 'Robin')]));
    const result = LR.validate({ ...leadRecoveryConfig(), staff_alerts: [alert] });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test('every select part offers exactly what the validator accepts', () => {
    const config = leadRecoveryConfig();
    for (const [fieldKey, layout] of Object.entries(layoutsFor(LR.key))) {
      for (const part of (layout.parts ?? []).filter((p) => p.control === 'select')) {
        for (const option of part.options) {
          const doc = { ...config, [fieldKey]: { ...config[fieldKey], [part.key]: option } };
          const result = LR.validate(doc);
          assert.ok(!(result.errors ?? []).some((e) => e.startsWith(`${fieldKey}.${part.key}`)), `${fieldKey}.${part.key}=${option}`);
        }
      }
    }
  });
});

describe('what the lifecycle is expected to do with a change', () => {
  const before = leadRecoveryConfig();
  const change = (patch) => analyseChange(LR, before, { ...before, ...patch });
  const scope = moduleScope('lead_recovery');

  test('a template edit on a live module holds new leads until a retest; in-flight ones keep their wording', () => {
    const [effect] = lifecycleEffect(change({ templates: { ...before.templates, followup: 'changed {{company}}' } }), scope, [{ moduleKey: 'lead_recovery', state: 'active' }]);
    assert.equal(effect.none, false);
    assert.deepEqual(effect.requires, ['retest']);
    assert.match(effect.headline, /stays active, but new leads are held/);
  });

  test('a compliance change pauses a live module until it is re-approved', () => {
    const [effect] = lifecycleEffect(change({ compliance: { ...before.compliance, status: 'pending' } }), scope, [{ moduleKey: 'lead_recovery', state: 'active' }]);
    assert.match(effect.headline, /is paused: it needs .*reactivation/);
  });

  test('a consequence-free change stays live; a module that is not live is unaffected; nothing changed is no effect at all', () => {
    const [live] = lifecycleEffect(change({ booking_url: 'https://book.example/x' }), scope, [{ moduleKey: 'lead_recovery', state: 'active' }]);
    assert.match(live.headline, /stays live/);
    const [configuring] = lifecycleEffect(change({ templates: { ...before.templates, followup: 'x {{company}}' } }), scope, [{ moduleKey: 'lead_recovery', state: 'configuring' }]);
    assert.match(configuring.headline, /not live/);
    assert.deepEqual(lifecycleEffect(change({}), scope, [{ moduleKey: 'lead_recovery', state: 'active' }]), []);
  });

  test('a client-settings change reaches the modules that read the field, and only those', () => {
    const tenant = tenantSettingsSchema();
    const report = analyseChange(tenant, { company_name: 'A', timezone: 'America/Denver' }, { company_name: 'A', timezone: 'America/Chicago' });
    const effects = lifecycleEffect(report, { kind: 'tenant' }, [{ moduleKey: 'lead_recovery', state: 'active' }]);
    assert.equal(effects.length, 1);
    assert.match(effects[0].headline, /new leads are held/);
  });
});

/* ══ 2. the form ══════════════════════════════════════════ */

describe('turning inputs into a document', () => {
  const fields = schemaProjection(LR, OPERATOR).fields;

  test('opening hours and lists read and write the way they are typed', () => {
    assert.equal(rangesToText([{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }]), '08:00-12:00, 13:00-17:00');
    assert.deepEqual(textToRanges('08:00-12:00, 13:00 – 17:00'), [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }]);
    assert.deepEqual(textToRanges(''), []);
    assert.deepEqual(textToRanges('noon'), [{ open: 'noon', close: '' }], 'passed through for the server to refuse, not dropped');
    assert.deepEqual(textToLines(' a \n\n b '), ['a', 'b']);
  });

  test('a number or JSON that is not one is caught before sending; an emptied optional text goes back to null', () => {
    assert.equal(valueFrom('number', 'twelve').error, '"twelve" is not a number');
    assert.equal(valueFrom('json', '{').error, 'not valid JSON');
    assert.equal(valueFrom('text', '  ', null).value, null);
    assert.equal(valueFrom('text', '', '').value, '');
  });

  test('every field is drawn by a real control — groups by their parts, lists as lines or rows, nothing as raw JSON', () => {
    const kinds = Object.fromEntries(fields.map((f) => [f.key, fieldKind(f)]));
    assert.equal(kinds.templates, 'parts');
    assert.equal(kinds.services, 'lines');
    assert.equal(kinds.staff_alerts, 'records');
    assert.equal(kinds.booking_url, 'text');
    assert.ok(!Object.values(kinds).includes('json'), JSON.stringify(kinds));
  });

  test('inputs round-trip to the same document, and a patch carries only what changed', () => {
    const doc = leadRecoveryConfig();
    const own = Object.fromEntries(fields.map((f) => [f.key, doc[f.key]]));
    const inputs = inputsFor(fields, own);
    const { doc: back, errors } = documentFrom(fields, inputs, own);
    assert.deepEqual(errors, {});
    assert.deepEqual(changedFields(own, back), [], 'nothing changed by drawing and reading back');
    const edited = documentFrom(fields, { ...inputs, services: `${inputs.services}\nroofing` }, own).doc;
    assert.deepEqual(Object.keys(patchFor(own, edited)), ['services']);
  });

  test('a field the operator may not edit keeps its value whatever the input says', () => {
    const locked = fields.map((f) => (f.key === 'booking_url' ? { ...f, editable: false } : f));
    const base = { booking_url: 'https://kept.example' };
    assert.equal(documentFrom(locked, { booking_url: 'https://changed.example' }, base).doc.booking_url, 'https://kept.example');
  });

  test('the server\'s errors are filed under their field and part', () => {
    const byField = errorsByField([
      { path: 'staff_alerts[0].address', message: 'staff_alerts[0].address must be E.164 for an SMS recipient' },
      { path: 'templates.followup', message: 'templates.followup uses an unknown placeholder' },
      { path: '', message: 'a configuration document must be a JSON object' },
    ]);
    assert.equal(byField.staff_alerts[0].part, 'address');
    assert.equal(byField.templates[0].part, 'followup');
    assert.equal(byField._document.length, 1);
  });
});

/* ══ 3. the actions, on real Postgres ═════════════════════ */

const pglite = await loadPglite();
const skip = pglite ? false : SKIP_REASON;

describe('the settings actions', { skip }, () => {
  let db;
  let operator;
  let tenantId;
  let call;
  const LRS = { scope: 'module', module_key: 'lead_recovery' };

  before(async () => {
    db = await freshDatabase();
    operator = 'cccccccc-0000-4000-8000-000000000301';
    await db.query('insert into auth.users (id, email) values ($1, $2)', [operator, 'op@example.test']);
    await db.query('insert into public.arc_admins (user_id) values ($1)', [operator]);
    tenantId = (await db.query(`insert into tenants (name, slug, status) values ('Settings Co', 'settings-co', 'onboarding') returning id`)).rows[0].id;
    const store = supabaseStore(restClient(db));
    /* the same write the ops function makes. */
    const markStep = async (t, moduleKey, stepKey) => {
      await db.query(
        `insert into module_onboarding (tenant_id, module_key, step_key, done_at) values ($1, $2, $3, now())
         on conflict (tenant_id, module_key, step_key) do update set done_at = excluded.done_at`,
        [t, moduleKey, stepKey],
      );
    };
    call = (action, body, actorId = operator) =>
      handleConfigAction(action, { store, body: { tenant_id: tenantId, ...body }, actorId, audit: async () => true, markStep });
    const selected = await handleLifecycleAction('module-select', { store, body: { tenant_id: tenantId, module_key: 'lead_recovery', expected_state_version: 0 }, actorId: operator });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
  });

  const must = (res, what) => {
    assert.equal(res.status, 200, `${what}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  /** publish the whole Lead Recovery document through drafts: tenant scope first, then the module. */
  async function publishAll(config, note) {
    for (const [scope, keys] of [[{ scope: 'tenant' }, ['company_name', 'timezone']], [LRS, null]]) {
      const loaded = must(await call('config-scope', scope), 'load');
      const draft = loaded.open_draft ?? must(await call('config-draft-create', scope), 'draft').draft;
      const fields = keys ?? loaded.schema.fields.map((f) => f.key);
      const patch = Object.fromEntries(fields.map((k) => [k, config[k]]));
      const saved = must(await call('config-draft-update', { ...scope, draft_id: draft.id, expected_revision: draft.revision, patch }), 'save');
      must(await call('config-publish', {
        ...scope, draft_id: draft.id, expected_revision: saved.draft.revision, expected_version: loaded.current?.version ?? 0, note,
      }), 'publish');
    }
  }

  test('a client with nothing published loads as the registry\'s fields, no version, no draft, and its module\'s state', async () => {
    const body = must(await call('config-scope', LRS), 'load');
    assert.equal(body.schema.key, 'lead_recovery_config');
    /* six since ARC-GO-310 added the two messages a customer gets after replying. this suite
       only runs on real SQL, which is how a count of four outlived that change. */
    assert.deepEqual(
      body.schema.fields.find((f) => f.key === 'templates').layout.parts.map((part) => part.key),
      layoutsFor('lead_recovery_config').templates.parts.map((part) => part.key),
    );
    assert.equal(body.schema.fields.find((f) => f.key === 'templates').layout.parts.length, 6);
    assert.equal(body.current, null);
    assert.equal(body.open_draft, null);
    assert.deepEqual(body.lifecycles, [{ module_key: 'lead_recovery', state: 'configuring' }]);
  });

  test('an invalid value is refused with its field named; a secret-shaped one too', async () => {
    const draft = must(await call('config-draft-create', { scope: 'tenant' }), 'draft').draft;
    const secret = ['sk', 'live0123456789', 'abcdefghij'].join('-');
    const res = await call('config-draft-update', { scope: 'tenant', draft_id: draft.id, expected_revision: draft.revision, patch: { company_name: secret } });
    assert.equal(res.status, 422);
    assert.equal(res.body.field_errors[0].path, 'company_name');
    assert.match(res.body.field_errors[0].message, /looks like an API key/);
    must(await call('config-draft-discard', { scope: 'tenant', draft_id: draft.id, expected_revision: draft.revision }), 'discard');
  });

  test('a stale revision is a conflict, not an overwrite', async () => {
    const draft = must(await call('config-draft-create', { scope: 'tenant' }), 'draft').draft;
    must(await call('config-draft-update', { scope: 'tenant', draft_id: draft.id, expected_revision: draft.revision, patch: { company_name: 'First' } }), 'first');
    const stale = await call('config-draft-update', { scope: 'tenant', draft_id: draft.id, expected_revision: draft.revision, patch: { company_name: 'Second' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'draft_conflict');
    const now = must(await call('config-draft-get', { scope: 'tenant' }), 'get').draft;
    assert.equal(now.config.company_name, 'First');
    must(await call('config-draft-discard', { scope: 'tenant', draft_id: now.id, expected_revision: now.revision }), 'discard');
  });

  test('the first valid publish of both scopes ticks "business rules", as the Lead Recovery panel\'s save does', async () => {
    const step = async () => (await db.query(`select done_at from module_onboarding where tenant_id = $1 and step_key = 'business_rules'`, [tenantId])).rows[0]?.done_at ?? null;
    assert.equal(await step(), null);
    await publishAll(leadRecoveryConfig({ twilio: { ...leadRecoveryConfig().twilio, phone_number: '+16145559001' } }), 'first');
    assert.ok(await step(), 'ticked once the effective configuration resolves valid');
  });

  test('the preview says what the module\'s lifecycle will do', async () => {
    const draft = must(await call('config-draft-create', LRS), 'draft').draft;
    const saved = must(await call('config-draft-update', { ...LRS, draft_id: draft.id, expected_revision: draft.revision, patch: { booking_url: 'https://book.example/settings' } }), 'save');
    const preview = must(await call('config-draft-preview', { ...LRS, draft_id: draft.id }), 'preview');
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.impact.changed_fields, ['booking_url']);
    assert.equal(preview.lifecycle_effect[0].module_key, 'lead_recovery');
    assert.match(preview.lifecycle_effect[0].headline, /not live/);
    must(await call('config-publish', { ...LRS, draft_id: draft.id, expected_revision: saved.draft.revision, expected_version: 1, note: 'second' }), 'publish');
  });

  test('versions compare field by field, and staff numbers are hidden in the comparison', async () => {
    const history = must(await call('config-history', LRS), 'history').versions;
    assert.deepEqual(history.map((v) => v.version), [2, 1]);
    const compared = must(await call('config-compare', { ...LRS, from_version_id: history[1].id, to_version_id: history[0].id }), 'compare');
    assert.deepEqual(compared.impact.changes.map((c) => [c.path, c.before, c.after]), [['booking_url', null, 'https://book.example/settings']]);

    const draft = must(await call('config-draft-create', LRS), 'draft').draft;
    const saved = must(await call('config-draft-update', {
      ...LRS, draft_id: draft.id, expected_revision: draft.revision,
      patch: { staff_alerts: [{ name: 'Robin', channel: 'sms', address: '+16145550177' }] },
    }), 'save');
    must(await call('config-publish', { ...LRS, draft_id: draft.id, expected_revision: saved.draft.revision, expected_version: 2 }), 'publish');
    const v3 = must(await call('config-history', LRS), 'history').versions[0];
    const hidden = must(await call('config-compare', { ...LRS, from_version_id: history[0].id, to_version_id: v3.id }), 'compare');
    assert.ok(hidden.impact.changes.every((c) => c.redacted && !('after' in c)));
    assert.ok(!JSON.stringify(hidden).includes('+16145550177'));
  });

  test('restore previews against the current version, publishes as the next one, and leaves the old row untouched', async () => {
    const history = must(await call('config-history', LRS), 'history').versions;
    const v1 = history.find((v) => v.version === 1);
    const v1Before = must(await call('config-version', { ...LRS, version_id: v1.id }), 'v1').version;

    const preview = must(await call('config-rollback-preview', { ...LRS, version_id: v1.id }), 'preview');
    assert.equal(preview.current.version, 3);
    assert.ok(preview.impact.changed_fields.includes('booking_url'));
    assert.ok(Array.isArray(preview.lifecycle_effect));

    const restored = must(await call('config-rollback', { ...LRS, version_id: v1.id, expected_version: 3, note: 'restored v1' }), 'restore');
    assert.equal(restored.version, 4);
    assert.equal(restored.rollback_of_version_id, v1.id);
    const v1After = must(await call('config-version', { ...LRS, version_id: v1.id }), 'v1').version;
    assert.deepEqual(v1After, v1Before, 'v1 is exactly as it was');
    const stale = await call('config-rollback', { ...LRS, version_id: v1.id, expected_version: 3 });
    assert.equal(stale.status, 409);
  });

  test('an edit by someone the registry does not allow is refused by the engine', async () => {
    const store = supabaseStore(restClient(db));
    const client = { kind: 'client', tenantId, userId: operator };
    const draft = await createDraft(store, { tenantId, scope: moduleScope('lead_recovery'), actor: client });
    if (draft.ok) {
      const result = await updateDraft(store, { tenantId, scope: moduleScope('lead_recovery'), draftId: draft.draft.id, expectedRevision: draft.draft.revision, patch: { booking_url: 'https://x.example' }, actor: client });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'edit_permission_denied');
    } else {
      assert.ok(['edit_permission_denied', 'forbidden', 'unauthorized'].includes(draft.code), draft.code);
    }
  });

  test('without a signed-in operator nothing is read', async () => {
    const res = await call('config-scope', LRS, null);
    assert.equal(res.status, 401);
  });
});

/* ══ 4. what renders ══════════════════════════════════════ */

async function loadComponents() {
  const { build } = await import('esbuild');
  const stub = {
    name: 'supabase-stub',
    setup(b) {
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
        "import ConfigEditor from './src/portal/components/ConfigEditor.jsx';",
        "import ConfigHistory from './src/portal/components/ConfigHistory.jsx';",
        'const inRouter = (el) => renderToStaticMarkup(createElement(MemoryRouter, null, el));',
        'const never = { load: () => new Promise(() => {}), history: () => new Promise(() => {}) };',
        'export const renderEditor = (props) => inRouter(createElement(ConfigEditor, { tenantId: "t-1", scope: "module", moduleKey: "lead_recovery", api: never, ...props }));',
        'export const renderHistory = (props) => inRouter(createElement(ConfigHistory, { tenantId: "t-1", scope: "module", moduleKey: "lead_recovery", api: never, ...props }));',
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
  const dir = mkdtempSync(path.join(tmpdir(), 'config-ui-'));
  const file = path.join(dir, 'config.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { renderEditor, renderHistory } = await loadComponents();

const projection = schemaProjection(getConfigSchema('lead_recovery_config'), OPERATOR);
const document = Object.fromEntries(projection.fields.map((f) => [f.key, leadRecoveryConfig()[f.key]]));
const scopeData = (extra = {}) => ({
  schema: projection,
  current: { id: 'v2', version: 2, config: document, published_at: '2026-09-29T15:00:00Z' },
  open_draft: { id: 'd1', revision: 3, base_version: 2, config: document },
  lifecycles: [{ module_key: 'lead_recovery', state: 'configuring' }],
  ...extra,
});

describe('the settings editor', () => {
  test('loading is said, not drawn as an empty form', () => {
    assert.match(renderEditor(), /reading the settings…/);
  });

  test('every field is drawn from the registry with a control that fits it', () => {
    const html = renderEditor({ initial: scopeData() });
    for (const field of projection.fields) assert.match(html, new RegExp(`aria-label="${field.label}"`), field.label);
    assert.match(html, /<textarea[^>]*>Hi\{\{customer_name\}\}, this is \{\{company\}\}/, 'templates are text areas');
    assert.match(html, /<input type="checkbox"[^>]*checked=""[^>]*\/><span>use a model to help read replies/, 'a toggle is a checkbox');
    assert.match(html, /<option value="same_response"/, 'a closed set is a select of the validator\'s own values');
    assert.match(html, /value="08:00-17:00"/, 'opening hours as typed');
    assert.match(html, /pauses a live module/);
    assert.match(html, /company name and timezone come from the client settings tab/);
  });

  test('a draft says it is a draft and not live, with its revision and base', () => {
    const html = renderEditor({ initial: scopeData() });
    assert.match(html, /draft · revision 3 · from v2/);
    assert.match(html, /draft — not live/);
    assert.match(html, /review &amp; publish/);
  });

  test('with no draft the values are shown but not editable, and editing starts a draft', () => {
    const html = renderEditor({ initial: scopeData({ open_draft: null }) });
    assert.match(html, /published v2/);
    assert.match(html, /edit — start a draft/);
    assert.ok(!/<textarea(?![^>]*disabled)/.test(html), 'every text area is disabled');
  });

  test('read-only for a deboarded client: no buttons, every input disabled', () => {
    const html = renderEditor({ initial: scopeData(), readOnly: true });
    assert.doesNotMatch(html, /save draft|review &amp; publish|start a draft/);
    assert.ok(!/<input type="text"(?![^>]*disabled)/.test(html.replace(/<input type="checkbox"[^>]*>/g, '')));
    assert.match(html, /read-only/);
  });

  test('nothing published and no draft is an empty state that says what to do', () => {
    assert.match(renderEditor({ initial: scopeData({ current: null, open_draft: null }) }), /start a draft from the defaults, fill it in, and publish it/);
  });
});

describe('the version history', () => {
  const versions = [
    { id: 'v2', version: 2, published_at: '2026-09-29T15:00:00Z', source: 'draft', note: 'new hours', rollback_of_version_id: null },
    { id: 'v1', version: 1, published_at: '2026-09-28T15:00:00Z', source: 'draft', note: null, rollback_of_version_id: null },
  ];

  test('loading, empty, and a list with compare boxes and a restore on every version but the live one', () => {
    assert.match(renderHistory(), /reading the history…/);
    assert.match(renderHistory({ initial: [] }), /nothing published yet/);
    const html = renderHistory({ initial: versions, current: { id: 'v2', version: 2 } });
    assert.match(html, /aria-label="compare v2"/);
    assert.match(html, /aria-label="compare v1"/);
    assert.equal((html.match(/restore…/g) ?? []).length, 1);
    assert.match(html, /compare the two ticked/);
  });

  test('restore is off while a draft is open', () => {
    const html = renderHistory({ initial: versions, current: { id: 'v2', version: 2 }, readOnly: true });
    assert.doesNotMatch(html, /restore…/);
    assert.match(html, /restore is off while a draft is open/);
  });
});

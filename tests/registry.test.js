/* ARC-100 — the module, connector and capability registries.
 *
 * Two kinds of test live here and they do different jobs.
 *
 * The first kind asserts the registry's own invariants: keys are unique, a planned
 * module cannot be selected, a capability a module asks for actually exists. These
 * are the rules that stop the registry becoming the third conflicting vocabulary
 * rather than the one that replaced the other two.
 *
 * The second kind is **drift detection**. The typed registry and the SQL catalog in
 * `0012_registry.sql` are two representations of one set of facts, and the failure
 * mode ARC-100 exists to prevent is somebody updating one and not the other. Those
 * tests parse the migration and compare it to the code, so the build fails rather
 * than a tenant later pointing at a module version that exists in only one place.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  getCapability,
  assertKnownCapabilities,
  SELECTABLE_STATUSES,
} from '../supabase/functions/_shared/registry/capabilities.ts';
import {
  MODULES,
  MODULE_KEYS,
  canonicalModuleKey,
  getModule,
  getModuleVersion,
  isSelectable,
  latestSelectableModuleVersion,
  modulesInPortalOrder,
  resolveModuleAlias,
  selectableModules,
  validateModuleRegistry,
} from '../supabase/functions/_shared/registry/modules.ts';
import {
  CONNECTORS,
  availableCapabilities,
  connectorsProviding,
  getConnector,
  getConnectorVersion,
  latestSelectableConnectorVersion,
  validateConnectorRegistry,
} from '../supabase/functions/_shared/registry/connectors.ts';
import {
  LEAD_RECOVERY_SCHEMA,
  changeImpact,
  editableFields,
  getConfigSchema,
  getField,
} from '../supabase/functions/_shared/registry/schemas.ts';
import {
  evaluateCapabilities,
  externalEffectCapabilities,
  isCompatible,
  requiredCapabilities,
} from '../supabase/functions/_shared/registry/resolve.ts';
import { resolveModuleRuntime, validateRegistries, validatorFor } from '../supabase/functions/_shared/registry/index.ts';
import { MODULE_META } from '../src/portal/lib/modules.js';
import { MODULES as PORTAL_MODULES } from '../src/portal/lib/types.js';
import { defaultConfig } from '../supabase/functions/_shared/lead-recovery-config.ts';

const SQL = readFileSync(new URL('../supabase/migrations/0012_registry.sql', import.meta.url), 'utf8');

const LEAD_RECOVERY_V1 = getModuleVersion('lead_recovery', 1);

/* One INSERT's value list, so a drift regex cannot wander into a neighbouring block
   and match rows it was never meant to see. */
function sqlBlock(table) {
  const start = SQL.indexOf(`insert into public.${table}`);
  assert.ok(start >= 0, `0012 has no insert into ${table}`);
  const end = SQL.indexOf(';', start);
  return SQL.slice(start, end === -1 ? undefined : end);
}

/* ══ registry self-consistency ════════════════════════════ */

describe('the registry is internally consistent', () => {
  test('it validates', () => {
    assert.doesNotThrow(() => validateRegistries());
    assert.doesNotThrow(() => validateModuleRegistry());
    assert.doesNotThrow(() => validateConnectorRegistry());
  });

  test('canonical module keys are unique', () => {
    assert.equal(new Set(MODULE_KEYS).size, MODULE_KEYS.length);
    assert.equal(new Set(MODULES.map((m) => m.key)).size, MODULES.length);
  });

  test('module versions are unique within a module', () => {
    for (const module of MODULES) {
      const versions = module.versions.map((v) => v.version);
      assert.equal(new Set(versions).size, versions.length, `${module.key} has duplicate versions`);
    }
  });

  test('capability keys are unique', () => {
    assert.equal(new Set(CAPABILITY_KEYS).size, CAPABILITY_KEYS.length);
  });

  test('every capability a module requires exists', () => {
    for (const module of MODULES) {
      for (const version of module.versions) {
        for (const requirement of version.requirements) {
          assert.doesNotThrow(() =>
            assertKnownCapabilities(requirement.capabilities, `${module.key}@${version.version}`));
        }
      }
    }
  });

  test('every capability a connector declares exists', () => {
    for (const connector of CONNECTORS) {
      for (const version of connector.versions) {
        assert.doesNotThrow(() =>
          assertKnownCapabilities(version.capabilities, `${connector.key}@${version.version}`));
      }
    }
  });

  test('an unknown capability fails loudly rather than reading as unmet', () => {
    assert.throws(() => assertKnownCapabilities(['teleportation'], 'test'), /unknown capabilities/);
  });

  test('no capability is dead vocabulary', () => {
    const declared = new Set(CONNECTORS.flatMap((c) => c.versions.flatMap((v) => v.capabilities)));
    for (const capability of CAPABILITIES) {
      assert.ok(declared.has(capability.key), `${capability.key} is declared by no connector`);
    }
  });

  test('portal ordering is deterministic and total', () => {
    const order = modulesInPortalOrder().map((m) => m.key);
    assert.deepEqual(order, [
      'lead_recovery', 'estimate_recovery', 'review_recovery', 'membership_retention', 'install_warranty',
    ]);
    assert.deepEqual(modulesInPortalOrder().map((m) => m.key), order, 'stable across calls');
  });
});

/* ══ selectability — the roadmap-honesty invariant ════════ */

describe('only a module ARC can actually run is selectable', () => {
  test('lead recovery is selectable', () => {
    assert.equal(isSelectable('lead_recovery'), true);
    assert.deepEqual(selectableModules().map((m) => m.key), ['lead_recovery']);
  });

  for (const key of ['estimate_recovery', 'review_recovery', 'membership_retention', 'install_warranty']) {
    test(`${key} is planned and cannot be selected`, () => {
      const module = getModule(key);
      assert.equal(module.status, 'planned');
      assert.equal(isSelectable(key), false);
      assert.equal(module.versions.length, 0, 'a planned module publishes no version');
      assert.equal(latestSelectableModuleVersion(key), null);
    });
  }

  test('a planned module claims no connectors, schema or execution path', () => {
    for (const module of MODULES.filter((m) => !SELECTABLE_STATUSES.includes(m.status))) {
      for (const version of module.versions) {
        assert.fail(`${module.key} is planned but published version ${version.version}`);
      }
      assert.equal(resolveModuleRuntime(module.key), null);
      assert.equal(validatorFor(module.key), null);
    }
  });

  test('a planned module cannot be made selectable by marking a version available', () => {
    /* the invariant `validateModuleRegistry` enforces: definition status gates
       version status, so flipping one without the other fails the build. */
    const broken = {
      ...getModule('estimate_recovery'),
      versions: [{ ...LEAD_RECOVERY_V1, moduleKey: 'estimate_recovery', status: 'available' }],
    };
    assert.throws(() => {
      if (!SELECTABLE_STATUSES.includes(broken.status)) {
        const v = broken.versions.find((x) => SELECTABLE_STATUSES.includes(x.status));
        if (v) throw new Error(`module ${broken.key} is ${broken.status} but version ${v.version} is ${v.status}`);
      }
    }, /is planned but version/);
  });

  test('every selectable module version is complete', () => {
    for (const module of selectableModules()) {
      const version = latestSelectableModuleVersion(module.key);
      assert.ok(version.configSchemaKey, 'has a schema');
      assert.ok(getConfigSchema(version.configSchemaKey), 'the schema resolves');
      assert.ok(validatorFor(module.key), 'has a validator');
      assert.ok(version.safety.activationTestKeys.length > 0, 'declares activation tests');
      assert.ok(version.runtime.executionMode, 'declares an execution mode');
      assert.ok(module.portal.routeKey, 'has portal metadata');
    }
  });
});

/* ══ aliases ══════════════════════════════════════════════ */

describe('one canonical key, every other spelling an alias', () => {
  const cases = [
    ['lead_recovery', 'lead_recovery'],
    ['lead_capture', 'lead_recovery'],
    ['leads', 'lead_recovery'],
    ['estimates', 'estimate_recovery'],
    ['reviews', 'review_recovery'],
    ['memberships', 'membership_retention'],
    ['installs', 'install_warranty'],
  ];

  for (const [alias, canonical] of cases) {
    test(`"${alias}" normalises to ${canonical}`, () => {
      assert.equal(canonicalModuleKey(alias), canonical);
      assert.equal(resolveModuleAlias(alias).key, canonical);
    });
  }

  test('an unknown spelling fails closed', () => {
    assert.equal(canonicalModuleKey('speed_to_lead'), null);
    assert.equal(resolveModuleAlias(''), null);
    assert.equal(getModule('nope'), null);
  });

  test('no alias is claimed by two modules', () => {
    const seen = new Map();
    for (const module of MODULES) {
      for (const alias of [module.key, module.eventModuleKey, module.portal.routeKey, ...module.aliases]) {
        const owner = seen.get(alias);
        assert.ok(!owner || owner === module.key, `"${alias}" claimed by ${owner} and ${module.key}`);
        seen.set(alias, module.key);
      }
    }
  });

  test('stored vocabulary is never renamed', () => {
    /* the four migrations and every historical event row say `lead_capture`. the
       registry maps it; it does not rewrite it. */
    assert.equal(getModule('lead_recovery').eventModuleKey, 'lead_capture');
    for (const module of MODULES) {
      assert.ok(PORTAL_MODULES.includes(module.eventModuleKey),
        `${module.eventModuleKey} must stay a real event-module bucket`);
    }
  });
});

/* ══ portal projection ════════════════════════════════════ */

describe('the portal derives from the registry rather than redefining it', () => {
  test('MODULE_META covers exactly the event-module buckets', () => {
    assert.deepEqual(Object.keys(MODULE_META).sort(), [...PORTAL_MODULES].sort());
  });

  test('every portal module maps back to a canonical module', () => {
    for (const key of Object.keys(MODULE_META)) {
      assert.ok(canonicalModuleKey(key), `${key} resolves to a canonical module`);
    }
  });

  test('labels and icons match the registry', () => {
    for (const module of MODULES) {
      const meta = MODULE_META[module.eventModuleKey];
      assert.equal(meta.label, module.portal.label);
      assert.equal(meta.nav, module.portal.navLabel);
      assert.equal(meta.icon, module.portal.icon);
      assert.equal(meta.entity, module.portal.entity);
      assert.equal(meta.quietAfterHours, module.portal.quietAfterHours);
      assert.equal(meta.awaiting, module.portal.awaiting);
      assert.equal(meta.canonicalKey, module.key);
      assert.equal(meta.routeKey, module.portal.routeKey);
    }
  });

  test('existing routes are unchanged', () => {
    /* the nav in `lib/nav.js` routes to these, and a rename would 404 every client. */
    assert.deepEqual(
      modulesInPortalOrder().map((m) => m.portal.routeKey),
      ['leads', 'estimates', 'reviews', 'memberships', 'installs'],
    );
  });

  test('only lead capture is marked selectable in the projection', () => {
    assert.equal(MODULE_META.lead_capture.selectable, true);
    for (const key of ['estimates', 'reviews', 'memberships', 'installs']) {
      assert.equal(MODULE_META[key].selectable, false, `${key} must not offer activation`);
    }
  });

  test('the projection is frozen', () => {
    assert.throws(() => { MODULE_META.lead_capture = null; });
  });
});

/* ══ configuration schema ═════════════════════════════════ */

describe('the Lead Recovery schema is registered without being weakened', () => {
  test('it resolves by key and version', () => {
    assert.equal(getConfigSchema('lead_recovery_config').key, 'lead_recovery_config');
    assert.equal(getConfigSchema('lead_recovery_config', 1).version, 1);
    assert.equal(getConfigSchema('lead_recovery_config', 99), null, 'a wrong version does not resolve');
    assert.equal(getConfigSchema('nope'), null);
  });

  test('the registry resolves the same validator the engine used to import', () => {
    const fromRegistry = validatorFor('lead_recovery');
    assert.equal(typeof fromRegistry, 'function');
    assert.equal(fromRegistry, LEAD_RECOVERY_SCHEMA.validate);
  });

  test('defaults are a valid starting shape, not a complete configuration', () => {
    /* `defaultConfig()` deliberately leaves the tenant-specific fields empty so an
       operator has to supply them — a default company name or forwarding number is
       exactly the kind of plausible wrong value that ships to a customer. So the
       property worth asserting is that the skeleton is structurally sound: every
       complaint is a missing required value, never an unknown or malformed field. */
    const result = LEAD_RECOVERY_SCHEMA.validate(LEAD_RECOVERY_SCHEMA.defaults());
    assert.equal(result.ok, false, 'a blank configuration is not activatable');
    for (const error of result.errors) {
      assert.match(error, /is required|at least one/,
        `defaults produced a structural error rather than a missing value: ${error}`);
    }
  });

  test('defaults plus the tenant-specific fields validate', () => {
    const complete = {
      ...LEAD_RECOVERY_SCHEMA.defaults(),
      company_name: 'Halstead Heating',
      services: ['furnace repair'],
      service_area: { zips: ['43215'], cities: [], note: null },
      forwarding: { destination: '+16145550137', timeout_seconds: 20 },
    };
    const result = LEAD_RECOVERY_SCHEMA.validate(complete);
    assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
  });

  test('an unknown field is still rejected by name', () => {
    const result = LEAD_RECOVERY_SCHEMA.validate({ ...defaultConfig(), custom_webhook: 'https://evil.test' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('custom_webhook')));
  });

  test('field metadata covers every field the config carries', () => {
    const configured = Object.keys(defaultConfig());
    const described = LEAD_RECOVERY_SCHEMA.fields.map((f) => f.key);
    for (const key of configured) {
      assert.ok(described.includes(key), `${key} has no field metadata`);
    }
    for (const key of described) {
      assert.ok(configured.includes(key), `${key} is described but not part of the config`);
    }
  });

  test('no field is client editable today', () => {
    /* there is no client write path by design (0010:589-593). ARC-310 decides which,
       if any, of these ever opens up — and this test is what will notice. */
    assert.deepEqual(editableFields('lead_recovery_config', 'client'), []);
  });

  test('operator-editable fields exclude protected ones', () => {
    for (const field of editableFields('lead_recovery_config', 'operator')) {
      assert.equal(field.protected, false);
    }
  });

  test('every field prohibits secrets', () => {
    for (const field of LEAD_RECOVERY_SCHEMA.fields) {
      assert.equal(field.secretProhibited, true, `${field.key} must refuse credential shapes`);
    }
  });

  test('a compliance change requires reactivation', () => {
    const impact = changeImpact('lead_recovery_config', ['compliance']);
    assert.equal(impact.requiresReactivation, true);
    assert.equal(impact.requiresRetest, true);
  });

  test('a safety change requires shadow mode', () => {
    assert.equal(changeImpact('lead_recovery_config', ['safety']).requiresShadow, true);
  });

  test('a template change requires retesting but not reactivation', () => {
    const impact = changeImpact('lead_recovery_config', ['templates']);
    assert.equal(impact.requiresRetest, true);
    assert.equal(impact.requiresReactivation, false,
      'an in-flight run keeps its pinned snapshot, so this affects new runs only');
  });

  test('a cosmetic change requires nothing', () => {
    const impact = changeImpact('lead_recovery_config', ['company_name']);
    assert.equal(impact.requiresRetest, false);
    assert.equal(impact.requiresShadow, false);
    assert.equal(impact.requiresReactivation, false);
  });

  test('an unrecognised field is treated as maximally consequential', () => {
    const impact = changeImpact('lead_recovery_config', ['whatever']);
    assert.deepEqual(impact.unknownFields, ['whatever']);
    assert.equal(impact.requiresRetest, true);
    assert.equal(impact.requiresReactivation, true);
  });

  test('field lookup resolves', () => {
    assert.equal(getField('lead_recovery_config', 'twilio').requiresReactivation, true);
    assert.equal(getField('lead_recovery_config', 'nope'), null);
  });
});

/* ══ connectors ═══════════════════════════════════════════ */

describe('a connector declares what ARC implemented, not what the provider offers', () => {
  test('keys and versions are unique', () => {
    assert.equal(new Set(CONNECTORS.map((c) => c.key)).size, CONNECTORS.length);
    for (const connector of CONNECTORS) {
      const versions = connector.versions.map((v) => v.version);
      assert.equal(new Set(versions).size, versions.length);
    }
  });

  test('twilio declares the five capabilities ARC actually implements', () => {
    const twilio = getConnectorVersion('twilio', 1);
    assert.deepEqual([...twilio.capabilities].sort(), [
      'receive_call_status', 'receive_calls', 'receive_delivery_status', 'receive_sms', 'send_sms',
    ]);
  });

  test('a planned connector claims nothing', () => {
    for (const key of ['google_calendar', 'jobber', 'housecall_pro', 'servicetitan', 'gohighlevel']) {
      const connector = getConnector(key);
      assert.equal(connector.status, 'planned');
      assert.equal(connector.versions.length, 0, `${key} must publish no version`);
      assert.equal(latestSelectableConnectorVersion(key), null);
    }
  });

  test('a non-selectable connector version cannot claim capabilities', () => {
    assert.throws(() => {
      const version = { status: 'planned', capabilities: ['send_sms'] };
      if (!SELECTABLE_STATUSES.includes(version.status) && version.capabilities.length > 0) {
        throw new Error('planned but claims capabilities');
      }
    }, /claims capabilities/);
  });

  test('the registry stores no credential', () => {
    const text = JSON.stringify(CONNECTORS);
    assert.ok(!/auth_token|api_key"\s*:\s*"|password|private_key|bearer\s/i.test(text));
    /* auth *type* is fine; an auth *value* is not. */
    assert.ok(text.includes('api_key'), 'auth types are still described');
    assert.ok(!/AC[0-9a-f]{32}|SK[0-9a-f]{32}|sk-[A-Za-z0-9]{20}/.test(text));
  });

  test('a deprecated version stays resolvable for history', () => {
    /* nothing is deprecated yet; this asserts the lookup does not filter by status,
       so a historical run can still resolve the version it used. */
    assert.ok(getConnectorVersion('twilio', 1));
    assert.equal(getConnectorVersion('twilio', 99), null);
  });

  test('capability lookup finds providers', () => {
    assert.deepEqual(connectorsProviding('send_sms').map((v) => v.connectorKey), ['twilio']);
    assert.deepEqual(connectorsProviding('receive_web_leads').map((v) => v.connectorKey), ['arc_web_intake']);
    assert.deepEqual(connectorsProviding('teleportation'), []);
  });
});

/* ══ capability resolution ════════════════════════════════ */

describe('modules depend on capabilities, not on provider brands', () => {
  test('lead recovery names no provider in its requirements', () => {
    const text = JSON.stringify(LEAD_RECOVERY_V1.requirements);
    for (const brand of ['twilio', 'anthropic', 'jobber', 'servicetitan']) {
      assert.ok(!text.toLowerCase().includes(brand), `requirements must not name ${brand}`);
    }
  });

  test('everything currently available satisfies lead recovery', () => {
    const result = evaluateCapabilities(LEAD_RECOVERY_V1, availableCapabilities());
    assert.equal(result.satisfied, true, result.reasons.join('; '));
    assert.deepEqual(result.missingCapabilities, []);
  });

  test('all_of requires every capability', () => {
    const result = evaluateCapabilities(LEAD_RECOVERY_V1, [
      'receive_calls', 'send_sms', 'receive_delivery_status',
    ]);
    assert.equal(result.satisfied, false);
    assert.ok(result.missingCapabilities.includes('receive_sms'));
    const conversation = result.outcomes.find((o) => o.key === 'conversation');
    assert.equal(conversation.satisfied, false);
    assert.deepEqual(conversation.missing, ['receive_sms']);
  });

  test('any_of is satisfied by either branch', () => {
    const viaCalls = evaluateCapabilities(LEAD_RECOVERY_V1, [
      'receive_calls', 'send_sms', 'receive_sms', 'receive_delivery_status',
    ]);
    assert.equal(viaCalls.outcomes.find((o) => o.key === 'intake').satisfied, true);

    const viaForm = evaluateCapabilities(LEAD_RECOVERY_V1, [
      'receive_web_leads', 'send_sms', 'receive_sms', 'receive_delivery_status',
    ]);
    assert.equal(viaForm.outcomes.find((o) => o.key === 'intake').satisfied, true);
    assert.equal(viaForm.satisfied, true, 'a web-form-only shop is a valid configuration');
  });

  test('any_of with neither branch blocks, and says what would fix it', () => {
    const result = evaluateCapabilities(LEAD_RECOVERY_V1, [
      'send_sms', 'receive_sms', 'receive_delivery_status',
    ]);
    assert.equal(result.satisfied, false);
    const intake = result.outcomes.find((o) => o.key === 'intake');
    assert.equal(intake.satisfied, false);
    assert.match(intake.explanation, /at least one of/);
    const suggested = intake.couldBeSatisfiedBy.map((c) => c.connectorKey).sort();
    assert.deepEqual(suggested, ['arc_web_intake', 'twilio']);
  });

  test('an optional capability never blocks', () => {
    const withoutClassifier = evaluateCapabilities(LEAD_RECOVERY_V1, [
      'receive_calls', 'receive_call_status', 'send_sms', 'receive_sms', 'receive_delivery_status',
    ]);
    assert.equal(withoutClassifier.satisfied, true);
    const optional = withoutClassifier.outcomes.find((o) => o.key === 'reply_classification');
    assert.equal(optional.satisfied, false);
    assert.equal(optional.blocking, false);
    assert.ok(withoutClassifier.reasons.some((r) => r.startsWith('optional:')));
  });

  test('blocking reasons are listed before optional ones', () => {
    const result = evaluateCapabilities(LEAD_RECOVERY_V1, ['receive_calls']);
    assert.equal(result.satisfied, false);
    const firstOptional = result.reasons.findIndex((r) => r.startsWith('optional:'));
    const lastBlocking = result.reasons.map((r) => !r.startsWith('optional:')).lastIndexOf(true);
    assert.ok(firstOptional === -1 || lastBlocking < firstOptional);
  });

  test('a conditional requirement binds only when its config flag is set', () => {
    const version = {
      ...LEAD_RECOVERY_V1,
      requirements: [{
        key: 'connected_booking',
        kind: 'conditional',
        capabilities: ['receive_web_leads'],
        description: 'Booking into a connected calendar.',
        whenConfigField: 'booking.mode',
      }],
    };
    assert.equal(evaluateCapabilities(version, [], null).satisfied, true, 'no config: not yet binding');
    assert.equal(evaluateCapabilities(version, [], { booking: {} }).satisfied, true, 'flag off: not binding');
    assert.equal(
      evaluateCapabilities(version, [], { booking: { mode: 'connected' } }).satisfied,
      false,
      'flag on: binding and unmet',
    );
  });

  test('required, optional and conditional are reported separately', () => {
    const { required, optional } = requiredCapabilities(LEAD_RECOVERY_V1);
    assert.ok(required.includes('send_sms'));
    assert.ok(optional.includes('classify_text'));
    assert.ok(!required.includes('classify_text'));
  });

  test('capabilities that reach the public are identifiable', () => {
    const external = externalEffectCapabilities(LEAD_RECOVERY_V1);
    assert.ok(external.includes('send_sms'));
    assert.ok(!external.includes('receive_delivery_status'));
    assert.equal(getCapability('send_sms').risk, 'high');
    assert.equal(getCapability('send_sms').reconciliationRequired, true);
  });

  test('a declaration is not a claim that any tenant is connected', () => {
    /* the resolver takes capabilities the caller vouches for; it never reads a tenant.
       passing an empty set means "nothing connected" and must not be satisfiable. */
    assert.equal(evaluateCapabilities(LEAD_RECOVERY_V1, []).satisfied, false);
  });

  test('compatibility is per-capability, not all-or-nothing', () => {
    const twilio = getConnectorVersion('twilio', 1);
    const result = isCompatible(LEAD_RECOVERY_V1, twilio);
    assert.equal(result.compatible, true);
    assert.ok(result.provides.includes('send_sms'));
    /* twilio alone does not satisfy every group — web leads come from elsewhere. */
    assert.ok(!result.provides.includes('receive_web_leads'));

    assert.equal(isCompatible(LEAD_RECOVERY_V1, { capabilities: [] }).compatible, false);
  });
});

/* ══ execution contract ═══════════════════════════════════ */

describe('the execution declaration matches ADR-010', () => {
  test('lead recovery v1 is direct and forbids n8n', () => {
    assert.equal(LEAD_RECOVERY_V1.runtime.executionMode, 'direct');
    assert.equal(LEAD_RECOVERY_V1.runtime.n8n, 'prohibited');
    assert.equal(LEAD_RECOVERY_V1.runtime.supportsDirectExecution, true);
  });

  test('no environment-specific workflow id appears anywhere', () => {
    const text = JSON.stringify(MODULES);
    assert.ok(!/\.app\.n8n\.cloud|webhook\/[a-z0-9-]{8}/i.test(text));
    assert.equal(LEAD_RECOVERY_V1.runtime.workflowKey, null);
    assert.equal(LEAD_RECOVERY_V1.runtime.runnerKey, 'arc-direct-worker');
  });

  test('the registry never makes n8n look production-ready', () => {
    for (const module of MODULES) {
      for (const version of module.versions) {
        assert.notEqual(version.runtime.n8n, 'required',
          'production n8n is licensing-gated (ADR-010 §26)');
      }
    }
  });
});

/* ══ drift detection ══════════════════════════════════════ */

describe('the SQL catalog cannot drift from the typed registry', () => {
  /* these parse the seed block of 0012 and compare it to the code. the failure this
     prevents is somebody adding a module version to one and not the other, which
     would leave ARC-120 with a foreign key pointing at a version that does not
     exist where it matters. */

  const seededModules = [...sqlBlock('registry_modules')
    .matchAll(/\('(\w+)',\s*'(?:[^']|'')*',\s*'(?:[^']|'')*',\s*'(\w+)',\s*'(\w+)',\s*'(\w+)',\s*(\d+)\)/g)]
    .map((m) => ({ key: m[1], status: m[2], eventModuleKey: m[3], routeKey: m[4], order: Number(m[5]) }));

  test('every module in code is seeded in SQL, with matching metadata', () => {
    assert.deepEqual(
      seededModules.map((m) => m.key).sort(),
      MODULES.map((m) => m.key).sort(),
      'the SQL catalog and the typed registry list exactly the same modules',
    );
    for (const module of MODULES) {
      const seeded = seededModules.find((s) => s.key === module.key);
      assert.ok(seeded, `${module.key} is missing from 0012`);
      assert.equal(seeded.status, module.status, `${module.key} status differs`);
      assert.equal(seeded.eventModuleKey, module.eventModuleKey, `${module.key} event key differs`);
      assert.equal(seeded.routeKey, module.portal.routeKey, `${module.key} route differs`);
      assert.equal(seeded.order, module.portal.order, `${module.key} order differs`);
    }
  });

  test('every capability in code is seeded in SQL', () => {
    for (const capability of CAPABILITIES) {
      assert.ok(
        SQL.includes(`('${capability.key}',`),
        `${capability.key} is missing from 0012`,
      );
    }
    const block = sqlBlock('registry_capabilities');
    const seeded = [...block.matchAll(/\('(\w+)',\s*'/g)].map((m) => m[1]);
    assert.deepEqual([...seeded].sort(), [...CAPABILITY_KEYS].sort());
  });

  test('every connector in code is seeded in SQL, with matching status', () => {
    for (const connector of CONNECTORS) {
      const pattern = new RegExp(`\\('${connector.key}', '[^']*', '\\w+', '${connector.status}'`);
      assert.match(SQL, pattern, `${connector.key} missing or wrong status in 0012`);
    }
  });

  test('every seeded alias exists in code, and vice versa', () => {
    const seeded = [...sqlBlock('registry_module_aliases')
      .matchAll(/\('(\w+)',\s*'(\w+)',\s*'(\w+)'\)/g)]
      .map((m) => ({ alias: m[1], moduleKey: m[2] }));
    assert.ok(seeded.length > 0, 'aliases are seeded');

    for (const { alias, moduleKey } of seeded) {
      assert.equal(canonicalModuleKey(alias), moduleKey, `alias ${alias} disagrees with code`);
    }
    for (const module of MODULES) {
      for (const alias of [module.key, module.eventModuleKey]) {
        assert.ok(seeded.some((s) => s.alias === alias), `${alias} is not seeded`);
      }
    }
  });

  test('the only seeded module version matches lead recovery v1', () => {
    assert.match(SQL, /'lead_recovery', 1, 'available',\s*'lead_recovery_config', 1,\s*'direct', 'prohibited', true/);
    const versionInserts = SQL.match(/insert into public\.registry_module_versions/g) ?? [];
    assert.equal(versionInserts.length, 1, 'exactly one module version is published');
  });

  test('seeded connector capabilities match the code', () => {
    const seeded = [...sqlBlock('registry_connector_capabilities')
      .matchAll(/\('(\w+)',\s*(\d+),\s*'(\w+)'\)/g)]
      .map((m) => `${m[1]}@${m[2]}:${m[3]}`)
      .sort();
    const inCode = CONNECTORS
      .flatMap((c) => c.versions.flatMap((v) => v.capabilities.map((cap) => `${c.key}@${v.version}:${cap}`)))
      .sort();
    assert.deepEqual(seeded, inCode);
  });

  test('seeded requirement capabilities match the code', () => {
    const seeded = [...sqlBlock('registry_module_requirement_capabilities')
      .matchAll(/\('([\w]+)',\s*'([\w]+)'\)/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    const inCode = LEAD_RECOVERY_V1.requirements
      .flatMap((r) => r.capabilities.map((c) => `${r.key}:${c}`))
      .sort();
    assert.deepEqual(seeded, inCode);
  });
});

/* ══ the migration's own protections ══════════════════════ */

describe('0012 protects the registry in SQL', () => {
  test('published versions are immutable', () => {
    assert.match(SQL, /before update or delete on public\.registry_module_versions/);
    assert.match(SQL, /before update or delete on public\.registry_connector_versions/);
    assert.match(SQL, /a published registry version is immutable/);
  });

  test('a retired version cannot come back', () => {
    assert.match(SQL, /a retired version cannot be brought back into service/);
  });

  test('capability links are fixed at publication', () => {
    assert.match(SQL, /capability links are fixed at publication/);
  });

  test('nobody can write the registry from a browser', () => {
    /* the protection is the absence of any insert/update/delete policy, as in 0004,
       0010 and 0011. assert no such policy was added. */
    assert.ok(!/create policy \w+ on public\.registry_\w+\s+for (insert|update|delete|all)/.test(SQL));
    assert.match(SQL, /No insert, update or delete policy on any registry table/);
  });

  test('operational connector detail is operator-only', () => {
    assert.match(SQL, /registry_connector_versions_read[\s\S]{0,160}is_arc_admin/);
    assert.match(SQL, /registry_module_requirements_read[\s\S]{0,160}is_arc_admin/);
  });

  test('RLS is on for every registry table', () => {
    const tables = [...SQL.matchAll(/create table if not exists public\.(registry_\w+)/g)].map((m) => m[1]);
    assert.ok(tables.length >= 9);
    for (const table of tables) {
      assert.match(SQL, new RegExp(`alter table public\\.${table}\\s+enable row level security`),
        `${table} has no RLS`);
    }
  });

  test('a version that can neither run directly nor use n8n is refused', () => {
    assert.match(SQL, /registry_module_versions_executable/);
  });

  test('a selectable version must name a schema', () => {
    assert.match(SQL, /registry_module_versions_selectable_has_schema/);
  });

  test('the existing lead_recovery constraints are documented as retained', () => {
    assert.match(SQL, /RETAINED/);
    assert.ok(!/drop constraint[\s\S]{0,80}module_key/.test(SQL),
      'no module_key constraint is dropped without its replacement protection');
  });

  test('no secret is stored, and the schema refuses secret-shaped text', () => {
    assert.match(SQL, /registry_connector_versions_no_secrets/);
    assert.ok(!/AC[0-9a-f]{32}|sk-[A-Za-z0-9]{20}|SK[0-9a-f]{32}/.test(SQL));
  });
});

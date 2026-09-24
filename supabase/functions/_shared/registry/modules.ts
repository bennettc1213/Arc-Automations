/**
 * The module registry — ARC's one canonical product vocabulary.
 *
 * Before this file the repository had two, and they disagreed. The portal knew five
 * modules (`lead_capture`, `estimates`, `reviews`, `memberships`, `installs`) as
 * display buckets for derived figures; the execution engine knew exactly one
 * (`lead_recovery`) enforced by check constraints. A tenant could have
 * `lead_recovery` switched on without `lead_capture` declared, which was harmless
 * only because `lead_capture` is always on.
 *
 * The reconciliation here is deliberate about what it does *not* do:
 *
 *   - It does not rename anything in the database. `tenants.modules` still stores
 *     `lead_capture`; events still derive their module from `event_type`. Renaming
 *     stored values would rewrite history to tidy a vocabulary.
 *   - It does not make the four observation-only modules real. They are `planned`:
 *     they have no validator, no capabilities, no execution path, and they cannot be
 *     selected or activated. The portal keeps rendering them because clients whose
 *     CRM posts estimate events still see estimate figures — that is reporting, not
 *     a module ARC runs.
 *
 * What it does do is make one key canonical and every other spelling an alias that
 * normalises at the boundary.
 *
 * **Portal-safe.** This file is imported by the browser bundle, so it carries no
 * validator and no executable contract — `configSchemaKey` is a string that
 * `registry/schemas.ts` (server-side) resolves. That split is what keeps the
 * 900-line Lead Recovery validator out of the client bundle.
 */

import {
  assertKnownCapabilities,
  type LifecycleStatus,
  SELECTABLE_STATUSES,
} from './capabilities.ts';

/* ── canonical keys ─────────────────────────────────────── */

export const MODULE_KEYS = [
  'lead_recovery',
  'estimate_recovery',
  'review_recovery',
  'membership_retention',
  'install_warranty',
] as const;
export type ModuleKey = typeof MODULE_KEYS[number];

/* ── execution ──────────────────────────────────────────── */

/** ADR-010 §30. Operator-owned; a client never sees or sets this. */
export const EXECUTION_MODES = ['direct', 'n8n', 'hybrid'] as const;
export type ExecutionMode = typeof EXECUTION_MODES[number];

/** ADR-010 §26: production n8n is licensing-gated, so a module may forbid it outright. */
export const N8N_POSTURES = ['prohibited', 'optional', 'required'] as const;
export type N8nPosture = typeof N8N_POSTURES[number];

/* ── capability requirements ────────────────────────────── */

/**
 * A requirement group.
 *
 * `all_of` — every capability listed is needed.
 * `any_of` — at least one satisfies the group, which is how a module says "some way
 *            of taking a lead in" without naming Twilio.
 * `optional` — never blocks activation; records that a feature degrades without it.
 * `conditional` — required only when a configuration flag is set, which is how
 *            connected-calendar booking stays optional until somebody chooses it.
 */
export interface CapabilityRequirement {
  key: string;
  kind: 'all_of' | 'any_of' | 'optional' | 'conditional';
  capabilities: readonly string[];
  description: string;
  /** for `conditional`: the config field whose truthiness turns this on. */
  whenConfigField?: string;
}

/* ── field metadata ─────────────────────────────────────── */

export const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'enum', 'list', 'object', 'phone', 'timezone',
] as const;
export type FieldType = typeof FIELD_TYPES[number];

/**
 * What ARC-110 and ARC-310 need to know about one configuration field.
 *
 * The three `requires*` flags are the load-bearing ones and they are **registry
 * metadata, never inferred from a field name**: ADR-010 §16 says a template edit
 * affects new runs only, while a compliance change must block. Only trusted metadata
 * can make that call.
 */
export interface FieldMetadata {
  key: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  clientEditable: boolean;
  operatorEditable: boolean;
  /** system-controlled: not editable by anyone through configuration. */
  protected: boolean;
  /** the validator refuses credential-shaped values in this field. */
  secretProhibited: boolean;
  requiresRetest: boolean;
  requiresShadow: boolean;
  requiresReactivation: boolean;
  sensitiveDisplay: boolean;
  control: 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'list' | 'group';
  visibleWhen?: { field: string; equals: unknown };
  deprecated?: boolean;
  /**
   * Which configuration scope stores this field (ARC-110). Absent means the schema's own
   * scope. `'tenant'` on a module schema's field means the value lives in the tenant-wide
   * settings document and is composed into the module's effective configuration — a
   * module document may not carry it, so no two scopes ever hold the same key.
   */
  ownerScope?: 'tenant';
}

/* ── module versions ────────────────────────────────────── */

export interface ModuleVersion {
  moduleKey: ModuleKey;
  version: number;
  status: LifecycleStatus;

  configSchemaKey: string | null;
  configSchemaVersion: number | null;

  requirements: readonly CapabilityRequirement[];

  runtime: {
    triggers: readonly string[];
    actions: readonly string[];
    eventTypes: readonly string[];
    executionMode: ExecutionMode;
    n8n: N8nPosture;
    supportsDirectExecution: boolean;
    runnerKey: string | null;
    workflowKey: string | null;
    workflowContractVersion: number | null;
  };

  safety: {
    requiresConsent: boolean;
    requiresHumanHandoff: boolean;
    requiresDeterministicSafetyRules: boolean;
    requiresApprovedTemplates: boolean;
    activationTestKeys: readonly string[];
    requiresShadowMode: boolean;
    monitoringChecks: readonly string[];
  };

  deprecatedBy?: { moduleKey: ModuleKey; version: number };
  limitation?: string;
}

export interface ModulePortalProjection {
  routeKey: string;
  navLabel: string;
  label: string;
  title: string;
  blurb: string;
  icon: string;
  entity: string;
  /** hours of silence before the portal calls a live module quiet. */
  quietAfterHours: number;
  awaiting: string;
  order: number;
}

export interface ModuleDefinition {
  key: ModuleKey;
  displayName: string;
  description: string;
  status: LifecycleStatus;
  /**
   * The value this module's events and `tenants.modules` already use.
   *
   * Not renamed, ever. `lead_recovery`'s bucket is `lead_capture` because that is
   * what four migrations and every historical event row already say.
   */
  eventModuleKey: string;
  /** every other spelling that must normalise to `key`. */
  aliases: readonly string[];
  portal: ModulePortalProjection;
  versions: readonly ModuleVersion[];
}

/* ── the registry ───────────────────────────────────────── */

export const MODULES: readonly ModuleDefinition[] = Object.freeze([
  {
    key: 'lead_recovery',
    displayName: 'Lead Recovery',
    description:
      'A missed call or a website form becomes a lead, a text back, and either a routed job or a person.',
    status: 'available',
    eventModuleKey: 'lead_capture',
    aliases: ['lead_capture', 'leads'],
    portal: {
      routeKey: 'leads',
      navLabel: 'lead capture',
      label: 'lead capture',
      title: 'lead capture',
      blurb: 'every opportunity that came in, and how fast it was answered',
      icon: 'leads',
      entity: 'lead',
      quietAfterHours: 48,
      awaiting:
        'lead capture is being wired up. nothing has come through it yet — the first call or form will appear here within seconds of it happening.',
      order: 1,
    },
    versions: [
      {
        moduleKey: 'lead_recovery',
        version: 1,
        status: 'available',
        configSchemaKey: 'lead_recovery_config',
        configSchemaVersion: 1,
        requirements: [
          {
            key: 'intake',
            kind: 'any_of',
            capabilities: ['receive_calls', 'receive_web_leads'],
            description: 'Some way for a lead to arrive — a forwarded number, a website form, or both.',
          },
          {
            key: 'missed_call_detection',
            kind: 'optional',
            capabilities: ['receive_call_status'],
            description: 'Without the dial-result callback, only web-form leads are recoverable.',
          },
          {
            key: 'conversation',
            kind: 'all_of',
            capabilities: ['send_sms', 'receive_sms'],
            description: 'Texting the caller back, and hearing the reply — including STOP.',
          },
          {
            key: 'delivery_evidence',
            kind: 'all_of',
            capabilities: ['receive_delivery_status'],
            description: 'Settling whether a sent message actually arrived.',
          },
          {
            key: 'reply_classification',
            kind: 'optional',
            capabilities: ['classify_text'],
            description:
              'Without a classifier every reply goes to a person, which is the safe default rather than a failure.',
          },
        ],
        runtime: {
          triggers: ['twilio_voice', 'twilio_dial_status', 'twilio_inbound_sms', 'web_form', 'scheduled_action'],
          actions: [
            'send_first_response', 'send_followup', 'classify_reply',
            'route_to_contractor', 'open_handoff', 'close_run', 'notify_staff',
          ],
          eventTypes: [
            'call_missed', 'lead_received', 'sms_sent', 'message_delivered', 'message_failed',
            'lead_qualified', 'routed', 'task_opened', 'automation_failed',
          ],
          /* ADR-010 §11: Lead Recovery v1 is direct end to end. n8n is in none of its
             29 operations, so a licensing gate cannot block this module. */
          executionMode: 'direct',
          n8n: 'prohibited',
          supportsDirectExecution: true,
          runnerKey: 'arc-direct-worker',
          workflowKey: null,
          workflowContractVersion: null,
        },
        safety: {
          requiresConsent: true,
          requiresHumanHandoff: true,
          requiresDeterministicSafetyRules: true,
          requiresApprovedTemplates: true,
          /* the nine required steps of the existing eleven-step gate. */
          activationTestKeys: [
            'tenant_created', 'business_rules', 'staff_destination_verified',
            'twilio_connected', 'routing_tested', 'templates_approved',
            'consent_recorded', 'compliance_approved', 'canary_passed',
          ],
          /* ARC-120 built shadow mode. v1's first activation does not require it — this
             published contract is frozen, and changing it would be a new version — but a
             change the registry marks `requiresShadow` (the safety rules) still requires
             shadow evidence before the module goes live again (CHANGE_IMPACT_POLICY). */
          requiresShadowMode: false,
          monitoringChecks: ['dispatcher_heartbeat', 'effect_reconciliation_queue'],
        },
      },
    ],
  },

  /* ── planned. reporting buckets, not modules ARC runs. ────
     Each of these renders figures folded out of the event log by `lib/lifecycle.js`
     when a client's own systems post them. None has a validator, capabilities, an
     execution path or an activation gate, and none can be selected. */
  {
    key: 'estimate_recovery',
    displayName: 'Estimate Recovery',
    description: 'Unsold estimates chased to a decision.',
    status: 'planned',
    eventModuleKey: 'estimates',
    aliases: ['estimates'],
    portal: {
      routeKey: 'estimates',
      navLabel: 'estimates',
      label: 'estimate recovery',
      title: 'estimate recovery',
      blurb: 'open quotes waiting on a decision, and what came back',
      icon: 'reports',
      entity: 'estimate',
      quietAfterHours: 72,
      awaiting:
        'estimate recovery is being wired up. once your estimates are syncing, every open quote and the follow-up against it will show here.',
      order: 2,
    },
    versions: [],
  },
  {
    key: 'review_recovery',
    displayName: 'Reviews & Service Recovery',
    description: 'Review requests after a completed job, and the unhappy ones caught first.',
    status: 'planned',
    eventModuleKey: 'reviews',
    aliases: ['reviews'],
    portal: {
      routeKey: 'reviews',
      navLabel: 'reviews',
      label: 'reviews & recovery',
      title: 'reviews & service recovery',
      blurb: 'requests sent, reviews received, and the cases that need a person',
      icon: 'reviews',
      entity: 'review request',
      quietAfterHours: 96,
      awaiting:
        'review requests are being wired up. once completed jobs are syncing, every request and the response to it will show here.',
      order: 3,
    },
    versions: [],
  },
  {
    key: 'membership_retention',
    displayName: 'Membership Retention',
    description: 'Maintenance plans renewed before they lapse.',
    status: 'planned',
    eventModuleKey: 'memberships',
    aliases: ['memberships'],
    portal: {
      routeKey: 'memberships',
      navLabel: 'memberships',
      label: 'memberships',
      title: 'memberships',
      blurb: 'plans due, renewals won, and the ones that lapsed',
      icon: 'memberships',
      entity: 'membership',
      quietAfterHours: 168,
      awaiting:
        'membership renewals are being wired up. once your plans are syncing, every renewal due and the outcome will show here.',
      order: 4,
    },
    versions: [],
  },
  {
    key: 'install_warranty',
    displayName: 'Install & Warranty',
    description: 'New equipment registered for warranty before the window closes.',
    status: 'planned',
    eventModuleKey: 'installs',
    aliases: ['installs'],
    portal: {
      routeKey: 'installs',
      navLabel: 'installs',
      label: 'installs & warranty',
      title: 'installs & warranty registration',
      blurb: 'equipment installed, and whether the warranty was registered in time',
      icon: 'installs',
      entity: 'install',
      quietAfterHours: 168,
      awaiting:
        'warranty registration is being wired up. once installs are syncing, every registration and its deadline will show here.',
      order: 5,
    },
    versions: [],
  },
]);

/* ── resolution ─────────────────────────────────────────── */

const BY_KEY = new Map<string, ModuleDefinition>(MODULES.map((m) => [m.key, m]));

/**
 * Every spelling ARC will accept, mapped to the canonical key.
 *
 * Built once and frozen. A collision here is a programming error and throws at import
 * rather than silently letting one alias win.
 */
const BY_ALIAS: Map<string, ModuleDefinition> = (() => {
  const map = new Map<string, ModuleDefinition>();
  for (const module of MODULES) {
    for (const alias of [module.key, module.eventModuleKey, module.portal.routeKey, ...module.aliases]) {
      const existing = map.get(alias);
      if (existing && existing.key !== module.key) {
        throw new Error(`alias "${alias}" is claimed by both ${existing.key} and ${module.key}`);
      }
      map.set(alias, module);
    }
  }
  return map;
})();

export function getModule(key: string): ModuleDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Normalise any accepted spelling to the canonical module.
 *
 * This is the controlled compatibility boundary. Call it at the edge — a route param,
 * a `tenants.modules` value, an event's derived bucket — and work in canonical keys
 * from there on. Returns null for anything unrecognised so callers fail closed.
 */
export function resolveModuleAlias(alias: string): ModuleDefinition | null {
  return BY_ALIAS.get(alias) ?? null;
}

/** The canonical key for any accepted spelling, or null. */
export function canonicalModuleKey(alias: string): ModuleKey | null {
  return BY_ALIAS.get(alias)?.key ?? null;
}

export function getModuleVersion(key: string, version: number): ModuleVersion | null {
  return BY_KEY.get(key)?.versions.find((v) => v.version === version) ?? null;
}

/** The newest version a tenant could be given. Null for a planned module. */
export function latestSelectableModuleVersion(key: string): ModuleVersion | null {
  const versions = (BY_KEY.get(key)?.versions ?? [])
    .filter((v) => SELECTABLE_STATUSES.includes(v.status))
    .sort((a, b) => b.version - a.version);
  return versions[0] ?? null;
}

/**
 * Whether a tenant may be given this module at all.
 *
 * Both the definition and at least one version must be selectable. A `planned`
 * module is never selectable however its versions are marked, which is the invariant
 * that stops the four reporting buckets being switched on.
 */
export function isSelectable(key: string): boolean {
  const module = BY_KEY.get(key);
  if (!module || !SELECTABLE_STATUSES.includes(module.status)) return false;
  return module.versions.some((v) => SELECTABLE_STATUSES.includes(v.status));
}

export function selectableModules(): ModuleDefinition[] {
  return MODULES.filter((m) => isSelectable(m.key));
}

/** Deterministic portal ordering. Never depends on object key order. */
export function modulesInPortalOrder(): ModuleDefinition[] {
  return [...MODULES].sort((a, b) => a.portal.order - b.portal.order);
}

/* ── self-validation, called by the drift tests ─────────── */

export function validateModuleRegistry(): void {
  const seenKeys = new Set<string>();
  const seenRoutes = new Set<string>();
  const seenEventKeys = new Set<string>();
  const seenOrders = new Set<number>();

  for (const module of MODULES) {
    if (seenKeys.has(module.key)) throw new Error(`duplicate module key: ${module.key}`);
    seenKeys.add(module.key);

    if (seenRoutes.has(module.portal.routeKey)) {
      throw new Error(`duplicate portal route key: ${module.portal.routeKey}`);
    }
    seenRoutes.add(module.portal.routeKey);

    if (seenEventKeys.has(module.eventModuleKey)) {
      throw new Error(`duplicate event module key: ${module.eventModuleKey}`);
    }
    seenEventKeys.add(module.eventModuleKey);

    if (seenOrders.has(module.portal.order)) {
      throw new Error(`duplicate portal order: ${module.portal.order}`);
    }
    seenOrders.add(module.portal.order);

    const versions = new Set<number>();
    for (const version of module.versions) {
      if (versions.has(version.version)) {
        throw new Error(`duplicate version ${version.version} for module ${module.key}`);
      }
      versions.add(version.version);

      if (version.moduleKey !== module.key) {
        throw new Error(`module version ${module.key}@${version.version} carries the wrong key`);
      }

      for (const requirement of version.requirements) {
        assertKnownCapabilities(
          requirement.capabilities,
          `module ${module.key}@${version.version} requirement "${requirement.key}"`,
        );
        if (requirement.kind === 'conditional' && !requirement.whenConfigField) {
          throw new Error(
            `conditional requirement "${requirement.key}" on ${module.key}@${version.version} names no config field`,
          );
        }
      }

      /* a selectable version has to be complete enough to activate. */
      if (SELECTABLE_STATUSES.includes(version.status)) {
        if (!version.configSchemaKey) {
          throw new Error(`selectable ${module.key}@${version.version} has no configuration schema`);
        }
        if (version.safety.activationTestKeys.length === 0) {
          throw new Error(`selectable ${module.key}@${version.version} declares no activation tests`);
        }
        if (!version.runtime.supportsDirectExecution && version.runtime.n8n === 'prohibited') {
          throw new Error(
            `${module.key}@${version.version} can neither run directly nor use n8n`,
          );
        }
      }
    }

    /* the invariant the four reporting buckets rest on. */
    if (!SELECTABLE_STATUSES.includes(module.status)) {
      const selectableVersion = module.versions.find((v) => SELECTABLE_STATUSES.includes(v.status));
      if (selectableVersion) {
        throw new Error(
          `module ${module.key} is ${module.status} but version ${selectableVersion.version} is ${selectableVersion.status}`,
        );
      }
    }
  }
}

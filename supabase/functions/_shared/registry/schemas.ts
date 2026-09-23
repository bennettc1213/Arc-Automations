/**
 * Registered configuration schemas — the executable half of the module registry.
 *
 * Kept apart from `modules.ts` on purpose. That file is imported by the browser
 * bundle and carries only metadata; this one imports the validators and is
 * server-side. The split is what lets the portal read module labels without pulling
 * the whole Lead Recovery validator into the client bundle, and it is the
 * "safe client-facing projection versus internal operational definition" separation
 * ARC-100 asks for.
 *
 * **The Lead Recovery validator is wrapped, not rewritten.** `validateLeadRecoveryConfig`
 * is the same function the engine has always called: whitelist keys, closed
 * placeholder list, credential-shape refusal, cross-field checks, validated again on
 * read. Registration adds an addressable identity and field-level metadata around it.
 * Nothing about what it accepts or rejects changes — the regression tests in
 * `tests/lead-recovery.test.js` are the proof.
 */

import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  type ConfigResult,
  validateLeadRecoveryConfig,
} from '../lead-recovery-config.ts';
import type { FieldMetadata } from './modules.ts';

export interface ConfigSchema {
  key: string;
  version: number;
  displayName: string;
  /** the trusted server-side validator. the only thing permitted to accept config. */
  validate(input: unknown): ConfigResult;
  /** a complete, valid configuration to start from. */
  defaults(): Record<string, unknown>;
  /** the schema rejects any key it does not know, by name. */
  rejectsUnknownFields: true;
  fields: readonly FieldMetadata[];
}

/**
 * Field metadata for Lead Recovery.
 *
 * The three `requires*` flags are trusted registry metadata and are **never inferred
 * from a field name** — ADR-010 §16 draws the line between a change that affects only
 * new runs (a template edit; ARC-015 pins each run to a snapshot, so an in-flight
 * sequence keeps its approved words) and one that must block execution until somebody
 * re-approves (compliance status, the sending number).
 *
 * `clientEditable` is false everywhere today. There is no client write path by design
 * (`0010:589–593`), and ARC-310 will decide which of these ever opens up. Recording
 * the intent now means that decision is a metadata change, not a hunt through a form.
 */
const LEAD_RECOVERY_FIELDS: readonly FieldMetadata[] = Object.freeze([
  {
    key: 'company_name',
    type: 'string',
    label: 'company name',
    help: 'How the business names itself in a text to a customer.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: false,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'text',
  },
  {
    key: 'timezone',
    type: 'timezone',
    label: 'timezone',
    help: 'Drives business hours and the after-hours branch.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    /* changes when a message may be sent, so a routing dry-run should be repeated. */
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'select',
  },
  {
    key: 'business_hours',
    type: 'object',
    label: 'business hours',
    help: 'When an automated first response may go out.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'holidays',
    type: 'list',
    label: 'holidays',
    help: 'Dates treated as closed.',
    required: false,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: false,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'list',
  },
  {
    key: 'services',
    type: 'list',
    label: 'services',
    help: 'What the shop does. Used for qualification, not for sending.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: false,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'list',
  },
  {
    key: 'service_area',
    type: 'object',
    label: 'service area',
    help: 'ZIP codes and cities the shop will travel to.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: false,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'forwarding',
    type: 'object',
    label: 'call forwarding',
    help: 'The number an inbound call is forwarded to, and how long it rings.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    /* somebody has to answer a test call on the new number before this is trusted. */
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'staff_alerts',
    type: 'list',
    label: 'staff alerts',
    help: 'Who is texted when a lead is routed or a person is needed.',
    required: false,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    /* real mobile numbers of the client's staff. */
    sensitiveDisplay: true,
    control: 'list',
  },
  {
    key: 'booking_url',
    type: 'string',
    label: 'booking link',
    help: 'Optional scheduling link offered in a reply.',
    required: false,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: false,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'text',
  },
  {
    key: 'templates',
    type: 'object',
    label: 'message templates',
    help: 'The exact reviewed words sent to a customer. A model never writes these.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    /* the client has to read and approve the wording again. an in-flight run keeps
       its pinned snapshot, so this affects new runs only. */
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'after_hours',
    type: 'object',
    label: 'after-hours behaviour',
    help: 'What happens to a lead that arrives outside business hours.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'safety',
    type: 'object',
    label: 'safety rules',
    help: 'Emergency keywords and services that always go straight to a person.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    /* loosening a safety rule is the change most worth watching before it is live. */
    requiresShadow: true,
    requiresReactivation: true,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'ai',
    type: 'object',
    label: 'reply classification',
    help: 'Whether a model helps read replies. It can only add caution, never remove it.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: false,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'compliance',
    type: 'object',
    label: 'messaging compliance',
    help: 'Brand and campaign registration, and the opt-out sentence the engine appends.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    /* operator-attested, and the engine refuses to send unless it reads "approved". */
    protected: false,
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    /* the one field whose change must stop a live module until somebody re-approves. */
    requiresReactivation: true,
    sensitiveDisplay: false,
    control: 'group',
  },
  {
    key: 'twilio',
    type: 'object',
    label: 'Twilio resources',
    help:
      'Non-secret identifiers: subaccount SID, messaging service SID, number. The account SID and auth token are ARC platform secrets and never appear here.',
    required: true,
    clientEditable: false,
    operatorEditable: true,
    protected: false,
    /* enforced twice over: the validator refuses credential shapes and the column
       carries a check constraint against secret-shaped strings. */
    secretProhibited: true,
    requiresRetest: true,
    requiresShadow: false,
    requiresReactivation: true,
    sensitiveDisplay: false,
    control: 'group',
  },
]);

export const LEAD_RECOVERY_SCHEMA: ConfigSchema = Object.freeze({
  key: 'lead_recovery_config',
  version: CONFIG_SCHEMA_VERSION,
  displayName: 'Lead Recovery configuration',
  validate: validateLeadRecoveryConfig,
  defaults: () => defaultConfig() as unknown as Record<string, unknown>,
  rejectsUnknownFields: true,
  fields: LEAD_RECOVERY_FIELDS,
});

export const CONFIG_SCHEMAS: readonly ConfigSchema[] = Object.freeze([LEAD_RECOVERY_SCHEMA]);

const BY_KEY = new Map(CONFIG_SCHEMAS.map((s) => [s.key, s]));

export function getConfigSchema(key: string, version?: number): ConfigSchema | null {
  const schema = BY_KEY.get(key);
  if (!schema) return null;
  if (version !== undefined && schema.version !== version) return null;
  return schema;
}

export function getField(schemaKey: string, fieldKey: string): FieldMetadata | null {
  return BY_KEY.get(schemaKey)?.fields.find((f) => f.key === fieldKey) ?? null;
}

/**
 * Which fields a given audience may edit.
 *
 * ARC-310 will render from this rather than from a hand-maintained form, and ARC-110
 * will refuse a patch that touches anything outside it.
 */
export function editableFields(schemaKey: string, actor: 'client' | 'operator'): FieldMetadata[] {
  const schema = BY_KEY.get(schemaKey);
  if (!schema) return [];
  return schema.fields.filter((f) => {
    if (f.protected) return false;
    return actor === 'client' ? f.clientEditable : f.operatorEditable;
  });
}

/** Which consequences a set of changed fields carries. ARC-110 and ARC-120 read this. */
export function changeImpact(schemaKey: string, changedFields: readonly string[]): {
  requiresRetest: boolean;
  requiresShadow: boolean;
  requiresReactivation: boolean;
  unknownFields: string[];
} {
  const schema = BY_KEY.get(schemaKey);
  if (!schema) {
    return { requiresRetest: false, requiresShadow: false, requiresReactivation: false, unknownFields: [...changedFields] };
  }
  const unknownFields: string[] = [];
  let requiresRetest = false;
  let requiresShadow = false;
  let requiresReactivation = false;

  for (const key of changedFields) {
    const field = schema.fields.find((f) => f.key === key);
    if (!field) {
      unknownFields.push(key);
      /* an unrecognised field is treated as maximally consequential rather than
         ignored. the alternative lets a typo slip a change past every gate. */
      requiresRetest = true;
      requiresReactivation = true;
      continue;
    }
    requiresRetest ||= field.requiresRetest;
    requiresShadow ||= field.requiresShadow;
    requiresReactivation ||= field.requiresReactivation;
  }
  return { requiresRetest, requiresShadow, requiresReactivation, unknownFields };
}

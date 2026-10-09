/**
 * ARC-310 — how the settings screen draws the inside of a field. Presentation only.
 *
 * The registry's field metadata (`schemas.ts`) describes each top-level field — its label,
 * its control, what a change to it requires — and the validator owns every rule about its
 * contents. What neither says is how to lay out the parts of a group or the items of a
 * list, which is all this file adds. Nothing here accepts or rejects a value: a layout that
 * named a part the validator does not know would simply draw an input the server refuses,
 * and `tests/config-settings.test.js` checks every part here against the schema's own
 * default document so that cannot drift quietly.
 *
 * A field with no layout is drawn as a JSON box, validated by the server like any other.
 */

import {
  AFTER_HOURS_BEHAVIOURS,
  AI_PROVIDERS,
  ALERT_CHANNELS,
  COMPLIANCE_STATUSES,
  FORWARDING_MODES,
} from '../lead-recovery-config.ts';

export type PartControl =
  | 'text'      // one line; empty is null
  | 'select'    // one of `options`, which are the validator's own constants
  | 'textarea'  // several lines, for wording a customer reads
  | 'number'
  | 'toggle'
  | 'lines'     // a list of short strings, one per line
  | 'ranges';   // a day's opening hours, "08:00-12:00, 13:00-17:00"; empty is closed

export interface RecordColumn {
  key: string;
  label: string;
  /** a closed set the validator accepts, offered as a select. */
  options?: readonly string[];
}

export interface FieldLayout {
  /** a group: its parts, in the order drawn. */
  parts?: readonly { key: string; label: string; control: PartControl; options?: readonly string[] }[];
  /** a list: plain strings one per line, or records with columns. */
  items?: 'text' | { columns: readonly RecordColumn[] };
}

const DAYS = [
  ['mon', 'monday'], ['tue', 'tuesday'], ['wed', 'wednesday'], ['thu', 'thursday'],
  ['fri', 'friday'], ['sat', 'saturday'], ['sun', 'sunday'],
] as const;

const LEAD_RECOVERY_LAYOUT: Readonly<Record<string, FieldLayout>> = Object.freeze({
  business_hours: { parts: DAYS.map(([key, label]) => ({ key, label, control: 'ranges' as const })) },
  holidays: { items: 'text' },
  services: { items: 'text' },
  service_area: {
    parts: [
      { key: 'zips', label: 'ZIP codes', control: 'lines' },
      { key: 'cities', label: 'cities', control: 'lines' },
      { key: 'note', label: 'note', control: 'text' },
    ],
  },
  forwarding: {
    parts: [
      { key: 'mode', label: 'which number customers dial', control: 'select', options: FORWARDING_MODES },
      { key: 'destination', label: 'the business’s own number', control: 'text' },
      { key: 'timeout_seconds', label: 'ring for (seconds)', control: 'number' },
    ],
  },
  staff_alerts: {
    items: {
      columns: [
        { key: 'name', label: 'name' },
        { key: 'channel', label: 'channel', options: ALERT_CHANNELS },
        { key: 'address', label: 'number or address' },
      ],
    },
  },
  templates: {
    parts: [
      { key: 'first_response', label: 'first response', control: 'textarea' },
      { key: 'after_hours_response', label: 'after-hours response', control: 'textarea' },
      { key: 'followup', label: 'follow-up', control: 'textarea' },
      { key: 'handoff_ack', label: 'handoff acknowledgement', control: 'textarea' },
      { key: 'reply_ack', label: 'after they reply', control: 'textarea' },
      { key: 'reply_ack_booking', label: 'after they reply, with the booking link', control: 'textarea' },
    ],
  },
  after_hours: {
    parts: [
      { key: 'behaviour', label: 'behaviour', control: 'select', options: AFTER_HOURS_BEHAVIOURS },
      { key: 'callback_window', label: 'callback window', control: 'text' },
    ],
  },
  safety: {
    parts: [
      { key: 'emergency_keywords', label: 'emergency keywords', control: 'lines' },
      { key: 'always_handoff_services', label: 'always hand off these services', control: 'lines' },
      { key: 'confidence_floor', label: 'confidence floor (0–1)', control: 'number' },
      { key: 'handoff_on_ambiguous_scope', label: 'hand off when the job is unclear', control: 'toggle' },
    ],
  },
  ai: {
    parts: [
      { key: 'enabled', label: 'use a model to help read replies', control: 'toggle' },
      { key: 'provider', label: 'provider', control: 'select', options: AI_PROVIDERS },
      { key: 'model', label: 'model', control: 'text' },
    ],
  },
  compliance: {
    parts: [
      { key: 'status', label: 'status', control: 'select', options: COMPLIANCE_STATUSES },
      { key: 'brand_registered', label: 'brand registered', control: 'toggle' },
      { key: 'campaign_ref', label: 'campaign reference', control: 'text' },
      { key: 'reviewed_at', label: 'reviewed on', control: 'text' },
      { key: 'opt_out_language', label: 'opt-out sentence', control: 'text' },
    ],
  },
  twilio: {
    parts: [
      { key: 'subaccount_sid', label: 'subaccount SID', control: 'text' },
      { key: 'messaging_service_sid', label: 'messaging service SID', control: 'text' },
      { key: 'phone_number', label: 'phone number', control: 'text' },
      { key: 'phone_number_sid', label: 'phone number SID', control: 'text' },
    ],
  },
});

const LAYOUTS: Readonly<Record<string, Readonly<Record<string, FieldLayout>>>> = Object.freeze({
  lead_recovery_config: LEAD_RECOVERY_LAYOUT,
  tenant_settings: {},
});

export function fieldLayout(schemaKey: string, fieldKey: string): FieldLayout | null {
  return LAYOUTS[schemaKey]?.[fieldKey] ?? null;
}

export function layoutsFor(schemaKey: string): Readonly<Record<string, FieldLayout>> {
  return LAYOUTS[schemaKey] ?? {};
}

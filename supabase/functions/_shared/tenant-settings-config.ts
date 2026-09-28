/**
 * Tenant-wide settings — the facts about a business that are not any one module's.
 *
 * ARC-110 splits configuration into two scopes. A module's document holds what only that
 * module means (Lead Recovery's templates, hours, forwarding). This document holds what
 * every module of the same tenant must agree on: the name the business goes by and the
 * timezone its day is measured in. Estimate Recovery will text under the same name and
 * count the same working day; storing those twice would let two modules disagree about
 * who the customer is talking to.
 *
 * The two scopes never share a key. `registry/schemas.ts` declares which fields a module
 * takes from here (`ownerScope: 'tenant'`), so composing the effective configuration is a
 * disjoint union rather than a precedence rule — there is no case where a module value
 * and a tenant value for the same field both exist and one has to win.
 *
 * Validated exactly as strictly as Lead Recovery: unknown keys refused by name, and the
 * same credential and executable-content scan (`scanForForbidden`), imported rather than
 * copied, so there is one list of what a secret looks like.
 */

import { isValidTimezone, scanForForbidden } from './lead-recovery-config.ts';

export const TENANT_SETTINGS_SCHEMA_KEY = 'tenant_settings';
export const TENANT_SETTINGS_SCHEMA_VERSION = 1;

export interface TenantSettings {
  company_name: string;
  timezone: string;
}

export type TenantSettingsResult =
  | { ok: true; config: TenantSettings; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export const TENANT_SETTINGS_FIELDS = ['company_name', 'timezone'] as const;

/**
 * The starting point for a tenant's first draft.
 *
 * Deliberately not valid on its own: a default company name is exactly the plausible
 * wrong value that ships to a customer, so the operator has to type the real one.
 */
export function defaultTenantSettings(): TenantSettings {
  return { company_name: '', timezone: 'America/New_York' };
}

export function validateTenantSettings(input: unknown): TenantSettingsResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['tenant settings must be a JSON object'], warnings };
  }
  const value = input as Record<string, unknown>;

  scanForForbidden(value, '', errors);
  for (const key of Object.keys(value)) {
    if (!(TENANT_SETTINGS_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${key} is not a tenant-wide setting. Known: ${TENANT_SETTINGS_FIELDS.join(', ')}`);
    }
  }

  let companyName: string | null = null;
  if (typeof value.company_name !== 'string' || value.company_name.trim() === '') {
    errors.push('company_name is required — it is the name that appears in every text');
  } else if (value.company_name.trim().length > 80) {
    errors.push('company_name is longer than 80 characters');
  } else {
    companyName = value.company_name.trim();
  }

  /* required here, unlike in the Lead Recovery validator, which falls back to a default
     zone when the field is absent. a tenant-wide default is the one place a silent
     fallback would decide every module's working day for them. */
  let timezone: string | null = null;
  if (typeof value.timezone !== 'string' || value.timezone.trim() === '') {
    errors.push('timezone is required — every hours decision is made in it');
  } else if (value.timezone.trim().length > 64) {
    errors.push('timezone is longer than 64 characters');
  } else if (!isValidTimezone(value.timezone.trim())) {
    errors.push(`timezone "${value.timezone.trim()}" is not an IANA zone (for example America/Denver)`);
  } else {
    timezone = value.timezone.trim();
  }

  if (errors.length > 0 || companyName === null || timezone === null) return { ok: false, errors, warnings };
  return { ok: true, warnings, config: { company_name: companyName, timezone } };
}

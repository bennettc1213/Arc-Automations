/**
 * What a business's own owner may publish, and nothing else (decided 2026-10-13).
 *
 * Publishing configuration is an operator action. This is the one exception, and it is a
 * closed list: the words of three texts, and whether and when the one follow-up goes. An
 * owner cannot reach a number, an hour, a service area, a compliance field or any other
 * template through it — `ownerWordingViolations` is asked by the engine before anything is
 * written and again by 0034 in SQL (`config_owner_wording_violation`), and a test holds the
 * two lists together.
 *
 * Why wording is safe to hand over: a template is still a template. The validator's closed
 * placeholder list, its length cap and the credential check apply to an owner's words exactly
 * as to an operator's, the opt-out sentence is appended by the engine and is not theirs to
 * remove, and a model still writes none of it.
 *
 * Why it does not wait for a retest: the registry marks a wording change `requiresRetest`
 * because "the client has to read and approve the wording again". When the client wrote it,
 * that has happened. The version records the waiver (`owner_authored`) rather than hiding
 * it, and every other consequence of a change still applies.
 *
 * Portal-safe: imports only the canonical serialiser.
 */

import { canonicalJson } from '../canonical-json.ts';

export const OWNER_WORDING_MODULE = 'lead_recovery';

/**
 * The top-level fields an owner's publication may differ in. `questions` is which of the
 * reviewed questions ARC asks after a reply, and in what order (0036): a closed list of
 * keys, each a template, so it is wording too.
 */
export const OWNER_WORDING_FIELDS = ['templates', 'followup', 'questions'] as const;

/** The templates inside `templates` an owner may change. Mirrored in 0034, widened by 0036. */
export const OWNER_WORDING_TEMPLATES = [
  'first_response', 'first_response_form', 'followup',
  'question_service', 'question_location', 'question_urgency', 'question_timing',
] as const;

export type OwnerTemplateKey = (typeof OWNER_WORDING_TEMPLATES)[number];

export interface OwnerWording {
  /** a string sets the words; null removes the key, which puts back the reviewed default (`first_response_form` has none). */
  templates?: Partial<Record<OwnerTemplateKey, string | null>>;
  followup?: { enabled: boolean; after_minutes?: number };
  /** which questions are asked, in order. an empty list asks none. */
  questions?: { ask: string[] };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * Every place the two module documents differ outside what an owner may publish.
 * Empty means the change is wording and only wording.
 */
export function ownerWordingViolations(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((OWNER_WORDING_FIELDS as readonly string[]).includes(key)) continue;
    if (!same(before[key], after[key])) out.push(key);
  }
  const was = isPlainObject(before.templates) ? before.templates : {};
  const now = isPlainObject(after.templates) ? after.templates : {};
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if ((OWNER_WORDING_TEMPLATES as readonly string[]).includes(key)) continue;
    if (!same(was[key], now[key])) out.push(`templates.${key}`);
  }
  return out.sort();
}

/** The module document with an owner's wording applied to it. Touches nothing else. */
export function applyOwnerWording(document: Record<string, unknown>, wording: OwnerWording): Record<string, unknown> {
  const next: Record<string, unknown> = { ...document };
  if (wording.templates) {
    const templates: Record<string, unknown> = { ...(isPlainObject(document.templates) ? document.templates : {}) };
    for (const key of OWNER_WORDING_TEMPLATES) {
      const value = wording.templates[key];
      if (value === undefined) continue;
      if (value === null) delete templates[key];
      else templates[key] = value;
    }
    next.templates = templates;
  }
  if (wording.followup) {
    next.followup = {
      ...(isPlainObject(document.followup) ? document.followup : {}),
      enabled: wording.followup.enabled,
      ...(wording.followup.after_minutes === undefined ? {} : { after_minutes: wording.followup.after_minutes }),
    };
  }
  if (wording.questions) {
    /* the wait for an answer is not the owner's to set here, so whatever is published stays. */
    next.questions = {
      ...(isPlainObject(document.questions) ? document.questions : {}),
      ask: [...wording.questions.ask],
    };
  }
  return next;
}

/**
 * The recorded impact of an owner's wording publication: the registry's own answer, with
 * the retest it would have asked for waived and the waiver written down. A change that
 * would need anything more than a retest is not one this path may publish at all.
 */
export function ownerWordingImpact(impact: Record<string, unknown>): { ok: true; impact: Record<string, unknown> } | { ok: false; reason: string } {
  if (impact.requires_shadow === true || impact.requires_reactivation === true) {
    return { ok: false, reason: 'this change needs more than a retest, which an owner cannot publish' };
  }
  if (Array.isArray(impact.unknown_fields) && impact.unknown_fields.length > 0) {
    return { ok: false, reason: 'this change touches a field the registry does not describe' };
  }
  return {
    ok: true,
    impact: {
      ...impact,
      requires_retest: false,
      owner_authored: { waived: impact.requires_retest === true ? ['retest'] : [], fields: [...OWNER_WORDING_FIELDS] },
    },
  };
}

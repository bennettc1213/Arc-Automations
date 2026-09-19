/**
 * The Lead Recovery configuration contract.
 *
 * This file is the answer to the only question a multi-tenant SaaS has to keep answering:
 * where is a customer allowed to be different? Here, and nowhere else. There is one
 * engine, one prompt, one set of templates and one deployment; an HVAC shop in Columbus
 * and a plumber in Boise differ by the contents of `module_configs.config` and by nothing
 * else. A tenant that needs behaviour this shape cannot express is a change to the shared
 * engine, not a branch, a copied workflow or a second database.
 *
 * Three rules the validator enforces rather than documents:
 *
 * 1. **Unknown keys are rejected.** A whitelist, not a denylist. It is the difference
 *    between configuration and a scripting language: the moment an unrecognised key is
 *    tolerated, somebody stores behaviour in one and something downstream grows a branch to
 *    read it, and the shared engine has quietly forked.
 *
 * 2. **No executable logic, anywhere.** No expressions, no callbacks, no template syntax
 *    beyond a closed list of placeholders. A config that can compute is a config that can
 *    be made to compute something nobody reviewed, on a channel that reaches customers.
 *
 * 3. **No credentials.** Twilio's account and messaging-service references are non-secret
 *    identifiers and live here; the auth token and API key live in function secrets and
 *    are rejected on sight if they are pasted in. The database carries a second, blunter
 *    version of this check as a constraint, because the cost of being wrong is a secret in
 *    a table an operator can read.
 *
 * Pure, dependency-free and node-importable: the ops console imports it to validate before
 * it writes, the `ops` edge function imports it to validate what actually arrives, and the
 * test suite imports it directly. One definition, three callers — the browser's copy is a
 * convenience, and the server never trusts it.
 */

export const CONFIG_SCHEMA_VERSION = 1;

export const MODULE_KEY = 'lead_recovery';

/* ── vocabularies ───────────────────────────────────────── */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const AFTER_HOURS_BEHAVIOURS = [
  /* answer immediately with the same text, day or night. what most shops want: the point
     of the product is that nobody waits. */
  'same_response',
  /* answer immediately, but with copy that says when somebody will actually call back. */
  'after_hours_response',
  /* say nothing until opening time, then send. for trades whose out-of-hours work is
     priced differently and who do not want to imply availability. */
  'queue_until_open',
  /* send nothing at all outside hours. */
  'do_not_send',
] as const;

export const COMPLIANCE_STATUSES = ['not_started', 'pending', 'approved', 'rejected'] as const;

export const AI_PROVIDERS = ['anthropic', 'none'] as const;

export const ALERT_CHANNELS = ['sms', 'email'] as const;

/* The placeholders a template may contain. A closed list, because the alternative is an
   expression evaluator pointed at customer-facing copy. Anything else between braces is a
   rejection, not a literal. */
export const TEMPLATE_PLACEHOLDERS = [
  'company',
  'customer_name',
  'booking_url',
  'callback_window',
] as const;

export const TEMPLATE_KEYS = [
  'first_response',
  'after_hours_response',
  'followup',
  'handoff_ack',
] as const;

/** Every template is one SMS segment's worth of room plus the opt-out line. */
export const MAX_TEMPLATE_CHARS = 320;

/* ── the shape ──────────────────────────────────────────── */

export interface BusinessHourRange {
  open: string;
  close: string;
}

export interface LeadRecoveryConfig {
  company_name: string;
  timezone: string;
  business_hours: Record<string, BusinessHourRange[]>;
  holidays: string[];
  services: string[];
  service_area: { zips: string[]; cities: string[]; note: string | null };
  forwarding: { destination: string; timeout_seconds: number };
  staff_alerts: { name: string | null; channel: string; address: string }[];
  booking_url: string | null;
  templates: Record<string, string>;
  after_hours: { behaviour: string; callback_window: string | null };
  safety: {
    emergency_keywords: string[];
    always_handoff_services: string[];
    confidence_floor: number;
    handoff_on_ambiguous_scope: boolean;
  };
  ai: { enabled: boolean; provider: string; model: string | null };
  compliance: {
    status: string;
    brand_registered: boolean;
    campaign_ref: string | null;
    reviewed_at: string | null;
    opt_out_language: string;
  };
  twilio: {
    subaccount_sid: string | null;
    messaging_service_sid: string | null;
    phone_number: string | null;
    phone_number_sid: string | null;
  };
}

export type ConfigResult =
  | { ok: true; config: LeadRecoveryConfig; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/* ── primitives ─────────────────────────────────────────── */

const E164 = /^\+[1-9][0-9]{7,15}$/;
const ZIP = /^[0-9]{5}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AC_SID = /^AC[0-9a-fA-F]{32}$/;
const MG_SID = /^MG[0-9a-fA-F]{32}$/;
const PN_SID = /^PN[0-9a-fA-F]{32}$/;

/**
 * What a credential looks like when somebody pastes one into the wrong box.
 *
 * The bare-32-hex rule is the load-bearing one: a Twilio auth token is exactly that, and it
 * is indistinguishable from a legitimate value by anything except the fact that nothing
 * here legitimately holds one. Twilio's own SIDs survive because they carry their
 * two-letter prefix.
 */
const CREDENTIAL_SHAPES: { pattern: RegExp; what: string }[] = [
  { pattern: /^[0-9a-f]{32}$/i, what: 'a bare 32-character hex string, which is what a Twilio auth token looks like' },
  { pattern: /^SK[0-9a-fA-F]{32}$/, what: 'a Twilio API key SID' },
  { pattern: /^sk-[A-Za-z0-9_-]{16,}$/, what: 'an API key' },
  { pattern: /\bsk_(live|test)_/i, what: 'a Stripe key' },
  { pattern: /\bBearer\s+\S/i, what: 'a bearer token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\./, what: 'a JWT' },
  { pattern: /service_role/i, what: 'a Supabase service-role reference' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
];

/** Anything that would make a string do something rather than say something. */
const EXECUTABLE_SHAPES: { pattern: RegExp; what: string }[] = [
  { pattern: /\$\{/, what: 'a template expression' },
  { pattern: /<%/, what: 'a template tag' },
  { pattern: /javascript:/i, what: 'a javascript: url' },
  { pattern: /\bfunction\s*\(/, what: 'a function literal' },
  { pattern: /=>/, what: 'an arrow function' },
  { pattern: /<script/i, what: 'a script tag' },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walks every string in the submitted object looking for the two categories above.
 *
 * Done over the raw input rather than over the parsed result, so a credential hiding in a
 * key the whitelist is about to drop is still reported. A rejected field that silently
 * discarded somebody's auth token would leave them believing it had been stored somewhere
 * safe.
 */
function scanForForbidden(value: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    for (const { pattern, what } of CREDENTIAL_SHAPES) {
      if (pattern.test(value)) {
        errors.push(`${path} looks like ${what}. Credentials belong in function secrets, never in configuration.`);
        return;
      }
    }
    for (const { pattern, what } of EXECUTABLE_SHAPES) {
      if (pattern.test(value)) {
        errors.push(`${path} contains ${what}. Configuration describes behaviour, it never defines it.`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForForbidden(item, `${path}[${i}]`, errors, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      scanForForbidden(item, path ? `${path}.${key}` : key, errors, depth + 1);
    }
  }
}

function str(value: unknown, path: string, errors: string[], max = 200): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${path} must be text`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    errors.push(`${path} is longer than ${max} characters`);
    return null;
  }
  return trimmed;
}

function bool(value: unknown, path: string, errors: string[], fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(`${path} must be true or false`);
    return fallback;
  }
  return value;
}

function strList(value: unknown, path: string, errors: string[], max: number, itemMax = 80): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a list`);
    return [];
  }
  if (value.length > max) {
    errors.push(`${path} holds more than ${max} entries`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    const parsed = str(item, `${path}[${i}]`, errors, itemMax);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

/** Rejects a key the schema does not know, by name, so a typo is a sentence not a silence. */
function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}${path ? '.' : ''}${key} is not a setting this module has. Known: ${allowed.join(', ')}`);
    }
  }
}

/**
 * Is this a timezone Postgres and Luxon will both accept?
 *
 * Asked of the runtime rather than checked against a baked-in list, because a bundled list
 * of IANA zones goes stale and the wrong answer here means every business-hours decision
 * for that tenant is made in the wrong day.
 */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.includes('/');
  } catch {
    return false;
  }
}

/** Every `{{placeholder}}` in a template must be on the closed list. */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  if (template.length > MAX_TEMPLATE_CHARS) {
    problems.push(`is longer than ${MAX_TEMPLATE_CHARS} characters`);
  }
  const used = [...template.matchAll(/\{\{\s*([a-z_]*)\s*\}\}/gi)].map((m) => m[1]);
  for (const name of used) {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
      problems.push(`uses {{${name}}}, which is not a placeholder this module fills. Known: ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`);
    }
  }
  /* a lone brace is nearly always a placeholder somebody mistyped, and it would be sent to
     a customer verbatim. */
  const stripped = template.replace(/\{\{\s*[a-z_]*\s*\}\}/gi, '');
  if (stripped.includes('{') || stripped.includes('}')) {
    problems.push('contains a brace outside a placeholder — a mistyped {{name}} is sent to the customer as-is');
  }
  return problems;
}

const TOP_LEVEL = [
  'company_name',
  'timezone',
  'business_hours',
  'holidays',
  'services',
  'service_area',
  'forwarding',
  'staff_alerts',
  'booking_url',
  'templates',
  'after_hours',
  'safety',
  'ai',
  'compliance',
  'twilio',
] as const;

/* ── defaults ───────────────────────────────────────────── */

/**
 * The reviewed copy.
 *
 * Every customer-facing message starts life as one of these. The classifier may decide a
 * lead is an emergency and it may summarise what somebody wrote, but it never writes the
 * text that gets sent — a model generating outbound SMS is a model one prompt injection
 * away from writing whatever the customer asked it to, on the contractor's phone number,
 * under the contractor's brand.
 *
 * The opt-out sentence is appended by the engine rather than being part of the template, so
 * it cannot be edited out of one.
 */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  first_response:
    "Hi{{customer_name}}, this is {{company}} — sorry we missed your call. Reply here with what you need and your ZIP and we'll get right back to you.",
  after_hours_response:
    "Hi{{customer_name}}, this is {{company}} — sorry we missed your call. We're closed right now but reply with what you need and we'll come back to you {{callback_window}}.",
  followup:
    "{{company}} again — just checking we've got this right. Reply with what you need and we'll get someone out to you.",
  handoff_ack:
    "Thanks — a member of the {{company}} team is picking this up now and will call you directly.",
};

export const DEFAULT_OPT_OUT_LANGUAGE = 'Reply STOP to opt out.';

/**
 * The floor under the classifier.
 *
 * Below this, the lead goes to a person rather than down an automated path. It is
 * configurable because trades differ in how much ambiguity they can absorb, but it is
 * floored at 0.5 in the validator: a threshold of zero would switch the safety net off
 * while still reading as "configured".
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.7;

export function defaultConfig(partial: Partial<LeadRecoveryConfig> = {}): LeadRecoveryConfig {
  return {
    company_name: '',
    timezone: 'America/New_York',
    business_hours: {
      mon: [{ open: '08:00', close: '17:00' }],
      tue: [{ open: '08:00', close: '17:00' }],
      wed: [{ open: '08:00', close: '17:00' }],
      thu: [{ open: '08:00', close: '17:00' }],
      fri: [{ open: '08:00', close: '17:00' }],
      sat: [],
      sun: [],
    },
    holidays: [],
    services: [],
    service_area: { zips: [], cities: [], note: null },
    forwarding: { destination: '', timeout_seconds: 20 },
    staff_alerts: [],
    booking_url: null,
    templates: { ...DEFAULT_TEMPLATES },
    after_hours: { behaviour: 'after_hours_response', callback_window: 'first thing in the morning' },
    safety: {
      emergency_keywords: [],
      always_handoff_services: [],
      confidence_floor: DEFAULT_CONFIDENCE_FLOOR,
      handoff_on_ambiguous_scope: true,
    },
    ai: { enabled: true, provider: 'anthropic', model: null },
    compliance: {
      status: 'not_started',
      brand_registered: false,
      campaign_ref: null,
      reviewed_at: null,
      opt_out_language: DEFAULT_OPT_OUT_LANGUAGE,
    },
    twilio: {
      subaccount_sid: null,
      messaging_service_sid: null,
      phone_number: null,
      phone_number_sid: null,
    },
    ...partial,
  };
}

/* ── the validator ──────────────────────────────────────── */

export function validateLeadRecoveryConfig(input: unknown): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['configuration must be a JSON object'], warnings };
  }

  /* before anything is parsed, so a secret in a field that is about to be discarded is
     still reported rather than quietly dropped. */
  scanForForbidden(input, '', errors);
  rejectUnknown(input, TOP_LEVEL, '', errors);

  const base = defaultConfig();

  // ── identity ──────────────────────────────────────────
  const companyName = str(input.company_name, 'company_name', errors, 80);
  if (!companyName) errors.push('company_name is required — it is the name that appears in every text');

  const timezone = str(input.timezone, 'timezone', errors, 64) ?? base.timezone;
  if (!isValidTimezone(timezone)) {
    errors.push(`timezone "${timezone}" is not an IANA zone (for example America/Denver)`);
  }

  // ── hours ─────────────────────────────────────────────
  const businessHours: Record<string, BusinessHourRange[]> = {};
  const hoursRaw = input.business_hours;
  if (hoursRaw === undefined || hoursRaw === null) {
    Object.assign(businessHours, base.business_hours);
  } else if (!isPlainObject(hoursRaw)) {
    errors.push('business_hours must be an object keyed by weekday');
  } else {
    rejectUnknown(hoursRaw, WEEKDAYS, 'business_hours', errors);
    for (const day of WEEKDAYS) {
      const ranges = hoursRaw[day];
      businessHours[day] = [];
      if (ranges === undefined || ranges === null) continue;
      if (!Array.isArray(ranges)) {
        errors.push(`business_hours.${day} must be a list of {open, close}`);
        continue;
      }
      if (ranges.length > 3) {
        errors.push(`business_hours.${day} has more than three periods`);
        continue;
      }
      ranges.forEach((range, i) => {
        const where = `business_hours.${day}[${i}]`;
        if (!isPlainObject(range)) {
          errors.push(`${where} must be {open, close}`);
          return;
        }
        rejectUnknown(range, ['open', 'close'], where, errors);
        const open = str(range.open, `${where}.open`, errors, 5);
        const close = str(range.close, `${where}.close`, errors, 5);
        if (!open || !TIME.test(open)) {
          errors.push(`${where}.open must be a 24-hour time like 08:00`);
          return;
        }
        if (!close || !TIME.test(close)) {
          errors.push(`${where}.close must be a 24-hour time like 17:00`);
          return;
        }
        if (close <= open) {
          errors.push(`${where} closes at or before it opens — an overnight shift needs two periods`);
          return;
        }
        businessHours[day].push({ open, close });
      });
    }
  }

  const holidays = strList(input.holidays, 'holidays', errors, 60, 10);
  for (const day of holidays) {
    if (!DATE.test(day) || Number.isNaN(Date.parse(day))) {
      errors.push(`holidays entry "${day}" must be a date like 2026-12-25`);
    }
  }

  // ── what they sell, and where ─────────────────────────
  const services = strList(input.services, 'services', errors, 40, 60);
  if (services.length === 0) {
    errors.push('services must list at least one thing this company does — it is what the classifier matches against');
  }

  const areaRaw = input.service_area;
  const serviceArea = { zips: [] as string[], cities: [] as string[], note: null as string | null };
  if (areaRaw !== undefined && areaRaw !== null) {
    if (!isPlainObject(areaRaw)) {
      errors.push('service_area must be an object');
    } else {
      rejectUnknown(areaRaw, ['zips', 'cities', 'note'], 'service_area', errors);
      serviceArea.zips = strList(areaRaw.zips, 'service_area.zips', errors, 400, 10);
      for (const zip of serviceArea.zips) {
        if (!ZIP.test(zip)) errors.push(`service_area.zips entry "${zip}" is not a five-digit ZIP`);
      }
      serviceArea.cities = strList(areaRaw.cities, 'service_area.cities', errors, 80, 60);
      serviceArea.note = str(areaRaw.note, 'service_area.note', errors, 200);
    }
  }
  if (serviceArea.zips.length === 0 && serviceArea.cities.length === 0) {
    errors.push('service_area needs at least one ZIP or city — without it every lead reads as out of area');
  }

  // ── the call ──────────────────────────────────────────
  const fwdRaw = input.forwarding;
  const forwarding = { destination: '', timeout_seconds: base.forwarding.timeout_seconds };
  if (!isPlainObject(fwdRaw)) {
    errors.push('forwarding is required — {destination, timeout_seconds}');
  } else {
    rejectUnknown(fwdRaw, ['destination', 'timeout_seconds'], 'forwarding', errors);
    const destination = str(fwdRaw.destination, 'forwarding.destination', errors, 20);
    if (!destination) {
      errors.push('forwarding.destination is required — the number the call is handed to');
    } else if (!E164.test(destination)) {
      errors.push(`forwarding.destination "${destination}" must be E.164, for example +16145550137`);
    } else {
      forwarding.destination = destination;
    }
    if (fwdRaw.timeout_seconds !== undefined && fwdRaw.timeout_seconds !== null) {
      const seconds = fwdRaw.timeout_seconds;
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 5 || seconds > 120) {
        errors.push('forwarding.timeout_seconds must be a whole number of seconds between 5 and 120');
      } else {
        forwarding.timeout_seconds = seconds;
      }
    }
  }

  // ── who gets told ─────────────────────────────────────
  const alertsRaw = input.staff_alerts;
  const staffAlerts: LeadRecoveryConfig['staff_alerts'] = [];
  if (alertsRaw !== undefined && alertsRaw !== null) {
    if (!Array.isArray(alertsRaw)) {
      errors.push('staff_alerts must be a list');
    } else if (alertsRaw.length > 10) {
      errors.push('staff_alerts holds more than ten recipients');
    } else {
      alertsRaw.forEach((entry, i) => {
        const where = `staff_alerts[${i}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${where} must be {name, channel, address}`);
          return;
        }
        rejectUnknown(entry, ['name', 'channel', 'address'], where, errors);
        const channel = str(entry.channel, `${where}.channel`, errors, 10) ?? 'sms';
        if (!(ALERT_CHANNELS as readonly string[]).includes(channel)) {
          errors.push(`${where}.channel must be one of ${ALERT_CHANNELS.join(', ')}`);
          return;
        }
        const address = str(entry.address, `${where}.address`, errors, 120);
        if (!address) {
          errors.push(`${where}.address is required`);
          return;
        }
        if (channel === 'sms' && !E164.test(address)) {
          errors.push(`${where}.address must be E.164 for an SMS recipient`);
          return;
        }
        if (channel === 'email' && !EMAIL.test(address)) {
          errors.push(`${where}.address is not an email address`);
          return;
        }
        staffAlerts.push({ name: str(entry.name, `${where}.name`, errors, 60), channel, address });
      });
    }
  }
  if (staffAlerts.length === 0) {
    warnings.push('nobody is on staff_alerts — a lead that needs a person will sit in the portal with no one told about it');
  }

  // ── booking ───────────────────────────────────────────
  let bookingUrl: string | null = null;
  const bookingRaw = str(input.booking_url, 'booking_url', errors, 300);
  if (bookingRaw) {
    try {
      const url = new URL(bookingRaw);
      if (url.protocol !== 'https:') errors.push('booking_url must be https');
      else bookingUrl = url.toString();
    } catch {
      errors.push(`booking_url "${bookingRaw}" is not a url`);
    }
  }

  // ── the copy ──────────────────────────────────────────
  const templates: Record<string, string> = { ...DEFAULT_TEMPLATES };
  const templatesRaw = input.templates;
  if (templatesRaw !== undefined && templatesRaw !== null) {
    if (!isPlainObject(templatesRaw)) {
      errors.push('templates must be an object');
    } else {
      rejectUnknown(templatesRaw, TEMPLATE_KEYS, 'templates', errors);
      for (const key of TEMPLATE_KEYS) {
        const raw = templatesRaw[key];
        if (raw === undefined || raw === null) continue;
        const text = str(raw, `templates.${key}`, errors, MAX_TEMPLATE_CHARS + 40);
        if (!text) {
          errors.push(`templates.${key} cannot be empty — remove it to use the reviewed default`);
          continue;
        }
        for (const problem of templateProblems(text)) {
          errors.push(`templates.${key} ${problem}`);
        }
        templates[key] = text;
      }
    }
  }
  if (bookingUrl === null) {
    for (const [key, text] of Object.entries(templates)) {
      if (text.includes('{{booking_url}}')) {
        errors.push(`templates.${key} uses {{booking_url}} but no booking_url is set — it would send an empty gap to a customer`);
      }
    }
  }

  // ── out of hours ──────────────────────────────────────
  const afterRaw = input.after_hours;
  const afterHours = { behaviour: base.after_hours.behaviour, callback_window: base.after_hours.callback_window };
  if (afterRaw !== undefined && afterRaw !== null) {
    if (!isPlainObject(afterRaw)) {
      errors.push('after_hours must be an object');
    } else {
      rejectUnknown(afterRaw, ['behaviour', 'callback_window'], 'after_hours', errors);
      const behaviour = str(afterRaw.behaviour, 'after_hours.behaviour', errors, 30) ?? base.after_hours.behaviour;
      if (!(AFTER_HOURS_BEHAVIOURS as readonly string[]).includes(behaviour)) {
        errors.push(`after_hours.behaviour must be one of ${AFTER_HOURS_BEHAVIOURS.join(', ')}`);
      } else {
        afterHours.behaviour = behaviour;
      }
      afterHours.callback_window = str(afterRaw.callback_window, 'after_hours.callback_window', errors, 80);
    }
  }
  if (
    (afterHours.behaviour === 'after_hours_response' || templates.after_hours_response.includes('{{callback_window}}')) &&
    !afterHours.callback_window
  ) {
    errors.push('after_hours.callback_window is required when the out-of-hours text promises a time');
  }

  // ── safety ────────────────────────────────────────────
  const safetyRaw = input.safety;
  const safety = { ...base.safety };
  if (safetyRaw !== undefined && safetyRaw !== null) {
    if (!isPlainObject(safetyRaw)) {
      errors.push('safety must be an object');
    } else {
      rejectUnknown(
        safetyRaw,
        ['emergency_keywords', 'always_handoff_services', 'confidence_floor', 'handoff_on_ambiguous_scope'],
        'safety',
        errors,
      );
      safety.emergency_keywords = strList(safetyRaw.emergency_keywords, 'safety.emergency_keywords', errors, 60, 40)
        .map((word) => word.toLowerCase());
      safety.always_handoff_services = strList(
        safetyRaw.always_handoff_services,
        'safety.always_handoff_services',
        errors,
        40,
        60,
      );
      safety.handoff_on_ambiguous_scope = bool(
        safetyRaw.handoff_on_ambiguous_scope,
        'safety.handoff_on_ambiguous_scope',
        errors,
        true,
      );
      if (safetyRaw.confidence_floor !== undefined && safetyRaw.confidence_floor !== null) {
        const floor = safetyRaw.confidence_floor;
        if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0.5 || floor > 0.99) {
          /* floored at 0.5 deliberately: the setting exists so a trade that can absorb
             ambiguity can loosen it, not so the safety net can be switched off while the
             config still reads as configured. */
          errors.push('safety.confidence_floor must be between 0.5 and 0.99');
        } else {
          safety.confidence_floor = floor;
        }
      }
    }
  }
  for (const service of safety.always_handoff_services) {
    if (!services.includes(service)) {
      warnings.push(`safety.always_handoff_services names "${service}", which is not in services — it will never match`);
    }
  }

  // ── the classifier ────────────────────────────────────
  const aiRaw = input.ai;
  const ai = { ...base.ai };
  if (aiRaw !== undefined && aiRaw !== null) {
    if (!isPlainObject(aiRaw)) {
      errors.push('ai must be an object');
    } else {
      rejectUnknown(aiRaw, ['enabled', 'provider', 'model'], 'ai', errors);
      ai.enabled = bool(aiRaw.enabled, 'ai.enabled', errors, true);
      const provider = str(aiRaw.provider, 'ai.provider', errors, 30) ?? 'anthropic';
      if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
        errors.push(`ai.provider must be one of ${AI_PROVIDERS.join(', ')}`);
      } else {
        ai.provider = provider;
      }
      ai.model = str(aiRaw.model, 'ai.model', errors, 60);
    }
  }
  if (!ai.enabled) {
    warnings.push('classification is off — every reply will be handed to a person rather than routed automatically');
  }

  // ── compliance ────────────────────────────────────────
  const complianceRaw = input.compliance;
  const compliance = { ...base.compliance };
  if (complianceRaw !== undefined && complianceRaw !== null) {
    if (!isPlainObject(complianceRaw)) {
      errors.push('compliance must be an object');
    } else {
      rejectUnknown(
        complianceRaw,
        ['status', 'brand_registered', 'campaign_ref', 'reviewed_at', 'opt_out_language'],
        'compliance',
        errors,
      );
      const status = str(complianceRaw.status, 'compliance.status', errors, 20) ?? 'not_started';
      if (!(COMPLIANCE_STATUSES as readonly string[]).includes(status)) {
        errors.push(`compliance.status must be one of ${COMPLIANCE_STATUSES.join(', ')}`);
      } else {
        compliance.status = status;
      }
      compliance.brand_registered = bool(complianceRaw.brand_registered, 'compliance.brand_registered', errors, false);
      compliance.campaign_ref = str(complianceRaw.campaign_ref, 'compliance.campaign_ref', errors, 60);
      const reviewedAt = str(complianceRaw.reviewed_at, 'compliance.reviewed_at', errors, 40);
      if (reviewedAt && Number.isNaN(Date.parse(reviewedAt))) {
        errors.push('compliance.reviewed_at must be an ISO date');
      } else {
        compliance.reviewed_at = reviewedAt;
      }
      const optOut = str(complianceRaw.opt_out_language, 'compliance.opt_out_language', errors, 80);
      if (optOut) {
        if (!/\bstop\b/i.test(optOut)) {
          errors.push('compliance.opt_out_language must tell the customer to reply STOP');
        }
        compliance.opt_out_language = optOut;
      }
    }
  }
  if (compliance.status === 'approved' && !compliance.brand_registered) {
    errors.push('compliance.status is approved but brand_registered is false — one of the two is wrong');
  }

  // ── twilio references (identifiers, never credentials) ─
  const twilioRaw = input.twilio;
  const twilio = { ...base.twilio };
  if (twilioRaw !== undefined && twilioRaw !== null) {
    if (!isPlainObject(twilioRaw)) {
      errors.push('twilio must be an object');
    } else {
      rejectUnknown(
        twilioRaw,
        ['subaccount_sid', 'messaging_service_sid', 'phone_number', 'phone_number_sid'],
        'twilio',
        errors,
      );
      const sub = str(twilioRaw.subaccount_sid, 'twilio.subaccount_sid', errors, 40);
      if (sub && !AC_SID.test(sub)) errors.push('twilio.subaccount_sid must look like ACxxxxxxxx…');
      else twilio.subaccount_sid = sub;

      const mg = str(twilioRaw.messaging_service_sid, 'twilio.messaging_service_sid', errors, 40);
      if (mg && !MG_SID.test(mg)) errors.push('twilio.messaging_service_sid must look like MGxxxxxxxx…');
      else twilio.messaging_service_sid = mg;

      const pn = str(twilioRaw.phone_number, 'twilio.phone_number', errors, 20);
      if (pn && !E164.test(pn)) errors.push('twilio.phone_number must be E.164, for example +16145550100');
      else twilio.phone_number = pn;

      const pnSid = str(twilioRaw.phone_number_sid, 'twilio.phone_number_sid', errors, 40);
      if (pnSid && !PN_SID.test(pnSid)) errors.push('twilio.phone_number_sid must look like PNxxxxxxxx…');
      else twilio.phone_number_sid = pnSid;
    }
  }
  if (twilio.phone_number && twilio.phone_number === forwarding.destination) {
    errors.push('twilio.phone_number and forwarding.destination are the same number — the call would dial itself');
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    config: {
      company_name: companyName!,
      timezone,
      business_hours: businessHours,
      holidays,
      services,
      service_area: serviceArea,
      forwarding,
      staff_alerts: staffAlerts,
      booking_url: bookingUrl,
      templates,
      after_hours: afterHours,
      safety,
      ai,
      compliance,
      twilio,
    },
  };
}

/* ── activation ─────────────────────────────────────────── */

/**
 * The onboarding checklist, in the order it is actually done.
 *
 * `required` marks the steps activation is gated on. They are the ones whose absence means
 * the module would either not work or would do something it is not allowed to do — routing
 * with no destination, texting with no registered campaign. The rest are steps that matter
 * and that a human should confirm, but whose absence is a worse-service problem rather than
 * a wrong-behaviour one.
 */
export const ONBOARDING_STEPS = [
  { key: 'tenant_created', label: 'tenant created', required: true, detail: 'the client exists in Arc and has a client ID' },
  { key: 'business_rules', label: 'business rules completed', required: true, detail: 'hours, services, service area and templates saved and valid' },
  { key: 'staff_destination_verified', label: 'staff destination verified', required: true, detail: 'somebody answered a test call on the forwarding number' },
  { key: 'twilio_connected', label: 'Twilio resources connected', required: true, detail: 'a number and messaging service are recorded against this tenant' },
  { key: 'routing_tested', label: 'phone routing tested', required: true, detail: 'a dry-run of the voice webhook produced the right TwiML' },
  { key: 'website_origin', label: 'website origin configured', required: false, detail: 'the intake key exists and names the origins the form may post from' },
  { key: 'templates_approved', label: 'message templates approved', required: true, detail: 'the client has read and approved the exact words that will be sent' },
  { key: 'consent_recorded', label: 'consent process recorded', required: true, detail: 'how consent is captured on the call and on the form, written down' },
  { key: 'compliance_approved', label: 'messaging compliance approved', required: true, detail: 'brand and campaign registered, compliance.status is approved' },
  { key: 'canary_passed', label: 'synthetic tests passed', required: true, detail: 'a canary lead ran end to end without touching a real customer' },
  { key: 'module_activated', label: 'module activated', required: false, detail: 'the switch itself — ticked by activation, not before it' },
] as const;

export const REQUIRED_STEPS = ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.key);

export interface ActivationCheck {
  ok: boolean;
  blockers: string[];
  missingSteps: string[];
}

/**
 * Fail-closed activation.
 *
 * Returns every reason at once rather than the first, because an operator working through
 * onboarding wants the list, not a door that opens one inch per attempt. `ok` is only true
 * when there is nothing in either array — there is no "override" argument, deliberately:
 * the way to activate a module whose compliance is not approved is to get the compliance
 * approved.
 */
export function canActivate(
  config: unknown,
  completedSteps: string[],
): ActivationCheck {
  const blockers: string[] = [];
  const result = validateLeadRecoveryConfig(config);

  if (!result.ok) {
    blockers.push(...result.errors.map((e) => `configuration: ${e}`));
  } else {
    if (result.config.compliance.status !== 'approved') {
      blockers.push(
        `messaging compliance is "${result.config.compliance.status}" — Arc will not send on an unapproved campaign`,
      );
    }
    if (!result.config.twilio.phone_number) {
      blockers.push('no Twilio number is recorded for this tenant');
    }
    if (!result.config.twilio.messaging_service_sid) {
      blockers.push('no Twilio messaging service is recorded for this tenant');
    }
  }

  const done = new Set(completedSteps);
  const missingSteps = REQUIRED_STEPS.filter((key) => !done.has(key));

  return { ok: blockers.length === 0 && missingSteps.length === 0, blockers, missingSteps };
}

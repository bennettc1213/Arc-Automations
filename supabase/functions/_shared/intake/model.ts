/**
 * ARC-350 — native lead capture: what a form is, what a submission, an import row and an API
 * post must look like, and how an arrival's source is described.
 *
 * **Portal-safe.** No database, no network, no Deno API; the imports below are themselves
 * portal-safe. The hosted form page checks a submission with `parseSubmission` before it
 * posts, the console checks a form with `parseFormDefinition` before it saves, and the
 * function runs the same two again, because a browser is never the last check.
 * `0024_native_intake.sql` mirrors the vocabularies here and is drift-tested against them.
 *
 * A form is data, not a program. Its definition is a closed list of field types with a
 * label, a required flag and (for a choice) its options — every other key is refused, so
 * there is nowhere to put a condition, a pattern, a script or markup. Text a person typed is
 * kept as text and never rendered as anything else.
 *
 * Attribution comes in two kinds and they are never mixed: what ARC knows for itself (which
 * form, which endpoint, which import, which operator) is on the source record's own columns;
 * what a browser *claimed* (the page, the referrer, the campaign parameters) is under
 * `claimed`, because anybody can type `?utm_source=google` into an address bar.
 */

import { normaliseEmail, normalisePhone } from '../phone.ts';
import { CONTACT_CHANNELS, type FieldError, type Parsed, parseContactInput, PRIORITIES, secretProblem } from '../crm/model.ts';

type Raw = Record<string, unknown>;

/* ── vocabularies (mirrored by 0024's check constraints) ── */

export const FORM_STATUSES = ['draft', 'published', 'archived'] as const;
export type FormStatus = typeof FORM_STATUSES[number];

export const IMPORT_STATUSES = ['previewed', 'importing', 'completed', 'cancelled'] as const;
export const IMPORT_ROW_STATUSES = ['ready', 'invalid', 'duplicate_in_file', 'imported', 'skipped', 'failed'] as const;
export type ImportRowStatus = typeof IMPORT_ROW_STATUSES[number];
export const CONTACT_MATCHES = ['new_contact', 'existing_contact', 'ambiguous_contact'] as const;
export const ARRIVAL_OUTCOMES = ['created', 'duplicate', 'replayed', 'failed'] as const;
/** 0023's three; a form only ever asks about the two it can write to. */
export const CONSENT_CHANNELS = CONTACT_CHANNELS;
export const FORM_CONSENT_CHANNELS = ['sms', 'email'] as const;
export type FormConsentChannel = typeof FORM_CONSENT_CHANNELS[number];

export const FORM_KEY = /^arcf_[a-z0-9]{32}$/;
export const ENDPOINT_TOKEN = /^arci_[a-z0-9]{48}$/;

export const LIMITS = Object.freeze({
  formFields: 25,
  selectOptions: 20,
  importRows: 2000,
  importColumns: 60,
  csvCharacters: 1_000_000,
  importBatch: 200,
  dedupeMinutesMax: 43200,
  hourlyCapMax: 5000,
  /** a form nobody could have typed this fast. */
  minDwellMs: 1200,
});

/* ── text a stranger typed ──────────────────────────────── */

/* control characters, and the invisible ones that reorder or hide text. */
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

/**
 * One spelling of free text: no control or invisible characters, tabs as spaces, runs of
 * spaces collapsed, trimmed. A single line unless `multiline`. '' is null.
 */
export function cleanText(value: unknown, opts: { multiline?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\t/g, ' ');
  text = opts.multiline
    ? text.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  text = text.trim();
  return text === '' ? null : text;
}

const REMOVED = '[removed: this looked like a password or a key]';

/**
 * A customer who pastes a password into "what do you need?" must not lose their enquiry to
 * the database's refusal of secret-shaped text, and the password must not be kept. So the
 * answer is replaced, whole, and says so.
 */
function withoutSecrets(text: string): string {
  return secretProblem(text) ? REMOVED : text;
}

/* ── the form definition ────────────────────────────────── */

export const FIELD_TYPES = ['text', 'textarea', 'phone', 'email', 'service', 'select', 'checkbox', 'number'] as const;
export type FieldType = typeof FIELD_TYPES[number];

/**
 * The fields ARC knows the meaning of. A form may include each at most once; its type is
 * fixed, and where its answer goes is decided here, not by the form.
 */
export const STANDARD_FIELDS: Readonly<Record<string, { type: FieldType; label: string; max: number }>> = Object.freeze({
  name: { type: 'text', label: 'Your name', max: 120 },
  phone: { type: 'phone', label: 'Phone number', max: 24 },
  email: { type: 'email', label: 'Email', max: 200 },
  service: { type: 'service', label: 'What do you need help with?', max: 41 },
  address: { type: 'text', label: 'Street address', max: 200 },
  city: { type: 'text', label: 'City', max: 120 },
  region: { type: 'text', label: 'State', max: 120 },
  postal_code: { type: 'text', label: 'ZIP code', max: 20 },
  message: { type: 'textarea', label: 'Tell us what is going on', max: 2000 },
  preferred_time: { type: 'text', label: 'When suits you?', max: 120 },
});

/** a question of the business's own: `q_` and a short key. */
const CUSTOM_KEY = /^q_[a-z0-9_]{1,30}$/;
const CUSTOM_TYPES: readonly FieldType[] = ['text', 'textarea', 'select', 'checkbox', 'number'];
const CUSTOM_MAX: Readonly<Record<string, number>> = Object.freeze({ text: 200, textarea: 2000 });

export interface FormField {
  key: string;
  type: FieldType;
  label: string;
  required: boolean;
  help: string | null;
  /** `select` only. */
  options: string[] | null;
  /** text and textarea only. */
  max_length: number | null;
}

export interface FormConsent { mode: 'optional' | 'required'; text: string }

export interface FormDefinition {
  title: string;
  intro: string | null;
  submit_label: string;
  success_message: string;
  fields: FormField[];
  consent: Partial<Record<FormConsentChannel, FormConsent>>;
}

const asObject = (raw: unknown): Raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Raw : {});
const isObject = (raw: unknown): raw is Raw => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);

/** a line of the form's own wording: required or not, capped, and never a credential. */
function wording(raw: Raw, key: string, max: number, errors: FieldError[], field: string, required: boolean): string | null {
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ field, message: 'is required' });
    return null;
  }
  const text = cleanText(value, { multiline: max > 200 });
  if (text === null) {
    errors.push({ field, message: required ? 'is required' : 'must be text' });
    return null;
  }
  if (text.length > max) errors.push({ field, message: `is longer than ${max} characters` });
  else if (secretProblem(text)) errors.push({ field, message: 'looks like a credential — those are never put on a form' });
  return text;
}

function unknownKeys(raw: Raw, known: readonly string[], prefix: string, errors: FieldError[]) {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) errors.push({ field: `${prefix}${key}`, message: 'is not something a form can have' });
  }
}

/**
 * A form definition, whole. Every problem is reported at once, by path. What comes back is
 * the normalised definition — the only shape the hosted page and the function ever read.
 */
export function parseFormDefinition(raw: unknown): Parsed<FormDefinition> {
  const errors: FieldError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'definition', message: 'is an object' }] };
  unknownKeys(raw, ['title', 'intro', 'submit_label', 'success_message', 'fields', 'consent'], '', errors);

  const title = wording(raw, 'title', 120, errors, 'title', true) ?? '';
  const intro = wording(raw, 'intro', 500, errors, 'intro', false);
  const submitLabel = wording(raw, 'submit_label', 40, errors, 'submit_label', false) ?? 'Send';
  const success = wording(raw, 'success_message', 300, errors, 'success_message', false)
    ?? 'Thanks — we have your details and will be in touch.';

  const fields: FormField[] = [];
  const list = Array.isArray(raw.fields) ? raw.fields : null;
  if (!list || list.length === 0 || list.length > LIMITS.formFields) {
    errors.push({ field: 'fields', message: `a form has 1 to ${LIMITS.formFields} fields` });
  } else {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const at = `fields[${i}]`;
      if (!isObject(item)) return void errors.push({ field: at, message: 'is an object' });
      unknownKeys(item, ['key', 'type', 'label', 'required', 'help', 'options', 'max_length'], `${at}.`, errors);
      const key = typeof item.key === 'string' ? item.key : '';
      const standard = STANDARD_FIELDS[key];
      if (!standard && !CUSTOM_KEY.test(key)) {
        return void errors.push({ field: `${at}.key`, message: `is one of ${Object.keys(STANDARD_FIELDS).join(', ')}, or a question of your own starting with q_` });
      }
      if (seen.has(key)) errors.push({ field: `${at}.key`, message: `"${key}" is already on this form` });
      seen.add(key);
      /* an answer is stored under its key, and a key like q_password next to any long answer
         reads as a credential to every check downstream. */
      if (secretProblem({ [key]: 'x'.repeat(12) })) errors.push({ field: `${at}.key`, message: 'reads like a credential field — choose another key' });

      let type: FieldType;
      if (standard) {
        type = standard.type;
        if (item.type !== undefined && item.type !== type) errors.push({ field: `${at}.type`, message: `${key} is always ${type}` });
      } else if (typeof item.type === 'string' && CUSTOM_TYPES.includes(item.type as FieldType)) {
        type = item.type as FieldType;
      } else {
        return void errors.push({ field: `${at}.type`, message: `is one of: ${CUSTOM_TYPES.join(', ')}` });
      }

      const label = wording(item, 'label', 160, errors, `${at}.label`, !standard) ?? standard?.label ?? '';
      const help = wording(item, 'help', 200, errors, `${at}.help`, false);
      if (item.required !== undefined && typeof item.required !== 'boolean') errors.push({ field: `${at}.required`, message: 'must be true or false' });

      let options: string[] | null = null;
      if (type === 'select') {
        const given = Array.isArray(item.options) ? item.options : [];
        options = [];
        for (const option of given) {
          const text = cleanText(option);
          if (!text || text.length > 80 || secretProblem(text)) errors.push({ field: `${at}.options`, message: 'each option is 1 to 80 characters of plain text' });
          else if (!options.includes(text)) options.push(text);
        }
        if (options.length < 2 || given.length > LIMITS.selectOptions) errors.push({ field: `${at}.options`, message: `a choice has 2 to ${LIMITS.selectOptions} different options` });
      } else if (item.options !== undefined && item.options !== null) {
        errors.push({ field: `${at}.options`, message: 'only a choice (select) has options' });
      }

      let maxLength: number | null = null;
      const cap = standard && (type === 'text' || type === 'textarea') ? standard.max : CUSTOM_MAX[type];
      if (cap !== undefined) {
        maxLength = cap;
        if (item.max_length !== undefined && item.max_length !== null) {
          if (typeof item.max_length !== 'number' || !Number.isInteger(item.max_length) || item.max_length < 1 || item.max_length > cap) {
            errors.push({ field: `${at}.max_length`, message: `is a whole number from 1 to ${cap}` });
          } else maxLength = item.max_length;
        }
      } else if (item.max_length !== undefined && item.max_length !== null) {
        errors.push({ field: `${at}.max_length`, message: 'only a text field has a length' });
      }

      fields.push({ key, type, label, required: item.required === true, help, options, max_length: maxLength });
    });
    /* a lead nobody can reach is not a lead. */
    if (!seen.has('phone') && !seen.has('email')) errors.push({ field: 'fields', message: 'a form asks for a phone number or an email address' });
  }

  const consent: FormDefinition['consent'] = {};
  if (raw.consent !== undefined && raw.consent !== null) {
    if (!isObject(raw.consent)) errors.push({ field: 'consent', message: 'is an object' });
    else {
      unknownKeys(raw.consent, FORM_CONSENT_CHANNELS, 'consent.', errors);
      for (const channel of FORM_CONSENT_CHANNELS) {
        const entry = raw.consent[channel];
        if (entry === undefined || entry === null) continue;
        const at = `consent.${channel}`;
        if (!isObject(entry)) { errors.push({ field: at, message: 'is an object' }); continue; }
        unknownKeys(entry, ['mode', 'text'], `${at}.`, errors);
        if (entry.mode !== 'optional' && entry.mode !== 'required') errors.push({ field: `${at}.mode`, message: 'is optional or required' });
        const text = wording(entry, 'text', 500, errors, `${at}.text`, true);
        const needs = channel === 'sms' ? 'phone' : 'email';
        if (!fields.some((f) => f.key === needs)) errors.push({ field: at, message: `asks about ${channel} but the form has no ${needs} field` });
        if (text && (entry.mode === 'optional' || entry.mode === 'required')) consent[channel] = { mode: entry.mode, text };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const value: FormDefinition = { title, intro, submit_label: submitLabel, success_message: success, fields, consent };
  /* 0024 checks the stored document as one piece of text; so does this. */
  if (secretProblem(value)) return { ok: false, errors: [{ field: 'definition', message: 'reads like it contains a credential — reword it' }] };
  return { ok: true, value };
}

/** where a new form starts: the four things almost every service business asks. */
export function defaultFormDefinition(title: string): FormDefinition {
  const field = (key: string, required: boolean): FormField => ({
    key,
    type: STANDARD_FIELDS[key].type,
    label: STANDARD_FIELDS[key].label,
    required,
    help: null,
    options: null,
    max_length: ['text', 'textarea'].includes(STANDARD_FIELDS[key].type) ? STANDARD_FIELDS[key].max : null,
  });
  return {
    title,
    intro: null,
    submit_label: 'Send',
    success_message: 'Thanks — we have your details and will be in touch.',
    fields: [field('name', true), field('phone', true), field('email', false), field('message', true)],
    consent: {
      sms: { mode: 'optional', text: 'Text me about this request. Message and data rates may apply. Reply STOP to opt out.' },
    },
  };
}

export interface FormInput {
  name?: string;
  definition?: FormDefinition;
  dedupe_minutes?: number;
  hourly_cap?: number;
}

/** what an operator saves: the form's name, its definition, and its two limits. */
export function parseFormInput(raw: unknown, opts: { partial?: boolean } = {}): Parsed<FormInput> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  const out: FormInput = {};
  unknownKeys(source, ['name', 'definition', 'dedupe_minutes', 'hourly_cap'], '', errors);

  if (source.name !== undefined || !opts.partial) {
    const name = wording(source, 'name', 120, errors, 'name', true);
    if (name) out.name = name;
  }
  if (source.definition !== undefined || !opts.partial) {
    const parsed = parseFormDefinition(source.definition);
    if (parsed.ok) out.definition = parsed.value;
    else errors.push(...parsed.errors.map((e) => ({ field: e.field === 'definition' ? e.field : `definition.${e.field}`, message: e.message })));
  }
  const whole = (key: 'dedupe_minutes' | 'hourly_cap', min: number, max: number) => {
    const value = source[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors.push({ field: key, message: `is a whole number from ${min} to ${max}` });
    else out[key] = value;
  };
  whole('dedupe_minutes', 0, LIMITS.dedupeMinutesMax);
  whole('hourly_cap', 1, LIMITS.hourlyCapMax);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/* ── a submission ───────────────────────────────────────── */

export interface ServiceOption { id: string; key: string; name: string; category_id: string | null }

export interface ConsentInput { channel: string; address: string; granted: boolean; disclosure: string }

export interface ArrivalParts {
  contact: Raw;
  lead: { title: string; summary: string | null; service_id: string | null; service_category_id: string | null; priority?: string };
  consent: ConsentInput[];
  /** the business's own questions, by key. kept on the source record. */
  answers: Record<string, string | number | boolean>;
}

const firstLine = (text: string, max: number) => {
  const line = text.split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * One submission checked against the form it was made on. Values are keyed by field key;
 * consent arrives as `consent_sms` / `consent_email`, true only when the box was ticked.
 * A key the form does not have is ignored rather than stored — the form decides what a
 * submission is, not the request.
 */
export function parseSubmission(
  definition: FormDefinition,
  values: unknown,
  context: { formName: string; services: readonly ServiceOption[] },
): Parsed<ArrivalParts> {
  const input = asObject(values);
  const errors: FieldError[] = [];
  const got: Record<string, string | number | boolean | null> = {};
  let service: ServiceOption | null = null;

  for (const field of definition.fields) {
    const value = input[field.key];
    const missing = () => { if (field.required) errors.push({ field: field.key, message: 'is required' }); got[field.key] = null; };

    if (field.type === 'checkbox') {
      if (value !== undefined && value !== null && typeof value !== 'boolean') { errors.push({ field: field.key, message: 'must be true or false' }); continue; }
      if (field.required && value !== true) errors.push({ field: field.key, message: 'is required' });
      got[field.key] = value === true;
      continue;
    }
    if (value === undefined || value === null || value === '') { missing(); continue; }

    if (field.type === 'number') {
      const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?[0-9]{1,12}(\.[0-9]{1,4})?$/.test(value.trim()) ? Number(value) : NaN;
      if (!Number.isFinite(number) || Math.abs(number) > 1e12) errors.push({ field: field.key, message: 'must be a number' });
      else got[field.key] = number;
      continue;
    }
    if (field.type === 'phone') {
      const phone = normalisePhone(value);
      if (!phone) errors.push({ field: field.key, message: 'is not a phone number we can call — include the area code' });
      else got[field.key] = phone;
      continue;
    }
    if (field.type === 'email') {
      const email = normaliseEmail(value);
      if (!email) errors.push({ field: field.key, message: 'does not look like an email address' });
      else got[field.key] = email;
      continue;
    }

    const text = cleanText(value, { multiline: field.type === 'textarea' });
    if (text === null) { missing(); continue; }
    if (field.type === 'service') {
      service = context.services.find((s) => s.key === text) ?? null;
      if (!service) errors.push({ field: field.key, message: 'is not one of the services on this form' });
      continue;
    }
    if (field.type === 'select') {
      if (!field.options?.includes(text)) errors.push({ field: field.key, message: 'is not one of the choices' });
      else got[field.key] = text;
      continue;
    }
    if (field.max_length && text.length > field.max_length) { errors.push({ field: field.key, message: `is longer than ${field.max_length} characters` }); continue; }
    got[field.key] = withoutSecrets(text);
  }

  const phone = typeof got.phone === 'string' ? got.phone : null;
  const email = typeof got.email === 'string' ? got.email : null;
  if (!phone && !email && !errors.some((e) => e.field === 'phone' || e.field === 'email')) {
    errors.push({ field: definition.fields.some((f) => f.key === 'phone') ? 'phone' : 'email', message: 'give us a phone number or an email address so we can reach you' });
  }

  /* consent is recorded only for an address that was actually given, and is never assumed:
     anything but `true` is "did not agree". */
  const consent: ConsentInput[] = [];
  for (const channel of FORM_CONSENT_CHANNELS) {
    const asked = definition.consent[channel];
    const address = channel === 'sms' ? phone : email;
    if (!asked || !address) continue;
    const granted = input[`consent_${channel}`] === true;
    if (asked.mode === 'required' && !granted) errors.push({ field: `consent_${channel}`, message: 'please tick this box so we can get back to you' });
    consent.push({ channel, address, granted, disclosure: asked.text });
  }

  if (errors.length > 0) return { ok: false, errors };

  const answers: Record<string, string | number | boolean> = {};
  const lines: string[] = [];
  if (typeof got.message === 'string') lines.push(got.message);
  for (const field of definition.fields) {
    if (field.key !== 'preferred_time' && !CUSTOM_KEY.test(field.key)) continue;
    const value = got[field.key];
    if (value === null || value === undefined || value === false) continue;
    answers[field.key] = value;
    lines.push(`${field.label}: ${value === true ? 'yes' : value}`);
  }
  const summary = lines.join('\n').slice(0, 2000) || null;

  const contact: Raw = {};
  const put = (key: string, value: unknown) => { if (typeof value === 'string' && value !== '') contact[key] = value; };
  put('display_name', got.name);
  put('phone', phone);
  put('email', email);
  put('address_line1', got.address);
  put('city', got.city);
  put('region', got.region);
  put('postal_code', got.postal_code);

  return {
    ok: true,
    value: {
      contact,
      lead: {
        title: service?.name ?? (typeof got.message === 'string' ? firstLine(got.message, 80) : `${context.formName} enquiry`),
        summary,
        service_id: service?.id ?? null,
        service_category_id: service?.category_id ?? null,
      },
      consent,
      answers,
    },
  };
}

/** the two checks a person passes without noticing and a script usually does not. */
export function spamVerdict(body: Raw, now: number): 'honeypot' | 'dwell' | null {
  if (typeof body.company_website === 'string' && body.company_website.trim() !== '') return 'honeypot';
  const renderedAt = typeof body.rendered_at === 'number' ? body.rendered_at : 0;
  if (renderedAt > 0 && now - renderedAt < LIMITS.minDwellMs) return 'dwell';
  return null;
}

/* ── attribution a browser claimed ──────────────────────── */

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
/** ad click identifiers. their presence is recorded; the identifier itself is not kept. */
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid'] as const;

/** an http(s) address without its query or fragment — where, not the tracking on it. */
function pageOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * What the browser said about where the visitor came from. Never fails: anything that is
 * not usable is left out. Everything here is a claim — it says so in the key it is stored
 * under — and none of it is ever used to decide anything.
 */
export function parseAttribution(raw: unknown): Raw {
  const input = asObject(raw);
  const out: Raw = {};
  const page = pageOf(input.page);
  const referrer = pageOf(input.referrer);
  if (page) out.page = page;
  if (referrer) out.referrer = referrer;
  /* the campaign may arrive as fields, or still on the page's own query string. */
  let query: URLSearchParams | null = null;
  try {
    query = typeof input.page === 'string' && input.page.length <= 2000 ? new URL(input.page).searchParams : null;
  } catch { /* not an address */ }
  for (const key of UTM) {
    const value = cleanText(input[key] ?? query?.get(key) ?? null);
    if (value && !secretProblem(value)) out[key] = value.slice(0, 120);
  }
  const clicks = CLICK_IDS.filter((key) => (typeof input[key] === 'string' && input[key] !== '') || query?.has(key));
  if (clicks.length > 0) out.click_ids = clicks;
  if (input.embedded === true) out.embedded = true;
  return out;
}

/* ── an API post ────────────────────────────────────────── */

const WEBHOOK_CONTACT = ['name', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country'];

export interface WebhookArrival extends ArrivalParts {
  eventId: string | null;
  claimed: Raw;
  occurredAt: string | null;
}

/**
 * A lead posted by the client's own system:
 *
 *   { event_id, contact: { name | first_name + last_name, phone, email, address… },
 *     lead: { title, summary, service, priority }, attribution: { page, referrer, utm_… },
 *     consent: { sms: { granted, disclosure }, email: { … } }, occurred_at }
 *
 * `event_id` is theirs, and is what makes a redelivery the same arrival. Strict: a key this
 * does not know is refused, so a field is never silently dropped.
 */
export function parseWebhookPayload(raw: unknown, context: { services: readonly ServiceOption[] }): Parsed<WebhookArrival> {
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'body', message: 'is a JSON object' }] };
  const errors: FieldError[] = [];
  unknownKeys(raw, ['event_id', 'contact', 'lead', 'attribution', 'consent', 'occurred_at'], '', errors);

  let eventId: string | null = null;
  if (raw.event_id !== undefined && raw.event_id !== null) {
    const id = cleanText(raw.event_id);
    if (!id || id.length < 8 || id.length > 120 || secretProblem(id)) errors.push({ field: 'event_id', message: 'is 8 to 120 characters' });
    else eventId = id;
  }

  const contactRaw = asObject(raw.contact);
  unknownKeys(contactRaw, WEBHOOK_CONTACT, 'contact.', errors);
  /* only the keys this accepts go on to the contact check, so each problem is named once. */
  const { name, ...rest } = Object.fromEntries(Object.entries(contactRaw).filter(([key]) => WEBHOOK_CONTACT.includes(key)));
  const contact = parseContactInput(name === undefined ? rest : { ...rest, display_name: name });
  if (!contact.ok) errors.push(...contact.errors.map((e) => ({ field: `contact.${e.field === 'display_name' ? 'name' : e.field}`, message: e.message })));

  const leadRaw = asObject(raw.lead);
  unknownKeys(leadRaw, ['title', 'summary', 'service', 'priority'], 'lead.', errors);
  const lead = leadFields(leadRaw, context.services, errors, 'lead.');

  const consent: ConsentInput[] = [];
  if (raw.consent !== undefined && raw.consent !== null) {
    const given = asObject(raw.consent);
    unknownKeys(given, FORM_CONSENT_CHANNELS, 'consent.', errors);
    for (const channel of FORM_CONSENT_CHANNELS) {
      if (given[channel] === undefined) continue;
      const entry = asObject(given[channel]);
      const at = `consent.${channel}`;
      const address = contact.ok ? (channel === 'sms' ? contact.value.phone : contact.value.email) : null;
      const disclosure = cleanText(entry.disclosure, { multiline: true });
      if (typeof entry.granted !== 'boolean') errors.push({ field: `${at}.granted`, message: 'must be true or false' });
      else if (!disclosure || disclosure.length > 1000 || secretProblem(disclosure)) errors.push({ field: `${at}.disclosure`, message: 'is the wording the person was shown, up to 1000 characters' });
      else if (typeof address !== 'string') errors.push({ field: at, message: `there is no ${channel === 'sms' ? 'phone number' : 'email address'} for this to be about` });
      else consent.push({ channel, address, granted: entry.granted, disclosure });
    }
  }

  let occurredAt: string | null = null;
  if (raw.occurred_at !== undefined && raw.occurred_at !== null) {
    const ms = typeof raw.occurred_at === 'string' ? Date.parse(raw.occurred_at) : NaN;
    if (Number.isNaN(ms)) errors.push({ field: 'occurred_at', message: 'is not a date and time' });
    else occurredAt = new Date(ms).toISOString();
  }

  if (errors.length > 0 || !contact.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      eventId,
      contact: contact.value,
      lead: { ...lead, title: lead.title ?? lead.serviceName ?? (lead.summary ? firstLine(lead.summary, 80) : 'New enquiry') },
      consent,
      answers: {},
      claimed: parseAttribution(raw.attribution),
      occurredAt,
    },
  };
}

interface LeadFields {
  title: string | null;
  summary: string | null;
  service_id: string | null;
  service_category_id: string | null;
  serviceName: string | null;
  priority?: string;
}

/** a lead's own fields, from an API post, an import row or a typed-in lead. */
function leadFields(raw: Raw, services: readonly ServiceOption[], errors: FieldError[], prefix: string): LeadFields {
  const out: LeadFields = { title: null, summary: null, service_id: null, service_category_id: null, serviceName: null };
  const text = (key: 'title' | 'summary', max: number) => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') return;
    const value = cleanText(raw[key], { multiline: key === 'summary' });
    if (value === null) errors.push({ field: `${prefix}${key}`, message: 'must be text' });
    else if (value.length > max) errors.push({ field: `${prefix}${key}`, message: `is longer than ${max} characters` });
    else if (secretProblem(value)) errors.push({ field: `${prefix}${key}`, message: 'looks like a credential — those are never kept on a customer record' });
    else out[key] = value;
  };
  text('title', 200);
  text('summary', 2000);
  if (raw.service !== undefined && raw.service !== null && raw.service !== '') {
    const wanted = cleanText(raw.service)?.toLowerCase() ?? '';
    const service = services.find((s) => s.key === wanted || s.name.toLowerCase() === wanted);
    if (!service) errors.push({ field: `${prefix}service`, message: 'is not one of this business\'s services' });
    else {
      out.service_id = service.id;
      out.service_category_id = service.category_id;
      out.serviceName = service.name;
    }
  }
  if (raw.priority !== undefined && raw.priority !== null && raw.priority !== '') {
    const priority = cleanText(raw.priority)?.toLowerCase() ?? '';
    if (!(PRIORITIES as readonly string[]).includes(priority)) errors.push({ field: `${prefix}priority`, message: `is one of: ${PRIORITIES.join(', ')}` });
    else out.priority = priority;
  }
  return out;
}

/**
 * A lead somebody typed in: `{ contact_id }` for a customer already on file, or
 * `{ contact: {...} }` for a new one, and `{ lead: { title, summary, service, priority } }`.
 */
export function parseManualLead(
  raw: unknown,
  context: { services: readonly ServiceOption[] },
): Parsed<{ contactId: string | null; contact: Raw; lead: ArrivalParts['lead']; allowDuplicate: boolean }> {
  const source = asObject(raw);
  const errors: FieldError[] = [];
  unknownKeys(source, ['contact_id', 'contact', 'lead', 'allow_duplicate'], '', errors);
  let contactId: string | null = null;
  let contact: Raw = {};
  if (source.contact_id !== undefined && source.contact_id !== null) {
    if (typeof source.contact_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.contact_id)) errors.push({ field: 'contact_id', message: 'is not an id' });
    else if (source.contact !== undefined) errors.push({ field: 'contact', message: 'name an existing contact or a new one, not both' });
    else contactId = source.contact_id.toLowerCase();
  } else {
    const parsed = parseContactInput(source.contact);
    if (parsed.ok) contact = parsed.value;
    else errors.push(...parsed.errors.map((e) => ({ field: `contact.${e.field}`, message: e.message })));
  }
  const lead = leadFields(asObject(source.lead), context.services, errors, 'lead.');
  unknownKeys(asObject(source.lead), ['title', 'summary', 'service', 'priority'], 'lead.', errors);
  const title = lead.title ?? lead.serviceName;
  if (!title) errors.push({ field: 'lead.title', message: 'is required' });
  if (source.allow_duplicate !== undefined && typeof source.allow_duplicate !== 'boolean') errors.push({ field: 'allow_duplicate', message: 'must be true or false' });
  if (errors.length > 0) return { ok: false, errors };
  const { serviceName: _name, ...fields } = lead;
  return { ok: true, value: { contactId, contact, lead: { ...fields, title: title as string }, allowDuplicate: source.allow_duplicate === true } };
}

/* ── CSV ────────────────────────────────────────────────── */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: ',' | ';' | '\t';
  /** why the file as a whole cannot be imported. empty when it can. */
  problems: string[];
}

/** the separator the heading line uses most, outside quotes. a comma unless it is clearly not. */
function delimiterOf(line: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts] += 1;
  }
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

/**
 * A CSV file, read the way a spreadsheet writes one: quoted values, doubled quotes, line
 * breaks inside quotes, CRLF or LF, an optional byte-order mark, and a semicolon or a tab
 * where a locale uses one. Blank lines are dropped. Nothing is evaluated — a cell that
 * starts with `=` is the text `=…`.
 */
export function parseCsv(input: unknown): ParsedCsv {
  const empty: ParsedCsv = { headers: [], rows: [], delimiter: ',', problems: [] };
  if (typeof input !== 'string' || input.trim() === '') return { ...empty, problems: ['the file is empty'] };
  if (input.length > LIMITS.csvCharacters) return { ...empty, problems: [`the file is larger than ${LIMITS.csvCharacters.toLocaleString('en-US')} characters — split it and import the parts`] };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = delimiterOf(text.slice(0, text.search(/\r?\n|$/)));

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const endField = () => { record.push(wasQuoted ? field : field.trim()); field = ''; wasQuoted = false; };
  const endRecord = () => {
    endField();
    if (record.some((cell) => cell !== '')) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === '') { quoted = true; wasQuoted = true; field = ''; }
    else if (ch === delimiter) endField();
    else if (ch === '\n') endRecord();
    else if (ch === '\r') { if (text[i + 1] !== '\n') endRecord(); }
    else field += ch;
  }
  if (quoted) return { ...empty, delimiter, problems: ['a quoted value is never closed — the file is cut off or a quote is missing'] };
  endRecord();

  if (records.length === 0) return { ...empty, delimiter, problems: ['the file is empty'] };
  const problems: string[] = [];
  const headers = records[0].map((h, i) => cleanText(h)?.slice(0, 80) ?? `column ${i + 1}`);
  if (headers.length > LIMITS.importColumns) problems.push(`the file has ${headers.length} columns; an import reads up to ${LIMITS.importColumns}`);
  const repeated = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (repeated.length > 0) problems.push(`two columns are both headed "${repeated[0]}" — rename one`);
  const rows = records.slice(1);
  if (rows.length === 0) problems.push('the file has a heading line and no rows');
  if (rows.length > LIMITS.importRows) problems.push(`the file has ${rows.length} rows; an import takes up to ${LIMITS.importRows} — split it and import the parts`);
  return { headers, rows, delimiter, problems };
}

/** what a column can be mapped to. */
export const IMPORT_TARGETS = [
  'name', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'address_line2', 'city', 'region',
  'postal_code', 'country', 'title', 'summary', 'service', 'priority',
] as const;
export type ImportTarget = typeof IMPORT_TARGETS[number];
export type ImportMapping = Record<string, ImportTarget | null>;

const ALIASES: Readonly<Record<ImportTarget, readonly string[]>> = Object.freeze({
  name: ['name', 'full name', 'customer', 'customer name', 'contact', 'contact name', 'client', 'client name'],
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'cell', 'cell phone', 'telephone', 'tel'],
  email: ['email', 'e-mail', 'email address', 'e-mail address'],
  address_line1: ['address', 'street', 'street address', 'address 1', 'address line 1', 'service address'],
  address_line2: ['address 2', 'address line 2', 'unit', 'apt', 'suite'],
  city: ['city', 'town'],
  region: ['state', 'province', 'region'],
  postal_code: ['zip', 'zip code', 'zipcode', 'postal code', 'postcode'],
  country: ['country'],
  title: ['title', 'job', 'job title', 'subject', 'lead', 'opportunity'],
  summary: ['summary', 'notes', 'note', 'message', 'description', 'details', 'comments', 'request'],
  service: ['service', 'service type', 'job type', 'category'],
  priority: ['priority', 'urgency'],
});

/** a first guess at what each column is, from its heading. the operator confirms it. */
export function suggestMapping(headers: readonly string[]): ImportMapping {
  const mapping: ImportMapping = {};
  const taken = new Set<ImportTarget>();
  const plain = (text: string) => text.toLowerCase().replace(/[_\-.\s]+/g, ' ').trim();
  for (const header of headers) {
    const heading = plain(header);
    const target = IMPORT_TARGETS.find((t) => !taken.has(t) && ALIASES[t].some((alias) => plain(alias) === heading)) ?? null;
    if (target) taken.add(target);
    mapping[header] = target;
  }
  return mapping;
}

/** the mapping an operator confirmed, checked against the file's own headings. */
export function parseMapping(raw: unknown, headers: readonly string[]): Parsed<ImportMapping> {
  if (!isObject(raw)) return { ok: false, errors: [{ field: 'mapping', message: 'is an object: column heading → what it is' }] };
  const errors: FieldError[] = [];
  const mapping: ImportMapping = {};
  const used = new Map<string, string>();
  for (const [header, target] of Object.entries(raw)) {
    if (!headers.includes(header)) { errors.push({ field: `mapping.${header}`, message: 'is not a column of this file' }); continue; }
    if (target === null || target === '' || target === 'ignore') { mapping[header] = null; continue; }
    if (typeof target !== 'string' || !(IMPORT_TARGETS as readonly string[]).includes(target)) {
      errors.push({ field: `mapping.${header}`, message: `is one of: ${IMPORT_TARGETS.join(', ')}, or left out` });
      continue;
    }
    if (used.has(target)) errors.push({ field: `mapping.${header}`, message: `${target} is already taken from the column "${used.get(target)}"` });
    if (secretProblem({ [header]: target })) errors.push({ field: `mapping.${header}`, message: 'is headed like a credential column — leave it out of the import' });
    used.set(target, header);
    mapping[header] = target as ImportTarget;
  }
  if (!['name', 'first_name', 'last_name', 'phone', 'email'].some((t) => used.has(t))) {
    errors.push({ field: 'mapping', message: 'map at least one column to a name, a phone number or an email address' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: mapping };
}

export interface ImportRow {
  row_number: number;
  status: 'ready' | 'invalid' | 'duplicate_in_file';
  payload: Raw;
  problems: FieldError[];
}

/**
 * Every row of the file as what it would become. A row with a problem says which field and
 * why — never the value, which may be the very thing that should not be repeated. A row whose
 * phone or email already appeared higher up is a duplicate of that row and is not imported.
 */
export function mapImportRows(input: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  mapping: ImportMapping;
  services: readonly ServiceOption[];
  fileName: string;
}): ImportRow[] {
  const columns = input.headers.map((header) => input.mapping[header] ?? null);
  const seenPhone = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  return input.rows.map((cells, index) => {
    const rowNumber = index + 1;
    const errors: FieldError[] = [];
    if (cells.length > input.headers.length) errors.push({ field: 'row', message: 'has more values than the file has columns — check for an unquoted comma' });
    const value: Partial<Record<ImportTarget, string>> = {};
    columns.forEach((target, i) => {
      const cell = cleanText(cells[i] ?? '', { multiline: target === 'summary' });
      if (target && cell) value[target] = cell;
    });

    const { name, title, summary, service, priority, ...contactRaw } = value;
    const contact = parseContactInput(name === undefined ? contactRaw : { ...contactRaw, display_name: name });
    if (!contact.ok) errors.push(...contact.errors.map((e) => ({ field: e.field === 'display_name' ? 'name' : e.field, message: e.message })));
    const lead = leadFields({ title, summary, service, priority }, input.services, errors, '');

    if (errors.length > 0 || !contact.ok) return { row_number: rowNumber, status: 'invalid', payload: {}, problems: errors };

    const phone = contact.value.phone as string | null | undefined;
    const email = contact.value.email as string | null | undefined;
    const earlier = (phone ? seenPhone.get(phone) : undefined) ?? (email ? seenEmail.get(email) : undefined);
    if (phone && !seenPhone.has(phone)) seenPhone.set(phone, rowNumber);
    if (email && !seenEmail.has(email)) seenEmail.set(email, rowNumber);
    if (earlier !== undefined) {
      return { row_number: rowNumber, status: 'duplicate_in_file', payload: {}, problems: [{ field: 'row', message: `has the same phone or email as row ${earlier}` }] };
    }

    const { serviceName, ...fields } = lead;
    const present = (object: Raw) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));
    const payload = {
      contact: present(contact.value),
      lead: present({ ...fields, title: fields.title ?? serviceName ?? `Imported from ${input.fileName}`.slice(0, 200) }),
    };
    if (secretProblem(payload)) return { row_number: rowNumber, status: 'invalid', payload: {}, problems: [{ field: 'row', message: 'reads like it contains a credential — those are never kept on a customer record' }] };
    return { row_number: rowNumber, status: 'ready', payload, problems: [] };
  });
}

/* ── where a form lives ─────────────────────────────────── */

/** the shareable link. the key is public by construction; it is not the client's id. */
export function formUrl(siteUrl: string, publicKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/form/${publicKey}`;
}

/**
 * What is pasted into the business's own site: a frame around the hosted form, and nothing
 * else. No script runs on their page and nothing of ARC's is configured there — the snippet
 * is the link, so there is no key, token or endpoint in it to leak or to drift.
 */
export function embedSnippet(siteUrl: string, publicKey: string, title: string): string {
  const safe = title.replace(/[<>"&]/g, '');
  return `<iframe src="${formUrl(siteUrl, publicKey)}?embed=1" title="${safe}" loading="lazy" style="width:100%;min-height:680px;border:0"></iframe>`;
}

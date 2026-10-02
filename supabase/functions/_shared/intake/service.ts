/**
 * ARC-350 — the intake service: every way a lead enters 0023's CRM that is not Lead Recovery.
 *
 *   a hosted form     `publicForm` / `submitForm`        nobody is signed in
 *   an API post       `receiveWebhook`                   a bearer token ARC issued
 *   a typed-in lead   `createManualLead`                 an operator or a client user
 *   a CSV             `inspectCsv` → `previewImport` → `commitImport`
 *
 * All four end in one place: `store.arrival`, which is 0024's `crm_intake_arrival` — the
 * source record, the contact, the lead and the consent rows in one transaction, behind one
 * lock per client. So "the same person twice" and "the same request twice" are decided
 * once, in the database, the same way for every door.
 *
 * This file checks who is asking (ARC-340's `can`), checks the input (`model.ts`), checks
 * that this side is the authority for what would be created (`writeDecision`), and builds
 * the arrival. It writes no `events` row and starts nothing: capturing a lead is not
 * following it up.
 *
 * The two public functions answer with as little as possible. A stranger is told their
 * request arrived and nothing else — not the lead, not the client, not whether it was a
 * duplicate, not whether it was thrown away as spam.
 */

import {
  actorStamp,
  can,
  type CrmActor,
  type CrmPermission,
  effectivePolicy,
  type FieldError,
  type ObjectType,
  secretProblem,
  writeDecision,
} from '../crm/model.ts';
import { type CrmErrorCode, type CrmOutcome, type CrmStore, CrmStoreError, type Row, type RowQuery } from '../crm/service.ts';
import {
  type ArrivalParts,
  cleanText,
  ENDPOINT_TOKEN,
  FORM_KEY,
  FORM_STATUSES,
  type FormDefinition,
  LIMITS,
  mapImportRows,
  parseAttribution,
  parseCsv,
  parseFormDefinition,
  parseFormInput,
  parseManualLead,
  parseMapping,
  parseSubmission,
  parseWebhookPayload,
  type ServiceOption,
  spamVerdict,
  suggestMapping,
  IMPORT_TARGETS,
} from './model.ts';

/* ── the store ──────────────────────────────────────────── */

export const INTAKE_TABLES = [
  'crm_intake_forms', 'crm_intake_endpoints', 'crm_imports', 'crm_import_rows', 'crm_consent_records',
] as const;
export type IntakeTable = typeof INTAKE_TABLES[number];

export interface ArrivalResult {
  outcome: 'created' | 'duplicate' | 'replayed';
  source_event_id: string;
  contact_id: string | null;
  lead_id: string | null;
  contact_matched: boolean;
  ambiguous: boolean;
}

/** Tenant-scoped like ARC-340's store, except the two lookups a public request starts from. */
export interface IntakeStore {
  rows(table: IntakeTable | 'crm_source_events', tenantId: string, query?: RowQuery): Promise<Row[]>;
  row(table: IntakeTable, tenantId: string, id: string): Promise<Row | null>;
  insert(table: IntakeTable, row: Row): Promise<Row>;
  insertMany(table: IntakeTable, rows: Row[]): Promise<void>;
  update(table: IntakeTable, tenantId: string, id: string, patch: Row): Promise<Row | null>;
  /** the form a public key names, whoever's it is. the key is all a browser has. */
  formByPublicKey(publicKey: string): Promise<Row | null>;
  endpointByTokenHash(hash: string): Promise<Row | null>;
  arrival(tenantId: string, arrival: Row): Promise<ArrivalResult>;
  annotateImport(tenantId: string, importId: string): Promise<void>;
  importSummary(tenantId: string, importId: string): Promise<{ by_status: Record<string, number>; by_match: Record<string, number> }>;
  commitImport(request: { tenantId: string; importId: string; actorType: string; actorId: string | null; limit: number }): Promise<{ processed: number; remaining: number; status: string }>;
}

export interface IntakeDeps {
  crm: CrmStore;
  intake: IntakeStore;
  now?: () => Date;
}

/** how long "this person already has an open lead" lasts for an API post or a typed-in lead. */
export const DEFAULT_DEDUPE_MINUTES = 1440;

/* ── plumbing ───────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const asObject = (raw: unknown): Row => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {});

type Refusal = { ok: false; code: CrmErrorCode; message: string; fieldErrors?: FieldError[]; candidates?: Row[] };
const refuse = (code: CrmErrorCode, message: string): Refusal => ({ ok: false, code, message });
const invalid = (errors: FieldError[]): Refusal => ({
  ok: false, code: 'invalid', message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: errors,
});

/** the permission, the tenant, and a store refusal turned into an outcome. */
async function act<T>(
  deps: IntakeDeps,
  actor: CrmActor | null,
  permission: CrmPermission,
  tenantId: unknown,
  fn: (tenantId: string, actor: CrmActor) => Promise<CrmOutcome<T>>,
): Promise<CrmOutcome<T>> {
  if (!actor) return refuse('unauthorized', 'not signed in');
  if (!isId(tenantId)) return refuse('invalid', 'tenant_id is required');
  const allowed = can(actor, permission, tenantId);
  if (!allowed.ok) return refuse(allowed.code as CrmErrorCode, allowed.message);
  try {
    if (!(await deps.crm.getTenant(tenantId))) return refuse('not_found', 'this client does not exist');
    return await fn(tenantId, actor);
  } catch (error) {
    if (error instanceof CrmStoreError) return refuse(error.code, error.message);
    throw error;
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `length` characters of a–z0–9 from the platform's random source, without modulo bias. */
export function randomKey(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 252 && out.length < length) out += ALPHABET[byte % 36];
    }
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** the business's services a form or an import can name. */
async function serviceOptions(crm: CrmStore, tenantId: string, opts: { bookableOnly: boolean }): Promise<ServiceOption[]> {
  const rows = await crm.rows('business_services', tenantId, { isNull: ['archived_at'], order: ['key', 'asc'] });
  return rows
    .filter((s) => !opts.bookableOnly || s.is_bookable === true)
    .map((s) => ({ id: s.id, key: s.key, name: s.name, category_id: s.category_id ?? null }));
}

/** ARC-340's step 3: is this side the authority for a new record of this kind. */
async function mayCreate(crm: CrmStore, tenantId: string, actor: CrmActor, objectType: ObjectType, fields: string[]): Promise<Refusal | null> {
  const rows = await crm.rows('crm_source_policies', tenantId, { eq: { object_type: objectType } });
  const decision = writeDecision(effectivePolicy(rows[0], objectType), actor, 'create', fields);
  return decision.ok ? null : refuse(decision.code as CrmErrorCode, decision.message);
}

async function mayIntake(crm: CrmStore, tenantId: string, actor: CrmActor, parts: { contact: Row | null; lead: Row }): Promise<Refusal | null> {
  const present = (object: Row) => Object.keys(object).filter((k) => object[k] !== null && object[k] !== undefined);
  return (parts.contact ? await mayCreate(crm, tenantId, actor, 'contact', present(parts.contact)) : null)
    ?? await mayCreate(crm, tenantId, actor, 'lead', present(parts.lead));
}

const withoutHash = ({ token_hash: _hash, ...endpoint }: Row): Row => endpoint;

/* ── forms ──────────────────────────────────────────────── */

export interface IntakeOverview {
  forms: Row[];
  endpoints: Row[];
  imports: Row[];
  /** the most recent arrivals through any door, newest first. */
  recent: Row[];
  services: ServiceOption[];
  limits: typeof LIMITS;
}

export function getIntakeOverview(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown): Promise<CrmOutcome<IntakeOverview>> {
  return act(deps, actor, 'read', tenantId, async (id) => {
    const [forms, endpoints, imports, recent, services] = await Promise.all([
      deps.intake.rows('crm_intake_forms', id, { order: ['created_at', 'desc'] }),
      deps.intake.rows('crm_intake_endpoints', id, { order: ['created_at', 'desc'] }),
      deps.intake.rows('crm_imports', id, { order: ['created_at', 'desc'], limit: 20 }),
      deps.intake.rows('crm_source_events', id, { order: ['received_at', 'desc'], limit: 50 }),
      serviceOptions(deps.crm, id, { bookableOnly: false }),
    ]);
    return { ok: true, result: { forms, endpoints: endpoints.map(withoutHash), imports, recent, services, limits: LIMITS } };
  });
}

/** Create a form (a draft, with a new link) or change one. Publishing is `setFormStatus`. */
export function saveForm(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown, formId?: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const creating = formId === undefined || formId === null;
    const parsed = parseFormInput(input, { partial: !creating });
    if (!parsed.ok) return invalid(parsed.errors);
    const { type, id: actorId } = actorStamp(who);
    const stamp = { updated_by_type: type, updated_by: actorId };
    if (creating) {
      return { ok: true, result: await deps.intake.insert('crm_intake_forms', { tenant_id: id, public_key: `arcf_${randomKey(32)}`, ...parsed.value, ...stamp }) };
    }
    if (!isId(formId)) return refuse('not_found', 'no such form for this client');
    if (Object.keys(parsed.value).length === 0) return invalid([{ field: 'form', message: 'nothing to change' }]);
    const row = await deps.intake.update('crm_intake_forms', id, formId, { ...parsed.value, ...stamp });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such form for this client');
  });
}

/** draft → published → archived, and back to draft. Only a published form takes submissions. */
export function setFormStatus(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, formId: unknown, status: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    if (!isId(formId)) return refuse('not_found', 'no such form for this client');
    if (typeof status !== 'string' || !(FORM_STATUSES as readonly string[]).includes(status)) {
      return invalid([{ field: 'status', message: `is one of: ${FORM_STATUSES.join(', ')}` }]);
    }
    const { type, id: actorId } = actorStamp(who);
    const row = await deps.intake.update('crm_intake_forms', id, formId, { status, updated_by_type: type, updated_by: actorId });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such form for this client');
  });
}

/* ── API endpoints ──────────────────────────────────────── */

/**
 * Issue a token for the client's own system to post leads with. The token is in the result
 * of this one call and nowhere afterwards — only its hash is kept.
 */
export function createEndpoint(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<{ endpoint: Row; token: string }>> {
  return act(deps, actor, 'policy', tenantId, async (id, who) => {
    const name = cleanText(asObject(input).name);
    if (!name || name.length > 120 || secretProblem(name)) return invalid([{ field: 'name', message: 'is 1 to 120 characters, and says what will be posting here' }]);
    const token = `arci_${randomKey(48)}`;
    const { type, id: actorId } = actorStamp(who);
    const endpoint = await deps.intake.insert('crm_intake_endpoints', {
      tenant_id: id, name, token_hash: await sha256Hex(token), token_hint: token.slice(-4), created_by_type: type, created_by: actorId,
    });
    return { ok: true, result: { endpoint: withoutHash(endpoint), token } };
  });
}

export function revokeEndpoint(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, endpointId: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'policy', tenantId, async (id, who) => {
    if (!isId(endpointId)) return refuse('not_found', 'no such endpoint for this client');
    const { type, id: actorId } = actorStamp(who);
    const row = await deps.intake.update('crm_intake_endpoints', id, endpointId, {
      revoked_at: (deps.now?.() ?? new Date()).toISOString(), revoked_by_type: type, revoked_by: actorId,
    });
    return row ? { ok: true, result: withoutHash(row) } : refuse('not_found', 'no such endpoint for this client');
  });
}

/* ── a lead somebody typed in ───────────────────────────── */

export function createManualLead(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<ArrivalResult>> {
  return act(deps, actor, 'record', tenantId, async (id, who) => {
    const parsed = parseManualLead(input, { services: await serviceOptions(deps.crm, id, { bookableOnly: false }) });
    if (!parsed.ok) return invalid(parsed.errors);
    const { contactId, contact, lead, allowDuplicate } = parsed.value;
    const refused = await mayIntake(deps.crm, id, who, { contact: contactId ? null : contact, lead });
    if (refused) return refused;
    const { type, id: actorId } = actorStamp(who);
    try {
      return {
        ok: true,
        result: await deps.intake.arrival(id, {
          source: 'manual', actor_type: type, actor_id: actorId,
          ...(contactId ? { contact_id: contactId } : { contact }),
          lead,
          dedupe_minutes: allowDuplicate ? 0 : DEFAULT_DEDUPE_MINUTES,
          on_ambiguous: 'refuse',
          detail: { entered_by: type },
        }),
      };
    } catch (error) {
      /* several customers share this phone or email: the person entering it chooses. */
      if (error instanceof CrmStoreError && error.code === 'ambiguous_contact') {
        const [byPhone, byEmail] = await Promise.all([
          contact.phone ? deps.crm.rows('crm_contacts', id, { eq: { phone: contact.phone }, isNull: ['merged_into_id', 'archived_at'] }) : [],
          contact.email ? deps.crm.rows('crm_contacts', id, { eq: { email: contact.email }, isNull: ['merged_into_id', 'archived_at'] }) : [],
        ]);
        const candidates = [...new Map([...byPhone, ...byEmail].map((c) => [c.id, c])).values()];
        return { ok: false, code: 'ambiguous_contact', message: error.message, candidates };
      }
      throw error;
    }
  });
}

/* ── CSV import ─────────────────────────────────────────── */

export interface CsvInspection {
  headers: string[];
  /** a first guess from the headings; the operator confirms or changes it. */
  suggested: Record<string, string | null>;
  sample: string[][];
  row_count: number;
  targets: readonly string[];
}

/** Read a file's headings and first rows. Writes nothing. */
export function inspectCsv(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<CsvInspection>> {
  return act(deps, actor, 'business', tenantId, (_id) => {
    const csv = parseCsv(asObject(input).csv);
    if (csv.problems.length > 0) return Promise.resolve(invalid(csv.problems.map((message) => ({ field: 'csv', message }))));
    return Promise.resolve({
      ok: true,
      result: { headers: csv.headers, suggested: suggestMapping(csv.headers), sample: csv.rows.slice(0, 5), row_count: csv.rows.length, targets: IMPORT_TARGETS },
    });
  });
}

export interface ImportView {
  import: Row;
  summary: { by_status: Record<string, number>; by_match: Record<string, number> };
  /** the rows that will not, or did not, become a lead — each with why. */
  attention: Row[];
  /** the first rows that will, as they would be written. */
  sample: Row[];
}

async function importView(deps: IntakeDeps, tenantId: string, importId: string): Promise<ImportView | null> {
  const row = await deps.intake.row('crm_imports', tenantId, importId);
  if (!row) return null;
  const [summary, attention, sample] = await Promise.all([
    deps.intake.importSummary(tenantId, importId),
    deps.intake.rows('crm_import_rows', tenantId, {
      eq: { import_id: importId }, in: ['status', ['invalid', 'duplicate_in_file', 'failed', 'skipped']], order: ['row_number', 'asc'], limit: 200,
    }),
    deps.intake.rows('crm_import_rows', tenantId, { eq: { import_id: importId, status: 'ready' }, order: ['row_number', 'asc'], limit: 20 }),
  ]);
  return { import: row, summary, attention, sample };
}

/**
 * Store the file as rows and say what each would become: ready, not valid (and why), a
 * repeat of an earlier row, and — for the ready ones — whether the person is already a
 * customer. Nothing in the CRM changes until `commitImport`.
 */
export function previewImport(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, input: unknown): Promise<CrmOutcome<ImportView>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    const source = asObject(input);
    const csv = parseCsv(source.csv);
    if (csv.problems.length > 0) return invalid(csv.problems.map((message) => ({ field: 'csv', message })));
    const mapping = parseMapping(source.mapping, csv.headers);
    const errors: FieldError[] = mapping.ok ? [] : [...mapping.errors];
    const fileName = cleanText(source.file_name)?.slice(0, 200) ?? null;
    if (!fileName || secretProblem(fileName)) errors.push({ field: 'file_name', message: 'is required' });
    const dedupe = source.dedupe_minutes ?? DEFAULT_DEDUPE_MINUTES;
    if (typeof dedupe !== 'number' || !Number.isInteger(dedupe) || dedupe < 0 || dedupe > LIMITS.dedupeMinutesMax) {
      errors.push({ field: 'dedupe_minutes', message: `is a whole number from 0 to ${LIMITS.dedupeMinutesMax}` });
    }
    if (errors.length > 0 || !mapping.ok || !fileName) return invalid(errors);

    const refused = await mayIntake(deps.crm, id, who, { contact: { display_name: '' }, lead: { title: '' } });
    if (refused) return refused;

    const rows = mapImportRows({
      headers: csv.headers, rows: csv.rows, mapping: mapping.value, fileName,
      services: await serviceOptions(deps.crm, id, { bookableOnly: false }),
    });
    const { type, id: actorId } = actorStamp(who);
    const mapped = Object.fromEntries(Object.entries(mapping.value).filter(([, target]) => target !== null));
    const created = await deps.intake.insert('crm_imports', {
      tenant_id: id, file_name: fileName, mapping: mapped, dedupe_minutes: dedupe, total_rows: rows.length, created_by_type: type, created_by: actorId,
    });
    for (let i = 0; i < rows.length; i += 500) {
      await deps.intake.insertMany('crm_import_rows', rows.slice(i, i + 500).map((r) => ({ tenant_id: id, import_id: created.id, ...r })));
    }
    await deps.intake.annotateImport(id, created.id);
    return { ok: true, result: (await importView(deps, id, created.id))! };
  });
}

export function getImport(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, importId: unknown): Promise<CrmOutcome<ImportView>> {
  return act(deps, actor, 'read', tenantId, async (id) => {
    const view = isId(importId) ? await importView(deps, id, importId) : null;
    return view ? { ok: true, result: view } : refuse('not_found', 'no such import for this client');
  });
}

/**
 * Import the next batch of ready rows. Returns how many are left; call it again until none
 * are. A row that is refused is marked with the reason and the rest carry on.
 */
export function commitImport(
  deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, importId: unknown,
): Promise<CrmOutcome<ImportView & { processed: number; remaining: number }>> {
  return act(deps, actor, 'business', tenantId, async (id, who) => {
    if (!isId(importId)) return refuse('not_found', 'no such import for this client');
    const refused = await mayIntake(deps.crm, id, who, { contact: { display_name: '' }, lead: { title: '' } });
    if (refused) return refused;
    const { type, id: actorId } = actorStamp(who);
    const done = await deps.intake.commitImport({ tenantId: id, importId, actorType: type, actorId, limit: LIMITS.importBatch });
    return { ok: true, result: { ...(await importView(deps, id, importId))!, processed: done.processed, remaining: done.remaining } };
  });
}

/** Abandon a preview, or stop an import where it is. Rows already imported stay imported. */
export function cancelImport(deps: IntakeDeps, actor: CrmActor | null, tenantId: unknown, importId: unknown): Promise<CrmOutcome<Row>> {
  return act(deps, actor, 'business', tenantId, async (id) => {
    if (!isId(importId)) return refuse('not_found', 'no such import for this client');
    const row = await deps.intake.update('crm_imports', id, importId, { status: 'cancelled' });
    return row ? { ok: true, result: row } : refuse('not_found', 'no such import for this client');
  });
}

/* ── the public side: a form ────────────────────────────── */

export interface PublicFormView {
  version: number;
  business: string;
  title: string;
  intro: string | null;
  submit_label: string;
  success_message: string;
  fields: (FormDefinition['fields'][number] & { choices?: { value: string; label: string }[] })[];
  consent: FormDefinition['consent'];
}

interface LoadedForm { row: Row; definition: FormDefinition; services: ServiceOption[]; business: string }

/**
 * The published form a key names, or null — for a key that was never issued, a draft and an
 * archived form alike, so the answer says nothing about which. A service question with no
 * services to choose from is left off rather than shown empty.
 */
async function loadPublishedForm(deps: IntakeDeps, publicKey: unknown): Promise<LoadedForm | null> {
  if (typeof publicKey !== 'string' || !FORM_KEY.test(publicKey)) return null;
  const row = await deps.intake.formByPublicKey(publicKey);
  if (!row || row.status !== 'published') return null;
  const parsed = parseFormDefinition(row.definition);
  const tenant = await deps.crm.getTenant(row.tenant_id);
  if (!parsed.ok || !tenant || tenant.status === 'archived') return null;
  const services = await serviceOptions(deps.crm, row.tenant_id, { bookableOnly: true });
  const fields = parsed.value.fields.filter((f) => f.type !== 'service' || services.length > 0);
  return { row, definition: { ...parsed.value, fields }, services, business: tenant.name };
}

export async function publicForm(deps: IntakeDeps, publicKey: unknown): Promise<PublicFormView | null> {
  const form = await loadPublishedForm(deps, publicKey);
  if (!form) return null;
  const { definition } = form;
  return {
    version: form.row.version,
    business: form.business,
    title: definition.title,
    intro: definition.intro,
    submit_label: definition.submit_label,
    success_message: definition.success_message,
    fields: definition.fields.map((field) => (field.type === 'service'
      ? { ...field, choices: form.services.map((s) => ({ value: s.key, label: s.name })) }
      : field)),
    consent: definition.consent,
  };
}

export type PublicOutcome =
  | { ok: true; discarded: 'honeypot' | 'dwell' | null; outcome: ArrivalResult['outcome'] | null; tenantId: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'rate_limited'; message: string; fieldErrors?: FieldError[] };

const SUBMISSION_ID = /^[A-Za-z0-9-]{16,64}$/;

/**
 * One submission of a hosted form: `{ values, attribution, submission_id, company_website,
 * rendered_at }`. The two silent checks come first and answer exactly as a real submission
 * does — a script that is told it was caught is a script that gets fixed.
 */
export async function submitForm(deps: IntakeDeps, publicKey: unknown, body: unknown): Promise<PublicOutcome> {
  const form = await loadPublishedForm(deps, publicKey);
  if (!form) return { ok: false, code: 'not_found', message: 'unknown form' };
  const tenantId: string = form.row.tenant_id;
  const input = asObject(body);
  const now = deps.now?.() ?? new Date();

  const spam = spamVerdict(input, now.getTime());
  if (spam) return { ok: true, discarded: spam, outcome: null, tenantId };

  const parsed = parseSubmission(form.definition, input.values, { formName: form.row.name, services: form.services });
  if (!parsed.ok) return { ok: false, code: 'invalid', message: 'some answers need another look', fieldErrors: parsed.errors };
  const parts: ArrivalParts = parsed.value;

  /* the page makes an id when it renders, so a double click or a retried request is one
     submission. without one, the same person saying the same thing in the same minute is. */
  const idempotency = typeof input.submission_id === 'string' && SUBMISSION_ID.test(input.submission_id)
    ? input.submission_id
    : (await sha256Hex(JSON.stringify([parts.contact.phone ?? null, parts.contact.email ?? null, parts.lead.title, now.toISOString().slice(0, 16)]))).slice(0, 32);

  const answers = Object.fromEntries(Object.entries(parts.answers).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]));
  let detail: Row = { form: { name: form.row.name, version: form.row.version }, claimed: parseAttribution(input.attribution), answers };
  /* the answers are in the lead's summary too; if together they read like a credential to
     0024's check, the source record keeps the rest and the lead is not lost. */
  if (secretProblem(detail)) detail = { form: detail.form, claimed: {}, answers: {} };

  try {
    const result = await deps.intake.arrival(tenantId, {
      source: 'web_form',
      actor_type: 'system',
      idempotency_key: `form:${form.row.id}:${idempotency}`,
      form_id: form.row.id,
      detail,
      contact: parts.contact,
      lead: parts.lead,
      consent: parts.consent,
      dedupe_minutes: form.row.dedupe_minutes,
      /* nobody is there to choose between two customers who share a number: keep the lead
         and leave a task for a person. */
      on_ambiguous: 'new_contact',
    });
    return { ok: true, discarded: null, outcome: result.outcome, tenantId };
  } catch (error) {
    if (error instanceof CrmStoreError && error.code === 'rate_limited') return { ok: false, code: 'rate_limited', message: 'this form is busy — please try again later, or call us' };
    if (error instanceof CrmStoreError && error.code === 'not_found') return { ok: false, code: 'not_found', message: 'unknown form' };
    throw error;
  }
}

/* ── the public side: an API post ───────────────────────── */

export type WebhookOutcome =
  | { ok: true; result: ArrivalResult; tenantId: string }
  | { ok: false; code: 'unauthorized' | 'invalid'; message: string; fieldErrors?: FieldError[] };

/**
 * A lead posted with an endpoint's token. The tenant is the endpoint's — nothing in the
 * body can name another. `event_id` (or an `Idempotency-Key` header) is required, because
 * a sender that retries without one would make a lead per retry.
 */
export async function receiveWebhook(deps: IntakeDeps, token: unknown, body: unknown, idempotencyHeader?: unknown): Promise<WebhookOutcome> {
  const unauthorized: WebhookOutcome = { ok: false, code: 'unauthorized', message: 'a valid endpoint token is required' };
  if (typeof token !== 'string' || !ENDPOINT_TOKEN.test(token)) return unauthorized;
  const endpoint = await deps.intake.endpointByTokenHash(await sha256Hex(token));
  if (!endpoint || endpoint.revoked_at) return unauthorized;
  const tenantId: string = endpoint.tenant_id;
  const tenant = await deps.crm.getTenant(tenantId);
  if (!tenant || tenant.status === 'archived') return unauthorized;

  const parsed = parseWebhookPayload(body, { services: await serviceOptions(deps.crm, tenantId, { bookableOnly: false }) });
  if (!parsed.ok) return { ok: false, code: 'invalid', message: parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; '), fieldErrors: parsed.errors };
  const header = cleanText(idempotencyHeader);
  const eventId = parsed.value.eventId ?? (header && header.length >= 8 && header.length <= 120 && !secretProblem(header) ? header : null);
  if (!eventId) {
    const errors = [{ field: 'event_id', message: 'is required — it is what makes a redelivery the same lead instead of a second one' }];
    return { ok: false, code: 'invalid', message: `${errors[0].field}: ${errors[0].message}`, fieldErrors: errors };
  }

  const { contact, lead, consent, occurredAt } = parsed.value;
  const claimed = secretProblem(parsed.value.claimed) ? {} : parsed.value.claimed;
  try {
    const result = await deps.intake.arrival(tenantId, {
      source: 'webhook',
      actor_type: 'system',
      idempotency_key: `endpoint:${endpoint.id}:${eventId}`,
      external_ref: eventId,
      endpoint_id: endpoint.id,
      detail: { endpoint: { name: endpoint.name }, claimed, ...(occurredAt ? { claimed_occurred_at: occurredAt } : {}) },
      contact,
      lead,
      consent,
      dedupe_minutes: DEFAULT_DEDUPE_MINUTES,
      on_ambiguous: 'new_contact',
    });
    if (result.outcome !== 'replayed') {
      await deps.intake.update('crm_intake_endpoints', tenantId, endpoint.id, { last_used_at: (deps.now?.() ?? new Date()).toISOString() });
    }
    return { ok: true, result, tenantId };
  } catch (error) {
    /* revoked between the lookup and the write. */
    if (error instanceof CrmStoreError && error.code === 'not_found') return unauthorized;
    if (error instanceof CrmStoreError) return { ok: false, code: 'invalid', message: error.message };
    throw error;
  }
}

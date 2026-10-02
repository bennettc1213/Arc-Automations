import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { Empty, Panel, Pill, Term } from './ui';
import { ActionButton, CopyValue, Field, Notice, SelectInput, TextArea, TextInput } from './ops-ui';
import {
  cancelIntakeImport,
  commitIntakeImport,
  createIntakeEndpoint,
  createIntakeLead,
  getIntake,
  inspectIntakeCsv,
  intakeHookUrl,
  previewIntakeImport,
  revokeIntakeEndpoint,
  saveIntakeForm,
  setIntakeFormStatus,
} from '../lib/ops';
import { formatStamp } from '../lib/format';
import {
  defaultFormDefinition,
  embedSnippet,
  formUrl,
  IMPORT_TARGETS,
  LIMITS,
  parseFormDefinition,
  STANDARD_FIELDS,
} from '../../../supabase/functions/_shared/intake/model.ts';
import './IntakePanel.css';

/**
 * ARC-350 — how leads get into ARC for a client with no lead platform of their own: a form
 * ARC hosts, a lead typed in, a CSV, or their own system posting to an endpoint.
 *
 * The page decides nothing. A form is checked here with the same `parseFormDefinition` the
 * server runs, so a problem shows while it is typed; every button is one `intake-*` action,
 * and what happened — a new lead, a duplicate, a refusal — is the server's answer, printed.
 * An endpoint's token is shown once, in the response that made it, and is in no later read.
 */

const TABS = [
  ['forms', 'forms'],
  ['lead', 'add a lead'],
  ['import', 'import a file'],
  ['api', 'api endpoints'],
  ['arrivals', 'recent arrivals'],
];

const STATUS_TONE = { draft: 'idle', published: 'ok', archived: 'neutral' };
const SOURCE_WORDS = { web_form: 'form', webhook: 'api', import: 'import', manual: 'typed in' };

/* where the hosted form lives: this site. the link is the whole of what is shared. */
const siteUrl = () => `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, '');

const TARGET_WORDS = {
  name: 'full name', first_name: 'first name', last_name: 'last name', phone: 'phone', email: 'email',
  address_line1: 'street address', address_line2: 'address line 2', city: 'city', region: 'state', postal_code: 'ZIP',
  country: 'country (2 letters)', title: 'lead title', summary: 'notes', service: 'service', priority: 'priority',
};

/* ── forms ───────────────────────────────────────────────── */

const CUSTOM_TYPES = [
  { value: 'text', label: 'short answer' },
  { value: 'textarea', label: 'long answer' },
  { value: 'select', label: 'choice' },
  { value: 'checkbox', label: 'tick box' },
  { value: 'number', label: 'number' },
];

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'question';

/** the editor's own shape: every standard field as a row that is on or off, then the extras. */
function toDraft(form) {
  const definition = form?.definition ?? defaultFormDefinition('Request service');
  const byKey = new Map(definition.fields.map((field) => [field.key, field]));
  return {
    name: form?.name ?? 'Website form',
    title: definition.title,
    intro: definition.intro ?? '',
    submitLabel: definition.submit_label,
    success: definition.success_message,
    standard: Object.entries(STANDARD_FIELDS).map(([key, spec]) => ({
      key,
      on: byKey.has(key),
      required: byKey.get(key)?.required ?? false,
      label: byKey.get(key)?.label ?? spec.label,
    })),
    custom: definition.fields
      .filter((field) => !(field.key in STANDARD_FIELDS))
      .map((field) => ({ key: field.key, type: field.type, label: field.label, required: field.required, options: (field.options ?? []).join('\n') })),
    smsMode: definition.consent.sms?.mode ?? 'off',
    smsText: definition.consent.sms?.text ?? defaultFormDefinition('x').consent.sms.text,
    dedupeMinutes: form?.dedupe_minutes ?? 1440,
    hourlyCap: form?.hourly_cap ?? 120,
  };
}

function toDefinition(draft) {
  return {
    title: draft.title,
    intro: draft.intro || null,
    submit_label: draft.submitLabel,
    success_message: draft.success,
    fields: [
      ...draft.standard.filter((f) => f.on).map((f) => ({ key: f.key, label: f.label, required: f.required })),
      ...draft.custom.map((f) => ({
        key: f.key,
        type: f.type,
        label: f.label,
        required: f.required,
        ...(f.type === 'select' ? { options: f.options.split('\n').map((o) => o.trim()).filter(Boolean) } : {}),
      })),
    ],
    consent: draft.smsMode === 'off' ? {} : { sms: { mode: draft.smsMode, text: draft.smsText } },
  };
}

function FormEditor({ tenantId, form, onSaved, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(form));
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const setRow = (list, index, patch) => set({ [list]: draft[list].map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const checked = useMemo(() => parseFormDefinition(toDefinition(draft)), [draft]);

  return (
    <div className="itk-editor">
      <div className="ops-form">
        <Field label="name in the console" required>
          <TextInput value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="heading the customer sees" required>
          <TextInput value={draft.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="line under the heading" wide>
          <TextInput value={draft.intro} maxLength={500} onChange={(e) => set({ intro: e.target.value })} />
        </Field>
      </div>

      <p className="itk-sub">what the form asks</p>
      <ul className="itk-fields">
        {draft.standard.map((field, index) => (
          <li key={field.key} className={field.on ? 'is-on' : ''}>
            <label className="itk-check">
              <input type="checkbox" checked={field.on} onChange={(e) => setRow('standard', index, { on: e.target.checked })} />
              <span className="mono">{field.key}</span>
            </label>
            <TextInput
              aria-label={`${field.key} label`}
              value={field.label}
              maxLength={160}
              disabled={!field.on}
              onChange={(e) => setRow('standard', index, { label: e.target.value })}
            />
            <label className="itk-check">
              <input type="checkbox" checked={field.required} disabled={!field.on} onChange={(e) => setRow('standard', index, { required: e.target.checked })} />
              required
            </label>
          </li>
        ))}
        {draft.custom.map((field, index) => (
          <li key={field.key} className="is-on itk-fields__custom">
            <span className="mono">{field.key}</span>
            <TextInput aria-label="question" value={field.label} maxLength={160} onChange={(e) => setRow('custom', index, { label: e.target.value })} />
            <SelectInput aria-label="answer type" options={CUSTOM_TYPES} value={field.type} onChange={(e) => setRow('custom', index, { type: e.target.value })} />
            <label className="itk-check">
              <input type="checkbox" checked={field.required} onChange={(e) => setRow('custom', index, { required: e.target.checked })} />
              required
            </label>
            <button type="button" className="ws-btn" aria-label={`remove the question ${field.label}`} onClick={() => set({ custom: draft.custom.filter((_, i) => i !== index) })}>
              <Icon name="close" size={13} />
            </button>
            {field.type === 'select' && (
              <TextArea aria-label="choices, one per line" placeholder="choices, one per line" value={field.options} onChange={(e) => setRow('custom', index, { options: e.target.value })} />
            )}
          </li>
        ))}
      </ul>
      <div className="ops-row">
        <button
          type="button"
          className="ws-btn"
          disabled={draft.standard.filter((f) => f.on).length + draft.custom.length >= LIMITS.formFields}
          onClick={() => {
            const base = `q_${slug('question')}`;
            let key = base;
            for (let n = 2; draft.custom.some((f) => f.key === key); n += 1) key = `${base}_${n}`;
            set({ custom: [...draft.custom, { key, type: 'text', label: 'Your question', required: false, options: '' }] });
          }}
        >
          <Icon name="plus" size={13} />
          add a question of their own
        </button>
        <span className="ops-muted">a form is a list of questions. it has no conditions, patterns or scripts, and cannot be given any.</span>
      </div>

      <p className="itk-sub">permission to text</p>
      <div className="ops-form">
        <Field label="tick box under the form" hint="never ticked for them. what they were shown and what they chose is kept with the lead.">
          <SelectInput
            value={draft.smsMode}
            onChange={(e) => set({ smsMode: e.target.value })}
            options={[
              { value: 'off', label: 'do not ask' },
              { value: 'optional', label: 'ask — they may leave it unticked' },
              { value: 'required', label: 'ask — the form cannot be sent without it' },
            ]}
          />
        </Field>
        {draft.smsMode !== 'off' && (
          <Field label="the words next to the box" wide required>
            <TextArea value={draft.smsText} maxLength={500} onChange={(e) => set({ smsText: e.target.value })} />
          </Field>
        )}
      </div>

      <p className="itk-sub">after they send it</p>
      <div className="ops-form">
        <Field label="button">
          <TextInput value={draft.submitLabel} maxLength={40} onChange={(e) => set({ submitLabel: e.target.value })} />
        </Field>
        <Field label="message once sent" wide>
          <TextInput value={draft.success} maxLength={300} onChange={(e) => set({ success: e.target.value })} />
        </Field>
        <Field label="same person again within (minutes)" hint="a second request from somebody with an open lead this recent is added to that lead. 0 always makes a new one.">
          <TextInput type="number" min={0} max={LIMITS.dedupeMinutesMax} value={draft.dedupeMinutes} onChange={(e) => set({ dedupeMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="most requests in an hour" hint="past this the form asks people to try later. it is the ceiling a flood hits.">
          <TextInput type="number" min={1} max={LIMITS.hourlyCapMax} value={draft.hourlyCap} onChange={(e) => set({ hourlyCap: Number(e.target.value) })} />
        </Field>
      </div>

      {!checked.ok && (
        <Notice tone="warn" title="this form cannot be saved yet">
          <ul className="itk-problems">
            {checked.errors.map((error) => (
              <li key={`${error.field}-${error.message}`}>
                <span className="mono">{error.field}</span> {error.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="ops-row">
        <ActionButton
          variant="primary"
          icon="check"
          disabled={!checked.ok || !draft.name.trim()}
          onRun={async () => {
            const saved = await saveIntakeForm(
              tenantId,
              { name: draft.name, definition: toDefinition(draft), dedupe_minutes: draft.dedupeMinutes, hourly_cap: draft.hourlyCap },
              form?.id,
            );
            await onSaved(saved);
            return form ? `saved — version ${saved.version}` : 'saved as a draft';
          }}
        >
          {form ? 'save changes' : 'save as a draft'}
        </ActionButton>
        <button type="button" className="ws-btn" onClick={onClose}>
          close
        </button>
        {form?.status === 'published' && <span className="ops-muted">this form is published: a saved change is live at once, on the same link.</span>}
      </div>
    </div>
  );
}

function FormRow({ tenantId, form, timezone, readOnly, onChanged, onEdit }) {
  const link = formUrl(siteUrl(), form.public_key);
  const setStatus = (status, message) => async () => {
    await setIntakeFormStatus(tenantId, form.id, status);
    await onChanged();
    return message;
  };
  return (
    <li className="itk-row">
      <div className="itk-row__head">
        <span className="itk-row__name">{form.name}</span>
        <Pill tone={STATUS_TONE[form.status] ?? 'neutral'}>
          <Term k={form.status}>{form.status}</Term>
        </Pill>
        <span className="ops-muted">
          version {form.version} · {form.definition.fields.length} questions · changed {formatStamp(form.updated_at, timezone)}
        </span>
      </div>
      {form.status !== 'archived' && (
        <div className="itk-row__links">
          <CopyValue label="link" value={link} />
          <CopyValue label="embed" value={embedSnippet(siteUrl(), form.public_key, form.definition.title)} display="a frame around the hosted form — no script" />
          {form.status === 'published' && (
            <a className="ws-btn" href={link} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} />
              open
            </a>
          )}
        </div>
      )}
      {!readOnly && (
        <div className="ops-row">
          {form.status !== 'archived' && (
            <button type="button" className="ws-btn" onClick={() => onEdit(form)}>
              <Icon name="edit" size={13} />
              edit
            </button>
          )}
          {form.status === 'draft' && (
            <ActionButton
              icon="check"
              variant="primary"
              confirm={`publish ${form.name}? anyone with the link can send a request, and each one becomes a lead for this client.`}
              onRun={setStatus('published', 'published')}
            >
              publish
            </ActionButton>
          )}
          {form.status === 'published' && (
            <ActionButton icon="close" confirm={`unpublish ${form.name}? the link stops taking requests until it is published again.`} onRun={setStatus('draft', 'back to a draft')}>
              unpublish
            </ActionButton>
          )}
          {form.status !== 'archived' && (
            <ActionButton icon="archive" confirm={`archive ${form.name}? the link stops taking requests. everything it collected is kept.`} onRun={setStatus('archived', 'archived')}>
              archive
            </ActionButton>
          )}
          {form.status === 'archived' && (
            <ActionButton icon="refresh" onRun={setStatus('draft', 'restored as a draft')}>
              restore as a draft
            </ActionButton>
          )}
        </div>
      )}
    </li>
  );
}

function Forms({ tenantId, data, timezone, readOnly, reload }) {
  const [editing, setEditing] = useState(null); // null | 'new' | form
  return (
    <>
      {data.forms.length === 0 && editing === null && (
        <Empty title="no forms yet">a form gives this client a link, and a frame for their own site, that turns a request into a lead here.</Empty>
      )}
      <ul className="itk-rows">
        {data.forms.map((form) => (
          <FormRow key={form.id} tenantId={tenantId} form={form} timezone={timezone} readOnly={readOnly} onChanged={reload} onEdit={setEditing} />
        ))}
      </ul>
      {!readOnly && editing === null && (
        <div className="ops-row">
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={13} />
            new form
          </button>
        </div>
      )}
      {editing !== null && (
        <FormEditor
          key={editing === 'new' ? 'new' : editing.id}
          tenantId={tenantId}
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reload();
            /* a new form joins the list above as a draft, where its link and its publish
               button are. an existing one stays open, so the saved note is seen. */
            if (editing === 'new') setEditing(null);
          }}
        />
      )}
    </>
  );
}

/* ── a lead typed in ─────────────────────────────────────── */

const EMPTY_LEAD = { name: '', phone: '', email: '', title: '', summary: '', service: '', priority: 'normal' };

function ManualLead({ tenantId, data, reload }) {
  const [lead, setLead] = useState(EMPTY_LEAD);
  const [result, setResult] = useState(null);
  const set = (patch) => setLead((current) => ({ ...current, ...patch }));
  const send = (allowDuplicate) => async () => {
    setResult(null);
    const contact = Object.fromEntries(
      [['display_name', lead.name], ['phone', lead.phone], ['email', lead.email]].filter(([, value]) => value.trim() !== ''),
    );
    try {
      const arrival = await createIntakeLead(tenantId, {
        contact,
        lead: { title: lead.title, summary: lead.summary, service: lead.service, priority: lead.priority },
        allow_duplicate: allowDuplicate,
      });
      setResult({ arrival });
      if (arrival.outcome === 'created') setLead(EMPTY_LEAD);
      await reload();
      return arrival.outcome === 'created' ? 'lead created' : 'this person already has an open lead';
    } catch (error) {
      if (error.payload?.candidates) setResult({ candidates: error.payload.candidates });
      throw error;
    }
  };
  return (
    <>
      <div className="ops-form">
        <Field label="name">
          <TextInput value={lead.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="phone" hint="a name, a phone or an email — at least one.">
          <TextInput value={lead.phone} inputMode="tel" onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="email">
          <TextInput value={lead.email} inputMode="email" onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="what it is about" required>
          <TextInput value={lead.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        {data.services.length > 0 && (
          <Field label="service">
            <SelectInput
              value={lead.service}
              onChange={(e) => set({ service: e.target.value })}
              options={[{ value: '', label: '—' }, ...data.services.map((s) => ({ value: s.key, label: s.name }))]}
            />
          </Field>
        )}
        <Field label="priority">
          <SelectInput value={lead.priority} onChange={(e) => set({ priority: e.target.value })} options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: p }))} />
        </Field>
        <Field label="notes" wide>
          <TextArea value={lead.summary} maxLength={2000} onChange={(e) => set({ summary: e.target.value })} />
        </Field>
        <div className="ops-form__row">
          <ActionButton variant="primary" icon="plus" disabled={!lead.title.trim() && !lead.service} onRun={send(false)}>
            add the lead
          </ActionButton>
        </div>
      </div>

      {result?.arrival?.outcome === 'duplicate' && (
        <Notice tone="warn" title="this person already has an open lead from the last day">
          <p>
            what you entered was recorded against that lead (<span className="mono">{result.arrival.lead_id.slice(0, 8)}</span>) and no second
            lead was made. if this really is a separate job:
          </p>
          <ActionButton icon="plus" onRun={send(true)}>
            make a separate lead anyway
          </ActionButton>
        </Notice>
      )}
      {result?.candidates && (
        <Notice tone="warn" title="more than one customer on file shares this phone or email">
          <p>nothing was created. merge them if they are one person, or leave the shared detail out and add the lead to the right one:</p>
          <ul className="itk-problems">
            {result.candidates.map((candidate) => (
              <li key={candidate.id}>
                {candidate.display_name} <span className="mono">{candidate.id.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

/* ── a CSV ───────────────────────────────────────────────── */

const ROW_TONE = { ready: 'ok', imported: 'ok', invalid: 'fail', failed: 'fail', duplicate_in_file: 'warn', skipped: 'idle' };

function ImportSummary({ view }) {
  const status = view.summary.by_status;
  const match = view.summary.by_match;
  return (
    <>
      <p className="itk-counts">
        {Object.entries(status).map(([key, count]) => (
          <span key={key}>
            <b>{count}</b> <Term k={key}>{key}</Term>
          </span>
        ))}
      </p>
      {Object.keys(match).length > 0 && (
        <p className="ops-muted">
          of the ready rows: {match.new_contact ?? 0} new customers · {match.existing_contact ?? 0} already on file (
          <Term k="existing_contact">existing_contact</Term>) · {match.ambiguous_contact ?? 0} shared by several (
          <Term k="ambiguous_contact">ambiguous_contact</Term>)
        </p>
      )}
      {view.attention.length > 0 && (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense">
            <thead>
              <tr>
                <th>row</th>
                <th>state</th>
                <th>why</th>
              </tr>
            </thead>
            <tbody>
              {view.attention.map((row) => (
                <tr key={row.row_number}>
                  <td className="mono">{row.row_number}</td>
                  <td>
                    <Pill tone={ROW_TONE[row.status] ?? 'neutral'}>
                      <Term k={row.status}>{row.status}</Term>
                    </Pill>
                  </td>
                  <td>
                    {row.problems.length > 0
                      ? row.problems.map((p) => `${p.field === 'row' ? 'this row' : p.field} ${p.message}`).join(' · ')
                      : row.outcome === 'duplicate'
                        ? 'this person already had an open lead'
                        : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CsvImport({ tenantId, data, timezone, reload }) {
  const [file, setFile] = useState(null); // { name, csv, inspection }
  const [mapping, setMapping] = useState({});
  const [dedupe, setDedupe] = useState(1440);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const input = useRef(null);

  async function choose(event) {
    const chosen = event.target.files?.[0];
    setError(null);
    setView(null);
    setFile(null);
    if (!chosen) return;
    try {
      const csv = await chosen.text();
      const inspection = await inspectIntakeCsv(tenantId, csv);
      setFile({ name: chosen.name, csv, inspection });
      setMapping(inspection.suggested);
    } catch (problem) {
      setError(problem.message);
    }
  }

  const reset = () => {
    setFile(null);
    setView(null);
    if (input.current) input.current.value = '';
  };
  const targets = [{ value: '', label: 'leave out' }, ...IMPORT_TARGETS.map((t) => ({ value: t, label: TARGET_WORDS[t] ?? t }))];

  return (
    <>
      <div className="ops-form">
        <Field label="a .csv file" hint={`up to ${LIMITS.importRows.toLocaleString('en-US')} rows. the first line is the column headings. nothing is written until you import.`} wide>
          <input ref={input} className="ops-input" type="file" accept=".csv,text/csv" onChange={choose} />
        </Field>
      </div>
      {error && (
        <Notice tone="fail" title="this file cannot be imported">
          <p>{error}</p>
        </Notice>
      )}

      {file && !view && (
        <>
          <p className="itk-sub">
            {file.inspection.row_count} rows — what is each column?
          </p>
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th>column</th>
                  <th>is</th>
                  <th>first rows</th>
                </tr>
              </thead>
              <tbody>
                {file.inspection.headers.map((header, index) => (
                  <tr key={header}>
                    <td>{header}</td>
                    <td>
                      <SelectInput
                        aria-label={`what the column ${header} is`}
                        options={targets}
                        value={mapping[header] ?? ''}
                        onChange={(e) => setMapping((current) => ({ ...current, [header]: e.target.value || null }))}
                      />
                    </td>
                    <td className="itk-sample">{file.inspection.sample.map((row) => row[index]).filter(Boolean).slice(0, 3).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-form">
            <Field label="same person again within (minutes)" hint="a row for somebody with an open lead this recent is recorded against that lead. 0 always makes a new one.">
              <TextInput type="number" min={0} max={LIMITS.dedupeMinutesMax} value={dedupe} onChange={(e) => setDedupe(Number(e.target.value))} />
            </Field>
            <div className="ops-form__row">
              <ActionButton
                variant="primary"
                icon="search"
                onRun={async () => {
                  const mapped = Object.fromEntries(Object.entries(mapping).filter(([, target]) => target));
                  setView(await previewIntakeImport(tenantId, { fileName: file.name, csv: file.csv, mapping: mapped, dedupeMinutes: dedupe }));
                  await reload();
                  return 'checked — nothing imported yet';
                }}
              >
                check the file
              </ActionButton>
            </div>
          </div>
        </>
      )}

      {view && (
        <>
          <p className="itk-sub">
            {view.import.file_name} — {view.import.status === 'previewed' ? 'checked, nothing imported yet' : view.import.status}
          </p>
          <ImportSummary view={view} />
          {view.sample.length > 0 && (
            <p className="ops-muted">
              first to be imported: {view.sample.slice(0, 3).map((row) => `${row.payload.contact?.display_name ?? '—'} (${row.payload.lead?.title ?? ''})`).join(' · ')}
            </p>
          )}
          <div className="ops-row">
            {view.import.status !== 'completed' && view.import.status !== 'cancelled' && (
              <>
                <ActionButton
                  variant="primary"
                  icon="download"
                  disabled={(view.summary.by_status.ready ?? 0) === 0}
                  confirm={`import ${view.summary.by_status.ready ?? 0} rows? each becomes a lead. a customer already on file gets the lead and is not changed.`}
                  onRun={async () => {
                    /* a batch at a time; an import that is interrupted carries on from where it stopped. */
                    let progress = await commitIntakeImport(tenantId, view.import.id);
                    setView(progress);
                    while (progress.remaining > 0) {
                      progress = await commitIntakeImport(tenantId, view.import.id);
                      setView(progress);
                    }
                    await reload();
                    return `done — ${progress.summary.by_status.imported ?? 0} leads imported`;
                  }}
                >
                  import the ready rows
                </ActionButton>
                <ActionButton
                  icon="close"
                  onRun={async () => {
                    await cancelIntakeImport(tenantId, view.import.id);
                    reset();
                    await reload();
                    return 'cancelled';
                  }}
                >
                  cancel
                </ActionButton>
              </>
            )}
            {(view.import.status === 'completed' || view.import.status === 'cancelled') && (
              <button type="button" className="ws-btn" onClick={reset}>
                import another file
              </button>
            )}
          </div>
        </>
      )}

      {data.imports.length > 0 && (
        <>
          <p className="itk-sub">earlier imports</p>
          <ul className="itk-list">
            {data.imports.map((entry) => (
              <li key={entry.id}>
                <span className="mono">{formatStamp(entry.created_at, timezone)}</span> {entry.file_name} · {entry.total_rows} rows · {entry.status}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/* ── API endpoints ───────────────────────────────────────── */

function Endpoints({ tenantId, data, timezone, readOnly, reload }) {
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  const hook = intakeHookUrl();
  return (
    <>
      <p className="ops-muted">
        for a website builder, an ad platform or a spreadsheet tool that can send a request when a lead comes in. it posts a lead here with a token;
        every post needs its own <span className="mono">event_id</span>, so a repeat is the same lead and not a second one.
      </p>
      {data.endpoints.length === 0 && <Empty title="no endpoints">nothing posts leads for this client yet.</Empty>}
      <ul className="itk-rows">
        {data.endpoints.map((endpoint) => (
          <li key={endpoint.id} className="itk-row">
            <div className="itk-row__head">
              <span className="itk-row__name">{endpoint.name}</span>
              <Pill tone={endpoint.revoked_at ? 'neutral' : 'ok'}>{endpoint.revoked_at ? 'revoked' : 'accepting'}</Pill>
              <span className="ops-muted">
                token ends <span className="mono">{endpoint.token_hint}</span> · {endpoint.last_used_at ? `last used ${formatStamp(endpoint.last_used_at, timezone)}` : 'never used'}
              </span>
              {!readOnly && !endpoint.revoked_at && (
                <ActionButton
                  icon="close"
                  confirm={`revoke ${endpoint.name}? anything posting with its token stops being accepted immediately, and it cannot be switched back on.`}
                  onRun={async () => {
                    await revokeIntakeEndpoint(tenantId, endpoint.id);
                    await reload();
                    return 'revoked';
                  }}
                >
                  revoke
                </ActionButton>
              )}
            </div>
          </li>
        ))}
      </ul>

      {fresh && (
        <Notice tone="warn" title="copy this token now — it is not shown again">
          <p>
            <CopyValue label="token" value={fresh.token} />
          </p>
          <p>
            <CopyValue label="post to" value={hook} />
          </p>
          <p className="ops-muted">
            header <span className="mono">Authorization: Bearer &lt;token&gt;</span>, body{' '}
            <span className="mono">{'{ "event_id": "…", "contact": { "name", "phone", "email" }, "lead": { "summary" } }'}</span>. only its fingerprint is kept
            here, so a lost token is replaced, not recovered.
          </p>
          <button type="button" className="ws-btn" onClick={() => setFresh(null)}>
            i have copied it
          </button>
        </Notice>
      )}

      {!readOnly && (
        <div className="ops-form">
          <Field label="what will be posting" hint="named after the system, so it can be told apart and revoked on its own.">
            <TextInput value={name} maxLength={120} placeholder="website builder" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="ops-form__row">
            <ActionButton
              icon="plus"
              disabled={!name.trim()}
              onRun={async () => {
                setFresh(await createIntakeEndpoint(tenantId, name));
                setName('');
                await reload();
                return 'made';
              }}
            >
              make an endpoint
            </ActionButton>
          </div>
        </div>
      )}
    </>
  );
}

/* ── recent arrivals ─────────────────────────────────────── */

function door(event, data) {
  if (event.form_id) return data.forms.find((f) => f.id === event.form_id)?.name ?? 'a form';
  if (event.endpoint_id) return data.endpoints.find((e) => e.id === event.endpoint_id)?.name ?? 'an endpoint';
  if (event.import_id) return `${event.detail?.import?.file_name ?? 'a file'}, row ${event.detail?.import?.row ?? '?'}`;
  return event.source === 'manual' ? 'somebody at the desk' : '—';
}

function claimed(event) {
  const said = event.detail?.claimed ?? {};
  const parts = [
    said.utm_source && `source ${said.utm_source}`,
    said.utm_campaign && `campaign ${said.utm_campaign}`,
    said.referrer && `from ${said.referrer}`,
    said.click_ids?.length && `ad click (${said.click_ids.join(', ')})`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function Arrivals({ data, timezone }) {
  if (data.recent.length === 0) return <Empty title="nothing has arrived yet">a request through any form, file, endpoint or the desk shows here.</Empty>;
  return (
    <>
      <p className="ops-muted">
        every request that came in, including the ones added to a lead that was already open. &ldquo;they said&rdquo; is what the visitor&rsquo;s browser
        reported about where they came from — it is recorded, not checked.
      </p>
      <div className="ws-tablewrap">
        <table className="ws-table ws-table--dense">
          <thead>
            <tr>
              <th>when</th>
              <th>how</th>
              <th>through</th>
              <th>lead</th>
              <th>they said</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((event) => (
              <tr key={event.id}>
                <td className="mono">{formatStamp(event.received_at, timezone)}</td>
                <td>{SOURCE_WORDS[event.source] ?? event.source}</td>
                <td>{door(event, data)}</td>
                <td className="mono">{event.lead_id ? event.lead_id.slice(0, 8) : '—'}</td>
                <td className="itk-sample">{claimed(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── the panel ───────────────────────────────────────────── */

/**
 * `initial` and `load` exist so the panel can be drawn from a known answer; the console
 * passes neither and the panel reads the server.
 */
export default function IntakePanel({ tenantId, timezone = 'UTC', readOnly = false, initial = null, load = getIntake }) {
  const [state, setState] = useState(initial ? { kind: 'ready', data: initial } : { kind: 'loading' });
  const [tab, setTab] = useState('forms');

  const reload = useCallback(async () => {
    try {
      setState({ kind: 'ready', data: await load(tenantId) });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [load, tenantId]);

  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const note =
    state.kind === 'ready'
      ? `${state.data.forms.filter((f) => f.status === 'published').length} forms published · ${state.data.recent.length} recent arrivals`
      : 'forms, files, the desk and their own systems';

  return (
    <Panel title="lead capture" note={note}>
      {state.kind === 'loading' && <p className="ops-muted">reading lead capture…</p>}

      {state.kind === 'error' &&
        (state.error?.payload?.error === 'unknown action' || /0024_native_intake/.test(state.error?.message ?? '') ? (
          <Notice tone="warn" title="lead capture is not deployed here yet">
            <p>
              apply <code>0024_native_intake.sql</code>, then redeploy the <code>ops</code> function and deploy <code>native-intake</code> — this page
              reads and writes through them.
            </p>
          </Notice>
        ) : (
          <Notice tone="fail" title="lead capture could not be read">
            <p>{state.error?.message ?? 'unknown error'}</p>
          </Notice>
        ))}

      {state.kind === 'ready' && (
        <>
          <nav className="cfg-tabs" aria-label="ways a lead comes in">
            {TABS.filter(([key]) => !readOnly || key === 'forms' || key === 'api' || key === 'arrivals').map(([key, label]) => (
              <button key={key} type="button" className={`ws-btn${key === tab ? ' ws-btn--primary' : ''}`} aria-pressed={key === tab} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'forms' && <Forms tenantId={tenantId} data={state.data} timezone={timezone} readOnly={readOnly} reload={reload} />}
          {tab === 'lead' && <ManualLead tenantId={tenantId} data={state.data} reload={reload} />}
          {tab === 'import' && <CsvImport tenantId={tenantId} data={state.data} timezone={timezone} reload={reload} />}
          {tab === 'api' && <Endpoints tenantId={tenantId} data={state.data} timezone={timezone} readOnly={readOnly} reload={reload} />}
          {tab === 'arrivals' && <Arrivals data={state.data} timezone={timezone} />}
          <p className="ws-note">
            capturing a lead sends nothing and starts nothing: it is recorded, with how it arrived, and waits for a person. a customer already on
            file is never changed by a request coming in.
          </p>
        </>
      )}
    </Panel>
  );
}

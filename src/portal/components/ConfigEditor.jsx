import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Field, Notice, SelectInput, TextArea, TextInput } from './ops-ui';
import ConfigHistory from './ConfigHistory';
import { PublishReview } from './ConfigReview';
import { settingsApi } from '../lib/ops';
import { formatStamp } from '../lib/format';
import {
  blankRecord,
  changedFields,
  consequenceLabels,
  documentFrom,
  errorsByField,
  fieldKind,
  inputsFor,
  patchFor,
} from '../lib/config-form';
import './ConfigEditor.css';

/**
 * ARC-310 — one configuration scope, drawn from the registry and edited as a draft.
 *
 * Everything this shows comes from `config-scope`: the fields and what the operator may change
 * (registry metadata, `registry/layouts.ts` for the inside of a group), the published version,
 * the open draft. Nothing here decides whether a value is allowed — a save goes to the server,
 * which validates with the module's own validator and answers by path, and those answers are
 * shown under the field they name.
 *
 * The order of events is ARC-110's: open a draft from the current version → save changes
 * (each save carries the revision it was made from) → review, which is the server's preview:
 * what changed, what each change requires, and what the module's lifecycle will do with it →
 * publish, carrying the draft's revision and the version it expects to replace. Anything that
 * moved in between is a 409 shown as "changed elsewhere", never a silent overwrite.
 */

const CONFLICT_CODES = new Set(['draft_conflict', 'stale_draft', 'publication_conflict', 'draft_closed', 'draft_exists']);

const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['America/Denver', 'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'UTC'];
  }
})();

function FieldErrors({ errors, part = undefined }) {
  const list = (errors ?? []).filter((e) => part === undefined || e.part === part);
  if (list.length === 0) return null;
  return (
    <ul className="cfg-errors">
      {list.map((e, i) => (
        <li key={`${e.path ?? ''}-${i}`}>{e.message}</li>
      ))}
    </ul>
  );
}

function PartInput({ part, value, disabled, onChange }) {
  const id = `cfg-${part.key}`;
  switch (part.control) {
    case 'toggle':
      return (
        <label className="ops-check">
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span>{part.label}</span>
        </label>
      );
    case 'textarea':
      return <TextArea id={id} value={value} disabled={disabled} rows={3} onChange={(e) => onChange(e.target.value)} />;
    case 'lines':
      return <TextArea id={id} value={value} disabled={disabled} rows={3} placeholder="one per line" onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      return (
        <SelectInput
          value={value}
          disabled={disabled}
          options={(part.options ?? []).map((o) => ({ value: o, label: o }))}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'ranges':
      return <TextInput mono value={value} disabled={disabled} placeholder="closed — or 08:00-17:00" onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <TextInput mono inputMode="decimal" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <TextInput value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

function FieldEditor({ field, input, editing, errors, onChange }) {
  const disabled = !editing || !field.editable;
  const kind = fieldKind(field);
  const badges = [
    ...consequenceLabels(field),
    ...(field.sensitive_display ? ['hidden in history'] : []),
    ...(!field.editable ? ['read-only'] : []),
  ];

  let body;
  if (kind === 'parts') {
    body = (
      <div className="cfg-parts">
        {field.layout.parts.map((part) => (
          <div key={part.key} className={`cfg-part${part.control === 'textarea' ? ' cfg-part--wide' : ''}`}>
            {part.control !== 'toggle' && <span className="cfg-part__label">{part.label}</span>}
            <PartInput part={part} value={input?.[part.key]} disabled={disabled} onChange={(v) => onChange({ ...input, [part.key]: v })} />
            <FieldErrors errors={errors} part={part.key} />
          </div>
        ))}
      </div>
    );
  } else if (kind === 'records') {
    const columns = field.layout.items.columns;
    const rows = input ?? [];
    body = (
      <div className="cfg-records">
        {rows.length === 0 && <p className="ops-muted">none yet.</p>}
        {rows.map((row, index) => (
          <div className="cfg-record" key={index}>
            {columns.map((column) => (
              <PartInput
                key={column.key}
                part={{ key: column.key, label: column.label, control: column.options ? 'select' : 'text', options: column.options }}
                value={row[column.key] ?? ''}
                disabled={disabled}
                onChange={(v) => onChange(rows.map((r, i) => (i === index ? { ...r, [column.key]: v } : r)))}
              />
            ))}
            {!disabled && (
              <button type="button" className="ws-btn" aria-label={`remove ${field.label} row ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
        ))}
        {!disabled && (
          <button type="button" className="ws-btn" onClick={() => onChange([...rows, blankRecord(field)])}>
            <Icon name="plus" size={13} />
            add
          </button>
        )}
        <span className="cfg-record__head">{columns.map((c) => c.label).join(' · ')}</span>
      </div>
    );
  } else if (kind === 'toggle') {
    body = (
      <label className="ops-check">
        <input type="checkbox" checked={input === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  } else if (kind === 'select' && field.type === 'timezone') {
    body = (
      <SelectInput
        value={input}
        disabled={disabled}
        options={(TIMEZONES.includes(input) || !input ? TIMEZONES : [input, ...TIMEZONES]).map((z) => ({ value: z, label: z }))}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (kind === 'lines' || kind === 'textarea' || kind === 'json') {
    body = (
      <TextArea
        className={kind === 'json' ? 'cfg-json' : ''}
        value={input}
        disabled={disabled}
        rows={kind === 'json' ? 6 : 3}
        placeholder={kind === 'lines' ? 'one per line' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    body = <TextInput mono={kind === 'number'} value={input} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <section className={`cfg-field${errors?.length ? ' cfg-field--error' : ''}`} aria-label={field.label}>
      <header className="cfg-field__head">
        <h3 className="cfg-field__label">
          {field.label}
          {field.required && <i title="required">*</i>}
        </h3>
        {badges.map((b) => (
          <Pill key={b} tone={b === 'pauses a live module' ? 'warn' : 'neutral'}>
            {b}
          </Pill>
        ))}
      </header>
      <p className="cfg-field__help">{field.help}</p>
      {body}
      <FieldErrors errors={(errors ?? []).filter((e) => kind !== 'parts' || !e.part)} />
    </section>
  );
}

export default function ConfigEditor({ tenantId, scope, moduleKey = null, readOnly = false, timezone = 'UTC', initial = null, api = settingsApi }) {
  const [state, setState] = useState(initial ? { kind: 'ready', data: initial } : { kind: 'loading' });
  const [inputs, setInputs] = useState(() => (initial ? inputsFor(initial.schema.fields, (initial.open_draft ?? initial.current)?.config ?? {}) : {}));
  const [serverErrors, setServerErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [conflict, setConflict] = useState(null);
  const [review, setReview] = useState(null);
  const [note, setNote] = useState('');
  const [historyKey, setHistoryKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      const data = await api.load(tenantId, scope, moduleKey);
      setState({ kind: 'ready', data });
      setInputs(inputsFor(data.schema.fields, (data.open_draft ?? data.current)?.config ?? {}));
      setServerErrors([]);
      setConflict(null);
      setReview(null);
      setHistoryKey((k) => k + 1);
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api, tenantId, scope, moduleKey]);

  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const data = state.kind === 'ready' ? state.data : null;
  const draft = data?.open_draft ?? null;
  const current = data?.current ?? null;
  const editing = Boolean(draft) && !readOnly;
  const fields = data?.schema.fields ?? [];
  const base = (draft ?? current)?.config ?? {};

  const built = useMemo(() => documentFrom(fields, inputs, base), [fields, inputs, base]);
  const dirty = editing && changedFields(base, built.doc).length > 0;
  const errors = useMemo(() => {
    const byField = errorsByField(serverErrors);
    for (const [key, list] of Object.entries(built.errors)) byField[key] = [...(byField[key] ?? []), ...list];
    return byField;
  }, [serverErrors, built.errors]);

  /* a refusal: a stale screen is a conflict to reload, field errors go by their fields. */
  function refusal(error) {
    if (error?.status === 409 && CONFLICT_CODES.has(error.payload?.code)) {
      setConflict(error.message);
      return null;
    }
    if (error?.payload?.field_errors) setServerErrors(error.payload.field_errors);
    throw error;
  }

  async function save() {
    if (Object.keys(built.errors).length > 0) throw new Error('fix the highlighted fields first');
    const patch = patchFor(base, built.doc);
    if (Object.keys(patch).length === 0) return 'nothing to save';
    try {
      const saved = await api.updateDraft(tenantId, scope, moduleKey, draft.id, draft.revision, patch);
      setState({ kind: 'ready', data: { ...data, open_draft: saved.draft } });
      setInputs(inputsFor(fields, saved.draft.config));
      setWarnings(saved.warnings ?? []);
      const check = await api.validate(tenantId, scope, moduleKey, saved.draft.id);
      setServerErrors(check.field_errors ?? []);
      return check.valid ? `saved — revision ${saved.draft.revision}, valid` : `saved — revision ${saved.draft.revision}, not valid yet`;
    } catch (error) {
      return refusal(error);
    }
  }

  if (state.kind === 'loading') return <p className="ops-muted">reading the settings…</p>;
  if (state.kind === 'error') {
    return state.error?.payload?.error === 'unknown action' ? (
      <Notice tone="warn" title="the ops function predates the settings screen">
        <p>redeploy the <code>ops</code> function — this page reads the settings through it.</p>
      </Notice>
    ) : (
      <Notice tone="fail" title="the settings could not be read">
        <p>{state.error?.message ?? 'unknown error'}</p>
      </Notice>
    );
  }

  const status = draft
    ? `draft · revision ${draft.revision} · from ${draft.base_version ? `v${draft.base_version}` : 'the defaults'}`
    : current
      ? `published v${current.version}`
      : 'nothing published yet';

  return (
    <>
      <Panel
        title={data.schema.display_name}
        note={status}
        actions={
          !readOnly && (
            <span className="ops-row">
              {!draft && (
                <ActionButton
                  variant="primary"
                  icon="edit"
                  onRun={async () => {
                    try {
                      await api.createDraft(tenantId, scope, moduleKey);
                    } catch (error) {
                      refusal(error);
                    }
                    await reload();
                    return null;
                  }}
                >
                  {current ? 'edit — start a draft' : 'start from the defaults'}
                </ActionButton>
              )}
              {draft && (
                <>
                  <ActionButton icon="check" disabled={!dirty} onRun={save}>
                    save draft
                  </ActionButton>
                  <ActionButton
                    variant="primary"
                    icon="chevron"
                    disabled={dirty}
                    title={dirty ? 'save the draft first' : undefined}
                    onRun={async () => {
                      try {
                        setReview(await api.preview(tenantId, scope, moduleKey, draft.id));
                      } catch (error) {
                        refusal(error);
                      }
                      return null;
                    }}
                  >
                    review & publish
                  </ActionButton>
                  <ActionButton
                    icon="close"
                    confirm="discard this draft? its changes are not kept."
                    onRun={async () => {
                      try {
                        await api.discard(tenantId, scope, moduleKey, draft.id, draft.revision);
                      } catch (error) {
                        refusal(error);
                      }
                      await reload();
                      return null;
                    }}
                  >
                    discard draft
                  </ActionButton>
                </>
              )}
            </span>
          )
        }
      >
        <div className="cfg-status">
          {draft ? <Pill tone="idle">draft — not live</Pill> : current ? <Pill tone="ok">published</Pill> : <Pill tone="neutral">empty</Pill>}
          {current && (
            <span className="ops-muted">
              live: v{current.version}
              {current.published_at ? ` · ${formatStamp(current.published_at, timezone)}` : ''}
            </span>
          )}
          {readOnly && <Pill tone="neutral">read-only</Pill>}
        </div>

        {conflict && (
          <Notice tone="warn" title="these settings changed elsewhere">
            <p>{conflict}. nothing was overwritten. reload to see the latest, then make your change again.</p>
            <button type="button" className="ws-btn" onClick={reload}>
              <Icon name="refresh" size={13} />
              reload
            </button>
          </Notice>
        )}

        {errors._document?.length > 0 && (
          <Notice tone="fail" title="the draft as a whole">
            <ul>
              {errors._document.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </Notice>
        )}
        {warnings.length > 0 && (
          <Notice tone="warn" title="worth a look">
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        )}

        {!draft && !current ? (
          <Empty title="no settings yet">
            {readOnly ? 'nothing was ever published here.' : 'start a draft from the defaults, fill it in, and publish it.'}
          </Empty>
        ) : (
          <div className="cfg-fields">
            {fields.map((field) => (
              <FieldEditor
                key={field.key}
                field={field}
                input={inputs[field.key]}
                editing={editing}
                errors={errors[field.key]}
                onChange={(value) => {
                  setInputs((prev) => ({ ...prev, [field.key]: value }));
                  setServerErrors((prev) => prev.filter((e) => !(e.path ?? '').startsWith(field.key)));
                }}
              />
            ))}
          </div>
        )}

        {data.schema.from_tenant.length > 0 && (
          <p className="ws-note">
            {data.schema.from_tenant.map((f) => f.label).join(' and ')}{' '}
            {data.schema.from_tenant.length === 1 ? 'comes' : 'come'} from the client settings tab and
            {' '}{data.schema.from_tenant.length === 1 ? 'is' : 'are'} edited there.
          </p>
        )}
      </Panel>

      {review && (
        <Panel title="review before publishing" note="what the server says this change will do">
          <PublishReview preview={review} />
          <Field label="note" hint="kept with the version in the history" wide>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional — why this changed" />
          </Field>
          <div className="ops-row" style={{ marginTop: 14 }}>
            <ActionButton
              variant="primary"
              icon="check"
              disabled={!review.valid || review.impact.changes.length === 0}
              confirm="publish this version? it becomes what new work runs on."
              onRun={async () => {
                try {
                  const published = await api.publish(tenantId, scope, moduleKey, draft.id, draft.revision, current?.version ?? 0, note || null);
                  setNote('');
                  await reload();
                  return `published v${published.version}`;
                } catch (error) {
                  return refusal(error);
                }
              }}
            >
              publish
            </ActionButton>
            <button type="button" className="ws-btn" onClick={() => setReview(null)}>
              keep editing
            </button>
          </div>
        </Panel>
      )}

      <ConfigHistory
        key={historyKey}
        tenantId={tenantId}
        scope={scope}
        moduleKey={moduleKey}
        current={current}
        readOnly={readOnly || Boolean(draft)}
        timezone={timezone}
        api={api}
        onChanged={reload}
      />
    </>
  );
}

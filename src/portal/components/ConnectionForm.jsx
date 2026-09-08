import { useState } from 'react';
import { ActionButton, Field, SelectInput, TextArea, TextInput } from './ops-ui';
import { CONNECTION_KINDS, saveConnection } from '../lib/ops';

/**
 * declaring what a client is wired to.
 *
 * the one field that matters more than it looks is the workflow id. without it a
 * connection can be listed but never checked — the console has no way to match it
 * to anything in the event log, and it shows as "no workflow id" rather than
 * borrowing the tenant's overall activity and calling that proof it is alive.
 *
 * there is no credential field and there never will be. tokens and API keys live
 * in n8n and in supabase function secrets; a table the browser can read is the
 * wrong place to keep one, and a form that invited you to paste one in would be
 * the wrong place to ask.
 */

const STATUS_OPTIONS = [
  { value: 'planned', label: 'planned' },
  { value: 'connected', label: 'connected' },
  { value: 'paused', label: 'paused' },
  { value: 'retired', label: 'retired' },
];

const PLACEHOLDER = {
  n8n: 'https://n8n.yourhost.com',
  twilio: '+1 801 555 0134',
  gohighlevel: 'sub-account id',
  webhook: 'https://…',
  crm: 'which crm, and the account',
  calendar: 'which calendar',
  database: 'which database',
  other: 'where it lives',
};

export default function ConnectionForm({ connection, onCancel, onSaved }) {
  const [form, setForm] = useState({
    id: connection.id ?? null,
    tenantId: connection.tenantId,
    kind: connection.kind ?? 'n8n',
    label: connection.label ?? '',
    endpoint: connection.endpoint ?? '',
    status: connection.status ?? 'planned',
    workflowId: connection.workflowId ?? '',
    notes: connection.notes ?? '',
  });

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  return (
    <div style={{ padding: 'var(--panel-pad)', borderBottom: '1px solid var(--line)' }}>
      <div className="ops-form">
        <Field label="what is it" required>
          <TextInput
            value={form.label}
            onChange={set('label')}
            placeholder="speed-to-lead workflow"
            autoFocus
          />
        </Field>

        <Field label="kind">
          <SelectInput options={CONNECTION_KINDS} value={form.kind} onChange={set('kind')} />
        </Field>

        <Field label="where it lives" hint="never a credential — just where to find it">
          <TextInput
            mono
            value={form.endpoint}
            onChange={set('endpoint')}
            placeholder={PLACEHOLDER[form.kind] ?? PLACEHOLDER.other}
          />
        </Field>

        <Field label="declared status" hint="what we intend; the console checks it against events">
          <SelectInput options={STATUS_OPTIONS} value={form.status} onChange={set('status')} />
        </Field>

        <Field
          label="workflow id"
          hint="the workflow_id this sends on. without it, liveness cannot be checked."
        >
          <TextInput
            mono
            value={form.workflowId}
            onChange={set('workflowId')}
            placeholder="wf_speed_to_lead"
          />
        </Field>

        <Field label="notes" wide>
          <TextArea value={form.notes} onChange={set('notes')} placeholder="optional" />
        </Field>

        <div className="ops-form__row">
          <ActionButton
            variant="primary"
            icon="check"
            disabled={!form.label.trim()}
            onRun={async () => {
              await saveConnection({ ...form, label: form.label.trim() });
              await onSaved();
            }}
          >
            {form.id ? 'save connection' : 'add connection'}
          </ActionButton>

          <button type="button" className="ws-btn" onClick={onCancel}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

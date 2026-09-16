import { useState } from 'react';
import Icon from './Icon';
import { ActionButton, Field, SelectInput, TextArea, TextInput } from './ops-ui';
import { CONNECTION_KINDS, saveConnection } from '../lib/ops';
import {
  BILLING_CYCLE_OPTIONS,
  BILLING_STATUS_OPTIONS,
  INTEGRATIONS,
  INTEGRATION_BY_KEY,
  PAID_BY_OPTIONS,
  keysUrlFor,
} from '../lib/integrations';

/**
 * declaring what a client is wired to, and what it costs.
 *
 * the one field that matters more than it looks is the workflow id. without it a
 * connection can be listed but never checked — the console has no way to match it
 * to anything in the event log, and it shows as "no workflow id" rather than
 * borrowing the tenant's overall activity and calling that proof it is alive.
 *
 * there is no credential field and there never will be. tokens and API keys live
 * in n8n and in supabase function secrets; a table the browser can read is the
 * wrong place to keep one. what is recorded is the last four characters — enough
 * to tell two keys apart and to notice one was rotated — and where the real one
 * is kept. the input stops at four, and so does the database.
 */

const STATUS_OPTIONS = [
  { value: 'planned', label: 'planned' },
  { value: 'connected', label: 'connected' },
  { value: 'paused', label: 'paused' },
  { value: 'retired', label: 'retired' },
];

const PROVIDER_OPTIONS = [
  { value: '', label: 'something else' },
  ...INTEGRATIONS.map((entry) => ({ value: entry.key, label: entry.name })),
];

const PLACEHOLDER = {
  webhook: 'https://…',
  crm: 'which crm, and the account',
  calendar: 'which calendar',
  database: 'which database',
  other: 'where it lives',
};

function centsToDollars(cents) {
  return cents == null ? '' : String(cents / 100);
}

function dollarsToCents(text) {
  const cleaned = String(text).replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : NaN;
}

export default function ConnectionForm({ connection, onCancel, onSaved, intro }) {
  const [form, setForm] = useState({
    id: connection.id ?? null,
    tenantId: connection.tenantId,
    provider: connection.provider ?? '',
    kind: connection.kind ?? 'n8n',
    label: connection.label ?? '',
    endpoint: connection.endpoint ?? '',
    status: connection.status ?? 'planned',
    workflowId: connection.workflowId ?? '',
    expectedQuietHours: connection.expectedQuietHours ?? null,
    notes: connection.notes ?? '',
    accountRef: connection.accountRef ?? '',
    credentialHint: connection.credentialHint ?? '',
    credentialLocation: connection.credentialLocation ?? '',
    verifiedAt: connection.verifiedAt ?? null,
    billingStatus: connection.billingStatus ?? 'none',
    paidBy: connection.paidBy ?? '',
    cost: centsToDollars(connection.costCents),
    billingCycle: connection.billingCycle ?? '',
    renewsAt: connection.renewsAt ?? '',
  });

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const integration = INTEGRATION_BY_KEY.get(form.provider) ?? null;
  const costCents = dollarsToCents(form.cost);
  const tracked = form.billingStatus !== 'none';
  const keysUrl = keysUrlFor(integration, form);

  /* picking a service fills in what it implies, and only what is still empty — a
     label somebody typed is theirs. */
  function pickProvider(event) {
    const next = INTEGRATION_BY_KEY.get(event.target.value);
    setForm((prev) => ({
      ...prev,
      provider: event.target.value,
      kind: next ? next.kind : prev.kind,
      label: prev.label || (next ? next.name : ''),
      credentialLocation: prev.credentialLocation || (next ? next.keyStore : ''),
    }));
  }

  return (
    <div className="ops-connform">
      {intro}

      <div className="ops-form">
        <Field label="service">
          <SelectInput options={PROVIDER_OPTIONS} value={form.provider} onChange={pickProvider} />
        </Field>

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
            placeholder={integration?.endpointHint ?? PLACEHOLDER[form.kind] ?? PLACEHOLDER.other}
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

        <p className="ops-connform__section">account &amp; key</p>

        <Field label="account" hint="login email, account sid, workspace — whose account it is">
          <TextInput
            value={form.accountRef}
            onChange={set('accountRef')}
            placeholder="owner@company.com"
          />
        </Field>

        <Field label="key · last 4" hint="the last four characters only. never the key.">
          <TextInput
            mono
            maxLength={4}
            value={form.credentialHint}
            onChange={set('credentialHint')}
            placeholder="a1b2"
          />
        </Field>

        <Field label="key is stored in" hint="where the real key lives">
          <TextInput
            value={form.credentialLocation}
            onChange={set('credentialLocation')}
            placeholder="n8n credentials"
          />
        </Field>

        {keysUrl && (
          <div className="ops-form__row">
            <a className="ws-btn" href={keysUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={12} />
              {integration.name} api keys
            </a>
            {integration.billingUrl && (
              <a
                className="ws-btn"
                href={integration.billingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external" size={12} />
                {integration.name} billing
              </a>
            )}
          </div>
        )}

        <p className="ops-connform__section">billing</p>

        <Field label="subscription">
          <SelectInput
            options={BILLING_STATUS_OPTIONS}
            value={form.billingStatus}
            onChange={set('billingStatus')}
          />
        </Field>

        <Field label="paid by">
          <SelectInput
            options={PAID_BY_OPTIONS}
            value={form.paidBy}
            onChange={set('paidBy')}
            disabled={!tracked}
          />
        </Field>

        <Field
          label="cost"
          hint={Number.isNaN(costCents) ? 'that is not an amount' : 'per cycle, in usd'}
        >
          <TextInput
            mono
            inputMode="decimal"
            value={form.cost}
            onChange={set('cost')}
            placeholder="24"
            disabled={!tracked}
          />
        </Field>

        <Field label="billing cycle">
          <SelectInput
            options={BILLING_CYCLE_OPTIONS}
            value={form.billingCycle}
            onChange={set('billingCycle')}
            disabled={!tracked}
          />
        </Field>

        <Field
          label={form.billingStatus === 'trial' ? 'trial ends' : 'renews on'}
          hint="the next charge date"
        >
          <TextInput
            mono
            type="date"
            value={form.renewsAt}
            onChange={set('renewsAt')}
            disabled={!tracked}
          />
        </Field>

        <Field label="notes" wide>
          <TextArea value={form.notes} onChange={set('notes')} placeholder="optional" />
        </Field>

        <div className="ops-form__row">
          <ActionButton
            variant="primary"
            icon="check"
            disabled={!form.label.trim() || Number.isNaN(costCents)}
            onRun={async () => {
              const { cost, ...rest } = form;
              await saveConnection({
                ...rest,
                label: form.label.trim(),
                accountRef: form.accountRef.trim(),
                credentialHint: form.credentialHint.trim(),
                credentialLocation: form.credentialLocation.trim(),
                /* untracked billing saves as untracked, not as a stale price and
                   date nobody can see because the fields were greyed out. */
                paidBy: tracked ? form.paidBy : null,
                costCents: tracked ? costCents : null,
                billingCycle: tracked ? form.billingCycle : null,
                renewsAt: tracked ? form.renewsAt : null,
              });
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

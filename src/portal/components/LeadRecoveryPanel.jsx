import { useCallback, useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Panel, Pill, Term } from './ui';
import {
  ActionButton,
  CheckList,
  CopyValue,
  Disclosure,
  Fact,
  Field,
  Help,
  Notice,
  SelectInput,
  TextArea,
  TextInput,
} from './ops-ui';
import { formatCount, formatMoney, formatRelative, formatStamp } from '../lib/format';
import {
  activateLeadRecovery,
  getLeadRecovery,
  issueIntakeKey,
  pauseLeadRecovery,
  recordLeadOutcome,
  resolveLeadHandoff,
  retryLeadRecoveryAction,
  runLeadRecoveryCanary,
  saveLeadRecoveryConfig,
  selectLeadRecovery,
  settleUnknownSend,
  suppressLeadContact,
  takeOverLead,
  testLeadRecoveryRouting,
} from '../lib/ops';
/* the validator itself, imported from the edge function's own source.
 *
 * not a second copy and not a subset: the same module the `ops` function runs against what
 * actually arrives. an operator sees a problem as they type instead of after a round trip,
 * and the server still validates everything regardless — the browser's answer is a
 * convenience and never the decision. */
import {
  AFTER_HOURS_BEHAVIOURS,
  COMPLIANCE_STATUSES,
  DEFAULT_TEMPLATES,
  defaultConfig,
  FORWARDING_MODES,
  ONBOARDING_STEPS,
  validateLeadRecoveryConfig,
  WEEKDAYS,
} from '../../../supabase/functions/_shared/lead-recovery-config.ts';

/**
 * ARC Lead Recovery, from the operator's side.
 *
 * Everything a tenant's module needs in one panel, in the order onboarding actually
 * happens: configure it, prove the routing, prove the pipeline, then switch it on. The
 * switch is at the bottom and is the only control that can refuse — activation is
 * fail-closed, and when it refuses it prints every reason rather than the first.
 *
 * Two things are deliberately absent. There is no workflow builder: what a tenant may
 * differ in is this form, and a shape it cannot express is a change to the shared engine.
 * And there is no "buy a number" button: provisioning is billable and externally visible,
 * so it is done by a person in the Twilio console who then records the reference here.
 *
 * The two test controls cannot reach a member of the public, and the panel says so beside
 * each of them rather than expecting anyone to take it on trust.
 */

const LIST_HINT = 'one per line, or separated by commas';

/* the form edits strings; the config stores arrays. kept as two explicit conversions
   rather than a clever binding, because "the operator typed nothing" and "the operator
   cleared the list" have to survive the round trip as the same empty array. */
const toList = (text) =>
  String(text ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const fromList = (list) => (Array.isArray(list) ? list.join('\n') : '');

function hoursToText(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return '';
  return ranges.map((range) => `${range.open}-${range.close}`).join(', ');
}

function textToHours(text) {
  return toList(text)
    .map((chunk) => {
      const [open, close] = chunk.split('-').map((part) => part.trim());
      return open && close ? { open, close } : null;
    })
    .filter(Boolean);
}

/* the form's own shape: flat strings, because that is what inputs hold. `toConfig` is the
   one place it becomes the nested object the validator judges. */
function toForm(config) {
  const base = { ...defaultConfig(), ...(config ?? {}) };
  return {
    company_name: base.company_name ?? '',
    timezone: base.timezone ?? 'America/New_York',
    hours: Object.fromEntries(WEEKDAYS.map((day) => [day, hoursToText(base.business_hours?.[day])])),
    holidays: fromList(base.holidays),
    services: fromList(base.services),
    zips: fromList(base.service_area?.zips),
    cities: fromList(base.service_area?.cities),
    destination: base.forwarding?.destination ?? '',
    timeout: String(base.forwarding?.timeout_seconds ?? 20),
    forwarding_mode: base.forwarding?.mode ?? 'arc_first',
    alerts: (base.staff_alerts ?? []).map((a) => `${a.channel}:${a.address}${a.name ? `:${a.name}` : ''}`).join('\n'),
    booking_url: base.booking_url ?? '',
    first_response: base.templates?.first_response ?? '',
    after_hours_response: base.templates?.after_hours_response ?? '',
    followup: base.templates?.followup ?? '',
    handoff_ack: base.templates?.handoff_ack ?? '',
    reply_ack: base.templates?.reply_ack ?? '',
    reply_ack_booking: base.templates?.reply_ack_booking ?? '',
    after_hours_behaviour: base.after_hours?.behaviour ?? 'after_hours_response',
    callback_window: base.after_hours?.callback_window ?? '',
    emergency_keywords: fromList(base.safety?.emergency_keywords),
    always_handoff: fromList(base.safety?.always_handoff_services),
    confidence_floor: String(base.safety?.confidence_floor ?? 0.7),
    handoff_on_ambiguous: base.safety?.handoff_on_ambiguous_scope !== false,
    ai_enabled: base.ai?.enabled !== false,
    ai_provider: base.ai?.provider ?? 'anthropic',
    ai_model: base.ai?.model ?? '',
    compliance_status: base.compliance?.status ?? 'not_started',
    brand_registered: base.compliance?.brand_registered === true,
    campaign_ref: base.compliance?.campaign_ref ?? '',
    opt_out_language: base.compliance?.opt_out_language ?? 'Reply STOP to opt out.',
    subaccount_sid: base.twilio?.subaccount_sid ?? '',
    messaging_service_sid: base.twilio?.messaging_service_sid ?? '',
    phone_number: base.twilio?.phone_number ?? '',
    phone_number_sid: base.twilio?.phone_number_sid ?? '',
  };
}

function toConfig(form) {
  /* an alert line is `channel:address[:name]`. a compact spelling for a list that is
     usually two entries and never ten, and one that survives a copy-paste between
     clients. */
  const alerts = toList(form.alerts).map((line) => {
    const [channel, address, ...rest] = line.split(':').map((part) => part.trim());
    return { channel: channel || 'sms', address: address ?? '', name: rest.join(':') || null };
  });

  return {
    company_name: form.company_name.trim(),
    timezone: form.timezone.trim(),
    business_hours: Object.fromEntries(WEEKDAYS.map((day) => [day, textToHours(form.hours[day])])),
    holidays: toList(form.holidays),
    services: toList(form.services),
    service_area: { zips: toList(form.zips), cities: toList(form.cities), note: null },
    forwarding: {
      destination: form.destination.trim(),
      timeout_seconds: Number(form.timeout) || 20,
      /* sent only when it is not what its absence already means, like the two templates
         below: a save that changes neither is then a document an `ops` function from before
         ARC-GO-310 still accepts, so shipping the site ahead of the function breaks nothing. */
      ...(form.forwarding_mode !== 'arc_first' ? { mode: form.forwarding_mode } : {}),
    },
    staff_alerts: alerts,
    booking_url: form.booking_url.trim() || null,
    templates: {
      first_response: form.first_response.trim(),
      after_hours_response: form.after_hours_response.trim(),
      followup: form.followup.trim(),
      handoff_ack: form.handoff_ack.trim(),
      ...Object.fromEntries(
        ['reply_ack', 'reply_ack_booking']
          .map((key) => [key, form[key].trim()])
          .filter(([key, text]) => text !== '' && text !== DEFAULT_TEMPLATES[key]),
      ),
    },
    after_hours: {
      behaviour: form.after_hours_behaviour,
      callback_window: form.callback_window.trim() || null,
    },
    safety: {
      emergency_keywords: toList(form.emergency_keywords),
      always_handoff_services: toList(form.always_handoff),
      confidence_floor: Number(form.confidence_floor) || 0.7,
      handoff_on_ambiguous_scope: form.handoff_on_ambiguous,
    },
    ai: { enabled: form.ai_enabled, provider: form.ai_provider, model: form.ai_model.trim() || null },
    compliance: {
      status: form.compliance_status,
      brand_registered: form.brand_registered,
      campaign_ref: form.campaign_ref.trim() || null,
      reviewed_at: null,
      opt_out_language: form.opt_out_language.trim(),
    },
    twilio: {
      subaccount_sid: form.subaccount_sid.trim() || null,
      messaging_service_sid: form.messaging_service_sid.trim() || null,
      phone_number: form.phone_number.trim() || null,
      phone_number_sid: form.phone_number_sid.trim() || null,
    },
  };
}

/* the two setups, in words an operator would use on the phone with the client. */
const FORWARDING_MODE_WORDS = {
  arc_first: "ARC's number — it rings the business, and an unanswered call is a lead",
  business_first: 'their own number — their phone company forwards unanswered calls to ARC',
};

const COMPLIANCE_TONE = {
  approved: 'ok',
  pending: 'warn',
  rejected: 'fail',
  not_started: 'neutral',
};

export default function LeadRecoveryPanel({ client }) {
  const tenantId = client.id;
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [form, setForm] = useState(() => toForm(null));
  const [dirty, setDirty] = useState(false);
  /* the published versions the form was filled from. sent back on save so a form that
     somebody else has since saved over is refused rather than silently winning (0014). */
  const [formVersions, setFormVersions] = useState(null);
  const [routing, setRouting] = useState(null);
  const [canary, setCanary] = useState(null);
  const [activationError, setActivationError] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [origins, setOrigins] = useState('');

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, status: prev.data ? 'ready' : 'loading' }));
    try {
      const data = await getLeadRecovery(tenantId);
      setState({ status: 'ready', data, error: null });
      /* only reset the form from the server when the operator has not started editing.
         reloading over half-typed configuration is the fastest way to lose somebody's
         work. */
      setDirty((isDirty) => {
        if (!isDirty) {
          setForm(toForm(data.config));
          setFormVersions(data.versions ?? null);
        }
        return isDirty;
      });
    } catch (error) {
      setState({ status: 'error', data: null, error: error.message });
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const config = useMemo(() => toConfig(form), [form]);
  /* validated on every keystroke by the same function the server runs. */
  const validation = useMemo(() => validateLeadRecoveryConfig(config), [config]);

  const set = (key) => (event) => {
    const value = event?.target?.type === 'checkbox' ? event.target.checked : event?.target?.value ?? event;
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const setHours = (day) => (event) => {
    setForm((prev) => ({ ...prev, hours: { ...prev.hours, [day]: event.target.value } }));
    setDirty(true);
  };

  if (state.status === 'loading') {
    return (
      <Panel title="lead recovery" note="the execution layer">
        <p className="ops-muted">loading…</p>
      </Panel>
    );
  }

  if (state.status === 'error') {
    return (
      <Panel title="lead recovery" note="the execution layer">
        <Notice tone="fail" title="could not read this client's module">
          {state.error}
        </Notice>
      </Panel>
    );
  }

  const data = state.data;
  const steps = data.steps ?? [];
  const activation = data.activation ?? { ok: false, blockers: [], missingSteps: [] };
  const complianceStatus = data.compliance ?? 'not_started';
  const runs = data.runs_by_state ?? {};
  const needingPerson = (runs.handoff_required ?? 0) + (runs.handed_off ?? 0);
  /* the module's lifecycle (ARC-120): the state this panel was drawn from travels back with
     every change, so acting on a stale screen is refused rather than silently winning. */
  const lifecycle = data.lifecycle?.lifecycle ?? null;
  const stateVersion = lifecycle?.state_version ?? 0;
  const unselected = !lifecycle || lifecycle.state === 'unselected';

  return (
    <Panel
      title="lead recovery"
      note={data.live ? 'live' : data.enabled ? 'active, new runs held' : data.configured ? 'configured, not switched on' : 'not set up'}
      actions={
        <Pill tone={data.live ? 'ok' : data.configured ? 'warn' : 'neutral'}>
          {data.live ? 'sending' : data.enabled ? 'held' : data.configured ? 'paused' : 'no config'}
        </Pill>
      }
    >
      {/* ── what it is doing right now ── */}
      <dl className="ws-facts">
        <Fact label="state">
          {data.live ? 'answering calls and texting back' : 'recording leads, sending nothing'}
        </Fact>
        {data.lifecycle?.effective && (
          <Fact label={<Term k="lifecycle" />} note="the operator's decision and the system's health, kept apart">
            {data.lifecycle.effective.headline}
          </Fact>
        )}
        <Fact label="messaging compliance">
          <Pill tone={COMPLIANCE_TONE[complianceStatus] ?? 'neutral'}>{complianceStatus.replace(/_/g, ' ')}</Pill>
        </Fact>
        <Fact label="runs" note="across every lead this client has">
          {Object.keys(runs).length === 0
            ? 'none yet'
            : Object.entries(runs)
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => `${count} ${key.replace(/_/g, ' ')}`)
                .join(' · ')}
        </Fact>
        <Fact label="waiting on a person">{formatCount(needingPerson)}</Fact>
        <Fact label="config version" note="a run is pinned to the version it started under">
          {data.config_version ?? '—'}
        </Fact>
        <Fact label="last saved">
          {data.updated_at ? formatStamp(data.updated_at, client.timezone) : 'never'}
        </Fact>
      </dl>

      {!validation.ok && (
        <Notice tone="warn" title={`${validation.errors.length} thing${validation.errors.length === 1 ? '' : 's'} to fix before this can be saved`}>
          <ul className="ops-lr__list">
            {validation.errors.slice(0, 8).map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Notice>
      )}

      {validation.ok && validation.warnings.length > 0 && (
        <Notice tone="info" title="worth a look, but it will save">
          <ul className="ops-lr__list">
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}

      {/* ── the configuration ── */}
      <Disclosure
        title="business rules"
        summary="the only place one client differs from another"
        defaultOpen={!data.configured}
      >
        <div className="ops-form">
          <Field label="company name" required hint="the name in every text that goes out">
            <TextInput value={form.company_name} onChange={set('company_name')} maxLength={80} />
          </Field>
          <Field label="timezone" required hint="every hours decision is made in it">
            <TextInput value={form.timezone} onChange={set('timezone')} mono />
          </Field>

          <Field label="business hours" wide hint="per day, as 08:00-17:00. two periods for a split shift; blank for closed">
            <div className="ops-lr__hours">
              {WEEKDAYS.map((day) => (
                <label key={day} className="ops-lr__day">
                  <span>{day}</span>
                  <TextInput value={form.hours[day]} onChange={setHours(day)} mono placeholder="closed" />
                </label>
              ))}
            </div>
          </Field>

          <Field label="holidays" hint="dates they are shut, as 2026-12-25">
            <TextArea value={form.holidays} onChange={set('holidays')} rows={2} />
          </Field>
          <Field label="services offered" required hint={`what the classifier matches against — ${LIST_HINT}`}>
            <TextArea value={form.services} onChange={set('services')} rows={4} />
          </Field>
          <Field label="ZIP codes covered" required hint={LIST_HINT}>
            <TextArea value={form.zips} onChange={set('zips')} rows={3} />
          </Field>
          <Field label="cities covered" hint="optional, for the ones without a clean ZIP list">
            <TextArea value={form.cities} onChange={set('cities')} rows={2} />
          </Field>

          <Field label="which number customers dial" wide required hint="decides when a call counts as missed">
            <SelectInput
              value={form.forwarding_mode}
              onChange={set('forwarding_mode')}
              options={FORWARDING_MODES.map((key) => ({ value: key, label: FORWARDING_MODE_WORDS[key] ?? key }))}
            />
          </Field>
          <Field label="the business's own number" required hint="E.164 — the phone that rings when ARC's number is in front, and who a lead is given to either way">
            <TextInput value={form.destination} onChange={set('destination')} mono placeholder="+16145550137" />
          </Field>
          <Field label="ring for (seconds)" required hint="5–120. used only when ARC's number is in front: after this, the call counts as missed">
            <TextInput value={form.timeout} onChange={set('timeout')} mono />
          </Field>

          <Field label="staff alerts" wide hint="one per line, as sms:number:name — sms:+16145550101:Dana. text only: email alerts are not built">
            <TextArea value={form.alerts} onChange={set('alerts')} rows={3} />
          </Field>

          <Field label="booking url" hint="https only; leave blank if they have none">
            <TextInput value={form.booking_url} onChange={set('booking_url')} />
          </Field>
        </div>
      </Disclosure>

      <Disclosure title="the words that get sent" summary="reviewed templates — the model never writes a customer-facing message">
        <Help label="why these are templates and not generated">
          A model that writes outbound SMS under the contractor&rsquo;s brand and phone number is one
          prompt injection away from writing whatever the last stranger asked it to, with no review
          step between it and the carrier. So the classifier reads and summarises, and these
          sentences are what actually leaves. Placeholders are a closed list:{' '}
          <code>{'{{company}}'}</code>, <code>{'{{customer_name}}'}</code>,{' '}
          <code>{'{{booking_url}}'}</code>, <code>{'{{callback_window}}'}</code>. The opt-out line is
          appended by the engine and cannot be edited out of a template.
        </Help>
        <div className="ops-form">
          <Field label="first response" wide required hint="queued the moment a call is missed or a form arrives, and sent by the next run of the queue">
            <TextArea value={form.first_response} onChange={set('first_response')} rows={3} />
          </Field>
          <Field label="out-of-hours response" wide hint="used when they are closed and the behaviour below says to answer anyway">
            <TextArea value={form.after_hours_response} onChange={set('after_hours_response')} rows={3} />
          </Field>
          <Field label="follow-up" wide hint="once, an hour later or at the next opening time, only if nobody replied">
            <TextArea value={form.followup} onChange={set('followup')} rows={2} />
          </Field>
          <Field label="handed to a person" wide hint="sent when the sequence stops and somebody takes over">
            <TextArea value={form.handoff_ack} onChange={set('handoff_ack')} rows={2} />
          </Field>
          <Field label="after they reply" wide hint="sent once, after their reply has been read and passed to the business">
            <TextArea value={form.reply_ack} onChange={set('reply_ack')} rows={2} />
          </Field>
          <Field label="after they reply, with the booking link" wide hint="used instead when a booking url is set above">
            <TextArea value={form.reply_ack_booking} onChange={set('reply_ack_booking')} rows={2} />
          </Field>
          <Field label="out of hours" hint="what happens to a lead that lands when they are shut">
            <SelectInput
              value={form.after_hours_behaviour}
              onChange={set('after_hours_behaviour')}
              options={AFTER_HOURS_BEHAVIOURS.map((key) => ({ value: key, label: key.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field label="callback window" hint="the promise in the out-of-hours text, e.g. “first thing in the morning”">
            <TextInput value={form.callback_window} onChange={set('callback_window')} />
          </Field>
          <Field label="opt-out wording" wide required hint="must tell the customer to reply STOP">
            <TextInput value={form.opt_out_language} onChange={set('opt_out_language')} />
          </Field>
        </div>
      </Disclosure>

      <Disclosure title="safety and classification" summary="the rules that outrank the model">
        <Help label="what the model is and is not allowed to decide">
          Deterministic word lists run first, on the raw customer text, and they can only ever{' '}
          <em>add</em> caution. The classifier&rsquo;s output is merged with them as a logical OR:
          it can raise urgency and it can ask for a person, and there is no code path in which it
          clears a flag a rule set. Gas, fire, smoke, electrical, flooding, medical distress, an
          angry customer, an unclear scope and anything below the confidence floor all go to a
          human. If there is no AI key at all, every lead goes to a human — the system degrades to
          a person rather than inventing an answer.
        </Help>
        <div className="ops-form">
          <Field label="extra emergency words" hint={`added to the built-in lists — ${LIST_HINT}`}>
            <TextArea value={form.emergency_keywords} onChange={set('emergency_keywords')} rows={2} />
          </Field>
          <Field label="services that always need a person" hint="must match a service above, or it will never fire">
            <TextArea value={form.always_handoff} onChange={set('always_handoff')} rows={2} />
          </Field>
          <Field label="confidence floor" hint="0.5–0.99. below this the lead goes to a person">
            <TextInput value={form.confidence_floor} onChange={set('confidence_floor')} mono />
          </Field>
          <Field label="unclear scope needs a person">
            <label className="ops-check">
              <input type="checkbox" checked={form.handoff_on_ambiguous} onChange={set('handoff_on_ambiguous')} />
              <span>hand off when the enquiry matches no service they list</span>
            </label>
          </Field>
          <Field label="classification">
            <label className="ops-check">
              <input type="checkbox" checked={form.ai_enabled} onChange={set('ai_enabled')} />
              <span>use a model to classify replies</span>
            </label>
          </Field>
          <Field label="provider">
            <SelectInput
              value={form.ai_provider}
              onChange={set('ai_provider')}
              options={[
                { value: 'anthropic', label: 'anthropic' },
                { value: 'none', label: 'none — deterministic word lists only' },
              ]}
            />
          </Field>
        </div>
      </Disclosure>

      <Disclosure title="Twilio and compliance" summary="identifiers, never credentials">
        <Help label="where the secrets live">
          The account SID and auth token are Arc&rsquo;s, one pair for the whole platform, set as
          secrets on the edge functions. Nothing here is a credential: a subaccount SID, a messaging
          service SID and a phone number are public identifiers, and knowing them grants nothing.
          The validator refuses anything shaped like a token — including a bare 32-character hex
          string, which is exactly what a Twilio auth token looks like.
        </Help>
        <div className="ops-form">
          <Field label="Twilio number" required hint="the ARC routing number. this is what resolves a webhook to this client">
            <TextInput value={form.phone_number} onChange={set('phone_number')} mono placeholder="+16145550100" />
          </Field>
          <Field label="messaging service SID" required hint="MG… — carries the A2P registration">
            <TextInput value={form.messaging_service_sid} onChange={set('messaging_service_sid')} mono />
          </Field>
          <Field label="subaccount SID" hint="AC… if they have their own subaccount">
            <TextInput value={form.subaccount_sid} onChange={set('subaccount_sid')} mono />
          </Field>
          <Field label="number SID" hint="PN…">
            <TextInput value={form.phone_number_sid} onChange={set('phone_number_sid')} mono />
          </Field>
          <Field label="compliance status" required hint="Arc will not send on anything but approved">
            <SelectInput
              value={form.compliance_status}
              onChange={set('compliance_status')}
              options={COMPLIANCE_STATUSES.map((key) => ({ value: key, label: key.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field label="campaign reference" hint="the A2P campaign id, for the record">
            <TextInput value={form.campaign_ref} onChange={set('campaign_ref')} mono />
          </Field>
          <Field label="brand registered">
            <label className="ops-check">
              <input type="checkbox" checked={form.brand_registered} onChange={set('brand_registered')} />
              <span>the brand is registered with the carriers</span>
            </label>
          </Field>
        </div>
      </Disclosure>

      <div className="ops-rowactions">
        <ActionButton
          disabled={!validation.ok || !dirty}
          onRun={async () => {
          const result = await saveLeadRecoveryConfig(tenantId, config, formVersions);
          setDirty(false);
          await load();
          return `saved as version ${result.config_version}`;
          }}
        >
          {dirty ? 'save configuration' : 'saved'}
        </ActionButton>
        {dirty && <span className="ops-muted">unsaved changes</span>}
      </div>

      {/* ── proving it works, without touching a customer ── */}
      <Disclosure title="test it" summary="neither of these can reach a member of the public" defaultOpen>
        <div className="ops-rowactions">
          <ActionButton
            onRun={async () => {
            const result = await testLeadRecoveryRouting(tenantId);
            setRouting(result);
            return result.resolves ? 'the number resolves to this client' : 'the number is claimed by more than one client';
            }}
          >
          test phone routing
        </ActionButton>
          <ActionButton
            onRun={async () => {
            const result = await runLeadRecoveryCanary(tenantId);
            setCanary(result);
            await load();
            return result.passed ? 'the canary went end to end' : `stopped: ${result.outcome}`;
            }}
          >
          run a synthetic canary
        </ActionButton>
        </div>
        <p className="ops-muted">
          Routing is a computation — it returns the TwiML the voice webhook would produce and places
          no call. The <Term k="canary" /> creates a synthetic lead flagged <code>is_canary</code>, runs it through
          the whole engine with a sender that records instead of sending, and addresses it to
          Twilio&rsquo;s reserved test number. It is excluded from every client-facing count, exactly
          as the hourly canary always has been.
        </p>

        {routing && (
          <div className="ops-lr__sub">
            <dl className="ws-facts">
              <Fact label="number">{routing.number}</Fact>
              <Fact label="customers dial">{FORWARDING_MODE_WORDS[routing.mode] ?? routing.mode ?? '—'}</Fact>
              {routing.dials === false ? (
                <Fact label="arc dials">nobody — a call that reaches arc is already a missed one</Fact>
              ) : (
                <>
                  <Fact label="forwards to">{routing.forwards_to}</Fact>
                  <Fact label="rings for">{routing.timeout_seconds}s</Fact>
                </>
              )}
              <Fact label="resolves uniquely">{routing.resolves ? 'yes' : `no — also claimed by ${routing.conflicts.length} other`}</Fact>
            </dl>
            <p className="ops-muted">enter these in the Twilio console for this number:</p>
            <CopyValue label="voice — a call comes in" value={routing.webhooks.voice} />
            <CopyValue label="messaging — a message comes in" value={routing.webhooks.sms} />
            <CopyValue label="messaging service — delivery status" value={routing.webhooks.message_status} />
            <Disclosure title="the TwiML this would return" summary="nothing was dialled">
              <pre className="ops-lr__pre">{routing.twiml}</pre>
            </Disclosure>
          </div>
        )}

        {canary && (
          <div className="ops-lr__sub">
            <Notice tone={canary.passed ? 'ok' : 'warn'} title={canary.passed ? 'the canary completed' : 'the canary stopped early'}>
              <p>{canary.outcome}</p>
              <p className="ops-muted">{canary.note}</p>
            </Notice>
            <CheckList
              checks={(canary.actions ?? []).map((action, i) => ({
                key: `${action.type}-${i}`,
                label: action.type.replace(/_/g, ' '),
                tone: action.status === 'done' ? 'ok' : action.status === 'cancelled' ? 'idle' : 'fail',
                detail: action.error ?? action.status,
              }))}
            />
          </div>
        )}
      </Disclosure>

      {/* ── the website form ── */}
      <Disclosure title="website form" summary="the same engine, a different door">
        {(data.intake_keys ?? []).length === 0 ? (
          <p className="ops-muted">no intake key yet. a form cannot post until one exists and names the origins it may post from.</p>
        ) : (
          (data.intake_keys ?? []).map((key) => (
            <div key={key.id} className="ops-lr__sub">
              <CopyValue label="public key" value={key.public_key} />
              <dl className="ws-facts">
                <Fact label="origins allowed">
                  {key.allowed_origins?.length
                    ? key.allowed_origins.join(', ')
                    : 'none yet — the form will refuse every submission'}
                </Fact>
                <Fact label="last used">{key.last_used_at ? formatRelative(key.last_used_at) : 'never'}</Fact>
              </dl>
            </div>
          ))
        )}
        <div className="ops-form">
          <Field label="allowed origins" wide hint="scheme and host only, https — https://theirsite.com">
            <TextArea value={origins} onChange={(event) => setOrigins(event.target.value)} rows={2} />
          </Field>
        </div>
        <div className="ops-rowactions">
          <ActionButton
            confirm={
            (data.intake_keys ?? []).length > 0
            ? 'rotating revokes the current key immediately. any form still using it stops working until the snippet is replaced. continue?'
            : null
            }
            onRun={async () => {
            const result = await issueIntakeKey(tenantId, {
            allowedOrigins: toList(origins),
            rotate: (data.intake_keys ?? []).length > 0,
            });
            setSnippet(result.snippet);
            await load();
            return 'issued';
            }}
          >
          {(data.intake_keys ?? []).length > 0 ? 'rotate the key' : 'issue a key'}
        </ActionButton>
        </div>
        {snippet && (
          <>
            <p className="ops-muted">paste this into their site where the form should appear:</p>
            <CopyValue label="snippet" value={snippet} />
          </>
        )}
      </Disclosure>

      {/* ── what needs a person ── */}
      {(data.open_handoffs ?? []).length > 0 && (
        <Disclosure
          title={`${formatCount(data.open_handoffs.length)} lead${data.open_handoffs.length === 1 ? '' : 's'} waiting on a person`}
          summary="the automation has stopped on each of these"
          defaultOpen
        >
          {data.open_handoffs.map((handoff) => (
            <div key={handoff.id} className="ops-lr__sub">
              <dl className="ws-facts">
                <Fact label="why">
                  {handoff.is_safety && <Pill tone="fail">safety</Pill>} {handoff.reason}
                </Fact>
                <Fact label="opened">{formatRelative(handoff.opened_at)}</Fact>
                <Fact label="code">{String(handoff.reason_code).replace(/_/g, ' ')}</Fact>
              </dl>
              <div className="ops-rowactions">
                <ActionButton
                  onRun={async () => {
                  await takeOverLead(tenantId, handoff.lead_id, { note: 'taken over from the console' });
                  await load();
                  return 'taken over — every scheduled message is cancelled';
                  }}
                >
          take this lead over
        </ActionButton>
                <ActionButton
                  onRun={async () => {
                  await resolveLeadHandoff(tenantId, handoff.id, 'resolved from the console');
                  await load();
                  return 'resolved';
                  }}
                >
          mark resolved
        </ActionButton>
              </div>
            </div>
          ))}
        </Disclosure>
      )}

      {/* ── what broke ── */}
      {(data.failed_actions ?? []).length > 0 && (
        <Disclosure
          title={`${formatCount(data.failed_actions.length)} failed action${data.failed_actions.length === 1 ? '' : 's'}`}
          summary="retries exhausted. each one already opened a task for a person"
          defaultOpen
        >
          {data.failed_actions.map((action) => (
            <div key={action.id} className="ops-lr__sub">
              <dl className="ws-facts">
                <Fact label="what">{action.action_type.replace(/_/g, ' ')}</Fact>
                <Fact label="attempts">{`${action.attempts} of ${action.max_attempts}`}</Fact>
                <Fact label="failed">{action.completed_at ? formatRelative(action.completed_at) : '—'}</Fact>
              </dl>
              <p className="ops-muted">{action.last_error}</p>
              <div className="ops-rowactions">
                <ActionButton
                  onRun={async () => {
                  await retryLeadRecoveryAction(tenantId, action.id);
                  await load();
                  return 'back on the queue';
                  }}
                >
          retry it now
        </ActionButton>
              </div>
            </div>
          ))}
        </Disclosure>
      )}

      {/* ── sends nobody could vouch for (ARC-GO-310) ── */}
      {(data.unknown_sends ?? []).length > 0 && (
        <Disclosure
          title={`${formatCount(data.unknown_sends.length)} send${data.unknown_sends.length === 1 ? '' : 's'} with an unknown outcome`}
          summary="held, never resent. look each one up at the provider, then say what it shows"
          defaultOpen
        >
          {data.unknown_sends.map((attempt) => (
            <UnknownSend key={attempt.id} tenantId={tenantId} attempt={attempt} onDone={load} />
          ))}
        </Disclosure>
      )}

      {/* ── recent leads ── */}
      <Disclosure title="recent leads" summary="the operational records, newest first — stop one, record its visit, or close it">
        {(data.recent_leads ?? []).length === 0 ? (
          <Empty title="no leads through the engine yet">
            a missed call or a website form will create one within seconds of it happening.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>customer</th>
                  <th>source</th>
                  <th>status</th>
                  <th>urgency</th>
                  <th>what you can do</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_leads.map((lead) => (
                  <tr key={lead.id}>
                    <td className="mono">{formatRelative(lead.created_at)}</td>
                    <td>
                      {lead.customer_name ?? 'unknown'}
                      {lead.is_canary && <Pill tone="neutral">canary</Pill>}
                    </td>
                    <td>{String(lead.source).replace(/_/g, ' ')}</td>
                    <td>
                      <Pill tone={lead.status === 'booked' ? 'ok' : lead.status === 'handoff_required' ? 'warn' : 'neutral'}>
                        {String(lead.status).replace(/_/g, ' ')}
                      </Pill>
                    </td>
                    <td>{lead.urgency ? String(lead.urgency).replace(/_/g, ' ') : '—'}</td>
                    <td>
                      <LeadControls tenantId={tenantId} lead={lead} timezone={client.timezone ?? 'UTC'} onDone={load} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <SuppressNumber tenantId={tenantId} onDone={load} />
      </Disclosure>

      {/* ── onboarding, and the switch ── */}
      <Disclosure title="onboarding" summary="activation is refused until every required step is done" defaultOpen={!data.enabled}>
        <ol className="ops-steps">
          {steps.map((step) => (
            <li key={step.key} className={`ops-lr__step${step.done_at ? ' is-done' : ''}`}>
              <div className="ops-lr__stepline">
                <b>{step.label}</b>
                {step.required && <Pill tone="neutral">required</Pill>}
                {step.done_at ? (
                  <Pill tone="ok">
                    <Icon name="check" size={11} /> {formatStamp(step.done_at, client.timezone)}
                  </Pill>
                ) : (
                  <Pill tone="idle">outstanding</Pill>
                )}
              </div>
              <span className="ops-muted">{step.detail}</span>
              <StepToggle tenantId={tenantId} step={step} onDone={load} />
            </li>
          ))}
        </ol>

        {activationError && (
          <Notice tone="fail" title="this module cannot be activated yet">
            <ul className="ops-lr__list">
              {(activationError.blockers ?? []).map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
              {(activationError.missing_steps ?? []).map((step) => (
                <li key={step}>the “{String(step).replace(/_/g, ' ')}” step is not done</li>
              ))}
            </ul>
          </Notice>
        )}

        <div className="ops-rowactions">
          {unselected ? (
            <ActionButton
              onRun={async () => {
              await selectLeadRecovery(tenantId, stateVersion);
              await load();
              return 'selected — configure it, then run a canary to begin testing';
              }}
            >
          select lead recovery for this client
        </ActionButton>
          ) : data.enabled ? (
            <ActionButton
              confirm="pausing stops new sequences and cancels everything already queued for this client. calls will still forward. continue?"
              onRun={async () => {
              const result = await pauseLeadRecovery(tenantId, 'paused from the console', stateVersion);
              await load();
              return `paused · ${formatCount(result.cancelled_actions)} queued action(s) cancelled`;
              }}
            >
          pause lead recovery
        </ActionButton>
          ) : (
            <ActionButton
              disabled={!activation.ok}
              confirm="this switches on live texting to this client's customers. continue?"
              onRun={async () => {
              setActivationError(null);
              try {
              await activateLeadRecovery(tenantId, stateVersion);
              await load();
              return 'live';
              } catch (error) {
              /* the edge function answers 409 with every reason at once. shown as a
              list rather than one line, because an operator working through
              onboarding wants the whole list. */
              setActivationError(error.payload ?? { blockers: [error.message] });
              throw error;
              }
              }}
            >
          activate lead recovery
        </ActionButton>
          )}
          {!unselected && !data.enabled && !activation.ok && (
            <span className="ops-muted">
              {activation.missingSteps.length > 0
                ? `${activation.missingSteps.length} required step(s) outstanding`
                : activation.blockers[0]}
            </span>
          )}
        </div>
      </Disclosure>
    </Panel>
  );
}

/* ── the operator's minimum (ARC-GO-310) ─────────────────────
 *
 * every action below already existed in the `ops` function and had no button: an operator
 * who saw an ordinary lead going wrong could not stop it, and a booked visit could only be
 * recorded with SQL. each is the engine's own call, and this decides nothing.
 */

const CLOSE_OUTCOMES = [
  { value: 'declined', label: 'the customer said no' },
  { value: 'no_response', label: 'the customer went quiet' },
  { value: 'not_a_fit', label: 'not a job they do' },
  { value: 'duplicate', label: 'a duplicate of another lead' },
];

const FINISHED_LEAD = new Set(['closed', 'suppressed']);

function LeadControls({ tenantId, lead, timezone, onDone }) {
  const [when, setWhen] = useState('');
  const [outcome, setOutcome] = useState(CLOSE_OUTCOMES[0].value);

  if (lead.is_canary) return <span className="ops-muted">a synthetic lead</span>;
  if (FINISHED_LEAD.has(lead.status)) return <span className="ops-muted">finished</span>;

  return (
    <div className="ops-lr__sub">
      {lead.status !== 'handed_off' && lead.status !== 'booked' && (
        <div className="ops-rowactions">
          <ActionButton
            confirm="stop the automation on this lead? every message still queued for this customer is cancelled, and the lead is yours."
            consequence="every message still queued for this customer is cancelled, and the lead is yours."
            onRun={async () => {
              await takeOverLead(tenantId, lead.id, { note: 'stopped from the console' });
              await onDone();
              return 'stopped — nothing further is sent';
            }}
          >
            stop this lead
          </ActionButton>
        </div>
      )}
      <div className="ops-rowactions">
        <Field label="visit time" hint={`on the business's clock (${timezone})`}>
          <TextInput type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
        </Field>
        <ActionButton
          disabled={!when}
          onRun={async () => {
            const at = DateTime.fromISO(when, { zone: timezone });
            if (!at.isValid) throw new Error('that is not a date and time');
            await recordLeadOutcome(tenantId, lead.id, 'booked', null, at.toUTC().toISO());
            await onDone();
            return 'visit recorded — the automation has stopped on this lead';
          }}
        >
          record the visit
        </ActionButton>
      </div>
      <div className="ops-rowactions">
        <Field label="close it as">
          <SelectInput value={outcome} onChange={(event) => setOutcome(event.target.value)} options={CLOSE_OUTCOMES} />
        </Field>
        <ActionButton
          confirm="close this lead? everything still queued for it is cancelled, and it is not reopened."
          consequence="everything still queued for it is cancelled, and it is not reopened."
          onRun={async () => {
            await recordLeadOutcome(tenantId, lead.id, outcome);
            await onDone();
            return 'closed';
          }}
        >
          close this lead
        </ActionButton>
      </div>
    </div>
  );
}

function SuppressNumber({ tenantId, onDone }) {
  const [number, setNumber] = useState('');
  return (
    <div className="ops-lr__sub">
      <div className="ops-rowactions">
        <Field label="never text this number" hint="E.164, as +16145550137. for a customer who asked a person to stop">
          <TextInput value={number} onChange={(event) => setNumber(event.target.value)} mono placeholder="+16145550137" />
        </Field>
        <ActionButton
          disabled={!number.trim()}
          confirm="add this number to the do-not-contact list? arc will not text it again for this client."
          consequence="arc will not text it again for this client."
          onRun={async () => {
            const result = await suppressLeadContact(tenantId, { address: number.trim() });
            setNumber('');
            await onDone();
            return result.outcome ?? 'added';
          }}
        >
          stop texting it
        </ActionButton>
      </div>
    </div>
  );
}

function UnknownSend({ tenantId, attempt, onDone }) {
  const [sid, setSid] = useState('');
  const settle = (verdict) => async () => {
    const result = await settleUnknownSend(tenantId, attempt.id, { verdict, providerMessageId: sid.trim() || null });
    await onDone();
    return result.outcome;
  };
  return (
    <div className="ops-lr__sub">
      <dl className="ws-facts">
        <Fact label="what">{attempt.kind === 'staff_sms' ? 'an alert to the business' : 'a text to a customer'}</Fact>
        <Fact label="to">{attempt.to ?? '—'}</Fact>
        <Fact label="started">{attempt.started_at ? formatRelative(attempt.started_at) : '—'}</Fact>
      </dl>
      <p className="ops-muted">{attempt.detail ?? 'the provider did not answer'}</p>
      <div className="ops-rowactions">
        <Field label="the provider's message id" hint="optional — SM… from the provider's own log, if it shows one">
          <TextInput value={sid} onChange={(event) => setSid(event.target.value)} mono />
        </Field>
        <ActionButton
          confirm="record this as sent? it is written to the client's record as a text that went out. nothing is resent."
          consequence="it is written to the client's record as a text that went out. nothing is resent."
          onRun={settle('sent')}
        >
          the provider shows it was sent
        </ActionButton>
        <ActionButton
          confirm="record this as not sent? nobody has texted this customer, and the lead stays with a person. nothing is resent."
          consequence="nobody has texted this customer, and the lead stays with a person. nothing is resent."
          onRun={settle('not_sent')}
        >
          the provider shows nothing
        </ActionButton>
      </div>
    </div>
  );
}

function StepToggle({ tenantId, step, onDone }) {
  return (
    <ActionButton
      onRun={async () => {
      const { setLeadRecoveryStep } = await import('../lib/ops');
      await setLeadRecoveryStep(tenantId, step.key, !step.done_at);
      await onDone();
      return step.done_at ? 'reopened' : 'done';
      }}
    >
          {step.done_at ? 'reopen' : 'mark done'}
        </ActionButton>
  );
}

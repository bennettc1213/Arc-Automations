import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { Consequence, Empty, Panel, Pill, Term } from './ui';
import { ActionButton, Field, Notice, SelectInput, TextInput } from './ops-ui';
import {
  applyOnboardingAuthority,
  enableOnboardingCapability,
  getOnboarding,
  saveBusinessProfile,
  saveBusinessService,
  saveOnboarding,
} from '../lib/ops';
import { formatStamp } from '../lib/format';
import {
  CAPABILITIES,
  EXISTING_RECORDS,
  getCapability,
  LIMITS,
  OWNING_CAPABILITIES,
  parseAnswersInput,
  parsePlanInput,
  policyOf,
  recommendPlan,
  REGISTRY_VIEW,
  targetPolicy,
} from '../../../supabase/functions/_shared/onboarding/model.ts';
import { CONNECTORS } from '../../../supabase/functions/_shared/registry/connectors.ts';
import { getRoute, ROUTE_DISCOVERY, ROUTES } from '../../../supabase/functions/_shared/routes/model.ts';
import './OnboardingPanel.css';

/**
 * ARC-390 — putting one client on a route: what they have today, who provides each thing a
 * business does from now on, and what is still missing.
 *
 * The page decides nothing. What the business said and the plan are checked here with the
 * same `parseAnswersInput` and `parsePlanInput` the server runs, so a problem shows while it
 * is typed; the suggestion is `recommendPlan`, computed from the answers on screen and
 * copied into the plan only when somebody presses the button. What each capability *is* —
 * ARC, external, blocked — and whether a step is done are the server's answers, read off
 * what exists, and printed.
 *
 * Saving a plan saves a plan. The route and who keeps each kind of record change on their
 * own tab, behind what the change will do; a module is selected on the client's page and
 * goes live on the activation page.
 */

const TABS = [
  ['steps', 'where it stands'],
  ['stack', 'what they have'],
  ['plan', 'the plan'],
  ['authority', 'route & records'],
  ['business', 'business'],
  ['setup', 'set up & hand over'],
  ['history', 'history'],
];

const STEP_TONE = { done: 'ok', todo: 'neutral', blocked: 'fail', not_needed: 'idle' };
const STEP_WORD = { done: 'done', todo: 'to do', blocked: 'blocked', not_needed: 'not needed' };
const STATE_TONE = { arc: 'ok', external: 'ok', not_needed: 'idle', blocked: 'fail', undecided: 'warn' };
const SOURCE_WORDS = { arc: 'ARC provides it', external: 'their own system', not_needed: 'not part of this setup' };
const RECORD_WORDS = { none: 'no list to bring in', spreadsheet: 'a list in a file or spreadsheet', their_system: 'in a system they are keeping' };
const EVENT_WORDS = {
  answers_saved: 'answers saved',
  plan_saved: 'plan saved',
  route_changed: 'route changed',
  authority_changed: 'where records are kept changed',
  capability_enabled: 'an ARC piece set up',
};
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
/* a step that is done on this page opens one of its tabs. */
const STEP_TAB = { stack: 'stack', route: 'authority', capabilities: 'plan', business: 'business', authority: 'authority', lead_capture: 'setup', booking: 'setup' };
/* what `onboarding-enable` can make, by capability. */
const ENABLES = { lead_pipeline: 'make the pipeline', website_form: 'draft a form', booking: 'draft an appointment type and a booking page' };

/** the systems that could be the other side of a capability: the registry's, minus ARC's own accounts. */
function connectorOptions(capability) {
  return [
    { value: '', label: 'something else — type its name' },
    ...CONNECTORS.filter((c) => capability.providers.includes(c.category) && REGISTRY_VIEW.reach(c.key) !== 'arc_owned').map((c) => ({
      value: c.key,
      label: REGISTRY_VIEW.reach(c.key) === 'none' ? `${c.displayName} (ARC cannot connect to it yet)` : c.displayName,
    })),
  ];
}

const routeTerm = (key) => (key ? <Term k={`route_${key}`}>{getRoute(key)?.name}</Term> : 'no route');
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 40);
/* the database returns an object's keys in its own order: compare what they hold, not how they are listed. */
const stable = (value) =>
  JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

function Problems({ title, errors }) {
  if (!errors?.length) return null;
  return (
    <Notice tone="warn" title={title}>
      <ul className="onb-problems">
        {errors.map((error) => (
          <li key={`${error.field}-${error.message}`}>
            <span className="mono">{error.field}</span> {error.message}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** the tool a business keeps: one the registry has an entry for, or a name. */
function ToolPicker({ capability, value, onChange, disabled }) {
  return (
    <>
      <SelectInput
        aria-label={`${capability.label}: which system`}
        disabled={disabled}
        options={connectorOptions(capability)}
        value={value.connector_key ?? ''}
        onChange={(e) => onChange({ connector_key: e.target.value || null, tool: e.target.value ? null : value.tool })}
      />
      {!value.connector_key && (
        <TextInput
          aria-label={`${capability.label}: what they call it`}
          placeholder="what they call it"
          maxLength={LIMITS.tool}
          disabled={disabled}
          value={value.tool ?? ''}
          onChange={(e) => onChange({ connector_key: null, tool: e.target.value })}
        />
      )}
    </>
  );
}

/* ── where it stands ─────────────────────────────────────── */

function Standing({ data, base, goTo }) {
  const href = { lead_capture: 'intake', workspace: 'crm', activation: 'activation', client: '' };
  return (
    <>
      <p className="onb-summary">
        <b>
          {data.summary.done} of {data.summary.total}
        </b>{' '}
        steps done · {data.summary.gaps === 0 ? 'no gaps' : `${data.summary.gaps} ${data.summary.gaps === 1 ? 'capability' : 'capabilities'} nobody provides yet`} ·{' '}
        {data.plan ? <>planned as {routeTerm(data.plan.route)}</> : 'no plan yet'}
      </p>
      <ol className="onb-steps">
        {data.steps.map((step) => (
          <li key={step.key} className={`onb-step onb-step--${step.status}`}>
            <Pill tone={STEP_TONE[step.status]}>{STEP_WORD[step.status]}</Pill>
            <div>
              <p className="onb-step__label">{step.label}</p>
              <p className="ops-muted">{step.detail}</p>
            </div>
            {step.status !== 'not_needed' &&
              (step.place === 'here' ? (
                <button type="button" className="ws-btn" onClick={() => goTo(STEP_TAB[step.key])}>
                  open
                </button>
              ) : (
                <Link className="ws-btn" to={`${base}/clients/${data.tenant.id}${href[step.place] ? `/${href[step.place]}` : ''}`}>
                  <Icon name="external" size={13} />
                  {step.place === 'lead_capture' ? 'lead capture' : step.place === 'workspace' ? 'lead inbox' : step.place === 'activation' ? 'activation' : 'client page'}
                </Link>
              ))}
          </li>
        ))}
      </ol>
      <p className="ws-note">
        nothing here is ticked by hand. a step is done because the thing exists — the hours are set, the form is published, each record is kept where the
        plan says — so this page reads the same whoever opens it, and whenever.
      </p>
    </>
  );
}

/* ── what they have ──────────────────────────────────────── */

/** the draft as the questionnaire's own shape: a question nobody has asked yet is left out. */
function cleanAnswers(draft) {
  return {
    discovery: Object.fromEntries(Object.entries(draft.discovery).filter(([, value]) => value)),
    tools: Object.fromEntries(
      Object.entries(draft.tools)
        .filter(([, tool]) => tool?.uses)
        .map(([key, tool]) => [
          key,
          tool.uses === 'nothing'
            ? { uses: 'nothing' }
            : { uses: 'own_tool', keep: tool.keep === true, connector_key: tool.connector_key || null, tool: tool.connector_key ? null : tool.tool?.trim() || null },
        ]),
    ),
    existing_records: draft.existing_records || null,
  };
}

function Stack({ tenantId, data, readOnly, onSaved, onUsePlan }) {
  const [draft, setDraft] = useState(() => structuredClone(data.answers));
  const answers = useMemo(() => cleanAnswers(draft), [draft]);
  const checked = useMemo(() => parseAnswersInput(answers), [answers]);
  const suggestion = useMemo(() => recommendPlan(answers), [answers]);
  const setTool = (key, patch) => setDraft((d) => ({ ...d, tools: { ...d.tools, [key]: { ...d.tools[key], ...patch } } }));

  return (
    <>
      <p className="ops-muted">what the business says it has today. these answers suggest a plan and are kept as what was said — they set nothing up.</p>

      <p className="onb-sub">the business</p>
      <div className="ops-form">
        {ROUTE_DISCOVERY.map((question) => (
          <Field key={question.key} label={question.question}>
            <SelectInput
              disabled={readOnly}
              value={draft.discovery[question.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, discovery: { ...d.discovery, [question.key]: e.target.value } }))}
              options={[{ value: '', label: 'not asked yet' }, ...question.options]}
            />
          </Field>
        ))}
        <Field label="Is there a customer list to bring in?">
          <SelectInput
            disabled={readOnly}
            value={draft.existing_records ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, existing_records: e.target.value || null }))}
            options={[{ value: '', label: 'not asked yet' }, ...EXISTING_RECORDS.map((value) => ({ value, label: RECORD_WORDS[value] }))]}
          />
        </Field>
      </div>

      <p className="onb-sub">what they use for each thing</p>
      <ul className="onb-rows">
        {CAPABILITIES.map((capability) => {
          const tool = draft.tools[capability.key] ?? {};
          return (
            <li key={capability.key} className="onb-row">
              <div>
                <p className="onb-row__label">{capability.label}</p>
                <p className="ops-muted">{capability.question}</p>
              </div>
              <div className="onb-row__controls">
                <SelectInput
                  aria-label={`${capability.label}: what they use`}
                  disabled={readOnly}
                  value={tool.uses ?? ''}
                  onChange={(e) => setTool(capability.key, { uses: e.target.value || undefined })}
                  options={[
                    { value: '', label: 'not asked yet' },
                    { value: 'nothing', label: 'nothing in place' },
                    { value: 'own_tool', label: 'a tool of their own' },
                  ]}
                />
                {tool.uses === 'own_tool' && (
                  <>
                    <ToolPicker capability={capability} value={tool} disabled={readOnly} onChange={(patch) => setTool(capability.key, patch)} />
                    <label className="onb-check">
                      <input type="checkbox" disabled={readOnly} checked={tool.keep === true} onChange={(e) => setTool(capability.key, { keep: e.target.checked })} />
                      they want to keep it
                    </label>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Problems title="these answers cannot be saved yet" errors={checked.ok ? [] : checked.errors} />

      {!readOnly && (
        <div className="ops-row">
          <ActionButton
            variant="primary"
            icon="check"
            disabled={!checked.ok}
            consequence="keeps what was said. it sets nothing up and changes no plan."
            onRun={async () => {
              onSaved(await saveOnboarding(tenantId, data.revision, { answers }));
              return 'saved';
            }}
          >
            save the answers
          </ActionButton>
        </div>
      )}

      <p className="onb-sub">what these answers point to</p>
      {!suggestion.complete ? (
        <p className="ops-muted">answer the five questions about the business and a route is suggested here.</p>
      ) : (
        <div className="onb-suggestion">
          <p>
            <b>{routeTerm(suggestion.route)}</b> — {getRoute(suggestion.route).audience}
          </p>
          <ul className="onb-problems">
            {suggestion.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="ops-muted">{suggestion.notice}</p>
          {!readOnly && (
            <button type="button" className="ws-btn" onClick={() => onUsePlan(suggestion.plan)}>
              <Icon name="chevron" size={13} />
              start the plan from this
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ── the plan ────────────────────────────────────────────── */

function cleanPlan(draft) {
  return {
    route: draft.route || null,
    capabilities: Object.fromEntries(
      Object.entries(draft.capabilities)
        .filter(([, choice]) => choice?.source)
        .map(([key, choice]) => [
          key,
          choice.source === 'external'
            ? { source: 'external', connector_key: choice.connector_key || null, tool: choice.connector_key ? null : choice.tool?.trim() || null }
            : { source: choice.source, connector_key: null, tool: null },
        ]),
    ),
  };
}

function Plan({ tenantId, data, draft, setDraft, readOnly, onSaved }) {
  const plan = useMemo(() => cleanPlan(draft), [draft]);
  const checked = useMemo(() => parsePlanInput(plan), [plan]);
  const dirty = stable(plan) !== stable(data.plan ?? { route: null, capabilities: {} });
  const setChoice = (key, patch) => setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, [key]: { ...d.capabilities[key], ...patch } } }));
  const saved = (key) => data.matrix.find((row) => row.capability === key);

  return (
    <>
      <p className="onb-sub">the route</p>
      <div className="onb-routes" role="radiogroup" aria-label="the route">
        {ROUTES.map((route) => (
          <button
            key={route.key}
            type="button"
            role="radio"
            aria-checked={draft.route === route.key}
            disabled={readOnly}
            className={`onb-route${draft.route === route.key ? ' is-on' : ''}`}
            onClick={() => setDraft((d) => ({ ...d, route: route.key }))}
          >
            <b>{route.name}</b>
            <span>{route.situation}</span>
            <span className="ops-muted">{route.audience}</span>
          </button>
        ))}
      </div>

      <p className="onb-sub">who provides each thing</p>
      <ul className="onb-rows">
        {CAPABILITIES.map((capability) => {
          const choice = draft.capabilities[capability.key] ?? {};
          const row = saved(capability.key);
          return (
            <li key={capability.key} className="onb-row">
              <div>
                <p className="onb-row__label">{capability.label}</p>
                <p className="ops-muted">{capability.arc ?? capability.outside}</p>
              </div>
              <div className="onb-row__controls">
                <SelectInput
                  aria-label={`${capability.label}: who provides it`}
                  disabled={readOnly}
                  value={choice.source ?? ''}
                  onChange={(e) => setChoice(capability.key, { source: e.target.value || undefined })}
                  options={[
                    { value: '', label: 'not decided' },
                    ...(capability.arc ? [{ value: 'arc', label: SOURCE_WORDS.arc }] : []),
                    { value: 'external', label: SOURCE_WORDS.external },
                    { value: 'not_needed', label: SOURCE_WORDS.not_needed },
                  ]}
                />
                {choice.source === 'external' && <ToolPicker capability={capability} value={choice} disabled={readOnly} onChange={(patch) => setChoice(capability.key, patch)} />}
              </div>
              <div className="onb-row__state">
                <Pill tone={STATE_TONE[row.state]}>
                  <Term k={`onb_${row.state}`} />
                </Pill>
                <span className="ops-muted">{row.reason}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="ops-muted">the state beside each line is the plan as it was last saved, read against what exists now — not the choices on screen.</p>

      <Problems title="this plan cannot be saved yet" errors={checked.ok ? [] : checked.errors} />

      {!readOnly && (
        <div className="ops-row">
          <ActionButton
            variant="primary"
            icon="check"
            disabled={!checked.ok || !dirty}
            consequence="saves the plan. it selects no module, records no route, connects nothing and moves no record."
            onRun={async () => {
              onSaved(await saveOnboarding(tenantId, data.revision, { plan }));
              return 'saved — the route and where records are kept are applied on their own tab';
            }}
          >
            save the plan
          </ActionButton>
          {dirty && (
            <button type="button" className="ws-btn" onClick={() => setDraft(structuredClone(data.plan ?? { route: '', capabilities: {} }))}>
              discard changes
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ── route & records ─────────────────────────────────────── */

function Authority({ tenantId, data, readOnly, onSaved }) {
  if (!data.plan) return <Empty title="no plan yet">save a plan first. the route and where each record is kept follow from it.</Empty>;
  const { pending, facts } = data;
  const side = (policy) => (policy.authority === 'arc' ? 'ARC' : `${REGISTRY_VIEW.name(policy.connector_key)}${policy.authority === 'hybrid' ? ' (split field by field)' : ''}`);

  return (
    <>
      <div className="ws-tablewrap onb-gap">
        <table className="ws-table ws-table--dense">
          <thead>
            <tr>
              <th>what</th>
              <th>
                <Term k="record_authority">where it is kept</Term> now
              </th>
              <th>the plan says</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>route</td>
              <td>{routeTerm(facts.route)}</td>
              <td>{routeTerm(data.plan.route)}</td>
            </tr>
            {OWNING_CAPABILITIES.map(({ capability, object }) => {
              const choice = data.plan.capabilities[capability];
              return (
                <tr key={object}>
                  <td>{getCapability(capability).noun}</td>
                  <td>{side(policyOf(facts, object))}</td>
                  <td>{choice || data.plan.route === 'native' ? side(targetPolicy(choice)) : 'not decided'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pending.digest ? (
        <>
          <Consequence label="what applying this does">
            {pending.lines.map((line) => (
              <span key={line} className="onb-line">
                {line}
              </span>
            ))}
          </Consequence>
          {!readOnly && (
            <div className="ops-row">
              <ActionButton
                variant="primary"
                icon="check"
                confirm={`apply this to ${data.tenant.name}?\n\n${pending.lines.join('\n\n')}`}
                consequence="records the route and who keeps each kind of record, as listed above. nothing is deleted."
                onRun={async () => {
                  onSaved(await applyOnboardingAuthority(tenantId, pending.digest));
                  return 'applied';
                }}
              >
                apply the route and where records are kept
              </ActionButton>
            </div>
          )}
        </>
      ) : (
        <p className="ops-muted">nothing to apply: the route on record is the plan&rsquo;s, and every record is kept where the plan says.</p>
      )}
      <p className="ws-note">
        if anything a change counts has moved since this page was read, applying it is refused and it is shown again. a change here deletes nothing. handing a kind of record to their system leaves ARC&rsquo;s copy where it is; taking it back leaves every link to
        their system as history. splitting one kind of record field by field is still done on the record&rsquo;s own policy, and is left alone here.
      </p>
    </>
  );
}

/* ── the business ────────────────────────────────────────── */

function Business({ tenantId, data, readOnly, reload }) {
  const profile = data.business.profile ?? {};
  const [form, setForm] = useState(() => ({
    hours: Object.fromEntries(DAYS.map(([key]) => [key, profile.business_hours?.[key] ?? []])),
    public_phone: profile.public_phone ?? '',
    public_email: profile.public_email ?? '',
    website_url: profile.website_url ?? '',
  }));
  const [service, setService] = useState({ name: '', minutes: '', bookable: true });
  const setHours = (key, periods) => setForm((f) => ({ ...f, hours: { ...f.hours, [key]: periods } }));

  return (
    <>
      <p className="ops-muted">
        {data.tenant.name}&rsquo;s name and timezone ({data.tenant.timezone}) are the client&rsquo;s own and are changed on the settings page. this is what no other
        page holds: when they are open, how the public reaches them, and what they sell.
      </p>

      <p className="onb-sub">opening hours</p>
      <ul className="onb-hours">
        {DAYS.map(([key, label]) => {
          const periods = form.hours[key];
          return (
            <li key={key}>
              <label className="onb-check">
                <input type="checkbox" disabled={readOnly} checked={periods.length > 0} onChange={(e) => setHours(key, e.target.checked ? [{ open: '08:00', close: '17:00' }] : [])} />
                {label}
              </label>
              {periods.length === 1 && (
                <>
                  <input className="ops-input" type="time" disabled={readOnly} aria-label={`${label} opens`} value={periods[0].open} onChange={(e) => setHours(key, [{ ...periods[0], open: e.target.value }])} />
                  <input className="ops-input" type="time" disabled={readOnly} aria-label={`${label} closes`} value={periods[0].close} onChange={(e) => setHours(key, [{ ...periods[0], close: e.target.value }])} />
                </>
              )}
              {periods.length > 1 && <span className="ops-muted">{periods.map((p) => `${p.open}–${p.close}`).join(', ')} — kept as they are</span>}
              {periods.length === 0 && <span className="ops-muted">closed</span>}
            </li>
          );
        })}
      </ul>

      <p className="onb-sub">how the public reaches them</p>
      <div className="ops-form">
        <Field label="public phone">
          <TextInput disabled={readOnly} value={form.public_phone} onChange={(e) => setForm((f) => ({ ...f, public_phone: e.target.value }))} />
        </Field>
        <Field label="public email">
          <TextInput type="email" disabled={readOnly} value={form.public_email} onChange={(e) => setForm((f) => ({ ...f, public_email: e.target.value }))} />
        </Field>
        <Field label="website" hint="an https address">
          <TextInput disabled={readOnly} value={form.website_url} onChange={(e) => setForm((f) => ({ ...f, website_url: e.target.value }))} />
        </Field>
      </div>
      {!readOnly && (
        <div className="ops-row">
          <ActionButton
            variant="primary"
            icon="check"
            onRun={async () => {
              await saveBusinessProfile(tenantId, {
                business_hours: Object.fromEntries(Object.entries(form.hours).filter(([, periods]) => periods.length > 0)),
                public_phone: form.public_phone.trim() || null,
                public_email: form.public_email.trim() || null,
                website_url: form.website_url.trim() || null,
              });
              await reload();
              return 'saved';
            }}
          >
            save the profile
          </ActionButton>
        </div>
      )}

      <p className="onb-sub">what they sell</p>
      {data.business.services.length === 0 ? (
        <p className="ops-muted">no services yet. a form and a booking page offer the ones marked bookable.</p>
      ) : (
        <ul className="onb-list">
          {data.business.services.map((item) => (
            <li key={item.id}>
              <b>{item.name}</b>{' '}
              <span className="ops-muted">
                {item.default_duration_minutes ? `${item.default_duration_minutes} min · ` : ''}
                {item.is_bookable ? 'can be asked for online' : 'not offered online'}
                {item.archived_at ? ' · retired' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="ops-form">
          <Field label="add a service">
            <TextInput value={service.name} maxLength={120} placeholder="Furnace repair" onChange={(e) => setService((s) => ({ ...s, name: e.target.value }))} />
          </Field>
          <Field label="usual length (minutes)">
            <TextInput type="number" min={5} max={1440} value={service.minutes} onChange={(e) => setService((s) => ({ ...s, minutes: e.target.value }))} />
          </Field>
          <div className="ops-form__row">
            <label className="onb-check">
              <input type="checkbox" checked={service.bookable} onChange={(e) => setService((s) => ({ ...s, bookable: e.target.checked }))} />a customer can ask for it online
            </label>
            <ActionButton
              icon="plus"
              disabled={slug(service.name).length < 2}
              onRun={async () => {
                await saveBusinessService(tenantId, {
                  key: slug(service.name),
                  name: service.name.trim(),
                  is_bookable: service.bookable,
                  ...(service.minutes ? { default_duration_minutes: Number(service.minutes) } : {}),
                });
                setService({ name: '', minutes: '', bookable: true });
                await reload();
                return 'added';
              }}
            >
              add the service
            </ActionButton>
          </div>
        </div>
      )}
    </>
  );
}

/* ── set up & hand over ──────────────────────────────────── */

function Setup({ tenantId, data, base, readOnly, onSaved }) {
  const { facts } = data;
  const client = `${base}/clients/${data.tenant.id}`;
  const selected = facts.modules.filter((module) => module.state !== 'unselected');
  const mine = data.matrix.filter((row) => row.choice?.source === 'arc');

  return (
    <>
      <p className="onb-sub">the pieces ARC provides</p>
      {mine.length === 0 ? (
        <p className="ops-muted">the saved plan gives nothing to ARC yet.</p>
      ) : (
        <ul className="onb-rows">
          {mine.map((row) => (
            <li key={row.capability} className="onb-row">
              <div>
                <p className="onb-row__label">{row.label}</p>
                <p className="ops-muted">{row.reason}</p>
              </div>
              <div className="onb-row__state">
                <Pill tone={STATE_TONE[row.state]}>
                  <Term k={`onb_${row.state}`} />
                </Pill>
              </div>
              <div className="onb-row__controls">
                {!readOnly && row.state === 'blocked' && ENABLES[row.capability] && (
                  <ActionButton
                    icon="plus"
                    consequence={`${ENABLES[row.capability]}. nothing is published and nothing is switched on.`}
                    onRun={async () => {
                      const next = await enableOnboardingCapability(tenantId, row.capability);
                      onSaved(next);
                      return next.enabled.made.length > 0 ? `made: ${next.enabled.made.join(', ')}` : 'already there — it needs publishing, not making';
                    }}
                  >
                    set it up
                  </ActionButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="onb-sub">where leads come in</p>
      <p className="onb-facts">
        <span>
          <b>{facts.forms.published}</b> of {facts.forms.total} forms published
        </span>
        <span>
          <b>{facts.endpoints}</b> endpoints for their own systems
        </span>
        <span>
          <b>{facts.imports.completed}</b> files imported
        </span>
        <span>
          <b>{facts.booking_pages.published}</b> of {facts.booking_pages.total} booking pages published
        </span>
      </p>
      <div className="ops-row">
        <Link className="ws-btn" to={`${client}/intake`}>
          <Icon name="leads" size={13} />
          lead capture — publish a form, copy its link or frame, import a file, issue an endpoint
        </Link>
        <Link className="ws-btn" to={`${client}/crm`}>
          <Icon name="clients" size={13} />
          lead inbox — pipeline, bookings, linking a record to their system
        </Link>
      </div>

      <p className="onb-sub">hand over to activation</p>
      {selected.length === 0 ? (
        <p className="ops-muted">
          nothing is selected for this client. choosing what ARC runs for them is done on{' '}
          <Link className="ops-inline-link" to={client}>
            their page
          </Link>
          , and selecting never switches anything on.
        </p>
      ) : (
        <ul className="onb-list">
          {selected.map((module) => (
            <li key={module.module_key}>
              <span className="mono">{module.module_key}</span>{' '}
              <Pill tone={module.state === 'active' ? 'ok' : 'neutral'}>
                <Term k={module.state}>{module.state}</Term>
              </Pill>{' '}
              <Link className="ops-inline-link" to={`${client}/activation/${module.module_key}`}>
                connections, readiness, tests, go live
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="ws-note">
        onboarding ends at the hand-over. whether a module may run, be tested, shadow real leads or go live is decided on the activation page and nowhere
        on this one — {data.summary.ready_for_handoff ? 'and nothing on this page is still outstanding.' : `and ${data.summary.outstanding.length} of this page's steps are still open.`}
      </p>
    </>
  );
}

/* ── history ─────────────────────────────────────────────── */

function detailWords(event) {
  const detail = event.detail ?? {};
  if (event.event_type === 'plan_saved') return `${getRoute(detail.route)?.name ?? detail.route}${detail.previous_route && detail.previous_route !== detail.route ? `, was ${getRoute(detail.previous_route)?.name}` : ''}`;
  if (event.event_type === 'route_changed') return `${getRoute(detail.from)?.name ?? 'no route'} → ${getRoute(detail.to)?.name}`;
  if (event.event_type === 'authority_changed') {
    return (detail.changes ?? []).map((c) => `${getCapability(c.capability)?.noun ?? c.object_type}: ${c.to.authority === 'arc' ? 'ARC' : REGISTRY_VIEW.name(c.to.connector_key)} (${c.records})`).join(' · ');
  }
  if (event.event_type === 'capability_enabled') return `${getCapability(detail.capability)?.label ?? detail.capability}: ${(detail.made ?? []).join(', ')}`;
  return `${detail.questions ?? 0} questions, ${detail.capabilities ?? 0} capabilities`;
}

function History({ data, timezone }) {
  if (data.history.length === 0) return <Empty title="nothing has happened yet">every answer saved, plan saved and change applied is listed here with who did it.</Empty>;
  return (
    <div className="ws-tablewrap">
      <table className="ws-table ws-table--dense">
        <thead>
          <tr>
            <th>when</th>
            <th>what</th>
            <th>detail</th>
            <th>who</th>
          </tr>
        </thead>
        <tbody>
          {data.history.map((event) => (
            <tr key={event.id}>
              <td className="mono">{formatStamp(event.occurred_at, timezone)}</td>
              <td>{EVENT_WORDS[event.event_type] ?? event.event_type}</td>
              <td>{detailWords(event)}</td>
              <td className="mono">{String(event.actor_user_id).slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── the panel ───────────────────────────────────────────── */

const planDraft = (plan) => structuredClone(plan ?? { route: '', capabilities: {} });

/**
 * `initial` and `load` exist so the panel can be drawn from a known answer; the console
 * passes neither and the panel reads the server.
 */
export default function OnboardingPanel({ tenantId, base, timezone = 'UTC', readOnly = false, initial = null, load = getOnboarding }) {
  const [state, setState] = useState(initial ? { kind: 'ready', data: initial } : { kind: 'loading' });
  const [tab, setTab] = useState('steps');
  const [draft, setDraft] = useState(() => planDraft(initial?.plan));

  /* a write answers with the whole of where onboarding now stands. the plan on screen follows
     the saved one; the answers tab is remounted on its revision so it does too. */
  const show = useCallback((data) => {
    setState({ kind: 'ready', data });
    setDraft(planDraft(data.plan));
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await load(tenantId);
      setState({ kind: 'ready', data });
      return data;
    } catch (error) {
      setState({ kind: 'error', error });
      return null;
    }
  }, [load, tenantId]);

  useEffect(() => {
    if (initial) return;
    reload().then((data) => data && setDraft(planDraft(data.plan)));
  }, [initial, reload]);

  const note =
    state.kind === 'ready'
      ? `${state.data.summary.done} of ${state.data.summary.total} steps done · ${state.data.summary.gaps} gaps`
      : 'what they have, who provides what, and what is missing';

  return (
    <Panel title="onboarding" note={note}>
      {state.kind === 'loading' && <p className="ops-muted">reading onboarding…</p>}

      {state.kind === 'error' &&
        (state.error?.payload?.error === 'unknown action' || /0028_onboarding/.test(state.error?.message ?? '') ? (
          <Notice tone="warn" title="onboarding is not deployed here yet">
            <p>
              apply <code>0028_onboarding.sql</code>, then redeploy the <code>ops</code> function — this page reads and writes through them.
            </p>
          </Notice>
        ) : (
          <Notice tone="fail" title="onboarding could not be read">
            <p>{state.error?.message ?? 'unknown error'}</p>
          </Notice>
        ))}

      {state.kind === 'ready' && (
        <>
          <nav className="cfg-tabs" aria-label="parts of onboarding">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" className={`ws-btn${key === tab ? ' ws-btn--primary' : ''}`} aria-pressed={key === tab} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'steps' && <Standing data={state.data} base={base} goTo={setTab} />}
          {tab === 'stack' && (
            <Stack
              key={state.data.revision}
              tenantId={tenantId}
              data={state.data}
              readOnly={readOnly}
              onSaved={show}
              onUsePlan={(plan) => {
                setDraft(planDraft(plan));
                setTab('plan');
              }}
            />
          )}
          {tab === 'plan' && <Plan tenantId={tenantId} data={state.data} draft={draft} setDraft={setDraft} readOnly={readOnly} onSaved={show} />}
          {tab === 'authority' && <Authority tenantId={tenantId} data={state.data} readOnly={readOnly} onSaved={show} />}
          {tab === 'business' && <Business key={state.data.business.profile?.updated_at ?? 'new'} tenantId={tenantId} data={state.data} readOnly={readOnly} reload={reload} />}
          {tab === 'setup' && <Setup tenantId={tenantId} data={state.data} base={base} readOnly={readOnly} onSaved={show} />}
          {tab === 'history' && <History data={state.data} timezone={timezone} />}
        </>
      )}
    </Panel>
  );
}

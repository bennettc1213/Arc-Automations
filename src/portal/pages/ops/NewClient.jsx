import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Panel, Pill } from '../../components/ui';
import {
  ActionButton,
  CopyValue,
  Field,
  Notice,
  SelectInput,
  TextArea,
  TextInput,
} from '../../components/ops-ui';
import { ServicePicker } from '../../components/BuildPanel';
import { ModulePicker, PickedRequirements } from '../../components/ModuleSelection';
import { createTenant, linkClientAccount, mintToken } from '../../lib/ops';
import { addClientServices, buildProgress, STAGE } from '../../lib/builds';
import { SERVICE_BY_KEY } from '../../lib/service-catalog';
import { generateClientId, slugify } from '../../lib/client-id';
import { parseTenantInput } from '../../../../supabase/functions/_shared/tenants/model.ts';

/**
 * onboarding a client, in the order it actually happens.
 *
 * the ID is generated before anything is saved and shown at the size you read it
 * aloud from, because that is when it is used: you are on the phone, you are
 * telling them what it is, and an ID that only exists after a successful insert
 * cannot be part of that conversation. regenerating it is one click and costs
 * nothing — nothing has been written yet.
 *
 * arc sells services, not hours, so what they bought is chosen here too and the
 * account cannot be saved without at least one. each service is written with its
 * build checklist straight after the account, and the checklists live on the
 * client's page from then on.
 *
 * the steps after the save are separate buttons rather than one "create
 * everything" action. each one touches a different system, each can fail on its
 * own, and a single button that half-worked would leave you guessing which half.
 *
 * the account itself is one server action (ARC-300, `tenant-create`): the tenant, the
 * modules chosen here selected — configuring, never switched on — and the audit row, in one
 * transaction. the form is checked by the same `parseTenantInput` the server runs, so a
 * problem shows against its field as it is typed; the server checks again regardless and
 * its field errors land in the same place.
 */

/* the form's fields, as the server names them. */
function toWire(form, clientId, slug) {
  return {
    name: form.name,
    slug,
    client_id: clientId,
    company: form.company,
    timezone: form.timezone,
    status: form.status,
    plan: form.plan,
    notes: form.notes,
    login_email: form.loginEmail,
    contact_name: form.contactName,
    contact_phone: form.contactPhone,
  };
}

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `create-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const TIMEZONES = [
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Chicago',
  'America/New_York',
  'UTC',
].map((zone) => ({ value: zone, label: zone }));

const STATUS_OPTIONS = [
  { value: 'onboarding', label: 'onboarding' },
  { value: 'active', label: 'active' },
  { value: 'paused', label: 'paused' },
];

export default function NewClient({ base, clients, allClients, reload, initial = {} }) {
  const [clientId, setClientId] = useState(generateClientId);
  const [created, setCreated] = useState(null);
  const [freshToken, setFreshToken] = useState(null);
  const [services, setServices] = useState(initial.services ?? []);
  const [modules, setModules] = useState(initial.modules ?? []);
  /* one per form: a double press, or a retry after the connection dropped mid-save,
     returns the client already created instead of making a second. */
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [serverErrors, setServerErrors] = useState(initial.serverErrors ?? []);
  const [form, setForm] = useState({
    name: '',
    company: '',
    slug: '',
    status: 'onboarding',
    plan: '',
    timezone: 'America/Denver',
    loginEmail: '',
    contactName: '',
    contactPhone: '',
    notes: '',
    ...initial.form,
  });

  const set = (key) => (event) => {
    const { value } = event.target;
    setForm((prev) => ({ ...prev, [key]: value }));
    setServerErrors([]);
  };

  /* the slug follows the name until somebody types their own, at which point it
     stops following. a field that silently overwrites what you typed into it is a
     field you learn not to trust. */
  const slug = form.slug.trim() || slugify(form.name);
  /* the handle is unique across every tenant row, archived ones included — a
     deboarded client still holds its slug in the database — so this checks the
     full roster, not just the ones the sidebar shows as current. */
  const slugTaken = (allClients ?? clients).some((client) => client.tenant.slug === slug);

  /* the server's own check, run here as the operator types. a field shows its problem
     once there is something in it — an empty form is not a page of red. */
  const wire = toWire(form, clientId, slug);
  const check = parseTenantInput(wire);
  const fieldError = (field) =>
    serverErrors.find((error) => error.field === field)?.message ??
    (check.ok || !wire[field] ? null : check.errors.find((error) => error.field === field)?.message ?? null);
  const moduleErrors = serverErrors.filter((error) => error.field.startsWith('modules'));
  const canSave = check.ok && !slugTaken && services.length > 0;
  const stepCount = services.reduce((sum, key) => sum + (SERVICE_BY_KEY.get(key)?.steps.length ?? 0), 0);

  const welcome = useMemo(
    () =>
      [
        `your arc portal is ready.`,
        ``,
        `client id: ${clientId}`,
        `sign in:   ${window.location.origin}/login`,
        ``,
        `enter the id and we email a sign-in link to ${form.loginEmail || 'your address on file'}.`,
        `no password to remember. the link lasts an hour; request another any time.`,
      ].join('\n'),
    [clientId, form.loginEmail],
  );

  if (created) {
    /* read back from the roster rather than from what was picked, so this lists
       what was actually written. */
    const createdBuilds = clients.find((client) => client.tenant.id === created.id)?.builds ?? null;

    return (
      <>
        <Notice tone="warn" title={`${created.name} is in the system`}>
          <p>
            the account exists and its client id is live. two things still have to happen before
            they can actually use it — both are below, and neither runs automatically because
            each one touches a different system and can fail on its own.
          </p>
        </Notice>

        {created.legacy && (
          <Notice tone="fail" title="created the old way — no module was selected and nothing was audited">
            <p>
              the <code>ops</code> function deployed here predates module selection, so the account
              was written straight from the browser. redeploy <code>ops</code> and apply{' '}
              <code>0021_ops_tenant_creation.sql</code>, then choose their modules on their page.
            </p>
          </Notice>
        )}

        {!created.legacy && (
          <Panel title="their modules" note={created.lifecycles.length ? `${created.lifecycles.length} selected` : 'none chosen'}>
            {created.lifecycles.length > 0 ? (
              <ul className="bld-created">
                {created.lifecycles.map((lifecycle) => (
                  <li key={lifecycle.module_key}>
                    <span>{lifecycle.module_key}</span>
                    <Pill tone="idle">{lifecycle.state}</Pill>
                    <span className="mono">not switched on — activation is its own gate</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ops-muted">no module was chosen. give them one from their page when it is sold.</p>
            )}
          </Panel>
        )}

        <Panel title="their client id" note="hand this over">
          <div className="ops-idcard">
            <div>
              <div className="ops-idcard__val">{created.clientId}</div>
              <div className="ops-idcard__meta" style={{ marginTop: 12 }}>
                <span>account: {created.slug}</span>
                <span>timezone: {created.timezone}</span>
              </div>
            </div>
            <div className="ops-idcard__actions">
              <CopyValue value={created.clientId} label="id" />
              <CopyValue value={welcome} label="welcome text" mono={false} display="the wording, ready to paste" />
            </div>
          </div>
        </Panel>

        <Panel title="step one — let them in" note="invites the address and links it to this tenant">
          <p className="ops-muted">
            a client id selects the account; the sign-in link still has to go somewhere. this
            invites <span className="mono">{created.loginEmail || 'the address'}</span> into auth
            if it has no account yet, then attaches it to this tenant as owner.
          </p>
          <div className="ops-row" style={{ marginTop: 14 }}>
            <ActionButton
              variant="primary"
              icon="link"
              disabled={!created.loginEmail}
              onRun={async () => {
                const result = await linkClientAccount(created.id, created.loginEmail);
                await reload();
                return result.invited
                  ? `invited ${result.linked} — they have an email to accept`
                  : `${result.linked} can sign in now`;
              }}
            >
              link the account
            </ActionButton>
            {!created.loginEmail && (
              <span className="ops-field__hint">
                no sign-in address was set. add one on the client page first.
              </span>
            )}
          </div>
        </Panel>

        <Panel title="step two — let the pipeline write" note="a bearer token for n8n">
          <p className="ops-muted">
            n8n posts events with a per-tenant token rather than a supabase key, so a
            compromised workflow can write events for this client and nothing else. the raw
            value is shown once and never stored.
          </p>

          {freshToken ? (
            <div className="ops-secret" style={{ marginTop: 14 }}>
              <span className="ops-secret__label">copy this now — it is not stored anywhere</span>
              <div className="ops-secret__val">{freshToken}</div>
              <CopyValue value={freshToken} label="token" />
            </div>
          ) : (
            <div className="ops-row" style={{ marginTop: 14 }}>
              <ActionButton
                variant="primary"
                icon="plus"
                onRun={async () => {
                  const { raw } = await mintToken(created.id, `${created.slug} n8n`);
                  setFreshToken(raw);
                }}
              >
                mint their ingest token
              </ActionButton>
            </div>
          )}
        </Panel>

        <Panel
          title="step three — build what they bought"
          note={
            createdBuilds
              ? `${createdBuilds.length} service${createdBuilds.length === 1 ? '' : 's'} · ${createdBuilds.reduce(
                  (sum, build) => sum + build.steps.length,
                  0,
                )} steps`
              : 'not saved'
          }
        >
          {created.servicesError ? (
            <>
              <Notice tone="fail" title="the account was saved, but its services were not">
                <p>
                  {created.servicesError}. nothing is half-written — the services and their
                  checklists go in together or not at all — so it is safe to try again.
                </p>
              </Notice>
              <div className="ops-row" style={{ marginTop: 14 }}>
                <ActionButton
                  variant="primary"
                  icon="refresh"
                  onRun={async () => {
                    await addClientServices(created.id, created.serviceKeys);
                    await reload();
                    setCreated((prev) => ({ ...prev, servicesError: null }));
                  }}
                >
                  save the services again
                </ActionButton>
              </div>
            </>
          ) : (
            <>
              <p className="ops-muted">
                each service has its checklist on {created.name}&rsquo;s page: build it on arc&rsquo;s
                side, then integrate it into their business. tick it off there as the work gets done
                — steps can be added or removed for this client without touching anyone else&rsquo;s.
              </p>
              {createdBuilds && createdBuilds.length > 0 && (
                <ul className="bld-created" style={{ marginTop: 14 }}>
                  {createdBuilds.map((build) => {
                    const progress = buildProgress(build);
                    return (
                      <li key={build.id}>
                        <span>{build.name}</span>
                        <Pill tone={STAGE[progress.stage].tone}>{STAGE[progress.stage].label}</Pill>
                        <span className="mono">
                          {progress.build.total} build · {progress.integrate.total} integrate
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </Panel>

        <Panel title="then">
          <div className="ops-row">
            <Link className="ws-btn ws-btn--primary" to={`${base}/clients/${created.id}`}>
              <Icon name="chevron" size={13} />
              open {created.name}&rsquo;s checklist
            </Link>
            <button
              type="button"
              className="ws-btn"
              onClick={() => {
                setCreated(null);
                setFreshToken(null);
                setServices([]);
                setModules([]);
                setServerErrors([]);
                setIdempotencyKey(newKey());
                setClientId(generateClientId());
                setForm((prev) => ({
                  ...prev,
                  name: '',
                  company: '',
                  slug: '',
                  loginEmail: '',
                  contactName: '',
                  contactPhone: '',
                  notes: '',
                }));
              }}
            >
              <Icon name="plus" size={13} />
              add another
            </button>
          </div>
          <p className="ws-note">
            declare what they are wired to on their client page — the n8n instance, the twilio
            number, the workflow ids. that is what turns the connections page from a list into a
            check.
          </p>
        </Panel>
      </>
    );
  }

  return (
    <>
      <Panel title="their client id" note="generated here, saved with the account">
        <div className="ops-idcard">
          <div>
            <div className="ops-idcard__val">{clientId}</div>
            <div className="ops-idcard__meta" style={{ marginTop: 12 }}>
              <span>40 bits, crockford base32 — no i, l, o or u</span>
              <span>this is what they type at /login</span>
            </div>
          </div>

          <div className="ops-idcard__actions">
            <CopyValue value={clientId} label="id" />
            <button type="button" className="ws-btn" onClick={() => setClientId(generateClientId())}>
              <Icon name="refresh" size={13} />
              generate another
            </button>
          </div>
        </div>

        <p className="ws-note">
          nothing is written until you save, so regenerate as many as you like. the database
          enforces uniqueness on top of this — a collision at 40 bits is not going to happen,
          and it is handled anyway.
        </p>
      </Panel>

      <Panel
        title="what we’re building"
        note={
          services.length
            ? `${services.length} service${services.length === 1 ? '' : 's'} · ${stepCount} steps to deliver`
            : 'choose at least one'
        }
      >
        <p className="ops-muted" style={{ marginBottom: 14 }}>
          what they bought. each service comes with its checklist — build it on arc&rsquo;s side,
          then integrate it into their business — and more can be added from their page later.
        </p>
        <ServicePicker
          selected={services}
          onToggle={(key) =>
            setServices((prev) => (prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]))
          }
        />
      </Panel>

      <Panel
        title="which modules"
        note={modules.length ? `${modules.length} selected — none switched on` : 'optional'}
      >
        <p className="ops-muted" style={{ marginBottom: 14 }}>
          what arc will run for them, from the module registry. choosing one selects it —
          configuring — and nothing more: it goes live only after its own activation checks pass on
          their page. planned modules are listed so you can see what is coming, and cannot be chosen.
        </p>
        <ModulePicker
          selected={modules}
          onToggle={(key) => {
            setServerErrors([]);
            setModules((prev) => (prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]));
          }}
        />
        {moduleErrors.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <Notice tone="fail" title="a module could not be given to them">
              <ul>
                {moduleErrors.map((error) => (
                  <li key={error.field}>{error.message}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <PickedRequirements selected={modules} />
        </div>
      </Panel>

      <Panel
        title="the account"
        actions={
          <ActionButton
            variant="primary"
            icon="check"
            disabled={!canSave}
            title={services.length === 0 ? 'choose at least one service first' : undefined}
            onRun={async () => {
              let result;
              try {
                result = await createTenant({ tenant: check.value, modules, idempotencyKey });
              } catch (error) {
                /* every field the server refused, against its field — the button shows the
                   same list as one line. */
                setServerErrors(error.payload?.field_errors ?? []);
                throw error;
              }
              const tenant = result.tenant;
              /* the account is real from here. if the services fail to save, the
                 page still moves on and says so, with a retry — sending the
                 operator back to a form whose account already exists would get
                 the next press refused as a duplicate handle. */
              let servicesError = null;
              try {
                await addClientServices(tenant.id, services);
              } catch (error) {
                servicesError = error.message;
              }
              await reload();
              setCreated({ ...tenant, legacy: result.legacy, lifecycles: result.lifecycles, serviceKeys: services, servicesError });
              return null;
            }}
          >
            create the account
          </ActionButton>
        }
      >
        <div className="ops-form">
          <Field label="business name" required hint={fieldError('name')}>
            <TextInput
              value={form.name}
              onChange={set('name')}
              placeholder="cascade restoration"
              autoFocus
            />
          </Field>

          <Field label="company" hint={fieldError('company') ?? 'if it trades under a different name'}>
            <TextInput value={form.company} onChange={set('company')} placeholder="optional" />
          </Field>

          <Field
            label="account handle"
            hint={
              fieldError('slug') ??
              (slugTaken
                ? 'another client already uses this handle'
                : 'used in exports and support email. follows the name unless you set it.')
            }
          >
            <TextInput
              mono
              value={form.slug}
              onChange={set('slug')}
              placeholder={slugify(form.name) || 'cascade-restoration'}
            />
          </Field>

          <Field label="status">
            <SelectInput options={STATUS_OPTIONS} value={form.status} onChange={set('status')} />
          </Field>

          <Field
            label="timezone"
            hint={fieldError('timezone') ?? 'every date and figure in their portal renders in this zone'}
          >
            <SelectInput options={TIMEZONES} value={form.timezone} onChange={set('timezone')} />
          </Field>

          <Field label="plan" hint={fieldError('plan')}>
            <TextInput value={form.plan} onChange={set('plan')} placeholder="pilot, retainer…" />
          </Field>

          <Field
            label="sign-in address"
            hint={fieldError('login_email') ?? 'where their sign-in link goes. without it the client id cannot let them in.'}
          >
            <TextInput
              type="email"
              value={form.loginEmail}
              onChange={set('loginEmail')}
              placeholder="owner@company.com"
            />
          </Field>

          <Field label="contact name" hint={fieldError('contact_name')}>
            <TextInput value={form.contactName} onChange={set('contactName')} placeholder="who you deal with" />
          </Field>

          <Field label="phone" hint={fieldError('contact_phone')}>
            <TextInput value={form.contactPhone} onChange={set('contactPhone')} placeholder="(801) 555-0134" />
          </Field>

          <Field label="notes" wide hint={fieldError('notes')}>
            <TextArea
              value={form.notes}
              onChange={set('notes')}
              placeholder="what they do, what they signed up for, anything worth remembering"
            />
          </Field>
        </div>
      </Panel>

      <Panel title="what this writes">
        <p className="ops-muted">
          one server action, in one transaction: the row in <code>public.tenants</code> with the
          client id above, each chosen module selected in <code>tenant_modules</code> with its
          first history row (configuring — never active), the <code>tenant created</code> step of
          its activation checklist, and who created it, in <code>tenant_creations</code> and the
          audit log. then one row in <code>client_services</code> per service chosen, each with its
          checklist in <code>client_service_steps</code>. no events, no connections, no token, no
          n8n workflow — those come next, each is its own step, and no client ever gets a workflow
          of their own. the account will
          show in the roster immediately with zeroes against it, which is correct: nothing has
          happened for them yet, and a new client showing invented activity would be the one
          unrecoverable lie in a product sold on only printing what it can prove.
        </p>
      </Panel>
    </>
  );
}

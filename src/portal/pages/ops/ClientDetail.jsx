import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import Icon from '../../components/Icon';
import EventFeed from '../../components/EventFeed';
import { Empty, Panel, Pill, Sparkline, StatCard } from '../../components/ui';
import {
  ActionButton,
  CheckList,
  CopyValue,
  Fact,
  Field,
  Help,
  LivenessPill,
  Notice,
  PipelinePill,
  SelectInput,
  TenantStatus,
  TextArea,
  TextInput,
} from '../../components/ops-ui';
import ConnectionForm from '../../components/ConnectionForm';
import ServicesPanel from '../../components/ServicesPanel';
import ReportDialog from '../../components/ReportDialog';
import {
  CONNECTION_KINDS,
  DEBOARD_REASONS,
  connectionLiveness,
  deboardClient,
  deleteConnection,
  linkClientAccount,
  listTokens,
  mintToken,
  reissueClientId,
  restoreClient,
  revokeToken,
  updateClient,
} from '../../lib/ops';
import { formatMoney, integrationFor } from '../../lib/integrations';
import { functionUrl } from '../../lib/supabase';
import { site } from '../../../data/site';
import {
  formatCount,
  formatDuration,
  formatRelative,
  formatStamp,
  formatUptime,
} from '../../lib/format';

/**
 * one client, all the way down.
 *
 * four questions, in the order they get asked: can they get in, what are their
 * numbers doing, what are they wired to, and is any of it still sending. the page
 * is laid out in that order and nothing else is on it.
 *
 * the numbers are the client's own dashboard object, not a summary of it — the
 * same `data` their sign-in renders. so "how is this client doing" is answered
 * with the figures they would quote back, which is the only version of that
 * answer worth having in a conversation with them.
 */

/* no "archived" here. picking it from a dropdown used to archive a client while
   leaving their tokens valid and their login attached — a past client whose n8n
   could still write events. taking someone out of the system is the deboard panel
   at the foot of this page, which does all of it at once. */
const STATUS_OPTIONS = [
  { value: 'onboarding', label: 'onboarding' },
  { value: 'active', label: 'active' },
  { value: 'paused', label: 'paused' },
];

const RESTORE_OPTIONS = [
  { value: 'paused', label: 'restore as paused' },
  { value: 'onboarding', label: 'restore as onboarding' },
  { value: 'active', label: 'restore as active' },
];

const FEED_THREADS = 12;

function seedForm(tenant) {
  return {
    name: tenant.name,
    company: tenant.company ?? '',
    status: tenant.status,
    plan: tenant.plan ?? '',
    timezone: tenant.timezone,
    loginEmail: tenant.loginEmail ?? '',
    contactName: tenant.contactName ?? '',
    contactPhone: tenant.contactPhone ?? '',
    notes: tenant.notes ?? '',
  };
}

/**
 * resolves the client, then hands off to a body keyed on its id.
 *
 * the key is doing real work. the form below is seeded once, from state, and then
 * owned by the page — because re-seeding it whenever the roster refreshes would
 * wipe half-typed edits out from under whoever was typing them, which is the worst
 * bug an admin form can have. but navigating from one client to the next does not
 * remount this component, so without the key the second client would open showing
 * the first one's details in the fields. remounting on identity change is the fix,
 * and it is one line rather than an effect that re-seeds on some changes and not
 * others.
 */
export default function ClientDetail({ allClients, base, reload, probe, runProbe }) {
  const { tenantId } = useParams();
  const client = allClients.find((entry) => entry.tenant.id === tenantId);

  if (!client) {
    return (
      <Empty title="no such client">
        that account is not in the roster.{' '}
        <Link className="ops-inline-link" to={`${base}/clients`}>
          back to the list
        </Link>
        .
      </Empty>
    );
  }

  return (
    <ClientBody
      key={client.tenant.id}
      client={client}
      base={base}
      reload={reload}
      probe={probe}
      runProbe={runProbe}
    />
  );
}

function ClientBody({ client, base, reload, probe, runProbe }) {
  const { tenant, data } = client;
  const archived = tenant.status === 'archived';
  /* what the deboard just did, kept here rather than in the panel that did it:
     the panel disappears the moment the reload says this client is archived. */
  const [deboarded, setDeboarded] = useState(null);
  const [restoreTo, setRestoreTo] = useState('paused');

  const [form, setForm] = useState(() => seedForm(tenant));
  const [tokens, setTokens] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [freshToken, setFreshToken] = useState(null);
  /* one form for the whole page, whichever table or card opened it. `integration`
     is set when it was opened by a connect button, so the form can say what to do
     in the tab that just opened. */
  const [editing, setEditing] = useState(null);
  const [reporting, setReporting] = useState(false);
  const servicesRef = useRef(null);

  const openEditor = (connection, integration = null, connecting = false) => {
    setEditing({ connection, integration, connecting });
    window.requestAnimationFrame(() =>
      servicesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  useEffect(() => {
    let live = true;
    listTokens(tenant.id)
      .then((rows) => live && setTokens(rows))
      .catch((error) => live && setTokenError(error.message));
    return () => {
      live = false;
    };
  }, [tenant.id]);

  const events = useMemo(() => data.threads ?? [], [data]);

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const since = DateTime.fromISO(tenant.createdAt, { zone: 'utc' }).setZone(tenant.timezone);
  const activeTokens = (tokens ?? []).filter((token) => !token.revokedAt);

  /* the welcome text, ready to paste into an email. written out in full here rather
     than left as "send them their id" because the wording is part of the product:
     it is the first thing a client reads about how to get in, and it should say the
     same thing every time. */
  const welcome = [
    `your arc portal is ready.`,
    ``,
    `client id: ${tenant.clientId}`,
    `sign in:   ${window.location.origin}/login`,
    ``,
    `enter the id and we email a sign-in link to ${tenant.loginEmail || 'your address on file'}.`,
    `no password to remember. the link lasts an hour; request another any time.`,
  ].join('\n');

  return (
    <>
      <div className="ops-head">
        <div className="ops-head__main">
          <Link className="ops-back" to={`${base}/clients`}>
            <Icon name="back" size={12} /> all clients
          </Link>

          <h2 className="ops-head__name">{tenant.name}</h2>

          <div className="ops-head__sub">
            {archived ? (
              <Pill tone="idle">past client</Pill>
            ) : (
              <>
                <TenantStatus status={tenant.status} />
                <PipelinePill verdict={client.pipeline} />
              </>
            )}
            <span className="mono" style={{ color: 'var(--faint)' }}>
              {tenant.timezone}
            </span>
            <span className="mono" style={{ color: 'var(--faint)' }}>
              since {since.toFormat('LLL d, yyyy')}
            </span>
          </div>
        </div>

        <div className="ops-head__actions">
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => setReporting(true)}>
            <Icon name="reports" size={13} />
            generate report
          </button>

          {tenant.loginEmail && !archived && (
            <a
              className="ws-btn"
              href={`mailto:${tenant.loginEmail}?subject=${encodeURIComponent(
                `your arc portal — ${tenant.name}`,
              )}&body=${encodeURIComponent(welcome)}`}
            >
              <Icon name="mail" size={13} />
              email their id
            </a>
          )}
        </div>
      </div>

      {reporting && <ReportDialog client={client} onClose={() => setReporting(false)} />}

      {archived && (
        <div className="ops-archived">
          <div className="ops-archived__text">
            <p className="ops-archived__title">
              <Icon name="archive" size={18} />
              past client
            </p>
            <p className="ops-archived__body">
              {tenant.archivedAt
                ? `deboarded ${formatStamp(tenant.archivedAt, tenant.timezone)}`
                : 'archived before deboarding was recorded'}
              {' · '}
              {tenant.archiveReason ?? 'no reason recorded'}
              {tenant.archiveNote ? ` — ${tenant.archiveNote}` : ''}. their tokens are revoked,
              nobody can sign in to this account and nothing it was wired to is marked connected.
              every event is kept, so the numbers below and any report are still their real
              history.
            </p>
          </div>

          <div className="ops-archived__actions">
            <SelectInput
              options={RESTORE_OPTIONS}
              value={restoreTo}
              onChange={(event) => setRestoreTo(event.target.value)}
              aria-label="status to restore to"
            />
            <ActionButton
              icon="refresh"
              confirm={`bring ${tenant.name} back onto the books as ${restoreTo}? their old tokens stay revoked and nobody regains access until you mint a token and link the account again.`}
              onRun={async () => {
                const result = await restoreClient(tenant.id, restoreTo);
                setDeboarded(null);
                await reload();
                return `restored as ${result.status} — mint a token and link the account to reconnect them`;
              }}
            >
              restore
            </ActionButton>
            <Link className="ws-btn" to={`${base}/past-clients`}>
              <Icon name="archive" size={13} />
              all past clients
            </Link>
          </div>
        </div>
      )}

      {deboarded && (
        <Notice tone="ok" title={`${tenant.name} is now a past client`}>
          <p>
            {formatCount(deboarded.tokens_revoked)} token{deboarded.tokens_revoked === 1 ? '' : 's'}{' '}
            revoked · {formatCount(deboarded.members_removed)} login
            {deboarded.members_removed === 1 ? '' : 's'} removed from the account
            {deboarded.logins_deleted ? ` (${deboarded.logins_deleted} deleted from auth)` : ''} ·{' '}
            {formatCount(deboarded.connections_retired)} connection
            {deboarded.connections_retired === 1 ? '' : 's'} retired
            {deboarded.logged === false ? ' · the audit write failed' : ''}.
          </p>
          {deboarded.logins_kept?.length > 0 && (
            <p>
              kept {deboarded.logins_kept.length} login
              {deboarded.logins_kept.length === 1 ? '' : 's'}:{' '}
              {deboarded.logins_kept.map((login) => login.why).join('; ')}.
            </p>
          )}
        </Notice>
      )}

      {!archived && client.pipeline && (
        <Panel
          title="pipeline — live check"
          note={
            client.pipeline.evidence === 'live'
              ? `checked ${formatStamp(probe.result.checked_at, DateTime.local().zoneName)}`
              : client.pipeline.evidence === 'events'
                ? 'from the event log'
                : 'checking…'
          }
          actions={
            <button
              type="button"
              className="ws-btn"
              onClick={runProbe}
              disabled={probe?.kind === 'checking'}
            >
              <Icon name="pulse" size={13} />
              {probe?.kind === 'checking' ? 'checking…' : 'check again'}
            </button>
          }
          bare
        >
          <div className="ops-live__head">
            <PipelinePill verdict={client.pipeline} />
            <p className="ops-live__summary">
              {client.pipeline.state === 'connected'
                ? 'every check passed — events can get from their n8n into this portal right now.'
                : client.pipeline.state === 'checking'
                  ? 'asking the ingest endpoint and n8n…'
                  : client.pipeline.summary}
            </p>
          </div>

          <CheckList checks={client.pipeline.checks} />

          {probe?.kind === 'error' && (
            <div style={{ padding: 'var(--panel-pad)', paddingTop: 0 }}>
              <Notice tone="warn" title="the live check could not run">
                <p>
                  {probe.error}.{' '}
                  {probe.result
                    ? 'the rows above are from the last check that did.'
                    : 'the rows above are judged from the event log and tokens instead, so they cannot say whether a workflow is switched on in n8n.'}
                </p>
              </Notice>
            </div>
          )}

          {probe?.result && !probe.result.n8n?.configured && (
            <p className="ws-note" style={{ padding: '0 var(--panel-pad) var(--panel-pad)' }}>
              workflows are not being asked about: set <code>N8N_API_URL</code> and{' '}
              <code>N8N_API_KEY</code> as secrets on the <code>ops</code> function and this panel also
              says whether each workflow is switched on and how its last run went.
            </p>
          )}
        </Panel>
      )}

      {!archived && !tenant.loginEmail && (
        <Notice tone="warn" title="this client cannot sign in yet">
          <p>
            a client id selects the account; the sign-in link still has to go somewhere. add
            the address below and press <b>link the account</b> — that invites it into auth and
            attaches it to this tenant in one step.
          </p>
        </Notice>
      )}

      <div className="ws-stats">
        <StatCard
          label="leads · 30d"
          value={data.metrics.leadsLast30Days}
          animate
          format={formatCount}
          delta={data.deltas.leads}
          deltaLabel="vs prev 30d"
          tone="lead"
        >
          <Sparkline points={data.leadsPerDay.map((day) => day.leads)} />
        </StatCard>

        <StatCard
          label="median response"
          value={
            data.metrics.medianResponseMs === null
              ? '—'
              : formatDuration(data.metrics.medianResponseMs)
          }
          compact
          delta={data.deltas.medianResponseMs}
          deltaLabel="vs prev 30d"
          sub={`${formatCount(data.metrics.sends)} texts sent`}
        />

        <StatCard
          label="checks passing"
          value={data.metrics.uptimePct === null ? '—' : formatUptime(data.metrics.uptimePct)}
          compact
          sub={
            data.reliability.lastCheckAt
              ? `last check ${formatRelative(data.reliability.lastCheckAt, tenant.timezone)}`
              : 'no end-to-end checks yet'
          }
        />

        <StatCard
          label="last event"
          value={
            client.lastEventAt ? formatRelative(client.lastEventAt, tenant.timezone) : 'never'
          }
          compact
          sub={`${formatCount(client.eventCount)} in the loaded window`}
        />
      </div>

      {/* ── identity & access ───────────────────────────────── */}

      <Panel title="client id" note="what they type to sign in">
        <div className="ops-idcard">
          <div>
            <div className="ops-idcard__val">{tenant.clientId ?? 'none'}</div>
            <div className="ops-idcard__meta" style={{ marginTop: 12 }}>
              <span>account: {tenant.slug ?? tenant.id}</span>
              <span>
                sign-in link goes to {tenant.loginEmail || 'nowhere yet — no address on file'}
              </span>
            </div>
          </div>

          <div className="ops-idcard__actions">
            {tenant.clientId && <CopyValue value={tenant.clientId} label="id" />}

            <ActionButton
              icon="refresh"
              confirm={`reissue the client id for ${tenant.name}? the current one stops working immediately and they will need the new one to sign in.`}
              onRun={async () => {
                const updated = await reissueClientId(tenant.id);
                await reload();
                return `new id ${updated.clientId}`;
              }}
            >
              reissue
            </ActionButton>
          </div>
        </div>

        <p className="ws-note">
          the id is not a password. it selects the account, and the sign-in link still has to
          land in a mailbox somebody controls — so an id read over the phone or forwarded in an
          email is not, on its own, access. reissue it anyway if it ends up somewhere public.
        </p>
      </Panel>

      <div className="ws-two">
        <Panel
          title="account"
          note="edits save to the tenant row"
          actions={
            <ActionButton
                variant="primary"
                icon="check"
                onRun={async () => {
                  await updateClient(tenant.id, {
                    name: form.name.trim(),
                    company: form.company.trim() || null,
                    status: form.status,
                    plan: form.plan.trim() || null,
                    timezone: form.timezone.trim(),
                    login_email: form.loginEmail.trim().toLowerCase() || null,
                    contact_name: form.contactName.trim() || null,
                    contact_phone: form.contactPhone.trim() || null,
                    notes: form.notes.trim() || null,
                    onboarded_at:
                      form.status === 'active' && !tenant.onboardedAt
                        ? new Date().toISOString()
                        : tenant.onboardedAt,
                  });
                  await reload();
                  return 'saved';
                }}
              >
              save
            </ActionButton>
          }
        >
          <div className="ops-form">
              <Field label="name" required>
                <TextInput value={form.name} onChange={set('name')} />
              </Field>

              <Field label="company">
                <TextInput value={form.company} onChange={set('company')} placeholder="optional" />
              </Field>

              {!archived && (
                <Field label="status" hint="a label you set — the pipeline check above is what is measured">
                  <SelectInput options={STATUS_OPTIONS} value={form.status} onChange={set('status')} />
                </Field>
              )}

              <Field label="plan">
                <TextInput value={form.plan} onChange={set('plan')} placeholder="pilot, retainer…" />
              </Field>

              <Field
                label="timezone"
                hint="every date and figure in their portal renders in this zone"
              >
                <TextInput mono value={form.timezone} onChange={set('timezone')} />
              </Field>

              <Field label="sign-in address" hint="where their sign-in link is sent">
                <TextInput
                  type="email"
                  value={form.loginEmail}
                  onChange={set('loginEmail')}
                  placeholder="owner@company.com"
                />
              </Field>

              <Field label="contact name">
                <TextInput value={form.contactName} onChange={set('contactName')} />
              </Field>

              <Field label="phone">
                <TextInput value={form.contactPhone} onChange={set('contactPhone')} />
              </Field>

              <Field label="notes" wide>
                <TextArea value={form.notes} onChange={set('notes')} placeholder="anything worth remembering about this account" />
              </Field>

              {!archived && (
              <div className="ops-form__row">
                <ActionButton
                  icon="link"
                  disabled={!form.loginEmail.trim()}
                  onRun={async () => {
                    const result = await linkClientAccount(tenant.id, form.loginEmail.trim());
                    await reload();
                    return result.invited
                      ? `invited ${result.linked} — they have an email to accept`
                      : `${result.linked} is linked and can sign in now`;
                  }}
                  title="invites the address if it has no account, then attaches it to this tenant"
                >
                  link the account
                </ActionButton>

                <span className="ops-field__hint" style={{ maxWidth: '46ch' }}>
                  needs the <code>ops</code> edge function deployed. it is the only step that
                  touches auth, which is why it does not run in the browser.
                </span>
              </div>
              )}
          </div>
        </Panel>

        <Panel title="what they see" note="their dashboard object, unmodified">
          <dl className="ws-facts">
            <Fact label="leads this month">
              <span className="mono">{formatCount(data.metrics.leadsThisMonth)}</span>
            </Fact>
            <Fact label="leads · 30d">
              <span className="mono">{formatCount(data.metrics.leadsLast30Days)}</span>
            </Fact>
            <Fact label="p90 response" note="nine in ten answered at least this fast">
              <span className="mono">
                {data.metrics.p90ResponseMs === null
                  ? '—'
                  : formatDuration(data.metrics.p90ResponseMs)}
              </span>
            </Fact>
            <Fact label="missed calls answered">
              <span className="mono">{formatCount(data.metrics.missedCallsAnswered)}</span>
            </Fact>
            <Fact label="history loaded" note="metrics are computed over the last 30 of these">
              <span className="mono">{formatCount(data.coverageDays)} days</span>
            </Fact>
            <Fact label="open incidents">
              <span className="mono">
                {formatCount(data.incidents.filter((incident) => incident.open).length)}
              </span>
            </Fact>
            <Fact label="sources sending">
              {data.sources.length === 0 ? (
                <span style={{ color: 'var(--faint)' }}>none in the window</span>
              ) : (
                data.sources.map((source) => source.label).join(', ')
              )}
            </Fact>
          </dl>

          <p className="ws-note">
            these are not a summary of their dashboard — they are their dashboard, computed by
            the same code behind their sign-in. if a figure here looks wrong, it is wrong on
            their screen too.
          </p>
        </Panel>
      </div>

      {/* ── services & subscriptions ────────────────────────── */}

      <div ref={servicesRef} className="ops-anchor">
        <ServicesPanel
          client={client}
          reload={reload}
          editing={Boolean(editing)}
          onEdit={(connection, integration) =>
            openEditor(connection, integration, !connection.id)
          }
          form={
            editing && (
              <ConnectionForm
                key={editing.connection.id ?? `new-${editing.connection.provider ?? 'other'}`}
                connection={editing.connection}
                intro={
                  editing.connecting &&
                  editing.integration && (
                    <Notice tone="ok" title={`${editing.integration.name} opened in a new tab`}>
                      <p>
                        sign in or create the account there, set up billing and make a key. then
                        come back and record it here: the account, the key&apos;s last four,
                        what it costs and when it renews. set declared status to{' '}
                        <b>connected</b> once it is wired in.
                      </p>
                    </Notice>
                  )
                }
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null);
                  await reload();
                }}
              />
            )
          }
        />
      </div>

      {/* ── connections ─────────────────────────────────────── */}

      <Panel
        title="connections & servers"
        note={`${client.connections.length} declared`}
        actions={
          <button
            type="button"
            className="ws-btn"
            onClick={() => openEditor({ tenantId: tenant.id, kind: 'n8n', status: 'planned' })}
          >
            <Icon name="plus" size={13} />
            add a connection
          </button>
        }
        bare
      >

        {client.connections.length === 0 ? (
          <Empty title="nothing declared yet">
            record the n8n instance, the twilio number and anything else this client's
            automation touches. the console then checks each one against the event log and
            tells you which have gone quiet.
          </Empty>
        ) : (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th className="ws-table__wide">connection</th>
                  <th>kind</th>
                  <th>
                    marked as
                    <Help>what you set on this connection by hand. it checks nothing.</Help>
                  </th>
                  <th>
                    actually sending
                    <Help>
                      read from the event log: has this workflow id sent anything, and recently
                      enough for how often it normally runs.
                    </Help>
                  </th>
                  <th>last seen</th>
                  <th className="ws-table__num">runs</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {client.connections.map((connection) => {
                  const liveness = connectionLiveness(
                    connection,
                    client.workflowActivity,
                    DateTime.now(),
                  );
                  return (
                    <tr className="ws-table__row" key={connection.id}>
                      <td>
                        <span className="ops-client">
                          <span className="ops-client__name">{connection.label}</span>
                          {connection.endpoint && (
                            <span className="ops-client__id">{connection.endpoint}</span>
                          )}
                        </span>
                      </td>
                      <td className="ws-table__sub">
                        {CONNECTION_KINDS.find((k) => k.value === connection.kind)?.label ??
                          connection.kind}
                      </td>
                      <td className="ws-table__sub">{connection.status}</td>
                      <td>
                        <LivenessPill liveness={liveness} />
                      </td>
                      <td className="ws-table__sub">
                        {liveness.lastAt
                          ? formatRelative(liveness.lastAt, tenant.timezone)
                          : '—'}
                      </td>
                      <td className="ws-table__num">{formatCount(liveness.runs)}</td>
                      <td>
                        <div className="ops-row">
                          <button
                            type="button"
                            className="ws-btn"
                            onClick={() => openEditor(connection)}
                            title="edit"
                          >
                            <Icon name="edit" size={12} />
                          </button>
                          <ActionButton
                            icon="trash"
                            confirm={`remove "${connection.label}"? this only forgets that we declared it — no events are deleted.`}
                            onRun={async () => {
                              await deleteConnection(connection.id);
                              await reload();
                            }}
                          >
                            remove
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="ws-note">
          <b>declared</b> is what we said we wired up. <b>observed</b> is what the event log
          says has actually run, matched on workflow id. a connection marked connected that
          has not sent anything in days is the most useful row on this page — and it is only
          possible to spot because the two columns are allowed to disagree.
        </p>
      </Panel>

      {/* ── pipeline tokens ─────────────────────────────────── */}

      <Panel
        title="ingest tokens"
        note={tokens === null ? 'loading…' : `${activeTokens.length} active`}
        actions={
          <ActionButton
            icon="plus"
            onRun={async () => {
              const { token, raw } = await mintToken(tenant.id, `${tenant.slug ?? 'client'} n8n`);
              setTokens((prev) => [token, ...(prev ?? [])]);
              setFreshToken(raw);
            }}
          >
            mint a token
          </ActionButton>
        }
        bare
      >
        {freshToken && (
          <div className="ops-secret" style={{ margin: 'var(--panel-pad)' }}>
            <span className="ops-secret__label">copy this now — it is not stored anywhere</span>
            <div className="ops-secret__val">{freshToken}</div>
            <div className="ops-row">
              <CopyValue value={freshToken} label="token" />
              <button type="button" className="ws-btn" onClick={() => setFreshToken(null)}>
                done
              </button>
            </div>
            <p className="ops-secret__note">
              only a SHA-256 of this value went to the database, which is the same digest the
              ingest function looks it up by. there is no way to recover it — if it is lost,
              revoke the token and mint another.
            </p>
          </div>
        )}

        {tokenError && (
          <div style={{ padding: 'var(--panel-pad)' }}>
            <Notice tone="fail" title="could not read the tokens">
              <p>
                {tokenError}. if this says the table is not readable, migration{' '}
                <code>0003_client_ids_and_ops.sql</code> has not been applied — 0001 left
                <code>ingest_tokens</code> with row level security on and no policy at all.
              </p>
            </Notice>
          </div>
        )}

        {tokens !== null && tokens.length === 0 && !tokenError && (
          <Empty title="no tokens yet">
            n8n posts events with a per-tenant bearer token rather than a supabase key, so a
            compromised workflow can write events for this client and nothing else.
          </Empty>
        )}

        {tokens !== null && tokens.length > 0 && (
          <div className="ws-tablewrap">
            <table className="ws-table ws-table--dense">
              <thead>
                <tr>
                  <th className="ws-table__wide">label</th>
                  <th>state</th>
                  <th>created</th>
                  <th>last used</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr className="ws-table__row" key={token.id}>
                    <td className="ws-table__strong">{token.label ?? 'unlabelled'}</td>
                    <td>
                      {/* "active" only ever meant "not revoked", and said nothing about
                          whether n8n had posted with it. the last-use stamp is the
                          evidence, so the state is read off it. */}
                      {token.revokedAt ? (
                        <Pill tone="idle">revoked</Pill>
                      ) : token.lastUsedAt ? (
                        <Pill tone="ok">in use</Pill>
                      ) : (
                        <Pill tone="warn">never used</Pill>
                      )}
                    </td>
                    <td className="ws-table__sub">
                      {formatStamp(token.createdAt, tenant.timezone)}
                    </td>
                    <td className="ws-table__sub">
                      {token.lastUsedAt
                        ? formatRelative(token.lastUsedAt, tenant.timezone)
                        : 'never used'}
                    </td>
                    <td>
                      {!token.revokedAt && (
                        <ActionButton
                          icon="trash"
                          confirm="revoke this token? anything posting with it stops being accepted immediately."
                          onRun={async () => {
                            await revokeToken(token.id);
                            setTokens((prev) =>
                              prev.map((row) =>
                                row.id === token.id
                                  ? { ...row, revokedAt: new Date().toISOString() }
                                  : row,
                              ),
                            );
                          }}
                        >
                          revoke
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ padding: 'var(--panel-pad)', display: 'grid', gap: 10 }}>
          <span className="ops-field__label">what n8n posts to</span>
          <CopyValue value={functionUrl('ingest')} label="url" />
          <p className="ws-note" style={{ marginTop: 0 }}>
            an HTTP Request node, POST, with <code>Authorization: Bearer &lt;token&gt;</code> and a
            body of <code>{'{ "event_type": "lead_received", "occurred_at": "…" }'}</code>. send an{' '}
            <code>event_key</code> too and retries stop double-counting leads.
          </p>
        </div>
      </Panel>

      {/* ── their feed ──────────────────────────────────────── */}

      <Panel title="recent activity" note="their feed, as they see it" bare>
        {events.length === 0 ? (
          <Empty title="nothing has come through yet">
            no client-visible event has been recorded for {tenant.name}.{' '}
            {client.connections.length === 0
              ? 'nothing is declared as connected either — that is consistent, not broken.'
              : 'something is declared as connected, so this is worth chasing.'}
          </Empty>
        ) : (
          <EventFeed
            threads={events.slice(0, FEED_THREADS)}
            timezone={tenant.timezone}
            live={false}
            title={`${tenant.name} · activity`}
          />
        )}
      </Panel>

      <Panel title="get in touch">
        <div className="ops-row">
          {tenant.loginEmail && (
            <a className="ws-btn" href={`mailto:${tenant.loginEmail}`}>
              <Icon name="mail" size={13} />
              {tenant.loginEmail}
            </a>
          )}
          {tenant.contactPhone && (
            <a className="ws-btn" href={`tel:${tenant.contactPhone.replace(/[^\d+]/g, '')}`}>
              <Icon name="phone" size={13} />
              {tenant.contactPhone}
            </a>
          )}
          <CopyValue value={welcome} label="welcome text" mono={false} display="the wording, ready to paste" />
        </div>
        <p className="ws-note">
          the welcome text is the wording a client first reads about getting in. it is stored
          here rather than retyped each time so every client is told the same thing — from{' '}
          {site.brand}.
        </p>
      </Panel>

      {!archived && (
        <DeboardPanel
          client={client}
          tokens={tokens}
          reload={reload}
          onDone={(result) => {
            setDeboarded(result);
            /* the token table was read when the page opened; every row in it has
               just been revoked, so read it again rather than show them live. */
            listTokens(tenant.id)
              .then(setTokens)
              .catch((error) => setTokenError(error.message));
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </>
  );
}

/**
 * taking a client out of the system.
 *
 * closed until asked for, and then a form rather than a button, because the
 * button's consequences are worth reading before they happen: the list of what
 * will change is computed from this client's own tokens and connections, not
 * written generically. the confirmation is typing their name — the one thing
 * that cannot be done by reflex on the wrong client's page.
 *
 * what it deliberately does not do is on the list too. it cancels nothing that
 * costs money, because the console has never held a billing key for any of those
 * accounts; the subscriptions arc pays for are listed with a link to each
 * provider's billing page, so ending them is one click away rather than
 * something remembered a month later from an invoice.
 */
function DeboardPanel({ client, tokens, reload, onDone }) {
  const { tenant, connections } = client;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [deleteLogins, setDeleteLogins] = useState(false);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState({ kind: 'idle' });

  const activeTokens = tokens === null ? null : tokens.filter((token) => !token.revokedAt).length;
  const wired = connections.filter((connection) => connection.status !== 'retired');
  const arcPays = connections.filter(
    (connection) =>
      connection.paidBy === 'arc' && ['active', 'trial', 'past_due'].includes(connection.billingStatus),
  );

  const confirmed = typed.trim().toLowerCase() === tenant.name.trim().toLowerCase();
  const ready = Boolean(reason) && confirmed && state.kind !== 'busy';

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    setState({ kind: 'busy' });
    try {
      const result = await deboardClient({ tenantId: tenant.id, reason, note, deleteLogins });
      await reload();
      onDone(result);
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }

  return (
    <Panel
      title="deboard this client"
      note="take them out of the system — their history is kept"
      className="ops-danger"
      actions={
        !open && (
          <button type="button" className="ws-btn" onClick={() => setOpen(true)}>
            <Icon name="exit" size={13} />
            start deboarding
          </button>
        )
      }
    >
      {!open ? (
        <p className="ops-muted">
          when an engagement ends: cuts off their pipeline and their sign-in in one step, and moves
          them to <b>past clients</b>. nothing is deleted, and they can be restored.
        </p>
      ) : (
        <form onSubmit={submit}>
          <ul className="ops-danger__list">
            <li>
              <i>1</i>
              <span>
                <b>
                  {activeTokens === null
                    ? 'every ingest token is revoked'
                    : `${activeTokens} ingest token${activeTokens === 1 ? ' is' : 's are'} revoked`}
                </b>{' '}
                — n8n&rsquo;s next post for this client is refused, so nothing more lands in their
                account.
              </span>
            </li>
            <li>
              <i>2</i>
              <span>
                <b>sign-in access is removed</b>
                {tenant.loginEmail ? ` for ${tenant.loginEmail}` : ''} — their client id stops
                working and any open session reads nothing.
              </span>
            </li>
            <li>
              <i>3</i>
              <span>
                <b>
                  {wired.length} connection{wired.length === 1 ? ' is' : 's are'} marked retired
                </b>
                {wired.length > 0 ? ` — ${wired.map((connection) => connection.label).join(', ')}` : ''}.
              </span>
            </li>
            <li>
              <i>4</i>
              <span>
                <b>they move to past clients</b>, with the reason below. events, incidents and
                reports stay exactly as they are.
              </span>
            </li>
          </ul>

          {arcPays.length > 0 && (
            <Notice tone="warn" title="cancel what arc pays for yourself">
              <p>
                deboarding does not cancel any subscription. these are marked paid by arc and still
                running:
              </p>
              <ul className="ops-danger__list" style={{ margin: '8px 0 0' }}>
                {arcPays.map((connection) => {
                  const billingUrl = integrationFor(connection)?.billingUrl;
                  return (
                    <li key={connection.id}>
                      <i>·</i>
                      <span>
                        <b>{connection.label}</b>
                        {connection.costCents ? ` · ${formatMoney(connection.costCents)}` : ''}
                        {billingUrl && (
                          <>
                            {' — '}
                            <a href={billingUrl} target="_blank" rel="noreferrer">
                              open billing
                            </a>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Notice>
          )}

          <div className="ops-form" style={{ marginTop: 16 }}>
            <Field label="why they are leaving" required>
              <SelectInput
                options={[
                  { value: '', label: 'choose a reason…' },
                  ...DEBOARD_REASONS.map((value) => ({ value, label: value })),
                ]}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>

            <Field label="note" hint="kept with the record on the past clients page" wide>
              <TextArea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="anything worth knowing if they come back"
              />
            </Field>

            <label className="ops-check ops-field--wide">
              <input
                type="checkbox"
                checked={deleteLogins}
                onChange={(event) => setDeleteLogins(event.target.checked)}
              />
              <span>
                also delete their login from supabase auth. a login that belongs to another client, or
                to an operator, is always kept.
              </span>
            </label>

            <Field label={`type ${tenant.name} to confirm`} required wide>
              <TextInput
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck="false"
                placeholder={tenant.name}
              />
            </Field>
          </div>

          {state.kind === 'error' && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="fail" title="nothing was changed">
                <p>{state.message}</p>
              </Notice>
            </div>
          )}

          <div className="ops-row" style={{ marginTop: 16 }}>
            <button type="submit" className="ws-btn ws-btn--danger" disabled={!ready}>
              <Icon name="exit" size={13} />
              {state.kind === 'busy' ? 'deboarding…' : `deboard ${tenant.name}`}
            </button>
            <button
              type="button"
              className="ws-btn"
              onClick={() => {
                setOpen(false);
                setState({ kind: 'idle' });
              }}
              disabled={state.kind === 'busy'}
            >
              cancel
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

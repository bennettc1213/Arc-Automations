import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import Icon from '../../components/Icon';
import EventFeed from '../../components/EventFeed';
import { Empty, Panel, Sparkline, StatCard } from '../../components/ui';
import {
  ActionButton,
  CopyValue,
  Fact,
  Field,
  LivenessPill,
  Notice,
  PipelineStatus,
  SelectInput,
  TenantStatus,
  TextArea,
  TextInput,
} from '../../components/ops-ui';
import ConnectionForm from '../../components/ConnectionForm';
import {
  CONNECTION_KINDS,
  connectionLiveness,
  deleteConnection,
  linkClientAccount,
  listTokens,
  mintToken,
  reissueClientId,
  revokeToken,
  updateClient,
} from '../../lib/ops';
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

const STATUS_OPTIONS = [
  { value: 'onboarding', label: 'onboarding' },
  { value: 'active', label: 'active' },
  { value: 'paused', label: 'paused' },
  { value: 'archived', label: 'archived' },
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
export default function ClientDetail({ clients, base, reload }) {
  const { tenantId } = useParams();
  const client = clients.find((entry) => entry.tenant.id === tenantId);

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

  return <ClientBody key={client.tenant.id} client={client} base={base} reload={reload} />;
}

function ClientBody({ client, base, reload }) {
  const { tenant, data } = client;

  const [form, setForm] = useState(() => seedForm(tenant));
  const [tokens, setTokens] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [freshToken, setFreshToken] = useState(null);
  const [editing, setEditing] = useState(null);

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
            <TenantStatus status={tenant.status} />
            <PipelineStatus status={data.status} />
            <span className="mono" style={{ color: 'var(--faint)' }}>
              {tenant.timezone}
            </span>
            <span className="mono" style={{ color: 'var(--faint)' }}>
              since {since.toFormat('LLL d, yyyy')}
            </span>
          </div>
        </div>

        <div className="ops-head__actions">
          {tenant.loginEmail && (
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

      {!tenant.loginEmail && (
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

              <Field label="status">
                <SelectInput options={STATUS_OPTIONS} value={form.status} onChange={set('status')} />
              </Field>

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

      {/* ── connections ─────────────────────────────────────── */}

      <Panel
        title="connections & servers"
        note={`${client.connections.length} declared`}
        actions={
          <button
            type="button"
            className="ws-btn"
            onClick={() => setEditing({ tenantId: tenant.id, kind: 'n8n', status: 'planned' })}
          >
            <Icon name="plus" size={13} />
            add a connection
          </button>
        }
        bare
      >
        {editing && (
          <ConnectionForm
            connection={editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await reload();
            }}
          />
        )}

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
                  <th>declared</th>
                  <th>observed</th>
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
                            onClick={() => setEditing(connection)}
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
                    <td className="ws-table__sub">{token.revokedAt ? 'revoked' : 'active'}</td>
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
    </>
  );
}

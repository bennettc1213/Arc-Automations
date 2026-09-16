import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Panel, Pill } from './ui';
import { ActionButton } from './ops-ui';
import { patchConnection } from '../lib/ops';
import {
  INTEGRATIONS,
  billingState,
  billingTotals,
  connectionsFor,
  formatMoney,
  integrationFor,
  keysUrlFor,
  nextRenewal,
  observedFor,
} from '../lib/integrations';
import { formatRelative } from '../lib/format';

/**
 * what a client's automation is signed up to, and whether it is still paid for.
 *
 * two halves. the table is the accounts that exist: which service, whose account,
 * which key (by its last four), what it costs and when it next charges. the grid
 * underneath is every service the console knows how to wire, each saying
 * connected or connect — and connect opens that provider's own sign-up in a new
 * tab while the form to record what came back opens here, so nothing typed is
 * lost to a redirect.
 *
 * the billing column is what was typed, not what the provider says. none of these
 * accounts are queried — most are the client's, and holding a billing-scoped key
 * for each would be a far larger thing to protect than a renewal date is worth.
 * so a renewal date that has passed asks to be confirmed rather than announcing a
 * lapse, and "mark paid" rolls it forward one cycle.
 */

const DECLARED_TONE = { connected: 'ok', planned: 'neutral', paused: 'warn', retired: 'idle' };

const CYCLE_SUFFIX = { monthly: '/mo', annual: '/yr', usage: ' est/mo' };

function Monogram({ name }) {
  const letters = name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2);
  return (
    <span className="ops-svc__mono" aria-hidden="true">
      {letters}
    </span>
  );
}

export default function ServicesPanel({ client, editing, onEdit, form, reload }) {
  const { tenant, connections } = client;
  const zone = tenant.timezone;
  const now = DateTime.now();

  const accounts = connections
    .map((connection) => ({
      connection,
      integration: integrationFor(connection),
      billing: billingState(connection, zone, now),
    }))
    .filter(
      (row) => row.integration || row.connection.billingStatus !== 'none' || row.connection.accountRef,
    )
    .sort((a, b) => a.billing.rank - b.billing.rank);

  const totals = billingTotals(connections);
  /* connected means either declared connected or proven by the event log. */
  const connectedCount = INTEGRATIONS.filter(
    (integration) =>
      connectionsFor(integration, connections).some((c) => c.status === 'connected') ||
      observedFor(integration, client.workflowActivity),
  ).length;

  const trouble = accounts.filter((row) => row.billing.tone === 'fail').length;

  /* the service is already running — nothing to sign up for, only a row to write. */
  function record(integration) {
    onEdit({
      tenantId: tenant.id,
      provider: integration.key,
      kind: integration.kind,
      label: integration.name,
      status: 'connected',
      credentialLocation: integration.keyStore,
    });
  }

  function connect(integration) {
    window.open(integration.connectUrl, '_blank', 'noopener,noreferrer');
    onEdit(
      {
        tenantId: tenant.id,
        provider: integration.key,
        kind: integration.kind,
        label: integration.name,
        status: 'planned',
        credentialLocation: integration.keyStore,
      },
      integration,
    );
  }

  return (
    <Panel
      title="services & subscriptions"
      note={
        `${connectedCount} connected` +
        (totals.tracked ? ` · ${formatMoney(totals.monthly)}/mo${totals.hasUsage ? ' est' : ''}` : '') +
        (trouble ? ` · ${trouble} need attention` : '')
      }
      bare
    >
      {editing && form}

      {accounts.length === 0 ? (
        <Empty title="no accounts recorded">
          nothing this client runs on has an account or a subscription on file yet. connect a
          service below — it opens the provider in a new tab and a form here for what you set up.
        </Empty>
      ) : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense">
            <thead>
              <tr>
                <th className="ws-table__wide">service</th>
                <th>declared</th>
                <th>key</th>
                <th>subscription</th>
                <th className="ws-table__num">cost</th>
                <th>paid by</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map(({ connection, integration, billing }) => {
                const billingUrl = integration?.billingUrl;
                const keysUrl = keysUrlFor(integration, connection);
                const canRenew =
                  ['active', 'past_due'].includes(connection.billingStatus) &&
                  ['monthly', 'annual'].includes(connection.billingCycle);

                return (
                  <tr
                    className={`ws-table__row${
                      billing.tone === 'fail'
                        ? ' ops-row--down'
                        : billing.tone === 'warn'
                          ? ' ops-row--attention'
                          : ''
                    }`}
                    key={connection.id}
                  >
                    <td>
                      <span className="ops-client">
                        <span className="ops-client__name">
                          {integration ? `${integration.name} · ` : ''}
                          {connection.label}
                        </span>
                        <span className="ops-client__id">
                          {connection.accountRef || connection.endpoint || 'no account on file'}
                        </span>
                      </span>
                    </td>
                    <td>
                      <Pill tone={DECLARED_TONE[connection.status] ?? 'neutral'}>
                        {connection.status}
                      </Pill>
                    </td>
                    <td className="ws-table__sub">
                      {connection.credentialHint ? (
                        <span className="ops-client">
                          <span className="mono">•••• {connection.credentialHint}</span>
                          <span className="ops-client__id">
                            {connection.verifiedAt
                              ? `checked ${formatRelative(connection.verifiedAt, zone)}`
                              : connection.credentialLocation || 'never checked'}
                          </span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <Pill tone={billing.tone}>{billing.label}</Pill>
                    </td>
                    <td className="ws-table__num">
                      {connection.costCents == null
                        ? '—'
                        : `${formatMoney(connection.costCents)}${
                            CYCLE_SUFFIX[connection.billingCycle] ?? ''
                          }`}
                    </td>
                    <td className="ws-table__sub">{connection.paidBy ?? '—'}</td>
                    <td>
                      <div className="ops-row ops-row--tight">
                        {canRenew && (
                          <ActionButton
                            icon="check"
                            title="record this cycle as paid and roll the renewal date forward"
                            onRun={async () => {
                              const renewsAt = nextRenewal(connection, zone);
                              await patchConnection(connection.id, {
                                billing_status: 'active',
                                renews_at: renewsAt,
                              });
                              await reload();
                            }}
                          >
                            paid
                          </ActionButton>
                        )}
                        {connection.credentialHint && (
                          <ActionButton
                            icon="refresh"
                            title="you just confirmed this key still works"
                            onRun={async () => {
                              await patchConnection(connection.id, {
                                verified_at: new Date().toISOString(),
                              });
                              await reload();
                            }}
                          >
                            key ok
                          </ActionButton>
                        )}
                        {billingUrl && (
                          <a
                            className="ws-btn"
                            href={billingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${integration.name} billing`}
                          >
                            <Icon name="external" size={12} />
                            billing
                          </a>
                        )}
                        {keysUrl && (
                          <a
                            className="ws-btn"
                            href={keysUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${integration.name} api keys`}
                          >
                            <Icon name="external" size={12} />
                            keys
                          </a>
                        )}
                        <button
                          type="button"
                          className="ws-btn"
                          onClick={() => onEdit(connection, integration)}
                          title="edit"
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totals.tracked > 0 && (
        <div className="ops-svc__totals">
          <span>
            <b>{formatMoney(totals.monthly)}</b>/mo across {totals.tracked} subscription
            {totals.tracked === 1 ? '' : 's'}
            {totals.hasUsage ? ' (usage-based ones estimated)' : ''}
          </span>
          <span>arc pays {formatMoney(totals.arc)}/mo</span>
          <span>client pays {formatMoney(totals.client)}/mo</span>
        </div>
      )}

      <div className="ops-svc">
        <p className="ops-connform__section">connect a service</p>
        <div className="ops-svc__grid">
          {INTEGRATIONS.map((integration) => {
            const rows = connectionsFor(integration, connections);
            const best = rows[0];
            const billing = best ? billingState(best, zone, now) : null;
            const observed = observedFor(integration, client.workflowActivity);
            const on = best?.status === 'connected' || Boolean(observed);

            return (
              <div
                className={`ops-svc__card${on ? ' ops-svc__card--on' : ''}`}
                key={integration.key}
              >
                <div className="ops-svc__top">
                  <Monogram name={integration.name} />
                  <span className="ops-svc__name">
                    {integration.name}
                    <span className="ops-svc__cat">{integration.category}</span>
                  </span>
                </div>

                <p className="ops-svc__blurb">
                  {integration.blurb}
                  {observed && (
                    <span className="ops-svc__proof">
                      {observed.workflows} workflow{observed.workflows === 1 ? '' : 's'} ·{' '}
                      {observed.runs.toLocaleString('en-US')} events · last{' '}
                      {formatRelative(observed.lastAt, zone)}
                      {!best && ' · not recorded yet'}
                    </span>
                  )}
                </p>

                <div className="ops-svc__foot">
                  {best ? (
                    <>
                      <Pill
                        tone={observed ? 'ok' : (DECLARED_TONE[best.status] ?? 'neutral')}
                        title={observed && best.status !== 'connected' ? `declared ${best.status}, but it is sending` : undefined}
                      >
                        {observed ? 'connected' : best.status}
                      </Pill>
                      {billing && billing.tone !== 'idle' && (
                        <Pill tone={billing.tone}>{billing.label}</Pill>
                      )}
                      <button
                        type="button"
                        className="ws-btn ops-svc__btn"
                        onClick={() => onEdit(best, integration)}
                      >
                        manage
                      </button>
                    </>
                  ) : observed ? (
                    <>
                      <Pill tone="ok">connected</Pill>
                      <button
                        type="button"
                        className="ws-btn ops-svc__btn"
                        onClick={() => record(integration)}
                        title="it is already sending — record the account, key and billing"
                      >
                        <Icon name="plus" size={12} />
                        record it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ws-btn ws-btn--primary ops-svc__btn"
                      onClick={() => connect(integration)}
                      title={`opens ${integration.name} in a new tab`}
                    >
                      <Icon name="link" size={12} />
                      connect
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

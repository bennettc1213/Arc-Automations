import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { Empty, Panel, Pill, StatCard } from '../../components/ui';
import { Field, Notice } from '../../components/ops-ui';
import { acknowledgeAlert, raiseAlert, resolveAlert } from '../../lib/ops';
import { formatCount, formatSpan, formatStamp } from '../../lib/format';

/**
 * the write path for the only mutable table in the schema.
 *
 * `alerts` has had a select policy and an admin update policy since the first
 * migration, and the reliability page has been rendering incidents from it the
 * whole time — but nothing anywhere inserted a row. A client-facing page
 * promised "the hourly end-to-end check fails, we get paged, and the incident
 * appears on your reliability page" against a table that could not have
 * contents. This page is the half of that promise that lives in this repo.
 *
 * The other half does not exist yet and this page says so rather than implying
 * otherwise. Detection — the poller that sweeps for tenants that have gone quiet
 * and raises the alert without anybody watching — is Phase 2. Until it ships,
 * every row here got here because a human noticed, and an operator reading this
 * page should know that about it.
 *
 * Acknowledge and resolve go through the edge function even though the admin
 * update policy would allow them straight from the browser. Routing them through
 * the function is what puts them in the audit log.
 */

const CHECK_TYPES = [
  { key: 'canary', label: 'canary', blurb: 'the end-to-end check did not come out the far end' },
  { key: 'watermark', label: 'watermark', blurb: 'expected volume did not arrive in the window' },
  { key: 'schema', label: 'schema', blurb: 'a payload arrived in the wrong shape' },
];

const SEVERITIES = ['critical', 'warning', 'info'];

export default function Alerts({ clients, base, reload }) {
  const [tenantId, setTenantId] = useState('');
  const [checkType, setCheckType] = useState('canary');
  const [severity, setSeverity] = useState('critical');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  /* every client's incidents in one list. the per-client reliability page shows
     one tenant's; an operator wants to know what is on fire anywhere. */
  const rows = useMemo(() => {
    const now = DateTime.now();
    return clients
      .flatMap((client) =>
        client.data.incidents.map((incident) => ({
          incident,
          client,
          ageMs: now.diff(DateTime.fromISO(incident.firedAt, { zone: 'utc' })).milliseconds,
        })),
      )
      .sort((a, b) => {
        // open first, then newest. an operator opens this to find what is live.
        if (a.incident.open !== b.incident.open) return a.incident.open ? -1 : 1;
        return b.incident.firedAt.localeCompare(a.incident.firedAt);
      });
  }, [clients]);

  const open = rows.filter((row) => row.incident.open);
  const unacknowledged = open.filter((row) => !row.incident.acknowledgedAt);

  async function run(label, fn) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const result = await fn();
      /* the function reports whether the audit row landed. an action that
         succeeded without being logged is not a failure to show the operator as
         an error, but it is not a silence either. */
      setDone(result?.logged === false ? `${label} — done, but the audit write failed` : `${label} — done`);
      await reload?.();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(null);
    }
  }

  const canRaise = tenantId && message.trim().length > 0;

  return (
    <>
      {unacknowledged.length > 0 && (
        <Notice tone="fail" title={`${unacknowledged.length} open, unacknowledged`}>
          an alert nobody has acknowledged is an alert nobody has looked at. the client can
          see every one of these on their own reliability page.
        </Notice>
      )}

      <div className="ws-stats ws-stats--three">
        <StatCard
          label="open incidents"
          value={formatCount(open.length)}
          sub={open.length === 0 ? 'nothing is on fire' : 'visible to the client right now'}
          tone="lead"
        />
        <StatCard
          label="unacknowledged"
          value={formatCount(unacknowledged.length)}
          sub={unacknowledged.length === 0 ? 'all seen' : 'nobody has clicked acknowledge'}
        />
        <StatCard
          label="in the window"
          value={formatCount(rows.length)}
          sub="across every client, resolved included"
        />
      </div>

      <Notice tone="warn" title="detection is not built yet">
        this page raises, acknowledges and resolves alerts, and they render correctly on the
        affected client&rsquo;s reliability page. nothing yet <em>detects</em> that a client has
        gone quiet — that is the n8n poller in phase 2 (N4). until it ships, an alert exists
        because a person noticed, and the support page&rsquo;s promise that we get paged
        automatically is not yet true.
      </Notice>

      <Panel title="raise an alert" note="writes through the ops function, and is logged">
        {error && <Notice tone="fail" title="that did not work">{error}</Notice>}
        {done && <Notice tone="ok" title={done} />}

        <div className="ops-form">
          <Field label="client" required>
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">choose a client…</option>
              {clients.map((client) => (
                <option key={client.tenant.id} value={client.tenant.id}>
                  {client.tenant.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="check type"
            hint={CHECK_TYPES.find((c) => c.key === checkType)?.blurb}
          >
            <select value={checkType} onChange={(e) => setCheckType(e.target.value)}>
              {CHECK_TYPES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="severity">
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="what happened"
            hint="the client reads this verbatim on their reliability page. write it for them, not for you."
            wide
            required
          >
            <textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="canary: sms send failed 3 consecutive checks. twilio a2p campaign registration lapsed."
            />
          </Field>
        </div>

        <button
          type="button"
          className="ws-btn ws-btn--primary"
          disabled={!canRaise || busy !== null}
          onClick={() =>
            run('raised', async () => {
              const result = await raiseAlert({ tenantId, checkType, severity, message: message.trim() });
              setMessage('');
              return result;
            })
          }
        >
          {busy === 'raised' ? 'raising…' : 'raise it'}
        </button>
      </Panel>

      <Panel
        title="incidents"
        note={`${formatCount(rows.length)} · ${formatCount(open.length)} open`}
        bare
      >
        {rows.length === 0 ? (
          <Empty title="no alerts have ever been raised">
            which is either very good news or the reason this page exists. nothing writes to
            this table on its own yet.
          </Empty>
        ) : (
          <ol className="ws-timeline">
            {rows.map(({ incident, client, ageMs }) => (
              <li key={incident.id} className={incident.open ? 'is-open' : ''}>
                <div className="ws-timeline__head">
                  <Pill tone={incident.open ? 'fail' : 'ok'}>
                    {incident.open ? 'open' : 'resolved'}
                  </Pill>
                  <span className="ws-timeline__type mono">
                    <Link to={`${base}/clients/${client.tenant.id}`}>{client.tenant.name}</Link>
                    {' · '}
                    {incident.checkType} · {incident.severity}
                  </span>
                  <span className="ws-timeline__span mono">
                    {incident.open ? 'open for' : 'lasted'} {formatSpan(incident.durationMs ?? ageMs)}
                  </span>
                </div>

                <p className="ws-timeline__msg">{incident.message}</p>

                <div className="ws-timeline__marks">
                  <span>
                    <em>detected</em>
                    {formatStamp(incident.firedAt, client.tenant.timezone)}
                  </span>
                  <span>
                    <em>acknowledged</em>
                    {incident.acknowledgedAt
                      ? formatStamp(incident.acknowledgedAt, client.tenant.timezone)
                      : 'not yet'}
                  </span>
                  <span>
                    <em>resolved</em>
                    {incident.resolvedAt
                      ? formatStamp(incident.resolvedAt, client.tenant.timezone)
                      : 'in progress'}
                  </span>
                </div>

                {incident.open && (
                  <div className="ops-rowactions">
                    {!incident.acknowledgedAt && (
                      <button
                        type="button"
                        className="ws-btn"
                        disabled={busy !== null}
                        onClick={() => run('acknowledged', () => acknowledgeAlert(incident.id))}
                      >
                        acknowledge
                      </button>
                    )}
                    <button
                      type="button"
                      className="ws-btn ws-btn--primary"
                      disabled={busy !== null}
                      onClick={() => run('resolved', () => resolveAlert(incident.id))}
                    >
                      resolve
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

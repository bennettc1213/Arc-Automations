import { DateTime } from 'luxon';
import { Panel, Pill } from '../../components/ui';
import { site } from '../../../data/site';
import { formatCount, formatStamp } from '../../lib/format';

/**
 * what is wired up, and who to tell when it should change.
 *
 * this page has no save button, and that is a decision rather than an omission. arc runs
 * these automations as a service — routing rules and business hours live in n8n and in the
 * client's own phone system, not in a settings table this page could write to. a form that
 * looked editable and quietly changed nothing would be the worst possible version of it.
 *
 * so everything here is read out of the event log instead of out of a config file, which
 * has a useful side effect: the connected sources and the on-call roster shown below are
 * the ones that have actually produced events, not the ones somebody meant to set up.
 */

function Row({ label, children, note }) {
  return (
    <div className="ws-facts__row">
      <dt>{label}</dt>
      <dd>
        {children}
        {note && <span className="ws-facts__note">{note}</span>}
      </dd>
    </div>
  );
}

export default function Account({ data }) {
  const { tenant, sources, routing, threadTotal, reliability, coverageDays } = data;

  const since = DateTime.fromISO(tenant.createdAt, { zone: 'utc' }).setZone(tenant.timezone);
  const days = Math.max(0, Math.round(DateTime.now().diff(since, 'days').days));

  const changeSubject = encodeURIComponent(`portal change request — ${tenant.name}`);
  const changeBody = encodeURIComponent(
    `account: ${tenant.name} (${tenant.slug})\n\nwhat should change:\n\n`,
  );

  return (
    <>
      <div className="ws-two">
        <Panel title="account">
          <dl className="ws-facts">
            <Row label="name">{tenant.name}</Row>
            <Row label="account id" note="quote this if you email us about a specific lead">
              <span className="mono">{tenant.slug ?? tenant.id}</span>
            </Row>
            <Row label="status">
              <Pill tone={tenant.status === 'active' ? 'ok' : 'warn'}>{tenant.status}</Pill>
            </Row>
            <Row label="timezone" note="every time and date in this portal is rendered in it">
              <span className="mono">{tenant.timezone}</span>
            </Row>
            <Row label="monitoring since" note={`${formatCount(days)} days`}>
              {since.toFormat('LLLL d, yyyy')}
            </Row>
          </dl>
        </Panel>

        <Panel title="what is connected" note="observed, not configured">
          {sources.length === 0 ? (
            <p className="ws-panel__empty">no source has produced a lead in this window.</p>
          ) : (
            <ul className="ws-list">
              {sources.map((source) => (
                <li key={source.key}>
                  <Pill tone="ok">live</Pill>
                  <span className="ws-list__label">{source.label}</span>
                  <span className="ws-list__val mono">{formatCount(source.count)} leads · 30d</span>
                </li>
              ))}
            </ul>
          )}

          <p className="ws-note">
            a source appears here the first time it produces a lead. if something you expect is
            missing from this list, it is not sending — which is exactly the failure worth
            finding out about from a dashboard rather than from a customer.
          </p>
        </Panel>
      </div>

      <div className="ws-two">
        <Panel title="on-call roster" note="from routed leads, 30d">
          {routing.length === 0 ? (
            <p className="ws-panel__empty">no leads have been routed in this window.</p>
          ) : (
            <ul className="ws-list">
              {routing.map((row) => (
                <li key={row.tech}>
                  <span className="ws-list__label">{row.tech}</span>
                  <span className="ws-list__val mono">
                    {formatCount(row.count)} leads · {formatCount(row.replied)} replied
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="data & retention">
          <dl className="ws-facts">
            <Row label="leads held">
              <span className="mono">{formatCount(threadTotal)}</span>
            </Row>
            <Row label="history loaded" note="metrics are computed over the last 30 of these">
              <span className="mono">{formatCount(coverageDays)} days</span>
            </Row>
            <Row label="verification checks" note={`${reliability.intervalLabel}, end to end`}>
              <span className="mono">{formatCount(reliability.checks)} in 30d</span>
            </Row>
            <Row label="what we store">
              lead metadata, message timings and delivery results
              <span className="ws-facts__note">
                no card data, and no message content beyond the acknowledgement we send
              </span>
            </Row>
            <Row label="who can see it">
              only accounts attached to {tenant.name}
              <span className="ws-facts__note">
                enforced by row-level security in the database, not by a filter in this page
              </span>
            </Row>
          </dl>
        </Panel>
      </div>

      <Panel title="changing any of this">
        <p className="ws-panel__body">
          business hours, routing order, who is on call, the wording of the text that goes out —
          all of it is ours to change and none of it is a toggle in here. that is on purpose:
          these rules live in the automation itself and in your phone system, and a switch on
          this page that silently disagreed with either one would be worse than no switch.
          tell us what should be different and it gets changed, usually the same day.
        </p>

        <a className="ws-btn ws-btn--primary" href={`mailto:${site.email}?subject=${changeSubject}&body=${changeBody}`}>
          request a change
        </a>

        <p className="ws-note mono">
          {site.email} · last check {reliability.lastCheckAt
            ? formatStamp(reliability.lastCheckAt, tenant.timezone)
            : '—'}
        </p>
      </Panel>
    </>
  );
}

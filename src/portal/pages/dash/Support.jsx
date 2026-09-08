import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Panel } from '../../components/ui';
import { site } from '../../../data/site';
import { formatRelative } from '../../lib/format';

/**
 * how to reach a person.
 *
 * deliberately not a ticket form. a form on a page like this is a way of appearing available
 * without being available — it collects the message and says nothing about who reads it or
 * when. an email address and an honest response window is a smaller promise and a real one.
 *
 * the first panel is the important one: most of what a client would open a ticket about is
 * already answered on a page in this portal, and pointing at the page is faster than
 * answering the question twice.
 */

const ANSWERS = [
  {
    q: 'a customer says nobody got back to them',
    a: 'open leads, search their name or phone number, and expand the row. it shows the exact times the lead landed, the text went out, and where it was routed.',
    to: 'leads',
    cta: 'go to leads',
  },
  {
    q: 'the numbers look lower than last month',
    a: 'reports has the month-by-month table and the thirty-day comparison. if a source stopped sending, it shows up on the account page as a source that no longer appears.',
    to: 'reports',
    cta: 'go to reports',
  },
  {
    q: 'is it actually running right now',
    a: 'reliability shows the hourly end-to-end check, thirty days of results, and every incident with the time it was detected and fixed.',
    to: 'reliability',
    cta: 'go to reliability',
  },
  {
    q: 'something should work differently',
    a: 'routing, business hours, message wording and escalation are all changeable, and none of them are toggles in here. email the change and it usually ships the same day.',
    to: 'account',
    cta: 'go to account',
  },
];

export default function Support({ data, base }) {
  const { tenant, status } = data;

  const subject = encodeURIComponent(`portal support — ${tenant.name}`);

  return (
    <>
      <Panel title="before you email" note="most answers are a page away">
        <ul className="ws-qa">
          {ANSWERS.map((item) => (
            <li key={item.q}>
              <p className="ws-qa__q">{item.q}</p>
              <p className="ws-qa__a">{item.a}</p>
              <Link className="ws-qa__link" to={`${base}/${item.to}`}>
                {item.cta}
                <Icon name="chevron" size={12} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="ws-two">
        <Panel title="reach a person">
          <p className="ws-panel__body">
            it is a small team, so this reaches somebody who can actually change the automation
            rather than somebody who will forward it. include the customer's name or phone
            number if it is about a specific lead — it makes the answer minutes instead of hours.
          </p>

          <a className="ws-btn ws-btn--primary" href={`mailto:${site.email}?subject=${subject}`}>
            email support
          </a>

          <dl className="ws-facts">
            <div className="ws-facts__row">
              <dt>email</dt>
              <dd className="mono">{site.email}</dd>
            </div>
            <div className="ws-facts__row">
              <dt>anything broken</dt>
              <dd>
                same day
                <span className="ws-facts__note">
                  usually before you write — the canary pages us first
                </span>
              </dd>
            </div>
            <div className="ws-facts__row">
              <dt>changes &amp; questions</dt>
              <dd>
                one business day
                <span className="ws-facts__note">
                  small copy and routing changes are normally same day
                </span>
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="what we do when it breaks">
          <p className="ws-panel__body">
            you do not have to notice first. the hourly end-to-end check fails, we get paged, and
            the incident appears on your reliability page with the time it was detected — before
            anyone has emailed anybody. if it is a source that stopped sending rather than a
            send that failed, the schema assert catches that too: leads quietly stopping is the
            failure mode with no error message, and it is the one worth building for.
          </p>

          <p className="ws-note">
            current state:{' '}
            <b>
              {status.status === 'operational'
                ? 'all systems operational'
                : status.status === 'degraded'
                  ? 'degraded — watching'
                  : 'action required'}
            </b>
            {status.lastCheckedAt && (
              <> · last checked {formatRelative(status.lastCheckedAt, tenant.timezone)}</>
            )}
          </p>

          <Link className="ws-btn" to={`${base}/reliability`}>
            see the checks
          </Link>
        </Panel>
      </div>
    </>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { Empty, Panel, Pill } from './ui';
import { PRIORITY_TONE } from '../lib/attention';
import { formatCount, formatRelative, formatStamp } from '../lib/format';

/**
 * everything that needs a person, in one list, across every module.
 *
 * the design problem here is not finding the items — lib/attention.js does that — it is
 * that a queue where everything is red is a queue nobody triages. so there are exactly three
 * priorities and only the top one gets the failure colour. "urgent" means somebody could get
 * hurt or a customer is actively waiting on a human; "high" means money is moving away from
 * the business today; "normal" is real work with a real deadline that is not today.
 *
 * the second design problem is that this list is read on a phone in a driveway. so every row
 * leads with who it is and what is wrong, in that order, and everything else — the module,
 * the age, who it is assigned to — is secondary text that wraps underneath rather than
 * columns that scroll sideways.
 */

const SHOW = 8;

export default function AttentionQueue({
  attention,
  base,
  timezone,
  title = 'needs a person',
  limit = SHOW,
  showModule = true,
}) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? attention.items : attention.items.slice(0, limit);

  return (
    <Panel
      title={title}
      note={
        attention.total === 0 ? null : (
          <span className="ws-queue__counts mono">
            {attention.counts.urgent > 0 && (
              <b className="is-urgent">{attention.counts.urgent} urgent</b>
            )}
            {attention.counts.high > 0 && <b className="is-high">{attention.counts.high} high</b>}
            {attention.counts.normal > 0 && <b>{attention.counts.normal} normal</b>}
          </span>
        )
      }
    >
      {attention.total === 0 ? (
        /* the empty state is the good one here, and it has to read that way rather than as
           a page that failed to load. */
        <Empty title="nothing is waiting on a person">
          every lead, estimate, review, membership and install we are watching is either
          handled or still moving on its own. this list fills itself when that changes.
        </Empty>
      ) : (
        <>
          <ul className="ws-queue">
            {items.map((item) => (
              <li key={item.key} className={`ws-queue__item is-${item.priority}`}>
                <div className="ws-queue__head">
                  <Pill tone={PRIORITY_TONE[item.priority]}>{item.priority}</Pill>
                  <span className="ws-queue__who">{item.customer}</span>
                  {showModule && <span className="ws-queue__module">{item.moduleLabel}</span>}
                </div>

                <p className="ws-queue__reason">
                  {item.reason}
                  {item.detail && <em>{item.detail}</em>}
                </p>

                <div className="ws-queue__meta mono">
                  {item.openedAt && (
                    <span title={formatStamp(item.openedAt, timezone)}>
                      waiting {formatRelative(item.openedAt, timezone).replace(' ago', '')}
                    </span>
                  )}
                  {item.dueAt && (
                    <span className={item.overdue ? 'is-overdue' : undefined}>
                      <Icon name="clock" size={11} />
                      {item.overdue ? 'due ' : 'due '}
                      {formatRelative(item.dueAt, timezone)}
                    </span>
                  )}
                  {item.assignedTo && <span>→ {item.assignedTo}</span>}
                  {item.state && <span className="ws-queue__state">{item.state}</span>}
                  {item.to && (
                    <Link className="ws-queue__link" to={`${base}/${item.to}`}>
                      open
                      <Icon name="chevron" size={11} />
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {attention.total > limit && (
            <div className="ws-more">
              <button
                type="button"
                className="ws-btn"
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded
                  ? 'show fewer'
                  : `show ${formatCount(attention.total - limit)} more`}
              </button>
              <span className="mono">
                {formatCount(items.length)} of {formatCount(attention.total)} shown
              </span>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

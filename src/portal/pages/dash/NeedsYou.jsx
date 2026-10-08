import { Link } from 'react-router-dom';
import { Empty, Panel, Pill } from '../../components/ui';
import { site } from '../../../data/site';
import { formatRelative } from '../../lib/format';
import { ownerNeeds } from '../../lib/owner';
import './Owner.css';

/**
 * ARC-MK-200 — needs you: what do I have to do?
 *
 * everything waiting on the owner, in three kinds: an outcome question for a visit whose
 * time has passed, a lead arc stopped on and handed to a person, and anything that did not
 * go the usual way. the list is derived on every read (`ownerNeeds`) — nothing is stored,
 * so nothing here can go stale.
 *
 * answering from this screen is not built yet: that is the portal's first write, and it
 * goes in with its own checks. until then the page says how to answer, and never shows a
 * button that does nothing.
 */

const KIND_TONE = { outcome: 'warn', handoff: 'fail', other: 'neutral' };

export default function NeedsYou({ data, base }) {
  const needs = ownerNeeds(data);
  const tz = data.tenant?.timezone ?? 'UTC';
  const subject = encodeURIComponent(`an answer for arc — ${data.tenant?.name ?? ''}`);

  if (needs.total === 0) {
    return (
      <div className="ow">
        <Panel>
          <Empty title="nothing needs you">
            every lead is either handled or still moving on its own. this list fills itself
            when that changes.
          </Empty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="ow">
      {needs.example && <p className="ow-example">example leads for a made-up company.</p>}

      {needs.groups.map((group) => (
        <Panel title={group.label} note={`${group.items.length} waiting`} key={group.key}>
          <p className="ow-sub">{group.blurb}</p>
          <ul className="ow-needs">
            {group.items.map((item) => (
              <li key={item.key} className={`ow-need ow-need--${group.key}`}>
                <div className="ow-need__head">
                  <Pill tone={KIND_TONE[group.key]}>{group.label}</Pill>
                  {item.openedAt && <span className="ow-need__age mono">{formatRelative(item.openedAt, tz)}</span>}
                </div>
                <p className="ow-need__title">{item.title}</p>
                {item.detail && <p className="ow-need__detail">{item.detail}</p>}
                <p className="ow-need__reason">{item.reason}</p>
                {item.to && (
                  <Link className="ws-btn ow-tap" to={`${base}/${item.to}`}>
                    see the record
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ))}

      <Panel title="how to answer">
        <p className="ow-sub">
          answering from this screen is not switched on yet. for now, tell us and we record
          it for you — the lead stays here until it is settled.
        </p>
        {!needs.example && (
          <a className="ws-btn ws-btn--primary ow-tap" href={`mailto:${site.email}?subject=${subject}`}>
            email your answer
          </a>
        )}
      </Panel>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { Panel, Pill } from '../../components/ui';
import { ModuleStat } from '../../components/ModuleUI';
import { site } from '../../../data/site';
import { formatCount } from '../../lib/format';
import { ownerMonth } from '../../lib/owner';
import './Owner.css';

/**
 * ARC-MK-200 — this month: is arc working?
 *
 * the owner portal's front page, read on a phone between jobs. three figures, then what
 * provably happened, then one card for each place a job slips away.
 *
 * the page decides nothing: `ownerMonth` hands it every figure already derived, and a
 * figure it could not derive arrives as null with its reason. that is drawn as a dash and
 * the reason through `ModuleStat` — never as a zero.
 */

const STAGE_TONE = { launch: 'ok', next: 'idle', later: 'neutral', blocked: 'neutral' };

export default function ThisMonth({ data, base }) {
  const month = ownerMonth(data, { terms: site.price.terms, leaks: site.leaks.items });

  return (
    <div className="ow">
      {month.example && (
        <p className="ow-example">
          example figures, counted from seven example leads for a made-up company.
        </p>
      )}

      <div className="ow-figures">
        {month.figures.map((figure) => (
          <ModuleStat
            key={figure.key}
            label={figure.label}
            value={figure.available ? formatCount(figure.value) : null}
            sub={figure.note}
            available={figure.available}
            unavailable={figure.note}
          />
        ))}
      </div>

      <div className="ow-actions">
        <Link className="ws-btn ws-btn--primary ow-tap" to={`${base}/needs-you`}>
          see what needs you
        </Link>
        <Link className="ws-btn ow-tap" to={`${base}/jobs`}>
          see every job
        </Link>
      </div>

      <Panel title="what happened" note={month.provenWindow}>
        {month.proven ? (
          <dl className="ow-proven">
            {month.proven.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{formatCount(row.value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="ow-sub">
            <span aria-hidden="true">— </span>
            <span className="ws-sr">not available. </span>
            nothing has come through your phone line yet, so there is nothing to count.
          </p>
        )}
        <p className="ow-sub">{site.price.counts}</p>
      </Panel>

      <Panel title="where jobs slip away" note="one at a time">
        <ul className="ow-leaks">
          {month.leaks.map((leak) => (
            <li key={leak.key} className={`ow-leak${leak.running ? ' is-running' : ''}`}>
              <div className="ow-leak__head">
                <h3>{leak.name}</h3>
                <Pill tone={leak.running ? 'ok' : STAGE_TONE[leak.stage] ?? 'neutral'}>{leak.status}</Pill>
              </div>
              <p>{leak.what}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

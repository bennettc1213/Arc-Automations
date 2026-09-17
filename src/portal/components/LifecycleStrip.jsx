import { Link } from 'react-router-dom';
import { Panel } from './ui';
import { formatCount } from '../lib/format';

/**
 * captured → qualified → estimated → approved → installed → retained.
 *
 * the one picture that says what arc is for: not "we send texts fast", but "this is where
 * the money entered the business and where it stopped". each stage is a real count of real
 * records, and each one is a link into the table behind it — a funnel you cannot open is a
 * decoration.
 *
 * the hard requirement it is built around: a stage whose module is not connected shows a
 * dash and the reason, never a zero. four stages reading 0 because nothing is wired up looks
 * exactly like a business that quoted nothing and sold nothing, and a contractor reading
 * that about their own company will disbelieve the two numbers that were true as well.
 *
 * no percentages between stages. the stages come from separate systems over different time
 * windows — an install this month belongs to an estimate from two months ago — so a
 * conversion rate drawn between them would be arithmetic on two unrelated populations.
 */

export default function LifecycleStrip({ lifecycle, base, note }) {
  return (
    <Panel
      title="the lifecycle"
      note={note ?? 'last 30 days · counts of records, not estimates of them'}
    >
      <ol className="ws-life">
        {lifecycle.map((stage, i) => {
          const body = (
            <>
              <span className="ws-life__value">
                {stage.available ? formatCount(stage.value) : '—'}
              </span>
              <span className="ws-life__label">{stage.label}</span>
              <span className="ws-life__note">{stage.note}</span>
            </>
          );

          return (
            <li
              key={stage.key}
              className={`ws-life__stage is-${stage.state}`}
              /* the arrow is drawn by css on every stage but the first, so it never lands
                 in the tab order or gets read out as content. */
              data-step={i}
            >
              {stage.available && stage.to ? (
                <Link to={`${base}/${stage.to}`} className="ws-life__in">
                  {body}
                </Link>
              ) : (
                <div className="ws-life__in">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

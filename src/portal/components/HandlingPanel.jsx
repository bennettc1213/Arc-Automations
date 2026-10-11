import { Link } from 'react-router-dom';
import { Panel } from './ui';
import { site } from '../../data/site';
import { formatCount } from '../lib/format';
import { ownerHandling } from '../lib/handling';
import './HandlingPanel.css';

/**
 * ARC-MK-230 — what arc does with each lead: the offer's three lines, each with its record.
 *
 * a missed call gets a text back, a website request gets one too, and the questions are
 * asked before the owner calls back. the names and the sentence under each are the
 * homepage's own (`site.leaks.covers`), so the page that sold it and the page that shows it
 * use one copy of the words.
 *
 * the panel decides nothing: `ownerHandling` hands it every figure already counted, and one
 * it could not count arrives as null with its reason — drawn as a dash and the reason, never
 * a zero. drawn on the owner's "this month" and on the console's client page from the same
 * dashboard object, so the two cannot disagree.
 *
 * `base` is the workspace's address. without one (the console) the cards carry no link.
 */
export default function HandlingPanel({ data, base = null, title = 'what arc does with each lead' }) {
  const handling = ownerHandling(data, { covers: site.leaks.covers.items });
  if (handling.steps.length === 0) return null;

  return (
    <Panel title={title} note={handling.window}>
      <ol className="hd-steps">
        {handling.steps.map((step, index) => (
          <li className="hd-step" key={step.key}>
            <p className="hd-step__n mono">
              {index + 1} of {handling.steps.length}
            </p>
            <h3 className="hd-step__name">{step.name}</h3>
            <p className="hd-step__what">{step.what}</p>

            <dl className="hd-figures">
              {step.figures.map((figure) => (
                <div key={figure.label}>
                  <dt>{figure.label}</dt>
                  <dd className="hd-figures__value">
                    {figure.available ? (
                      typeof figure.value === 'number' ? formatCount(figure.value) : figure.value
                    ) : (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="ws-sr">not available</span>
                      </>
                    )}
                  </dd>
                  {figure.note && <dd className="hd-figures__note">{figure.note}</dd>}
                </div>
              ))}
            </dl>

            {base && step.source && (
              <Link className="hd-step__more" to={handling.example ? `${base}/jobs` : `${base}/jobs?from=${step.source}`}>
                {handling.example ? 'see the examples' : 'see these jobs'}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

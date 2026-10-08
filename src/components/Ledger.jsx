import { Link } from 'react-router-dom';
import { site } from '../data/site';
import './Ledger.css';

/* the proof ledger, as three made-up leads. it says they are made up before it shows
   them: this is what the ledger looks like, not a claim about anybody's phone. */
export default function Ledger() {
  const { eyebrow, title, lead, exampleNote, leads, demo } = site.ledger;

  return (
    <section className="ledger wrap" id="ledger" aria-labelledby="ledger-title">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title ledger__title" id="ledger-title">
        {title}
      </h2>
      <p className="ledger__lead">{lead}</p>
      <p className="ledger__note mono">{exampleNote}</p>

      <div className="ledger__rows">
        {leads.map((entry) => (
          <article className={`lrow lrow--${entry.key}`} key={entry.key}>
            <h3 className="lrow__who mono">{entry.who}</h3>
            <ol className="lrow__steps">
              {entry.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="lrow__verdict">
              <strong>{entry.verdict}</strong>
              <span>{entry.reason}</span>
            </p>
          </article>
        ))}
      </div>

      <Link className="ledger__demo mono" to="/demo">
        {demo}
      </Link>
    </section>
  );
}

import { site } from '../data/site';
import { openPilot } from '../lib/pilot';
import './Price.css';

/* a term that has a number prints the number; one that has not been agreed prints
   its own words. never a zero, and never a figure nobody has agreed to. */
export function priceValue(row, terms) {
  if (row.value) return row.value;
  const amount = terms?.[row.term];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return row.unset;
  return `$${amount.toLocaleString('en-US')}${row.suffix ?? ''}`;
}

export default function Price() {
  const { eyebrow, title, terms, rows, counts, disputeLead, disputeReasons } = site.price;

  return (
    <section className="price wrap" id="price" aria-labelledby="price-title">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title price__title" id="price-title">
        {title}
      </h2>

      <dl className="price__rows">
        {rows.map((row) => (
          <div className="price__row" key={row.label}>
            <dt className="mono">{row.label}</dt>
            <dd>{priceValue(row, terms)}</dd>
          </div>
        ))}
      </dl>

      <div className="price__rules">
        <p>{counts}</p>
        <p>{disputeLead}</p>
        <ul className="price__reasons mono">
          {disputeReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>

      <button type="button" className="price__cta" onClick={() => openPilot()}>
        {site.cta.primary} <span aria-hidden="true">→</span>
      </button>
    </section>
  );
}

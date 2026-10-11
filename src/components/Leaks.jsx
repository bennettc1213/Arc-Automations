import { site } from '../data/site';
import './Leaks.css';

/* the four places a job slips away — a staged map, not a menu. only the first is
   being offered; the other three say so in words, because a card that is merely
   dimmer than its neighbour reads as "also available". */
export default function Leaks() {
  const { eyebrow, title, lead, items, covers } = site.leaks;

  return (
    <section className="leaks wrap" id="leaks" aria-labelledby="leaks-title">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title leaks__title" id="leaks-title">
        {title}
      </h2>
      <p className="leaks__lead">{lead}</p>

      <ol className="leaks__list">
        {items.map((leak, i) => (
          <li className={`leak leak--${leak.stage}`} key={leak.key}>
            <span className="leak__idx mono" aria-hidden="true">
              0{i + 1}
            </span>
            <h3 className="leak__name">{leak.name}</h3>
            <p className="leak__what">{leak.what}</p>
            <p className="leak__status mono">{leak.status}</p>
          </li>
        ))}
      </ol>

      {/* what the first leak covers. not three more cards in the map — the map is the
          four leaks — so it is a plain list under it, in the launch colour. */}
      <div className="covers" aria-labelledby="covers-title">
        <h3 className="covers__title" id="covers-title">
          {covers.title}
        </h3>
        <ul className="covers__list">
          {covers.items.map((item) => (
            <li className="covers__item" key={item.key}>
              <h4 className="covers__name">{item.name}</h4>
              <p className="covers__what">{item.what}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

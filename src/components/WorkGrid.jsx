import { useState } from 'react';
import { site } from '../data/site';
import { useIsMobile } from '../lib/hooks';
import MediaSlot from './MediaSlot';
import TypeLabel from './TypeLabel';
import './WorkGrid.css';

export default function WorkGrid() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(null);
  const [hot, setHot] = useState(null);

  return (
    <section className="workgrid wrap" id="index" aria-label="work index">
      <p className="eyebrow">04 — the index</p>
      <h2 className="section-title workgrid__title">everything shipped.</h2>

      <div className="workgrid__rows">
        {site.workIndex.map((w, i) => {
          const expanded = isMobile ? open === i : undefined;
          return (
            <div
              key={w.title}
              className={`wrow ${expanded ? 'is-open' : ''}`}
              onClick={isMobile ? () => setOpen(open === i ? null : i) : undefined}
              onMouseEnter={() => setHot(i)}
              onMouseLeave={() => setHot((h) => (h === i ? null : h))}
            >
              <div className="wrow__bar">
                <span className="wrow__idx mono">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="wrow__name">{w.title}</h3>
                <span className="wrow__kind mono">{w.kind}</span>
                <span className="wrow__year mono">{w.year}</span>
                <span className="wrow__arrow" aria-hidden="true">
                  ↘
                </span>
              </div>

              <div className="wrow__reveal">
                <div className="wrow__reveal-clip">
                  <div className="wrow__url mono">
                    {w.url ? (
                      <a href={w.url} target="_blank" rel="noreferrer">
                        <TypeLabel
                          text={`${w.url.replace(/^https?:\/\//, '')} ↗`}
                          play={hot === i || open === i}
                        />
                      </a>
                    ) : (
                      <TypeLabel text={w.urlLabel} play={hot === i || open === i} />
                    )}
                  </div>
                  {w.url ? (
                    <a
                      className="wrow__shot wrow__shot--link"
                      href={w.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${w.title} — open live`}
                    >
                      <MediaSlot name={w.media} spec={w.mediaSpec} alt={w.title} />
                    </a>
                  ) : (
                    <div className="wrow__shot">
                      <MediaSlot name={w.media} spec={w.mediaSpec} alt={w.title} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

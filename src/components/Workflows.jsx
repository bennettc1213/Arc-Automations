import { useState } from 'react';
import { site } from '../data/site';
import { openPilot } from '../lib/pilot';
import TickOnChange from './TickOnChange';
import './Workflows.css';

/* the three core offers always show; the rest of the menu sits behind one toggle
   so it is there for anyone who wants it without diluting the pitch. */
const CORE = site.workflows;
const MORE = site.workflowsMore ?? [];
const ALL = [...CORE, ...MORE];

export default function Workflows() {
  const [tab, setTab] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const TABS = showMore ? ALL : CORE;
  const active = ALL[tab];

  const toggleMore = () => {
    // collapsing while an extra tab is selected would leave the panel showing a
    // tab that is no longer on screen — fall back to the first one.
    if (showMore && tab >= CORE.length) setTab(0);
    setShowMore((v) => !v);
  };

  return (
    <section className="workflows wrap" id="workflows" aria-label="what we build">
      <p className="eyebrow">03 — what we build</p>
      <h2 className="section-title workflows__title">our specialty.</h2>

      <div className="wf__tabs" role="tablist" aria-label="offerings">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === i}
            className={`wf__tab ${tab === i ? 'is-active' : ''}`}
            onClick={() => setTab(i)}
          >
            <span className="wf__tab-index mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="wf__tab-label">{t.label}</span>
            {t.tag && <span className="wf__tab-tag mono">{t.tag}</span>}
          </button>
        ))}
      </div>

      {MORE.length > 0 && (
        <button
          type="button"
          className={`wf__more mono ${showMore ? 'is-open' : ''}`}
          onClick={toggleMore}
          aria-expanded={showMore}
        >
          {showMore ? 'show fewer' : `see ${MORE.length} more services`}
          <span className="wf__more-chev" aria-hidden="true">▾</span>
        </button>
      )}

      <div className="wf__stage">
        <div className="wf__panel" key={active.id}>
          <div className="wf__panelhead">
            <TickOnChange value={tab + 1} className="wf__num" />
            <div className="wf__panelmeta">
              <h3 className="wf__name">{active.label}</h3>
              <span className="wf__tag mono">{active.tag}</span>
            </div>
          </div>

          <div className="wf__desc">
            <p className="wf__desc-copy">{active.description}</p>
            {active.points && (
              <ul className="wf__points">
                {active.points.map((pt) => (
                  <li key={pt}>
                    <span aria-hidden="true">→</span> {pt}
                  </li>
                ))}
              </ul>
            )}
            {/* a tab with its own intake (marketing automation) opens that one;
                everything else gets the generic trade/pain/volume intake. */}
            <button
              className="wf__cta"
              onClick={() => openPilot(site.pilot.presets?.[active.id] ? active.id : undefined)}
            >
              start a pilot <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

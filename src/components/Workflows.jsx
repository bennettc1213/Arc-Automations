import { useState } from 'react';
import { site } from '../data/site';
import { openPilot } from '../lib/pilot';
import TickOnChange from './TickOnChange';
import './Workflows.css';

const TABS = site.workflows.map((w, i) => ({ ...w, index: i + 1 }));

export default function Workflows() {
  const [tab, setTab] = useState(0);
  const active = TABS[tab];

  return (
    <section className="workflows wrap" id="workflows" aria-label="what we build">
      <p className="eyebrow">03 — what we build</p>
      <h2 className="section-title workflows__title">the offering.</h2>

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
            <button className="wf__cta" onClick={() => openPilot('marketing-automation')}>
              start a pilot <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

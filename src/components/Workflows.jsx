import { useRef, useState } from 'react';
import { site } from '../data/site';
import { useInView, useReducedMotion } from '../lib/hooks';
import { hasMedia } from '../lib/media';
import { openPilot } from '../lib/pilot';
import MediaSlot from './MediaSlot';
import TickOnChange from './TickOnChange';
import PixelGuy from './PixelGuy';
import './Workflows.css';

const TABS = [
  ...site.workflows.map((w, i) => ({ ...w, index: i + 1 })),
  { id: 'more', label: 'and more →', tag: null, index: 4 },
];

export default function Workflows() {
  const [tab, setTab] = useState(0);
  const stageRef = useRef(null);
  const inView = useInView(stageRef, '-40px');
  const reduced = useReducedMotion();
  const active = TABS[tab];
  const isMore = active.id === 'more';

  return (
    <section className="workflows wrap" id="workflows" aria-label="the workflows">
      <p className="eyebrow">03 — the workflows</p>
      <h2 className="section-title workflows__title">under the hood.</h2>

      <div className="wf__tabs" role="tablist" aria-label="workflows">
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

      <div className="wf__stage" ref={stageRef}>
        {!isMore ? (
          <div className="wf__panel" key={active.id}>
            <div className="wf__panelhead">
              <TickOnChange value={tab + 1} className="wf__num" />
              <div className="wf__panelmeta">
                <h3 className="wf__name">{active.label}</h3>
                <span className="wf__tag mono">{active.tag}</span>
              </div>
            </div>

            {/* the canvas is the hero — real screenshot, room to breathe,
                horizontal scroll when the flow is wider than the viewport */}
            <div className="wf__canvas">
              <div className="wf__canvas-scroll">
                <MediaSlot
                  name={active.canvas}
                  spec="full-res n8n canvas screenshot — the real one"
                  alt={`${active.label} n8n workflow canvas`}
                  className="wf__shot"
                />
              </div>
              {inView && !reduced && hasMedia(active.canvas) && (
                <span className="wf__sweep" key={`sweep-${tab}`} aria-hidden="true" />
              )}
            </div>

            <dl className="wf__breakdown">
              <div>
                <dt className="mono">trigger —</dt>
                <dd>{active.breakdown.trigger}</dd>
              </div>
              <div>
                <dt className="mono">the flow —</dt>
                <dd>{active.breakdown.does}</dd>
              </div>
              <div>
                <dt className="mono">you get —</dt>
                <dd>{active.breakdown.gets}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="wf__more" key="more">
            <p className="wf__statement">
              if it’s repetitive,
              <br />
              it’s automatable.
            </p>
            <p className="wf__substatement">
              every workflow here started as a contractor telling us what was eating their
              week. yours is next.
            </p>
            <button className="wf__cta" onClick={openPilot}>
              start a pilot <span aria-hidden="true">→</span>
            </button>
            <div className="wf__more-guy">
              <PixelGuy size={40} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

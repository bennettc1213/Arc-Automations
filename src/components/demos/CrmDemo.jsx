import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from '../../lib/hooks';
import './demos.css';

const ROWS = [
  { id: 'j-441', name: 'west valley roofing', job: 'storm re-roof', amount: '$8,400' },
  { id: 'j-435', name: 'beehive plumbing', job: 'water heater swap', amount: '$2,150' },
  { id: 'j-428', name: 'layton hvac', job: 'furnace replacement', amount: '$6,900' },
];

const TODAY = [
  { time: '9:00', label: 'call — west valley', done: true },
  { time: '11:30', label: 'follow-up — layton', done: false },
  { time: '2:00', label: 'reminder — beehive', done: false },
];

// phases: 0 idle · 1 new lead routed · 2 booked · 3 reminder · 4 hold · 5 loop
export default function CrmDemo() {
  const rootRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? 4 : 0);

  useEffect(() => {
    if (reduced || !inView) return undefined;
    let t;
    if (phase === 0) t = setTimeout(() => setPhase(1), 900);
    else if (phase === 1) t = setTimeout(() => setPhase(2), 1500);
    else if (phase === 2) t = setTimeout(() => setPhase(3), 1200);
    else if (phase === 3) t = setTimeout(() => setPhase(4), 1600);
    else if (phase === 4) t = setTimeout(() => setPhase(0), 2800);
    return () => clearTimeout(t);
  }, [phase, inView, reduced]);

  const hot = phase >= 1;
  const routed = phase >= 2;
  const remind = phase >= 3;

  const statusOf = (i) => {
    if (i === 0) return !hot ? 'est. sent' : routed ? 'booked' : 'new lead';
    return i === 1 ? 'booked' : 'in progress';
  };

  return (
    <div className="demo demo-crm" ref={rootRef}>
      <div className="demo__chrome mono">
        <span>home-service crm — live</span>
        <span className={`demo-crm__state ${routed ? 'is-synced' : ''}`}>
          {phase === 0 ? 'waiting…' : routed ? 'synced' : 'routing…'}
        </span>
      </div>

      <div className="demo-crm__body">
        <div className="demo-crm__list">
          {ROWS.map((r, i) => {
            const isHot = hot && i === 0;
            return (
              <div
                key={r.id}
                className={`demo-crm__row ${isHot ? 'is-hot' : ''} ${routed && i === 0 ? 'is-booked' : ''}`}
              >
                <span className="mono demo-crm__id">{r.id}</span>
                <div className="demo-crm__who">
                  <span className="demo-crm__name">{r.name}</span>
                  <span className="demo-crm__job">{r.job}</span>
                </div>
                <span className="mono demo-crm__amount">{r.amount}</span>
                <span className={`demo-crm__chip mono ${isHot ? 'is-live' : ''}`}>
                  {statusOf(i)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="demo-crm__today">
          <span className="mono demo-crm__today-label">today</span>
          <ul>
            {TODAY.map((t, i) => (
              <li
                key={t.time}
                className={`mono ${t.done ? 'is-done' : ''} ${remind && !t.done && i === 1 ? 'is-now' : ''}`}
              >
                {t.time} · {t.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

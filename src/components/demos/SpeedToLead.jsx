import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from '../../lib/hooks';
import './demos.css';

const NODES = [
  { icon: '⚡', label: 'form / missed call', sub: 'webhook trigger' },
  { icon: '⋔', label: 'parse + score', sub: 'n8n' },
  { icon: '◪', label: 'create contact', sub: 'gohighlevel' },
  { icon: '✉', label: 'text back', sub: 'twilio sms' },
  { icon: '☏', label: 'call bridge', sub: 'twilio voice' },
  { icon: '✓', label: 'booked', sub: 'calendar' },
];

// stopwatch readout per phase — the whole flow lands inside a minute
const CLOCK = ['00:00', '00:02', '00:05', '00:09', '00:17', '00:31', '00:43'];

export default function SpeedToLead() {
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? NODES.length : 0);

  useEffect(() => {
    if (reduced) return undefined;
    if (!inView) return undefined;
    const t = setTimeout(
      () => setPhase((p) => (p >= NODES.length ? 0 : p + 1)),
      phase >= NODES.length ? 2000 : phase === 0 ? 900 : 750
    );
    return () => clearTimeout(t);
  }, [phase, inView, reduced]);

  // pan the strip so the active node stays in frame — reads like following the flow
  useEffect(() => {
    const track = trackRef.current;
    const root = rootRef.current;
    if (!track || !root) return;
    const active = Math.min(phase, NODES.length - 1);
    const node = track.children[active * 2]; // nodes interleaved with connectors
    if (!node) return;
    const target = Math.max(
      0,
      Math.min(
        node.offsetLeft + node.offsetWidth / 2 - root.clientWidth / 2,
        track.scrollWidth - root.clientWidth + 32
      )
    );
    track.style.transform = `translateX(${-target}px)`;
  }, [phase]);

  const done = phase >= NODES.length;

  return (
    <div className="demo demo-stl" ref={rootRef}>
      <div className="demo__chrome mono">
        <span>speed-to-lead.json</span>
        <span className="demo-stl__clock">
          ⏱ {CLOCK[Math.min(phase, CLOCK.length - 1)]}
        </span>
      </div>

      <div className="demo-stl__viewport">
        <div className="demo-stl__track" ref={trackRef}>
          {NODES.map((n, i) => (
            <NodePair
              key={n.label}
              node={n}
              i={i}
              lit={phase > i}
              active={phase === i + 1}
              last={i === NODES.length - 1}
            />
          ))}
        </div>
      </div>

      <div className={`demo-stl__badge mono ${done ? 'is-on' : ''}`}>
        lead booked in 43s ✓
      </div>
    </div>
  );
}

function NodePair({ node, i, lit, active, last }) {
  return (
    <>
      <div className={`stl-node ${lit ? 'is-lit' : ''} ${active ? 'is-active' : ''}`}>
        <span className="stl-node__icon" aria-hidden="true">
          {node.icon}
        </span>
        <span className="stl-node__label">{node.label}</span>
        <span className="stl-node__sub mono">{node.sub}</span>
      </div>
      {!last && (
        <div className={`stl-wire ${lit ? 'is-lit' : ''}`} aria-hidden="true">
          <span className="stl-wire__pulse" />
        </div>
      )}
    </>
  );
}

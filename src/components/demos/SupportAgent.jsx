import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from '../../lib/hooks';
import './demos.css';

const QUERY = 'hail took out half my roof — how fast can someone come out?';
const ANSWER =
  'storm damage — that’s priority routing. you’re inside the service area, so we’re flagging this hot and texting you two slots for tomorrow.';
const SOURCES = ['service-area.md', 'lead-score: storm', 'jobs/roofing.md'];

// phases: 0 idle · 1 typing · 2 retrieving · 3 answering · 4 hold
export default function SupportAgent() {
  const rootRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? 4 : 0);
  const [qChars, setQChars] = useState(reduced ? QUERY.length : 0);
  const [aChars, setAChars] = useState(reduced ? ANSWER.length : 0);

  useEffect(() => {
    if (reduced || !inView) return undefined;
    let t;
    if (phase === 0) {
      t = setTimeout(() => setPhase(1), 700);
    } else if (phase === 1) {
      if (qChars < QUERY.length) {
        t = setTimeout(() => setQChars((c) => c + 1), 34);
      } else {
        t = setTimeout(() => setPhase(2), 350);
      }
    } else if (phase === 2) {
      t = setTimeout(() => setPhase(3), 1900);
    } else if (phase === 3) {
      if (aChars < ANSWER.length) {
        t = setTimeout(() => setAChars((c) => c + 1), 16);
      } else {
        t = setTimeout(() => setPhase(4), 400);
      }
    } else if (phase === 4) {
      t = setTimeout(() => {
        setQChars(0);
        setAChars(0);
        setPhase(0);
      }, 3600);
    }
    return () => clearTimeout(t);
  }, [phase, qChars, aChars, inView, reduced]);

  return (
    <div className="demo demo-agent" ref={rootRef}>
      <div className="demo__chrome mono">
        <span>lead-qualification — live</span>
        <span className={`demo-agent__state ${phase === 2 ? 'is-busy' : ''}`}>
          {phase === 2 ? 'retrieving…' : phase >= 3 ? 'grounded' : 'listening'}
        </span>
      </div>

      <div className="demo-agent__body">
        <div className="demo-agent__msg demo-agent__msg--user">
          <span className="mono demo-agent__who">new lead</span>
          <p>
            {QUERY.slice(0, qChars)}
            {phase === 1 && <span className="demo-agent__caret" />}
          </p>
        </div>

        <div className={`demo-agent__sources ${phase >= 2 ? 'is-on' : ''}`}>
          {SOURCES.map((s, i) => (
            <span
              className={`demo-agent__chip mono ${phase === 2 ? 'is-scanning' : ''} ${
                phase >= 3 && i === 1 ? 'is-hit' : ''
              }`}
              style={{ animationDelay: `${i * 0.28}s` }}
              key={s}
            >
              {s}
            </span>
          ))}
        </div>

        <div className={`demo-agent__msg demo-agent__msg--bot ${phase >= 3 ? 'is-on' : ''}`}>
          <span className="mono demo-agent__who demo-agent__who--bot">agent</span>
          <p>
            {ANSWER.slice(0, aChars)}
            {phase === 3 && <span className="demo-agent__caret" />}
          </p>
          <span className={`demo-agent__cite mono ${phase === 4 ? 'is-on' : ''}`}>
            [ score: HOT · routed → your phone ]
          </span>
        </div>
      </div>
    </div>
  );
}

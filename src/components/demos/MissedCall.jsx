import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from '../../lib/hooks';
import './demos.css';

const CALLER = { name: 'west valley roofing', number: '(801) 555-0144', time: '2:14pm' };
const CUSTOMER_MSG = 'hey — water is coming through the basement ceiling. can you come out this week?';
const ARC_REPLY = 'hi sam — arc auto-reply, we are on a roof right now. grabbed you two windows this week, pick a slot →';
const START = 42;

// phases: 0 armed · 1 missed · 2 replying · 3 booked · 4 hold
export default function MissedCall() {
  const rootRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? 4 : 0);
  const [tick, setTick] = useState(reduced ? 0 : START);
  const [replyChars, setReplyChars] = useState(reduced ? ARC_REPLY.length : 0);

  useEffect(() => {
    if (reduced || !inView) return undefined;
    let t;
    if (phase === 0) {
      t = setTimeout(() => setPhase(1), 900);
    } else if (phase === 1) {
      t = setTimeout(() => setPhase(2), 1200);
    } else if (phase === 2) {
      if (tick > 0) {
        t = setTimeout(() => setTick((v) => v - 1), 60);
      } else if (replyChars < ARC_REPLY.length) {
        t = setTimeout(() => setReplyChars((c) => c + 1), 14);
      } else {
        t = setTimeout(() => setPhase(3), 400);
      }
    } else if (phase === 3) {
      t = setTimeout(() => setPhase(4), 1800);
    } else if (phase === 4) {
      t = setTimeout(() => {
        setTick(START);
        setReplyChars(0);
        setPhase(0);
      }, 3200);
    }
    return () => clearTimeout(t);
  }, [phase, tick, replyChars, inView, reduced]);

  const missed = phase >= 1;
  const replying = phase >= 2;
  const booked = phase >= 3;
  const doneTyping = replying && replyChars >= ARC_REPLY.length;

  return (
    <div className="demo demo-mc" ref={rootRef}>
      <div className="demo__chrome mono">
        <span>missed-call text-back — live</span>
        <span className={`demo-mc__state ${booked ? 'is-synced' : ''}`}>
          {booked ? 'replied in 42s' : missed ? 'on it…' : 'armed'}
        </span>
      </div>

      <div className="demo-mc__body">
        <div className={`demo-mc__call ${missed ? 'is-missed' : ''}`}>
          <span className={`demo-mc__dot ${missed && !booked ? 'is-ringing' : ''}`} />
          <span className="mono demo-mc__call-line">
            {booked
              ? `caller rebooked · ${CALLER.name}`
              : `missed call · ${CALLER.time} · ${CALLER.name}`}
          </span>
          <span className="mono demo-mc__timer">
            {booked ? '00:00' : missed ? `00:${String(tick).padStart(2, '0')}` : 'armed'}
          </span>
        </div>

        <div className="demo-mc__thread">
          <div className={`demo-mc__msg demo-mc__msg--them ${replying ? 'is-on' : ''}`}>
            <span className="mono demo-mc__who">{CALLER.number}</span>
            <p>{CUSTOMER_MSG}</p>
          </div>

          <div className={`demo-mc__msg demo-mc__msg--us ${replying ? 'is-on' : ''}`}>
            <span className="mono demo-mc__who">arc automations</span>
            <p>
              {ARC_REPLY.slice(0, replyChars)}
              {replying && !doneTyping && <span className="demo-agent__caret" />}
            </p>
          </div>

          <div className={`demo-mc__booked mono ${booked ? 'is-on' : ''}`}>
            booked · wed 2:00pm — reminder armed for tue 8:00am
          </div>
        </div>
      </div>
    </div>
  );
}

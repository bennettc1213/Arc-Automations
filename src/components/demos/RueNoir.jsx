import { useRef, useState } from 'react';
import { useInView, useLoop, useReducedMotion } from '../../lib/hooks';
import { media } from '../../lib/media';
import './demos.css';

// its hero, echoed live — real captions, real palette, real typeface.
// if rue-noir-01..04.jpg frames are dropped in, they crossfade behind the type.
const PLATES = [
  { text: 'Rue Noir', title: true },
  { text: 'Paris, 4:00 a.m.' },
  { text: 'Every cup, a small ceremony.' },
  { text: 'Worth the descent.' },
];

const FRAMES = ['rue-noir-01.jpg', 'rue-noir-02.jpg', 'rue-noir-03.jpg', 'rue-noir-04.jpg'].map(
  media
);

export default function RueNoir() {
  const rootRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);

  useLoop(() => setI((n) => (n + 1) % PLATES.length), 3200, inView && !reduced);

  const hasFrames = FRAMES.some(Boolean);

  return (
    <div className="demo demo-rn" ref={rootRef}>
      {hasFrames &&
        FRAMES.map(
          (url, f) =>
            url && (
              <img
                key={url}
                src={url}
                alt=""
                loading="lazy"
                className={`demo-rn__frame ${f === i % FRAMES.length ? 'is-on' : ''}`}
              />
            )
        )}

      <div className="demo-rn__vignette" aria-hidden="true" />
      <div className="demo-rn__grain" aria-hidden="true" />

      {PLATES.map((p, n) => (
        <div className={`demo-rn__plate ${n === i ? 'is-on' : ''}`} key={p.text}>
          {p.title ? <span className="demo-rn__title">{p.text}</span> : <em>{p.text}</em>}
        </div>
      ))}

      <span className="demo-rn__no">Pl. 0{i + 1}</span>
      <span className="demo-rn__rule" aria-hidden="true" />
    </div>
  );
}

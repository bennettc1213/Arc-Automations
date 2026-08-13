import { useEffect, useRef, useState } from 'react';
import { useInView, useMedia, useReducedMotion } from '../lib/hooks';
import './PixelGuy.css';

const ACCENT = '#ff4d00';
const LITE = '#ffa366'; // the eye — still orange, just warmer

// 10×10 pixel maps. Head rows shift a column with facing; one lighter pixel
// is the eye. Everything about him snaps — no tweens, ever.
const HEAD = [
  '...xxxx...',
  '..xxxxxx..',
  '..xxxxxx..',
  '..xxxxxx..',
  '..xxxxxx..',
  '...xxxx...',
];
const BODY = ['..xxxxxx..', '.xxxxxxxx.', '.xxxxxxxx.'];
const FEET_A = '..xx..xx..';
const FEET_B = '.xx....xx.';
const EYE_ROW = 3;
const EYE_COL = { left: 2, center: 4, right: 7 };

function shiftRow(row, dx) {
  if (dx === 0) return row;
  return dx > 0 ? '.' + row.slice(0, 9) : row.slice(1) + '.';
}

function buildRects(facing, { blink = false, squash = false, feet = FEET_A } = {}) {
  const dx = facing === 'left' ? -1 : facing === 'right' ? 1 : 0;
  let head = HEAD.map((r) => shiftRow(r, dx));
  let eyeRow = EYE_ROW;
  if (squash) {
    head = head.slice(0, 5); // lose the neck row — one pixel-row shorter
    eyeRow += 1;
  }
  const rows = [...(squash ? ['..........'] : []), ...head, ...BODY, feet];
  const rects = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < 10; x++) {
      if (row[x] !== 'x') continue;
      rects.push({ x, y, eye: !blink && y === eyeRow && x === EYE_COL[facing] });
    }
  });
  return rects;
}

function Sprite({ rects, size }) {
  return (
    <svg viewBox="0 0 10 10" width={size} height={size} shapeRendering="crispEdges">
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x}
          y={r.y}
          width="1"
          height="1"
          fill={r.eye ? LITE : ACCENT}
        />
      ))}
    </svg>
  );
}

export default function PixelGuy({ size = 24, className = '', autoHop = false }) {
  const reduced = useReducedMotion();
  const fine = useMedia('(pointer: fine)');
  const live = !reduced;
  const rootRef = useRef(null);
  const [facing, setFacing] = useState('center');
  const [blink, setBlink] = useState(false);
  const [squash, setSquash] = useState(false);
  const [hopY, setHopY] = useState(0);
  const hopping = useRef(false);

  // idle blink every 4–7s, randomized so it never feels metronomic
  useEffect(() => {
    if (!live) return undefined;
    let t1;
    let t2;
    let on = true;
    const loop = () => {
      t1 = setTimeout(() => {
        setBlink(true);
        t2 = setTimeout(() => {
          setBlink(false);
          if (on) loop();
        }, 130);
      }, 4000 + Math.random() * 3000);
    };
    loop();
    return () => {
      on = false;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [live]);

  // face the cursor — three discrete states, snapping between them
  useEffect(() => {
    if (!live || !fine) return undefined;
    let raf = 0;
    let mx = null;
    const update = () => {
      raf = 0;
      const el = rootRef.current;
      if (!el || mx == null) return;
      const r = el.getBoundingClientRect();
      const c = r.left + r.width / 2;
      setFacing(mx < c - r.width ? 'left' : mx > c + r.width ? 'right' : 'center');
    };
    const onMove = (e) => {
      mx = e.clientX;
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [live, fine]);

  // compress one pixel-row on fast scroll, spring back
  useEffect(() => {
    if (!live) return undefined;
    let lastY = window.scrollY;
    let t;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = Math.abs(y - lastY);
      lastY = y;
      if (dy > 60) {
        setSquash(true);
        clearTimeout(t);
        t = setTimeout(() => setSquash(false), 150);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      clearTimeout(t);
    };
  }, [live]);

  // hop once on click, land with a 1px overshoot
  const hop = () => {
    if (!live || hopping.current) return;
    hopping.current = true;
    const u = Math.max(1, Math.round(size / 10));
    const frames = [-2 * u, -3 * u, -3 * u, -2 * u, 0, 1, 0];
    frames.forEach((y, i) =>
      setTimeout(() => {
        setHopY(y);
        if (i === frames.length - 1) hopping.current = false;
      }, i * 55)
    );
  };

  // celebratory hop on mount (confirmation screens)
  useEffect(() => {
    if (!autoHop || !live) return undefined;
    const t = setTimeout(hop, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHop, live]);

  const rects = buildRects(live ? facing : 'center', {
    blink: live && blink,
    squash: live && squash,
  });

  return (
    <span
      ref={rootRef}
      className={`pixelguy ${className}`}
      onClick={hop}
      data-facing={facing}
      data-squash={squash || undefined}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        transform: hopY ? `translateY(${hopY}px)` : undefined,
      }}
    >
      <Sprite rects={rects} size={size} />
    </span>
  );
}

/** static mark — the logo as a glyph, for marquee separators and the like */
export function PixelMark({ size = 13 }) {
  const rects = buildRects('center', {});
  return (
    <span className="pixelmark" aria-hidden="true">
      <Sprite rects={rects} size={size} />
    </span>
  );
}

const ROAM_HOP = 7; // frames in a roaming hop

/**
 * Background wanderer — paces a floor line, pauses to blink, turns around,
 * occasionally hops. Every move is a discrete step. Lives behind content.
 */
export function PixelRoamer({ size = 30 }) {
  const reduced = useReducedMotion();
  const wrapRef = useRef(null);
  const inView = useInView(wrapRef, '60px');
  const [f, setF] = useState({
    x: 40,
    dir: 1,
    mode: 'walk',
    feet: false,
    blink: false,
    hopI: -1,
    idleT: 0,
  });

  useEffect(() => {
    if (reduced || !inView) return undefined;
    const id = setInterval(() => {
      setF((s) => {
        const w = wrapRef.current?.clientWidth ?? 800;
        let { x, dir, mode, feet, blink, hopI, idleT } = s;
        blink = false;
        if (mode === 'hop') {
          hopI += 1;
          x += dir * 5; // hops carry him forward
          if (hopI >= ROAM_HOP) {
            mode = 'walk';
            hopI = -1;
          }
        } else if (mode === 'idle') {
          idleT -= 1;
          if (Math.random() < 0.12) blink = true;
          if (idleT <= 0) {
            mode = 'walk';
            if (Math.random() < 0.5) dir = -dir; // sometimes wanders back
          }
        } else {
          x += dir * 4;
          feet = !feet;
          const margin = 16;
          if (x <= margin) {
            x = margin;
            dir = 1;
          } else if (x >= w - size - margin) {
            x = w - size - margin;
            dir = -1;
          }
          const roll = Math.random();
          if (roll < 0.02) {
            mode = 'idle';
            idleT = 8 + Math.floor(Math.random() * 18);
          } else if (roll < 0.028) {
            mode = 'hop';
            hopI = 0;
          }
        }
        return { x, dir, mode, feet, blink, hopI, idleT };
      });
    }, 110);
    return () => clearInterval(id);
  }, [reduced, inView, size]);

  if (reduced) return null;

  const u = Math.max(1, Math.round(size / 10));
  const hopYs = [-2 * u, -3 * u, -3 * u, -2 * u, 0, 1, 0];
  const y = f.mode === 'hop' && f.hopI >= 0 && f.hopI < ROAM_HOP ? hopYs[f.hopI] : 0;
  const rects = buildRects(f.dir === 1 ? 'right' : 'left', {
    blink: f.blink,
    feet: f.mode === 'walk' && f.feet ? FEET_B : FEET_A,
  });

  return (
    <span className="pixel-roamer" ref={wrapRef} aria-hidden="true">
      <span
        className="pixel-roamer__guy"
        style={{ width: size, height: size, transform: `translate(${f.x}px, ${y}px)` }}
      >
        <Sprite rects={rects} size={size} />
      </span>
    </span>
  );
}

/** tiny pixel guy who walks the footer ticker, left to right, looping */
export function PixelWalker({ size = 22 }) {
  const reduced = useReducedMotion();
  const wrapRef = useRef(null);
  const guyRef = useRef(null);
  const inView = useInView(wrapRef, '40px');
  const [frame, setFrame] = useState(false);

  useEffect(() => {
    if (reduced || !inView) return undefined;
    let x = -40;
    const id = setInterval(() => {
      const w = wrapRef.current?.clientWidth ?? window.innerWidth;
      x += 3;
      if (x > w + 40) x = -40;
      if (guyRef.current) guyRef.current.style.transform = `translateX(${x}px)`;
      setFrame((f) => !f);
    }, 90);
    return () => clearInterval(id);
  }, [reduced, inView]);

  if (reduced) return null;

  const rects = buildRects('right', { feet: frame ? FEET_B : FEET_A });
  return (
    <span className="pixel-walker" ref={wrapRef} aria-hidden="true">
      <span className="pixel-walker__guy" ref={guyRef} style={{ width: size, height: size }}>
        <Sprite rects={rects} size={size} />
      </span>
    </span>
  );
}

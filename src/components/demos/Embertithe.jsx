import { useEffect, useRef } from 'react';
import { useInView, useReducedMotion } from '../../lib/hooks';
import { media } from '../../lib/media';
import './demos.css';

/**
 * Renders the real combat clip when embertithe-clip.mp4 is dropped in.
 * Until then: an honest slot wrapped in the game's own motif — rising embers
 * and the corruption meter.
 */
export default function Embertithe() {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const inView = useInView(rootRef, '80px');
  const reduced = useReducedMotion();
  const clip = media('embertithe-clip.mp4');

  useEffect(() => {
    if (clip || reduced) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let raf;
    let running = inView;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const P = Array.from({ length: 34 }, () => spawn(canvas, dpr, true));

    function spawn(c, d, anywhere = false) {
      return {
        x: Math.random() * c.width,
        y: anywhere ? Math.random() * c.height : c.height + 10,
        r: (0.6 + Math.random() * 1.8) * d,
        vy: (0.18 + Math.random() * 0.5) * d,
        sway: Math.random() * Math.PI * 2,
        life: 0.35 + Math.random() * 0.65,
      };
    }

    const tick = () => {
      if (!running) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        p.y -= p.vy;
        p.sway += 0.02;
        p.x += Math.sin(p.sway) * 0.3 * dpr;
        const fade = Math.min(1, p.y / (canvas.height * 0.55));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 96, 24, ${0.65 * p.life * fade})`;
        ctx.fill();
        if (p.y < -12) P[i] = spawn(canvas, dpr);
      }
      raf = requestAnimationFrame(tick);
    };

    if (running) raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [clip, inView, reduced]);

  if (clip) {
    return (
      <div className="demo demo-et">
        <video src={clip} muted loop autoPlay playsInline preload="metadata" className="demo-et__clip" />
        <CorruptionMeter reduced={reduced} />
      </div>
    );
  }

  return (
    <div className="demo demo-et" ref={rootRef}>
      <canvas ref={canvasRef} className="demo-et__embers" aria-hidden="true" />
      <div className="demo-et__slot">
        <span className="slot__mark" aria-hidden="true">
          *
        </span>
        <span className="slot__name">assets/media/embertithe-clip.mp4</span>
        <span className="slot__spec">looping combat clip · 10–20s · 1080p</span>
      </div>
      <CorruptionMeter reduced={reduced} />
    </div>
  );
}

function CorruptionMeter({ reduced }) {
  return (
    <div className="demo-et__hud" aria-hidden="true">
      <span className="demo-et__hud-label mono">corruption</span>
      <div className={`demo-et__meter ${reduced ? '' : 'is-live'}`}>
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.9}s` }} />
        ))}
      </div>
      <span className="demo-et__hud-note mono">power at a price</span>
    </div>
  );
}

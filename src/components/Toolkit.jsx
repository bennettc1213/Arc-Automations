import { useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import { site } from '../data/site';
import { useInView, useIsMobile, useReducedMotion } from '../lib/hooks';
import PixelGuy from './PixelGuy';
import './Toolkit.css';

/**
 * Drag-and-throw physics chips. Real matter.js bodies synced to DOM nodes so
 * the type stays crisp. Killed under 768px and for reduced motion — static
 * wrapped tags render instead.
 */
export default function Toolkit() {
  const isMobile = useIsMobile();
  const reduced = useReducedMotion();
  const physics = !isMobile && !reduced;

  return (
    <section className="toolkit" id="toolkit" aria-label="toolkit">
      <div className="wrap">
        <p className="eyebrow">05 — the toolkit</p>
        <div className="toolkit__headrow">
          <h2 className="section-title">what we build with.</h2>
          {physics && <p className="toolkit__hint mono">drag them. throw them. they’re insured.</p>}
        </div>
      </div>

      {physics ? <PhysicsPit key="physics" /> : <StaticChips key="static" />}
    </section>
  );
}

function StaticChips() {
  return (
    <div className="toolkit__static wrap">
      {site.toolkit.map((t) => (
        <span key={t.label} className={`chip ${t.core ? 'chip--core' : ''}`}>
          {t.label}
        </span>
      ))}
      <PixelGuy size={26} />
    </div>
  );
}

function PhysicsPit() {
  const pitRef = useRef(null);
  const chipRefs = useRef([]);
  const inView = useInView(pitRef, '-60px');
  const [dropped, setDropped] = useState(false);
  const worldRef = useRef(null);

  // build the world once the pit scrolls into view
  useEffect(() => {
    if (!inView || dropped) return;
    setDropped(true);
  }, [inView, dropped]);

  useEffect(() => {
    if (!dropped) return undefined;
    const pit = pitRef.current;
    const { Engine, Bodies, Composite, Mouse, MouseConstraint, Runner, Body } = Matter;

    const W = pit.clientWidth;
    const H = pit.clientHeight;

    const engine = Engine.create({ enableSleeping: true });
    engine.gravity.y = 1.1;

    const wall = { isStatic: true, render: { visible: false } };
    const bounds = [
      Bodies.rectangle(W / 2, H + 50, W + 200, 100, wall), // floor
      Bodies.rectangle(-50, H / 2, 100, H * 4, wall), // left
      Bodies.rectangle(W + 50, H / 2, 100, H * 4, wall), // right
      Bodies.rectangle(W / 2, -H * 1.6, W + 200, 100, wall), // high ceiling — throws stay in
    ];
    Composite.add(engine.world, bounds);

    const chips = chipRefs.current.filter(Boolean);
    const bodies = chips.map((el, i) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = 60 + Math.random() * Math.max(W - 120, 60);
      const y = -60 - i * 46 - Math.random() * 90;
      const body = Bodies.rectangle(x, y, w, h, {
        chamfer: { radius: h / 2 },
        restitution: 0.45,
        friction: 0.12,
        frictionAir: 0.012,
        angle: (Math.random() - 0.5) * 0.6,
      });
      return body;
    });
    Composite.add(engine.world, bodies);

    const mouse = Mouse.create(pit);
    const mouseConstraint = MouseConstraint.create(engine, {
      mouse,
      constraint: { stiffness: 0.18, render: { visible: false } },
    });
    Composite.add(engine.world, mouseConstraint);

    // matter's mouse eats the wheel — give scrolling back to the page
    mouse.element.removeEventListener('wheel', mouse.mousewheel);
    mouse.element.removeEventListener('DOMMouseScroll', mouse.mousewheel);

    // wake bodies on grab so sleeping piles respond
    Matter.Events.on(mouseConstraint, 'startdrag', (e) => Matter.Sleeping.set(e.body, false));

    const runner = Runner.create();
    Runner.run(runner, engine);

    let raf;
    const sync = () => {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const el = chips[i];
        el.style.transform = `translate(${b.position.x - el.offsetWidth / 2}px, ${
          b.position.y - el.offsetHeight / 2
        }px) rotate(${b.angle}rad)`;
      }
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);

    // nudge everything on resize instead of rebuilding
    const onResize = () => {
      const nw = pit.clientWidth;
      Body.setPosition(bounds[2], { x: nw + 50, y: H / 2 });
      Body.setPosition(bounds[0], { x: nw / 2, y: H + 50 });
      bodies.forEach((b) => {
        if (b.position.x > nw - 30) Body.setPosition(b, { x: nw - 60, y: b.position.y });
        Matter.Sleeping.set(b, false);
      });
    };
    window.addEventListener('resize', onResize);

    worldRef.current = { engine, runner };

    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      Runner.stop(runner);
      Engine.clear(engine);
      worldRef.current = null;
    };
  }, [dropped]);

  return (
    <div className="toolkit__pit" ref={pitRef}>
      {site.toolkit.map((t, i) => (
        <span
          key={t.label}
          ref={(el) => (chipRefs.current[i] = el)}
          className={`chip chip--physics ${t.core ? 'chip--core' : ''} ${
            dropped ? 'is-live' : ''
          }`}
        >
          {t.label}
        </span>
      ))}
      {/* the mark falls in with his tools — grab him, throw him, he blinks */}
      <span
        ref={(el) => (chipRefs.current[site.toolkit.length] = el)}
        className={`pitguy ${dropped ? 'is-live' : ''}`}
      >
        <PixelGuy size={38} />
      </span>
      <span className="toolkit__floorline" aria-hidden="true" />
    </div>
  );
}

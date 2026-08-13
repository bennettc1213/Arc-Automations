import { useEffect, useRef } from 'react';
import { gsap, ScrollTrigger } from '../lib/gsap';
import { useReducedMotion } from '../lib/hooks';
import { site } from '../data/site';
import './Stats.css';

function formatStat(value, format) {
  switch (format) {
    case 'plus':
      return `${Math.round(value).toLocaleString()}+`;
    case 'under-seconds':
      return `<${Math.round(value)}s`;
    default:
      return `${Math.round(value)}`;
  }
}

export default function Stats() {
  const rootRef = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return undefined;
    const ctx = gsap.context(() => {
      gsap.utils.toArray('.stat__value').forEach((el) => {
        const target = Number(el.dataset.value);
        const format = el.dataset.format;
        const obj = { v: 0 };
        gsap.to(obj, {
          v: target,
          duration: 1.7,
          ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
          onUpdate: () => {
            el.textContent = formatStat(obj.v, format);
          },
        });
      });

      gsap.from('.stats__copy > *', {
        y: 30,
        opacity: 0,
        duration: 0.8,
        ease: 'power3.out',
        stagger: 0.08,
        scrollTrigger: { trigger: rootRef.current, start: 'top 72%', once: true },
      });
    }, rootRef);
    return () => {
      ctx.revert();
      ScrollTrigger.refresh();
    };
  }, [reduced]);

  return (
    <section className="stats wrap" ref={rootRef} aria-label="stats and bio">
      <div className="stats__copy">
        <p className="eyebrow">01 — {site.bio.kicker}</p>
        <h2 className="section-title">{site.bio.heading}</h2>
        {site.bio.body.map((p) => (
          <p className="stats__para" key={p.slice(0, 24)}>
            {p}
          </p>
        ))}
      </div>

      <dl className="stats__grid">
        {site.stats.map((s) => (
          <div className="stat" key={s.label}>
            <dd
              className="stat__value"
              data-value={s.value}
              data-format={s.format}
            >
              {reduced ? formatStat(s.value, s.format) : formatStat(0, s.format)}
            </dd>
            <dt className="stat__label mono">{s.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

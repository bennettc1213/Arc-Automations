import { useEffect, useRef } from 'react';
import { gsap } from '../lib/gsap';
import { site } from '../data/site';
import TickNumber from './TickNumber';
import SpeedToLead from './demos/SpeedToLead';
import SupportAgent from './demos/SupportAgent';
import RueNoir from './demos/RueNoir';
import Embertithe from './demos/Embertithe';
import YouTubeGrid from './demos/YouTubeGrid';
import './Projects.css';

const DEMOS = {
  speedToLead: SpeedToLead,
  supportAgent: SupportAgent,
  rueNoir: RueNoir,
  embertithe: Embertithe,
  youtube: YouTubeGrid,
};

const INDICES = site.projects.map((p) => p.index);

export default function Projects() {
  const rootRef = useRef(null);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add(
      '(min-width: 901px) and (prefers-reduced-motion: no-preference)',
      () => {
        const panels = gsap.utils.toArray('.panel', rootRef.current);

        panels.forEach((panel, i) => {
          const visual = panel.querySelector('.panel__visual');
          const meta = panel.querySelector('.panel__meta');

          // visual scales/parallaxes in while the panel slides over the last one
          gsap.fromTo(
            visual,
            { scale: 0.92, y: 70 },
            {
              scale: 1,
              y: 0,
              ease: 'none',
              scrollTrigger: {
                trigger: panel,
                start: 'top bottom',
                end: 'top top',
                scrub: true,
              },
            }
          );

          // copy fades up once the panel is mostly in view
          gsap.from(meta.children, {
            y: 36,
            opacity: 0,
            duration: 0.7,
            ease: 'power3.out',
            stagger: 0.06,
            scrollTrigger: {
              trigger: panel,
              start: 'top 45%',
              toggleActions: 'play none none reverse',
            },
          });

          // circuit line draws in as the panel pins — like an n8n edge
          const circuit = panel.querySelector('.panel__circuit-path');
          if (circuit) {
            gsap.fromTo(
              circuit,
              { strokeDashoffset: 1 },
              {
                strokeDashoffset: 0,
                ease: 'none',
                immediateRender: false,
                scrollTrigger: {
                  trigger: panel,
                  start: 'top 88%',
                  end: 'top 25%',
                  scrub: true,
                },
              }
            );
          }

          // previous panel recedes as this one covers it
          if (i > 0) {
            gsap.fromTo(
              panels[i - 1].querySelector('.panel__inner'),
              { scale: 1, opacity: 1 },
              {
                scale: 0.95,
                opacity: 0.35,
                ease: 'none',
                scrollTrigger: {
                  trigger: panel,
                  start: 'top bottom',
                  end: 'top top',
                  scrub: true,
                },
              }
            );
          }
        });
      },
      rootRef
    );

    return () => mm.revert();
  }, []);

  return (
    <section className="projects" id="work" ref={rootRef} aria-label="featured builds">
      <header className="projects__head wrap">
        <p className="eyebrow">02 — featured builds</p>
        <h2 className="section-title">
          five things we shipped.
          <br />
          <span className="projects__head-dim">all of them real.</span>
        </h2>
      </header>

      {site.projects.map((p, i) => {
        const Demo = DEMOS[p.demo];
        return (
          <article className="panel" key={p.id} id={p.id}>
            <div className="panel__inner">
              <svg
                className="panel__circuit"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  className="panel__circuit-path"
                  d="M 6 24 C 24 24 28 52 44 52 L 62 52"
                  pathLength="1"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <div className="panel__meta">
                <div className="panel__indexrow">
                  <TickNumber value={i + 1} className="panel__num" />
                  <ol className="panel__indices mono" aria-hidden="true">
                    {INDICES.map((n) => (
                      <li key={n} className={n === p.index ? 'is-active' : ''}>
                        {n}
                      </li>
                    ))}
                  </ol>
                </div>
                <span className="panel__tag mono">{p.tag}</span>
                <h3 className="panel__title">{p.title}</h3>
                <p className="panel__copy">{p.copy}</p>
                <ul className="panel__points">
                  {p.points.map((pt) => (
                    <li key={pt}>
                      <span aria-hidden="true">→</span> {pt}
                    </li>
                  ))}
                </ul>
                <span className="panel__status mono">{p.status}</span>
              </div>

              {p.liveUrl ? (
                <a
                  className="panel__visual-wrap panel__visual-link"
                  href={p.liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${p.title} — open the live site`}
                >
                  <span className="panel__visual-url mono">
                    {p.liveUrl.replace(/^https?:\/\//, '')}
                    <i className="panel__visual-arrow" aria-hidden="true">
                      ↗
                    </i>
                  </span>
                  <div className="panel__visual">
                    <Demo />
                    <span className="panel__visual-glow" aria-hidden="true" />
                  </div>
                </a>
              ) : (
                <div className="panel__visual-wrap">
                  <div className="panel__visual">
                    <Demo />
                  </div>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

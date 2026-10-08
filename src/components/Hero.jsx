import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { gsap } from '../lib/gsap';
import { useReducedMotion } from '../lib/hooks';
import { openPilot } from '../lib/pilot';
import { scrollToId } from '../lib/SmoothScroll';
import { site } from '../data/site';
import { PixelRoamer } from './PixelGuy';
import PortalFilm from './PortalFilm';
import './Hero.css';

export default function Hero() {
  const rootRef = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return undefined;
    const ctx = gsap.context(() => {
      gsap.from('.hero__reveal > *', {
        yPercent: 110,
        duration: 1,
        ease: 'power4.out',
        stagger: 0.09,
        delay: 0.15,
      });
      gsap.from('.hero__sub, .hero__row', {
        y: 24,
        opacity: 0,
        duration: 0.9,
        ease: 'power3.out',
        stagger: 0.1,
        delay: 0.65,
      });
      /* the film arrives last and from further away. it is the only object in the
         hero rather than a line of type, so it gets the weight of one. */
      gsap.from('.hero__stage', {
        y: 40,
        opacity: 0,
        duration: 1.1,
        ease: 'power3.out',
        delay: 0.8,
      });
    }, rootRef);
    return () => ctx.revert();
  }, [reduced]);

  return (
    <section className="hero" ref={rootRef} aria-label="intro">
      {/* the mark, off duty — wandering the empty space above the fold */}
      <div className="hero__roam" aria-hidden="true">
        <PixelRoamer size={30} />
      </div>

      {/* the claim on the left, the evidence on the right. the film is the product
          running, so it goes level with the sentence it is there to back up rather
          than a scroll below it. */}
      <div className="hero__grid">
        <div className="hero__copy">
          <p className="hero__eyebrow mono">{site.hero.eyebrow}</p>

          {/* the problem in the page's own colour, what arc does about it in the
              accent. the headline holds still: a word that keeps swapping is a
              sentence nobody can finish reading. */}
          <h1 className="hero__title">
            {site.hero.lines.map((line) => (
              <span className="hero__reveal" key={line}>
                <span>{line}</span>
              </span>
            ))}
            {site.hero.accent.map((line) => (
              <span className="hero__reveal hero__reveal--accent" key={line}>
                <span>{line}</span>
              </span>
            ))}
          </h1>

          <div className="hero__foot">
            <p className="hero__sub">{site.hero.sub}</p>
            <div className="hero__row">
              <button className="hero__btn hero__btn--solid" onClick={() => openPilot()}>
                {site.cta.primary} →
              </button>
              <button
                className="hero__btn hero__btn--ghost"
                onClick={() => scrollToId('ledger')}
              >
                {site.cta.secondary} ↓
              </button>
            </div>
          </div>
        </div>

        <div className="hero__stage">
          <PortalFilm />
          <Link className="hero__stage-cap mono" to="/demo">
            {site.hero.stageCaption}
          </Link>
        </div>
      </div>
    </section>
  );
}

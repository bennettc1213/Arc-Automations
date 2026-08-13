import { useEffect, useRef, useState } from 'react';
import { scrollToId } from '../lib/SmoothScroll';
import { openPilot } from '../lib/pilot';
import { site } from '../data/site';
import PixelGuy from './PixelGuy';
import './Nav.css';

const LINKS = [
  { id: 'work', label: 'work' },
  { id: 'workflows', label: 'workflows' },
  { id: 'index', label: 'index' },
  { id: 'toolkit', label: 'toolkit' },
  { id: 'process', label: 'process' },
];

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const barRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = window.scrollY;
      setScrolled(y > 32);
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, y / max) : 0;
      if (barRef.current) barRef.current.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <header className={`nav ${scrolled ? 'nav--scrolled' : ''}`}>
      <div className="nav__inner">
        <a
          className="nav__wordmark"
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            scrollToId('top');
          }}
        >
          <PixelGuy size={24} />
          <span>
            {site.wordmark}
            <span className="nav__star">*</span>
          </span>
        </a>

        <nav className="nav__links" aria-label="sections">
          {LINKS.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              onClick={(e) => {
                e.preventDefault();
                scrollToId(l.id);
              }}
            >
              {l.label}
            </a>
          ))}
        </nav>

        <button className="nav__cta" onClick={openPilot}>
          <span className="nav__dot" aria-hidden="true" />
          start a pilot
        </button>
      </div>
      <span className="nav__progress" ref={barRef} aria-hidden="true" />
    </header>
  );
}

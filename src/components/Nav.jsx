import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { scrollToId } from '../lib/SmoothScroll';
import { openPilot } from '../lib/pilot';
import { site } from '../data/site';
import PixelGuy from './PixelGuy';
import GlowButton from './GlowButton';
import './Nav.css';

const LINKS = [
  { id: 'workflows', label: 'workflows' },
  { id: 'work', label: 'work' },
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

        <div className="nav__actions">
          {/* the operator console's door. deliberately not a GlowButton: those two
              are the site's calls to action and this is a staff entrance for an
              audience of one, so it is a small mono chip that sits quietly to the
              left of them and does not compete. the page behind it is gated on
              `arc_admins` in postgres, so a visitor clicking it learns nothing
              except that it exists — which is the same thing a /login link tells
              them. */}
          <Link className="nav__ops" to="/ops" title="operator console">
            <span className="nav__ops-dot" aria-hidden="true" />
            ops
          </Link>

          {/* the portal's front door, not the sign-in form. it explains what is
              behind the login before asking anyone to prove they belong there,
              and routes on to the dashboard or the form from its own page. */}
          <GlowButton to="/portal" variant="ghost">
            portal
          </GlowButton>

          <GlowButton variant="primary" onClick={openPilot}>
            <span className="glowbtn__dot" aria-hidden="true" />
            start a pilot
          </GlowButton>
        </div>
      </div>
      <span className="nav__progress" ref={barRef} aria-hidden="true" />
    </header>
  );
}

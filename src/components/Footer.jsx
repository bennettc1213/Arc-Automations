import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Marquee from './Marquee';
import PixelGuy, { PixelWalker } from './PixelGuy';
import { openPilot } from '../lib/pilot';
import { site } from '../data/site';
import './Footer.css';

function useMountainTime() {
  const [now, setNow] = useState('');
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'America/Denver',
    });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function Footer() {
  const now = useMountainTime();
  const tickerItems = [...site.ticker, `local time ${now || '—'}`];

  return (
    <footer className="footer" id="contact">
      <div className="footer__main wrap">
        <p className="eyebrow">07 — start</p>
        <PixelGuy size={64} className="footer__guy" />
        <h2 className="footer__heading">{site.footer.heading}</h2>
        <p className="footer__sub">{site.footer.sub}</p>
        <button className="footer__cta" onClick={openPilot}>
          {site.footer.cta} <span aria-hidden="true">→</span>
        </button>
      </div>

      {/* the operator console's door, moved off the primary nav. the page behind it
          is gated on `arc_admins` and rls, so this is about what a customer should
          have to look at, not about hiding anything. */}
      <div className="footer__util wrap">
        <Link className="footer__ops" to="/ops" title="operator console">
          <span className="footer__ops-dot" aria-hidden="true" />
          ops
        </Link>
      </div>

      {/* persistent ticker — live clock rides along, pixel guy walks the line */}
      <div className="footer__tickerwrap">
        <Marquee
          items={tickerItems}
          separator="✦"
          reverse
          className="footer__ticker"
        />
        <PixelWalker size={20} />
      </div>
    </footer>
  );
}

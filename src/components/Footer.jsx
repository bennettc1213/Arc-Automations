import { useEffect, useState } from 'react';
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

      <div className="footer__meta wrap mono">
        <span>
          {site.wordmark}
          <span className="footer__star">*</span> — {site.brand}
        </span>
        <span>{site.footer.school}</span>
        <span>{site.footer.location}</span>
        {site.footer.links.map((l) => (
          <a key={l.label} href={l.url} target="_blank" rel="noreferrer">
            {l.label} ↗
          </a>
        ))}
        <span>© {new Date().getFullYear()} {site.brand}</span>
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

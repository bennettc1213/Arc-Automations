import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import SmoothScroll from './lib/SmoothScroll';
import WarmGrid from './components/WarmGrid';
import Nav from './components/Nav';
import Hero from './components/Hero';
import Marquee from './components/Marquee';
import Projects from './components/Projects';
import Workflows from './components/Workflows';
import PilotOverlay from './components/PilotOverlay';
import WorkGrid from './components/WorkGrid';
import Toolkit from './components/Toolkit';
import Process from './components/Process';
import Footer from './components/Footer';
import SlideVeil from './portal/components/SlideVeil';
import { shouldSkipEntrance } from './portal/lib/entrance';
import { leftThePortal } from './lib/crossing';
import { site } from './data/site';

/**
 * the marketing site — lifted out of App.jsx so App can route between this and
 * the portal. the cursor and focus-ring layers stay in App because the portal
 * wants them too.
 *
 * the one thing it knows about the portal is how you got back from it. the
 * portal's own door reveals itself with a sheet sliding to the right; coming
 * back out, the same sheet leaves to the left, so the crossing is legibly a
 * return rather than a second arrival. it plays only for visitors who actually
 * came from over there — the overwhelming majority of arrivals here are from a
 * link or a search result, and putting a full-screen wipe in front of those
 * would be exactly the "seen it too many times" problem the portal's own
 * entrance was rebuilt to solve.
 *
 * decided during the first render, not in an effect. by the time effects run,
 * the route watcher in App has already moved the marker on to this page.
 */
export default function Site() {
  const { pathname } = useLocation();
  const [returning, setReturning] = useState(
    () => leftThePortal(pathname) && !shouldSkipEntrance(),
  );

  return (
    <SmoothScroll>
      {/* no onReveal: unlike the portal's door there is nothing underneath
          waiting to be let in — the site is already standing, and the sheet
          coming off it is the whole transition. */}
      {returning && <SlideVeil reverse onDone={() => setReturning(false)} />}
      <WarmGrid />
      <Nav />
      <main id="top">
        <Hero />
        <Marquee items={site.marqueeA} />
        <Workflows />
        <Marquee items={site.marqueeB} separator="·" reverse className="marquee--big" />
        <Projects />
        <WorkGrid />
        <Toolkit />
        <Process />
      </main>
      <Footer />
      <PilotOverlay />
    </SmoothScroll>
  );
}

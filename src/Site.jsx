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
import { site } from './data/site';

/**
 * the marketing site, unchanged — lifted out of App.jsx so App can route
 * between this and the portal. the cursor and focus-ring layers stay in App
 * because the portal wants them too.
 */
export default function Site() {
  return (
    <SmoothScroll>
      <WarmGrid />
      <Nav />
      <main id="top">
        <Hero />
        <Marquee items={site.marqueeA} />
        <Projects />
        <Marquee items={site.marqueeB} separator="·" reverse className="marquee--big" />
        <Workflows />
        <WorkGrid />
        <Toolkit />
        <Process />
      </main>
      <Footer />
      <PilotOverlay />
    </SmoothScroll>
  );
}

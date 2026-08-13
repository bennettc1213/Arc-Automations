import SmoothScroll from './lib/SmoothScroll';
import WarmGrid from './components/WarmGrid';
import CursorSquare from './components/CursorSquare';
import FocusRing from './components/FocusRing';
import Nav from './components/Nav';
import Hero from './components/Hero';
import Marquee from './components/Marquee';
import Stats from './components/Stats';
import Projects from './components/Projects';
import Workflows from './components/Workflows';
import PilotOverlay from './components/PilotOverlay';
import WorkGrid from './components/WorkGrid';
import Toolkit from './components/Toolkit';
import Process from './components/Process';
import Footer from './components/Footer';
import { site } from './data/site';

export default function App() {
  return (
    <SmoothScroll>
      <WarmGrid />
      <Nav />
      <main id="top">
        <Hero />
        <Marquee items={site.marqueeA} />
        <Stats />
        <Projects />
        <Marquee items={site.marqueeB} separator="·" reverse className="marquee--big" />
        <Workflows />
        <WorkGrid />
        <Toolkit />
        <Process />
      </main>
      <Footer />
      <PilotOverlay />
      <CursorSquare />
      <FocusRing />
    </SmoothScroll>
  );
}

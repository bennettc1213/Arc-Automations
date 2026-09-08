import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import CursorSquare from './components/CursorSquare';
import FocusRing from './components/FocusRing';
import Site from './Site';
import PortalHome from './portal/pages/PortalHome';
import lazyRoute from './lib/lazyRoute';
import './portal/portal.css';

/**
 * the marketing site and the portal are one deployment.
 *
 * the cursor and focus-ring layers sit above the router so they carry across
 * every route — an overlay that vanishes when you sign in makes the portal feel
 * like a different product, which is exactly the seam the portal should not have.
 *
 * note the portal routes do NOT get SmoothScroll: lenis is right for a long
 * marketing scroll and wrong for a dashboard with a scrollable feed rail inside
 * it, where hijacked wheel events fight the panel that should be receiving them.
 *
 * everything past the front door is split out of the main bundle. the dashboard
 * is eight pages, a supabase client and — for the demo — a hundred kilobytes of
 * generated data, none of which a visitor reading the marketing site will ever
 * render. PortalHome stays eager because it is the page the nav button points at.
 */

const Portal = lazyRoute(() => import('./portal/pages/Portal'));
const Demo = lazyRoute(() => import('./portal/pages/Demo'));
const Login = lazyRoute(() => import('./portal/pages/Login'));
const AuthCallback = lazyRoute(() => import('./portal/pages/AuthCallback'));

/* the operator console. split out for the same reason as the dashboard and then
   some: it is a second workspace with its own eight-page shell, and exactly one
   person on earth will ever load it. unlike PortalHome, its front door is lazy
   too — the nav button that points at it is for an audience of one, and making
   every visitor download the door on the off chance is the wrong trade. */
const OpsHome = lazyRoute(() => import('./portal/pages/OpsHome'));
const Ops = lazyRoute(() => import('./portal/pages/Ops'));

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      {/* the fallback is deliberately near-empty. a spinner that appears for eighty
          milliseconds and vanishes is a flash of something broken, and these chunks
          are small enough that the honest answer is to show nothing yet. */}
      <Suspense fallback={<div className="route-wait" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<Site />} />
          {/* /portal is the portal's front door, open to anyone. the dashboard it
              guards is a level down, and that route is the one that demands a
              session. splitting them is what lets the portal button on the
              marketing site lead somewhere that explains itself.

              both the dashboard and the demo are splats: the workspace inside them
              owns its own pages (leads, activity, automations…) so that the two
              render the identical route tree over different data. defining those
              pages twice out here is how a demo starts drifting from the product. */}
          <Route path="/portal" element={<PortalHome />} />
          <Route path="/portal/dashboard/*" element={<Portal />} />
          <Route path="/login" element={<Login />} />
          <Route path="/demo/*" element={<Demo />} />
          <Route path="/auth/callback" element={<AuthCallback />} />

          {/* the operator side, laid out to mirror the client side exactly: /ops is
              the door and /ops/console is the workspace it guards, the same way
              /portal fronts /portal/dashboard. the symmetry is not decoration — it
              is what lets both doors share one entrance implementation and one
              workspace shell. the console is gated on `arc_admins` in postgres, so
              these routes existing publicly gives away nothing but their names. */}
          <Route path="/ops" element={<OpsHome />} />
          <Route path="/ops/console/*" element={<Ops />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <CursorSquare />
      <FocusRing />
    </BrowserRouter>
  );
}

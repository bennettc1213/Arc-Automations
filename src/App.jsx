import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import CursorSquare from './components/CursorSquare';
import FocusRing from './components/FocusRing';
import Site from './Site';
import Portal from './portal/pages/Portal';
import Login from './portal/pages/Login';
import Demo from './portal/pages/Demo';
import AuthCallback from './portal/pages/AuthCallback';
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
 */
export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Site />} />
        <Route path="/portal" element={<Portal />} />
        <Route path="/login" element={<Login />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CursorSquare />
      <FocusRing />
    </BrowserRouter>
  );
}

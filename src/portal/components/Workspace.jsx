import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CommandPalette from './CommandPalette';
import Overview from '../pages/dash/Overview';
import Leads from '../pages/dash/Leads';
import Activity from '../pages/dash/Activity';
import Automations from '../pages/dash/Automations';
import Reliability from '../pages/dash/Reliability';
import Reports from '../pages/dash/Reports';
import Account from '../pages/dash/Account';
import Support from '../pages/dash/Support';
import { activeItem } from '../lib/nav';
import { downloadCsv, threadsToCsv } from '../lib/csv';
import '../workspace.css';

/**
 * the frame every dashboard page renders inside, and the single implementation the
 * signed-in portal and the public demo both use.
 *
 * that sharing is not a convenience. the demo has to be the real product running against
 * generated data — the moment it becomes a separate mock, the two drift, and a prospect is
 * being shown something that does not exist. so the route decides where the data comes from
 * and nothing below this line knows the difference.
 */

const COLLAPSE_KEY = 'arc.portal.railCollapsed';
const MOBILE_QUERY = '(max-width: 1000px)';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    /* safari in private mode throws on localStorage rather than returning null. a sidebar
       preference is never worth taking the dashboard down for. */
    return false;
  }
}

export default function Workspace({ data, base, email, onSignOut, banner, live = true }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  const page = activeItem(location.pathname, base);

  const toggleCollapse = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignored: see readCollapsed */
      }
      return next;
    });
  }, []);

  /* the drawer is closed by navigating, not by the link. tying it to onClick would leave it
     open whenever a route changes some other way — the palette, a back button, a redirect. */
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* the drawer traps scroll behind itself while open. without this the page underneath
     scrolls when you swipe the overlay, which reads as the tap having missed. */
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  /* the rail is never collapsed on a phone — it is off-canvas there, and a collapsed
     off-canvas drawer is a drawer of unlabelled glyphs. */
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (event) => setIsMobile(event.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const railCollapsed = collapsed && !isMobile;

  const exportLeads = useCallback(() => {
    downloadCsv(
      `${data.tenant.slug ?? 'arc'}-leads-${new Date().toISOString().slice(0, 10)}.csv`,
      threadsToCsv(data.threads, data.tenant.timezone),
    );
  }, [data]);

  const paletteActions = useMemo(() => {
    const list = [
      {
        label: 'export leads as csv',
        icon: 'download',
        hint: `${data.threads.length} threads`,
        run: exportLeads,
      },
    ];
    if (onSignOut) list.push({ label: 'sign out', icon: 'signout', run: onSignOut });
    return list;
  }, [data.threads.length, exportLeads, onSignOut]);

  const counts = useMemo(
    () => ({
      leads: data.threadTotal,
      reliability: data.incidents.filter((incident) => incident.open).length || null,
    }),
    [data],
  );

  const pageProps = { data, base, live, onExport: exportLeads };

  return (
    <div className={`portal ws${railCollapsed ? ' ws--tight' : ''}${drawerOpen ? ' ws--open' : ''}`}>
      <button
        type="button"
        className="ws__scrim"
        onClick={() => setDrawerOpen(false)}
        tabIndex={-1}
        aria-hidden="true"
      />

      <Sidebar
        base={base}
        tenantName={data.tenant.name}
        status={data.status}
        collapsed={railCollapsed}
        onToggleCollapse={toggleCollapse}
        counts={counts}
      />

      <div className="ws__main">
        <Topbar
          title={page.title}
          blurb={page.blurb}
          timezone={data.tenant.timezone}
          status={data.status}
          incidents={data.incidents}
          email={email}
          tenantName={data.tenant.name}
          onSignOut={onSignOut}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenMenu={() => setDrawerOpen(true)}
        />

        {banner}

        <main className="ws__page">
          <Routes>
            <Route index element={<Overview {...pageProps} />} />
            <Route path="leads" element={<Leads {...pageProps} />} />
            <Route path="activity" element={<Activity {...pageProps} />} />
            <Route path="automations" element={<Automations {...pageProps} />} />
            <Route path="reliability" element={<Reliability {...pageProps} />} />
            <Route path="reports" element={<Reports {...pageProps} />} />
            <Route path="account" element={<Account {...pageProps} />} />
            <Route path="support" element={<Support {...pageProps} />} />
            <Route path="*" element={<Overview {...pageProps} />} />
          </Routes>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        base={base}
        data={data}
        actions={paletteActions}
      />
    </div>
  );
}

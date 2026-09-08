import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CommandPalette from './CommandPalette';
import Icon from './Icon';
import Roster from '../pages/ops/Roster';
import Clients from '../pages/ops/Clients';
import ClientDetail from '../pages/ops/ClientDetail';
import NewClient from '../pages/ops/NewClient';
import Identity from '../pages/ops/Identity';
import Servers from '../pages/ops/Servers';
import SupabasePanel from '../pages/ops/SupabasePanel';
import OpsActivity from '../pages/ops/OpsActivity';
import { OPS_NAV_GROUPS, OPS_NAV_ITEMS } from '../lib/ops-nav';
import { activeItem } from '../lib/nav';
import { rosterTotals } from '../lib/ops';
import '../workspace.css';
import '../ops.css';

/**
 * the frame the ops console renders inside.
 *
 * deliberately the same Sidebar and Topbar the client workspace uses, over a
 * different nav declaration. the console is not a different application — it is
 * the same product looked at from the other side of the table, and the moment it
 * grew its own shell the two would start drifting in exactly the way the demo and
 * the dashboard are prevented from drifting.
 *
 * the roster is loaded once, above this, and handed down. every page here reads
 * the same object, so the number on the roster and the number on a client's page
 * are the same number rather than two reads a few seconds apart.
 */

const COLLAPSE_KEY = 'arc.ops.railCollapsed';
const MOBILE_QUERY = '(max-width: 1000px)';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    /* safari in private mode throws rather than returning null. a rail preference
       is never worth taking the console down for. */
    return false;
  }
}

/* the rail's status lamp, for the whole book rather than one client. worst state
   wins: an operator wants to know that something is down, not that most things
   are fine. */
function worstStatus(clients) {
  if (clients.some((client) => client.data.status.status === 'failed')) {
    return { status: 'failed', detail: 'at least one client pipeline is failing' };
  }
  if (clients.some((client) => client.data.status.status === 'degraded')) {
    return { status: 'degraded', detail: 'a recent check failed for at least one client' };
  }
  return { status: 'operational', detail: null };
}

export default function OpsWorkspace({ roster, email, onSignOut, onReload, banner }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const base = '/ops/console';
  const page = activeItem(location.pathname, base, OPS_NAV_ITEMS);
  const clients = roster.clients;
  const totals = useMemo(() => rosterTotals(clients), [clients]);
  const status = useMemo(() => worstStatus(clients), [clients]);

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

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

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

  /* every client is reachable by name, by company and by client id from ⌘K. the
     id is in there because it is the string that arrives in an email — "we're
     having trouble with ARC-4K7P-92QX" is how a support conversation starts, and
     pasting it into the search box should land on that account. */
  const records = useMemo(
    () =>
      clients.map((client) => ({
        id: `client:${client.tenant.id}`,
        icon: 'clients',
        label: client.tenant.name,
        hint: `${client.tenant.clientId ?? 'no id'} · ${client.tenant.status}`,
        keywords: [client.tenant.company, client.tenant.slug, client.tenant.clientId, client.tenant.loginEmail]
          .filter(Boolean)
          .join(' '),
        run: () => navigate(`${base}/clients/${client.tenant.id}`),
      })),
    [clients, navigate],
  );

  const actions = useMemo(() => {
    const list = [
      { label: 'add a client', icon: 'plus', run: () => navigate(`${base}/clients/new`) },
      { label: 'generate a client id', icon: 'identity', run: () => navigate(`${base}/identity`) },
      { label: 'reload the roster', icon: 'refresh', run: onReload },
      { label: 'open the client demo', icon: 'external', run: () => navigate('/demo') },
    ];
    if (onSignOut) list.push({ label: 'sign out', icon: 'signout', run: onSignOut });
    return list;
  }, [navigate, onReload, onSignOut]);

  const counts = useMemo(
    () => ({
      clients: totals.clients,
      servers: totals.connections || null,
      /* only ever a number worth reacting to. a badge that is permanently lit is
         furniture, so a healthy book shows nothing at all. */
      '': totals.degraded || null,
    }),
    [totals],
  );

  const ctx = { roster, clients, totals, base, reload: onReload, email };

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
        groups={OPS_NAV_GROUPS}
        mark="ops"
        home="/ops"
        tenantName="arc automations"
        tenantSub={`${totals.clients} client${totals.clients === 1 ? '' : 's'} · ${totals.active} live`}
        status={status}
        collapsed={railCollapsed}
        onToggleCollapse={toggleCollapse}
        counts={counts}
      />

      <div className="ws__main">
        <Topbar
          title={page.title}
          blurb={page.blurb}
          status={status}
          incidents={clients.flatMap((client) =>
            client.data.incidents.map((incident) => ({
              ...incident,
              checkType: `${client.tenant.name} · ${incident.checkType}`,
            })),
          )}
          email={email}
          tenantName="arc ops"
          onSignOut={onSignOut}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenMenu={() => setDrawerOpen(true)}
          searchLabel="search clients, ids, pages"
          windowLabel={`30d · ${totals.clients} client${totals.clients === 1 ? '' : 's'}`}
          home="/ops"
          homeLabel="ops home"
          actions={
            <button type="button" className="ws-top__icon" onClick={onReload} title="reload the roster">
              <Icon name="refresh" />
            </button>
          }
        />

        {banner}

        <main className="ws__page">
          <Routes>
            <Route index element={<Roster {...ctx} />} />
            <Route path="clients" element={<Clients {...ctx} />} />
            <Route path="clients/new" element={<NewClient {...ctx} />} />
            <Route path="clients/:tenantId" element={<ClientDetail {...ctx} />} />
            <Route path="activity" element={<OpsActivity {...ctx} />} />
            <Route path="servers" element={<Servers {...ctx} />} />
            <Route path="supabase" element={<SupabasePanel {...ctx} />} />
            <Route path="identity" element={<Identity {...ctx} />} />
            <Route path="*" element={<Roster {...ctx} />} />
          </Routes>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        base={base}
        items={OPS_NAV_ITEMS}
        records={records}
        recordsLabel="clients"
        actions={actions}
        placeholder="search a client, a client id, a page…"
        emptyHint="clients are searchable by name, company, slug and client id."
      />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CommandPalette from './CommandPalette';
import Icon from './Icon';
import RoadmapAssistant from './RoadmapAssistant';
import Roster from '../pages/ops/Roster';
import Clients from '../pages/ops/Clients';
import ClientDetail from '../pages/ops/ClientDetail';
import NewClient from '../pages/ops/NewClient';
import PastClients from '../pages/ops/PastClients';
import Identity from '../pages/ops/Identity';
import Servers from '../pages/ops/Servers';
import Alerts from '../pages/ops/Alerts';
import AuditLog from '../pages/ops/AuditLog';
import SupabasePanel from '../pages/ops/SupabasePanel';
import OpsActivity from '../pages/ops/OpsActivity';
import { OPS_NAV_GROUPS, OPS_NAV_ITEMS } from '../lib/ops-nav';
import { activeItem } from '../lib/nav';
import { checkingVerdict, pipelineVerdict, probePipelines, rosterTotals } from '../lib/ops';
import { formatClock } from '../lib/format';
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
 *
 * two things are added to it here rather than above. the book is split into the
 * clients still on it and past clients, so no page has to remember to leave a
 * deboarded client out of its totals. and every current client carries a
 * `pipeline` verdict from the live check, which runs when the console opens and
 * every few minutes after — so "connected" on any page means something asked
 * ingest and n8n just now, not that somebody once typed "active".
 */

const COLLAPSE_KEY = 'arc.ops.railCollapsed';
const MOBILE_QUERY = '(max-width: 1000px)';

/* often enough that a workflow switched off shows up while you are still in the
   console, rarely enough to stay well clear of n8n's api rate limit. */
const PROBE_EVERY_MS = 5 * 60 * 1000;

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
   are fine. judged from the pipeline verdicts, so the lamp and the roster's
   pipeline column are the same answer. */
function bookStatus(clients, probe) {
  if (probe.kind === 'checking' && !probe.result) {
    return { status: 'unchecked', word: 'checking pipelines…', detail: null };
  }

  const names = (list) =>
    list
      .slice(0, 3)
      .map((client) => client.tenant.name)
      .join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');

  const down = clients.filter((client) => client.pipeline.state === 'disconnected');
  if (down.length > 0) {
    return {
      status: 'failed',
      word: `${down.length} not connected`,
      detail: `not connected: ${names(down)}`,
    };
  }

  const partial = clients.filter((client) => client.pipeline.state === 'partial');
  if (partial.length > 0) {
    return {
      status: 'degraded',
      word: `${partial.length} need${partial.length === 1 ? 's' : ''} a look`,
      detail: `partly connected: ${names(partial)}`,
    };
  }

  if (!clients.some((client) => client.pipeline.state === 'connected')) {
    return { status: 'unchecked', word: 'nothing connected yet', detail: null };
  }

  return { status: 'operational', word: 'all connected', detail: null };
}

export default function OpsWorkspace({ roster, email, onSignOut, onReload, onReloadBuilds, banner }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [probe, setProbe] = useState({ kind: 'checking', result: null, error: null });
  const location = useLocation();
  const navigate = useNavigate();

  const base = '/ops/console';
  const page = activeItem(location.pathname, base, OPS_NAV_ITEMS);

  const current = useMemo(
    () => roster.clients.filter((client) => client.tenant.status !== 'archived'),
    [roster.clients],
  );

  /* most recently deboarded first. a tenant archived before migration 0007 has no
     date and sorts last. */
  const pastClients = useMemo(
    () =>
      roster.clients
        .filter((client) => client.tenant.status === 'archived')
        .sort((a, b) => String(b.tenant.archivedAt ?? '').localeCompare(String(a.tenant.archivedAt ?? ''))),
    [roster.clients],
  );

  /* the probe reads the latest client list through a ref, so a roster reload after
     every save does not also re-ask n8n about the whole book. it re-runs when the
     set of clients changes, which is when there is something new to ask about. */
  const currentRef = useRef(current);
  currentRef.current = current;
  const clientKey = current.map((client) => client.tenant.id).join(',');

  const runProbe = useCallback(async () => {
    setProbe((prev) => ({ ...prev, kind: 'checking' }));
    try {
      const result = await probePipelines(currentRef.current);
      setProbe({ kind: 'ready', result, error: null });
    } catch (error) {
      /* the last good answer is kept. a live check that fails once should not wipe
         out what it learned a few minutes ago — the verdicts fall back to the
         event log only if there was never an answer at all. */
      setProbe((prev) => ({ kind: 'error', result: prev.result, error: error.message }));
    }
  }, []);

  useEffect(() => {
    runProbe();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') runProbe();
    }, PROBE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [runProbe, clientKey]);

  const clients = useMemo(() => {
    const now = DateTime.now();
    return current.map((client) => ({
      ...client,
      pipeline:
        probe.kind === 'checking' && !probe.result
          ? checkingVerdict()
          : pipelineVerdict(client, probe.result, now),
    }));
  }, [current, probe]);

  const allClients = useMemo(() => [...clients, ...pastClients], [clients, pastClients]);

  const totals = useMemo(() => rosterTotals(clients, pastClients), [clients, pastClients]);
  const status = useMemo(() => bookStatus(clients, probe), [clients, probe]);

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
     pasting it into the search box should land on that account. past clients
     included: that email can come a year after they left. */
  const records = useMemo(
    () =>
      allClients.map((client) => ({
        id: `client:${client.tenant.id}`,
        icon: client.tenant.status === 'archived' ? 'archive' : 'clients',
        label: client.tenant.name,
        hint: `${client.tenant.clientId ?? 'no id'} · ${
          client.tenant.status === 'archived' ? 'past client' : client.pipeline?.word ?? client.tenant.status
        }`,
        keywords: [client.tenant.company, client.tenant.slug, client.tenant.clientId, client.tenant.loginEmail]
          .filter(Boolean)
          .join(' '),
        run: () => navigate(`${base}/clients/${client.tenant.id}`),
      })),
    [allClients, navigate],
  );

  const actions = useMemo(() => {
    const list = [
      { label: 'add a client', icon: 'plus', run: () => navigate(`${base}/clients/new`) },
      { label: 'check every pipeline now', icon: 'pulse', run: runProbe },
      { label: 'generate a client id', icon: 'identity', run: () => navigate(`${base}/identity`) },
      { label: 'reload the roster', icon: 'refresh', run: onReload },
      { label: 'ask the roadmap assistant', icon: 'support', run: () => setRoadmapOpen(true) },
      { label: 'open the client demo', icon: 'external', run: () => navigate('/demo') },
    ];
    if (onSignOut) list.push({ label: 'sign out', icon: 'signout', run: onSignOut });
    return list;
  }, [navigate, onReload, onSignOut, runProbe]);

  const counts = useMemo(
    () => ({
      clients: totals.clients,
      servers: totals.connections || null,
      'past-clients': totals.archived || null,
      /* only ever a number worth reacting to. a badge that is permanently lit is
         furniture, so a healthy book shows nothing at all. */
      '': totals.disconnected + totals.partial || null,
    }),
    [totals],
  );

  const checkedAt = probe.result?.checked_at;
  const checkLabel =
    probe.kind === 'checking'
      ? 'checking…'
      : probe.kind === 'error' && !probe.result
        ? 'live check unavailable'
        : checkedAt
          ? `checked ${formatClock(checkedAt, DateTime.local().zoneName).slice(0, 5)}`
          : 'check now';

  const ctx = {
    roster,
    clients,
    pastClients,
    allClients,
    totals,
    base,
    reload: onReload,
    /* falls back to the full reload wherever the console is mounted without it. */
    reloadBuilds: onReloadBuilds ?? onReload,
    email,
    probe,
    runProbe,
  };

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
        tenantSub={`${totals.clients} client${totals.clients === 1 ? '' : 's'} · ${
          probe.result || probe.kind === 'error' ? `${totals.connected} connected` : 'checking…'
        }`}
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
            <>
              <button
                type="button"
                className={`ws-top__check ws-top__check--${probe.kind}`}
                onClick={runProbe}
                disabled={probe.kind === 'checking'}
                title={
                  probe.error
                    ? `the live check failed: ${probe.error}`
                    : 'ask ingest and n8n, right now, whether every pipeline is connected'
                }
              >
                <Icon name="pulse" />
                <span>{checkLabel}</span>
              </button>
              <button type="button" className="ws-top__icon" onClick={onReload} title="reload the roster">
                <Icon name="refresh" />
              </button>
            </>
          }
        />

        {banner}

        <main className="ws__page">
          {/* only on the page itself: a client's own page sits under "clients" in the
              nav, and "the full list" above one client would describe the wrong page. */}
          {page.blurb &&
            location.pathname.replace(/\/+$/, '') === (page.to ? `${base}/${page.to}` : base) && (
              <p className="ws-intro">{page.blurb}</p>
            )}
          <Routes>
            <Route index element={<Roster {...ctx} />} />
            <Route path="clients" element={<Clients {...ctx} />} />
            <Route path="clients/new" element={<NewClient {...ctx} />} />
            <Route path="clients/:tenantId" element={<ClientDetail {...ctx} />} />
            <Route path="past-clients" element={<PastClients {...ctx} />} />
            <Route path="activity" element={<OpsActivity {...ctx} />} />
            <Route path="servers" element={<Servers {...ctx} />} />
            <Route path="alerts" element={<Alerts {...ctx} />} />
            <Route path="audit" element={<AuditLog {...ctx} />} />
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

      {/* answers questions about the canonical roadmap from the ops function. operators
          only — this shell never renders for anyone else, and ops refuses them anyway. */}
      <RoadmapAssistant open={roadmapOpen} onOpenChange={setRoadmapOpen} />
    </div>
  );
}

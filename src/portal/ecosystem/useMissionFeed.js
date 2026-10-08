import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { readEvents } from '../lib/event-row';
import { adaptEvent, mergeEvents } from './model';

export default function useMissionFeed(tenantId, demo) {
  const [feed, setFeed] = useState({
    events: [],
    status: 'connecting',
    lastRead: null,
    error: null,
    providers: [],
    providerError: null,
    active: null,
  });
  useEffect(() => {
    if (demo) return;
    const db = getSupabase();
    if (!db) {
      setFeed((f) => ({ ...f, status: 'offline', error: 'No database connection configured.' }));
      return;
    }
    let live = true,
      busy = false,
      initialized = false,
      realtime = false;
    const seen = new Set();
    const accept = (rows, initial = false) => {
      if (!live) return;
      const incoming = rows.map((row) => adaptEvent(row, tenantId)).filter(Boolean);
      const fresh = incoming.filter((e) => !seen.has(e.id));
      incoming.forEach((e) => seen.add(e.id));
      // A historical backfill must not make Damon pretend he is working now.
      const active = !initial
        ? fresh
            .filter((e) => !e.isCanary && Date.now() - Date.parse(e.timestamp) < 120000)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
        : null;
      setFeed((f) => ({
        ...f,
        events: mergeEvents(f.events, incoming, tenantId),
        ...(active ? { active } : {}),
      }));
    };
    async function refresh() {
      if (!live || busy || document.hidden) return;
      busy = true;
      try {
        const { data, error } = await readEvents((columns) =>
          db
            .from('events')
            .select(columns)
            .eq('tenant_id', tenantId)
            .order('occurred_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(300),
        );
        if (error) throw new Error('Event feed unavailable. Check the connection and your OPS session.');
        if (!live) return;
        accept(data ?? [], !initialized);
        initialized = true;
        setFeed((f) => ({ ...f, status: realtime ? 'live' : 'polling', lastRead: Date.now(), error: null }));
      } catch (error) {
        if (live) setFeed((f) => ({ ...f, status: 'offline', active: null, error: error.message }));
      } finally {
        busy = false;
      }
    }
    async function providers() {
      const { data, error } = await db
        .from('provider_connections')
        .select('tenant_id,connector_key,status,health_status,last_verified_at')
        .eq('tenant_id', tenantId);
      if (live)
        setFeed((f) => ({
          ...f,
          providers: error ? [] : (data ?? []).filter((p) => p.tenant_id === tenantId),
          providerError: error
            ? 'Provider metadata unavailable. Inspect client activation for readiness.'
            : null,
        }));
    }
    const channel = db
      .channel(`mission-${tenantId}-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'events', filter: `tenant_id=eq.${tenantId}` },
        (payload) => accept([payload.new], !initialized),
      )
      .subscribe((status) => {
        realtime = status === 'SUBSCRIBED';
        if (live) setFeed((f) => ({ ...f, status: f.lastRead ? (realtime ? 'live' : 'polling') : f.status }));
      });
    refresh();
    providers();
    const timer = setInterval(refresh, 8000);
    const providerTimer = setInterval(providers, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(providerTimer);
      document.removeEventListener('visibilitychange', refresh);
      db.removeChannel(channel);
    };
  }, [tenantId, demo]);
  return feed;
}

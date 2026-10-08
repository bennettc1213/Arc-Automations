import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ArcMark from '../../../components/ArcMark';
import ConfigEditor from '../../components/ConfigEditor';
import MissionScene from '../../ecosystem/MissionScene';
import useMissionFeed from '../../ecosystem/useMissionFeed';
import {
  AGENT,
  DEMO_TENANT,
  STATIONS,
  STATION_BY_ID,
  demoSequence,
  stationState,
} from '../../ecosystem/model';
import { connectVault, syncVault, downloadJournal } from '../../ecosystem/memory';
import '../../ecosystem/mission.css';

const time = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
function PixelAgent() {
  return (
    <span className="mc-pixel-agent" aria-hidden="true">
      <i />
      <b />
      <em />
      <s />
    </span>
  );
}

export default function MissionControl({ clients = [], base = '/ops/console' }) {
  const [params, setParams] = useSearchParams();
  const id = params.get('client');
  const client = id === DEMO_TENANT.id ? { tenant: DEMO_TENANT } : clients.find((c) => c.tenant.id === id);
  const choose = (value) => setParams(value ? { client: value } : {});
  if (!client)
    return (
      <div className="mc mc-launch">
        <header className="mc-header">
          <Link to={base} className="mc-brand">
            <ArcMark size={25} />
            <strong>
              arc<span>.</span>
            </strong>
            <span className="mc-wordmark">MISSION CONTROL</span>
          </Link>
          <span className="mc-badge">OPS ACCESS</span>
        </header>
        <main className="mc-launch-body">
          <div className="mc-kicker">
            <i className="mc-dot mc-dot--ok" /> ARC OPERATIONS / ORBITAL NETWORK
          </div>
          <h1>
            Your business systems.
            <br />
            <span>One mission control.</span>
          </h1>
          <p>
            Follow Damon Reid through the recovery loop. Every signal, every handoff, every piece of proof —
            in one place.
          </p>
          <div className="mc-launch-agent">
            <PixelAgent />
            <div>
              <small>YOUR RECOVERY AGENT</small>
              <h2>Damon Reid</h2>
              <span>Standing by for a client assignment.</span>
            </div>
            <span className="mc-badge">01 AGENT</span>
          </div>
          <div className="mc-section-heading">
            <h2>Select a client ecosystem</h2>
            <span>{clients.length} AVAILABLE</span>
          </div>
          {id && (
            <p role="alert">
              That client is not available in your active roster. Choose an available client below.
            </p>
          )}
          <div className="mc-client-grid">
            {clients.map((c) => (
              <button className="mc-client-card" key={c.tenant.id} onClick={() => choose(c.tenant.id)}>
                <span className="mc-card-icon">◇</span>
                <small>CLIENT ECOSYSTEM</small>
                <h3>{c.tenant.company || c.tenant.name}</h3>
                <p>
                  {c.tenant.clientId || 'ARC client'} · {c.tenant.status}
                </p>
                <span>
                  Enter mission control <b>↗</b>
                </span>
              </button>
            ))}
            <button className="mc-client-card mc-client-card--demo" onClick={() => choose(DEMO_TENANT.id)}>
              <span className="mc-card-icon">▷</span>
              <small>SIMULATED TRAINING ENVIRONMENT</small>
              <h3>Explore the station</h3>
              <p>A missed call. A recovery. A clear trail of proof.</p>
              <span>
                Launch demo replay <b>↗</b>
              </span>
            </button>
          </div>
          <footer className="mc-launch-foot">
            <span>
              11 STATIONS <b>+</b> 3D AGENT FOLLOW <b>+</b> 2D TACTICAL MAP <b>+</b> OBSIDIAN MEMORY
            </span>
            <Link to={base}>← Back to OPS</Link>
          </footer>
        </main>
      </div>
    );
  return <Mission key={client.tenant.id} {...{ client, clients, base, choose }} />;
}

function StationEditor({ tenant, onClose }) {
  const dialog = useRef(null);
  const [scope, setScope] = useState('module');
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog className="mc-editor portal" ref={dialog} onClose={onClose}>
      <header>
        <div>
          <span className="mc-kicker">STATION CONFIGURATION / {tenant.name}</span>
          <h2>Rules & filters</h2>
        </div>
        <button
          className="mc-icon-btn"
          onClick={() => dialog.current.close()}
          aria-label="Close station editor"
        >
          ×
        </button>
      </header>
      <p>
        Changes use ARC’s existing draft, review and publish flow. Publishing may require a new activation
        check.
      </p>
      <nav aria-label="Configuration scope">
        <button className="ws-btn" aria-pressed={scope === 'module'} onClick={() => setScope('module')}>
          Lead Recovery
        </button>
        <button className="ws-btn" aria-pressed={scope === 'tenant'} onClick={() => setScope('tenant')}>
          Business settings
        </button>
      </nav>
      <ConfigEditor
        key={scope}
        tenantId={tenant.id}
        scope={scope}
        moduleKey={scope === 'module' ? 'lead_recovery' : null}
        timezone={tenant.timezone}
        readOnly={tenant.status === 'archived'}
      />
    </dialog>
  );
}

function Mission({ client, clients, base, choose }) {
  const tenant = client.tenant,
    demo = tenant.id === DEMO_TENANT.id;
  const feed = useMissionFeed(tenant.id, demo);
  const [mode, setMode] = useState('follow');
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [zoom, setZoom] = useState(() => (window.innerWidth > 1000 ? 1.22 : 1));
  const [reset, setReset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('activity');
  const [editing, setEditing] = useState(false);
  const [scenario, setScenario] = useState('recovery');
  const [sequence, setSequence] = useState(() => demoSequence());
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [fallback, setFallback] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [vault, setVault] = useState(null);
  const [memory, setMemory] = useState({ count: 0, error: null, at: null });
  const [connecting, setConnecting] = useState(false);
  const memoryQueue = useRef(Promise.resolve());
  const vaultRef = useRef(null);
  const close = () => {
    setSelected(null);
    setTab('activity');
  };
  const inspect = useCallback((id) => {
    setSelected(id);
    setTab(id === 'memory' ? 'memory' : 'station');
  }, []);
  const onFailure = useCallback(() => {
    setFallback(true);
    setMode('map');
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!demo || !playing || step >= sequence.length - 1) return;
    const timer = setTimeout(() => setStep((i) => i + 1), 4000);
    return () => clearTimeout(timer);
  }, [demo, playing, step, sequence]);
  const events = useMemo(
    () => (demo ? sequence.slice(0, step + 1).reverse() : feed.events),
    [demo, sequence, step, feed.events],
  );
  const active = demo
    ? sequence[step]
    : feed.active && now - Date.parse(feed.active.timestamp) < 25000 && feed.status !== 'offline'
      ? feed.active
      : null;
  const activeStation = active?.station ?? 'command';
  const statuses = Object.fromEntries(
    STATIONS.map((s) => [
      s.id,
      stationState(s, events, {
        demo,
        memory: !!vault && !memory.error,
        providers: feed.providers,
        providerError: feed.providerError,
      }),
    ]),
  );
  const station = STATION_BY_ID[selected];
  const displayEvents = events.filter(
    (e) =>
      (filter !== 'issues' || ['error', 'attention'].includes(e.status)) &&
      (filter !== 'real' || !e.isCanary) &&
      (!search ||
        `${e.summary} ${e.type} ${e.correlationId ?? ''}`.toLowerCase().includes(search.toLowerCase())),
  );
  const stationEvents = station ? events.filter((e) => e.station === station.id).slice(0, 10) : [];
  const issues = events.filter((e) => e.status === 'error' || e.status === 'attention').length;
  useEffect(() => {
    if (!vault) return;
    let live = true;
    memoryQueue.current = memoryQueue.current
      .catch(() => {})
      .then(async () => {
        if (vaultRef.current !== vault) return;
        try {
          const count = await syncVault(vault, events, () => vaultRef.current === vault);
          if (live) setMemory({ count, error: null, at: Date.now() });
        } catch {
          if (live)
            setMemory((m) => ({
              ...m,
              error: 'Vault write failed. Reconnect the folder and check its write permission.',
            }));
        }
      });
    return () => {
      live = false;
    };
  }, [events, vault]);
  useEffect(
    () => () => {
      vaultRef.current = null;
    },
    [],
  );
  async function connect() {
    setConnecting(true);
    try {
      const result = await connectVault(tenant);
      vaultRef.current = result;
      setVault(result);
      setMemory({ count: 0, error: null, at: null });
    } catch (error) {
      if (error.name !== 'AbortError') setMemory((m) => ({ ...m, error: error.message }));
    } finally {
      setConnecting(false);
    }
  }
  function replay(value = scenario) {
    setScenario(value);
    setSequence(demoSequence(value));
    setStep(0);
    setPlaying(true);
  }
  const editLink =
    station?.destination === 'connections'
      ? `${base}/servers`
      : station?.destination !== null
        ? `${base}/clients/${tenant.id}${station?.destination ? `/${station.destination}` : ''}`
        : null;
  const feedWord = demo
    ? 'SIMULATION'
    : feed.status === 'live'
      ? 'LIVE EVENTS'
      : feed.status === 'polling'
        ? 'POLLING · 8s'
        : feed.status === 'offline'
          ? 'FEED OFFLINE'
          : 'CONNECTING';
  return (
    <div className="mc mc-mission">
      {editing && !demo && <StationEditor tenant={tenant} onClose={() => setEditing(false)} />}
      <header className="mc-header">
        <Link to={base} className="mc-brand">
          <ArcMark size={24} />
          <strong>
            arc<span>.</span>
          </strong>
          <span className="mc-wordmark">MISSION CONTROL</span>
        </Link>
        <div className="mc-header-divider" />
        <label className="mc-client-select">
          <small>CLIENT ECOSYSTEM</small>
          <select
            aria-label="Select client ecosystem"
            value={tenant.id}
            onChange={(e) => choose(e.target.value)}
          >
            {clients.map((c) => (
              <option key={c.tenant.id} value={c.tenant.id}>
                {c.tenant.company || c.tenant.name}
              </option>
            ))}
            <option value={DEMO_TENANT.id}>Summit Air & Heat · DEMO</option>
          </select>
        </label>
        <span className={`mc-badge ${demo ? 'mc-badge--demo' : ''}`}>
          <i
            className={`mc-dot mc-dot--${demo ? 'warn' : feed.status === 'offline' ? 'error' : feed.lastRead ? 'ok' : 'muted'}`}
          />
          {feedWord}
        </span>
        <Link className="mc-back" to={base}>
          ↗ OPS portal
        </Link>
        <button className="mc-icon-btn" aria-label="Choose another ecosystem" onClick={() => choose(null)}>
          ⊞
        </button>
      </header>
      <div className="mc-subheader">
        <span>
          <i className="mc-dot mc-dot--warn" />
          {demo
            ? 'Training sector · simulated events, no messages sent'
            : 'Read-only telemetry · backend controls every action'}
        </span>
        <span>
          HEALTH {demo ? 'SIMULATED' : 'UNVERIFIED'} <b>／</b> {time(now)} LOCAL
        </span>
      </div>
      <div className="mc-workspace">
        <aside className="mc-stations">
          <div className="mc-section-heading">
            <h2>STATIONS</h2>
            <span>11</span>
          </div>
          <nav aria-label="Ecosystem stations">
            {STATIONS.filter((s) => s.id !== 'command').map((s) => (
              <button
                key={s.id}
                className={`mc-station-nav ${selected === s.id ? 'is-selected' : ''} ${activeStation === s.id ? 'is-active' : ''}`}
                onClick={() => inspect(s.id)}
                style={{ '--station': s.color }}
              >
                <span className="mc-station-number">{s.code}</span>
                <span>
                  <b>{s.name}</b>
                  <small>{s.tool}</small>
                </span>
                <i className={`mc-dot mc-dot--${statuses[s.id].tone}`} />
              </button>
            ))}
          </nav>
          <div className="mc-side-bottom">
            <span className="mc-kicker">PILOT SCOPE</span>
            <p>
              One agent.
              <br />
              Missed jobs recovered.
              <br />
              Every result needs proof.
            </p>
            <button
              onClick={() => {
                setTab('setup');
                setSelected(null);
              }}
              className="mc-text-button"
            >
              ＋ Connect a station
            </button>
          </div>
        </aside>
        <main className="mc-center">
          <div className="mc-scene-bar">
            <div>
              <span className="mc-kicker">
                ORBITAL STATION / {demo ? 'DEMO-01' : tenant.clientId || 'ARC'}
              </span>
              <h1>{tenant.company || tenant.name}</h1>
            </div>
            <div className="mc-view-switch" aria-label="Camera mode">
              <button
                aria-pressed={mode === 'follow'}
                onClick={() => !fallback && setMode('follow')}
                disabled={fallback}
              >
                ◈ 3D follow
              </button>
              <button aria-pressed={mode === 'map'} onClick={() => setMode('map')}>
                ⊞ 2D free cam
              </button>
            </div>
          </div>
          <div className="mc-scene-wrap">
            <MissionScene
              {...{
                mode,
                activeStation,
                selected,
                onSelect: inspect,
                reduced,
                statuses,
                zoom,
                reset,
                onFailure,
              }}
            />
            <div className="mc-scene-caption">
              <i
                className={`mc-dot mc-dot--${demo ? 'warn' : feed.status === 'offline' ? 'error' : 'muted'}`}
              />
              {fallback
                ? 'WebGL unavailable · 2D fallback'
                : mode === 'map'
                  ? 'TACTICAL VIEW · DRAG TO PAN'
                  : 'AGENT CAMERA · FOLLOWING DAMON'}
              <span>
                {demo ? 'DEMO' : feed.lastRead ? `READ ${time(feed.lastRead)}` : 'AWAITING CONNECTION'}
              </span>
            </div>
            <div className="mc-scene-tools">
              <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.65, z + 0.15))}>
                +
              </button>
              <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.65, z - 0.15))}>
                −
              </button>
              <button
                aria-label="Reset camera"
                onClick={() => {
                  setZoom(1);
                  setReset((r) => r + 1);
                }}
              >
                ⌖
              </button>
              <button aria-label="Reduce motion" aria-pressed={reduced} onClick={() => setReduced((r) => !r)}>
                Ⅱ
              </button>
            </div>
            <div className="mc-legend">
              <span>
                <i className="mc-dot mc-dot--ok" />
                Evidence
              </span>
              <span>
                <i className="mc-dot mc-dot--warn" />
                Review
              </span>
              <span>
                <i className="mc-dot mc-dot--error" />
                Error
              </span>
              <span>
                <i className="mc-dot mc-dot--muted" />
                Unverified
              </span>
            </div>
          </div>
          <div className="mc-agent-strip">
            <PixelAgent />
            <div>
              <small>ARC LEAD RECOVERY AGENT</small>
              <h2>
                {AGENT.name}
                <span>01</span>
              </h2>
              <p>
                <i
                  className={`mc-dot mc-dot--${active?.status === 'error' ? 'error' : active ? 'warn' : 'muted'}`}
                />
                {active
                  ? `${active.action} · ${STATION_BY_ID[activeStation].name}`
                  : 'Standing by · waiting for a new event'}
              </p>
            </div>
            <div className="mc-agent-task">
              <small>{demo ? 'SIMULATED TASK' : 'LATEST OBSERVED ACTION'}</small>
              <p>{active?.summary || 'No current action reported by the backend.'}</p>
            </div>
            <button className="mc-text-button" onClick={() => inspect('command')}>
              Inspect ↗
            </button>
          </div>
          {demo && (
            <div className="mc-replay">
              <span className="mc-badge mc-badge--demo">DEMO REPLAY</span>
              <select aria-label="Replay scenario" value={scenario} onChange={(e) => replay(e.target.value)}>
                <option value="recovery">Missed call → booking → proof</option>
                <option value="safety">Safety stop → human review</option>
                <option value="failure">Twilio failure → handoff</option>
              </select>
              <button onClick={() => setPlaying((p) => !p)} disabled={step === sequence.length - 1}>
                {playing ? 'Ⅱ Pause' : '▷ Play'}
              </button>
              <button onClick={() => replay()}>↺ Restart</button>
              <span>
                {step + 1} / {sequence.length}
              </span>
            </div>
          )}
          {feed.error && !demo && (
            <p role="alert" className="mc-notice">
              {feed.error} Retrying automatically. Previously loaded evidence is retained.
            </p>
          )}
        </main>
        <aside className="mc-inspector">
          <div className="mc-panel-tabs">
            <button aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>
              Activity
            </button>
            <button
              aria-pressed={tab === 'station' || tab === 'setup'}
              onClick={() => inspect(selected || 'command')}
            >
              Inspect
            </button>
            <button aria-pressed={tab === 'memory'} onClick={() => inspect('memory')}>
              Memory
            </button>
          </div>
          {tab === 'activity' && (
            <>
              <div className="mc-panel-heading">
                <span className="mc-kicker">EVENT TELEMETRY</span>
                <h2>
                  The evidence trail<span>{events.length}</span>
                </h2>
                <p>
                  {demo
                    ? 'A simulated recovery, one recorded step at a time.'
                    : 'Latest 300 events. New events stream in, with an 8-second refresh fallback.'}
                </p>
              </div>
              <div className="mc-filters">
                <input
                  aria-label="Search events"
                  placeholder="Search event or correlation…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="Filter event display"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All evidence</option>
                  <option value="issues">Errors & review</option>
                  <option value="real">Exclude synthetic checks</option>
                </select>
              </div>
              <div className="mc-feed">
                {displayEvents.length ? (
                  displayEvents.slice(0, 80).map((e, i) => (
                    <button
                      className={`mc-event mc-event--${e.status}`}
                      key={e.id}
                      onClick={() => inspect(e.station)}
                    >
                      <div className="mc-event-top">
                        <span>{STATION_BY_ID[e.station].tool}</span>
                        <time>{time(e.timestamp)}</time>
                      </div>
                      <p>{e.summary}</p>
                      <small>
                        {e.isCanary ? 'SYNTHETIC CHECK' : demo ? 'DEMO' : e.status.toUpperCase()} · {e.type}
                      </small>
                      {i === 0 && <span className="mc-latest">LATEST</span>}
                    </button>
                  ))
                ) : (
                  <div className="mc-empty">
                    <span>⌁</span>
                    <h3>
                      {filter !== 'all' || search ? 'No matching events' : 'Listening for the first signal'}
                    </h3>
                    <p>
                      {filter !== 'all' || search
                        ? 'Change the display filters to see more evidence.'
                        : 'Events appear here when the selected client’s backend records them.'}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === 'station' && station && (
            <div className="mc-detail">
              <div className="mc-panel-heading">
                <span className="mc-kicker">
                  STATION {station.code} / {station.tool}
                </span>
                <h2>{station.name}</h2>
                <span className={`mc-status mc-status--${statuses[station.id].tone}`}>
                  {statuses[station.id].label}
                </span>
                <p>{station.description}</p>
              </div>
              <div className="mc-detail-body">
                <div className="mc-callout">{statuses[station.id].detail}</div>
                <h3>Connect & configure</h3>
                <ol>
                  {station.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                {editLink && !demo && (
                  <Link className="mc-primary-button" to={editLink}>
                    {station.id === 'business' || station.id === 'qualification'
                      ? 'Edit rules & filters'
                      : 'Open station controls'}{' '}
                    ↗
                  </Link>
                )}
                {demo && (
                  <p className="mc-fine">
                    Configuration controls become available when you select a real client.
                  </p>
                )}
                <h3>
                  Recent station evidence <span>{stationEvents.length}</span>
                </h3>
                {stationEvents.length ? (
                  stationEvents.map((e) => (
                    <details className="mc-evidence" key={e.id}>
                      <summary>
                        <span>{e.summary}</span>
                        <small>{time(e.timestamp)}</small>
                      </summary>
                      <dl>
                        <dt>Source event</dt>
                        <dd>{e.id}</dd>
                        <dt>Correlation</dt>
                        <dd>{e.correlationId || 'Not recorded'}</dd>
                        <dt>Type</dt>
                        <dd>{e.type}</dd>
                        {Object.entries(e.meta).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k.replaceAll('_', ' ')}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                      {!demo && <Link to={`${base}/clients/${tenant.id}`}>Open client evidence ↗</Link>}
                    </details>
                  ))
                ) : (
                  <p className="mc-fine">No evidence for this station in the loaded window.</p>
                )}
                <div className="mc-callout mc-callout--quiet">
                  Queue depth and verified completed jobs are unavailable in this telemetry view. A completed
                  run or booking is not a billing claim.
                </div>
              </div>
            </div>
          )}
          {tab === 'memory' && (
            <div className="mc-detail">
              <div className="mc-panel-heading">
                <span className="mc-kicker">OBSIDIAN / LOCAL VAULT</span>
                <h2>Damon’s memory</h2>
                <span className={`mc-status mc-status--${vault && !memory.error ? 'ok' : 'muted'}`}>
                  {vault && !memory.error ? 'Folder connected' : 'Awaiting connection'}
                </span>
                <p>Decisions, outcomes and proof references, saved as readable Markdown.</p>
              </div>
              <div className="mc-detail-body">
                <div className="mc-memory-folder">
                  ◇ Damon Read Memory<span>↳ {tenant.id}</span>
                  <span>　↳ Events / event-id.md</span>
                  <span>　↳ Context.md</span>
                </div>
                <ol>
                  <li>Open or create an Obsidian vault.</li>
                  <li>Press “Connect vault folder” and choose the vault’s root folder.</li>
                  <li>
                    Allow folder access. ARC creates the memory folder and one file for each observed event.
                  </li>
                </ol>
                <button className="mc-primary-button" onClick={connect} disabled={connecting}>
                  {connecting ? 'Connecting…' : vault ? 'Reconnect vault folder' : 'Connect vault folder'} ↗
                </button>
                {vault && (
                  <>
                    <p className="mc-fine">
                      {vault.vaultName} · {memory.count} notes written
                      {memory.at ? ` · ${time(memory.at)}` : ''}
                    </p>
                    <button
                      className="mc-text-button"
                      onClick={() => {
                        vaultRef.current = null;
                        setVault(null);
                      }}
                    >
                      Disconnect folder
                    </button>
                  </>
                )}
                {memory.error && (
                  <p className="mc-notice" role="alert">
                    {memory.error}
                  </p>
                )}
                <button
                  className="mc-secondary-button"
                  onClick={() => downloadJournal(events, tenant.id)}
                  disabled={!events.length}
                >
                  ↓ Download loaded journal (.md)
                </button>
                <h3>Keep the memory running</h3>
                <p className="mc-fine">
                  Folder sync runs while this page is open. For full history and continuous logging, run the
                  included local bridge:
                </p>
                <code className="mc-command">
                  npm run memory:sync -- --vault "YOUR VAULT PATH" --tenant {demo ? 'CLIENT_UUID' : tenant.id}
                </code>
                <div className="mc-callout">
                  The journal mirrors recorded evidence; it does not capture unrecorded decisions or private
                  reasoning. Production memory retrieval is not connected yet. Edit approved operational rules
                  in client settings.
                </div>
              </div>
            </div>
          )}
          {tab === 'setup' && (
            <div className="mc-detail">
              <div className="mc-panel-heading">
                <span className="mc-kicker">STATION CONNECTION GUIDE</span>
                <h2>Connect the recovery loop</h2>
                <p>Stations become meaningful when their tools emit real ARC events.</p>
              </div>
              <div className="mc-detail-body">
                {['signal', 'comms', 'n8n', 'memory', 'business'].map((id) => (
                  <button className="mc-setup-card" key={id} onClick={() => inspect(id)}>
                    <span>{STATION_BY_ID[id].name}</span>
                    <small>{STATION_BY_ID[id].tool} ↗</small>
                  </button>
                ))}
                <div className="mc-callout">
                  Lead Recovery runs in ARC. n8n is a future, gated runner; AI callbacks remain disabled. Use
                  the client activation console to verify providers, safety and configuration.
                </div>
                {!demo && (
                  <Link
                    className="mc-primary-button"
                    to={`${base}/clients/${tenant.id}/activation/lead_recovery`}
                  >
                    Open activation console ↗
                  </Link>
                )}
              </div>
            </div>
          )}
          {tab === 'station' &&
            !demo &&
            ['business', 'qualification', 'comms', 'safety'].includes(selected) && (
              <div className="mc-edit-action">
                <button className="mc-primary-button" onClick={() => setEditing(true)}>
                  Edit rules & filters in station ↗
                </button>
              </div>
            )}
          <footer className="mc-panel-footer">
            <i className="mc-dot mc-dot--muted" /> APPEND-ONLY EVIDENCE / TENANT ISOLATED
          </footer>
        </aside>
      </div>
      <footer className="mc-metrics">
        <span className="mc-metrics-label">
          {demo ? 'REPLAY' : 'LOADED WINDOW'}
          <small>{demo ? 'SIMULATED' : 'UP TO 300 EVENTS'}</small>
        </span>
        {[
          ['Signals', events.filter((e) => !e.isCanary && e.type === 'lead_received').length],
          ['Missed calls', events.filter((e) => !e.isCanary && e.type === 'call_missed').length],
          ['Replies', events.filter((e) => !e.isCanary && e.type === 'reply_received').length],
          ['Bookings recorded', events.filter((e) => !e.isCanary && e.type === 'lead_booked').length],
          ['Error / review events', issues],
        ].map(([label, value]) => (
          <div key={label}>
            <strong
              aria-label={!demo && !feed.lastRead ? 'Not available: waiting for event read' : undefined}
            >
              {!demo && !feed.lastRead ? '—' : value}
            </strong>
            <span>{label}</span>
          </div>
        ))}
        <span className="mc-metrics-proof">
          PROOF BEFORE PROMISES <b>◇</b>
        </span>
      </footer>
    </div>
  );
}

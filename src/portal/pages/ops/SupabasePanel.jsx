import { useCallback, useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import { Panel, Pill, StatCard } from '../../components/ui';
import { ActionButton, CopyValue, Notice } from '../../components/ops-ui';
import OperatorAccount from '../../components/OperatorAccount';
import { dashboardUrl, probeSupabase, projectRef } from '../../lib/ops';
import { functionUrl, isConfigured } from '../../lib/supabase';
import { formatCount, formatStamp } from '../../lib/format';

/**
 * the project everything runs on, probed rather than described.
 *
 * every row on this page is the result of a round trip made just now: a table that
 * answered, a function that responded, a socket that opened. the alternative — a
 * page listing what the schema is supposed to contain — is a screenshot of a
 * migration file, and it would go on cheerfully reporting that everything was fine
 * while the project was down.
 *
 * the edge functions are probed with a body they will reject. a 400 back from
 * client-login means deployed, reachable and validating input, and finding that
 * out did not send a sign-in email to anybody.
 */

const TABLE_NOTE = {
  tenants: 'one row per client',
  events: 'append-only; every number in the product is derived from this',
  alerts: 'the only mutable table in the schema',
  connections: 'what each client is declared to be wired to',
  ingest_tokens: 'sha-256 digests only — no token is ever stored',
  arc_admins: 'who can see this console',
};

const FUNCTION_NOTE = {
  'client-login': 'turns a client id into a sign-in link, without disclosing the address',
  ops: 'invites and links a client account — the only step that touches auth',
  ingest: 'the write path n8n posts events to',
};

export default function SupabasePanel({ totals, email }) {
  const [probe, setProbe] = useState(null);
  const [error, setError] = useState(null);

  const run = useCallback(() => {
    setProbe(null);
    setError(null);
    probeSupabase()
      .then(setProbe)
      .catch((probeError) => setError(probeError.message));
  }, []);

  useEffect(run, [run]);

  if (!isConfigured) {
    return (
      <Notice tone="fail" title="no supabase connection configured here">
        <p>
          this build has no <code>VITE_SUPABASE_URL</code> or <code>VITE_SUPABASE_ANON_KEY</code>.
          the console cannot read anything without them — set them in{' '}
          <code>.env.local</code> and restart the dev server.
        </p>
      </Notice>
    );
  }

  const failedTables = (probe?.tables ?? []).filter((table) => table.error);
  const missingFunctions = (probe?.functions ?? []).filter((fn) => !fn.deployed);

  return (
    <>
      {error && (
        <Notice tone="fail" title="the probe itself failed">
          <p>{error}</p>
        </Notice>
      )}

      {failedTables.length > 0 && (
        <Notice tone="warn" title={`${failedTables.length} table${failedTables.length === 1 ? '' : 's'} could not be read`}>
          <p>
            {failedTables.map((table) => `${table.table}: ${table.error}`).join(' · ')}. if these
            are permission errors, migration <code>0003_client_ids_and_ops.sql</code> has not
            been applied — it is what grants this console read access across tenants.
          </p>
        </Notice>
      )}

      {missingFunctions.length > 0 && (
        <Notice
          tone="warn"
          title={`${missingFunctions.length} edge function${
            missingFunctions.length === 1 ? ' is' : 's are'
          } not deployed`}
        >
          <p>
            {missingFunctions.map((fn) => fn.name).join(', ')}. deploy from the repo root:
            <br />
            <code>supabase functions deploy client-login --no-verify-jwt</code>
            <br />
            <code>supabase functions deploy ops</code>
            <br />
            <code>supabase secrets set ARC_SITE_URL=https://your-site.com</code>
          </p>
          <p style={{ marginTop: 8 }}>
            until <code>client-login</code> is up, no client can sign in with an id — the box at{' '}
            /login has nothing to call. until <code>ops</code> is up, the link-account button on a
            client page cannot invite anybody.
          </p>
        </Notice>
      )}

      <div className="ws-stats ws-stats--three">
        <StatCard
          label="project"
          value={projectRef() ?? 'unknown'}
          compact
          sub={probe ? `answered in ${probe.latencyMs}ms` : 'probing…'}
        />
        <StatCard
          label="events held"
          value={probe?.tables?.find((table) => table.table === 'events')?.count ?? '—'}
          animate={Boolean(probe)}
          format={formatCount}
          tone="lead"
          sub="every figure in the product is derived from these"
        />
        <StatCard
          label="clients"
          value={totals.clients}
          animate
          sub={`${totals.active} active · ${totals.unlinked} without a sign-in address`}
        />
      </div>

      <Panel
        title="tables"
        note={probe ? `probed ${formatStamp(probe.checkedAt, 'UTC')} utc` : 'probing…'}
        actions={
          <ActionButton
            icon="refresh"
            onRun={async () => {
              run();
              return null;
            }}
          >
            probe again
          </ActionButton>
        }
        bare
      >
        <div className="ops-probe">
          {(probe?.tables ?? []).map((table) => (
            <div className="ops-probe__row" key={table.table}>
              <span className="ops-probe__name">{table.table}</span>
              {table.error ? (
                <Pill tone="fail">unreadable</Pill>
              ) : (
                <Pill tone="ok">readable</Pill>
              )}
              <span className="ops-probe__detail">{table.error ?? TABLE_NOTE[table.table]}</span>
              <span className="ops-probe__val">
                {table.count === null ? '—' : `${formatCount(table.count)} rows`}
              </span>
            </div>
          ))}

          {!probe && <div className="ops-probe__row">probing the project…</div>}
        </div>

        <p className="ws-note">
          these counts are what row level security lets this session see. they are the whole
          table because you are an arc admin — a client's session running the identical query
          gets only their own rows, and that is enforced by postgres rather than by a filter in
          the page.
        </p>
      </Panel>

      <Panel title="edge functions" bare>
        <div className="ops-probe">
          {(probe?.functions ?? []).map((fn) => (
            <div className="ops-probe__row" key={fn.name}>
              <span className="ops-probe__name">{fn.name}</span>
              <Pill tone={fn.deployed ? 'ok' : 'fail'}>
                {fn.deployed ? 'deployed' : 'not found'}
              </Pill>
              <span className="ops-probe__detail">{FUNCTION_NOTE[fn.name]}</span>
              <span className="ops-probe__val">{fn.status ?? 'no response'}</span>
            </div>
          ))}
          {!probe && <div className="ops-probe__row">probing the functions…</div>}
        </div>

        <div style={{ padding: 'var(--panel-pad)', display: 'grid', gap: 10 }}>
          <CopyValue value={functionUrl('ingest')} label="ingest" />
          <CopyValue value={functionUrl('client-login')} label="login" />
        </div>

        <p className="ws-note">
          probed with an empty body, which every one of them rejects. a <code>400</code> is a
          healthy answer here: it means the function is up and validating. a <code>404</code>{' '}
          means it has never been deployed.
        </p>
      </Panel>

      <Panel title="realtime">
        <div className="ops-row">
          {probe ? (
            <Pill tone={probe.realtime.ok ? 'ok' : 'warn'}>
              {probe.realtime.ok ? 'socket opened' : probe.realtime.detail}
            </Pill>
          ) : (
            <Pill tone="neutral">opening a socket…</Pill>
          )}
        </div>
        <p className="ws-note">
          the client feed subscribes to inserts on <code>events</code>. row level security
          applies to realtime too, so a subscriber receives only their own tenant's rows — the
          live feed is not a second, looser read path.
        </p>
      </Panel>

      <OperatorAccount email={email} />

      <Panel title="open in supabase">
        <div className="ops-row">
          <a className="ws-btn" href={dashboardUrl('/editor')} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} />
            table editor
          </a>
          <a className="ws-btn" href={dashboardUrl('/auth/users')} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} />
            auth users
          </a>
          <a className="ws-btn" href={dashboardUrl('/sql/new')} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} />
            sql editor
          </a>
          <a className="ws-btn" href={dashboardUrl('/functions')} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} />
            functions
          </a>
          <a className="ws-btn" href={dashboardUrl('/logs/explorer')} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} />
            logs
          </a>
        </div>

        <p className="ws-note">
          inviting a client by hand lives under auth users, if you would rather not use the
          link-account button. the service-role key is not in this repo and must never be — it
          belongs only in the edge functions' secrets.
        </p>
      </Panel>
    </>
  );
}

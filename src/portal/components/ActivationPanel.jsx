import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { Empty, Panel, Pill, Term } from './ui';
import { ActionButton, Disclosure, Field, Notice, SelectInput, TextInput } from './ops-ui';
import { activationApi } from '../lib/ops';
import { formatStamp } from '../lib/format';
import {
  activationImpact,
  CONNECTION_DISPLAY,
  connectionTestVerdict,
  liveRunVerdict,
  readinessChecklist,
} from '../../../supabase/functions/_shared/activation/model.ts';
import './ActivationPanel.css';

/**
 * ARC-320 — one module, on its way to live and while it is live.
 *
 * Five questions, in the order an operator asks them: what state is it in and would a live
 * run start now; what is still missing; what is it connected to and does each connection
 * work; what has been tested; and what happened to it. Every answer is drawn from the
 * server's `activation-overview`, and every button is an existing server action with its own
 * gate — this component decides nothing. Activate is disabled while the readiness the server
 * computed says no, and the server re-evaluates everything when it is pressed anyway.
 *
 * No credential is ever on this page. A connection arrives as ARC-130's safe summary; the
 * credential hint is at most four characters; a key typed into the connect form goes to the
 * `connections` function once, is cleared from the form, and is never sent back.
 *
 * `initial` and `api` exist so the panel can be drawn from a known answer in a test; the
 * console passes neither.
 */

const STATE_TONE = { active: 'ok', paused: 'warn', shadow: 'idle', testing: 'neutral', configuring: 'neutral', unselected: 'idle' };
const HEALTH_TONE = { healthy: 'ok', unverified: 'neutral', degraded: 'warn', failing: 'fail', blocking: 'fail' };
const CAPABILITY_TONE = { ready: 'ok', missing: 'warn', unknown: 'warn', invalid: 'fail', expired: 'fail', unhealthy: 'fail', unsupported: 'idle' };
const CHECK_GLYPH = { ok: '■', blocked: '●', not_required: '□' };
const KIND_WORDS = { all_of: 'needs all of', any_of: 'needs one of', optional: 'optional', conditional: 'when turned on' };
const HEALTH_OPTIONS = ['unverified', 'healthy', 'degraded', 'failing', 'blocking'].map((value) => ({ value, label: value }));

/* the lifecycle transitions this page offers, in the order they are reached. select and
   deselect stay on the client page's module list; the test and the shadow review have their
   own places below. */
const TRANSITION_BUTTONS = [
  { key: 'begin_testing', label: 'begin testing', icon: 'pulse' },
  { key: 'enter_shadow', label: 'enter shadow', icon: 'clock', confirm: 'enter shadow mode? real leads are evaluated and recorded as "would have" — nothing is sent to anyone.' },
  { key: 'exit_shadow', label: 'leave shadow', icon: 'back' },
  { key: 'stop_testing', label: 'stop testing', icon: 'back' },
  { key: 'activate', label: 'activate', icon: 'check', variant: 'primary', gated: true },
  { key: 'resume', label: 'resume', icon: 'check', variant: 'primary', gated: true },
  {
    key: 'pause',
    label: 'pause',
    icon: 'close',
    confirm: 'pause this module? no new live run starts, and queued contact for live runs is cancelled (handoffs and closes still run). resuming re-checks every gate.',
  },
];

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const pairWords = (numbers) =>
  numbers ? `client settings v${numbers.tenant ?? '?'} · module v${numbers.module ?? '?'}` : 'none';

function when(iso, timezone) {
  return iso ? formatStamp(iso, timezone) : '—';
}

/* ── the head: state, health, and whether a live run would start ── */

function StatusHead({ data, timezone, readOnly, run }) {
  const { status, module } = data;
  const lifecycle = status.lifecycle;
  const state = status.effective?.state ?? lifecycle?.state ?? 'unselected';
  const health = lifecycle?.health?.status ?? 'unverified';
  const verdict = liveRunVerdict(status.effective);
  const impact = activationImpact({ lifecycle, heads: status.heads });
  const ready = status.readiness?.ok === true;
  const transitions = status.transitions ?? [];
  const buttons = TRANSITION_BUTTONS.filter((b) => transitions.includes(b.key));

  return (
    <Panel
      title={`${module.name} — status`}
      note={
        lifecycle ? (
          <>
            <Term k="lifecycle" /> v{lifecycle.state_version} · updated {when(lifecycle.updated_at, timezone)}
          </>
        ) : (
          'not selected for this client'
        )
      }
    >
      {/* the state and the health are printed as the system names them — those are the words
          in the history below and in the audit log. each carries what it means. */}
      <div className="act-head">
        <Pill tone={STATE_TONE[state] ?? 'neutral'}>
          <Term k={state}>{state}</Term>
        </Pill>
        {state === 'shadow' && (
          <Pill tone="idle" title="real leads are evaluated and recorded; nothing is sent">
            shadow — nothing is sent
          </Pill>
        )}
        <Pill tone={HEALTH_TONE[health] ?? 'fail'} title="the health overlay — separate from the state, and never changes it">
          <Term k="health">health</Term> <Term k={health}>{health}</Term>
        </Pill>
        <span className="act-head__headline">{status.effective?.headline}</span>
      </div>

      <p className={`act-live${verdict.allowed ? ' act-live--ok' : ''}`}>
        <b>live runs:</b> {verdict.sentence}
      </p>
      {verdict.holds.length > 0 && (
        <ul className="act-list" aria-label="what holds live runs">
          {verdict.holds.map((hold) => (
            <li key={hold.code}>
              <span className="mono">{hold.code}</span> {hold.message}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && buttons.length > 0 && (
        <div className="act-controls">
          {buttons.map((button) => {
            const blocked = button.gated && !ready;
            const confirm = button.gated
              ? `${button.label} ${module.name}?\n\n${impact.sentences.join('\n')}`
              : button.confirm;
            return (
              <ActionButton
                key={button.key}
                icon={button.icon}
                variant={button.variant}
                disabled={blocked}
                title={blocked ? `blocked: ${status.readiness?.blockers?.[0]?.message ?? 'readiness is not met'}` : undefined}
                confirm={confirm}
                onRun={() => run(button.key)}
              >
                {button.label}
              </ActionButton>
            );
          })}
        </div>
      )}
      {!readOnly && buttons.some((b) => b.gated) && !ready && (
        <p className="ws-note">
          {buttons.find((b) => b.gated).label} is disabled until every line of the readiness checklist below passes. the
          server checks all of it again when it is pressed.
        </p>
      )}
      {readOnly && <p className="ws-note">read-only — this client has been deboarded.</p>}
    </Panel>
  );
}

/* ── what is still missing ──────────────────────────────── */

function Readiness({ data }) {
  const { status, versions } = data;
  const items = readinessChecklist(status.readiness);
  const impact = activationImpact({ lifecycle: status.lifecycle, heads: status.heads });
  const blocked = items.filter((item) => item.state === 'blocked').length;

  return (
    <Panel
      title="readiness"
      note={status.readiness?.ok ? 'every activation check passes' : `${blocked} ${blocked === 1 ? 'check blocks' : 'checks block'} going live`}
    >
      <ul className="act-checks">
        {items.map((item) => (
          <li key={item.key} className={`act-checks__row act-checks__row--${item.state}`}>
            <i aria-hidden="true">{CHECK_GLYPH[item.state]}</i>
            <span className="act-checks__label">{item.label}</span>
            <span className="act-checks__detail">{item.detail}</span>
            {item.blockers.length > 1 && (
              <ul className="act-list act-checks__more">
                {item.blockers.slice(1).map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {status.readiness?.blockers?.length > 0 && (
        <Disclosure title="blocked reasons, exactly as the server gave them" summary={`${status.readiness.blockers.length} reasons`}>
          <ul className="act-list">
            {status.readiness.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>
                <span className="mono">{blocker.code}</span> {blocker.message}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <div className="act-impact">
        <p className="act-impact__title">what going live would change</p>
        <dl className="act-impact__pairs">
          <div>
            <dt>would authorise</dt>
            <dd>{pairWords(versions?.heads)}</dd>
          </div>
          <div>
            <dt>authorised now</dt>
            <dd>{pairWords(versions?.authorized)}</dd>
          </div>
          <div>
            <dt>last tested</dt>
            <dd>{pairWords(versions?.tested)}</dd>
          </div>
        </dl>
        <ul className="act-list">
          {impact.sentences.map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/* ── connections ────────────────────────────────────────── */

function KeyForm({ provider, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => Object.fromEntries(provider.credential_fields.map((name) => [name, ''])));
  const filled = provider.credential_fields.every((name) => values[name].trim().length > 0);
  return (
    <div className="act-keyform">
      {provider.credential_fields.map((name) => (
        <Field key={name} label={name.replace(/_/g, ' ')} hint="sent once to the connections function, verified with the provider, stored in Vault — never shown again">
          <TextInput
            type="password"
            mono
            autoComplete="off"
            spellCheck="false"
            value={values[name]}
            onChange={(event) => setValues((prev) => ({ ...prev, [name]: event.target.value }))}
          />
        </Field>
      ))}
      <div className="ops-row">
        <ActionButton
          icon="link"
          variant="primary"
          disabled={!filled}
          onRun={async () => {
            const credential = { ...values };
            /* the form forgets the key the moment it is handed over, whatever happens next. */
            setValues(Object.fromEntries(provider.credential_fields.map((name) => [name, ''])));
            return await onSubmit(credential);
          }}
        >
          store and verify
        </ActionButton>
        <button type="button" className="ws-btn" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}

function ConnectionLine({ provider, timezone, readOnly, actions }) {
  const [entering, setEntering] = useState(false);
  const connection = provider.connection;

  if (provider.owner === 'arc') {
    return (
      <li className="act-provider">
        <span className="act-provider__name">{provider.name}</span>
        <Pill tone="neutral" title="ARC's own account or an ARC-issued key — proven by configuration and onboarding attestation, not a client connection">
          managed by ARC
        </Pill>
      </li>
    );
  }

  const display = connection?.display ?? (provider.connectable ? 'missing' : 'unsupported');
  const words = CONNECTION_DISPLAY[display] ?? CONNECTION_DISPLAY.unknown;
  const test = connectionTestVerdict(connection?.latest_test);
  const testable = connection && ['unverified', 'connected', 'degraded', 'needs_reauth', 'expired'].includes(display);
  const ended = connection && ['revoked', 'disconnected', 'failed'].includes(display);

  return (
    <li className="act-provider">
      <span className="act-provider__name">{provider.name}</span>
      <Pill tone={words.tone} title={words.sentence}>
        {words.label}
      </Pill>
      {connection?.hint && <span className="mono act-provider__hint" title="the last four characters, where the provider says that is safe">{connection.hint}</span>}
      <span className="act-provider__detail">
        {words.sentence}
        {connection?.last_verified_at ? ` · verified ${when(connection.last_verified_at, timezone)}` : ''}
        {connection?.verified_capabilities?.length ? ` · serves ${connection.verified_capabilities.join(', ')}` : ''}
      </span>
      {connection && (
        <span className={`act-provider__test act-provider__test--${test.tone}`}>
          last test: <b>{test.word}</b> — {test.sentence}
        </span>
      )}

      {!readOnly && (
        <span className="act-provider__actions">
          {testable && (
            <ActionButton icon="pulse" onRun={() => actions.test(connection.id)}>
              test
            </ActionButton>
          )}
          {connection && !ended && provider.auth_type === 'oauth2' && provider.connectable && (
            <ActionButton icon="refresh" onRun={() => actions.reauthorize(provider, connection)}>
              reauthorise
            </ActionButton>
          )}
          {connection && !ended && (
            <ActionButton
              icon="trash"
              confirm={`disconnect ${provider.name}? the credential is retired and purged, any active module that needed it is paused, and reconnecting makes a new connection.`}
              onRun={() => actions.disconnect(connection)}
            >
              disconnect
            </ActionButton>
          )}
          {(!connection || ended) && provider.connectable && provider.auth_type === 'oauth2' && (
            <ActionButton icon="link" onRun={() => actions.connect(provider)}>
              connect
            </ActionButton>
          )}
          {(!connection || ended) && provider.connectable && provider.auth_type === 'api_key' && !entering && (
            <button type="button" className="ws-btn" onClick={() => setEntering(true)}>
              <Icon name="link" size={13} />
              connect with a key
            </button>
          )}
        </span>
      )}
      {entering && (
        <KeyForm
          provider={provider}
          onCancel={() => setEntering(false)}
          onSubmit={async (credential) => {
            const result = await actions.storeKey(provider, credential);
            setEntering(false);
            return result;
          }}
        />
      )}
    </li>
  );
}

function Connections({ data, timezone, readOnly, actions }) {
  const listed = new Set(
    data.requirements.flatMap((r) => r.capabilities.flatMap((c) => c.providers.map((p) => p.connection?.id).filter(Boolean))),
  );
  const others = data.connections.filter((c) => !listed.has(c.id));

  return (
    <Panel title="connections" note="what this module needs, and what serves it">
      {data.requirements.length === 0 ? (
        <Empty title="this module needs no connection">nothing to connect.</Empty>
      ) : (
        <ul className="act-reqs">
          {data.requirements.map((requirement) => (
            <li key={requirement.key} className={`act-req${requirement.blocking ? '' : ' act-req--soft'}`}>
              <p className="act-req__head">
                <span className="act-req__kind">{KIND_WORDS[requirement.kind] ?? requirement.kind}</span>
                <span className="act-req__desc">{requirement.description}</span>
              </p>
              <ul className="act-caps">
                {requirement.capabilities.map((capability) => (
                  <li key={capability.key} className="act-cap">
                    <p className="act-cap__head">
                      <span className="mono">{capability.key}</span>
                      <Pill tone={CAPABILITY_TONE[capability.status] ?? 'fail'}>{capability.status}</Pill>
                      <span className="act-cap__reason">{capability.reason}</span>
                    </p>
                    {capability.providers.length === 0 ? (
                      <p className="act-cap__reason">no connector ARC offers provides this</p>
                    ) : (
                      <ul className="act-providers">
                        {capability.providers.map((provider) => (
                          <ConnectionLine
                            key={provider.connector_key}
                            provider={provider}
                            timezone={timezone}
                            readOnly={readOnly}
                            actions={actions}
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <Disclosure title="other connections this client holds" summary={`${others.length}`}>
          <ul className="act-providers">
            {others.map((connection) => (
              <ConnectionLine
                key={connection.id}
                provider={{ connector_key: connection.connector_key, name: connection.connector_key, owner: 'tenant', auth_type: connection.auth_method, connectable: false, credential_fields: [], connection }}
                timezone={timezone}
                readOnly={readOnly}
                actions={actions}
              />
            ))}
          </ul>
        </Disclosure>
      )}

      <p className="ws-note">
        a connection is <b>connected</b> only once the provider has confirmed the account and each capability — a stored
        token is not readiness. a test is queued as a durable run and action before anything is asked of the provider.
      </p>
    </Panel>
  );
}

/* ── tests and evidence ─────────────────────────────────── */

function Evidence({ data, timezone, readOnly, actions }) {
  const { evidence, module, status, tests } = data;
  const current = evidence.test;
  const tested = status.lifecycle?.tested;
  const heads = status.heads;
  const isCurrent = Boolean(current && tested && heads && tested.tenant_version_id === heads.tenant_version_id && tested.module_version_id === heads.module_version_id);
  const canTest = ['testing', 'shadow', 'active', 'paused', 'configuring'].includes(status.lifecycle?.state);

  return (
    <Panel
      title="tests & evidence"
      actions={
        !readOnly && module.test_action && canTest ? (
          <ActionButton icon="pulse" onRun={() => actions.moduleTest(module.test_action)}>
            run the synthetic test
          </ActionButton>
        ) : null
      }
    >
      <div className="act-evidence">
        <p className="act-evidence__title">module test</p>
        {!module.test_action ? (
          <p className="ops-muted">no synthetic test is registered for this module, so it cannot produce test evidence yet.</p>
        ) : current ? (
          <p>
            <Pill tone={current.outcome === 'passed' ? 'ok' : 'fail'}>{current.outcome}</Pill>{' '}
            {isCurrent ? 'of the current configuration' : 'of an earlier configuration — test again before going live'} ·{' '}
            {when(current.recorded_at, timezone)} · run <span className="mono">{String(current.run_id ?? '').slice(0, 8)}</span> · simulated
          </p>
        ) : (
          <p className="ops-muted">no passing test is on record. a test is a synthetic lead through the whole engine — nothing reaches a handset.</p>
        )}
        {evidence.recent_tests?.length > 1 && (
          <ul className="act-list" aria-label="recent tests">
            {evidence.recent_tests.slice(0, 5).map((row) => (
              <li key={row.id}>
                <span className="mono">{when(row.recorded_at, timezone)}</span> {row.outcome}
                {row.summary?.run_state ? ` · ${row.summary.run_state}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(status.lifecycle?.state === 'shadow' || evidence.shadow_review || evidence.shadow_observations > 0) && (
        <div className="act-evidence">
          <p className="act-evidence__title">
            <Term k="shadow" />
          </p>
          <p>
            {evidence.shadow_observations} observation{evidence.shadow_observations === 1 ? '' : 's'} of the current configuration
            {evidence.shadow_review ? ` · last review ${evidence.shadow_review.outcome} ${when(evidence.shadow_review.recorded_at, timezone)}` : ' · not reviewed'}
          </p>
          {!readOnly && (status.transitions ?? []).includes('record_shadow_review') && (
            <div className="ops-row">
              <ActionButton icon="check" onRun={() => actions.transition('record_shadow_review', { outcome: 'passed' })}>
                accept what shadow observed
              </ActionButton>
              <ActionButton icon="close" onRun={() => actions.transition('record_shadow_review', { outcome: 'failed' })}>
                reject it
              </ActionButton>
            </div>
          )}
        </div>
      )}

      <div className="act-evidence">
        <p className="act-evidence__title">connection tests</p>
        {tests.length === 0 ? (
          <p className="ops-muted">no connection has been tested for this client.</p>
        ) : (
          <ul className="act-list">
            {tests.slice(0, 8).map((test) => {
              const verdict = connectionTestVerdict(test);
              return (
                <li key={test.action_id}>
                  <span className="mono">{when(test.requested_at, timezone)}</span> {test.connector_key ?? 'connection'} ·{' '}
                  <b className={`act-tone--${verdict.tone}`}>{verdict.word}</b> — {verdict.sentence}
                  {test.evidence?.connection_status ? ` · now ${test.evidence.connection_status}` : ''}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/* ── health ─────────────────────────────────────────────── */

function Health({ data, timezone, readOnly, actions }) {
  const health = data.status.lifecycle?.health;
  const [status, setStatus] = useState(health?.status ?? 'unverified');
  const [reason, setReason] = useState('');
  const canReport = (data.status.transitions ?? []).includes('report_health');

  return (
    <Panel title="health overlay" note="what has been observed — it never changes the state, and a recovery never reactivates anything">
      <p>
        <Pill tone={HEALTH_TONE[health?.status] ?? 'neutral'}>
          <Term k={health?.status ?? 'unverified'}>{health?.status ?? 'unverified'}</Term>
        </Pill>{' '}
        {health?.reason ?? 'no reason recorded'}
        {health?.checked_at ? ` · ${when(health.checked_at, timezone)}` : ''}
        {health?.evidence?.source ? ` · source ${health.evidence.source}` : ''}
      </p>
      {!readOnly && canReport && (
        <div className="act-healthform">
          <Field label="report health">
            <SelectInput options={HEALTH_OPTIONS} value={status} onChange={(event) => setStatus(event.target.value)} />
          </Field>
          <Field label="why" hint="recorded with the report, with you as its source">
            <TextInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="what you saw" />
          </Field>
          <ActionButton icon="check" onRun={() => actions.reportHealth(status, reason)}>
            record
          </ActionButton>
        </div>
      )}
    </Panel>
  );
}

/* ── what happened ──────────────────────────────────────── */

function History({ data, timezone }) {
  const history = data.status.history ?? [];
  return (
    <Panel title="transition history" note={`newest first · ${history.length} shown`} bare>
      {history.length === 0 ? (
        <Empty title="nothing yet">this module has no lifecycle history for this client.</Empty>
      ) : (
        <div className="ws-tablewrap">
          <table className="ws-table ws-table--dense">
            <thead>
              <tr>
                <th>when</th>
                <th>transition</th>
                <th>state</th>
                <th>by</th>
                <th className="ws-table__wide">why</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr className="ws-table__row" key={entry.id}>
                  <td className="ws-table__sub">{when(entry.occurred_at, timezone)}</td>
                  <td className="mono">{entry.transition}</td>
                  <td className="ws-table__sub">
                    {entry.from_state} → {entry.to_state}
                  </td>
                  <td className="ws-table__sub">{entry.actor_type}</td>
                  <td>
                    {entry.reason ?? entry.reason_code}
                    {Array.isArray(entry.impact?.classifications) && entry.impact.classifications.length > 0 && (
                      <span className="act-history__impact"> · impact {entry.impact.classifications.join(', ')}</span>
                    )}
                    {entry.pending_after?.length > 0 && <span className="act-history__impact"> · requires {entry.pending_after.join(', ')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ── the panel ──────────────────────────────────────────── */

export default function ActivationPanel({
  tenantId,
  moduleKey,
  timezone = 'UTC',
  readOnly = false,
  returnPath = null,
  initial = null,
  api = activationApi,
}) {
  const [state, setState] = useState(initial ? { kind: 'ready', data: initial } : { kind: 'loading' });

  const reload = useCallback(async () => {
    try {
      setState({ kind: 'ready', data: await api.overview(tenantId, moduleKey) });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [api, tenantId, moduleKey]);

  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const data = state.kind === 'ready' ? state.data : null;
  const stateVersion = data?.status?.lifecycle?.state_version ?? 0;

  /* every write reloads, whichever way it went: a refusal is often "someone else acted
     first", and the page should show what is true now rather than what was true then. */
  const actions = useMemo(() => {
    const after = async (work) => {
      try {
        return await work();
      } finally {
        await reload();
      }
    };
    return {
      transition: (key, extra = {}) =>
        after(async () => {
          await api.transition(key, tenantId, moduleKey, stateVersion, { idempotencyKey: newKey(), ...extra });
          return 'done';
        }),
      reportHealth: (status, reason) =>
        after(async () => {
          await api.reportHealth(tenantId, moduleKey, stateVersion, status, reason);
          return `health recorded as ${status}`;
        }),
      moduleTest: (testAction) =>
        after(async () => {
          const result = await api.runModuleTest(testAction, tenantId);
          return result?.passed ? 'passed — evidence recorded' : 'the test did not pass — see the evidence below';
        }),
      test: (connectionId) =>
        after(async () => {
          const result = await api.testConnection(tenantId, moduleKey, connectionId, newKey());
          if (result?.pass?.deferred) return `queued — ${result.pass.deferred.reason}`;
          return connectionTestVerdict(result?.test).word;
        }),
      connect: async (provider) => {
        const result = await api.connectOAuth(tenantId, provider.connector_key, returnPath);
        if (result?.authorization_url) window.location.assign(result.authorization_url);
        return 'opening the provider…';
      },
      reauthorize: async (provider, connection) => {
        const result = await api.connectOAuth(tenantId, provider.connector_key, returnPath, {
          connectionId: connection.id,
          expectedStatusVersion: connection.status_version,
        });
        if (result?.authorization_url) window.location.assign(result.authorization_url);
        return 'opening the provider…';
      },
      storeKey: (provider, credential) =>
        after(async () => {
          const result = await api.storeApiKey(tenantId, provider.connector_key, credential, newKey());
          return `stored — ${result?.connection?.status ?? 'recorded'}`;
        }),
      disconnect: (connection) =>
        after(async () => {
          await api.disconnect(tenantId, connection.id, connection.status_version);
          return 'disconnected';
        }),
    };
  }, [api, tenantId, moduleKey, stateVersion, returnPath, reload]);

  if (state.kind === 'loading') {
    return (
      <Panel title="activation">
        <p className="ops-muted">reading the module&rsquo;s lifecycle, connections and evidence…</p>
      </Panel>
    );
  }

  if (state.kind === 'error') {
    return (
      <Panel title="activation">
        {state.error?.payload?.error === 'unknown action' ? (
          <Notice tone="warn" title="the ops function predates the activation console">
            <p>
              redeploy the <code>ops</code> function — this page reads everything through its <code>activation-overview</code> action.
            </p>
          </Notice>
        ) : (
          <Notice tone="fail" title="the module could not be read">
            <p>{state.error?.message ?? 'unknown error'}</p>
          </Notice>
        )}
      </Panel>
    );
  }

  if (!data.status?.lifecycle) {
    return (
      <>
        <StatusHead data={data} timezone={timezone} readOnly={readOnly} run={(key) => actions.transition(key)} />
        <Notice tone="warn" title={`${data.module.name} is not selected for this client`}>
          <p>select it from the client&rsquo;s module list first. selecting never switches anything on.</p>
        </Notice>
        <Connections data={data} timezone={timezone} readOnly={readOnly} actions={actions} />
      </>
    );
  }

  return (
    <>
      <StatusHead data={data} timezone={timezone} readOnly={readOnly} run={(key) => actions.transition(key)} />
      <Readiness data={data} />
      <Connections data={data} timezone={timezone} readOnly={readOnly} actions={actions} />
      <Evidence data={data} timezone={timezone} readOnly={readOnly} actions={actions} />
      <Health key={data.status.lifecycle.health?.checked_at ?? 'none'} data={data} timezone={timezone} readOnly={readOnly} actions={actions} />
      <History data={data} timezone={timezone} />
    </>
  );
}

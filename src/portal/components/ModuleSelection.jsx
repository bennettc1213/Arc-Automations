import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Disclosure, Notice } from './ops-ui';
import { deselectModule, getTenantModules, selectModule } from '../lib/ops';
import { formatStamp } from '../lib/format';
import { moduleCatalog } from '../../../supabase/functions/_shared/tenants/model.ts';
import './ModuleSelection.css';

/**
 * ARC-300 — which modules a client has, read off the registry.
 *
 * Two views over one vocabulary. The picker (new client) draws the registry's catalog —
 * the same `moduleCatalog()` the `ops` function checks a request against — so a module that
 * is planned, or needs something no connector ARC offers provides, is shown and cannot be
 * ticked. The panel (client page) asks the server for each module's lifecycle, readiness
 * and configuration, and its two buttons are ARC-120's select and deselect, carrying the
 * state version the panel was drawn from.
 *
 * Choosing a module selects it. It never switches it on: that is the Lead Recovery panel's
 * activation gate, and nothing here reaches it.
 */

const KIND_WORDS = {
  all_of: 'needs all of',
  any_of: 'needs one of',
  optional: 'optional',
  conditional: 'when turned on',
};

const STATE_TONE = {
  active: 'ok',
  paused: 'warn',
  shadow: 'idle',
  testing: 'idle',
  configuring: 'idle',
  unselected: 'neutral',
};

function Requirements({ requirements }) {
  if (requirements.length === 0) return null;
  return (
    <ul className="msel-reqs">
      {requirements.map((requirement) => {
        const connectors = [
          ...new Set(requirement.capabilities.flatMap((c) => c.connectors.map((connector) => connector.name))),
        ];
        return (
          <li key={requirement.key} className={`msel-reqs__item msel-reqs__item--${requirement.kind}`}>
            <span className="msel-reqs__kind">{KIND_WORDS[requirement.kind] ?? requirement.kind}</span>
            <span className="msel-reqs__caps mono">{requirement.capabilities.map((c) => c.key).join(', ')}</span>
            <span className="msel-reqs__via">
              {connectors.length ? `via ${connectors.join(' or ')}` : 'no connector provides this'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ── the picker ──────────────────────────────────────────── */

export function ModulePicker({ selected, onToggle, catalog = moduleCatalog() }) {
  return (
    <div className="bld-pick msel-pick" role="group" aria-label="modules">
      {catalog.map((module) => {
        const on = selected.includes(module.key);
        return (
          <button
            type="button"
            key={module.key}
            className={`bld-pick__card${on ? ' bld-pick__card--on' : ''}${module.selectable ? '' : ' bld-pick__card--taken'}`}
            aria-pressed={on}
            disabled={!module.selectable}
            title={module.problem?.message}
            onClick={() => onToggle(module.key)}
          >
            <span className="bld-pick__top">
              <span className="bld-pick__box" aria-hidden="true">
                {on && <Icon name="check" size={12} />}
              </span>
              <span className="bld-pick__name">{module.name}</span>
              <span className="bld-pick__flag">{module.selectable ? `v${module.version}` : module.status}</span>
            </span>
            <span className="bld-pick__brief">{module.description}</span>
            <span className="bld-pick__meta">
              {module.selectable
                ? `${module.requirements.filter((r) => r.kind === 'all_of' || r.kind === 'any_of').length} required connections · ${module.activationSteps.length} activation checks`
                : module.problem?.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** the picked modules' requirements, read before the account is saved. */
export function PickedRequirements({ selected, catalog = moduleCatalog() }) {
  const picked = catalog.filter((module) => selected.includes(module.key));
  if (picked.length === 0) {
    return (
      <p className="ops-muted">
        no module chosen. the client can be created without one and given a module from their page
        later — until then nothing runs for them.
      </p>
    );
  }
  return (
    <div className="msel-picked">
      {picked.map((module) => (
        <div key={module.key}>
          <p className="msel-picked__name">{module.name} — what it will need before it can go live</p>
          <Requirements requirements={module.requirements} />
        </div>
      ))}
    </div>
  );
}

/* ── the panel ───────────────────────────────────────────── */

function describeScope(scope) {
  const name = scope.scope === 'tenant' ? 'client settings' : 'module settings';
  const published = scope.published ? `published v${scope.published.version}` : 'not published yet';
  return `${name}: ${published}${scope.draft ? ' · draft open' : ''}`;
}

function ModuleRow({ module, tenantId, timezone, readOnly, onChanged }) {
  const status = module.lifecycle;
  const state = status?.lifecycle?.state ?? 'unselected';
  const stateVersion = status?.lifecycle?.state_version ?? 0;
  const transitions = status?.transitions ?? [];
  const blockers = status?.readiness?.blockers ?? [];
  const selected = state !== 'unselected';

  return (
    <li className={`msel-row${selected ? ' msel-row--selected' : ''}`}>
      <div className="msel-row__head">
        <span className="msel-row__name">{module.name}</span>
        {module.selectable || selected ? (
          <Pill tone={STATE_TONE[state] ?? 'neutral'}>{state}</Pill>
        ) : (
          <Pill tone="neutral">{module.status}</Pill>
        )}
        {status?.effective && selected && <span className="msel-row__headline">{status.effective.headline}</span>}

        {!readOnly && (
          <span className="msel-row__actions">
            {module.selectable && transitions.includes('select') && (
              <ActionButton
                icon="plus"
                onRun={async () => {
                  await selectModule(tenantId, module.key, stateVersion);
                  await onChanged();
                  return 'selected — configuring';
                }}
              >
                select
              </ActionButton>
            )}
            {transitions.includes('deselect') && (
              <ActionButton
                icon="close"
                confirm={`deselect ${module.name}? queued live work for it is cancelled, and it would have to be tested again before going live.`}
                onRun={async () => {
                  await deselectModule(tenantId, module.key, stateVersion);
                  await onChanged();
                  return 'deselected';
                }}
              >
                deselect
              </ActionButton>
            )}
          </span>
        )}
      </div>

      {!module.selectable && !selected ? (
        <p className="msel-row__why">{module.problem?.message}</p>
      ) : (
        <div className="msel-row__body">
          {selected && (
            <p className={`msel-row__ready${status?.readiness?.ok ? ' msel-row__ready--ok' : ''}`}>
              {status?.readiness?.ok
                ? 'every activation check passes'
                : `${blockers.length} ${blockers.length === 1 ? 'thing' : 'things'} before it can go live`}
            </p>
          )}
          {selected && blockers.length > 0 && (
            <Disclosure title="what is still missing" summary={blockers[0].message}>
              <ul className="msel-list">
                {blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}>
                    <span className="mono">{blocker.code}</span> {blocker.message}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {module.configuration.length > 0 && (
            <p className="msel-row__config">{module.configuration.map(describeScope).join(' · ')}</p>
          )}
          <Requirements requirements={module.requirements} />
          {status?.history?.length > 0 && (
            <ul className="msel-list msel-list--history" aria-label={`${module.name} history`}>
              {status.history.slice(0, 3).map((entry) => (
                <li key={entry.id}>
                  <span className="mono">{formatStamp(entry.occurred_at, timezone)}</span>{' '}
                  {entry.from_state} → {entry.to_state} · {entry.actor_type}
                  {entry.reason ? ` · ${entry.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * `initial` and `load` exist so the panel can be drawn from a known answer; the console
 * passes neither and the panel reads the server.
 */
export default function TenantModulesPanel({ tenantId, timezone = 'UTC', base = '', readOnly = false, initial = null, load = getTenantModules }) {
  const [state, setState] = useState(initial ? { kind: 'ready', data: initial } : { kind: 'loading' });

  const reload = useCallback(async () => {
    try {
      const data = await load(tenantId);
      setState({ kind: 'ready', data });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, [load, tenantId]);

  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const note =
    state.kind === 'ready'
      ? `${state.data.modules.filter((m) => m.lifecycle?.lifecycle && m.lifecycle.lifecycle.state !== 'unselected').length} selected · ${state.data.modules.length} registered`
      : 'from the module registry';

  return (
    <Panel title="modules" note={note}>
      {state.kind === 'loading' && <p className="ops-muted">reading the modules…</p>}

      {state.kind === 'error' &&
        (state.error?.payload?.error === 'unknown action' ? (
          <Notice tone="warn" title="the ops function predates module selection">
            <p>
              redeploy the <code>ops</code> function and apply{' '}
              <code>0021_ops_tenant_creation.sql</code> — this panel reads the modules through it.
            </p>
          </Notice>
        ) : (
          <Notice tone="fail" title="the modules could not be read">
            <p>{state.error?.message ?? 'unknown error'}</p>
          </Notice>
        ))}

      {state.kind === 'ready' && state.data.modules.length === 0 && (
        <Empty title="no modules are registered">the registry is empty, which is a deploy problem, not this client&rsquo;s.</Empty>
      )}

      {state.kind === 'ready' && state.data.modules.length > 0 && (
        <>
          <ul className="msel-rows">
            {state.data.modules.map((module) => (
              <ModuleRow
                key={module.key}
                module={module}
                tenantId={tenantId}
                timezone={timezone}
                readOnly={readOnly}
                onChanged={reload}
              />
            ))}
          </ul>
          <p className="ws-note">
            {state.data.creation
              ? `created ${formatStamp(state.data.creation.created_at, timezone)} by operator ${state.data.creation.actor_user_id.slice(0, 8)} with ${
                  state.data.creation.modules.length ? state.data.creation.modules.join(', ') : 'no modules'
                }. `
              : 'created before module selection was recorded. '}
            selecting a module never switches it on — activation is the module&rsquo;s own gate.{' '}
            <Link to={`${base}/audit`}>audit log</Link>
          </p>
        </>
      )}
    </Panel>
  );
}

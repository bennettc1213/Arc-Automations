import { useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Empty, Panel, Pill } from './ui';
import { ActionButton, Notice, TextInput } from './ops-ui';
import { INTEGRATION_BY_KEY } from '../lib/integrations';
import { PHASES, SERVICE_CATALOG } from '../lib/service-catalog';
import {
  STAGE,
  addClientServices,
  addStep,
  buildProgress,
  buildsSummary,
  removeService,
  removeStep,
  setStepDone,
  stepEvidence,
} from '../lib/builds';
import { formatStamp } from '../lib/format';
import './BuildPanel.css';

/**
 * what arc is building for one client, and how far each build has got.
 *
 * one section per service they bought, each with its checklist in the two phases
 * the work happens in: build it, then integrate it into their business. the stage
 * pill and the progress bar are read off the boxes, so they cannot disagree with
 * them.
 *
 * where the console can see a step for itself — a token n8n has posted with, a
 * lead in the log, a twilio account recorded as connected — it says so under the
 * step. a box ticked against evidence that says otherwise is marked, the same way
 * "marked as" and "actually sending" sit side by side on the connections table.
 *
 * ticks are shown the moment they are clicked and written behind that. each one
 * re-reads only the checklists, not the event log, so working down a list is not
 * something you wait on.
 */

const GLYPH = { ok: '■', warn: '▲', idle: '□' };

const without = (record, key) => {
  const next = { ...record };
  delete next[key];
  return next;
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/* ── choosing services ───────────────────────────────────── */

/**
 * the catalog as a set of toggles. used on "add a client" and on a client page's
 * "add a service". `taken` maps a service the client already has to the stage it
 * is at, and those cannot be picked twice.
 */
export function ServicePicker({ selected, onToggle, taken = new Map() }) {
  return (
    <div className="bld-pick" role="group" aria-label="services">
      {SERVICE_CATALOG.map((service) => {
        const already = taken.get(service.key);
        const on = selected.includes(service.key);
        const count = (phase) => service.steps.filter((step) => step.phase === phase).length;
        const needs = service.needs.map((key) => INTEGRATION_BY_KEY.get(key)?.name ?? key);

        return (
          <button
            type="button"
            key={service.key}
            className={`bld-pick__card${on ? ' bld-pick__card--on' : ''}${already ? ' bld-pick__card--taken' : ''}`}
            aria-pressed={on}
            disabled={Boolean(already)}
            onClick={() => onToggle(service.key)}
          >
            <span className="bld-pick__top">
              <span className="bld-pick__box" aria-hidden="true">
                {(on || already) && <Icon name="check" size={12} />}
              </span>
              <span className="bld-pick__name">{service.name}</span>
              {service.featured && <span className="bld-pick__flag">core</span>}
            </span>
            <span className="bld-pick__brief">{service.brief}</span>
            <span className="bld-pick__meta">
              {already
                ? `already on this client · ${already}`
                : `${count('build')} build + ${count('integrate')} integrate steps`}
              {needs.length > 0 && !already && <span> · {needs.join(', ')}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── the panel ───────────────────────────────────────────── */

export default function BuildPanel({ client, reloadBuilds, readOnly = false }) {
  const { tenant, builds } = client;
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState([]);
  /* a tick shown before the write lands, keyed by step. while one is here the
     roster's copy of that step is ignored, so a re-read that started before this
     write finished cannot flick the box back. */
  const [pending, setPending] = useState({});
  const [errors, setErrors] = useState({});

  if (builds === null || builds === undefined) {
    return (
      <Panel title="what we’re building">
        <Notice tone="warn" title="the build checklist is not set up on this project">
          <p>
            {client.buildsError ?? 'the checklists could not be read'}. until then no services can be
            chosen for a client, and nothing else on this page is affected.
          </p>
        </Notice>
      </Panel>
    );
  }

  const done = (step) => (step.id in pending ? pending[step.id] : Boolean(step.doneAt));
  const summary = buildsSummary(builds);
  const taken = new Map(builds.map((build) => [build.key, STAGE[buildProgress(build).stage].label]));
  const everythingTaken = SERVICE_CATALOG.every((service) => taken.has(service.key));

  async function toggle(step) {
    const next = !done(step);
    setPending((prev) => ({ ...prev, [step.id]: next }));
    setErrors((prev) => without(prev, step.id));
    try {
      await setStepDone(step.id, next);
      await reloadBuilds();
    } catch (error) {
      setErrors((prev) => ({ ...prev, [step.id]: error.message }));
    } finally {
      setPending((prev) => without(prev, step.id));
    }
  }

  async function remove(step) {
    if (!window.confirm(`remove “${step.label}” from this checklist? it only applies to ${tenant.name}.`)) return;
    setErrors((prev) => without(prev, step.id));
    try {
      await removeStep(step.id);
      await reloadBuilds();
    } catch (error) {
      setErrors((prev) => ({ ...prev, [step.id]: error.message }));
    }
  }

  return (
    <Panel
      title="what we’re building"
      note={
        builds.length === 0
          ? 'no services chosen'
          : `${plural(summary.services, 'service')} · ${summary.done}/${summary.steps} steps · ${summary.delivered} delivered`
      }
      actions={
        !readOnly && (
          <button
            type="button"
            className="ws-btn"
            onClick={() => {
              setAdding((open) => !open);
              setPicked([]);
            }}
            disabled={everythingTaken && !adding}
            title={everythingTaken ? 'every service in the catalog is already on this client' : undefined}
          >
            <Icon name={adding ? 'close' : 'plus'} size={13} />
            {adding ? 'cancel' : 'add a service'}
          </button>
        )
      }
      bare
    >
      {adding && (
        <div className="bld-add">
          <p className="bld-add__lead">
            each service arrives with its checklist. steps can be added or removed for {tenant.name}{' '}
            afterwards without changing the catalog.
          </p>
          <ServicePicker
            selected={picked}
            taken={taken}
            onToggle={(key) =>
              setPicked((prev) => (prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]))
            }
          />
          <div className="ops-row">
            <ActionButton
              variant="primary"
              icon="plus"
              disabled={picked.length === 0}
              onRun={async () => {
                await addClientServices(tenant.id, picked);
                await reloadBuilds();
                setPicked([]);
                setAdding(false);
              }}
            >
              {picked.length ? `add ${plural(picked.length, 'service')}` : 'choose a service'}
            </ActionButton>
          </div>
        </div>
      )}

      {builds.length === 0 && !adding && (
        <Empty title={readOnly ? 'no services were recorded' : 'nothing chosen yet'}>
          {readOnly
            ? `no services were recorded for ${tenant.name} while they were a client.`
            : `choose what arc is building for ${tenant.name}. each service comes with its checklist — build it on arc’s side, then integrate it into their business — and this panel tracks it to delivered.`}
        </Empty>
      )}

      {builds.length > 0 && (
        <div className="bld-list">
          {builds.map((build) => (
            <BuildItem
              key={build.id}
              build={build}
              client={client}
              done={done}
              pending={pending}
              errors={errors}
              onToggle={toggle}
              onRemove={remove}
              reloadBuilds={reloadBuilds}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {builds.length > 0 && (
        <p className="ws-note bld-note">
          <b>delivered</b> means the checklist is finished — not that it is working. that is the
          pipeline check. where the console can see a step for itself, it says so underneath, and a
          box ticked against what it sees is marked <span className="bld-inline-warn">▲</span>.
        </p>
      )}
    </Panel>
  );
}

/* ── one service ─────────────────────────────────────────── */

function BuildItem({ build, client, done, pending, errors, onToggle, onRemove, reloadBuilds, readOnly }) {
  const zone = client.tenant.timezone;
  const progress = buildProgress(build, done);
  const stage = STAGE[progress.stage];
  /* open unless it is already delivered — decided once, when the page opens, so
     ticking the last box does not snap the section shut under the cursor. */
  const [initiallyOpen] = useState(progress.stage !== 'delivered');
  const disagree = build.steps.filter((step) => done(step) && stepEvidence(step, client)?.met === false).length;
  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;

  return (
    <details className={`bld bld--${progress.stage}`} open={initiallyOpen}>
      <summary className="bld__head">
        <Icon name="chevron" size={12} className="bld__chev" />
        <span className="bld__title">
          <span className="bld__name">{build.name}</span>
          {build.tag && <span className="bld__tag">{build.tag}</span>}
        </span>

        <span className="bld__status">
          {disagree > 0 && (
            <Pill tone="warn" title="ticked, but what the console can see says otherwise — open to see which">
              {disagree} to check
            </Pill>
          )}
          <Pill tone={stage.tone}>
            {progress.stage === 'delivered' && progress.deliveredAt
              ? `delivered ${DateTime.fromISO(progress.deliveredAt, { zone: 'utc' }).setZone(zone).toFormat('LLL d')}`
              : stage.label}
          </Pill>
          <span className="bld__bar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="bld__count mono" aria-label={`${progress.done} of ${progress.total} steps done`}>
            {progress.done}/{progress.total}
          </span>
        </span>
      </summary>

      <div className="bld__body">
        <div className="bld__phases">
          {PHASES.map((phase) => {
            const steps = build.steps.filter((step) => step.phase === phase.key);
            const counts = progress[phase.key];
            return (
              <section className="bld-phase" key={phase.key}>
                <header className="bld-phase__head">
                  <span className="bld-phase__label">{phase.label}</span>
                  <span className="bld-phase__note">{phase.note}</span>
                  <span className="bld-phase__count mono">
                    {counts.done}/{counts.total}
                  </span>
                </header>

                {steps.length === 0 ? (
                  <p className="bld-phase__empty">no steps in this phase.</p>
                ) : (
                  <ol className="bld-steps">
                    {steps.map((step) => (
                      <StepRow
                        key={step.id}
                        step={step}
                        client={client}
                        checked={done(step)}
                        busy={step.id in pending}
                        error={errors[step.id]}
                        onToggle={onToggle}
                        onRemove={onRemove}
                        readOnly={readOnly}
                      />
                    ))}
                  </ol>
                )}

                {!readOnly && <AddStep build={build} phase={phase.key} reloadBuilds={reloadBuilds} />}
              </section>
            );
          })}
        </div>

        <footer className="bld__foot">
          {build.needs.length > 0 && (
            <span className="bld__needs">
              <span className="bld__needs-label">runs on</span>
              {build.needs.map((key) => {
                const evidence = stepEvidence({ evidence: `account:${key}` }, client);
                const tone = evidence?.met ? 'ok' : 'idle';
                return (
                  <span className={`bld__need bld__need--${tone}`} key={key} title={evidence?.detail}>
                    <i aria-hidden="true">{GLYPH[tone]}</i>
                    {INTEGRATION_BY_KEY.get(key)?.name ?? key}
                  </span>
                );
              })}
            </span>
          )}

          <span className="bld__since mono">
            added {DateTime.fromISO(build.createdAt, { zone: 'utc' }).setZone(zone).toFormat('LLL d, yyyy')}
          </span>

          {!readOnly && (
            <ActionButton
              icon="trash"
              confirm={`remove ${build.name} from ${client.tenant.name}? its checklist and every tick on it go too. nothing else about the client changes.`}
              onRun={async () => {
                await removeService(build.id);
                await reloadBuilds();
              }}
            >
              remove service
            </ActionButton>
          )}
        </footer>
      </div>
    </details>
  );
}

/* ── one step ────────────────────────────────────────────── */

function StepRow({ step, client, checked, busy, error, onToggle, onRemove, readOnly }) {
  const zone = client.tenant.timezone;
  const evidence = stepEvidence(step, client);

  /* four cases, and the one that matters is ticked-but-not-seen. seen-but-not-
     ticked is not a warning: the operator may simply not have got to it. */
  const proof = !evidence
    ? null
    : checked
      ? evidence.met
        ? { tone: 'ok', text: evidence.detail }
        : { tone: 'warn', text: `ticked, but ${evidence.detail}` }
      : evidence.met
        ? { tone: 'ok', text: `already true — ${evidence.detail}` }
        : { tone: 'idle', text: evidence.detail };

  return (
    <li className={`bld-step${checked ? ' bld-step--done' : ''}${proof?.tone === 'warn' ? ' bld-step--warn' : ''}`}>
      <label className="bld-step__main">
        <input
          type="checkbox"
          checked={checked}
          disabled={readOnly || busy}
          onChange={() => onToggle(step)}
        />
        <span className="bld-step__text">
          <span className="bld-step__label">
            {step.label}
            {!step.key && <span className="bld-step__custom">added for this client</span>}
          </span>
          {step.detail && <span className="bld-step__detail">{step.detail}</span>}
          {proof && (
            <span className={`bld-step__proof bld-step__proof--${proof.tone}`}>
              <i aria-hidden="true">{GLYPH[proof.tone]}</i>
              {proof.text}
            </span>
          )}
          {error && <span className="ops-action__msg ops-action__msg--fail">{error}</span>}
        </span>
      </label>

      <span className="bld-step__side">
        {checked && step.doneAt && !busy && (
          <span className="bld-step__when mono" title={formatStamp(step.doneAt, zone)}>
            {DateTime.fromISO(step.doneAt, { zone: 'utc' }).setZone(zone).toFormat('LLL d')}
          </span>
        )}
        {!readOnly && (
          <button
            type="button"
            className="bld-step__remove"
            onClick={() => onRemove(step)}
            aria-label={`remove “${step.label}”`}
            title="remove this step for this client"
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </span>
    </li>
  );
}

function AddStep({ build, phase, reloadBuilds }) {
  const [label, setLabel] = useState('');
  const [state, setState] = useState({ kind: 'idle' });
  const busy = state.kind === 'busy';

  async function submit(event) {
    event.preventDefault();
    if (!label.trim() || busy) return;
    setState({ kind: 'busy' });
    try {
      await addStep(build, { phase, label });
      await reloadBuilds();
      setLabel('');
      setState({ kind: 'idle' });
    } catch (error) {
      setState({ kind: 'error', message: error.message });
    }
  }

  return (
    <form className="bld-addstep" onSubmit={submit}>
      <TextInput
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder={phase === 'build' ? 'add a build step for this client' : 'add an integration step for this client'}
        aria-label={`add a ${phase} step to ${build.name}`}
        disabled={busy}
      />
      <button type="submit" className="ws-btn" disabled={!label.trim() || busy}>
        <Icon name="plus" size={12} />
        {busy ? 'adding…' : 'add'}
      </button>
      {state.kind === 'error' && <span className="ops-action__msg ops-action__msg--fail">{state.message}</span>}
    </form>
  );
}

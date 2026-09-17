import { Panel, Pill } from './ui';
import { formatRelative } from '../lib/format';

/**
 * whether each module is working, and — the part that matters — what that answer is based on.
 *
 * every other monitoring panel in this product shows a state. this one shows the evidence
 * underneath it, because the claim being made is unusual: most dashboards say "healthy"
 * when the last workflow run did not throw, and this one refuses to. a module producing
 * events with nothing checking them reads `not verified`, in its own colour, with the
 * missing check named.
 *
 * that state exists to be acted on rather than tolerated. a client who sees it can ask for
 * the check; an operator who sees it knows exactly what is unwired.
 */

const TONE = {
  healthy: 'ok',
  degraded: 'warn',
  failing: 'fail',
  quiet: 'warn',
  unverified: 'idle',
  awaiting: 'idle',
  unavailable: 'neutral',
};

const CHECK_TONE = { ok: 'ok', warn: 'warn', fail: 'fail', idle: 'idle' };

export default function ModuleHealth({ health, timezone, title = 'automation health', note }) {
  const modules = Object.values(health).filter((module) => module.state !== 'unavailable');

  return (
    <Panel
      title={title}
      note={note ?? 'each module checked on its own evidence'}
    >
      <ul className="ws-health">
        {modules.map((module) => (
          <li key={module.key} className={`ws-health__row is-${module.state}`}>
            <div className="ws-health__head">
              <span className="ws-health__name">{module.label}</span>
              <Pill tone={TONE[module.state] ?? 'neutral'}>{module.word}</Pill>
            </div>

            <p className="ws-health__summary">{module.summary}</p>

            {module.checks.length > 0 && (
              <ul className="ws-health__checks">
                {module.checks.map((check) => (
                  <li key={check.key} className={`is-${CHECK_TONE[check.tone]}`}>
                    <i aria-hidden="true">
                      {check.tone === 'ok' ? '■' : check.tone === 'warn' ? '▲' : check.tone === 'fail' ? '●' : '□'}
                    </i>
                    <b>{check.label}</b>
                    <span>{check.detail}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="ws-health__foot mono">
              {module.lastSuccessAt
                ? `last activity ${formatRelative(module.lastSuccessAt, timezone)}`
                : 'no activity yet'}
              {module.lastCheckAt && ` · last check ${formatRelative(module.lastCheckAt, timezone)}`}
              {!module.verified && module.state !== 'awaiting' && ' · no end-to-end check wired up'}
            </p>
          </li>
        ))}
      </ul>

      <p className="ws-note">
        a module is only called <b>working</b> when something independent has proved it end to
        end — a synthetic job pushed through the live pipeline, a check on the shape of what
        arrives, or a floor under the volume. a workflow finishing without an error is not
        evidence that anything reached a customer, so it is never enough on its own, and a
        module with no check against it says so rather than borrowing the green.
      </p>
    </Panel>
  );
}

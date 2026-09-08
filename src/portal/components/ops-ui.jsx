import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { Pill } from './ui';

/**
 * the pieces the ops console is built out of, on top of the ones in ui.jsx.
 *
 * nothing here invents a look. a panel is still Panel, a status is still Pill, a
 * number is still StatCard — this file adds only the three things an operator
 * console needs that a client dashboard never did: fields you can type into, a
 * value you can copy in one click, and a button that reports whether the thing it
 * just did worked.
 *
 * that last one is the whole reason this file exists. the client portal has no
 * write path at all, so it has never had to answer "did that save?". every write
 * in the console goes through ActionButton, which stays busy until the promise
 * settles and then says plainly which way it went.
 */

/* ── copying ─────────────────────────────────────────────── */

/**
 * a value, and one click to put it on the clipboard.
 *
 * the confirmation is the button changing to a tick for a beat and changing back.
 * a toast for "copied" is a notification about the least surprising thing that
 * has ever happened, and it steals focus from the form you were filling in.
 */
export function CopyValue({ value, label, mono = true, title, display }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  const node = useRef(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* clipboard access needs a secure context and, in firefox, a permission.
         selecting the text is the honest fallback: it still gets the value into a
         paste with one keystroke, and it never claims to have copied something it
         did not. no "copied" tick is shown on this path for the same reason. */
      if (node.current) {
        const range = document.createRange();
        range.selectNodeContents(node.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  }, [value]);

  return (
    <span className="ops-copy" title={title}>
      {label && <span className="ops-copy__label">{label}</span>}
      {/* `display` is for values too long to be read on the page — the welcome
          email, a curl line. the chip then names what is on the clipboard rather
          than showing forty truncated characters of it, and the real value is
          still what gets copied. the hidden node is what the selection fallback
          above reaches for. */}
      <code className={`ops-copy__val${mono ? '' : ' ops-copy__val--plain'}`} ref={node}>
        {display ?? value}
      </code>
      <button
        type="button"
        className="ops-copy__btn"
        onClick={copy}
        aria-label={copied ? 'copied' : `copy ${label ?? 'value'}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </span>
  );
}

/* ── writing ─────────────────────────────────────────────── */

/**
 * a button attached to something that can fail.
 *
 * `onRun` returns a promise. the button is disabled while it is in flight, and
 * whatever it resolves to — a string, or nothing — is shown underneath. a
 * rejection is shown as the error, in full, unaltered: an ops console that
 * swallowed a postgres message and printed "something went wrong" would be
 * hiding the one piece of text that says what to do next.
 */
export function ActionButton({
  onRun,
  children,
  variant = '',
  icon,
  confirm,
  disabled,
  title,
}) {
  const [state, setState] = useState({ kind: 'idle' });
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setState({ kind: 'busy' });
    try {
      const result = await onRun();
      if (live.current) setState({ kind: 'done', message: typeof result === 'string' ? result : null });
    } catch (error) {
      if (live.current) setState({ kind: 'error', message: error.message });
    }
  }

  return (
    <span className="ops-action">
      <button
        type="button"
        className={`ws-btn${variant ? ` ws-btn--${variant}` : ''}`}
        onClick={run}
        disabled={disabled || state.kind === 'busy'}
        title={title}
      >
        {icon && <Icon name={state.kind === 'done' ? 'check' : icon} size={13} />}
        {state.kind === 'busy' ? 'working…' : children}
      </button>

      {state.kind === 'error' && <span className="ops-action__msg ops-action__msg--fail">{state.message}</span>}
      {state.kind === 'done' && state.message && (
        <span className="ops-action__msg ops-action__msg--ok">{state.message}</span>
      )}
    </span>
  );
}

/* ── forms ───────────────────────────────────────────────── */

export function Field({ label, hint, children, wide = false, required = false }) {
  return (
    <label className={`ops-field${wide ? ' ops-field--wide' : ''}`}>
      <span className="ops-field__label">
        {label}
        {required && <i title="required">*</i>}
      </span>
      {children}
      {hint && <span className="ops-field__hint">{hint}</span>}
    </label>
  );
}

export function TextInput({ mono = false, ...rest }) {
  return <input className={`ops-input${mono ? ' ops-input--mono' : ''}`} {...rest} />;
}

export function TextArea(props) {
  return <textarea className="ops-input ops-input--area" rows={3} {...props} />;
}

export function SelectInput({ options, ...rest }) {
  return (
    <select className="ops-input ops-input--select" {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* ── status vocabulary ───────────────────────────────────── */

/**
 * one mapping from a tenant's status to a pill, used everywhere.
 *
 * `onboarding` is deliberately not a warning. it is the correct state for a
 * client in their first fortnight, and a console that painted every new client
 * amber would train its only reader to ignore amber.
 */
const TENANT_TONE = { active: 'ok', onboarding: 'neutral', paused: 'warn', archived: 'idle' };

export function TenantStatus({ status }) {
  return <Pill tone={TENANT_TONE[status] ?? 'neutral'}>{status}</Pill>;
}

/* the pipeline's own verdict, from the event log rather than from the tenant row.
   the two disagree often and usefully: an "active" client whose canaries have
   been failing for a day is the row worth opening first. */
const PIPELINE_TONE = { operational: 'ok', degraded: 'warn', failed: 'fail' };
const PIPELINE_WORD = { operational: 'live', degraded: 'degraded', failed: 'action required' };

export function PipelineStatus({ status }) {
  const state = status?.status ?? 'operational';
  return (
    <Pill tone={PIPELINE_TONE[state]} title={status?.detail ?? undefined}>
      {PIPELINE_WORD[state]}
    </Pill>
  );
}

const LIVENESS_TONE = { live: 'ok', flaky: 'warn', stale: 'fail', silent: 'idle', unmatched: 'neutral' };

export function LivenessPill({ liveness }) {
  return <Pill tone={LIVENESS_TONE[liveness.state] ?? 'neutral'}>{liveness.label}</Pill>;
}

/* ── notices ─────────────────────────────────────────────── */

/**
 * something the operator has to know before the page below makes sense.
 *
 * used for exactly two things: a missing deployment step, and a failed read. both
 * are states with a fix, so both print the fix. a notice that only says a thing
 * is broken is a notice that gets dismissed.
 */
export function Notice({ tone = 'warn', title, children }) {
  return (
    <div className={`ops-notice ops-notice--${tone}`}>
      <Icon name={tone === 'fail' ? 'warn' : 'warn'} size={14} />
      <div>
        <p className="ops-notice__title">{title}</p>
        {children && <div className="ops-notice__body">{children}</div>}
      </div>
    </div>
  );
}

/**
 * a closed-by-default explainer for a procedure nobody runs often enough to
 * remember it — "add another operator" is the case this was built for, after
 * onboarding the first one meant reconstructing the steps from a chat log.
 *
 * plain `<details>` rather than state: the browser already tracks open/closed,
 * animates nothing that has to be undone, and survives a page reload with the
 * section however it was left — which is exactly the right behaviour for a
 * reference panel and not something worth a `useState` to reimplement.
 */
export function Disclosure({ title, summary, defaultOpen = false, children }) {
  return (
    <details className="ops-disclosure" open={defaultOpen || undefined}>
      <summary className="ops-disclosure__head">
        <Icon name="chevron" size={12} className="ops-disclosure__chev" />
        <span className="ops-disclosure__title">{title}</span>
        {summary && <span className="ops-disclosure__summary">{summary}</span>}
      </summary>
      <div className="ops-disclosure__body">{children}</div>
    </details>
  );
}

/* a labelled key/value, for the identity blocks that head every client page. */
export function Fact({ label, children, note }) {
  return (
    <div className="ws-facts__row">
      <dt>{label}</dt>
      <dd>
        {children}
        {note && <span className="ws-facts__note">{note}</span>}
      </dd>
    </div>
  );
}

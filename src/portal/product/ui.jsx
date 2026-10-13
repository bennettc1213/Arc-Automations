import { useEffect, useId, useRef } from 'react';

export function Button({ children, primary, quiet, className = '', ...props }) {
  return (
    <button type="button" className={`ap-button${primary ? ' ap-button--primary' : ''}${quiet ? ' ap-button--quiet' : ''} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = '' }) {
  return <span className={`ap-badge${tone ? ` ap-badge--${tone}` : ''}`}>{children}</span>;
}

export function Field({ label, error, hint, children }) {
  const id = useId();
  return (
    <label className="ap-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small id={id} role="alert" className="ap-error">{error}</small>}
    </label>
  );
}

export function Notice({ children, warning = false }) {
  return <div className={`ap-notice${warning ? ' ap-notice--warning' : ''}`}>{children}</div>;
}

export function Section({ title, note, action, children }) {
  return (
    <section className="ap-section">
      <div className="ap-section-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A page's title block: one heading, one sentence, at most one action. */
export function PageHead({ back, title, children, action }) {
  return (
    <div className="ap-page-intro">
      <div>
        {back}
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** One answer to a question. `recommended` shows the pill and the reason beside it. */
export function Choice({ type = 'radio', name, checked, onChange, title, children, recommended, reason, disabled }) {
  return (
    <label className={`ap-choice${checked ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}>
      <input type={type} name={name} checked={checked} onChange={onChange} disabled={disabled} />
      <span className="ap-choice-body">
        <span className="ap-choice-title">
          {title}
          {recommended && <Badge tone="rec">Recommended</Badge>}
        </span>
        {children && <span className="ap-choice-text">{children}</span>}
        {recommended && reason && <span className="ap-choice-reason">{reason}</span>}
      </span>
    </label>
  );
}

export function Choices({ legend, legendHidden, hint, children }) {
  return (
    <fieldset className="ap-choice-group">
      {legend && <legend className={legendHidden ? 'ap-sr' : undefined}>{legend}</legend>}
      {hint && <p className="ap-muted">{hint}</p>}
      <div className="ap-choice-list">{children}</div>
    </fieldset>
  );
}

/** A done / not-done list where each open item says where to fix it. */
export function Checklist({ items, renderAction }) {
  return (
    <ul className="ap-checks">
      {items.map(item => (
        <li key={item.id} className={item.done ? 'is-done' : ''}>
          <span className="ap-check-mark" aria-hidden="true">{item.done ? '✓' : ''}</span>
          <div>
            <b>{item.label}</b>
            <span className="ap-sr"> {item.done ? '(done)' : '(to do)'}</span>
            {!item.done && item.detail && <p>{item.detail}</p>}
          </div>
          {!item.done && renderAction?.(item)}
        </li>
      ))}
    </ul>
  );
}

export function Progress({ value, max, label }) {
  return (
    <div className={`ap-progress${value >= max ? ' is-full' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${Math.round((value / max) * 100)}%` }} />
    </div>
  );
}

export function Dialog({ title, children, onClose }) {
  const ref = useRef(null), id = useId();
  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, []);
  return (
    <dialog className="ap-dialog" ref={ref} aria-labelledby={id}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      <div className="ap-dialog-head">
        <h2 id={id}>{title}</h2>
        <Button quiet onClick={onClose} aria-label="Close dialog">Close</Button>
      </div>
      {children}
    </dialog>
  );
}

export const dateLabel = (at, zone = 'America/New_York') => at ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(at)) : 'No activity yet';
export const sourceLabel = source => ({ phone: 'Missed call', form: 'Website inquiry', existing: 'Existing contacts', prospect: 'Sourced prospect' })[source] || 'Unknown source';
export const stateLabel = state => ({ not_connected: 'Not connected', pending_review: 'Waiting on ARC', needs_attention: 'Needs attention', in_progress: 'In progress', connected: 'Connected', unavailable: 'Unavailable', draft: 'Draft', simulated: 'Running on sample data', paused: 'Paused' })[state] || state;
export const stateTone = state => ({ connected: 'good', simulated: 'good', needs_attention: 'warn', pending_review: 'warn', in_progress: 'warn', paused: 'warn' })[state] || '';
export const initials = name => String(name || '?').split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();

const EVENT_WORDS = { missed_call: 'Missed call', eligible_inquiry: 'New inquiry', eligible_contact: 'Contact due a check-in', accepted: 'Text queued', sent: 'Text sent', delivered: 'Text delivered', replied: 'Customer replied', qualified: 'Looks like a fit', owner_notified: 'You were alerted', suppressed: 'Opted out', owner_takeover: 'You took over', owner_resumed: 'ARC resumed', owner_reported_booking: 'Booking reported', owner_message: 'You replied', sample_followup: 'Check-in sent', followup_held: 'Check-in held' };
export const eventLabel = type => EVENT_WORDS[type] || String(type || '').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

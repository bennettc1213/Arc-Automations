import { useEffect, useId, useRef } from 'react';
export function Button({ children, primary, ...props }) { return <button type="button" className={`ap-button${primary ? ' ap-button--primary' : ''}`} {...props}>{children}</button>; }
export function Badge({ children, tone = '' }) { return <span className={`ap-badge ${tone && `ap-badge--${tone}`}`}>{children}</span>; }
export function Field({ label, error, hint, children }) { const id = useId(); return <label className="ap-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}{error && <small id={id} role="alert" className="ap-error">{error}</small>}</label>; }
export function Notice({ children, warning = false }) { return <div className={`ap-notice${warning ? ' ap-notice--warning' : ''}`}>{children}</div>; }
export function Section({ title, note, action, children }) { return <section className="ap-section"><div className="ap-section-head"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div>{children}</section>; }
export function Dialog({ title, children, onClose }) {
  const ref = useRef(null), id = useId();
  useEffect(() => { const node = ref.current; const previous = document.activeElement; node.showModal(); return () => { node.close(); previous?.focus(); }; }, []);
  return <dialog className="ap-dialog" ref={ref} aria-labelledby={id} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="ap-dialog-head"><h2 id={id}>{title}</h2><Button onClick={onClose} aria-label="Close dialog">Close</Button></div>{children}</dialog>;
}
export const dateLabel = (at, zone = 'America/New_York') => at ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(at)) : 'No activity yet';
export const sourceLabel = source => ({ phone: 'Missed call', form: 'Website inquiry', existing: 'Existing contacts', prospect: 'Sourced prospect' })[source] || 'Unknown source';
export const stateLabel = state => ({ not_connected: 'Not connected', pending_review: 'Pending review', needs_attention: 'Needs attention', in_progress: 'In progress', connected: 'Connected', unavailable: 'Unavailable', draft: 'Draft', simulated: 'Simulated live', paused: 'Paused' })[state] || state;

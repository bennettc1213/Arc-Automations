import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { FORM_KEY, parseSubmission } from '../../../supabase/functions/_shared/intake/model.ts';
import './PublicForm.css';

/**
 * ARC-350 — a client's hosted form, at `/form/<key>`. The same page is what the embed frames
 * (`?embed=1`), so there is one renderer and no script on anybody else's site.
 *
 * It is read by a member of the public who has never heard of ARC: the business's name, the
 * questions, one button. The page knows only the key in its address. It asks the
 * `native-intake` function for the published form that key names and posts the answers
 * back; it is never given a client id, and there is nothing in it to configure.
 *
 * Answers are checked here with the same `parseSubmission` the function runs, so a mistake
 * is shown next to the field before anything is sent. The function checks again.
 *
 * Deliberately not the Supabase client: this page needs one GET and one POST, and a visitor
 * filling in a plumber's contact form should not download an auth library to do it.
 */

const ENDPOINT = `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/native-intake`;

const AUTOCOMPLETE = { name: 'name', phone: 'tel', email: 'email', address: 'street-address', city: 'address-level2', region: 'address-level1', postal_code: 'postal-code' };

function newSubmissionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

function FieldInput({ field, id, value, invalid, describedBy, onChange }) {
  const common = { id, name: field.key, required: field.required, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  if (field.type === 'textarea') {
    return <textarea {...common} rows={4} maxLength={field.max_length ?? undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.type === 'select' || field.type === 'service') {
    const choices = field.type === 'service' ? field.choices ?? [] : (field.options ?? []).map((option) => ({ value: option, label: option }));
    return (
      <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  const type = field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : 'text';
  return (
    <input
      {...common}
      type={type}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      autoComplete={AUTOCOMPLETE[field.key] ?? 'off'}
      maxLength={field.max_length ?? undefined}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function PublicForm() {
  const { key } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get('embed') === '1';
  const [state, setState] = useState({ kind: 'loading' });
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState([]);
  const [phase, setPhase] = useState('idle'); // idle | sending | sent | failed
  const [failure, setFailure] = useState('');
  const renderedAt = useRef(Date.now());
  const submissionId = useRef(newSubmissionId());
  const formNode = useRef(null);

  /* the site's square cursor and dark page belong to ARC, not to this business's customer. */
  useEffect(() => {
    document.documentElement.classList.add('arc-form-page');
    return () => document.documentElement.classList.remove('arc-form-page');
  }, []);

  useEffect(() => {
    let live = true;
    if (!FORM_KEY.test(key ?? '') || !import.meta.env.VITE_SUPABASE_URL) {
      setState({ kind: 'unavailable' });
      return undefined;
    }
    fetch(`${ENDPOINT}/form?key=${encodeURIComponent(key)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!live) return;
        if (!body?.form) return setState({ kind: 'unavailable' });
        document.title = `${body.form.title} — ${body.form.business}`;
        renderedAt.current = Date.now();
        return setState({ kind: 'ready', form: body.form });
      })
      .catch(() => live && setState({ kind: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [key]);

  const form = state.kind === 'ready' ? state.form : null;
  const services = useMemo(
    () => (form?.fields.find((f) => f.type === 'service')?.choices ?? []).map((c) => ({ id: c.value, key: c.value, name: c.label, category_id: null })),
    [form],
  );
  const errorFor = (field) => errors.find((error) => error.field === field)?.message;
  const set = (field, value) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => current.filter((error) => error.field !== field));
  };

  async function submit(event) {
    event.preventDefault();
    if (!form || phase === 'sending') return;
    const checked = parseSubmission(form, values, { formName: form.title, services });
    if (!checked.ok) {
      setErrors(checked.errors);
      formNode.current?.querySelector(`[name="${checked.errors[0].field}"]`)?.focus();
      return;
    }
    setPhase('sending');
    setFailure('');
    try {
      const response = await fetch(`${ENDPOINT}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          values,
          submission_id: submissionId.current,
          rendered_at: renderedAt.current,
          company_website: new FormData(formNode.current).get('company_website') ?? '',
          attribution: { page: window.location.href, referrer: document.referrer, embedded },
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) return setPhase('sent');
      if (response.status === 422 && body?.field_errors?.length) {
        setErrors(body.field_errors);
        setPhase('idle');
        return undefined;
      }
      setFailure(body?.error ?? 'That did not send.');
      return setPhase('failed');
    } catch {
      setFailure('That did not send — check your connection and try again.');
      return setPhase('failed');
    }
  }

  return (
    <main className={`pform${embedded ? ' pform--embed' : ''}`}>
      <div className="pform__card">
        {state.kind === 'loading' && (
          <p className="pform__quiet" aria-busy="true">
            Loading…
          </p>
        )}

        {state.kind === 'unavailable' && (
          <>
            <h1 className="pform__title">This form is not available</h1>
            <p className="pform__quiet">The link may be out of date. Please contact the business directly.</p>
          </>
        )}

        {form && phase === 'sent' && (
          <div role="status">
            <p className="pform__business">{form.business}</p>
            <h1 className="pform__title">{form.success_message}</h1>
          </div>
        )}

        {form && phase !== 'sent' && (
          <form ref={formNode} onSubmit={submit} noValidate>
            <p className="pform__business">{form.business}</p>
            <h1 className="pform__title">{form.title}</h1>
            {form.intro && <p className="pform__intro">{form.intro}</p>}

            {form.fields.map((field) => {
              const id = `pf-${field.key}`;
              const problem = errorFor(field.key);
              const described = [field.help && `${id}-help`, problem && `${id}-error`].filter(Boolean).join(' ') || undefined;
              if (field.type === 'checkbox') {
                return (
                  <div key={field.key} className="pform__field">
                    <label className="pform__tick">
                      <input type="checkbox" name={field.key} checked={values[field.key] === true} aria-describedby={described} onChange={(e) => set(field.key, e.target.checked)} />
                      <span>
                        {field.label}
                        {field.required && <span aria-hidden="true"> *</span>}
                      </span>
                    </label>
                    {problem && (
                      <p className="pform__error" id={`${id}-error`}>
                        {field.label} {problem}
                      </p>
                    )}
                  </div>
                );
              }
              return (
                <div key={field.key} className="pform__field">
                  <label htmlFor={id}>
                    {field.label}
                    {field.required ? <span aria-hidden="true"> *</span> : <span className="pform__optional"> (optional)</span>}
                  </label>
                  <FieldInput field={field} id={id} value={values[field.key]} invalid={Boolean(problem)} describedBy={described} onChange={(value) => set(field.key, value)} />
                  {field.help && (
                    <p className="pform__help" id={`${id}-help`}>
                      {field.help}
                    </p>
                  )}
                  {problem && (
                    <p className="pform__error" id={`${id}-error`}>
                      {field.label} {problem}
                    </p>
                  )}
                </div>
              );
            })}

            {/* a field a person never sees and a script usually fills. */}
            <div className="pform__hp" aria-hidden="true">
              <label>
                Company website
                <input name="company_website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>

            {['sms', 'email'].map((channel) => {
              const asked = form.consent?.[channel];
              const name = `consent_${channel}`;
              const problem = errorFor(name);
              if (!asked) return null;
              return (
                <div key={channel} className="pform__field">
                  {/* never ticked for them: what is sent is what they chose. */}
                  <label className="pform__tick">
                    <input type="checkbox" name={name} checked={values[name] === true} onChange={(e) => set(name, e.target.checked)} />
                    <span>{asked.text}</span>
                  </label>
                  {problem && <p className="pform__error">{problem.charAt(0).toUpperCase() + problem.slice(1)}</p>}
                </div>
              );
            })}

            {errors.length > 0 && (
              <p className="pform__error" role="alert">
                {errors.length === 1 ? 'One answer needs another look.' : `${errors.length} answers need another look.`}
              </p>
            )}
            {phase === 'failed' && (
              <p className="pform__error" role="alert">
                {failure}
              </p>
            )}

            <button type="submit" className="pform__send" disabled={phase === 'sending'}>
              {phase === 'sending' ? 'Sending…' : form.submit_label}
            </button>
          </form>
        )}
      </div>
      <p className="pform__by">Form by ARC Automations</p>
    </main>
  );
}

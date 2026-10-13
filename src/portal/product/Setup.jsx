import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SETUP_STEPS, validateBusiness, newCampaign } from './model';
import { TRADES, applyRecommended, readinessItems, suggestedServices } from './guide';
import { CampaignChoices, Journey } from './Campaigns';
import { Badge, Button, Checklist, Field, Notice, PageHead, Progress, stateLabel, stateTone } from './ui';
import { configureForm } from './api';

const ZONES = { 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Phoenix': 'Arizona time',
  'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time', UTC: 'UTC' };

export function BusinessForm({ business, onChange, errors = {} }) {
  const change = key => e => onChange({ ...business, [key]: e.target.value });
  const suggested = suggestedServices(business);
  const add = service => onChange({ ...business, services: [business.services.trim().replace(/,$/, ''), service].filter(Boolean).join(', ') });
  return (
    <div className="ap-form">
      <fieldset className="ap-form-group">
        <legend>Your business</legend>
        <div className="ap-form-grid">
          <Field label="Business name" error={errors.name}>
            <input value={business.name} maxLength={400} onChange={change('name')} aria-invalid={Boolean(errors.name)} />
          </Field>
          <Field label="What kind of work you do" error={errors.trade}>
            <input value={business.trade} maxLength={400} onChange={change('trade')} aria-invalid={Boolean(errors.trade)} list="ap-trades" placeholder="For example, Plumbing" />
            <datalist id="ap-trades">{Object.keys(TRADES).map(trade => <option key={trade} value={trade} />)}</datalist>
          </Field>
        </div>
        <Field label="Services you offer" hint="Separate them with commas. ARC uses this list to tell you whether a job is one you do." error={errors.services}>
          <input value={business.services} maxLength={400} onChange={change('services')} aria-invalid={Boolean(errors.services)} />
        </Field>
        {suggested.length > 0 && (
          <div className="ap-suggest">
            <span>Common for {business.trade.trim()}:</span>
            {suggested.map(service => <Button key={service} quiet onClick={() => add(service)}>+ {service}</Button>)}
          </div>
        )}
        <Field label="Where you work" hint="ZIP codes or town names, separated by commas. A job outside this area is flagged for you." error={errors.area}>
          <input value={business.area} maxLength={400} onChange={change('area')} aria-invalid={Boolean(errors.area)} />
        </Field>
      </fieldset>

      <fieldset className="ap-form-group">
        <legend>Your hours</legend>
        <div className="ap-form-grid ap-form-grid--four">
          <Field label="Working days" error={errors.days}>
            <select value={business.days} onChange={change('days')}>
              <option>Monday–Friday</option><option>Monday–Saturday</option><option>Every day</option>
            </select>
          </Field>
          <Field label="Opens"><input type="time" value={business.open} onChange={change('open')} /></Field>
          <Field label="Closes" error={errors.close}><input type="time" value={business.close} onChange={change('close')} /></Field>
          <Field label="Timezone" error={errors.timezone}>
            <select value={business.timezone} onChange={change('timezone')}>
              {[...new Set([business.timezone, ...Object.keys(ZONES)])].map(zone => <option key={zone} value={zone}>{ZONES[zone] || zone}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="ap-form-group">
        <legend>How ARC reaches you</legend>
        <div className="ap-form-grid">
          <Field label="When a customer needs you">
            <select value={business.alerts} onChange={change('alerts')}>
              <option value="Inbox and owner text">Show it in my inbox and text me</option>
              <option value="Inbox only">Show it in my inbox</option>
            </select>
          </Field>
          <Field label="Your mobile number" hint="Optional. Start with the country code, like +15551234567. Text alerts begin once ARC has verified it with you." error={errors.ownerPhone}>
            <input type="tel" value={business.ownerPhone || ''} onChange={change('ownerPhone')} />
          </Field>
        </div>
      </fieldset>
    </div>
  );
}

const HOW = {
  phone: ['Agree with ARC support which number customers dial and where it forwards.', 'Together you test a call you answer, one you miss, a repeat caller and voicemail.', 'From then on a missed caller gets a text about that call only, and can reply STOP.'],
  form: ['Enter your website address exactly, starting with https://.', 'Paste the snippet into your site, then send yourself a test inquiry with the permission box ticked.', 'Check that the inquiry shows up under Leads.'],
  messaging: ['ARC registers your business with the phone carriers. In the US a business must do this before it can text customers.', 'The carriers review it. ARC tells you as soon as it clears.', 'Opt-outs are handled for you: anyone who replies STOP is not texted again.'],
  existing: ['Note where the list came from.', 'Only contacts with a record of agreeing to this kind of message are texted.', 'Go through the list with ARC before a campaign uses it.'],
};
const UNKNOWN = [
  { id: 'phone', name: 'Business phone', state: 'unavailable', detail: 'ARC could not load the status of your phone line.' },
  { id: 'form', name: 'Website inquiries', state: 'unavailable', detail: 'ARC could not load the status of your website form.' },
  { id: 'messaging', name: 'Business messaging', state: 'unavailable', detail: 'ARC could not load the status of your texting registration.' },
];

export function Connections({ state, dispatch, compact = false, onReload }) {
  const [selected, setSelected] = useState(null);
  const [origin, setOrigin] = useState(state.form?.origins?.[0] || '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => setOrigin(state.form?.origins?.[0] || ''), [state.form?.origins?.[0]]);
  const demo = state.mode === 'demo';
  const connections = state.connections.length ? state.connections : UNKNOWN;
  const snippet = state.form?.public_key && import.meta.env.VITE_SUPABASE_URL
    ? `<div data-arc-lead-form></div>\n<script async src="${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lead-intake/embed.js?key=${state.form.public_key}"></script>` : '';
  async function saveOrigin(value) {
    setBusy(true); setFeedback('');
    try {
      await configureForm(state.tenantId, value);
      await onReload?.();
      setFeedback(value ? 'Saved. Paste the snippet into your site, then send yourself a test inquiry.' : 'Your website form is switched off.');
    } catch (error) { setFeedback(`That did not save: ${error.message}`); }
    finally { setBusy(false); }
  }
  return (
    <>
      {!compact && <PageHead title="Connections">How leads reach ARC, and how ARC reaches your customers.</PageHead>}
      <div className="ap-connection-list">
        {connections.map(c => {
          const open = selected === c.id;
          return (
            <article key={c.id} className="ap-card ap-connection">
              <div className="ap-row">
                <h3>{c.name}</h3>
                <Badge tone={stateTone(c.state)}>{demo && c.state === 'connected' ? 'Connected (sample)' : stateLabel(c.state)}</Badge>
              </div>
              <p>{c.detail}</p>
              <Button aria-expanded={open} onClick={() => setSelected(open ? null : c.id)}>{open ? 'Hide steps' : 'How to connect'}</Button>
              {open && (
                <div className="ap-connection-detail">
                  <ol className="ap-numbered">{(HOW[c.id] || HOW.messaging).map(line => <li key={line}>{line}</li>)}</ol>
                  {demo && (
                    <div className="ap-actions">
                      <Button onClick={() => dispatch({ type: 'connection', id: c.id, state: 'connected' })}>Mark as connected</Button>
                      <Button quiet onClick={() => dispatch({ type: 'connection', id: c.id, state: 'needs_attention' })}>Mark as failing</Button>
                      <span className="ap-muted">Demo only. A real connection is checked by ARC.</span>
                    </div>
                  )}
                  {!demo && c.id === 'form' && state.form?.available && (
                    <div>
                      <Field label="Your website address" hint="Like https://yourbusiness.com, with nothing after the name.">
                        <input value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://yourbusiness.com" />
                      </Field>
                      <div className="ap-actions">
                        <Button primary disabled={busy || !origin.trim()} onClick={() => saveOrigin(origin.trim())}>Save website address</Button>
                        {state.form.public_key && <Button disabled={busy} onClick={() => saveOrigin('')}>Switch form off</Button>}
                      </div>
                      {feedback && <p role="status">{feedback}</p>}
                      {snippet && (
                        <Field label="Paste this into your website" hint="This code is safe to publish. ARC only accepts inquiries from the address above, and limits how many can arrive.">
                          <textarea readOnly value={snippet} rows={4} onFocus={event => event.target.select()} />
                        </Field>
                      )}
                      {state.form.last_used_at && <p className="ap-muted">Last inquiry received {new Date(state.form.last_used_at).toLocaleString()}.</p>}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      <p className="ap-muted">ARC support sets up call routing and text registration with you. Being connected does not switch a campaign on.</p>
    </>
  );
}

const TITLES = ['Tell us about your business', 'Pick your first campaign', 'Connect what it needs', 'See what your customer gets', 'Check what is left'];
const EXAMPLE = { name: 'Halstead Heating & Air', trade: 'HVAC', services: 'Heating repair, AC repair, Maintenance', area: '43215, 43220, Columbus', timezone: 'America/New_York' };

export function Setup({ state, dispatch, base, onReload }) {
  const [business, setBusiness] = useState(state.business), [errors, setErrors] = useState({});
  const demo = state.mode === 'demo';
  const step = state.setupStep;
  const first = state.campaigns[0];
  const left = first ? readinessItems(first, state) : [];
  const ready = first && left.every(item => item.done);
  const advance = async () => {
    if (step === 0) {
      const problems = validateBusiness(business);
      setErrors(problems);
      if (Object.keys(problems).length) return;
      if (demo) { await dispatch({ type: 'business', business }); await dispatch({ type: 'setup', step: 1 }); }
      else await dispatch({ type: 'business', business, step: 1 });
      return;
    }
    await dispatch({ type: 'setup', step: Math.min(4, step + 1) });
  };
  return (
    <>
      <PageHead title="Set up your business" action={<Link className="ap-button" to={base}>Look around first</Link>}>
        {demo ? 'Five short steps. This is the demo, so use made-up details.'
          : state.setupAvailable ? 'Five short steps. Your answers save each time you continue, so you can stop and come back.'
            : 'Setup cannot be saved on this account yet. Please contact ARC support.'}
      </PageHead>
      <ol className="ap-steps">
        {SETUP_STEPS.map((title, i) => (
          <li key={title}>
            <button type="button" disabled={i > step} aria-current={i === step ? 'step' : undefined} className={i < step ? 'is-done' : ''} onClick={() => dispatch({ type: 'setup', step: i })}>
              <span>{i < step ? '✓' : i + 1}</span>{title}
            </button>
          </li>
        ))}
      </ol>
      <div className="ap-guide ap-guide--wide">
        <div className="ap-guide-main">
          <p className="ap-guide-count">Step {step + 1} of {SETUP_STEPS.length}</p>
          <h2 className="ap-guide-question">{TITLES[step]}</h2>

          {step === 0 && (
            <>
              <p className="ap-guide-help">You enter this once. Every campaign reuses it.</p>
              {demo && <Button onClick={() => setBusiness({ ...business, ...EXAMPLE })}>Fill in example details</Button>}
              <BusinessForm business={business} onChange={setBusiness} errors={errors} />
            </>
          )}
          {step === 1 && (
            <>
              <p className="ap-guide-help">Start with how most customers reach you. ARC fills in the settings it recommends, and you can change any of them later.</p>
              {first && <Notice>You picked {first.name}. Continue, or choose another below to add it.</Notice>}
              <CampaignChoices state={state} base={base} onSelect={async kind => {
                if (await dispatch({ type: 'saveCampaign', campaign: applyRecommended(newCampaign(kind, state.tenantId), state) })) await dispatch({ type: 'setup', step: 2 });
              }} />
            </>
          )}
          {step === 2 && (
            <>
              <p className="ap-guide-help">You can keep going while a connection is still being set up.</p>
              <Connections state={state} dispatch={dispatch} onReload={onReload} compact />
            </>
          )}
          {step === 3 && (first ? (
            <>
              <p className="ap-guide-help">This is {first.name}, start to finish, with the settings ARC recommends.</p>
              <Journey campaign={first} business={state.business} className="ap-card" />
              <Link className="ap-button" to={`${base}/campaigns/${first.id}`}>Change the wording or questions</Link>
            </>
          ) : <Notice>Pick a campaign in step 2 to see it here.</Notice>)}
          {step === 4 && (
            <>
              <p className="ap-guide-help">Your setup is saved. This is what still stands between {first ? first.name : 'your campaign'} and going live.</p>
              <div className="ap-card">
                <Progress value={left.filter(item => item.done).length + (first ? 2 : 1)} max={left.length + 2} label="Setup progress" />
                <Checklist
                  items={[{ id: 'account', label: 'Account created', done: true },
                    { id: 'campaign', label: 'First campaign chosen', done: Boolean(first), detail: 'Go back to step 2 and pick one.' }, ...left]}
                  renderAction={item => item.to ? <Link className="ap-button" to={`${base}/${item.to}`}>{item.action}</Link>
                    : item.step && first ? <Link className="ap-button" to={`${base}/campaigns/${first.id}`}>{item.action}</Link> : null} />
              </div>
              <div className="ap-actions">
                {first && <Link className={`ap-button${ready && demo ? '' : ' ap-button--primary'}`} to={`${base}/campaigns/${first.id}`}>Review and test your campaign</Link>}
                {demo && ready && <Button primary onClick={() => dispatch({ type: 'setup', step: 4, complete: true })}>Finish setup</Button>}
              </div>
            </>
          )}

          <div className="ap-form-footer">
            <Button disabled={step === 0} onClick={() => dispatch({ type: 'setup', step: step - 1 })}>Back</Button>
            {step < 4 && (step !== 1 || first) && <Button primary onClick={advance}>Continue</Button>}
          </div>
        </div>
      </div>
    </>
  );
}

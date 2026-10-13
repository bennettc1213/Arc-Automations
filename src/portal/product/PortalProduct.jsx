import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import Icon from '../components/Icon';
import OwnerAccount from '../pages/dash/OwnerAccount';
import { productionState } from './production';
import { billingSession, saveBusiness, saveCampaign } from './api';
import { SETUP_STEPS, metrics, validateBusiness } from './model';
import { oneLine, readinessItems, usageWarning } from './guide';
import { Campaigns, CampaignBuilder } from './Campaigns';
import { Setup, Connections, BusinessForm } from './Setup';
import { Leads, Inbox, Timeline } from './LeadsInbox';
import Sources from './Sources';
import { Badge, Button, Dialog, Notice, PageHead, Progress, Section, dateLabel, initials, stateLabel, stateTone } from './ui';
import { site } from '../../data/site';
import './product.css';

const PRIMARY = [['', 'Home', 'overview'], ['leads', 'Leads', 'leads'], ['campaigns', 'Campaigns', 'automations'], ['inbox', 'Inbox', 'bell']];
const SECONDARY = [['connections', 'Connections', 'reliability'], ['settings', 'Settings', 'account'], ['billing', 'Billing', 'reports'], ['help', 'Help', 'support']];
const LEGACY = ['jobs', 'needs-you', 'account', 'account/details', 'account/records', 'account/summary', 'activity', 'automations', 'reliability', 'reports', 'estimates', 'reviews', 'memberships', 'installs', 'support'];
const TOOLS = [['account/records', 'Contact records and tasks'], ['account/summary', 'Monthly fee summary'], ['jobs', 'Job evidence'], ['needs-you', 'Outcome questions'], ['reports', 'Reports and exports'], ['account/details', 'Account details'], ['automations', 'What is running now'], ['activity', 'Activity history'], ['reliability', 'Reliability']];
// the model's own figures, under the words an owner would use for them
const METRIC_WORDS = { eligible: 'Inquiries ARC could answer', sent: 'Typical time to first text', engaged: 'Missed callers who replied', qualified: 'Leads that look like a fit' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// a real account has no "setup complete" flag yet: the last step with a campaign saved is the same thing
const settingUp = state => !state.setupComplete && !(state.mode !== 'demo' && state.setupStep >= SETUP_STEPS.length - 1 && state.campaigns.length > 0);

/** The one thing most worth doing now, read off the same state every page shows. */
function nextStep(state, base) {
  const waiting = state.leads.filter(lead => lead.needsOwner);
  if (waiting.length) {
    const names = waiting.slice(0, 2).map(lead => lead.name).join(' and ');
    return { title: `${plural(waiting.length, 'customer')} waiting on you`,
      text: waiting.length > 2 ? `${names} and ${waiting.length - 2} more need a person.` : `${names} ${waiting.length > 1 ? 'need' : 'needs'} a person.`,
      to: waiting.length === 1 ? `${base}/inbox/${waiting[0].id}` : `${base}/inbox`, action: 'Open inbox' };
  }
  if (settingUp(state)) {
    return { title: 'Finish setting up', text: `Step ${state.setupStep + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[state.setupStep].toLowerCase()}.`, to: `${base}/setup`, action: 'Continue setup' };
  }
  const broken = state.connections.find(c => c.state === 'needs_attention');
  if (broken) return { title: `${broken.name} needs attention`, text: broken.detail, to: `${base}/connections`, action: 'Open connections' };
  if (!state.campaigns.length) {
    return { title: 'Create your first campaign', text: 'Answer a few questions and ARC sets up the rest with the settings it recommends.', to: `${base}/campaigns/new`, action: 'New campaign' };
  }
  for (const c of state.campaigns.filter(c => c.runtime === 'draft')) {
    const todo = readinessItems(c, state).find(item => !item.done && item.id !== 'publish');
    if (todo) return { title: `${c.name} is not ready yet`, text: `Next: ${todo.todo}.`, to: `${base}/campaigns/${c.id}`, action: 'Open campaign' };
  }
  return null;
}

function Overview({ state, base }) {
  const demo = state.mode === 'demo';
  const attention = state.leads.filter(lead => lead.needsOwner);
  const broken = state.connections.filter(c => c.state === 'needs_attention');
  const setup = settingUp(state);
  const next = nextStep(state, base);
  return (
    <>
      <PageHead title={setup ? 'Let’s get your first campaign ready.' : 'Keep the conversation going.'}>
        {setup ? 'Tell ARC about your business, pick a campaign, then test it.' : 'Who needs you, what ARC is handling, and how it is going.'}
      </PageHead>

      {next ? (
        <div className="ap-card ap-next-card">
          <div>
            <p className="ap-next-label">Recommended next step</p>
            <h2>{next.title}</h2>
            <p>{next.text}</p>
            {setup && next.action === 'Continue setup' && <Progress value={state.setupStep} max={SETUP_STEPS.length} label="Setup progress" />}
          </div>
          <Link className="ap-button ap-button--primary" to={next.to}>{next.action}</Link>
        </div>
      ) : (
        <div className="ap-card ap-next-card ap-next-card--quiet">
          <div>
            <p className="ap-next-label">Recommended next step</p>
            <h2>Nothing needs you right now</h2>
            <p>ARC will bring a customer here the moment one needs a person.</p>
          </div>
        </div>
      )}

      <div className="ap-section-head">
        <h2>Last 30 days</h2>
        <span className="ap-muted">Up to {dateLabel(state.asOf, state.business.timezone)}{demo ? ' · sample data' : ''}</span>
      </div>
      <div className="ap-metrics">
        {metrics(state).map(m => (
          <article className="ap-card ap-metric" key={m.label}>
            <p>{METRIC_WORDS[m.filter] || m.label}</p>
            {m.value === null
              ? <strong><span aria-hidden="true">—</span><span className="ap-sr">not available</span></strong>
              : <strong>{m.value}</strong>}
            {m.value === null && <small>Not enough recorded yet to show this.</small>}
            <details>
              <summary>How this is counted</summary>
              <p>{m.detail} Counted over the 30 days up to the time above, from {demo ? 'sample events' : 'your recorded activity'}.</p>
              <Link to={`${base}/leads?filter=${m.filter}`}>See the leads behind this →</Link>
            </details>
          </article>
        ))}
      </div>

      <div className="ap-overview-grid">
        <Section title="Waiting on you" note={attention.length ? `${plural(attention.length, 'conversation')} ${attention.length === 1 ? 'needs' : 'need'} a person` : undefined}
          action={<Link to={`${base}/inbox`}>Open inbox →</Link>}>
          <div className="ap-card ap-list">
            {attention.map(lead => (
              <Link className="ap-list-row" key={lead.id} to={`${base}/inbox/${lead.id}`}>
                <span className="ap-avatar">{initials(lead.name)}</span>
                <span><b>{lead.name}</b><small>{lead.service || 'Has not said what they need'} · {lead.qualification}</small></span>
                <span className="ap-list-go" aria-hidden="true">→</span>
              </Link>
            ))}
            {broken.map(c => (
              <Link key={c.id} className="ap-list-row" to={`${base}/connections`}>
                <span className="ap-avatar"><Icon name="reliability" /></span>
                <span><b>{c.name}</b><small>{c.detail}</small></span>
                <Badge tone="warn">Check</Badge>
              </Link>
            ))}
            {!attention.length && !broken.length && <p className="ap-empty">Nobody is waiting on you.</p>}
          </div>
        </Section>
        <Section title="Campaigns" action={<Link to={`${base}/campaigns`}>All campaigns →</Link>}>
          <div className="ap-card ap-list">
            {state.campaigns.map(c => (
              <Link key={c.id} className="ap-list-row" to={`${base}/campaigns/${c.id}`}>
                <span><b>{c.name}</b><small>{oneLine(c)}</small></span>
                <Badge tone={stateTone(c.runtime)}>{stateLabel(c.runtime)}</Badge>
              </Link>
            ))}
            {!state.campaigns.length && <p className="ap-empty">No campaigns yet. <Link to={`${base}/campaigns/new`}>Create your first one</Link>.</p>}
          </div>
        </Section>
      </div>

      <Section title="Recent activity" action={<Link to={`${base}/leads`}>All leads →</Link>}>
        <div className="ap-card"><Timeline state={state} limit={6} /></div>
      </Section>
    </>
  );
}

function Settings({ state, dispatch, data, base, live }) {
  const [business, setBusiness] = useState(state.business), [errors, setErrors] = useState({});
  useEffect(() => setBusiness(state.business), [state.business]);
  async function save() {
    const problems = validateBusiness(business);
    setErrors(problems);
    if (!Object.keys(problems).length) await dispatch({ type: 'business', business });
  }
  return (
    <>
      <PageHead title="Settings">Your business, your hours and how ARC reaches you. Every campaign uses these.</PageHead>
      <div className="ap-card">
        <BusinessForm business={business} onChange={setBusiness} errors={errors} />
        <div className="ap-form-footer"><span /><Button primary onClick={save}>Save changes</Button></div>
      </div>
      {state.mode !== 'demo' && <OwnerAccount data={data} base={base} live={live} />}
      <Section title="More tools" note="Your reports, job records and account history.">
        <div className="ap-tool-links">{TOOLS.map(([path, label]) => <Link key={path} to={`${base}/${path}`}>{label}<span aria-hidden="true">→</span></Link>)}</div>
      </Section>
    </>
  );
}

function Billing({ state, base }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const account = state.billing;
  async function open(action) {
    setBusy(true); setError('');
    try { window.location.assign(await billingSession(state.tenantId, action)); }
    catch (failure) { setError(failure.message); setBusy(false); }
  }
  const status = String(account?.status || 'none').replaceAll('_', ' ');
  const usage = account?.available && account.period_start ? usageWarning(account.used, account.action_cap) : null;
  return (
    <>
      <PageHead title="Billing">Your ARC subscription and how many texts you have used.</PageHead>
      <div className="ap-card">
        {state.mode === 'demo' ? <Notice>This is the demo. There is nothing to pay and no billing to manage.</Notice>
          : !account?.available ? <Notice warning>Your billing details could not be loaded: {account?.error || 'please try again later'}.</Notice>
            : (
              <>
                <dl className="ap-facts">
                  <div><dt>Subscription</dt><dd><Badge tone={['active', 'trialing'].includes(account.status) ? 'good' : 'warn'}>{status === 'none' ? 'Not started' : status.replace(/^./, c => c.toUpperCase())}</Badge></dd></div>
                  <div><dt>Texts used this period</dt><dd>{account.used == null ? 'Not available' : `${account.used} of ${account.action_cap}`}</dd></div>
                  {account.period_end && <div><dt>Period ends</dt><dd>{dateLabel(account.period_end, state.business.timezone)}{account.cancel_at_period_end ? ' · cancels then' : ''}</dd></div>}
                </dl>
                {usage && <Notice warning={usage.level === 'at'}>{usage.text}</Notice>}
                <Notice>
                  New texts go out only while your subscription is active or in a trial, inside the period you have paid for. If a payment is overdue or you cancel, new texts pause and incoming inquiries still show up here. Every text ARC tries to send to a customer or to you counts once, even when delivery is uncertain. Message segments are billed separately by the messaging provider.
                </Notice>
                {error && <p role="alert" className="ap-error">{error}</p>}
                <div className="ap-actions">
                  {account.stripe_customer_id && <Button disabled={busy} onClick={() => open('portal')}>Manage billing</Button>}
                  {(!account.stripe_subscription_id || ['none', 'canceled', 'incomplete_expired'].includes(account.status)) && <Button primary disabled={busy} onClick={() => open('checkout')}>Start test checkout</Button>}
                </div>
              </>
            )}
      </div>
      <Section title="Questions about a bill?">
        <p>Your pilot fee and the jobs behind it are under <Link to={`${base}/jobs`}>job evidence</Link>. That is a record of what was counted, not an invoice.</p>
        <a className="ap-button" href={`mailto:${site.email}?subject=ARC%20subscription%20question`}>Contact billing support</a>
      </Section>
    </>
  );
}

function Help({ base }) {
  return (
    <>
      <PageHead title="Help">A person at ARC reads every message.</PageHead>
      <div className="ap-card">
        <h2>Talk to a person</h2>
        <p>Tell us your business name and what you expected to happen. Please never send a password.</p>
        <a className="ap-button ap-button--primary" href={`mailto:${site.email}`}>Email ARC support</a>
      </div>
      <Section title="Common places to look">
        <div className="ap-tool-links">
          <Link to={`${base}/setup`}>Finish or change your setup<span aria-hidden="true">→</span></Link>
          <Link to={`${base}/connections`}>How to connect your phone or website<span aria-hidden="true">→</span></Link>
          <Link to={`${base}/campaigns`}>Change what ARC says to customers<span aria-hidden="true">→</span></Link>
          <Link to={`${base}/settings`}>Reports and account tools<span aria-hidden="true">→</span></Link>
        </div>
      </Section>
    </>
  );
}

export default function PortalProduct({ data, base, live = true, onSignOut, onReload, demoAdapter, renderLegacy }) {
  const [state, setState] = useState(() => demoAdapter ? demoAdapter.initial() : productionState(data));
  const stateRef = useRef(state);
  const [notice, setNotice] = useState(''), [menu, setMenu] = useState(false), [reset, setReset] = useState(false);
  const location = useLocation(), navigate = useNavigate(), main = useRef(null);
  const route = location.pathname.slice(base.length).replace(/^\//, '');
  const legacy = LEGACY.includes(route);
  const demo = state.mode === 'demo';
  const page = [...PRIMARY, ...SECONDARY, ['setup', 'Setup']].find(([path]) => path ? route === path || route.startsWith(path + '/') : route === '')?.[1] || 'Account tools';
  useEffect(() => { if (!demoAdapter) { const next = productionState(data); stateRef.current = next; setState(next); } }, [data, demoAdapter]);
  useEffect(() => { setMenu(false); }, [location.pathname]);

  async function dispatch(action) {
    if (demoAdapter) {
      try {
        const next = demoAdapter.reduce(stateRef.current, action);
        stateRef.current = next; setState(next); demoAdapter.persist(next);
        setNotice(['saveCampaign', 'business'].includes(action.type) ? 'Saved for this demo session.' : '');
      } catch (e) { setNotice(e.message); }
      return true;
    }
    if (!stateRef.current.setupAvailable) { setNotice('Nothing was saved: setup is not available on this account yet. Please contact ARC support.'); return false; }
    try {
      setNotice('Saving…');
      if (action.type === 'business' || action.type === 'setup') {
        const current = stateRef.current;
        const business = action.business || current.business;
        const step = action.step ?? current.setupStep;
        const revision = await saveBusiness(current.tenantId, current.setupRevision, business, step);
        stateRef.current = { ...current, business, setupStep: step, setupRevision: revision };
        setState(stateRef.current);
        setNotice('Saved.');
      } else if (action.type === 'saveCampaign') {
        await saveCampaign(stateRef.current.tenantId, action.duplicate ? { ...action.campaign, id: 'draft', revision: 0 } : action.campaign);
        setNotice('Draft saved. It is not live, so nothing changes in what ARC sends.');
      } else { setNotice('That is not available on your account yet. Nothing has changed.'); return false; }
      await onReload?.();
      return true;
    } catch (error) { setNotice(`That did not save: ${error.message}`); return false; }
  }

  const props = { state, dispatch, base, onReload };
  const unread = state.leads.filter(lead => lead.unread).length;
  const item = ([path, label, icon]) => (
    <NavLink key={path} to={`${base}${path ? '/' + path : ''}`} end={path === ''} onClick={() => setMenu(false)}>
      <Icon name={icon} />{label}
      {path === 'inbox' && unread > 0 && <span className="ap-nav-count" aria-label={`${unread} unread`}>{unread}</span>}
    </NavLink>
  );
  const nav = mobile => (
    <>
      <Link className="ap-brand" to="/portal"><ArcMark size={24} /><span>arc<span className="ap-accent">.</span>portal</span></Link>
      <div className="ap-business">
        <span className="ap-avatar">{initials(state.business.name || 'A').slice(0, 1)}</span>
        <div><b>{state.business.name || 'Your business'}</b><small>{demo ? 'Demo business' : state.business.trade || 'Your workspace'}</small></div>
      </div>
      <nav aria-label={mobile ? 'Mobile portal navigation' : 'Portal navigation'}>
        {PRIMARY.map(item)}
        {settingUp(state) && <NavLink to={`${base}/setup`} onClick={() => setMenu(false)}><Icon name="check" />Finish setup<span className="ap-nav-count">{state.setupStep + 1}/{SETUP_STEPS.length}</span></NavLink>}
        <div className="ap-nav-separator" />
        {SECONDARY.map(item)}
      </nav>
      <div className="ap-sidebar-foot">
        <Link to="/">Back to ARC ↗</Link>
        {onSignOut && <Button quiet onClick={onSignOut}>Sign out</Button>}
      </div>
    </>
  );

  // Compatibility pages retain their existing working implementation and route addresses.
  if (legacy) {
    return (
      <>
        <div className="ap-compat">
          <Link to={base}>← Back to your portal</Link>
          {demo && <span>Demo - sample data; no messages are sent. Historical account tools use a separate sample archive.</span>}
        </div>
        {renderLegacy()}
      </>
    );
  }
  return (
    <div className="portal ap">
      <a className="ap-skip" href="#ap-main" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      <aside className="ap-sidebar">{nav(false)}</aside>
      <div className="ap-main">
        <header className="ap-topbar">
          <Button aria-label="Open navigation" onClick={() => setMenu(true)} className="ap-menu-button"><Icon name="menu" /></Button>
          <span>{state.business.name || 'Your business'} <span className="ap-breadcrumb">/ {page}</span></span>
        </header>
        {demo && (
          <div className="ap-demo-banner">
            <span><b>Demo</b> A made-up business with sample data; no messages are sent.</span>
            <div><Button onClick={() => setReset(true)}>Reset demo</Button><Link to="/login">Sign in →</Link></div>
          </div>
        )}
        {notice && (
          <div className="ap-feedback" role="status">
            <span>{notice}</span>
            <Button quiet aria-label="Dismiss notice" onClick={() => setNotice('')}>Dismiss</Button>
          </div>
        )}
        <main id="ap-main" ref={main} tabIndex={-1} className="ap-content">
          <Routes>
            <Route index element={<Overview {...props} />} />
            <Route path="overview" element={<Navigate replace to={base} />} />
            <Route path="setup" element={<Setup {...props} />} />
            <Route path="campaigns" element={<Campaigns {...props} />} />
            <Route path="campaigns/new" element={<CampaignBuilder key="new" {...props} />} />
            <Route path="campaigns/:id" element={<CampaignBuilder key={route} {...props} />} />
            <Route path="leads" element={<Leads {...props} />} />
            <Route path="leads/sources" element={<Sources {...props} />} />
            <Route path="inbox" element={<Inbox {...props} />} />
            <Route path="inbox/:id" element={<Inbox {...props} />} />
            <Route path="connections" element={<Connections {...props} />} />
            <Route path="settings" element={<Settings {...props} data={data} live={live} />} />
            <Route path="billing" element={<Billing state={state} base={base} />} />
            <Route path="help" element={<Help base={base} />} />
            <Route path="*" element={<Section title="Page not found"><Link to={base}>Back to Home</Link></Section>} />
          </Routes>
        </main>
      </div>
      {menu && <Dialog title="Navigation" onClose={() => setMenu(false)}>{nav(true)}</Dialog>}
      {reset && (
        <Dialog title="Reset the demo" onClose={() => setReset(false)}>
          <p>Start the demo over. Open a business that is already running, or go through setup from the beginning.</p>
          <div className="ap-actions">
            <Button primary onClick={() => { dispatch({ type: 'reset', empty: false }); setReset(false); navigate(base); }}>A business already running</Button>
            <Button onClick={() => { dispatch({ type: 'reset', empty: true }); setReset(false); navigate(`${base}/setup`); }}>Start from the beginning</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { filterLeads } from './model';
import { questionHelp } from './guide';
import { Badge, Button, Dialog, Field, Notice, PageHead, Section, dateLabel, eventLabel, initials, sourceLabel } from './ui';
import { crmApi } from '../lib/crm';
import Conversation, { Conversations } from '../components/CrmConversation';
import { getSupabase } from '../lib/supabase';

const FILTERS = [['all', 'All leads'], ['attention', 'Waiting on you'], ['eligible', 'Inquiries ARC could answer'], ['sent', 'First text sent'], ['engaged', 'Missed callers who replied'], ['qualified', 'Looks like a fit'], ['phone', 'Missed calls'], ['form', 'Website inquiries'], ['existing', 'Existing contacts'], ['suppressed', 'Opted out']];
const words = value => String(value || '').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const fitTone = fit => fit === 'Qualified' ? 'good' : fit === 'Needs Owner Review' ? 'warn' : '';
const AUTHORS = { 'ARC automation': 'ARC', 'Demo owner': 'You' };

export function Leads({ state, base }) {
  const [params, setParams] = useSearchParams(), [query, setQuery] = useState(''), [selected, setSelected] = useState(null);
  const filter = params.get('filter') || 'all';
  const rows = filterLeads(state, query, filter);
  return (
    <>
      <PageHead title="Leads" action={<Link className="ap-button" to={`${base}/leads/sources`}>Add lead source</Link>}>
        Everyone who has reached out, where they came from and what happens next.
      </PageHead>
      {state.mode !== 'demo' && !state.runtimeAvailable && <Notice warning>Some lead details could not be loaded ({state.runtimeError || 'connection failed'}), so this list may be incomplete.</Notice>}
      <div className="ap-filters">
        <Field label="Search"><input type="search" placeholder="Name, service or source" value={query} onChange={e => setQuery(e.target.value)} /></Field>
        <Field label="Show">
          <select value={filter} onChange={e => setParams(e.target.value === 'all' ? {} : { filter: e.target.value })}>
            {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <p className="ap-result-count" aria-live="polite">
          {rows.length} of {state.leads.length} shown{state.totalLeadCount > state.leads.length ? ` · ${state.totalLeadCount} in your full history` : ''}
        </p>
      </div>
      {rows.length > 0 && (
        <div className="ap-card ap-table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>What they need</th><th>Fit</th><th>Can ARC text them?</th><th><span className="ap-sr">Open</span></th></tr></thead>
            <tbody>
              {rows.map(lead => (
                <tr key={lead.id}>
                  <td><button type="button" className="ap-link-button" onClick={() => setSelected(lead)}>{lead.name}</button><small>{sourceLabel(lead.source)} · {dateLabel(lead.lastActivity, state.business.timezone)}</small></td>
                  <td>{lead.service || 'Not said yet'}<small>{lead.suppressed ? 'Opted out' : words(lead.state)}</small></td>
                  <td><Badge tone={fitTone(lead.qualification)}>{lead.qualification}</Badge></td>
                  <td>{lead.suppressed ? 'No, they opted out' : lead.permission?.evidence ? 'Yes, permission on record' : 'Not confirmed'}</td>
                  <td><Link to={`${base}/inbox/${lead.id}`}>{lead.needsOwner ? 'Needs you →' : 'Open →'}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!rows.length && (
        <div className="ap-card ap-empty">
          {state.leads.length ? 'No leads match that search.' : <>No leads yet. <Link to={`${base}/connections`}>Connect a source</Link>, then send yourself a test inquiry.</>}
        </div>
      )}
      {selected && (
        <Dialog title={selected.name} onClose={() => setSelected(null)}>
          <LeadSummary lead={selected} state={state} />
          <h3 className="ap-subheading">What has happened</h3>
          <Timeline state={state} leadId={selected.id} />
          <Link className="ap-button ap-button--primary" to={`${base}/inbox/${selected.id}`} onClick={() => setSelected(null)}>Open conversation</Link>
        </Dialog>
      )}
    </>
  );
}

export function LeadSummary({ lead, state }) {
  return (
    <>
      <dl className="ap-facts">
        <div><dt>Came from</dt><dd>{sourceLabel(lead.source)}</dd></div>
        <div><dt>Phone</dt><dd>{lead.phone || 'Not known'}</dd></div>
        <div>
          <dt>Permission to text</dt>
          <dd>{lead.permission?.evidence || 'None on record. Check before contacting them.'}{lead.permission?.capturedAt && <small>{dateLabel(lead.permission.capturedAt, state.business.timezone)}</small>}</dd>
        </div>
        <div><dt>Campaign</dt><dd>{state.campaigns.find(c => c.id === lead.campaignId)?.name || 'Not linked to one'}</dd></div>
        <div><dt>Fit</dt><dd>{lead.qualification}<small>{lead.qualificationReason}</small></dd></div>
        {Object.entries(lead.answers).map(([key, value]) => <div key={key}><dt>{questionHelp(key).title}</dt><dd>{value}<small>In their words</small></dd></div>)}
      </dl>
      {lead.booked && <Notice>You marked this as booked. That is your report, not a confirmed job or revenue.</Notice>}
    </>
  );
}

export function Timeline({ state, leadId, limit = 12 }) {
  const names = new Map(state.leads.map(lead => [lead.id, lead.name]));
  const events = state.events.filter(e => !leadId || e.leadId === leadId).slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  if (!events.length) return <p className="ap-empty">Nothing has happened yet.</p>;
  return (
    <ol className="ap-timeline">
      {events.map(e => (
        <li key={e.id}>
          <span className="ap-timeline-dot" />
          <div>
            <b>{eventLabel(e.type)}</b>{!leadId && names.get(e.leadId) && <span className="ap-timeline-who"> · {names.get(e.leadId)}</span>}
            {e.detail && <p>{e.detail}</p>}
            <small>{dateLabel(e.at, state.business.timezone)}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Messages({ lead, state }) {
  return (
    <div className="ap-messages" aria-live="polite">
      {lead.messages.map(m => (
        <div key={m.id} className={`ap-message ${m.author === 'Customer' ? 'ap-message--customer' : ''}`}>
          <p>{m.body}</p>
          <small>{m.author === 'Customer' ? lead.name.split(' ')[0] : AUTHORS[m.author] || m.author} · {dateLabel(m.at, state.business.timezone)} · {words(m.state)}</small>
        </div>
      ))}
      {!lead.messages.length && <p className="ap-empty">No messages yet.</p>}
    </div>
  );
}

function ThreadList({ rows, selected, base, empty }) {
  return (
    <aside className="ap-thread-list" aria-label="Conversations">
      {rows.map(lead => (
        <Link key={lead.id} className={lead.id === selected?.id ? 'is-selected' : ''} to={`${base}/inbox/${lead.id}`}>
          <span className="ap-avatar">{initials(lead.name)}</span>
          <span><b>{lead.name}</b><small>{lead.suppressed ? 'Opted out' : lead.messages.at(-1)?.body || words(lead.state)}</small></span>
          {lead.needsOwner ? <Badge tone="warn">Needs you</Badge> : lead.unread && <span className="ap-unread" aria-label="Unread" />}
        </Link>
      ))}
      {!rows.length && <p className="ap-empty">{empty}</p>}
    </aside>
  );
}

function ProductionInbox({ state, base, onReload }) {
  const api = useMemo(() => crmApi('crm', state.tenantId), [state.tenantId]);
  const [by, setBy] = useState(null);
  const { id } = useParams();
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const rows = state.leads.filter(lead => lead.messages.length || lead.needsOwner);
  const selected = state.leads.find(lead => lead.id === id) || rows[0];
  async function takeOver(lead) {
    setWorking(true); setError('');
    const { data, error: failure } = await getSupabase().functions.invoke('crm', {
      body: { action: 'lead-takeover', tenant_id: state.tenantId, lead_id: lead.id },
    });
    // the function's own words ("unknown action") are not an owner's: say what did and did not happen
    if (failure || !data?.ok) setError('Taking over did not work, so ARC has not stopped. Please contact ARC support.');
    else await onReload?.();
    setWorking(false);
  }
  return (
    <>
      {!state.runtimeAvailable && <Notice warning>Your conversations could not be loaded: {state.runtimeError || 'connection failed'}.</Notice>}
      <div className="ap-inbox">
        <ThreadList rows={rows} selected={selected} base={base} empty={state.runtimeAvailable ? 'No conversations yet.' : 'Nothing to show.'} />
        {selected ? (
          <section className="ap-thread">
            <header>
              <div><h2>{selected.name}</h2><p>{selected.service || 'Has not said what they need'} · {selected.qualification}</p></div>
              {!selected.ownerTakeover && !selected.suppressed && <Button disabled={working} onClick={() => takeOver(selected)}>{working ? 'Taking over…' : 'Take over'}</Button>}
            </header>
            {selected.handoffReason && <Notice warning>Handed to you: {selected.handoffReason}</Notice>}
            {selected.ownerTakeover && <Notice>You have taken this over, and ARC has stopped texting this customer. A text already on its way cannot be recalled.</Notice>}
            {!selected.ownerTakeover && !selected.suppressed && <p className="ap-muted">Taking over stops ARC’s texts to this customer so you can handle it yourself.</p>}
            <Messages lead={selected} state={state} />
            {error && <p role="alert" className="ap-error">{error}</p>}
          </section>
        ) : <section className="ap-thread"><p className="ap-empty">Pick a conversation to read it.</p></section>}
      </div>
      <Section title="Conversations from your contact list">
        <Notice>Picking up a contact here does not stop a campaign that is still texting them. Use Take over on their conversation above first.</Notice>
        {by ? (
          <>
            <Button onClick={() => setBy(null)}>← All conversations</Button>
            <Conversation api={api} by={by} timezone={state.business.timezone} businessName={state.business.name} />
          </>
        ) : <Conversations api={api} timezone={state.business.timezone} onOpenContact={contact => setBy({ contact_id: contact })} onOpenThread={thread => setBy({ conversation_id: thread })} />}
      </Section>
    </>
  );
}

const CONFIRM = {
  takeover: ['Take over this conversation?', 'ARC stops texting this customer and you reply yourself. Any check-in that was waiting is cancelled.'],
  resume: ['Hand this back to ARC?', 'ARC can carry on asking its questions. A check-in that was cancelled stays cancelled, and an opt-out or a booking still stops everything.'],
  booked: ['Mark this as booked?', 'ARC stops texting this customer. It is recorded as your report, not as a confirmed job or revenue.'],
};

export function Inbox({ state, dispatch, base, onReload }) {
  const { id } = useParams();
  const [filter, setFilter] = useState('all'), [body, setBody] = useState(''), [confirm, setConfirm] = useState(null);
  const demo = state.mode === 'demo';
  const match = (lead, tab) => tab === 'all' || tab === 'unread' && lead.unread || tab === 'attention' && lead.needsOwner;
  const rows = state.leads.filter(lead => match(lead, filter)).slice().sort((a, b) => Number(Boolean(b.unread)) - Number(Boolean(a.unread)) || b.lastActivity.localeCompare(a.lastActivity));
  const lead = state.leads.find(l => l.id === id) || rows[0];
  const campaign = lead && state.campaigns.find(c => c.id === lead.campaignId);
  const question = campaign?.questions.find(q => !lead.answers[q.key]);
  useEffect(() => setBody(''), [lead?.id]);
  const waiting = state.leads.filter(l => l.needsOwner).length;
  if (!demo) {
    return (
      <>
        <PageHead title="Inbox">Your conversations, and anything that needs a person.</PageHead>
        <ProductionInbox state={state} base={base} onReload={onReload} />
      </>
    );
  }
  const canned = { service: state.business.services.split(',')[0].trim(), location: state.business.area.split(',')[0].trim(), urgency: 'This week', timing: 'Tomorrow morning' };
  return (
    <>
      <PageHead title="Inbox">{waiting ? `${waiting} ${waiting === 1 ? 'conversation needs' : 'conversations need'} you.` : 'Nobody is waiting on you.'}</PageHead>
      <div className="ap-tabs" role="group" aria-label="Conversation filter">
        {[['all', 'All'], ['unread', 'Unread'], ['attention', 'Waiting on you']].map(([value, label]) => (
          <Button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} ({state.leads.filter(l => match(l, value)).length})</Button>
        ))}
      </div>
      <div className="ap-inbox">
        <ThreadList rows={rows} selected={lead} base={base} empty="Nothing here." />
        {lead && (
          <section className="ap-thread">
            <header>
              <div>
                <h2>{lead.name}</h2>
                <p>{sourceLabel(lead.source)} · {lead.ownerTakeover ? 'You are handling this' : campaign?.runtime === 'paused' ? 'Campaign paused' : 'ARC is handling this'}</p>
              </div>
              <div className="ap-actions">
                {lead.unread && <Button quiet onClick={() => dispatch({ type: 'read', id: lead.id })}>Mark read</Button>}
                <Button disabled={lead.suppressed || lead.booked} onClick={() => setConfirm(lead.ownerTakeover ? 'resume' : 'takeover')}>{lead.ownerTakeover ? 'Hand back to ARC' : 'Take over'}</Button>
              </div>
            </header>
            {lead.needsOwner && (
              <div className="ap-owner-summary">
                <b>Handed to you</b>
                <p>{Object.values(lead.answers).join(' · ') || 'They have not given any details yet.'}</p>
                <p>{lead.qualificationReason}</p>
              </div>
            )}
            {lead.suppressed && <Notice warning>This customer opted out. ARC will not text them again.</Notice>}
            {lead.followupStopped && !lead.suppressed && <p className="ap-muted">Check-ins are off for this customer: they replied, or you stepped in.</p>}
            <Messages lead={lead} state={state} />
            {state.lastSimulation && <Notice>{state.lastSimulation}</Notice>}
            <div className="ap-composer">
              <Field label="Your reply">
                <textarea value={body} maxLength={1600} onChange={e => setBody(e.target.value)} placeholder={lead.ownerTakeover ? 'Write a reply…' : 'Take over to reply yourself'} disabled={!lead.ownerTakeover || lead.suppressed} />
              </Field>
              <Button primary disabled={!body.trim() || !lead.ownerTakeover || lead.suppressed} onClick={() => { dispatch({ type: 'ownerReply', id: lead.id, body }); setBody(''); }}>Send reply</Button>
            </div>
            {!lead.suppressed && (
              <details className="ap-sim-controls" open={Boolean(question)}>
                <summary>Demo controls: play the customer</summary>
                <p className="ap-muted">See how ARC responds. Each button sends one pretend message from the customer.</p>
                <div className="ap-actions">
                  {question && <Button onClick={() => dispatch({ type: 'reply', id: lead.id, key: question.key, body: canned[question.key] })}>Reply: {canned[question.key]}</Button>}
                  <Button onClick={() => dispatch({ type: 'followup', id: lead.id })}>Skip ahead to the check-in</Button>
                  <Button onClick={() => dispatch({ type: 'reply', id: lead.id, body: 'STOP' })}>Reply STOP</Button>
                  <Button onClick={() => setConfirm('booked')}>Mark as booked</Button>
                </div>
              </details>
            )}
          </section>
        )}
      </div>
      {lead && (
        <Section title="About this customer">
          <div className="ap-card">
            <LeadSummary lead={lead} state={state} />
            <details><summary>What has happened</summary><Timeline state={state} leadId={lead.id} /></details>
          </div>
        </Section>
      )}
      {confirm && lead && (
        <Dialog title={CONFIRM[confirm][0]} onClose={() => setConfirm(null)}>
          <p>{CONFIRM[confirm][1]}</p>
          <Button primary onClick={() => { dispatch({ type: confirm, id: lead.id }); setConfirm(null); }}>Confirm</Button>
        </Dialog>
      )}
    </>
  );
}

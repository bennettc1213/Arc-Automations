import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { filterLeads } from './model';
import { Badge, Button, Dialog, Field, Notice, Section, dateLabel, sourceLabel } from './ui';
import { crmApi } from '../lib/crm';
import Conversation, { Conversations } from '../components/CrmConversation';

export function Leads({ state, base }) {
  const [params,setParams] = useSearchParams(), [query,setQuery] = useState(''),[selected,setSelected] = useState(null);
  const filter = params.get('filter') || 'all';
  const rows = filterLeads(state,query,filter);
  return <><div className="ap-page-intro"><div><p className="ap-eyebrow">Every inquiry, with context</p><h1>Leads</h1><p>Know where they came from and what happens next.</p></div><Link className="ap-button ap-button--primary" to={`${base}/leads/sources`}>Add lead source <span aria-hidden="true">＋</span></Link></div>
    <div className="ap-filters"><Field label="Search leads"><input type="search" placeholder="Name, service or source" value={query} onChange={e=>setQuery(e.target.value)}/></Field><Field label="Filter leads"><select value={filter} onChange={e=>setParams(e.target.value === 'all' ? {} : {filter:e.target.value})}>{[['all','All leads'],['attention','Needs owner'],['eligible','Eligible inquiries'],['sent','Response sent'],['engaged','Engaged missed callers'],['qualified','Qualified evidence'],['phone','Missed calls'],['form','Website inquiries'],['existing','Existing contacts'],['suppressed','Suppressed']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Field><p className="ap-result-count" aria-live="polite">{rows.length} of {state.leads.length} loaded records{state.totalLeadCount > state.leads.length ? ` ? ${state.totalLeadCount} in account history` : ''}</p></div>
    <div className="ap-table-wrap"><table><thead><tr><th>Contact / source</th><th>Requested service</th><th>Qualification</th><th>Eligibility</th><th>Next action</th></tr></thead><tbody>{rows.map(l => <tr key={l.id}><td><button className="ap-link-button" onClick={()=>setSelected(l)}>{l.name}</button><small>{sourceLabel(l.source)} · {dateLabel(l.lastActivity,state.business.timezone)}</small></td><td>{l.service || 'Unknown'}<small>{l.state}</small></td><td><Badge tone={l.qualification === 'Qualified' ? 'good' : ''}>{l.qualification}</Badge></td><td>{l.suppressed ? 'Suppressed' : l.permission?.evidence ? 'Inquiry permission recorded' : 'Unverified'}</td><td><Link to={`${base}/inbox/${l.id}`}>{l.needsOwner ? 'Review conversation →' : 'View conversation →'}</Link></td></tr>)}</tbody></table></div>
    {!rows.length && <Notice>{state.leads.length ? 'No leads match these filters.' : 'No inquiries yet. Set up a source, then verify a test inquiry before activating a campaign.'}</Notice>}
    {selected && <Dialog title={selected.name} onClose={()=>setSelected(null)}><LeadSummary lead={selected} state={state}/><h3 className="ap-subheading">Activity evidence</h3><Timeline state={state} leadId={selected.id}/><Link className="ap-button ap-button--primary" to={`${base}/inbox/${selected.id}`} onClick={()=>setSelected(null)}>Open conversation</Link></Dialog>}
  </>;
}
export function LeadSummary({ lead, state }) {
  return <><dl className="ap-facts"><div><dt>Source</dt><dd>{sourceLabel(lead.source)}</dd></div><div><dt>Contact</dt><dd>{lead.phone || 'Unknown'}</dd></div><div><dt>Permission evidence</dt><dd>{lead.permission?.evidence || 'Unknown. Review evidence before communicating.'}{lead.permission?.capturedAt && <small>{dateLabel(lead.permission.capturedAt,state.business.timezone)}</small>}</dd></div><div><dt>Campaign</dt><dd>{state.campaigns.find(c=>c.id===lead.campaignId)?.name || 'Unknown'}</dd></div><div><dt>Qualification</dt><dd>{lead.qualification}<small>{lead.qualificationReason}</small></dd></div>{Object.entries(lead.answers).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}<small>Supplied by contact</small></dd></div>)}</dl>{lead.booked && <Notice>Booking reported by Demo owner. This is not verified booking or revenue evidence.</Notice>}</>;
}
export function Timeline({ state, leadId }) {
  const events = state.events.filter(e=>!leadId || e.leadId===leadId).slice().sort((a,b)=>b.at.localeCompare(a.at)).slice(0,12);
  return events.length ? <ol className="ap-timeline">{events.map(e=><li key={e.id}><span className="ap-timeline-dot"/><div><b>{e.type.replaceAll('_',' ')}</b>{e.detail && <p>{e.detail}</p>}<small>{dateLabel(e.at,state.business.timezone)}{state.mode === 'demo' ? ' · sample event' : ''}</small></div></li>)}</ol> : <p className="ap-muted">No activity recorded.</p>;
}

function ProductionInbox({ state }) {
  const api = useMemo(()=>crmApi('crm',state.tenantId),[state.tenantId]);
  const [by,setBy] = useState(null);
  return <Section title="Your conversations" note="Reads and replies use the existing authenticated conversation service."><Notice>Automation takeover and resume are unavailable here until an authorized acknowledgment endpoint is connected. Assigning a conversation does not pause automation.</Notice>{by ? <><Button onClick={()=>setBy(null)}>← All conversations</Button><Conversation api={api} by={by} timezone={state.business.timezone} businessName={state.business.name}/></> : <Conversations api={api} timezone={state.business.timezone} onOpenContact={id=>setBy({contact_id:id})} onOpenThread={id=>setBy({conversation_id:id})}/>}</Section>;
}
export function Inbox({ state, dispatch, base }) {
  const { id } = useParams();
  const [filter,setFilter] = useState('all'),[body,setBody] = useState(''),[confirm,setConfirm] = useState(null);
  const rows = state.leads.filter(l=>filter === 'all' || filter === 'unread' && l.unread || filter === 'attention' && l.needsOwner).slice().sort((a,b)=>Number(Boolean(b.unread))-Number(Boolean(a.unread)) || b.lastActivity.localeCompare(a.lastActivity));
  const lead = state.leads.find(l=>l.id===id) || rows[0];
  const campaign = lead && state.campaigns.find(c=>c.id===lead.campaignId);
  const question = campaign?.questions.find(q=>!lead.answers[q.key]);
  useEffect(()=>setBody(''),[lead?.id]);
  const canned = { service: state.business.services.split(',')[0].trim(), location: state.business.area.split(',')[0].trim(), urgency: 'This week', timing: 'Tomorrow morning' };
  return <><div className="ap-page-intro"><div><p className="ap-eyebrow">Conversations that move things forward</p><h1>Inbox</h1><p>{state.mode === 'demo' ? `${state.leads.filter(l=>l.needsOwner).length} need your attention` : 'Unread messages and owner handoffs'}</p></div></div>
    {state.mode !== 'demo' ? <ProductionInbox state={state}/> : <>
    <div className="ap-tabs" role="group" aria-label="Conversation filter">{[['all','All conversations'],['unread','Unread'],['attention','Needs owner']].map(([v,l])=><Button key={v} aria-pressed={filter===v} onClick={()=>setFilter(v)}>{l} ({state.leads.filter(r=>v==='all'||v==='unread'&&r.unread||v==='attention'&&r.needsOwner).length})</Button>)}</div>
    <div className="ap-inbox"><aside className="ap-thread-list" aria-label="Conversations">{rows.map(l=><Link key={l.id} className={l.id===lead?.id ? 'is-selected' : ''} to={`${base}/inbox/${l.id}`}><span className="ap-avatar">{l.name.split(' ').map(s=>s[0]).join('')}</span><span><b>{l.name}</b><small>{l.messages.at(-1)?.body || l.state}</small></span>{l.unread && <span className="ap-unread" aria-label="Unread"/>}</Link>)}{!rows.length && <p className="ap-muted">No conversations in this queue.</p>}</aside>
    {lead && <section className="ap-thread"><header><div><h2>{lead.name}</h2><p>{sourceLabel(lead.source)} · {lead.ownerTakeover ? 'Owner is in control' : campaign?.runtime === 'paused' ? 'Campaign paused' : 'Sample automation'}</p></div><div className="ap-actions">{lead.unread && <Button onClick={()=>dispatch({type:'read',id:lead.id})}>Mark read</Button>}<Button disabled={lead.suppressed || lead.booked} onClick={()=>setConfirm(lead.ownerTakeover ? 'resume' : 'takeover')}>{lead.ownerTakeover ? 'Resume assistance' : 'Take over'}</Button></div></header>
      {lead.followupStopped && <Notice>No-response follow-ups stopped after a reply or owner action.</Notice>}
      {lead.suppressed && <Notice warning>Contact opted out. All further messages are suppressed.</Notice>}
      <div className="ap-messages" aria-live="polite">{lead.messages.map(m=><div key={m.id} className={`ap-message ${m.author==='Customer' ? 'ap-message--customer' : ''}`}><small>{m.author} · {dateLabel(m.at,state.business.timezone)}</small><p>{m.body}</p><small>{m.state} · demo</small></div>)}{!lead.messages.length && <p className="ap-muted">No messages recorded.</p>}</div>
      {lead.needsOwner && <div className="ap-owner-summary"><b>Owner handoff</b><p>{lead.name} · {Object.values(lead.answers).join(' · ') || 'Details still needed'}</p><p>{lead.qualificationReason}</p><small>Notification simulated in Inbox; no text alert was sent.</small></div>}
      {state.lastSimulation && <Notice>{state.lastSimulation}</Notice>}<div className="ap-composer"><Field label="Owner reply"><textarea value={body} maxLength={1600} onChange={e=>setBody(e.target.value)} placeholder={lead.ownerTakeover ? 'Write a sample reply…' : 'Take over to reply as the owner'} disabled={!lead.ownerTakeover || lead.suppressed}/></Field><Button primary disabled={!body.trim() || !lead.ownerTakeover || lead.suppressed} onClick={()=>{dispatch({type:'ownerReply',id:lead.id,body});setBody('');}}>Send sample reply</Button></div>
      {!lead.suppressed && <details className="ap-sim-controls" open={Boolean(question)}><summary>Simulate the customer</summary><p className="ap-muted">One answer at a time. Customer content cannot change campaign rules.</p><div className="ap-actions">{question && <Button onClick={()=>dispatch({type:'reply',id:lead.id,key:question.key,body:canned[question.key]})}>Reply: {canned[question.key]}</Button>}<Button onClick={()=>dispatch({type:'followup',id:lead.id})}>Check next follow-up</Button><Button onClick={()=>dispatch({type:'reply',id:lead.id,body:'STOP'})}>Reply STOP</Button><Button onClick={()=>setConfirm('booked')}>Report a booking</Button></div></details>}
    </section>}
    </div>{lead && <Section title="Contact context"><LeadSummary lead={lead} state={state}/><details><summary>Activity and evidence</summary><Timeline state={state} leadId={lead.id}/></details></Section>}
    {confirm && lead && <Dialog title={confirm==='takeover' ? 'Take over this conversation?' : confirm==='resume' ? 'Resume conversation assistance?' : 'Report a booking?'} onClose={()=>setConfirm(null)}><p>{confirm==='takeover' ? 'Automated sample messages pause. You can reply as the owner; pending no-response follow-ups stop.' : confirm==='resume' ? 'Permitted conversation assistance may continue. Follow-ups stopped by a reply stay stopped. Opt-outs and booking stops cannot be overridden.' : 'This owner report stops automation and stays attributed to Demo owner. It does not count as verified booking or revenue.'}</p><Button primary onClick={()=>{dispatch({type:confirm,id:lead.id});setConfirm(null);}}>Confirm sample action</Button></Dialog>}
    </>}
  </>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import Icon from '../components/Icon';
import OwnerAccount from '../pages/dash/OwnerAccount';
import { productionState } from './production';
import { metrics, validateBusiness } from './model';
import { Campaigns, CampaignBuilder } from './Campaigns';
import { Setup, Connections, BusinessForm } from './Setup';
import { Leads, Inbox, Timeline } from './LeadsInbox';
import Sources from './Sources';
import { Badge, Button, Dialog, Notice, Section, dateLabel, stateLabel } from './ui';
import { site } from '../../data/site';
import './product.css';

const PRIMARY = [['','Overview','overview'],['leads','Leads','leads'],['campaigns','Campaigns','automations'],['inbox','Inbox','bell']];
const SECONDARY = [['connections','Connections','reliability'],['settings','Business settings','account'],['billing','Billing','reports'],['help','Help','support']];
const LEGACY = ['jobs','needs-you','account','account/details','account/records','account/summary','activity','automations','reliability','reports','estimates','reviews','memberships','installs','support'];

function Overview({state,base}) {
  const attention = state.leads.filter(l=>l.needsOwner);
  const broken = state.connections.filter(c=>c.state==='needs_attention');
  return <><div className="ap-page-intro"><div><p className="ap-eyebrow">Your day, at a glance</p><h1>{state.setupComplete ? 'Keep the conversation going.' : 'Let’s get your first campaign ready.'}</h1><p>{state.setupComplete ? 'A clear view of your inquiries, follow-ups and next steps.' : 'Tell us about your business, connect a source, then test the response.'}</p></div><Link className="ap-button ap-button--primary" to={`${base}/${state.setupComplete ? 'inbox' : 'setup'}`}>{state.setupComplete ? 'Open inbox' : 'Continue setup'} <span aria-hidden="true">→</span></Link></div>
    {!state.setupComplete && <div className="ap-setup-strip"><span className="ap-setup-number">{state.setupStep+1}<small>/ 5</small></span><div><h2>Your setup is in progress</h2><p>Account created · {state.mode==='demo' ? 'sample configuration in this session' : 'client configuration saving not connected'}</p></div><Link to={`${base}/setup`}>Return to unfinished step →</Link></div>}
    <div className="ap-section-head"><h2>Results with evidence</h2><span className="ap-muted">30 days ending {dateLabel(state.asOf,state.business.timezone)}</span></div>
    <div className="ap-metrics">{metrics(state).map(m=><article key={m.label}><p>{m.label}</p><strong>{m.value === null ? '—' : m.value}</strong><small>{m.value === null ? 'Not enough data' : state.mode==='demo' ? 'From sample events' : 'From recorded events'}</small><details><summary>How this is counted</summary><p>{m.detail} Window: the 30 days ending at the timestamp above. Source: {state.mode==='demo' ? 'isolated sample event ledger' : 'authenticated event log; incomplete evidence is withheld'}.</p><Link to={`${base}/leads?filter=${m.filter}`}>View supporting records →</Link></details></article>)}</div>
    <div className="ap-overview-grid"><Section title="Needs your attention" note={attention.length ? `${attention.length} conversations need a person` : 'You’re up to date with the records available'} action={<Link to={`${base}/inbox`}>View inbox →</Link>}>
      {attention.map(l=><Link className="ap-attention-row" key={l.id} to={`${base}/inbox/${l.id}`}><span className="ap-avatar">{l.name.split(' ').map(s=>s[0]).join('')}</span><span><b>{l.name}</b><small>{l.service || 'Service not supplied'} · {l.qualification}</small></span><span aria-hidden="true">↗</span></Link>)}
      {broken.map(c=><Link key={c.id} className="ap-attention-row" to={`${base}/connections`}><Icon name="reliability"/><span><b>{c.name}</b><small>{c.detail}</small></span><Badge tone="warn">Review</Badge></Link>)}
      {!attention.length&&!broken.length&&<p className="ap-muted">No owner requests in the available records. Connection readiness is checked separately.</p>}
    </Section><Section title="Campaigns" action={<Link to={`${base}/campaigns`}>Manage →</Link>}>{state.campaigns.map(c=><Link key={c.id} className="ap-status-row" to={`${base}/campaigns/${c.id}`}><span><b>{c.name}</b><small>{c.runtime==='draft' ? 'Review and test your draft' : c.runtime==='paused' ? 'Review before resuming' : 'Sample inquiries only'}</small></span><Badge tone={c.runtime==='simulated'?'good':''}>{stateLabel(c.runtime)}</Badge></Link>)}{!state.campaigns.length&&<p className="ap-muted">No campaign configurations loaded. Choose a first campaign in setup, or inspect your <Link to={`${base}/automations`}>existing automation activity</Link>.</p>}</Section></div>
    <Section title="Recent activity" note="Accepted, sent, delivered, replied and qualified are separate events."><Timeline state={state}/></Section>
  </>;
}
function Settings({state,dispatch,data,base,live}) {
  const [business,setBusiness]=useState(state.business),[errors,setErrors]=useState({});
  return <><div className="ap-page-intro"><div><h1>Business settings</h1><p>Your business facts, working hours and owner preferences.</p></div></div>{state.mode==='demo' ? <Section title="Business details"><BusinessForm business={business} onChange={setBusiness} errors={errors}/><Button primary onClick={()=>{const e=validateBusiness(business);setErrors(e);if(!Object.keys(e).length)dispatch({type:'business',business});}}>Save sample settings</Button></Section> : <><Notice>Published settings are read from your account. Changes currently require ARC support. <Link to={`${base}/setup`}>Explore setup preview</Link>.</Notice><OwnerAccount data={data} base={base} live={live}/></>}<Section title="Account tools" note="Existing reports, job evidence and operational capabilities remain available."><div className="ap-tool-links">{[['account/records','Contact records & tasks'],['account/summary','Monthly fee evidence'],['jobs','Job evidence'],['needs-you','Outcome review'],['reports','Reports & exports'],['account/details','Account details'],['automations','Existing automations'],['activity','Activity history'],['reliability','Reliability']].map(([path,label])=><Link key={path} to={`${base}/${path}`}>{label} →</Link>)}</div></Section></>;
}
function Billing({base}) { return <><div className="ap-page-intro"><div><h1>Billing</h1><p>Your business’s ARC subscription.</p></div></div><Section title="Subscription details"><Notice>No subscription or payment-provider data is connected to this view. No price or balance is inferred.</Notice><p>Existing pilot fee evidence is available in <Link to={`${base}/jobs`}>job evidence</Link>. It is separate from invoices or payments.</p><a className="ap-button" href={`mailto:${site.email}?subject=ARC%20subscription%20question`}>Contact billing support</a></Section></>; }

export default function PortalProduct({data,base,live=true,onSignOut,onReload,demoAdapter,renderLegacy}) {
  const [state,setState]=useState(()=>demoAdapter ? demoAdapter.initial() : productionState(data));
  const stateRef=useRef(state);
  const [notice,setNotice]=useState(''),[menu,setMenu]=useState(false),[reset,setReset]=useState(false);
  const location=useLocation(),navigate=useNavigate(),main=useRef(null);
  const route=location.pathname.slice(base.length).replace(/^\//,'');
  const legacy=LEGACY.includes(route);
  const page=[...PRIMARY,...SECONDARY,['setup','Setup']].find(([path])=>path?route===path||route.startsWith(path+'/'):route==='')?.[1]||'Account tools';
  useEffect(()=>{if(!demoAdapter){const next=productionState(data);stateRef.current=next;setState(next);}},[data,demoAdapter]);
  useEffect(()=>{setMenu(false);},[location.pathname]);
  function dispatch(action) {
    if(demoAdapter){
      try { const next=demoAdapter.reduce(stateRef.current,action);stateRef.current=next;setState(next);demoAdapter.persist(next);setNotice(['saveCampaign','business'].includes(action.type)?'Sample changes saved for this page session. Nothing was sent.':''); } catch(e){setNotice(e.message);}
      return;
    }
    // Client write routes do not exist for these contracts. Keep previews in memory only.
    if(action.type==='business'){setState(s=>({...s,business:action.business}));setNotice('Business details previewed in memory. Not saved to your account.');}
    else if(action.type==='setup')setState(s=>({...s,setupStep:action.step}));
    else if(action.type==='saveCampaign'){setState(s=>({...s,campaigns:[...s.campaigns.filter(c=>c.id!==action.campaign.id),{...action.campaign,id:action.campaign.id==='draft'?`preview-${s.campaigns.length+1}`:action.campaign.id,runtime:'draft'}]}));setNotice('Client campaign saving is unavailable. Kept as an in-memory preview only; your published settings are unchanged.');}
    else setNotice('This action needs an authorized server capability. Nothing has changed.');
  }
  const props={state,dispatch,base};
  function Nav({mobile=false}) {return <><Link className="ap-brand" to="/portal"><ArcMark size={23}/><span>arc<span className="ap-accent">.</span>portal</span></Link><div className="ap-business"><span className="ap-avatar">{state.business.name?state.business.name.slice(0,1):'A'}</span><div><b>{state.business.name||'Your business'}</b><small>{state.mode==='demo'?'Sample workspace':'Client workspace'}</small></div></div><nav aria-label={mobile?'Mobile portal navigation':'Portal navigation'}>{PRIMARY.map(([path,label,icon])=><NavLink key={path} to={`${base}${path?'/'+path:''}`} end={path===''} onClick={()=>setMenu(false)}><Icon name={icon}/>{label}{path==='inbox'&&state.leads.some(l=>l.unread)&&<span className="ap-nav-count">{state.leads.filter(l=>l.unread).length}</span>}</NavLink>)}<div className="ap-nav-separator"/>{!state.setupComplete&&<NavLink to={`${base}/setup`} onClick={()=>setMenu(false)}><Icon name="check"/>Finish setup</NavLink>}{SECONDARY.map(([path,label,icon])=><NavLink key={path} to={`${base}/${path}`} onClick={()=>setMenu(false)}><Icon name={icon}/>{label}</NavLink>)}</nav><div className="ap-sidebar-foot"><span className="ap-eyebrow">Made for the workday</span><p>A little less chasing.<br/>A clearer next step.</p><Link to="/">Back to ARC ↗</Link>{onSignOut&&<Button onClick={onSignOut}>Sign out</Button>}</div></>;}
  // Compatibility pages retain their existing working implementation and route addresses.
  if(legacy) return <><div className="ap-compat"><Link to={base}>← New portal overview</Link>{state.mode==='demo'&&<span>Demo - sample data; no messages are sent. Historical account tools use a separate sample archive.</span>}</div>{renderLegacy()}</>;
  return <div className="portal ap"><a className="ap-skip" href="#ap-main" onClick={e=>{e.preventDefault();main.current?.focus();}}>Skip to content</a><aside className="ap-sidebar"><Nav/></aside><div className="ap-main"><header className="ap-topbar"><Button aria-label="Open navigation" onClick={()=>setMenu(true)} className="ap-button ap-menu-button"><Icon name="menu"/></Button><span>{state.business.name||'Your business'} <span className="ap-breadcrumb">/ {page}</span></span><div>{state.mode==='demo'?<Badge>Sample workspace</Badge>:<Badge>Authenticated account</Badge>}</div></header>
    {state.mode==='demo'&&<div className="ap-demo-banner"><span><b>Demo</b> - sample data; no messages are sent.</span><div><Button onClick={()=>setReset(true)}>Reset demo</Button><Link to="/login">Sign in →</Link></div></div>}
    {notice&&<div className="ap-feedback" role="status"><span>{notice}</span><Button aria-label="Dismiss notice" onClick={()=>setNotice('')}>Dismiss</Button></div>}
    <main id="ap-main" ref={main} tabIndex={-1} className="ap-content"><Routes>
      <Route index element={<Overview {...props}/>}/><Route path="overview" element={<Navigate replace to={base}/>}/>
      <Route path="setup" element={<Setup {...props}/>}/><Route path="campaigns" element={<Campaigns {...props}/>}/><Route path="campaigns/new" element={<CampaignBuilder key="new" {...props}/>}/><Route path="campaigns/:id" element={<CampaignBuilder key={route} {...props}/>}/>
      <Route path="leads" element={<Leads {...props}/>}/><Route path="leads/sources" element={<Sources {...props}/>}/><Route path="inbox" element={<Inbox {...props}/>}/><Route path="inbox/:id" element={<Inbox {...props}/>}/>
      <Route path="connections" element={<Connections {...props}/>}/><Route path="settings" element={<Settings {...props} data={data} live={live}/>}/><Route path="billing" element={<Billing base={base}/>}/>
      <Route path="help" element={<><div className="ap-page-intro"><h1>Help</h1></div><Section title="Talk to a person"><p>Include your business name and what you expected to happen. Never include passwords or provider credentials.</p><a className="ap-button ap-button--primary" href={`mailto:${site.email}`}>Contact ARC support</a></Section><Section title="Your setup and records"><div className="ap-tool-links"><Link to={`${base}/setup`}>Return to setup →</Link><Link to={`${base}/connections`}>Connection requirements →</Link><Link to={`${base}/settings`}>Existing account tools →</Link></div></Section></>}/>
      <Route path="*" element={<Section title="Page not found"><Link to={base}>Return to Overview</Link></Section>}/>
    </Routes></main></div>
    {menu&&<Dialog title="Navigation" onClose={()=>setMenu(false)}><Nav mobile/></Dialog>}
    {reset&&<Dialog title="Reset your demo" onClose={()=>setReset(false)}><p>Replace the sample records and discard edits in this page session. Choose a populated business or start a new account.</p><div className="ap-actions"><Button primary onClick={()=>{dispatch({type:'reset',empty:false});setReset(false);navigate(base);}}>Reset populated demo</Button><Button onClick={()=>{dispatch({type:'reset',empty:true});setReset(false);navigate(`${base}/setup`);}}>Start new-account setup</Button></div></Dialog>}
  </div>;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { blankBusiness, newCampaign, validateBusiness, validateCampaign, previewMessage, qualify, eligibility, readiness, metrics, filterLeads, followupDecision } from '../src/portal/product/model.js';
import { demoState, demoAction, readDemoSession, saveDemoSession } from '../src/portal/demo/product-demo.js';
import { productionState } from '../src/portal/product/production.js';
const store = () => { let value; return {getItem:()=>value,setItem:(_,v)=>{value=v;}}; };

test('setup validates required facts, timezone and hours',()=>{
  assert.ok(validateBusiness(blankBusiness()).name);
  assert.deepEqual(validateBusiness(demoState().business),{});
  assert.ok(validateBusiness({...demoState().business,timezone:'invalid',close:'07:00'}).timezone);
  assert.ok(validateBusiness({...demoState().business,close:'07:00'}).close);
});
test('synthetic setup resumes at its exact unfinished step without persisting arbitrary text',()=>{
  const storage=store();
  let s=demoState(true);
  s=demoAction(s,{type:'business',business:demoState().business});
  s=demoAction(s,{type:'saveCampaign',campaign:newCampaign('missed',s.tenantId)});
  s=demoAction(s,{type:'setup',step:3});
  s.leads=[{name:'Real person',phone:'+12125559999',messages:[{body:'private message'}]}];
  saveDemoSession(storage,s);
  const resumed=readDemoSession(storage);
  assert.equal(resumed.setupStep,3);
  assert.equal(resumed.business.name,'Halstead Heating & Air');
  assert.equal(resumed.campaigns.length,1);
  assert.deepEqual(resumed.leads,[]);
  assert.doesNotMatch(storage.getItem(),/Real person|12125559999|private message/);
  s.business.name='Private business';saveDemoSession(storage,s);
  assert.doesNotMatch(storage.getItem(),/Private business/);
});
test('tampered session records cannot introduce contact data, templates or URLs',()=>{
  const s=readDemoSession({getItem:()=>JSON.stringify({scenario:'new',step:99,business:{name:'Real name'},campaignKinds:['missed','http://live'],leads:[{name:'Private'}]})});
  assert.equal(s.setupStep,4);assert.equal(s.business.name,'');assert.deepEqual(s.leads,[]);assert.equal(s.campaigns.length,1);
});
test('campaign editing a running sample creates a proposed draft and preserves runtime',()=>{
  const s=demoState(),c=s.campaigns[0];
  const next=demoAction(s,{type:'saveCampaign',campaign:{...c,message:c.message+' Thank you.'}});
  assert.equal(next.campaigns[0].message,c.message);assert.equal(next.campaigns[0].runtime,'simulated');
  assert.equal(next.campaigns.at(-1).runtime,'draft');assert.equal(next.campaigns.at(-1).version,2);
  const duplicate=demoAction(s,{type:'saveCampaign',campaign:c,duplicate:true});
  assert.equal(duplicate.campaigns.at(-1).runtime,'draft');assert.equal(duplicate.campaigns.at(-1).version,1);
});
test('message previews reject missing or invented facts and require sender identity',()=>{
  const b=demoState().business,c=newCampaign();
  assert.deepEqual(validateCampaign(c,b),[]);
  assert.deepEqual(previewMessage('{{service}} {{price}}',b).missing,['service','price']);
  assert.ok(validateCampaign({...c,message:'Hello'},b).length);
  assert.ok(validateCampaign({...c,cooldown:NaN},b).length);
});
test('eligibility requires purpose-specific evidence and keeps suppression authoritative',()=>{
  const s=demoState(),c=s.campaigns[0],l={...s.leads[0],contactCount:0};
  assert.equal(eligibility(l,c,Date.parse(s.asOf)).ok,true);
  for(const change of [{permission:null},{suppressed:true},{phone:'bad'},{ownerTakeover:true},{booked:true},{contactCount:3},{deliveryFailed:true},{lastSentAt:s.asOf}]) assert.equal(eligibility({...l,...change},c,Date.parse(s.asOf)).ok,false);
  assert.equal(eligibility(l,{...c,audience:'reactivation'},Date.parse(s.asOf)).ok,false);
});
test('qualification is tied to supplied answers and uncertain or urgent cases go to the owner',()=>{
  const b=demoState().business;
  assert.equal(qualify({},b).state,'Needs Information');
  assert.equal(qualify({service:'Heating repair',location:'43215'},b).state,'Qualified');
  assert.equal(qualify({service:'Roofing',location:'43215'},b).state,'Unsupported Service');
  assert.equal(qualify({location:'99999'},b).state,'Outside Service Area');
  assert.equal(qualify({urgency:'urgent'},b).state,'Needs Owner Review');
  assert.notEqual(qualify({},b,[]).state,'Qualified');
});
test('readiness requires verified routing and never authorizes production activation',()=>{
  const s=demoState(),c=s.campaigns[0];
  assert.deepEqual(readiness(c,s),[]);
  s.connections[0].routingTested=false;assert.match(readiness(c,s).join(' '),/voicemail/);
  s.mode='production';assert.match(readiness(c,s).join(' '),/authorized server/);
});
test('demo reducer refuses a real tenant or production mode',()=>{
  assert.throws(()=>demoAction({...demoState(),tenantId:'real-tenant'},{type:'reset'}),/synthetic tenant/);
  assert.throws(()=>demoAction({...demoState(),mode:'production'},{type:'scenario'}),/synthetic tenant/);
});
test('metrics use evidence, correct median, exclusions, windows and matching drilldowns',()=>{
  const s=demoState();const m=metrics(s);
  assert.deepEqual(m.map(m=>m.value),[3,'60s',1,2]);
  for(const metric of m.filter(m=>m.filter!=='sent')) assert.equal(filterLeads(s,'',metric.filter).length,metric.value);
  s.leads[2].qualification='Qualified';s.leads[2].booked=true;
  assert.equal(metrics(s)[3].value,2);
  s.events.push({id:'old',type:'qualified',leadId:'old',at:'2025-01-01T00:00:00Z'},{id:'test',type:'qualified',leadId:'test',at:s.asOf,excluded:true});
  assert.equal(metrics(s)[3].value,2);
  const empty={...s,events:[]};assert.equal(metrics(empty)[1].value,null);
  assert.deepEqual(metrics({...empty,evidenceComplete:false}).map(m=>m.value),[null,null,null,null]);
  const duplicated=demoState();duplicated.events.push({...duplicated.events.find(e=>e.type==='eligible_inquiry'),id:'redelivery'});
  assert.equal(metrics(duplicated)[1].value,'60s');
});
test('client dashboard fetches only the selected business when a member can read two',async()=>{
  const rows={tenants:[{id:'a',name:'A',timezone:'UTC'},{id:'b',name:'B',timezone:'UTC'}],events:[{id:'event-a',tenant_id:'a'},{id:'event-b',tenant_id:'b'}],alerts:[{id:'alert-a',tenant_id:'a'},{id:'alert-b',tenant_id:'b'}]};
  let signedIn=true,queries=0;
  globalThis.__portalTestClient={auth:{getUser:async()=>({data:{user:signedIn?{email:'owner@example.invalid'}:null}})},from(table){
    queries++;let selected=rows[table];
    const q={select(){return q;},eq(k,v){selected=selected.filter(r=>r[k]===v);return q;},gte(){return q;},order(){return q;},limit(n){selected=selected.slice(0,n);return q;},range(from,to){selected=selected.slice(from,to+1);return q;},then(resolve,reject){return Promise.resolve({data:selected,error:null}).then(resolve,reject);}};return q;
  }};
  try {
    const bundled=await build({entryPoints:[new URL('../src/portal/lib/dashboard.js',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1')],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',plugins:[{name:'test-read-boundary',setup(b){
      b.onResolve({filter:/^\.\/(supabase|dashboard-data)$/},args=>({path:args.path,namespace:'test-reader'}));
      b.onLoad({filter:/.*/,namespace:'test-reader'},args=>({contents:args.path==='./supabase'?'export const getSupabase=()=>globalThis.__portalTestClient;':'export const buildDashboardData=(tenant,events,now,alerts)=>({tenant,events,alerts});',loader:'js'}));
    }}]});
    const module={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
    const result=await module.exports.getDashboardForUser();
    assert.equal(result.data.tenant.id,'a');
    assert.deepEqual(result.data.events.map(e=>e.id),['event-a']);
    assert.deepEqual(result.data.alerts.map(a=>a.id),['alert-a']);
    signedIn=false;const count=queries;
    assert.equal((await module.exports.getDashboardForUser()).signedIn,false);
    assert.equal(queries,count,'Unauthenticated read must never query tenant records');
  } finally {delete globalThis.__portalTestClient;}
});
test('an eligible missed call proceeds one answer at a time to handoff and no-response cancellation',()=>{
  let s=demoAction(demoState(),{type:'scenario',campaignId:'campaign-1',scenario:'eligible'});
  const id=s.lastLeadId;
  for(const [key,body] of [['service','Heating repair'],['location','43215'],['urgency','This week'],['timing','Tomorrow morning']]) s=demoAction(s,{type:'reply',id,key,body});
  let l=s.leads.find(l=>l.id===id);assert.equal(l.qualification,'Qualified');assert.equal(l.needsOwner,true);assert.equal(l.followupStopped,true);
  assert.ok(s.events.some(e=>e.leadId===id&&e.type==='owner_notified'));
  const before=l.messages.length;
  s=demoAction(s,{type:'takeover',id});s=demoAction(s,{type:'reply',id,body:'Please call me.'});
  l=s.leads.find(l=>l.id===id);assert.equal(l.messages.length,before+1);
  s=demoAction(s,{type:'reply',id,body:'STOP'});
  assert.throws(()=>demoAction(s,{type:'resume',id}),/cannot resume/);
  assert.throws(()=>demoAction(s,{type:'ownerReply',id,body:'Hi'}),/eligible conversation/);
});
test('follow-up rechecks replies, quiet hours, caps, suppression and pause',()=>{
  const s=demoState(),c=s.campaigns[0];
  const l={...s.leads[2],messages:[],lastSentAt:'2026-10-09T12:00:00Z',contactCount:1};
  const monday=Date.parse('2026-10-12T16:00:00Z');
  assert.equal(followupDecision(l,c,s.business,monday).ok,true);
  assert.match(followupDecision({...l,followupStopped:true},c,s.business,monday).reason,/stopped/);
  assert.match(followupDecision(l,c,s.business,Date.parse('2026-10-12T02:00:00Z')).reason,/Quiet hours/);
  assert.equal(followupDecision({...l,suppressed:true},c,s.business,monday).ok,false);
  assert.equal(followupDecision(l,{...c,runtime:'paused'},s.business,monday).ok,false);
});
test('failure and answered-call scenarios do not create a sent event',()=>{
  for(const scenario of ['answered','repeated','unknown','unavailable','failed','incomplete','blocked','duplicate','quiet']){
    const s=demoState(),next=demoAction(s,{type:'scenario',campaignId:'campaign-1',scenario});
    assert.equal(next.events.length,s.events.length);assert.equal(next.leads.length,s.leads.length);assert.ok(next.lastSimulation);
  }
});
test('owner-reported booking never becomes authoritative booking or revenue evidence',()=>{
  const s=demoAction(demoState(),{type:'booked',id:'lead-1'});
  assert.equal(s.events.at(-1).type,'owner_reported_booking');
  assert.match(s.events.at(-1).detail,/Demo owner/);
  assert.equal(s.leads[0].followupStopped,true);
});
test('production projection never fills missing fields with sample records',()=>{
  const p=productionState({tenant:{id:'tenant-a',name:'Real account',timezone:'UTC'},generatedFor:'2026-10-11T00:00:00Z',threads:[]});
  assert.deepEqual(p.leads,[]);assert.deepEqual(p.campaigns,[]);assert.deepEqual(p.connections,[]);assert.equal(p.business.services,'');
  assert.equal(p.mode,'production');assert.equal(p.tenantId,'tenant-a');
  assert.doesNotMatch(readFileSync(new URL('../src/portal/product/production.js',import.meta.url),'utf8'),/import.*demo|localStorage|sessionStorage/);
});
test('demo adapter has no production imports, fetches, billing or transport',()=>{
  const source=readFileSync(new URL('../src/portal/demo/product-demo.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\bfetch\s*\(|getSupabase|crmApi|functionUrl|XMLHttpRequest|sendBeacon|WebSocket|^import.*production/m);
});

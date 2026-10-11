import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const browser = await chromium.launch({channel:'msedge',headless:true});
const origin = process.env.PORTAL_PREVIEW_URL || 'http://127.0.0.1:5186';
mkdirSync('dist-smoke/rebuild',{recursive:true});
const errors=[],external=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin && !['data:','blob:'].includes(url.protocol)){external.push(url.origin+url.pathname);return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(origin+'/demo');
  await page.getByRole('heading',{name:'Keep the conversation going.'}).waitFor();
  for(const width of [360,768,1440]){
    await page.setViewportSize({width,height:960});
    for(const [name,path] of [['overview',''],['campaigns','/campaigns'],['builder','/campaigns/campaign-1'],['leads','/leads'],['inbox','/inbox'],['sources','/leads/sources'],['connections','/connections'],['settings','/settings'],['billing','/billing']]){
      await page.goto(origin+'/demo'+path);
      await page.locator('.ap-content').waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${name} overflows at ${width}`);
      await page.screenshot({path:`dist-smoke/rebuild/after-${name}-${width}.png`,fullPage:true});
    }
  }
  await page.setViewportSize({width:1440,height:960});
  await page.goto(origin+'/demo');
  await page.getByRole('button',{name:'Reset demo',exact:true}).click();
  await page.getByRole('button',{name:'Start new-account setup'}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByText('Please fill this in.').first().waitFor();
  await page.getByRole('button',{name:'Use fictional business details'}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Choose Missed Call Text Back'}).click();
  for(const name of ['Business phone','Business messaging']){
    const row=page.locator('.ap-connection-list article').filter({has:page.getByRole('heading',{name,exact:true})});
    await row.getByRole('button',{name:'View requirements'}).click();
    await row.getByRole('button',{name:'Simulate successful verification'}).click();
  }
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Finish sample setup'}).click();
  await page.getByRole('link',{name:'Review campaign & test'}).click();
  await page.getByRole('button',{name:'5 Review & test'}).click();
  await page.getByRole('button',{name:'Run sample scenario'}).click();
  await page.getByRole('link',{name:'Open conversation →'}).click();
  for(const answer of ['Heating repair','43215','This week','Tomorrow morning']) await page.getByRole('button',{name:`Reply: ${answer}`,exact:true}).click();
  await page.getByText('Owner handoff',{exact:true}).waitFor();
  await page.getByText('No-response follow-ups stopped after a reply or owner action.').waitFor();
  await page.getByRole('button',{name:'Take over',exact:true}).click();
  await page.getByRole('button',{name:'Confirm sample action'}).click();
  await page.getByLabel('Owner reply',{exact:true}).fill('Thanks. I will review your request.');
  await page.getByRole('button',{name:'Send sample reply'}).click();
  await page.locator('.ap-messages').getByText('Thanks. I will review your request.',{exact:true}).waitFor();
  await page.locator('.ap-sim-controls summary').click();
  await page.getByRole('button',{name:'Reply STOP',exact:true}).click();
  await page.getByText('Contact opted out. All further messages are suppressed.').waitFor();
  assert.equal(await page.getByLabel('Owner reply',{exact:true}).isDisabled(),true);
  await page.screenshot({path:'dist-smoke/rebuild/journey-complete.png',fullPage:true});
  // Import parsing and eligibility are local even if a visitor supplies a real-looking value.
  await page.getByRole('link',{name:'Leads',exact:true}).click();
  await page.getByRole('link',{name:'Add lead source'}).click();
  await page.getByRole('button',{name:'Existing contact list',exact:true}).click();
  await page.getByLabel('CSV file').setInputFiles({name:'sample.csv',mimeType:'text/csv',buffer:Buffer.from('name,phone\nMorgan,+16145550110\nDuplicate,+16145550110\nBad,wrong\n')});
  await page.getByText('1 valid · 1 duplicates in file · 1 invalid').waitFor();
  assert.equal(await page.getByRole('button',{name:'Import unavailable'}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}).includes('Morgan')),false);
  // Mobile dialog supports Escape and restores focus.
  await page.setViewportSize({width:360,height:800});
  await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('dialog',{name:'Navigation'}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await page.getByRole('button',{name:'Open navigation'}).evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(external,[],'Demo attempted external requests');
  assert.deepEqual(errors,[],'Browser errors');
  console.log('PASS: 27 responsive screenshots, setup → campaign → simulated response → qualification → handoff → takeover → opt-out; CSV preview, mobile dialog, zero external requests.');
} finally {await browser.close();}

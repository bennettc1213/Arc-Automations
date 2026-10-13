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
  await page.getByRole('button',{name:'Start from the beginning'}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByText('Please fill this in.').first().waitFor();
  await page.getByRole('button',{name:'Fill in example details'}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Choose Missed Call Text Back'}).click();
  for(const name of ['Business phone','Business messaging']){
    const row=page.locator('.ap-connection-list article').filter({has:page.getByRole('heading',{name,exact:true})});
    await row.getByRole('button',{name:'How to connect'}).click();
    await row.getByRole('button',{name:'Mark as connected'}).click();
  }
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Finish setup',exact:true}).click();
  await page.getByRole('link',{name:'Review and test your campaign'}).click();
  // an existing campaign opens on its review: what happens, the answers, what is left, the test
  await page.getByRole('heading',{name:'Here is what will happen'}).waitFor();
  await page.getByRole('button',{name:'Run a test'}).click();
  await page.getByRole('link',{name:'Open conversation →'}).click();
  for(const answer of ['Heating repair','43215','This week','Tomorrow morning']) await page.getByRole('button',{name:`Reply: ${answer}`,exact:true}).click();
  await page.getByText('Handed to you',{exact:true}).waitFor();
  await page.getByText('Check-ins are off for this customer: they replied, or you stepped in.').waitFor();
  await page.getByRole('button',{name:'Take over',exact:true}).click();
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByLabel('Your reply',{exact:true}).fill('Thanks. I will review your request.');
  await page.getByRole('button',{name:'Send reply'}).click();
  await page.locator('.ap-messages').getByText('Thanks. I will review your request.',{exact:true}).waitFor();
  await page.locator('.ap-sim-controls summary').click();
  await page.getByRole('button',{name:'Reply STOP',exact:true}).click();
  await page.getByText('This customer opted out. ARC will not text them again.').waitFor();
  assert.equal(await page.getByLabel('Your reply',{exact:true}).isDisabled(),true);
  await page.screenshot({path:'dist-smoke/rebuild/journey-complete.png',fullPage:true});
  // a new campaign is asked one question at a time, each with ARC's pick already chosen
  await page.goto(origin+'/demo/campaigns/new');
  for(const question of ['What should ARC take off your plate?','What should the first text say?','What do you need to know before you call back?','When should the first text go out?','What if they do not reply?','How often can one person hear from you?']){
    await page.getByRole('heading',{name:question}).waitFor();
    assert.ok(await page.locator('.ap-guide-main .ap-badge--rec').count()>0,`${question} offers no recommendation`);
    await page.getByRole('button',{name:'Continue',exact:true}).click();
  }
  await page.getByText('ARC’s recommended setup').waitFor();
  await page.getByRole('button',{name:'Save campaign'}).click();
  await page.getByRole('heading',{name:'Campaigns',exact:true}).waitFor();
  // Import parsing and eligibility are local even if a visitor supplies a real-looking value.
  await page.getByRole('link',{name:'Leads',exact:true}).click();
  await page.getByRole('link',{name:'Add lead source'}).click();
  await page.getByRole('button',{name:'Existing contact list',exact:true}).click();
  await page.getByLabel('CSV file').setInputFiles({name:'sample.csv',mimeType:'text/csv',buffer:Buffer.from('name,phone\nMorgan,+16145550110\nDuplicate,+16145550110\nBad,wrong\n')});
  await page.getByText('1 valid · 1 duplicates in file · 1 invalid').waitFor();
  assert.equal(await page.getByRole('button',{name:'Import not available yet'}).isDisabled(),true);
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
  console.log('PASS: 27 responsive screenshots, setup → campaign → guided campaign questions → simulated response → qualification → handoff → takeover → opt-out; CSV preview, mobile dialog, zero external requests.');
} finally {await browser.close();}

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:5187';
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  const requests=[];
  await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin){requests.push(`${u.origin}${u.pathname}`);return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();
  await page.goto(origin+'/');
  await page.mouse.move(400,400);
  await page.locator('.cursor-square').waitFor();
  const before=await page.locator('.cursor-square').getAttribute('style');
  await page.mouse.move(720,520);
  await page.waitForTimeout(200);
  const after=await page.locator('.cursor-square').getAttribute('style');
  assert.notEqual(after,before,'Homepage cursor should follow pointer');
  await page.goto(origin+'/demo?tenant_id=real-account&live=true');
  await page.getByRole('heading',{name:'Keep the conversation going.'}).waitFor();
  assert.match(await page.locator('.ap-demo-banner').innerText(),/no messages are sent/);
  for(const path of ['jobs','needs-you','account','account/details','account/records','account/summary','automations','reliability','reports','activity']){
    await page.goto(origin+'/demo/'+path);
    await page.locator('main').waitFor();
    assert.match(await page.locator('.ap-compat').innerText(),/Demo - sample data/);
  }
  assert.deepEqual(requests,[],'Demo or compatibility tools attempted a production call');
  await page.goto(origin+'/portal/dashboard?preview=1');
  await page.waitForTimeout(500);
  assert.doesNotMatch(await page.locator('body').innerText(),/Halstead|Casey Ellis|Sample workspace/,'Production auth route must not fall back to fixtures');
  assert.ok(page.url().includes('/login') || /unavailable|no portal linked/i.test(await page.locator('body').innerText()),'Unauthenticated production route stays gated');
  console.log('PASS: built demo ignores live/tenant URL flags, compatibility routes make zero external requests, production preview flag cannot bypass auth, homepage cursor tracks pointer.');
} finally {await browser.close();}

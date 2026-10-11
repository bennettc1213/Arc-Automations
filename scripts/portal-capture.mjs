import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
const phase = process.argv[2] || 'after';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
mkdirSync('dist-smoke/rebuild', { recursive: true });
try {
  for (const width of [360, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    for (const [name, route] of [['home', '/'], ['portal', '/portal'], ['demo', '/demo']]) {
      await page.goto('http://127.0.0.1:5186' + route);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `dist-smoke/rebuild/${phase}-${name}-${width}.png`, fullPage: true });
    }
    await page.close();
  }
  if (phase === 'after') {
    const page=await browser.newPage();
    for(const width of [360,768,1440]) {
      const files=['before','after'].map(p=>'data:image/png;base64,'+readFileSync(`dist-smoke/rebuild/${p}-home-${width}.png`).toString('base64'));
      const result=await page.evaluate(async urls=>{
        const images=await Promise.all(urls.map(url=>new Promise(resolve=>{const i=new Image();i.onload=()=>resolve(i);i.src=url;})));
        const dimensions=images.map(i=>[i.width,i.height]);
        if(JSON.stringify(dimensions[0])!==JSON.stringify(dimensions[1])) return {dimensions,changed:'different dimensions'};
        const data=images.map(i=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return ctx.getImageData(0,0,i.width,i.height).data;});
        let changed=0;
        for(let p=0;p<data[0].length;p+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(data[0][p+c]-data[1][p+c])))>20)changed++;
        return {dimensions:dimensions[0],changedPercent:Math.round(changed/(data[0].length/4)*10000)/100};
      },files);
      console.log(`Homepage ${width}px comparison: ${JSON.stringify(result)}`);
    }
    await page.close();
  }
} finally { await browser.close(); }
console.log(`${phase} screenshots captured at 360, 768, 1440px`);

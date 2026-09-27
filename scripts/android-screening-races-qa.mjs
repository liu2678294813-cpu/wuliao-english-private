import { chromium,expect } from '@playwright/test';
import { CRBrowserContext } from '../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js';
import {readFileSync,writeFileSync} from 'node:fs';
const initialize=CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize=function(){this._options.acceptDownloads='internal-browser-default';return initialize.call(this);};
const browser=await chromium.connectOverCDP('http://127.0.0.1:9231');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('https://localhost'));
try{
 await page.locator('.ds-rail .ds-nav button',{hasText:'筛查'}).click();
 await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible({timeout:15000});
 const frame=page.frames().find(f=>f.url().includes('/vocabulary/index.html'));
 await expect(frame.locator('main .grid button').first()).toBeVisible({timeout:15000});
 await frame.evaluate(()=>{
   window.__correctionAudit={samples:[],pending:null,running:true};
   document.addEventListener('click',e=>{if(e.target.closest('button')?.textContent.trim()==='我不会')window.__correctionAudit.pending={english:document.querySelector('main h2').textContent.trim(),shownAt:null};},true);
   const tick=()=>{const audit=window.__correctionAudit;if(!audit.running)return;const pending=audit.pending;
     if(pending){const english=document.querySelector('main h2')?.textContent.trim();
       if(english!==pending.english){audit.samples.push(performance.now()-pending.shownAt);audit.pending=null;}
       else if(pending.shownAt===null&&[...document.querySelectorAll('main button')].some(b=>b.disabled))pending.shownAt=performance.now();
     }requestAnimationFrame(tick);};requestAnimationFrame(tick);
 });
 for(let i=0;i<5;i++){const english=await frame.locator('main h2').innerText();await frame.getByRole('button',{name:'我不会',exact:true}).click();await expect(frame.locator('main h2')).not.toHaveText(english);}
 const correction=await frame.evaluate(()=>{window.__correctionAudit.running=false;return window.__correctionAudit.samples;});
 expect(correction).toHaveLength(5);expect(correction.every(ms=>ms>=990&&ms<1200)).toBe(true);
 const before=await frame.locator('main h2').innerText();
 await page.getByRole('checkbox',{name:'乱序筛查'}).check();await page.getByRole('checkbox',{name:'乱序筛查'}).uncheck();
 await expect(frame.locator('main h2')).toHaveText(before);
 const file='output/interaction-device/vocabulary-results.json';const report=JSON.parse(readFileSync(file,'utf8'));
 report.screening.correctionVisibleMs=correction;report.screening.shufflePreservesCurrentQuestion=true;
 writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({correctionVisibleMs:correction,shuffle:'passed'}));
}finally{await browser.close();}

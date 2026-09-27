import { chromium, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
// Playwright 1.57 configures desktop downloads when attaching over CDP.
// Android WebView has no download contexts. This test-only shim preserves its
// native download behavior without changing installed dependencies or app code.
import { CRBrowserContext } from '../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js';
const initializeContext=CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize=function(){this._options.acceptDownloads='internal-browser-default';return initializeContext.call(this);};

const output=resolve('output/interaction-device');mkdirSync(output,{recursive:true});
const adb=resolve('.android-sdk/platform-tools/adb.exe');
const run=(...args)=>execFileSync(adb,args,{encoding:'utf8',windowsHide:true}).trim();
const pid=run('shell','pidof','com.wuliao.english.latencyqa');
if(!/^\d+$/.test(pid))throw Error('Isolated QA app is not running');
run('forward','tcp:9231',`localabstract:webview_devtools_remote_${pid}`);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9231');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('https://localhost'));
if(!page)throw Error('QA WebView unavailable');
const resume=process.argv.includes('--resume');
const report=resume?JSON.parse(readFileSync(resolve(output,'vocabulary-results.json'),'utf8')):{device:run('shell','getprop','ro.product.model'),package:'com.wuliao.english.latencyqa',startedAt:new Date().toISOString(),errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.dismiss());
const snap=async(name)=>page.screenshot({path:resolve(output,`${name}.png`)});
const nav=async(label)=>{await page.locator('.ds-rail .ds-nav button',{hasText:label}).first().click();};
const username=`latency-${Date.now()}`;
try{
 let frame;
 if(!resume){
 await page.locator('.account-card').waitFor({timeout:30000});
 await page.locator('input[autocomplete="username"]').fill(username);
 await page.locator('input[type="password"]').nth(0).fill('isolated-test-123');
 await page.locator('input[type="password"]').nth(1).fill('isolated-test-123');
 await page.locator('.account-submit').click();await page.locator('.home-page').waitFor({timeout:30000});
 await nav('词库');await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible();
 const fixture=await page.evaluate(async(username)=>{
   const assets=await(await fetch('/vocabulary/word-assets.json')).json();
   const chunks=await Promise.all(Object.values(assets).slice(0,4).map(path=>import(path)));
   const words=chunks.flatMap(m=>m.default.entries).slice(0,1735);
   const listId=await new Promise((resolve,reject)=>{const r=indexedDB.open('KaoyanVocabDB');r.onsuccess=()=>{const db=r.result,tx=db.transaction('wordLists','readwrite');const add=tx.objectStore('wordLists').add({username,name:'隔离验收 1735 词',type:'raw',round:1,wordIds:words.map(w=>w.wordId),createdAt:Date.now()});tx.oncomplete=()=>{db.close();resolve(add.result);};tx.onabort=()=>reject(tx.error);};});
   localStorage.setItem('wuliao:vocab:last-source-list-'+username,String(listId));return{listId,words};
 },username);
 report.fixture={username,listId:fixture.listId,words:fixture.words.length};
 await nav('筛查');
 frame=page.frames().find(f=>f.url().includes('/vocabulary/index.html'));
 await frame.waitForFunction(()=>window.__wuliaoScreeningContext,null,{timeout:30000});
 await expect(frame.locator('main .grid button').first()).toBeVisible();
 await frame.evaluate((words)=>{
   const dictionary=new Map(words.map(w=>[w.english,w.chinese.replace(/^[A-L][.、]\s*/, '')]));
   window.__qa={frames:0,mismatches:[],feedback:[],events:[],running:true};
   const tick=()=>{if(!window.__qa.running)return;const english=document.querySelector('main h2')?.textContent.trim();const options=[...document.querySelectorAll('main .grid button')].map(n=>n.textContent.trim());
     if(dictionary.has(english)&&options.length){window.__qa.frames++;if(!options.includes(dictionary.get(english)))window.__qa.mismatches.push({english,options});}requestAnimationFrame(tick);};requestAnimationFrame(tick);
   document.addEventListener('click',e=>{if(!e.target.closest('main button'))return;const start=performance.now(),inputWait=start-e.timeStamp;
     requestAnimationFrame(()=>setTimeout(()=>window.__qa.feedback.push({inputWait,paintOpportunity:performance.now()-start}),0));},true);
   try{new PerformanceObserver(list=>window.__qa.events.push(...list.getEntries().filter(e=>e.name==='click').map(e=>({duration:e.duration,inputWait:e.processingStart-e.startTime,processing:e.processingEnd-e.processingStart})))).observe({type:'event',buffered:true,durationThreshold:16});}catch{}
 },fixture.words);
 const dictionary=new Map(fixture.words.map(w=>[w.english,w.chinese.replace(/^[A-L][.、]\s*/, '')]));
 const correction=[];
 for(let i=0;i<100;i++){
   const english=await frame.locator('main h2').innerText();const started=Date.now();
   if(i%20===0)await frame.getByRole('button',{name:'我不会',exact:true}).click();
   else await frame.locator('main .grid button').filter({hasText:dictionary.get(english)}).first().click();
   await expect(frame.locator('main h2')).not.toHaveText(english);
   if(i%20===0)correction.push(Date.now()-started);
   if(i%25===24)console.log(`screening ${i+1}/100`);
 }
 report.screening=await frame.evaluate(()=>{window.__qa.running=false;return window.__qa;});report.screening.correction=correction;
 expect(report.screening.mismatches).toEqual([]);await snap('screening-100');
 await nav('背诵');await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible();
 frame=page.frames().find(f=>f.url().includes('/vocabulary/memorize.html'));
 await expect(frame.locator('.word-row').first()).toBeVisible();
 const value=await frame.locator('#listSelect option').filter({hasText:'隔离验收'}).getAttribute('value');
 await frame.locator('#listSelect').selectOption(value);await expect(frame.locator('#listSummary')).toContainText('1735');
 await frame.evaluate(()=>{window.__qa={feedback:[],events:[]};document.addEventListener('click',e=>{if(!e.target.closest('.mark-button'))return;const start=performance.now();requestAnimationFrame(()=>setTimeout(()=>window.__qa.feedback.push({inputWait:start-e.timeStamp,paintOpportunity:performance.now()-start}),0));},true);
   try{new PerformanceObserver(list=>window.__qa.events.push(...list.getEntries().filter(e=>e.name==='click').map(e=>({duration:e.duration,inputWait:e.processingStart-e.startTime,processing:e.processingEnd-e.processingStart})))).observe({type:'event',durationThreshold:16});}catch{}
 });
 for(let i=0;i<60;i++){
   const button=frame.locator('.word-row:not(.masked) .mark-button').first();await button.scrollIntoViewIfNeeded();await button.click();
   if(i%10===9)await frame.locator('#viewport').evaluate(node=>{node.scrollTop+=600;node.dispatchEvent(new Event('scroll'));});
 }
 await frame.evaluate(()=>window.__wuliaoFlushVocabulary());
 report.memorize=await frame.evaluate(()=>({...window.__qa,masked:document.getElementById('maskSummary').textContent,scrollTop:document.getElementById('viewport').scrollTop}));
 expect(report.memorize.masked).toContain('60');await snap('memorize-60');
 }
 await page.reload();await page.locator('.home-page').waitFor({timeout:30000});await nav('背诵');
 await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible({timeout:15000});
 frame=page.frames().find(f=>f.url().includes('/vocabulary/memorize.html'));
 await expect(frame.locator('#maskSummary')).toContainText('60');
 expect(await frame.locator('#viewport').evaluate(n=>n.scrollTop)).toBeCloseTo(report.memorize.scrollTop,0);
 report.memorize.restartVerified=true;
 console.log('memorize 60 operations + reload passed');
 for(const key of ['screening','memorize']){
   const percentile=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]??null;
   report[key].p95PaintOpportunity=percentile(report[key].feedback.map(v=>v.paintOpportunity));
   report[key].p95EventTiming=percentile(report[key].events.map(v=>v.duration));
 }
 report.completedAt=new Date().toISOString();
 delete report.failure;
}catch(error){report.failure=error.stack;await snap('failure').catch(()=>{});throw error;}
finally{writeFileSync(resolve(output,'vocabulary-results.json'),JSON.stringify(report,null,2));await browser.close();}

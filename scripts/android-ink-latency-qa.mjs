import { chromium, expect } from '@playwright/test';
import { CRBrowserContext } from '../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openOfficialResource,navTo } from '../e2e/helpers.js';
const initialize=CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize=function(){this._options.acceptDownloads='internal-browser-default';return initialize.call(this);};
const out=resolve('output/interaction-device');mkdirSync(out,{recursive:true});
const adb=resolve('.android-sdk/platform-tools/adb.exe');
const run=(...args)=>execFileSync(adb,args,{encoding:'utf8',windowsHide:true}).trim();
const pid=run('shell','pidof','com.wuliao.english.latencyqa');
if(!/^\d+$/.test(pid))throw Error('QA app is not running');
run('forward','tcp:9231',`localabstract:webview_devtools_remote_${pid}`);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9231');
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('https://localhost'));
const cdp=await page.context().newCDPSession(page);
const report={package:'com.wuliao.english.latencyqa',startedAt:new Date().toISOString(),scenarios:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const rows=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('wuliao-english');r.onsuccess=()=>{const db=r.result,q=db.transaction('reader-ink').objectStore('reader-ink').getAll();q.onsuccess=()=>{db.close();resolve(q.result);};q.onerror=()=>reject(q.error);};}));
const stroke=async(x,y)=>{
 for(const [type,dx] of [['mousePressed',0],['mouseMoved',18],['mouseReleased',24]])await cdp.send('Input.dispatchMouseEvent',{type,x:x+dx,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1,pointerType:'pen'});
};
try{
 await openOfficialResource(page,'2007 英语（一）Text 1');
 await page.locator('.deep-paper:visible').first().scrollIntoViewIfNeeded();
 let position=await page.locator('.deep-paper:visible').first().boundingBox();
 await stroke(position.x+position.width*.25,Math.max(170,position.y+130));
 await expect.poll(async()=>(await rows()).filter(r=>r.key?.includes('deep-ink:v2:')&&JSON.parse(r.value).length).length).toBeGreaterThan(0);
 const template=(await rows()).find(r=>r.key?.includes('deep-ink:v2:')&&JSON.parse(r.value).length);
 for(const count of [100,1000,3000]){
   const countSamples=20;
   await page.evaluate(async({template,count,countSamples})=>{
     const content=document.querySelector('.deep-reader-content'),rect=content.getBoundingClientRect();
     const top=Math.max(180,rect.top+140);
     const source=JSON.parse(template.value)[0];
     const strokes=Array.from({length:count},(_,i)=>{
       const x=i<countSamples?.12+(i%5)*.10:.72+(i%25)*.008;
       const y=i<countSamples?(top-rect.top+Math.floor(i/5)*32)/rect.height:.80+(i%100)*.0015;
       const next={...source,points:Array.from({length:80},(_,j)=>({x:x+j*.00006,y,pressure:.5}))};
       delete next.coordinateSpace;delete next.deepAnchor;return next;
     });
     const record={...template,value:JSON.stringify(strokes)};
     await new Promise((resolve,reject)=>{const r=indexedDB.open('wuliao-english');r.onsuccess=()=>{const db=r.result,tx=db.transaction('reader-ink','readwrite');tx.objectStore('reader-ink').put(record);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
   },{template,count,countSamples});
   await page.reload();await page.locator('.ds-rail').waitFor({timeout:30000});
   await openOfficialResource(page,'2007 英语（一）Text 1');
   await page.locator('.deep-paper:visible').first().scrollIntoViewIfNeeded();
   await page.evaluate(()=>{
     window.__inkQA={feedback:[],events:[],armed:false};
     document.addEventListener('pointerup',e=>{if(!window.__inkQA.armed)return;window.__inkQA.armed=false;const start=performance.now();requestAnimationFrame(()=>setTimeout(()=>window.__inkQA.feedback.push({inputWait:start-e.timeStamp,paintOpportunity:performance.now()-start}),0));},true);
     try{new PerformanceObserver(list=>window.__inkQA.events.push(...list.getEntries().filter(e=>e.name==='pointerup').map(e=>({duration:e.duration,inputWait:e.processingStart-e.startTime,processing:e.processingEnd-e.processingStart})))).observe({type:'event',durationThreshold:16});}catch{}
   });
   const source=JSON.parse((await rows()).find(r=>r.id===template.id).value);
   const pixels=[];
   for(let index=0;index<countSamples;index++){
     const target=await page.evaluate(point=>{
       const rect=document.querySelector('.deep-reader-content').getBoundingClientRect();
       return{x:rect.left+point.x*rect.width,y:rect.top+point.y*rect.height};
     },source[index].points[30]);
     const alpha=()=>page.evaluate(({x,y})=>{
       let value=0;for(const canvas of document.querySelectorAll('.deep-ink-tile')){const box=canvas.getBoundingClientRect();if(x<box.left||x>=box.right||y<box.top||y>=box.bottom)continue;
         const px=Math.floor((x-box.left)/box.width*canvas.width),py=Math.floor((y-box.top)/box.height*canvas.height);
         const data=canvas.getContext('2d').getImageData(Math.max(0,px-2),Math.max(0,py-2),5,5).data;
         for(let i=3;i<data.length;i+=4)value+=data[i];}return value;
     },target);
     const before=await alpha();expect(before).toBeGreaterThan(0);
     const x=target.x-10,y=target.y-10;
     await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'pen'});
     await delay(720);
     for(const [dx,dy]of [[24,0],[24,20],[0,20],[0,0]])await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx,y:y+dy,button:'none',buttons:1,pointerType:'pen'});
     await page.evaluate(()=>{window.__inkQA.armed=true;});
     await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,pointerType:'pen'});
     await expect.poll(alpha).toBe(0);pixels.push({before,after:await alpha()});
     if(index===0||index===countSamples-1)await page.screenshot({path:resolve(out,`ink-${count}-${index+1}.png`)});
   }
   const metrics=await page.evaluate(()=>window.__inkQA);
   // Immediately write after erasing, undo that new stroke, then leave and reload.
   position=await page.locator('.deep-paper:visible').first().boundingBox();
   await stroke(position.x+position.width*.6,Math.max(170,position.y+130));
   await page.getByRole('button',{name:'撤销',exact:true}).click();
   await page.locator('.reader-header .back-button').first().click();
   await expect(page.locator('.library-page')).toBeVisible();
   const saved=(await rows()).find(r=>r.id===template.id);expect(JSON.parse(saved.value)).toHaveLength(count-countSamples);
   await page.reload();await expect.poll(async()=>(await rows()).find(r=>r.id===template.id)?.value).toBe(saved.value);
   const percentile=a=>a.sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1]??null;
   report.scenarios.push({count,samples:countSamples,pixels,metrics,p95PaintOpportunity:percentile(metrics.feedback.map(v=>v.paintOpportunity)),p95EventTiming:percentile(metrics.events.map(v=>v.duration)),restartVerified:true});
   writeFileSync(resolve(out,'ink-results.json'),JSON.stringify(report,null,2));console.log(`ink ${count}: erase/write/undo/reload passed`);
   if(count!==3000)await openOfficialResource(page,'2007 英语（一）Text 1');
 }
}catch(error){report.failure=error.stack;await page.screenshot({path:resolve(out,'ink-failure.png')}).catch(()=>{});throw error;}
finally{report.completedAt=new Date().toISOString();writeFileSync(resolve(out,'ink-results.json'),JSON.stringify(report,null,2));await browser.close();}

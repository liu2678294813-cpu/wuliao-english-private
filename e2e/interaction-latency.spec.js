import { test, expect } from '@playwright/test';
import { createAccount, navTo } from './helpers.js';

export async function seedVocabulary(page) {
  const username = await createAccount(page);
  await navTo(page,'词库');
  await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible();
  const listId = await page.evaluate(async (username) => {
    const assets = await (await fetch('/vocabulary/word-assets.json')).json();
    const chunks = await Promise.all(Object.values(assets).slice(0,4).map((path) => import(path)));
    const wordIds = chunks.flatMap((module) => module.default.entries.map((word) => word.wordId)).slice(0,1735);
    return new Promise((resolve,reject) => { const open = indexedDB.open('KaoyanVocabDB');
      open.onsuccess = () => { const db = open.result, tx = db.transaction('wordLists','readwrite');
        const add = tx.objectStore('wordLists').add({username,name:'隔离延迟验收 1735 词',type:'raw',round:1,wordIds,createdAt:Date.now()});
        tx.oncomplete = () => {db.close();resolve(add.result);}; tx.onabort = () => reject(tx.error); };open.onerror=()=>reject(open.error);
    });
  },username);
  return { username,listId };
}

test('100 real questions stay synchronized on every animation frame, including wrong answers and double taps', async ({page},info) => {
  const errors=[]; page.on('pageerror',(e)=>errors.push(e.message));
  const {listId} = await seedVocabulary(page);
  await page.goto('/vocabulary/index.html#/dashboard');
  await expect(page.getByRole('heading',{name:/仪表/})).toBeVisible();
  await page.evaluate((id)=>localStorage.setItem('wuliao:vocab:last-source-list-'+localStorage.getItem('kaoyan_vocab_current_user'),String(id)),listId);
  await page.evaluate((id)=>{location.hash=`/screening/1?sourceListId=${id}`;},listId);
  await page.waitForFunction(()=>window.__wuliaoScreeningContext, null, {timeout:15000});
  const context=await page.evaluate(()=>window.__wuliaoScreeningContext());
  expect(context.sourceWordIds.length).toBe(1735);
  await page.evaluate((words)=>{
    window.__frames={count:0,mismatches:[],running:true};
    const dictionary=new Map(words.map((word)=>[word.english,word.chinese.replace(/^[A-L][.、]\s*/, '')]));
    const check=()=>{if(!window.__frames.running)return;
      const english=document.querySelector('main h2')?.textContent.trim();
      const options=[...document.querySelectorAll('main .grid button')].map((node)=>node.textContent.trim());
      if(english&&dictionary.has(english)&&options.length){window.__frames.count++;if(!options.includes(dictionary.get(english)))window.__frames.mismatches.push({english,options});}
      requestAnimationFrame(check);};requestAnimationFrame(check);
  },context.words);
  const words=new Map(context.words.map((word)=>[word.english,word.chinese.replace(/^[A-L][.、]\s*/, '')]));
  for(let index=0;index<100;index++){
    const heading=page.locator('main h2'); const english=await heading.innerText();
    const correct=page.locator('main .grid button').filter({hasText:words.get(english)}).first();
    if(index%20===0){await page.getByRole('button',{name:'我不会',exact:true}).click();await expect(heading).toHaveText(english);}
    else await correct.evaluate((button)=>{button.click();button.click();});
    await expect(heading).not.toHaveText(english);
  }
  const frames=await page.evaluate(()=>{window.__frames.running=false;return window.__frames;});
  expect(frames.count).toBeGreaterThan(100);expect(frames.mismatches).toEqual([]);expect(errors).toEqual([]);
  await info.attach('frame-audit',{body:JSON.stringify(frames),contentType:'application/json'});
  await page.screenshot({path:info.outputPath('screening-100.png')});
});

test('1735-word list changes only the selected row and restores records plus scroll after reload',async({page},info)=>{
  const {listId}=await seedVocabulary(page);await page.goto(`/vocabulary/memorize.html?list=list:${listId}`);
  await expect(page.locator('.word-row').first()).toBeVisible();
  // Select the seeded list by its displayed label, independent of storage key spelling.
  const value=await page.locator('#listSelect option').filter({hasText:'隔离延迟验收'}).getAttribute('value');
  await page.locator('#listSelect').selectOption(value);
  await expect(page.locator('#listSummary')).toContainText('1735');
  const result=await page.evaluate(async()=>{
    const rows=[...document.querySelectorAll('.word-row')];const second=rows[1];
    for (let i=0;i<3;i++) { document.querySelectorAll('.word-row')[0].querySelector('button').click(); document.querySelectorAll('.word-row')[2].querySelector('button').click(); }
    const same=document.querySelectorAll('.word-row')[1]===second;
    await window.__wuliaoFlushVocabulary();return {same,masked:document.querySelectorAll('.word-row.masked').length};
  });
  expect(result).toEqual({same:true,masked:2});
  await page.locator('#viewport').evaluate((node)=>{node.scrollTop=1200;node.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>window.__wuliaoFlushVocabulary());await page.reload();
  await expect(page.locator('#maskSummary')).toContainText('2');
  await expect.poll(()=>page.locator('#viewport').evaluate((node)=>node.scrollTop)).toBe(1200);
  await page.screenshot({path:info.outputPath('memorize-1735.png')});
});

test('transaction abort rolls back word record and progress together; retry stays on the same question',async({page})=>{
  const {listId}=await seedVocabulary(page);
  page.on('dialog',(dialog)=>dialog.dismiss());
  await page.goto('/vocabulary/index.html#/dashboard');await expect(page.getByRole('heading',{name:/仪表/})).toBeVisible();
  await page.evaluate((id)=>{location.hash=`/screening/1?sourceListId=${id}`;},listId);
  await page.waitForFunction(()=>window.__wuliaoScreeningContext,null,{timeout:15000});
  await expect(page.locator('main .grid button').first()).toBeVisible();
  const before=await page.locator('main h2').innerText();
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='screeningSessions'){IDBObjectStore.prototype.put=original;throw new DOMException('isolated test failure','QuotaExceededError');}return original.apply(this,args);};
  });
  await page.getByRole('button',{name:'我不会',exact:true}).click();
  await expect(page.getByRole('button',{name:'我不会',exact:true})).toBeEnabled();
  await expect(page.locator('main h2')).toHaveText(before);
  const counts=await page.evaluate(()=>new Promise((resolve)=>{const r=indexedDB.open('KaoyanVocabDB');r.onsuccess=()=>{const db=r.result,tx=db.transaction(['wordRecords','screeningSessions']);const a=tx.objectStore('wordRecords').count(),b=tx.objectStore('screeningSessions').count();tx.oncomplete=()=>{db.close();resolve([a.result,b.result]);};};}));
  expect(counts).toEqual([0,0]);
  await page.getByRole('button',{name:'我不会',exact:true}).click();await expect(page.locator('main h2')).not.toHaveText(before);
});

test('auto pronunciation follows the displayed question and cancels a queued word on exit',async({page})=>{
  const {listId}=await seedVocabulary(page);
  await page.goto('/vocabulary/index.html#/dashboard');await expect(page.getByRole('heading',{name:/仪表/})).toBeVisible();
  await page.evaluate(id=>{window.__spoken=[];window.WuliaoPronunciation={speak:async word=>window.__spoken.push(word),stop(){}};localStorage.setItem('wuliao:vocabulary:auto-pronounce','true');location.hash=`/screening/1?sourceListId=${id}`;},listId);
  await expect(page.locator('main .grid button').first()).toBeVisible();
  const first=await page.locator('main h2').innerText();
  await expect.poll(()=>page.evaluate(()=>window.__spoken.at(-1))).toBe(first);
  await page.evaluate(()=>{location.hash='/dashboard';});
  await expect(page.getByRole('heading',{name:/仪表/})).toBeVisible();
  const count=await page.evaluate(()=>window.__spoken.length);
  await page.waitForTimeout(200);expect(await page.evaluate(()=>window.__spoken.length)).toBe(count);
});

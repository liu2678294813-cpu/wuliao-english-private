// Runs ONLY against the separately installed QA package, never the user's app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const appId = "com.wuliao.english.saveqa";
const adb = resolve(".android-sdk/platform-tools/adb.exe");
const output = resolve("output/save-models-20260909");
mkdirSync(output, { recursive: true });
const shell = (...args) => execFileSync(adb, args, { encoding: "utf8", windowsHide: true }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
let sequence = 0;
const pending = new Map();
const errors = [];
async function connect() {
  const pid = shell("shell", "pidof", appId).split(/\s+/)[0];
  assert.ok(/^\d+$/.test(pid), "QA app is running");
  shell("forward", "tcp:9224", `localabstract:webview_devtools_remote_${pid}`);
  let tabs;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { tabs = await (await fetch("http://127.0.0.1:9224/json")).json(); if (tabs[0]?.webSocketDebuggerUrl) break; } catch { /* WebView starts after Activity */ }
    await delay(250);
  }
  if (!tabs?.[0]?.webSocketDebuggerUrl) throw new Error("QA WebView not ready");
  ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  await send("Runtime.enable");
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function wait(expression, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function input(selector, value) {
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function openReader() {
  await evaluate(`(()=>{const card=[...document.querySelectorAll('.resource-card')].find(e=>e.textContent.includes('2007 英语（一）Text 1'));if(!card)throw Error('article card missing');card.querySelector('.resource-open').click();})()`);
  await wait("!!document.querySelector('.reader-page .deep-paper')", "reader");
}
async function draw(returnImmediately = true) {
  await evaluate(`(()=>{const paper=[...document.querySelectorAll('.deep-paper')].find(e=>e.getClientRects().length);paper.scrollIntoView({block:'start'});})()`);
  await delay(100);
  await evaluate(`(()=>{const paper=[...document.querySelectorAll('.deep-paper')].find(e=>e.getClientRects().length);const r=paper.getBoundingClientRect();const x=r.left+r.width*.2,y=Math.max(170,r.top+120);const target=document.elementFromPoint(x,y)||paper;for(const [type,dx] of [['pointerdown',0],['pointermove',24],['pointerup',48]])target.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:71,pointerType:'pen',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,pressure:.5,clientX:x+dx,clientY:y+dx/2}));${returnImmediately ? "document.querySelector('.reader-header .back-button').click();" : ""}})()`);
}
async function strokes() {
  return evaluate(`new Promise((resolve,reject)=>{const o=indexedDB.open('wuliao-english');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result;const r=db.transaction('reader-ink').objectStore('reader-ink').index('username').getAll(localStorage.getItem('kaoyan_vocab_current_user'));r.onsuccess=()=>{db.close();resolve(r.result.filter(e=>e.key.startsWith('wuliao:deep-ink:v2:')).flatMap(e=>JSON.parse(e.value)));};};})`);
}
async function screenshot(name) {
  const image = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(output, name), Buffer.from(image.data, "base64"));
}
const results = [];
try {
  await connect();
  await wait("!!document.querySelector('.account-card') || !!document.querySelector('.home-page')", "app load");
  if (await evaluate("!!document.querySelector('.account-card')")) {
    await input('input[autocomplete="username"]', `qa-save-${Date.now()}`);
    await input('.account-card input[type="password"]', "testpass123");
    await input('.account-card label:last-of-type input[type="password"]', "testpass123");
    await click(".account-submit");
    await wait("!!document.querySelector('.home-page')", "new QA account", 45000);
  }
  assert.equal(await evaluate("!!window.AndroidSecureStore && Capacitor.getPlatform()==='android'"), true);
  await evaluate("[...document.querySelectorAll('.ds-nav button')].find(e=>e.textContent.includes('精读')).click()");
  await wait("!!document.querySelector('.library-page')", "library");
  await openReader();
  let previous = await strokes();
  const initialCount = previous.length;
  for (let i = 0; i < 20; i++) {
    await draw();
    await wait("!!document.querySelector('.library-page')", "immediate return");
    const saved = await strokes();
    assert.equal(saved.length, initialCount + i + 1);
    assert.deepEqual(saved.slice(0, previous.length), previous);
    previous = saved;
    await openReader();
  }
  await wait(`(()=>{for(const canvas of document.querySelectorAll('canvas.deep-ink-tile')){const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;for(let i=3;i<data.length;i+=4)if(data[i])return true;}return false;})()`, "restored ink painted on canvas");
  await screenshot("android-reader-saved.png");
  results.push({ test: "Android pen-up + return in same task, 20 loops", passed: true, count: previous.length });
  await draw(false);
  // Hardware back uses the native back callback and host save barrier.
  shell("shell", "input", "keyevent", "4");
  await wait("!!document.querySelector('.library-page')", "hardware back");
  assert.equal((await strokes()).length, previous.length + 1);
  previous = await strokes();
  results.push({ test: "Android hardware back saves final stroke", passed: true });
  await openReader();
  await draw(false);
  shell("shell", "input", "keyevent", "3");
  await delay(600);
  shell("shell", "am", "start", "-n", `${appId}/com.wuliao.english.MainActivity`);
  assert.equal((await strokes()).length, previous.length + 1);
  previous = await strokes();
  results.push({ test: "Android background/foreground", passed: true });
  await wait("document.querySelector('.learning-save-status')?.textContent.includes('已保存')", "confirmed save");
  ws.close();
  shell("shell", "am", "force-stop", appId);
  shell("shell", "am", "start", "-n", `${appId}/com.wuliao.english.MainActivity`);
  await delay(1000);
  await connect();
  await wait("!!document.querySelector('.library-page') || !!document.querySelector('.home-page')", "cold restart", 45000);
  assert.deepEqual(await strokes(), previous);
  results.push({ test: "APK process restart restores confirmed strokes exactly", passed: true });
  await evaluate(`window.fetch=((original)=>(url,options)=>String(url).includes('api.deepseek.com/models')?Promise.resolve(new Response(JSON.stringify({data:[{id:'qa-model-a'},{id:'qa-model-b'}]}),{status:200,headers:{'Content-Type':'application/json'}})):original(url,options))(window.fetch.bind(window))`);
  await evaluate("document.querySelector('.ds-ai-api').click()");
  await wait("!!document.querySelector('.provider-settings')", "AI settings");
  await input('.provider-settings input[type="password"]', "qa-fixture-not-a-real-key");
  await click('.provider-settings .provider-actions .primary-button');
  await wait("document.querySelector('.provider-settings select[aria-label=\"选择模型\"]')?.options.length===3", "automatic model list");
  await evaluate(`(()=>{const s=document.querySelector('.provider-settings select[aria-label="选择模型"]');s.value='qa-model-b';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('.provider-settings .provider-actions .primary-button');
  await wait("document.querySelector('.provider-settings .primary-button')?.disabled===false", "model save");
  await screenshot("android-model-selector.png");
  await send("Page.reload");
  await wait("!!document.querySelector('.home-page') || !!document.querySelector('.library-page')", "reload after model save");
  await evaluate("document.querySelector('.ds-ai-api').click()");
  await wait("!!document.querySelector('.provider-model-picker input[maxlength]')", "restored settings");
  assert.equal(await evaluate("document.querySelector('.provider-model-picker input[maxlength]').value"), "qa-model-b");
  results.push({ test: "Android model listing/selection and restart persistence (mock API)", passed: true });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "android-results.json"), JSON.stringify({ appId, origin: "https://localhost", tests: results, uncaughtErrors: errors }, null, 2));
  console.log(JSON.stringify({ tests: results, uncaughtErrors: errors }));
} catch (error) {
  try { if (ws?.readyState === 1) await screenshot("android-failure.png"); } catch { /* best effort */ }
  console.error(error.message);
  process.exitCode = 1;
} finally { ws?.close(); }

import { chromium, expect } from "@playwright/test";
import { CRBrowserContext } from "../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openOfficialResource, clickStageAdvance } from "../e2e/helpers.js";

const initialize = CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize = function () { this._options.acceptDownloads = "internal-browser-default"; return initialize.call(this); };
const app = "com.wuliao.english.translationocrqa";
const out = resolve("output/translation-ocr-20260921/device"); mkdirSync(out, { recursive: true });
const adb = resolve(".android-sdk/platform-tools/adb.exe");
const run = (...args) => execFileSync(adb, args, { encoding: "utf8", windowsHide: true }).trim();
const originalInk = readFileSync("output/translation-ocr-20260921/real-samples/source-ink.json", "utf8");
run("install", "-r", resolve("output/translation-ocr-20260921/translation-ocr-qa.apk"));
// Only the dedicated QA application's data is reset, never the production app.
run("shell", "pm", "clear", app);
run("shell", "am", "start", "-W", "-n", `${app}/com.wuliao.english.MainActivity`);
const pid = run("shell", "pidof", app);
if (!/^\d+$/.test(pid)) throw new Error("Isolated QA application did not start");
run("forward", "tcp:9228", `localabstract:webview_devtools_remote_${pid}`);
await expect.poll(async () => {
  try { return (await fetch("http://127.0.0.1:9228/json/list").then(r => r.json())).some(p => p.url?.startsWith("https://localhost")); }
  catch { return false; }
}, { timeout: 15000 }).toBe(true);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
const page = browser.contexts()[0].pages().find(p => p.url().startsWith("https://localhost"));
const cdp = await page.context().newCDPSession(page);
const report = { app, device: run("shell", "getprop", "ro.product.model"), provider: "mock response; real API is evaluated separately", scenarios: [], errors: [] };
page.on("pageerror", error => report.errors.push(error.message));
const screenshot = name => writeFileSync(resolve(out, `${name}.png`), execFileSync(adb, ["exec-out", "screencap", "-p"], { windowsHide: true }));
const inkKey = "wuliao:deep-ink:v2:postgraduate-2016-text-1:passage-1:deep-translation";
async function readInk() {
  return page.evaluate(async key => {
    const db=await new Promise(ok=>{const r=indexedDB.open("wuliao-english");r.onsuccess=()=>ok(r.result)});
    const rows=await new Promise(ok=>{const r=db.transaction("reader-ink").objectStore("reader-ink").getAll();r.onsuccess=()=>ok(r.result)});db.close();
    return rows.find(r=>r.key===key)?.value;
  }, inkKey);
}
try {
  await page.locator(".account-card").waitFor({ timeout: 30000 });
  const username = `translation-ocr-qa-${Date.now()}`;
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[type="password"]').nth(0).fill("isolated-ocr-qa");
  await page.locator('input[type="password"]').nth(1).fill("isolated-ocr-qa");
  await page.locator(".account-submit").click();
  await page.locator(".home-page").waitFor({ timeout: 30000 });
  await openOfficialResource(page, "2016 英语（一）Text 1");
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(async ({username, inkKey, originalInk}) => {
    const key=Object.keys(localStorage).find(k=>k.includes("wuliao:reading-flow:"));
    const flow=JSON.parse(localStorage.getItem(key));const now=Date.now();
    for(const id of ["deep-cover","deep-first-read","deep-clean-text","deep-first-quiz"])flow.stages[id]={status:"completed",completedAt:now};
    flow.stages["deep-translation"]={status:"current",completedAt:null};flow.currentStage="deep-translation";
    flow.timedReading={phase:"done",elapsedMs:1000,startedAt:null,pausedAt:null,completedAt:now};localStorage.setItem(key,JSON.stringify(flow));
    const prefix=`wuliao:user:${encodeURIComponent(username)}:`;
    localStorage.setItem(prefix+"wuliao:writing:vision-api-config:v1",JSON.stringify({baseUrl:"https://vision.example.com/v1"}));
    localStorage.setItem(prefix+"wuliao:writing:vision-api-key","qa-placeholder");
    localStorage.setItem(prefix+"wuliao:writing:vision-model:v1","test-vision");
    const db=await new Promise(ok=>{const r=indexedDB.open("wuliao-english");r.onsuccess=()=>ok(r.result)});
    await new Promise((ok,no)=>{const tx=db.transaction("reader-ink","readwrite");tx.objectStore("reader-ink").put({id:JSON.stringify([username,inkKey]),username,key:inkKey,value:originalInk});tx.oncomplete=ok;tx.onerror=()=>no(tx.error)});db.close();
  }, { username, inkKey, originalInk });
  await page.reload(); await page.locator(".library-page").waitFor({ timeout: 30000 });
  await page.locator(".resource-card", {hasText:"2016 英语（一）Text 1"}).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  let requests=0;
  await page.route("https://vision.example.com/**", route=>{requests++;return route.fulfill({json:{choices:[{message:{content:'{"text":"这是用于校验保存流程的测试文字。","unsure":false}'}}]}})});
  const unit=page.locator("#deep-translation .translation-unit").first();
  await unit.scrollIntoViewIfNeeded();
  const before=await readInk();expect(before).toBe(originalInk);
  const height=await unit.locator(".deep-writing-lines").evaluate(el=>el.getBoundingClientRect().height);
  screenshot("before-recognition");
  await unit.getByRole("button",{name:"识别",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"笔译识别与校对"});
  await expect(dialog.locator("textarea")).toHaveValue("这是用于校验保存流程的测试文字。");
  expect(await dialog.locator("textarea").evaluate(el=>document.activeElement===el)).toBe(false);
  screenshot("recognition-dialog");
  await dialog.getByRole("button",{name:"确认保存",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await readInk()).toBe(before);
  expect(await unit.locator(".deep-writing-lines").evaluate(el=>el.getBoundingClientRect().height)).toBe(height);
  await expect(unit.getByRole("button",{name:"完成笔译",exact:true})).toBeVisible();
  screenshot("saved-original-ink");
  report.scenarios.push("recognition and confirmed save preserve all 734 original strokes and writing area height; no keyboard on opening");
  const blank=page.locator("#deep-translation .translation-unit").nth(3);
  await blank.scrollIntoViewIfNeeded();
  const box=await blank.locator(".deep-writing-lines").boundingBox();
  const send=(type,x,y)=>cdp.send("Input.dispatchMouseEvent",{type,x,y,button:type==="mouseMoved"?"none":"left",buttons:type==="mouseReleased"?0:1,clickCount:1,pointerType:"pen"});
  const x=box.x+45,y=box.y+15;
  await send("mousePressed",x,y);await send("mouseMoved",x+35,y+2);await send("mouseReleased",x+35,y+2);
  await expect.poll(async()=>JSON.parse(await readInk()).length).toBe(JSON.parse(originalInk).length+1);
  await page.getByRole("button",{name:"撤销",exact:true}).first().click();
  await expect.poll(readInk).toBe(originalInk);
  await send("mousePressed",x,y);await send("mouseMoved",x+35,y+2);await send("mouseReleased",x+35,y+2);
  await expect.poll(async()=>JSON.parse(await readInk()).length).toBe(JSON.parse(originalInk).length+1);
  await send("mousePressed",x-10,y-12);
  await new Promise(resolve=>setTimeout(resolve,760));
  for(const [px,py] of [[x+50,y-12],[x+50,y+15],[x-10,y+15],[x-10,y-12]]) await send("mouseMoved",px,py);
  await send("mouseReleased",x-10,y-12);
  await expect.poll(readInk).toBe(originalInk);
  await send("mousePressed",x+65,y);await send("mouseMoved",x+85,y+2);await send("mouseReleased",x+85,y+2);
  await expect.poll(async()=>JSON.parse(await readInk()).length).toBe(JSON.parse(originalInk).length+1);
  await page.getByRole("button",{name:"撤销",exact:true}).first().click();
  await expect.poll(readInk).toBe(originalInk);
  await blank.getByRole("button",{name:"识别",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("没有可识别");
  expect(requests).toBe(1);
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  report.scenarios.push("pen drawing, long-press lasso deletion, resumed writing and undo work after OCR; erased blank row does not call the provider");
  await page.reload();await page.locator(".library-page").waitFor({ timeout:30000 });
  await page.locator(".resource-card",{hasText:"2016 英语（一）Text 1"}).first().locator(".resource-open").click();
  await unit.scrollIntoViewIfNeeded();
  await unit.getByRole("button",{name:"查看文字",exact:true}).click();
  await expect(dialog.locator("textarea")).toHaveValue("这是用于校验保存流程的测试文字。");
  expect(await readInk()).toBe(originalInk);
  report.scenarios.push("confirmed text and original ink survive refresh");
  report.requests=requests;
  expect(report.errors).toEqual([]);
  report.passed=true;
} catch(error) { report.failure=error.message; screenshot("failure"); process.exitCode=1; }
finally {
  writeFileSync(resolve(out,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  await browser.close();
  run("shell","am","start","-n","com.wuliao.english/.MainActivity");
}

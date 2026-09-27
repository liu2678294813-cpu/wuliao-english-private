// 真机 WebView CDP 诊断入口（临时工具，不属于正式测试）。
// 用法: node scripts/probe-cdp.mjs <command>
//   ping       - 连接并打印页面信息
//   measure    - 注入探针并模拟一次 pen 笔画，输出时序
import { chromium } from "@playwright/test";

const CDP_URL = "http://127.0.0.1:9223";
const command = process.argv[2] || "ping";

const browser = await chromium.connectOverCDP(CDP_URL);
const contexts = browser.contexts();
console.log(`contexts: ${contexts.length}`);
for (const ctx of contexts) {
  for (const page of ctx.pages()) {
    console.log(`page: ${page.url().slice(0, 120)}`);
  }
}
const ctx = contexts[0];
let page = ctx.pages()[0];
if (!page) {
  page = await ctx.newPage();
  console.log("new page created (wait for load)");
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(1000);
console.log(`active page: ${page.url().slice(0, 160)}`);

if (command === "ping") {
  const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    hasReader: Boolean(document.querySelector(".deep-reader-content")),
    hasPreview: Boolean(document.querySelector(".custom-viewport-ink-preview")),
    hasTiles: document.querySelectorAll(".deep-ink-tile").length,
    androidApp: Boolean(window.isAndroidApp && window.isAndroidApp()),
  }));
  console.log(JSON.stringify(info, null, 2));
}

if (command === "measure") {
  const result = await page.evaluate(async () => {
    // ---- 探针注入（页面运行时，不修改源码）----
    const log = [];
    const push = (name, t) => { if (log.length < 30000) log.push([name, Math.round(t), log.length]); };
    const origMoveTo = CanvasRenderingContext2D.prototype.moveTo;
    const origLineTo = CanvasRenderingContext2D.prototype.lineTo;
    const origQuad = CanvasRenderingContext2D.prototype.quadraticCurveTo;
    const origStroke = CanvasRenderingContext2D.prototype.stroke;
    const origClearRect = CanvasRenderingContext2D.prototype.clearRect;
    const now = () => performance.now();
    CanvasRenderingContext2D.prototype.moveTo = function (...a) { push("moveTo", now()); return origMoveTo.apply(this, a); };
    CanvasRenderingContext2D.prototype.lineTo = function (...a) { push("lineTo", now()); return origLineTo.apply(this, a); };
    CanvasRenderingContext2D.prototype.quadraticCurveTo = function (...a) { push("quad", now()); return origQuad.apply(this, a); };
    CanvasRenderingContext2D.prototype.stroke = function (...a) { push("stroke", now()); return origStroke.apply(this, a); };
    CanvasRenderingContext2D.prototype.clearRect = function (...a) { push("clearRect", now()); return origClearRect.apply(this, a); };
    // rAF 帧记录
    const frames = [];
    let rafId = 0;
    const tick = () => { frames.push(performance.now()); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    // 长任务
    const longTasks = [];
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ dur: Math.round(entry.duration), start: Math.round(entry.startTime) });
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch { /* ignore */ }
    // 事件时间戳
    const pointerEvents = [];
    const capturePointer = (type) => {
      addEventListener(type, (e) => pointerEvents.push([type, Math.round(performance.now()), e.pointerType]), { capture: true });
    };
    ["pointerdown", "pointermove", "pointerup"].forEach(capturePointer);

    await new Promise((r) => setTimeout(r, 200));
    const baseline = { frames: frames.length, log: log.length };
    return { baseline, started: true };
  });
  console.log("probe installed:", JSON.stringify(result));
}

await browser.close();

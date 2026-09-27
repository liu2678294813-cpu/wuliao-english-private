// 真机 WebView 笔迹时序探针（临时工具）：注入运行时 monkey-patch + 模拟 pen stroke，
// 输出 出墨延迟 / pen-up handoff 时序 / 帧间隔 / 长任务。
const expr = `
(async () => {
  const out = { canvas: [], frames: [], events: [], longTasks: [], penUp: null };
  const now = () => performance.now();
  const push = (name, t) => { if (out.canvas.length < 40000) out.canvas.push([name, Math.round(t)]); };
  const proto = CanvasRenderingContext2D.prototype;
  const wrap = (name, fn) => { const orig = proto[name]; proto[name] = function (...a) { push(name, now()); return orig.apply(this, a); }; };
  ["moveTo", "lineTo", "quadraticCurveTo", "stroke", "clearRect", "fillRect", "beginPath", "arc"].forEach(wrap);

  // 帧记录（从注入后开始）
  let rafId = 0;
  const tick = () => { out.frames.push(Math.round(performance.now())); rafId = requestAnimationFrame(tick); };
  rafId = requestAnimationFrame(tick);
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) out.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {}

  // 在正文内取一个书写点（避开 UI 按钮）
  const content = document.querySelector(".deep-reader-content");
  const rect = content.getBoundingClientRect();
  const x0 = rect.left + rect.width * 0.35;
  const y0 = rect.top + rect.height * 0.3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const mk = (type, x, y) => {
    const e = new PointerEvent(type, {
      pointerId: 7, pointerType: "pen", isPrimary: true,
      clientX: x, clientY: y, pressure: 0.5, button: 0, buttons: 1,
      bubbles: true, cancelable: true,
    });
    return e;
  };

  const target = content;
  const t0 = now();
  target.dispatchEvent(mk("pointerdown", x0, y0));
  await sleep(40);
  for (let i = 1; i <= 6; i += 1) {
    target.dispatchEvent(mk("pointermove", x0 + i * 12, y0 + i * 5));
    await sleep(33); // ~30fps 书写节奏
  }
  await sleep(40);
  const upAt = now();
  target.dispatchEvent(mk("pointerup", x0 + 6 * 12, y0 + 6 * 5));
  await sleep(120);

  const finish = now();
  cancelAnimationFrame(rafId);

  // ---- 分析 ----
  const firstDraw = out.canvas.find(([n]) => n === "moveTo" || n === "quadraticCurveTo");
  const lastPreviewDraw = out.canvas.find(([n]) => n === "stroke");
  const clearIdx = out.canvas.findIndex(([n]) => n === "clearRect");
  const lastDrawIdx = out.canvas.length - 1;
  const drawsAfterUp = out.canvas.slice(out.canvas.findIndex(([, t]) => t >= upAt));
  const frameGaps = [];
  for (let i = 1; i < out.frames.length; i += 1) frameGaps.push(out.frames[i] - out.frames[i - 1]);

  return {
    noteMode: content.classList.contains("note-mode"),
    rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
    firstInkDrawMsAfterFirstMove: firstDraw ? Math.round(firstDraw[1] - (t0 + 40)) : null,
    lastStrokeBeforeUpMs: lastPreviewDraw ? Math.round(upAt - lastPreviewDraw[1]) : null,
    clearRectMsAfterUp: clearIdx >= 0 ? Math.round(out.canvas[clearIdx][1] - upAt) : null,
    canvasCommands: out.canvas.length,
    drawsAfterUpCount: drawsAfterUp.length,
    frameGapsMs: frameGaps.slice(-12),
    longTasks: out.longTasks.slice(-6),
    eventCount: out.events.length,
  };
})()`;
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./probe-expr-tmp.js", import.meta.url), expr, "utf8");
console.log("expr written");

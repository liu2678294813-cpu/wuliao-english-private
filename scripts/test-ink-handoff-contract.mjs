// X1.2 笔迹渲染时序专项 contract（对应"抬笔粗→细闪变 / 书写延迟 / 阶段切换闪屏"修复）。
// 覆盖：
//  13.1 pen handoff：finalize preview → incrementalCommit → 同一事务 previewClear（无重叠帧）
//  13.2 无 blank fallback：commitAppendStroke 不可确认时走 renderCommitted fallback，不丢笔
//  13.4 geometry refresh：一次 pen-up 仅 1 次强制 fresh snapshot，tile window 事务内复用
//  13.5 stage transition：layout 阶段（paint 前）同步重绘 committed；tile backing 仅在几何变化时重置
// 方式：手动 rAF 队列 + 记录型 canvas + 源码契约断言，生产代码零修改。
// 依赖浏览器帧级视觉的断言不在此伪造（真机录像验收）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------- 可控 rAF ----------------

const rafState = { queue: new Map(), next: 1 };
globalThis.requestAnimationFrame = (cb) => {
  const id = rafState.next += 1;
  rafState.queue.set(id, cb);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { rafState.queue.delete(id); };
function flushRaf() {
  const cbs = [...rafState.queue.values()];
  rafState.queue.clear();
  for (const cb of cbs) cb();
}
function pendingRafCount() {
  return rafState.queue.size;
}

// ---------------- 记录型 canvas / DOM ----------------

class FakeElement {
  constructor(rect = { left: 10, top: 20, width: 500, height: 800 }) {
    this.rect = rect;
  }
  closest() { return null; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture() {}
  releasePointerCapture() {}
  contains() { return true; }
}

function recordingContext() {
  const commands = [];
  const context = new Proxy({}, {
    get: (target, prop) => {
      if (prop === "commands") return commands;
      if (!(prop in target)) {
        target[prop] = typeof prop === "string" ? (...args) => commands.push([prop, ...args]) : undefined;
      }
      return target[prop];
    },
    set: (target, prop, value) => { target[prop] = value; return true; },
  });
  return context;
}

function fakeCanvas(context) {
  return {
    dataset: { ratio: "1" },
    style: {},
    width: 500,
    height: 800,
    clientWidth: 500,
    clientHeight: 800,
    getContext: () => context,
    remove: () => {},
  };
}

function pointerEvent(type, x, y, { pointerType = "pen", pressure = 0.5, pointerId = 1 } = {}) {
  return {
    type, pointerType, pointerId, button: 0, clientX: x, clientY: y, pressure,
    nativeEvent: { pointerType, clientX: x, clientY: y, pressure, getCoalescedEvents: () => [] },
    target: new FakeElement(),
    preventDefault() {},
  };
}

if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = {};
if (typeof globalThis.Element === "undefined") globalThis.Element = class Element {};

// ---------------- 13.1：pen-up 重叠窗口（同一事务清 preview） ----------------

test("13.1 pen handoff：同步确认后同一事务清 preview（无重叠帧）", async () => {
  rafState.queue.clear();
  const previewCommands = recordingContext();
  const committedCommands = recordingContext();
  const events = [];
  const contentRef = { current: new FakeElement() };
  const previewCanvasRef = { current: fakeCanvas(previewCommands) };
  const strokesRef = { current: [] };
  const activeRef = { current: null };
  const toolRef = { current: "pen" };
  const colorRef = { current: "#173a62" };
  const penSizeRef = { current: 2.6 };
  const penModeRef = { current: "ballpoint" };
  const eraserModeRef = { current: "normal" };
  const eraserSizeRef = { current: 24 };
  const { createInkRuntimeController } = await import("../src/ink/inkRuntime.js");
  const controller = createInkRuntimeController({
    canInteract: () => true,
    surfaceRef: contentRef,
    previewCanvasRef,
    strokesRef,
    activeRef,
    toolRef,
    colorRef,
    penSizeRef,
    penModeRef,
    eraserModeRef,
    eraserSizeRef,
    commitAppendStroke: () => {
      events.push("commitAppendStroke");
      // 模拟 CustomDeepReader.appendStrokeToTiles：同步绘制 committed tile。
      committedCommands.beginPath();
      committedCommands.stroke();
      return true;
    },
    renderCommitted: () => true,
    persistStrokes: () => { events.push("persistStrokes"); },
    engineForPen: () => true,
  });

  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  for (let i = 1; i <= 4; i += 1) controller.handlePointerMove(pointerEvent("pointermove", 50 + i * 10, 60 + i * 5));
  flushRaf(); // 帧 N：preview 已画
  assert.equal(
    previewCommands.commands.some(([name]) => name === "moveTo" || name === "quadraticCurveTo" || name === "lineTo"),
    true,
    "preview 应在书写后包含轨迹命令",
  );

  events.length = 0;
  const commandsAtUp = previewCommands.commands.length;
  controller.handlePointerUp(pointerEvent("pointerup", 100, 85)); // pointerup 同步事务

  // 契约：committed 同步提交后，preview 在同一事务内立即清空。
  assert.ok(events.includes("commitAppendStroke"), "committed 已在 pointerup 事务内同步提交");
  assert.equal(committedCommands.commands.length > 0, true, "committed canvas 已同步绘制");
  const newCommandsAtUp = previewCommands.commands.slice(commandsAtUp);
  assert.equal(
    newCommandsAtUp.some(([name]) => name === "clearRect"),
    true,
    "preview 在 pointerup 同步事务内即被清空（同一事务 clear）",
  );
  assert.equal(pendingRafCount(), 0, "不再把 previewClear 推迟到下一 rAF");

  flushRaf();
  const clearIndex = previewCommands.commands.findIndex(([name], index) => index >= commandsAtUp && name === "clearRect");
  assert.ok(clearIndex >= 0, "pointerup 同步事务内出现 clearRect（preview 同事务清空）");
  const afterClear = previewCommands.commands.slice(clearIndex + 1);
  assert.ok(
    !afterClear.some(([name]) => name === "moveTo" || name === "quadraticCurveTo" || name === "lineTo"),
    "clearRect 之后无任何新的 preview 绘制命令（无 preview+committed 同帧叠加窗口）",
  );
});

test("13.2 无 blank fallback：append 不可确认时走 renderCommitted fallback", async () => {
  rafState.queue.clear();
  const previewCommands = recordingContext();
  const fallbackCalls = [];
  const contentRef = { current: new FakeElement() };
  const previewCanvasRef = { current: fakeCanvas(previewCommands) };
  const strokesRef = { current: [] };
  const activeRef = { current: null };
  const toolRef = { current: "pen" };
  const colorRef = { current: "#173a62" };
  const penSizeRef = { current: 2.6 };
  const penModeRef = { current: "ballpoint" };
  const eraserModeRef = { current: "normal" };
  const eraserSizeRef = { current: 24 };
  const { createInkRuntimeController } = await import("../src/ink/inkRuntime.js");
  const controller = createInkRuntimeController({
    canInteract: () => true,
    surfaceRef: contentRef,
    previewCanvasRef,
    strokesRef,
    activeRef,
    toolRef,
    colorRef,
    penSizeRef,
    penModeRef,
    eraserModeRef,
    eraserSizeRef,
    commitAppendStroke: () => false,
    renderCommitted: (stroke = null) => { fallbackCalls.push(stroke ? "targeted" : "full"); return true; },
    persistStrokes: () => {},
    engineForPen: () => true,
  });
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 76));
  controller.handlePointerUp(pointerEvent("pointerup", 100, 85));
  assert.deepEqual(fallbackCalls, ["targeted"], "append 未确认时先同步 committed fallback");
  flushRaf();
  assert.equal(
    previewCommands.commands.some(([name]) => name === "clearRect"),
    true,
    "fallback 成功同步绘制后 preview 仍被清除（不残留、不空白）",
  );
});

// ---------------- 13.4：geometry refresh 去重 ----------------

test("13.4a 一次 snapshot 的 DOM read 成本（content rect + 每个 region rect）", async () => {
  const { buildDeepInkRegionSnapshot } = await import("../src/deepInkGeometry.js");
  let contentReads = 0;
  let regionReads = 0;
  let scans = 0;
  const regionEls = Array.from({ length: 24 }, (_, index) => ({
    id: `region-${index}`,
    dataset: { sentenceScope: `p1:s${index}` },
    getBoundingClientRect() { regionReads += 1; return { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }; },
    matches: () => true,
    closest: () => null,
  }));
  const contentEl = {
    getBoundingClientRect() { contentReads += 1; return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }; },
    querySelectorAll() { scans += 1; return regionEls; },
  };
  const snapshot = buildDeepInkRegionSnapshot(contentEl);
  assert.ok(snapshot.regions.length > 0);
  assert.equal(contentReads, 1, "一次 snapshot = 1 次 content getBoundingClientRect");
  assert.equal(regionReads, regionEls.length, "一次 snapshot = 每个 region 1 次 getBoundingClientRect");
  assert.equal(scans, 2, "一次 snapshot = 2 次 querySelectorAll（local + stage）");
});

test("13.4b 一次 pen-up 仅 1 次 fresh snapshot，tile window 事务内复用", () => {
  const reader = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
  const geometry = readFileSync(new URL("../src/deepInkGeometry.js", import.meta.url), "utf8");

  // 1) 实际会话锁定起笔快照；无会话的旧调用仍即时获取几何。
  assert.match(geometry, /beginStroke\(active\)[\s\S]{0,120}refreshSnapshot\?\.\(\)/, "起笔获取 snapshot");
  assert.match(geometry, /captured \|\| refreshSnapshot\?\.\(\)/, "优先使用采样时的 snapshot");
  // 2) currentInkTileWindow 仅兜底刷新（不再每次全量扫描）
  const tileWindowBody = reader.slice(reader.indexOf("function currentInkTileWindow"), reader.indexOf("function tileHeightFor"));
  assert.match(tileWindowBody, /if \(!inkGeometrySnapshotRef\.current\) refreshInkGeometrySnapshot\(\)/, "tileWindow 仅 null 时兜底刷新");
  assert.doesNotMatch(tileWindowBody, /\n\s+refreshInkGeometrySnapshot\(\);\n/, "tileWindow 不再无条件强制刷新");
  // 3) appendStrokeToTiles 计算一次 info 后把 syncInkTiles 的第二次计算复用掉
  const appendBody = reader.slice(reader.indexOf("function appendStrokeToTiles"), reader.indexOf("function renderCommittedInk"));
  assert.match(appendBody, /const info = currentInkTileWindow\(\)/, "appendStrokeToTiles 计算一次 tile window");
  assert.match(appendBody, /syncInkTiles\(false, info\)/, "syncInkTiles 复用同一事务的 info");
  // 4) syncInkTiles 支持 infoOverride，其他调用点不受影响
  const syncBody = reader.slice(reader.indexOf("function syncInkTiles"), reader.indexOf("function redrawTilesForStroke"));
  assert.match(syncBody, /infoOverride \|\| currentInkTileWindow\(\)/, "syncInkTiles 支持 infoOverride 复用");
  // => 一次 pen-up：finalize(1 次 fresh) + append 内 1 次轻量 rect 计算，无重复全量扫描
});

// ---------------- 13.5：stage transition 重绘时机与 identity ----------------

test("13.5a 阶段切换在 layout 阶段同步重绘 committed（paint 前完成）", () => {
  const reader = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
  const switchBody = reader.slice(reader.indexOf("function switchInkStage"), reader.indexOf("function changeViewedStage"));
  assert.match(switchBody, /inkStageRenderPendingRef\.current = true/, "switchInkStage 不再直接 rAF 调度");
  assert.doesNotMatch(switchBody, /scheduleCommittedInkRender\(\)/, "阶段切换路径不再使用 rAF 延后重绘");
  // useLayoutEffect 在 inkStageId 变化时同步刷新 geometry 并重绘（React commit 后、paint 前）
  assert.match(
    reader,
    /useLayoutEffect\(\(\) => \{[\s\S]{0,300}inkStageRenderPendingRef[\s\S]{0,300}refreshInkGeometrySnapshot\(\)[\s\S]{0,200}renderCommittedInk\(\)[\s\S]{0,100}\}, \[inkStageId\]\)/,
    "layout 阶段同步重绘 committed",
  );
});

test("13.5b 阶段切换不 remount ink 层；tile backing 仅在几何变化时重置", () => {
  const reader = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
  // 1) 阶段 id 不参与任何 key=，committed layer / preview canvas 保持稳定 identity
  const mainKeyBody = reader.slice(reader.indexOf("<main"), reader.indexOf("onPointerDownCapture"));
  assert.doesNotMatch(mainKeyBody, /key=\{(activeStage|flowCurrentStage|inkStageId)\}/, "正文 main 不因阶段变化 remount");
  assert.match(mainKeyBody, /key=\{passage\.id\}/, "main 只在 passage 变化时 remount（既有契约）");
  // 2) syncInkTiles 仅在 geometryChanged 时重置 canvas backing size（width/height）
  const syncBody = reader.slice(reader.indexOf("function syncInkTiles"), reader.indexOf("function redrawTilesForStroke"));
  assert.match(syncBody, /geometryChanged\) resizeInkCanvas\(/, "tile backing 仅在几何变化时重置");
  // 3) switchInkStage 不触碰 committed layer DOM（无销毁/重建）
  const switchBody = reader.slice(reader.indexOf("function switchInkStage"), reader.indexOf("function changeViewedStage"));
  assert.doesNotMatch(switchBody, /remove\(\)|replaceChild|innerHTML/, "阶段切换不销毁/重建 committed 层");
});

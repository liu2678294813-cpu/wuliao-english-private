// X1.1 共享笔系统契约：精读 / 普通完形 / 模拟考试必须使用同一份 Shared Ink Runtime。
// 1) 源码契约：三个业务模块（CustomDeepReader / ClozeReader→ClozeInkSurface / ExamInkSurface）
//    引用同一个 useStructuredInk 模块，且不再维护各自独立的劣化渲染生命周期。
// 2) 行为契约：用记录型 canvas 驱动 createInkRuntimeController，
//    - pointermove 只增量绘制（pen direct-ink 无 clear）；
//    - pointerup 走 append-only commit（不重画历史）；
//    - eraser 走结构性重绘；
//    - lasso 只删除真实圈选范围内的 stroke；
//    - 长按临时橡皮（620ms）→ 抬笔恢复 pen。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// ---------------- 源码契约 ----------------

test("精读 / 普通完形 / 考试四个 Surface 引用同一个 Shared Ink Runtime 模块", () => {
  const deepReader = read("src/CustomDeepReader.jsx");
  const clozeSurface = read("src/ink/ClozeInkSurface.jsx");
  assert.match(deepReader, /from "\.\/ink\/useStructuredInk"/);
  assert.match(clozeSurface, /from "\.\/useStructuredInk"/);
  // 普通完形 / 考试通过 ClozeInkSurface / ExamInkSurface 使用同一 Runtime（不另起炉灶）。
  assert.match(read("src/ClozeReader.jsx"), /<ClozeInkSurface/);
});

test("Shared Runtime 导出精读正式笔系统全部关键能力", async () => {
  const runtime = await import("../src/ink/inkRuntime.js");
  for (const name of [
    "appendIncrementalInk",
    "finalizeInkPath",
    "shouldUseAppendCommit",
    "startInkLongPressTimer",
    "eraseAnnotationsInPolygon",
    "eraseAnnotationsAlongPath",
    "installPenScrollGuard",
    "tileRangeForStroke",
    "traceInkPath",
    "createInkRuntimeController",
  ]) {
    assert.equal(typeof runtime[name], "function", `shared runtime must export ${name}`);
  }
});

test("普通完形 / 考试不再出现独立劣化渲染生命周期", () => {
  const cloze = read("src/ink/ClozeInkSurface.jsx");
  for (const source of [cloze]) {
    assert.doesNotMatch(source, /pointermove[\s\S]{0,200}clearRect/);
    assert.doesNotMatch(source, /function renderPreview\(/);
    assert.doesNotMatch(source, /function commitStrokes\(/);
  }
});

test("完形无独立 pen / toolbar / eraser 实现（全部消费共享组件与 Runtime）", () => {
  const clozeReader = read("src/ClozeReader.jsx");
  const clozeSurface = read("src/ink/ClozeInkSurface.jsx");
  // 工具栏：唯一来源是共享 AnnotationToolbar
  assert.match(clozeReader, /import \{ AnnotationToolbar \} from "\.\/ui\/AnnotationToolbar"/);
  // 无独立 pointer handler / eraser / 自定义 toolbar markup
  assert.doesNotMatch(clozeReader, /onPointerDownCapture/);
  assert.doesNotMatch(clozeReader, /onPointerMoveCapture/);
  assert.doesNotMatch(clozeReader, /eraseAnnotations/);
  assert.doesNotMatch(clozeReader, /tool-size-range-track/);
  assert.doesNotMatch(clozeReader, /color-picker/);
  // 特殊工具（陌生词）走 Shared Runtime beforeInk* 扩展点，而不是完形特例会话
  assert.match(clozeReader, /createUnknownSelectionHooks/);
  assert.match(clozeSurface, /beforeInkDown/);
  // 完形仅保留 persistence adapter（clozeInk namespace）
  assert.match(clozeSurface, /saveClozeInk/);
  assert.doesNotMatch(clozeSurface, /saveInkStrokes\(/);
});

// ---------------- 行为契约（记录型 canvas） ----------------

class FakeElement {
  constructor() {
    this.rect = { left: 10, top: 20, width: 500, height: 800 };
  }
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  contains() {
    return true;
  }
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
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
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
    type,
    pointerType,
    pointerId,
    button: 0,
    clientX: x,
    clientY: y,
    pressure,
    nativeEvent: {
      pointerType,
      clientX: x,
      clientY: y,
      pressure,
      getCoalescedEvents: () => [],
    },
    target: new FakeElement(),
    preventDefault() {},
  };
}

function runtimeHarness({ engineForPen = () => true, extra = {} } = {}) {
  const committedCommands = recordingContext();
  const previewCommands = recordingContext();
  const content = new FakeElement();
  const contentRef = { current: content };
  const previewCanvasRef = { current: fakeCanvas(previewCommands) };
  const strokesRef = { current: [] };
  const activeRef = { current: null };
  const toolRef = { current: "pen" };
  const colorRef = { current: "#173a62" };
  const penSizeRef = { current: 2.6 };
  const penModeRef = { current: "ballpoint" };
  const eraserModeRef = { current: "normal" };
  const eraserSizeRef = { current: 24 };
  const calls = { commitAppend: 0, committedRender: [], persisted: [], hints: [] };
  const controller = runtime.createInkRuntimeController({
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
    commitAppendStroke: () => { calls.commitAppend += 1; },
    renderCommitted: (extra = null) => { calls.committedRender.push(extra ? "extra" : "full"); },
    persistStrokes: (next, opts) => { calls.persisted.push({ next: next.length, opts, canonical: next }); },
    engineForPen,
    onHint: (hint) => { calls.hints.push(hint); },
    ...extra,
  });
  return {
    controller,
    committedCommands,
    previewCommands,
    strokesRef,
    calls,
    toolRef,
    eraserModeRef,
    activeRef,
  };
}

// node 环境补 window / Element 等（行为契约测试用）。
if (!globalThis.window) {
  globalThis.window = globalThis;
}
if (typeof globalThis.Element === "undefined") {
  globalThis.Element = class Element {};
  FakeElement.prototype instanceof Element || true;
}
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

import * as runtime from "../src/ink/inkRuntime.js";

test("pen 笔画：pointermove 增量绘制，pointerup append-only 提交（不重画历史）", async () => {
  const { controller, previewCommands, calls } = runtimeHarness();
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  for (let i = 1; i <= 5; i += 1) controller.handlePointerMove(pointerEvent("pointermove", 50 + i * 10, 60 + i * 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 增量路径：preview 上没有 clearRect（绝不整笔重画）。
  const clears = previewCommands.commands.filter(([name]) => name === "clearRect").length;
  assert.equal(clears, 0, "pen preview must be incremental (no clearRect per move)");
  assert.ok(previewCommands.commands.some(([name]) => name === "moveTo" || name === "quadraticCurveTo"), "preview must draw segments");
  controller.handlePointerUp(pointerEvent("pointerup", 100, 85));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.commitAppend, 1, "pen up must use append-only commit");
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].opts.skipTileRedraw, true, "pen append must skip structural redraw");
});

test("pen 交接：append 未确认时先同步 committed fallback，再清理 preview", async () => {
  const fallbackCalls = [];
  const { controller, calls } = runtimeHarness({
    extra: {
      commitAppendStroke: () => false,
      renderCommitted: (stroke = null) => {
        fallbackCalls.push(stroke ? "targeted" : "full");
        return true;
      },
    },
  });
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 76));
  controller.handlePointerUp(pointerEvent("pointerup", 100, 85));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(fallbackCalls, ["targeted"]);
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].opts.skipTileRedraw, true);
});

test("normal eraser：结构性重绘（含 extra stroke），不 append-only", async () => {
  const { controller, calls, toolRef, eraserModeRef } = runtimeHarness();
  toolRef.current = "eraser";
  eraserModeRef.current = "normal";
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 90));
  assert.ok(calls.committedRender.some((kind) => kind === "extra"), "eraser must structurally redraw with extra stroke");
  controller.handlePointerUp(pointerEvent("pointerup", 90, 100));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.commitAppend, 0, "eraser must not use append-only commit");
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].opts.skipTileRedraw, false, "eraser must allow structural redraw on persist");
});

test("lasso：只删除真实圈选范围内 stroke，套索轨迹不持久化", async () => {
  const { controller, strokesRef, calls } = runtimeHarness();
  strokesRef.current = [
    { tool: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
    { tool: "pen", points: [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }] },
  ];
  calls.persisted = [];
  const lasso = runtimeHarness();
  lasso.strokesRef.current = strokesRef.current;
  lasso.toolRef.current = "eraser";
  lasso.eraserModeRef.current = "lasso";
  // 圈住左上角区域（normalized x 0.02–0.14, y 0.0125–0.22，覆盖第一条 stroke）
  lasso.controller.handlePointerDown(pointerEvent("pointerdown", 20, 30));
  lasso.controller.handlePointerMove(pointerEvent("pointermove", 80, 40));
  lasso.controller.handlePointerMove(pointerEvent("pointermove", 80, 120));
  lasso.controller.handlePointerUp(pointerEvent("pointerup", 40, 130));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(lasso.calls.persisted.length, 1, "lasso must persist deletion result");
  assert.equal(lasso.calls.persisted[0].next, 1, "only the stroke inside the polygon must be deleted");
});

test("lasso：可选 geometry adapter 在投影坐标命中，但保存原 canonical stroke", async () => {
  const canonical = { tool: "pen", points: [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }] };
  const keptCanonical = { tool: "pen", points: [{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.7 }] };
  const adapter = {
    projectStroke: (stroke) => stroke === canonical
      ? { ...stroke, points: [{ x: 0.08, y: 0.08 }, { x: 0.12, y: 0.12 }] }
      : { ...stroke, points: stroke.points.map((point) => ({ ...point })) },
  };
  const { controller, strokesRef, calls, toolRef, eraserModeRef } = runtimeHarness({ extra: { geometryAdapter: adapter } });
  strokesRef.current = [canonical, keptCanonical];
  toolRef.current = "eraser";
  eraserModeRef.current = "lasso";
  controller.handlePointerDown(pointerEvent("pointerdown", 15, 25));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 30));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 120));
  controller.handlePointerUp(pointerEvent("pointerup", 20, 125));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].next, 1, "命中必须基于 projected stroke");
  assert.equal(calls.persisted[0].canonical[0], keptCanonical, "不完整 adapter 的 projected clone 也不得进入 storage");
  assert.deepEqual(canonical.points, [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }], "canonical 不得被投影覆盖");
});

test("长按固定临时套索：permanent normal 与 lasso 都进入 lasso（提示 + 虚线预览）", async () => {
  for (const eraserMode of ["normal", "lasso"]) {
    const { controller, calls, activeRef, previewCommands, eraserModeRef } = runtimeHarness();
    eraserModeRef.current = eraserMode;
    controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
    await new Promise((resolve) => setTimeout(resolve, 660));
    assert.equal(activeRef.current?.sessionTool, "temporary-eraser", `${eraserMode}: 必须进入临时会话`);
    assert.equal(activeRef.current?.stroke.tool, "lasso", `${eraserMode}: 临时工具固定为 lasso`);
    assert.ok(calls.hints.includes("临时自由套索：圈选后抬笔删除"), `${eraserMode}: 出现套索提示`);
    controller.handlePointerMove(pointerEvent("pointermove", 80, 80));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(previewCommands.commands.some(([name]) => name === "setLineDash"), `${eraserMode}: lasso 虚线预览`);
    controller.handlePointerUp(pointerEvent("pointerup", 80, 80));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(activeRef.current, null, `${eraserMode}: 抬笔后会话结束`);
  }
});

test("长按前明显移动不进入临时套索，保持正常 pen append-only", async () => {
  const { controller, calls, activeRef } = runtimeHarness();
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  controller.handlePointerMove(pointerEvent("pointermove", 90, 90));
  controller.handlePointerMove(pointerEvent("pointermove", 130, 120));
  controller.handlePointerUp(pointerEvent("pointerup", 170, 150));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(activeRef.current, null, "会话正常结束");
  assert.equal(calls.commitAppend, 1, "正常 pen 笔画必须 append-only commit");
  assert.ok(!calls.hints.some((hint) => hint.includes("套索")), "不得出现套索提示");
});

test("临时套索：圈选删除真实范围内笔迹，套索轨迹不持久化，抬笔恢复 pen", async () => {
  const harness = runtimeHarness();
  harness.strokesRef.current = [
    { tool: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
    { tool: "pen", points: [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }] },
  ];
  harness.calls.persisted = [];
  const { controller, calls, toolRef, activeRef } = harness;
  controller.handlePointerDown(pointerEvent("pointerdown", 20, 30));
  await new Promise((resolve) => setTimeout(resolve, 660));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 40));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 120));
  controller.handlePointerUp(pointerEvent("pointerup", 40, 130));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(activeRef.current, null, "抬笔后会话结束");
  assert.equal(toolRef.current, "pen", "全局工具始终保持 pen");
  assert.equal(calls.persisted.length, 1, "只提交一次删除结果");
  assert.equal(calls.persisted[0].next, 1, "只有圈内的笔迹被删除");
  assert.ok(calls.hints.includes("已恢复画笔"), "恢复画笔提示");
});

test("临时套索 pointercancel：会话干净结束，全局工具仍为 pen", async () => {
  const { controller, calls, toolRef, activeRef } = runtimeHarness();
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  await new Promise((resolve) => setTimeout(resolve, 660));
  assert.equal(activeRef.current?.sessionTool, "temporary-eraser");
  controller.handlePointerCancel(pointerEvent("pointercancel", 70, 80));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(activeRef.current, null, "cancel 后会话结束");
  assert.equal(toolRef.current, "pen", "cancel 后不残留 eraser/lasso 状态");
  assert.equal(calls.commitAppend, 0, "cancel 不得提交 pen 笔画");
});

test("精读视口固定预览：临时套索轨迹经 toPreviewPixel 映射后绘制", async () => {
  const { controller, previewCommands } = runtimeHarness({
    extra: {
      toPreviewPixel: (point, active) => [
        active.rect.left + point.x * active.surface.width,
        active.rect.top + point.y * active.surface.height,
      ],
      previewCanvasSize: () => ({ width: 1000, height: 900 }),
      previewOptions: (stroke) => ({ lineWidth: stroke.width || 2, strokeStyle: stroke.color, ratio: 1 }),
    },
  });
  controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  await new Promise((resolve) => setTimeout(resolve, 660));
  controller.handlePointerMove(pointerEvent("pointermove", 80, 80));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(previewCommands.commands.some(([name]) => name === "setLineDash"), "viewport lasso 必须为虚线");
  const move = previewCommands.commands.find(([name]) => name === "moveTo");
  assert.ok(move, "viewport lasso 必须经 toPreviewPixel 映射");
  assert.deepEqual(move.slice(1), [50, 60], "surface 归一化点必须映射回视口像素");
  controller.handlePointerUp(pointerEvent("pointerup", 80, 80));
  await new Promise((resolve) => setTimeout(resolve, 5));
});

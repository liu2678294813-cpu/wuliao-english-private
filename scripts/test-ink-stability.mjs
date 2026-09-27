import test from "node:test";
import assert from "node:assert/strict";

// inkStability.js 在调用时读取 window.setTimeout/clearTimeout，
// 这里提供基于真实 timer 的包装，便于断言 delay 与清理行为。
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let recordedDelay = null;
let clearedIds = [];

globalThis.window = {
  setTimeout(callback, delay, ...args) {
    recordedDelay = delay;
    return realSetTimeout(callback, delay, ...args);
  },
  clearTimeout(id) {
    clearedIds.push(id);
    return realClearTimeout(id);
  },
};

const {
  INK_PEN_UP_JITTER_CSS_PX,
  clearInkTimer,
  isCurrentInkSession,
  shouldAppendPointerUpPoint,
  startInkLongPress,
  temporaryInkMode,
} = await import("../src/inkStability.js");

const {
  LONG_PRESS_MS,
  LONG_PRESS_MAX_DISPLACEMENT_CSS_PX,
  LONG_PRESS_MAX_PATH_CSS_PX,
  activateTemporaryEraser,
  appendInkPointerUp,
  appendInkSamples,
  appendIncrementalInk,
  collapseTapStroke,
  createInkSession,
  createLongPressCandidate,
  endInkSession,
  finalizeInkPath,
  inkSegments,
  inkTail,
  isSharpTurn,
  shouldUseAppendCommit,
  shouldActivateTemporaryEraser,
  startInkLongPressTimer,
  tileRangeForStroke,
  traceInkPath,
  updateLongPressCandidate,
} = await import("../src/inkEngine.js");

function resetTimers() {
  recordedDelay = null;
  clearedIds = [];
}

const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

function enginePoint(x, y, width = 100, height = 100) {
  return {
    normalized: { x: x / width, y: y / height },
    pixel: { x, y },
    viewport: { x, y },
  };
}

function makeEngineSession(startX = 0, startY = 0) {
  return createInkSession({
    pointerId: 1,
    pointerType: "pen",
    point: enginePoint(startX, startY),
    strokeMeta: {
      tool: "pen",
      color: "#173a62",
      width: 2.6,
      engine: "direct-ink",
      penMode: "ballpoint",
    },
    rect: { left: 0, top: 0, width: 100, height: 100 },
    surface: { width: 100, height: 100 },
  });
}

class RecordingContext {
  constructor() {
    this.commands = [];
  }

  save() { this.commands.push({ op: "save" }); }
  restore() { this.commands.push({ op: "restore" }); }
  scale() { this.commands.push({ op: "scale" }); }
  beginPath() { this.commands.push({ op: "beginPath" }); }
  moveTo(x, y) { this.commands.push({ op: "moveTo", x, y }); }
  lineTo(x, y) { this.commands.push({ op: "lineTo", x, y }); }
  quadraticCurveTo(cx, cy, x, y) { this.commands.push({ op: "quadraticCurveTo", cx, cy, x, y }); }
  arc(x, y, r) { this.commands.push({ op: "arc", x, y, r }); }
  fill() { this.commands.push({ op: "fill" }); }
  stroke() { this.commands.push({ op: "stroke" }); }
}

const geometryOps = new Set(["moveTo", "lineTo", "quadraticCurveTo", "arc", "fill", "stroke"]);
const geometryCommands = (ctx) => ctx.commands.filter((command) => geometryOps.has(command.op));
const toPixel = (point) => [point.x, point.y];
const inkOptions = { lineWidth: 2.6, strokeStyle: "#173a62" };

async function runFinishPath({ moved }) {
  resetTimers();
  const active = {
    id: 7,
    moved,
    temporaryEraser: false,
    stroke: { points: [{ x: 0.5, y: 0.5 }] },
    lastPixel: { x: 100, y: 100 },
    timer: null,
  };
  const activeRef = { current: active };
  let triggered = 0;
  startInkLongPress(active, activeRef, 40, () => {
    triggered += 1;
    active.temporaryEraser = true;
  });
  assert.ok(active.timer, "timer 已启动");
  const timerId = active.timer;
  // finishInk 在 appendPointerUpPoint 之前必须清 timer
  clearInkTimer(active);
  assert.equal(active.timer, null, "timer 已清空");
  assert.equal(clearedIds[0], timerId, "clearTimeout 收到原 timer");
  // 等待超过原延迟：被清理的旧 callback 不得执行
  await wait(100);
  assert.equal(triggered, 0, "旧 callback 不得触发");
  assert.equal(active.temporaryEraser, false, "不得进入 temporary eraser");
}

test("A: 短点 pointerup 后旧 timer 不再触发临时橡皮", async () => {
  await runFinishPath({ moved: false });
});

test("B: 短笔画（<3px）pointerup 后旧 timer 不再触发临时橡皮", async () => {
  await runFinishPath({ moved: true });
});

test("C: pointercancel（复用 finish 路径）后旧 timer 不再触发", async () => {
  await runFinishPath({ moved: false });
});

test("D: stale-session guard：ref 已不是该 active 时旧 callback 安全 return", async () => {
  resetTimers();
  const oldActive = { id: 7, timer: null };
  const activeRef = { current: oldActive };
  let triggered = 0;
  startInkLongPress(oldActive, activeRef, 30, () => {
    triggered += 1;
  });
  activeRef.current = { id: 8 };
  await wait(80);
  assert.equal(triggered, 0, "新会话已替换旧 active，旧 timer 不得触发");

  resetTimers();
  const secondActive = { id: 9, timer: null };
  const secondRef = { current: secondActive };
  let secondTriggered = 0;
  startInkLongPress(secondActive, secondRef, 30, () => {
    secondTriggered += 1;
  });
  secondRef.current = null; // pointerup 后 activeInkRef.current 置空
  await wait(80);
  assert.equal(secondTriggered, 0, "ref 置空后旧 timer 不得触发");
});

test("startInkLongPress 保持 620ms 长按时间", () => {
  resetTimers();
  const active = { id: 10, timer: null };
  const activeRef = { current: active };
  startInkLongPress(active, activeRef, 620, () => {});
  assert.equal(recordedDelay, 620);
  clearInkTimer(active);
});

test("isCurrentInkSession 要求同一对象且 pointer id 一致", () => {
  const active = { id: 3 };
  const activeRef = { current: active };
  assert.equal(isCurrentInkSession(activeRef, active), true);
  assert.equal(isCurrentInkSession({ current: { id: 4 } }, active), false);
  assert.equal(isCurrentInkSession({ current: null }, active), false);
});

test("E: 合法长按（permanent eraserMode=normal）固定进入临时套索", async () => {
  resetTimers();
  const eraserModeRef = { current: "normal" };
  const active = { id: 1, timer: null, temporaryEraser: false };
  const activeRef = { current: active };
  let triggered = 0;
  startInkLongPress(active, activeRef, 30, () => {
    assert.equal(temporaryInkMode(eraserModeRef), "lasso");
    triggered += 1;
  });
  await wait(80);
  assert.equal(triggered, 1, "合法长按必须触发");
});

test("F: 合法长按（permanent eraserMode=lasso）仍进入临时套索", async () => {
  resetTimers();
  const eraserModeRef = { current: "lasso" };
  const active = { id: 2, timer: null, temporaryEraser: false };
  const activeRef = { current: active };
  let triggered = 0;
  startInkLongPress(active, activeRef, 30, () => {
    assert.equal(temporaryInkMode(eraserModeRef), "lasso");
    triggered += 1;
  });
  await wait(80);
  assert.equal(triggered, 1, "合法套索长按必须触发");
});

test("Pen 长按固定进入临时套索，与 permanent eraserMode 无关", () => {
  assert.equal(temporaryInkMode({ current: "normal" }), "lasso");
  assert.equal(temporaryInkMode({ current: "lasso" }), "lasso");
});

test("G: 抬笔位移 0.3/0.5/0.9 CSS px 不追加新点", () => {
  for (const distance of [0.3, 0.5, 0.9]) {
    const active = {
      stroke: { points: [{ x: 0.1, y: 0.2 }] },
      lastPixel: { x: 100, y: 200 },
    };
    const upPoint = { pixel: { x: 100 + distance, y: 200 } };
    assert.equal(
      shouldAppendPointerUpPoint(active, upPoint, INK_PEN_UP_JITTER_CSS_PX),
      false,
      `${distance}px 属于抬笔机械抖动`,
    );
  }
});

test("H: 抬笔位移 2/3 CSS px 追加有效终点", () => {
  for (const distance of [2, 3]) {
    const active = {
      stroke: { points: [{ x: 0.1, y: 0.2 }] },
      lastPixel: { x: 100, y: 200 },
    };
    const upPoint = { pixel: { x: 100 + distance, y: 200 } };
    assert.equal(
      shouldAppendPointerUpPoint(active, upPoint, INK_PEN_UP_JITTER_CSS_PX),
      true,
      `${distance}px 是真实末端`,
    );
  }
});

test("I: 点状笔画极小抖动不产生小尾巴，真实位移才追加", () => {
  const dot = {
    moved: false,
    stroke: { points: [{ x: 0.5, y: 0.5 }] },
    lastPixel: { x: 50, y: 60 },
  };
  assert.equal(shouldAppendPointerUpPoint(dot, { pixel: { x: 50.5, y: 60 } }), false);
  assert.equal(shouldAppendPointerUpPoint(dot, { pixel: { x: 52, y: 60 } }), true);
});

test("兼容兜底：无最后点或无 lastPixel 时保留原追加行为", () => {
  assert.equal(shouldAppendPointerUpPoint({ stroke: { points: [] }, lastPixel: { x: 1, y: 1 } }, { pixel: { x: 5, y: 5 } }), true);
  assert.equal(
    shouldAppendPointerUpPoint({ stroke: { points: [{ x: 0.1, y: 0.1 }] } }, { pixel: { x: 5, y: 5 } }),
    true,
  );
  assert.equal(clearInkTimer({ timer: null }), undefined);
});

// ---------------- 统一 Ink Engine：采样与 session ----------------

test("引擎: coalesced 采样按序追加且不重排", () => {
  const session = makeEngineSession();
  const appended = appendInkSamples(session, [enginePoint(2, 0), enginePoint(5, 1), enginePoint(9, 2)]);
  assert.equal(appended, 3);
  assert.deepEqual(session.stroke.points.map((point) => point.x), [0, 0.02, 0.05, 0.09]);
  assert.deepEqual(session.stroke.points.map((point) => point.y), [0, 0, 0.01, 0.02]);
});

test("引擎: 重复/极小距离采样去重，批次末点始终保留", () => {
  const session = makeEngineSession();
  appendInkSamples(session, [enginePoint(0.1, 0), enginePoint(0.1, 0), enginePoint(0.3, 0)]);
  assert.equal(session.stroke.points.length, 2);
  assert.equal(session.stroke.points[1].x, 0.003);
  const duplicateBatch = makeEngineSession(10, 10);
  appendInkSamples(duplicateBatch, [enginePoint(10.1, 10), enginePoint(10.1, 10), enginePoint(10.1, 10)]);
  assert.equal(duplicateBatch.stroke.points.length, 2);
});

test("引擎: moved 仅在距离起点 >=3px 时置真（套索语义）", () => {
  const session = makeEngineSession();
  appendInkSamples(session, [enginePoint(2, 0)]);
  assert.equal(session.moved, false);
  appendInkSamples(session, [enginePoint(4, 0)]);
  assert.equal(session.moved, true);
});

test("引擎: 长按候选在离开轻点范围后永久失效", () => {
  let candidate = createLongPressCandidate(0, 0, 0);
  candidate = updateLongPressCandidate(candidate, LONG_PRESS_MAX_DISPLACEMENT_CSS_PX + 1, 0);
  assert.equal(candidate.active, false);
  let circular = createLongPressCandidate(0, 0, 0);
  for (const [x, y] of [[0.8, 0], [0, 0], [-0.8, 0], [0, 0], [0.8, 0]]) {
    circular = updateLongPressCandidate(circular, x, y);
  }
  assert.ok(circular.maxDisplacement <= LONG_PRESS_MAX_DISPLACEMENT_CSS_PX);
  assert.ok(circular.pathLength > LONG_PRESS_MAX_PATH_CSS_PX);
  assert.equal(circular.active, false);
  assert.equal(shouldActivateTemporaryEraser(circular, LONG_PRESS_MS), false);
});

test("引擎: 采样移动使候选失效时自动清理长按 timer", () => {
  resetTimers();
  const session = makeEngineSession();
  const ref = { current: session };
  startInkLongPressTimer(session, ref, {
    eraserModeRef: { current: "normal" },
    colorRef: { current: "#000" },
    eraserSizeRef: { current: 10 },
  });
  assert.ok(session.timer, "timer 已启动");
  appendInkSamples(session, [enginePoint(8, 0)]);
  assert.equal(session.timer, null, "位移超过阈值后 timer 必须清理");
  assert.equal(session.longPress.active, false);
});

// ---------------- 统一 Ink Engine：曲线构造 ----------------

test("引擎: 共线点生成的曲线全部位于直线上，尾段到达真实终点", () => {
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
  const segments = inkSegments(line);
  assert.equal(segments.length, 3);
  for (const segment of segments) {
    assert.equal(segment.from.y, 0);
    assert.equal(segment.to.y, 0);
    if (segment.type === "quad") assert.equal(segment.control.y, 0);
  }
  const tail = inkTail(line);
  assert.equal(tail.to.x, 30);
  assert.equal(tail.to.y, 0);
});

test("引擎: 多点圆弧段首尾相连、无 NaN", () => {
  const circle = Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return { x: 100 + 50 * Math.cos(angle), y: 100 + 50 * Math.sin(angle) };
  });
  const segments = inkSegments(circle);
  assert.equal(segments.length, 23);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    assert.ok(Math.abs(current.from.x - previous.to.x) < 1e-9);
    assert.ok(Math.abs(current.from.y - previous.to.y) < 1e-9);
  }
  for (const segment of segments) {
    assert.ok(Number.isFinite(segment.from.x) && Number.isFinite(segment.from.y));
    assert.ok(Number.isFinite(segment.to.x) && Number.isFinite(segment.to.y));
    if (segment.type === "quad") {
      assert.ok(Number.isFinite(segment.control.x) && Number.isFinite(segment.control.y));
    }
  }
});

test("引擎: 尖角（外部转角 >=约100°）直连顶点，平滑弧线不触发", () => {
  assert.equal(isSharpTurn({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }), false);
  const sharp = { x: 0, y: 0 };
  const vertex = { x: 10, y: 0 };
  const after = { x: 10 - 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2 };
  assert.equal(isSharpTurn(sharp, vertex, after), true);
  const segments = inkSegments([sharp, vertex, after]);
  assert.ok(segments.some((segment) => (
    segment.type === "line"
    && segment.to.x === 10
    && segment.to.y === 0
  )));
});

test("引擎: 抬笔 0.5px 抖动不追加、不产生尾段跳变；2px 真实终点追加", () => {
  const session = makeEngineSession();
  appendInkSamples(session, [enginePoint(10, 0), enginePoint(20, 0), enginePoint(30, 0)]);
  const before = session.stroke.points.length;
  appendInkPointerUp(session, enginePoint(30.4, 0));
  assert.equal(session.stroke.points.length, before);
  assert.equal(inkTail(session.stroke.points).to.x, 0.3);
  const real = makeEngineSession();
  appendInkSamples(real, [enginePoint(10, 0), enginePoint(20, 0)]);
  appendInkPointerUp(real, enginePoint(22, 0));
  assert.equal(real.stroke.points.length, 4);
  assert.equal(inkTail(real.stroke.points).to.x, 0.22);
});

// ---------------- 统一 Ink Engine：实时 == 最终 ----------------

test("引擎: 增量绘制 + 收尾与整笔回放产生相同几何命令", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 3, y: 1 },
    { x: 7, y: -1 },
    { x: 12, y: 4 },
    { x: 10, y: 9 },
    { x: 4, y: 10 },
    { x: 1, y: 6 },
    { x: 2, y: 2 },
  ];
  const live = new RecordingContext();
  let rendered = 0;
  for (let index = 1; index < points.length; index += 1) {
    rendered = appendIncrementalInk(live, points.slice(0, index + 1), rendered, toPixel, inkOptions);
  }
  finalizeInkPath(live, points, rendered, toPixel, inkOptions);
  const replay = new RecordingContext();
  traceInkPath(replay, points, toPixel, inkOptions);
  assert.deepEqual(geometryCommands(live), geometryCommands(replay));
});

test("引擎: 新增点只追加新段，不改变已生成段", () => {
  const prefix = [
    { x: 0, y: 0 },
    { x: 3, y: 1 },
    { x: 7, y: -1 },
    { x: 12, y: 4 },
  ];
  const full = [
    ...prefix,
    { x: 10, y: 9 },
    { x: 4, y: 10 },
  ];
  const prefixSegments = inkSegments(prefix);
  const fullSegments = inkSegments(full);
  assert.deepEqual(prefixSegments, fullSegments.slice(0, prefixSegments.length));
});

test("引擎: 单点 tap 不产生独立圆点命令，折叠后保持单点", () => {
  const session = makeEngineSession();
  appendInkPointerUp(session, enginePoint(0.2, 0));
  assert.equal(session.stroke.points.length, 1);
  assert.equal(collapseTapStroke(session), false);
  const ctx = new RecordingContext();
  appendIncrementalInk(ctx, session.stroke.points, 0, toPixel, inkOptions);
  const commands = geometryCommands(ctx);
  assert.equal(commands.filter((command) => command.op === "arc").length, 0);
  assert.equal(commands.filter((command) => command.op === "fill").length, 0);
});

test("引擎: 正常短线不折叠且无独立起笔圆点", () => {
  const session = makeEngineSession();
  appendInkSamples(session, [enginePoint(10, 0)]);
  appendInkPointerUp(session, enginePoint(10, 0));
  assert.equal(collapseTapStroke(session), false);
  assert.equal(session.stroke.points.length, 2);
  const segments = inkSegments(session.stroke.points);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, "line");
  const ctx = new RecordingContext();
  traceInkPath(ctx, session.stroke.points, toPixel, inkOptions);
  const commands = geometryCommands(ctx);
  assert.equal(commands.filter((command) => command.op === "arc").length, 0);
  assert.equal(commands.filter((command) => command.op === "fill").length, 0);
});

test("引擎: 0.1px jitter 折叠为单点且无小尾巴", () => {
  const session = makeEngineSession();
  appendInkSamples(session, [enginePoint(0.1, 0)]);
  assert.equal(session.stroke.points.length, 2);
  assert.equal(collapseTapStroke(session), true);
  assert.equal(session.stroke.points.length, 1);
  assert.equal(inkTail(session.stroke.points), null);
});

test("引擎: 多点快速线条首点自然接入曲线，无独立圆点", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 3, y: 1 },
    { x: 7, y: -1 },
    { x: 12, y: 4 },
    { x: 10, y: 9 },
  ];
  const ctx = new RecordingContext();
  traceInkPath(ctx, points, toPixel, inkOptions);
  const commands = geometryCommands(ctx);
  assert.equal(commands.filter((command) => command.op === "arc").length, 0);
  assert.equal(commands.filter((command) => command.op === "fill").length, 0);
  const segments = inkSegments(points);
  assert.equal(segments[0].from.x, 0);
  assert.equal(segments[0].from.y, 0);
});

test("引擎: collapseTapStroke 不影响 eraser/lasso", () => {
  const eraser = {
    stroke: { tool: "eraser", points: [{ x: 0, y: 0 }, { x: 0.001, y: 0 }] },
    startPixel: { x: 0, y: 0 },
    lastPixel: { x: 0.1, y: 0 },
  };
  assert.equal(collapseTapStroke(eraser), false);
  assert.equal(eraser.stroke.points.length, 2);
  const lasso = {
    stroke: { mode: "lasso", points: [{ x: 0, y: 0 }, { x: 0.001, y: 0 }] },
    startPixel: { x: 0, y: 0 },
    lastPixel: { x: 0.1, y: 0 },
  };
  assert.equal(collapseTapStroke(lasso), false);
  assert.equal(lasso.stroke.points.length, 2);
});

test("引擎: shouldUseAppendCommit 仅普通 pen 笔画走 append-only", () => {
  assert.equal(shouldUseAppendCommit({ tool: "pen", engine: "direct-ink", penMode: "ballpoint" }), true);
  assert.equal(shouldUseAppendCommit({ tool: "pen" }), true);
  assert.equal(shouldUseAppendCommit({ mode: "pen" }), true);
  assert.equal(shouldUseAppendCommit({ tool: "eraser" }), false);
  assert.equal(shouldUseAppendCommit({ tool: "lasso" }), false);
  assert.equal(shouldUseAppendCommit({ mode: "normal-eraser" }), false);
  assert.equal(shouldUseAppendCommit(null), false);
});

test("引擎: tileRangeForStroke 计算跨 tile 范围并裁剪到可见窗口", () => {
  const info = { start: 0, end: 4, contentHeight: 5 * 2048 };
  assert.deepEqual(
    tileRangeForStroke({ minY: 0.1, maxY: 0.25 }, info, { tileHeight: 2048, overlap: 24 }),
    { first: 0, last: 2 },
  );
  const cross = { start: 0, end: 4, contentHeight: 3 * 2048 };
  assert.deepEqual(
    tileRangeForStroke({ minY: 0.2, maxY: 0.3 }, cross, { tileHeight: 2048, overlap: 24 }),
    { first: 0, last: 1 },
  );
  const aboveWindow = { start: 2, end: 3, contentHeight: 4 * 2048 };
  assert.equal(
    tileRangeForStroke({ minY: 0, maxY: 0.01 }, aboveWindow, { tileHeight: 2048, overlap: 24 }),
    null,
  );
  assert.equal(tileRangeForStroke(null, info, { tileHeight: 2048, overlap: 24 }), null);
});

// ---------------- 统一 Ink Engine：长按临时橡皮 ----------------

test("引擎: startInkLongPressTimer 使用 465ms 长按时间", () => {
  resetTimers();
  const session = makeEngineSession();
  startInkLongPressTimer(session, { current: session }, {
    eraserModeRef: { current: "normal" },
    colorRef: { current: "#000" },
    eraserSizeRef: { current: 10 },
  });
  assert.equal(recordedDelay, 465);
  endInkSession(session);
});

test("引擎: endInkSession 清理后的长按 timer 不触发", async () => {
  resetTimers();
  const session = makeEngineSession();
  const ref = { current: session };
  startInkLongPressTimer(session, ref, {
    eraserModeRef: { current: "normal" },
    colorRef: { current: "#000" },
    eraserSizeRef: { current: 10 },
  });
  assert.ok(session.timer);
  const timerId = session.timer;
  endInkSession(session);
  assert.equal(session.timer, null);
  assert.equal(clearedIds[0], timerId, "clearTimeout 收到原 timer");
  await wait(100);
  assert.equal(session.sessionTool, "pen");
});

test("引擎: 合法长按切换为临时自由套索且不改全局工具", () => {
  const active = makeEngineSession();
  const ref = { current: active };
  active.longPress = createLongPressCandidate(0, 0, Date.now() - LONG_PRESS_MS - 50);
  const eraserModeRef = { current: "normal" };
  const colorRef = { current: "#123456" };
  const eraserSizeRef = { current: 9 };
  let activatedMode = null;
  const ok = activateTemporaryEraser(active, ref, eraserModeRef, {
    colorRef,
    eraserSizeRef,
    onTemporaryEraser: (session, mode) => { activatedMode = mode; },
  });
  assert.equal(ok, true);
  assert.equal(activatedMode, "lasso");
  assert.equal(active.sessionTool, "temporary-eraser");
  assert.equal(active.stroke.tool, "lasso");
  assert.equal(active.stroke.width, 2);
  assert.equal(active.stroke.color, "#e26f51");
});

test("引擎: stale-session 或已失效候选不能激活临时橡皮", () => {
  const active = makeEngineSession();
  active.longPress = createLongPressCandidate(0, 0, Date.now() - LONG_PRESS_MS - 50);
  const staleRef = { current: null };
  assert.equal(
    activateTemporaryEraser(active, staleRef, { current: "normal" }, {
      colorRef: { current: "#000" },
      eraserSizeRef: { current: 10 },
    }),
    false,
  );
  assert.equal(active.sessionTool, "pen");
  const active2 = makeEngineSession();
  const ref2 = { current: active2 };
  active2.longPress = createLongPressCandidate(0, 0, Date.now() - LONG_PRESS_MS - 50);
  active2.longPress.active = false;
  assert.equal(
    activateTemporaryEraser(active2, ref2, { current: "normal" }, {
      colorRef: { current: "#000" },
      eraserSizeRef: { current: 10 },
    }),
    false,
  );
});

// ---------------- 统一 Ink Engine：两阅读器共用同一核心 ----------------

test("引擎: PdfReader 与 CustomDeepReader 共用同一核心模块", async () => {
  const fs = await import("node:fs");
  const pdf = fs.readFileSync(new URL("../src/PdfReader.jsx", import.meta.url), "utf8");
  const deep = fs.readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
  assert.match(pdf, /from ["']\.\/inkEngine["']/);
  assert.match(deep, /from ["']\.\/inkEngine["']/);
});

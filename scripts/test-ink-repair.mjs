import test from "node:test";
import assert from "node:assert/strict";
import { createInkSession, appendInkSamples, collapseTapStroke, shouldActivateTemporaryEraser } from "../src/inkEngine.js";

const point = (x, y) => ({ normalized: { x: x / 100, y: y / 100 }, pixel: { x, y } });
function session(path) {
  const active = createInkSession({
    pointerId: 1, pointerType: "pen", point: point(...path[0]),
    strokeMeta: { tool: "pen", engine: "direct-ink", penMode: "ballpoint", width: 2.6 },
    rect: { left: 0, top: 0, width: 100, height: 100 },
  });
  appendInkSamples(active, path.slice(1).map(([x, y]) => point(x, y)));
  return active;
}

test("closed box and returning hook retain their complete paths", () => {
  for (const path of [
    [[10, 10], [40, 10], [40, 40], [10, 40], [10, 10]],
    [[10, 10], [50, 10], [10.3, 10.2]],
  ]) {
    const active = session(path);
    assert.equal(collapseTapStroke(active), false);
    assert.equal(active.stroke.points.length, path.length);
  }
});

test("small returning movements with a long path are not taps", () => {
  const active = session([[10, 10], [10.8, 10], [9.2, 10], [10, 10]]);
  assert.equal(collapseTapStroke(active), false);
});

test("a true jittering tap stays a single normal-sized dot", () => {
  const active = session([[10, 10], [10.1, 10], [10.2, 10]]);
  assert.equal(collapseTapStroke(active), true);
  assert.equal(active.stroke.points.length, 1);
  assert.equal(active.stroke.width, 2.6);
});

globalThis.window = globalThis;
globalThis.Element ??= class Element {};
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
function flushFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const cb of callbacks) cb(performance.now());
}
const { createInkRuntimeController } = await import("../src/ink/inkRuntime.js");
function runtime({ commit = () => true, render = () => true, persist, extra = {} } = {}) {
  frames.clear();
  const commands = [];
  const context = new Proxy({}, { get: (_, key) => (...args) => commands.push([key, ...args]) });
  const canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100, dataset: { ratio: "1" }, getContext: () => context };
  const tailCommands = [];
  const tailContext = new Proxy({}, { get: (_, key) => (...args) => tailCommands.push([key, ...args]) });
  const tailCanvas = { ...canvas, getContext: () => tailContext };
  const ref = (current) => ({ current });
  const strokesRef = ref([]);
  const activeRef = ref(null);
  const controller = createInkRuntimeController({
    surfaceRef: ref({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), setPointerCapture() {} }),
    previewCanvasRef: ref(canvas), tailCanvasRef: ref(tailCanvas), strokesRef, activeRef,
    toolRef: ref("pen"), colorRef: ref("#123456"), penSizeRef: ref(2.6), penModeRef: ref("ballpoint"),
    eraserModeRef: ref("normal"), eraserSizeRef: ref(20), engineForPen: () => true,
    commitAppendStroke: commit, renderCommitted: render,
    persistStrokes: persist || ((next) => { strokesRef.current = next; }),
    ...extra,
  });
  const event = (type, x = 10, id = 1) => ({
    type, clientX: x, clientY: 10, pointerType: "pen", pointerId: id, button: 0, pressure: .5,
    target: {}, preventDefault() {},
  });
  const stroke = (id = 1) => {
    controller.handlePointerDown(event("pointerdown", 10, id));
    controller.handlePointerMove(event("pointermove", 30, id));
    controller.handlePointerUp(event("pointerup", 30, id));
  };
  return { controller, commands, tailCommands, canvas, context, strokesRef, activeRef, event, stroke };
}

test("undefined commit is not success, and failed fallback keeps ink through later frames", () => {
  let ready = false;
  const r = runtime({ commit: () => undefined, render: () => ready });
  r.stroke();
  flushFrame();
  assert.equal(r.controller.pendingCommitCount(), 1);
  r.stroke(2);
  flushFrame();
  assert.equal(r.controller.pendingCommitCount(), 2);
  ready = true;
  assert.equal(r.controller.retryPendingCommits(), true);
  assert.equal(r.controller.pendingCommitCount(), 0);
  assert.equal(r.strokesRef.current.length, 2);
  r.controller.dispose();
});

test("a new pen session finishes the old one and duplicate up/cancel cannot resave", () => {
  const r = runtime();
  r.controller.handlePointerDown(r.event("pointerdown", 10, 1));
  r.controller.handlePointerMove(r.event("pointermove", 30, 1));
  r.stroke(2);
  r.controller.handlePointerCancel(r.event("pointercancel", 30, 2));
  r.controller.handlePointerUp(r.event("lostpointercapture", 30, 1));
  assert.equal(r.strokesRef.current.length, 2);
  assert.equal(r.activeRef.current, null);
  r.controller.dispose();
});

test("a synchronous save failure retains the stroke and can be retried at the save boundary", () => {
  let ready = false;
  let saved;
  const r = runtime({ persist: (next) => { if (!ready) throw Error("storage unavailable"); saved = next; } });
  r.stroke();
  assert.equal(r.strokesRef.current.length, 1);
  assert.equal(r.activeRef.current, null);
  assert.throws(() => r.controller.finishActiveForGeometryChange(), /storage unavailable/);
  ready = true;
  r.controller.finishActiveForGeometryChange();
  assert.equal(saved.length, 1);
  r.controller.dispose();
});

test("pen down draws an immediate normal-size dot; moving tail reaches the latest point", () => {
  const r = runtime();
  r.controller.handlePointerDown(r.event("pointerdown", 10));
  assert.deepEqual(r.tailCommands.find(([op]) => op === "arc").slice(1, 4), [10, 10, 1.3]);
  r.controller.handlePointerMove(r.event("pointermove", 30));
  assert.deepEqual(r.tailCommands.filter(([op]) => op === "lineTo").at(-1), ["lineTo", 30, 10], "pen input must not wait for another animation frame");
  flushFrame();
  assert.deepEqual(r.tailCommands.filter(([op]) => op === "lineTo").at(-1), ["lineTo", 30, 10]);
  assert.equal(r.commands.some(([op]) => op === "clearRect"), false, "stable live prefix is append-only");
  const clears = r.tailCommands.filter(([op]) => op === "clearRect");
  assert.ok(clears.length > 0);
  assert.ok(clears.every(([, , , width, height]) => width < 100 && height < 100), "only old tail bounds are cleared");
  r.controller.handlePointerUp(r.event("pointerup", 30));
  assert.equal(r.strokesRef.current[0].points.at(-1).x, .3);
  r.controller.dispose();
});

test("high-frequency drawing buffers bounded diagnostics without scheduling work per sample", () => {
  const r = runtime();
  const originalTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = (...args) => { scheduled += 1; return originalTimeout(...args); };
  try {
    r.controller.handlePointerDown(r.event("pointerdown", 10));
    const afterDown = scheduled;
    for (let i = 1; i <= 1000; i += 1) {
      r.controller.handlePointerMove(r.event("pointermove", 10 + i * .07));
    }
    assert.equal(scheduled, afterDown, "movement must not create telemetry timers");
    assert.equal(r.activeRef.current.stroke.points.length, 1001);
    assert.ok(r.activeRef.current.telemetry.renderSamples.length <= 64);
    r.controller.handlePointerUp(r.event("pointerup", 80));
    assert.equal(scheduled, afterDown + 1, "one diagnostics task at stroke end");
    assert.equal(r.strokesRef.current[0].points.length, 1001);
    assert.equal(r.strokesRef.current[0].telemetry, undefined, "diagnostics never enter saved strokes");
  } finally {
    globalThis.setTimeout = originalTimeout;
    r.controller.dispose();
  }
});

test("failed dot handoff preserves visible dot on stable preview while starting the next stroke", () => {
  const r = runtime({ commit: () => false, render: () => false });
  r.controller.handlePointerDown(r.event("pointerdown", 10));
  r.controller.handlePointerUp(r.event("pointerup", 10));
  assert.ok(r.commands.some(([op]) => op === "arc"));
  r.controller.handlePointerDown(r.event("pointerdown", 50, 2));
  assert.equal(r.controller.pendingCommitCount(), 1);
  r.controller.dispose();
});

test("native raw input and React move consume each real sample once", () => {
  const r = runtime();
  r.controller.handlePointerDown({ ...r.event("pointerdown", 10), timeStamp: 1 });
  const samples = [
    { ...r.event("pointerrawupdate", 20), timeStamp: 2 },
    { ...r.event("pointerrawupdate", 30), timeStamp: 3 },
  ];
  // A parent summary may differ from the last raw sample; it is not another raw point.
  const native = { ...samples[1], clientX: 32, getCoalescedEvents: () => samples };
  r.controller.handlePointerMove(native);
  r.controller.handlePointerMove({ ...native, type: "pointermove", nativeEvent: native });
  assert.deepEqual(r.activeRef.current.stroke.points.map((p) => p.x), [.1, .2, .3]);
  // Raw events may stop arriving: a newer ordinary move must still work.
  r.controller.handlePointerMove({ ...r.event("pointermove", 40), timeStamp: 4 });
  assert.equal(r.activeRef.current.stroke.points.at(-1).x, .4);
  r.controller.dispose();
});

test("pending page serialization yields a frame and can be cancelled for a boundary flush", async () => {
  const { scheduleInkSave, cancelScheduledInkSave } = await import("../src/saveCoordinator.js");
  let writes = 0;
  const handle = scheduleInkSave(() => { writes += 1; });
  assert.equal(writes, 0);
  cancelScheduledInkSave(handle);
  flushFrame();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes, 0);
  scheduleInkSave(() => { writes += 1; });
  flushFrame();
  assert.equal(writes, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes, 1);
});

test("intentional stationary long press survives but a slow real stroke never becomes a lasso", () => {
  const tap = session([[10, 10], [10.2, 10]]);
  assert.equal(shouldActivateTemporaryEraser(tap.longPress, tap.longPress.startTime + 621), true);
  const written = session([[10, 10], [11.2, 10], [10, 10]]);
  assert.equal(written.longPress.active, false);
  assert.equal(shouldActivateTemporaryEraser(written.longPress, Date.now() + 5000), false);
});

test("lasso commits and paints exactly once, a miss does neither, and the next pen remains usable", () => {
  let paints = 0, saves = 0;
  const r = runtime({ render: () => { paints++; return true; }, persist: () => { saves++; } });
  r.strokesRef.current = [{ tool:'pen',points:[{x:.3,y:.3}] },{ tool:'pen',points:[{x:.8,y:.8}] }];
  const circle = () => {
    r.controller.handlePointerDown(r.event('pointerdown',10));
    Object.assign(r.activeRef.current, { moved:true, stroke:{tool:'lasso',points:[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.5},{x:.1,y:.5}]} });
    r.controller.handlePointerUp(r.event('pointerup',10));
  };
  circle(); assert.equal(saves,1); assert.equal(paints,1); assert.equal(r.strokesRef.current.length,1);
  circle(); assert.equal(saves,1); assert.equal(paints,1);
  r.stroke(2); assert.equal(r.strokesRef.current.length,2);
  r.controller.dispose();
});


test("lasso erases all visible stored ink and undo restores the exact originals", () => {
  const old = { tool: "pen", width: 2, points: [{ x: .2, y: .2 }] };
  let visible = [old];
  const r = runtime({ extra: {
    toolRef: { current: "eraser" }, eraserModeRef: { current: "lasso" },
    erasureSource: () => visible,
    persistErasure: (next) => { visible = next; },
    captureUndo: () => { const before = visible; return () => { visible = before; }; },
  } });
  for (const [type, x, y] of [["pointerdown", 10, 10], ["pointermove", 40, 10], ["pointermove", 40, 40], ["pointermove", 10, 40], ["pointerup", 10, 10]]) {
    r.controller[type === "pointerdown" ? "handlePointerDown" : type === "pointerup" ? "handlePointerUp" : "handlePointerMove"]({ ...r.event(type, x), clientY: y });
  }
  assert.deepEqual(visible, [], "the visible old-stage stroke must disappear at pointerup");
  assert.equal(r.controller.canUndo(), true);
  r.controller.undo();
  assert.equal(visible[0], old);
  r.controller.dispose();
});

test("undo includes ordinary eraser and then the preceding pen operation", () => {
  const r = runtime(); r.stroke();
  const original = r.strokesRef.current;
  r.controller.setDeps({ toolRef: { current: "eraser" } }); r.stroke(2);
  assert.equal(r.strokesRef.current.length, 2);
  r.controller.undo(); assert.deepEqual(r.strokesRef.current, original);
  r.controller.undo(); assert.deepEqual(r.strokesRef.current, []);
  r.controller.dispose();
});


test("undo patch preserves exact stroke identity and ordering after mixed deletion", async () => {
  const { createInkUndoPatch } = await import("../src/ink/inkUndo.js");
  const before = Array.from({ length: 6 }, (_, id) => ({ id }));
  const extra = { id: 7 };
  const after = [before[1], before[4], extra];
  const restored = createInkUndoPatch(before, after)(after);
  assert.deepEqual(restored, before);
  restored.forEach((stroke, index) => assert.equal(stroke, before[index]));
});

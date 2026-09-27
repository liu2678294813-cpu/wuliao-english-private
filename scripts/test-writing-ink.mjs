import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

await import("./test-hooks.mjs");

const {
  createWritingInkAdapter,
  WritingInkSurfaceError,
} = await import("../src/writing/writingInkAdapter.js");
const {
  createWritingInkGeometryAdapter,
  createWritingPageGeometrySnapshot,
  finalizeWritingStrokeGeometry,
  isVisionRenderableWritingStroke,
  measureWritingInkContainer,
  projectWritingStroke,
  WRITING_INK_COORDINATE_SPACE,
  WRITING_PAGE_ASPECT_RATIO,
  WRITING_PAGE_CANONICAL_SIZE,
  writingInkPointToPixel,
} = await import("../src/writing/writingInkGeometry.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertPointClose(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(actual.x - expected.x) <= epsilon, `expected x=${expected.x}, received ${actual.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= epsilon, `expected y=${expected.y}, received ${actual.y}`);
}

function identity(overrides = {}) {
  return {
    username: "alice",
    sessionId: "session-1",
    surfaceId: "w7:independent:attempt-a",
    stageId: "W7_INDEPENDENT",
    ownerRecordId: "attempt-a",
    sourceFingerprint: "source-a",
    ...overrides,
  };
}

function recordKey(value) {
  return `${value.username}::${value.sessionId}::${value.surfaceId}`;
}

function createMemoryPersistence() {
  const records = new Map();
  const reads = [];
  const writes = [];
  let readOverride = null;
  let saveFailure = null;
  let saveGate = null;

  return {
    records,
    reads,
    writes,
    setReadOverride(value) { readOverride = value; },
    failSavesWith(error) { saveFailure = error; },
    delayNextSave() {
      let release;
      saveGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    async getSnapshot(args) {
      reads.push(clone(args));
      if (readOverride) return typeof readOverride === "function" ? readOverride(args) : clone(readOverride);
      const stored = records.get(recordKey(args));
      if (!stored) return { status: "missing", snapshot: null };
      if (stored.sourceFingerprint !== args.expectedSourceFingerprint) {
        return { status: "source-mismatch", snapshot: null, revision: stored.revision };
      }
      return { status: "ok", snapshot: clone(stored) };
    },
    async saveSnapshot(args) {
      writes.push(clone(args));
      if (saveGate) {
        const gate = saveGate;
        saveGate = null;
        await gate;
      }
      if (saveFailure) throw saveFailure;
      const key = recordKey(args);
      const existing = records.get(key);
      const actualRevision = existing?.revision || 0;
      if (actualRevision !== args.expectedRevision) {
        const error = new Error("stale");
        error.code = "stale-revision";
        throw error;
      }
      if (existing && existing.sourceFingerprint !== args.sourceFingerprint) {
        const error = new Error("source mismatch");
        error.code = "source-mismatch";
        throw error;
      }
      const revision = actualRevision + 1;
      const snapshot = {
        schemaVersion: 1,
        id: key,
        username: args.username,
        sessionId: args.sessionId,
        surfaceId: args.surfaceId,
        stageId: args.stageId,
        ownerRecordId: args.ownerRecordId,
        sourceFingerprint: args.sourceFingerprint,
        revision,
        strokes: clone(args.strokes),
        fingerprint: `verified-${key}-${revision}`,
        updatedAt: revision,
      };
      records.set(key, snapshot);
      return clone(snapshot);
    },
  };
}

function createAdapter(store, callbacks = {}, options = {}) {
  return createWritingInkAdapter({
    getSnapshot: store.getSnapshot.bind(store),
    saveSnapshot: store.saveSnapshot.bind(store),
    autosaveDelay: 60_000,
    ...callbacks,
    ...options,
  });
}

test("A restore: missing mounts an explicit empty runtime copy", async () => {
  const store = createMemoryPersistence();
  const observed = [];
  const adapter = createAdapter(store, { onStrokesChange: (next) => observed.push(next) });
  const mounted = await adapter.attach(identity());
  assert.equal(mounted.status, "missing");
  assert.deepEqual(mounted.strokes, []);
  assert.deepEqual(observed.at(-1), []);
  assert.equal(adapter.isInteractive(), true);
});

test("A restore: saved committed strokes restore exactly and publish a verified ref", async () => {
  const store = createMemoryPersistence();
  const source = identity();
  const seed = createAdapter(store);
  await seed.attach(source);
  seed.replaceCommitted([{ tool: "pen", points: [{ x: 0.2, y: 0.3 }] }]);
  const seededRef = await seed.flush();

  const refs = [];
  const restored = createAdapter(store, { onInkRefChange: (ref) => refs.push(ref) });
  const mounted = await restored.attach(source);
  assert.deepEqual(mounted.strokes, [{ tool: "pen", points: [{ x: 0.2, y: 0.3 }] }]);
  assert.deepEqual(refs.at(-1), seededRef);
});

test("A restore: damaged and source-mismatch fail closed with explicit errors", async () => {
  for (const failureStatus of ["damaged", "source-mismatch"]) {
    const store = createMemoryPersistence();
    store.setReadOverride({ status: failureStatus, snapshot: null, revision: 4 });
    const errors = [];
    const exposed = [];
    const adapter = createAdapter(store, {
      onError: (error) => errors.push(error),
      onStrokesChange: (next) => exposed.push(next),
    });
    const mounted = await adapter.attach(identity());
    assert.equal(mounted.status, failureStatus);
    assert.deepEqual(mounted.strokes, []);
    assert.equal(errors.at(-1).code, failureStatus);
    assert.deepEqual(exposed.at(-1), []);
    assert.equal(adapter.isInteractive(), false);
  }
});

test("A restore: account scope is part of identity and never exposes another account's strokes", async () => {
  const store = createMemoryPersistence();
  const alice = identity();
  const seed = createAdapter(store);
  await seed.attach(alice);
  seed.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
  await seed.flush();

  const bob = createAdapter(store);
  const mounted = await bob.attach(identity({ username: "bob" }));
  assert.equal(mounted.status, "missing");
  assert.deepEqual(mounted.strokes, []);
});

test("A restore: a mounted owner mismatch never exposes an otherwise valid snapshot", async () => {
  const store = createMemoryPersistence();
  const valid = identity();
  const seed = createAdapter(store);
  await seed.attach(valid);
  seed.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
  await seed.flush();

  const errors = [];
  const mismatched = createAdapter(store, { onError: (error) => errors.push(error) });
  const mounted = await mismatched.attach(identity({ ownerRecordId: "attempt-wrong" }));
  assert.equal(mounted.status, "identity-mismatch");
  assert.deepEqual(mounted.strokes, []);
  assert.equal(errors.at(-1).code, "identity-mismatch");
});

test("B persist: committed change saves once; unchanged flushes keep the verified revision", async () => {
  const store = createMemoryPersistence();
  const adapter = createAdapter(store);
  await adapter.attach(identity());
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }]);
  const first = await adapter.flush();
  const second = await adapter.flush();
  const third = await adapter.flush();
  assert.equal(store.writes.length, 1);
  assert.equal(first.revision, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);

  adapter.replaceCommitted([...adapter.getState().strokes, { tool: "pen", points: [{ x: 0.4, y: 0.4 }] }]);
  const changed = await adapter.flush();
  assert.equal(store.writes.length, 2);
  assert.equal(changed.revision, 2);
});

test("B pending mutation undone before autosave returns to a clean ready state without writing", async () => {
  const store = createMemoryPersistence();
  const adapter = createAdapter(store);
  await adapter.attach(identity());
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
  assert.equal(adapter.getState().status, "pending");
  adapter.undo();
  assert.equal(adapter.getState().status, "missing");
  assert.equal(adapter.getState().dirty, false);
  assert.equal(await adapter.flush(), null);
  assert.equal(store.writes.length, 0);
});

class FakeElement {
  constructor(rect = { left: 10, top: 20, width: 500, height: 800 }) {
    this.rect = rect;
  }
  closest() { return null; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture() {}
}

function recordingContext() {
  const commands = [];
  return new Proxy({ commands }, {
    get(target, prop) {
      if (!(prop in target)) target[prop] = (...args) => commands.push([prop, ...args]);
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function fakeCanvas(context) {
  return {
    dataset: { ratio: "1" },
    width: 500,
    height: 800,
    clientWidth: 500,
    clientHeight: 800,
    getContext: () => context,
  };
}

function pointerEvent(type, x, y, pointerId = 1) {
  return {
    type,
    pointerType: "pen",
    pointerId,
    button: 0,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    nativeEvent: {
      pointerType: "pen",
      pointerId,
      clientX: x,
      clientY: y,
      pressure: 0.5,
      getCoalescedEvents: () => [],
    },
    target: new FakeElement(),
    preventDefault() {},
  };
}

if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.Element) globalThis.Element = FakeElement;
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);
if (!globalThis.navigator) globalThis.navigator = { vibrate() {} };

const runtime = await import("../src/ink/inkRuntime.js");

function defaultPageRegions(surfaceRect) {
  return [{
    pageId: "page-1",
    rect: {
      left: surfaceRect.left,
      top: surfaceRect.top,
      width: surfaceRect.width,
      height: surfaceRect.width / WRITING_PAGE_ASPECT_RATIO,
    },
  }];
}

function createGeometrySnapshot(surfaceRect, pageRegions = defaultPageRegions(surfaceRect)) {
  return createWritingPageGeometrySnapshot(new FakeElement(surfaceRect), pageRegions);
}

function pointOnPage(surfaceRect, pageRect, x, y) {
  return {
    x: (pageRect.left - surfaceRect.left + x * pageRect.width) / surfaceRect.width,
    y: (pageRect.top - surfaceRect.top + y * pageRect.height) / surfaceRect.height,
  };
}

function createRuntimeAdapterHarness(store, surfaceIdentity = identity(), options = {}) {
  const strokesRef = { current: [] };
  const activeRef = { current: null };
  const toolRef = { current: "pen" };
  const eraserModeRef = { current: "normal" };
  const surfaceRect = options.surfaceRect || { left: 10, top: 20, width: 500, height: 800 };
  const surfaceElement = new FakeElement(surfaceRect);
  const geometryErrors = [];
  const snapshotRef = {
    current: createGeometrySnapshot(surfaceRect, options.pageRegions || defaultPageRegions(surfaceRect)),
  };
  const geometryAdapter = createWritingInkGeometryAdapter({
    getSnapshot: () => snapshotRef.current,
    onError: (error) => geometryErrors.push(error),
  });
  const adapter = createAdapter(store, {
    onStrokesChange(next) { strokesRef.current = next; },
  });
  const controller = runtime.createInkRuntimeController({
    canInteract: () => adapter.isInteractive(),
    surfaceRef: { current: surfaceElement },
    previewCanvasRef: { current: fakeCanvas(recordingContext()) },
    strokesRef,
    activeRef,
    toolRef,
    colorRef: { current: "#173a62" },
    penSizeRef: { current: 2.6 },
    penModeRef: { current: "ballpoint" },
    eraserModeRef,
    eraserSizeRef: { current: 24 },
    commitAppendStroke: () => true,
    renderCommitted: () => true,
    persistStrokes: (next, options) => adapter.replaceCommitted(next, options),
    engineForPen: () => false,
    geometryAdapter,
  });
  return {
    adapter,
    controller,
    strokesRef,
    activeRef,
    toolRef,
    eraserModeRef,
    surfaceIdentity,
    surfaceElement,
    snapshotRef,
    geometryAdapter,
    geometryErrors,
  };
}

function drawStroke(harness, offset = 0, pointerId = 1) {
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 50 + offset, 60 + offset, pointerId));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 90 + offset, 100 + offset, pointerId));
  harness.controller.handlePointerUp(pointerEvent("pointerup", 120 + offset, 130 + offset, pointerId));
}

test("B shared runtime: pointermove never persists; finalized committed stroke does", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  for (let index = 0; index < 5; index += 1) {
    harness.controller.handlePointerMove(pointerEvent("pointermove", 70 + index * 5, 80 + index * 5));
  }
  assert.equal(store.writes.length, 0);
  assert.equal(harness.adapter.getState().dirty, false);
  harness.controller.handlePointerUp(pointerEvent("pointerup", 110, 120));
  assert.equal(harness.adapter.getState().dirty, true);
  await harness.adapter.flush();
  assert.equal(store.writes.length, 1);
});

test("C undo persists the previous committed operation and reload restores it", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  drawStroke(harness, 0, 1);
  drawStroke(harness, 160, 2);
  await harness.adapter.flush();
  assert.equal(harness.adapter.getState().strokes.length, 2);
  harness.adapter.undo();
  await harness.adapter.flush();

  const reloaded = createAdapter(store);
  const mounted = await reloaded.attach(harness.surfaceIdentity);
  assert.equal(mounted.strokes.length, 1);
  assert.equal(mounted.strokes[0].tool, "pen");
});

test("C clear writes a legal empty snapshot without deleting the owner record", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  drawStroke(harness);
  const before = await harness.adapter.flush();
  harness.adapter.clear();
  const cleared = await harness.adapter.flush();
  assert.equal(cleared.revision, before.revision + 1);
  assert.equal(cleared.ownerRecordId, harness.surfaceIdentity.ownerRecordId);
  assert.deepEqual(store.records.get(recordKey(harness.surfaceIdentity)).strokes, []);

  const reloaded = createAdapter(store);
  assert.deepEqual((await reloaded.attach(harness.surfaceIdentity)).strokes, []);
});

test("D normal eraser uses Shared Runtime semantics and remains after reload", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  drawStroke(harness);
  harness.toolRef.current = "eraser";
  harness.eraserModeRef.current = "normal";
  drawStroke(harness, 0, 2);
  await harness.adapter.flush();
  assert.equal(harness.adapter.getState().strokes.at(-1).tool, "eraser");
  assert.equal(harness.adapter.getState().strokes.at(-1).version, 2);

  const reloaded = createAdapter(store);
  const mounted = await reloaded.attach(harness.surfaceIdentity);
  assert.equal(mounted.strokes.at(-1).tool, "eraser");
});

test("D lasso deletion comes from Shared Runtime and erased strokes do not return", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  harness.adapter.replaceCommitted([
    { tool: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
    { tool: "pen", points: [{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }] },
  ]);
  await harness.adapter.flush();
  harness.toolRef.current = "eraser";
  harness.eraserModeRef.current = "lasso";
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 20, 30));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 80, 40));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 80, 120));
  harness.controller.handlePointerUp(pointerEvent("pointerup", 40, 130));
  await harness.adapter.flush();
  assert.equal(harness.adapter.getState().strokes.length, 1);
  assert.deepEqual(harness.adapter.getState().strokes[0].points[0], { x: 0.8, y: 0.8 });

  const reloaded = createAdapter(store);
  assert.equal((await reloaded.attach(harness.surfaceIdentity)).strokes.length, 1);
});

test("D page-local projection keeps a page-1 lasso from deleting page-2 strokes", async () => {
  const store = createMemoryPersistence();
  const surfaceRect = { left: 10, top: 20, width: 500, height: 1000 };
  const pageWidth = 300;
  const pageHeight = pageWidth / WRITING_PAGE_ASPECT_RATIO;
  const page1 = { left: 80, top: 40, width: pageWidth, height: pageHeight };
  const page2 = { left: 80, top: 550, width: pageWidth, height: pageHeight };
  const pageRegions = [
    { pageId: "page-1", rect: page1 },
    { pageId: "page-2", rect: page2 },
  ];
  const harness = createRuntimeAdapterHarness(store, identity(), { surfaceRect, pageRegions });
  await harness.adapter.attach(harness.surfaceIdentity);
  const snapshot = harness.snapshotRef.current;
  const strokeA = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [
      pointOnPage(surfaceRect, page1, 0.4, 0.4),
      pointOnPage(surfaceRect, page1, 0.5, 0.5),
    ],
  }, snapshot);
  const strokeB = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [
      pointOnPage(surfaceRect, page2, 0.4, 0.4),
      pointOnPage(surfaceRect, page2, 0.5, 0.5),
    ],
  }, snapshot);
  harness.adapter.replaceCommitted([strokeA, strokeB]);
  await harness.adapter.flush();

  harness.toolRef.current = "eraser";
  harness.eraserModeRef.current = "lasso";
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 170, 170, 9));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 270, 170, 9));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 270, 290, 9));
  harness.controller.handlePointerUp(pointerEvent("pointerup", 170, 290, 9));
  await harness.adapter.flush();

  assert.equal(harness.adapter.getState().strokes.length, 1);
  assert.deepEqual(harness.adapter.getState().strokes[0], strokeB);
  assert.equal(harness.adapter.getState().strokes[0].writingAnchor.pageId, "page-2");
  const reloaded = createAdapter(store);
  assert.deepEqual((await reloaded.attach(harness.surfaceIdentity)).strokes, [strokeB]);
});

test("E flush finalizes an in-flight Shared Runtime stroke before awaiting verified persistence", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 50, 60));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 90, 100));
  assert.ok(harness.activeRef.current);
  harness.controller.finishActiveForGeometryChange();
  const ref = await harness.adapter.flush();
  assert.equal(harness.activeRef.current, null);
  assert.equal(ref.revision, 1);
  assert.equal(store.records.get(recordKey(harness.surfaceIdentity)).strokes.length, 1);
});

test("E flush waits for persistence completion and rejects instead of returning a fake ref", async () => {
  const store = createMemoryPersistence();
  const adapter = createAdapter(store);
  await adapter.attach(identity());
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.2 }] }]);
  const release = store.delayNextSave();
  let settled = false;
  const pending = adapter.flush().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  release();
  await pending;
  assert.equal(settled, true);

  const failingStore = createMemoryPersistence();
  const failing = createAdapter(failingStore);
  await failing.attach(identity());
  failing.replaceCommitted([{ tool: "pen", points: [{ x: 0.3, y: 0.4 }] }]);
  failingStore.failSavesWith(Object.assign(new Error("disk unavailable"), { code: "write-error" }));
  await assert.rejects(() => failing.flush(), (error) => {
    assert.ok(error instanceof WritingInkSurfaceError);
    assert.equal(error.code, "flush-failed");
    return true;
  });
  assert.equal(failing.getState().dirty, true);
});

test("F geometry: a single page produces explicit stable page-local canonical points", () => {
  const surfaceRect = { left: 100, top: 50, width: 1000, height: 1600 };
  const pageRect = {
    left: 250,
    top: 100,
    width: 600,
    height: 600 / WRITING_PAGE_ASPECT_RATIO,
  };
  const snapshot = createGeometrySnapshot(surfaceRect, [{ pageId: "page-1", rect: pageRect }]);
  const first = pointOnPage(surfaceRect, pageRect, 0.25, 0.4);
  const second = pointOnPage(surfaceRect, pageRect, 0.75, 0.6);
  const source = { tool: "pen", points: [first, second] };
  const canonical = finalizeWritingStrokeGeometry(source, snapshot);

  assert.equal(WRITING_PAGE_ASPECT_RATIO, 1 / Math.sqrt(2));
  assert.deepEqual(WRITING_PAGE_CANONICAL_SIZE, { width: 1, height: Math.sqrt(2) });
  assert.equal(canonical.coordinateSpace, WRITING_INK_COORDINATE_SPACE);
  assert.deepEqual(canonical.writingAnchor, { version: 1, pageId: "page-1" });
  assertPointClose(canonical.points[0].writingLocal, { x: 0.25, y: 0.4 });
  assertPointClose(canonical.points[1].writingLocal, { x: 0.75, y: 0.6 });
  assert.deepEqual(canonical.points.map(({ x, y }) => ({ x, y })), [first, second]);
  assert.equal(isVisionRenderableWritingStroke(canonical), true);
});

test("F geometry: two logical pages canonicalize independently instead of using the container", () => {
  const surfaceRect = { left: 20, top: 30, width: 900, height: 2100 };
  const pageWidth = 600;
  const pageHeight = pageWidth / WRITING_PAGE_ASPECT_RATIO;
  const page1 = { left: 120, top: 70, width: pageWidth, height: pageHeight };
  const page2 = { left: 120, top: 1100, width: pageWidth, height: pageHeight };
  const snapshot = createGeometrySnapshot(surfaceRect, [
    { pageId: "page-1", rect: page1 },
    { pageId: "page-2", rect: page2 },
  ]);
  const strokeA = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [pointOnPage(surfaceRect, page1, 0.2, 0.3)],
  }, snapshot);
  const strokeB = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [pointOnPage(surfaceRect, page2, 0.2, 0.3)],
  }, snapshot);

  assert.equal(strokeA.writingAnchor.pageId, "page-1");
  assert.equal(strokeB.writingAnchor.pageId, "page-2");
  assertPointClose(strokeA.points[0].writingLocal, { x: 0.2, y: 0.3 });
  assertPointClose(strokeB.points[0].writingLocal, { x: 0.2, y: 0.3 });
  assert.notEqual(strokeA.points[0].y, strokeB.points[0].y);
});

test("F geometry: adding page 2 and resizing never renormalizes page-1 canonical data", () => {
  const initialSurface = { left: 0, top: 0, width: 800, height: 1100 };
  const initialPage = { left: 100, top: 40, width: 600, height: 600 / WRITING_PAGE_ASPECT_RATIO };
  const initialSnapshot = createGeometrySnapshot(initialSurface, [{ pageId: "page-1", rect: initialPage }]);
  const canonical = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [pointOnPage(initialSurface, initialPage, 0.4, 0.7)],
  }, initialSnapshot);
  const persistedCopy = clone(canonical);

  const expandedSurface = { left: 0, top: 0, width: 1000, height: 2400 };
  const resizedPage1 = { left: 150, top: 60, width: 700, height: 700 / WRITING_PAGE_ASPECT_RATIO };
  const addedPage2 = { left: 150, top: 1250, width: 700, height: 700 / WRITING_PAGE_ASPECT_RATIO };
  const expandedSnapshot = createGeometrySnapshot(expandedSurface, [
    { pageId: "page-1", rect: resizedPage1 },
    { pageId: "page-2", rect: addedPage2 },
  ]);
  const projected = projectWritingStroke(canonical, expandedSnapshot);

  assert.equal(finalizeWritingStrokeGeometry(canonical, expandedSnapshot), canonical);
  assert.deepEqual(canonical, persistedCopy);
  assert.deepEqual(projected.points[0].writingLocal, persistedCopy.points[0].writingLocal);
  assertPointClose(
    { x: projected.points[0].x, y: projected.points[0].y },
    pointOnPage(expandedSurface, resizedPage1, 0.4, 0.7),
  );
  assert.notDeepEqual(
    { x: projected.points[0].x, y: projected.points[0].y },
    { x: canonical.points[0].x, y: canonical.points[0].y },
  );
});

test("F geometry: resize changes only projection and never adds a persisted revision", async () => {
  const store = createMemoryPersistence();
  const adapter = createAdapter(store);
  await adapter.attach(identity());
  const surface = { left: 0, top: 0, width: 800, height: 1200 };
  const oldPage = { left: 100, top: 40, width: 600, height: 600 / WRITING_PAGE_ASPECT_RATIO };
  const canonical = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [pointOnPage(surface, oldPage, 0.25, 0.5)],
  }, createGeometrySnapshot(surface, [{ pageId: "page-1", rect: oldPage }]));
  adapter.replaceCommitted([canonical]);
  const ref = await adapter.flush();
  const beforeWrites = store.writes.length;
  const beforeCanonical = clone(adapter.getState().strokes);

  const resizedSurface = { left: 0, top: 0, width: 1200, height: 1600 };
  const resizedPage = { left: 180, top: 80, width: 840, height: 840 / WRITING_PAGE_ASPECT_RATIO };
  const projected = projectWritingStroke(canonical, createGeometrySnapshot(
    resizedSurface,
    [{ pageId: "page-1", rect: resizedPage }],
  ));
  const dimensions = measureWritingInkContainer(new FakeElement(resizedSurface), 2);

  assert.deepEqual(
    writingInkPointToPixel(projected.points[0], dimensions),
    [projected.points[0].x * resizedSurface.width, projected.points[0].y * resizedSurface.height],
  );
  assert.deepEqual(adapter.getState().strokes, beforeCanonical);
  assert.deepEqual(await adapter.flush(), ref);
  assert.equal(store.writes.length, beforeWrites);
});

test("F geometry: no-page and ambiguous strokes fail closed with their global fallback", () => {
  const surface = { left: 0, top: 0, width: 500, height: 900 };
  const page = { left: 50, top: 50, width: 400, height: 400 / WRITING_PAGE_ASPECT_RATIO };
  const errors = [];
  let snapshot = createGeometrySnapshot(surface, [{ pageId: "page-1", rect: page }]);
  const geometryAdapter = createWritingInkGeometryAdapter({
    getSnapshot: () => snapshot,
    onError: (error) => errors.push(error),
  });
  const outside = { tool: "pen", points: [{ x: 0.5, y: 0.95 }] };

  assert.equal(geometryAdapter.finalizeStroke(outside), outside);
  assert.equal(errors.at(-1).code, "writing-geometry-no-page");
  assert.equal(isVisionRenderableWritingStroke(outside), false);

  snapshot = createGeometrySnapshot(surface, [
    { pageId: "page-1", rect: page },
    { pageId: "page-2", rect: page },
  ]);
  const ambiguous = { tool: "pen", points: [{ x: 0.5, y: 0.3 }] };
  assert.equal(geometryAdapter.finalizeStroke(ambiguous), ambiguous);
  assert.equal(errors.at(-1).code, "writing-geometry-ambiguous-page");
  assert.equal(isVisionRenderableWritingStroke(ambiguous), false);

  const canonical = finalizeWritingStrokeGeometry({
    tool: "pen",
    points: [pointOnPage(surface, page, 0.5, 0.5)],
  }, createGeometrySnapshot(surface, [{ pageId: "page-1", rect: page }]));
  snapshot = createGeometrySnapshot(surface, []);
  assert.equal(geometryAdapter.projectStroke(canonical), canonical);
  assert.equal(errors.at(-1).code, "writing-geometry-missing-page");
  assert.throws(
    () => createGeometrySnapshot(surface, [{ rect: page }]),
    (error) => error.code === "writing-geometry-invalid-page-id",
  );
});

test("F geometry: runtime persists a no-page committed stroke only as non-Vision global fallback", async () => {
  const store = createMemoryPersistence();
  const harness = createRuntimeAdapterHarness(store);
  await harness.adapter.attach(harness.surfaceIdentity);
  harness.controller.handlePointerDown(pointerEvent("pointerdown", 120, 760, 11));
  harness.controller.handlePointerMove(pointerEvent("pointermove", 150, 775, 11));
  harness.controller.handlePointerUp(pointerEvent("pointerup", 180, 790, 11));
  const ref = await harness.adapter.flush();
  const fallback = harness.adapter.getState().strokes[0];

  assert.equal(ref.revision, 1);
  assert.equal(harness.geometryErrors.at(-1).code, "writing-geometry-no-page");
  assert.equal(fallback.coordinateSpace, undefined);
  assert.equal(isVisionRenderableWritingStroke(fallback), false);
  assert.ok(fallback.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.deepEqual(store.records.get(recordKey(harness.surfaceIdentity)).strokes, [fallback]);
});

test("F geometry: reload preserves two-page canonical data and reprojects against new rects", async () => {
  const store = createMemoryPersistence();
  const source = identity();
  const surface = { left: 0, top: 0, width: 800, height: 1900 };
  const page1 = { left: 100, top: 30, width: 600, height: 600 / WRITING_PAGE_ASPECT_RATIO };
  const page2 = { left: 100, top: 990, width: 600, height: 600 / WRITING_PAGE_ASPECT_RATIO };
  const snapshot = createGeometrySnapshot(surface, [
    { pageId: "page-1", rect: page1 },
    { pageId: "page-2", rect: page2 },
  ]);
  const canonical = [
    finalizeWritingStrokeGeometry({ tool: "pen", points: [pointOnPage(surface, page1, 0.3, 0.4)] }, snapshot),
    finalizeWritingStrokeGeometry({ tool: "pen", points: [pointOnPage(surface, page2, 0.6, 0.7)] }, snapshot),
  ];
  const first = createAdapter(store);
  await first.attach(source);
  first.replaceCommitted(canonical);
  await first.flush();
  await first.dispose();

  const reloaded = createAdapter(store);
  const mounted = await reloaded.attach(source);
  assert.deepEqual(mounted.strokes, canonical);

  const newSurface = { left: 50, top: 25, width: 1000, height: 2300 };
  const newPage1 = { left: 150, top: 75, width: 700, height: 700 / WRITING_PAGE_ASPECT_RATIO };
  const newPage2 = { left: 150, top: 1250, width: 700, height: 700 / WRITING_PAGE_ASPECT_RATIO };
  const newSnapshot = createGeometrySnapshot(newSurface, [
    { pageId: "page-1", rect: newPage1 },
    { pageId: "page-2", rect: newPage2 },
  ]);
  const projected = mounted.strokes.map((stroke) => projectWritingStroke(stroke, newSnapshot));

  assert.deepEqual(projected.map((stroke) => stroke.writingAnchor.pageId), ["page-1", "page-2"]);
  assertPointClose(projected[0].points[0].writingLocal, { x: 0.3, y: 0.4 });
  assertPointClose(projected[1].points[0].writingLocal, { x: 0.6, y: 0.7 });
  assert.deepEqual(mounted.strokes, canonical);
});

test("F geometry: Vision readiness rejects incomplete or out-of-range page-local data", () => {
  const valid = {
    tool: "pen",
    coordinateSpace: WRITING_INK_COORDINATE_SPACE,
    writingAnchor: { version: 1, pageId: "page-1" },
    points: [{ x: 0.2, y: 0.3, writingLocal: { x: 0, y: 1 } }],
  };
  assert.equal(isVisionRenderableWritingStroke(valid), true);
  assert.equal(isVisionRenderableWritingStroke({ ...valid, writingAnchor: { version: 1, pageId: "" } }), false);
  assert.equal(isVisionRenderableWritingStroke({
    ...valid,
    points: [{ ...valid.points[0], writingLocal: { x: -0.01, y: 0.5 } }],
  }), false);
  assert.equal(isVisionRenderableWritingStroke({
    ...valid,
    points: [{ ...valid.points[0], writingLocal: { x: null, y: 0.5 } }],
  }), false);
  assert.equal(isVisionRenderableWritingStroke({ ...valid, coordinateSpace: "surface-v1" }), false);
});

test("G identity and account switches flush old ownership before exposing the new surface", async () => {
  const store = createMemoryPersistence();
  const observed = [];
  const adapter = createAdapter(store, { onStrokesChange: (next) => observed.push(clone(next)) });
  const surfaceA = identity();
  const surfaceB = identity({
    username: "bob",
    sessionId: "session-2",
    surfaceId: "w7:independent:attempt-b",
    ownerRecordId: "attempt-b",
    sourceFingerprint: "source-b",
  });
  await adapter.attach(surfaceA);
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
  const release = store.delayNextSave();
  const switching = adapter.attach(surfaceB);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.getState().status, "switching");
  release();
  const mountedB = await switching;
  assert.equal(mountedB.identity.username, "bob");
  assert.equal(mountedB.status, "missing");
  assert.deepEqual(mountedB.strokes, []);
  assert.deepEqual(observed.at(-1), []);
  assert.equal(store.records.get(recordKey(surfaceA)).strokes.length, 1);
  assert.equal(store.records.has(recordKey(surfaceB)), false);
});

test("G a late restore from A never publishes strokes after B has been requested", async () => {
  const store = createMemoryPersistence();
  const surfaceA = identity();
  const surfaceB = identity({
    surfaceId: "w7:independent:attempt-b",
    ownerRecordId: "attempt-b",
    sourceFingerprint: "source-b",
  });
  store.records.set(recordKey(surfaceA), {
    schemaVersion: 1,
    id: recordKey(surfaceA),
    ...surfaceA,
    revision: 1,
    strokes: [{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }],
    fingerprint: "verified-a-1",
    updatedAt: 1,
  });
  const originalGet = store.getSnapshot.bind(store);
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  store.getSnapshot = async (args) => {
    if (args.surfaceId === surfaceA.surfaceId) await readGate;
    return originalGet(args);
  };
  const observed = [];
  const adapter = createAdapter(store, { onStrokesChange: (next) => observed.push(clone(next)) });
  const mountingA = adapter.attach(surfaceA);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mountingB = adapter.attach(surfaceB);
  releaseRead();
  await Promise.all([mountingA, mountingB]);
  assert.ok(observed.every((entry) => entry.length === 0));
  assert.equal(adapter.getState().identity.surfaceId, surfaceB.surfaceId);
});

test("G a late verified save for A cannot publish A's InkRef into requested surface B", async () => {
  const store = createMemoryPersistence();
  const surfaceA = identity();
  const surfaceB = identity({
    surfaceId: "w7:independent:attempt-b",
    ownerRecordId: "attempt-b",
    sourceFingerprint: "source-b",
  });
  const refs = [];
  const adapter = createAdapter(store, { onInkRefChange: (ref) => refs.push(ref) });
  await adapter.attach(surfaceA);
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.2, y: 0.2 }] }]);
  const releaseSave = store.delayNextSave();
  const switching = adapter.attach(surfaceB);
  await new Promise((resolve) => setTimeout(resolve, 5));
  refs.length = 0;
  releaseSave();
  await switching;
  assert.ok(refs.every((ref) => ref === null || ref.surfaceId === surfaceB.surfaceId));
  assert.equal(store.records.get(recordKey(surfaceA)).surfaceId, surfaceA.surfaceId);
});

test("G failed old-surface autosave cannot leak state or revision into the new owner", async () => {
  const store = createMemoryPersistence();
  const errors = [];
  const adapter = createAdapter(store, { onError: (error) => errors.push(error) });
  const surfaceA = identity();
  const surfaceB = identity({
    surfaceId: "w7:independent:attempt-b",
    ownerRecordId: "attempt-b",
    sourceFingerprint: "source-b",
  });
  await adapter.attach(surfaceA);
  adapter.replaceCommitted([{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
  store.failSavesWith(new Error("old write failed"));
  const mountedB = await adapter.attach(surfaceB);
  assert.equal(mountedB.identity.ownerRecordId, "attempt-b");
  assert.deepEqual(mountedB.strokes, []);
  assert.equal(mountedB.revision, 0);
  assert.ok(errors.every((error) => error.identity?.surfaceId !== surfaceB.surfaceId));
  assert.ok(errors.some((error) => error.code === "flush-failed" && error.identity?.surfaceId === surfaceA.surfaceId));
});

test("I static contract: Writing consumes Shared Runtime and exposes the outer AnnotationToolbar bridge", async () => {
  const surface = readFileSync(new URL("../src/writing/WritingInkSurface.jsx", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../src/writing/writingInkAdapter.js", import.meta.url), "utf8");
  const geometry = readFileSync(new URL("../src/writing/writingInkGeometry.js", import.meta.url), "utf8");
  assert.match(surface, /useStructuredInk/);
  assert.match(surface, /onToolbarApiChange/);
  assert.match(surface, /onFlushHandleChange/);
  assert.match(surface, /finishActiveForGeometryChange/);
  assert.match(surface, /pageRegions/);
  assert.match(geometry, /resolveWritingPage/);
  assert.match(geometry, /toWritingLocalPoint/);
  assert.match(geometry, /projectWritingLocalPoint/);
  assert.match(geometry, /finalizeWritingStrokeGeometry/);
  assert.match(geometry, /projectWritingStroke/);
  assert.match(geometry, /writing-page-v1/);
  assert.doesNotMatch(surface, /function handlePointer(?:Down|Move|Up)/);
  assert.doesNotMatch(surface, /eraseAnnotationsAlongPath|eraseAnnotationsInPolygon/);
  assert.doesNotMatch(`${surface}\n${adapter}`, /localStorage|sessionStorage/);
  assert.doesNotMatch(geometry, /document|querySelector|WritingStage|saveWritingInkSnapshot|Date\.now|Math\.random/);

  const { createViteModuleRunner } = await import("./vite-module-runner.mjs");
  const vite = await createViteModuleRunner(fileURLToPath(new URL("..", import.meta.url)));
  try {
    const loaded = await vite.import("/src/writing/WritingInkSurface.jsx");
    assert.equal(typeof loaded.default, "function");
  } finally {
    await vite.close();
  }
});

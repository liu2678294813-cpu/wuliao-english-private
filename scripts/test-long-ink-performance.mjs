import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createDeepInkChangeSource, createDeepInkStageCache, createDeepInkTileIndex } from "../src/deepInkRenderCache.js";
import { reuseDeepInkGeometry } from "../src/deepInkGeometry.js";
import { createInkTileBitmapCache, createInkTileRenderer } from "../src/ink/inkTileRenderer.js";
import { packInkTileStrokes, unpackInkTileStrokes } from "../src/ink/inkTileTransfer.js";

const stroke = (y, overrides = {}) => ({
  tool: "pen", width: 3,
  points: [{ x: .2, y }, { x: .3, y: y + .001 }], ...overrides,
});
const bounds = (value) => ({
  minX: Math.min(...value.points.map(p => p.x)), maxX: Math.max(...value.points.map(p => p.x)),
  minY: Math.min(...value.points.map(p => p.y)), maxY: Math.max(...value.points.map(p => p.y)),
});

test("worker point transfer preserves double precision, pressure and stroke order without detaching saved ink", () => {
  const original = [{ ...stroke(.12345678901234567), color: "#123456", engine: "direct-ink",
    points: [{ x: .9876543210987654, y: .12345678901234567, pressure: 0, deepLocal: { x: .25, y: .3 } },
      { x: .1, y: .2, pressure: .7654321098765432 }, { x: .3, y: .4 }] },
    { type: "text", text: "note", x: .5, y: .4, fontSize: 18 },
    stroke(.5, { tool: "eraser", width: 20, version: 2 })];
  const before = JSON.stringify(original);
  const packed = packInkTileStrokes(original);
  const message = structuredClone(packed, { transfer: [packed.pointData.buffer] });
  assert.equal(packed.pointData.byteLength, 0, "derived coordinates must be transferable");
  const restored = unpackInkTileStrokes(message.strokes, message.pointData);
  for (let i = 0; i < original.length; i++) {
    const { points = [], ...metadata } = original[i];
    const { points: decoded, ...restoredMetadata } = restored[i];
    assert.deepEqual(restoredMetadata, metadata);
    assert.equal(decoded.length, points.length);
    for (let j = 0; j < points.length; j++) {
      assert.equal(decoded[j].x, points[j].x);
      assert.equal(decoded[j].y, points[j].y);
      assert.equal(Number.isFinite(decoded[j].pressure), Number.isFinite(points[j].pressure));
      if (Number.isFinite(points[j].pressure)) assert.equal(decoded[j].pressure, points[j].pressure);
    }
  }
  assert.equal(JSON.stringify(original), before, "persistence retains all pressure, tilt and anchor fields");
});

test("unchanged stored stages parse once, and replacing/removing a value invalidates the cache", () => {
  const storage = new Map([["a", JSON.stringify([stroke(.1)])]]);
  let parses = 0;
  const cache = createDeepInkStageCache(key => storage.get(key), value => { parses++; return JSON.parse(value); });
  const original = cache.read("a");
  for (let i = 0; i < 120; i++) assert.equal(cache.read("a"), original);
  assert.equal(parses, 1);
  storage.set("a", JSON.stringify([stroke(.2)]));
  assert.notEqual(cache.read("a"), original);
  assert.equal(cache.read("a")[0].points[0].y, .2);
  storage.delete("a");
  assert.deepEqual(cache.read("a"), []);
  assert.equal(parses, 2);
  storage.set("a", "bad ink");
  assert.throws(() => cache.read("a"));
  storage.set("a", "{}");
  assert.throws(() => cache.read("a"), /Invalid stage/);
});

test("saving keeps immutable stroke identity; account/passage caches stay independent", () => {
  const saved = [stroke(.1)], raw = JSON.stringify(saved);
  const cache = createDeepInkStageCache(() => raw);
  cache.remember("a", raw, saved);
  assert.equal(cache.read("a"), saved);
  const other = createDeepInkStageCache(() => "[]");
  assert.deepEqual(other.read("a"), []);
});

function rendererFixture() {
  const messages = [], paints = [], overlays = [], fallbacks = [];
  const worker = { postMessage: data => messages.push(data), terminate() { this.terminated = true; } };
  const context = { save() {}, restore() {}, setTransform() {}, clearRect() {}, drawImage(bitmap) { paints.push(bitmap.id); } };
  const tile = { width: 10, height: 10, getContext: () => context };
  const renderer = createInkTileRenderer({ createWorker: () => worker,
    drawFallback: (_tile, data) => fallbacks.push(data.strokes), drawOverlay: (_tile, stroke) => overlays.push(stroke) });
  const finish = id => {
    const bitmap = { id, close() { this.closed = true; } };
    worker.onmessage({ data: { id, bitmap } });
    assert.equal(bitmap.closed, true);
  };
  return { renderer, worker, tile, messages, paints, overlays, fallbacks, finish };
}

test("background history paints live append overlays and ignores an obsolete deletion result", () => {
  const r = rendererFixture(), first = stroke(.1), added = stroke(.2);
  r.renderer.paint(r.tile, { strokes: [first] });
  r.renderer.append(r.tile, added);
  r.finish(r.messages[0].id);
  assert.deepEqual(r.overlays, [added]);
  assert.equal(r.renderer.hasPending(r.tile), false);
  r.renderer.paint(r.tile, { strokes: [first, added] });
  const stale = r.messages.at(-1).id;
  r.renderer.paint(r.tile, { strokes: [added] });
  r.finish(stale);
  assert.ok(!r.paints.includes(stale), "a late bitmap must not resurrect deleted ink");
  assert.deepEqual(r.messages.at(-1).pointData, packInkTileStrokes([added]).pointData);
  assert.deepEqual(r.messages.at(-1).strokes, packInkTileStrokes([added]).strokes);
  r.finish(r.messages.at(-1).id);
});

test("worker queue coalesces rapid changes, cancellation releases tiles, and failure replays current ink", () => {
  const r = rendererFixture(), first = stroke(.1), second = stroke(.2);
  r.renderer.paint(r.tile, { strokes: [first] });
  const other = { ...r.tile };
  r.renderer.paint(other, { strokes: [first] });
  r.renderer.paint(other, { strokes: [second] });
  r.renderer.append(other, first);
  r.renderer.cancel(r.tile);
  r.finish(r.messages[0].id);
  assert.deepEqual(r.paints, []);
  assert.deepEqual(r.messages.at(-1).pointData, packInkTileStrokes([second]).pointData);
  assert.deepEqual(r.messages.at(-1).strokes, packInkTileStrokes([second]).strokes);
  r.worker.onerror();
  assert.deepEqual(r.fallbacks, [[second, first]]);
  assert.equal(r.worker.terminated, true);
  r.renderer.dispose();
  r.renderer.paint(other, { strokes: [first] });
  assert.equal(r.fallbacks.length, 1);
});

test("unsupported workers use the existing renderer, and bitmap cache has a hard memory cap", () => {
  const calls = [];
  const renderer = createInkTileRenderer({ createWorker: () => null, drawFallback: (_tile, data) => calls.push(data) });
  const data = { strokes: [stroke(.2)] };
  renderer.paint({}, data);
  assert.deepEqual(calls, [data]);
  const released = [], cache = createInkTileBitmapCache(800, tile => released.push(tile));
  const a = { width: 10, height: 10 }, b = { ...a }, c = { ...a };
  cache.put(0, a); cache.put(1, b);
  assert.equal(cache.take(0), a);
  cache.put(0, a); cache.put(2, c);
  assert.deepEqual(released, [b], "least recently used tile is evicted");
  assert.equal(cache.bytes, 800);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.deepEqual(new Set(released), new Set([a, b, c]));
});

const reader = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");

test("tiles leaving the viewport during a layout change are discarded instead of cached", () => {
  const body = reader.slice(reader.indexOf("  function syncInkTiles("), reader.indexOf("  function redrawTilesForStroke("));
  for (const emptyViewport of [false, true]) {
    const retired = { width: 900, height: 512, remove() {} };
    const kept = { width: 900, height: 512 };
    const geometry = {};
    const released = [], cached = [], redrawn = [];
    const deps = {
      committedInkLayerRef: { current: { append() {} } },
      currentInkTileWindow: () => ({ start: 1, end: emptyViewport ? 0 : 1,
        contentWidth: 900, contentHeight: 1024, ratio: 1 }),
      inkTileGeometryRef: { current: { regions: {}, ratio: 1 } },
      inkGeometrySnapshotRef: { current: { byId: geometry } },
      inkTilesRef: { current: new Map([[0, retired], ...emptyViewport ? [] : [[1, kept]]]) },
      inkTileBitmapCacheRef: { current: { clear() {}, put: (_index, tile) => cached.push(tile) } },
      releaseInkTile: tile => released.push(tile),
      tileHeightFor: () => 512, resizeInkCanvas() {}, displayedStageInk: () => [],
      drawInkTile: tile => redrawn.push(tile), INK_TILE_HEIGHT: 512,
    };
    const sync = new Function(...Object.keys(deps), `${body}; return syncInkTiles;`)(...Object.values(deps));
    sync();
    assert.deepEqual(released, [retired]);
    assert.deepEqual(cached, [], "a matching canvas size does not make old layout pixels reusable");
    assert.deepEqual(redrawn, emptyViewport ? [] : [kept]);
  }
});
test("multiple pen-up deltas reach local subscribers in order and unsubscribed units stop receiving ink", () => {
  const changes = createDeepInkChangeSource(), received = [];
  const first = stroke(.1), second = stroke(.8);
  const unsubscribe = changes.subscribe(value => received.push(value));
  changes.publish([first], { added: [first] });
  changes.publish([first, second], { added: [second] });
  changes.publish([second], { removed: [first] });
  assert.deepEqual(received.map(value => value.strokes.length), [1, 2, 1]);
  assert.deepEqual(received.map(value => value.added), [[first], [second], []]);
  unsubscribe();
  changes.publish([], { reset: true });
  assert.equal(received.length, 3);
  assert.deepEqual(changes.getSnapshot().strokes, []);
});

test("real ink publication only renders workbook when undo availability changes, including a new passage", () => {
  let inkChanges = createDeepInkChangeSource();
  const hasActiveInkRef = { current: false }, renders = [];
  const body = reader.slice(reader.indexOf("  function publishInkChange("), reader.indexOf("  function refreshInkGeometrySnapshot()"));
  const bind = () => new Function("inkChanges", "hasActiveInkRef", "setHasActiveInk", `${body}; return publishInkChange;`)(inkChanges, hasActiveInkRef, v => renders.push(v));
  const publish = bind();
  const first = stroke(.1);
  publish([first]);
  for (let i = 0; i < 100; i++) publish([first, stroke(i / 101)]);
  assert.deepEqual(renders, [true]);
  inkChanges = createDeepInkChangeSource();
  bind()([]);
  assert.deepEqual(renders, [true, false], "empty next passage must disable undo");
});

test("real displayedStageInk path reuses completed stages and combined arrays across 120 scroll frames", () => {
  const stages = ["deep-translation", "deep-redo"];
  const storage = new Map([["deep-translation", JSON.stringify(Array.from({ length: 3000 }, (_, i) => stroke(i / 3001)))]]);
  let parses = 0;
  const stageInkCache = createDeepInkStageCache(key => storage.get(key), raw => { parses++; return JSON.parse(raw); });
  const refs = {
    strokesRef: { current: [stroke(.4)] }, inkStageIdRef: { current: "deep-redo" },
    inkGeometrySnapshotRef: { current: { byId: new Map(stages.map(id => [`stage:${id}`, {}])) } },
    displayedInkCacheRef: { current: null },
  };
  const body = reader.slice(reader.indexOf("  function displayedStageInk("), reader.indexOf("  function pauseRunningTimedReading()"));
  const display = new Function(...Object.keys(refs), "STAGE_IDS", "stageInkCache", "passageStageInkKey", "resource", "passage",
    `${body}; return displayedStageInk;`)(...Object.values(refs), stages, stageInkCache, (_r, _p, id) => id, { id: "r" }, { id: "p" });
  // The production function also canonicalizes the two initial reading stages.
  globalThis.inkScopeStageId = id => id;
  try {
    const first = display();
    for (let i = 0; i < 120; i++) assert.equal(display(), first);
    assert.equal(first.length, 3001);
    assert.equal(parses, 1);
    refs.strokesRef.current = [...refs.strokesRef.current, stroke(.5)];
    const added = display();
    assert.equal(added.length, 3002);
    assert.equal(added[0], first[0]);
    storage.set("deep-translation", "[]");
    assert.equal(display().length, 2, "clearing another stage cannot leave stale visible ink");
  } finally { delete globalThis.inkScopeStageId; }
});

test("tile index skips offscreen history, preserves compositing order and reuses point projections", () => {
  let projected = 0;
  const index = createDeepInkTileIndex({ tileHeight: 512, overlap: 24,
    projectStroke: s => { projected++; return s; }, boundsForStroke: bounds });
  const history = Array.from({ length: 10000 }, (_, i) => stroke((i + .1) / 10000));
  const info = { contentWidth: 920, contentHeight: 100000 };
  const geometry = {};
  index.sync(history, info, geometry);
  for (let i = 0; i < 120; i++) {
    index.sync(history, info, geometry);
    assert.ok(index.forTile(i).length < 70, "only local strokes, not 10,000 strokes per tile");
  }
  assert.equal(projected, 10000);
  const added = stroke(.0005);
  index.sync([...history, added], info, geometry);
  assert.equal(projected, 10001, "append must not reproject historical points");
  assert.equal(index.forTile(0).at(-1).stroke, added);
  index.sync(history.slice(1), info, geometry);
  assert.ok(!index.forTile(0).some(r => r.stroke === history[0] || r.stroke === added));
  assert.equal(projected, 10001, "deletion reuses surviving points");
  index.sync(history, info, {});
  assert.equal(projected, 20001, "a real layout change invalidates projections");
});

test("tile candidates include seams and wide legacy erasers without changing pen/eraser order", () => {
  const index = createDeepInkTileIndex({ tileHeight: 512, overlap: 24, projectStroke: s => s, boundsForStroke: bounds });
  const pen = stroke(.5), eraser = stroke(.46, { tool: "eraser", width: 30 });
  index.sync([pen, eraser], { contentWidth: 900, contentHeight: 1024 }, {});
  assert.deepEqual(index.forTile(0).map(r => r.stroke), [pen, eraser]);
  assert.deepEqual(index.forTile(1).map(r => r.stroke), [pen, eraser]);
});

test("changed point arrays invalidate individual candidates without reprojecting other strokes", () => {
  let projected = 0;
  const index = createDeepInkTileIndex({ tileHeight: 512, overlap: 24,
    projectStroke: s => { projected++; return s; }, boundsForStroke: bounds });
  const first = stroke(.1), second = stroke(.9), geometry = {};
  const info = { contentWidth: 900, contentHeight: 1024 };
  index.sync([first, second], info, geometry);
  first.points = stroke(.85).points;
  index.sync([first, second], info, geometry);
  assert.equal(projected, 3);
  assert.deepEqual(index.forTile(0), []);
});

function snapshot({ top = 0, width = 920, height = 20000, shift = 0, jitter = 0 } = {}) {
  const regions = [{ id: "stage:deep-translation", stageId: "deep-translation", priority: 2,
    left: 0 + jitter, right: 1 + jitter, top: .1 + shift + jitter, bottom: .8 + shift + jitter }];
  return { contentRect: { top, width: width * .75, height: height * .75 },
    logicalRect: { width, height }, regions, byId: new Map(regions.map(r => [r.id, r])) };
}

test("scroll, paper scaling and subpixel noise keep geometry identity; screen rect is fresh", () => {
  const before = snapshot(), next = snapshot({ top: -3000, jitter: 1e-9 });
  const reused = reuseDeepInkGeometry(before, next);
  assert.equal(reused.byId, before.byId);
  assert.equal(reused.regions, before.regions);
  assert.equal(reused.contentRect.top, -3000);
});

test("paper resize, region movement/removal invalidate geometry without discarding any strokes", () => {
  const before = snapshot();
  for (const next of [snapshot({ width: 950 }), snapshot({ height: 22000 }), snapshot({ shift: .001 }),
    { ...snapshot(), regions: [], byId: new Map() }]) {
    assert.equal(reuseDeepInkGeometry(before, next), next);
    assert.notEqual(next.byId, before.byId);
  }
});

test("hit-testing a translation region measures DOM twice even with 10,000 strokes", () => {
  const body = reader.slice(reader.indexOf("function inkStrokesHitElement("), reader.indexOf("\n}", reader.indexOf("function inkStrokesHitElement(")) + 2);
  const hit = new Function("isEraserStroke", "normalizedStrokeBounds", `${body}; return inkStrokesHitElement;`)(s => s.tool === "eraser", bounds);
  let measures = 0;
  const element = { getBoundingClientRect() { measures++; return { left: 900, top: 900, right: 1000, bottom: 1000, width: 100, height: 100 }; } };
  const paper = { getBoundingClientRect() { measures++; return { left: 0, top: 0, width: 1000, height: 1000 }; } };
  assert.equal(hit(Array.from({ length: 10000 }, () => stroke(.1)), element, paper), false);
  assert.equal(measures, 2);
});

test("mounted React translation units update locally across rapid strokes, erasure and stage replacement", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const require = createRequire(import.meta.url);
  const { transformSync } = createRequire(require.resolve("vite"))("esbuild");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const savedGlobals = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this.classList.contains("sentence-work") ? 100 + Number(this.dataset.slot) * 400 : 0;
    const height = this.classList.contains("sentence-work") ? 200 : 1000;
    return { left: 0, top, width: 1000, height, right: 1000, bottom: top + height };
  };
  const DeepInkContext = React.createContext(null), changes = createDeepInkChangeSource();
  const helper = reader.slice(reader.indexOf("function inkStrokesHitElement("), reader.indexOf("\n}", reader.indexOf("function inkStrokesHitElement(")) + 2);
  const unit = reader.slice(reader.indexOf("function TranslationUnit("), reader.indexOf("function QuestionEvidenceRow("));
  const code = transformSync(helper + "\n" + unit, { loader: "jsx", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).code;
  const { useState, useRef, useContext, useEffect, useCallback } = React;
  const deps = { React, useState, useRef, useContext, useEffect, useCallback, DeepInkContext,
    isEraserStroke: s => s.tool === "eraser", normalizedStrokeBounds: bounds,
    translationKey: (...args) => args.join(":"), translationMethodKey: (...args) => args.join(":"),
    translationSentenceId: (_r, _p, paragraph, sentence) => `${paragraph}:${sentence}`,
    translationOcrTarget: value => ({ ...value, username: "test" }), readTranslationOcr: () => null,
    pendingLegacyTranslation: () => null, getUserItem: () => "", chapterLabel: () => "test",
    useClearableTextEntry: () => {}, useDebouncedStorageText: () => {
      const [value, setValue] = React.useState("");
      return { value, setValue, replaceValue: setValue, flush() {}, reset() { setValue(""); } };
    },
  };
  const TranslationUnit = new Function(...Object.keys(deps), `${code}; return TranslationUnit;`)(...Object.values(deps));
  let workbookRenders = 0;
  function Workbook() {
    workbookRenders++;
    return React.createElement(DeepInkContext.Provider, { value: changes },
      React.createElement("main", { className: "deep-reader-content" }, [0, 1].map(slot =>
        React.createElement("section", { className: "sentence-work", "data-slot": slot, key: slot },
          React.createElement(TranslationUnit, { resource: { id: "r" }, passage: { id: "p" },
            sentence: "test", paragraph: "test", paragraphNumber: 1, sentenceIndex: slot, lines: 2,
            inkOnly: true, progressEntry: { translationStatus: "translated" }, projectInkStroke: s => s })))));
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    await React.act(async () => root.render(React.createElement(Workbook)));
    const states = () => [...document.querySelectorAll(".translation-ai-button")].map(b => b.dataset.hasInk);
    assert.deepEqual(states(), ["0", "0"]);
    const first = stroke(.15), second = stroke(.55);
    await React.act(async () => {
      changes.publish([first], { added: [first] });
      changes.publish([first, second], { added: [second] });
    });
    assert.deepEqual(states(), ["1", "1"], "batched strokes in different units must both be observed");
    await React.act(async () => changes.publish([second], { removed: [first] }));
    assert.deepEqual(states(), ["0", "1"]);
    await React.act(async () => changes.publish([first], { reset: true }));
    assert.deepEqual(states(), ["1", "0"], "switching scope recomputes presence without stale deltas");
    await React.act(async () => changes.publish([], { reset: true }));
    assert.deepEqual(states(), ["0", "0"]);
    assert.equal(workbookRenders, 1, "ink changes must not render the workbook");
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

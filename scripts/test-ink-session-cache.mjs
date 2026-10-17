import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDeepInkTileIndex } from "../src/deepInkRenderCache.js";
import { createInkTileBitmapCache, createInkTileRenderer } from "../src/ink/inkTileRenderer.js";
import { tileRangeForStroke } from "../src/inkEngine.js";

const reader = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
const stroke = y => ({ tool: "pen", width: 3, points: [{ x: .1, y }, { x: .2, y: y + .001 }] });
const bounds = s => ({ minX: .1, maxX: .2, minY: s.points[0].y, maxY: s.points[1].y });

test("appending a stroke preserves distant bitmaps and invalidates only intersecting history", () => {
  const retired = [], cache = createInkTileBitmapCache(100000, tile => retired.push(tile.id));
  for (const [index, id] of [[0, "top"], [40, "middle"], [79, "changed"], [80, "changed-seam"]]) cache.put(index, { id, width: 10, height: 10 });
  const original = [stroke(.1)], previous = new Proxy(original, { get(target, key) { if (key === Symbol.iterator) throw new Error("ordinary append must not iterate the historical array"); return Reflect.get(target, key); } });
  const next = [original[0], stroke(.8)];
  const dependencies = {
    strokesRef: { current: previous }, inkTileBitmapCacheRef: { current: cache },
    displayedStageInk: strokes => strokes, currentInkTileWindow: () => ({ start: 78, end: 82, contentWidth: 900, contentHeight: 51200, ratio: 1 }),
    inkTileIndexRef: { current: { append() {} } }, inkGeometrySnapshotRef: { current: { byId: {} } },
    projectInkStroke: s => s, normalizedStrokeBounds: bounds, tileRangeForStroke, INK_TILE_HEIGHT: 512, INK_TILE_OVERLAP: 24,
    startTransition: callback => callback(), publishInkChange: (_next, delta) => assert.deepEqual(delta, { added: [next[1]], removed: [] }),
    updateTilesForStrokes() { throw new Error("ordinary append already painted"); }, pendingStrokeSaveRef: { current: null },
    passageStageInkKey: () => "isolated", resource: { id: "r" }, passage: { id: "p" }, inkStageIdRef: { current: "deep-translation" },
    strokeSaveTimerRef: { current: null }, cancelScheduledInkSave() {}, scheduleInkSave: () => 1, flushPendingStrokeSave() {},
  };
  const persist = reader.slice(reader.indexOf("  function persistStrokes("), reader.indexOf("  function flushPendingStrokeSave("));
  const invalidate = reader.slice(reader.indexOf("  function invalidateInkTileHistory("), reader.indexOf("  function scheduleCommittedInkRender("));
  const run = new Function(...Object.keys(dependencies), `${persist}\n${invalidate}\nreturn persistStrokes;`)(...Object.values(dependencies));
  run(next, { skipTileRedraw: true });
  assert.deepEqual(new Set(retired), new Set(["changed", "changed-seam"]));
  assert.equal(cache.take(0).id, "top"); assert.equal(cache.take(40).id, "middle");
  assert.equal(cache.take(80), null); assert.equal(dependencies.pendingStrokeSaveRef.current.strokes, next);
});

test("incremental tile membership touches only new geometry and keeps original draw order", () => {
  let projections = 0;
  const index = createDeepInkTileIndex({ tileHeight: 512, overlap: 24, projectStroke: s => { projections++; return s; }, boundsForStroke: bounds });
  const old = Array.from({ length: 5000 }, (_, i) => stroke(i / 5001));
  const geometry = {}, info = { contentWidth: 900, contentHeight: 51200 };
  index.sync(old, info, geometry); assert.equal(projections, 5000);
  const added = stroke(.3), next = [...old, added];
  assert.equal(index.append(old, next, [added], info, geometry), true);
  assert.equal(projections, 5001);
  index.sync(next, info, geometry); assert.equal(projections, 5001);
  assert.equal(index.forTile(30).at(-1).stroke, added);
  assert.equal(index.append(next, [...next, stroke(.2)], [stroke(.2)], info, {}), false, "layout changes must rebuild");
});

test("cooperative fallback ignores cancelled work and adds live strokes after its completed bitmap", async () => {
  let finish;
  const overlays = [], copied = [];
  const first = stroke(.1), late = stroke(.2), tile = {};
  const renderer = createInkTileRenderer({ createWorker: () => null,
    drawFallback: (_tile, data, current) => new Promise(resolve => { finish = () => { if (current()) copied.push(data.strokes); resolve(); }; }),
    drawOverlay: (_tile, s) => overlays.push(s) });
  renderer.paint(tile, { strokes: [first] }); renderer.append(tile, late); finish();
  await Promise.resolve();
  assert.deepEqual(copied, [[first]]); assert.deepEqual(overlays, [late]); assert.equal(renderer.hasPending(tile), false);
  renderer.paint(tile, { strokes: [first] }); renderer.cancel(tile); finish(); await Promise.resolve();
  assert.equal(copied.length, 1, "cancelled fallback cannot resurrect ink");
  renderer.dispose();
});

test("newly visible work is prioritized over queued distant prepaint", () => {
  const messages = [], worker = { postMessage: job => messages.push(job), terminate() {} };
  const context = { save() {}, restore() {}, setTransform() {}, clearRect() {}, drawImage() {} };
  const renderer = createInkTileRenderer({ createWorker: () => worker, drawFallback() {}, drawOverlay() {} });
  const tile = () => ({ getContext: () => context });
  renderer.paint(tile(), { strokes: [], priority: 0 });
  renderer.paint(tile(), { strokes: [], priority: 100 });
  renderer.paint(tile(), { strokes: [], priority: 1 });
  worker.onmessage({ data: { id: messages[0].id, bitmap: { close() {} } } });
  assert.equal(messages[1].priority, 1);
  renderer.dispose();
});

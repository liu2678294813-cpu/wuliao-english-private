import test from "node:test";
import assert from "node:assert/strict";

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

const {
  appendInkSamples,
  createInkSession,
} = await import("../src/inkEngine.js");
const { createTelemetry } = await import("../src/telemetry/telemetry.js");

function enginePoint(x, y, width = 100, height = 100) {
  return {
    normalized: { x: x / width, y: y / height },
    pixel: { x, y },
    viewport: { x, y },
  };
}

function makeSession() {
  return createInkSession({
    pointerId: 1,
    pointerType: "pen",
    point: enginePoint(0, 0),
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

test("Ink Telemetry 不修改 stroke 原始数据", () => {
  const baseline = makeSession();
  const samples = [enginePoint(10, 10), enginePoint(20, 20), enginePoint(30, 30)];
  appendInkSamples(baseline, samples);
  const baselinePoints = JSON.parse(JSON.stringify(baseline.stroke.points));

  const telemetry = createTelemetry({
    storage: memoryStorage(),
    schedule: (fn) => { fn(); return null; },
    cancel: () => {},
  });
  const active = makeSession();
  active.telemetry = { startAt: 0, coalesced: 0, accepted: 0 };
  const accepted = appendInkSamples(active, samples);
  active.telemetry.coalesced += samples.length;
  active.telemetry.accepted += accepted;

  assert.deepEqual(active.stroke.points, baselinePoints);
  assert.equal(active.stroke.tool, "pen");
  assert.equal(active.telemetry.coalesced, 3);
  assert.equal(active.telemetry.accepted, 3);
  assert.deepEqual(active.stroke, baseline.stroke);

  // Telemetry 记录本身也不抛错、不改变 stroke
  telemetry.recordEvent({
    eventType: "ink.stroke_end",
    taskType: "pen",
    status: "ok",
    durationMs: 12,
    metadata: { points: active.stroke.points.length },
  });
  assert.deepEqual(active.stroke, baseline.stroke);
  assert.equal(telemetry.getInkMetrics({ range: "all" }).strokeCount, 1);
});

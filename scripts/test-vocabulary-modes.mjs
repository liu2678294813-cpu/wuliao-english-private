import test from "node:test";
import assert from "node:assert/strict";
import { memoryProgress, memoryState, advanceMemory, swipeDirection } from "../public/vocabulary/memory-modes.js";
const at = step => ({ sharedProgress: { count: Math.ceil(step / 2), masked: step % 2 === 1 } });
test("default clicks count three times, while one right swipe completes", () => {
  let record = {};
  for (const [count, step] of [[1, 2], [2, 4], [3, 5]]) {
    record = at(advanceMemory(record, "default"));
    assert.deepEqual(memoryState(record), { count, step, masked: count === 3, locked: count === 3 });
  }
  for (let step = 0; step <= 5; step++) assert.equal(advanceMemory(at(step), "default", "right"), 5);
});
test("cycle counts hides only and preserves shared partial/completed state", () => {
  let record = {};
  for (const [step, direction] of ["right", "click", "right", "left", "click"].entries()) {
    record = at(advanceMemory(record, "cycle", direction));
    assert.equal(memoryProgress(record), step + 1);
    assert.deepEqual(memoryState(record, "default"), memoryState(record, "cycle"));
  }
  assert.equal(advanceMemory(record, "cycle", "left"), 5);
  assert.equal(advanceMemory(at(1), "default"), 3);
  assert.equal(advanceMemory(at(4), "cycle"), 5);
});
test("legacy counts, conflicting modes and explicit clears migrate without history resurrection", () => {
  for (const count of [0, 1, 2, 3]) assert.equal(memoryState({ clickCount: count }).count, count);
  assert.equal(memoryProgress({ clickCount: 3, modeProgress: { default: 1, cycle: 4 } }), 5);
  assert.equal(memoryProgress({ clickCount: 0, modeProgress: { default: 0, cycle: 5 } }), 5);
  assert.equal(memoryProgress({ legacyClickCount: 3, clickCount: 0, modeProgress: { default: 0, cycle: 0 } }), 0);
  assert.equal(memoryProgress({ ...at(0), clickCount: 3, modeProgress: { cycle: 5 } }), 0);
  for (let step = 1; step < 5; step++) assert.equal(memoryProgress({ modeProgress: { cycle: step } }), step);
});
test("wrong directions and vertical/short/diagonal gestures never advance", () => {
  assert.equal(advanceMemory({}, "cycle", "left"), 0);
  assert.equal(advanceMemory(at(1), "cycle", "right"), 1);
  assert.equal(advanceMemory(at(1), "default", "left"), 1);
  for (const [x, y] of [[30, 0], [60, 60], [4, 80]]) assert.equal(swipeDirection(x, y), null);
  assert.equal(swipeDirection(-80, 10), "left"); assert.equal(swipeDirection(80, 10), "right");
});

import test from "node:test";
import assert from "node:assert/strict";
import * as readingFlow from "../src/readingFlow.js";
import { createUnknownSelectionHooks } from "../src/unknownWordInteraction.js";

test("manual redo is an active attempt without fabricating translation completion", () => {
  assert.equal(typeof readingFlow.enterReadingStage, "function", "explicit stage entry API is required");
  assert.equal(typeof readingFlow.activeQuestionAttempt, "function", "drawer attempt must have one source of truth");
  const original = readingFlow.emptyFlow("interaction-resource", "passage-1", 100);
  const before = JSON.stringify(original);
  assert.equal(readingFlow.activeQuestionAttempt(original), "first");
  const redo = readingFlow.enterReadingStage(original, "deep-redo", 200);
  assert.equal(redo.currentStage, "deep-redo");
  assert.equal(readingFlow.activeQuestionAttempt(redo), "redo");
  assert.notEqual(redo.stages["deep-translation"].status, "completed");
  assert.equal(redo.stages["deep-translation"].completedAt, null);
  assert.equal(readingFlow.normalizeFlow(redo).currentStage, "deep-redo", "reload must retain the explicitly entered stage");
  assert.equal(JSON.stringify(original), before, "entry must not mutate the caller's flow");
  const resumed = readingFlow.enterReadingStage(redo, "deep-translation", 300);
  assert.equal(resumed.currentStage, "deep-translation");
  assert.equal(readingFlow.activeQuestionAttempt(resumed), "first");
  assert.notEqual(resumed.stages["deep-translation"].status, "completed");
});

function unknownHarness({ token = null, writing = true, enabled = true } = {}) {
  const toolRef = { current: "unknown" };
  const noteRef = { current: false };
  const selectionRef = { current: null };
  let commits = 0;
  const hooks = createUnknownSelectionHooks({
    toolRef, selectionRef,
    onCollect() { if (token) selectionRef.current.tokens.set("token", token); return token; },
    onCommit() { commits += 1; },
    fallbackToPenOnPenMiss: enabled,
    isWritingArea: () => writing,
    onRequestPenMode() { toolRef.current = "pen"; noteRef.current = true; },
  });
  return { hooks, toolRef, noteRef, selectionRef, commits: () => commits };
}

test("unknown pen miss passes the same pointerdown through with synchronized refs", () => {
  const state = unknownHarness();
  const event = { pointerId: 7, pointerType: "pen", preventDefault() {} };
  assert.equal(state.hooks.beforeInkDown(event), undefined);
  assert.equal(state.toolRef.current, "pen");
  assert.equal(state.noteRef.current, true);
  assert.equal(state.selectionRef.current, null);
  assert.equal(state.hooks.beforeInkMove(event), undefined);
  assert.equal(state.hooks.beforeInkFinish(event), undefined);
  assert.equal(state.commits(), 0);
});

for (const pointerType of ["touch", "mouse"]) {
  test(`unknown ${pointerType} miss does not request pen mode`, () => {
    const state = unknownHarness();
    assert.equal(state.hooks.beforeInkDown({ pointerId: 1, pointerType }), "abort");
    assert.equal(state.toolRef.current, "unknown");
    assert.equal(state.noteRef.current, false);
  });
}

test("unknown token hit supports successive selections without switching tool", () => {
  const state = unknownHarness({ token: { word: "abandon" } });
  for (const pointerId of [1, 2]) {
    const event = { pointerId, pointerType: "pen" };
    assert.equal(state.hooks.beforeInkDown(event), "abort");
    assert.equal(state.selectionRef.current.tokens.size, 1);
    assert.equal(state.hooks.beforeInkFinish(event), "abort");
    assert.equal(state.toolRef.current, "unknown");
  }
  assert.equal(state.commits(), 2);
});

test("unknown fallback is opt-in and excludes non-writing regions", () => {
  for (const options of [{ enabled: false }, { writing: false }]) {
    const state = unknownHarness(options);
    assert.equal(state.hooks.beforeInkDown({ pointerId: 1, pointerType: "pen" }), "abort");
    assert.equal(state.toolRef.current, "unknown");
  }
});

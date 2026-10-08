import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { normalizeUnknownTerm, normalizeUnknownWord } from "../src/unknownWords.js";
import { createDirectUnknownTap, shouldHandleDirectUnknownTap, unknownWordRanges,
  expandUnknownSelectionSpans, unknownSentenceContextFromToken, unknownPointerRegion,
  createUnknownSelectionHooks } from "../src/unknownWordInteraction.js";
import { upsertUnknownContextSense } from "../src/storage.js";
import { resolveUnknownContextMeaning } from "../src/unknownWordContext.js";
import { createLongPressCandidate, updateLongPressCandidate, shouldActivateTemporaryEraser,
  LONG_PRESS_MS, TAP_MOVE_THRESHOLD_CSS_PX, TAP_PATH_THRESHOLD_CSS_PX } from "../src/inkEngine.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://localhost/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;

test("phrase normalization preserves apostrophes/hyphens and legacy word normalization", () => {
  assert.equal(normalizeUnknownTerm("  Be   Responsible For  "), "be responsible for");
  assert.equal(normalizeUnknownTerm("（IT’S   well-known!）"), "it's well-known");
  assert.equal(normalizeUnknownTerm("Ｂｅ\nResponsible\tFor"), "be responsible for");
  assert.equal(normalizeUnknownWord("  It’s "), "it's");
});

function sentenceFixture(prefix = "translation") {
  document.body.innerHTML = `<div id="root"><p data-unknown-scope="${prefix}:p2:s3" data-sentence-scope="${prefix}:p2:s3">We should be responsible for it.</p></div>`;
  const scope = document.querySelector("p");
  return { scope, tokens: unknownWordRanges(scope) };
}

for (const reverse of [false, true]) {
  test(`phrase expands skipped middle tokens in DOM order, reverse=${reverse}`, () => {
    const { tokens } = sentenceFixture();
    const hits = reverse ? [tokens[4], tokens[2]] : [tokens[2], tokens[4]];
    const spans = expandUnknownSelectionSpans({ tokens: new Map(hits.map((t) => [t.occurrenceId, t])) }, "passage");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].word, "be responsible for");
    assert.equal(spans[0].contextKey, "passage:p2:s3");
    assert.equal(spans[0].sentence, "We should be responsible for it.");
    assert.deepEqual(spans[0].occurrenceIds, tokens.slice(2, 5).map((t) => t.occurrenceId));
  });
}

test("one token remains a word; repeated render scopes share canonical context", () => {
  const contexts = ["translation", "repeat", "clean"].map((prefix) => {
    const { tokens } = sentenceFixture(prefix);
    const [span] = expandUnknownSelectionSpans({ tokens: new Map([[tokens[3].occurrenceId, tokens[3]]]) }, "p");
    assert.equal(span.word, "responsible");
    return span.contextKey;
  });
  assert.equal(new Set(contexts).size, 1);
});

test("paragraph scope splits tokens by nearest sentence DOM; no cross-sentence phrase", () => {
  document.body.innerHTML = '<p data-unknown-scope="clean:p1"><span data-sentence-scope="clean:p1:s1">First sentence ends.</span> <span data-sentence-scope="clean:p1:s2">Next sentence begins.</span></p>';
  const tokens = unknownWordRanges(document.querySelector("p"));
  const spans = expandUnknownSelectionSpans({ tokens: new Map(tokens.map((t) => [t.occurrenceId, t])) }, "p");
  assert.deepEqual(spans.map((s) => s.word), ["First sentence ends", "Next sentence begins"]);
  assert.notEqual(spans[0].contextKey, spans[1].contextKey);
});

test("custom scope has stable fallback and unmounted tokens do not commit", () => {
  const { scope, tokens } = sentenceFixture();
  scope.dataset.sentenceScope = "custom:test";
  assert.match(unknownSentenceContextFromToken(tokens[0], "p").contextKey, /^p:custom:test:/);
  scope.remove();
  assert.deepEqual(expandUnknownSelectionSpans({ tokens: new Map([["t", tokens[0]]]) }, "p"), []);
  assert.deepEqual(expandUnknownSelectionSpans(null, "p"), []);
});

test("partially unmounted selection cancels the whole phrase instead of saving surviving hits", () => {
  document.body.innerHTML = '<div><p data-unknown-scope="translation:p1:s1">one two three</p><p data-unknown-scope="translation:p1:s2">four five</p></div>';
  const scopes = [...document.querySelectorAll("p")];
  const hits = [...unknownWordRanges(scopes[0]), ...unknownWordRanges(scopes[1])];
  scopes[0].remove();
  assert.deepEqual(expandUnknownSelectionSpans({ tokens: new Map(hits.map((token) => [token.occurrenceId, token])) }, "p"), []);
});

for (const [pointerType, noteMode, activeInk, expected] of [
  ["touch", true, false, true], ["touch", false, false, true],
  ["pen", true, false, false], ["mouse", true, false, false],
  ["pen", false, false, true], ["mouse", false, false, true],
  ["touch", true, true, false],
]) test(`direct tap gating ${pointerType}, noteMode=${noteMode}, ink=${activeInk}`, () => {
  assert.equal(shouldHandleDirectUnknownTap({ pointerType, noteMode, activeInk, enabled: true }), expected);
  assert.equal(shouldHandleDirectUnknownTap({ pointerType, noteMode, activeInk, enabled: false }), false);
});

function tapHarness() {
  const { tokens } = sentenceFixture();
  const commits = [];
  const tap = createDirectUnknownTap({ canHandle: () => true, hitTest: () => tokens[2], onCommit: (s) => commits.push(s) });
  const event = (type, x = 0, timeStamp = 0, pointerId = 1) => ({ type, pointerType: "touch", pointerId, clientX: x, clientY: 0, timeStamp });
  return { tap, commits, event };
}

test("tap commits once and duplicate up cannot commit again", async () => {
  const { tap, commits, event } = tapHarness();
  tap.down(event("pointerdown")); tap.move(event("pointermove", 3, 50));
  assert.equal(tap.finish(event("pointerup", 3, 100)), true);
  assert.equal(tap.finish(event("pointerup", 3, 100)), false);
  await Promise.resolve();
  assert.equal(commits.length, 1);
});

for (const kind of ["movement", "long", "cancel", "lost", "scroll", "multi", "reset", "coalesced"]) {
  test(`direct tap rejects ${kind}`, async () => {
    const { tap, commits, event } = tapHarness();
    tap.down(event("pointerdown"));
    if (kind === "movement") { tap.move(event("pointermove", 20, 30)); tap.move(event("pointermove", 0, 60)); }
    if (kind === "scroll") tap.cancel();
    if (kind === "multi") tap.down(event("pointerdown", 0, 10, 2));
    if (kind === "reset") tap.reset();
    if (kind === "coalesced") tap.move({ ...event("pointermove"), getCoalescedEvents: () => [event("pointermove", 20)] });
    tap.finish(event(kind === "cancel" ? "pointercancel" : kind === "lost" ? "lostpointercapture" : "pointerup", 0, kind === "long" ? 351 : 100));
    await Promise.resolve();
    assert.equal(commits.length, 0);
  });
}

test("geometry recognizes English whitespace and writing under overlay; excludes controls", () => {
  document.body.innerHTML = '<main><canvas></canvas><p data-unknown-scope="s">one two</p><div class="translation-unit"><textarea></textarea><div class="deep-writing-lines"></div><button>OCR</button></div></main>';
  const root = document.querySelector("main");
  const canvas = document.querySelector("canvas");
  const event = { target: canvas, clientX: 1, clientY: 1 };
  for (const [selector, region] of [["p", "english"], [".deep-writing-lines", "writing"], ["button", "control"], ["textarea", "control"]]) {
    document.elementsFromPoint = () => [canvas, document.querySelector(selector), root];
    assert.equal(unknownPointerRegion(event, root), region);
  }
  delete document.elementsFromPoint;
});

test("English miss remains unknown, collects endpoint; interrupted selection never commits", () => {
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    const selectionRef = { current: null }, toolRef = { current: "unknown" };
    let collected = 0, committed = 0;
    const hooks = createUnknownSelectionHooks({ selectionRef, toolRef, cancelOnInterrupted: true,
      fallbackToPenOnPenMiss: true, isWritingArea: () => false, onRequestPenMode: () => { toolRef.current = "pen"; },
      onCollect: () => { collected++; }, onCommit: () => { committed++; } });
    assert.equal(hooks.beforeInkDown({ pointerId: 1, pointerType: "pen" }), "abort");
    assert.equal(toolRef.current, "unknown");
    hooks.beforeInkFinish({ pointerId: 1, type });
    assert.equal(committed, type === "pointerup" ? 1 : 0);
    assert.equal(collected, type === "pointerup" ? 2 : 1);
    assert.equal(selectionRef.current, null);
  }
});

const entry = { id: "r", username: "u", word: "issue", normalizedWord: "issue", contextKey: "p:p1:s1", sentence: "We discussed the issue.", occurrenceIds: ["s1:0"] };
test("sense merge is idempotent, preserves legacy meaning and unions phrase occurrences", () => {
  const legacy = { meaning: "旧释义", occurrences: ["legacy:0"], createdAt: 10 };
  const first = upsertUnknownContextSense(legacy, entry, 20);
  const again = upsertUnknownContextSense(first, { ...entry, occurrenceIds: ["s1:0", "s1:1", "s1:2"] }, 30);
  assert.equal(again.senses.length, 1);
  assert.equal(again.meaning, "旧释义");
  assert.equal(again.createdAt, 10);
  assert.equal(again.senses[0].meaningRevision, first.senses[0].meaningRevision);
  assert.deepEqual(again.occurrences, ["legacy:0", "s1:0", "s1:1", "s1:2"]);
  assert.deepEqual(first.senses[0].occurrenceIds, ["s1:0"]);
});

test("same term in different sentence retains independent senses", () => {
  const first = upsertUnknownContextSense(null, entry);
  first.senses[0].meaning = "问题"; first.senses[0].meaningSource = "context-ai";
  const next = upsertUnknownContextSense(first, { ...entry, contextKey: "p:p1:s2", sentence: "They issue a report.", occurrenceIds: ["s2:1"] });
  assert.equal(next.senses.length, 2);
  assert.equal(next.senses[0].meaning, "问题");
  assert.equal(next.senses[1].meaning, "");
});

test("AI precedes dictionary, receives full sentence, and concurrent duplicate is deduplicated", async () => {
  const record = upsertUnknownContextSense(null, entry);
  let calls = 0, dictionaryCalls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = { getKey: async () => "test-key", dictionary: async () => { dictionaryCalls++; return "通用义"; },
    lookup: async ({ word, sentence }) => { calls++; assert.equal(word, "issue"); assert.equal(sentence, entry.sentence); await gate; return "问题"; },
    update: async (_id, context, meaning, metadata) => { assert.equal(context, entry.contextKey); assert.equal(meaning, "问题"); assert.equal(metadata.meaningSource, "context-ai"); } };
  const one = resolveUnknownContextMeaning(record, entry.contextKey, options);
  const two = resolveUnknownContextMeaning(record, entry.contextKey, options);
  assert.equal(one, two);
  release(); await one;
  assert.equal(calls, 1); assert.equal(dictionaryCalls, 0);
  record.senses[0].meaningSource = "context-ai";
  await resolveUnknownContextMeaning(record, entry.contextKey, options);
  assert.equal(calls, 1);
});

test("AI failure uses explicitly marked dictionary fallback; phrase remains saved pending", async () => {
  const record = upsertUnknownContextSense(null, entry);
  let result;
  await resolveUnknownContextMeaning(record, entry.contextKey, { getKey: async () => "key", lookup: async () => { throw Error("timeout"); },
    dictionary: async () => "通用义", update: async (...args) => { result = args; } });
  assert.equal(result[3].meaningSource, "dictionary-fallback");
  const phrase = upsertUnknownContextSense(null, { ...entry, id: "phrase", word: "be responsible for", normalizedWord: "be responsible for" });
  await resolveUnknownContextMeaning(phrase, entry.contextKey, { getKey: async () => "", dictionary: async () => { assert.fail("phrase dictionary not required"); }, update: async () => assert.fail("empty meaning must not overwrite") });
  assert.equal(phrase.senses[0].meaningSource, "pending-context");
});

test("stale/aborted AI never updates saved sense", async () => {
  const record = upsertUnknownContextSense(null, entry);
  const controller = new AbortController();
  await resolveUnknownContextMeaning(record, entry.contextKey, { signal: controller.signal, getKey: async () => "key",
    lookup: async () => { controller.abort(); return "错误串写"; }, update: async () => assert.fail("stale write") });
  await resolveUnknownContextMeaning(record, entry.contextKey, { isCurrent: () => false, getKey: async () => assert.fail("stale request") });
});

test("long press 465ms accepts 2.9px jitter, rejects >3px or accumulated >6px", () => {
  let candidate = createLongPressCandidate(0, 0, 0);
  assert.equal(shouldActivateTemporaryEraser(candidate, 464), false);
  assert.equal(shouldActivateTemporaryEraser(candidate, LONG_PRESS_MS), true);
  candidate = updateLongPressCandidate(candidate, 2.9, 0);
  assert.equal(shouldActivateTemporaryEraser(candidate, LONG_PRESS_MS), true);
  assert.equal(shouldActivateTemporaryEraser(updateLongPressCandidate(candidate, 3.01, 0), LONG_PRESS_MS), false);
  let boundary = updateLongPressCandidate(createLongPressCandidate(0, 0, 0), 3, 0);
  assert.equal(shouldActivateTemporaryEraser(boundary, LONG_PRESS_MS), true);
  boundary = updateLongPressCandidate(boundary, 0, 0);
  assert.equal(boundary.pathLength, 6);
  assert.equal(shouldActivateTemporaryEraser(boundary, LONG_PRESS_MS), true);
  boundary = updateLongPressCandidate(boundary, 0.01, 0);
  assert.equal(shouldActivateTemporaryEraser(boundary, LONG_PRESS_MS), false);
  candidate = createLongPressCandidate(0, 0, 0);
  for (const x of [2, -2, 2]) candidate = updateLongPressCandidate(candidate, x, 0);
  assert.equal(candidate.maxDisplacement, 2);
  assert.equal(candidate.active, false);
  assert.equal(TAP_MOVE_THRESHOLD_CSS_PX, 1);
  assert.equal(TAP_PATH_THRESHOLD_CSS_PX, 2);
});

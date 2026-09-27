import test from "node:test";
import assert from "node:assert/strict";
import { runHandwritingWorkflow, initialHandwritingScroll } from "../src/vocabulary/handwritingWorkflow.js";
import { handwritingImageStroke } from "../src/vocabulary/handwritingImage.js";

test("old row ink and ordinary erasers retain normalized geometry outside the edge; corrupt canonical ink is rejected", () => {
  const pen = { tool: "pen", width: 1, points: [{ x: 0.12, y: 0.31 }, { x: 0.01, y: 1.061 }] };
  const eraser = { tool: "eraser", width: 24, points: [{ x: 0.13, y: 0.16 }, { x: 0.02, y: 1.137 }] };
  assert.deepEqual(handwritingImageStroke(pen), pen);
  assert.deepEqual(handwritingImageStroke(eraser), eraser);
  const canonical = { ...pen, coordinateSpace: "writing-page-v1", writingAnchor: { version: 1, pageId: "answer" }, points: [{ x: 0.8, y: 0.9, writingLocal: { x: 0.1, y: 0.2 } }] };
  assert.equal(handwritingImageStroke(canonical).points[0].x, 0.1);
  assert.equal(handwritingImageStroke(canonical).points[0].y, 0.2);
  assert.throws(() => handwritingImageStroke({ ...pen, coordinateSpace: "writing-page-v1" }), /坐标无效/);
  assert.throws(() => handwritingImageStroke({ points: [{ x: NaN, y: 0 }] }), /坐标无效/);
});

function harness(ids = [0, 34, 79]) {
  const words = Array.from({ length: 80 }, (_, i) => ({ wordId: String(i), english: `word${i}`, chinese: `词义${i}` }));
  const answers = new Map(ids.map(i => [String(i), { id: `answer${i}`, wordId: String(i), revision: 1, strokeCount: 2, inkFingerprint: `ink${i}`, textSource: "handwriting", text: "", stale: true }]));
  const images = [], judged = [], calls = [];
  const read = id => answers.get(id);
  const same = answer => read(answer.wordId)?.revision === answer.revision && read(answer.wordId)?.inkFingerprint === answer.inkFingerprint;
  const change = (id, patch) => { const next = { ...read(id), ...patch }; answers.set(id, next); return next; };
  const options = { words, read, same, change,
    image: async answer => { images.push(answer.wordId); return "data:image/png;base64,test"; },
    recognize: async rows => { calls.push(rows.length); return rows.map(row => ({ id: row.id, text: "正确中文", unsure: false })); },
    compare: async rows => rows.map(row => ({ id: row.id, verdict: "correct", reason: "同义词" })),
    applyVerdict: async (answer, verdict) => { if (!same(answer)) return false; judged.push(answer.wordId); change(answer.wordId, { verdict, stale: false, classified: verdict !== "unsure" }); return true; },
  };
  return { options, answers, images, judged, calls, change, run: () => runHandwritingWorkflow(options) };
}
test("all written rows including 35 and 80 are transcribed then classified; retry is idempotent", async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.completed, 3); assert.deepEqual(h.images, ["0", "34", "79"]);
  assert.deepEqual(h.judged, h.images); assert.equal((await h.run()).total, 0);
});
test("batching is bounded; failed judgement retries from transcript without another image call", async () => {
  const h = harness(Array.from({ length: 13 }, (_, i) => i));
  const compare = h.options.compare; h.options.compare = async () => { throw Error("offline"); };
  assert.equal((await h.run()).errors.length, 13); assert.deepEqual(h.calls, [5, 5, 3]);
  h.options.compare = compare; assert.equal((await h.run()).completed, 13); assert.deepEqual(h.calls, [5, 5, 3]);
});
test("late recognition cannot replace edits or classify an answer from an older revision", async () => {
  const h = harness([0]); h.options.recognize = async rows => {
    h.change("0", { revision: 2, textSource: "keyboard", text: "人工修改" });
    return rows.map(row => ({ id: row.id, text: "旧结果", unsure: false }));
  };
  await h.run(); assert.equal(h.answers.get("0").text, "人工修改"); assert.equal(h.judged.length, 0);
});
test("uncertain/blank recognition never becomes a correct or wrong list entry", async () => {
  const h = harness([0]); h.options.recognize = async rows => rows.map(row => ({ id: row.id, text: "", unsure: false }));
  const result = await h.run(); assert.equal(result.unsure, 1); assert.equal(result.completed, 0);
  assert.equal(h.answers.get("0").classified, false);
});
test("one damaged snapshot doesn't block other words; missing provider rows remain retryable", async () => {
  const h = harness(); const image = h.options.image;
  h.options.image = async answer => { if (answer.wordId === "34") throw Error("damaged"); return image(answer); };
  h.options.recognize = async rows => [{ id: rows[0].id, text: "中文", unsure: false }];
  const result = await h.run(); assert.equal(result.completed, 1); assert.equal(result.errors.length, 2);
  assert.equal(h.answers.get("79").recognizedFingerprint, undefined);
});
test("keyboard answers bypass vision; cancelled jobs do not call providers", async () => {
  const h = harness([0]); h.change("0", { textSource: "keyboard", text: "键盘答案" });
  assert.equal((await h.run()).completed, 1); assert.equal(h.images.length, 0);
  h.change("0", { stale: true }); h.options.signal = AbortSignal.abort(); await h.run(); assert.equal(h.judged.length, 1);
});
test("old page positions migrate to continuous scroll and new positions take precedence", () => {
  assert.equal(initialHandwritingScroll({ page: 2 }), 4800);
  assert.equal(initialHandwritingScroll({ page: 2, scrollTop: 123 }), 123);
  assert.equal(initialHandwritingScroll(null, 35), 4200);
});

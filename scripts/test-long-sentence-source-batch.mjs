import test from "node:test";
import assert from "node:assert/strict";
import { chooseLongSentenceSources, chooseLongSentenceWords } from "../src/longSentence/sourceBatch.js";
test("79 selected sources produce a six-source bounded, rotating batch", () => {
  const all = Array.from({ length: 79 }, (_, i) => ({ sourceReviewId: String(i) }));
  const first = chooseLongSentenceSources(all, 0);
  assert.equal(first.total, 79);
  assert.deepEqual(first.items.map(x => x.sourceReviewId), ["0","1","2","3","4","5"]);
  const second = chooseLongSentenceSources(all, first.nextCursor);
  assert.deepEqual(second.items.map(x => x.sourceReviewId), ["6","7","8","9","10","11"]);
  let cursor = 0, visited = new Set();
  for (let n = 0; n < 14; n++) {
    const batch = chooseLongSentenceSources(all, cursor);
    batch.items.forEach(x => visited.add(x.sourceReviewId));
    cursor = batch.nextCursor;
  }
  assert.equal(visited.size, 79);
  assert.equal(all.length, 79, "saved original selection must not be mutated");
});
test("small selections and word limit remain stable", () => {
  const source = [{ id: "one" }];
  assert.deepEqual(chooseLongSentenceSources(source, 7).items, source);
  const words = Array.from({ length: 200 }, (_, i) => ({ id: i }));
  assert.equal(chooseLongSentenceWords(words).items.length, 24);
  assert.equal(chooseLongSentenceWords(words).total, 200);
  assert.equal(words.length, 200);
});

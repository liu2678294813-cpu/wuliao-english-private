import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  sampleEssayDocument,
  translationDocument,
  wholeDocumentTranslationUnit,
} from "../src/writing/writingDocument.js";

test("legacy sentence units normalize at read time without data loss", () => {
  assert.equal(translationDocument([
    { unitId: "s1", typedText: "第一段。" },
    { unitId: "s2", typedText: "第二段。" },
  ]), "第一段。\n\n第二段。");
  assert.equal(sampleEssayDocument({ text: "Full essay wins.", segments: [{ text: "Sentence card." }] }), "Full essay wins.");
});

test("new W2 input persists one full-document translation unit", () => {
  assert.deepEqual(wholeDocumentTranslationUnit({
    sampleSegments: [{ unitId: "paragraph-1" }, { unitId: "paragraph-2" }],
    typedText: "一份完整译文。",
    inputMethod: "typed",
  }), {
    unitId: "paragraph-1",
    inputMethod: "typed",
    typedText: "一份完整译文。",
    inkRef: null,
  });
});

test("W2/W3/W6/W7 share one split-workspace contract and W2 has no sentence-card input map", async () => {
  const stages = await readFile(new URL("../src/writing/ui/WritingStages.jsx", import.meta.url), "utf8");
  const split = await readFile(new URL("../src/writing/ui/WritingSplitWorkspace.jsx", import.meta.url), "utf8");
  assert.ok(split.includes("writing-split-workspace"));
  assert.ok((stages.match(/<WritingSplitWorkspace/g) || []).length >= 4);
  assert.ok((stages.match(/workActions=\{<InputModePicker/g) || []).length >= 4);
  assert.ok((stages.match(/showHeading=\{false\}/g) || []).length >= 4);
  assert.ok(split.includes("writing-split-header-actions"));
  assert.equal(stages.includes("中文译文 {index + 1}"), false);
  assert.equal(stages.includes("writing-translation-unit"), false);
});

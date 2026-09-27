import test from "node:test";
import assert from "node:assert/strict";
import { selectCustomLibraryResources } from "../src/libraryView.js";

const pending = { id: "pending", kind: "custom", conversionStatus: "pending" };
const passagesOnly = { id: "reading", kind: "custom", conversionStatus: "ready", analysis: { passages: [{}], clozes: [] } };
const clozesOnly = { id: "cloze", kind: "custom", conversionStatus: "ready", analysis: { passages: [], clozes: [{}] } };
const both = { id: "both", kind: "custom", conversionStatus: "ready", analysis: { passages: [{}], clozes: [{}] } };

test("精读资料库不构造 cloze-only ready card", () => {
  assert.deepEqual(
    selectCustomLibraryResources([pending, passagesOnly, clozesOnly, both], "reading").map((item) => item.id),
    ["pending", "reading", "both"],
  );
});

test("完形资料库不构造 passages-only ready card", () => {
  assert.deepEqual(
    selectCustomLibraryResources([pending, passagesOnly, clozesOnly, both], "cloze").map((item) => item.id),
    ["pending", "cloze", "both"],
  );
});

test("两页复用同一 custom resource identity，不复制记录", () => {
  const reading = selectCustomLibraryResources([both], "reading")[0];
  const cloze = selectCustomLibraryResources([both], "cloze")[0];
  assert.equal(reading, both);
  assert.equal(cloze, both);
  assert.equal(reading.id, cloze.id);
});


import test from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import { chromium } from "@playwright/test";

// Exercise the real IndexedDB implementation in isolated browser origins,
// including concurrent transactions, deletion and account changes.
const built = await build({ configFile: false, logLevel: "error", build: { write: false,
  lib: { entry: "src/storage.js", name: "unknownStorageTest", formats: ["iife"] } } });
const code = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;
const browser = await chromium.launch({ channel: "chrome", headless: true });
test.after(() => browser.close());

async function fixture(run) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("https://unknown.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<html><body>IndexedDB test</body></html>" }));
    await page.goto("https://unknown.test/fixture");
    await page.addScriptTag({ content: code });
    return await page.evaluate(run);
  } finally { await context.close(); }
}

test("concurrent adds merge two senses and occurrence union without duplicates", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const base = { resourceId: "r", passageId: "p", word: "issue", sentence: "An issue matters.", contextKey: "p:p1:s1", occurrenceIds: ["s1:1"] };
    const api = unknownStorageTest;
    await Promise.all([api.addUnknownWordContext(base), api.addUnknownWordContext(base), api.addUnknownWordContext({ ...base, sentence: "They issue reports.", contextKey: "p:p1:s2", occurrenceIds: ["s2:1"] })]);
    const [record] = await api.listUnknownWords();
    return { count: (await api.listUnknownWords()).length, senses: record.senses.length, occurrences: record.occurrences };
  });
  assert.equal(result.count, 1); assert.equal(result.senses, 2);
  assert.deepEqual(result.occurrences, ["s1:1", "s2:1"]);
});

test("sense edits are isolated; stale AI cannot overwrite manual edits or resurrect deletions", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const base = { resourceId: "r", passageId: "p", word: "issue", sentence: "An issue matters.", contextKey: "s1", occurrenceIds: ["s1:1"] };
    const first = await api.addUnknownWordContext(base);
    const oldRevision = first.senses[0].meaningRevision;
    await api.addUnknownWordContext({ ...base, contextKey: "s2", sentence: "They issue reports." });
    await api.updateUnknownWordContextMeaning(first.id, "s1", "问题");
    await api.updateUnknownWordContextMeaning(first.id, "s2", "发行");
    const stale = await api.updateUnknownWordContextMeaning(first.id, "s1", "过期AI", { expectedRevision: oldRevision, meaningSource: "context-ai" });
    const before = await api.listUnknownWords();
    await api.deleteUnknownWord(first.id);
    const deleted = await api.updateUnknownWordContextMeaning(first.id, "s1", "过期AI", { expectedRevision: oldRevision });
    const emptyCount = (await api.listUnknownWords()).length;
    const recreated = await api.addUnknownWordContext(base);
    const recreatedStale = await api.updateUnknownWordContextMeaning(first.id, "s1", "过期AI", { expectedRevision: oldRevision });
    return { stale, deleted, recreatedStale, emptyCount, meanings: before[0].senses.map((s) => s.meaning), revisionChanged: recreated.senses[0].meaningRevision !== oldRevision };
  });
  assert.equal(result.stale, null); assert.equal(result.deleted, null); assert.equal(result.recreatedStale, null);
  assert.equal(result.emptyCount, 0); assert.equal(result.revisionChanged, true);
  assert.deepEqual(result.meanings, ["问题", "发行"]);
});

test("legacy records still edit/delete/toggle; phrase does not need schema migration", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const legacy = await api.toggleUnknownWord({ resourceId: "r", passageId: "p", word: "old", normalizedWord: "old", meaning: "旧词", occurrenceId: "legacy:0", sourceType: "cloze" });
    await api.updateUnknownWordMeaning(legacy.id, "编辑旧义");
    const edited = (await api.listUnknownWords())[0];
    await api.toggleUnknownWord({ resourceId: "r", passageId: "p", word: "old", normalizedWord: "old", occurrenceId: "legacy:0" });
    const toggledCount = (await api.listUnknownWords()).length;
    const phrase = await api.addUnknownWordContext({ resourceId: "r", passageId: "p", word: " Be  Responsible For ", sentence: "They should be responsible for it.", contextKey: "s1", occurrenceIds: ["s1:2", "s1:3", "s1:4"] });
    await api.updateUnknownWordContextMeaning(phrase.id, "s1", "对……负责");
    const saved = (await api.listUnknownWords())[0];
    const db = await api.openWuliaoEnglishDatabase(); const version = db.version; db.close();
    await api.deleteUnknownWord(phrase.id);
    return { legacyMeaning: edited.meaning, legacyHasSenses: !!edited.senses, sourceType: edited.sourceType, toggledCount,
      normalized: saved.normalizedWord, meaning: saved.senses[0].meaning, occurrences: saved.occurrences, version, finalCount: (await api.listUnknownWords()).length };
  });
  assert.equal(result.legacyMeaning, "编辑旧义"); assert.equal(result.legacyHasSenses, false); assert.equal(result.sourceType, "cloze");
  assert.equal(result.toggledCount, 0); assert.equal(result.normalized, "be responsible for"); assert.equal(result.meaning, "对……负责");
  assert.equal(result.occurrences.length, 3); assert.equal(result.version, 8); assert.equal(result.finalCount, 0);
});

test("stale lifecycle/account guards prevent writes in the transaction", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const base = { username: "alice", resourceId: "r", passageId: "p", word: "issue", sentence: "An issue matters.", contextKey: "s1", occurrenceIds: ["s1:1"] };
    const denied = await api.addUnknownWordContext(base, { isCurrent: () => false });
    const first = await api.addUnknownWordContext(base);
    localStorage.setItem("kaoyan_vocab_current_user", "bob");
    const switchedAdd = await api.addUnknownWordContext(base);
    const switchedUpdate = await api.updateUnknownWordContextMeaning(first.id, "s1", "串写", { username: "alice" });
    const bobCount = (await api.listUnknownWords()).length;
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    return { denied, switchedAdd, switchedUpdate, bobCount, aliceMeaning: (await api.listUnknownWords())[0].senses[0].meaning };
  });
  assert.equal(result.denied, null); assert.equal(result.switchedAdd, null); assert.equal(result.switchedUpdate, null);
  assert.equal(result.bobCount, 0); assert.equal(result.aliceMeaning, "");
});

test("rapid single-token toggles add then cancel atomically, without late AI resurrection", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const entry = { resourceId: "r", passageId: "p", word: "issue", sentence: "An issue matters.", contextKey: "p:p1:s1", occurrenceIds: ["translation:p1:s1:1"] };
    const results = await Promise.all([api.toggleUnknownWordContext(entry), api.toggleUnknownWordContext(entry)]);
    const first = results[0].record;
    const late = await api.updateUnknownWordContextMeaning(first.id, entry.contextKey, "迟到 AI", { expectedRevision: first.senses[0].meaningRevision });
    return { actions: results.map((result) => result.action), count: (await api.listUnknownWords()).length, late };
  });
  assert.deepEqual(result.actions, ["added", "removed"]);
  assert.equal(result.count, 0); assert.equal(result.late, null);
});

test("cancel only the current sentence sense and preserve another meaning and highlight", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const entry = { resourceId: "r", passageId: "p", word: "issue", sentence: "An issue matters.", contextKey: "s1", occurrenceIds: ["s1:1"] };
    const old = await api.addUnknownWordContext(entry);
    await api.addUnknownWordContext({ ...entry, sentence: "They issue reports.", contextKey: "s2", occurrenceIds: ["s2:1"] });
    await api.updateUnknownWordContextMeaning(old.id, "s1", "问题");
    await api.updateUnknownWordContextMeaning(old.id, "s2", "发行");
    const action = await api.toggleUnknownWordContext(entry);
    const late = await api.updateUnknownWordContextMeaning(old.id, "s1", "过期", { expectedRevision: old.senses[0].meaningRevision });
    const [remaining] = await api.listUnknownWords();
    return { action: action.action, senses: remaining.senses, occurrences: remaining.occurrences, late, meaning: remaining.meaning };
  });
  assert.equal(result.action, "removed"); assert.equal(result.senses.length, 1);
  assert.equal(result.senses[0].contextKey, "s2"); assert.equal(result.meaning, "发行");
  assert.deepEqual(result.occurrences, ["s2:1"]); assert.equal(result.late, null);
});

test("tapping a phrase constituent cancels its whole current span and overlapping word, preserving other contexts", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const phrase = { resourceId: "r", passageId: "p", word: "be responsible for", sentence: "Be responsible for it.", contextKey: "s1", occurrenceIds: ["s1:0", "s1:1", "s1:2"] };
    await api.addUnknownWordContext(phrase);
    await api.addUnknownWordContext({ ...phrase, sentence: "They must be responsible for it.", contextKey: "s2", occurrenceIds: ["s2:2", "s2:3", "s2:4"] });
    await api.addUnknownWordContext({ ...phrase, word: "responsible", occurrenceIds: ["s1:1"] });
    const result = await api.toggleUnknownWordContext({ ...phrase, word: "responsible", occurrenceIds: ["s1:1"] });
    const rows = await api.listUnknownWords();
    return { action: result.action, rows };
  });
  assert.equal(result.action, "removed"); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].word, "be responsible for");
  assert.deepEqual(result.rows[0].occurrences, ["s2:2", "s2:3", "s2:4"]);
  assert.equal(result.rows[0].senses[0].contextKey, "s2");
});

test("legacy cancellation preserves other positions; account and lifecycle changes cannot toggle", async () => {
  const result = await fixture(async () => {
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const api = unknownStorageTest;
    const legacy = { resourceId: "r", passageId: "p", word: "old", normalizedWord: "old", meaning: "旧义", occurrenceId: "s1:0" };
    await api.toggleUnknownWord(legacy);
    await api.toggleUnknownWord({ ...legacy, occurrenceId: "s2:0" });
    const entry = { username: "alice", resourceId: "r", passageId: "p", word: "old", sentence: "Old facts remain.", contextKey: "s1", occurrenceIds: ["s1:0"] };
    const denied = await api.toggleUnknownWordContext(entry, { isCurrent: () => false });
    localStorage.setItem("kaoyan_vocab_current_user", "bob");
    const switched = await api.toggleUnknownWordContext(entry);
    localStorage.setItem("kaoyan_vocab_current_user", "alice");
    const removed = await api.toggleUnknownWordContext(entry);
    return { denied, switched, removed: removed.action, row: (await api.listUnknownWords())[0] };
  });
  assert.equal(result.denied, null); assert.equal(result.switched, null); assert.equal(result.removed, "removed");
  assert.deepEqual(result.row.occurrences, ["s2:0"]); assert.equal(result.row.meaning, "旧义");
  assert.equal(result.row.senses, undefined);
});

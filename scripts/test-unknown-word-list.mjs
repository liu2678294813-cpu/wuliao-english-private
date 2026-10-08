import test from "node:test";
import assert from "node:assert/strict";
import { buildUnknownWordList, readUnknownWordList, normalizeUnknownListTerm,
  filterResolvableUnknownRecords } from "../public/vocabulary/unknown-word-list.js";
import { normalizeUnknownTerm } from "../src/unknownWords.js";
import { withMemoryProgress } from "../public/vocabulary/memory-record.js";
import { readVocabularyTodayState } from "../src/studyPlannerSources.js";

const record = (id, word, meaning, extra = {}) => ({ id, username: "alice", word, meaning, ...extra });
const rows = [
  record("r1", "Issue", "问题", { createdAt: 1 }),
  record("r2", "issue", "议题", { createdAt: 2, senses: [
    { contextKey: "z", meaning: "发行", meaningSource: "manual-context" },
    { contextKey: "p", meaning: "pending-context", meaningSource: "pending-context" },
    { contextKey: "q", meaning: " 问题 ", meaningSource: "context-ai" },
  ] }),
  record("r3", " take   account of ", "考虑到"),
  record("r4", "private", "其他账号", { username: "bob" }),
];

test("标准化与现有 term 契约一致，支持词组及 Unicode", () => {
  for (const text of ["Issue", "ＩＳＳＵＥ", "take  account of", "don’t", "'word!'", "  take\naccount of  ", "123"]) {
    assert.equal(normalizeUnknownListTerm(text), normalizeUnknownTerm(text));
  }
});
test("多来源按词去重，释义去空去重且顺序稳定", () => {
  const result = buildUnknownWordList(rows, "alice");
  assert.deepEqual(result, [
    { wordId: "unknown:issue", english: "issue", chinese: "问题；议题；发行" },
    { wordId: "unknown:take account of", english: "take account of", chinese: "考虑到" },
  ]);
  assert.deepEqual(buildUnknownWordList([...rows].reverse(), "alice"), result);
});
test("坏记录不阻塞词库，无释义词保留，缺标准字段时使用 word", () => {
  assert.deepEqual(buildUnknownWordList([null, {}, record("x", null, {}),
    record("y", "Consequence", ""), record("z", "issue", "问题； 问题；议题")], "alice"),
  [{ wordId: "unknown:consequence", english: "consequence", chinese: "" },
    { wordId: "unknown:issue", english: "issue", chinese: "问题；议题" }]);
});
test("账号严格隔离，空账号和空词库安全", () => {
  assert.deepEqual(buildUnknownWordList(rows, "bob").map((word) => word.english), ["private"]);
  assert.deepEqual(buildUnknownWordList(rows, ""), []);
  assert.deepEqual(buildUnknownWordList([], "alice"), []);
});
test("复习只跳过无法解析的 unknown ID，普通记录保持", () => {
  const records = ["word_0000", "import:1", "unknown:issue", "unknown:deleted", "unknown:empty"]
    .map((wordId) => ({ wordId }));
  const words = [...buildUnknownWordList(rows, "alice"), { wordId: "unknown:empty", chinese: "" }];
  assert.deepEqual(filterResolvableUnknownRecords(records, words).map((row) => row.wordId),
    ["word_0000", "import:1", "unknown:issue"]);
});
test("删除重加使用相同统一 memory key，来源内容变化不更改 2/3 进度", () => {
  const word = buildUnknownWordList(rows, "alice")[0];
  const progress = withMemoryProgress({}, word.wordId, 4, { username: "alice", listKey: "unknown-words", now: 10 });
  assert.equal(progress.memoryKey, "alice:unknown-words:unknown:issue");
  assert.deepEqual(progress.sharedProgress, { count: 2, masked: false });
  const readded = buildUnknownWordList([record("new-source", "ISSUE", "发行")], "alice")[0];
  assert.equal(readded.wordId, word.wordId);
  assert.equal(withMemoryProgress(progress, readded.wordId, 4,
    { username: "alice", listKey: "unknown-words", now: 20 }).clickCount, 2);
});

function fakeSource({ missing = false, missingStore = false, noIndex = false, failure = false } = {}) {
  const calls = [], closes = [];
  return { calls, closes, open(...args) {
    calls.push(["open", ...args]);
    const request = { transaction: { abort() { calls.push(["abort"]); queueMicrotask(() => request.onerror()); } } };
    queueMicrotask(() => {
      if (missing) { request.onupgradeneeded(); return; }
      if (failure) { request.onerror(); return; }
      request.result = {
        objectStoreNames: { contains: () => !missingStore },
        close() { closes.push(true); },
        transaction(name, mode) {
          calls.push(["transaction", name, mode]);
          const transaction = {};
          const getAll = (username) => {
            const read = {};
            queueMicrotask(() => {
              read.result = username ? rows.filter((row) => row.username === username) : rows;
              read.onsuccess();
              transaction.oncomplete();
            });
            return read;
          };
          transaction.objectStore = () => ({ indexNames: { contains: () => !noIndex },
            index: () => ({ getAll }), getAll });
          return transaction;
        },
      };
      request.onsuccess();
    });
    return request;
  } };
}
test("数据库只读且不指定版本，账号索引读取后关闭连接", async () => {
  const indexedDB = fakeSource();
  const result = await readUnknownWordList("alice", { indexedDB });
  assert.equal(result.words.length, 2);
  assert.deepEqual(indexedDB.calls, [["open", "wuliao-english"], ["transaction", "unknown-words", "readonly"]]);
  assert.equal(indexedDB.closes.length, 1);
});
test("缺数据库中止创建，缺 store 安全空列表", async () => {
  const indexedDB = fakeSource({ missing: true });
  assert.equal((await readUnknownWordList("alice", { indexedDB })).error, "");
  assert.deepEqual(indexedDB.calls, [["open", "wuliao-english"], ["abort"]]);
  const missingStore = fakeSource({ missingStore: true });
  assert.deepEqual((await readUnknownWordList("alice", { indexedDB: missingStore })).words, []);
  assert.equal(missingStore.closes.length, 1);
});
test("缺索引仍按账号过滤；读取失败返回独立错误", async () => {
  assert.equal((await readUnknownWordList("bob", { indexedDB: fakeSource({ noIndex: true }) })).words.length, 1);
  assert.ok((await readUnknownWordList("alice", { indexedDB: fakeSource({ failure: true }) })).error);
  assert.ok((await readUnknownWordList("alice", { indexedDB: null })).error);
});
test("Planner 与 Review 共用有效词判断，删除源不产生幽灵待办", async () => {
  const records = ["unknown:issue", "unknown:deleted", "unknown:empty", "word_0000"]
    .map((wordId) => ({ username: "alice", wordId, maskedDates: ["2026-10-07"] }));
  const openDb = async () => ({
    close() {}, transaction() { return { objectStore() { return { getAll() {
      const request = {};
      queueMicrotask(() => { request.result = records; request.onsuccess(); });
      return request;
    } }; } }; },
  });
  const state = await readVocabularyTodayState({ username: "alice", date: "2026-10-07", openDb,
    readStorage: () => null, readUnknown: async () => ({ words: buildUnknownWordList(rows, "alice") }) });
  assert.equal(state.dueCount, 2);
  assert.equal(state.available, true);
});

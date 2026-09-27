// X1.1 考试完形笔迹契约（修改 3/6/7/9/10/11）：
// - cloze:main 是正式 Exam Ink Surface（EXAM_INK_SURFACES 内），record shape 不变、无 schema bump；
// - 完形 source fingerprint 复用项目统一 computeFileFingerprint，确定性且对正文/题号/选项敏感；
// - Surface Transaction：cloze ↔ reading / text ↔ text 必须 flush，同 Surface 切题不 flush；
// - Ink Registry：valid ref add/update，null delete，交卷 merge 不携带 stale ref；
// - flush 失败只标记 partial，不影响主状态机。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

import {
  EXAM_INK_SCHEMA_VERSION,
  EXAM_INK_SURFACES,
  examInkRegistryUpsert,
  examSurfaceFlushDecision,
  mergeExamInkRegistryWithFlush,
  saveExamInkSnapshot,
  getExamInkSnapshot,
} from "../src/exam/examInkStorage.js";
import { computeFileFingerprint } from "../src/fingerprint.js";

// ---------------- fake IndexedDB（与 test-exam-ink-storage 同构） ----------------

function createFakeIndexedDb() {
  const records = new Map();
  const databasesByName = new Map();
  function makeTransaction() {
    const transaction = {
      objectStore: () => store(),
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    setTimeout(() => {
      // 请求的 onsuccess 已通过微任务先于定时器完成，随后触发事务 complete。
      if (transaction.oncomplete) transaction.oncomplete();
    }, 0);
    return transaction;
  }
  const db = {
    name: "wuliao-english",
    version: 4,
    close() {},
    objectStoreNames: { contains: () => true },
    transaction: makeTransaction,
  };
  const store = () => ({
    get: (id) => makeRequest(() => records.get(id)),
    put: (value) => makeRequest(() => {
      records.set(value.id, value);
      return value;
    }),
  });
  function makeRequest(resolve) {
    const request = { result: resolve() };
    queueMicrotask(() => { if (request.onsuccess) request.onsuccess(); });
    return request;
  }
  databasesByName.set("wuliao-english", { stores: { "exam-ink": { records } } });
  return {
    records,
    databasesByName,
    open() {
      const request = { result: db };
      queueMicrotask(() => { if (request.onsuccess) request.onsuccess(); });
      return request;
    },
  };
}

// ---------------- cloze:main surface ----------------

test("cloze:main 是正式 Exam Ink Surface：save/get 正常工作，record shape 不变（无 schema bump）", async () => {
  const indexedDb = createFakeIndexedDb();
  assert.ok(EXAM_INK_SURFACES.includes("cloze:main"));
  assert.equal(EXAM_INK_SCHEMA_VERSION, 1, "cloze:main 只是新的 surfaceId，不需要 schema 升级");
  const saved = await saveExamInkSnapshot({
    username: "alice",
    sessionId: "x1-1",
    surfaceId: "cloze:main",
    sourceFingerprint: "cloze-src",
    strokes: [{ tool: "pen", points: [{ x: 0.1, y: 0.2 }] }],
    expectedRevision: 0,
    indexedDb,
  });
  assert.equal(saved.surfaceId, "cloze:main");
  assert.equal(saved.revision, 1);
  const loaded = await getExamInkSnapshot({
    username: "alice",
    sessionId: "x1-1",
    surfaceId: "cloze:main",
    expectedSourceFingerprint: "cloze-src",
    indexedDb,
  });
  assert.equal(loaded.status, "ok");
  assert.equal(loaded.snapshot.strokes.length, 1);
});

test("Exam 完形与阅读使用同一存储；不同 session 不互相污染", async () => {
  const indexedDb = createFakeIndexedDb();
  const base = { username: "alice", surfaceId: "cloze:main", sourceFingerprint: "s", expectedRevision: 0, indexedDb };
  await saveExamInkSnapshot({ ...base, sessionId: "x1-1", strokes: [{ id: "stroke-a" }] });
  const other = await getExamInkSnapshot({ ...base, sessionId: "x1-2", indexedDb });
  assert.equal(other.status, "missing");
});

// ---------------- cloze source fingerprint（修改 6/11） ----------------

test("完形 source fingerprint：确定性 + 对正文/题号/选项敏感 + 复用 computeFileFingerprint", async () => {
  const source = (text) => JSON.stringify({
    resourceId: "postgraduate-2020-cloze",
    passageText: text,
    blanks: [{ number: 1, options: [{ key: "A", text: "natives" }, { key: "B", text: "inhabitants" }] }],
  });
  const fp1 = await computeFileFingerprint(new TextEncoder().encode(source("The room was full of people.")));
  const fp2 = await computeFileFingerprint(new TextEncoder().encode(source("The room was full of people.")));
  assert.equal(fp1, fp2, "同一输入必须得到同一指纹");
  const changedText = await computeFileFingerprint(new TextEncoder().encode(source("The hall was full of people.")));
  assert.notEqual(fp1, changedText, "正文变化必须改变指纹");
  const changedOption = await computeFileFingerprint(new TextEncoder().encode(JSON.stringify({
    resourceId: "postgraduate-2020-cloze",
    passageText: "The room was full of people.",
    blanks: [{ number: 1, options: [{ key: "A", text: "natives" }, { key: "B", text: "locals" }] }],
  })));
  assert.notEqual(fp1, changedOption, "选项变化必须改变指纹");
  const changedBlank = await computeFileFingerprint(new TextEncoder().encode(JSON.stringify({
    resourceId: "postgraduate-2020-cloze",
    passageText: "The room was full of people.",
    blanks: [{ number: 2, options: [{ key: "A", text: "natives" }, { key: "B", text: "inhabitants" }] }],
  })));
  assert.notEqual(fp1, changedBlank, "Blank number 变化必须改变指纹");

  // 实现必须复用统一指纹能力，不得新增 Exam/Cloze 专用 FNV。
  const examSources = read("src/exam/examSources.js");
  assert.match(examSources, /computeFileFingerprint/);
  assert.doesNotMatch(examSources, /fnv1a/);
  assert.doesNotMatch(examSources, /Math\.random|Date\.now/);
  // 完形组首个 item 携带 passageFingerprint（与 Reading 组同一字段语义）。
  assert.match(examSources, /passageFingerprint: clozePassageFingerprint/);
});

// ---------------- Surface Transaction（修改 4/9） ----------------

test("examSurfaceFlushDecision：cloze↔reading / text↔text 必须 flush；同 Surface 切题不 flush", () => {
  const cloze = { section: "cloze", resourceId: "postgraduate-2020-cloze" };
  const t1 = { section: "reading", resourceId: "postgraduate-2020-english1-text-1" };
  const t1b = { section: "reading", resourceId: "postgraduate-2020-english1-text-1" };
  const t2 = { section: "reading", resourceId: "postgraduate-2020-english1-text-2" };

  assert.equal(examSurfaceFlushDecision(cloze, t1).shouldFlush, true);
  assert.equal(examSurfaceFlushDecision(cloze, t1).previousSurface, "cloze:main");
  assert.equal(examSurfaceFlushDecision(t1, cloze).shouldFlush, true);
  assert.equal(examSurfaceFlushDecision(t1, t2).shouldFlush, true);
  assert.equal(examSurfaceFlushDecision(t2, t1).shouldFlush, true);
  assert.equal(examSurfaceFlushDecision(t1, t1b).shouldFlush, false, "同一 Text 内切题（Q21→Q22）不得 flush");
  assert.equal(examSurfaceFlushDecision(undefined, t1).shouldFlush, false);
});

test("flush 失败语义：merge 只更新 registry，partial 状态单独报告，不影响答案/会话", () => {
  const merged = mergeExamInkRegistryWithFlush({ "reading:text-1": { revision: 1 } }, {
    inkRefs: { "reading:text-2": { revision: 3 } },
    inkStatus: "partial",
  });
  assert.equal(merged.registry["reading:text-1"].revision, 1);
  assert.equal(merged.registry["reading:text-2"].revision, 3);
  assert.equal(merged.partial, true);
  const clean = mergeExamInkRegistryWithFlush({}, { inkRefs: { "cloze:main": { revision: 2 } }, inkStatus: "complete" });
  assert.equal(clean.partial, false);
  const thrown = mergeExamInkRegistryWithFlush({ "cloze:main": { revision: 2 } }, null);
  assert.equal(thrown.partial, false);
  assert.equal(thrown.registry["cloze:main"].revision, 2, "flush 失败后保留 last verified ref");
});

// ---------------- Ink Registry（修改 7/10） ----------------

test("examInkRegistryUpsert：valid ref add/update；null delete（stale ref 不会进入 Result.inkRefs）", () => {
  const refA = { surfaceId: "cloze:main", revision: 1, fingerprint: "f1" };
  const refA2 = { surfaceId: "cloze:main", revision: 2, fingerprint: "f2" };
  const refB = { surfaceId: "reading:text-1", revision: 5, fingerprint: "f5" };

  let registry = {};
  registry = examInkRegistryUpsert(registry, "cloze:main", refA);
  registry = examInkRegistryUpsert(registry, "reading:text-1", refB);
  assert.deepEqual(registry, { "cloze:main": refA, "reading:text-1": refB });

  registry = examInkRegistryUpsert(registry, "cloze:main", refA2);
  assert.equal(registry["cloze:main"].revision, 2, "valid ref 必须覆盖旧 ref");

  // source-mismatch / damaged / clear 后 surface 上报 null → 删除旧 entry，
  // 交卷合并时不会出现引用失效历史 snapshot 的 stale ref。
  registry = examInkRegistryUpsert(registry, "cloze:main", null);
  assert.deepEqual(registry, { "reading:text-1": refB });
  registry = examInkRegistryUpsert(registry, "reading:text-1", null);
  assert.deepEqual(registry, {});
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAiRequestLifecycle, mergeAiRequestContext } from "../src/aiRequestLifecycle.js";

// ---------------- R4 已确认运行时缺陷的专项回归 ----------------

test("mergeAiRequestContext：派生空值绝不覆盖父上下文非空值", () => {
  const parent = { resourceId: "r1", passageId: "p1", clozeId: "c1" };
  // 普通讲解 / 快译 / 自由问答不带位置字段 → 不能把父上下文覆盖成空串
  assert.deepEqual(
    mergeAiRequestContext(parent, { type: "chat" }),
    { resourceId: "r1", passageId: "p1", clozeId: "c1", taskType: "chat" },
  );
  assert.deepEqual(
    mergeAiRequestContext(parent, { type: "quick-translate", text: "hello" }),
    { resourceId: "r1", passageId: "p1", clozeId: "c1", taskType: "quick-translate" },
  );
});

test("mergeAiRequestContext：派生非空值按请求覆盖", () => {
  const merged = mergeAiRequestContext(
    { resourceId: "r1", passageId: "p1" },
    { resourceId: "r1", passageId: "p1", questionId: "q1", type: "question-hint-1" },
  );
  assert.equal(merged.resourceId, "r1");
  assert.equal(merged.passageId, "p1");
  assert.equal(merged.questionId, "q1");
  assert.equal(merged.taskType, "question-hint-1");
});

test("mergeAiRequestContext：完形上下文独立覆盖 clozeId / sentenceId", () => {
  const merged = mergeAiRequestContext(
    { resourceId: "c1", clozeId: "cloze-1" },
    { clozeId: "cloze-1", sentenceId: "s1", taskType: "cloze-hint-1" },
  );
  assert.equal(merged.resourceId, "c1");
  assert.equal(merged.clozeId, "cloze-1");
  assert.equal(merged.sentenceId, "s1");
});

test("lifecycle：内容相同的新上下文对象不触发 abort（防每次渲染误杀 in-flight）", () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  const controller = new AbortController();
  const requestId = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId,
    context: { resourceId: "r1", passageId: "p1", taskType: "chat" },
    controller,
  });
  // 父组件每次渲染新建等值对象：setActiveContext 必须按值比较，不得 abort
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  lifecycle.setActiveContext({ passageId: "p1", resourceId: "r1" });
  assert.equal(controller.signal.aborted, false);
  assert.equal(lifecycle.isContextStale(requestId), false);
  // 真实上下文变化仍会 abort
  lifecycle.setActiveContext({ resourceId: "r2", passageId: "p1" });
  assert.equal(controller.signal.aborted, true);
});

// ---------------- Vocabulary 协议修复 ----------------

test("app-polish.js：EMBEDDED_INITIAL_HISTORY_LENGTH 已定义", async () => {
  const source = await readFile(resolve("public/vocabulary/app-polish.js"), "utf8");
  assert.match(source, /const\s+EMBEDDED_INITIAL_HISTORY_LENGTH\s*=\s*history\.length/);
  assert.doesNotMatch(source, /EMBEDDED_INITIAL_HISTORY_LENGTH[\s\S]{0,80}?undefined/);
});

test("app-polish.js：同时监听旧 postMessage 与 adapter CustomEvent", async () => {
  const source = await readFile(resolve("public/vocabulary/app-polish.js"), "utf8");
  for (const type of [
    "wuliao:vocabulary-navigate",
    "wuliao:vocabulary-auto-pronounce",
    "wuliao:vocabulary-shuffle",
    "wuliao:hardware-back",
  ]) {
    assert.match(source, new RegExp(`addEventListener\\("${type}"`), `${type} CustomEvent 监听缺失`);
    assert.match(source, new RegExp(`addEventListener\\("message"`), `${type} 的 message 兜底缺失`);
  }
});

test("embedded-vocabulary.js：监听 hardware-back CustomEvent", async () => {
  const source = await readFile(resolve("public/vocabulary/embedded-vocabulary.js"), "utf8");
  assert.match(source, /addEventListener\("wuliao:hardware-back"/);
});

test("vocabulary-bridge-adapter.js：父消息转 CustomEvent 且带 payload", async () => {
  const source = await readFile(resolve("public/vocabulary/vocabulary-bridge-adapter.js"), "utf8");
  assert.match(source, /wuliao:vocabulary-navigate/);
  assert.match(source, /wuliao:hardware-back/);
  assert.match(source, /dispatchLegacy/);
});

// ---------------- IndexedDB 基础修复 ----------------

test("storage.js：新库创建 custom-pdfs 时同时建 fingerprint 索引", async () => {
  const source = await readFile(resolve("src/storage.js"), "utf8");
  const createBranch = source.slice(source.indexOf("createObjectStore(STORE"), source.indexOf("} else {"));
  assert.match(createBranch, /store\.createIndex\("fingerprint"/);
  assert.match(createBranch, /store\.createIndex\("username"/);
});

test("storage.js：事务以 complete 为成功点并处理 onerror/onabort", async () => {
  const source = await readFile(resolve("src/storage.js"), "utf8");
  assert.match(source, /transaction\.oncomplete/);
  assert.match(source, /transaction\.onabort/);
  assert.match(source, /transaction\.onerror/);
  assert.match(source, /request\.onsuccess = \(event\) => \{ result = event\.target\.result/);
});

test("storage.js：删除自定义 PDF 同时清理解析缓存", async () => {
  const source = await readFile(resolve("src/storage.js"), "utf8");
  assert.match(source, /clearParseCache\(current\.fingerprint\)/);
});

// ---------------- 导入队列 / 构建链路 ----------------

test("App.jsx：Library 卸载时终止导入队列并 resolve 编辑器等待", async () => {
  const source = await readFile(resolve("src/App.jsx"), "utf8");
  assert.match(source, /aliveRef\.current = false/);
  assert.match(source, /editorResolveRef\.current\?\.\(\)/);
  assert.match(source, /if \(!aliveRef\.current\) return;/);
});

test("package.json：build 包含 vocabulary import integration patch", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.match(packageJson.scripts.build, /patch-vocabulary-import-integration\.mjs/);
  assert.match(packageJson.scripts["sites:build"], /patch-vocabulary-import-integration\.mjs/);
});

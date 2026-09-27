// 陌生词 shared interaction 契约（精读 / 完形消费同一套核心能力）：
// 1) 同一 token 识别规则：UNKNOWN_WORD_PATTERN 行为（含 data-unknown-ignore 排除）；
// 2) occurrenceId 格式稳定：`${scope}:${wordIndex}`（sentenceKey 可反查）；
// 3) 两个宿主都 import 共享 unknownWordInteraction，且都调用 storage.toggleUnknownWord
//    （同一 unknown-words store），完形记录 metadata sourceType=cloze；
// 4) 释义链同构：离线 lookupUnknownWordMeaning → AI lookupWordMeaningWithAi → updateUnknownWordMeaning。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://localhost/" });
for (const key of ["document", "Node", "NodeFilter", "Text", "Range", "Highlight"]) {
  globalThis[key] = dom.window[key];
}
globalThis.CSS = { highlights: new Map(), highlight: null };
globalThis.CSS.highlights.set = (name, value) => { globalThis.CSS.highlights.set._last = { name, value }; };
globalThis.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges; } };
globalThis.NodeFilter = dom.window.NodeFilter;

const { UNKNOWN_WORD_PATTERN, unknownWordRanges, collectUnknownTokenInto, createUnknownSelectionHooks } = await import("../src/unknownWordInteraction.js");
const { buildClozeUnknownEntry, unknownWordSourceType } = await import("../src/clozeUnknownWords.js");
const { normalizeUnknownWord } = await import("../src/unknownWords.js");

function makeScope(html, scopeId) {
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  const scope = host.firstElementChild;
  scope.dataset.unknownScope = scopeId;
  dom.window.document.body.replaceChildren(host);
  return scope;
}

test("同一 token 识别规则：UNKNOWN_WORD_PATTERN 切词与 data-unknown-ignore 排除", () => {
  const scope = makeScope(
    '<p data-unknown-scope="s1">One day, it\'s raining <button data-unknown-ignore>1 A</button> dogs.</p>',
    "cloze:s1",
  );
  const tokens = unknownWordRanges(scope);
  const words = tokens.map((token) => token.word);
  assert.deepEqual(words, ["One", "day", "it's", "raining", "dogs"], "blank chip 文本（1/A）被 data-unknown-ignore 排除");
  // occurrenceId 格式：`${scope.dataset.unknownScope}:${wordIndex}`
  assert.equal(tokens[0].occurrenceId, "cloze:s1:0");
  assert.equal(tokens[4].occurrenceId, "cloze:s1:4");
  // 反查：去掉尾部 :数字 得到 sentenceKey 前缀
  assert.equal(String(tokens[3].occurrenceId).replace(/:\d+$/, ""), "cloze:s1");
});

test("真实 sentenceKey 格式：occurrenceId 反查恒命中（AI 释义句子上下文）", () => {
  // clozeSentenceKeyFor 返回 `cloze:${source}:p${n}s${m}:${fingerprint}`（已含 cloze: 前缀），
  // data-unknown-scope 直接使用 sentenceKey，occurrenceId 去尾部数字后必须还原回该 key。
  const realKey = "cloze:xqh9kcf:p1s1:xmxhp7k";
  const scope = makeScope(`<p data-unknown-scope="${realKey}">By 1830 the former colonies.</p>`, realKey);
  const tokens = unknownWordRanges(scope);
  assert.equal(tokens[0].occurrenceId, `${realKey}:0`);
  assert.equal(String(tokens[0].occurrenceId).replace(/:\d+$/, ""), realKey, "反查结果即 sentenceKey，可命中 sentenceByKey");
  // 双重前缀（cloze:cloze:...）是历史 bug 形态：反查后不应残留 cloze:cloze:
  assert.ok(!realKey.startsWith("cloze:cloze:"), "sentenceKey 本身只含单层 cloze: 前缀");
});

test("normalize / toggle 语义共享：两宿主都消费 storage.toggleUnknownWord 与共享模块", () => {
  const deepReader = read("src/CustomDeepReader.jsx");
  const clozeReader = read("src/ClozeReader.jsx");
  // 两个宿主都 import 同一共享 interaction 模块
  assert.match(deepReader, /from "\.\/unknownWordInteraction"/);
  assert.match(clozeReader, /from "\.\/unknownWordInteraction"/);
  // 两个宿主都直接调用 storage.toggleUnknownWord（同一 unknown-words store）
  assert.match(deepReader, /toggleUnknownWord\(\{/);
  assert.match(clozeReader, /toggleUnknownWord\(buildClozeUnknownEntry/);
  // normalize 同一实现
  assert.equal(normalizeUnknownWord("  It’s "), "it's");
  assert.equal(normalizeUnknownWord("WOMEN'S"), "women's");
});

test("完形 entry metadata：sourceType=cloze + resourceId/clozeId/sourceLabel，主键语义不变", () => {
  const entry = buildClozeUnknownEntry({
    resource: { id: "postgraduate-2021-cloze", title: "2021 英语（一）完形填空", year: 2021 },
    word: "occupy",
    normalizedWord: "occupy",
    occurrenceId: "cloze:s:3",
    meaning: "占据",
  });
  assert.equal(entry.sourceType, "cloze");
  assert.equal(entry.resourceId, "postgraduate-2021-cloze");
  assert.equal(entry.clozeId, "postgraduate-2021-cloze");
  assert.equal(entry.passageId, "cloze");
  assert.equal(entry.sourceLabel, "2021 英语（一）完形填空");
  assert.equal(entry.year, 2021);
  assert.equal(unknownWordSourceType(entry), "cloze");
  assert.equal(unknownWordSourceType({}), "reading", "旧记录无 sourceType → reading（兼容）");
  assert.equal(unknownWordSourceType({ sourceType: "reading" }), "reading");
});

test("释义链同构：离线 lookupUnknownWordMeaning → AI lookupWordMeaningWithAi → updateUnknownWordMeaning", () => {
  const clozeReader = read("src/ClozeReader.jsx");
  assert.match(clozeReader, /lookupUnknownWordMeaning\(token\.word\)/);
  assert.match(clozeReader, /getAiApiKey\(\)/);
  assert.match(clozeReader, /lookupWordMeaningWithAi/);
  assert.match(clozeReader, /updateUnknownWordMeaning/);
  const deepReader = read("src/CustomDeepReader.jsx");
  assert.match(deepReader, /lookupUnknownWordMeaning\(token\.word\)/);
  assert.match(deepReader, /lookupWordMeaningWithAi/);
  assert.match(deepReader, /updateUnknownWordMeaning/);
});

test("selection 钩子共享：collectUnknownTokenInto 收集 + beforeInk* abort 语义", () => {
  const selection = { id: 7, tokens: new Map() };
  const fakeEvent = {
    pointerId: 7,
    clientX: 0,
    clientY: 0,
    preventDefault() {},
  };
  // 无命中：不写入 token，返回 null
  assert.equal(collectUnknownTokenInto(selection, fakeEvent), null);
  assert.equal(selection.tokens.size, 0);
  // beforeInkDown：非 unknown 工具 → undefined（不 abort）
  const hooks = createUnknownSelectionHooks({
    toolRef: { current: "pen" },
    selectionRef: { current: null },
    onCollect() {},
    onCommit() {},
    onError() {},
  });
  assert.equal(hooks.beforeInkDown(fakeEvent), undefined);
  // unknown 工具 → 启动 selection 并 abort
  const selectionRef = { current: null };
  const unknownHooks = createUnknownSelectionHooks({
    toolRef: { current: "unknown" },
    selectionRef,
    onCollect(event) { selectionRef.current.tokens.set("x", { word: "hello" }); },
    onCommit() {},
    onError() {},
  });
  assert.equal(unknownHooks.beforeInkDown(fakeEvent), "abort");
  assert.equal(selectionRef.current.id, 7);
  assert.equal(unknownHooks.beforeInkMove(fakeEvent), "abort");
  assert.equal(unknownHooks.beforeInkFinish(fakeEvent), "abort");
  assert.equal(selectionRef.current, null, "抬笔后 selection 会话清空");
});

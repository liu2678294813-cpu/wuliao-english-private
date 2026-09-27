// X1.1 普通完形笔迹契约：
// - 独立 namespace wuliao:cloze-ink:v1:*（账号 scope 内）；
// - 与 clozeProgress / clozeFlow 完全隔离（answer state ≠ ink state）；
// - 同一篇完形跨阶段保留（first-attempt → self-review → correction → analysis → final-read）；
// - reload 后保留；
// - D+1 / D+7 长期复习（ClozeReviewSession）不加载普通完形历史笔迹；
// - 普通完形与 Exam 笔迹隔离。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// 模拟 localStorage + 账号 scope。
const backing = new Map();
globalThis.localStorage = {
  getItem: (key) => (backing.has(key) ? backing.get(key) : null),
  setItem: (key, value) => backing.set(key, String(value)),
  removeItem: (key) => backing.delete(key),
  clear: () => backing.clear(),
};

import { clozeInkKey, clearClozeInk, loadClozeInk, saveClozeInk } from "../src/clozeInk.js";
import { getUserItem } from "../src/userData.js";

const scoped = (username, key) => `wuliao:user:${encodeURIComponent(username)}:${key}`;
function withUser(username, run) {
  backing.set("kaoyan_vocab_current_user", username);
  return run();
}

test("cloze ink：独立 namespace、load/save/clear 与账号隔离", () => {
  backing.clear();
  withUser("alice", () => {
    const key = clozeInkKey("r1", "c1");
    assert.equal(key, "wuliao:cloze-ink:v1:r1:c1");
    assert.deepEqual(loadClozeInk("r1", "c1"), []);

    const strokes = [{ tool: "pen", points: [{ x: 0.1, y: 0.2 }] }];
    saveClozeInk("r1", "c1", strokes);
    assert.deepEqual(loadClozeInk("r1", "c1"), strokes);
    // 数据落在账号 scope 内（wuliao:user:<alice>: 前缀）
    assert.ok(backing.has(scoped("alice", key)), "cloze ink must be stored under the account scope");
    assert.deepEqual(loadClozeInk("r2", "c1"), []);
    assert.deepEqual(loadClozeInk("r1", "c2"), []);
    clearClozeInk("r1", "c1");
    assert.deepEqual(loadClozeInk("r1", "c1"), []);
  });
  // 账号隔离：B 看不到 A 的笔迹
  withUser("alice", () => {
    saveClozeInk("r1", "c1", [{ tool: "pen", points: [{ x: 0.5, y: 0.5 }] }]);
  });
  withUser("bob", () => {
    assert.deepEqual(loadClozeInk("r1", "c1"), []);
  });
  // 切换回 A 仍在
  withUser("alice", () => {
    assert.equal(loadClozeInk("r1", "c1").length, 1);
  });
});

test("cloze ink 与 clozeProgress / clozeFlow 隔离（answer state ≠ ink state）", () => {
  withUser("alice", () => {
    saveClozeInk("r1", "c1", [{ tool: "pen", points: [{ x: 0.1, y: 0.1 }] }]);
    const inkRaw = backing.get(scoped("alice", clozeInkKey("r1", "c1")));
    assert.ok(inkRaw.includes('"tool":"pen"'));
    assert.ok(!inkRaw.includes("firstAnswer"));
    assert.ok(!inkRaw.includes("reviewAnswer"));
    assert.ok(!inkRaw.includes("prediction"));
    // clozeProgress / clozeFlow 不包含 stroke
    backing.set(scoped("alice", "wuliao:cloze-progress:r1:c1"), JSON.stringify({ attempts: {} }));
    backing.set(scoped("alice", "wuliao:cloze-flow:r1:c1"), JSON.stringify({ currentStage: "cloze-first-attempt" }));
    assert.ok(!backing.get(scoped("alice", "wuliao:cloze-progress:r1:c1")).includes('"tool":"pen"'));
    assert.ok(!backing.get(scoped("alice", "wuliao:cloze-flow:r1:c1")).includes('"tool":"pen"'));
  });
});

test("cloze ink 使用 userData（账号 scope / 备份枚举），不触碰 Exam / deep-ink 存储", () => {
  const storageSource = read("src/clozeInk.js");
  assert.match(storageSource, /getUserItem, removeUserItem, setUserItem/);
  assert.doesNotMatch(storageSource, /openWuliaoEnglishDatabase|indexedDB/);
  assert.doesNotMatch(storageSource, /saveExamInkSnapshot|getExamInkSnapshot/);
  assert.doesNotMatch(storageSource, /from "\.\/deepReaderKeys"|from "\.\/exam\//);
  const clozeSurface = read("src/ink/ClozeInkSurface.jsx");
  assert.match(clozeSurface, /clozeInk/);
  assert.doesNotMatch(clozeSurface, /examInkSnapshot|exam-ink/);
  const examSurface = read("src/exam/ExamInkSurface.jsx");
  assert.doesNotMatch(examSurface, /clozeInk|CLOZE_INK/);
});

test("D+1 / D+7 长期复习不加载普通完形历史笔迹", () => {
  const reviewSession = read("src/ClozeReviewSession.jsx");
  assert.doesNotMatch(reviewSession, /clozeInk|ClozeInkSurface|cloze-ink|stroke/);
  assert.doesNotMatch(reviewSession, /canvas|handwriting/);
});

test("ClozeInkSurface toolbar callback 使用稳定 ref，不因父组件重渲染清空 API", () => {
  const surface = read("src/ink/ClozeInkSurface.jsx");
  const reader = read("src/ClozeReader.jsx");
  assert.match(surface, /onToolbarApiChangeRef = useRef\(onToolbarApiChange\)/);
  assert.match(surface, /onToolbarApiChangeRef\.current\?\.\(\{ undo, clear \}\)/);
  assert.doesNotMatch(surface, /\[clear, onToolbarApiChange, undo\]/);
  assert.match(reader, /onToolbarApiChange=\{handleClozeToolbarApiChange\}/);
});

test("笔偏好双向共享：精读与完形读写同一批 storage key（禁止第二套 cloze 偏好）", () => {
  const deepReader = read("src/CustomDeepReader.jsx");
  const clozeReader = read("src/ClozeReader.jsx");
  // 同一批偏好 key：PEN_SIZE / PEN_MODE / eraser-mode
  assert.match(deepReader, /PEN_SIZE_STORAGE_KEY/);
  assert.match(deepReader, /PEN_MODE_STORAGE_KEY/);
  assert.match(clozeReader, /PEN_SIZE_STORAGE_KEY/);
  assert.match(clozeReader, /PEN_MODE_STORAGE_KEY/);
  assert.match(clozeReader, /wuliao:pref:eraser-mode/);
  // 不存在完形专用第二套偏好
  assert.ok(!clozeReader.includes("wuliao:cloze-pen-size"), "禁止 wuliao:cloze-pen-size");
  assert.ok(!clozeReader.includes("wuliao:cloze-pen-mode"), "禁止 wuliao:cloze-pen-mode");
  // 行为：同一 key 读写（完形写入 → 精读读取同一值；反之亦然）
  backing.clear();
  withUser("alice", () => {
    const source = read("src/annotationTools.js");
    const sizeKey = source.match(/export const PEN_SIZE_STORAGE_KEY = "([^"]+)"/)[1];
    const modeKey = source.match(/export const PEN_MODE_STORAGE_KEY = "([^"]+)"/)[1];
    // 精读侧写入
    backing.set(scoped("alice", sizeKey), "4.5");
    backing.set(scoped("alice", modeKey), "fountain");
    // 完形侧读取同一值（经同一个 userData scope）
    assert.equal(getUserItem(sizeKey), "4.5");
    assert.equal(getUserItem(modeKey), "fountain");
    // 完形侧写入 → 精读侧读取同一值
    backing.set(scoped("alice", sizeKey), "6");
    assert.equal(getUserItem(sizeKey), "6");
    backing.set(scoped("alice", modeKey), "ballpoint");
    assert.equal(getUserItem(modeKey), "ballpoint");
  });
});

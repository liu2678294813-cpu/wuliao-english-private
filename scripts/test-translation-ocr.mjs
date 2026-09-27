import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
const { getUserItem, setUserItem, setCurrentUsername } = await import("../src/userData.js");
const { translationOcrTarget, readTranslationOcr, pendingLegacyTranslation, saveConfirmedTranslation } = await import("../src/translationOcrStorage.js");
const { passageClearableKeys, translationLegacyDismissedKey } = await import("../src/deepReaderKeys.js");
const { parseTranslationOcr, recognizeTranslationInk } = await import("../src/translationOcrAi.js");
const { TRANSPORT_KINDS } = await import("../src/aiProvider.js");
const { captureTranslationInk } = await import("../src/translationOcrImage.js");
const { createBackup, parseBackup, restoreBackup } = await import("../src/backup.js");

function target(overrides = {}) {
  return translationOcrTarget({ username: "ocr-alice", resourceId: "r1", passageId: "p1", paragraphNumber: 1, sentenceIndex: 0, sentence: "Technology changes our lives.", ...overrides });
}
function fresh() { localStorage.clear(); setCurrentUsername("ocr-alice"); }

test("same sentence position is isolated by account, resource and passage", () => {
  fresh();
  const first = target(), second = target({ resourceId: "r2" }), third = target({ passageId: "p2" });
  saveConfirmedTranslation(first, { text: "科技改变生活。", inkFingerprint: "one", expectedText: "" });
  assert.equal(getUserItem(second.storageKey), null);
  assert.equal(getUserItem(third.storageKey), null);
  assert.equal(getUserItem(first.storageKey, "bob"), null);
  assert.equal(readTranslationOcr(first).inkFingerprint, "one");
  assert.throws(() => target({ resourceId: { id: "r1" } }), /无效/);
});

test("legacy text requires explicit binding, keeps source and cannot bind twice", () => {
  fresh();
  const first = target(), second = target({ resourceId: "r2" });
  const oldKey = "wuliao:deep-translation:[object Object]:[object Object]:1:0";
  setUserItem(oldKey, "待核实的旧译文");
  const legacy = pendingLegacyTranslation(first);
  assert.equal(getUserItem(first.storageKey), null);
  saveConfirmedTranslation(first, { text: legacy.text, source: "legacy", legacy });
  assert.equal(getUserItem(oldKey), legacy.text);
  assert.equal(pendingLegacyTranslation(second), null);
  assert.throws(() => saveConfirmedTranslation(second, { text: legacy.text, legacy }), /已变更或已确认/);
});

test("canonical text takes precedence over ambiguous legacy content", () => {
  fresh();
  setUserItem("wuliao:deep-translation:[object Object]:[object Object]:1:0", "旧文字");
  setUserItem(target().storageKey, "正确所属文字");
  assert.equal(pendingLegacyTranslation(target()), null);
});

test("backup round trip retains sentence ownership, ink revision, legacy binding and dismissal", async () => {
  fresh();
  const first = target(), second = target({ resourceId: "r2" });
  const oldKey = "wuliao:deep-translation:[object Object]:[object Object]:1:0";
  setUserItem(oldKey, "待确认旧文字");
  saveConfirmedTranslation(first, { text: "第一篇的确认译文", inkFingerprint: "first-ink", source: "legacy", legacy: pendingLegacyTranslation(first) });
  saveConfirmedTranslation(second, { text: "第二篇的确认译文", inkFingerprint: "second-ink" });
  setUserItem(translationLegacyDismissedKey("cleared", "p1"), "1");
  const before = [...localStorage.map.entries()].filter(([key]) => key.startsWith("wuliao:user:ocr-alice:"));
  const { manifest } = await createBackup({ username: "ocr-alice", sources: { entries: [...localStorage.map.entries()].map(([key, value]) => ({ key, value })), databases: [] } });
  const parsed = await parseBackup(JSON.stringify(manifest));
  fresh();
  const writeLocal = async ({ key, value }) => localStorage.setItem(key, value);
  writeLocal.read = key => localStorage.getItem(key);
  const result = await restoreBackup({ manifest: parsed, username: "ocr-alice", existingEntries: [], writeLocal });
  assert.equal(result.ok, true);
  for (const [key, value] of before) assert.equal(localStorage.getItem(key), value);
  assert.equal(getUserItem(first.storageKey), "第一篇的确认译文");
  assert.equal(getUserItem(second.storageKey), "第二篇的确认译文");
  assert.equal(readTranslationOcr(first).inkFingerprint, "first-ink");
  assert.equal(readTranslationOcr(second).inkFingerprint, "second-ink");
  assert.equal(pendingLegacyTranslation(target({ resourceId: "r3" })), null);
  assert.equal(pendingLegacyTranslation(target({ resourceId: "cleared" })), null);
  await assert.rejects(restoreBackup({ manifest: parsed, username: "bob", existingEntries: [], writeLocal }), /不能恢复到当前账号/);
});

test("page clear removes recognition metadata and keeps the legacy tombstone", () => {
  fresh();
  const item = target();
  setUserItem("wuliao:deep-translation:[object Object]:[object Object]:1:0", "旧文字");
  saveConfirmedTranslation(item, { text: "电子译文", inkFingerprint: "ink" });
  const tombstone = translationLegacyDismissedKey("r1", "p1");
  setUserItem(tombstone, "1");
  const keys = passageClearableKeys({ id: "r1" }, { id: "p1", paragraphs: [{ number: 1, sentences: [item.sentence] }] });
  assert.ok(keys.includes(item.metadataKey));
  assert.ok(!keys.includes(tombstone));
  for (const key of keys) localStorage.removeItem(`wuliao:user:ocr-alice:${key}`);
  assert.equal(getUserItem(item.storageKey), null);
  assert.equal(readTranslationOcr(item), null);
  assert.equal(pendingLegacyTranslation(item), null);
});

test("storage failure rolls back previous confirmed text and metadata", () => {
  fresh();
  const item = target();
  saveConfirmedTranslation(item, { text: "原译文", inkFingerprint: "original" });
  const previous = [...localStorage.map.entries()];
  const originalWrite = localStorage.setItem;
  let failed = false;
  localStorage.setItem = function (key, value) {
    if (!failed && key.endsWith(item.storageKey)) { failed = true; throw new Error("quota"); }
    return originalWrite.call(this, key, value);
  };
  try { assert.throws(() => saveConfirmedTranslation(item, { text: "新译文", inkFingerprint: "new" }), /未能完整保存/); }
  finally { localStorage.setItem = originalWrite; }
  assert.deepEqual([...localStorage.map.entries()], previous);
});

test("storage read-back failure cannot report success", () => {
  fresh();
  const item = target(), write = localStorage.setItem;
  localStorage.setItem = function (key, value) { if (!key.endsWith(item.metadataKey)) write.call(this, key, value); };
  try { assert.throws(() => saveConfirmedTranslation(item, { text: "译文" }), /未能完整保存/); }
  finally { localStorage.setItem = write; }
  assert.equal(getUserItem(item.storageKey), null);
});

test("new edits, account switches and altered legacy records reject stale saves", () => {
  fresh();
  const item = target();
  setUserItem(item.storageKey, "其他窗口的新译文");
  assert.throws(() => saveConfirmedTranslation(item, { text: "识别稿", expectedText: "" }), /其他位置修改/);
  setCurrentUsername("bob");
  assert.throws(() => saveConfirmedTranslation(item, { text: "识别稿" }), /账号已切换/);
  assert.equal(getUserItem(item.storageKey, "ocr-alice"), "其他窗口的新译文");
});

test("damaged or different-source metadata is not used for a sentence", () => {
  fresh();
  setUserItem(target().metadataKey, "broken");
  assert.equal(readTranslationOcr(target()), null);
  saveConfirmedTranslation(target(), { text: "译文" });
  assert.equal(readTranslationOcr(target({ sentence: "Different sentence." })), null);
});

test("OCR parsing preserves spelling, mixed scripts and uncertainty", () => {
  assert.deepEqual(parseTranslationOcr('```json\n{"text":"他在2026年用AI。［不清楚］","unsure":true}\n```'), { text: "他在2026年用AI。［不清楚］", unsure: true });
  for (const content of ['{"text":"a"}', '{"text":12,"unsure":false}', "wrong", "null"]) assert.throws(() => parseTranslationOcr(content), /格式无效/);
});

for (const transportKind of [TRANSPORT_KINDS.CHAT, TRANSPORT_KINDS.RESPONSES]) {
  test(`vision request uses configured ${transportKind} and contains only the ink image`, async () => {
    let sent;
    const profile = { baseUrl: "https://ocr.invalid/v1", modelId: "vision-test", transportOverride: transportKind };
    const result = await recognizeTranslationInk({ image: "data:image/png;base64,test" }, { profile, request: async (options) => { sent = options; return { content: '{"text":"原样译文","unsure":false}' }; } });
    assert.equal(sent.profile, profile);
    assert.equal(sent.messages[1].content.length, 1);
    assert.equal(sent.messages[1].content[0].type, transportKind === TRANSPORT_KINDS.RESPONSES ? "input_image" : "image_url");
    assert.equal(transportKind === TRANSPORT_KINDS.RESPONSES ? sent.messages[1].content[0].detail : sent.messages[1].content[0].image_url.detail, "high");
    assert.equal(sent.timeoutMs, 45000);
    assert.equal(result.text, "原样译文");
  });
}

test("empty images and cancellation do not produce usable recognition results", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const options = { profile: { baseUrl: "https://ocr.invalid", modelId: "vision-test" }, request: async () => { calls++; return { content: '{"text":"旧结果","unsure":false}' }; } };
  await assert.rejects(recognizeTranslationInk({ image: "" }, options), /没有可识别/);
  await assert.rejects(recognizeTranslationInk({ image: "image", signal: controller.signal }, options), { name: "AbortError" });
  assert.equal(calls, 0);
});

function captureFixture({ scale = 1, strokes = [], activeStroke = null } = {}) {
  const writingElement = { getBoundingClientRect: () => ({ left: 20 * scale, top: 110 * scale, width: 200 * scale, height: 70 * scale }) };
  const contentElement = {
    contains: item => item === writingElement, offsetWidth: 500, offsetHeight: 1200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500 * scale, height: 1200 * scale }), querySelectorAll: () => [],
  };
  return captureTranslationInk({ strokes, writingElement, contentElement, activeStroke });
}
function stroke(y, tool = "pen") { return { tool, width: 3, color: "#000", points: [{ x: .1, y: y / 1200 }, { x: .3, y: y / 1200 }] }; }

test("single-row capture excludes source/adjacent rows, keeps erasers and never changes ink", () => {
  const strokes = [stroke(80), stroke(130), stroke(145, "eraser"), stroke(210)];
  const before = structuredClone(strokes);
  const first = captureFixture({ strokes });
  assert.equal(first.strokes.length, 2);
  assert.equal(first.strokes[1].tool, "eraser");
  assert.deepEqual(strokes, before);
  assert.deepEqual(first, captureFixture({ strokes, scale: .75 }));
  strokes[1].points[0].x = .15;
  assert.equal(first.strokes[0].points[0].x, .1);
  assert.notEqual(first.fingerprint, captureFixture({ strokes }).fingerprint);
});

test("an active pen stroke is not forcibly committed for OCR", () => {
  assert.throws(() => captureFixture({ activeStroke: {} }), /抬笔/);
});

import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type;
  }
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { setCurrentUsername } = await import("../src/userData.js");
const { createDebouncedStorageWriter } = await import("../src/debouncedStorage.js");
const {
  deepNavigationNoteKey,
  passageClearableKeys,
  passageInkKey,
  passageStageInkKey,
  passageStageInkMigrationKey,
  passageThemeKey,
  paragraphCompressKey,
  paragraphSummaryKey,
  translationMethodKey,
  translationOcrKey,
  translationTextKey,
} = await import("../src/deepReaderKeys.js");
const { STAGE_IDS } = await import("../src/readingFlow.js");
const {
  emptyProgress,
  markCorrected,
  markParagraphCompleted,
  markTranslated,
  resetPassageProgress,
  sentenceKeyFor,
} = await import("../src/translationProgress.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const RESOURCE = { id: "res-1" };
const PASSAGE = {
  id: "passage-1",
  paragraphs: [
    {
      number: 1,
      sentences: ["The first sentence is here.", "The second sentence follows."],
    },
    {
      number: 2,
      sentences: ["Another paragraph starts."],
    },
  ],
};

test("清空键枚举覆盖当前 passage 全部键盘输入与笔迹键", () => {
  fresh();
  const keys = passageClearableKeys(RESOURCE, PASSAGE);
  assert.ok(keys.includes(deepNavigationNoteKey(RESOURCE.id, PASSAGE.id)));
  assert.ok(keys.includes(translationTextKey(RESOURCE.id, PASSAGE.id, 1, 0)));
  assert.ok(keys.includes(translationTextKey(RESOURCE.id, PASSAGE.id, 1, 1)));
  assert.ok(keys.includes(translationTextKey(RESOURCE.id, PASSAGE.id, 2, 0)));
  assert.ok(keys.includes(translationMethodKey(RESOURCE.id, PASSAGE.id, 2, 0)));
  assert.ok(keys.includes(translationOcrKey(RESOURCE.id, PASSAGE.id, 2, 0)));
  assert.ok(keys.includes(paragraphSummaryKey(RESOURCE.id, PASSAGE.id, 1)));
  assert.ok(keys.includes(paragraphCompressKey(RESOURCE.id, PASSAGE.id, 2)));
  assert.ok(keys.includes(passageThemeKey(RESOURCE.id, PASSAGE.id)));
  assert.ok(keys.includes(passageInkKey(RESOURCE.id, PASSAGE.id)));
  assert.ok(keys.includes(passageStageInkMigrationKey(RESOURCE.id, PASSAGE.id)));
  STAGE_IDS.forEach((stageId) => assert.ok(keys.includes(passageStageInkKey(RESOURCE.id, PASSAGE.id, stageId))));
  assert.equal(keys.length, 1 + 3 * 3 + 2 * 2 + 1 + 1 + 1 + STAGE_IDS.length);
});

test("清空键不会包含答案/证据/AI/流程键", () => {
  fresh();
  const keys = passageClearableKeys(RESOURCE, PASSAGE);
  assert.ok(!keys.some((key) => key.includes("deep-answers")));
  assert.ok(!keys.some((key) => key.includes("evidence")));
  assert.ok(!keys.some((key) => key.includes("reading-flow")));
  assert.ok(!keys.some((key) => key.includes("unknown")));
  assert.ok(!keys.some((key) => key.includes("review-task")));
});

test("resetPassageProgress 只重置当前 resource/passage 的译文状态", () => {
  fresh();
  let progress = emptyProgress(RESOURCE.id, PASSAGE.id);
  const key = sentenceKeyFor({
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: PASSAGE.paragraphs[0].sentences[0],
  });
  progress = markTranslated(progress, key);
  progress = markCorrected(progress, key, { translationText: "译文" });
  progress = markParagraphCompleted(progress, 1);

  const reset = resetPassageProgress(progress);
  assert.equal(reset.resourceId, RESOURCE.id);
  assert.equal(reset.passageId, PASSAGE.id);
  assert.deepEqual(reset.sentences, {});
  assert.deepEqual(reset.paragraphs, {});
  assert.equal(typeof reset.updatedAt, "number");

  const other = resetPassageProgress(emptyProgress("res-2", PASSAGE.id));
  assert.equal(other.resourceId, "res-2");
});

test("debounced writer reset 会取消 pending write 且 flush 不写旧值", () => {
  const writes = [];
  const removes = [];
  let pendingCallback = null;
  let timerId = 0;
  const writer = createDebouncedStorageWriter({
    read: () => "",
    write: (value) => writes.push(value),
    remove: () => removes.push("removed"),
    schedule: (callback) => {
      timerId += 1;
      pendingCallback = callback;
      return timerId;
    },
    cancel: (id) => {
      if (id === timerId) pendingCallback = null;
    },
    delay: 300,
  });

  writer.setLatest("旧文字");
  assert.equal(writer.hasPending(), true);
  writer.reset();
  assert.equal(writer.hasPending(), false);
  assert.equal(writer.isCleared(), true);
  assert.deepEqual(removes, ["removed"]);

  writer.flush();
  assert.deepEqual(writes, []);
  assert.deepEqual(removes, ["removed", "removed"]);

  writer.setLatest("新文字");
  assert.equal(writer.isCleared(), false);
  pendingCallback?.();
  assert.deepEqual(writes, ["新文字"]);
});

test("reset 会取消未执行的 timer，旧值不会写回", () => {
  const writes = [];
  const removes = [];
  let pendingCallback = null;
  const writer = createDebouncedStorageWriter({
    read: () => "",
    write: (value) => writes.push(value),
    remove: () => removes.push("removed"),
    schedule: (callback) => {
      pendingCallback = callback;
      return 1;
    },
    cancel: (id) => {
      if (id === 1) pendingCallback = null;
    },
    delay: 300,
  });

  writer.setLatest("待清空");
  const staleCallback = pendingCallback;
  writer.reset();
  staleCallback?.();
  assert.deepEqual(writes, []);
  assert.deepEqual(removes, ["removed", "removed"]);
});

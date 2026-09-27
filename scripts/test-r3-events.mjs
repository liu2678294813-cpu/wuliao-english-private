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
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || null;
  }
};
globalThis.document = {};

const listeners = new Map();
globalThis.window = {
  addEventListener(name, handler) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
  },
  removeEventListener(name, handler) {
    const list = listeners.get(name) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  dispatchEvent(event) {
    for (const handler of [...(listeners.get(event.type) || [])]) {
      handler(event);
    }
  },
};

const { AppEvent, AppEventName } = await import("../src/events/eventTypes.js");
const { emitAppEvent, onAppEvent, isKnownAppEvent } = await import("../src/events/appEvents.js");
const { setCurrentUsername } = await import("../src/userData.js");
const { REVIEW_TASKS_UPDATED } = await import("../src/readingReview.js");
const { CLOZE_REVIEW_TASKS_UPDATED } = await import("../src/clozeReview.js");
const { STUDY_PLAN_UPDATED } = await import("../src/studyPlanner.js");
const { studyRankEventName } = await import("../src/studyRank.js");
const { upsertTranslationReviewRecord } = await import("../src/aiLearningRecords.js");

test("emit / subscribe 收到 payload 且事件名一致", () => {
  let received = null;
  const off = onAppEvent(AppEvent.ACCOUNT_CHANGED, (payload, event) => {
    received = { payload, eventType: event.type };
  });
  emitAppEvent(AppEvent.ACCOUNT_CHANGED, { username: "alice" });
  assert.deepEqual(received.payload, { username: "alice" });
  assert.equal(received.eventType, AppEvent.ACCOUNT_CHANGED);
  off();
});

test("unsubscribe 后不再收到", () => {
  let count = 0;
  const off = onAppEvent(AppEvent.RANK_UPDATED, () => {
    count += 1;
  });
  emitAppEvent(AppEvent.RANK_UPDATED);
  off();
  emitAppEvent(AppEvent.RANK_UPDATED);
  assert.equal(count, 1);
});

test("payload 透传且默认空对象", () => {
  let withPayload = null;
  let withoutPayload = null;
  const off1 = onAppEvent("wuliao:custom-payload-test", (payload) => {
    withPayload = payload;
  });
  const off2 = onAppEvent("wuliao:custom-no-payload-test", (payload) => {
    withoutPayload = payload;
  });
  emitAppEvent("wuliao:custom-payload-test", { a: 1 });
  emitAppEvent("wuliao:custom-no-payload-test");
  assert.deepEqual(withPayload, { a: 1 });
  assert.deepEqual(withoutPayload, {});
  off1();
  off2();
});

test("SSR / 无 window 环境不抛错", () => {
  const realWindow = globalThis.window;
  delete globalThis.window;
  let threw = false;
  try {
    emitAppEvent(AppEvent.ACCOUNT_CHANGED, { username: "ssr" });
    const off = onAppEvent(AppEvent.ACCOUNT_CHANGED, () => {});
    off();
  } catch {
    threw = true;
  }
  globalThis.window = realWindow;
  assert.equal(threw, false);
});

test("事件名集中且业务模块常量值一致", () => {
  assert.equal(AppEvent.REVIEW_TASKS_UPDATED, REVIEW_TASKS_UPDATED);
  assert.equal(AppEvent.CLOZE_REVIEW_TASKS_UPDATED, CLOZE_REVIEW_TASKS_UPDATED);
  assert.equal(AppEvent.STUDY_PLAN_UPDATED, STUDY_PLAN_UPDATED);
  assert.equal(AppEvent.RANK_UPDATED, studyRankEventName);
  for (const name of Object.values(AppEvent)) {
    assert.equal(isKnownAppEvent(name), true);
  }
  assert.equal(AppEventName.has("wuliao:not-registered"), false);
});

test("legacy 兼容：业务模块派发的事件可被 onAppEvent 订阅", async () => {
  const seen = [];
  const off = onAppEvent(AppEvent.ACCOUNT_CHANGED, (payload) => {
    seen.push(payload);
  });
  setCurrentUsername("alice");
  setCurrentUsername("bob");
  setCurrentUsername("");
  off();
  assert.deepEqual(seen, [{ username: "alice" }, { username: "bob" }, { username: "" }]);
});

test("AI learning records 写入触发集中事件", async () => {
  setCurrentUsername("alice");
  let updated = 0;
  const off = onAppEvent(AppEvent.LEARNING_RECORDS_UPDATED, () => {
    updated += 1;
  });
  upsertTranslationReviewRecord({
    resourceId: "r1",
    chapter: "chapter",
    sentenceId: "s1",
    itemId: "s1",
    itemLabel: "第1段第1句",
    inputMethod: "typed",
    errorTags: ["漏译"],
    summaryLevel: "needs-revision",
    sentenceSnippet: "snippet",
  });
  off();
  assert.ok(updated >= 1);
});

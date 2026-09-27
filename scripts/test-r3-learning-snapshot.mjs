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

const { setCurrentUsername, setUserItem } = await import("../src/userData.js");
const {
  getLearningSnapshot,
  getLearningSnapshotRevision,
  getLearningSnapshotScanCount,
  isSnapshotStale,
} = await import("../src/learningSnapshot.js");
const { emptyFlow, saveReadingFlow } = await import("../src/readingFlow.js");
const { emptyClozeFlow, saveClozeFlow } = await import("../src/clozeFlow.js");
const { emptyClozeProgress, saveClozeProgress } = await import("../src/clozeProgress.js");
const {
  emptyClozeTranslationProgress,
  saveClozeTranslationProgress,
} = await import("../src/clozeTranslationProgress.js");
const { emptyProgress, saveTranslationProgress } = await import("../src/translationProgress.js");

const TODAY = "2026-08-10";

function fresh(username = "alice") {
  globalThis.localStorage.clear();
  setCurrentUsername(username);
}

function invalidate() {
  globalThis.window.dispatchEvent(new globalThis.CustomEvent("wuliao:learning-state-invalidated"));
}

test("同一次 revision 多消费者不重复完整 scan", () => {
  fresh();
  const first = getLearningSnapshot({ today: TODAY, force: true });
  const second = getLearningSnapshot({ today: TODAY });
  const third = getLearningSnapshot({ today: TODAY });
  assert.equal(first.revision, second.revision);
  assert.equal(first.revision, third.revision);
  assert.equal(getLearningSnapshotScanCount(), 1);
  assert.equal(first.scan.today, TODAY);
  assert.equal(first.username, "alice");
});

test("reading 更新会使快照失效并反映到新扫描", () => {
  fresh();
  const before = getLearningSnapshot({ today: TODAY, force: true });
  assert.equal(before.scan.flows.size, 0);

  const flow = emptyFlow("r1", "p1", 1000);
  flow.currentStage = "deep-translation";
  saveReadingFlow(flow);

  const after = getLearningSnapshot({ today: TODAY });
  assert.ok(after.revision > before.revision);
  assert.equal(after.scan.flows.size, 1);
  assert.equal(after.scan.flows.get("r1\u0000p1").currentStage, "deep-translation");
});

test("cloze flow / progress / translation 更新会使快照失效", () => {
  fresh();
  const before = getLearningSnapshot({ today: TODAY, force: true });

  saveClozeFlow(emptyClozeFlow("c1", "cloze-1", 2000));
  const afterFlow = getLearningSnapshot({ today: TODAY });
  assert.ok(afterFlow.revision > before.revision);

  saveClozeProgress(emptyClozeProgress("c1", "cloze-1", [1, 2, 3], 3000));
  const afterProgress = getLearningSnapshot({ today: TODAY });
  assert.ok(afterProgress.revision > afterFlow.revision);

  saveClozeTranslationProgress(emptyClozeTranslationProgress("c1", "cloze-1", 4000));
  const afterTranslation = getLearningSnapshot({ today: TODAY });
  assert.ok(afterTranslation.revision > afterProgress.revision);
});

test("reading translation 更新会使快照失效", () => {
  fresh();
  const before = getLearningSnapshot({ today: TODAY, force: true });
  saveTranslationProgress(emptyProgress("r1", "p1"));
  const after = getLearningSnapshot({ today: TODAY });
  assert.ok(after.revision > before.revision);
});

test("AI learning record 更新会使快照失效", () => {
  fresh();
  const before = getLearningSnapshot({ today: TODAY, force: true });
  globalThis.window.dispatchEvent(
    new globalThis.CustomEvent("wuliao:learning-records-updated"),
  );
  const after = getLearningSnapshot({ today: TODAY });
  assert.ok(after.revision > before.revision);
});

test("vocabulary session 更新会使快照失效", () => {
  fresh();
  const before = getLearningSnapshot({ today: TODAY, force: true });
  globalThis.window.dispatchEvent(
    new globalThis.CustomEvent("wuliao:vocabulary-session-updated"),
  );
  const after = getLearningSnapshot({ today: TODAY });
  assert.ok(after.revision > before.revision);
});

test("账号切换不复用旧账号 snapshot", () => {
  fresh("alice");
  const alice = getLearningSnapshot({ today: TODAY, force: true });
  assert.equal(alice.username, "alice");

  fresh("bob");
  const bob = getLearningSnapshot({ today: TODAY, force: true });
  assert.equal(bob.username, "bob");
  assert.ok(bob.revision > alice.revision);

  const bobAgain = getLearningSnapshot({ today: TODAY });
  assert.equal(bobAgain.username, "bob");
  assert.equal(bobAgain.revision, bob.revision);
});

test("force refresh 强制重新扫描", () => {
  fresh();
  getLearningSnapshot({ today: TODAY, force: true });
  const countAfterFirst = getLearningSnapshotScanCount();
  const forced = getLearningSnapshot({ today: TODAY, force: true });
  assert.equal(forced.revision, getLearningSnapshotRevision());
  assert.ok(getLearningSnapshotScanCount() > countAfterFirst);
});

test("stale async 结果不覆盖新 revision", () => {
  fresh();
  const snapshot = getLearningSnapshot({ today: TODAY, force: true });
  assert.equal(isSnapshotStale(snapshot), false);

  invalidate();
  assert.equal(isSnapshotStale(snapshot), true);

  const freshSnapshot = getLearningSnapshot({ today: TODAY });
  assert.equal(isSnapshotStale(freshSnapshot), false);
});

test("快照是运行时派生缓存，不新增持久化数据", () => {
  fresh();
  getLearningSnapshot({ today: TODAY, force: true });
  const keys = [];
  for (let index = 0; index < globalThis.localStorage.length; index += 1) {
    keys.push(globalThis.localStorage.key(index));
  }
  assert.ok(!keys.some((key) => /learning-snapshot|snapshot/i.test(String(key))));
});

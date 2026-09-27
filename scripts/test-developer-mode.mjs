import test from "node:test";
import assert from "node:assert/strict";

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

const { createDeveloperMode } = await import("../src/developerMode.js");

test("Developer Mode 默认关闭", () => {
  const mode = createDeveloperMode({ storage: memoryStorage(), pin: "123456" });
  assert.equal(mode.isDeveloperMode(), false);
});

test("版本连点不足不会开启", () => {
  const mode = createDeveloperMode({ storage: memoryStorage(), pin: "123456" });
  let state = null;
  for (let index = 0; index < 6; index += 1) {
    state = mode.tapVersion();
  }
  assert.equal(state.ready, false);
  assert.equal(mode.isDeveloperMode(), false);
});

test("超过时间窗口计数自动重置", () => {
  let fakeNow = 0;
  const mode = createDeveloperMode({ storage: memoryStorage(), pin: "123456", now: () => fakeNow });
  mode.tapVersion();
  mode.tapVersion();
  fakeNow += 7000;
  const state = mode.tapVersion();
  assert.equal(state.count, 1);
  assert.equal(state.ready, false);
});

test("7 次点击后进入 PIN 流程，错误 PIN 不能开启", () => {
  const storage = memoryStorage();
  const mode = createDeveloperMode({ storage, pin: "123456" });
  let state = null;
  for (let index = 0; index < 7; index += 1) {
    state = mode.tapVersion();
  }
  assert.equal(state.ready, true);
  assert.equal(mode.isDeveloperMode(), false);
  const result = mode.submitPin("000000");
  assert.equal(result.ok, false);
  assert.equal(mode.isDeveloperMode(), false);
});

test("PIN 错误后进入轻量锁定", () => {
  let fakeNow = 1000;
  const mode = createDeveloperMode({ storage: memoryStorage(), pin: "123456", now: () => fakeNow });
  for (let index = 0; index < 7; index += 1) mode.tapVersion();
  const result = mode.submitPin("000000");
  assert.equal(result.ok, false);
  assert.equal(mode.isLocked(), true);
  fakeNow += 2000;
  assert.equal(mode.isLocked(), false);
});

test("PIN 正确才能开启", () => {
  const storage = memoryStorage();
  let fakeNow = 0;
  const mode = createDeveloperMode({ storage, pin: "123456", now: () => fakeNow });
  for (let index = 0; index < 7; index += 1) mode.tapVersion();
  const wrong = mode.submitPin("654321");
  assert.equal(wrong.ok, false);
  fakeNow += 2000;
  const right = mode.submitPin("123456");
  assert.equal(right.ok, true);
  assert.equal(mode.isDeveloperMode(), true);
});

test("关闭 Developer Mode 后状态正确", () => {
  const storage = memoryStorage();
  const mode = createDeveloperMode({ storage, pin: "123456" });
  mode.enable();
  assert.equal(mode.isDeveloperMode(), true);
  mode.disable();
  assert.equal(mode.isDeveloperMode(), false);
});

test("Developer Mode 与学习数据互不影响", () => {
  const storage = memoryStorage({
    "wuliao:user:u:learning": "keep-me",
  });
  const mode = createDeveloperMode({ storage, pin: "123456" });
  mode.enable();
  mode.disable();
  assert.equal(storage.getItem("wuliao:user:u:learning"), "keep-me");
  assert.equal(storage.getItem("wuliao:dev:mode:v1"), null);
});

test("订阅者能收到状态变化", () => {
  const mode = createDeveloperMode({ storage: memoryStorage(), pin: "123456" });
  const seen = [];
  const unsubscribe = mode.subscribe((value) => seen.push(value));
  mode.enable();
  mode.disable();
  unsubscribe();
  assert.deepEqual(seen, [true, false]);
});

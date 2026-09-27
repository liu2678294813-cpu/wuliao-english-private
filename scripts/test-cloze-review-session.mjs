import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "https://localhost/",
  pretendToBeVisual: true,
});

for (const key of ["window", "document", "localStorage", "CustomEvent", "Event", "MouseEvent", "HTMLElement", "Node"]) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const vite = await createViteModuleRunner(fileURLToPath(new URL("..", import.meta.url)));

const { default: ClozeReviewSession } = await vite.import("/src/ClozeReviewSession.jsx");
const { setCurrentUsername } = await vite.import("/src/userData.js");
const {
  emptyClozeProgress,
  recordFirstAnswer,
  recordReviewAnswer,
  recordFirstConfidence,
  recordReviewConfidence,
  saveClozeProgress,
} = await vite.import("/src/clozeProgress.js");
const {
  scheduleClozeD1Task,
  getClozeReviewTask,
  TASK_TYPE_D7,
} = await vite.import("/src/clozeReview.js");
const { getClozeOfficialAnswerKey } = await vite.import("/src/clozeAnswerKeys.js");
const { emptyClozeTranslationProgress, saveClozeTranslationProgress } = await vite.import("/src/clozeTranslationProgress.js");

const cloze = {
  id: "cloze-review-session-test",
  paragraphs: [{
    number: 1,
    segments: [
      { type: "text", text: "People" },
      { type: "blank", number: 1 },
      { type: "text", text: "the room. Others" },
      { type: "blank", number: 2 },
      { type: "text", text: "outside." },
    ],
  }],
  blanks: [
    { number: 1, options: [
      { key: "A", text: "displayed" }, { key: "B", text: "occupied" },
      { key: "C", text: "located" }, { key: "D", text: "equipped" },
    ] },
    { number: 2, options: [
      { key: "A", text: "remain" }, { key: "B", text: "leave" },
      { key: "C", text: "wait" }, { key: "D", text: "work" },
    ] },
  ],
};

// 官方资源：id 与真实列表一致（postgraduate-2007-cloze），clozeSource 指向合成 JSON。
const officialResource = {
  id: "postgraduate-2007-cloze",
  kind: "official-cloze",
  year: 2007,
  title: "2007 完形会话测试",
  clozeSource: "/library/postgraduate/2007/2007-cloze.json",
};
const customResource = {
  id: "custom-session-cloze",
  title: "自定义完形会话测试",
  analysis: { clozes: [cloze] },
};

// 官方答案：使用真实 2007 答案表（前两个空位）。
const OFFICIAL = getClozeOfficialAnswerKey({ year: 2007, clozeId: cloze.id });
const KEY1 = OFFICIAL["1"] || "A";
const KEY2 = OFFICIAL["2"] || "B";

function fakeRequest(result) {
  const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    request.result = result;
    // 真实 IndexedDB 事件以 request 为 event.target。
    if (typeof request.onsuccess === "function") request.onsuccess({ target: request });
  });
  return request;
}

globalThis.indexedDB = {
  open() {
    const database = {
      objectStoreNames: { contains: () => true },
      transaction() {
        const transaction = {
          objectStore() {
            return { getAll() { return fakeRequest([customResource]); }, index() { return { getAll() { return fakeRequest([customResource]); } }; } };
          },
          close() {},
        };
        // 真实 IndexedDB 顺序：request 成功后 → transaction.oncomplete。
        // 双重微任务确保 oncomplete 在 request.onsuccess 之后执行。
        queueMicrotask(() => {
          queueMicrotask(() => transaction.oncomplete?.());
        });
        return transaction;
      },
      close() {},
    };
    return fakeRequest(database);
  },
};

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => cloze,
});

const resourceId = officialResource.id;
const clozeId = officialResource.id;

function setup() {
  localStorage.clear();
  setCurrentUsername("cloze-session-user");
  const numbers = [1, 2];
  let progress = emptyClozeProgress(resourceId, clozeId, numbers, 1);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "B");
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordReviewConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "A");
  progress = recordReviewAnswer(progress, 2, "A");
  progress = recordReviewConfidence(progress, 2, "uncertain");
  saveClozeProgress(progress);
  saveClozeTranslationProgress(emptyClozeTranslationProgress(resourceId, clozeId, 1));
  return progress;
}

function wait(milliseconds = 25) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let activeRoot = null;

async function renderSession(taskKey, onClose) {
  const container = document.getElementById("root");
  if (activeRoot) {
    await act(async () => {
      activeRoot.unmount();
      await wait(0);
    });
  }
  container.innerHTML = "";
  activeRoot = createRoot(container);
  await act(async () => {
    activeRoot.render(React.createElement(ClozeReviewSession, { taskKey, onClose }));
    await wait();
  });
  for (let attempt = 0; attempt < 40 && !container.querySelector(".cloze-option"); attempt += 1) {
    await act(async () => { await wait(); });
  }
  assert.ok(container.querySelector(".cloze-option"), "session should finish loading");
  return { container, root: activeRoot };
}

async function click(element) {
  assert.ok(element, "target element should exist");
  await act(async () => {
    element.click();
    await wait(0);
  });
}

async function unmount(root) {
  await act(async () => {
    root.unmount();
    await wait(0);
  });
  if (activeRoot === root) activeRoot = null;
}

function option(container, key) {
  return [...container.querySelectorAll(".cloze-option")]
    .find((button) => button.querySelector("b")?.textContent === key);
}

async function answerBlank(container, optionKey) {
  await click(option(container, optionKey));
  await click([...container.querySelectorAll(".cloze-confidence-row button")].find((b) => b.textContent === "确定"));
  await click([...container.querySelectorAll(".primary-button")].find((b) => b.textContent === "提交作答"));
}

test("D+1 会话：作答写入 sidecar，不覆盖 D 当天 first/review，reload 恢复", async () => {
  const progress = setup();
  const d1 = scheduleClozeD1Task({
    resourceId,
    clozeId,
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: OFFICIAL,
  });
  assert.deepEqual(d1.targets.map((item) => Number(item.blankId)).sort((a, b) => a - b), [1, 2]);

  let closed = false;
  const { container, root } = await renderSession(d1.task.taskKey, () => { closed = true; });
  assert.ok(container.textContent.includes("第 1 空"));
  await answerBlank(container, KEY1);

  const saved = getClozeReviewTask(d1.task.taskKey);
  assert.equal(saved.attempts["1"].answer, KEY1);
  assert.equal(saved.attempts["1"].confidence, "confident");
  assert.equal(saved.currentIndex, 1);

  await unmount(root);
  const { container: container2, root: root2 } = await renderSession(d1.task.taskKey, () => { closed = true; });
  assert.ok(container2.textContent.includes("第 2 空"), "reload should resume at blank 2");
  await unmount(root2);
  assert.equal(closed, false);
});

test("D+1 全部完成后任务完成，并自动 materialize D+7（方案 B）", async () => {
  const progress = setup();
  const d1 = scheduleClozeD1Task({
    resourceId,
    clozeId,
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: OFFICIAL,
  });
  let closed = false;
  const { container, root } = await renderSession(d1.task.taskKey, () => { closed = true; });
  await answerBlank(container, KEY1);
  await click([...container.querySelectorAll(".primary-button")].find((b) => b.textContent === "下一空"));
  await answerBlank(container, KEY2);
  console.log("DBG_T2_BEFORE_FINISH=", container.textContent.slice(0, 220));
  await click([...container.querySelectorAll(".primary-button")].find((b) => b.textContent === "完成复习"));

  for (let attempt = 0; attempt < 40 && !container.textContent.includes("复习完成"); attempt += 1) {
    await act(async () => { await wait(); });
  }
  assert.ok(container.textContent.includes("D+1 复习完成"), "should show completion view");
  await unmount(root);

  const d1Done = getClozeReviewTask(d1.task.taskKey);
  assert.ok(d1Done.completedAt != null, "d1 should be completed");
  const d7Key = d1Done.taskKey.replace(":d1:", ":d7:");
  const d7 = getClozeReviewTask(d7Key);
  // 期望按真实 2007 答案表派生：
  //   空1：D 当天最终 B；D+1 答 KEY1。KEY1 与 B 不一致 → 保留（D+1 仍错或再次改答）；
  //       KEY1===A 且当天高置信错误 → 即使一次稳定也保留。
  //   空2：D 当天最终 A；D+1 答 KEY2。KEY2 !== A → 保留（改答/仍错）。
  const expectedD7 = [];
  if (KEY1 !== "B") expectedD7.push(1);
  if (KEY2 !== "A") expectedD7.push(2);
  if (expectedD7.length > 0) {
    assert.ok(d7, "d7 task should be materialized");
    assert.equal(d7.type, TASK_TYPE_D7);
    assert.deepEqual(d7.targetBlankIds, expectedD7);
    assert.equal(d7.dueDate, "2026-08-08");
  } else {
    assert.equal(d7, null, "no d7 needed when both blanks stabilized");
  }
  assert.equal(closed, false);
});

test("无答案 D+1 会话：提交需要自评，check 无 correctness 字样", async () => {
  localStorage.clear();
  setCurrentUsername("cloze-session-user");
  const numbers = [1, 2];
  let progress = emptyClozeProgress(customResource.id, customResource.id, numbers, 1);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "B");
  progress = recordReviewConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "A");
  progress = recordReviewAnswer(progress, 2, "A");
  progress = recordReviewConfidence(progress, 2, "confident");
  saveClozeProgress(progress);
  saveClozeTranslationProgress(emptyClozeTranslationProgress(customResource.id, customResource.id, 1));

  const d1 = scheduleClozeD1Task({
    resourceId: customResource.id,
    clozeId: customResource.id,
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: {},
  });
  assert.ok(d1);
  const { container, root } = await renderSession(d1.task.taskKey, () => {});
  const submit = [...container.querySelectorAll(".primary-button")].find((b) => b.textContent === "提交作答");
  assert.ok(submit.disabled, "submit should be disabled until answer + self-rating");
  await click(option(container, "A"));
  assert.ok(submit.disabled, "still disabled without self-rating");
  await click([...container.querySelectorAll(".cloze-review-basis-row button")].find((b) => b.textContent === "上下文"));
  await click([...container.querySelectorAll(".cloze-confidence-row button")].find((b) => b.textContent === "确定"));
  await click([...container.querySelectorAll(".cloze-confidence-row button")].find((b) => b.textContent === "稳定"));
  await click(submit);
  assert.ok(container.textContent.includes("本次作答"));
  assert.ok(container.textContent.includes("稳定"));
  assert.ok(container.textContent.includes("不判断对错"), "answerless note should be present");
  assert.ok(!container.textContent.includes("本次正确"));
  assert.ok(!container.textContent.includes("本次错误"));
  await unmount(root);
});

test.after(async () => {
  await vite.close();
});

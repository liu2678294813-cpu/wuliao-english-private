import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "localStorage", "CustomEvent", "Event", "InputEvent", "MouseEvent", "HTMLElement", "HTMLButtonElement", "HTMLSelectElement", "Node"]) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);

const ReactModule = await import("react");
const React = ReactModule.default;
const { act } = ReactModule;
const { createRoot } = await import("react-dom/client");
const vite = await createViteModuleRunner(repositoryRoot);
const { default: WritingLibrary } = await vite.import("/src/writing/ui/WritingLibrary.jsx");
const { writingQuestionBank } = await vite.import("/src/writing/writingQuestionBank.js");
let root;

const wait = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function render(services, onOpenSession = () => {}, onConfigureTextAi = () => {}) {
  if (root) await act(async () => { root.unmount(); await wait(); });
  const container = document.getElementById("root");
  container.replaceChildren();
  root = createRoot(container);
  await act(async () => { root.render(React.createElement(WritingLibrary, { username: "alice", services, onOpenSession, onConfigureTextAi })); await wait(); });
  return container;
}
async function click(element) { await act(async () => { element.click(); await wait(); }); }
function button(container, text) { return [...container.querySelectorAll("button")].find((item) => item.textContent.includes(text) || item.getAttribute("aria-label")?.includes(text)); }

function services(startQuestionTraining, privateQuestionIds = []) {
  return {
    questionBank: writingQuestionBank,
    questionSessions: { startQuestionTraining },
    privateSamplesReady: Promise.resolve({ status: "ready" }),
    privateSamples: { listAvailableQuestionIds: async () => privateQuestionIds },
    readModels: { buildWritingLibrary: async () => ({ activeItems: [], completedItems: [], damagedItems: [], diagnostics: [] }) },
  };
}

test("an exactly matched private sample adds an explicit source choice without exposing its body", async () => {
  const starts = [];
  const privateQuestionId = "postgrad-en1-2023-writing-a";
  const container = await render(services(async (questionId, options) => {
    starts.push([questionId, options]);
    return { session: { sessionId: "private-session" } };
  }, [privateQuestionId]));
  await click(button(container, "查看 2023 年小作文"));
  assert.ok(button(container, "使用设备私有参考范文"));
  assert.ok(button(container, "使用 AI 生成范文"));
  assert.doesNotMatch(container.textContent, /DEVICE_ONLY_REFERENCE_BODY/);
  await click(button(container, "使用设备私有参考范文"));
  assert.deepEqual(starts, [[privateQuestionId, { sampleSource: "device_private" }]]);
});

test("library mirrors Reading/Cloze year groups and cards without AI or sample leakage", async () => {
  let starts = 0;
  const container = await render(services(async () => { starts += 1; }));
  assert.equal(container.querySelectorAll(".writing-question-years > .year-group").length, 23);
  assert.equal(container.querySelectorAll(".writing-question-card").length, 42);
  assert.match(container.querySelector(".writing-question-years .year-heading").textContent, /2023.*2 篇/);
  assert.equal(container.querySelectorAll(".writing-question-preview").length, 0, "cards should be the initial selection surface");
  assert.doesNotMatch(container.textContent, /Sample Essay|范文正文|参考范文/);
  assert.equal(starts, 0, "mounting and browsing must not start AI");
  await click(button(container, "查看 2023 年小作文"));
  assert.match(container.textContent, /2023 · QUESTION 51/);
  assert.match(container.textContent, /Write a notice to recruit a student/);
  assert.equal(starts, 0);
  const select = container.querySelector("#writing-question-year");
  await act(async () => {
    select.value = "2001";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait();
  });
  assert.equal(container.querySelectorAll(".writing-question-years > .year-group").length, 1);
  assert.equal(container.querySelectorAll(".writing-question-card").length, 1);
  assert.match(container.querySelector(".year-heading").textContent, /2001.*1 篇/);
  assert.equal(container.querySelectorAll(".writing-question-preview").length, 0);
  await click(button(container, "查看 2001 年大作文"));
  assert.match(container.textContent, /2001 · QUESTION 46/);
  assert.match(container.querySelector(".writing-question-preview img").getAttribute("src"), /\/2001\/.*prompt\.png$/);
  assert.equal(starts, 0);
  await act(async () => {
    select.value = "2012";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait();
  });
  await click(button(container, "查看 2012 年小作文"));
  assert.match(container.textContent, /Some international students are coming/);
  assert.equal(starts, 0);
});

test("start failure is actionable and does not navigate; accepted start opens W1 Session", async () => {
  const opened = [];
  let attempts = 0;
  const container = await render(services(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("范文生成失败，没有创建训练记录。请检查 AI 设置或网络后重试。");
    return { session: { sessionId: "session-ok" } };
  }), (sessionId) => opened.push(sessionId));
  await click(button(container, "查看 2023 年小作文"));
  await click(button(container, "用这道题开始训练"));
  assert.deepEqual(opened, []);
  assert.match(container.textContent, /训练尚未创建/);
  assert.match(container.textContent, /没有创建训练记录/);
  await click(button(container, "重试"));
  assert.deepEqual(opened, ["session-ok"]);
});

test("Text AI missing state explains config isolation and opens the existing Text AI settings", async () => {
  let configureCalls = 0;
  const missing = Object.assign(new Error("请先配置文本 AI。"), { code: "text_ai_not_configured" });
  const container = await render(
    services(async () => { throw missing; }),
    () => {},
    () => { configureCalls += 1; },
  );
  await click(button(container, "查看 2023 年小作文"));
  await click(button(container, "用这道题开始训练"));
  assert.match(container.textContent, /写作训练的范文生成、对照分析和评分使用文本 AI/);
  assert.match(container.textContent, /多模态 \/ 手写识别 AI.*只用于手写作文识别/);
  await click(button(container, "去配置文本 AI"));
  assert.equal(configureCalls, 1);
});

test("rapid double click starts one provider flow and opens at most one Session", async () => {
  let starts = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const opened = [];
  const container = await render(services(async () => {
    starts += 1;
    await pending;
    return { session: { sessionId: "session-once" } };
  }), (sessionId) => opened.push(sessionId));
  await click(button(container, "查看 2023 年小作文"));
  const startButton = button(container, "用这道题开始训练");
  await act(async () => {
    startButton.click();
    startButton.click();
    await wait();
  });
  assert.equal(starts, 1);
  release();
  await act(async () => { await pending; await wait(); });
  assert.deepEqual(opened, ["session-once"]);
});

test.after(async () => {
  if (root) await act(async () => { root.unmount(); await wait(); });
  await vite.close();
  dom.window.close();
});

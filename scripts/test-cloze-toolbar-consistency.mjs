// Cloze Toolbar 一致性契约（Shared AnnotationToolbar）：
// 1) 展开状态：键盘输入/手写批注切换、笔、橡皮、粗细 slider、颜色、撤销、清空 全部渲染；
// 2) 折叠状态：DOM 只剩「展开工具 + stageHint」，slider / color / pen / eraser / 撤销 / 清空
//    全部不渲染（禁止依赖 CSS 压缩隐藏——WebView 下会残留，见折叠残留 Bug）；
// 3) noteMode 切换（键盘输入 ⇄ 手写批注）不清答案、不改 activeBlank、不丢笔迹 state。

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

const noopCanvasContext = () => new Proxy({}, {
  get: (target, prop) => {
    if (prop === Symbol.toPrimitive) return () => 0;
    if (!(prop in target)) target[prop] = () => {};
    return target[prop];
  },
  set: (target, prop, value) => {
    target[prop] = value;
    return true;
  },
});
dom.window.HTMLCanvasElement.prototype.getContext = () => noopCanvasContext();
dom.window.HTMLCanvasElement.prototype.toDataURL = () => "";

const vite = await createViteModuleRunner(fileURLToPath(new URL("..", import.meta.url)));

const { default: ClozeReader } = await vite.import("/src/ClozeReader.jsx");
const { setCurrentUsername } = await vite.import("/src/userData.js");
const {
  completeClozeStage,
  emptyClozeFlow,
  getClozeFlow,
  saveClozeFlow,
} = await vite.import("/src/clozeFlow.js");
const {
  emptyClozeProgress,
  getClozeProgress,
  recordFirstAnswer,
  saveClozeProgress,
  setActiveBlank,
} = await vite.import("/src/clozeProgress.js");

const resourceId = "cloze-toolbar-test";
const cloze = {
  id: resourceId,
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
const resource = { id: resourceId, title: "完形工具栏测试", analysis: { clozes: [cloze] } };

function wait(milliseconds = 25) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function renderReader() {
  const container = document.getElementById("root");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ClozeReader, { resource, onClose() {} }));
    await wait();
  });
  for (let attempt = 0; attempt < 30 && !container.querySelector(".cloze-option"); attempt += 1) {
    await act(async () => { await wait(); });
  }
  assert.ok(container.querySelector(".cloze-option"), "ClozeReader should finish loading");
  return { container, root };
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
}

function toolbar(container) {
  return container.querySelector(".cloze-reader-page > .annotation-toolbar");
}

test("折叠契约：展开渲染完整控件集，折叠后 DOM 只剩展开工具 + stageHint", async () => {
  localStorage.clear();
  setCurrentUsername("cloze-toolbar-test-user");
  const flow = completeClozeStage(emptyClozeFlow(resourceId, resourceId, 20), "cloze-cover", 101);
  saveClozeFlow(flow);
  const progress = recordFirstAnswer(emptyClozeProgress(resourceId, resourceId, [1, 2], 100), 1, "D");
  saveClozeProgress(progress);

  const mounted = await renderReader();
  const bar = toolbar(mounted.container);
  assert.ok(bar, "shared AnnotationToolbar rendered");

  // 展开状态：完整控件集（与精读同一共享组件契约）
  const text = bar.textContent;
  for (const label of ["收起工具", "键盘输入", "手写批注", "笔", "橡皮", "粗细", "撤销", "清空笔迹"]) {
    assert.ok(text.includes(label), `展开态应包含 ${label}`);
  }
  assert.equal(bar.querySelectorAll(".tool-size-range-track").length, 1, "展开态有粗细 slider");
  assert.equal(bar.querySelectorAll(".color-picker button").length, 3, "展开态有 3 个颜色圆");
  assert.ok(bar.querySelector(".input-mode-picker"), "展开态有键盘/手写切换");

  // 折叠：DOM 层面子控件全部消失（不只 CSS 隐藏）
  await click(bar.querySelector(".toolbar-collapse-toggle"));
  assert.ok(bar.classList.contains("collapsed"));
  assert.match(bar.querySelector(".toolbar-collapse-toggle").textContent, /展开工具/);
  assert.ok(bar.querySelector(".toolbar-stage-hint"), "折叠态保留 stageHint");
  assert.equal(bar.querySelectorAll(".tool-size-range-track").length, 0, "折叠后 slider 不渲染");
  assert.equal(bar.querySelectorAll(".color-picker button").length, 0, "折叠后颜色圆不渲染");
  assert.equal(bar.querySelectorAll(".input-mode-picker").length, 0, "折叠后键盘/手写切换不渲染");
  const buttonTexts = [...bar.querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(buttonTexts.filter((t) => !/展开工具|⌄/.test(t)), [], "折叠后无其他按钮残留");

  // 展开恢复完整
  await click(bar.querySelector(".toolbar-collapse-toggle"));
  assert.equal(bar.querySelectorAll(".tool-size-range-track").length, 1, "再次展开 slider 恢复");
  assert.equal(bar.querySelectorAll(".color-picker button").length, 3, "再次展开颜色圆恢复");

  await unmount(mounted.root);
});

test("noteMode 切换：键盘输入 ⇄ 手写批注 不清答案、不改 activeBlank、不丢笔迹 state", async () => {
  localStorage.clear();
  setCurrentUsername("cloze-toolbar-test-user");
  const flow = completeClozeStage(emptyClozeFlow(resourceId, resourceId, 20), "cloze-cover", 101);
  saveClozeFlow(flow);
  let progress = emptyClozeProgress(resourceId, resourceId, [1, 2], 100);
  progress = recordFirstAnswer(progress, 1, "D");
  progress = setActiveBlank(progress, 2);
  saveClozeProgress(progress);

  const mounted = await renderReader();
  const bar = toolbar(mounted.container);
  const modePicker = bar.querySelector(".input-mode-picker");
  assert.ok(modePicker, "共享 input-mode-picker 存在");

  const keyboardBtn = [...modePicker.querySelectorAll("button")].find((b) => /键盘输入/.test(b.textContent));
  const handwritingBtn = [...modePicker.querySelectorAll("button")].find((b) => /手写批注/.test(b.textContent));
  assert.ok(keyboardBtn && handwritingBtn, "键盘/手写两个切换按钮存在");

  const progressBefore = JSON.stringify(getClozeProgress(resourceId, resourceId, [1, 2]));

  // 切到键盘输入（jsdom 非 Android，默认已是键盘模式；先切手写再切回，验证往返）
  await click(handwritingBtn);
  assert.ok(handwritingBtn.classList.contains("active"));
  await click(keyboardBtn);
  assert.ok(keyboardBtn.classList.contains("active"));

  const progressAfter = JSON.stringify(getClozeProgress(resourceId, resourceId, [1, 2]));
  assert.equal(progressAfter, progressBefore, "noteMode 往返切换不改变 progress（答案 / activeBlank 保留）");
  assert.equal(mounted.container.querySelector("#cloze-blank-1 em")?.textContent, "D", "答案展示保留");

  // 键盘模式下正文 Blank 可正常点击（交互不被手写 Surface 截获）
  await click(mounted.container.querySelector("#cloze-blank-2"));
  assert.ok(mounted.container.querySelector(".cloze-question-panel.is-open"), "键盘模式点击 blank 打开题目窗");

  await unmount(mounted.root);
});

test.after(async () => {
  await vite.close();
  dom.window.close();
});

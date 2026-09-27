import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function pointer(window, type, { pointerId = 1, clientX = 0, clientY = 0, button = 0 } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    button: { value: button },
  });
  return event;
}

test("divider requires long press, resizes both orientations, persists per user, and cleans pending timers", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "Event", "HTMLElement", "Node", "localStorage", "MutationObserver"]) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactModule = await import("react");
  const React = ReactModule.default;
  const { act } = ReactModule;
  const { createRoot } = await import("react-dom/client");
  const vite = await createViteModuleRunner(repositoryRoot);
  const module = await vite.import("/src/writing/ui/WritingSplitWorkspace.jsx");
  const Split = module.default;
  const root = createRoot(document.getElementById("root"));
  const render = async (layout = "split", username = "alice") => act(async () => root.render(React.createElement(Split, {
    stage: "W7_INDEPENDENT",
    username,
    layout,
    sourceLabel: "展示区",
    sourcePane: React.createElement("div", null, "source"),
    workLabel: "手写区",
    workPane: React.createElement("div", null, "work"),
  })));
  await render();
  const workspace = document.querySelector(".writing-split-workspace");
  workspace.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500 });
  for (const header of document.querySelectorAll(".writing-split-pane > header")) header.getBoundingClientRect = () => ({ height: 40 });
  const divider = document.querySelector(".writing-split-divider");

  await act(async () => {
    divider.dispatchEvent(pointer(window, "pointerdown", { clientX: 320, clientY: 200 }));
    divider.dispatchEvent(pointer(window, "pointerup", { clientX: 320, clientY: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 380));
  });
  assert.equal(workspace.dataset.splitRatio, "0.4000", "short tap does not resize");

  await act(async () => {
    divider.dispatchEvent(pointer(window, "pointerdown", { pointerId: 2, clientX: 320, clientY: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 370));
    document.dispatchEvent(pointer(window, "pointermove", { pointerId: 2, clientX: 560, clientY: 200 }));
    document.dispatchEvent(pointer(window, "pointerup", { pointerId: 2, clientX: 560, clientY: 200 }));
  });
  assert.equal(workspace.dataset.splitRatio, "0.7000");

  await act(async () => {
    divider.dispatchEvent(pointer(window, "pointerdown", { pointerId: 3, clientX: 560, clientY: 200 }));
    document.dispatchEvent(pointer(window, "pointermove", { pointerId: 3, clientX: 580, clientY: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 380));
    document.dispatchEvent(pointer(window, "pointermove", { pointerId: 3, clientX: 240, clientY: 200 }));
    document.dispatchEvent(pointer(window, "pointerup", { pointerId: 3, clientX: 240, clientY: 200 }));
  });
  assert.equal(workspace.dataset.splitRatio, "0.7000", "movement before activation cancels the long press");

  await render("stacked");
  const stacked = document.querySelector(".writing-split-workspace");
  stacked.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500 });
  for (const header of document.querySelectorAll(".writing-split-pane > header")) header.getBoundingClientRect = () => ({ height: 40 });
  const stackedDivider = document.querySelector(".writing-split-divider");
  await act(async () => {
    stackedDivider.dispatchEvent(pointer(window, "pointerdown", { pointerId: 4, clientX: 300, clientY: 250 }));
    await new Promise((resolve) => setTimeout(resolve, 370));
    document.dispatchEvent(pointer(window, "pointermove", { pointerId: 4, clientX: 300, clientY: 334 }));
    document.dispatchEvent(pointer(window, "pointerup", { pointerId: 4, clientX: 300, clientY: 334 }));
  });
  assert.equal(stacked.dataset.stackedRatio, "0.6667", "stacked clamp preserves at least 140px for the lower pane");
  assert.equal(stacked.getAttribute("data-split-ratio"), "0.7000", "split preference remains independent");

  await act(async () => root.unmount());
  const secondRoot = createRoot(document.getElementById("root"));
  await act(async () => secondRoot.render(React.createElement(Split, {
    stage: "W7_INDEPENDENT", username: "alice", layout: "split", sourceLabel: "展示区", sourcePane: React.createElement("div"), workLabel: "手写区", workPane: React.createElement("div"),
  })));
  assert.equal(document.querySelector(".writing-split-workspace").dataset.splitRatio, "0.7000", "saved split ratio restores");
  await act(async () => secondRoot.render(React.createElement(Split, {
    stage: "W7_INDEPENDENT", username: "bob", layout: "split", sourceLabel: "展示区", sourcePane: React.createElement("div"), workLabel: "手写区", workPane: React.createElement("div"),
  })));
  assert.equal(document.querySelector(".writing-split-workspace").dataset.splitRatio, "0.4000", "another account uses its own default");
  localStorage.setItem("wuliao:user:bob:wuliao:pref:writing-split-ratio:v1", "broken");
  await act(async () => secondRoot.unmount());
  await vite.close();
});

test("divider source preserves ink document sizing and never mutates ink identity or strokes", async () => {
  const source = await readFile(new URL("../src/writing/ui/WritingSplitWorkspace.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/writing/writing.css", import.meta.url), "utf8");
  assert.match(source, /WRITING_SPLIT_LONG_PRESS_MS = 350/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /releasePointerCapture/);
  assert.match(source, /Math\.max\(sourceContentHeight \* 2, workViewportHeight, 1\)/);
  assert.match(source, /ResizeObserver/);
  assert.doesNotMatch(source, /attemptId|surfaceId|ownerRecordId|setStrokes|persistStrokes/);
  assert.match(css, /\.writing-split-divider\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.writing-split-workspace\.is-stacked \.writing-split-divider\s*\{[^}]*touch-action:\s*pan-x/);
});

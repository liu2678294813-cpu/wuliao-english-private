import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";
import {
  isNavGroup,
  isWritingView,
  PRIMARY_NAV,
  READING_NAV,
  writingHostHash,
  writingRouteFromHost,
} from "../src/navigation.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("Writing 是独立顶级入口且不属于 Reading", () => {
  const writing = PRIMARY_NAV.find((item) => item.id === "writing");
  const reading = PRIMARY_NAV.find((item) => item.id === "reading-group");
  assert.deepEqual(writing, { id: "writing", label: "写作", icon: "vocabulary", view: "writing-library" });
  assert.ok(!isNavGroup(writing));
  assert.ok(isNavGroup(reading));
  assert.ok(!reading.children.some((item) => item.id === "writing" || item.label === "写作"));
  assert.deepEqual(READING_NAV.map((item) => item.label), ["精读", "完形"]);
});

test("Writing Library 与 Session route 保留 session identity 且不编码 Stage", () => {
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { location: { hash: "#/writing" } };
    assert.deepEqual(writingRouteFromHost(), { view: "writing-library", sessionId: "" });
    globalThis.window = { location: { hash: "#/writing/session/session%3Aalice%3A1" } };
    assert.deepEqual(writingRouteFromHost(), { view: "writing-session", sessionId: "session:alice:1" });
    globalThis.window = { location: { hash: "#/writing/session/session-a?stage=W7" } };
    assert.equal(writingRouteFromHost(), null);
  } finally {
    globalThis.window = originalWindow;
  }
  assert.equal(writingHostHash({ view: "writing-library" }), "#/writing");
  assert.equal(writingHostHash({ view: "writing-session", sessionId: "session:alice:1" }), "#/writing/session/session%3Aalice%3A1");
  assert.ok(!writingHostHash({ view: "writing-session", sessionId: "session-a" }).includes("W7"));
});

test("Library 与 Workspace 都映射为 Writing active state", () => {
  assert.equal(isWritingView("writing-library"), true);
  assert.equal(isWritingView("writing-session"), true);
  assert.equal(isWritingView("library"), false);
});

test("App route wiring uses safe workspace loader and back returns Library without Stage mutation", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../src/writing/ui/WritingWorkspace.jsx", import.meta.url), "utf8");
  assert.match(app, /<WritingLibrary[^>]+onOpenSession=\{openWritingSession\}/);
  assert.match(app, /<WritingWorkspace[^>]+sessionId=\{writingSessionId\}/);
  assert.match(app, /setNav\(\{ view: "writing-library", stack: \[\] \}\)/);
  assert.doesNotMatch(app, /setCurrentStage|previousWritingStage|writingBackStack/);
  assert.match(workspace, /services\.readModels\.loadWritingWorkspace\(\{ sessionId \}\)/);
  assert.match(workspace, /workspace\.safeStage/);
});

test("AppShell keeps Writing active on Library and Workspace and exposes accessible label", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "Node", "MouseEvent"]) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactModule = await import("react");
  const React = ReactModule.default;
  const { act } = ReactModule;
  const { createRoot } = await import("react-dom/client");
  const vite = await createViteModuleRunner(repositoryRoot);
  const { default: AppShell } = await vite.import("/src/ui/AppShell.jsx");
  const root = createRoot(document.getElementById("root"));
  for (const activeView of ["writing-library", "writing-session"]) {
    await act(async () => {
      root.render(React.createElement(AppShell, { activeView, username: "alice", onNavigate() {}, onOpenAiApi() {}, onOpenSettings() {} }, React.createElement("p", null, "content")));
    });
    const buttons = [...document.querySelectorAll(".ds-nav button")];
    const writing = buttons.find((button) => button.textContent.trim() === "写作");
    assert.ok(writing);
    assert.equal(writing.classList.contains("is-active"), true);
    assert.equal(writing.getAttribute("aria-current"), "page");
    assert.equal(writing.textContent.trim(), "写作");
  }
  await act(async () => root.unmount());
  await vite.close();
});

test("collapsed AppShell keeps the shared icon rail, ignores legacy position preference, and expands from the brand", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "localStorage", "HTMLElement", "Node", "MouseEvent"]) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 600 });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactModule = await import("react");
  const React = ReactModule.default;
  const { act } = ReactModule;
  const { createRoot } = await import("react-dom/client");
  const vite = await createViteModuleRunner(repositoryRoot);
  const { default: AppShell } = await vite.import("/src/ui/AppShell.jsx");
  const props = { activeView: "writing-session", username: "drag-user", onNavigate() {}, onOpenAiApi() {}, onOpenSettings() {} };
  localStorage.setItem("wuliao:sidebar-restore-position:v1", JSON.stringify({ x: 760, y: 500 }));
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(AppShell, props, React.createElement("p", null, "content"))); });
  await act(async () => { document.querySelector(".ds-brand").click(); });
  const shell = document.querySelector(".ds-shell");
  const rail = document.querySelector(".ds-rail");
  const brand = document.querySelector(".ds-brand");
  assert.equal(shell.classList.contains("ds-shell-collapsed"), true);
  assert.ok(rail, "the original rail stays mounted when collapsed");
  assert.equal(document.querySelector(".ds-sidebar-restore"), null, "no detached restore control is rendered");
  assert.equal(brand.getAttribute("aria-label"), "展开侧栏");
  assert.equal(document.querySelectorAll(".ds-nav button").length, 9, "all navigation icons remain available");
  assert.equal(localStorage.getItem("wuliao:sidebar-restore-position:v1"), JSON.stringify({ x: 760, y: 500 }), "unrelated legacy preference is ignored rather than rewritten");
  await act(async () => { brand.click(); });
  assert.equal(shell.classList.contains("ds-shell-collapsed"), false, "brand click expands the same rail");
  assert.equal(brand.getAttribute("aria-label"), "收起侧栏");
  await act(async () => root.unmount());
  await vite.close();
});

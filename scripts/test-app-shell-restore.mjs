import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("collapsed AppShell keeps the shared navigation as a clickable icon rail", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "Event", "MouseEvent", "HTMLElement", "Node", "localStorage"]) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactModule = await import("react");
  const React = ReactModule.default;
  const { act } = ReactModule;
  const { createRoot } = await import("react-dom/client");
  const vite = await createViteModuleRunner(repositoryRoot);
  const { default: AppShell } = await vite.import("/src/ui/AppShell.jsx");
  const root = createRoot(document.getElementById("root"));
  const navigations = [];
  await act(async () => root.render(React.createElement(AppShell, {
    activeView: "home",
    username: "alice",
    onNavigate: (...args) => navigations.push(args),
    onOpenAiApi: () => {},
    onOpenSettings: () => {},
  }, React.createElement("header", { className: "home-greeting" }, React.createElement("button", null, "返回")))));
  const expandedLabels = [...document.querySelectorAll(".ds-nav > button > span")].map((node) => node.textContent);
  assert.deepEqual(expandedLabels, ["首页", "精读", "完形", "模拟", "写作", "词库", "筛查", "背诵", "复习"]);
  await act(async () => document.querySelector(".ds-brand").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.ok(document.querySelector(".ds-shell").classList.contains("ds-shell-collapsed"));
  assert.ok(document.querySelector(".ds-rail"), "the rail stays mounted while collapsed");
  assert.equal(document.querySelectorAll(".ds-nav > button").length, expandedLabels.length);
  assert.equal(document.querySelector(".ds-brand").getAttribute("aria-label"), "展开侧栏");
  const memorize = document.querySelector('.ds-nav > button[aria-label="背诵"]');
  assert.ok(memorize);
  await act(async () => memorize.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.deepEqual(navigations.at(-1), ["vocabulary", "", "memorize"]);
  await act(async () => document.querySelector(".ds-brand").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.ok(!document.querySelector(".ds-shell").classList.contains("ds-shell-collapsed"));
  assert.equal(document.querySelector(".ds-brand").getAttribute("aria-label"), "收起侧栏");
  await act(async () => root.unmount());
  await vite.close();
});

test("collapsed rail CSS removes labels without shrinking touch targets", async () => {
  const shell = await readFile(new URL("../src/ui/AppShell.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/redesign/app-shell.css", import.meta.url), "utf8");
  assert.match(shell, /PRIMARY_NAV\.map/);
  assert.match(shell, /aria-label=\{child\.label\}/);
  assert.match(shell, /aria-label=\{item\.label\}/);
  assert.doesNotMatch(shell, /ds-sidebar-restore/);
  assert.match(css, /--ds-collapsed-rail-width:\s*64px/);
  assert.match(css, /\.ds-shell-collapsed \.ds-nav-group,[\s\S]*\.ds-nav > button > span\s*\{\s*display:\s*none/);
  assert.match(css, /\.ds-shell-collapsed \.ds-nav > button\s*\{[\s\S]*width:\s*48px;[\s\S]*min-height:\s*48px/);
  assert.doesNotMatch(css, /\.ds-shell-collapsed \.ds-rail\s*\{[^}]*translateX/);
});

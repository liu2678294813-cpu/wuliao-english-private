import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/redesign/reader.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const toolbarSource = readFileSync(new URL("../src/ui/AnnotationToolbar.jsx", import.meta.url), "utf8");
const inkToolsSource = readFileSync(new URL("../src/annotationTools.js", import.meta.url), "utf8");
const inkRuntimeSource = readFileSync(new URL("../src/ink/inkRuntime.js", import.meta.url), "utf8");

test("tablet ink toolbar keeps its row while controls meet the compact visual contract", () => {
  // 共享 Toolbar 视觉契约同时作用于 reader / cloze / exam 三个宿主。
  const toolbar = source.match(/\.reader-page > \.annotation-toolbar\.tablet-ink-toolbar,\n\.cloze-reader-page > \.annotation-toolbar\.tablet-ink-toolbar,\n\.exam-session > \.annotation-toolbar\.tablet-ink-toolbar \{([\s\S]*?)\n\}/);
  assert.ok(toolbar);
  assert.match(toolbar[1], /height: var\(--reader-toolbar-height\)/);
  assert.match(toolbar[1], /min-height: var\(--reader-toolbar-height\)/);
  assert.match(source, /min-height: 40px/);
  assert.match(source, /font-size: 14px/);
  assert.match(source, /font-size: 19px/);
  assert.match(source, /height: 36px/);
  assert.match(source, /height: 4px/);
  assert.match(source, /width: 40px[\s\S]*height: 40px[\s\S]*padding: 9px[\s\S]*background-clip: content-box/);
  assert.match(source, /inset: 5px/);
  assert.match(source, /inset: -2px/);
  const visualContract = source.slice(source.indexOf("/* Toolbar visual-only contract"));
  assert.match(visualContract, /tablet-ink-toolbar > button::before,[\s\S]*?color-picker button::before[\s\S]*?\{[\s\S]*?position: absolute;[\s\S]*?inset: -2px;[\s\S]*?content: "";/);
  assert.doesNotMatch(visualContract, /@media \(pointer: coarse\)[\s\S]*?color-picker button::before[\s\S]*?inset: -2px/);
  assert.match(source, /border-left: 1px solid/);
  assert.match(source, /display: inline-flex/);
  assert.match(source, /align-items: center/);
  assert.match(source, /justify-content: center/);
  assert.match(source, /gap: 4px/);
  assert.match(source, /\.toolbar-icon/);
  assert.match(source, /flex: 0 0 19px/);
  assert.equal((toolbarSource.match(/className="toolbar-icon"/g) || []).length, 6);
  assert.match(toolbarSource, /aria-hidden="true"/);
});

test("2026-08-13：阶段栏主标签与共享 toolbar 同为 14px 视觉级别", () => {
  assert.match(source, /\.reader-page > \.stage-nav button \{\n\n  min-height: var\(--reader-stage-height\);\n  padding-inline: clamp\(9px, 1\.15vw, 17px\);\n  color: var\(--ds-ink-soft, #50636b\);\n  font-size: var\(--ds-text-md, 14px\);/);
  assert.match(source, /font-size: 14px/);
  assert.match(source, /\.reader-page > \.stage-nav button span \{\n\n  width: 20px;\n  height: 20px;/);
});

test("2026-08-13：collapsed pill 支持 pointer 二维拖拽且点击/拖拽不冲突", () => {
  assert.match(toolbarSource, /setPointerCapture/);
  assert.match(toolbarSource, /Math\.hypot\(dx, dy\) < 6/);
  assert.match(toolbarSource, /translate3d/);
  assert.match(toolbarSource, /suppressPillClickRef/);
  assert.match(toolbarSource, /pillDragging/);
  assert.match(toolbarSource, /touchAction: "none"/);
  assert.match(source, /\.toolbar-collapse-toggle \{\n\n  position: fixed;/);
  assert.match(source, /touch-action: none;/);
});

test("2026-08-13：Lasso 虚线走显式共享渲染分支", () => {
  assert.match(inkToolsSource, /\} else if \(tool === "lasso"\) \{/);
  assert.match(inkToolsSource, /context\.setLineDash\(\[7, 5\]\)/);
  assert.match(inkRuntimeSource, /#e26f51/);
});

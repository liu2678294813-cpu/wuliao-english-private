// ExamInkSurface 契约：考试笔迹必须使用与精读 / 普通完形相同的 Shared Ink Runtime。
// 本测试验证新 surface 不再存在独立的劣化渲染生命周期（每次 move 清屏重画 / 每次 commit 全量重绘），
// 并保留 flush / clear / 状态机等对外契约。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const source = read("src/exam/ExamInkSurface.jsx");

// 从 const NAME = useCallback( 开始到 "}, [deps]);" 结束的区域文本。
function callbackRegion(name) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  if (start < 0) return "";
  const terminator = source.indexOf("\n  }, [", start);
  if (terminator < 0) return "";
  const close = source.indexOf("]);", terminator);
  return close < 0 ? "" : source.slice(start, close + 3);
}

test("ExamInkSurface 使用 Shared Ink Runtime（useStructuredInk），不再维护独立预览/提交生命周期", () => {
  assert.match(source, /useStructuredInk/);
  // 不再存在劣化实现：每次 move 清屏重画整笔、每次 commit 重绘全部历史。
  assert.doesNotMatch(source, /function renderPreview\(/);
  assert.doesNotMatch(source, /const renderPreview = /);
  assert.doesNotMatch(source, /function renderCommitted\(/);
  assert.doesNotMatch(source, /function commitStrokes\(/);
  // append-only 提交路径必须存在（普通新增 pen stroke 不重画历史）。
  assert.match(source, /commitAppendStroke/);
  assert.match(source, /renderInkLayer\(canvas, strokesRef\.current, width, height, ratio\)/);
});

test("ExamInkSurface pointer 生命周期：move 只走共享 Runtime；所有终态路径经同一收尾", () => {
  assert.match(source, /onPointerMoveCapture=\{inkController\.handlePointerMove\}/);
  assert.match(source, /onPointerUpCapture=\{inkController\.handlePointerUp\}/);
  assert.match(source, /onPointerCancelCapture=\{inkController\.handlePointerCancel\}/);
  assert.match(source, /onLostPointerCapture=\{inkController\.handlePointerUp\}/);
  // pointermove 不直接触达任何存储调用（存储只发生在收尾后的 persistStrokes → enqueueSave）。
  assert.doesNotMatch(source, /handlePointerMove[\s\S]*enqueueSave/);
});

test("ExamInkSurface flush 保留进行中笔画并报告 complete/partial", () => {
  const flush = callbackRegion("flush");
  assert.ok(flush.includes("activeRef.current"), "flush must handle the active stroke");
  assert.ok(flush.includes("inkController.handlePointerUp"), "flush must finish via the shared runtime");
  assert.ok(flush.includes("await saveQueueRef.current"), "flush must await the serial save queue");
  assert.ok(flush.includes("examInkFlushResult(surfaceId, lastGoodRef.current"), "flush must report ink refs");
  assert.ok(flush.includes("writeBlocked: writeBlockedRef.current"), "flush must report writeBlocked");
  assert.ok(flush.includes("dirty: dirtySinceLastSuccessRef.current"), "flush must report dirty");
});

test("ExamInkSurface 无普通 reader 持久化；考试笔迹与学习数据完全隔离", () => {
  assert.doesNotMatch(source, /getUserItem|setUserItem|localStorage|PEN_MODE_STORAGE_KEY|PEN_SIZE_STORAGE_KEY/);
  assert.doesNotMatch(source, /cloze-ink/);
  assert.doesNotMatch(source, /deep-ink/);
});

test("ExamInkSurface clear 失败回滚到最后成功快照；source 恢复需确认", () => {
  const clear = callbackRegion("clear");
  assert.ok(clear.includes("replacingUnreadable"), "clear must distinguish source recovery");
  assert.ok(clear.includes("expectedRevision: revisionRef.current || null"), "clear must pass expected revision");
  assert.ok(clear.includes("strokesRef.current = lastGoodStrokesRef.current"), "clear failure must restore last good");
  assert.ok(clear.includes("setStrokes(lastGoodStrokesRef.current)"), "clear failure must restore state");
});

test("ExamInkSurface 工具栏状态受控（toolbar 位于 ExamSession），surface 只上报 strokes 与 api", () => {
  assert.match(source, /tool = "pen"/);
  assert.match(source, /eraserMode = "normal"/);
  assert.match(source, /onStrokesCountChange/);
  assert.match(source, /onToolbarApiChange/);
  assert.match(source, /canClear = strokes\.length > 0/);
});

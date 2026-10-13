import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function source(relativePath) {
  return readFile(resolve(relativePath), "utf8");
}

// ---------------- PdfReader：可取消、可重试 ----------------

test("PdfReader：fetch 与 getDocument 携带 AbortSignal，卸载时 abort", async () => {
  const sourceCode = await source("src/PdfReader.jsx");
  assert.match(sourceCode, /fetch\(sourceUrl, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(sourceCode, /getDocument\(\{[\s\S]*?signal: controller\.signal/);
  assert.match(sourceCode, /controller\.abort\(\)/);
  assert.match(sourceCode, /reloadAttempt/);
});

test("PdfReader：加载失败提供重新加载按钮", async () => {
  const sourceCode = await source("src/PdfReader.jsx");
  assert.match(sourceCode, /setReloadAttempt\(\(value\) => value \+ 1\)/);
  assert.match(sourceCode, /AbortError/);
});

// ---------------- ClozeReader：watchdog + retry ----------------

test("ClozeReader：加载 watchdog 与重试按钮", async () => {
  const sourceCode = await source("src/ClozeReader.jsx");
  assert.match(sourceCode, /20000/);
  assert.match(sourceCode, /完形资料读取超时，请重试/);
  assert.match(sourceCode, /setLoadAttempt\(\(value\) => value \+ 1\)/);
  assert.match(sourceCode, /loadAttempt/);
});

// ---------------- 完形档案 / Settings / AI / 陌生词 ----------------

test("ClozeLearningArchiveModal：展开加载失败进入错误态而非永久读取", async () => {
  const sourceCode = await source("src/ClozeLearningArchiveModal.jsx");
  assert.match(sourceCode, /setDetailFailed\(true\)/);
  assert.match(sourceCode, /detailFailed/);
});

test("SettingsPanel：PIN 锁定计时器卸载时清理", async () => {
  const sourceCode = await source("src/ui/SettingsPanel.jsx");
  assert.match(sourceCode, /lockResetTimerRef/);
  assert.match(sourceCode, /window\.clearTimeout\(lockResetTimerRef\.current\)/);
});

test("ai.js：API 模型目录请求有超时与 abort 识别", async () => {
  const sourceCode = await source("src/ai.js");
  assert.match(sourceCode, /new AbortController\(\)/);
  assert.match(sourceCode, /AI_MODEL_LIST_TIMEOUT_MS\s*=\s*10000/);
  assert.match(sourceCode, /window\.setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
  assert.match(sourceCode, /读取模型列表超时/);
  assert.match(sourceCode, /signal: controller\.signal/);
});

test("AiFloatWindow：refreshKeyStatus 卸载后不再 setState", async () => {
  const sourceCode = await source("src/AiFloatWindow.jsx");
  assert.match(sourceCode, /keyStatusAliveRef/);
  assert.match(sourceCode, /keyStatusAliveRef\.current = false/);
});

test("CustomDeepReader：陌生词 AI 释义链卸载后不再写 IndexedDB", async () => {
  const sourceCode = await source("src/CustomDeepReader.jsx");
  assert.match(sourceCode, /mountedRef/);
  assert.match(sourceCode, /const isCurrent = \(\) => mountedRef\.current && getCurrentUsername\(\) === storageUsername && ocrContextRef\.current === context/);
  assert.match(sourceCode, /if \(!isCurrent\(\)\) return;/);
  assert.match(sourceCode, /signal: controller\.signal, isCurrent/);
  const resolver = await source("src/unknownWordContext.js");
  assert.match(resolver, /if \(!current\(\) \|\| !meaning\) return null/);
  assert.match(resolver, /expectedRevision: sense\.meaningRevision, isCurrent: current/);
});

// ---------------- 导入编辑器 / 词汇导入 ----------------

test("ExamImportEditor：重新解析分支以运行代次阻止旧请求迟到写回", async () => {
  const sourceCode = await source("src/ExamImportEditor.jsx");
  assert.match(sourceCode, /parseRunRef/);
  assert.match(sourceCode, /parseRunRef\.current !== runId/);
  assert.match(sourceCode, /parseRunRef\.current === runId/);
  assert.match(sourceCode, /if \(parseRunRef\.current === runId\) setProgress\(nextProgress\)/);
});

test("资料库修复：StrictMode setup 恢复 alive；统一导入复用 fingerprint 并在返回时校验账号", async () => {
  const sourceCode = await source("src/App.jsx");
  assert.match(sourceCode, /useEffect\(\(\) => \{\s*\/\/ StrictMode[\s\S]*?aliveRef\.current = true;/);
  const controller = await source("src/import/controller.js");
  assert.match(controller, /item\.fingerprint = fingerprint/);
  assert.match(controller, /await computeFileFingerprint\(file\.file\) !== file\.fingerprint/);
  assert.match(controller, /assertAccount\(this\.token\)/);
});

test("词汇导入 import.js：PDF 解析有超时与资源销毁", async () => {
  const sourceCode = await source("public/vocabulary/import.js");
  assert.match(sourceCode, /withParseTimeout/);
  assert.match(sourceCode, /page\.cleanup\?\.\(\)/);
  assert.match(sourceCode, /loadingTask\.destroy/);
});

test("词汇导入 import.js：UTF-8 CSV 使用 string 模式避免中文乱码", async () => {
  const sourceCode = await source("public/vocabulary/import.js");
  assert.ok(sourceCode.includes("/\\.csv$/i.test(file.name"));
  assert.match(sourceCode, /XLSX\.read\(await file\.text\(\), \{ type: "string" \}\)/);
});

// ---------------- Planner / 首页 ----------------

test("TodayTasks：计划失败进入可重试状态", async () => {
  const sourceCode = await source("src/TodayTasks.jsx");
  assert.match(sourceCode, /planFailed/);
  assert.match(sourceCode, /onRetryPlan=\{retryPlan\}/);
});

test("StudyPlannerPanel：失败态提供重新生成按钮", async () => {
  const sourceCode = await source("src/StudyPlannerPanel.jsx");
  assert.match(sourceCode, /planFailed = false/);
  assert.match(sourceCode, /onRetryPlan/);
  assert.match(sourceCode, /today-plan-retry/);
});

// ---------------- ErrorBoundary ----------------

test("ErrorBoundary：支持返回首页恢复动作", async () => {
  const sourceCode = await source("src/ErrorBoundary.jsx");
  assert.match(sourceCode, /onReset/);
  assert.match(sourceCode, /返回首页/);
});

test("App.jsx：核心页面有独立局部边界（key=view + onReset）", async () => {
  const sourceCode = await source("src/App.jsx");
  assert.match(sourceCode, /<ErrorBoundary\s+key=\{nav\.view\}/);
  assert.match(sourceCode, /setNav\(\{ view: "home", stack: \[\] \}\)/);
});

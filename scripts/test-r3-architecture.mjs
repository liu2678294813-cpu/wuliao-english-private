import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function exists(relativePath) {
  return existsSync(new URL(`../${relativePath}`, import.meta.url));
}

test("R3 基础设施模块存在", () => {
  for (const file of [
    "src/events/eventTypes.js",
    "src/events/appEvents.js",
    "src/learningSnapshot.js",
    "src/aiRequestLifecycle.js",
    "src/vocabulary/vocabularyProtocol.js",
    "src/vocabulary/vocabularyBridge.js",
    "src/ui/VocabularyWorkspace.jsx",
    "public/vocabulary/vocabulary-bridge-adapter.js",
  ]) {
    assert.equal(exists(file), true, `missing ${file}`);
  }
});

test("App.jsx 不再定义词汇 iframe workspace 组件（职责已独立）", () => {
  const app = read("src/App.jsx");
  assert.doesNotMatch(app, /function VocabularyWorkspace/);
  assert.match(app, /import VocabularyWorkspace from "\.\/ui\/VocabularyWorkspace"/);
});

test("CustomDeepReader 保持单一 UI 边界（未做破坏性拆分）", () => {
  const reader = read("src/CustomDeepReader.jsx");
  assert.match(reader, /export default function CustomDeepReader/);
  // 笔迹引擎保持在独立模块，Reader 只引用其 API
  assert.match(reader, /from "\.\/inkEngine"/);
  assert.match(reader, /from "\.\/annotationTools"/);
});

test("AI 请求不再由 UI 组件直接管理全部生命周期", () => {
  const aiWindow = read("src/AiFloatWindow.jsx");
  assert.match(aiWindow, /createAiRequestLifecycle/);
  assert.match(aiWindow, /isContextStale/);
  const ai = read("src/ai.js");
  assert.match(ai, /signal = null/);
});

test("LearningSnapshot 是只读派生层，不包含业务规则", () => {
  const snapshot = read("src/learningSnapshot.js");
  assert.doesNotMatch(snapshot, /localStorage\.setItem/);
  assert.doesNotMatch(snapshot, /indexedDB\.open/);
  const sources = read("src/studyPlannerSources.js");
  // Planner 业务规则仍留在 studyPlannerSources / studyPlanner，由调用方消费 snapshot
  assert.match(sources, /planStudyDay/);
});

test("事件名集中定义且业务模块引用统一契约", () => {
  const eventTypes = read("src/events/eventTypes.js");
  const readingReview = read("src/readingReview.js");
  const clozeReview = read("src/clozeReview.js");
  const studyPlanner = read("src/studyPlanner.js");
  assert.match(eventTypes, /REVIEW_TASKS_UPDATED: "wuliao:review-tasks-updated"/);
  assert.match(eventTypes, /LEARNING_STATE_INVALIDATED: "wuliao:learning-state-invalidated"/);
  assert.match(readingReview, /REVIEW_TASKS_UPDATED = AppEvent\.REVIEW_TASKS_UPDATED/);
  assert.match(clozeReview, /CLOZE_REVIEW_TASKS_UPDATED = AppEvent\.CLOZE_REVIEW_TASKS_UPDATED/);
  assert.match(studyPlanner, /STUDY_PLAN_UPDATED = AppEvent\.STUDY_PLAN_UPDATED/);
});

test("词汇消息发送统一走 VocabularyBridge", () => {
  const app = read("src/App.jsx");
  assert.doesNotMatch(app, /postMessage\(\{ type: "wuliao:vocabulary-navigate"/);
  assert.doesNotMatch(app, /postMessage\(\{ type: "wuliao:hardware-back"/);
  assert.match(app, /vocabularyBridge\.send/);
});

test("词汇子应用 adapter 收敛发送点且保留既有接收逻辑", () => {
  const adapter = read("public/vocabulary/vocabulary-bridge-adapter.js");
  assert.match(adapter, /wuliao:vocabulary/);
  assert.match(adapter, /window\.VocabularyBridge/);
  assert.match(adapter, /ROUTE_CHANGED/);
  assert.match(adapter, /HARDWARE_BACK_RESPONSE/);
  const polish = read("public/vocabulary/app-polish.js");
  assert.match(polish, /VocabularyBridge/);
  // 既有接收逻辑与安全校验保留
  assert.match(polish, /isTrustedParentMessage/);
  assert.match(polish, /wuliao:hardware-back/);
});

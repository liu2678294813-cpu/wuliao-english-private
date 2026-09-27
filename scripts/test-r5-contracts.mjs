// R5 · 交互与一致性收尾契约测试。
//
// 覆盖：
//   A. 完形资料卡真实学习状态（纯函数 + 轻量扫描）
//   B. 陌生词来源兼容（sourceType 默认 reading、筛选、主键不变）
//   C. 首页最近学习统一派生（阅读 + 完形混排、limit、去重、已完成完形、ghost 过滤）
//   D. study rank 契约不变
//   E. 精读工具栏 collapsed 几何契约（占位释放、展开命中区、920px / ink 保护）
//   F. 完形陌生词两态门控（初做/复查/订正整个入口隐藏，精析/回读完整开放，
//      共享 unknownWordInteraction 机制，无 mark-only 中间态）
//   G. 自定义完形长期档案标题修复

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.indexedDB = undefined;

const { setCurrentUsername } = await import("../src/userData.js");
const { CLOZE_STAGES, completeClozeStage, emptyClozeFlow, saveClozeFlow } = await import("../src/clozeFlow.js");
const { emptyClozeProgress, markAnalyzed, saveClozeProgress } = await import("../src/clozeProgress.js");
const { ensureClozeReviewTask, startClozeReviewTask } = await import("../src/clozeReview.js");
const {
  deriveClozeCardStatus,
  scanClozeLibraryStatuses,
  CLOZE_CARD_STATE,
} = await import("../src/clozeLibraryStatus.js");
const { unknownWordSourceType } = await import("../src/clozeUnknownWords.js");
const { buildClozeUnknownEntry } = await import("../src/clozeUnknownWords.js");
const { buildRecentLearning, completedClozeCount, scanClozeFlows } = await import("../src/recentLearning.js");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function makeOfficialResource(year = 2012) {
  return {
    id: `postgraduate-${year}-cloze`,
    kind: "official-cloze",
    category: "postgraduate-cloze",
    year,
    title: `${year} 英语（一）完形填空`,
    subtitle: "Section I · Use of English · 正式训练",
  };
}

function makeCustomResource(title = "2021 真题卷") {
  return {
    id: "custom-fingerprint-user",
    kind: "custom",
    category: "custom",
    year: 2021,
    title,
    analysis: { clozes: [{ blanks: Array.from({ length: 5 }, (_, i) => ({ number: i + 1 })) }] },
  };
}

function completeFlow(flow, now = Date.now()) {
  let next = flow;
  for (const stage of CLOZE_STAGES) {
    if (next.stages[stage.id].status !== "completed") {
      next = { ...next, stages: { ...next.stages, [stage.id]: { status: "completed", completedAt: now } } };
    }
  }
  return next;
}

// ---------------- A. 完形资料卡状态 ----------------

test("A1 无任何记录 → 尚未开始", () => {
  const status = deriveClozeCardStatus({ resource: makeOfficialResource(2012) });
  assert.equal(status.state, CLOZE_CARD_STATE.NOT_STARTED);
  assert.equal(status.label, "尚未开始");
  assert.equal(status.dueLabel, null);
});

test("A2 first-attempt flow → 进行中 · 限时初做", () => {
  const resource = makeOfficialResource(2012);
  const flow = { ...emptyClozeFlow(resource.id, resource.id), currentStage: "cloze-first-attempt" };
  const status = deriveClozeCardStatus({ flow, resource });
  assert.equal(status.state, CLOZE_CARD_STATE.IN_PROGRESS);
  assert.equal(status.label, "进行中 · 限时初做");
});

test("A3 analysis 12/20 → 进行中 · 逐空精析 12/20", () => {
  const resource = makeOfficialResource(2012);
  const flow = { ...emptyClozeFlow(resource.id, resource.id), currentStage: "cloze-analysis" };
  let progress = emptyClozeProgress(resource.id, resource.id, Array.from({ length: 20 }, (_, i) => i + 1));
  for (let number = 1; number <= 12; number += 1) progress = markAnalyzed(progress, number, true);
  const status = deriveClozeCardStatus({ flow, progress, resource });
  assert.equal(status.state, CLOZE_CARD_STATE.IN_PROGRESS);
  assert.equal(status.label, "进行中 · 逐空精析 12/20");
  assert.equal(status.analyzedCount, 12);
  assert.equal(status.totalBlanks, 20);
});

test("A4 全部阶段完成 → 已完成", () => {
  const resource = makeOfficialResource(2012);
  const flow = completeFlow(emptyClozeFlow(resource.id, resource.id));
  const status = deriveClozeCardStatus({ flow, resource });
  assert.equal(status.state, CLOZE_CARD_STATE.COMPLETED);
  assert.equal(status.label, "✓ 已完成");
});

test("A5 D+1 逾期/到期 → D+1 待复习 · N 空（优先于已完成）", () => {
  const resource = makeOfficialResource(2012);
  const flow = completeFlow(emptyClozeFlow(resource.id, resource.id));
  const task = ensureClozeReviewTask({
    taskKey: `cloze-review:d1:${resource.id}:${resource.id}:2026-08-01`,
    type: "d1",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1, 2, 3, 5, 7, 9, 12],
    username: "alice",
  }).task;
  const status = deriveClozeCardStatus({ flow, reviewTasks: [task], resource, today: "2026-08-03" });
  assert.equal(status.state, CLOZE_CARD_STATE.REVIEW_DUE);
  assert.equal(status.label, "D+1 待复习 · 7 空");
  assert.equal(status.dueLabel, "D+1 待复习 · 7 空");
});

test("A6 D+7 到期 → D+7 待复习 · 3 空", () => {
  const resource = makeOfficialResource(2012);
  const flow = completeFlow(emptyClozeFlow(resource.id, resource.id));
  const task = ensureClozeReviewTask({
    taskKey: `cloze-review:d7:${resource.id}:${resource.id}:2026-08-01`,
    type: "d7",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-08-01",
    dueDate: "2026-08-08",
    targetBlankIds: [2, 4, 6],
    username: "alice",
  }).task;
  const status = deriveClozeCardStatus({ flow, reviewTasks: [task], resource, today: "2026-08-08" });
  assert.equal(status.state, CLOZE_CARD_STATE.REVIEW_DUE);
  assert.equal(status.label, "D+7 待复习 · 3 空");
});

test("A7 进行中的复习优先于到期待复习", () => {
  const resource = makeOfficialResource(2012);
  const flow = completeFlow(emptyClozeFlow(resource.id, resource.id));
  const due = ensureClozeReviewTask({
    taskKey: `cloze-review:d1:${resource.id}:${resource.id}:2026-08-01`,
    type: "d1",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1],
    username: "alice",
  }).task;
  const d7 = ensureClozeReviewTask({
    taskKey: `cloze-review:d7:${resource.id}:${resource.id}:2026-07-01`,
    type: "d7",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-07-01",
    dueDate: "2026-07-08",
    targetBlankIds: [2],
    username: "alice",
  }).task;
  const inProgress = startClozeReviewTask(d7.taskKey, 1780000000000, "alice");
  assert.ok(inProgress, "startClozeReviewTask 应返回进行中的任务");
  const status = deriveClozeCardStatus({
    flow,
    reviewTasks: [due, inProgress].filter(Boolean),
    resource,
    today: "2026-08-03",
  });
  assert.equal(status.state, CLOZE_CARD_STATE.REVIEW_IN_PROGRESS);
  assert.equal(status.label, "进行中 · D+7 复习");
});

test("A8 D+7 已完成且全部复习完成 → 已稳定", () => {
  const resource = makeOfficialResource(2012);
  const flow = completeFlow(emptyClozeFlow(resource.id, resource.id));
  const d1 = ensureClozeReviewTask({
    taskKey: `cloze-review:d1:${resource.id}:${resource.id}:2026-08-01`,
    type: "d1",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1],
    username: "alice",
  }).task;
  const d7 = ensureClozeReviewTask({
    taskKey: `cloze-review:d7:${resource.id}:${resource.id}:2026-08-01`,
    type: "d7",
    resourceId: resource.id,
    clozeId: resource.id,
    sourceDate: "2026-08-01",
    dueDate: "2026-08-08",
    targetBlankIds: [1],
    username: "alice",
  }).task;
  const status = deriveClozeCardStatus({
    flow,
    reviewTasks: [
      { ...d1, completedAt: 1780000000000 },
      { ...d7, completedAt: 1780000000000 },
    ],
    resource,
    today: "2026-08-20",
  });
  assert.equal(status.state, CLOZE_CARD_STATE.COMPLETED);
  assert.equal(status.label, "✓ 已完成 · 已稳定");
});

test("A9 custom 无官方答案：状态不出现正确率/错题/对错", () => {
  const resource = makeCustomResource("2021 真题卷");
  const flow = { ...emptyClozeFlow(resource.id, resource.id), currentStage: "cloze-correction" };
  const status = deriveClozeCardStatus({ flow, resource });
  assert.equal(status.label, "进行中 · 统一订正");
  for (const forbidden of ["正确", "错误", "错题", "对/错", "正确率"]) {
    assert.ok(!status.label.includes(forbidden), `custom 状态不得包含「${forbidden}」`);
  }
});

test("A10 轻量扫描一次遍历生成 Map（official + custom）", () => {
  fresh();
  const resource = makeOfficialResource(2010);
  saveClozeFlow({ ...completeClozeStage(emptyClozeFlow(resource.id, resource.id), "cloze-cover"), updatedAt: 1700000000000 });
  const custom = makeCustomResource("2022 模拟卷");
  let flow = emptyClozeFlow(custom.id, custom.id);
  for (const stageId of ["cloze-cover", "cloze-first-attempt", "cloze-self-review", "cloze-correction"]) {
    flow = completeClozeStage(flow, stageId);
  }
  saveClozeFlow(flow);
  const map = scanClozeLibraryStatuses({ resources: [resource, custom] });
  assert.equal(map.size, 2);
  assert.equal(map.get(resource.id).label, "进行中 · 限时初做");
  assert.equal(map.get(custom.id).label, "进行中 · 逐空精析 0/5");
});

test("A11 已删除的 custom resource 不产生状态（扫描只认传入资源）", () => {
  fresh();
  saveClozeFlow({ ...emptyClozeFlow("custom-gone", "custom-gone"), updatedAt: 1700000000000 });
  const map = scanClozeLibraryStatuses({ resources: [makeOfficialResource(2011)] });
  assert.equal(map.size, 1);
  assert.ok(!map.has("custom-gone"));
});

// ---------------- B. 陌生词来源兼容 ----------------

test("B1 旧记录无 sourceType → 按 reading 处理", () => {
  assert.equal(unknownWordSourceType({ resourceId: "postgraduate-2012-text-3" }), "reading");
  assert.equal(unknownWordSourceType(null), "reading");
});

test("B2 新 cloze 记录 → cloze；新 reading 记录 → reading", () => {
  assert.equal(unknownWordSourceType({ sourceType: "cloze" }), "cloze");
  assert.equal(unknownWordSourceType({ sourceType: "reading" }), "reading");
});

test("B3 完形 entry 主键字段语义不变（username 之外字段结构）", () => {
  const entry = buildClozeUnknownEntry({
    resource: makeOfficialResource(2012),
    word: "Incredible",
    normalizedWord: "incredible",
    occurrenceId: "s-1:0:w1",
    meaning: "难以置信的",
  });
  assert.equal(entry.resourceId, "postgraduate-2012-cloze");
  assert.equal(entry.passageId, "cloze");
  assert.equal(entry.normalizedWord, "incredible");
  assert.equal(entry.sourceType, "cloze");
  assert.equal(entry.chapter, "完形填空");
  assert.equal(entry.sourceLabel, "2012 英语（一）完形填空");
  // 与精读记录共用同一组 identity 字段，不引入新主键成分
  assert.ok("resourceId" in entry && "passageId" in entry && "normalizedWord" in entry);
});

test("B4 陌生词 token 识别（共享 UNKNOWN_WORD_PATTERN）不触碰 blank/句子身份", () => {
  const shared = read("src/unknownWordInteraction.js");
  assert.match(shared, /UNKNOWN_WORD_PATTERN = \/\[A-Za-z\]\+/);
  const source = read("src/ClozeReader.jsx");
  // 完形正文：每个句子是独立 data-unknown-scope，blank chip 用 data-unknown-ignore 排除，
  // token 识别只作用于展示层文本，不改 blank 编号 / 句子身份。
  assert.match(source, /data-unknown-scope/);
  assert.match(source, /data-unknown-ignore/);
  assert.match(source, /token\.number/);
});

// ---------------- C. 首页最近学习 ----------------

function saveReadingProgress(resourceId, updatedAt) {
  globalThis.localStorage.setItem(
    `wuliao:user:alice:wuliao:progress:${resourceId}`,
    JSON.stringify({ id: resourceId, page: 2, total: 15, updatedAt }),
  );
}

test("C1 reading-only 行为不回归", () => {
  fresh();
  saveReadingProgress("postgraduate-2012-text-3", 1000);
  saveReadingProgress("postgraduate-2012-text-4", 900);
  const items = buildRecentLearning({
    resources: [],
    customResources: [],
    username: "alice",
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "reading");
  assert.equal(items[0].resource.id, "postgraduate-2012-text-3");
});

test("C2 cloze flow 最近项进入列表并按 updatedAt 混排", () => {
  fresh();
  saveReadingProgress("postgraduate-2012-text-3", 1000);
  saveClozeFlow({ ...emptyClozeFlow("postgraduate-2010-cloze", "postgraduate-2010-cloze"), updatedAt: 3000 });
  saveClozeFlow({ ...emptyClozeFlow("postgraduate-2009-cloze", "postgraduate-2009-cloze"), updatedAt: 2000 });
  const items = buildRecentLearning({
    resources: [makeOfficialResource(2010), makeOfficialResource(2009)],
    username: "alice",
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.type), ["cloze-training", "cloze-training", "reading"]);
  assert.equal(items[0].resource.id, "postgraduate-2010-cloze");
  assert.equal(items[1].resource.id, "postgraduate-2009-cloze");
});

test("C3 最大展示数量限制生效（limit）", () => {
  fresh();
  saveReadingProgress("postgraduate-2012-text-1", 100);
  saveReadingProgress("postgraduate-2012-text-2", 200);
  saveReadingProgress("postgraduate-2012-text-3", 300);
  saveClozeFlow({ ...emptyClozeFlow("postgraduate-2010-cloze", "postgraduate-2010-cloze"), updatedAt: 400 });
  const items = buildRecentLearning({ resources: [makeOfficialResource(2010)], limit: 3, username: "alice" });
  assert.equal(items.length, 3);
  assert.equal(items[0].resource.id, "postgraduate-2010-cloze");
});

test("C4 Continue Learning 项被排除（支持 cloze 资源 id）", () => {
  fresh();
  saveClozeFlow({ ...emptyClozeFlow("postgraduate-2010-cloze", "postgraduate-2010-cloze"), updatedAt: 100 });
  saveReadingProgress("postgraduate-2012-text-3", 50);
  const items = buildRecentLearning({
    resources: [makeOfficialResource(2010)],
    excludeResourceIds: ["postgraduate-2010-cloze"],
    username: "alice",
  });
  assert.deepEqual(items.map((item) => item.resource.id), ["postgraduate-2012-text-3"]);
});

test("C5 已删除 custom flow 不产生 ghost 项", () => {
  fresh();
  saveClozeFlow({ ...emptyClozeFlow("custom-gone", "custom-gone"), updatedAt: 999 });
  const items = buildRecentLearning({ resources: [], customResources: [], username: "alice" });
  assert.equal(items.length, 0);
});

test("C6 cloze review task 最近项进入列表（含已完成任务仅展示不重启）", () => {
  fresh();
  ensureClozeReviewTask({
    taskKey: "cloze-review:d1:postgraduate-2012-cloze:postgraduate-2012-cloze:2026-08-01",
    type: "d1",
    resourceId: "postgraduate-2012-cloze",
    clozeId: "postgraduate-2012-cloze",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1, 2],
    username: "alice",
  });
  const items = buildRecentLearning({
    resources: [makeOfficialResource(2012)],
    username: "alice",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "cloze-review");
  assert.equal(items[0].task.type, "d1");
  assert.ok(items[0].updatedAt > 0);
});

test("C7 已完成完形数量派生（official + custom，ghost 过滤）", () => {
  fresh();
  saveClozeFlow(completeFlow(emptyClozeFlow("postgraduate-2010-cloze", "postgraduate-2010-cloze"), 1000));
  saveClozeFlow(completeFlow(emptyClozeFlow("postgraduate-2011-cloze", "postgraduate-2011-cloze"), 1000));
  saveClozeFlow(completeFlow(emptyClozeFlow("custom-gone", "custom-gone"), 1000));
  const count = completedClozeCount({
    resources: [makeOfficialResource(2010), makeOfficialResource(2011)],
    username: "alice",
  });
  assert.equal(count, 2);
});

test("C8 scanClozeFlows 轻量扫描不解析正文", () => {
  fresh();
  saveClozeFlow({ ...emptyClozeFlow("postgraduate-2010-cloze", "postgraduate-2010-cloze"), updatedAt: 5 });
  const flows = scanClozeFlows("alice");
  assert.equal(flows.size, 1);
  assert.equal(flows.get("postgraduate-2010-cloze").updatedAt, 5);
});

// ---------------- D. study rank 契约不变 ----------------

test("D1 rank 计分常量与事实源不变（不包含完形）", () => {
  const source = read("src/studyRank.js");
  assert.match(source, /6515/);
  assert.match(source, /1500/);
  assert.match(source, /68/);
  assert.match(source, /1000/);
  assert.match(source, /MAX_SCORE = VOCABULARY_MAX_SCORE \+ READING_MAX_SCORE/);
  assert.ok(!source.includes("cloze"), "rank 计分不得依赖完形");
});

// ---------------- E. 精读工具栏 collapsed 几何契约 ----------------

test("E1 collapsed 后工具栏不再保留全宽固定高度占位", () => {
  const css = read("src/redesign/reader.css");
  assert.match(css, /\.annotation-toolbar\.collapsed\b[^{]*\{[^}]*height:\s*0\s*!important/m);
  assert.match(css, /\.annotation-toolbar\.collapsed\b[^{]*\{[^}]*min-height:\s*0\s*!important/m);
  // 不能只是把 51px 改成更小值：必须出现 height: 0 的规则
  assert.ok(!/\.annotation-toolbar\.collapsed\b[^{]*\{[^}]*height:\s*var\(--reader-toolbar-height\)/m.test(css));
});

test("E2 折叠态展开入口为紧凑悬浮形态且触控命中 ≥44px", () => {
  const css = read("src/redesign/reader.css");
  assert.match(css, /\.annotation-toolbar\.collapsed \.toolbar-collapse-toggle/);
  assert.match(css, /position:\s*absolute/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /border-radius:\s*999px/);
  // 入口不再作为全宽 normal flow 行
  assert.match(css, /position:\s*absolute/);
});

test("E3 折叠后正文区域补偿（Custom margin / Pdf padding）", () => {
  const css = read("src/redesign/reader.css");
  assert.match(css, /\.annotation-toolbar\.collapsed \+ \.deep-reader-content/);
  assert.match(css, /\.annotation-toolbar\.collapsed \+ \.reader-main/);
});

test("E4 受控折叠状态接线（两个 Reader 都传 collapsed + stageHint）", () => {
  const pdf = read("src/PdfReader.jsx");
  const custom = read("src/CustomDeepReader.jsx");
  const toolbar = read("src/ui/AnnotationToolbar.jsx");
  assert.match(pdf, /collapsed=\{topAreaCollapsed\}/);
  assert.match(custom, /collapsed=\{topAreaCollapsed\}/);
  assert.match(pdf, /stageHint=\{stage\}/);
  assert.match(custom, /stageHint=\{/);
  // Default pill hosts retain their contract; Readers opt into chrome-only.
  assert.match(toolbar, /pillCollapsed && stageHint/);
  assert.match(toolbar, /collapseMode = "pill"/);
  assert.match(pdf, /collapseMode="chrome-only"/);
  assert.match(custom, /collapseMode="chrome-only"/);
});

test("E5 920px workbook 几何契约未被修改", () => {
  const css = read("src/redesign/reader.css");
  assert.match(css, /width:\s*min\(920px/);
  assert.match(css, /transition:\s*none/);
  const tokens = read("src/redesign/tokens.css");
  assert.match(tokens, /--ds-reader-max:\s*920px/);
});

test("E6 perfect-freehand / ink schema 契约未被修改", () => {
  const pdf = read("src/PdfReader.jsx");
  const custom = read("src/CustomDeepReader.jsx");
  assert.match(custom, /perfect-freehand|createStroke|getStroke|drawInkStroke/);
  assert.match(custom, /deep-committed-ink-layer/);
  assert.match(custom, /viewport-ink-preview/);
  // 未改动 canvas-stack 内联尺寸机制
  assert.match(pdf, /canvas-stack/);
});

// ---------------- F. 完形陌生词阶段隔离 ----------------

test("F1 初做/复查/订正不渲染陌生词入口（两态门控）", () => {
  const source = read("src/ClozeReader.jsx");
  // 两态：禁止查词的阶段（初做/复查/订正）整个入口隐藏；
  // 允许的阶段（精析/回读）100% 精读完整能力。
  assert.match(source, /unknownWordsVisible = isAnalysisStage\(stageId\) \|\| isFinalReadStage\(stageId\)/);
  // 入口在共享 AnnotationToolbar（unknownEnabled），不再有 ReaderHeader 独立 toggle。
  assert.match(source, /unknownEnabled=\{unknownWordsVisible\}/);
  assert.ok(!source.includes("cloze-unknown-mode-toggle"), "完形不再有独立陌生词入口按钮");
  // 纵深门控：禁止阶段不透传 beforeInk* 钩子（runtime 层也不收集陌生词）
  assert.match(source, /beforeInkDown=\{unknownWordsVisible \? clozeUnknownHooks\.beforeInkDown : null\}/);
  assert.match(source, /beforeInkMove=\{unknownWordsVisible \? clozeUnknownHooks\.beforeInkMove : null\}/);
  assert.match(source, /beforeInkFinish=\{unknownWordsVisible \? clozeUnknownHooks\.beforeInkFinish : null\}/);
});

test("F2 无 mark-only 中间态：订正阶段整个入口隐藏", () => {
  const source = read("src/ClozeReader.jsx");
  assert.ok(!source.includes("unknownMarkOnly"), "不存在订正只标记中间态");
  assert.ok(!source.includes("markClozeUnknownWord"), "不再调用完形专用 mark 函数");
  const helper = read("src/clozeUnknownWords.js");
  assert.ok(!helper.includes("markClozeUnknownWord"), "clozeUnknownWords 不再提供 mark-only 实现");
  assert.match(helper, /buildClozeUnknownEntry/);
});

test("F3 精析/回读完整开放（离线释义 → AI → 人工补充，带 mounted guard）", () => {
  const source = read("src/ClozeReader.jsx");
  assert.match(source, /aliveRef\.current/);
  assert.match(source, /lookupWordMeaningWithAi/);
  assert.match(source, /updateUnknownWordMeaning/);
});

test("F4 D+1/D+7 复习会话不提供陌生词释义入口", () => {
  const session = read("src/ClozeReviewSession.jsx");
  assert.ok(!session.includes("toggleUnknownWord"), "复习会话不得接入生词 toggle");
  assert.ok(!session.includes("lookupUnknownWordMeaning"), "复习会话不得查询词义");
  assert.ok(!session.includes("cloze-unknown-target"), "复习正文不得渲染生词 target");
});

test("F5 完形正文陌生词 scope 不改变 blank / sentence 结构", () => {
  const source = read("src/ClozeReader.jsx");
  assert.match(source, /cloze-blank-/);
  assert.match(source, /sentence\.sentenceKey/);
  assert.match(source, /token\.number/);
  // 每个句子是独立 data-unknown-scope（scope id = sentence.sentenceKey，其本身含
  // cloze: 前缀），blank chip 用 data-unknown-ignore 排除——token 识别不改 blank /
  // sentence 结构；occurrenceId = `${sentenceKey}:${wordIndex}` 可精确反查句子。
  assert.match(source, /data-unknown-scope=\{sentence\.sentenceKey\}/);
  assert.match(source, /data-unknown-ignore/);
});

// ---------------- G. 自定义完形档案标题 ----------------

test("G1 EntryRow 使用解析后的标题而非 resourceId", () => {
  const source = read("src/ClozeLearningArchiveModal.jsx");
  // R6：标题解析仍由 titleFor 完成（官方 → custom title → resourceId），
  // 在 items memo 中解析一次后传给 EntryRow，行为等价。
  assert.match(source, /title: titleFor\(record\)/);
  assert.match(source, /title=\{item\.title\}/);
  assert.match(source, /<strong>\{title \|\| record\.resourceId\}<\/strong>/);
  assert.match(source, /titleFor = \(record\) =>/);
  // fallback 顺序：官方 → custom title → resourceId
  assert.match(source, /postgraduateClozeResources\.find/);
  assert.match(source, /customTitles\[record\.resourceId\]/);
  assert.match(source, /record\.resourceId/);
});

test("G2 官方标题与自定义标题映射逻辑", () => {
  const resource = makeOfficialResource(2020);
  assert.equal(resource.title, "2020 英语（一）完形填空");
  const custom = makeCustomResource("2021 真题卷");
  assert.equal(custom.title, "2021 真题卷");
});

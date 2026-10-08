import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  isLegacyExamHash,
  isNavGroup,
  longSentenceHostHash,
  longSentenceRouteFromHost,
  isVocabularyRouteActive,
  navLeaves,
  normalizeVocabularyRoute,
  PRIMARY_NAV,
  readingHostHash,
  readingRouteFromHost,
  READING_NAV,
  shouldReloadVocabularyDocument,
  VOCABULARY_SPA_ROUTES,
  VOCABULARY_STATIC_PAGES,
  vocabularyWorkspaceFor,
} from "../src/navigation.js";

test("一级导航包含独立长难句，阅读分组不变", () => {
  assert.deepEqual(
    PRIMARY_NAV.map((item) => item.label),
    ["首页", "阅读", "长难句", "写作", "词库", "筛查", "背诵", "复习"],
  );
  assert.ok(!PRIMARY_NAV.some((item) => item.label === "更多"));
  assert.ok(!PRIMARY_NAV.some((item) => item.label === "学习" || item.label === "学习单词"));
  assert.equal(new Set(PRIMARY_NAV.map((item) => item.id)).size, PRIMARY_NAV.length);
});

test("阅读是分组标题，不直接导航；精读/完形是叶子", () => {
  const group = PRIMARY_NAV.find((item) => item.id === "reading-group");
  assert.equal(group.label, "阅读");
  assert.ok(isNavGroup(group));
  assert.ok(!group.view, "分组本身不可点击导航");
  assert.deepEqual(group.children.map((item) => item.label), ["精读", "完形"]);
  assert.deepEqual(READING_NAV.map((item) => item.view), ["library", "cloze-library"]);
  for (const child of group.children) {
    assert.ok(child.view, "叶子必须有 view");
    assert.ok(!isNavGroup(child));
  }
});

test("叶子列表包含精读/完形/写作/长难句，共 9 项，且不包含分组", () => {
  const leaves = navLeaves(PRIMARY_NAV);
  const labels = leaves.map((item) => item.label);
  assert.ok(labels.includes("精读"));
  assert.ok(labels.includes("完形"));
  assert.ok(!labels.includes("模拟"));
  assert.ok(labels.includes("写作"));
  assert.ok(!labels.includes("阅读"));
  assert.ok(labels.includes("首页"));
  assert.ok(labels.includes("词库"));
  assert.equal(leaves.length, 9);
  assert.ok(leaves.some((item) => item.id === "long-sentence" && item.view === "long-sentence"));
  assert.ok(!leaves.some((item) => item.id === "exam"));
});

test("词库指向 dashboard SPA，背诵/复习指向 static，列表 route 仍保留但不是一级入口", () => {
  const byId = Object.fromEntries(navLeaves(PRIMARY_NAV).map((item) => [item.id, item]));
  assert.equal(byId["vocabulary-home"].kind, "spa");
  assert.equal(byId["vocabulary-home"].route, "/dashboard");
  assert.equal(byId["vocabulary-home"].icon, "dashboard");
  assert.equal(byId.screening.kind, "spa");
  assert.equal(byId.screening.route, "/screening/1");
  assert.equal(byId.lists, undefined);
  assert.ok(VOCABULARY_SPA_ROUTES.has("/lists"));
  assert.equal(byId.memorize.kind, "static");
  assert.equal(byId.memorize.page, "memorize");
  assert.equal(byId.review.kind, "static");
  assert.equal(byId.review.page, "review");
});

test("首页与主页的 view 与 active 判定互不混淆", () => {
  assert.equal(PRIMARY_NAV.find((item) => item.id === "home").view, "home");
  assert.equal(PRIMARY_NAV.find((item) => item.id === "vocabulary-home").view, "vocabulary");
  assert.ok(isVocabularyRouteActive("/dashboard", "/dashboard"));
  assert.ok(!isVocabularyRouteActive("/dashboard", "/lists"));
  assert.ok(!isVocabularyRouteActive("/dashboard", "/screening/1"));
  assert.ok(!isVocabularyRouteActive("/lists", "/dashboard"));
});

test("同 document 不重载 iframe，跨 document 才重载", () => {
  assert.equal(shouldReloadVocabularyDocument({
    targetKind: "spa",
    currentPathname: "/vocabulary/index.html",
  }), false);
  assert.equal(shouldReloadVocabularyDocument({
    targetKind: "spa",
    currentPathname: "/vocabulary/memorize.html",
  }), true);
  assert.equal(shouldReloadVocabularyDocument({
    targetKind: "static",
    targetPage: "memorize",
    currentPathname: "/vocabulary/memorize.html",
  }), false);
  assert.equal(shouldReloadVocabularyDocument({
    targetKind: "static",
    targetPage: "review",
    currentPathname: "/vocabulary/memorize.html",
  }), true);
});

test("静态工作区配置带 embedded 标识", () => {
  assert.ok(VOCABULARY_STATIC_PAGES.memorize.src.includes("?embedded=1"));
  assert.ok(VOCABULARY_STATIC_PAGES.review.src.includes("?embedded=1"));
  assert.ok(VOCABULARY_STATIC_PAGES.import.src.includes("?embedded=1"));
  const workspace = vocabularyWorkspaceFor(PRIMARY_NAV.find((item) => item.id === "memorize"));
  assert.equal(workspace.kind, "static");
  assert.equal(workspace.page, "memorize");
});

test("路由规范化与 active 判断", () => {
  assert.equal(normalizeVocabularyRoute("/screening/1"), "/screening");
  assert.equal(normalizeVocabularyRoute("/learning/42"), "/learning");
  assert.equal(normalizeVocabularyRoute("/export/42"), "/export");
  assert.equal(normalizeVocabularyRoute("/lists"), "/lists");
  assert.ok(VOCABULARY_SPA_ROUTES.has("/screening"));
  assert.ok(isVocabularyRouteActive("/screening", "/screening"));
  assert.ok(isVocabularyRouteActive("/screening", "/screening/1?sourceListId=3"));
  assert.ok(!isVocabularyRouteActive("/lists", "/screening/1"));
});

test("阅读 hash 路由可解析与恢复", () => {
  const originalHash = globalThis.window?.location?.hash;
  globalThis.window = { location: { hash: "#/reading/library" } };
  try {
    assert.deepEqual(readingRouteFromHost(), { view: "library", resourceId: "" });
  } finally {
    globalThis.window = { location: { hash: originalHash || "" } };
  }
  assert.equal(readingHostHash({ view: "library" }), "#/reading/library");
  assert.equal(readingHostHash({ view: "cloze-library" }), "#/reading/cloze");
  assert.equal(readingHostHash({ view: "cloze", resourceId: "postgraduate-2023-cloze" }), "#/reading/cloze/postgraduate-2023-cloze");
});

test("完形训练深链接解析出 resourceId", () => {
  const originalHash = globalThis.window?.location?.hash;
  globalThis.window = { location: { hash: "#/reading/cloze/postgraduate-2007-cloze" } };
  try {
    assert.deepEqual(readingRouteFromHost(), { view: "cloze", resourceId: "postgraduate-2007-cloze" });
  } finally {
    globalThis.window = { location: { hash: originalHash || "" } };
  }
});

test("旧模拟地址只做兼容识别，不解析或恢复考试", () => {
  for (const hash of ["#/exam", "#/exam/", "#/exam/library", "#/exam/history",
    "#/exam/cover/2023", "#/exam/session/x", "#/exam/result/%E0%A4"]) {
    assert.equal(isLegacyExamHash(hash), true);
  }
  for (const hash of ["", "#/reading/library", "#/examination", "#/writing"]) {
    assert.equal(isLegacyExamHash(hash), false);
  }
});

test("长难句深链接只保留 Session identity，拒绝损坏编码和额外查询", () => {
  const originalWindow = globalThis.window;
  try {
    for (const [hash, expected] of [
      ["#/long-sentence", { view: "long-sentence", sessionId: "" }],
      [longSentenceHostHash("alice:练习/1"), { view: "long-sentence", sessionId: "alice:练习/1" }],
      ["#/long-sentence/session/%E0%A4%A", null],
      ["#/long-sentence/session/a?stage=answer", null],
    ]) {
      globalThis.window = { location: { hash } };
      assert.deepEqual(longSentenceRouteFromHost(), expected);
    }
  } finally { globalThis.window = originalWindow; }
});

// Execute the actual host callbacks with controlled persistence/navigation ports.
// This keeps failure and isolation assertions independent of JSX rendering.
function hostFunction(file, name, ports) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n  }`));
  assert.ok(match, `Missing host callback ${name}`);
  return vm.runInNewContext(`(${match[0]})`, ports);
}

test("导航保存屏障等待所有写入，失败时不执行跳转且允许重试", async () => {
  let release;
  let fail = false;
  let actions = 0;
  let failures = 0;
  const order = [];
  const pending = new Promise((resolve) => { release = resolve; });
  const leave = hostFunction("../src/App.jsx", "leaveAfterSave", {
    leaveTaskRef: { current: null }, username: "alice", Event,
    flushPendingSaves: async () => { await pending; order.push("pending"); if (fail) throw new Error("quota"); },
    flushDurableInk: async (username) => { assert.equal(username, "alice"); order.push("durable"); },
    window: { dispatchEvent() {} }, reportSaveFailure() { failures += 1; },
  });
  const first = leave(async () => { actions += 1; order.push("navigate"); });
  assert.equal(actions, 0);
  assert.equal(leave(() => { actions += 100; }), first, "double-back shares one save boundary");
  release();
  assert.equal(await first, true);
  assert.deepEqual(order, ["pending", "durable", "navigate"]);
  fail = true;
  assert.equal(await leave(() => { actions += 1; }), false);
  assert.equal(actions, 1);
  assert.equal(failures, 1);
  fail = false;
  assert.equal(await leave(() => { actions += 1; }), true);
  assert.equal(actions, 2);
});

test("Reader 入口只携带身份/位置/题窗上下文，不写答案或推进流程", () => {
  let saved = 0;
  let context;
  const open = hostFunction("../src/CustomDeepReader.jsx", "openLongSentenceTraining", {
    onOpenLongSentence(value) { context = value; },
    saveReadingPosition() { saved += 1; },
    loadJson: () => ({ anchorId: "deep-translation", offset: 27 }),
    positionKey: (id) => id, reviewPositionKey: (id) => id,
    reviewActive: false, activeReviewTaskKey: "", reviewTaskKey: "",
    resource: { id: "resource-A" }, passage: { id: "passage-B" },
    readerPanelsRef: { current: { getPanel: () => "questions" } },
    flowRef: { current: { currentStage: "deep-translation" } },
    drawerFocusQuestionId: 23, topAreaCollapsed: false, activeStage: "deep-translation",
    window: { scrollY: 321 },
  });
  open();
  assert.equal(saved, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    resourceId: "resource-A", passageId: "passage-B", readingStage: "deep-translation",
    questionId: 23, drawerWasOpen: true, panel: "questions", topAreaCollapsed: false,
    anchorId: "deep-translation", offset: 27, scrollY: 321, reviewTaskKey: "",
  });
});

test("长难句返回先保存：Session 退到列表，列表再返回 Reader", async () => {
  const session = { current: "session-1" };
  const events = [];
  const ports = {
    longSentenceSessionIdRef: session, longSentenceReaderOriginRef: { current: { resource: { id: "r" } } },
    setLongSentenceSessionId(value) { session.current = value; events.push(["session", value]); },
    longSentenceHostHash,
    window: { history: { state: null, replaceState(_state, _title, hash) { events.push(["hash", hash]); } } },
    leaveAfterSave: async (action) => { events.push(["saved"]); return action(); },
    returnToLongSentenceReader(saved) { assert.equal(saved, true); events.push(["reader"]); },
    goBack() { events.push(["home"]); },
  };
  const close = hostFunction("../src/App.jsx", "closeLongSentenceSession", ports);
  ports.closeLongSentenceSession = close;
  await close();
  assert.deepEqual(events, [["saved"], ["session", ""], ["hash", "#/long-sentence"]]);
  await close();
  assert.deepEqual(events.slice(-2), [["saved"], ["reader"]]);
});

test("原句复习复用已有 Sentence Recheck 并在任务写入失败时禁止跳转", async () => {
  let ok = true;
  const events = [];
  const source = { resourceId: "r", passageId: "p", sentenceKey: "p1-s2" };
  const start = hostFunction("../src/App.jsx", "startLongSentenceOriginalReview", {
    leaveAfterSave: async (action) => { events.push("saved"); return action(); },
    ensureSentenceRecheckTask(args) {
      assert.deepEqual(JSON.parse(JSON.stringify(args)), { resourceId: "r", passageId: "p", sentenceKeys: ["p1-s2"] });
      events.push("task"); return { ok, task: ok ? { taskKey: "review-r-p" } : null, error: "quota" };
    },
    startReview: async (task) => { assert.equal(task.taskKey, "review-r-p"); events.push("reader"); return true; },
  });
  await start(source);
  assert.deepEqual(events, ["saved", "task", "reader"]);
  ok = false;
  await assert.rejects(start(source), /quota/);
  assert.deepEqual(events.slice(3), ["saved", "task"]);
});

test("重启后按已保存 origin 恢复正确精读资料/题窗/位置，不写 readingFlow", async () => {
  const context = {
    resourceId: "official-2023", passageId: "passage-2", readingStage: "deep-translation",
    questionId: 22, drawerWasOpen: true, panel: "questions", scrollY: 840,
  };
  const resource = { id: context.resourceId, kind: "official" };
  const restored = {};
  const ports = {
    longSentenceOriginRef: { current: null }, longSentenceReaderOriginRef: { current: null },
    postgraduateResources: [resource],
    listCustomPdfs: async () => { throw new Error("official origin must not read custom files"); },
    readingHostHash,
    leaveAfterSave: async (action) => action(),
    setLongSentenceOrigin(value) { restored.origin = value; },
    setActiveResource(value) { restored.resource = value; },
    setReviewTaskKey(value) { restored.review = value; },
    setReaderOptions(value) { restored.options = value; },
    setNav(value) { restored.nav = value; },
    window: { location: { pathname: "/", search: "" }, history: {
      state: null, replaceState(_state, _title, hash) { restored.hash = hash; },
    } },
    goBack() { throw new Error("origin must restore Reader"); },
  };
  const restore = hostFunction("../src/App.jsx", "returnToLongSentenceReader", ports);
  ports.returnToLongSentenceReader = restore;
  await restore(context);
  assert.equal(restored.resource, resource);
  assert.equal(restored.options.restoreContext, context);
  assert.equal(restored.origin, context);
  assert.equal(restored.nav.view, "reader");
  assert.equal(restored.review, "");
  assert.equal(restored.hash, "#/reading/library");
  await assert.rejects(restore({ ...context, resourceId: "removed-resource" }), /official origin must not read custom files/);
  assert.equal(restored.resource, resource, "failed resolution leaves the mounted target unchanged");
});

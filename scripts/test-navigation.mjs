import test from "node:test";
import assert from "node:assert/strict";
import {
  examHostHash,
  examRouteFromHost,
  isNavGroup,
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

test("一级导航固定为 首页/阅读(分组)/写作/词库/筛查/背诵/复习", () => {
  assert.deepEqual(
    PRIMARY_NAV.map((item) => item.label),
    ["首页", "阅读", "写作", "词库", "筛查", "背诵", "复习"],
  );
  assert.ok(!PRIMARY_NAV.some((item) => item.label === "更多"));
  assert.ok(!PRIMARY_NAV.some((item) => item.label === "学习" || item.label === "学习单词"));
  assert.equal(new Set(PRIMARY_NAV.map((item) => item.id)).size, PRIMARY_NAV.length);
});

test("阅读是分组标题，不直接导航；精读/完形/模拟是叶子", () => {
  const group = PRIMARY_NAV.find((item) => item.id === "reading-group");
  assert.equal(group.label, "阅读");
  assert.ok(isNavGroup(group));
  assert.ok(!group.view, "分组本身不可点击导航");
  assert.deepEqual(group.children.map((item) => item.label), ["精读", "完形", "模拟"]);
  assert.deepEqual(READING_NAV.map((item) => item.view), ["library", "cloze-library", "exam-library"]);
  assert.equal(READING_NAV[2].id, "exam");
  assert.equal(READING_NAV[2].icon, "exam");
  for (const child of group.children) {
    assert.ok(child.view, "叶子必须有 view");
    assert.ok(!isNavGroup(child));
  }
});

test("叶子列表包含精读/完形/模拟/写作，共 9 项，且不包含分组", () => {
  const leaves = navLeaves(PRIMARY_NAV);
  const labels = leaves.map((item) => item.label);
  assert.ok(labels.includes("精读"));
  assert.ok(labels.includes("完形"));
  assert.ok(labels.includes("模拟"));
  assert.ok(labels.includes("写作"));
  assert.ok(!labels.includes("阅读"));
  assert.ok(labels.includes("首页"));
  assert.ok(labels.includes("词库"));
  assert.equal(leaves.length, 9);
  assert.ok(leaves.some((item) => item.id === "exam" && item.view === "exam-library"));
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

test("X1 考试 hash 路由保留 cover/session/result identity", () => {
  const cases = [
    ["#/exam/library", { view: "exam-library" }],
    ["#/exam/history", { view: "exam-history" }],
    ["#/exam/cover/2023", { view: "exam-cover", year: 2023 }],
    ["#/exam/session/x1%3Aalice%3A1", { view: "exam-session", sessionId: "x1:alice:1" }],
    ["#/exam/result/exam-result%3Av1%3Ax1-1", { view: "exam-result", resultId: "exam-result:v1:x1-1" }],
  ];
  const originalHash = globalThis.window?.location?.hash;
  try {
    for (const [hash, expected] of cases) {
      globalThis.window = { location: { hash } };
      assert.deepEqual(examRouteFromHost(), expected);
    }
  } finally {
    globalThis.window = { location: { hash: originalHash || "" } };
  }
  assert.equal(examHostHash({ view: "exam-library" }), "#/exam/library");
  assert.equal(examHostHash({ view: "exam-history" }), "#/exam/history");
  assert.equal(examHostHash({ view: "exam-cover", year: 2007 }), "#/exam/cover/2007");
  assert.equal(examHostHash({ view: "exam-session", sessionId: "x1:alice:1" }), "#/exam/session/x1%3Aalice%3A1");
  assert.equal(examHostHash({ view: "exam-result", resultId: "exam-result:v1:x1-1" }), "#/exam/result/exam-result%3Av1%3Ax1-1");
});

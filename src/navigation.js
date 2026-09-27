/**
 * Single navigation source of truth for the whole App. Desktop rail, tablet
 * rail and mobile bottom nav all render from PRIMARY_NAV; vocabulary pages
 * resolve through VOCABULARY_SPA_ROUTES / VOCABULARY_STATIC_PAGES.
 *
 * B 阶段：阅读成为分组标题（精读 / 完形），分组本身不导航。桌面/平板/手机
 * 共用同一数据源，路由语义一致；手机上渲染叶子项，不强行复制侧栏。
 */

export const VOCABULARY_SPA_ROUTES = new Set([
  "/dashboard",
  "/lists",
  "/screening",
  "/learning",
  "/export",
  "/confusion",
]);

export const VOCABULARY_STATIC_PAGES = {
  memorize: {
    key: "memorize",
    label: "背诵",
    icon: "learning",
    title: "背诵",
    src: "/vocabulary/memorize.html?embedded=1",
  },
  review: {
    key: "review",
    label: "复习",
    icon: "review",
    title: "复习",
    src: "/vocabulary/review.html?embedded=1",
  },
  import: {
    key: "import",
    label: "导入词库",
    icon: "import",
    title: "导入词库",
    src: "/vocabulary/import.html?embedded=1",
  },
};

export const READING_NAV = [
  { id: "reading", label: "精读", icon: "book", view: "library" },
  { id: "cloze", label: "完形", icon: "cloze", view: "cloze-library" },
  { id: "exam", label: "模拟", icon: "exam", view: "exam-library" },
];

export const PRIMARY_NAV = [
  { id: "home", label: "首页", icon: "home", view: "home" },
  { id: "reading-group", label: "阅读", kind: "group", children: READING_NAV },
  { id: "writing", label: "写作", icon: "vocabulary", view: "writing-library" },
  { id: "vocabulary-home", label: "词库", icon: "dashboard", view: "vocabulary", kind: "spa", route: "/dashboard" },
  { id: "screening", label: "筛查", icon: "screening", view: "vocabulary", kind: "spa", route: "/screening/1" },
  { id: "memorize", label: "背诵", icon: "learning", view: "vocabulary", kind: "static", page: "memorize" },
  { id: "review", label: "复习", icon: "review", view: "vocabulary", kind: "static", page: "review" },
];

export function isNavGroup(item) {
  return item?.kind === "group";
}

// 全部叶子项（分组不参与导航点击）。
export function navLeaves(nav = PRIMARY_NAV) {
  return nav.flatMap((item) => (isNavGroup(item) ? item.children : [item]));
}

export function readingNavLeaves() {
  return READING_NAV;
}

export function normalizeVocabularyRoute(route) {
  const value = String(route || "");
  if (/^\/screening(?:\/|$)/.test(value)) return "/screening";
  if (/^\/learning(?:\/|$)/.test(value)) return "/learning";
  if (/^\/export(?:\/|$)/.test(value)) return "/export";
  return value;
}

export function isVocabularyRouteActive(navRoute, currentRoute) {
  const current = String(currentRoute || "");
  if (navRoute === "/screening") {
    return current === "/screening" || current.startsWith("/screening/");
  }
  return current === navRoute;
}

export function isVocabularySpaRoute(route) {
  const value = String(route || "");
  return VOCABULARY_SPA_ROUTES.has(value)
    || /^\/screening\/\d+/.test(value)
    || /^\/learning\/[^/?#]+/.test(value)
    || /^\/export\/[^/?#]+/.test(value);
}

export function vocabularyWorkspaceFor(navItem) {
  if (navItem?.kind === "static") {
    const page = VOCABULARY_STATIC_PAGES[navItem.page];
    return page ? { kind: "static", page: page.key, src: page.src, label: page.label } : null;
  }
  if (navItem?.kind === "spa") {
    return { kind: "spa", route: navItem.route, src: `/vocabulary/index.html#${navItem.route}`, label: navItem.label };
  }
  return null;
}

// ---------------- 阅读 / 完形 hash 路由 ----------------
// 精读：     #/reading/library            （精读资料库）
// 完形列表： #/reading/cloze              （完形资料库）
// 完形训练： #/reading/cloze/<resourceId> （指定完形资料）
// 深链接/刷新后可以恢复对应页面。

export function readingRouteFromHost() {
  const match = /^#\/reading\/(library|cloze(?:\/([^/?#]+))?)$/.exec(window.location.hash);
  if (!match) return null;
  if (match[1] === "library") return { view: "library", resourceId: "" };
  if (match[2]) {
    try {
      return { view: "cloze", resourceId: decodeURIComponent(match[2]) };
    } catch {
      return null;
    }
  }
  return { view: "cloze-library", resourceId: "" };
}

export function readingHostHash(route) {
  if (route?.view === "cloze") return `#/reading/cloze/${encodeURIComponent(route.resourceId || "")}`;
  if (route?.view === "cloze-library") return "#/reading/cloze";
  return "#/reading/library";
}

// ---------------- 写作 hash 路由 ----------------
// 写作库：   #/writing
// 写作现场： #/writing/session/<sessionId>
// Stage 永远不进入 URL；刷新后由 persisted facts -> safeStage 恢复。

export function writingRouteFromHost() {
  const hash = String(window.location.hash || "");
  if (hash === "#/writing" || hash === "#/writing/") return { view: "writing-library", sessionId: "" };
  const match = /^#\/writing\/session\/([^/?#]+)$/.exec(hash);
  if (!match) return null;
  try {
    return { view: "writing-session", sessionId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function writingHostHash(route) {
  if (route?.view === "writing-session") {
    return `#/writing/session/${encodeURIComponent(route.sessionId || "")}`;
  }
  return "#/writing";
}

export function isWritingView(view) {
  return view === "writing-library" || view === "writing-session";
}

export function examRouteFromHost() {
  const match = /^#\/exam\/(library|history|cover\/([^/?#]+)|session\/([^/?#]+)|result\/([^/?#]+))$/.exec(window.location.hash);
  if (!match) return null;
  const kind = match[1];
  try {
    if (kind === "library" || kind === "history") return { view: `exam-${kind}` };
    if (kind.startsWith("cover/")) return { view: "exam-cover", year: Number(decodeURIComponent(match[2])) };
    if (kind.startsWith("session/")) return { view: "exam-session", sessionId: decodeURIComponent(match[3]) };
    return { view: "exam-result", resultId: decodeURIComponent(match[4]) };
  } catch { return null; }
}

export function examHostHash(route) {
  if (route?.view === "exam-cover") return `#/exam/cover/${encodeURIComponent(route.year || "")}`;
  if (route?.view === "exam-session") return `#/exam/session/${encodeURIComponent(route.sessionId || "")}`;
  if (route?.view === "exam-result") return `#/exam/result/${encodeURIComponent(route.resultId || "")}`;
  if (route?.view === "exam-history") return "#/exam/history";
  return "#/exam/library";
}

export function navigationBackTarget(stack = []) {
  return Array.isArray(stack) && stack.length ? stack[stack.length - 1] : "home";
}

/**
 * Decide whether the vocabulary iframe must reload its document when the
 * parent switches to `targetKind`/`targetPage`. When the child already
 * navigated itself to the target document (e.g. 背诵 -> 学习单词), rewriting
 * src races with the in-flight navigation and can leave `loaded` stuck false,
 * because the final hash change fires no iframe load event.
 */
export function shouldReloadVocabularyDocument({ targetKind, targetPage = "", currentPathname = "" }) {
  const targetPath = targetKind === "static"
    ? `/vocabulary/${targetPage}.html`
    : "/vocabulary/index.html";
  return currentPathname !== targetPath;
}

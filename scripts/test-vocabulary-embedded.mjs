import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function navigationHistory(initialHash) {
  const source = read("public/vocabulary/app-polish.js");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const responses = [];
  const sandbox = {
    history: { length: 1, back() { throw new Error("Unexpected document back"); } },
    location: { hash: initialHash },
    sessionStorage: { getItem(key) { return key === "wuliao:vocab:embedded-fresh" ? "1" : null; }, removeItem() {} },
    window: { VocabularyBridge: { respondHardwareBack(value) { responses.push(value); } } },
  };
  vm.runInNewContext(`
    ${section("const EMBEDDED_INITIAL_HISTORY_LENGTH", "let lastReportedHostRoute")}
    ${section("const sendHardwareBackResponse", "const normalizeHostRoute")}
    ${section("const trackRoute", "const routes =")}
    ${section("const currentRoute", "const updateActiveState")}
    ${section("const handleParentHardwareBack", 'window.addEventListener("message"')}
    globalThis.navigation = { trackRoute, back: handleParentHardwareBack };
  `, sandbox);
  return { ...sandbox.navigation, location: sandbox.location, responses };
}

test("vocabulary startup root redirect cannot become a hardware Back destination", () => {
  const nav = navigationHistory("#/");
  nav.location.hash = "#/dashboard";
  nav.trackRoute("/dashboard");
  nav.back();
  assert.deepEqual(nav.responses, [true]);
  assert.equal(nav.location.hash, "#/dashboard");
});

test("transient root and login hash changes do not pollute dashboard history", () => {
  const nav = navigationHistory("#/dashboard");
  nav.trackRoute("/");
  nav.trackRoute("/login");
  nav.trackRoute("/dashboard");
  nav.back();
  assert.deepEqual(nav.responses, [true]);
});

test("real vocabulary child routes still return to dashboard before exiting host", () => {
  const nav = navigationHistory("#/dashboard");
  nav.trackRoute("/screening/1");
  nav.location.hash = "#/screening/1";
  nav.back();
  assert.deepEqual(nav.responses, [false]);
  assert.equal(nav.location.hash, "/dashboard");
  nav.trackRoute("/dashboard");
  nav.back();
  assert.deepEqual(nav.responses, [false, true]);
});

function reviewHelpers() {
  const source = read("public/vocabulary/review.js");
  const numericStart = source.indexOf("function numericWordId");
  const helperStart = source.indexOf("function normalizedMeaning");
  const helperEnd = source.indexOf("async function loadWords", helperStart);
  assert.ok(numericStart >= 0 && helperStart > numericStart && helperEnd > helperStart);
  const sandbox = {};
  vm.runInNewContext(`
    const OPTION_COUNT = 12;
    const DISTRACTOR_COUNT = OPTION_COUNT - 1;
    const DISTRACTOR_POOL_LIMIT = 96;
    const CONFUSING_DISTRACTOR_COUNT = Math.round(DISTRACTOR_COUNT * 0.64);
    const CONFUSING_SCORE_THRESHOLD = 0.28;
    ${source.slice(numericStart, helperStart)}
    ${source.slice(helperStart, helperEnd)}
    globalThis.helpers = { distractorScore, selectDistractors };
  `, sandbox);
  return sandbox.helpers;
}

test("三个静态词汇页都加载 embedded 脚本", () => {
  for (const file of ["public/vocabulary/memorize.html", "public/vocabulary/review.html", "public/vocabulary/import.html"]) {
    const html = read(file);
    assert.match(html, /embedded-vocabulary\.js/);
  }
});

test("embedded 脚本实现硬件返回与来源校验", () => {
  const script = read("public/vocabulary/embedded-vocabulary.js");
  assert.match(script, /window\.parent !== window/);
  assert.match(script, /wuliao:hardware-back/);
  assert.match(script, /atRoot/);
  assert.match(script, /event\.source === window\.parent/);
});

test("app-polish 在 embedded 模式隐藏重复导航并注入局部操作", () => {
  const script = read("public/vocabulary/app-polish.js");
  assert.match(script, /vocab-embedded/);
  assert.match(script, /embeddedVocabActions/);
  assert.match(script, /HOST_ROUTES/);
  assert.match(script, /"\/screening"/);
  assert.match(script, /normalizeHostRoute/);
  assert.match(script, /主页/);
  assert.doesNotMatch(script, /词汇总览/);
  assert.match(script, /学习单词/);
  assert.match(script, /embeddedDashboardLibrary/);
  assert.match(script, /heading\.textContent = "仪表盘"/);
  assert.match(script, /addButton\("词库"/);
  assert.doesNotMatch(script, /addButton\("返回词库"/);
});

test("dashboard 标题行样式将仪表盘与词库保持同行", () => {
  const css = read("public/vocabulary/vocabulary-redesign.css");
  assert.match(css, /\.embedded-dashboard-heading\s*\{/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(css, /#embeddedDashboardLibrary/);
});

test("自动读音由父层通过 postMessage 同步到筛查子应用", () => {
  const script = read("public/vocabulary/app-polish.js");
  assert.match(script, /wuliao:vocabulary-auto-pronounce/);
  assert.match(script, /maybeSpeakCurrentWord/);
  assert.match(script, /lastAutoSpokenWord = ""/);
});

test("从 SPA 点击静态背诵时忽略旧 iframe 迟到的 route 消息", () => {
  const app = read("src/App.jsx");
  const handlerStart = app.indexOf("function handleVocabularyRouteChange(route)");
  const handlerEnd = app.indexOf("function navigateFromShell", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /if \(vocabularyFreshStaticRef\.current\) return;/);
  const staticNavigation = app.slice(app.indexOf("function navigateFromShell"), app.indexOf("function handleStaticPageMessage"));
  assert.match(staticNavigation, /vocabularyFreshStaticRef\.current = true;/);
});

test("背诵页不再包含 autoSpeakToggle，memorize.js 不再引用它", () => {
  const html = read("public/vocabulary/memorize.html");
  const js = read("public/vocabulary/memorize.js");
  assert.doesNotMatch(html, /autoSpeakToggle/);
  assert.doesNotMatch(js, /autoSpeakToggle/);
  assert.doesNotMatch(js, /getElementById\("autoSpeakToggle"\)/);
  assert.doesNotMatch(js, /autoSpeakToggle\.addEventListener/);
});

test("复习页的下一词自动读音保留", () => {
  const html = read("public/vocabulary/review.html");
  const js = read("public/vocabulary/review.js");
  assert.match(html, /autoSpeakToggle/);
  assert.match(js, /autoSpeakToggle\.addEventListener/);
});

test("背诵页不再提供导入词库入口，import.html 返回词库且仍保留", () => {
  const memorizeHtml = read("public/vocabulary/memorize.html");
  const importHtml = read("public/vocabulary/import.html");
  assert.doesNotMatch(memorizeHtml, /href="\/vocabulary\/import\.html"/);
  assert.doesNotMatch(memorizeHtml, /导入词库/);
  assert.match(importHtml, /href="\/vocabulary\/index\.html#\/lists"/);
  assert.match(importHtml, /返回词库/);
  assert.match(importHtml, /embedded-vocabulary\.js/);
});

test("app-polish 导入词库分类链路完整：bridge API、全部设熟知、去重与幂等 guard", () => {
  const script = read("public/vocabulary/app-polish.js");
  assert.match(script, /installImportedListTools/);
  assert.match(script, /getImportedMainLists/);
  assert.match(script, /addImportedWordsToClassificationList\(list\.id, targetType\)/);
  assert.match(script, /addClassificationButton\("familiar"/);
  assert.match(script, /\\u5168\\u90e8\\u8bbe\\u719f\\u77e5/);
  assert.match(script, /data-remove-familiar-list-id/);
  assert.match(script, /embeddedToolsRoute === route/);
  assert.match(script, /document\.getElementById\(EMBEDDED_TOOLS_ID\)/);
  assert.match(script, /IMPORTED_LIST_TOOLS_RETRY_LIMIT/);
  assert.match(script, /IMPORTED_LIST_TOOLS_MIN_INTERVAL_MS/);
});

test("背词使用独立规则状态并保留朗读与保存失败恢复", () => {
  const js = read("public/vocabulary/memorize.js");
  assert.match(js, /memoryState/);
  assert.match(js, /english.tabIndex = masked \? -1 : 0/);
  assert.match(js, /createWordSaveQueue/); // Behavioral rollback coverage: test-interaction-latency.mjs.
  assert.match(js, /resetProgress/);
  assert.match(js, /pointercancel/);
});

test("背词滚动虚拟化复用重叠行，并用逻辑索引固定条纹背景", () => {
  const js = read("public/vocabulary/memorize.js");
  const css = [
    "public/vocabulary/memorize.css",
    "public/vocabulary/wuliao-theme.css",
    "public/vocabulary/deep-sea-theme.css",
    "public/vocabulary/vocabulary-redesign.css",
  ].map(read).join("\n");
  const renderStart = js.indexOf("function renderVisibleRows(force = false)");
  const renderEnd = js.indexOf("async function selectList", renderStart);
  const renderSource = js.slice(renderStart, renderEnd);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(js, /const renderedRows = new Map\(\)/);
  assert.match(renderSource, /if \(renderedRows\.has\(index\)\) continue/);
  assert.match(renderSource, /rowsLayer\.insertBefore\(row, nextRow\)/);
  assert.match(js, /index % 2 \? " is-alternate"/);
  assert.match(css, /\.word-row\.is-alternate/);
  assert.doesNotMatch(css, /\.word-row:nth-child\(even\)/);
  assert.match(css, /\.spacer,[\s\S]*\.rows-layer\s*\{\s*background:\s*var\(--vocab-paper\)/);
  assert.match(js, /viewport\.addEventListener\("scroll", \(\) => \{\s*renderVisibleRows\(\)/);
});

test("正式页面标题不再展示需求说明式副标题，必要状态与操作提示仍保留", () => {
  const memorize = read("public/vocabulary/memorize.html");
  const review = read("public/vocabulary/review.html");
  const imported = read("public/vocabulary/import.html");
  const app = read("src/App.jsx");
  const unknownWords = read("src/UnknownWordLibrary.jsx");
  const writingLibrary = read("src/writing/ui/WritingLibrary.jsx");
  assert.doesNotMatch(memorize, /每次打开，接着上次继续/);
  assert.doesNotMatch(review, /筛查三次划线的单词/);
  assert.doesNotMatch(imported, /PDF、Excel、CSV 均只在当前浏览器本地处理/);
  assert.doesNotMatch(app, /选择一套完形，完成初做、复查、订正、精析与回读/);
  assert.doesNotMatch(unknownWords, /精读与完形共用同一份陌生词库/);
  assert.doesNotMatch(writingLibrary, /从范文拆解到独立改写/);
  assert.doesNotMatch(writingLibrary, /按年份选择作文；题干与原卷图画来自本地 PDF/);
  assert.match(memorize, /当前位置自动保存/);
  assert.match(review, /id="answerHint"/);
  assert.match(imported, /Excel\/CSV 第一列填英文/);
  assert.match(imported, /id="statusText"/);
});

test("保存失败回滚读取当前记录，清除不删除历史", () => {
  const js = read("public/vocabulary/memorize.js");
  assert.match(js, /const before = state.records.get\(wordId\) \|\| \{\}/);
  assert.match(js, /createWordSaveQueue/);
  assert.doesNotMatch(js, /objectStore\(MEMORY_STORE\).delete/);
});

test("复习答错严格回到 0/3，并保留原记录元数据", () => {
  const js = read("public/vocabulary/review.js");
  assert.match(js, /store\.put\(\{\s*\.\.\.record/);
  assert.match(js, /clickCount:\s*0/);
  assert.match(js, /maskedAt:\s*record\.maskedAt/);
  assert.match(js, /maskedDates:\s*dates/);
  assert.match(js, /lastReviewDate:\s*state\.selectedDate/);
  assert.match(js, /lastReviewResult:\s*"wrong"/);
  assert.match(js, /reviewedAt:\s*now/);
  assert.match(js, /恢复为 0\/3/);
});

test("复习干扰项使用有限候选池、可注入 RNG，并维持约 60–75% 混淆项", () => {
  const js = read("public/vocabulary/review.js");
  const helpers = reviewHelpers();
  const target = { wordId: "word_1000", english: "reflect", chinese: "反射；反映；反省" };
  const confusing = [
    ["reflection", "反射；反映"],
    ["reflexion", "反射；反映"],
    ["reflective", "反射的；反映的"],
    ["refraction", "折射；反射"],
    ["refine", "改进；精炼"],
    ["refute", "反驳；驳斥"],
    ["refract", "折射；反射"],
    ["refactor", "重构；改造"],
  ].map(([english, chinese], index) => ({ wordId: `word_${1001 + index}`, english, chinese }));
  const random = [
    ["budget", "预算"],
    ["amuse", "娱乐"],
    ["distant", "遥远的"],
    ["mineral", "矿物"],
    ["surgery", "外科手术"],
    ["harvest", "收获"],
    ["obligation", "义务；责任"],
  ].map(([english, chinese], index) => ({ wordId: `word_${1010 + index}`, english, chinese }));
  const candidates = [...confusing, ...random];
  const rng = () => 0.37;
  const first = helpers.selectDistractors(target, candidates, { rng });
  const second = helpers.selectDistractors(target, candidates, { rng });
  assert.equal(first.length, 11);
  assert.deepEqual(first, second);
  const confusingCount = first.filter((candidate) => helpers.distractorScore(target, candidate) >= 0.28).length;
  assert.ok(confusingCount >= 6 && confusingCount <= 8, `混淆项数量为 ${confusingCount}`);
  assert.match(js, /DISTRACTOR_POOL_LIMIT\s*=\s*96/);
  assert.match(js, /const rng = Math\.random/);
  assert.doesNotMatch(js, /const seed = numericWordId/);
});

test("干扰项来源权重只读取已有字段，不改词汇 schema", () => {
  const helpers = reviewHelpers();
  const target = { wordId: "import:target", english: "calm", chinese: "平静", listKey: "import-list-a" };
  const sameList = { wordId: "import:same", english: "budget", chinese: "预算", listKey: "import-list-a" };
  const otherList = { wordId: "import:other", english: "budget", chinese: "预算", listKey: "import-list-b" };
  assert.ok(helpers.distractorScore(target, sameList) > helpers.distractorScore(target, otherList));
});

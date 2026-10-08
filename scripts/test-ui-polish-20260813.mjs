import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navLeaves, READING_NAV } from "../src/navigation.js";
import { buildPageWarnings, ocrPageNumbers, pageQuality } from "../src/pdfParserCore.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------- 导航 / AppShell / 设置 ----------------

test("阅读组只包含精读/完形，全部导航叶子共 9 项", () => {
  assert.deepEqual(READING_NAV.map((item) => item.label), ["精读", "完形"]);
  const leaves = navLeaves();
  assert.equal(leaves.length, 9);
  assert.ok(leaves.some((item) => item.id === "writing" && item.view === "writing-library"));
  assert.ok(!leaves.some((item) => item.id === "exam"));
});

test("rail 不再存在独立账号卡片，设置内保留账号与切换账号", () => {
  const shell = read("src/ui/AppShell.jsx");
  assert.ok(!shell.includes("ds-account"));
  assert.ok(!shell.includes("ds-mobile-account"));
  assert.ok(shell.includes("账号、备份与本地信息"));
  const settings = read("src/ui/SettingsPanel.jsx");
  assert.ok(settings.includes("切换账号"));
  assert.ok(settings.indexOf("<h3>账号</h3>") < settings.indexOf("<h3>数据备份</h3>"));
});

test("底部导航 9 项：所有移动宽度保证 44px 最小列并允许横向滚动", () => {
  const css = read("src/redesign/app-shell.css");
  assert.ok(css.includes("repeat(9, minmax(44px, 1fr))"));
  assert.ok(css.includes("overflow-x: auto"));
});

// ---------------- 首页 / Planner / 资料库 ----------------

test("首页删除本地数据小字与 Quick Start，最近学习 limit 保持 3", () => {
  const app = read("src/App.jsx");
  assert.ok(!app.includes("overview-local-note"));
  assert.ok(!app.includes('className="quick-start"'));
  assert.ok(app.includes("limit: 3"));
});

test("Planner 只统一主学习 CTA，Overflow 行不新增学习按钮", () => {
  const source = read("src/StudyPlannerPanel.jsx");
  assert.ok(source.includes('return "学习";'));
  const overflowStart = source.indexOf("function PlannerOverflowRow");
  const overflowEnd = source.indexOf("function DeferredRow");
  const overflowSource = source.slice(overflowStart, overflowEnd);
  assert.ok(!overflowSource.includes("primary-button"), "Overflow 行不得新增学习 CTA");
  assert.ok(overflowSource.includes("今天暂不安排"));
  assert.ok(overflowSource.includes("跳过本次"));
});

test("资料库卡片列数收敛为单一视口规则：4/2/1 且删除旧 container rules", () => {
  const css = read("src/redesign/pages.css");
  assert.ok(!css.includes("@container library-main"));
  assert.ok(css.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"));
  assert.ok(css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
});

// ---------------- OCR false-positive 修复 ----------------

test("OCR Case A：长文高 junk 但 needsOcr=false 不生成 OCR 异常 warning", () => {
  const quality = pageQuality([{ pageNumber: 1, text: `${"A".repeat(300)}${"★".repeat(300)}` }]);
  assert.equal(quality[0].needsOcr, false);
  assert.ok(quality[0].junkRatio > 0.45);
  assert.deepEqual(buildPageWarnings(quality, false), []);
  assert.deepEqual(buildPageWarnings(quality, true), []);
});

test("OCR Case B：短文本高 junk needsOcr=true 仍生成 warning", () => {
  const quality = pageQuality([{ pageNumber: 2, text: `${"A".repeat(50)}${"★".repeat(50)}` }]);
  assert.equal(quality[0].needsOcr, true);
  assert.match(buildPageWarnings(quality, false)[0], /未启用 OCR/);
  assert.match(buildPageWarnings(quality, true)[0], /已尝试 OCR 修正/);
});

test("OCR Case C：无文字层 warning 保留；official ocrPolicy disabled 不触发 OCR", () => {
  const quality = pageQuality([{ pageNumber: 3, text: "" }]);
  assert.match(buildPageWarnings(quality, false)[0], /没有可用的文字层/);
  assert.deepEqual(ocrPageNumbers(quality, "disabled"), []);
  assert.equal(ocrPageNumbers(quality, "disabled").length, 0);
});

// ---------------- 共享工具栏 / 拖拽 / 套索 / 字号 ----------------

test("collapsed pill 拖拽 contract：pointer capture、6px 阈值、translate3d、点击抑制、阶段 hint 随拖拽隐藏", () => {
  const toolbar = read("src/ui/AnnotationToolbar.jsx");
  assert.ok(toolbar.includes("setPointerCapture"));
  assert.ok(toolbar.includes("translate3d"));
  assert.ok(toolbar.includes("Math.hypot(dx, dy) < 6"));
  assert.ok(toolbar.includes("suppressPillClickRef"));
  assert.ok(toolbar.includes("pillDragging"));
  assert.ok(toolbar.includes("!pillDragging && <span className=\"toolbar-stage-hint\""));
  assert.ok(toolbar.includes("touchAction: \"none\""));
});

test("Lasso 虚线：共享渲染器使用 setLineDash([7,5]) 的显式 lasso 分支", () => {
  const tools = read("src/annotationTools.js");
  assert.ok(tools.includes("context.setLineDash([7, 5])"));
  assert.ok(tools.includes("} else if (tool === \"lasso\") {"));
});

test("Toolbar 长按提示为临时套索，不再是临时橡皮", () => {
  const toolbar = read("src/ui/AnnotationToolbar.jsx");
  assert.ok(toolbar.includes("长按临时套索"));
  assert.ok(!toolbar.includes("长按临时橡皮"));
});

test("PdfReader 与 CustomDeepReader 均消费共享 AnnotationToolbar（PdfReader 按现有架构验证）", () => {
  const pdf = read("src/PdfReader.jsx");
  assert.ok(pdf.includes("AnnotationToolbar"));
  const custom = read("src/CustomDeepReader.jsx");
  assert.ok(custom.includes("AnnotationToolbar"));
});

test("精读和完形 Toolbar 行高统一 42px reserved row，44px 伪元素命中区共享", () => {
  const reader = read("src/redesign/reader.css");
  assert.ok(reader.includes(".custom-workbook-page,"));
  assert.ok(!reader.includes(".exam-session"));
  assert.ok(reader.includes("--reader-toolbar-height: 42px"));
  assert.ok(!reader.includes("--reader-toolbar-height: 44px"));
  assert.ok(!reader.includes("--reader-toolbar-height: 51px"), "删除 51px 旧行高");
  assert.ok(reader.includes("button::before"));
  assert.ok(reader.includes("inset: -2px"));
  assert.ok(reader.includes("scrollbar-width: none"), "三宿主 Toolbar 隐藏滚动条，避免行高差异");
  assert.ok(reader.includes("tablet-ink-toolbar::-webkit-scrollbar"));
  const pages = read("src/redesign/pages.css");
  assert.ok(!pages.includes("--reader-toolbar-height: 42px"), "完形宿主不再重复声明行高");
});

test("品牌折叠属于 AppShell 状态：任意 workspace 页面切换为共享导航图标 rail，无 home 特判", () => {
  const shell = read("src/ui/AppShell.jsx");
  assert.ok(shell.includes("sidebarCollapsed"));
  assert.ok(shell.includes("ds-shell-collapsed"));
  assert.ok(!shell.includes("ds-sidebar-restore"));
  assert.ok(shell.includes("setSidebarCollapsed((collapsed) => !collapsed)"));
  assert.ok(!shell.includes('activeView !== "home"'));
  assert.ok(!shell.includes('activeView === "home"'));
  assert.ok(shell.includes('sidebarCollapsed ? "展开侧栏" : "收起侧栏"'));
  assert.ok(!shell.includes('aria-label="返回首页"'));
  assert.ok(!/useEffect\(\(\) => \{[\s\S]*?setSidebarCollapsed[\s\S]*?\}, \[activeView\]\)/.test(shell), "不得恢复按 activeView 特判的折叠 useEffect");
  const css = read("src/redesign/app-shell.css");
  assert.ok(css.includes(".ds-shell-collapsed .ds-rail"));
  assert.ok(css.includes("--ds-collapsed-rail-width: 64px"));
  assert.ok(css.includes(".ds-shell-collapsed .ds-nav > button"));
  assert.ok(css.includes(".ds-nav > button > span { display: none; }"));
  assert.ok(!css.includes(".ds-sidebar-restore"));
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.ok(mobileBlock.includes(".ds-shell-collapsed { --ds-rail-width: 0px; }"));
});

test("阶段栏与完形/Exam 状态主标签统一 14px（--ds-text-md）", () => {
  const reader = read("src/redesign/reader.css");
  assert.ok(reader.includes(".reader-page > .stage-nav button"));
  assert.ok(reader.includes("font-size: var(--ds-text-md, 14px)"));
  const pages = read("src/redesign/pages.css");
  assert.ok(pages.includes(".cloze-reader-stage { color: var(--ds-ink-soft); font: 600 14px var(--ds-sans); }"));
  assert.ok(pages.includes(".cloze-timer-bar {"));
  assert.ok(pages.includes("font-size: 14px;"));
});

// ---------------- 完形题窗收起 ----------------

test("完形题窗复用精读侧栏与正文整体缩放，保留退场内容", () => {
  const cloze = read("src/ClozeReader.jsx");
  assert.ok(cloze.includes("panel-collapsed"));
  assert.ok(cloze.includes("cloze-panel-expand-fab"));
  assert.ok(cloze.includes("收起题窗"));
  const css = read("src/redesign/pages.css");
  assert.ok(cloze.includes("useReaderPaperLayout(readerPageRef"));
  assert.ok(cloze.includes("cloze-question-panel reader-side-panel"));
  assert.ok(!css.includes("grid-template-columns: minmax(0, 64fr) minmax(0, 36fr)"));
  const reader = read("src/redesign/reader.css");
  assert.ok(reader.includes(":is(.custom-workbook-page, .cloze-reader-page) .reader-side-panel"));
  assert.ok(reader.includes("transform: translateX(calc(100% + 24px))"));
  assert.ok(reader.includes('[data-motion-state="closed"] { visibility: hidden; }'));
  assert.ok(css.includes(".cloze-panel-expand-fab"));
});

test("完形冻结提示按官方答案区分文案", () => {
  const cloze = read("src/ClozeReader.jsx");
  assert.ok(cloze.includes("function ReadOnlyAnswerNotice({ hasOfficial })"));
  assert.ok(cloze.includes("避免订正阶段改写原始作答"));
  assert.ok(cloze.includes("现在请核对两次作答变化并完成统一订正"));
});

// ---------------- Exam UI ----------------


test("资料库与导航没有整卷模拟入口，写作保留原入口", () => {
  const app = read("src/App.jsx");
  const writing = read("src/writing/ui/WritingLibrary.jsx");
  const navigation = read("src/navigation.js");
  assert.doesNotMatch(app, /ExamLibrary|onOpenExam|\.\/exam\//);
  assert.doesNotMatch(navigation, /label:\s*"模拟"/);
  assert.doesNotMatch(writing, /writing-library-hero[\s\S]*?<button[^>]+back-button/);
  assert.match(writing, /浏览历年真题/);
});

test("交互动效使用统一 presence 状态与合成层属性", () => {
  const tokens = read("src/redesign/tokens.css");
  const shell = read("src/ui/AppShell.jsx");
  const shellCss = read("src/redesign/app-shell.css");
  const pdfReader = read("src/PdfReader.jsx");
  const aiWindow = read("src/AiFloatWindow.jsx");
  const motion = read("src/ui/useMotionPresence.js");
  const android = read("android/app/src/main/java/com/wuliao/english/MainActivity.java");

  assert.match(tokens, /--ds-motion-duration:\s*200ms/);
  assert.match(tokens, /--ds-motion-ease:\s*cubic-bezier\(\.2, \.8, \.2, 1\)/);
  assert.match(shell, /content\.animate\([\s\S]*?translateX/);
  assert.doesNotMatch(shellCss, /transition:\s*(?:width|margin-left|padding)/);
  assert.match(pdfReader, /data-motion-state=\{motion\.state\}/);
  assert.match(aiWindow, /motion\.present[\s\S]*?data-motion-state=\{motion\.state\}/);
  for (const state of ["opening", "open", "closing", "closed"]) assert.ok(motion.includes(`"${state}"`));
  assert.doesNotMatch(android, /enableSlowWholeDocumentDraw/);
});


// ---------------- 词库 / 筛查 ----------------

test("词库删除最近词库（稳定语义定位）与 100dvh iframe、筛查单屏规则", () => {
  const polish = read("public/vocabulary/app-polish.js");
  assert.ok(polish.includes("removeRecentLibrarySection"));
  assert.ok(polish.includes('=== "最近词库"'));
  const pages = read("src/redesign/pages.css");
  assert.ok(pages.includes("min-height: calc(100dvh - 76px)"));
  const redesign = read("public/vocabulary/vocabulary-redesign.css");
  assert.ok(redesign.includes("repeat(3, minmax(0, 1fr))"));
  assert.ok(redesign.includes("repeat(2, minmax(0, 1fr))"));
  assert.ok(redesign.includes("min-height: 44px"));
});

test("本轮回归：精读导航、无重排面板槽、背诵页覆盖 641-820px", () => {
  const reader = read("src/CustomDeepReader.jsx");
  const readerCss = read("src/styles.css");
  const readerChromeCss = read("src/redesign/reader.css");
  const memorizeCss = read("public/vocabulary/memorize.css");
  const shellCss = read("src/redesign/app-shell.css");
  const pagesCss = read("src/redesign/pages.css");
  assert.ok(reader.includes('["初做", ["deep-clean-text", "deep-first-quiz"]]'));
  assert.ok(!reader.includes("①限时读文 → ②初做与定位依据"));
  assert.ok(reader.includes("完成审题，进入初做"));
  assert.ok(reader.includes("限时初做中：原文与题目同时显示，完成初做时自动结束计时"));
  for (const obsolete of [
    "开始限时读文",
    "结束限时读文，进入第一次做题",
    "限时读文已完成",
    "完成审题，进入限时读文",
    "已经限时读完，开始做题",
  ]) {
    assert.ok(!reader.includes(obsolete), `删除旧限时读文中间步骤：${obsolete}`);
  }
  assert.doesNotMatch(readerCss, /timed-reading-active \.deep-reader-content > section:not\(#deep-clean-text\):not\(#deep-first-quiz\)/,
    "初做计时期间不得隐藏已完成阶段，否则向上划回无法查看原阶段字迹");
  assert.ok(reader.includes("function displayedStageInk"));
  assert.ok(reader.includes("const renderedStrokes = displayedStageInk()"));
  assert.doesNotMatch(readerCss, /\.reader-main\s*\{[^}]*transition:\s*padding-right/);
  assert.doesNotMatch(readerChromeCss, /transition:\s*width[^;]*margin-right/);
  assert.match(readerChromeCss, /transform-origin:\s*0 0/);
  assert.doesNotMatch(readerChromeCss, /\[data-question-panel="open"\][^{]*\{[^}]*width:/);
  assert.match(readerChromeCss, /@media \(min-width: 1100px\) and \(max-width: 1399px\)[\s\S]*?\.reader-main\.drawer-open[\s\S]*?padding-right:\s*16px/);
  assert.match(reader, /const ReaderSidePanels = forwardRef/);
  assert.doesNotMatch(reader, /deriveReaderPanelOffset/);
  assert.match(memorizeCss, /@media \(min-width: 641px\) and \(max-width: 820px\)[\s\S]*?\.spacer,[\s\S]*?min-width: 0;/);
  assert.match(memorizeCss, /@media \(min-width: 641px\) and \(max-width: 820px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 80px/);
  assert.match(memorizeCss, /@media \(min-width: 641px\) and \(max-width: 820px\)[\s\S]*?\.word-content[\s\S]*?min-width: 0;/);
  assert.match(memorizeCss, /@media \(min-width: 641px\) and \(max-width: 820px\)[\s\S]*?\.mark-button[\s\S]*?width: 80px;/);
  assert.match(shellCss, /\.ds-shell-content\s*\{[^}]*min-width:\s*0;/);
  assert.match(pagesCss, /\.ds-shell \.vocabulary-page\s*\{[^}]*min-width:\s*0;/);
  assert.match(pagesCss, /\.ds-shell \.vocabulary-frame-wrap\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/);
  assert.match(pagesCss, /\.ds-shell \.vocabulary-frame\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/);
});

test("SimplifiedExportDocument 布局契约：模块无视口 spacer、初做不带证据、笔译行数限制为 1-4", () => {
  const source = read("src/CustomDeepReader.jsx");
  const start = source.indexOf("function SimplifiedExportDocument");
  const end = source.indexOf("export default function CustomDeepReader", start);
  assert.ok(start >= 0 && end > start, "SimplifiedExportDocument 应保持可定位的独立实现");
  const documentSource = source.slice(start, end);
  assert.doesNotMatch(documentSource, /window\.innerHeight/);
  assert.doesNotMatch(documentSource, /simplified-export-module-spacer|className=[^\n]*spacer/);
  assert.equal((documentSource.match(/data-export-module/g) || []).length, 7);

  const firstStart = documentSource.indexOf("<span>3</span>");
  const redoStart = documentSource.indexOf("<span>4</span>", firstStart);
  assert.ok(firstStart >= 0 && redoStart > firstStart, "应存在初做模块与下一模块边界");
  const firstModule = documentSource.slice(firstStart, redoStart);
  assert.match(firstModule, /renderQuestions\("first",\s*\{\s*includeEvidence:\s*false\s*\}\)/);
  assert.doesNotMatch(firstModule, /simplified-export-evidence|includeEvidence:\s*true/);
  assert.match(documentSource, /Math\.max\(1,\s*Math\.min\(4,/);
  assert.match(documentSource, /Array\.from\(\{\s*length:\s*lineCountFor\(sentence\)\s*\}\)/);

  const css = read("src/styles.css");
  const printStart = css.indexOf("@media print", css.indexOf(".simplified-export-document"));
  const printEnd = css.indexOf("/* 8.5", printStart);
  const printCss = css.slice(printStart, printEnd > printStart ? printEnd : undefined);
  assert.match(printCss, /\.simplified-export-module \+ \.simplified-export-module[\s\S]*?break-before:\s*page;[\s\S]*?page-break-before:\s*always;/);
  assert.match(printCss, /\.simplified-export-question[\s\S]*?break-inside:\s*avoid/);
  assert.match(printCss, /\.simplified-export-sentence[\s\S]*?page-break-inside:\s*avoid/);
});

test("Android PDF 导出使用系统 PrintAdapter，禁止退回 viewport 截图拼页", () => {
  const source = read("android/app/src/main/java/com/wuliao/english/MainActivity.java");
  const start = source.indexOf("private static final class AndroidPdfExporter");
  const end = source.indexOf("private static final class AndroidSpeech", start);
  assert.ok(start >= 0 && end > start, "AndroidPdfExporter 应保持可定位的独立实现");
  const exporterSource = source.slice(start, end);

  assert.match(exporterSource, /createPrintDocumentAdapter/);
  assert.match(exporterSource, /PrintManager\.print|printManager\.print/);
  assert.match(exporterSource, /MediaSize\.ISO_A4\.asPortrait\(\)/);
  assert.doesNotMatch(exporterSource, /PixelCopy|PdfDocument|Bitmap|window\.innerHeight|capturePicture/);
});

test("设置面板使用独立滚动正文，PIN 覆盖层仍是 panel 的直接子项", () => {
  const settings = read("src/ui/SettingsPanel.jsx");
  const css = read("src/redesign/pages.css");
  assert.match(settings, /<div className="settings-body">/);
  assert.ok(settings.indexOf('className="settings-body"') < settings.indexOf('className="settings-pin-backdrop"'));
  assert.match(css, /\.settings-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.settings-header,[\s\S]*?flex:\s*0 0 auto;/);
});

test("资料库操作条独立 sticky 且不使用 backdrop blur；学习档案入口单独放大并复用 review 图标", () => {
  const app = read("src/App.jsx");
  const tasks = read("src/TodayTasks.jsx");
  const css = read("src/redesign/pages.css");
  assert.match(app, /className="library-action-strip"/);
  assert.match(css, /\.ds-shell \.library-action-strip\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(css, /\.ds-shell \.library-header\s*\{[\s\S]*?position:\s*static;[\s\S]*?backdrop-filter:\s*none;/);
  assert.match(tasks, /today-support-link today-archive-link/);
  assert.match(tasks, /<Icon name="review" size=\{18\} \/>/);
  assert.match(css, /\.ds-shell \.today-archive-link\s*\{[\s\S]*?min-height:\s*var\(--ds-control-md\)/);
});

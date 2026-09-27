/**
 * Build a current source-analysis package for the app.
 *
 * Outputs:
 *   output/wuliao-english-source-analysis.md
 *   output/wuliao-english-src-analysis.zip
 *
 * The archive contains text source/config/test files and a manifest. It
 * intentionally excludes secrets, generated output, caches and binary study
 * materials so it can be shared with an external analysis tool safely.
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, relative } from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, "output");
const REPORT_PATH = join(OUTPUT_DIR, "wuliao-english-source-analysis.md");
const ZIP_PATH = join(OUTPUT_DIR, "wuliao-english-src-analysis.zip");
const STAGING_PATH = join(OUTPUT_DIR, ".source-analysis-staging");

const ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "index.html",
  "README.md",
  "vite.config.ts",
  "vite.app.config.js",
  "capacitor.config.json",
  "playwright.config.mjs",
];

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".gradle",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".mjs",
  ".pro",
  ".properties",
  ".ps1",
  ".py",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const FOLDER_NAMES_TO_SKIP = new Set([
  ".android-sdk",
  ".android-toolchain",
  ".git",
  ".gradle",
  ".netlify",
  ".reasonix",
  ".wrangler",
  "build",
  "dist",
  "node_modules",
  "output",
  "test-results",
  "tmp",
]);

const EXCLUDED_RELATIVE_PATHS = new Set([
  ".env.local",
]);

const F = "```";

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function relativePath(file) {
  return normalizePath(relative(ROOT, file));
}

function hasAllowedExtension(file) {
  return CODE_EXTENSIONS.has(extname(file).toLowerCase());
}

function isExcluded(relativeFile) {
  if (EXCLUDED_RELATIVE_PATHS.has(relativeFile)) return true;
  if (relativeFile.startsWith("android/app/src/main/assets/")) return true;
  if (relativeFile.startsWith("public/vocabulary/assets/") || relativeFile.startsWith("public/vocabulary/vendor/")) return true;
  const parts = relativeFile.split("/");
  if (parts.some((part, index) => FOLDER_NAMES_TO_SKIP.has(part) && !(index === 0 && part === "build"))) return true;
  if (relativeFile.startsWith("src/generated/")) return true;
  if (relativeFile.startsWith("public/library/") && !relativeFile.endsWith("-cloze.json")) return true;
  return false;
}

async function walk(directory, predicate, result = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && FOLDER_NAMES_TO_SKIP.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, predicate, result);
    } else if (entry.isFile() && predicate(fullPath)) {
      result.push(fullPath);
    }
  }
  return result;
}

async function collectFiles() {
  const files = new Map();
  const add = (file) => {
    const relativeFile = relativePath(file);
    if (!relativeFile || isExcluded(relativeFile)) return;
    files.set(relativeFile, file);
  };

  for (const name of ROOT_FILES) {
    const file = join(ROOT, name);
    try {
      if ((await stat(file)).isFile()) add(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const treeRules = [
    ["app", hasAllowedExtension],
    ["android", (file) => /\.(gradle|java|json|kt|pro|properties|ps1|txt|xml)$/i.test(file)],
    ["build", hasAllowedExtension],
    ["docs", (file) => file.toLowerCase().endsWith(".md")],
    ["e2e", (file) => /\.(js|mjs|json|ts|tsx)$/i.test(file)],
    ["public/library", (file) => file.toLowerCase().endsWith("-cloze.json")],
    ["public/vocabulary", hasAllowedExtension],
    ["scripts", hasAllowedExtension],
    ["src", hasAllowedExtension],
    ["worker", hasAllowedExtension],
  ];

  for (const [directory, predicate] of treeRules) {
    const found = await walk(join(ROOT, directory), predicate);
    found.forEach(add);
  }

  for (const name of ["favicon.svg", "ui-icons.svg"]) {
    const file = join(ROOT, "public", name);
    try {
      if ((await stat(file)).isFile()) add(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativeFile, file]) => ({ relativeFile, file }));
}

function languageFor(relativeFile) {
  const extension = extname(relativeFile).toLowerCase();
  const languages = {
    ".css": "css",
    ".gradle": "groovy",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".kt": "kotlin",
    ".mjs": "javascript",
    ".ps1": "powershell",
    ".py": "python",
    ".sh": "bash",
    ".sql": "sql",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
  };
  return languages[extension] || "text";
}

function fenceFor(content) {
  const runs = content.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

async function readText(file, maxBytes = Infinity) {
  const buffer = await readFile(file);
  const size = buffer.byteLength;
  if (size <= maxBytes) return { text: buffer.toString("utf8"), size, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString("utf8")}\n... [报告截断；ZIP 内保留完整文件，共 ${(size / 1024).toFixed(0)} KB] ...\n`,
    size,
    truncated: true,
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function gitValue(args, fallback = "未知") {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: ROOT, maxBuffer: 1024 * 1024 });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function getGitSnapshot() {
  const [branch, head, status] = await Promise.all([
    gitValue(["branch", "--show-current"]),
    gitValue(["rev-parse", "--short", "HEAD"]),
    gitValue(["status", "--short"], ""),
  ]);
  const statusLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return {
    branch,
    head,
    statusEntries: statusLines.length,
    untrackedEntries: statusLines.filter((line) => line.startsWith("??")).length,
    modifiedEntries: statusLines.filter((line) => !line.startsWith("??")).length,
  };
}

function fileGroup(relativeFile) {
  if (relativeFile.startsWith("src/")) return "React 与业务源码（src）";
  if (relativeFile.startsWith("scripts/")) return "测试与工程脚本";
  if (relativeFile.startsWith("e2e/")) return "Playwright E2E";
  if (relativeFile.startsWith("public/")) return "公共资源与词汇子应用";
  if (relativeFile.startsWith("android/")) return "Android 原生工程";
  if (relativeFile.startsWith("app/")) return "站点入口";
  if (relativeFile.startsWith("docs/")) return "项目报告";
  if (relativeFile.startsWith("worker/")) return "站点 Worker";
  if (relativeFile.startsWith("build/")) return "构建插件";
  return "根配置";
}

function shouldIncludeInReport(relativeFile) {
  if (relativeFile === "pnpm-lock.yaml") return false;
  if (relativeFile.startsWith("scripts/fixtures/")) return false;
  if (relativeFile.startsWith("public/library/")) {
    return relativeFile === "public/library/postgraduate/2023/2023-cloze.json";
  }
  if (relativeFile === "public/vocabulary/word-assets.json") return false;
  return true;
}

function add(lines, value = "") {
  lines.push(value);
}

function addBlock(lines, value) {
  value.trim().split("\n").forEach((line) => add(lines, line));
}

function packageOverview() {
  return [
    "- **产品**：无聊英语（wuliao-english），本地优先的考研英语精读、完形填空与词汇训练 App。",
    "- **运行形态**：Vite Web 应用 + Capacitor Android；站点构建另外提供 vinext/Cloudflare Worker 入口。",
    "- **前端**：React 19、Vite 8、React StrictMode；主 App 使用自定义 `nav.view + stack + hash` 导航，没有 React Router。",
    "- **本地数据**：账号作用域 `localStorage`、多个 IndexedDB 数据库；学习事实不依赖服务端同步。",
    "- **离线能力**：PDF.js 文字层解析、Tesseract.js 英文 OCR、笔迹与学习资料留在当前设备。",
    "- **AI 边界**：DeepSeek 为浏览器直连的可选能力；启用 AI 时题目、文章片段、译文或学习思路会发送给 DeepSeek，不应将 AI 路径描述为全程离线。",
    "- **正式内置库**：2007–2023 年英语（一）阅读 Text 1–4，共 68 篇；完形为 17 年 Section I。",
  ];
}

function dataFlowText() {
  return [
    "### 4.1 精读主链",
    "```text",
    "library.js / 自定义 PDF",
    "  -> PDF.js 文字层与按页 OCR",
    "  -> deepReadingParser / examImport",
    "  -> passages / paragraphs / sentences / questions",
    "  -> CustomDeepReader + PdfReader",
    "  -> readingFlow (A: 7 阶段)",
    "  -> translationProgress (逐句笔译与复盘)",
    "  -> questionEvidence + deep-answers (答案/证据链)",
    "  -> readingReview (D+1 / 困难句复查)",
    "  -> articleLearningSummary + TodayTasks + StudyPlanner",
    "```",
    "官方资料路径使用内置 workbook 文字层并明确关闭 OCR；自定义整卷 PDF 会保存到 IndexedDB，经解析与人工修正后进入同一套学习工作台。自定义资料不生成官方答案。",
    "",
    "### 4.2 完形训练",
    "```text",
    "官方 cloze JSON / 自定义 PDF analysis.clozes",
    "  -> clozeParser.normalizeCloze",
    "  -> ClozeReader",
    "  -> clozeFlow (6 阶段)",
    "  -> clozeProgress (初做/复查/置信度/逐空精析)",
    "  -> clozeTranslation + clozeAiService",
    "  -> clozeReview (D+1 / D+7)",
    "```",
    "初做答案、复查答案和订正结果隔离保存；无官方答案资料只显示作答变化与自评数据，不计算正确率。",
    "",
    "### 4.3 AI",
    "```text",
    "页面请求事件 -> AiFloatWindow -> service/parser/cache",
    "  -> callDeepSeek (timeout + AbortSignal)",
    "  -> 结构化结果校验 / evidence 白名单 / 泄露检测",
    "  -> AI history + learning-records",
    "```",
    "R3 引入统一 App Event 与 AI Request Lifecycle；上下文切换会终止或丢弃旧请求，避免过期结果写入当前文章/题目。",
    "",
    "### 4.4 词汇子应用",
    "```text",
    "AppShell -> VocabularyWorkspace iframe -> VocabularyBridge v1",
    "  -> vocabulary-bridge-adapter.js -> legacy bundle CustomEvent",
    "  -> app-polish / embedded-vocabulary / import",
    "```",
    "词汇 iframe 的 READY、路由、返回、自动朗读、session 更新和静态页通信通过版本化协议桥接；旧 bundle 仍保留兼容监听路径。",
    "",
    "### 4.5 首页计划与备份",
    "- `LearningStateSnapshot` 复用一次学习扫描给 TodayTasks、Planner 和 Rank；事实仍来自阅读、完形、复习、词汇与 AI 学习记录。",
    "- `backup.js` 生成 `wuliao-backup` v1，导出账号作用域学习数据和自定义 PDF 附件，排除 API Key、密码 verifier、可再生缓存、telemetry、开发开关和 runtime snapshot。恢复是同账号 merge，跨 localStorage/IndexedDB 没有单一原子事务。",
  ];
}

function storageText() {
  return [
    "### localStorage（通过 `userData.js` 账号作用域化）",
    "| 领域 | 关键 key / 内容 |",
    "|---|---|",
    "| 账号 | `kaoyan_vocab_current_user`、`wuliao_auth_legacy_owner`、`wuliao:user:<encoded>:<logicalKey>` |",
    "| 精读 | `wuliao:reading-flow:*`、`reading-activity:*`、`translation-progress:*`、`question-evidence:*`、`deep-answers:*`、`deep-translation:*`、`deep-ink:*` |",
    "| 阅读复习 | `wuliao:review-task:*`、`deep-position:*`、`review-position:*` |",
    "| 完形 | `wuliao:cloze-flow:*`、`cloze-progress:*`（schema 2）、`cloze-translation:*`、`cloze-review-task:*` |",
    "| AI | `wuliao:ai:history`、`ai:learning-records`、各任务 cache、`ai:model`、`ai:button-pos`；API Key 不进入备份 |",
    "| Planner | `wuliao:study-plan:<YYYY-MM-DD>`，只保存预算/确认/defer，不复制学习完成事实 |",
    "| 词汇 | `wuliao:vocabulary:*`、`kaoyan_vocab_memorize_progress:*`、`kaoyan_vocab_daily_review:*` 等 legacy/session key |",
    "| 可观测性 | `wuliao:telemetry:*`、`wuliao:dev:mode:v1`，不进入普通备份 |",
    "",
    "### IndexedDB",
    "| 数据库 | store / 用途 |",
    "|---|---|",
    "| `wuliao-english` v3 | `custom-pdfs`（含 `username`、`fingerprint`、File/Blob、analysis）、`unknown-words`、`pdf-parse-cache` |",
    "| `KaoyanVocabDB` | `users`、`wordLists`、`screeningProgress`、`screeningSessions`、`wordRecords`、`confusionPairs` |",
    "| `KaoyanVocabMemorizeDB` v2 | `records`、`importedLists`、`importedWords` |",
    "",
    "兼容策略是读取时归一化与增量 schema；旧 localStorage 记录通过 legacy owner 逻辑归属，不进行大规模复制；IndexedDB 升级只增 store/index，不删旧数据。",
  ];
}

function moduleText() {
  return [
    "| 模块 | 入口/组件 | 核心实现 |",
    "|---|---|---|",
    "| 应用壳与导航 | `App.jsx`、`AppShell.jsx`、`BackContext` | 账号门禁、页面栈、hash、Overlay、Android Back |",
    "| 精读 | `CustomDeepReader.jsx`、`PdfReader.jsx` | 7 阶段工作台、原 PDF、题卡、笔迹 |",
    "| 精读领域逻辑 | `readingFlow.js`、`translationProgress.js`、`questionEvidence.js`、`readingReview.js` | 状态机、笔译、证据、复读任务 |",
    "| 完形 | `ClozeReader.jsx`、`ClozeReviewSession.jsx` | 6 阶段、逐空作答、订正、复习 |",
    "| 完形领域逻辑 | `clozeParser.js`、`clozeFlow.js`、`clozeProgress.js`、`clozeReview.js` | parser、状态机、事实记录、D+1/D+7 |",
    "| PDF/OCR/导入 | `pdfParser.js`、`pdfParserCore.js`、`ocrLifecycle.js`、`examImport.js` | 文字层、局部/整卷 OCR、结构化导入 |",
    "| AI | `AiFloatWindow.jsx`、`ai.js`、各 service/parser/cache | DeepSeek 请求、提示、批改、诊断、档案 |",
    "| 首页计划 | `TodayTasks.jsx`、`StudyPlannerPanel.jsx` | Snapshot、候选源、计划排序、Rank |",
    "| 词汇 | `VocabularyWorkspace.jsx`、`vocabularyBridge.js`、`public/vocabulary/*` | iframe legacy app + v1 bridge |",
    "| 数据安全 | `userData.js`、`storage.js`、`backup.js` | 账号隔离、IndexedDB、备份/恢复 |",
    "| 事件与可观测性 | `events/*`、`telemetry/*`、`developerMode.js` | AppEvent、遥测、离线 eval |",
  ];
}

function riskText() {
  return [
    "1. **必须真实人工验证的平板路径**：M-Pencil 第一笔、连续书写、临时橡皮、undo、滚动后的坐标、toolbar collapse 与 reload 仍未被真实 M-Pencil 验收。",
    "2. **发布签名**：Android 当前为 debug `1.0.53 / versionCode 54`，没有 release keystore/signing 配置。",
    "3. **版本分裂**：Web `package.json` 仍为 `0.1.0`，Android 版本为 `1.0.53/54`。",
    "4. **资料一致性**：parser integrity 为 68/68；exact-content 历史结果为 44/68，剩余 24 项已按 OCR 行合并、题目错位、噪声或 reference variant 归类，不能简单等同为 68/68 数字通过。",
    "5. **恢复边界**：localStorage 与多个 IndexedDB 没有统一原子事务；备份恢复为 merge，失败可能返回 partial failure；新账号缺少词汇数据库时可能需要先初始化词汇页。",
    "6. **异步边界**：完形加载 watchdog 尚未给 fetch 配 AbortSignal；TodayTasks 的 custom PDF 初次读取错误链仍有缺口；陌生词 AI 请求有卸载保护但网络请求本身仍可能运行到 timeout。",
    "7. **协议维护成本**：词汇新协议、旧 `postMessage` 与 CustomEvent 兼容路径并存；功能已桥接，但回归面较大。",
    "8. **数据增长与隐私**：AI learning records/收藏 history 缺少明确长期上限；AI 直连 DeepSeek 时会发送用户主动提交的学习内容。",
    "9. **资料范围**：正式内置库当前止于 2023；2024 资料尚未接入。高考/中考入口是保留入口，不是当前主实现。",
    "10. **工作区状态**：当前源码来自 dirty worktree，不等同于 HEAD；本次生成记录状态摘要，但不把未提交改动折算成稳定发布版本。",
  ];
}

async function readPackageJson(files) {
  const entry = files.find((item) => item.relativeFile === "package.json");
  if (!entry) return { scripts: {}, testScriptCount: 0, e2eSpecCount: 0 };
  try {
    const packageJson = JSON.parse(await readFile(entry.file, "utf8"));
    const scripts = packageJson.scripts || {};
    const allTests = String(scripts["test:all"] || "");
    const testScriptCount = (allTests.match(/scripts\/test-[\w-]+\.mjs/g) || []).length;
    const e2eSpecCount = files.filter((item) => /^e2e\/.*\.spec\.(js|mjs|ts|tsx)$/.test(item.relativeFile)).length;
    return { scripts, testScriptCount, e2eSpecCount };
  } catch {
    return { scripts: {}, testScriptCount: 0, e2eSpecCount: 0 };
  }
}

async function buildReport(files, git, packageInfo, archiveEntries) {
  const lines = [];
  const generatedAt = new Date().toISOString();
  const sourceFiles = files.filter((item) => item.relativeFile.startsWith("src/")).length;
  const testFiles = files.filter((item) => /^scripts\/test-.*\.mjs$/.test(item.relativeFile)).length;
  const e2eFiles = files.filter((item) => /^e2e\/.*\.spec\.(js|mjs|ts|tsx)$/.test(item.relativeFile)).length;
  const totalBytes = archiveEntries.reduce((sum, item) => sum + item.size, 0);

  add(lines, "# 无聊英语 App 当前源码分析包");
  add(lines);
  add(lines, `> 生成时间：${generatedAt}`);
  add(lines, `> 源码快照：分支 \`${git.branch}\`，HEAD \`${git.head}\`，工作区状态条目 ${git.statusEntries}（修改 ${git.modifiedEntries}，未跟踪 ${git.untrackedEntries}）。`);
  add(lines, "> 说明：本报告与 ZIP 均依据生成时的当前工作区文件，不代表只读 HEAD；本次没有自动重新执行全量测试、生产构建或设备验收。");
  add(lines, `> ZIP 原始文本文件：${archiveEntries.length} 个，约 ${(totalBytes / 1024).toFixed(0)} KB；报告对极大文件可能截断，ZIP 保留完整文本。`);
  add(lines);
  add(lines, "## 目录");
  add(lines, "1. [快照与范围](#快照与范围)");
  add(lines, "2. [项目概览](#项目概览)");
  add(lines, "3. [构建与测试](#构建与测试)");
  add(lines, "4. [架构与数据流](#架构与数据流)");
  add(lines, "5. [存储契约](#存储契约)");
  add(lines, "6. [模块地图](#模块地图)");
  add(lines, "7. [验证记录与边界](#验证记录与边界)");
  add(lines, "8. [已知风险](#已知风险)");
  add(lines, "9. [归档文件清单](#归档文件清单)");
  add(lines, "10. [源码全文](#源码全文)");
  add(lines);
  add(lines, "---");
  add(lines, "## 快照与范围");
  add(lines, `- 采集源码文件：${sourceFiles} 个；测试脚本：${testFiles} 个；Playwright spec：${e2eFiles} 个。`);
  add(lines, "- 包含：`src`、站点 `app`、Worker、构建配置、Android 文本工程、词汇 iframe 文本资源、Node 测试、E2E、R3/R4 文档与完形 JSON/fixture 示例。");
  add(lines, "- 排除：`.env.local`、API/密码等本地配置、`node_modules`、`.git`、`dist`、`output`、`tmp`、Gradle/Android 缓存、PDF/PNG/JPG/JAR/APK 等二进制资料。");
  add(lines, "- 归档根目录含 `analysis.md`（本报告）、`manifest.json`（路径/大小/SHA-256/排除规则）以及按仓库相对路径保存的文本文件。");
  add(lines);
  add(lines, "## 项目概览");
  packageOverview().forEach((line) => add(lines, line));
  add(lines);
  add(lines, "## 构建与测试");
  add(lines, "### 常用命令");
  add(lines, F + "powershell");
  add(lines, "pnpm install");
  add(lines, "pnpm dev              # Vite 开发服务器，127.0.0.1");
  add(lines, "pnpm build            # 词汇 bundle patch + Vite build + sites worker");
  add(lines, "pnpm preview          # 预览 dist");
  add(lines, "pnpm start            # scripts/start.mjs 静态服务，默认 4173");
  add(lines, "pnpm test:all         # Node 内置 node:test 全量契约/领域测试");
  add(lines, "pnpm test:e2e         # Playwright 浏览器流程");
  add(lines, "pnpm release:check    # release gate；会执行 patch/build，不是严格只读检查");
  add(lines, "pnpm android:sync     # build + cap sync android");
  add(lines, "pnpm android:apk      # 本地 JDK/SDK + Gradle，当前为 debug APK");
  add(lines, "pnpm eval:offline     # 离线 eval；AI eval 可能调用 DeepSeek 并产生费用");
  add(lines, F);
  add(lines, `当前 \`package.json\` 的 \`test:all\` 显式列出约 ${packageInfo.testScriptCount} 个测试文件，源码中收集到 ${testFiles} 个 \`scripts/test-*.mjs\`；E2E spec ${e2eFiles} 个。`);
  add(lines, "");
  add(lines, "R4 收尾报告记录的历史验证（本次生成未重跑）：`pnpm test:all` 581/581，Playwright 22/22，平板自动化 smoke 38/38，production build、release check 与 frozen lockfile 通过。历史数据必须结合当前 dirty 源码和下方风险阅读。");
  add(lines);
  add(lines, "## 架构与数据流");
  dataFlowText().forEach((line) => add(lines, line));
  add(lines);
  add(lines, "## 存储契约");
  storageText().forEach((line) => add(lines, line));
  add(lines);
  add(lines, "## 模块地图");
  moduleText().forEach((line) => add(lines, line));
  add(lines);
  add(lines, "## 验证记录与边界");
  add(lines, "- Node 测试使用 Node 原生 `node:test`，不是 Jest/Vitest；覆盖精读、完形、AI、Planner、Snapshot、事件、备份、词汇桥接、PDF/import、telemetry、R1–R4 contract。");
  add(lines, "- E2E 覆盖官方精读、七阶段恢复、完形训练/复习、词汇 bridge、AI abort、Back、刷新恢复、备份 merge/幂等与 API Key 排除；多数完整后半程使用 fixture/localStorage seed，不等于全部从零人工流程。");
  add(lines, "- 官方阅读路径关闭 OCR；PDF/OCR、Android 真机、M-Pencil、custom PDF binary roundtrip 等边界应分别看测试与 R4 文档，不能由 Node 测试数字替代。");
  add(lines, "- `eval:ai*` 是真实 AI 评估入口，可能发送数据并产生费用，不属于安全的离线测试。");
  add(lines);
  add(lines, "## 已知风险");
  riskText().forEach((line) => add(lines, line));
  add(lines);
  add(lines, "## 归档文件清单");
  add(lines, "| 分组 | 数量 | 说明 |");
  add(lines, "|---|---:|---|");
  const groups = new Map();
  for (const entry of archiveEntries) {
    const group = fileGroup(entry.relativeFile);
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  for (const [group, count] of groups) add(lines, `| ${group} | ${count} | ZIP 内为完整文本 |`);
  // Remove the accidental visual control marker if a terminal copied this file.
  lines[lines.length - 1] = lines[lines.length - 1].replace("\u001b", "");
  add(lines);
  add(lines, "```text");
  archiveEntries.forEach((entry) => add(lines, entry.relativeFile));
  add(lines, "```");
  add(lines);
  add(lines, "## 源码全文");
  add(lines, "> 下列内容为报告可读版。测试 fixture、pnpm lockfile、完形资料与超大词汇资产主要放在 ZIP；ZIP 中的文本文件完整，报告中的大文件可能按文件截断。");

  for (const entry of files) {
    if (!shouldIncludeInReport(entry.relativeFile)) continue;
    const { text, size, truncated } = await readText(entry.file, 350 * 1024);
    const fence = fenceFor(text);
    add(lines);
    add(lines, `### ${entry.relativeFile}${truncated ? `（报告截断，共 ${(size / 1024).toFixed(0)} KB）` : ""}`);
    add(lines);
    add(lines, `${fence}${languageFor(entry.relativeFile)}`);
    addBlock(lines, text);
    add(lines, fence);
  }

  return `${lines.join("\n")}\n`;
}

async function createArchive(files, git) {
  await rm(STAGING_PATH, { recursive: true, force: true });
  await mkdir(STAGING_PATH, { recursive: true });

  const archiveEntries = [];
  for (const entry of files) {
    const content = await readFile(entry.file);
    const target = join(STAGING_PATH, entry.relativeFile);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(entry.file, target);
    archiveEntries.push({
      path: entry.relativeFile,
      relativeFile: entry.relativeFile,
      size: content.byteLength,
      sha256: sha256(content),
    });
  }

  const packageInfo = await readPackageJson(files);
  const report = await buildReport(files, git, packageInfo, archiveEntries);
  await writeFile(REPORT_PATH, report, "utf8");
  await writeFile(join(STAGING_PATH, "analysis.md"), report, "utf8");

  const manifest = {
    format: "wuliao-english-source-analysis",
    version: 2,
    generatedAt: new Date().toISOString(),
    snapshot: git,
    files: archiveEntries,
    exclusions: [
      "Secrets and local environment files (.env.local)",
      "Generated output and caches (node_modules, dist, output, tmp, .gradle, .android-*)",
      "Binary study/build materials (PDF, images, JAR, APK and similar)",
      "public/library files except *-cloze.json examples",
      "src/generated runtime eval output",
    ],
    reportPath: "analysis.md",
  };
  await writeFile(join(STAGING_PATH, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await rm(ZIP_PATH, { force: true });
  try {
    await execFileAsync("tar", ["-a", "-c", "-f", ZIP_PATH, "-C", STAGING_PATH, "."], {
      cwd: ROOT,
      maxBuffer: 1024 * 1024,
    });
  } catch (tarError) {
    const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = [
      `Compress-Archive -Path ${quotePowerShell(join(STAGING_PATH, "*"))}`,
      `-DestinationPath ${quotePowerShell(ZIP_PATH)} -Force`,
    ].join(" ");
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: ROOT,
        maxBuffer: 1024 * 1024,
      });
    } catch (archiveError) {
      archiveError.cause = tarError;
      throw archiveError;
    }
  }

  await rm(STAGING_PATH, { recursive: true, force: true });
  const zipSize = (await stat(ZIP_PATH)).size;
  return { report, archiveEntries, zipSize };
}

const files = await collectFiles();
const git = await getGitSnapshot();
const result = await createArchive(files, git);
console.log(`written ${REPORT_PATH} (${(Buffer.byteLength(result.report, "utf8") / 1024).toFixed(0)} KB)`);
console.log(`written ${ZIP_PATH} (${(result.zipSize / 1024).toFixed(0)} KB, ${result.archiveEntries.length} files)`);

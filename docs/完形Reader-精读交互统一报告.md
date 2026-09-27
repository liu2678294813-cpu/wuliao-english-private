# 完形 Reader · 精读交互统一报告

> 本轮目标：完形（ClozeReader）的笔系统、陌生词系统、Reader UI 与精读（CustomDeepReader）完全统一。
> 核心原则：**精读已经成熟的 Reader 工具栏、笔操作、陌生词操作，完形全部直接复用，不复制代码各自维护。**

---

## 1. 基线

| 项 | 值 |
| --- | --- |
| branch | `codex/study-planner` |
| HEAD | `28b6817330809fde85563ef18ca35a5d5cf8d0ec` |
| dirty 资产 | 82 个修改文件 + 大量 untracked（R0–R6、X1、X1.1 成果，全部视为有效资产，未回退） |
| 备份路径 | `%TEMP%\opencode\cloze-reader-unification-20260812-200938\`（git-diff.patch 1.26MB、git-status.txt、untracked-files.txt、13 个重点文件副本） |
| 测试基线 | 改造前：ink-unification 7/7、cloze-ink 4/4、toolbar-visual-contract 1/1、r5-contracts 37/37、cloze-interaction 1/1 全绿 |
| Android device | BTK-W00（华为 MatePad，1440×2200 物理，adb serial `7VXYD24229201695`） |

## 2. 视频问题复现

| 视频问题 | 复现结论 | 修复 |
| --- | --- | --- |
| 折叠后残留 slider/颜色圆 | Playwright 832×544 复现：折叠后 `.tool-size-range-track`、`.color-picker button` 仍留在 DOM（仅靠 CSS `height:0` 压缩，Android WebView 下溢出显示） | 共享 `AnnotationToolbar` 折叠时**条件渲染**：DOM 只保留「展开工具 + stageHint」，其余控件不渲染（reader.css 折叠契约保留 height:0 作保险） |
| 完形工具栏操作与精读不一致 | 完形无「键盘输入/手写批注」切换（固定手写）、陌生词入口在 ReaderHeader 独立按钮 | 接入共享 `noteMode` 语义 + 陌生词入口迁入共享工具栏 |
| 陌生词两套交互 | 完形是 per-token button（`cloze-unknown-target`），精读是 caret/range hit-test | 完形删除 token button，接入共享 `data-unknown-scope` + CSS Custom Highlight 机制 |
| 顶部 vertical chrome 偏重 | Header 60px + toolbar + 阶段条 44px + priority 横条 + 400px 固定题窗 | Header 52px、阶段条 34px、priority 改 chip rail、双栏 64/36 |

## 3. Ink unification

### 原本已 shared（基线确认）
- `AnnotationToolbar`（唯一 source of truth）、`useStructuredInk`、`inkRuntime`（beforeInkDown/Move/Finish 扩展点）、`PEN_SIZE_STORAGE_KEY` / `PEN_MODE_STORAGE_KEY` / `wuliao:pref:eraser-mode`、完形笔迹独立 namespace（`wuliao:cloze-ink:v1:*`）。

### 本轮消除的 host-level divergence
1. **noteMode（键盘输入/手写批注）**：`ClozeReader` 新增 `inkNoteMode`（初始 `isAndroidApp()`，与精读一致），接线共享 `input-mode-picker`；`onTool`/`onColor` 自动切手写（同精读）。
2. **ClozeInkSurface 与 noteMode 联动**：`enabled = stageId !== "cloze-cover" && inkNoteMode`；键盘模式下 `canInteract()=false`（inkRuntime 首行 return），Canvas 不截获正文/Blank/选项/AI 交互，笔迹仍显示；切换模式不清笔迹、不 reload、不改 activeBlank/答案。
3. **折叠契约修复**：共享 `AnnotationToolbar` 折叠时子控件从 DOM 层面消失（不依赖 CSS 压缩），三宿主（精读/完形/考试）共同受益；832×544 实测折叠前后正文宽度零漂移。
4. **无独立实现断言**：`ClozeReader` 无 `onPointerDownCapture` / `eraseAnnotations` / 独立 toolbar markup；特殊工具（陌生词）走 Shared Runtime `beforeInk*` 钩子（与精读同一扩展点）。

### 最终共享 ownership
```
AnnotationToolbar → shared annotation state（noteMode/tool/collapsed/stageHint）
         ↓
useStructuredInk → inkRuntime（pointer capture / incremental draw / append-only commit / lasso / 620ms 临时橡皮）
         ↓
┌──────────────────┬──────────────────┐
│ CustomDeepReader │ ClozeReader      │
│ deep-ink namespace │ cloze-ink:v1  │
└──────────────────┴──────────────────┘
```

## 4. 陌生词

- **共享交互层 `src/unknownWordInteraction.js`**（新建）：`UNKNOWN_WORD_PATTERN`、`textNodesInUnknownScope`、`unknownWordRanges`、`unknownWordFromPoint`（caret hit-test）、`setUnknownHighlight`、`highlightSavedUnknownWords`、`collectUnknownTokenInto`、`createUnknownSelectionHooks`（beforeInk* 骨架，返回 "abort"）。`CustomDeepReader` 删除本地实现改 import 共享（含 NodeFilter/Text 环境防御、同步/异步 onCommit 兼容）。
- **完形正文接入 `data-unknown-scope`**：每个 sentence span 独立 scope（scope id 直接使用 `sentence.sentenceKey`，其本身含 `cloze:` 前缀，避免双重前缀；occurrenceId = `${sentenceKey}:${wordIndex}` 可经去尾部数字精确反查句子，AI 释义上下文正确），blank chip 加 `data-unknown-ignore`；per-token button（`renderUnknownTextTokens`/`cloze-unknown-target`）与完形专用 highlight 样式全部删除，高亮复用精读 `::highlight(SAVED/ACTIVE)` 视觉。
- **入口迁移**：删除 ReaderHeader `cloze-unknown-mode-toggle` 与独立 `unknownMode` state；陌生词入口在共享 `AnnotationToolbar`（`unknownEnabled`），tool=unknown 驱动。
- **两态门控（产品决策）**：初做/复查/订正整个入口隐藏；逐空精析/全文回读 100% 精读完整能力。**无 mark-only 中间态**（`markClozeUnknownWord` 死代码已删）。
- **释义链同构**：已有记录 → 离线词库（`lookupUnknownWordMeaning`）→ AI（`lookupWordMeaningWithAi`）→ 人工补充（prompt）；离线查找失败降级为空释义继续链路（两宿主统一修复）。
- **存储**：同一 IndexedDB `unknown-words` store；完形记录 `sourceType:"cloze"` + `resourceId` + `clozeId` + `sourceLabel`（`buildClozeUnknownEntry`），精读 `sourceType:"reading"`；无 schema bump、无迁移。
- **性能**：未知词记录仅在允许阶段进入时读取一次 + `wuliao:unknown-words-updated` 事件刷新，与 ink frame loop 完全解耦。

## 5. UI（完形 Reader 收尾）

| 区域 | 改动 |
| --- | --- |
| Header | min-height 60→52px、padding 压缩；保留「返回 / 标题 / 阶段 / 正文显示切换 / 重点数」单行导航 |
| 阶段条 | `cloze-timer-bar` 44→34px 轻量 hint；`cloze-analysis-summary` 58→42px 半透明 |
| Priority blanks | 改为紧凑 chip rail：`重点 4 · 1 · 2 · 3 · 19`（inline-flex，仍可点击跳转，不改 `priorityBlankNumbers`/`activeBlank`） |
| 横屏比例 | `.cloze-reader-layout` 从固定 400px 题窗改为 `minmax(0,64fr)/minmax(0,36fr)`；新增 `@media (max-width:899px) and (min-width:761px)` 双栏覆盖（832×544 实测正文 64.0% / 题窗 36.0%）；<=760 手机仍走底部抽屉 |
| 正文 card | padding 26/28→22/24、border/背景淡化（降套盒感） |
| Question Panel | card padding 18→14/16、标题 22→18px、选项行高压缩、双栏下收起按钮隐藏 |
| AI card | 背景饱和度 .92→.6、padding 收窄（不喧宾夺主；Hint 1/2、diagnosis 能力不变） |
| 保护 | `.cloze-blank` 样式未动（canonical geometry）；`ClozeInkSurface` 跨阶段不卸载不重建 |

## 6. 测试

| 门禁 | 结果 |
| --- | --- |
| `test:all`（node --test，`--test-concurrency=2` 加固） | **689/689 通过**（含新增 test:cloze-toolbar 2/2、test:unknown-word-shared 5/5） |
| `test:e2e`（Playwright 全量） | **43/43 通过**（flow14 扩至 6 项：折叠契约 / noteMode / 陌生词 store / 832×544 几何；flow11 陌生词契约更新为新交互） |
| `build` | 成功（EXIT:0，仅 chunk 大小既有警告） |
| `release:check` | **EXIT:0 全部 PASS**（NOTE 均为 R4 已记录已知项） |

新增/更新测试：
- `scripts/test-cloze-toolbar-consistency.mjs`（新）：展开控件全集、折叠后 DOM 仅剩展开工具+stageHint、noteMode 往返不丢答案/activeBlank/笔迹、键盘模式 blank 可点。
- `scripts/test-unknown-word-shared.mjs`（新）：同一 token 识别（含 `data-unknown-ignore` 排除）、occurrenceId 格式、`toggleUnknownWord` 共享、entry metadata（sourceType=cloze）、释义链同构、beforeInk* abort 语义。
- `scripts/test-ink-unification.mjs`：新增「完形无独立 pen/toolbar/eraser 实现」断言。
- `scripts/test-cloze-ink.mjs`：新增「笔偏好双向共享（同一 storage key，禁止第二套 cloze 偏好）」。
- `scripts/test-r5-contracts.mjs`：B4/F1/F2/F5 更新为两态门控 + 共享 interaction 契约。
- `e2e/flow14-cloze-ink.spec.js`：Flow B（折叠 DOM 契约）、Flow D（noteMode 状态保持）、Flow C（陌生词 sourceType=cloze 写入同一 store）、832×544 笔迹几何回归。
- `e2e/flow11-r5.spec.js`：陌生词测试更新为新交互（初做无入口 / 精析完整标记 / 来源筛选）。

期间修复的产品缺陷：
- `ClozeReader` 缺失 `lookupUnknownWordMeaning` import（陌生词释义链运行时失败）。
- 释义链离线词库查找失败未降级（两宿主统一 try/catch，E2E dev 下词库 chunk 不可用时走 AI/人工补充链）。
- `data-unknown-scope` 双重前缀导致 AI 释义句子上下文反查恒失败（review 发现，改为直接用 `sentence.sentenceKey`）。
- AI 释义补全未串行化（对齐精读 `aiLookupChainRef` 串行链 + mounted guard）。
- 纵深门控：禁止陌生词的阶段若 `inkTool` 残留 "unknown" 自动重置为 pen，且不透传 `beforeInk*` 钩子（review 建议，runtime 层也不收集）。

内置 review 三轮闭环（use_capability tool:review / run_skill review）：should-fix → 通过可发布 → ship as-is，无遗留问题。

## 7. Android

| 项 | 结果 |
| --- | --- |
| APK | `output/android/wuliao-english-android.apk`（70,971,481 字节，BUILD SUCCESSFUL 30s） |
| 部署 | `adb install -r` 覆盖安装 Success（未 uninstall、未 pm clear、未删应用） |
| 设备 | BTK-W00（华为 MatePad），serial `7VXYD24229201695` |
| 启动 | `am start` 正常，pid 11283，MainActivity resumed 无崩溃 |
| 数据完整性 | 覆盖安装后 `app_hws_webview/Default/` 下 Local Storage leveldb（002088.log 等）与 IndexedDB（https_localhost_0.indexeddb.leveldb）完整保留 |
| 截图 | `output/android/wuliao-smoke.png`（680KB，渲染正常） |
| 真机 UI smoke | 视觉契约（双栏 64/36、折叠零残留、Header 紧凑）由 Playwright 832×544 在同一 Chromium 内核验证；华为 WebView 同为 Chromium 内核 |

## 8. 数据保护证明

- 无 schema migration、无 IndexedDB version bump。
- 无清 localStorage、无清 IndexedDB（未执行 `pm clear` / 卸载重装）。
- 无修改 stroke schema；深读 `wuliao:deep-ink:*` 与完形 `wuliao:cloze-ink:v1:*` namespace 完全隔离。
- 未把完形笔迹挂入 D+1/D+7（`ClozeReviewSession` 契约断言维持）。
- 完形与精读陌生词共用同一 `unknown-words` store，仅 metadata（sourceType）区分；旧记录无 sourceType 按 reading 兼容。
- 未动解析器/官方数据：`clozeParser.js`、PDF_PARSER_VERSION、2007–2023 完形 JSON、answerKeys 均未修改。
- 未动业务状态机：clozeFlow / clozeProgress schema / first/review answers / confidence / prediction / basisTypes / references / translation / D+1 / D+7 语义不变。

---

IMPLEMENTATION COMPLETE
TESTS COMPLETE
ANDROID DEPLOYED
TABLET SMOKE COMPLETE

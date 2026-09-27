# 精读逐句笔译手写识别：实施与验收记录

日期：2026-09-21。项目：`D:\codex库\无聊英语`。

## 已交付的操作

每句「我的笔译」操作区新增 **识别**：原样手写 → 识别 → 弹窗对照笔迹校对文字 → 确认保存 → 按原流程完成笔译并手动点击 AI 批改。

- 弹窗展示本句横线区笔迹，支持修改结果、重试、取消及手动录入；打开时不自动聚焦输入框。
- 确认前不写入译文、不自动批改，也不自动完成笔译。再次识别先产生候选稿；取消保留已有文字。
- 确认后的文字通过「查看文字」维护，不叠加在已有手写笔迹上。新增按钮不占文档流，句子与横线区高度保持不变。
- 原有手动补录入口仍按原流程工作；核对只读阶段只能查看已有文字。
- 继续书写后再次批改或完成订正，会要求重新识别或校对；修改已订正文字会按原规则使订正状态失效。
- 空白、全部擦除、缺少视觉配置、网络失败、超时、返回格式错误和保存失败都有提示。保存失败保留弹窗草稿。

## 接入方式与数据边界

1. `translationOcrImage.js` 只读取原笔画；对当前句创建独立画布，按顺序重放笔迹和普通橡皮，裁掉横线、英文、按钮及其他句子。擦除完成后合成白底 PNG。复用原坐标投影与绘制函数，不更改共享引擎。
2. `translationOcrAi.js` 使用现有 Vision 配置、凭据和 `callAi`，兼容 Chat Completions 与 Responses；图片以 high detail 发送，超时 45 秒。请求只含裁剪后的笔迹图片和转录约束，不发送英文原句作为识别线索。
3. `TranslationOcrModal.jsx` 管理取消信号、同弹窗请求去重、候选稿与确认操作。结果返回和保存前核验账号、文章、句子、区域连接状态和笔迹指纹。离开文章、关闭弹窗或实际账号切换导致卸载时取消请求；迟到结果不能写入新目标。
4. `translationOcrStorage.js` 将文字、输入来源及笔迹指纹按账号、资源、篇章、段落和句子保存。验证写入回读，失败尝试恢复旧值；不缓存 PNG 到学习数据。
5. `CustomDeepReader.jsx` 只增加上述接入、逐句入口、旧数据兼容和批改前核验。译文键改为传入 `resource.id` / `passage.id`，修复 `[object Object]` 导致的文章间冲突。

### 旧文字的兼容处理

- 正确归属的文字优先。
- 无法确定归属的旧键保留原文，只在弹窗呈现「待确认旧译文」；必须主动选择并确认保存后才能绑定当前句。
- 绑定记录阻止同一份旧文字被再次认领到另一篇文章。
- 清空页面删除本句新译文及 OCR 信息，并保留旧文字已处理的标记，防止清空后旧内容再次自动出现。
- 备份继续使用现有备份格式；确认文字、指纹、旧文认领记录及清空标记都纳入同账号备份，不引入新的数据库。

## 保护原有改动与笔迹

开工时工作区已有多项未提交修改，均保留；本次没有提交、推送或回退这些修改。

原文件副本、开工状态和差异保存在 [留档目录](D:/codex库/无聊英语/output/translation-ocr-20260921)。`before.patch` 是开工前已有改动的记录，不能当作本次功能补丁使用。

以下文件与开工副本 SHA-256 完全一致：

- `src/annotationTools.js`
- `src/deepInkGeometry.js`
- `src/inkEngine.js`
- `src/ink/inkRuntime.js`
- `src/ink/inkSnapshot.js`
- `src/styles.css`
- `src/TranslationTranscriptionModal.jsx`
- `android/app/src/main/java/com/wuliao/english/MainActivity.java`

详细比对见 [preserved-files.json](D:/codex库/无聊英语/output/translation-ocr-20260921/preserved-files.json)。因此此次没有修改笔形、采样、压力计算、抬笔交接、Android 输入或原补录弹窗实现。指纹和图片生成只发生于识别、确认及批改等操作，不进入笔尖移动处理。

## 已执行的验证

| 验证 | 结果与范围 |
|---|---|
| 全量 Node 测试 | 1172 / 1172 通过，无跳过；包含 OCR 初始 14 项及现有精读、笔迹、保存、备份、账号、词汇等测试 |
| OCR 专项最终测试 | 15 / 15 通过；在全量测试后新增并通过 1 项真实备份函数的导出、解析、恢复测试 |
| 浏览器 | 15 / 15 通过：首轮 13 项，加文章切换和订正失效 2 项；API 采用明确的模拟响应 |
| 原笔迹抬笔回归 | 上述浏览器场景含 6 项既有像素检查：缩放、非整数原点、纵向、分块接缝、缩放接缝及题目面板 |
| 实际 Canvas 导出 | 检查擦除后重写、全擦空白、区域外排除、缩放及 deep-region-v2 坐标；原始数据未改变 |
| Android 独立测试包 | 华为 BTK-W00；734 条原笔画复制到独立账号，识别确认前后数据相等、横线区高度一致；无自动键盘；续写、长按套索删除、撤销及刷新恢复通过 |
| Web 构建 | 通过；仍有原有大 bundle / PDF 导入相关构建提示 |
| Android 构建 | 独立 QA 包及正式包名的候选 APK 均构建成功 |

浏览器另覆盖：空白不请求；取消不保存；网络失败保留旧文；写入失败保留草稿；识别中笔迹改变和账号变化拒绝旧结果；文章切换不串句；旧文明确绑定及清空不复活；390px 窄屏按钮不重叠；确认后手动发起批改。

验证命令（在项目目录执行）：

```powershell
corepack pnpm test:all
corepack pnpm test:translation-ocr
corepack pnpm exec playwright test --config e2e/translation-ocr.config.mjs
corepack pnpm build
node scripts/translation-ocr-device-qa.mjs
```

设备脚本仅清理固定的 `com.wuliao.english.translationocrqa` 测试应用；需要本次 QA APK 和留档笔迹样本。正式应用没有被测试脚本清空或升级。

日志：[全量测试](D:/codex库/无聊英语/output/translation-ocr-20260921/all-tests-final.log)、[OCR 专项](D:/codex库/无聊英语/output/translation-ocr-20260921/unit-ocr-final.log)、[浏览器 13 项](D:/codex库/无聊英语/output/translation-ocr-20260921/browser-final.log)、[浏览器补充 2 项](D:/codex库/无聊英语/output/translation-ocr-20260921/browser-extra.log)、[设备结果](D:/codex库/无聊英语/output/translation-ocr-20260921/device/result.json)。

## 真实识别质量与尚未完成的人工验收

已使用现有 Vision 配置实际调用识别，凭据留在设备端，没有输出到日志。当前文章取得 3 句非空真实笔迹，仅复制和读取原笔迹，没有把测试识别文字写回正式学习数据。

初轮出现摘要式漏字和超时；因此将提示强化为完整逐字转录，并启用 high detail。最终一轮结果：

| 真实样本 | 耗时 | 观察 |
|---|---:|---|
| 第 1 句 | 2.574 秒 | 返回文字，但有明显误字，例如手写「自裁」被识别为「自封」 |
| 第 2 句 | 45.051 秒 | 请求超时 |
| 第 3 句 | 34.094 秒 | 返回文字，仍需人工核对错字及漏字 |

这 3 句含红色订正及较随意笔迹，部分内容超出横线区域；功能按约定只裁取横线区。模型返回 `unsure: false` 也可能有错，因此它不是可信的准确率或置信度。界面始终要求人工校对，不自动采用结果。

证据：[真实请求记录](D:/codex库/无聊英语/output/translation-ocr-20260921/real-samples/live-results.json)、[样本 1](D:/codex库/无聊英语/output/translation-ocr-20260921/real-samples/sentence-1.png)、[样本 2](D:/codex库/无聊英语/output/translation-ocr-20260921/real-samples/sentence-2.png)、[样本 3](D:/codex库/无聊英语/output/translation-ocr-20260921/real-samples/sentence-3.png)。平板流程截图中的文字明确为模拟测试文字，不能作为模型准确性证据。

**未完成项：** 计划中的 30 句人工逐字标注与错误率统计，以及用户本人持笔书写的手感验收。当前只有 3 句样本；自动化笔事件与文件一致性检查不能替代真人持笔验收，也不能据此宣称识别准确率已达标。

后续质量评估可按工整、日常、潦草各 10 句，记录原文、识别结果、编辑距离、字符总数及耗时，计算字符错误率（替换 + 删除 + 插入）/ 原文字符数；超时单独统计。若当前视觉模型仍不足，再沿既定备选路径评估 PaddleOCR / RapidOCR，保留此次单句导出、确认与归属管理层。

## 三个实际操作例子

1. 手写「技术改变了我们的生活。」→ 点识别 → 弹窗改正误字并确认 → 完成笔译 → AI 批改。原笔迹仍在原位。
2. 擦掉写错的字并重写后再识别，图片只包含最终可见笔迹。确认后又改了手写内容，批改前会提示重新校对。
3. 第一篇识别未返回时离开，再打开第二篇相同位置的句子；迟到结果不写入第二篇。旧 `[object Object]` 文字也不会自动填入。

## 安装包与交付状态

[候选 APK：1.0.70 / 76](D:/codex库/无聊英语/output/translation-ocr-20260921/wuliao-english-1.0.70-translation-ocr-candidate.apk)，包名 `com.wuliao.english`，Debug 候选构建。

SHA-256：`14E068A10563F6E5048683007A3A6FA1CA69A3D0F37BCA11D093850F779D1D06`。

[独立 QA APK](D:/codex库/无聊英语/output/translation-ocr-20260921/translation-ocr-qa.apk)，包名 `com.wuliao.english.translationocrqa`，相同版本。

正式应用保持原安装版本；已安装验证的是独立 QA 包。候选代码指纹保存在 [candidate-source-hashes.json](D:/codex库/无聊英语/output/translation-ocr-20260921/candidate-source-hashes.json)。回退本次修改时应对照开工副本逐项操作，不能使用整仓库 reset 覆盖原有未提交工作。

[平板校对弹窗截图](D:/codex库/无聊英语/output/translation-ocr-20260921/device/recognition-dialog.png) · [保存后原笔迹截图](D:/codex库/无聊英语/output/translation-ocr-20260921/device/saved-original-ink.png)

"""Build the reviewable fourteen-part report from final, recorded evidence."""
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
out = root / "output/long-sentence/20260929-104646"
def read(name):
    return json.loads((out / name).read_text(encoding="utf-8-sig"))
def link(name):
    return f"[{name}]({(out / name).as_posix()})"
evidence = read("final-evidence.json")
preservation = read("pre-install/preservation-result.json")
learning = read("learning-preservation.json")
tablet = read("tablet-acceptance-final.json")
live = read("live-smoke-result.json")
quality = read("live-quality-review.json")
assert preservation["passed"] and learning["passed"] and live["passed"] and quality["passed"]
assert all(check["status"] == "passed" for check in evidence["checks"])
assert evidence["deployment"]["status"] == "installed"
assert not any(row["status"] == "FAIL" for row in tablet["tabletAcceptance"])

notes = {
 "src/App.jsx": "懒加载一级页面、Session hash、来源 context、Reader 返回现场与 feature flag；抽取官方解析入口。",
 "src/CustomDeepReader.jsx": "Reader 入口、原句权威复习完成回调及现场恢复，不推进 readingFlow。",
 "src/PdfReader.jsx": "将新 Reader 入口透传到精读宿主。",
 "src/ReviewSession.jsx": "三段保存边界与失败行可见；原句完成凭据恢复及账号检查。",
 "src/readingReview.js": "在既有 task/session 中增量保存 sentenceCompletions，派生已学习并严守前态/时间/指纹。",
 "src/storage.js": "共享 DB 增量升级 v8，七个训练 store、索引及验证既有 v7 的失败回退。",
 "src/backup.js": "新增 store 白名单、账号筛选、幂等与冲突检测。",
 "src/navigation.js": "一级长难句与 Session 路由，导航栈接入。",
 "src/ui/AppShell.jsx": "一级导航可见性与 flag。",
 "src/ui/SettingsPanel.jsx": "新增关闭长难句入口的设置，保留数据。",
 "src/writing/WritingInkSurface.jsx": "可选 persistence、逻辑尺寸及业务文案，默认写作行为不变。",
 "src/aiProvider.js": "temperature:null 省略参数并区分缓存；同账号同端点旧文本 native Key 安全迁移。",
 "src/officialAnalysis.js": "复用现有官方 PDF 分析/缓存，按需加载来源，不启用 OCR。",
 "src/longSentence/LongSentencePage.jsx": "五子页、来源/词选择、生成/作答/反馈/历史、保存屏障、稳定句纸和索引分页。",
 "src/longSentence/longSentence.css": "沿用 tokens/卡片与平板触点；局部工具栏位于句纸上方，消除遮挡。",
 "src/longSentence/ai.js": "两个业务服务、DATA 边界、有限修复/补齐、身份校验与请求来源记录。",
 "src/longSentence/validator.js": "冻结 JSON、来源白名单、难度一致性、重复/近复制、目标词与答案泄漏校验。",
 "src/longSentence/data.js": "训练 store 白名单 CRUD、账号范围与事务完成后返回。",
 "src/longSentence/repository.js": "Session/Attempt/Evaluation/Skill 生命周期、幂等写入、删除边界和到期索引分页。",
 "src/longSentence/schedule.js": "稳定技能身份、本地日历与 1/3/7/14/30 天调度、重大错误冲突及额外练习。",
 "src/longSentence/source.js": "只读来源解析、章节树、陌生词并集和已学习派生。",
 "src/longSentence/ink.js": "现有 Ink runtime 的独立训练持久化 adapter，绑定账号/item/attempt/指纹。",
 "src/longSentence/flag.js": "账号范围的 longSentenceTrainingEnabled 设置，默认开启，关闭后保留训练数据。",
 "package.json": "将五组长难句针对性测试纳入 test:all。",
 "android/app/build.gradle": "Android 发布版本从 1.0.76/82 递增至 1.0.77/83。",
 "e2e/long-sentence.spec.js": "完整训练/原句复习/到期迁移、离线/历史/错误、来源变更与工具栏几何验收。",
 "scripts/fixtures/long-sentence-quality.mjs": "固定质量样本及可复用的隔离测试素材。",
}
tracked = subprocess.check_output(["git", "diff", "--name-only", "-z"], cwd=root).decode().split("\0")
untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
initial = set((out / "untracked.txt").read_text(encoding="utf-8-sig").splitlines())
files, kept, diffs = [], [], []
for name in sorted(set(filter(None, tracked + untracked))):
    path = root / name
    old = out / "originals" / name
    if name in initial and not old.exists():
        kept.append(name)
        continue
    current = path.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
    previous = old.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n") if old.exists() else ""
    if old.exists() and previous == current:
        kept.append(name)
        continue
    note = notes.get(name)
    if not note and name.startswith("scripts/test-"):
        note = "验证新增契约/回归边界，更新被一级导航、DB 版本或解析抽取影响的既有断言。"
    if not note and name.startswith("e2e/"):
        note = "一级导航数量从 9 增至 10，更新原数量断言，保留尺寸与业务交互验证。"
    if not note and name.startswith("scripts/long-sentence-"):
        note = "保存基线、设备/学习数据证据、隔离真机验收或最终报告；不进入产品 bundle。"
    files.append(f"| [{name}]({path.as_posix()}) | {note or '请结合本轮差异审阅。'} |")
    diffs.extend(difflib.unified_diff(previous.splitlines(True), current.splitlines(True), fromfile="before/"+name, tofile="after/"+name))
(out / "implementation-only.diff").write_text("".join(diffs), encoding="utf-8")
checks = "\n".join(f"| {c['name']} | PASS | {c['details']} | {c.get('evidence','')} |" for c in evidence["checks"])
acceptance = "\n".join(f"| {r['id']} | {r['name']} | {r['status']} | {r['evidence'].replace('|','／')} |" for r in tablet["tabletAcceptance"])
store_table = "\n".join(f"| {name} | {v['before']} | {v['after']} |" for name,v in learning["existingStoreCounts"].items())
unknown = [r for r in tablet["tabletAcceptance"] if r["status"] == "NOT COVERED"]
status = "COMPLETE WITH DOCUMENTED LIMITATIONS" if unknown else "COMPLETE"
apk = evidence["apk"]
report = f"""# 长难句训练实施报告

交付状态：**{status}**。版本 **1.0.77 / 83**，正式包 `com.wuliao.english`。
本报告数字来自实际日志；mock、浏览器、平板 WebView、实体笔分别注明。

## 1. Baseline

实际项目为 `D:\\codex库\\无聊英语`，分支 `codex/vocabulary-modes-handwriting-20260915`，HEAD `c97c6464016c6a3df2105871fe4dfd27cbf90cd0`。
初始 17 个 tracked 修改、2 个 untracked，暂存区为空；原 Android 1.0.76 / 82。
目标平板 BTK_W00，serial `7VXYD24229201695`。未 reset、clean、restore、stash、清空数据或卸载正式包。
基线目录为 `{out}`。保存 branch/head/status、tracked diff、原件和 SHA-256、旧 APK、完整 private tar 及安装版本证据。
安装前最终备份 SHA-256：`{read('pre-install/backup-manifest.json')['archiveSha256']}`。

## 2. Current Architecture Audit

导航使用既有 AppShell/hash/navigation/BackController；原句事实由 translationProgress 管理；陌生词继续使用 unknown-words。
原句正确完成信号仅来自 ReviewSession 的“现在能独立理解”，不是普通状态按钮、AI 批改或训练自评。
文本 AI 继续使用既有 callAi/Provider profile/SecureStore；Ink 继续使用共享 WritingInkSurface/useStructuredInk/AnnotationToolbar。
共享 IndexedDB 原为 v7；Android 使用现有 Web build、Capacitor sync 和 Gradle 构建入口。

## 3. Frozen Architecture

来源只读，以 resourceId/passageId/sentenceKey 引用，保存原文指纹与快照。按需解析有学习事实的官方资料，自定义资料读取既有 analysis。
七类训练数据独立存储；原句复习完成凭据增量保存在既有 readingReview.session，不建第二套原句待掌握事实库。
五个子页为生成训练、待掌握、待复习、已学习、学习记录。flag 默认开启，关闭仅隐藏入口；长难句页不设置每日训练时间。
本地保存/后台屏障覆盖选择、题号、Session、译文及 Ink；历史每页 20、到期技能按索引分页，计数不截断于 500 条。
每次 Generate（包括重试/换句）重新确认来源指纹。难度固定以最高原困难句为基线，不逐轮递增。

## 4. Files Changed

下面说明的是本轮差异。{link('implementation-only.diff')} 以实施前原件为基准，避免把用户原有修改算作本轮工作。

| 文件 | 本轮原因 |
|---|---|
{chr(10).join(files)}

初始修改保留且本轮未变更的文件：`{'`、`'.join(kept)}`。
另更新既有文档项目 [build_docs.py](D:/codex库/无聊英语文档/生成脚本/build_docs.py)（增加章节与最终证据读取）、[现有功能 PDF](D:/codex库/无聊英语文档/无聊英语-现有功能文档.pdf) 和 [修改过程 PDF](D:/codex库/无聊英语文档/无聊英语-功能修改过程文档.pdf)（增加本次行为/测试/部署说明），保存旧文档与哈希，保留历史正文。

## 5. Data Migration

设备实际 DB **{learning['databaseVersionBefore']} → {learning['databaseVersionAfter']}**，新增 Session、Item、Attempt、Skill、Evaluation、ScheduleEvent、Ink 七 store。
升级为增量事务，失败后验证实际 v7 再打开旧库并禁用训练写入；不删表、不建空库或假装降级。
新 store 已纳入备份恢复白名单，账号隔离/冲突/重复恢复测试通过。
覆盖安装后首次启动前 **{preservation['matched']}/{preservation['filesBefore']}** 私有文件哈希完全匹配；启动后旧 store 数量如下。

| 原 store | 安装前 | 启动后 |
|---|---:|---:|
{store_table}

原学习 localStorage 哈希变化 {len(learning['originalLearningValueChanges'])} 项。首次启动前字节比较与启动后计数/哈希检查互补，计数本身不代表逐记录内容比较。
证据：{link('pre-install/preservation-result.json')}、{link('learning-preservation.json')}、{link('learning-preservation-after-live.json')}。真实请求后仅原有遥测与 Provider 运行兼容证据更新，学习值未变化且七个正式训练 store 仍为空。

## 6. AI Contract

Generate 严格整数 1–5（默认 5），一次批量；来源最高难度 +1 结构层级，生成新语义并自然使用 0–3 个所选词。
Generate schema 无参考译文/canonicalStructure/翻译评分，多余答案字段拒绝；本地校验英文、来源、词实际使用、元数据一致性、复制/近复制/重复与提示泄漏。
成功批立即持久化后再补失败数量。最多一次 JSON 修复及一次补齐；429/超时/断网不自动重试。新 Session/技能复习不取旧生成缓存。
Evaluate 只在译文提交后发生，独立分析英文并返回结构、参考译文、词汇和分类 major/minor 反馈；不调用会写原始学习记录的 runTranslationReview。
两类请求都不发送 Ink/OCR/无关文章。温度 null 表示省略参数，其他业务默认不变。
真实 Provider 验证：Generate {len(live.get('generateRequests',[]))} 次请求、Evaluate {len(live.get('evaluateRequests',[]))} 次请求；Provider/Model `{live['generateRequests'][0]['provider']} / {live['generateRequests'][0]['model']}`。
现有安全存储 Key 留在 WebView，无二次输入。旧文本 native Key 迁移限定同账号同端点，保留旧 native 副本并校验新写入。
本地规则不能证明所有未来句子真的更难/自然/语义全新；固定样本和本次真实句独立审阅见 {link('live-quality-review.json')}。

## 7. Ink Integration

直接复用 WritingInkSurface、useStructuredInk、AnnotationToolbar、现有 pointer/canvas engine，只给 Surface 增加可选业务持久化/逻辑尺寸/文案。
独立 Ink 身份绑定账号、generated item、attempt、内容指纹。首次布局先保存后允许写，旋转整体缩放英文与 Canvas；反馈放纸外。
切题/提交/退出等待活动 stroke 完成和事务成功；历史作答为原 attempt 的只读 Ink。
没有新 Canvas/Pointer 引擎、S/V/O 操作、结构标注 schema、OCR/Vision；没有恢复已移除的钢笔/荧光笔/独立几何工具。
平板 QA 曾发现默认 fixed 工具栏遮首行，已用本模块 CSS 正常布局修复，并新增几何/触点回归。
合成 pen 验证保存、旋转和工具行为；实体 M-Pencil 的触感/落点/掌拒/延迟没有自动化证据。

## 8. 已学习行为

**Generated training mastered 改变原句：NO。Original review correct 进入已学习：YES。**
例如：原句 S 待掌握 → 生成 B → 翻译/AI 解析/自评掌握，S、陌生词和 first/redo/evidence/readingFlow 保持不变。
随后 S 经原 ReviewSession“现在能独立理解”完成，凭据+前态 needs_review+当前 mastered+时间/指纹匹配才进入已学习。
到期以同 skillId 生成 C，排除 S/B 并保留核心结构；原句仍为唯一难度基线。
三段写入依次为完成凭据、原句持久化、mastered result。失败项保持可见；恢复仅精确匹配时补历史，原句仍 needs_review 只能显式重试。
重新 needs_review 退出已学习但留历史；旧记录无证据不回填；generic mastery 不替代该流程。

## 9. Tests

| 检查 | 结果 | 数字/说明 | 证据 |
|---|---|---|---|
{checks}

首次 Node 的 3 个失败为新增导航/DB 版本/官方解析抽取影响的旧断言，修正契约后最终全部通过；不是虚构的基线既有故障。
首次全 Playwright 163/167，4 个旧导航数量断言期待 9、实际 10；保留交互与尺寸断言并修正数量。
随后正式 bundle 检查 68/69，1 项缺编译期 Ink 性能探针；20 笔持久化已过。最终使用同一源码、原测试 probes flags、独立 outDir 完整重跑，未跳过/弱化指标。
release exact-content 为 44/68，24 个既有 reference/OCR 差异按现有门禁解释；不写成 68/68 内容一致。

## 10. Android

旧版 1.0.76 / 82 → 新版 **1.0.77 / 83**；包名和旧版一致，既有 debug 签名 SHA-256 `cb65f9a54422b71a791dddda1bdff301818d5ee7a34fddf839ff5d33e4e2330a`。
APK：[{Path(apk['path']).name}]({Path(apk['path']).as_posix()})；SHA-256 `{apk['sha256']}`。
现有脚本完成 Web build/Capacitor sync/APK；aapt/apksigner 检查通过；执行 `adb install -r` 成功。
首次启动前私有数据比较通过后才启动，MainActivity/进程/前台/安装版本均有直接证据。
正式学习记录未注入 fixture。平板自动化使用独立 QA package/account，正式包仅最小只读 live smoke。
证据：{link('deployment-result.json')}。旧 APK/完整备份保留用于可审阅回退；没有执行回退。

## 11. Tablet Acceptance

按附件原 26 项逐项记录。PASS 注明证据范围；mock 请求链不冒充 live 模型，合成 pen 不冒充 M-Pencil。

| 编号 | 项目 | 结果 | 直接证据及限制 |
|---:|---|---|---|
{acceptance}

## 12. Regression

完整 test:all 和完整 Playwright 覆盖既有精读、完形、词汇、写作、Ink、Back、AI、backup。
原句进度/复习凭据三个保存故障边界、账号隔离、旧响应、重复提交、补齐、重解析版本、刷新/后台恢复、Reader 返回、flag关闭、v7升级失败和备份恢复均有针对性覆盖。
保存了用户原有未提交修改；未提交 Git commit 或推送。两份 PDF 重新生成并渲染目视检查，历史正文与备份一致。

## 13. Remaining Risks

{chr(10).join('- '+r['name']+'：'+r['evidence'] for r in unknown) if unknown else '26 项已有完整直接证据。'}

本次真实模型样本只支持这个样本的质量判断，不能保证所有未来模型输出。真实同 skillId 的到期再生成尚未额外调用模型；同技能排重与核心保持已经用确定性浏览器样本验证。首轮核心指纹由 AI 抽象，本次保留了状语/宾语/关系从句的嵌套困难，但让步逻辑改为原因，不能用这一例证明严格逻辑子类型不变。复杂句解析仍可能错误，因此提供“解析有误”和显式重解析。
上述既有 24 项参考内容差异、debug 签名和 Web/Android 独立版本均在 release gate 记录，没有冒称修复或正式 release keystore。

## 14. Final Status

**{status}**。编码、针对性及全量测试、发布检查、正式覆盖安装、数据保留证据和两份 PDF 已完成；剩余项以上面的真实未覆盖范围为准。
主证据目录：`{out}`。原始失败日志/截图保留，最终验收与既有失败分开记录。
"""
(out / "长难句训练-实施报告.md").write_text(report, encoding="utf-8")
(out / "delivery-manifest.json").write_text(json.dumps({"status":status,"report":str(out / "长难句训练-实施报告.md"),"apk":apk,"tabletNotCovered":[r["id"] for r in unknown]}, ensure_ascii=False, indent=2),encoding="utf-8")
print(json.dumps({"status":status,"changedFiles":len(files),"preservedInitialFiles":len(kept),"report":str(out / "长难句训练-实施报告.md")},ensure_ascii=False))

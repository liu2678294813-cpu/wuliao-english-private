"""Add the approved import update to the existing two documentation PDFs.

Run with the existing build_docs.py renderer; its historical chapters are retained.
Generated PDFs and visual checks stay inside the current project evidence folder.
"""
import argparse
import importlib.util
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--base", default=r"D:\codex库\01_无聊英语项目\无聊英语文档\生成脚本\build_docs.py")
parser.add_argument("--evidence", default=str(ROOT / "output/unified-import/20261009"))
args = parser.parse_args()
evidence = pathlib.Path(args.evidence).resolve()
if not evidence.is_relative_to(ROOT / "output"):
    raise SystemExit("Documentation output must remain in this project")
spec = importlib.util.spec_from_file_location("existing_docs", args.base)
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)
data_path = evidence / "final-evidence.json"
data = json.loads(data_path.read_text(encoding="utf-8")) if data_path.exists() else {}
out = evidence / "documents"
out.mkdir(parents=True, exist_ok=True)
docs.OUT_DIR = str(out)
docs.DOC_UPDATE_DATE = "2026-10-09"
docs.product_version_label = lambda: "1.0.82 / versionCode 88；平板验证 " + data.get("deviceStatus", "NOT COVERED")

def update_story(process=False):
    story = [docs.H1("2026-10-09：统一批量导入与答案管理")]
    story.append(docs.NOTE("本节是当前导入行为。历史章节中的资料库上传、审核前写库、固定 20 空和自定义资料无答案描述已由本节替代。真实 AI 服务与物理触笔体验未验证；自动化 AI 响应均为受控模拟。"))
    story.append(docs.H2("首页选择目标，集中审核后保存"))
    story.append(docs.P("首页“资料导入”单选作文、完形或精读，初始不选。选择多文件后逐文件、逐页本地提取；审核前只有草稿和缓存，不进入正式资料库。集中预览可选择、编辑、移除、核对答案、局部重解析及另存独立资料。离开或重启可恢复最近持久化检查点，不恢复付费 AI 调用。"))
    story.append(docs.TABLE(["能力", "当前规则"], [
        ["格式与限额", "PDF、TXT、Markdown、DOCX、JSON、PNG/JPG；50 文件/批、100 MiB/文件、500 MiB/批。DOCX 解压 200 MiB、图片 2400 万像素上限。"],
        ["本地提取", "完整保留 PDF 页，答案插页不截断后文；仅低质量文字页 OCR。英文/简体中文资源随包。DOCX 不直接呈现原 HTML，不加载外部图片；图片以本地附件引用保存。"],
        ["精读", "一文章一资料；有题复用七阶段。纯文章不创建习题，审题、初做、重做标为不适用，继续阅读、翻译与复读。"],
        ["完形", "正文空位和选项题号必须一一对应，20 空仅提示。OCR 推断的缺空需人工核对；不会自动补成有效的 20 空。"],
        ["作文", "题面+范文+A/B 题型齐全时，经现有命令服务冻结快照进入 W1-W8。仅题或仅范文可保存待完善；未知年份 null。旧 Session 不因材料订正而改写。"],
        ["去重与恢复", "账号+文件指纹复用原文件；材料含目标模块与文件内身份。同 PDF 可分别导精读/完形。同内容默认跳过，明确另存可独立训练；不覆盖旧进度。"],
    ], widths=[30 * docs.mm, 140 * docs.mm]))
    story.append(docs.H2("答案、解析与评分分开管理"))
    story.append(docs.P("原文件答案仅在章节、题号和选项唯一对应时确认，冲突或关系不明保留待核对记录。有效正文可先保存；待核对答案不批改、不作为缺失项交给 AI。答案与解析独立存储，没有解析不妨碍答案保存，只有解析不推断答案。"))
    story.append(docs.P("无答案提示提供“AI 生成／手动录入／暂不添加”；部分缺失仅请求缺失题。AI 需先展示必要上下文并确认发送，结果仍为可修改、删除或主动重生成的候选，再确认才评分。AI 来源始终 ai_generated，原文件依据不会被静默覆盖。参考答案的 AI 解释也需要显式确认，不自行改判。"))
    story.append(docs.TABLE(["评分与修订", "保存和展示"], [
        ["正式正确率", "只使用程序已核验的内置官方题目身份与答案。导入文件自称官方、文件名年份或 AI 输出不能授予官方可信身份。"],
        ["参考正确率", "原文件/用户确认 AI/手动答案均独立评分，显示依据及覆盖题数；无有效答案题不进入分母。"],
        ["订正与撤销", "追加新答案版本和本地重评分；旧作答、旧答案、旧成绩及当时依据可查看。启动/返回前台继续中断重评，幂等且不改变计时、笔迹或复习；只改解析不重评。保存后编辑 AI 候选也保留原版本。"],
        ["备份与账号", "资料、来源、图片、待核对/已确认答案、解析、评分历史和自定义作文进白名单；草稿/缓存不进入正式备份。恢复检查关联；账号切换终止旧任务。"],
    ], widths=[30 * docs.mm, 140 * docs.mm]))
    story.append(docs.H2("三个实际例子"))
    for text in [
        "同整卷先导精读再导完形：共享一个来源文件，生成各自资料，互不阻挡。",
        "10 题有 7 个明确答案、1 个待核对、2 个缺失：待核对项单独保留，仅缺失的 2 题进入补全；评分覆盖 7/10，分母为 7。",
        "AI 候选 B 被用户改为 C：保存 AI 来源与 B 的历史证据，确认后用 C 参考评分；正式正确率不变。",
    ]: story.append(docs.BULLET(text))
    story.append(docs.H2("验证证据与边界"))
    tests = data.get("tests", {})
    story.append(docs.P(f"单元回归：{tests.get('unit', '待最终复核')}；浏览器：{tests.get('browser', '核心 36/36，账号检查待最终复核')}。浏览器使用隔离账号，真实 PDF、DOCX、图片及扫描 PDF 本地提取，模拟 AI 验证授权次数和 Schema。"))
    story.append(docs.P("平板当前未连接，覆盖安装、数据保全前后比对、系统多文件选择器、断网原生 OCR、后台回收、手指和触笔操作均为未覆盖。后续安装须先验证版本和兼容签名，备份/hash 后使用覆盖安装，禁止卸载或清数据。"))
    if process:
        story.append(docs.H2("实现顺序和增量发布"))
        story.append(docs.P("先保存 Git 状态、差异、未跟踪清单、文件哈希和源码副本，再制定状态机、数据契约与验收矩阵。增量数据库 8→9 保留所有旧 store；导入控制器、提取器、结构适配、事务提交、答案读取和评分修订分层实现。"))
        story.append(docs.P("GitHub 以执行时最新 main 为基线，按起始快照→完成结果计算本任务增量；同期兼容性改动保留、不混入任务。只在隔离源码验证通过后构建 Release APK，签名复用原证书。私人材料、凭据、安全备份及真实学习数据不上传。"))
    story.append(docs.PageBreak())
    return story

for name in ("doc1_story", "doc2_story"):
    original = getattr(docs, name)
    def wrapped(original=original, process=name == "doc2_story"):
        story = original()
        toc = next(i for i, item in enumerate(story) if item.__class__.__name__ == "TableOfContents")
        after = next(i for i in range(toc + 1, len(story)) if isinstance(story[i], docs.PageBreak)) + 1
        story[after:after] = update_story(process)
        return story
    setattr(docs, name, wrapped)
docs.main()
# Refresh the two existing canonical documentation artifacts, retaining their renderer.
canonical = pathlib.Path(args.base).resolve().parent.parent
for pdf in out.glob("*.pdf"):
    shutil.copy2(pdf, canonical / pdf.name)
print(out)

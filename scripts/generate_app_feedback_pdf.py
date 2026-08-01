from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    KeepTogether,
    PageTemplate,
    Paragraph,
    PageBreak,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "无聊英语App修改与问题逐点答复.pdf"

NAVY = colors.HexColor("#153A62")
TEAL = colors.HexColor("#087F78")
RED = colors.HexColor("#C93C3C")
INK = colors.HexColor("#243345")
MUTED = colors.HexColor("#607286")
PALE_BLUE = colors.HexColor("#EEF5FB")
PALE_TEAL = colors.HexColor("#EAF7F5")
PALE_RED = colors.HexColor("#FFF0EE")
PALE_GOLD = colors.HexColor("#FFF8E9")
LINE = colors.HexColor("#CAD8E6")


def register_fonts():
    pdfmetrics.registerFont(TTFont("YaHei", r"C:\Windows\Fonts\msyh.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("YaHei-Bold", r"C:\Windows\Fonts\msyhbd.ttc", subfontIndex=0))
    pdfmetrics.registerFontFamily("YaHei", normal="YaHei", bold="YaHei-Bold")


class NumberedDocTemplate(BaseDocTemplate):
    def __init__(self, filename):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=22 * mm,
            bottomMargin=18 * mm,
            title="无聊英语 App 修改与问题逐点答复",
            author="Codex",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="body")
        self.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=self.draw_header_footer))

    def draw_header_footer(self, canvas, doc):
        canvas.saveState()
        width, height = A4
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(18 * mm, height - 14 * mm, width - 18 * mm, height - 14 * mm)
        canvas.setFont("YaHei", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, height - 10.5 * mm, "无聊英语 · App 修改与问题逐点答复")
        canvas.drawRightString(width - 18 * mm, 9.5 * mm, f"{doc.page}")
        canvas.drawString(18 * mm, 9.5 * mm, "结论截至 2026-07-23 · 上架前请复核平台规则")
        canvas.restoreState()


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "TitleCN", parent=base["Title"], fontName="YaHei-Bold", fontSize=25,
            leading=34, textColor=NAVY, alignment=TA_CENTER, spaceAfter=8,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleCN", parent=base["Normal"], fontName="YaHei", fontSize=11,
            leading=18, textColor=MUTED, alignment=TA_CENTER,
        ),
        "h1": ParagraphStyle(
            "H1CN", parent=base["Heading1"], fontName="YaHei-Bold", fontSize=18,
            leading=25, textColor=NAVY, spaceBefore=8, spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "H2CN", parent=base["Heading2"], fontName="YaHei-Bold", fontSize=13.2,
            leading=20, textColor=TEAL, spaceBefore=8, spaceAfter=5,
        ),
        "body": ParagraphStyle(
            "BodyCN", parent=base["BodyText"], fontName="YaHei", fontSize=9.5,
            leading=16, textColor=INK, spaceAfter=5, wordWrap="CJK",
        ),
        "small": ParagraphStyle(
            "SmallCN", parent=base["BodyText"], fontName="YaHei", fontSize=8,
            leading=13, textColor=MUTED, spaceAfter=3, wordWrap="CJK",
        ),
        "question": ParagraphStyle(
            "QuestionCN", parent=base["BodyText"], fontName="YaHei-Bold", fontSize=9.5,
            leading=15, textColor=NAVY, wordWrap="CJK",
        ),
        "answer": ParagraphStyle(
            "AnswerCN", parent=base["BodyText"], fontName="YaHei", fontSize=9.2,
            leading=15.5, textColor=INK, leftIndent=2 * mm, bulletIndent=0,
            spaceAfter=3, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutCN", parent=base["BodyText"], fontName="YaHei-Bold", fontSize=10,
            leading=17, textColor=NAVY, wordWrap="CJK",
        ),
        "table_header": ParagraphStyle(
            "TableHeaderCN", parent=base["BodyText"], fontName="YaHei-Bold", fontSize=9.5,
            leading=15, textColor=colors.white, wordWrap="CJK",
        ),
    }


def p(text, style):
    return Paragraph(text, style)


def question_box(number, text, s):
    table = Table([[p(f"{number}. {text}", s["question"]) ]], colWidths=[174 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def answer_block(number, question, answers, s):
    flow = [question_box(number, question, s), Spacer(1, 2.5 * mm)]
    for answer in answers:
        flow.append(p(f"• {answer}", s["answer"]))
    flow.append(Spacer(1, 2.5 * mm))
    return flow


def callout(text, s, background=PALE_TEAL, border=TEAL):
    table = Table([[p(text, s["callout"])]], colWidths=[174 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), background),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def section_title(index, title, s):
    return [Spacer(1, 2 * mm), p(f"{index:02d}  {title}", s["h1"]), HRFlowable(width="100%", thickness=1, color=LINE), Spacer(1, 3 * mm)]


def build_story():
    s = styles()
    story = [Spacer(1, 28 * mm), p("无聊英语 App", s["title"]), p("修改建议与问题逐点答复", s["title"]), Spacer(1, 7 * mm)]
    story.append(callout(
        "先给结论：现阶段先不购买平台会员。继续用网页 + 本地测试版完成核心体验；先做本机个人段位、订正答案显示、单词自动发音与本地词库导入。跨用户排行榜、手机号登录和自动 AI 翻译放到第二阶段。",
        s,
    ))
    story.extend([
        Spacer(1, 8 * mm),
        p("分析对象：G:\\我的云端硬盘\\app.pdf", s["subtitle"]),
        p("对应项目：D:\\codex库\\无聊英语", s["subtitle"]),
        p("当前状态：Vite/React 网页版 + Capacitor Android 配置；本轮不更新 Android 工程、不发布线上版本。", s["subtitle"]),
        Spacer(1, 12 * mm),
        callout("范围说明：按原 PDF 的要求，最后一段“推荐原文”不做识别、评价或改写。", s, PALE_GOLD, colors.HexColor("#D6A53A")),
        PageBreak(),
    ])

    story += section_title(1, "网页版转 App", s)
    story += answer_block("1", "如何将 Codex 做的网页版软件转化为 App？", [
        "你现在的项目已经走在正确路线上：网页由 Vite/React 构建，再由 Capacitor 放进 Android 原生壳。标准流程是“网页构建 → Capacitor 同步 → Android Studio/Gradle 生成 APK 或 AAB → 真机测试 → 商店提交”。",
        "Android 可以在 Windows 上完成；iOS 还需要 Mac、Xcode、签名证书和 Apple 开发者计划。",
        "当前仓库已有 capacitor.config.json 和 android/，但本次检查没有发现已生成的 APK。因此可以说“打包框架已准备好”，不能说“安装包已经完成”。本轮按你的要求不继续同步到移动端。",
    ], s)
    story += answer_block("2", "这个过程中哪些需要付费？付费比免费多什么？够几个人用？", [
        "完全免费：继续开发网页、生成本地调试 APK、把 APK 私下发给测试者、PWA 网页访问。理论上人数不受技术硬限制，但安装、更新、信任提示和版本管理都要人工处理。",
        "Google Play：完整公开分发账户目前为一次性 25 美元；可面向公开用户分发并获得商店更新、崩溃/安装统计和付款能力。新个人账户公开发布前通常要完成至少 12 名测试者连续 14 天的封闭测试。Google 还宣布 2026 年 8 月推出免费“有限分发”，最多 20 台设备；截至本报告日期尚未正式可用。",
        "Apple App Store：Apple Developer Program 为每年 99 美元（当地可能显示本币价格）；包含 App Store 发布、TestFlight、证书和平台能力。免费 Apple 账户只适合学习和有限真机测试，不适合公开上架。",
        "联网后端：早期可用免费额度。以 Supabase 当前公开价格为例，免费层包含 5 万月活认证额度，但项目长期不活跃会暂停；稳定生产方案从 25 美元/月起。人数不是唯一成本，数据库大小、流量、邮件、备份和短信都会单独影响费用。",
        "AI：按输入/输出 token 用量计费。不要把“无限 AI 翻译”直接包含在低价会员里，应做限额、缓存或独立 AI 包。",
    ], s)
    story += answer_block("3", "建议我买哪个付费的？", [
        "现在不建议购买任何平台。先让 10–20 名真实同学使用网页或本地 APK，确认他们确实会连续使用精读、单词和复习功能。",
        "如果第一批目标是海外/可使用 Google Play 的 Android 用户，第一笔最值得付的是 Google Play 的一次性 25 美元。",
        "如果目标主要是中国大陆 Android 用户，Google Play 不是主要入口；应先完成 APP 备案与材料，再按华为、小米、OPPO、vivo 等渠道逐个评估。",
        "Apple 99 美元/年放到更后面：等你确认有足够 iPhone 用户，并且已有 Mac/Xcode 发布条件再付。",
    ], s)
    story += answer_block("4", "上架还需要做哪些准备、提交什么材料？", [
        "产品材料：正式 App 名称、图标、启动图、商店截图、简短/完整描述、分类、关键词、支持邮箱、支持页面、隐私政策网址、版本说明。",
        "技术材料：唯一包名、正式签名密钥、Android AAB（或渠道要求的 APK）、iOS Archive、适配当前系统版本、真机测试记录、崩溃和权限检查。签名密钥必须离线备份，丢失后更新会很麻烦。",
        "隐私与审核：列出收集的数据、用途、保存时间、删除方式；提供账号注销；如果审核员必须登录，要提供审核账号和操作说明。Apple 要求所有 App 提供可用的支持链接和隐私政策链接。",
        "中国大陆：在境内提供互联网信息服务的 App 应办理 APP 备案，填写备案登记表及承诺书，通过接入商或分发平台提交并核验真实身份、域名/IP 等信息；取得备案号后要在 App 显著位置展示。是否还需软件著作权、增值电信许可或教育类前置材料，取决于主体、收费方式、内容和具体商店，提交前应向渠道再次确认。",
        "收费准备：商品结构、退款说明、服务协议、发票/税务安排、商店内购配置。数字内容通常要遵守相应商店的支付规则。",
    ], s)

    story += section_title(2, "排位功能", s)
    story += answer_block("1", "为 App 增添一个排名功能。", [
        "建议分两步：第一步做“本机个人段位”，完全使用本机学习记录，不需要账户和服务器；第二步才做“好友/全站排行榜”。",
        "这样能先验证段位是否真的促进学习，也不会因为急着联网而引入账号、隐私、作弊和运维问题。本轮实现第一步。",
    ], s)
    story += answer_block("2", "用熟知词数量、阅读数量和完成率综合判断是否合理？有没有更好的？", [
        "方向合理，但直接相加不公平：词多的人会长期碾压新用户；只做一篇阅读就能得到 100% 完成率；反复点击也可能刷分。",
        "建议总分 2500 分：熟知词分 = min(1000, 12.4 × √熟知词数)；精读完成分 = min(1100, 17 × 完成篇数)；完成率分 = 400 × 完成率 × min(1, 已开始篇数/5)。平方根让前期进步明显、后期不靠堆词垄断；不足 5 篇时降低完成率奖励。",
        "熟知词按 wordId 去重，并只统计达到 3/3 黑线的词；阅读完成率 = 已标记完成篇数 / 已开始篇数。后续联网排行榜应增加连续学习天数、异常刷分检查和周榜，减少老用户永久霸榜。",
    ], s)
    story += answer_block("3", "段位怎么设计合理？", [
        "建议七段：启程 0–199、筑基 200–499、进阶 500–899、精读 900–1299、融会 1300–1699、洞见 1700–2099、登峰 2100–2500。",
        "每个段位显示“距下一段还差多少分”，比只显示名次更能指导行动。联网后可在每段内再加 I/II/III 小段位。",
        "不要把段位与付费特权绑定，也不要用强制在线时长排名；它应该奖励真实完成，而不是制造焦虑。",
    ], s)

    story += section_title(3, "精读", s)
    story += answer_block("1", "所有包含选项题目的页面，右上角增加订正功能；点击后把正确答案标红。", [
        "可实现。本轮在结构化精读页和悬浮习题窗加入“订正”按钮：点击后，正确选项采用与已选状态相同的整块高亮形式，但颜色为红色；再次点击可隐藏。用户原选择保留，错选与正确项可以同时看见。",
        "现有 66 份精读 PDF 明确写着“不提供答案与题目解析”，所以 App 不能从 PDF 自己推断答案。本轮会为 2007–2023 英语一阅读 Part A 加入答案表；自定义 PDF 若未识别答案，第一次点击订正时允许手工录入答案。",
        "订正只显示答案，不自动修改用户的第一次和重做记录。",
    ], s)
    story += answer_block("2", "保留手写字体和键盘输入；为什么手写完会自动转化为印刷体？", [
        "应保留两条独立路径：手写层保存笔画；键盘输入保存在文本框。手写不应该默认转换为印刷体。",
        "当前网页精读的手写批注以笔画保存，键盘输入是独立 textarea；代码本身没有自动把笔迹识别成印刷体。如果你看到转换，通常是进入了“手写识别/转文字”工具，或在系统输入法的手写面板里输入——那是系统把手写当作键盘文字提交。",
        "后续移动端应保留“原笔迹”和“转印刷体”两个明确按钮，并默认保留原笔迹。",
    ], s)
    story += answer_block("3", "逐段翻译页右上角增加注释按钮，打开看到逐句翻译。", [
        "适合做，但应默认折叠，避免学生在自己翻译前直接看答案。建议每段右上角放“逐句译注”，第一次点击前提醒“建议先完成自己的笔译”。",
        "译注内容最好包含逐句翻译、主干、连接关系和易错词，而不只是中文直译。若已有人工译文，优先使用人工内容并允许离线查看。",
        "本轮按你的主请求只实现第 1 点；第 3 点作为下一次独立功能，避免和订正、单词、排位同时扩大改动范围。",
    ], s)
    story += answer_block("4", "自定义资料没有逐句翻译时，由 App 提供翻译；是否需要 AI API？", [
        "对任意新 PDF 自动生成高质量逐句翻译，通常需要 AI API，或者在设备上下载较大的本地翻译模型。普通词典和固定规则只能查词，不能稳定处理长难句。",
        "更稳的产品路线：先允许用户导入带译文的资料；再做“按需生成本段译文”，而不是上传整本 PDF 自动翻译。生成结果缓存到本地，用户确认后再保存。",
        "API 密钥不能写进网页或 APK，必须由服务端代理，并设置每用户日限额、单段长度限制、超时和成本日志。",
        "API 费用按 token 计。以 OpenAI 当前公开价为例，不同文本模型的输入/输出价差很大，因此应根据质量测试选模型，并把 AI 翻译做成限额功能或独立用量包，不承诺无限使用。",
    ], s)

    story += section_title(4, "单词", s)
    story += answer_block("1", "每选完一个单词进入下一页时自动发音，并提供开关。", [
        "适合做，默认建议关闭，让用户主动开启，避免公共场合突然发声。设置保存在本机，进入下一词时自动用系统英文语音朗读；点击单词仍保留手动朗读。",
        "本轮会把同一开关用于单词筛查和日期复习，并避免同一个单词因页面重绘重复朗读。系统没有英文语音包时给出提示，不依赖付费语音 API。",
    ], s)
    story += answer_block("2", "可以自己导入 PDF 或 Excel 录入词库。", [
        "可实现为完全本地导入：支持 PDF、XLSX/XLS 和 CSV；推荐 Excel 两列格式“英文 / 中文释义”。文件只在浏览器解析，不上传服务器。",
        "PDF 的排版不统一，自动识别会有误差，因此导入页必须先显示预览、去重和识别数量，确认后再保存。扫描版 PDF 没有文字层时需要 OCR，本轮先明确提示，不静默导入错误内容。",
        "导入词库单独存放，不修改原始 6515 词及原筛查数据库；可以在背词训练和日期复习中使用。要让它完全进入原有多轮筛查器，需要下一步改造原打包应用的数据层。",
    ], s)

    story += section_title(5, "使用讲解视频", s)
    story += answer_block("1", "生成一份包含各部分功能讲解的视频。", [
        "建议 90 秒横版教程：0–8 秒首页与定位；8–28 秒进入真题库；28–55 秒演示题干、原文、作答、手写/键盘和订正；55–72 秒演示单词筛查、3/3 黑线和日期复习；72–84 秒展示本机段位与隐私；84–90 秒行动提示。",
        "录屏前先准备一套干净测试数据和固定脚本，避免真实账号、学习记录或文件路径出现在视频里。",
    ], s)
    story += answer_block("2", "讲清楚比其他 App 多的功能。", [
        "不要泛泛说“功能多”，应聚焦差异：同一篇文章内完成审题 → 限时读文 → 第一次作答 → 逐句笔译 → 订正 → 重做 → 第二天复读；笔迹和键盘内容保存在本机；单词达到 3/3 后按背词日期自动复习。",
        "对比时只说可验证事实，不点名贬低竞品。",
    ], s)
    story += answer_block("3", "再生成一份有吸引力开头的讲解视频。", [
        "建议 60 秒竖版开头：“真题做了很多遍，下一篇还是不会？问题可能不是做得少，而是每一篇都没有闭环。”",
        "随后 3 秒快速切换：选项定位、逐句笔译、红色订正、第二天复读；再进入完整讲解。结尾：“先免费完整吃透一篇，再决定它适不适合你。”",
        "本阶段先定脚本和镜头表。等桌面功能稳定后再录制，否则每次 UI 改动都会导致视频重录。",
    ], s)

    story += section_title(6, "收费", s)
    story += answer_block("1", "结合上架费、AI、时间精力等，如何收费合适？", [
        "建议“本地核心功能低价订阅 + AI 用量单独计费”，不要一开始做永久买断，也不要承诺无限 AI。",
        "内测期：14 天或 3 篇完整精读免费，收集留存和完成率。正式基础版可从 12.9 元/月、99 元/年测试；包含精读、单词、复习、导入和本机段位。价格不是定论，应根据 30 日留存与支持成本调整。",
        "AI 译注做独立包，例如按段数/额度售卖，或 Pro 版每月给固定额度。超额停止而不是后台继续烧钱。",
        "每月成本表至少包含：商店年费摊销、服务器/数据库、邮件/短信、AI、商店佣金、退款、税费、客服和你每月投入工时。盈亏平衡用户数 = 月固定成本 ÷（每名付费用户实收 - 每名用户变量成本）。",
        "先通过网页/测试 APK 验证 20–50 名活跃用户，再决定是否开订阅；过早接支付会增加审核、退款和税务工作。",
    ], s)

    story += section_title(7, "联网账户模式", s)
    story += answer_block("1", "手机号、自建账户等，选一个完善且便宜的方式。", [
        "建议第一版使用“邮箱 + 密码（或邮箱验证码）+ 自定义昵称”，后端用托管认证服务；不要先做手机号登录。手机号短信每次都产生成本，还涉及通道申请、模板审核、攻击防刷和更敏感的个人信息。",
        "昵称用于排行榜，邮箱不公开；学习数据默认本机，用户主动开启同步后才上传。必须提供导出数据、退出登录、注销账号和删除云端数据。",
        "Supabase 免费层可做小规模验证，但生产版应预算 25 美元/月级别的稳定后端，并确认目标用户所在地的网络可用性与合规。若主要服务中国大陆用户，上线前应改用境内合规云和备案域名，不能只按海外免费额度设计。",
        "排行榜表只保存必要聚合值，不上传原 PDF、整段笔记或笔迹；服务端重新计算分数并限制异常提交。",
    ], s)

    story += section_title(8, "接下来学习的技能", s)
    story += answer_block("1", "如何安排 Git、上架、工作树、Computer Use、Python？", [
        "推荐顺序：① Git 基础（status、diff、add、commit、branch、merge）→ ② Git worktree（每个功能一个工作树）→ ③ Android 打包和上架 → ④ Computer Use 做重复验收 → ⑤ Python 做数据清洗、PDF/Excel 处理和自动化。",
        "先学 Git 再学工作树，因为 worktree 依赖分支与提交概念；先完成一个可安装版本再学上架，能把材料和流程对应到真实产品。",
        "每项都做一个真实小任务：Git 保存一次功能；worktree 同时做“订正”和“导入”；上架走封闭测试；Computer Use 自动回归登录/答题；Python 清洗一份词库。",
    ], s)

    story += section_title(9, "推广与首页展示词", s)
    story += answer_block("1", "如何推广 App？", [
        "第一阶段不要买广告。找 20 名目标用户完成“一篇精读 + 一次日期复习”，记录他们在哪一步退出；用真实完成率和反馈改产品。",
        "内容渠道可做 30–60 秒短视频：展示一个具体痛点和一个完整闭环，不做夸大分数承诺。每条视频只讲一个功能，如“为什么做完题还要重做”“3/3 黑线如何进入日期复习”。",
        "建立邀请反馈入口、版本更新日志和公开问题清单。小范围口碑比一开始追求下载量更重要。",
    ], s)
    story += answer_block("2", "生成一个适合首页的展示词。", [
        "主标题：<b>不是多做题，是把一篇真题真正吃透。</b>",
        "副标题：从审题、限时阅读、逐句笔译，到订正、重做与第二天复读，把零散步骤连成一套能坚持的精读闭环。",
        "功能短句：<b>原文不上传｜手写与键盘都保留｜单词按背词日期复习</b>",
        "按钮：<b>免费开始一篇精读</b>；次按钮：看看完整学习流程。",
    ], s)

    story.append(PageBreak())
    story += section_title(10, "本轮落地范围与后续顺序", s)
    rows = [
        [p("项目", s["table_header"]), p("本轮处理", s["table_header"]), p("说明", s["table_header"])],
        [p("答复 PDF", s["body"]), p("完成", s["body"]), p("逐点回答全部问题，忽略指定原文", s["body"])],
        [p("本机个人段位", s["body"]), p("实现", s["body"]), p("熟知词、阅读完成与完成率综合", s["body"])],
        [p("精读订正", s["body"]), p("实现", s["body"]), p("官方答案表 + 自定义答案录入", s["body"])],
        [p("自动读音开关", s["body"]), p("实现", s["body"]), p("筛查/复习共用本机设置", s["body"])],
        [p("PDF/Excel 词库导入", s["body"]), p("实现", s["body"]), p("仅本地解析，原词库不改", s["body"])],
        [p("Android/iOS 同步", s["body"]), p("暂不做", s["body"]), p("按你的要求留到后续移动端任务", s["body"])],
        [p("跨用户排行榜/账户/支付/AI", s["body"]), p("暂不做", s["body"]), p("需要后端、合规和成本控制", s["body"])],
        [p("翻译注释按钮/视频成片", s["body"]), p("后续", s["body"]), p("功能稳定后单独制作", s["body"])],
    ]
    table = Table(rows, colWidths=[36 * mm, 28 * mm, 110 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE_BLUE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)

    story += section_title(11, "官方资料链接", s)
    sources = [
        ("Apple Developer Program 会员与 99 美元年费", "https://developer.apple.com/programs/enroll/"),
        ("Apple App Review 准备与隐私/支持链接要求", "https://developer.apple.com/app-store/review/"),
        ("Google Play Console 25 美元一次性注册费", "https://support.google.com/googleplay/android-developer/answer/6112435"),
        ("Google Play 新个人账户 12 人/14 天测试要求", "https://support.google.com/googleplay/android-developer/answer/14151465"),
        ("Android Developer Console 2026 年 8 月有限分发说明", "https://support.google.com/android-developer-console/answer/16640817"),
        ("中国政府网：工业和信息化部 APP 备案通知", "https://www.gov.cn/zhengce/zhengceku/202308/content_6897341.htm"),
        ("Supabase 定价与免费/Pro 配额", "https://supabase.com/pricing"),
        ("OpenAI API 官方定价", "https://developers.openai.com/api/docs/pricing"),
        ("研招网：2007 考研英语阅读参考答案", "https://yz.chsi.com.cn/kyzx/jyxd/200701/20070124/748806.html"),
        ("研招网：2008 考研英语阅读参考答案", "https://yz.chsi.com.cn/kyzx/other/200811/20081126/10549912.html"),
        ("文都：2009 考研英语阅读参考答案", "https://www.wendu.com/uploadfile/2017/0823/20170823033711924.pdf"),
        ("北鼎教育：2010–2023 英语一阅读 Part A 答案汇编", "https://29682352.s21i.faiusr.com/61/ABUIABA9GAAgpofLpAYosrehNQ.pdf"),
    ]
    for label, url in sources:
        story.append(p(f'• <link href="{url}" color="#087F78">{label}</link><br/><font size="7" color="#607286">{url}</font>', s["small"]))
    story.append(Spacer(1, 4 * mm))
    story.append(callout(
        "提醒：商店规则、价格、目标 API 和备案细节会变化。真正提交前，再按目标市场和开发者主体逐项复核。",
        s,
        PALE_RED,
        RED,
    ))
    return story


def main():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = NumberedDocTemplate(str(OUTPUT))
    doc.build(build_story())
    print(OUTPUT)


if __name__ == "__main__":
    main()

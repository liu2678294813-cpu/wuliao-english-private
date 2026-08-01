from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "无聊英语App上架与盈利路线图.pdf"

NAVY = colors.HexColor("#142B4A")
BLUE = colors.HexColor("#2F6FED")
TEAL = colors.HexColor("#0F8587")
GREEN = colors.HexColor("#2F7D5C")
GOLD = colors.HexColor("#C88B18")
RED = colors.HexColor("#B44141")
INK = colors.HexColor("#26364A")
MUTED = colors.HexColor("#617286")
LINE = colors.HexColor("#CCD8E5")
BG = colors.HexColor("#F5F8FC")
PALE_BLUE = colors.HexColor("#EDF4FF")
PALE_TEAL = colors.HexColor("#EAF7F6")
PALE_GREEN = colors.HexColor("#EDF8F1")
PALE_GOLD = colors.HexColor("#FFF7E6")
PALE_RED = colors.HexColor("#FFF0EF")
WHITE = colors.white

CONTENT_WIDTH = 174 * mm


def register_fonts():
    pdfmetrics.registerFont(TTFont("YaHei", r"C:\Windows\Fonts\msyh.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("YaHei-Bold", r"C:\Windows\Fonts\msyhbd.ttc", subfontIndex=0))
    pdfmetrics.registerFontFamily("YaHei", normal="YaHei", bold="YaHei-Bold")


class RoadmapDocTemplate(BaseDocTemplate):
    def __init__(self, filename):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=21 * mm,
            bottomMargin=18 * mm,
            title="无聊英语 App 上架与盈利路线图",
            subject="基于 2026-07-23 项目实况的发布与商业化执行计划",
            author="Codex",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="body")
        self.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=self.draw_header_footer))

    def draw_header_footer(self, canvas, doc):
        canvas.saveState()
        width, height = A4
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.45)
        canvas.line(18 * mm, height - 14 * mm, width - 18 * mm, height - 14 * mm)
        canvas.setFont("YaHei", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, height - 10.5 * mm, "无聊英语 · 上架与盈利路线图")
        canvas.drawRightString(width - 18 * mm, 9.5 * mm, f"第 {doc.page} 页")
        canvas.drawString(18 * mm, 9.5 * mm, "基于 2026-07-23 项目实况 · 平台规则提交前需再次复核")
        canvas.restoreState()


def make_styles():
    base = getSampleStyleSheet()
    return {
        "cover_title": ParagraphStyle(
            "CoverTitle", parent=base["Title"], fontName="YaHei-Bold",
            fontSize=26, leading=36, textColor=NAVY, alignment=TA_CENTER, spaceAfter=8,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle", parent=base["Normal"], fontName="YaHei",
            fontSize=11.5, leading=19, textColor=MUTED, alignment=TA_CENTER, wordWrap="CJK",
        ),
        "h1": ParagraphStyle(
            "H1", parent=base["Heading1"], fontName="YaHei-Bold",
            fontSize=18, leading=25, textColor=NAVY, spaceAfter=8, wordWrap="CJK",
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName="YaHei-Bold",
            fontSize=12.8, leading=19, textColor=TEAL, spaceBefore=7, spaceAfter=5, wordWrap="CJK",
        ),
        "body": ParagraphStyle(
            "Body", parent=base["BodyText"], fontName="YaHei",
            fontSize=9.2, leading=15.4, textColor=INK, spaceAfter=4.5, wordWrap="CJK",
        ),
        "body_tight": ParagraphStyle(
            "BodyTight", parent=base["BodyText"], fontName="YaHei",
            fontSize=8.6, leading=13.6, textColor=INK, spaceAfter=2.2, wordWrap="CJK",
        ),
        "small": ParagraphStyle(
            "Small", parent=base["BodyText"], fontName="YaHei",
            fontSize=7.8, leading=12.2, textColor=MUTED, spaceAfter=2, wordWrap="CJK",
        ),
        "tiny": ParagraphStyle(
            "Tiny", parent=base["BodyText"], fontName="YaHei",
            fontSize=7.1, leading=10.7, textColor=MUTED, spaceAfter=1.5, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "Callout", parent=base["BodyText"], fontName="YaHei-Bold",
            fontSize=9.8, leading=16.4, textColor=NAVY, wordWrap="CJK",
        ),
        "metric": ParagraphStyle(
            "Metric", parent=base["BodyText"], fontName="YaHei-Bold",
            fontSize=17, leading=22, textColor=BLUE, alignment=TA_CENTER, wordWrap="CJK",
        ),
        "metric_label": ParagraphStyle(
            "MetricLabel", parent=base["BodyText"], fontName="YaHei",
            fontSize=7.8, leading=11.5, textColor=MUTED, alignment=TA_CENTER, wordWrap="CJK",
        ),
        "table_header": ParagraphStyle(
            "TableHeader", parent=base["BodyText"], fontName="YaHei-Bold",
            fontSize=8.4, leading=13.2, textColor=WHITE, wordWrap="CJK",
        ),
        "table_header_center": ParagraphStyle(
            "TableHeaderCenter", parent=base["BodyText"], fontName="YaHei-Bold",
            fontSize=8.4, leading=13.2, textColor=WHITE, alignment=TA_CENTER, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "Table", parent=base["BodyText"], fontName="YaHei",
            fontSize=8.1, leading=12.7, textColor=INK, wordWrap="CJK",
        ),
        "table_center": ParagraphStyle(
            "TableCenter", parent=base["BodyText"], fontName="YaHei",
            fontSize=8.1, leading=12.7, textColor=INK, alignment=TA_CENTER, wordWrap="CJK",
        ),
        "right": ParagraphStyle(
            "Right", parent=base["BodyText"], fontName="YaHei",
            fontSize=8.1, leading=12.7, textColor=INK, alignment=TA_RIGHT, wordWrap="CJK",
        ),
    }


def p(text, style):
    return Paragraph(text, style)


def bullet(text, s, level=0, tight=False):
    style = s["body_tight"] if tight else s["body"]
    indent = "&nbsp;" * (level * 3)
    return p(f"{indent}• {text}", style)


def page_title(index, title, subtitle, s):
    items = [
        p(f"{index:02d}  {title}", s["h1"]),
        HRFlowable(width="100%", thickness=1.0, color=LINE),
    ]
    if subtitle:
        items.extend([Spacer(1, 1.6 * mm), p(subtitle, s["small"])])
    items.append(Spacer(1, 2.7 * mm))
    return items


def callout(text, s, background=PALE_TEAL, border=TEAL):
    box = Table([[p(text, s["callout"])]], colWidths=[CONTENT_WIDTH])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), background),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return box


def metric_cards(cards, s):
    cells = []
    for value, label, color in cards:
        cells.append([
            p(f'<font color="{color}">{value}</font>', s["metric"]),
            p(label, s["metric_label"]),
        ])
    row = []
    for metric, label in cells:
        inner = Table([[metric], [label]], colWidths=[CONTENT_WIDTH / len(cells) - 3 * mm])
        inner.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), WHITE),
            ("BOX", (0, 0), (-1, -1), 0.6, LINE),
            ("TOPPADDING", (0, 0), (-1, 0), 8),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
            ("TOPPADDING", (0, 1), (-1, 1), 2),
            ("BOTTOMPADDING", (0, 1), (-1, 1), 7),
        ]))
        row.append(inner)
    outer = Table([row], colWidths=[CONTENT_WIDTH / len(row)] * len(row))
    outer.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]))
    return outer


def make_table(rows, widths, s, header=True, center_cols=None, font_tight=False):
    center_cols = center_cols or set()
    converted = []
    for r_idx, row in enumerate(rows):
        converted_row = []
        for c_idx, value in enumerate(row):
            if isinstance(value, Paragraph):
                converted_row.append(value)
                continue
            if r_idx == 0 and header:
                style = s["table_header_center"] if c_idx in center_cols else s["table_header"]
            else:
                style = s["table_center"] if c_idx in center_cols else s["body_tight" if font_tight else "table"]
            converted_row.append(p(str(value), style))
        converted.append(converted_row)
    table = Table(converted, colWidths=widths, repeatRows=1 if header else 0, splitByRow=1)
    commands = [
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5.5),
        ("TOPPADDING", (0, 0), (-1, -1), 5.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.5),
    ]
    if header:
        commands.extend([
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, BG]),
        ])
    else:
        commands.append(("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, BG]))
    table.setStyle(TableStyle(commands))
    return table


def source_item(number, label, url, s):
    safe_label = escape(label)
    safe_url = escape(url)
    return p(
        f'<b>{number}. {safe_label}</b><br/>'
        f'<link href="{safe_url}" color="#0F8587">{safe_url}</link>',
        s["tiny"],
    )


def build_story():
    s = make_styles()
    story = []

    # Cover
    story.extend([
        Spacer(1, 23 * mm),
        p("无聊英语 App", s["cover_title"]),
        p("上架与盈利路线图", s["cover_title"]),
        Spacer(1, 5 * mm),
        p("基于当前网页端、Capacitor Android 工程和商业化缺口的 12 周执行计划", s["cover_subtitle"]),
        p("版本：2026-07-23 · 对应项目：D:\\codex库\\无聊英语", s["cover_subtitle"]),
        Spacer(1, 10 * mm),
        callout(
            "核心结论：你的产品不是从零开始，真正的瓶颈已经从“功能开发”转成“移动端验收、内容与字体授权、正式签名、计费合规、商店材料和用户验证”。先完成 Android 可收费版本；第一阶段卖软件工作流，不卖授权不清的资料；真实付费出现后再投入账号、云同步、AI 与 iOS。",
            s,
        ),
        Spacer(1, 9 * mm),
        metric_cards([
            ("12 周", "完成 Android 商业版的建议周期", "#2F6FED"),
            ("30–50 人", "第一轮有效目标用户内测", "#0F8587"),
            ("30 单", "验证付费意愿的第一里程碑", "#2F7D5C"),
        ], s),
        Spacer(1, 9 * mm),
        p("<b>推荐顺序</b>", s["h2"]),
        bullet("网页/PWA + 签名测试 APK 验证真实使用；不先买广告。", s),
        bullet("同步最新网页功能到 Android，做 3 台以上真机验收并生成正式 AAB。", s),
        bullet("版权与字体授权通过后，再配置商店内购和正式上架。", s),
        bullet("达到 30 个真实付费用户后，再决定云同步、跨用户排行榜与 iOS。", s),
        Spacer(1, 5 * mm),
        callout(
            "盈利不是“上架后自然发生”。本计划把盈利拆成四个闸门：能安装 → 能稳定使用 → 能合法收费 → 能持续获客。任何一关不过，都不扩大投入。",
            s,
            PALE_GOLD,
            GOLD,
        ),
        PageBreak(),
    ])

    # Current project snapshot
    story += page_title(1, "当前项目实况", "以下结论来自本地工程检查与现有线上地址核验，不是泛化建议。", s)
    story.append(metric_cards([
        ("54.2 MiB", "当前 dist 体积", "#2F6FED"),
        ("API 36", "Android target/compile SDK", "#2F7D5C"),
        ("0 个", "当前可交付 APK / AAB", "#B44141"),
        ("200", "现有 Netlify 站点响应", "#0F8587"),
    ], s))
    story.extend([Spacer(1, 5 * mm)])
    current_rows = [
        ["维度", "当前已具备", "仍缺少 / 风险", "成熟度"],
        ["核心产品", "Vite/React 网页；66 份精读资源；本机段位；订正；自动发音；PDF/Excel/CSV 词库导入；本地复习记录。", "最新功能尚未同步到 Android；还没有移动端整体验收。", "4 / 5"],
        ["Android 工程", "Capacitor 8.4.2；包名 com.wuliao.english；minSdk 24；target/compile SDK 36；Gradle/JDK/SDK 路径已准备。", "没有 debug/release APK；没有 AAB；release 未配置签名；版本仍为 1.0 / code 1。", "2 / 5"],
        ["数据与账号", "学习记录以 IndexedDB/本机存储为主；原始资料不上云，隐私优势明显。", "没有账号、云同步、服务端校验、购买权益恢复或跨设备迁移。", "2 / 5"],
        ["分发", "Netlify 站点可访问；Capacitor 构建脚本存在。", "项目不是 Git 仓库；没有正式商店条目、签名密钥、内测轨道和更新流程。", "1 / 5"],
        ["合规与收费", "当前权限极少，Android Manifest 主要只有 INTERNET。", "未发现隐私政策、服务协议、商店数据声明、支付/订阅、账号注销、备案或软件著作权材料。", "1 / 5"],
        ["商业验证", "功能定位清晰，精读—订正—复习闭环有差异化。", "没有可复核的活跃、留存、付费转化、退款或客服数据。", "1 / 5"],
    ]
    story.append(make_table(current_rows, [25 * mm, 61 * mm, 67 * mm, 21 * mm], s, center_cols={3}, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "判断：代码层面约处于“可进入移动端内测”，商业层面仍处于“收费前准备”。最短路径不是继续堆新功能，而是把现有能力变成一个可安装、可恢复、可审核、可收款的版本。",
            s,
            PALE_BLUE,
            BLUE,
        ),
        Spacer(1, 4 * mm),
        p("<b>已核对的工程证据</b>", s["h2"]),
        bullet("capacitor.config.json：webDir=dist，appId=com.wuliao.english。", s, tight=True),
        bullet("android/variables.gradle：minSdk=24，compileSdk=36，targetSdk=36。", s, tight=True),
        bullet("android/app/build.gradle：release 尚无 signingConfig，versionCode=1。", s, tight=True),
        bullet("android/app/build/outputs 下未发现 APK/AAB；现有构建脚本只生成 debug APK。", s, tight=True),
        bullet("线上地址 https://wuliao-english-mobile.netlify.app 当前返回 HTTP 200，但不代表包含本轮最新功能。", s, tight=True),
        PageBreak(),
    ])

    # Product strategy
    story += page_title(2, "最终目标与产品边界", "先定义“什么算完成”，避免上架、盈利和功能扩张互相拖累。", s)
    story.append(callout(
        "建议的 6 个月目标：完成 Android 商业版；获得至少 30 个真实付费用户验证付费意愿；把可归因的商店净收入做成正数；再以 100 个累计付费用户为第二里程碑。这里的数字是管理目标，不是收益承诺。",
        s,
    ))
    story.extend([Spacer(1, 4 * mm), p("产品定位", s["h2"])])
    story.append(make_table([
        ["要素", "建议定义"],
        ["目标用户", "正在准备考研英语、手里已有真题/资料，但难以坚持完整精读闭环的学生。"],
        ["核心承诺", "把审题、限时阅读、逐句笔译、订正、重做、第二天复读与单词复习放进同一工作台。"],
        ["北极星指标", "每周完成的“闭环精读篇数”，而不是打开次数、在线时长或单纯背词数量。"],
        ["第一商品", "Local Pro：一次性解锁本地高级工作流；不依赖账号、服务器和 AI。"],
        ["后续商品", "Cloud Pro：只有在云备份、跨设备同步、持续更新的合法内容真正存在后，才收年费。"],
    ], [34 * mm, 140 * mm], s))
    story.extend([Spacer(1, 4 * mm), p("版本边界", s["h2"])])
    version_rows = [
        ["版本", "必须包含", "明确不包含", "进入条件"],
        ["v0.9 内测", "现有精读/单词/本机段位；Android 真机稳定；数据可导出。", "支付、账号、AI、全站榜。", "3 台真机无 P0 数据丢失。"],
        ["v1.0 商业版", "Local Pro 内购；恢复购买；隐私/支持页面；正式签名 AAB；原创或授权样例。", "账号、云同步、AI 翻译、社交。", "版权闸门通过；30–50 人内测。"],
        ["v1.1 云同步", "可选账号、同步、注销、删除数据、服务端权益校验。", "无限 AI、复杂社区。", "≥30 个付费用户，且同步是高频请求。"],
        ["v2.0 增长版", "合法持续内容、周榜/好友榜、按需 AI 译注。", "无限用量承诺。", "留存和毛利足以覆盖运维。"],
    ]
    story.append(make_table(version_rows, [24 * mm, 61 * mm, 49 * mm, 40 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "为什么 v1 不做账号：当前本地优先已经能交付核心价值。账号会立刻引入身份验证、找回、数据删除、云端安全、备案与持续服务器成本；它应该由付费用户需求触发，而不是由“看起来像正式 App”触发。",
            s,
            PALE_GOLD,
            GOLD,
        ),
        PageBreak(),
    ])

    # P0 blockers
    story += page_title(3, "收费前的 P0 闸门", "下面五项比新增功能更重要；任一未通过，都可能导致下架、投诉或无法更新。", s)
    blocker_rows = [
        ["优先级", "闸门", "当前证据", "必须完成的动作"],
        ["P0", "内容版权", "App 内有 66 份处理后的真题/精读 PDF、答案表和词库；尚未看到可商业分发的授权链。", "逐项记录来源、权利人、许可范围、证明文件。无法证明的内容不随商业包分发，改为用户自行导入或自制原创样例。"],
        ["P0", "字体授权", "public/vocabulary/fonts/simhei.ttf 约 9.3 MiB，未发现再分发授权证明。", "若无明确商用再分发许可，替换为可随 App 分发的开源字体，并保留许可证与版权声明。"],
        ["P0", "第三方许可证", "包含 PDF.js、Tesseract、SheetJS、Capacitor 等依赖和模型/字体资产。", "生成依赖清单；核查许可、NOTICE 与源码/署名义务；移除未使用或来源不明的二进制。"],
        ["P0", "正式签名与数据迁移", "没有 release keystore、签名 AAB、升级测试和数据恢复方案。", "创建 upload key；离线双备份；不提交到 Git；测试覆盖安装、升级、卸载、恢复购买与数据导出。"],
        ["P0", "隐私与交易", "没有隐私政策、用户协议、商品说明、退款说明和商店数据声明。", "按真实行为写政策；最小化数据；明确本地/云端边界；数字权益使用目标商店允许的支付方式。"],
    ]
    story.append(make_table(blocker_rows, [17 * mm, 28 * mm, 58 * mm, 71 * mm], s, center_cols={0}, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "最重要的商业决策：如果 66 份资料的商业授权暂时拿不到，产品仍然可以上架——把卖点改成“精读工作流 + 用户自带资料 + 原创示范内容”。不要让内容授权成为整个软件产品的单点失败。",
            s,
            PALE_RED,
            RED,
        ),
        Spacer(1, 4 * mm),
        p("建议建立的版权台账字段", s["h2"]),
        bullet("文件/内容名称、来源 URL、作者/机构、取得日期、许可类型、是否允许修改与商业分发。", s, tight=True),
        bullet("截图/PDF/邮件等证明的保存位置；商店审核时可立即提供。", s, tight=True),
        bullet("无法确认的项目标为“禁止打包”，构建发布版时自动排除。", s, tight=True),
        PageBreak(),
    ])

    # Channel strategy
    story += page_title(4, "上架渠道策略", "验证渠道与赚钱渠道不是同一件事；先按用户所在地和设备占比分流。", s)
    channel_rows = [
        ["渠道", "当前作用", "公开成本/要求", "主要限制", "建议"],
        ["Netlify 网页/PWA", "立即做产品验证、收集等待名单、演示完整流程。", "现有站点可访问；当前无需商店账户。", "安装感、离线、支付、文件与系统能力不等同原生 App。", "现在继续使用。"],
        ["签名测试 APK", "真实 Android 设备内测。", "本地构建可免费；自行分发。", "安装提示、更新困难，不适合作为长期公开商业渠道。", "第 1–2 周完成。"],
        ["Google Play", "海外/可使用 Play 的 Android 用户；统一测试、更新、内购。", "完整分发一次性 25 美元；新个人账户通常需 12 人连续 14 天封闭测试；新 App 使用 AAB。", "中国大陆目标用户覆盖有限；平台规则与服务费依地区/项目变化。", "有海外用户再开完整分发。"],
        ["华为 / 小米等国内商店", "触达中国大陆 Android 用户。", "需主体认证、APP 备案和渠道材料；小米公开要求软著/电子版权与 APP 备案。", "渠道分散；内购、资质和审核逐家适配。", "若内测 Android 占比高，作为主要商业路径。"],
        ["Apple App Store", "覆盖 iPhone/iPad 用户，支付与更新统一。", "Apple Developer Program 99 美元/年；需 Xcode/Mac；审核与 IAP。", "当前 Windows 环境没有 iOS 构建链。", "付费验证或 iPhone 等待名单足够后再做。"],
    ]
    story.append(make_table(channel_rows, [28 * mm, 38 * mm, 48 * mm, 38 * mm, 22 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "推荐决策：先用网页 + Android 测试包招募同一批目标学生。若内测活跃用户中 Android ≥60%，优先国内 Android 商店；若 iPhone 等待名单 ≥40% 且愿意付费，再安排 Mac/Xcode 与 Apple 会员。Google Play 只在你确实要触达其可用地区时成为主线。",
            s,
            PALE_BLUE,
            BLUE,
        ),
        Spacer(1, 4 * mm),
        p("与你当前工程直接相关的好消息", s["h2"]),
        bullet("targetSdk 36 已满足 Google Play 自 2026-08-31 起对新 App/更新的 Android 16（API 36）要求。", s, tight=True),
        bullet("当前包名已固定为 com.wuliao.english；首次注册商店前再确认品牌，因为 Google Play 包名是长期标识。", s, tight=True),
        bullet("2026 年 8 月将推出的 Android 免费有限分发最多 20 台设备，且账户计划不能直接更改；它不适合你的公开盈利目标。", s, tight=True),
        PageBreak(),
    ])

    # Roadmap weeks 1-4
    story += page_title(5, "12 周路线图：第 1–4 周", "假设每周可投入 15–20 小时；若更少，请把周期拉长到 16–20 周，不要压缩验收。", s)
    roadmap_1 = [
        ["周次 / 日期", "目标", "具体动作", "交付物与退出条件"],
        ["第 1 周<br/>7/24–7/30", "冻结 v0.9 与建立发布基线", "建立本地 Git 仓库和完整备份；确认包名/应用名；记录当前网页构建；在明确授权后把最新网页产物同步到 Android；执行 debug 构建。", "可安装 debug APK；版本基线可回退；工程和用户数据均有备份。"],
        ["第 2 周<br/>7/31–8/6", "移动端真机验收", "至少 3 台 Android：文件导入、PDF.js worker、OCR、自动发音、IndexedDB、笔/触控、键盘、返回键、前后台切换、横竖屏、离线重启。", "0 个 P0 数据丢失；P1 问题有清单和负责人；首次学习流程可完整跑通。"],
        ["第 3 周<br/>8/7–8/13", "版权与隐私闸门", "审计 66 份 PDF、答案表、词库、SimHei 与 npm/二进制依赖；决定商业包内容；起草隐私政策、服务协议、支持页与版本说明。", "每个随包内容都有许可证明或被排除；政策文字与真实数据流一致。"],
        ["第 4 周<br/>8/14–8/20", "正式发布工程", "创建 upload key 并离线双备份；配置 release signing；生成签名 AAB；设置版本号；压缩冗余 OCR/字体；准备崩溃与日志最小方案。", "签名 AAB 可验证；从 release 包安装/升级成功；目标首装体积与性能达标。"],
    ]
    story.append(make_table(roadmap_1, [31 * mm, 35 * mm, 67 * mm, 41 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 6 * mm),
        p("第 1 个强制 Gate", s["h2"]),
        callout(
            "只有当 release 构建能在 3 台设备完成“导入资料 → 精读 → 订正 → 记录保存 → 单词复习 → 重启后恢复”，才进入付费和商店工作。不能用网页测试结果代替原生壳测试。",
            s,
            PALE_GREEN,
            GREEN,
        ),
        Spacer(1, 4 * mm),
        p("本阶段不要做", s["h2"]),
        bullet("不要同时引入账号、短信登录、全站排行榜或 AI 翻译。", s, tight=True),
        bullet("不要把 release keystore、密码、API key 或商店凭据放入仓库。", s, tight=True),
        bullet("不要在内容授权没有结论时制作以“完整真题库”为卖点的商店文案。", s, tight=True),
        PageBreak(),
    ])

    # Roadmap weeks 5-8
    story += page_title(6, "12 周路线图：第 5–8 周", "这一阶段把“能用”变成“能审核、能付费、能获得可信数据”。", s)
    roadmap_2 = [
        ["周次 / 日期", "目标", "具体动作", "交付物与退出条件"],
        ["第 5 周<br/>8/21–8/27", "商品与购买闭环", "配置 Local Pro 非消耗型商品；实现购买、恢复购买、取消/失败提示；免费层保留完整体验样例；付费权益不依赖来源不明内容。", "沙盒购买和恢复通过；换设备/重装后的权益行为符合平台规则。"],
        ["第 6 周<br/>8/28–9/3", "商店壳与国内材料并行", "准备图标、功能截图、短/长描述、隐私 URL、支持 URL、数据声明、年龄分级、审核说明。若走国内商店，同步启动 APP 备案、软著/电子版权与商户材料。", "目标商店后台材料完成 80%；国内资质状态有明确时间表。"],
        ["第 7 周<br/>9/4–9/10", "封闭测试第 1 周", "招募 30–50 名目标用户；Google 新个人账户至少确保 12 名测试者持续加入；每人完成一个真实精读闭环；只记录必要聚合事件。", "激活率、首篇完成率、崩溃与 P0/P1 问题可复核。"],
        ["第 8 周<br/>9/11–9/17", "封闭测试第 2 周", "维持 Google 12 人连续 14 天要求；修复数据损坏、支付和阻断问题；访谈退出用户；冻结 v1.0 候选版本。", "0 个 P0；关键 P1 关闭；内测报告和 v1.0 发布说明完成。"],
    ]
    story.append(make_table(roadmap_2, [31 * mm, 35 * mm, 67 * mm, 41 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 6 * mm),
        p("第 2 个强制 Gate", s["h2"]),
        callout(
            "上架提交前同时满足：版权台账通过、签名 AAB 通过、购买/恢复通过、隐私政策与真实数据行为一致、30–50 人完成有效内测、Google 适用时满足 12 人/14 天。少一项都不抢发。",
            s,
            PALE_GREEN,
            GREEN,
        ),
        Spacer(1, 4 * mm),
        p("内测数据最小化", s["h2"]),
        bullet("只收集匿名安装版本、设备/系统大类、页面到达、闭环完成、购买结果、崩溃类型。", s, tight=True),
        bullet("不采集原 PDF、笔记内容、笔迹、具体单词、答案文本或公开邮箱。", s, tight=True),
        bullet("反馈表与分析事件分开；用户可选择不参与诊断。", s, tight=True),
        PageBreak(),
    ])

    # Roadmap weeks 9-12 and months 4-6
    story += page_title(7, "12 周路线图：第 9–12 周与后续", "正式发布采取小流量放量；盈利验证看净收入与留存，不看下载量。", s)
    roadmap_3 = [
        ["周次 / 日期", "目标", "动作", "成功条件"],
        ["第 9 周<br/>9/18–9/24", "发布候选与定价实验", "提交目标商店预审；修复审核问题；在内测用户中比较 39/49/59 元一次性 Local Pro 的支付意愿和价值描述。", "定下一个主价格；审核材料无明显缺口。"],
        ["第 10 周<br/>9/25–10/1", "首个正式渠道上架", "先上一个最符合目标用户的渠道；保留 10%–20% 分阶段发布；准备退款、客服、版本回退和公告模板。", "商店可下载；购买成功；线上版本与签名版本一致。"],
        ["第 11 周<br/>10/2–10/8", "首批付费用户", "发布 3 个功能演示内容；所有入口指向同一免费体验；每天检查崩溃、支付、评价和反馈。", "首次获得可归因付费；没有规模性数据丢失或支付故障。"],
        ["第 12 周<br/>10/9–10/15", "复盘与下一阶段决策", "计算激活、D7、首篇完成、付费转化、退款、商店净收入和客服工时；决定继续、修复或暂停。", "达到下页 Gate 才扩大渠道/功能。"],
    ]
    story.append(make_table(roadmap_3, [31 * mm, 35 * mm, 67 * mm, 41 * mm], s, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("第 4–6 个月", s["h2"])])
    months_rows = [
        ["里程碑", "达到时做什么", "未达到时做什么"],
        ["30 个真实付费用户", "访谈至少 10 人；确认购买原因；按请求优先修复，不立刻扩品类。", "停止新增大功能；重做定位、免费样例与首日流程。"],
        ["100 个累计付费用户", "评估 Cloud Pro：账号、同步、数据删除、服务端权益与稳定后端。", "保持 Local Pro；不承担持续云成本。"],
        ["iPhone 等待名单 ≥40% 或明确付费需求", "安排 Mac/Xcode、Apple 会员与 TestFlight；复用已通过的合规材料。", "继续 Android，不为“平台齐全”而支付年度成本。"],
        ["D30 付费留存与持续价值成立", "测试年费 68–98 元；提供真实持续服务。", "不收订阅，只保留一次性本地版。"],
    ]
    story.append(make_table(months_rows, [40 * mm, 71 * mm, 63 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "不要用“已经投入很多时间”作为继续投入的理由。每个阶段都只看下一道闸门是否通过：用户是否完成、是否回来、是否付费、净收入是否覆盖新增成本。",
            s,
            PALE_GOLD,
            GOLD,
        ),
        PageBreak(),
    ])

    # Android technical checklist
    story += page_title(8, "Android 正式发布技术清单", "这是从当前工程到商店可交付物之间的具体差距。", s)
    technical_rows = [
        ["模块", "当前状态", "发布标准"],
        ["同步与构建", "最新网页改动尚未同步；脚本只构建 debug APK。", "pnpm build → cap sync android → debug 真机 → signed release AAB；每次发布可重复。"],
        ["签名与版本", "release 无 signingConfig；versionCode 1。", "upload key 离线双备份；凭据不入库；每版递增 versionCode；保存证书指纹。"],
        ["数据生命周期", "IndexedDB 为主，网页路径已验证。", "首次安装、升级、强退、系统回收、离线、卸载、重装、导出/导入均有预期；升级不丢数据。"],
        ["文件与 OCR", "PDF/Excel/CSV、PDF.js、Tesseract 依赖较多。", "Android 文件选择器与 URI 权限可用；扫描 PDF 有明确进度/失败提示；OCR 可按需加载。"],
        ["触控与输入", "网页已做触控/笔分流。", "至少一台平板 + 一台手机验证手写、手指滚动、缩放、软键盘、返回键和安全区。"],
        ["语音", "使用系统 speechSynthesis。", "无英文语音包时友好提示；切后台不重复播；开关持久化。"],
        ["支付", "尚无 Billing/IAP。", "购买、失败、取消、恢复、退款后权益变化、离线校验与异常日志可测。"],
        ["质量", "网页构建与浏览器流程通过，但无 release 移动验收。", "0 P0；崩溃可定位；首屏/核心操作在中端机可接受；商店预发布报告无阻断。"],
    ]
    story.append(make_table(technical_rows, [30 * mm, 62 * mm, 82 * mm], s, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("体积与性能优化", s["h2"])])
    size_rows = [
        ["当前发现", "处理建议", "目标"],
        ["dist 约 54.2 MiB；SimHei 约 9.3 MiB；存在多份 OCR wasm/core 与 traineddata。", "替换/移除授权不明字体；只保留实际使用的 OCR 核心；语言包按需下载并缓存；内置资料允许首启后下载。", "AAB 能通过商店；首装尽量 <80 MiB；OCR 不阻塞首屏；低存储设备有清理入口。"],
    ]
    story.append(make_table(size_rows, [55 * mm, 73 * mm, 46 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "发布密钥是长期资产：丢失、泄漏或被提交到公开仓库都会影响后续更新。建议加密 U 盘 + 独立离线备份各一份，另保存别名、证书指纹与恢复流程。",
            s,
            PALE_RED,
            RED,
        ),
        PageBreak(),
    ])

    # Compliance/store listing
    story += page_title(9, "合规与商店材料", "按“当前本地版”和“未来账号版”分别准备，避免政策写得比实际功能多或少。", s)
    compliance_rows = [
        ["材料/能力", "v1.0 本地版", "v1.1 账号版增量"],
        ["隐私政策", "说明本地存储、文件仅本机解析、必要网络请求、崩溃/分析数据与联系渠道。", "增加账号标识、同步内容、处理目的、保存期、处理方、跨境/境内托管说明。"],
        ["用户协议", "功能范围、知识产权、用户自带资料责任、付费权益、退款依平台、禁止滥用。", "增加账号安全、云端服务可用性、违规处理与终止条款。"],
        ["删除与导出", "提供学习数据导出、清空本地数据与卸载说明。", "App 内提供注销入口并删除云端数据；满足 Apple/Google 账号删除要求。"],
        ["商店数据声明", "逐项核对 SDK；不根据理想设计填写，必须与 release 包真实网络行为一致。", "加入认证、同步和服务器日志的数据类别与用途。"],
        ["审核材料", "截图、图标、描述、测试说明、权限解释、样例文件、支持/隐私 URL。", "提供可用审核账号或完整演示模式，审核期间后端保持可用。"],
        ["中国大陆上架", "主体一致、APP 备案、备案号展示；小米等渠道要求软著/电子版权；数字商品开通商户/支付能力。", "境内后端、域名/IP、实名与数据处理材料随架构更新。"],
    ]
    story.append(make_table(compliance_rows, [34 * mm, 70 * mm, 70 * mm], s, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("商店素材包", s["h2"])])
    material_rows = [
        ["资产", "完成标准"],
        ["品牌", "最终中文名、英文名、1024×1024 主图标、启动图、颜色与字体规范。"],
        ["截图", "至少覆盖首页、精读闭环、订正、手写/键盘、单词复习、导入和隐私；使用测试数据。"],
        ["文案", "一句定位、短描述、完整描述、3 个可验证差异点、版本说明；不承诺提分结果。"],
        ["支持", "公开支持邮箱、FAQ、隐私政策、用户协议、退款说明、问题反馈入口。"],
        ["审核", "功能路径、样例资料、购买商品说明、账号/无账号说明、特殊硬件或文件操作指引。"],
    ]
    story.append(make_table(material_rows, [34 * mm, 140 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "中国大陆备案、软件著作权、商户结算主体与税务处理取决于你的主体和渠道。这里给的是工作清单，不是法律或税务结论；正式收费前应按目标商店后台和所在地专业意见确认。",
            s,
            PALE_GOLD,
            GOLD,
        ),
        PageBreak(),
    ])

    # Pricing
    story += page_title(10, "收费结构：先卖本地价值，再卖持续服务", "价格需要测试；下面是适合当前技术结构的起始方案。", s)
    pricing_rows = [
        ["层级", "建议价格", "包含", "为什么这样设计"],
        ["免费版", "0 元", "用户自带资料导入；1 套原创/授权完整示范；基础精读与单词体验；本地数据导出。", "让用户在付款前完成一次真正的闭环，而不是只看功能截图。"],
        ["Local Pro", "一次性 49 元<br/>测试范围 39–59 元", "无限本地资料、完整精读工作流、高级统计、本机段位、完整导入与复习能力；不含云端和 AI。", "当前价值不依赖持续服务器，先用一次性商品验证付费，减少订阅反感与运维负担。"],
        ["Cloud Pro", "78 元/年<br/>测试范围 68–98 元", "跨设备同步、云备份、持续更新的合法内容、服务端权益与支持。", "只有真实持续服务存在时才收费；不把一次性本地能力强行订阅化。"],
        ["AI 用量包", "后续单独定价", "按段翻译/解释；额度、缓存、月上限和成本日志。", "AI 是变量成本，必须独立限额；v1 成本为 0。"],
    ]
    story.append(make_table(pricing_rows, [30 * mm, 30 * mm, 72 * mm, 42 * mm], s, center_cols={1}, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("免费与付费边界", s["h2"])])
    boundary_rows = [
        ["免费必须足够完整", "付费必须有清晰增量", "禁止的做法"],
        ["允许完整体验一篇；支持用户导入；数据可导出；不靠强制注册。", "节省重复操作、无限本地使用、完整统计、合法持续内容或云服务。", "把用户数据锁在付费墙后；以授权不明内容收费；承诺“永久无限 AI”；利用焦虑强制订阅。"],
    ]
    story.append(make_table(boundary_rows, [58 * mm, 58 * mm, 58 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "推荐首个商品：Local Pro 49 元一次性。首批 30 单的任务不是赚钱最大化，而是回答三个问题：谁愿意付、为什么付、付完后是否继续用。没有这三条证据，不增加订阅、云或 AI。",
            s,
            PALE_GREEN,
            GREEN,
        ),
        Spacer(1, 4 * mm),
        p("价格实验规则", s["h2"]),
        bullet("一次只改价格或文案中的一个变量；至少观察 2 周。", s, tight=True),
        bullet("记录激活用户到购买的转化，不用总下载量做分母。", s, tight=True),
        bullet("退款和客服时间也算成本；低价但高支持需求可能更不赚钱。", s, tight=True),
        PageBreak(),
    ])

    # Profit math
    story += page_title(11, "盈利模型与成本预算", "以下均为规划算例，商店服务费按 15% 作保守简化；税费、退款、汇率和各地区新规则另计。", s)
    story.append(metric_cards([
        ("¥41.65", "49 元商品扣 15% 后的简化净额", "#2F6FED"),
        ("¥66.30", "78 元年费扣 15% 后的简化净额", "#0F8587"),
        ("¥0", "v1 计划中的 AI 成本", "#2F7D5C"),
    ], s))
    story.extend([Spacer(1, 5 * mm)])
    profit_rows = [
        ["场景", "付费规模", "含税前流水", "扣 15% 后", "还未扣除"],
        ["A：验证期", "300 × Local Pro 49 元", "14,700 元", "12,495 元", "退款、税费、合规、营销、客服与工时"],
        ["B：小规模年费", "1,000 × Cloud Pro 78 元", "78,000 元", "66,300 元", "后端、退款、税费、内容与支持"],
        ["C：稳定产品", "3,000 × Cloud Pro 78 元", "234,000 元", "198,900 元", "同上；规模扩大还会增加运维"],
    ]
    story.append(make_table(profit_rows, [32 * mm, 43 * mm, 31 * mm, 31 * mm, 37 * mm], s, center_cols={2, 3}, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("快速盈亏换算", s["h2"])])
    formula = (
        "<b>真实盈亏平衡用户数</b> = （商店费 + 后端 + 合规/IP + 内容 + 营销 + 目标工时成本）"
        " ÷ （单价 ×〔1 − 商店费率 − 退款率 − 税负〕− 单用户变量成本）"
        "<br/><font size=\"8\">快速参考：每 1,000 元固定/工时成本约需 25 单 Local Pro 或 16 名年费用户；"
        "获得 10,000 元约需 241 单或 151 名年费用户。均未计其他成本。</font>"
    )
    story.append(callout(formula, s, PALE_BLUE, BLUE))
    story.extend([Spacer(1, 5 * mm), p("可预见成本", s["h2"])])
    cost_rows = [
        ["项目", "当前公开价格 / 预算方式", "何时支付"],
        ["Google 完整分发", "一次性 25 美元。", "确定需要 Google Play 公开分发时。"],
        ["Apple 开发者计划", "99 美元/年，地区价格可能不同。", "iPhone 需求和 Mac 构建条件成立时。"],
        ["Supabase", "Free 0 美元；生产 Pro 从 25 美元/月。", "v1 不需要；云同步成为付费价值后。"],
        ["OpenAI API", "按 token 用量；不同模型价差大。", "v1 设为 0；只在 AI 商品和服务端限额完成后。"],
        ["国内资质/主体/税务", "差异大，不在本计划编造统一金额。", "确定商店和开发者主体后逐项询价。"],
        ["你的工时", "每周记录开发、客服、内容和运营小时 × 你的目标时薪。", "从现在开始计入，否则“盈利”会被高估。"],
    ]
    story.append(make_table(cost_rows, [39 * mm, 83 * mm, 52 * mm], s, font_tight=True))
    story.append(PageBreak())

    # KPIs and gates
    story += page_title(12, "指标、闸门与停止条件", "这些是建议的内部阈值，不是行业基准；用途是帮助你做下一步决策。", s)
    kpi_rows = [
        ["指标", "定义", "建议阈值", "低于阈值时"],
        ["有效内测人数", "完成至少一次真实学习闭环的目标用户。", "30–50 人", "继续招募，不做商店规模投放。"],
        ["激活率", "新用户 24 小时内完成首篇关键流程。", "≥60%", "缩短首页、样例选择和首次操作。"],
        ["首篇闭环完成率", "开始精读者完成订正/保存/复习入口。", "≥50%", "定位中断步骤，不新增内容。"],
        ["D7 留存", "第 7 天前后再次完成学习动作。", "≥25%", "先修复复习提醒、进度可见与数据可靠性。"],
        ["付费转化", "激活用户 14 天内购买。", "≥5%", "访谈价值、边界与价格；不要先降到极低价。"],
        ["退款率", "已付款订单中退款比例。", "<5%", "检查承诺、购买页、兼容性与价值落差。"],
        ["崩溃稳定性", "无崩溃会话比例。", "≥99.5%", "暂停放量，优先修复 release 端问题。"],
        ["首响时间", "工作日首次回应支持请求。", "<24 小时", "减少渠道、完善 FAQ 与自动收集诊断。"],
    ]
    story.append(make_table(kpi_rows, [29 * mm, 65 * mm, 28 * mm, 52 * mm], s, center_cols={2}, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("四道经营 Gate", s["h2"])])
    gate_rows = [
        ["Gate", "通过条件", "通过后才能做"],
        ["G1 可发布", "3 台真机全流程；0 P0；signed AAB；升级不丢数据。", "进入封闭测试。"],
        ["G2 可收费", "版权/字体/第三方许可通过；购买恢复通过；政策与数据流一致。", "开启 Local Pro。"],
        ["G3 可放量", "30–50 人内测；激活 ≥60%；D7 ≥25%；无规模性投诉。", "扩大商店渠道与内容营销。"],
        ["G4 可扩张", "30 个付费用户；付费原因明确；净收入为正；支持负担可控。", "讨论账号、同步、iOS 与 AI。"],
    ]
    story.append(make_table(gate_rows, [25 * mm, 91 * mm, 58 * mm], s, center_cols={0}, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "停止条件：连续两轮各 30 名有效内测用户，激活仍 <40%；或 100 名激活用户中不足 3 人愿意按任何合理价格付费；或合法内容/主体条件无法落地。满足时暂停扩建，改定位或保留为个人工具。",
            s,
            PALE_RED,
            RED,
        ),
        PageBreak(),
    ])

    # Marketing
    story += page_title(13, "获客与首发运营", "先证明“自然流量也有人完成并付费”，再考虑广告。", s)
    story.append(callout(
        "统一主张：<b>不是多做题，是把一篇真题真正吃透。</b><br/>副标题：从审题、限时阅读、逐句笔译，到订正、重做与第二天复读，把零散步骤连成可坚持的精读闭环。",
        s,
    ))
    story.extend([Spacer(1, 5 * mm), p("首发漏斗", s["h2"])])
    funnel_rows = [
        ["阶段", "用户看到什么", "你记录什么", "下一步优化"],
        ["触达", "30–60 秒具体痛点演示；一条内容只讲一个功能。", "播放完成、链接点击。", "开头是否说中真实问题。"],
        ["落地页", "一句价值、3 个差异点、90 秒流程、隐私说明、免费开始。", "访问 → 开始体验。", "删除术语和功能堆砌。"],
        ["激活", "一套干净样例，直接进入完整精读；不强制注册。", "开始 → 完成首篇。", "找出最大中断步骤。"],
        ["付费", "明确免费/Local Pro 边界和一次性价格；可恢复购买。", "激活 → 购买 → 退款。", "访谈买与不买的原因。"],
        ["留存", "第二天复读、3/3 单词日期复习、可见进度。", "D1/D7/D30 与闭环数。", "让复习有价值，不靠骚扰通知。"],
    ]
    story.append(make_table(funnel_rows, [25 * mm, 59 * mm, 43 * mm, 47 * mm], s, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("前 30 天内容计划", s["h2"])])
    content_rows = [
        ["内容", "画面重点", "行动按钮"],
        ["视频 1：为什么做完真题仍不会", "审题 → 读文 → 第一次作答 → 红色订正。", "免费完成一篇。"],
        ["视频 2：手写与键盘不冲突", "笔写批注、手指滚动、键盘笔译、本机保存。", "领取测试包/加入等待名单。"],
        ["视频 3：单词不是刷完就结束", "3/3 黑线、按日期复习、自动发音开关、导入自己的词库。", "开始本地复习。"],
        ["用户案例", "只展示获授权的真实流程与节省的操作，不承诺提分。", "查看完整学习流程。"],
    ]
    story.append(make_table(content_rows, [45 * mm, 84 * mm, 45 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "广告 Gate：自然来源至少获得 100 个激活用户、付费转化 ≥5%、D7 ≥25% 后再测试小额投放。否则广告只会放大漏斗问题。",
            s,
            PALE_GOLD,
            GOLD,
        ),
        PageBreak(),
    ])

    # Risks
    story += page_title(14, "风险登记与当前不做清单", "把风险写成触发条件和应对动作，避免它们在上架前突然变成阻断。", s)
    risk_rows = [
        ["风险", "概率/影响", "预警信号", "应对"],
        ["内容或字体授权", "高 / 极高", "无法提供许可证明；商店要求补充；权利人投诉。", "商业包排除；改用户导入和原创样例；保留版权台账。"],
        ["移动端数据丢失", "中 / 极高", "升级、系统回收、存储清理后记录消失。", "数据版本迁移、导出备份、真机生命周期测试；未解决不收费。"],
        ["商店拒审/支付违规", "中 / 高", "商品说明模糊、数字权益绕过平台支付、数据声明不一致。", "用商店 IAP；审核说明清晰；release 包与政策逐项复核。"],
        ["体积与性能", "中 / 中", "OCR 首屏卡顿、低端机崩溃、下载转化低。", "按需加载 OCR/资料；删除重复资产；真实中端机性能预算。"],
        ["服务器与账号拖延", "高 / 中", "大量时间消耗在验证码、找回、同步冲突。", "v1 无账号；30 个付费用户后再立项。"],
        ["AI 成本与密钥泄漏", "中 / 高", "客户端出现 API key；无额度；异常用量。", "v1 不接 AI；后续服务端代理、限额、缓存和支出上限。"],
        ["单人运维", "高 / 中", "每天客服 >1 小时；多个渠道版本不同步。", "先一个商店；FAQ、版本日志、统一 issue 清单和固定发布日。"],
    ]
    story.append(make_table(risk_rows, [34 * mm, 25 * mm, 55 * mm, 60 * mm], s, center_cols={1}, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("当前明确不做", s["h2"])])
    no_rows = [
        ["不做", "何时重新评估"],
        ["AI 自动翻译/无限译注", "30 个付费用户后，先做 20 次人工质量与成本测试。"],
        ["跨用户全站排行榜", "账号和服务端反作弊稳定后；先保留本机段位。"],
        ["手机号短信登录", "邮件/免账号方案无法满足明确需求，且能承担短信与防刷成本时。"],
        ["多商店同时首发", "第一个商店发布流程稳定且更新可复现后。"],
        ["Apple 会员与 iOS", "iPhone 付费需求成立且有 Mac/Xcode 资源时。"],
        ["付费广告", "自然激活、留存和转化通过 Gate 后。"],
        ["授权不明资料随商业包分发", "取得书面授权后。"],
    ]
    story.append(make_table(no_rows, [61 * mm, 113 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "范围控制就是盈利策略：每推迟一个尚未被用户证明的系统，都会减少一次开发、审核、客服和合规成本。",
            s,
            PALE_GREEN,
            GREEN,
        ),
        PageBreak(),
    ])

    # First 7 days
    story += page_title(15, "从明天开始的 7 天清单", "这是整份路线图中最重要的一页；完成后你会拥有第一个可验证的移动端发布基线。", s)
    first_week_rows = [
        ["日期", "任务", "当天结束时必须留下的证据"],
        ["Day 1", "冻结 v0.9 功能范围；完整复制备份；建立本地 Git；记录未提交改动和当前构建哈希。", "备份路径、Git 状态、v0.9 功能清单。"],
        ["Day 2", "运行网页生产构建；在你明确开始移动端任务后同步到 Android；生成 debug APK。", "构建日志、APK 路径、文件哈希。"],
        ["Day 3", "手机安装并跑通：首页 → 精读 → 订正 → 保存 → 单词 → 日期复习。", "一份带设备型号/系统版本的验收记录。"],
        ["Day 4", "平板验证笔/手指分流、缩放、键盘、旋转、前后台和返回键；测试重启数据恢复。", "问题截图/录屏；P0/P1/P2 清单。"],
        ["Day 5", "建立内容、字体、依赖版权台账；给 66 份资料和 SimHei 做“可分发/禁止打包/待确认”标记。", "版权台账 v1；商业构建排除清单。"],
        ["Day 6", "招募 12 名 Google 适用测试者或 30 名产品内测候选；准备隐私草稿、支持邮箱和反馈表。", "测试者名单与测试说明；隐私政策草稿。"],
        ["Day 7", "修复阻断问题；发布 v0.9 内测包；安排下一周 3 次回访；统计首篇完成。", "签名/哈希、版本说明、反馈日程、首批数据。"],
    ]
    story.append(make_table(first_week_rows, [24 * mm, 94 * mm, 56 * mm], s, font_tight=True))
    story.extend([
        Spacer(1, 6 * mm),
        callout(
            "完成这 7 天后，下一项正式开发任务应是：<b>把当前网页功能同步到 Android，生成并真机验证 debug APK</b>。在此之前不接支付、不建账号、不做 AI。",
            s,
            PALE_BLUE,
            BLUE,
        ),
        Spacer(1, 5 * mm),
        p("每周固定复盘模板", s["h2"]),
        bullet("本周交付了什么可验证产物？", s, tight=True),
        bullet("哪一个 Gate 更接近通过？证据是什么？", s, tight=True),
        bullet("出现了哪些数据丢失、版权、审核或支付风险？", s, tight=True),
        bullet("用户完成/留存/付费哪个指标最弱？下周只修最弱的一项。", s, tight=True),
        bullet("本周投入工时和现金各多少？累计净收入多少？", s, tight=True),
        Spacer(1, 5 * mm),
        callout(
            "最终目标的可执行定义：不是“所有功能都做完”，而是“一个合法、稳定、可更新的版本，在明确渠道获得持续付费，并且净收入能够覆盖外部成本和你认可的工时成本”。",
            s,
            PALE_GREEN,
            GREEN,
        ),
        PageBreak(),
    ])

    # Sources and evidence
    story += page_title(16, "依据与官方资料", "链接和价格截至 2026-07-23；真正提交前应在目标商店账户后台再次确认。", s)
    story.append(p("本地工程依据", s["h2"]))
    local_rows = [
        ["文件/检查", "用于判断"],
        ["D:\\codex库\\无聊英语\\package.json", "Vite/React/Capacitor 依赖与 android:apk 脚本。"],
        ["D:\\codex库\\无聊英语\\capacitor.config.json", "appId、appName、webDir。"],
        ["D:\\codex库\\无聊英语\\android\\variables.gradle", "minSdk 24、compile/target SDK 36。"],
        ["D:\\codex库\\无聊英语\\android\\app\\build.gradle", "versionCode/Name、release 未签名。"],
        ["D:\\codex库\\无聊英语\\scripts\\build-android.ps1", "当前只构建 debug APK。"],
        ["D:\\codex库\\无聊英语\\public\\vocabulary\\fonts\\simhei.ttf", "约 9.3 MiB 字体资产，需要授权复核。"],
        ["android/app/build/outputs 与 output/android", "未发现 APK/AAB 产物。"],
        ["https://wuliao-english-mobile.netlify.app", "HTTP 200，可作为现有网页验证入口。"],
    ]
    story.append(make_table(local_rows, [79 * mm, 95 * mm], s, font_tight=True))
    story.extend([Spacer(1, 5 * mm), p("官方平台与技术资料", s["h2"])])
    sources = [
        ("Android Developer Console：完整分发 25 美元、2026 年 8 月有限分发最多 20 台", "https://support.google.com/android-developer-console/answer/16640817"),
        ("Google Play：新个人开发者账号的 12 名测试者 / 连续 14 天要求", "https://support.google.com/googleplay/android-developer/answer/14151465"),
        ("Google Play：2026-08-31 起目标 API 36 要求", "https://support.google.com/googleplay/android-developer/answer/11926878"),
        ("Google Play：创建 App、AAB、永久包名、签名与版本号", "https://support.google.com/googleplay/android-developer/answer/9859152"),
        ("Android Developers：签名并上传 App Bundle", "https://developer.android.com/studio/publish/upload-bundle"),
        ("Google Play：数字商品支付政策", "https://support.google.com/googleplay/android-developer/answer/9858738"),
        ("Google Play：服务费概览", "https://support.google.com/googleplay/android-developer/answer/112622"),
    ]
    for idx, (label, url) in enumerate(sources, 1):
        story.append(source_item(idx, label, url, s))
    story.append(PageBreak())

    story += page_title(17, "依据与官方资料（续）", "Apple、国内备案、后端与 AI 价格来源。", s)
    more_sources = [
        ("Apple Developer Program：99 美元/年、个人/组织注册要求", "https://developer.apple.com/programs/enroll/"),
        ("Apple App Review Guidelines：审核、IAP、账号与删除要求", "https://developer.apple.com/app-store/review/guidelines/"),
        ("Apple App Privacy：App Store 数据实践披露", "https://developer.apple.com/app-store/app-privacy-details/"),
        ("Apple App Store Small Business Program：15% 佣金资格", "https://developer.apple.com/app-store/small-business-program/"),
        ("Capacitor iOS：iOS 工程由 Xcode 管理", "https://capacitorjs.com/docs/ios"),
        ("中国政府网：工业和信息化部 APP 备案通知", "https://www.gov.cn/zhengce/zhengceku/202308/content_6897341.htm?type=mobile-internet"),
        ("小米开发者：基础资质 FAQ（软著/电子版权与 APP 备案）", "https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2251"),
        ("小米开发者生态政策：备案编号与知识产权要求", "https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1321"),
        ("华为 AppGallery：应用发布与资质入口", "https://developer.huawei.com/consumer/cn/appgallery/devstart/"),
        ("Supabase 定价：Free 与 Pro 配额", "https://supabase.com/pricing"),
        ("OpenAI API 官方定价", "https://developers.openai.com/api/docs/pricing"),
    ]
    for idx, (label, url) in enumerate(more_sources, 8):
        story.append(source_item(idx, label, url, s))
    story.extend([
        Spacer(1, 5 * mm),
        callout(
            "信息边界：本计划使用公开规则和本地工程证据制定执行路线，不构成法律、税务、投资或收益保证。平台、备案、支付、费率和资格会变化；提交和收费前以你的开发者主体、目标地区与账户后台为准。",
            s,
            PALE_RED,
            RED,
        ),
    ])

    return story


def main():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = RoadmapDocTemplate(str(OUTPUT))
    doc.build(build_story())
    print(OUTPUT)


if __name__ == "__main__":
    main()

"""Rebuild product PDFs with a current addendum, retaining all historical pages."""
from pathlib import Path
import json
import shutil
import fitz
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / 'artifacts/backup-transfer-20261019'
OUTPUT = EVIDENCE / 'documents'
PRODUCT = Path(r'D:\codex库\01_无聊英语项目\无聊英语文档')
OUTPUT.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('YaHeiTransfer', r'C:\Windows\Fonts\msyh.ttc', subfontIndex=0))
style = ParagraphStyle('body', fontName='YaHeiTransfer', fontSize=10, leading=17, spaceAfter=10, textColor=HexColor('#303833'), wordWrap='CJK')
title = ParagraphStyle('title', parent=style, fontSize=22, leading=32, spaceAfter=20)
heading = ParagraphStyle('heading', parent=style, fontSize=14, leading=22, spaceBefore=14, spaceAfter=10)
data = json.loads((EVIDENCE / 'evidence.json').read_text(encoding='utf-8'))
def P(text): return Paragraph(text, style)
def H(text): return Paragraph(text, heading)
def footer(canvas, doc):
    canvas.setFont('YaHeiTransfer', 8); canvas.setFillColor(HexColor('#6c746e'))
    canvas.drawString(44, 32, '无聊英语 1.0.100 / 106 · 2026-10-19 · 本次更新说明')
    canvas.drawRightString(550, 32, str(doc.page))

for filename in ['无聊英语-现有功能文档.pdf', '无聊英语-功能修改过程文档.pdf']:
    baseline = EVIDENCE / 'baseline' / filename
    if not baseline.exists(): shutil.copy2(PRODUCT / filename, baseline)
    addendum = OUTPUT / ('addendum-' + filename)
    story = [Paragraph('备份修复与设备互传', title), P('当前版本：1.0.100 / Android Build 106。此处为最新说明，后续保留的全部历史章节只代表其各自版本当时的行为和验证结果。'),
        H('已经修复的故障'),
        P('手动导出此前用 Capacitor PluginCall.getLong 读取 JSON 分块位置。首块 0 等小整数实际解析为 Integer，旧读取器只接受 Long，导致默认值 -1 与文件位置不匹配。现改为严格读取 Number 并验证非负整数，避免首块被误判。截图对应异常未取得真实设备日志，本结论来自当前源码及回归测试。'),
        P('临时数据库从每条记录单独提交改为最多 64 条或约 4 MiB 的批量提交；超大笔迹独立处理。附件和 JSON 保持分块，不构造完整备份字符串。减少 Base64 解码的逐字符回调和 SHA-256 每个块的临时数组分配。'),
        P('界面显示读取、写入和最终回读阶段。Android 文件只有目标文档回读哈希和大小一致后才报告已保存；浏览器仅发起下载时如实显示下载状态。旧 v1 JSON 备份继续兼容。'),
        H('免费互传：从今天就能使用'),
        P('1. 更新安卓 App 和 Windows 下载版；Windows 关闭旧服务后启动新版，继续使用原浏览器及 http://127.0.0.1:4173。安卓直接覆盖安装，禁止卸载或清除数据。'),
        P('2. 两台设备连接同一 Wi-Fi 或热点，进入相同名字的本机账号；接收端在设置中打开“接收其他设备数据”。'),
        P('3. 把接收端完整 WL1 连接码复制到发送端，点击“发送到其他设备”；回到接收端确认接收。连接码包含一次性加密秘密，只交给自己的设备，等待配对最多 10 分钟。'),
        P('4. 接收完整文件并校验后，查看差异，选择冲突处理方式，再确认导入。发送完成不等于已导入，接收端确认后才写入学习数据。'),
        PageBreak(), H('冲突、恢复与数据保护'),
        P('新增记录补入，相同记录跳过，本机独有内容保留。冲突默认保留本机；可按关联组明确采用导入版本。关联组保留本机时，该组新增记录也暂不补入，避免资料、附件、答案分离。此版不传播删除，也不自动把双方笔迹拼接。'),
        P('第一次学习数据写入之前，保存并回读全部涉及记录的原版本和导入版本。写入前再次检查内容指纹；预览之后本机记录发生变化时停止写入。IndexedDB 的比较与替换在同一事务中执行，跨库步骤保留恢复日志。'),
        P('“导入历史与恢复”可以还原被替换的原版本；新增记录保留。恢复发现记录已经继续学习时跳过该记录，保留后来的操作。恢复资料不会自动上传或进入普通备份，仅在明确删除相应历史时清理。'),
        H('三个使用例子'),
        P('例一：平板迁移到空手机。手机先创建同名账号，接收后导入缺失学习记录、笔迹和自定义资料；密码和 API Key 需在手机单独设置。'),
        P('例二：手机与平板都修改过同一篇阅读。差异页显示冲突，可保留本机或采用对方整组数据；被替换的旧版本可从历史恢复。'),
        P('例三：导入后继续学习，再恢复旧版本。系统检测到后来修改的记录，会保留新学习内容，而不是强行覆盖成旧状态。'),
        H('验证证据及限制')]
    for key, value in data['checks'].items(): story.append(P(f'{key}：{value}'))
    story.extend([P('未进行生产平板安装、真实账号覆盖升级验收或两台实体设备的 Wi-Fi 互传。自动化浏览器、原生编译和签名验证不能替代这些真机结果。未使用生产账号进行测试。'),
        P('第一版限安卓和 Windows 下载版同网手动互传，不含异地中转或后台自动同步。Windows 防火墙或热点客户端隔离可能阻止连接；可使用现有文件导入导出，通过 USB 或 LocalSend 免费传文件。GitHub 用于软件下载，不托管本次学习数据。')])
    SimpleDocTemplate(str(addendum), pagesize=(595.28, 841.89), leftMargin=44, rightMargin=44, topMargin=48, bottomMargin=58).build(story, onFirstPage=footer, onLaterPages=footer)
    document = fitz.open(addendum); new_pages = len(document)
    historical = fitz.open(baseline); old_count = len(historical); document.insert_pdf(historical)
    final = OUTPUT / filename; document.save(final, garbage=4, deflate=True)
    for i in range(new_pages): document[i].get_pixmap(matrix=fitz.Matrix(1.35, 1.35)).save(OUTPUT / f'{filename[:-4]}-new-{i+1}.png')
    for i in range(new_pages):
        page = document[i]
        for block in page.get_text('blocks'):
            if block[1] < 0 or block[3] > page.rect.height: raise RuntimeError('Text exceeds page bounds')
    assert len(document) == new_pages + old_count
    document.close(); historical.close()
    shutil.copy2(final, PRODUCT / filename)
    (ROOT / 'docs').mkdir(exist_ok=True); shutil.copy2(final, ROOT / 'docs' / filename)
    print(json.dumps({'file': filename, 'newPages': new_pages, 'historicalPages': old_count}, ensure_ascii=False))

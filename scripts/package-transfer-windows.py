"""Package the verified web build with an offline Windows Node runtime."""
from pathlib import Path
import shutil
import zipfile
import subprocess
import os
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'output/backup-transfer-20261019'
PACKAGE = OUT / ('windows-stage-' + uuid4().hex[:12])
PACKAGE.mkdir(parents=True, exist_ok=True)
def stage_file(source, destination):
    try: os.link(source, destination)
    except OSError: shutil.copy2(source, destination)
    return destination

shutil.copytree(ROOT / 'dist', PACKAGE / 'dist', copy_function=stage_file)
(PACKAGE / 'scripts').mkdir(exist_ok=True)
for name in ['start.mjs', 'device-transfer-server.mjs']:
    shutil.copy2(ROOT / 'scripts' / name, PACKAGE / 'scripts' / name)
shutil.copy2(ROOT / '启动无聊英语.cmd', PACKAGE / '启动无聊英语.cmd')
(PACKAGE / 'runtime').mkdir(exist_ok=True)
runtime = shutil.which('node')
if not runtime: raise RuntimeError('Node runtime not found')
shutil.copy2(runtime, PACKAGE / 'runtime/node.exe')
for license_name in ['LICENSE', 'LICENSE.txt']:
    license_file = Path(runtime).parent / license_name
    if license_file.exists(): shutil.copy2(license_file, PACKAGE / 'runtime' / license_name)
if not any((PACKAGE / 'runtime' / name).exists() for name in ['LICENSE', 'LICENSE.txt']):
    version = subprocess.check_output([runtime, '--version']).decode().strip()
    with urlopen(f'https://raw.githubusercontent.com/nodejs/node/{version}/LICENSE', timeout=30) as response:
        (PACKAGE / 'runtime/LICENSE').write_bytes(response.read())
(PACKAGE / '使用说明.txt').write_text('无聊英语 1.0.100 Windows 下载版\n\n完整解压后双击“启动无聊英语.cmd”，无需另外安装 Node.js。\n更新时先关闭旧服务，继续使用原浏览器和 http://127.0.0.1:4173。浏览器资料不在 ZIP 内，不要清除浏览器数据。\n\n免费互传：两端同一 Wi-Fi/热点、同名本机账号。接收端打开设置中的接收功能，把完整 WL1 连接码交给发送端；接收确认后等待校验和差异预览，再确认导入。\n连接码包含本次加密密钥，不要公开。Windows 防火墙需允许内置运行环境在专用网络通信。\n\n导入历史可恢复被替换版本，后续已修改的记录保留。传输断开时可重新发送，或用 USB/LocalSend 传备份 JSON 再导入。\n\n本轮完成隔离浏览器与传输测试，未进行生产平板安装及实体设备互传验收。\n', encoding='utf-8-sig')
archive = OUT / 'wuliao-english-windows.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for source in PACKAGE.rglob('*'):
        if source.is_file(): z.write(source, Path('wuliao-english-windows') / source.relative_to(PACKAGE))
print(archive)

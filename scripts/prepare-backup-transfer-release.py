"""Copy only the reviewed task files to a clean main checkout; preserve dirty source."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/backup-transfer-20261019'
DEST = OUT / 'release-source'
FILES = [
    'android/app/build.gradle',
    'android/app/src/main/java/com/wuliao/english/MainActivity.java',
    'android/app/src/main/java/com/wuliao/english/ManualBackupPlugin.java',
    'android/app/src/main/java/com/wuliao/english/BackupChunkPosition.java',
    'android/app/src/main/java/com/wuliao/english/DeviceTransferPlugin.java',
    'android/app/src/test/java/com/wuliao/english/BackupChunkPositionTest.java',
    'android/app/src/androidTest/java/com/wuliao/english/ManualBackupBridgeTest.java',
    'src/backup.js', 'src/backupStaging.js', 'src/manualBackup.js', 'src/updateBackupStream.js',
    'src/deviceTransfer.js', 'src/backupRestorePlan.js', 'src/ui/SettingsPanel.jsx',
    'src/ui/BackupTransferPanel.jsx', 'src/ui/backup-transfer.css',
    'scripts/start.mjs', 'scripts/device-transfer-server.mjs', 'scripts/test-backup-transfer.mjs',
    'scripts/test-ui-polish-20260813.mjs', 'scripts/generate-backup-transfer-docs.py',
    'scripts/prepare-backup-transfer-release.py', 'scripts/package-transfer-windows.py', 'e2e/backup-transfer.config.mjs',
    'e2e/backup-transfer.spec.js', 'e2e/flow10-backup.spec.js', 'e2e/four-fixes.spec.js',
    'package.json', '启动无聊英语.cmd', 'docs/备份与局域网互传.md',
    'docs/无聊英语-现有功能文档.pdf', 'docs/无聊英语-功能修改过程文档.pdf',
]
inventory = []
for name in FILES:
    source = ROOT / name
    if not source.is_file(): raise RuntimeError('Required task file missing: ' + name)
    destination = DEST / name; destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    inventory.append({'path': name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
readme = DEST / 'README.md'
text = readme.read_text(encoding='utf-8')
marker = '> **Android 最新下载：' if '> **Android 最新下载：' in text else '> **最新下载：'
start = text.index(marker)
end = text.index('\n', start)
text = text[:start] + '> **最新下载：[1.0.100 含文章版 Android / Windows](https://github.com/liu2678294813-cpu/wuliao-english-private/releases/latest)。** 修复备份导出失败及逐条暂存过慢，新增同一 Wi-Fi / 热点内免费加密互传。文件与互传统一先校验、预览差异，再确认导入；冲突可选择保留本机或采用导入整组，并保留被替换版本。详见[备份与局域网互传](docs/备份与局域网互传.md)。安卓请直接覆盖安装，不要卸载或清除数据；Windows 关闭旧服务后启动新版，继续使用原浏览器和 `http://127.0.0.1:4173`。本轮未安装生产平板，实体设备互传与真实账号升级未验证。' + text[end:]
readme.write_text(text, encoding='utf-8')
(OUT / 'release-files.json').write_text(json.dumps({'remoteBase': subprocess.check_output(['git', '-C', str(DEST), 'rev-parse', 'HEAD']).decode().strip(), 'files': inventory}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Prepared {len(inventory)} task files and README in {DEST}')

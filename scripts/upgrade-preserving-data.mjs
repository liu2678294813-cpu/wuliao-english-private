import { execFileSync, spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const adb = resolve('.android-sdk/platform-tools/adb.exe');
const app = 'com.wuliao.english';
const output = resolve('output/save-models-20260909');
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
const manifest = () => run('shell', 'run-as', app, 'sh', '-c', "'find app_webview app_hws_webview files shared_prefs no_backup -type f -exec sha256sum {} \\;' ").split('\n').map(s => s.trim()).filter(Boolean).sort();
run('shell', 'am', 'force-stop', app);
const before = manifest();
assert.ok(before.length > 0, 'Original data manifest must not be empty');
const backup = resolve(output, 'original-app-data-before-upgrade.tar');
const fd = openSync(backup, 'w');
try {
  const result = spawnSync(adb, ['exec-out', 'run-as', app, 'tar', '-cf', '-', 'app_webview', 'app_hws_webview', 'files', 'shared_prefs', 'no_backup'], { stdio: ['ignore', fd, 'pipe'], windowsHide: true });
  assert.equal(result.status, 0, `Backup failed: ${result.stderr?.toString()}`);
} finally { closeSync(fd); }
assert.ok(statSync(backup).size > 0);
writeFileSync(resolve(output, 'before-upgrade-manifest.json'), JSON.stringify(before));
console.log(JSON.stringify({ step: 'backup-complete', files: before.length, bytes: statSync(backup).size }));
const installed = run('install', '-r', resolve('output/android/wuliao-english-android.apk'));
assert.match(installed, /Success/);
const after = manifest();
assert.deepEqual(after, before, 'Application data files must be identical before first upgraded launch');
const version = run('shell', 'dumpsys', 'package', app).match(/versionName=([^\s]+)/)?.[1];
assert.equal(version, '1.0.61');
// Only remove the disposable package created during this task, after upgrade verification.
const removed = run('uninstall', 'com.wuliao.english.saveqa');
assert.match(removed, /Success/);
const packages = run('shell', 'pm', 'list', 'packages', 'wuliao').split(/\r?\n/).filter(Boolean);
assert.deepEqual(packages, [`package:${app}`]);
const result = { version, unchangedDataFiles: before.length, backupBytes: statSync(backup).size, upgrade: 'passed', originalDataByteComparison: 'identical', qaRemoved: true, installedPackages: packages, checkedAt: new Date().toISOString() };
writeFileSync(resolve(output, 'upgrade-results.json'), JSON.stringify(result, null, 2));
run('shell', 'am', 'start', '-n', `${app}/com.wuliao.english.MainActivity`);
console.log(JSON.stringify(result));

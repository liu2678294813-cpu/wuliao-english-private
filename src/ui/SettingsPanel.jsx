import { useEffect, useRef, useState } from "react";
import { flushPendingSaves } from "../saveCoordinator.js";
import { flushDurableInk } from "../durableInkStorage.js";
import { getAppInfo } from "../appInfo";
import { getDeveloperMode } from "../developerMode";
import ModalShell from "./Overlay";
import { useBackHandler } from "./BackContext";
import { BACK_PRIORITY } from "./backController";
import {
  BACKUP_FORMAT,
  BACKUP_JOURNAL_KEY,
  BACKUP_VERSION,
  browserEncodeAttachment,
  createBackup,
  defaultBackupSources,
  defaultRestoreSources,
  parseBackup,
  previewRestore,
  recordBackupTelemetry,
  restoreBackup,
} from "../backup";

export default function SettingsPanel({
  username,
  onClose,
  onSwitchAccount,
  onOpenDeveloperLab,
}) {
  const devMode = getDeveloperMode();
  const info = getAppInfo();
  const [devOn, setDevOn] = useState(() => devMode.isDeveloperMode());
  const [tapCount, setTapCount] = useState(0);
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [locked, setLocked] = useState(false);
  const lockResetTimerRef = useRef(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupError, setBackupError] = useState(false);
  const [restoreManifest, setRestoreManifest] = useState(null);
  const backupFileRef = useRef(null);

  useEffect(() => devMode.subscribe(setDevOn), [devMode]);
  useEffect(() => () => window.clearTimeout(lockResetTimerRef.current), []);

  function handleVersionTap() {
    const result = devMode.tapVersion();
    setTapCount(result.count);
    if (result.ready) {
      setShowPin(true);
      setPinError("");
      setLocked(devMode.isLocked());
    }
  }

  function handlePinSubmit(event) {
    event.preventDefault();
    if (locked) return;
    const result = devMode.submitPin(pin);
    if (result.ok) {
      setShowPin(false);
      setPin("");
      setPinError("");
      setDevOn(true);
      return;
    }
    setPin("");
    setPinError("开发者 PIN 不正确");
    setLocked(true);
    window.clearTimeout(lockResetTimerRef.current);
    lockResetTimerRef.current = window.setTimeout(() => {
      setLocked(false);
      setPinError("");
    }, 1500);
  }

  useBackHandler(() => {
    if (!showPin) return false;
    setShowPin(false);
    return true;
  }, {
    enabled: showPin,
    priority: BACK_PRIORITY.modal + 1,
  });

  async function handleExportBackup() {
    setBackupBusy(true);
    setBackupError(false);
    setBackupMessage("正在生成本机备份…");
    const startedAt = performance.now();
    try {
      await flushPendingSaves();
      await flushDurableInk(username);
      const sources = defaultBackupSources();
      const { manifest, fileText, counts } = await createBackup({
        sources,
        username,
        appVersion: info.appVersion,
        encodeAttachment: browserEncodeAttachment,
      });
      const blob = new Blob([fileText], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `wuliao-backup-${username}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setBackupMessage(
        `已导出 ${counts.localStorage} 条本地数据 + ${counts.indexedDB} 条词库数据`
        + (counts.customPdfs ? `，含 ${counts.customPdfs} 份自定义 PDF` : "")
        + "；不含 API Key、密码与缓存。",
      );
      recordBackupTelemetry("backup.export", { status: "ok", counts, durationMs: performance.now() - startedAt });
    } catch (error) {
      setBackupError(true);
      setBackupMessage(error instanceof Error ? `导出失败：${error.message}` : "导出失败，请重试");
      recordBackupTelemetry("backup.export", { status: "failed", durationMs: performance.now() - startedAt });
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleSelectBackupFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBackupBusy(true);
    setBackupError(false);
    setRestoreManifest(null);
    try {
      const text = await file.text();
      const manifest = await parseBackup(text);
      const preview = previewRestore(manifest, username);
      if (!preview.sameAccount) {
        setBackupError(true);
        setBackupMessage(`这份备份属于账号 ${preview.accounts.join("、")}，不能恢复到当前账号 ${username}。`);
        return;
      }
      setRestoreManifest(manifest);
      setBackupMessage(
        `备份有效：${preview.counts.localStorage} 条本地数据 + ${preview.counts.indexedDB} 条词库数据`
        + (preview.containsCustomPdfs ? "，包含自定义 PDF" : "")
        + "。恢复为安全合并：只补入不存在的记录，不覆盖现有数据。",
      );
    } catch (error) {
      setBackupError(true);
      setBackupMessage(error instanceof Error ? `导入失败：${error.message}` : "导入失败，请检查文件");
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreBackup() {
    const manifest = restoreManifest;
    if (!manifest || backupBusy) return;
    if (!window.confirm(`将把这份备份合并到当前账号 ${username}：只补入不存在的记录，不覆盖现有数据；不含密码与 API Key。确定恢复？`)) return;
    setBackupBusy(true);
    setBackupError(false);
    setBackupMessage("正在恢复…");
    const startedAt = performance.now();
    try {
      await flushPendingSaves();
      await flushDurableInk(username);
      const sources = defaultRestoreSources();
      const result = await restoreBackup({
        manifest,
        username,
        ...sources,
        journal: (entry) => {
          try {
            localStorage.setItem(BACKUP_JOURNAL_KEY, JSON.stringify({ ...entry, format: BACKUP_FORMAT, version: BACKUP_VERSION }));
          } catch {
            // journal 失败不影响恢复结果
          }
        },
      });
      if (result.ok) {
        const written = result.writtenLocal + result.writtenIdb;
        setBackupMessage(
          `恢复完成：补入 ${result.writtenLocal} 条本地记录、${result.writtenIdb} 条词库记录`
          + (written === 0 ? "（全部已存在，未重复写入）" : `，跳过已存在 ${result.skipped} 条`)
          + "；已抽样校验。",
        );
        recordBackupTelemetry("backup.restore", { status: "ok", durationMs: performance.now() - startedAt, errors: 0 });
      } else {
        setBackupError(true);
        setBackupMessage(
          `恢复遇到 ${result.errors.length} 个问题：${result.errors.slice(0, 3).map((error) => error.message).join("；")}`
          + "。已写部分不会回滚，请核对后重试；这不会清除任何既有数据。",
        );
        recordBackupTelemetry("backup.restore", { status: "failed", durationMs: performance.now() - startedAt, errors: result.errors.length });
      }
    } catch (error) {
      setBackupError(true);
      setBackupMessage(error instanceof Error ? `恢复失败：${error.message}` : "恢复失败，请重试");
      recordBackupTelemetry("backup.restore", { status: "failed", durationMs: performance.now() - startedAt, errors: 1 });
    } finally {
      setBackupBusy(false);
    }
  }

  return (
    <ModalShell open onClose={onClose} className="settings-backdrop" label="设置">
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div><small>SETTINGS</small><h2>设置</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭设置">×</button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>账号</h3>
            <div className="settings-row">
              <span>当前本机账号</span>
              <strong>{username || "未登录"}</strong>
            </div>
            <button className="settings-action" type="button" onClick={onSwitchAccount}>切换账号</button>
          </section>

          <section className="settings-section">
          <h3>数据备份</h3>
          <p className="settings-note">备份包含当前账号的学习记录、词库与自定义 PDF；不包含 API Key、密码与缓存。恢复为安全合并，不会覆盖现有数据。</p>
          <div className="settings-row">
            <span>生成并下载备份</span>
            <button className="settings-action primary" type="button" disabled={backupBusy} onClick={handleExportBackup}>
              {backupBusy ? "处理中…" : "导出备份"}
            </button>
          </div>
          <div className="settings-row">
            <span>从备份文件恢复</span>
            <button className="settings-action" type="button" disabled={backupBusy} onClick={() => backupFileRef.current?.click()}>
              选择备份文件
            </button>
            <input ref={backupFileRef} className="visually-hidden" type="file" accept=".json,application/json" onChange={handleSelectBackupFile} />
          </div>
          {restoreManifest && (
            <div className="settings-row">
              <span>确认恢复</span>
              <button className="settings-action primary" type="button" disabled={backupBusy} onClick={handleRestoreBackup}>
                {backupBusy ? "恢复中…" : "确认恢复（merge）"}
              </button>
            </div>
          )}
          {backupMessage && (
            <p className={`settings-note settings-backup-status ${backupError ? "is-error" : ""}`} role="status">{backupMessage}</p>
          )}
          </section>

          <section className="settings-section">
          <h3>关于</h3>
          <div className="settings-row">
            <span>App 版本</span>
            <button
              type="button"
              className="settings-version"
              onClick={handleVersionTap}
              aria-label={`App 版本 ${info.appVersion}`}
            >
              v{info.appVersion}
              {tapCount > 0 && tapCount < 7 ? <small> · {tapCount}/7</small> : null}
            </button>
          </div>
          {info.buildId ? (
            <div className="settings-row"><span>Build</span><strong>{info.buildId}</strong></div>
          ) : null}
          <div className="settings-row"><span>平台</span><strong>{info.platform === "android" ? "Android" : "Web / Browser"}</strong></div>
          {info.gitCommit ? (
            <div className="settings-row"><span>Git Commit</span><strong>{info.gitCommit}</strong></div>
          ) : null}
          <p className="settings-note">所有学习数据仅保存在当前设备。</p>
          </section>

          {devOn ? (
            <section className="settings-section">
            <h3>开发者选项</h3>
            <button className="settings-action primary" type="button" onClick={onOpenDeveloperLab}>打开开发者选项</button>
            <p className="settings-note">开发者模式只控制本机开发界面的可见性，基础诊断数据始终在设备本地低开销记录。</p>
            </section>
          ) : null}
        </div>

        {showPin ? (
          <div className="settings-pin-backdrop" onClick={() => setShowPin(false)}>
            <form className="settings-pin" onSubmit={handlePinSubmit} onClick={(event) => event.stopPropagation()}>
              <h3>开发者访问门槛</h3>
              <p>请输入开发者 PIN（仅本机开发者使用，不是账号密码）。</p>
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                autoFocus
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder="开发者 PIN"
                disabled={locked}
              />
              {pinError ? <p className="settings-pin-error">{pinError}</p> : null}
              <div className="settings-pin-actions">
                <button type="button" onClick={() => setShowPin(false)}>取消</button>
                <button type="submit" disabled={locked || !pin}>确认</button>
              </div>
            </form>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

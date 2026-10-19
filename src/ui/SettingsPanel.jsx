import { useEffect, useRef, useState } from "react";
import BackupTransferPanel from "./BackupTransferPanel.jsx";
import { getAppInfo } from "../appInfo";
import { getDeveloperMode } from "../developerMode";
import ModalShell from "./Overlay";
import AppUpdateSection from "./AppUpdateSection.jsx";
import { appUpdater } from "../appUpdater.js";
import { useBackHandler } from "./BackContext";
import { BACK_PRIORITY } from "./backController";


export default function SettingsPanel({
  username,
  onClose,
  onSwitchAccount,
  onOpenDeveloperLab,
  longSentenceTrainingEnabled = true,
  onLongSentenceTrainingEnabledChange,
}) {
  const devMode = getDeveloperMode();
  const buildInfo = getAppInfo();
  const [installedInfo, setInstalledInfo] = useState(null);
  const info = buildInfo.platform === "android" ? {
    ...buildInfo, appVersion: installedInfo?.versionName || "读取中", buildId: installedInfo?.versionCode || "",
  } : buildInfo;
  useEffect(() => {
    if (buildInfo.platform !== "android") return;
    let active = true;
    const refresh = () => { void appUpdater.getInstalledInfo().then(value => { if (active) setInstalledInfo(value); }).catch(() => {}); };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { active = false; document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [buildInfo.platform]);
  const [devOn, setDevOn] = useState(() => devMode.isDeveloperMode());
  const [tapCount, setTapCount] = useState(0);
  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [locked, setLocked] = useState(false);
  const lockResetTimerRef = useRef(null);
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
            <h3>学习功能</h3>
            <label className="settings-row">
              <span>长难句训练</span>
              <input type="checkbox" checked={longSentenceTrainingEnabled}
                onChange={(event) => onLongSentenceTrainingEnabledChange?.(event.target.checked)} />
            </label>
            <p className="settings-note">关闭后隐藏入口，已有训练记录仍保留。</p>
          </section>

          <BackupTransferPanel username={username} appVersion={info.appVersion} />

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
          {info.platform === "android" ? <AppUpdateSection /> : null}
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

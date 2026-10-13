import { useEffect, useRef, useState } from "react";
import { appUpdater, createUpdateController } from "../appUpdater.js";
import ModalShell from "./Overlay.jsx";

const defaultBackup = async (...args) => (await import("../appUpdateBackup.js")).persistUpdateBackups(...args);

export default function AppUpdateSection({ plugin = appUpdater, backup = defaultBackup }) {
  const [state, setState] = useState({ phase: "idle", message: "" });
  const controller = useRef(null);
  if (!controller.current) controller.current = createUpdateController({
    plugin, onChange: setState,
    backup,
  });
  useEffect(() => {
    let disposed = false, disconnect;
    void controller.current.connect().then((remove) => { if (disposed) void remove(); else disconnect = remove; }).catch(() => {});
    const reconcile = () => { void controller.current.reconcile().catch(() => {}); };
    const visible = () => { if (document.visibilityState === "visible") reconcile(); };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true; void disconnect?.();
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", visible);
      // Pending system installation belongs to the native journal, not this panel.
      if (!["installing", "pending-install"].includes(controller.current.state.phase)) void controller.current.cancel().catch(() => {});
    };
  }, []);
  const busy = ["checking", "downloading", "backing-up", "installing"].includes(state.phase);
  const open = ["available", "downloading", "backing-up", "installing", "pending-install"].includes(state.phase);
  const cancel = () => { if (state.phase !== "installing") void controller.current.cancel().catch(() => {}); };
  const release = state.release;
  const percent = state.total ? Math.min(100, Math.floor(state.received / state.total * 100)) : 0;
  return <>
    <div className="settings-row">
      <span>应用更新</span>
      <button className="settings-action" type="button" disabled={busy} onClick={() => controller.current.check()}>
        {state.phase === "checking" ? "检查中…" : state.phase === "error" ? "重试检查更新" : "检查更新"}
      </button>
    </div>
    {state.message && !open ? <p className={`settings-note ${state.phase === "error" ? "is-error" : ""}`} role="status">{state.message}</p> : null}
    <ModalShell open={open} onClose={cancel} className="settings-update-backdrop" label="应用更新">
      <section className="settings-update-panel">
        <header className="settings-header"><h2>{state.phase === "available" ? "发现新版本" : "应用更新"}</h2><button type="button" className="icon-button" aria-label="关闭更新弹窗" disabled={state.phase === "installing"} onClick={cancel}>×</button></header>
        {release ? <>
          <p>当前 v{release.installed.versionName} → 最新 v{release.versionName}</p>
          <p className="settings-note">{new Date(release.publishedAt).toLocaleDateString("zh-CN")} · {(release.apkBytes / 1024 / 1024).toFixed(1)} MB · 含文章版本</p>
          {state.phase === "available" ? <pre className="settings-update-notes">{release.notes || "此版本未提供更新说明。"}</pre> : null}
        </> : null}
        {state.phase === "downloading" ? <><progress max="100" value={percent} aria-label="更新下载进度" /><p role="status">正在下载 {percent}%（{(state.received / 1024 / 1024).toFixed(1)} MB）</p></> : null}
        {["backing-up", "installing", "pending-install"].includes(state.phase) ? <p role="status">{state.message}</p> : null}
        {state.phase === "available" ? <p className="settings-note">覆盖更新当前应用，保留全部账号学习数据。更新完成后自动清理临时安装包，只保留最近一份安全备份。</p> : null}
        <div className="settings-pin-actions">
          <button type="button" onClick={cancel} disabled={state.phase === "installing"}>{state.phase === "available" ? "取消" : ["backing-up", "pending-install", "installing"].includes(state.phase) ? "取消更新" : "取消下载"}</button>
          {state.phase === "available" ? <button type="button" className="settings-action primary" onClick={() => controller.current.update()}>更新</button> : null}
          {state.phase === "pending-install" ? <button type="button" className="settings-action primary" onClick={() => controller.current.resume()}>继续安装</button> : null}
        </div>
      </section>
    </ModalShell>
  </>;
}

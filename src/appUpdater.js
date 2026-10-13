import { registerPlugin } from "@capacitor/core";
import { isAndroidApp } from "./platform.js";

export const appUpdater = registerPlugin("AppUpdater");
export const canUpdateAndroid = isAndroidApp;

// The controller owns the sequence. Cancelling invalidates continuations as well
// as the native download, so a late result cannot start backup or installation.
export function createUpdateController({ plugin, backup, onChange = () => {} }) {
  let generation = 0, running = false;
  const state = { phase: "idle", release: null, installed: null, message: "", received: 0, total: 0 };
  const emit = (next) => { Object.assign(state, next); onChange({ ...state }); };
  const failure = (error) => emit({ phase: "error", message: error?.message || String(error || "更新失败，请重试") });
  function acceptNative(result) {
    if (!result || ["checking", "downloading", "backing-up"].includes(state.phase)) return;
    const status = result.status;
    if (status === "installed") {
      const target = result.targetVersionCode || state.release?.versionCode;
      if (!target || !result.installed || result.installed.versionCode < target) {
        failure(new Error("实际版本尚未更新，请重新检查更新")); return;
      }
      running = false;
      emit({ phase: "latest", installed: result.installed, message: "更新已完成，临时安装包已清理。" });
    } else if (["pending-user-action", "permission-required", "ready"].includes(status)) {
      running = false;
      emit({ phase: "pending-install", installed: result.installed, message: result.message || "更新已准备好，请继续系统安装确认。" });
    } else if (status === "submitted") {
      emit({ phase: "installing", message: "正在准备系统覆盖安装，请等待系统确认…" });
    } else if (["cancelled", "permission-denied", "failed"].includes(status)) {
      running = false;
      emit({ phase: status === "failed" ? "error" : "idle", installed: result.installed,
        message: result.message || (status === "permission-denied" ? "未允许安装更新，原版本仍保留。" : "未完成安装，原版本仍保留。") });
    }
  }
  async function reconcile() {
    if (!plugin.getUpdateState) return;
    const token = generation;
    const result = await plugin.getUpdateState();
    if (token === generation) acceptNative(result);
  }
  return {
    state,
    async connect() {
      const listener = await plugin.addListener("updateStateChanged", acceptNative);
      try { await reconcile(); }
      catch (error) { await listener.remove(); throw error; }
      return () => listener.remove();
    },
    reconcile,
    async resume() {
      if (running || state.phase !== "pending-install") return;
      running = true; const token = ++generation;
      emit({ phase: "installing", message: "正在打开系统覆盖安装确认…" });
      try { const result = await plugin.resumeUpdate(); if (token === generation) { acceptNative(result); await reconcile(); } }
      catch (error) { if (token === generation) failure(error); }
      finally { if (token === generation) running = false; }
    },
    async check() {
      if (running) return;
      running = true; const token = ++generation;
      emit({ phase: "checking", message: "正在检查 GitHub 最新版本…", release: null });
      try {
        const result = await plugin.checkLatest();
        if (token !== generation) return;
        emit(result.available
          ? { phase: "available", release: result, installed: result.installed, message: "" }
          : { phase: "latest", installed: result.installed, message: "当前已是最新版本" });
      } catch (error) { if (token === generation) failure(error); }
      finally { if (token === generation) running = false; }
    },
    async update() {
      if (running || state.phase !== "available") return;
      running = true; const token = ++generation, release = state.release;
      const active = () => { if (token !== generation) throw new Error("更新已取消"); };
      let listener;
      try {
        emit({ phase: "downloading", message: "正在下载更新…", received: 0, total: release.apkBytes });
        listener = await plugin.addListener("downloadProgress", (progress) => {
          if (token === generation) emit({ received: progress.received, total: progress.total });
        });
        active();
        const downloaded = await plugin.downloadUpdate({ releaseId: String(release.releaseId) });
        active();
        if (!downloaded?.verified) throw new Error("安装包未通过校验，已停止安装");
        emit({ phase: "backing-up", message: "正在保存并校验全账号学习数据备份…" });
        await backup(plugin, active, release.installed.versionName);
        active();
        emit({ phase: "installing", message: "请在系统界面确认安装；首次更新可能需要允许本应用安装更新。" });
        const result = await plugin.installUpdate();
        active();
        // The native journal is authoritative if a terminal callback raced submission.
        if (plugin.getUpdateState) await reconcile(); else acceptNative(result);
      } catch (error) {
        if (token === generation) {
          if (!["installing", "pending-install"].includes(state.phase)) {
            try { await plugin.cancelDownload(); } catch (cleanupError) {
              failure(new Error(`${error.message || error}；更新临时文件清理失败：${cleanupError.message || cleanupError}`)); return;
            }
          }
          failure(error);
        }
      }
      finally { try { await listener?.remove(); } finally { if (token === generation) running = false; } }
    },
    async cancel() {
      if (state.phase === "installing") return;
      const needsCancel = (running && state.phase !== "checking") || state.phase === "pending-install";
      ++generation; running = false;
      emit({ phase: "idle", release: null, message: "", received: 0, total: 0 });
      if (needsCancel) await plugin.cancelDownload();
    },
  };
}

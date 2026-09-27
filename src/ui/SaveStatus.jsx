import { useEffect, useState } from "react";
import { flushDurableInk, inkStorageStatus, subscribeInkStorage } from "../durableInkStorage.js";
import { flushPendingSaves } from "../saveCoordinator.js";

export default function SaveStatus({ username, showSaved = false }) {
  const [status, setStatus] = useState(() => inkStorageStatus(username));
  const [error, setError] = useState(false);
  useEffect(() => subscribeInkStorage(() => setStatus(inkStorageStatus(username))), [username]);
  useEffect(() => {
    const failed = () => setError(true);
    const saved = () => setError(false);
    window.addEventListener("wuliao:save-failed", failed);
    window.addEventListener("wuliao:save-succeeded", saved);
    return () => { window.removeEventListener("wuliao:save-failed", failed); window.removeEventListener("wuliao:save-succeeded", saved); };
  }, []);
  async function retry() {
    setStatus("saving");
    try { await flushPendingSaves(); await flushDurableInk(username); setError(false); setStatus("saved"); }
    catch { setError(true); }
  }
  const failed = error || status === "error";
  if (!failed && status === "saved" && !showSaved) return null;
  return <div className={`learning-save-status${failed ? " failed" : ""}`} role="status" aria-live="polite">
    {failed ? <>保存失败，内容仍在当前页面。<button type="button" onClick={retry}>重试保存</button></> : status === "saving" ? "保存中…" : "笔迹已保存"}
  </div>;
}

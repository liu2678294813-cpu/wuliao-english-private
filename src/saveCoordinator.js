// Leaving a workspace is an explicit save boundary, not an unmount side effect.
import { flushDurableInk } from "./durableInkStorage.js";
const writers = new Set();
export function reportSaveFailure() { globalThis.window?.dispatchEvent(new Event("wuliao:save-failed")); }
export function backgroundSave(flush) {
  try { Promise.resolve(flush()).catch(reportSaveFailure); } catch { reportSaveFailure(); }
}
// Give the completed stroke a paint opportunity before serializing the page.
// Each surface retains its pending snapshot and its synchronous navigation flush.
export function scheduleInkSave(flush) {
  const handle = { frame: null, timer: null };
  handle.frame = window.requestAnimationFrame(() => {
    handle.frame = null;
    handle.timer = window.setTimeout(() => { handle.timer = null; backgroundSave(flush); }, 0);
  });
  return handle;
}
export function cancelScheduledInkSave(handle) {
  if (!handle) return;
  if (handle.frame !== null) window.cancelAnimationFrame(handle.frame);
  if (handle.timer !== null) window.clearTimeout(handle.timer);
}
export function registerPendingSave(flush) { writers.add(flush); return () => writers.delete(flush); }
export async function flushPendingSaves() {
  const results = await Promise.allSettled([...writers].map((flush) => Promise.resolve().then(flush)));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
export async function saveBeforeNavigation(action, username) {
  try {
    await flushPendingSaves();
    await flushDurableInk(username);
    globalThis.window?.dispatchEvent(new Event("wuliao:save-succeeded"));
    action();
    return true;
  } catch { reportSaveFailure(); return false; }
}

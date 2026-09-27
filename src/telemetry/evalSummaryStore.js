// 最近 Eval Summary 的设备本地存储（属于诊断数据，可被“清除诊断数据”清除）。
import { LATEST_EVAL_KEY, EVAL_VISIBLE_KEY, readJsonKey, writeJsonKey } from "./telemetryStorage";

export function createEvalSummaryStore({ storage, now = Date.now } = {}) {
  const source = storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);
  return {
    get() {
      return readJsonKey(source, LATEST_EVAL_KEY);
    },
    set(value) {
      return writeJsonKey(source, LATEST_EVAL_KEY, {
        ...(value || {}),
        savedAt: now(),
      });
    },
    isVisible(appVersion) {
      const raw = readJsonKey(source, EVAL_VISIBLE_KEY);
      if (!raw) return true;
      // 新版本号出现时视为新的构建产物，重新展示 bundled summary。
      return raw.appVersion === appVersion ? raw.visible !== false : true;
    },
    setVisible(appVersion, visible) {
      return writeJsonKey(source, EVAL_VISIBLE_KEY, { appVersion, visible, savedAt: now() });
    },
    clear() {
      if (!source) return;
      try {
        source.removeItem(LATEST_EVAL_KEY);
        source.removeItem(EVAL_VISIBLE_KEY);
      } catch {
        // 清理失败不影响业务
      }
    },
  };
}

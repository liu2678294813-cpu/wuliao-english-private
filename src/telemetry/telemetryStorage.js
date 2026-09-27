// LocalTelemetrySink：设备作用域 localStorage 单键存储。
// 业务代码不得直接调用本模块，必须经过 telemetry.js 的公开 API。

export const TELEMETRY_KEY = "wuliao:telemetry:v1";
export const LATEST_EVAL_KEY = "wuliao:telemetry:latest-eval:v1";
export const EVAL_VISIBLE_KEY = "wuliao:telemetry:eval-visible:v1";

export function createTelemetryStorage({ storage, key = TELEMETRY_KEY } = {}) {
  const source = storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);
  return {
    key,
    read() {
      if (!source) return null;
      try {
        const raw = source.getItem(key);
        if (raw == null) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    write(doc) {
      if (!source) return false;
      try {
        source.setItem(key, JSON.stringify(doc));
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      if (!source) return;
      try {
        source.removeItem(key);
      } catch {
        // 清理失败不影响业务
      }
    },
  };
}

export function readJsonKey(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeJsonKey(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

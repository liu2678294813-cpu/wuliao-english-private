// 开发者访问门槛：默认关闭；设置 → 关于 → 连点版本号 7 次 → PIN。
// 这只是防止普通用户误入开发功能的轻量门槛，不是正式安全认证系统；
// 未来接服务器后必须由服务端账号 + 身份认证 + 角色权限控制。

export const DEV_MODE_KEY = "wuliao:dev:mode:v1";
export const VERSION_TAP_COUNT = 7;
export const TAP_WINDOW_MS = 6000;
export const FAILURE_LOCK_MS = 1500;

export function createDeveloperMode({
  storage,
  now = Date.now,
  pin = "",
  key = DEV_MODE_KEY,
} = {}) {
  const source = storage || (typeof globalThis !== "undefined" ? globalThis.localStorage : null);
  let tapCount = 0;
  let lastTapAt = 0;
  let lockedUntil = 0;
  const listeners = new Set();

  const readState = () => {
    if (!source) return false;
    try {
      return source.getItem(key) === "1";
    } catch {
      return false;
    }
  };

  const writeState = (value) => {
    if (!source) return;
    try {
      if (value) source.setItem(key, "1");
      else source.removeItem(key);
    } catch {
      // 状态写入失败不影响业务
    }
  };

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(isDeveloperMode());
      } catch {
        // 单个监听器异常不影响其他监听器
      }
    }
  };

  function isDeveloperMode() {
    return readState();
  }

  function tapVersion() {
    const current = now();
    if (current - lastTapAt > TAP_WINDOW_MS) tapCount = 0;
    lastTapAt = current;
    tapCount += 1;
    return { count: tapCount, ready: tapCount >= VERSION_TAP_COUNT };
  }

  function resetTaps() {
    tapCount = 0;
    lastTapAt = 0;
  }

  function isLocked() {
    return now() < lockedUntil;
  }

  function submitPin(value) {
    if (isLocked()) return { ok: false, locked: true };
    if (String(value == null ? "" : value).trim() === String(pin || "").trim()) {
      enable();
      return { ok: true, locked: false };
    }
    lockedUntil = now() + FAILURE_LOCK_MS;
    resetTaps();
    return { ok: false, locked: false };
  }

  function enable() {
    writeState(true);
    resetTaps();
    notify();
  }

  function disable() {
    writeState(false);
    notify();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    isDeveloperMode,
    tapVersion,
    resetTaps,
    isLocked,
    submitPin,
    enable,
    disable,
    subscribe,
  };
}

let defaultDeveloperMode = null;

export function getDeveloperMode() {
  if (!defaultDeveloperMode) {
    const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
    defaultDeveloperMode = createDeveloperMode({ pin: env.VITE_WULIAO_DEV_PIN || "" });
  }
  return defaultDeveloperMode;
}

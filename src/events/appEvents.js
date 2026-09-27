/**
 * 轻量事件原语：emitAppEvent / onAppEvent。
 *
 * - 事件名集中定义于 eventTypes.js；
 * - SSR / node 测试环境安全（window 缺失时静默降级，绝不抛错）；
 * - CustomEvent 缺失时退化为普通 Event（payload 仅在 CustomEvent 可用时透传）；
 * - 返回 unsubscribe 函数，便于 React useEffect cleanup 与测试。
 *
 * 约束：事件只用于跨 feature / 跨 React tree / 发布订阅场景；
 * 能直接函数调用的业务逻辑不得改造成事件。
 */

import { AppEventName } from "./eventTypes.js";

function resolveName(type) {
  if (typeof type === "string" && type) return type;
  if (type && typeof type === "object" && typeof type.type === "string" && type.type) return type.type;
  return "";
}

function hasWindow() {
  return typeof window !== "undefined"
    && typeof window.addEventListener === "function"
    && typeof window.dispatchEvent === "function";
}

export function emitAppEvent(type, payload) {
  const name = resolveName(type);
  if (!name || !hasWindow()) return;
  try {
    const EventCtor = typeof window.CustomEvent === "function"
      ? window.CustomEvent
      : typeof globalThis.CustomEvent === "function"
        ? globalThis.CustomEvent
        : null;
    if (EventCtor) {
      window.dispatchEvent(new EventCtor(name, payload === undefined ? {} : { detail: payload }));
    } else {
      window.dispatchEvent(new Event(name));
    }
  } catch {
    // 事件派发失败不影响业务本身。
  }
}

export function onAppEvent(type, handler) {
  const name = resolveName(type);
  if (!name || typeof handler !== "function") return () => {};
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  const listener = (event) => {
    handler(event.detail == null ? {} : event.detail, event);
  };
  window.addEventListener(name, listener);
  return () => {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener(name, listener);
    }
  };
}

export function isKnownAppEvent(name) {
  return AppEventName.has(String(name || ""));
}

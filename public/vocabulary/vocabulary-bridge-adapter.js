/**
 * 词汇子应用端 VocabularyBridge adapter。
 *
 * - 独立于编译后 bundle 加载（index.html 与三个静态页在业务脚本之前引入）；
 * - 向父端发送新协议消息（READY / ROUTE_CHANGED / BACK / SESSION_UPDATED /
 *   STATIC_PAGE / HARDWARE_BACK_RESPONSE）；
 * - 接收父端新协议消息（NAVIGATE / SET_AUTO_SPEAK / SET_SHUFFLE /
 *   HARDWARE_BACK），并转换为旧格式 window 事件，让 app-polish.js /
 *   embedded-vocabulary.js 的既有 listener 继续处理业务逻辑；
 * - 校验来源：event.source === window.parent，http(s) 下 origin 一致。
 *
 * 兼容性：本 adapter 是唯一向父端发送 postMessage 的出口；页面内部
 * 发送点（app-polish / embedded-vocabulary）统一调用 window.VocabularyBridge。
 */
(() => {
  const IS_EMBEDDED = typeof window !== "undefined" && window.parent !== window;
  const NAMESPACE = "wuliao:vocabulary";
  const VERSION = 1;
  let navigationVersion = 0;
  let pendingRoute = "";

  const usesHttpMessagingOrigin = () => {
    try {
      const protocol = window.location.protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  };

  const parentMessageTargetOrigin = () => {
    try {
      return usesHttpMessagingOrigin() ? window.location.origin : "*";
    } catch {
      return "*";
    }
  };

  const isTrustedParentMessage = (event) => {
    if (!event || event.source !== window.parent) return false;
    if (!usesHttpMessagingOrigin()) return true;
    try {
      return event.origin === window.location.origin;
    } catch {
      return false;
    }
  };

  const send = (type, payload) => {
    if (!IS_EMBEDDED) return;
    try {
      window.parent.postMessage(
        { namespace: NAMESPACE, version: VERSION, type, payload: payload === undefined ? null : payload },
        parentMessageTargetOrigin(),
      );
    } catch {
      // 父窗口不可用时静默降级，不影响子应用自身功能
    }
  };

  const dispatchLegacy = (type, detail) => {
    try {
      const EventCtor = typeof window.CustomEvent === "function"
        ? window.CustomEvent
        : typeof CustomEvent === "function"
          ? CustomEvent
          : null;
      window.dispatchEvent(
        EventCtor ? new EventCtor(type, detail === undefined ? {} : { detail }) : new Event(type),
      );
    } catch {
      // 事件派发失败不影响业务
    }
  };

  window.addEventListener("message", async (event) => {
    if (!isTrustedParentMessage(event)) return;
    const data = event.data;
    if (data?.namespace !== NAMESPACE || data?.version !== VERSION || data?.type !== "REQUEST_SCREENING_CONTEXT" || typeof data.payload?.requestId !== "string") return;
    const requestId = data.payload.requestId;
    try {
      if (!location.hash.startsWith("#/screening") || !window.__wuliaoScreeningContext) throw new Error("请先选择一个筛选词库");
      const context = await window.__wuliaoScreeningContext();
      if (context.username !== localStorage.getItem("kaoyan_vocab_current_user")) throw new Error("账号已切换");
      send("SCREENING_CONTEXT", { requestId, context });
    } catch (error) { send("SCREENING_CONTEXT", { requestId, error: error.message }); }
  });

  const bridge = {
    namespace: NAMESPACE,
    version: VERSION,

    ready() {
      send("READY");
    },

    reportRoute(route) {
      send("ROUTE_CHANGED", { route: String(route || "") });
    },

    reportStaticPage(page) {
      send("STATIC_PAGE", { page: String(page || "") });
    },

    requestBack() {
      send("BACK");
    },

    respondHardwareBack(atRoot) {
      send("HARDWARE_BACK_RESPONSE", { atRoot: Boolean(atRoot) });
    },

    reportSessionUpdated() {
      send("SESSION_UPDATED");
    },
  };

  window.VocabularyBridge = bridge;

  // Navigation waits for the current transaction. Failures keep this document.
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.target || anchor.download || event.button !== 0 || event.ctrlKey || event.metaKey
      || !window.__wuliaoFlushVocabulary) return;
    const href = anchor.href;
    if (!href || new URL(href).origin !== location.origin) return;
    event.preventDefault(); event.stopImmediatePropagation();
    pendingRoute = "";
    const request = ++navigationVersion;
    Promise.resolve().then(() => window.__wuliaoFlushVocabulary?.()).then(() => {
      if (request === navigationVersion) location.assign(href);
    })
      .catch(() => window.alert("保存失败，请重试后再离开"));
  }, true);

  if (!IS_EMBEDDED) return;

  window.addEventListener("message", async (event) => {
    if (!isTrustedParentMessage(event)) return;
    const data = event.data || {};
    if (data.namespace !== NAMESPACE || data.version !== VERSION) return;
    switch (data.type) {
      case "FLUSH_PENDING": {
        const requestId = data.payload?.requestId;
        if (typeof requestId !== "string") return;
        try { await window.__wuliaoFlushVocabulary?.(); send("FLUSH_RESULT", { requestId, ok: true }); }
        catch (error) { send("FLUSH_RESULT", { requestId, ok: false, error: error.message }); }
        return;
      }
      case "NAVIGATE": {
        const route = data.payload?.route;
        if (typeof route !== "string" || !route || location.hash === `#${route}`) return;
        if (route === pendingRoute) return;
        pendingRoute = route;
        const request = ++navigationVersion;
        try { await window.__wuliaoFlushVocabulary?.(); if (request === navigationVersion) dispatchLegacy("wuliao:vocabulary-navigate", { route }); }
        catch { window.alert("保存失败，请重试后再离开"); }
        finally { if (request === navigationVersion) pendingRoute = ""; }
        return;
      }
      case "SET_AUTO_SPEAK": {
        const enabled = data.payload?.enabled;
        if (typeof enabled === "boolean") dispatchLegacy("wuliao:vocabulary-auto-pronounce", { enabled });
        return;
      }
      case "SET_SHUFFLE": {
        const enabled = data.payload?.enabled;
        if (typeof enabled === "boolean") dispatchLegacy("wuliao:vocabulary-shuffle", { enabled });
        return;
      }
      case "HARDWARE_BACK":
        ++navigationVersion; pendingRoute = "";
        try { await window.__wuliaoFlushVocabulary?.(); dispatchLegacy("wuliao:hardware-back"); }
        catch { window.alert("保存失败，请重试后再离开"); }
        return;
      default:
        return;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bridge.ready(), { once: true });
  } else {
    bridge.ready();
  }
})();

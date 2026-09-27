/**
 * VocabularyBridge —— 主应用侧词汇通信桥。
 *
 * - 负责向词汇 iframe 发送新协议消息（NAVIGATE / SET_AUTO_SPEAK /
 *   SET_SHUFFLE / HARDWARE_BACK）；
 * - 负责接收并校验子端消息（READY / ROUTE_CHANGED / BACK / SESSION_UPDATED /
 *   STATIC_PAGE / HARDWARE_BACK_RESPONSE），校验失败的消息一律忽略；
 * - 兼容旧格式消息（wuliao:vocabulary-*）并映射到同一回调，避免既有
 *   bundle 在过渡期失效；
 * - 账号切换 / iframe 重挂载时调用 reset() 重新握手，绝不跨账号复用状态。
 *
 * 不依赖 React，不读 DOM（iframe window 由调用方注入），可单测。
 */

import {
  buildVocabularyMessage,
  isVocabularyMessage,
  validateVocabularyPayload,
  VocabMessageType,
} from "./vocabularyProtocol";

function isTrustedFrameMessage(event, frameWindow, expectedOrigin) {
  if (!event || !frameWindow) return false;
  if (event.source !== frameWindow) return false;
  if (expectedOrigin && event.origin && event.origin !== expectedOrigin) return false;
  return true;
}

export function createVocabularyBridge({
  frameWindow = () => null,
  messageTargetOrigin = () => "*",
  expectedOrigin = "",
  onEvent = () => {},
} = {}) {
  let ready = false;
  const listenerSet = new Set();
  const pendingFlushes = new Map();
  let requestSerial = 0;
  function flush() {
    const requestId = `flush:${++requestSerial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingFlushes.delete(requestId); reject(new Error("词汇保存等待超时，请重试")); }, 15000);
      pendingFlushes.set(requestId, { resolve, reject, timer });
      if (!send(VocabMessageType.FLUSH_PENDING, { requestId })) {
        clearTimeout(timer); pendingFlushes.delete(requestId); reject(new Error("词汇页面尚未连接"));
      }
    });
  }

  function send(type, payload) {
    const frame = typeof frameWindow === "function" ? frameWindow() : frameWindow;
    if (!frame || typeof frame.postMessage !== "function") return false;
    try {
      frame.postMessage(buildVocabularyMessage(type, payload), messageTargetOrigin());
      return true;
    } catch {
      return false;
    }
  }

  function handleMessage(event) {
    const frame = typeof frameWindow === "function" ? frameWindow() : frameWindow;
    if (!event || !frame) return;
    if (!isTrustedFrameMessage(event, frame, expectedOrigin)) return;

    const data = event.data || {};
    if (!isVocabularyMessage(data)) return;
    if (!validateVocabularyPayload(data.type, data.payload)) return;

    if (data.type === VocabMessageType.READY) {
      ready = true;
    }
    if (data.type === VocabMessageType.FLUSH_RESULT) {
      const pending = pendingFlushes.get(data.payload.requestId);
      if (pending) {
        clearTimeout(pending.timer); pendingFlushes.delete(data.payload.requestId);
        if (data.payload.ok) pending.resolve(); else pending.reject(new Error(data.payload.error || "词汇记录保存失败"));
      }
    }
    const normalized = { type: data.type, payload: data.payload, event };
    for (const listener of [...listenerSet]) {
      try {
        listener(normalized);
      } catch {
        // 单个监听器异常不影响其他监听器
      }
    }
    onEvent(normalized);
  }

  function on(listener) {
    if (typeof listener !== "function") return () => {};
    listenerSet.add(listener);
    return () => listenerSet.delete(listener);
  }

  function reset() {
    ready = false;
    for (const pending of pendingFlushes.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("词汇页面已切换"));
    }
    pendingFlushes.clear();
  }

  function isReady() {
    return ready;
  }

  return {
    flush,
    send,
    handleMessage,
    on,
    reset,
    isReady,
  };
}

export { VocabMessageType };

/**
 * 词汇子应用通信协议 —— 主 App 与词汇 iframe 之间的正式契约。
 *
 * 消息结构（双向一致）：
 *   {
 *     namespace: "wuliao:vocabulary",
 *     version: 1,
 *     type: "READY" | "NAVIGATE" | ...,
 *     payload: { ... }
 *   }
 *
 * 校验规则（接收方必须执行）：
 *   - event.source === 期望的 iframe window（父端）；
 *   - event.source === window.parent（子端）；
 *   - http(s) 下 origin 必须一致（file:// / Capacitor 本地 origin 兼容放宽）；
 *   - namespace / version / type 必须匹配；
 *   - payload 形状按 type 白名单校验。
 *
 * 兼容说明：R3 前存在多套未版本化消息（wuliao:vocabulary-route 等）。
 * 本协议是新契约；子应用 adapter 负责把旧格式事件转换为新协议消息，
 * 父端 bridge 对新旧格式都做校验与处理，保证既有 bundle 不失效。
 */

export const VOCABULARY_NAMESPACE = "wuliao:vocabulary";
export const VOCABULARY_PROTOCOL_VERSION = 1;

export const VocabMessageType = Object.freeze({
  /** 子端初始化完成，父端可安全发送导航/设置指令 */
  READY: "READY",
  UNKNOWN_WORDS_CHANGED: "UNKNOWN_WORDS_CHANGED",
  FLUSH_PENDING: "FLUSH_PENDING",
  FLUSH_RESULT: "FLUSH_RESULT",
  REQUEST_SCREENING_CONTEXT: "REQUEST_SCREENING_CONTEXT",
  SCREENING_CONTEXT: "SCREENING_CONTEXT",
  /** 父端 → 子端：请求导航到指定内部 route */
  NAVIGATE: "NAVIGATE",
  /** 子端 → 父端：子端内部 route 已变化 */
  ROUTE_CHANGED: "ROUTE_CHANGED",
  /** 子端 → 父端：子端请求父端执行 App 级返回 */
  BACK: "BACK",
  /** 父端 → 子端：同步自动读音开关 */
  SET_AUTO_SPEAK: "SET_AUTO_SPEAK",
  /** 父端 → 子端：同步乱序筛查开关 */
  SET_SHUFFLE: "SET_SHUFFLE",
  /** 子端 → 父端：复习/背诵 session 有更新（父端用于失效 Snapshot） */
  SESSION_UPDATED: "SESSION_UPDATED",
  /** 父端 → 子端：Android 硬件返回（子端先退内部路由） */
  HARDWARE_BACK: "HARDWARE_BACK",
  /** 子端 → 父端：硬件返回处理结果（atRoot 时父端执行 App 返回） */
  HARDWARE_BACK_RESPONSE: "HARDWARE_BACK_RESPONSE",
  /** 子端 → 父端：静态页（背诵/复习/导入）已加载 */
  STATIC_PAGE: "STATIC_PAGE",
});

export const VOCABULARY_MESSAGE_TYPES = new Set(Object.values(VocabMessageType));

export function buildVocabularyMessage(type, payload) {
  return {
    namespace: VOCABULARY_NAMESPACE,
    version: VOCABULARY_PROTOCOL_VERSION,
    type,
    payload: payload === undefined ? null : payload,
  };
}

export function isVocabularyMessage(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.namespace === VOCABULARY_NAMESPACE
    && value.version === VOCABULARY_PROTOCOL_VERSION
    && typeof value.type === "string"
    && VOCABULARY_MESSAGE_TYPES.has(value.type),
  );
}

/** 按 type 校验 payload 形状；不匹配返回 false，避免未知 payload 进入业务。 */
export function validateVocabularyPayload(type, payload) {
  const value = payload === undefined || payload === null ? {} : payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  switch (type) {
    case VocabMessageType.UNKNOWN_WORDS_CHANGED:
      return typeof value.username === "string" && value.username.length > 0;
    case VocabMessageType.FLUSH_PENDING:
      return typeof value.requestId === "string";
    case VocabMessageType.FLUSH_RESULT:
      return typeof value.requestId === "string" && typeof value.ok === "boolean";
    case VocabMessageType.REQUEST_SCREENING_CONTEXT:
      return typeof value.requestId === "string";
    case VocabMessageType.SCREENING_CONTEXT:
      return typeof value.requestId === "string" && (typeof value.error === "string" || Array.isArray(value.context?.words));
    case VocabMessageType.READY:
      return true;
    case VocabMessageType.NAVIGATE:
      return typeof value.route === "string" && value.route.length > 0;
    case VocabMessageType.ROUTE_CHANGED:
      return typeof value.route === "string";
    case VocabMessageType.BACK:
      return true;
    case VocabMessageType.SET_AUTO_SPEAK:
      return typeof value.enabled === "boolean";
    case VocabMessageType.SET_SHUFFLE:
      return typeof value.enabled === "boolean";
    case VocabMessageType.SESSION_UPDATED:
      return true;
    case VocabMessageType.HARDWARE_BACK:
      return true;
    case VocabMessageType.HARDWARE_BACK_RESPONSE:
      return typeof value.atRoot === "boolean";
    case VocabMessageType.STATIC_PAGE:
      return typeof value.page === "string";
    default:
      return false;
  }
}

/** 父端 / 子端共用：http(s) 下 postMessage 必须携带 origin，本地 file/Capacitor 放宽为 *。 */
export function vocabularyUsesHttpMessaging() {
  try {
    const protocol = (typeof window !== "undefined" && window.location?.protocol) || "";
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function vocabularyMessageTargetOrigin() {
  try {
    return vocabularyUsesHttpMessaging() ? window.location.origin : "*";
  } catch {
    return "*";
  }
}


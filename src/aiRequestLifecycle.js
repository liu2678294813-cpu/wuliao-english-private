/**
 * AI Request Lifecycle —— R3 AI 请求基础设施收口。
 *
 * 职责（只做基础设施，不碰教学语义）：
 *   - 分配 requestId；
 *   - 跟踪"当前业务上下文"（resourceId / passageId / clozeId /
 *     questionId / sentenceId / taskType 或等价键）；
 *   - 上下文切换时 abort 所有仍在飞行中的请求（需要调用方把 signal
 *     透传给 callDeepSeek / fetcher）；
 *   - 同一文章/段落内切换题目/句子时，新请求自动取代旧请求；
 *   - 提供 isContextStale(requestId)：异步 settle 后判定该请求是否仍属于
 *     当前上下文；过期结果一律丢弃，绝不允许旧请求覆盖新上下文。
 *
 * stale 语义（以 activeContext 为准，非空键必须相等）：
 *   - 请求上下文中 activeContext 未声明的键（如 sentenceId）不参与 stale
 *     判定 —— 调用方在 aiContext 中声明哪些键，就约束哪些键；
 *   - taskType 不参与 stale 判定（同位置 hint1 → hint2 属于对话延续）。
 *
 * 使用方式（调用方约定）：
 *   1. 每次发起请求：requestId = lifecycle.nextRequestId()；
 *      lifecycle.beginRequest({ requestId, context, controller })。
 *   2. 业务上下文变化（切文章/段落/题目/句子）时：
 *      lifecycle.setActiveContext(nextContext) —— 内部自动 abort 旧请求；
 *      或在 beginRequest 时携带新目标，同位置的旧目标请求被取代。
 *   3. settle 后：if (lifecycle.isContextStale(requestId)) return; 丢弃结果；
 *      最后 lifecycle.endRequest(requestId)。
 *
 * 本模块不持有任何业务状态，不写存储，不派发事件，可单测。
 */

const POSITION_KEYS = ["resourceId", "passageId", "clozeId", "questionId", "sentenceId"];

export function createAiRequestLifecycle() {
  let activeContext = null;
  let nextId = 0;
  const inflight = new Map();

  return {
    nextRequestId() {
      nextId += 1;
      return nextId;
    },

    getActiveContext() {
      return activeContext;
    },

    setActiveContext(context) {
      const next = context || null;
      const changed = !positionsEqual(next, activeContext);
      activeContext = next;
      if (changed) {
        abortAll(inflight);
      }
      return activeContext;
    },

    beginRequest({ requestId, context, controller = null }) {
      if (requestId == null) return null;
      const ctx = context || null;
      for (const [id, entry] of inflight) {
        if (sameLocation(entry.context, ctx) && !sameTarget(entry.context, ctx)) {
          abortEntry(entry);
          inflight.delete(id);
        }
      }
      inflight.set(requestId, { context: ctx, controller });
      return requestId;
    },

    endRequest(requestId) {
      inflight.delete(requestId);
    },

    cancelAll() {
      abortAll(inflight);
    },

    isContextStale(requestId) {
      const entry = inflight.get(requestId);
      // 请求已被 abort / 被新目标取代 / 已清理 → 一律视为过期，结果必须丢弃。
      if (!entry) return true;
      return !contextMatches(entry.context, activeContext);
    },

    inflightCount() {
      return inflight.size;
    },
  };
}

function abortEntry(entry) {
  try {
    entry.controller?.abort?.();
  } catch {
    // abort 失败不影响上下文切换本身
  }
}

function abortAll(inflight) {
  for (const entry of inflight.values()) {
    abortEntry(entry);
  }
  inflight.clear();
}

function sameLocation(left, right) {
  return Boolean(left && right)
    && left.resourceId === right.resourceId
    && left.passageId === right.passageId
    && left.clozeId === right.clozeId;
}

function hasTarget(ctx) {
  return Boolean(ctx && (String(ctx.questionId || "") || String(ctx.sentenceId || "")));
}

function sameTarget(left, right) {
  return hasTarget(left) && hasTarget(right)
    && left.questionId === right.questionId
    && left.sentenceId === right.sentenceId;
}

function positionsEqual(left, right) {
  if (!left || !right) return left === right;
  return POSITION_KEYS.every((key) => left[key] === right[key]);
}

// activeContext 为准：请求上下文中，active 已声明的非空键必须一致。
function contextMatches(requestCtx, activeCtx) {
  if (!requestCtx || !activeCtx) return false;
  for (const key of POSITION_KEYS) {
    const declared = activeCtx[key];
    if (declared && requestCtx[key] !== declared) return false;
  }
  return true;
}

export function aiRequestContext(detail = {}) {
  return {
    resourceId: String(detail?.resourceId || ""),
    passageId: String(detail?.passageId || ""),
    clozeId: String(detail?.clozeId || ""),
    questionId: String(detail?.questionId || ""),
    sentenceId: String(detail?.sentenceId || detail?.itemId || ""),
    taskType: String(detail?.type || detail?.taskType || ""),
  };
}

// 调用方把父组件注入的文章/段落上下文与本次请求派生上下文合并。
// 关键规则：派生上下文中为空的键绝不覆盖父上下文的非空值，否则普通讲解/
// 快译等不带位置字段的请求会把 resourceId/passageId 覆盖成空串，
// 导致 isContextStale() 把所有结果误判为过期（R4 修复的真实缺陷）。
export function mergeAiRequestContext(parentContext = {}, detail = {}) {
  const derived = aiRequestContext(detail);
  const output = { ...(parentContext || {}) };
  for (const [key, value] of Object.entries(derived)) {
    if (value) output[key] = value;
  }
  return output;
}

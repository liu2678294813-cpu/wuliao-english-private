// 陌生词共享交互层（精读 / 完形唯一 source of truth）。
//
// 从 CustomDeepReader 抽取，语义与其原实现完全一致：
//   - token 识别 / DOM point hit-test / selection highlight / saved highlight
//   - Shared Ink Runtime 的 beforeInk* 钩子骨架（tool=unknown 时收集 token、abort 常规会话）
//
// 宿主（CustomDeepReader / ClozeReader）只负责：
//   - 正文提供 [data-unknown-scope]（token 命中范围）
//   - 提供释义链上下文（sentence 文本 / AI key / 元数据）后 commit
//   - 监听 wuliao:unknown-words-updated 刷新 saved highlight
//
// 存储始终是同一个 IndexedDB `unknown-words` store；完形记录只增加
// sourceType:"cloze" 等元数据（见 clozeUnknownWords.buildClozeUnknownEntry）。

export const UNKNOWN_WORD_PATTERN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
export const SAVED_UNKNOWN_HIGHLIGHT = "wuliao-unknown-words";
export const ACTIVE_UNKNOWN_HIGHLIGHT = "wuliao-unknown-selecting";

// SHOW_TEXT = 0x4；NodeFilter 在部分 jsdom/SSR 环境缺失，回退到数值常量。
const TEXT_NODE_FILTER = globalThis.NodeFilter?.SHOW_TEXT ?? 0x4;

export function textNodesInUnknownScope(scope) {
  const nodes = [];
  const walker = document.createTreeWalker(scope, TEXT_NODE_FILTER);
  let node = walker.nextNode();
  while (node) {
    if (!node.parentElement?.closest("[data-unknown-ignore]")) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

export function unknownWordRanges(scope) {
  const ranges = [];
  let wordIndex = 0;
  for (const node of textNodesInUnknownScope(scope)) {
    for (const match of node.data.matchAll(UNKNOWN_WORD_PATTERN)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push({
        word: match[0],
        occurrenceId: `${scope.dataset.unknownScope}:${wordIndex++}`,
        range,
      });
    }
  }
  return ranges;
}

export function unknownWordFromPoint(clientX, clientY) {
  const caret = document.caretPositionFromPoint?.(clientX, clientY);
  const fallback = caret ? null : document.caretRangeFromPoint?.(clientX, clientY);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (node?.nodeType !== 3 || !Number.isFinite(offset)) return null; // TEXT_NODE = 3（不依赖全局 Text）
  const scope = node.parentElement?.closest("[data-unknown-scope]");
  if (!scope || node.parentElement?.closest("[data-unknown-ignore]")) return null;
  return unknownWordRanges(scope).find((token) => {
    if (token.range.startContainer !== node) return false;
    if (offset < token.range.startOffset || offset > token.range.endOffset) return false;
    return [...token.range.getClientRects()].some((rect) => (
      clientX >= rect.left - 2 && clientX <= rect.right + 2
      && clientY >= rect.top - 2 && clientY <= rect.bottom + 2
    ));
  }) || null;
}

export function setUnknownHighlight(name, ranges) {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;
  if (!document.querySelector("style[data-unknown-highlight-styles]")) {
    const style = document.createElement("style");
    style.dataset.unknownHighlightStyles = "true";
    style.textContent = `
      ::highlight(${SAVED_UNKNOWN_HIGHLIGHT}) { background: rgba(226, 111, 81, 0.13); text-decoration: underline rgba(226, 111, 81, 0.8) 1.5px; }
      ::highlight(${ACTIVE_UNKNOWN_HIGHLIGHT}) { background: rgba(226, 111, 81, 0.24); text-decoration: underline #e26f51 2px; }
    `;
    document.head.append(style);
  }
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

// saved highlight：把所有已保存陌生词的 range 一次性设置（精读原逻辑）。
export function highlightSavedUnknownWords({ root, selectedOccurrences }) {
  const ranges = [];
  root?.querySelectorAll("[data-unknown-scope]").forEach((scope) => {
    unknownWordRanges(scope).forEach((token) => {
      if (selectedOccurrences.has(token.occurrenceId)) ranges.push(token.range);
    });
  });
  setUnknownHighlight(SAVED_UNKNOWN_HIGHLIGHT, ranges);
}

// 把划过/点中的 token 收集进 selection 会话，并更新 active highlight。
// 返回 token（无命中返回 null）——与精读 collectUnknownToken 语义一致。
export function collectUnknownTokenInto(selection, event) {
  const token = unknownWordFromPoint(event.clientX, event.clientY);
  if (!token || !selection) return null;
  selection.tokens.set(token.occurrenceId, token);
  setUnknownHighlight(
    ACTIVE_UNKNOWN_HIGHLIGHT,
    [...selection.tokens.values()].map((item) => item.range),
  );
  return token;
}

// Shared Ink Runtime beforeInk* 钩子骨架（精读 unknown 选择同款语义）：
//   toolRef.current === "unknown" 时启动 selection 会话并 abort 常规 ink 会话。
// onCommit(selection) 由宿主实现释义链与存储；onError 报告失败。
export function createUnknownSelectionHooks({ toolRef, selectionRef, onCollect, onCommit, onError,
  fallbackToPenOnPenMiss = false, isWritingArea, onRequestPenMode }) {
  return {
    beforeInkDown(event) {
      if (toolRef.current !== "unknown") return undefined;
      selectionRef.current = { id: event.pointerId, tokens: new Map() };
      const token = onCollect(event);
      if (fallbackToPenOnPenMiss && event.pointerType === "pen" && !token
        && isWritingArea?.(event) && onRequestPenMode) {
        selectionRef.current = null;
        setUnknownHighlight(ACTIVE_UNKNOWN_HIGHLIGHT, []);
        onRequestPenMode();
        return undefined;
      }
      return "abort";
    },
    beforeInkMove(event) {
      const selection = selectionRef.current;
      if (selection?.id !== event.pointerId) return undefined;
      event.preventDefault();
      onCollect(event);
      return "abort";
    },
    beforeInkFinish(event) {
      const selection = selectionRef.current;
      if (selection?.id !== event.pointerId) return undefined;
      selectionRef.current = null;
      Promise.resolve(onCommit(selection)).catch((reason) => {
        onError?.(`陌生词保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
      return "abort";
    },
  };
}

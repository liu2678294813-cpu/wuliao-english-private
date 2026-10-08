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
        occurrenceId: `${scope.dataset.unknownScope}:${wordIndex}`,
        wordIndex: wordIndex++,
        scope,
        sentenceElement: node.parentElement?.closest("[data-sentence-scope]") || scope,
        range,
      });
    }
  }
  return ranges;
}

export function unknownWordFromPoint(clientX, clientY, cache) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const caret = document.caretPositionFromPoint?.(clientX, clientY);
  const fallback = caret ? null : document.caretRangeFromPoint?.(clientX, clientY);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (node?.nodeType !== 3 || !Number.isFinite(offset)) return null; // TEXT_NODE = 3（不依赖全局 Text）
  const scope = node.parentElement?.closest("[data-unknown-scope]");
  if (!scope || node.parentElement?.closest("[data-unknown-ignore]")) return null;
  let tokens = cache?.get(scope);
  if (!tokens) { tokens = unknownWordRanges(scope); cache?.set(scope, tokens); }
  return tokens.find((token) => {
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
  const token = unknownWordFromPoint(event.clientX, event.clientY, selection?.tokenCache);
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
  fallbackToPenOnPenMiss = false, isWritingArea, onRequestPenMode, cancelOnInterrupted = false }) {
  return {
    beforeInkDown(event) {
      if (toolRef.current !== "unknown") return undefined;
      if (selectionRef.current?.id === event.pointerId) return "abort";
      setUnknownHighlight(ACTIVE_UNKNOWN_HIGHLIGHT, []);
      selectionRef.current = { id: event.pointerId, tokens: new Map(), tokenCache: new WeakMap() };
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
      if (cancelOnInterrupted && event.type && event.type !== "pointerup") {
        selectionRef.current = null;
        setUnknownHighlight(ACTIVE_UNKNOWN_HIGHLIGHT, []);
        return "abort";
      }
      if (cancelOnInterrupted) onCollect(event);
      selectionRef.current = null;
      Promise.resolve(onCommit(selection)).catch((reason) => {
        onError?.(`陌生词保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
      return "abort";
    },
  };
}

export function unknownSentenceContextFromToken(token, passageId) {
  const element = token.sentenceElement || token.range?.startContainer?.parentElement?.closest("[data-sentence-scope]") || token.scope;
  if (!element?.isConnected) return null;
  const clone = element.cloneNode(true);
  clone.querySelectorAll("[data-unknown-ignore]").forEach((node) => node.remove());
  const sentence = (clone.textContent || "").replace(/\s+/g, " ").trim();
  if (!sentence) return null;
  const scope = element.dataset.sentenceScope || token.scope?.dataset.unknownScope || "custom";
  const match = /^(?:(?:clean|translation|repeat):)?(p\d+:s\d+)$/.exec(scope);
  const identity = match ? match[1] : `${scope.replace(/^(clean|translation|repeat):/, "")}:${sentence.normalize("NFKC")}`;
  return { element, sentence, contextKey: `${passageId}:${identity}` };
}

// Group by physical DOM sentence before canonicalizing: repeated UI copies must
// not bridge one another's token indexes. Only resolve a contiguous span on up.
export function expandUnknownSelectionSpans(selection, passageId) {
  const groups = new Map();
  for (const token of selection?.tokens?.values() || []) {
    const context = unknownSentenceContextFromToken(token, passageId);
    // A replaced/unmounted sentence invalidates the entire gesture. Keeping
    // only its surviving hits could otherwise save a truncated phrase.
    if (!context || !token.scope?.isConnected || !token.range?.startContainer?.isConnected) return [];
    let sentences = groups.get(token.scope);
    if (!sentences) { sentences = new Map(); groups.set(token.scope, sentences); }
    let group = sentences.get(context.element);
    if (!group) { group = { ...context, hits: [] }; sentences.set(context.element, group); }
    group.hits.push(token.wordIndex);
  }
  const spans = [];
  for (const [scope, sentences] of groups) {
    const tokens = selection.tokenCache?.get(scope) || unknownWordRanges(scope);
    for (const group of sentences.values()) {
      const min = Math.min(...group.hits), max = Math.max(...group.hits);
      const selected = tokens.filter((token) => token.sentenceElement === group.element && token.wordIndex >= min && token.wordIndex <= max);
      if (!selected.length) continue;
      spans.push({ word: selected.map((token) => token.word).join(" "), sentence: group.sentence,
        contextKey: group.contextKey, occurrenceIds: selected.map((token) => token.occurrenceId) });
    }
  }
  return spans;
}

// Coordinates are authoritative when the input target is a captured surface or
// an overlay. elementsFromPoint allows the paper beneath a canvas to be found.
export function unknownPointerRegion(event, root) {
  const elements = document.elementsFromPoint?.(event.clientX, event.clientY)
    || [document.elementFromPoint?.(event.clientX, event.clientY) || event.target];
  for (const element of elements) {
    if (!element || !root?.contains(element)) continue;
    if (element.closest?.("button,input,select,[contenteditable=true],[data-unknown-ignore],textarea:not([data-ink-only=true])")) return "control";
    if (element.closest?.("[data-unknown-scope]")) return "english";
    if (element.closest?.(".translation-unit,.deep-writing-lines")) return "writing";
  }
  return "other";
}

export function shouldHandleDirectUnknownTap({ pointerType, button = 0, noteMode, activeInk, enabled }) {
  if (!enabled || activeInk || !["touch", "mouse", "pen"].includes(pointerType)) return false;
  if (pointerType === "mouse" && button !== 0) return false;
  return pointerType === "touch" || !noteMode;
}

export function createDirectUnknownTap({ canHandle, hitTest = unknownWordFromPoint, onCommit, onError,
  maxDisplacement = 10, maxDuration = 350 }) {
  let candidate = null;
  const pointers = new Set();
  const timestamp = (event) => Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
  function cancel() { candidate = null; }
  function reset() { cancel(); pointers.clear(); }
  return {
    cancel, reset,
    down(event) {
      if (pointers.has(event.pointerId)) return Boolean(candidate?.id === event.pointerId);
      pointers.add(event.pointerId);
      if (pointers.size > 1) { cancel(); return false; }
      if (!canHandle(event)) return false;
      const token = hitTest(event.clientX, event.clientY);
      if (!token) return false;
      candidate = { id: event.pointerId, pointerType: event.pointerType, x: event.clientX,
        y: event.clientY, time: timestamp(event), token, maxDisplacement: 0 };
      return true;
    },
    move(event) {
      if (candidate?.id !== event.pointerId) return false;
      const samples = event.nativeEvent?.getCoalescedEvents?.() || event.getCoalescedEvents?.() || [];
      for (const sample of [...samples, event]) candidate.maxDisplacement = Math.max(candidate.maxDisplacement,
        Math.hypot(sample.clientX - candidate.x, sample.clientY - candidate.y));
      return true;
    },
    finish(event) {
      pointers.delete(event.pointerId);
      if (candidate?.id !== event.pointerId) return false;
      const tap = candidate;
      cancel();
      const distance = Math.max(tap.maxDisplacement, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
      if (event.type !== "pointerup" || event.pointerType !== tap.pointerType || !canHandle(event)
        || distance > maxDisplacement || timestamp(event) - tap.time > maxDuration) return true;
      const token = hitTest(event.clientX, event.clientY);
      if (!token || token.occurrenceId !== tap.token.occurrenceId || token.scope !== tap.token.scope) return true;
      Promise.resolve().then(() => onCommit({ id: tap.id, tokens: new Map([[token.occurrenceId, token]]) })).catch(onError);
      return true;
    },
  };
}

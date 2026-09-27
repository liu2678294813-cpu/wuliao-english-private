import {
  buildTextRange,
  buildTextSegment,
  resolveEntry,
} from "./questionEvidence";

const DEFAULT_HIGHLIGHT_NAME = "wuliao-question-evidence";

function textOffsetWithin(root, container, offset) {
  const doc = root?.ownerDocument;
  if (!doc || !root.contains(container)) return null;
  const prefix = doc.createRange();
  prefix.selectNodeContents(root);
  try {
    prefix.setEnd(container, offset);
  } catch {
    return null;
  }
  return prefix.toString().length;
}

function sentenceNodeMeta(node) {
  const paragraphNumber = Number(node?.dataset?.evidenceParagraph);
  const sentenceIndex = Number(node?.dataset?.evidenceSentence);
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) return null;
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0) return null;
  return { paragraphNumber, sentenceIndex };
}

function closestEvidenceParagraph(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return element?.closest?.("[data-evidence-paragraph][data-evidence-sentence]") || null;
}

export function evidenceRangeFromSelection(selection, articleElement, passage) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !articleElement) return null;
  const nativeRange = selection.getRangeAt(0);
  if (!articleElement.contains(nativeRange.startContainer) || !articleElement.contains(nativeRange.endContainer)) return null;
  if (!closestEvidenceParagraph(nativeRange.startContainer) || !closestEvidenceParagraph(nativeRange.endContainer)) return null;

  const segmentNodes = [...articleElement.querySelectorAll("[data-evidence-paragraph][data-evidence-sentence]")];
  const segments = [];
  for (const node of segmentNodes) {
    if (!nativeRange.intersectsNode(node)) continue;
    const meta = sentenceNodeMeta(node);
    if (!meta) continue;
    const sentenceText = String(
      passage?.paragraphs?.find((item) => item.number === meta.paragraphNumber)
        ?.sentences?.[meta.sentenceIndex] ?? node.textContent ?? "",
    );
    let startOffset = 0;
    let endOffset = node.textContent?.length || 0;
    if (node.contains(nativeRange.startContainer)) {
      startOffset = textOffsetWithin(node, nativeRange.startContainer, nativeRange.startOffset);
    }
    if (node.contains(nativeRange.endContainer)) {
      endOffset = textOffsetWithin(node, nativeRange.endContainer, nativeRange.endOffset);
    }
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) continue;
    const segment = buildTextSegment({ ...meta, sentenceText, startOffset, endOffset });
    if (segment) segments.push(segment);
  }
  const range = buildTextRange({ segments });
  return range.segments.length ? range : null;
}

function boundaryAtTextOffset(root, requestedOffset) {
  const doc = root?.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(root, 4);
  let remaining = Math.max(0, Number(requestedOffset) || 0);
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue?.length || 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return root.lastChild ? { node: root, offset: root.childNodes.length } : { node: root, offset: 0 };
}

function rangeForResolution(root, resolution) {
  if (resolution?.status !== "resolved") return null;
  const ref = resolution.ref;
  const node = root.querySelector(
    `[data-evidence-paragraph="${ref.paragraphNumber}"][data-evidence-sentence="${ref.sentenceIndex}"]`,
  );
  if (!node) return null;
  const start = boundaryAtTextOffset(node, ref.startOffset);
  const end = boundaryAtTextOffset(node, ref.endOffset);
  if (!start || !end) return null;
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return { range, node };
}

export function showEvidenceHighlight({
  entry,
  passage,
  articleElement,
  name = DEFAULT_HIGHLIGHT_NAME,
} = {}) {
  if (!entry || !articleElement) return { ok: false, reason: "missing", firstNode: null, clear() {} };
  const resolutions = resolveEntry(entry, passage);
  if (!resolutions.length) {
    return { ok: false, reason: "unresolved", firstNode: null, clear() {} };
  }
  const rangeCount = Array.isArray(entry.ranges) ? entry.ranges.length : 0;
  const completeRanges = [];
  for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex += 1) {
    const rangeResolutions = resolutions.filter((item) => item.rangeIndex === rangeIndex);
    if (!rangeResolutions.length || rangeResolutions.some((item) => item.status !== "resolved")) continue;
    const domRanges = rangeResolutions.map((item) => rangeForResolution(articleElement, item));
    if (domRanges.some((item) => !item)) continue;
    completeRanges.push(...domRanges);
  }
  if (!completeRanges.length) return { ok: false, reason: "unresolved", firstNode: null, clear() {} };

  const partial = completeRanges.length < resolutions.length;
  const parents = [...new Set(completeRanges.map((item) => item.node.closest(".clean-sentence") || item.node).filter(Boolean))];
  const highlightRegistry = globalThis.CSS?.highlights;
  const HighlightConstructor = globalThis.Highlight;
  if (highlightRegistry && typeof HighlightConstructor === "function") {
    highlightRegistry.delete(name);
    highlightRegistry.set(name, new HighlightConstructor(...completeRanges.map((item) => item.range)));
    return {
      ok: true,
      partial,
      method: "custom-highlight",
      firstNode: completeRanges[0].node,
      clear() { highlightRegistry.delete(name); },
    };
  }

  // No text-node splitting fallback: decorate the existing sentence parent and keep
  // the persisted excerpt available to the UI.
  parents.forEach((node) => node.classList.add("evidence-highlight-fallback"));
  return {
    ok: true,
    partial,
    method: "parent-decoration",
    firstNode: completeRanges[0].node,
    clear() { parents.forEach((node) => node.classList.remove("evidence-highlight-fallback")); },
  };
}

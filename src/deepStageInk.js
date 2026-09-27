import { stageIdForDeepInkStroke } from "./deepInkGeometry";

export function deepInkDigest(strokes) {
  const json = JSON.stringify(Array.isArray(strokes) ? strokes : []);
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${Array.isArray(strokes) ? strokes.length : 0}:${json.length}:${(hash >>> 0).toString(16)}`;
}

export function mergeDeepInkStrokes(first, second) {
  const merged = [];
  const seen = new Set();
  for (const stroke of [...(first || []), ...(second || [])]) {
    const fingerprint = JSON.stringify(stroke);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    merged.push(stroke);
  }
  return merged;
}

export function partitionDeepInkByStage(strokes, snapshot, stageIds) {
  const allowed = new Set(stageIds || []);
  const byStage = Object.fromEntries((stageIds || []).map((stageId) => [stageId, []]));
  const unresolved = [];
  for (const stroke of strokes || []) {
    const stageId = stageIdForDeepInkStroke(stroke, snapshot);
    if (!allowed.has(stageId)) {
      unresolved.push(stroke);
      continue;
    }
    byStage[stageId].push(stroke);
  }
  return { byStage, unresolved };
}

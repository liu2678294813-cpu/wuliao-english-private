// C 阶段：诊断原文证据的轻量校验。
// evidence.source 必须是发送给模型的【当前文章】中逐字存在的连续英文原文。
// 这里只做显示差异归一化（空白、引号、破折号），不做语义判断。

export function normalizeEvidenceText(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .replace(/[—–―]/g, "-")
    .replace(/[‐‑]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function validateEvidenceAgainstContext(evidence, articleText) {
  const context = normalizeEvidenceText(articleText);
  if (!context) return { ok: true, invalid: [] };
  const invalid = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const source = normalizeEvidenceText(item && item.source);
    if (source && context.includes(source)) continue;
    invalid.push(item);
  }
  return { ok: invalid.length === 0, invalid };
}

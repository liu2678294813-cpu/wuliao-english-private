export function textContentToLayout(content) {
  const lines = [];
  let current = { text: "", y: null, height: 10 };

  const finishLine = () => {
    if (!current.text.trim()) return;
    lines.push({
      text: current.text.replace(/\s+/g, " ").trim(),
      y: current.y,
      height: current.height || 10,
    });
  };

  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const y = item.transform?.[5] ?? current.y;
    const height = Math.abs(item.height || item.transform?.[3] || 10);
    const startsNewLine = current.text
      && current.y !== null
      && Math.abs(y - current.y) > Math.max(2.5, height * 0.4);
    if (startsNewLine) {
      finishLine();
      current = { text: "", y, height };
    }
    if (current.y === null) current.y = y;
    current.height = Math.max(current.height, height);
    current.text += `${item.str} `;
    if (item.hasEOL) {
      finishLine();
      current = { text: "", y: null, height: 10 };
    }
  }
  finishLine();

  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  let output = "";
  lines.forEach((line, index) => {
    if (index > 0) {
      const previous = lines[index - 1];
      const gap = Math.abs(previous.y - line.y);
      output += gap > medianHeight * 1.75 ? "\n\n" : "\n";
    }
    output += line.text;
  });
  return output;
}

export function pageQuality(pages) {
  const latinRatio = (text) => {
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const han = (text.match(/[\u2e80-\u9fff]/g) || []).length;
    return latin / Math.max(1, latin + han);
  };

  return pages.map((page) => {
    const text = String(page.text || "");
    const compact = text.replace(/\s+/g, "");
    const pageLatinRatio = latinRatio(text);
    const junk = text.replace(/[A-Za-z0-9.,;:!?'"()\[\]\s-]/g, "").length;
    const junkRatio = compact ? junk / Math.max(1, compact.length) : 1;
    const empty = compact.length < 12;
    const needsOcr = empty
      || (compact.length < 300 && junkRatio > 0.45)
      || (compact.length < 80 && pageLatinRatio < 0.5);
    return {
      pageNumber: page.pageNumber,
      chars: compact.length,
      junkRatio,
      latinRatio: pageLatinRatio,
      empty,
      needsOcr,
    };
  });
}

export function ocrPageNumbers(quality, ocrPolicy = "auto") {
  return ocrPolicy === "auto"
    ? quality.filter((entry) => entry.needsOcr).map((entry) => entry.pageNumber)
    : [];
}

// 2026-08-13：页面 warning 与 pageQuality 使用同一事实源（empty / needsOcr）。
// 禁止再使用独立的 raw junkRatio 阈值，避免“正文足够长但 junkRatio 高”的假警告。
export function buildPageWarnings(quality, allowOcr) {
  const warnings = [];
  for (const entry of quality) {
    if (entry.empty) {
      warnings.push(`第 ${entry.pageNumber} 页没有可用的文字层`);
    } else if (entry.needsOcr) {
      warnings.push(allowOcr
        ? `第 ${entry.pageNumber} 页文字层异常，已尝试 OCR 修正`
        : `第 ${entry.pageNumber} 页文字层异常，未启用 OCR`);
    }
  }
  return warnings;
}

export function hasUsableContent(analysis, ocrPolicy = "auto") {
  const hasPassage = analysis?.passages?.some((passage) => passage?.paragraphs?.length);
  if (ocrPolicy === "disabled") return Boolean(hasPassage);
  return Boolean(hasPassage || analysis?.totals?.clozes);
}

export const HANDWRITING_ROW_HEIGHT = 120;

export function initialHandwritingScroll(session, currentIndex = 0) {
  if (Number.isFinite(session?.scrollTop)) return Math.max(0, session.scrollTop);
  return Math.max(0, session?.page != null ? session.page * 20 : currentIndex) * HANDWRITING_ROW_HEIGHT;
}

export function needsHandwritingWork(answer) {
  if (!answer) return false;
  if (answer.strokeCount > 0 && answer.textSource !== "keyboard") {
    return !answer.inkFingerprint || answer.recognizedFingerprint !== answer.inkFingerprint
      || answer.unsure || answer.stale || !answer.classified;
  }
  return Boolean(answer.text?.trim()) && (answer.stale || !answer.classified);
}

// Work on a captured list, then validate each answer again before publishing.
// Rendering and provider calls are injected so offscreen, retry and race paths
// can be exercised without a live model or a mounted canvas.
export async function runHandwritingWorkflow({ words, read, same, change, applyVerdict, image, recognize, compare, signal, onProgress = () => {} }) {
  const candidates = words.map(word => ({ ...word, ...read(word.wordId) })).filter(needsHandwritingWork);
  const result = { total: candidates.length, completed: 0, unsure: 0, errors: [] };
  const alive = () => !signal?.aborted;
  for (let offset = 0; offset < candidates.length && alive(); offset += 5) {
    const batch = candidates.slice(offset, offset + 5);
    const images = [], toCompare = [];
    onProgress(`识别与判断 ${offset}/${candidates.length}…`);
    for (const captured of batch) {
      if (!same(captured) || !alive()) continue;
      if (captured.strokeCount > 0 && captured.textSource !== "keyboard" &&
          (captured.recognizedFingerprint !== captured.inkFingerprint || captured.unsure)) {
        try {
          const encoded = await image(captured);
          if (!encoded) throw new Error("笔迹为空，请重新书写");
          images.push({ id: captured.id, image: encoded, captured });
        } catch (error) { result.errors.push({ wordId: captured.wordId, stage: "读取笔迹", message: error.message }); }
      } else if (captured.text?.trim()) toCompare.push(captured);
    }
    if (images.length && alive()) {
      try {
        const rows = await recognize(images.map(({ id, image }) => ({ id, image })));
        for (const item of images) {
          if (!same(item.captured) || !alive()) continue;
          const row = rows.find(row => row.id === item.id);
          if (!row) { result.errors.push({ wordId: item.captured.wordId, stage: "识别", message: "服务未返回该词的结果" }); continue; }
          const unsure = row.unsure || !row.text.trim();
          const next = change(item.captured.wordId, { text: row.text, unsure, recognizedFingerprint: item.captured.inkFingerprint,
            textSource: "handwriting", stale: true, revision: item.captured.revision + 1 });
          if (!next) continue;
          const captured = { ...item.captured, ...next };
          if (unsure) { await applyVerdict(captured, "unsure", "识别不清，请人工核对或重新识别"); result.unsure++; }
          else toCompare.push(captured);
        }
      } catch (error) { images.forEach(item => result.errors.push({ wordId: item.captured.wordId, stage: "识别", message: error.message })); }
    }
    const ready = toCompare.filter(same);
    if (ready.length && alive()) {
      try {
        const rows = await compare(ready);
        for (const captured of ready) {
          if (!same(captured) || !alive()) continue;
          const row = rows.find(row => row.id === captured.id);
          if (!row) { result.errors.push({ wordId: captured.wordId, stage: "判断", message: "服务未返回该词的判断" }); continue; }
          try {
            if (await applyVerdict(captured, row.verdict, row.reason)) {
              if (row.verdict === "unsure") result.unsure++; else result.completed++;
            }
          } catch (error) { result.errors.push({ wordId: captured.wordId, stage: "归类保存", message: error.message }); }
        }
      } catch (error) { ready.forEach(item => result.errors.push({ wordId: item.wordId, stage: "判断", message: error.message })); }
    }
  }
  return result;
}

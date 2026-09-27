import { useEffect, useRef, useState } from "react";
import { PDF_PARSER_VERSION, parsePdfFile } from "./pdfParser";
import { setParseCache } from "./storage";
import { runPdfStructureFallback } from "./pdfAiStructureService";
import {
  buildImportSummary,
  clozeRawText,
  importFailureMessage,
  passageRawText,
  reparseCloze,
  reparsePassage,
  validateExamAnalysis,
} from "./examImport";

const PHASE_LABELS = {
  reading: "读取文件",
  fingerprint: "计算文件指纹",
  text: "PDF.js 提取正文",
  quality: "检查文本质量",
  "ocr-loading": "加载本地 OCR",
  ocr: "OCR 识别页面",
  structure: "识别试卷结构",
  done: "生成预览",
};

function ProgressBar({ progress }) {
  if (!progress) return null;
  const percent = Math.max(1, Math.min(100, progress.percent || 0));
  const label = progress.phase === "ocr"
    ? `${PHASE_LABELS[progress.phase] || "解析"}：第 ${progress.page}/${progress.total} 页`
    : progress.phase === "text"
      ? `提取第 ${progress.page}/${progress.total} 页文本`
      : PHASE_LABELS[progress.phase] || "解析中";
  return (
    <div className="import-progress">
      <span>{label}</span>
      <div className="import-track"><span style={{ width: `${percent}%` }} /></div>
      <small>{percent}%</small>
    </div>
  );
}

export default function ExamImportEditor({ record, file, fingerprint, cachedAnalysis, onSave, onClose }) {
  const [working, setWorking] = useState(null);
  const [busy, setBusy] = useState(!cachedAnalysis);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [sourcePages, setSourcePages] = useState([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReviewConfirmed, setAiReviewConfirmed] = useState(false);
  const abortRef = useRef(null);
  const parseRunRef = useRef(0);

  useEffect(() => {
    if (cachedAnalysis) {
      setWorking(structuredClone(cachedAnalysis));
      return undefined;
    }
    let cancelled = false;
    const runId = parseRunRef.current + 1;
    parseRunRef.current = runId;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    (async () => {
      const result = await parsePdfFile(file, (nextProgress) => {
        if (parseRunRef.current === runId) setProgress(nextProgress);
      }, { signal: controller.signal });
      if (cancelled || parseRunRef.current !== runId) return;
      await setParseCache(fingerprint, PDF_PARSER_VERSION, result.analysis);
      if (cancelled || parseRunRef.current !== runId) return;
      setSourcePages(result.pages || []);
      setWorking(result.analysis);
      setBusy(false);
    })().catch((reason) => {
      if (cancelled || parseRunRef.current !== runId) return;
      setSourcePages(reason?.diagnostics?.stablePages || []);
      setError(importFailureMessage(reason));
      setBusy(false);
    });
    return () => {
      cancelled = true;
      if (parseRunRef.current === runId) parseRunRef.current += 1;
      controller.abort();
    };
  }, [cachedAnalysis, file, fingerprint]);

  function cancelParse() {
    parseRunRef.current += 1;
    abortRef.current?.abort();
    setError("已取消导入，未保存任何内容");
    setBusy(false);
  }

  function retryParse(ocrPolicy = "auto") {
    abortRef.current?.abort();
    const runId = parseRunRef.current + 1;
    parseRunRef.current = runId;
    setBusy(true);
    setError("");
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    parsePdfFile(file, (nextProgress) => {
      if (parseRunRef.current === runId) setProgress(nextProgress);
    }, { signal: controller.signal, ocrPolicy })
      .then((result) => {
        if (parseRunRef.current !== runId) return null;
        return setParseCache(fingerprint, PDF_PARSER_VERSION, result.analysis)
          .then(() => {
            if (parseRunRef.current === runId) {
              setSourcePages(result.pages || []);
              setWorking(result.analysis);
            }
          });
      })
      .catch((reason) => {
        if (parseRunRef.current === runId) {
          setSourcePages(reason?.diagnostics?.stablePages || []);
          setError(importFailureMessage(reason));
        }
      })
      .finally(() => { if (parseRunRef.current === runId) setBusy(false); });
  }

  async function useAiStructureFallback() {
    const localParserFinishedWithLowConfidence = Boolean(working)
      && ["check", "incomplete"].includes(working.importConfidence?.status);
    if (!sourcePages.length || aiBusy || !localParserFinishedWithLowConfidence) return;
    setAiBusy(true);
    setError("");
    try {
      const aiAnalysis = await runPdfStructureFallback({ sourcePages, title: record.title });
      setAiReviewConfirmed(false);
      setWorking((current) => ({
        ...(current || {}),
        ...aiAnalysis,
        parserRevision: PDF_PARSER_VERSION,
        importConfidence: { ...(current?.importConfidence || {}), status: "check", aiFallback: true },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAiBusy(false);
    }
  }

  function updateClozeOptions(clozeIndex, blankNumber, key, text) {
    setWorking((current) => {
      const next = structuredClone(current);
      const cloze = next.clozes[clozeIndex];
      const blank = cloze.blanks.find((item) => item.number === blankNumber);
      const option = blank.options.find((item) => item.key === key);
      if (option) option.text = text;
      blank.complete = blank.options.every((item) => item.text.trim().length > 0);
      return next;
    });
  }

  function updateQuestion(partIndex, kind, questionIndex, changes) {
    setWorking((current) => {
      const next = structuredClone(current);
      const part = kind === "cloze" ? next.clozes[partIndex] : next.passages[partIndex];
      const question = part.questions[questionIndex] || part.blanks[questionIndex];
      Object.assign(question, changes);
      return next;
    });
  }

  function reparseClozePart(clozeIndex, rawText) {
    const parsed = reparseCloze(rawText, working.clozes[clozeIndex].sourceLabel);
    if (!parsed) {
      setError("重新解析完形失败：文本中未找到 Section I 结构");
      return;
    }
    setWorking((current) => {
      const next = structuredClone(current);
      next.clozes[clozeIndex] = { ...parsed, id: next.clozes[clozeIndex].id };
      return next;
    });
    setError("");
  }

  function reparsePassagePart(passageIndex, rawText) {
    const label = working.passages[passageIndex].label;
    const parsed = reparsePassage(rawText, label);
    if (!parsed) {
      setError("重新解析阅读失败：文本中没有可识别的段落或题目");
      return;
    }
    setWorking((current) => {
      const next = structuredClone(current);
      next.passages[passageIndex] = { ...parsed, id: next.passages[passageIndex].id };
      return next;
    });
    setError("");
  }

  function removePart(kind, index) {
    setWorking((current) => {
      const next = structuredClone(current);
      if (kind === "cloze") next.clozes.splice(index, 1);
      else next.passages.splice(index, 1);
      return next;
    });
  }

  const issues = working ? validateExamAnalysis(working) : null;
  const summary = working ? buildImportSummary(working) : null;
  const visibleWarnings = [...new Set([
    ...(Array.isArray(working?.warnings) ? working.warnings : []),
    ...(issues?.warnings || []),
  ])];
  const requiresAiReview = Boolean(working?.aiStructure);
  const canSave = Boolean(working)
    && !busy
    && issues
    && issues.errors.length === 0
    && (!requiresAiReview || aiReviewConfirmed);

  async function handleSave() {
    if (!canSave) return;
    try {
      await onSave(working);
    } catch (reason) {
      setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  return (
    <div className="import-editor-page">
      <header className="import-editor-header">
        <button className="back-button" type="button" onClick={onClose}>← 返回资料库</button>
        <div className="import-editor-title">
          <small>EXAM PDF IMPORT</small>
          <strong>{record.title}</strong>
        </div>
        <span className="import-editor-fingerprint" title="文件指纹">{fingerprint ? `#${fingerprint.slice(0, 12)}` : ""}</span>
      </header>

      <main className="import-editor-main">
        {busy && (
          <section className="import-parsing">
            <h1>正在识别试卷结构</h1>
            <p>完形 Section I 与阅读 Text 1–4 将自动结构化；只有文字层缺失的页面才会走 OCR。</p>
            <ProgressBar progress={progress} />
            <button type="button" className="import-cancel" onClick={cancelParse}>取消解析</button>
          </section>
        )}

        {error && !busy && (
          <section className="import-error">
            <strong>{error}</strong>
            <div className="import-error-actions">
              <button type="button" className="primary-button" onClick={() => retryParse("auto")}>重试本地 OCR</button>
              <button type="button" className="ai-api-test" onClick={() => retryParse("disabled")}>仅使用文字层</button>
              <button type="button" className="back-button" onClick={onClose}>返回资料库</button>
            </div>
          </section>
        )}

        {working && !busy && !error && (
          <>
            <section className="import-preview">
              <div className="import-preview-head">
                <div><small>STRUCTURED PREVIEW</small><h1>识别结果预览</h1></div>
                <span>{working.importConfidence?.status === "good" ? "识别良好" : "需要检查"} · 保存前可修正</span>
              </div>
              {working.importConfidence?.status !== "good" && sourcePages.length > 0 && !working.aiStructure && (
                <div className="import-ai-fallback">
                  <p>本地 OCR 与 parser 已完成，但题数或结构置信度不足。AI 只会接收 OCR 文本做结构整理，不会读取扫描图片或生成答案。</p>
                  <button type="button" className="ai-api-test" disabled={aiBusy} onClick={useAiStructureFallback}>
                    {aiBusy ? "AI 正在整理…" : "允许 AI 辅助结构识别"}
                  </button>
                </div>
              )}
              <div className="import-summary-grid">
                {summary.clozes.length ? (
                  summary.clozes.map((cloze, index) => (
                    <div className="import-summary-card" key={`cloze-${index}`}>
                      <span>Section I</span>
                      <strong>{cloze.complete}/{cloze.blanks} 空完整</strong>
                      <small>共 {cloze.blanks} 空</small>
                    </div>
                  ))
                ) : <div className="import-summary-card"><span>Section I</span><strong>未识别</strong><small>可在下方添加或重新解析</small></div>}
                {summary.texts.map((text, index) => (
                  <div className="import-summary-card" key={`text-${index}`}>
                    <span>{text.label}</span>
                    <strong>{text.questions} 题</strong>
                    <small>{text.paragraphs} 段</small>
                  </div>
                ))}
              </div>
              {visibleWarnings.length > 0 && (
                <ul className="import-warnings">
                  {visibleWarnings.map((warning) => <li key={warning}>⚠ {warning}</li>)}
                </ul>
              )}
              {issues && issues.errors.length > 0 && (
                <ul className="import-errors">
                  {issues.errors.map((issue) => <li key={issue}>✗ {issue}</li>)}
                </ul>
              )}
            </section>

            <section className="import-editor">
              <div className="import-editor-head"><h2>人工修正</h2><p>修正后点击"从文本重新解析"重建结构，或直接修改选项。</p></div>

              {working.clozes.map((cloze, clozeIndex) => (
                <article className="import-part-card" key={`edit-cloze-${clozeIndex}`}>
                  <header>
                    <strong>Section I · 完形（{cloze.blanks.length} 空）</strong>
                    <button type="button" className="import-part-remove" onClick={() => removePart("cloze", clozeIndex)}>删除此部分</button>
                  </header>
                  <label className="import-raw-field">正文（含空位编号）
                    <textarea
                      rows={6}
                      defaultValue={clozeRawText(cloze)}
                      onBlur={(event) => reparseClozePart(clozeIndex, event.target.value)}
                    />
                  </label>
                  <div className="import-options-grid">
                    {cloze.blanks.map((blank) => (
                      <div className="import-blank-editor" key={blank.number}>
                        <strong>第 {blank.number} 空</strong>
                        {blank.options.map((option) => (
                          <label key={option.key}>
                            <span>{option.key}</span>
                            <input
                              value={option.text}
                              onChange={(event) => updateClozeOptions(clozeIndex, blank.number, option.key, event.target.value)}
                              placeholder={`${option.key} 选项`}
                            />
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </article>
              ))}

              {working.passages.map((passage, passageIndex) => (
                <article className="import-part-card" key={`edit-text-${passageIndex}`}>
                  <header>
                    <strong>{passage.label}（{passage.questions.length} 题 · {passage.paragraphs.length} 段）</strong>
                    <button type="button" className="import-part-remove" onClick={() => removePart("reading", passageIndex)}>删除此部分</button>
                  </header>
                  <label className="import-raw-field">正文
                    <textarea
                      rows={5}
                      defaultValue={passageRawText(passage)}
                      onBlur={(event) => reparsePassagePart(passageIndex, event.target.value)}
                    />
                  </label>
                  <div className="import-question-editors">
                    {passage.questions.map((question, questionIndex) => (
                      <details className="import-question-editor" key={`${passage.label}-${questionIndex}`}>
                        <summary>第 {question.number} 题 · 题干与选项</summary>
                        <label>题号<input
                          value={question.number}
                          onChange={(event) => updateQuestion(passageIndex, "reading", questionIndex, { number: event.target.value })}
                        /></label>
                        <label>题干<textarea
                          rows={2}
                          value={question.stem}
                          onChange={(event) => updateQuestion(passageIndex, "reading", questionIndex, { stem: event.target.value })}
                        /></label>
                        {question.options.map((option) => (
                          <label key={option.key}><span>{option.key}</span><input
                            value={option.text}
                            onChange={(event) => updateQuestion(passageIndex, "reading", questionIndex, {
                              options: question.options.map((item) => item.key === option.key ? { ...item, text: event.target.value } : item),
                            })}
                          /></label>
                        ))}
                      </details>
                    ))}
                  </div>
                </article>
              ))}

              <div className="import-editor-actions">
                <span>{issues ? `${issues.errors.length} 个错误 · ${visibleWarnings.length} 个警告` : ""}</span>
                {requiresAiReview && (
                  <label className="import-ai-review-confirmation">
                    <input type="checkbox" checked={aiReviewConfirmed} onChange={(event) => setAiReviewConfirmed(event.target.checked)} />
                    我已逐项核对 AI 结构与 OCR 原文
                  </label>
                )}
                <button type="button" className="primary-button" disabled={!canSave} onClick={handleSave}>
                  {canSave ? "保存并进入学习体系" : requiresAiReview && !aiReviewConfirmed ? "请先确认人工核对" : "请先修正错误"}
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

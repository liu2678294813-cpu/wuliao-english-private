import { useEffect, useRef, useState } from "react";
import { importController } from "./controller.js";
import { TARGET_LABELS, IMPORT_TARGETS, questionsFor, validateContent, plainClone } from "./contracts.js";
import { missingQuestions, generateReferenceAnswers, referenceRequest, suggestStructure } from "./ai.js";
import { reparsePassage } from "../examImport.js";
import { parseClozeSection } from "../clozeParser.js";
import { useBackHandler } from "../ui/BackContext.jsx";
import { BACK_PRIORITY } from "../ui/backController.js";
import "./import.css";

const statusCopy = { selected: "等待处理", validating: "校验文件", extracting: "本地提取", structuring: "识别结构", review_required: "待检查", ready: "可保存", committing: "保存中", completed: "已保存", failed: "失败", cancelled: "已取消", duplicate: "已存在", unsupported: "不适用" };
function AnswerDrafts({ candidate, onChange }) {
  const questions = questionsFor(candidate.target, candidate.content);
  const answers = candidate.answers || [];
  const update = (index, changes) => onChange((candidate.answers || []).map((a, i) => i === index ? { ...a, explanationSource: a.explanationSource || a.source, ...changes } : a));
  return <div className="import-answer-drafts">
    {answers.map((a, index) => <div className="import-answer-row" key={`${index}:${a.source}`}>
      <label>题号<select aria-label={`候选 ${index + 1} 题号`} value={a.number} onChange={(e) => update(index, { number: e.target.value, ambiguous: false, reviewStatus: "candidate" })}><option value={a.number}>{a.number}</option>{questions.filter((q) => String(q.number) !== String(a.number)).map((q) => <option key={q.id} value={q.number}>{q.number}</option>)}</select></label>
      <label>答案<select aria-label={`第 ${a.number} 题候选答案`} value={a.value} onChange={(e) => update(index, { value: e.target.value, source: a.source === "ai_generated" ? "ai_generated" : "manual", ambiguous: false, reviewStatus: "candidate", manuallyEdited: true })}>{[...new Set([a.value, ...(questions.find((q) => String(q.number) === String(a.number))?.options || []).map((o) => o.key)])].map((key) => <option key={key}>{key}</option>)}</select></label>
      <span>{a.source === "ai_generated" ? "AI 候选" : a.source === "manual" ? "手动录入" : "原文件答案"} · {a.mappingStatus === "matched" ? a.reviewStatus === "confirmed" ? "已确认" : "待确认" : "对应关系待核对"}</span>
      <button type="button" onClick={() => update(index, { ambiguous: false, reviewStatus: "confirmed" })}>确认对应关系</button>
      <button type="button" onClick={() => onChange((candidate.answers || []).filter((_, i) => i !== index))}>移除候选</button>
      <label className="import-wide">解析<textarea aria-label={`第 ${a.number} 题候选解析`} defaultValue={a.explanation || ""} onBlur={(e) => { if (e.target.value !== (a.explanation || "")) update(index, { explanation: e.target.value, explanationSource: a.source === "ai_generated" ? "ai_generated" : "manual", explanationManuallyEdited: true }); }} /></label>
    </div>)}
  </div>;
}
function CandidateCard({ candidate, file, controller, onError }) {
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [aiInput, setAiInput] = useState(null), [structure, setStructure] = useState(null);
  const jsonRef = useRef(null), rawRef = useRef(null); const requestRef = useRef(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const edit = async (changes) => { try { await controller.edit(candidate.id, changes); } catch (error) { onError(error.message); } };
  const missing = missingQuestions(candidate), qs = questionsFor(candidate.target, candidate.content);
  const locked = candidate.status === "completed" || controller.busy;
  async function generate(force = false) {
    setBusy(true); const abort = new AbortController(); requestRef.current = abort;
    const revision = candidate.revision;
    try {
      const requestCandidate = { ...candidate, answers: candidate.answers.filter((a) => a.source !== "ai_generated" || a.reviewStatus === "confirmed") };
      const results = await generateReferenceAnswers(requestCandidate, { consent: true, signal: abort.signal, force });
      if (candidate.revision !== revision) throw new Error("题目已修改，请重新生成候选答案");
      await controller.edit(candidate.id, { answers: [...candidate.answers.filter((a) => a.source !== "ai_generated" || a.reviewStatus === "confirmed"), ...results] });
      setAiInput(null);
    } catch (error) { onError(`AI 未完成：${error.message}。原资料仍可导入。`); }
    finally { setBusy(false); requestRef.current = null; }
  }
  async function reparse() {
    const text = rawRef.current.value; const content = candidate.target === "reading" ? reparsePassage(text, candidate.content.label?.match(/\d+/)?.[0]) : parseClozeSection(text, candidate.title, { dynamic: true });
    if (!content) { onError("没有解析到有效结构，请使用下方结构编辑修正"); return; }
    content.id = candidate.content.id;
    questionsFor(candidate.target, content).forEach((q, index) => { q.id = qs.find((old) => String(old.number) === String(q.number))?.id || `${candidate.id}:q:new:${index}:${q.number}`; });
    await edit({ content, rawText: text });
  }
  return <article className={`import-candidate ${candidate.validation.errors.length ? "has-error" : ""}`}>
    <header><label><input type="checkbox" aria-label={`选择 ${candidate.title}`} checked={candidate.selected} disabled={locked || candidate.status === "duplicate"} onChange={(e) => edit({ selected: e.target.checked })} /><strong>{candidate.title}</strong></label><span>{statusCopy[candidate.status]}</span><button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "检查与编辑"}</button></header>
    <p>{TARGET_LABELS[candidate.target]} · {candidate.target === "writing" ? candidate.content.promptText ? candidate.content.referenceEssay ? "题目与范文" : "待补范文" : "待关联题目" : `${candidate.content.paragraphs.length} 段 · ${qs.length} 题`} · {candidate.answers.filter((a) => a.reviewStatus === "confirmed").length} 个已确认答案</p>
    {[...candidate.validation.errors, ...candidate.validation.warnings].map((message) => <p key={message} className="import-warning">{message}</p>)}
    {candidate.error && <p role="alert">{candidate.error}</p>}
    {candidate.status === "duplicate" && <button type="button" disabled={controller.busy} onClick={() => controller.saveAsNew(candidate.id).catch((e) => onError(e.message))}>另存为独立资料</button>}
    {expanded && !locked && <div className="import-candidate-editor">
      <label>标题<input defaultValue={candidate.title} onBlur={(e) => { if (candidate.title !== e.target.value) edit({ title: e.target.value }); }} /></label>
      <label>所属类型<select value={candidate.target} onChange={(e) => edit({ target: e.target.value })}>{IMPORT_TARGETS.map((target) => <option key={target} value={target}>{TARGET_LABELS[target]}</option>)}</select></label>
      {candidate.target === "writing" ? <>
        <label>作文题型<select value={candidate.content.taskType || ""} onChange={(e) => edit({ content: { ...candidate.content, taskType: e.target.value || null } })}><option value="">待确定</option><option value="postgrad-en1-writing-a">英语一 Writing A</option><option value="postgrad-en1-writing-b">英语一 Writing B</option></select></label>
        {[['promptText', '作文题目'], ['directions', '题目要求'], ['referenceEssay', '参考范文']].map(([field, label]) => <label className="import-wide" key={field}>{label}<textarea defaultValue={candidate.content[field] || ""} onBlur={(e) => { if (e.target.value !== candidate.content[field]) edit({ content: { ...candidate.content, [field]: e.target.value } }); }} /></label>)}
        <p>缺少题目或范文可先保存，之后从作文资料库完善；AI 不会自动生成范文。</p>
        {!!file?.extracted?.assets?.length && <fieldset className="import-wide"><legend>核对题目图片（仅选择属于此作文的图片）</legend>{file.extracted.assets.map((asset, index) => <label key={index}><input type="checkbox" checked={candidate.content.importAssetIndexes?.includes(index) || false} onChange={(event) => edit({ content: { ...candidate.content, importAssetIndexes: event.target.checked ? [...(candidate.content.importAssetIndexes || []), index] : candidate.content.importAssetIndexes.filter((i) => i !== index) } })} />{asset.name || `图片 ${index + 1}`} {asset.pageNumber ? `· 第 ${asset.pageNumber} 页` : "· 请人工核对位置"}</label>)}</fieldset>}
      </> : <>
        <label className="import-wide">原文与题目<textarea ref={rawRef} defaultValue={candidate.rawText} /></label><button type="button" onClick={reparse}>仅重新解析此条</button>
        <details className="import-wide"><summary>编辑段落、题干与选项结构</summary><textarea ref={jsonRef} defaultValue={JSON.stringify(candidate.content, null, 2)} aria-label="资料结构 JSON" /><button type="button" onClick={() => { try { const content = JSON.parse(jsonRef.current.value); content.id = candidate.content.id; const old = qs; questionsFor(candidate.target, content).forEach((q, index) => { q.id = old.find((p) => String(p.number) === String(q.number))?.id || `${candidate.id}:q:new:${index}:${q.number}`; }); edit({ content }); } catch (e) { onError(`结构未保存：${e.message}`); } }}>保存结构修正</button></details>
      </>}
      <details className="import-wide"><summary>查看来源文件提取原文</summary><pre>{file?.extracted?.pages.map((p) => `第 ${p.pageNumber} 页\n${p.text}`).join("\n\n")}</pre></details>
      {qs.length > 0 && <div className="import-wide">
        <AnswerDrafts candidate={candidate} onChange={(answers) => edit({ answers })} />
        {missing.length > 0 && <div className="import-answer-prompt"><p>{candidate.answers.length ? `当前缺少第 ${missing.map((q) => q.number).join("、")} 题答案，是否补全？` : "当前资料未检测到答案，是否使用 AI 生成参考答案？"}</p><div className="import-actions"><button type="button" disabled={busy} onClick={() => setAiInput(referenceRequest(candidate))}>AI 生成</button><button type="button" onClick={() => edit({ answers: [...candidate.answers, ...missing.map((q) => ({ number: String(q.number), questionId: q.id, value: q.options[0]?.key || "A", source: "manual", mappingStatus: "matched", reviewStatus: "candidate", explanation: "" }))] })}>手动录入</button><button type="button" onClick={() => edit({ answerDecision: "skip" })}>暂不添加</button></div>{candidate.answerDecision === "skip" && <p>将保存无答案资料，可从资料详情以后补充。</p>}</div>}
        {candidate.answers.some((a) => a.source === "ai_generated" && a.reviewStatus === "candidate") && <button type="button" disabled={busy} onClick={() => { setAiInput(referenceRequest({ ...candidate, answers: candidate.answers.filter((a) => a.source !== "ai_generated" || a.reviewStatus === "confirmed") })); }}>重新生成未确认候选</button>}
      </div>}
      <details className="import-wide"><summary>AI 辅助整理局部结构</summary><p>仅发送下方选定的原文片段，结果为建议，不自动修改资料。</p><textarea aria-label="AI 结构辅助片段" defaultValue="" id={`fragment-${candidate.id}`} /><button type="button" disabled={busy} onClick={async () => { const fragment = document.getElementById(`fragment-${candidate.id}`).value; if (!window.confirm(`确认向当前文本 AI 发送所填的 ${fragment.length} 字符原文片段？`)) return; setBusy(true); try { setStructure(await suggestStructure(candidate, fragment, { consent: true })); } catch (e) { onError(e.message); } finally { setBusy(false); } }}>确认发送片段</button>{structure && <pre>{JSON.stringify(structure, null, 2)}</pre>}</details>
      <button type="button" onClick={() => edit({ selected: false })}>暂不导入此条</button>
    </div>}
    {aiInput && <div className="import-ai-confirm" role="dialog" aria-label="确认 AI 生成参考答案"><h3>确认发送至当前文本 AI</h3><p>第 {aiInput.questions.map((q) => q.number).join("、")} 题及必要正文；返回结果需再次确认，不作为官方答案。</p><details><summary>查看发送内容</summary><pre>{JSON.stringify(aiInput, null, 2)}</pre></details><button type="button" disabled={busy} onClick={() => generate(candidate.answers.some((a) => a.source === "ai_generated"))}>{busy ? "生成中…" : "确认发送并生成"}</button><button type="button" onClick={() => { requestRef.current?.abort(); setAiInput(null); }}>取消</button></div>}
  </article>;
}
export default function UnifiedImport({ username, onOpenLibrary }) {
  const controller = importController; const [target, setTarget] = useState(""), [state, setState] = useState(null), [open, setOpen] = useState(false), [error, setError] = useState(""); const fileRef = useRef(null);
  useEffect(() => { const unsubscribe = controller.subscribe(setState); if (controller.state?.username === username) setState({ ...controller.state }); else { controller.cancel(); controller.state = null; controller.restore().then((s) => { if (s) setTarget(s.target); }).catch((e) => setError(e.message)); } return unsubscribe; }, [username]);
  useBackHandler(() => { if (!open) return false; setOpen(false); return true; }, { enabled: open, priority: BACK_PRIORITY.modal });
  async function selectFiles(e) { const files = [...e.target.files]; e.target.value = ""; if (!files.length) return; setError(""); setOpen(true); try { await controller.start(files, target); } catch (err) { setError(err.message); } }
  const completed = state?.candidates.filter((c) => c.status === "completed").length || 0;
  return <section className={`unified-import ${open ? "is-open" : ""}`} aria-label="资料导入">
    <div className="import-heading"><div><h2>资料导入</h2><p>选择类型，本地解析后统一检查与保存。</p></div>{open && <button type="button" onClick={() => setOpen(false)}>收起，稍后继续</button>}</div>
    {!open && <><fieldset className="import-targets"><legend>选择导入类型</legend>{IMPORT_TARGETS.map((t) => <label key={t}><input type="radio" name="import-target" value={t} checked={target === t} disabled={controller.busy} onChange={() => setTarget(t)} />{TARGET_LABELS[t]}</label>)}</fieldset><div className="import-actions"><button type="button" className="primary-button" disabled={!target || controller.busy} onClick={() => fileRef.current?.click()}>选择文件并批量导入</button>{state && state.status !== "completed" && <button type="button" onClick={() => { setTarget(state.target); setOpen(true); }}>继续未完成批次</button>}</div></>}
    <input className="visually-hidden" ref={fileRef} type="file" accept=".pdf,.txt,.md,.markdown,.docx,.json,.png,.jpg,.jpeg" multiple onChange={selectFiles} aria-label="选择批量导入文件" />
    {error && <p className="import-error" role="alert">{error}</p>}
    {open && state && <>
      <p>导入到：<strong>{TARGET_LABELS[state.target]}</strong> · {state.files.length} 个文件 · {state.candidates.length} 条候选 · 已保存 {completed} 条</p>
      <div className="import-file-list">{state.files.map((f) => <div key={f.id} className="import-file"><strong>{f.name}</strong><span>{statusCopy[f.status]}{f.progress?.page ? ` · 第 ${f.progress.page}/${f.progress.total} 页` : ""}</span>{f.error && <p role="alert">{f.error}</p>}{f.errorCode === "encoding" && <select aria-label={`${f.name} 文本编码`} value={f.encoding} onChange={(e) => { f.encoding = e.target.value; setState({ ...controller.state }); }}>{["utf-8", "gb18030", "utf-16le", "utf-16be"].map((v) => <option key={v}>{v}</option>)}</select>}{!["completed", "duplicate", "unsupported", "cancelled"].includes(f.status) && <button type="button" onClick={() => controller.cancelFile(f.id).catch((e) => setError(e.message))}>取消此文件</button>}{["failed", "cancelled", "selected"].includes(f.status) && <button type="button" disabled={controller.busy} onClick={() => controller.process(f.id).catch((e) => setError(e.message))}>重新处理此文件</button>}</div>)}</div>
      <div className="import-actions"><button type="button" disabled={controller.busy} onClick={async () => { for (const c of state.candidates.filter((c) => !["completed", "duplicate"].includes(c.status))) await controller.edit(c.id, { selected: true }); }}>全选</button><button type="button" disabled={controller.busy} onClick={async () => { for (const c of state.candidates.filter((c) => c.status !== "completed")) await controller.edit(c.id, { selected: false }); }}>取消全选</button>{controller.busy && <button type="button" onClick={() => controller.cancel()}>取消处理</button>}</div>
      {state.candidates.map((c) => <CandidateCard key={c.id} candidate={c} file={state.files.find((f) => f.id === c.fileId)} controller={controller} onError={setError} />)}
      <footer className="import-actions"><button type="button" className="primary-button" disabled={controller.busy || !state.candidates.some((c) => c.selected && !["completed", "duplicate"].includes(c.status))} onClick={() => controller.commit().catch((e) => setError(e.message))}>确认导入</button>{completed > 0 && <button type="button" onClick={() => onOpenLibrary(state.target)}>前往{TARGET_LABELS[state.target]}资料库</button>}</footer>
    </>}
  </section>;
}

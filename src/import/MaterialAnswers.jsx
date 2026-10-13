import { useCallback, useEffect, useRef, useState } from "react";
import { onAppEvent } from "../events/appEvents.js";
import { readMaterialAnswers, evaluateAnswers, reviseMaterialAnswer, regradeMaterial, confirmAiAnswer } from "./answers.js";
import { ANSWERS_CHANGED, importRepository } from "./repository.js";
import { generateReferenceAnswers, referenceRequest, explainReferenceAnswer } from "./ai.js";
import { getCurrentUsername } from "../userData.js";
import "./import.css";

export function useMaterialAnswers(resource, content) {
  const [state, setState] = useState({ model: null, error: "" });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++generation.current, username = getCurrentUsername();
    if (!content) return;
    try { const model = await readMaterialAnswers(resource, content); if (generation.current === id && username === getCurrentUsername()) setState({ model, error: "" }); }
    catch (e) { if (generation.current === id) setState({ model: null, error: e.message }); }
  }, [resource.id, content?.id]);
  useEffect(() => { setState({ model: null, error: "" }); refresh(); const off = onAppEvent(ANSWERS_CHANGED, (event) => { if (!event.materialId || event.materialId === resource.id) refresh(); }); return () => { generation.current++; off(); }; }, [refresh]);
  return { ...state, refresh };
}
export default function MaterialAnswers({ resource, content, attempts = {}, label = "当前作答", reveal = false }) {
  const { model, error, refresh } = useMaterialAnswers(resource, content), [edit, setEdit] = useState(null), [message, setMessage] = useState(""), [history, setHistory] = useState(null), [ai, setAi] = useState(null), [busy, setBusy] = useState(false);
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (!model || !resource.importVersion) return; regradeMaterial(resource, content, model).catch((e) => setMessage(`评分修订待处理：${e.message}`)); }, [model, JSON.stringify(attempts)]);
  if (!resource.importVersion) return null;
  if (!model) return <div className="material-answer-manager">{error || "正在读取答案资料…"}</div>;
  if (!model.total && !model.pending.length) return null;
  const scores = evaluateAnswers(model, attempts);
  const candidate = { id: resource.id, target: model.target, content, revision: resource.materialRevision || 1, answers: model.records, rawText: content.paragraphs?.map((p) => p.text).join("\n\n") || "" };
  async function save() {
    setBusy(true);
    try { await reviseMaterialAnswer({ resource, content, ...edit }); setEdit(null); await refresh(); setMessage("已保存订正，历史评分已保留并自动更新"); }
    catch (e) { setMessage(e.message); } finally { setBusy(false); }
  }
  async function generate() {
    setBusy(true); abort.current = new AbortController();
    try { const answers = await generateReferenceAnswers(candidate, { consent: true, signal: abort.current.signal, force: Boolean(ai?.force) }); setAi({ answers }); }
    catch (e) { setMessage(`AI 未完成：${e.message}，资料已保留`); setAi(null); }
    finally { setBusy(false); abort.current = null; }
  }
  async function acceptAi(index) {
    const a = ai.answers[index]; setBusy(true);
    try {
      const current = await readMaterialAnswers(resource, content);
      if (!current.missing.some((q) => q.id === a.questionId)) throw new Error("该题已补入答案，请重新检查，AI 不会覆盖");
      await confirmAiAnswer(resource, content, a);
      await refresh(); setAi({ answers: ai.answers.filter((_, i) => i !== index) });
    } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  }
  return <section className="material-answer-manager" aria-label="答案与解析管理">
    <details open={reveal}><summary>答案与解析 · {model.covered}/{model.total} 题有可用依据{model.pending.length ? ` · ${model.pending.length} 项待核对` : ""}</summary>
      {reveal ? <><p className="import-score">{label} · 参考正确率 {scores.reference.denominator ? `${scores.reference.correct}/${scores.reference.denominator}` : "暂无评分依据"} · 覆盖 {model.covered}/{model.total} 题</p><p>依据原文件／用户确认参考答案，单独评分。无依据题目不进入分母。</p></> : <p>当前仍在作答阶段，展开答案将用于自查，请在提交后查看。</p>}
      <table><thead><tr><th>题号</th><th>答案与来源</th><th>解析</th><th>操作</th></tr></thead><tbody>{model.questions.map((q) => { const entry = model.perQuestion[q.id], a = entry.answer; return <tr key={q.id}><td>{q.number}</td><td>{a?.value || "未添加"} · {a?.source === "ai_generated" ? "AI 参考" : a?.source === "source_document" ? "原文件" : a ? "手动" : "—"}</td><td>{entry.explanation || "暂无解析"}</td><td><button type="button" onClick={() => setEdit({ questionId: q.id, value: a?.value || q.options[0]?.key || "A", explanation: entry.explanation, previousId: a?.id, expectedRevision: a?.revision || model.records.find((r) => r.questionId === q.id)?.revision || 0 })}>人工订正</button></td></tr>; })}</tbody></table>
      {model.pending.map((a) => <div className="import-answer-row" key={a.id}><span>待核对：原题号 {a.number} · {a.value} · 第 {a.sourceLocation?.page || "?"} 页</span><select aria-label={`核对答案 ${a.id}`} defaultValue=""><option value="">选择对应题目</option>{model.questions.map((q) => <option key={q.id} value={q.id}>{q.number}</option>)}</select><button type="button" onClick={(event) => { const questionId = event.currentTarget.previousElementSibling.value; if (!questionId) return; setEdit({ questionId, value: a.value, previousId: a.id, expectedRevision: a.revision, explanation: model.explanations.find((e) => e.explanationId === a.answerId)?.text || "" }); }}>核对并订正</button></div>)}
      {model.records.filter((a) => a.mappingStatus === "matched" && a.reviewStatus === "candidate").map((a) => <div className="import-answer-row" key={a.id}><span>第 {a.number} 题 · {a.source === "ai_generated" ? "AI" : "手动"} 候选 {a.value}，尚未确认、不参与评分</span><button type="button" onClick={() => setEdit({ questionId: a.questionId, value: a.value, previousId: a.id, expectedRevision: a.revision, explanation: model.perQuestion[a.questionId]?.explanation || "" })}>核对候选答案</button></div>)}
      {model.questions.filter((q) => model.perQuestion[q.id]?.answer).map((q) => <button type="button" key={q.id} disabled={busy} onClick={() => setAi({ explanationInput: { question: q, answer: model.perQuestion[q.id].answer, body: candidate.content.paragraphs.map((p) => p.text).join("\n\n") } })}>AI 解释第 {q.number} 题参考答案</button>)}
      {ai?.explanationInput && <div className="import-ai-confirm"><strong>确认发送参考答案与必要原文</strong><pre>{JSON.stringify(ai.explanationInput, null, 2)}</pre><button type="button" disabled={busy} onClick={async () => { setBusy(true); abort.current = new AbortController(); try { const { question, answer } = ai.explanationInput; const result = await explainReferenceAnswer(candidate, question, answer, { consent: true, signal: abort.current.signal }); setAi({ explanationCandidate: { ...result, question, answer } }); } catch (e) { setMessage(e.message); } finally { setBusy(false); abort.current = null; } }}>确认发送并生成解析</button><button type="button" onClick={() => { abort.current?.abort(); setAi(null); }}>取消</button></div>}
      {ai?.explanationCandidate && <div className="import-ai-confirm"><strong>AI 候选解析（需确认，不改变答案和成绩）</strong><textarea aria-label="AI 候选解析" value={ai.explanationCandidate.text} onChange={(e) => setAi({ explanationCandidate: { ...ai.explanationCandidate, text: e.target.value } })} /><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { const x = ai.explanationCandidate, current = await readMaterialAnswers(resource, content); if (current.perQuestion[x.question.id]?.answer?.id !== x.answer.id) throw new Error("答案已订正，旧解析候选已失效"); await reviseMaterialAnswer({ resource, content, questionId: x.question.id, value: x.answer.value, previousId: x.answer.id, expectedRevision: x.answer.revision, explanation: x.text, explanationSource: "ai_generated" }); setAi(null); await refresh(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } }}>确认保存解析</button><button type="button" onClick={() => setAi(null)}>删除候选解析</button></div>}
      {model.missing.length > 0 && <div className="import-answer-prompt"><p>{model.covered ? `第 ${model.missing.map((q) => q.number).join("、")} 题缺少答案` : "当前资料未检测到答案，是否使用 AI 生成参考答案？"}</p><button type="button" onClick={() => setAi({ input: referenceRequest(candidate) })}>AI 生成</button><button type="button" onClick={() => { const q = model.missing[0]; setEdit({ questionId: q.id, value: q.options[0]?.key, explanation: "", expectedRevision: 0 }); }}>手动录入</button><button type="button" onClick={() => setMessage("资料已保存，可以后补充答案")}>暂不添加</button></div>}
      {edit && <div className="material-answer-editor"><strong>人工核对与订正</strong><select value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}>{model.questions.find((q) => q.id === edit.questionId)?.options.map((o) => <option key={o.key}>{o.key}</option>)}</select><textarea aria-label="订正解析" value={edit.explanation} onChange={(e) => setEdit({ ...edit, explanation: e.target.value })} /><div className="import-actions"><button type="button" disabled={busy} onClick={save}>确认保存订正</button>{edit.previousId && <button type="button" disabled={busy} onClick={() => { reviseMaterialAnswer({ resource, content, ...edit, revoke: true }).then(() => { setEdit(null); refresh(); }).catch((e) => setMessage(e.message)); }}>撤销该答案</button>}<button type="button" onClick={() => setEdit(null)}>取消</button></div></div>}
      {ai?.input && <div className="import-ai-confirm"><strong>确认发送至当前文本 AI</strong><pre>{JSON.stringify(ai.input, null, 2)}</pre><button type="button" disabled={busy} onClick={generate}>确认发送并生成</button><button type="button" onClick={() => { abort.current?.abort(); setAi(null); }}>取消</button></div>}
      {ai?.answers && ai.answers.map((a, i) => <div className="import-answer-row" key={a.questionId}><span>AI 候选 · 第 {a.number} 题</span><select value={a.value} onChange={(e) => setAi({ answers: ai.answers.map((v, j) => j === i ? { ...v, value: e.target.value } : v) })}>{model.questions.find((q) => q.id === a.questionId)?.options.map((o) => <option key={o.key}>{o.key}</option>)}</select><textarea value={a.explanation} onChange={(e) => setAi({ answers: ai.answers.map((v, j) => j === i ? { ...v, explanation: e.target.value } : v) })} /><button type="button" disabled={busy} onClick={() => acceptAi(i)}>确认候选答案</button><button type="button" onClick={() => setAi({ answers: ai.answers.filter((_, j) => i !== j) })}>删除候选</button><button type="button" disabled={busy} onClick={() => setAi({ input: referenceRequest(candidate), force: true })}>重新生成</button></div>)}
      <button type="button" onClick={async () => { const [answers, evaluations, explanations] = await Promise.all([importRepository.list("material-answers"), importRepository.list("answer-evaluations"), importRepository.list("material-explanations")]); setHistory({ explanations: explanations.filter((r) => r.materialId === resource.id), answers: answers.filter((r) => r.materialId === resource.id), evaluations: evaluations.filter((r) => r.materialId === resource.id).sort((a, b) => b.createdAt - a.createdAt) }); }}>查看答案与评分历史</button>
      {history && <details open><summary>历史版本（保留原作答与评分依据）</summary>{history.answers.map((a) => <p key={a.id}>第 {a.number} 题 · v{a.revision} · {a.value} · {a.source} · {a.reviewStatus}</p>)}{history.explanations.map((e) => <p key={e.id}>解析 · 第 {model.questions.find((q) => q.id === e.questionId)?.number || "待核对"} 题 · v{e.revision} · {e.source} · {e.text}</p>)}{history.evaluations.map((e) => <details key={e.id}><summary>{new Date(e.createdAt).toLocaleString()} · {e.attempt} · 参考 {e.scores.reference.correct}/{e.scores.reference.denominator} · {e.scores.reference.basis}</summary><p>当时作答：{Object.entries(e.answers || {}).map(([n, v]) => `${n}: ${v}`).join("；")}</p><p>当时参考依据：{Object.entries(e.gradingBasis?.reference || {}).map(([n, v]) => `${n}: ${v}`).join("；") || "暂无"}</p><p>答案记录版本：{(e.answerRecordIds || []).join("；")}</p></details>)}</details>}
      {message && <p role="status">{message}</p>}
    </details>
  </section>;
}

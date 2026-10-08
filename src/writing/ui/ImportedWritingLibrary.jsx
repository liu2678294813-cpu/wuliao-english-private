import { useEffect, useState } from "react";
import { importRepository, IMPORT_CHANGED, resolveImportFile } from "../../import/repository.js";
import { onAppEvent } from "../../events/appEvents.js";
import { writingReady, validateContent, hashContent, contentIdentity } from "../../import/contracts.js";
import { startImportedWriting } from "../writingImportedMaterials.js";
import { callCachedTextAi } from "../../aiProvider.js";
import { accountToken, assertAccount } from "../../import/repository.js";
import "../../import/import.css";

export function ImportedAsset({ asset }) {
  const [src, setSrc] = useState(asset.src || "");
  useEffect(() => { let alive = true, url; if (asset.fileId) resolveImportFile(asset.fileId).then((file) => { if (file && alive) { url = URL.createObjectURL(file); setSrc(url); } }); return () => { alive = false; if (url) URL.revokeObjectURL(url); }; }, [asset.fileId, asset.src]);
  return src ? <img src={src} alt={asset.alt || "题目图片"} style={{ maxWidth: "100%", maxHeight: 480 }} /> : <span>题图不可用</span>;
}
export default function ImportedWritingLibrary({ services, username, onOpenSession }) {
  const [items, setItems] = useState([]), [edit, setEdit] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [aiSample, setAiSample] = useState(null);
  useEffect(() => { let alive = true; const load = () => importRepository.list("writing-materials").then((rows) => { if (alive) setItems(rows.sort((a, b) => b.addedAt - a.addedAt)); }).catch((e) => setError(e.message)); load(); const off = onAppEvent(IMPORT_CHANGED, load); return () => { alive = false; off(); }; }, [username]);
  async function save() {
    const validation = validateContent("writing", edit.content); if (validation.errors.length) { setError(validation.errors.join("；")); return; }
    try {
      const current = await importRepository.get("writing-materials", edit.id);
      if (current.materialRevision !== edit.materialRevision) throw new Error("资料已更新，请重新打开");
      const next = { ...edit, materialRevision: edit.materialRevision + 1, contentFingerprint: await hashContent(contentIdentity("writing", edit.content)) };
      await importRepository.put("writing-materials", next); setItems(items.map((r) => r.id === next.id ? next : r)); setEdit(null); setAiSample(null);
    } catch (e) { setError(e.message); }
  }
  async function generateSample() {
    if (!edit.content.promptText?.trim() || !edit.content.taskType) { setError("请先补齐题目与 A/B 题型"); return; }
    const input = { promptText: edit.content.promptText, directions: edit.content.directions, taskType: edit.content.taskType };
    if (!window.confirm(`确认将以下题目发送至当前文本 AI 生成待核对范文？\n${input.promptText}`)) return;
    const token = accountToken(); setBusy(true);
    try { const result = await callCachedTextAi({ taskType: "import-writing-sample", cacheNamespace: "import-writing-sample", promptVersion: 1, messages: [{ role: "system", content: "为给定作文题目生成英文参考范文。只输出范文正文，不能生成或修改题目。" }, { role: "user", content: JSON.stringify(input) }] }); assertAccount(token); setAiSample({ text: result.content || result.text, metadata: { provider: result.providerId, modelId: result.modelId, promptVersion: 1 } }); }
    catch (e) { setError(`范文未生成：${e.message}，已保存题目不受影响`); } finally { setBusy(false); }
  }
  return <section className="writing-imported-materials"><h2>自定义作文资料</h2>{!items.length && <p>请从首页导入作文题目或参考范文。</p>}{error && <p role="alert">{error}</p>}
    {items.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.content.year || "年份未标注"} · {writingReady(item.content) ? "可进入 W1–W8 训练" : "待完善题目、范文或题型"}</p><details><summary>查看题目与参考范文</summary><p style={{ whiteSpace: "pre-wrap" }}>{item.content.promptText || "题目未关联"}</p>{item.content.assets?.map((a) => <ImportedAsset key={a.assetId} asset={a} />)}<p style={{ whiteSpace: "pre-wrap" }}>{item.content.referenceEssay || "范文未添加"}</p></details><div className="import-actions"><button type="button" disabled={busy || !writingReady(item.content)} onClick={async () => { setBusy(true); try { const result = await startImportedWriting(item, services); onOpenSession(result.session.sessionId); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>使用本地资料开始训练</button><button type="button" onClick={() => { setEdit(structuredClone(item)); setAiSample(null); }}>查看与完善资料</button></div></article>)}
    {edit && <article><h3>完善作文资料</h3><label>标题<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label><label>年份（可留空）<input type="number" value={edit.content.year || ""} onChange={(e) => setEdit({ ...edit, content: { ...edit.content, year: e.target.value ? Number(e.target.value) : null } })} /></label><label>题型<select value={edit.content.taskType || ""} onChange={(e) => setEdit({ ...edit, content: { ...edit.content, taskType: e.target.value || null } })}><option value="">待确定</option><option value="postgrad-en1-writing-a">Writing A</option><option value="postgrad-en1-writing-b">Writing B</option></select></label>{[["promptText", "作文题目"], ["directions", "题目要求"], ["referenceEssay", "参考范文"]].map(([field, label]) => <label key={field}>{label}<textarea value={edit.content[field] || ""} onChange={(e) => setEdit({ ...edit, content: { ...edit.content, [field]: e.target.value } })} /></label>)}<label>关联已有本地范文<select defaultValue="" onChange={(e) => { const match = items.find((r) => r.id === e.target.value); if (match) setEdit({ ...edit, content: { ...edit.content, referenceEssay: match.content.referenceEssay, sampleSource: match.content.sampleSource || "manual_import", generatorMetadata: match.content.generatorMetadata || null } }); }}><option value="">选择范文资料</option>{items.filter((r) => r.id !== edit.id && r.content.referenceEssay).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label><button type="button" disabled={busy} onClick={generateSample}>AI 生成候选范文</button>{aiSample && <div><textarea aria-label="AI 候选范文" value={aiSample.text} onChange={(e) => setAiSample({ ...aiSample, text: e.target.value })} /><button type="button" onClick={() => { setEdit({ ...edit, content: { ...edit.content, referenceEssay: aiSample.text, sampleSource: "ai_generated", generatorMetadata: aiSample.metadata } }); setAiSample(null); }}>确认使用候选范文</button><button type="button" onClick={() => setAiSample(null)}>删除候选</button></div>}<div className="import-actions"><button type="button" disabled={busy} onClick={save}>保存资料修正</button><button type="button" onClick={() => setEdit(null)}>取消</button></div><p>新训练使用修正后的资料；已开始的 Session 保留原冻结快照。</p></article>}
  </section>;
}

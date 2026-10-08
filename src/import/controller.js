import { computeFileFingerprint } from "../fingerprint.js";
import { IMPORT_LIMITS, IMPORT_VERSION, assertTarget, hashContent, contentIdentity, validateContent, plainClone } from "./contracts.js";
import { extractFile, extractionCacheId } from "./extractor.js";
import { parseCandidates, mapAnswers } from "./parsers.js";
import { importRepository, accountToken, assertAccount } from "./repository.js";

export class ImportBatchController {
  constructor({ repository = importRepository, extract = extractFile } = {}) { this.repository = repository; this.extract = extract; this.listeners = new Set(); this.state = null; this.abort = null; this.busy = false; this.writeTail = Promise.resolve(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish() { for (const f of this.listeners) f(this.state ? { ...this.state } : null); }
  persist() {
    const snapshot = structuredClone(this.state);
    const token = this.token;
    this.writeTail = this.writeTail.catch(() => {}).then(() => { assertAccount(token); return this.repository.put("import-batches", snapshot); });
    return this.writeTail;
  }
  async start(files, target) {
    assertTarget(target); if (this.busy) throw new Error("已有批次正在处理");
    if (!files.length || files.length > IMPORT_LIMITS.files || files.reduce((s, f) => s + f.size, 0) > IMPORT_LIMITS.batchBytes) throw new Error("每批最多 50 个文件、总计 500 MiB");
    this.token = accountToken(); assertAccount(this.token);
    this.state = { id: `${encodeURIComponent(this.token.username)}::batch::${crypto.randomUUID()}`, username: this.token.username, target, version: IMPORT_VERSION, createdAt: Date.now(), status: "selected", candidates: [], files: files.map((file, i) => ({ id: `file-${i + 1}`, file, name: file.name, status: "selected", progress: null, error: "", encoding: "utf-8" })) };
    await this.persist(); this.publish(); return this.process();
  }
  async restore() {
    const liveToken = this.token, liveState = this.state, nextToken = accountToken();
    // Remounting the page must keep the running queue and its latest edits.
    if (liveState?.username === nextToken.username && liveToken?.epoch === nextToken.epoch && liveState.status !== "completed") { this.publish(); return liveState; }
    this.token = nextToken; if (!this.token.username) return null;
    const token = this.token;
    const batches = await this.repository.list("import-batches"); assertAccount(token);
    if (this.state !== liveState) return this.state;
    const batch = batches.filter((b) => b.status !== "completed").sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!batch) return null;
    if (batch.version !== IMPORT_VERSION) throw new Error("导入器版本已变化，请重新选择文件；已保存资料不受影响");
    this.state = batch;
    for (const f of batch.files) if (["validating", "extracting", "structuring", "committing"].includes(f.status)) { f.status = "selected"; f.error = "任务曾中断，可继续处理"; }
    batch.status = "review_required"; this.publish(); return batch;
  }
  async process(onlyId) {
    if (this.busy) return; this.busy = true; this.cancelAll = false; this.abort = new AbortController();
    const token = this.token;
    try {
      for (const item of this.state.files) {
        if (onlyId && onlyId !== item.id || !onlyId && item.status !== "selected") continue;
        assertAccount(token); this.currentFileId = item.id; item.status = "validating"; item.error = ""; this.publish();
        try {
          if (this.abort.signal.aborted) { item.status = "cancelled"; break; }
          const fingerprint = await computeFileFingerprint(item.file); assertAccount(token);
          item.fingerprint = fingerprint;
          const cacheId = await extractionCacheId(token.username, fingerprint, this.state.target);
          const cached = await this.repository.get("import-cache", cacheId);
          item.status = "extracting"; this.publish();
          const extracted = cached?.extracted || await this.extract(item.file, { target: this.state.target, signal: this.abort.signal, encoding: item.encoding, onProgress: (progress) => { if (!this.abort.signal.aborted) { item.progress = progress; this.publish(); } } });
          assertAccount(token);
          if (this.abort.signal.aborted) throw Object.assign(new Error("已取消此文件"), { code: "cancelled" });
          if (!cached) await this.repository.put("import-cache", { id: cacheId, username: token.username, extracted, version: IMPORT_VERSION });
          item.extracted = extracted; item.status = "structuring"; this.publish();
          const structureId = `${cacheId}:${this.state.target}:${IMPORT_VERSION}`, structured = await this.repository.get("import-cache", structureId);
          const candidates = structured?.candidates || await parseCandidates(extracted, { username: token.username, fingerprint, target: this.state.target, title: item.name.replace(/\.[^.]+$/, ""), fileId: item.id });
          assertAccount(token);
          if (!structured) await this.repository.put("import-cache", { id: structureId, username: token.username, candidates, version: IMPORT_VERSION });
          if (!candidates.length) throw new Error("未识别到所选类型的资料，请检查文件或选择正确的目标");
          const existing = await this.repository.list(this.state.target === "writing" ? "writing-materials" : "custom-pdfs");
          this.state.candidates = this.state.candidates.filter((c) => c.fileId !== item.id || c.manuallyEdited || c.status === "completed");
          for (const parsed of candidates) {
            if (this.state.candidates.some((c) => c.id === parsed.id)) continue;
            const candidate = { ...plainClone(parsed), fileId: item.id };
            const duplicate = existing.find((r) => r.id === candidate.id || r.target === candidate.target && r.contentFingerprint === candidate.contentFingerprint);
            if (duplicate) { candidate.status = "duplicate"; candidate.selected = false; candidate.duplicateOf = duplicate.id; }
            this.state.candidates.push(candidate);
          }
          item.status = "review_required";
        } catch (error) {
          if (error.code === "account-changed") throw error;
          item.status = this.abort.signal.aborted ? "cancelled" : error.code === "unsupported" ? "unsupported" : "failed"; item.error = error.message || String(error); item.errorCode = error.code || "";
        }
        this.state.status = "review_required"; await this.persist(); this.publish();
        if (this.abort.signal.aborted && !this.cancelAll) this.abort = new AbortController();
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally { this.busy = false; this.currentFileId = null; this.publish(); }
  }
  cancel() { this.cancelAll = true; this.abort?.abort(); }
  async cancelFile(id) {
    const item = this.state?.files.find((f) => f.id === id);
    if (!item || item.status === "completed") return;
    item.status = "cancelled";
    for (const candidate of this.state.candidates.filter((c) => c.fileId === id && c.status !== "completed")) candidate.selected = false;
    if (this.busy && this.currentFileId === id) this.abort?.abort();
    await this.persist(); this.publish();
  }
  async edit(id, changes) {
    const token = this.token;
    assertAccount(this.token); const c = this.state.candidates.find((c) => c.id === id); if (!c || c.status === "completed") throw new Error("候选不存在或已保存");
    if (changes.content) {
      const oldQuestions = c.content.questions || c.content.blanks || [];
      for (const [i, q] of (changes.content.questions || changes.content.blanks || []).entries()) q.id = oldQuestions.find((old) => old.id === q.id || String(old.number) === String(q.number))?.id || `${c.id}:q:new:${crypto.randomUUID()}:${i}`;
      for (const [i, p] of (changes.content.paragraphs || []).entries()) { const old = c.content.paragraphs?.find((old) => old.id === p.id || old.text === p.text) || c.content.paragraphs?.[i]; p.id = old?.id || `${c.id}:p:new:${crypto.randomUUID()}`; p.sentenceIds = (p.sentences || []).map((text, j) => { const before = old?.sentences?.indexOf(text); return before >= 0 ? old.sentenceIds?.[before] || `${p.id}:s:${before + 1}` : `${p.id}:s:new:${j}:${crypto.randomUUID()}`; }); }
      changes.content.id = c.content.id;
    }
    Object.assign(c, changes); c.revision++; c.manuallyEdited = true;
    c.validation = validateContent(c.target, c.content); c.answers = mapAnswers(c);
    c.contentFingerprint = await hashContent(contentIdentity(c.target, c.content));
    assertAccount(token);
    c.status = c.target !== this.state.target ? "unsupported" : c.duplicateOf && !c.saveAsNew ? "duplicate" : "review_required";
    await this.persist(); this.publish();
  }
  async saveAsNew(id) {
    const c = this.state.candidates.find((c) => c.id === id); if (!c) return;
    const old = c.id; const next = `${old}:copy:${crypto.randomUUID()}`; c.id = next; c.content.id = next;
    for (const q of [...(c.content.questions || []), ...(c.content.blanks || [])]) q.id = q.id.replace(old, next);
    for (const a of c.answers || []) if (a.questionId) a.questionId = a.questionId.replace(old, next);
    c.saveAsNew = true; c.selected = true; c.duplicateOf = null; c.status = "review_required"; await this.persist(); this.publish();
  }
  async commit() {
    if (this.busy) throw new Error("请等待解析完成"); const token = this.token; assertAccount(token); this.busy = true; this.cancelAll = false;
    try {
      this.state.status = "committing"; this.publish();
      for (const c of this.state.candidates.filter((c) => c.selected && !["completed", "duplicate"].includes(c.status))) {
        if (this.cancelAll) break;
        if (!c.selected) continue;
        try {
          assertAccount(token);
          if (c.target !== this.state.target) throw new Error("不属于本批次目标");
          const file = this.state.files.find((f) => f.id === c.fileId);
          if (await computeFileFingerprint(file.file) !== file.fingerprint) throw new Error("来源文件已变化，请重新导入");
          c.status = "committing"; this.publish();
          const result = await this.repository.commit(c, { ...file.extracted, file: file.file, target: this.state.target, fingerprint: file.fingerprint }, token.username);
          assertAccount(token); c.status = result.status; c.savedMaterialId = result.materialId; c.error = "";
        } catch (error) { if (error.code === "account-changed") throw error; c.status = "failed"; c.error = error.message; }
        await this.persist(); this.publish();
      }
      for (const f of this.state.files) { const items = this.state.candidates.filter((c) => c.fileId === f.id); if (items.length && items.every((c) => ["completed", "duplicate"].includes(c.status))) f.status = items.some((c) => c.status === "completed") ? "completed" : "duplicate"; }
      this.state.status = this.state.candidates.some((c) => c.selected && !["completed", "duplicate"].includes(c.status)) || this.state.files.some((f) => ["failed", "selected", "cancelled"].includes(f.status)) ? "review_required" : "completed";
      await this.persist(); this.publish();
    } finally { this.busy = false; this.publish(); }
  }
}
export const importController = new ImportBatchController();
if (import.meta.env?.VITE_E2E_PROBES === "1" && typeof window !== "undefined") {
  window.__WULIAO_IMPORT_E2E__ = { controller: importController, repository: importRepository,
    answers: async () => import("./answers.js"), backup: async () => import("../backup.js"),
    ai: async () => import("./ai.js"), events: async () => import("../events/appEvents.js"),
  };
}

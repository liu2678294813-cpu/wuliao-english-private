import { openWuliaoEnglishDatabase } from "../storage.js";
import { getCurrentUsername } from "../userData.js";
import { onAppEvent, emitAppEvent } from "../events/appEvents.js";
import { AppEvent } from "../events/eventTypes.js";
import { IMPORT_VERSION, plainClone, scopedId, validateContent, hashContent, contentIdentity, questionsFor } from "./contracts.js";
import { mapAnswers } from "./parsers.js";

export const IMPORT_CHANGED = "wuliao:import-materials-updated";
export const ANSWERS_CHANGED = "wuliao:material-answers-updated";
let accountEpoch = 0;
onAppEvent(AppEvent.ACCOUNT_CHANGED, () => { accountEpoch++; });
export const accountToken = () => ({ username: getCurrentUsername(), epoch: accountEpoch });
export function assertAccount(token) {
  if (!token?.username || token.username !== getCurrentUsername() || token.epoch !== accountEpoch) throw Object.assign(new Error("账号已切换，旧账号任务已停止"), { code: "account-changed" });
}
export class ImportRepository {
  constructor({ indexedDb = globalThis.indexedDB, getUsername = getCurrentUsername } = {}) { this.indexedDb = indexedDb; this.getUsername = getUsername; }
  session() { return { username: this.getUsername(), epoch: accountEpoch }; }
  assertSession(token) { if (!token.username || token.username !== this.getUsername() || token.epoch !== accountEpoch) throw Object.assign(new Error("账号已切换，旧任务已停止"), { code: "account-changed" }); }
  async transaction(stores, mode, action, username = this.getUsername()) {
    const epoch = accountEpoch;
    if (!username || this.getUsername() !== username) throw new Error("账号不可用或已切换");
    const db = await openWuliaoEnglishDatabase(this.indexedDb);
    try {
      if (this.getUsername() !== username || epoch !== accountEpoch) throw new Error("账号已切换");
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode); let result;
        const finish = (value) => { result = value; };
        const off = onAppEvent(AppEvent.ACCOUNT_CHANGED, () => { try { tx.abort(); } catch {} });
        tx.oncomplete = () => { off(); if (this.getUsername() !== username || epoch !== accountEpoch) reject(new Error("账号已切换")); else resolve(result); };
        tx.onerror = () => { off(); reject(tx.error || new Error("存储失败")); };
        tx.onabort = () => { off(); reject(tx.error || new Error("事务已取消或存储空间不足")); };
        const guard = () => { if (this.getUsername() !== username || epoch !== accountEpoch) { tx.abort(); throw new Error("账号已切换"); } };
        try { action(tx, finish, guard); } catch (error) { tx.abort(); reject(error); }
      });
    } finally { db.close(); }
  }
  async list(store, username = this.getUsername()) {
    return this.transaction(store, "readonly", (tx, done) => { const r = tx.objectStore(store).index("username").getAll(username); r.onsuccess = () => done(r.result); }, username);
  }
  async get(store, id, username = this.getUsername()) {
    return this.transaction(store, "readonly", (tx, done) => { const r = tx.objectStore(store).get(id); r.onsuccess = () => done(r.result?.username === username ? r.result : null); }, username);
  }
  async put(store, record) {
    if (record.username !== this.getUsername()) throw new Error("资料不属于当前账号");
    await this.transaction(store, "readwrite", (tx, done, guard) => { guard(); tx.objectStore(store).put(record); done(record); }, record.username);
    return this.get(store, record.id, record.username);
  }
  async commit(candidate, source, username = this.getUsername()) {
    const session = this.session(); this.assertSession(session);
    if (username !== session.username || !candidate.id.startsWith(`${encodeURIComponent(username)}::${candidate.target}::`)) throw new Error("候选身份不属于当前账号或目标");
    const validation = validateContent(candidate.target, candidate.content);
    if (validation.errors.length) throw new Error(validation.errors.join("；"));
    if (candidate.target !== source.target) throw new Error("候选不属于本批次目标");
    const contentFingerprint = await hashContent(contentIdentity(candidate.target, candidate.content));
    const answers = mapAnswers(candidate); const now = Date.now();
    const store = candidate.target === "writing" ? "writing-materials" : "custom-pdfs";
    const fileId = scopedId(username, "file", source.fingerprint);
    const assetRecords = (source.assets || []).map((a, index) => ({ a, index })).filter(({ a, index }) => a.file && candidate.content.importAssetIndexes?.includes(index)).map(({ a, index }) => ({ id: `${fileId}:asset:${index + 1}`, username, file: a.file, name: a.name || `asset-${index + 1}`, pageNumber: a.pageNumber || null, fingerprint: source.fingerprint, sourceFileId: fileId }));
    const content = plainClone(candidate.content);
    if (candidate.target === "writing") content.assets = [...(content.assets || []), ...assetRecords.map((a, i) => ({ assetId: a.id, fileId: a.id, alt: `来源题图 ${i + 1}`, pageNumber: a.pageNumber }))];
    const material = { id: candidate.id, username, kind: "custom", category: "custom", target: candidate.target, title: candidate.title, subtitle: "本地导入资料", year: content.year ?? null, sourceFileId: fileId, sourceLocation: candidate.sourceLocation || {}, fingerprint: source.fingerprint, contentFingerprint, materialRevision: candidate.revision || 1, addedAt: now, conversionStatus: "ready", importVersion: IMPORT_VERSION,
      ...(candidate.target === "writing" ? { content } : { analysis: { version: 1, title: candidate.title, passages: candidate.target === "reading" ? [content] : [], clozes: candidate.target === "cloze" ? [content] : [], method: "local", sourcePages: source.pages?.length || 1 } }) };
    const receiptId = scopedId(username, "receipt", candidate.id);
    const rows = answers.map((a, i) => ({ ...plainClone(a), id: `${candidate.id}:answer:${i}:v1`, username, materialId: candidate.id, questionId: a.questionId, answerId: a.questionId || `pending:${i}`, revision: 1, materialRevision: material.materialRevision, createdAt: now, editedBy: a.manuallyEdited ? username : null, provenance: { fileId, original: a.sourceLocation || {}, ...(a.provenance || {}) } }));
    const explanationRows = rows.filter((a) => a.explanation).map((a) => ({ id: `${a.id}:explanation`, username, materialId: a.materialId, questionId: a.questionId, explanationId: a.answerId, revision: 1, text: a.explanation, source: a.explanationSource || a.source, editedBy: a.explanationManuallyEdited ? username : null, createdAt: now }));
    for (const row of rows) delete row.explanation;
    for (const [i, ex] of (Array.isArray(candidate.explanations) ? candidate.explanations : []).entries()) {
      if (typeof ex.text !== "string" || !ex.text.trim()) throw new Error("解析格式错误");
      const question = questionsFor(candidate.target, candidate.content).find((q) => String(q.number) === String(ex.number));
      explanationRows.push({ id: `${candidate.id}:ex:${i}:v1`, username, materialId: candidate.id, questionId: question?.id || null, explanationId: question?.id || `pending-ex:${i}`, revision: 1, text: ex.text, source: "source_document", createdAt: now });
    }
    this.assertSession(session);
    const result = await this.transaction([store, "import-files", "material-answers", "material-explanations", "import-receipts"], "readwrite", (tx, done, guard) => {
      const request = tx.objectStore("import-receipts").get(receiptId);
      request.onsuccess = () => {
        guard();
        if (request.result) { done({ status: "completed", materialId: request.result.materialId }); return; }
        const existing = tx.objectStore(store).index("username").getAll(username);
        existing.onsuccess = () => {
          guard();
          const duplicate = existing.result.find((r) => r.id === candidate.id || !candidate.saveAsNew && r.target === candidate.target && r.contentFingerprint === contentFingerprint);
          if (duplicate) { done({ status: "duplicate", materialId: duplicate.id }); return; }
          const fileStore = tx.objectStore("import-files"), shared = fileStore.get(fileId);
          shared.onsuccess = () => { guard(); if (!shared.result) fileStore.add({ id: fileId, username, fingerprint: source.fingerprint, file: source.file, name: source.file.name, addedAt: now }); };
          for (const asset of assetRecords) tx.objectStore("import-files").put(asset);
          tx.objectStore(store).add(material);
          for (const row of rows) {
            const original = row.source === "ai_generated" && row.provenance?.generatedAnswer;
            if (original && original.value !== row.value) tx.objectStore("material-answers").add({ ...row, id: row.id.replace(/:v1$/, ":v0"), revision: 0, value: original.value, reviewStatus: "candidate" });
            tx.objectStore("material-answers").add(row);
          }
          for (const row of explanationRows) tx.objectStore("material-explanations").add(row);
          tx.objectStore("import-receipts").add({ id: receiptId, username, materialId: material.id, createdAt: now });
          done({ status: "completed", materialId: material.id });
        };
      };
    }, username);
    this.assertSession(session);
    const verified = await this.get(store, result.materialId, username);
    if (!verified) throw new Error("资料写入后核验失败");
    emitAppEvent(IMPORT_CHANGED, { materialId: result.materialId });
    return { ...result, material: verified };
  }
}
export const importRepository = new ImportRepository();
export async function resolveImportFile(fileId) { return (await importRepository.get("import-files", fileId))?.file || null; }

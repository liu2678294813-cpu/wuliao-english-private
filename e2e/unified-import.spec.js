import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";
import path from "node:path";

const article = "People learn through practice. A careful reader checks the source before drawing conclusions. Understanding a passage takes patience, because its details can support several different interpretations. Good readers preserve evidence and compare their explanations with the original sentences. They also notice how the structure connects ideas and ask clear questions when a claim is uncertain. This habit makes learning reliable and useful over time.";
const q = (n) => `${n}. What helps readers learn?\n[A] Practice and evidence\n[B] Random guesses\n[C] Ignoring details\n[D] Changing the original`;
const blanks = `Section I Use of English\n\nPeople learn __1__ practice and remember __2__ details. Reading carefully helps them become more reliable learners.\n\n1. [A] through [B] above [C] under [D] against\n2. [A] useful [B] empty [C] false [D] broken`;
const mixed = `${blanks}\n\nSection II Reading Comprehension\nText 1\n${article}\n${q(21)}\n参考答案\n1. A\n2. A\n21. A\nWriting B\nDirections: Write an essay about learning.\n参考范文\n${article}`;
const payload = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
async function importFiles(page, target, files) {
  await page.getByRole("radio", { name: target, exact: true }).check();
  await page.getByLabel("选择批量导入文件").setInputFiles(files);
  await expect(page.locator(".import-candidate").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
}
async function commit(page) { await page.getByRole("button", { name: "确认导入", exact: true }).click(); await expect(page.locator(".unified-import")).toContainText("已保存 1 条"); }
async function rows(page, store) { return page.evaluate(async (name) => window.__WULIAO_IMPORT_E2E__.repository.list(name), store); }
test.beforeEach(async ({ page }) => { await createAccount(page); await expect(page.getByRole("heading", { name: "资料导入", exact: true })).toBeVisible(); });

test("home selection, preview before commit, partial failure, reload and reading training", async ({ page }) => {
  let aiCalls = 0; page.on("request", (r) => { if (/chat\/completions|\/responses/.test(r.url())) aiCalls++; });
  await expect(page.getByRole("button", { name: "选择文件并批量导入" })).toBeDisabled();
  await importFiles(page, "精读", [payload("mixed.txt", mixed), { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("broken") }]);
  expect((await rows(page, "custom-pdfs")).length).toBe(0);
  await expect(page.locator(".import-file").nth(1)).toContainText("不支持");
  await page.reload(); await page.getByRole("button", { name: "继续未完成批次" }).click();
  await expect(page.locator(".import-candidate")).toHaveCount(1);
  await commit(page); expect((await rows(page, "custom-pdfs"))[0].analysis.clozes).toHaveLength(0);
  await page.getByRole("button", { name: "前往精读资料库" }).click();
  await expect(page.getByRole("button", { name: "上传 PDF" })).toHaveCount(0);
  await page.getByRole("tab", { name: /自定义库/ }).click(); await page.locator(".resource-card .resource-open").first().click();
  await expect(page.locator(".reader-page")).toBeVisible(); await expect(page.locator(".material-answer-manager")).toContainText("1/1");
  expect(aiCalls).toBe(0);
  await page.screenshot({ path: "output/unified-import/20261009/reading-training.png" });
});
test("same file cross-module is independent, same target duplicate does not create progress", async ({ page }) => {
  await importFiles(page, "精读", [payload("same.txt", mixed)]); await commit(page);
  await page.getByRole("button", { name: "收起，稍后继续" }).click();
  await importFiles(page, "完形", [payload("same.txt", mixed)]); await commit(page);
  const materials = await rows(page, "custom-pdfs"); expect(materials).toHaveLength(2); expect(materials[0].sourceFileId).toBe(materials[1].sourceFileId); expect((await rows(page, "import-files")).length).toBe(1);
  expect(materials.find((m) => m.target === "cloze").analysis.clozes[0].blanks).toHaveLength(2);
  await page.getByRole("button", { name: "前往完形资料库" }).click(); await page.getByRole("tab", { name: /自定义库/ }).click(); await page.locator(".resource-card .resource-open").first().click(); await expect(page.locator(".cloze-reader-page")).toBeVisible();
  await expect(page.locator(".material-answer-manager")).toContainText("2/2");
  await page.getByRole("button", { name: "← 返回", exact: true }).click(); await navTo(page, "首页"); await page.getByRole("radio", { name: "完形", exact: true }).check(); await page.getByLabel("选择批量导入文件").setInputFiles([payload("same.txt", mixed)]); await expect(page.locator(".import-candidate")).toContainText("已存在"); expect((await rows(page, "custom-pdfs")).length).toBe(2);
});
test("complete writing enters original W1/W2 and incomplete material waits without AI", async ({ page }) => {
  await importFiles(page, "作文", [payload("essay.txt", mixed), payload("sample.txt", article)]);
  await page.getByRole("button", { name: "确认导入", exact: true }).click(); await expect(page.locator(".unified-import")).toContainText("已保存 2 条");
  await page.getByRole("button", { name: "前往作文资料库" }).click();
  const complete = page.locator(".writing-imported-materials article", { hasText: "essay" }); await expect(complete).toContainText("W1–W8");
  await complete.getByRole("button", { name: "使用本地资料开始训练" }).click();
  await expect(page.locator(".writing-reading-sheet")).toBeVisible(); await page.getByRole("button", { name: "完成范文精读" }).click(); await expect(page.getByRole("main", { name: "当前阶段 W2" })).toBeVisible(); await expect(page.getByRole("textbox", { name: "完整中文译文", exact: true })).toBeVisible();
  await page.screenshot({ path: "output/unified-import/20261009/writing-training.png" });
});
test("source answers revise automatically, isolate formal scores, preserve history and backup references", async ({ page }) => {
  await importFiles(page, "精读", [payload("answers.txt", `Text 1\n${article}\n${q(21)}\n${q(22)}\n参考答案\n21. A`)]); await commit(page);
  const result = await page.evaluate(async () => {
    const probe = window.__WULIAO_IMPORT_E2E__, repo = probe.repository, service = await probe.answers();
    const r = (await repo.list("custom-pdfs"))[0], p = r.analysis.passages[0], user = r.username;
    const key = `wuliao:user:${encodeURIComponent(user)}:wuliao:deep-answers:${r.id}:${p.id}:first`;
    localStorage.setItem(key, JSON.stringify({ 21: "A", 22: "B" }));
    const before = await service.readMaterialAnswers(r, p); await service.regradeMaterial(r, p, before);
    const first = before.records[0];
    await service.reviseMaterialAnswer({ resource: r, content: p, questionId: first.questionId, value: "B", previousId: first.id, expectedRevision: first.revision, explanation: "人工订正" });
    const after = await service.readMaterialAnswers(r, p); const evaluations = await repo.list("answer-evaluations");
    const backup = await probe.backup(); const { manifest } = await backup.createBackup({ username: user, sources: backup.defaultBackupSources(), encodeAttachment: backup.browserEncodeAttachment });
    const stores = Object.keys(manifest.sections.indexedDB["wuliao-english"]);
    const restore = await backup.restoreBackup({ manifest, username: user, ...backup.defaultRestoreSources(), createFile: backup.browserCreateFile });
    return { before: service.evaluateAnswers(before, { 21: "A", 22: "B" }), after: service.evaluateAnswers(after, { 21: "A", 22: "B" }), evaluations: evaluations.length, answers: (await repo.list("material-answers")).length, stores, attachments: Object.keys(manifest.attachments).length, restore, references: await service.verifyImportReferences() };
  });
  expect(result.before.official.denominator).toBe(0); expect(result.before.reference.correct).toBe(1); expect(result.after.reference.correct).toBe(0); expect(result.after.reference.denominator).toBe(1); expect(result.evaluations).toBe(2); expect(result.answers).toBe(2); expect(result.stores).toContain("material-answers"); expect(result.stores).toContain("import-files"); expect(result.attachments).toBe(1); expect(result.references).toEqual([]); expect(result.restore.errors).toEqual([]);
});
test("unresolved answers can save body but cannot score or trigger missing-answer AI", async ({ page }) => {
  await importFiles(page, "精读", [payload("unresolved.txt", `Text 1\n${article}\n${q(1)}\nText 2\n${article} A second passage presents another claim.\n${q(1)}\n参考答案\n1. A`)]);
  await page.getByRole("button", { name: "确认导入", exact: true }).click(); await expect(page.locator(".unified-import")).toContainText("已保存 2 条");
  const data = await page.evaluate(async () => { const probe = window.__WULIAO_IMPORT_E2E__, rows = await probe.repository.list("custom-pdfs"), service = await probe.answers(); return Promise.all(rows.map(async (r) => { const m = await service.readMaterialAnswers(r, r.analysis.passages[0]); return { pending: m.pending.length, missing: m.missing.length, denominator: service.evaluateAnswers(m, { 1: "A" }).reference.denominator }; })); });
  expect(data).toEqual([{ pending: 1, missing: 0, denominator: 0 }, { pending: 1, missing: 0, denominator: 0 }]);
});
test("plain article trains without fabricated questions; portrait preview has no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1280 }); await importFiles(page, "精读", [payload("pure.txt", article)]); await commit(page);
  await page.getByRole("button", { name: "前往精读资料库" }).click(); await page.getByRole("tab", { name: /自定义库/ }).click(); await page.locator(".resource-card .resource-open").first().click(); await expect(page.locator(".reader-page")).toBeVisible();
  const result = await page.evaluate(async () => { const r = (await window.__WULIAO_IMPORT_E2E__.repository.list("custom-pdfs"))[0], p = r.analysis.passages[0]; return { questions: p.questions.length, flow: JSON.parse(localStorage.getItem(`wuliao:user:${encodeURIComponent(r.username)}:wuliao:reading-flow:${r.id}:${p.id}`)), overflow: document.documentElement.scrollWidth > innerWidth }; });
  expect(result.questions).toBe(0); expect(result.flow.questionless).toBe(true); expect(result.flow.stages["deep-redo"].status).toBe("skipped"); expect(result.overflow).toBe(false);
  await expect(page.getByRole("button", { name: /审题 · 不适用/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /重做 · 不适用/ })).toBeVisible();
  await page.screenshot({ path: "output/unified-import/20261009/portrait-article.png" });
});
test("actual PDF and DOCX extract locally and retain source files", async ({ page }) => {
  await importFiles(page, "精读", [path.resolve("e2e/fixtures/unified-import/reading.pdf"), path.resolve("e2e/fixtures/unified-import/reading.docx")]);
  await expect(page.locator(".import-file").last()).toContainText("待检查");
  await expect(page.locator(".import-candidate")).toHaveCount(2);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".unified-import")).toContainText("已保存 1 条"); // Same structured content across two formats is deduplicated at commit.
  expect((await rows(page, "custom-pdfs")).length).toBe(1);
});

test("simulated AI sends only missing questions after consent and preserves edited candidate history", async ({ page }) => {
  let calls = 0, sent;
  await page.route("https://unified-import.invalid/**", async (route) => {
    calls++; const body = route.request().postDataJSON(); sent = JSON.parse(body.messages.at(-1).content);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: sent.questions.map((q) => ({ questionId: q.questionId, value: "B", explanation: "受控测试解析" })) }) } }], usage: { total_tokens: 0 } }) });
  });
  await page.evaluate(() => { const user = localStorage.getItem("kaoyan_vocab_current_user"), prefix = `wuliao:user:${encodeURIComponent(user)}:`; localStorage.setItem(prefix + "wuliao:ai:apikey", "simulated-key"); localStorage.setItem(prefix + "wuliao:ai:model", "simulated-text"); localStorage.setItem(prefix + "wuliao:ai:api-config", JSON.stringify({ version: 1, baseUrl: "https://unified-import.invalid" })); });
  await importFiles(page, "精读", [payload("ai.txt", `Text 1\n${article}\n${q(21)}\n${q(22)}\n参考答案\n21. A`)]);
  await page.getByRole("button", { name: "检查与编辑" }).click();
  expect(calls).toBe(0); await page.getByRole("button", { name: "AI 生成", exact: true }).click(); expect(calls).toBe(0);
  await page.getByRole("button", { name: "确认发送并生成", exact: true }).click();
  await expect(page.getByLabel("第 22 题候选答案")).toHaveValue("B"); expect(calls).toBe(1); expect(sent.questions.map((q) => q.number)).toEqual(["22"]);
  await page.getByLabel("第 22 题候选答案").selectOption("C");
  await page.locator(".import-answer-row").filter({ has: page.getByLabel("第 22 题候选答案") }).getByRole("button", { name: "确认对应关系" }).click();
  await commit(page);
  const answers = await rows(page, "material-answers"); expect(answers.find((a) => a.number === "21").value).toBe("A");
  expect(answers.filter((a) => a.number === "22").map((a) => [a.value, a.source, a.revision])).toEqual([["B", "ai_generated", 0], ["C", "ai_generated", 1]]);
});

test("atomic commit abort leaves no material, file or receipt and can retry", async ({ page }) => {
  await importFiles(page, "精读", [payload("atomic.txt", `Text 1\n${article}\n${q(21)}\n参考答案\n21. A`)]);
  const data = await page.evaluate(async () => {
    const { controller, repository } = window.__WULIAO_IMPORT_E2E__, original = repository.transaction.bind(repository);
    repository.transaction = (stores, mode, action, username) => original(stores, mode, (tx, done, guard) => { action(tx, done, guard); if (Array.isArray(stores) && stores.includes("import-receipts")) tx.abort(); }, username);
    await controller.commit(); repository.transaction = original;
    return { materials: (await repository.list("custom-pdfs")).length, files: (await repository.list("import-files")).length, receipts: (await repository.list("import-receipts")).length, status: controller.state.candidates[0].status };
  });
  expect(data).toEqual({ materials: 0, files: 0, receipts: 0, status: "failed" }); await commit(page);
});

test("explanation-only changes do not regrade; revoke and subsequent manual answers retain revisions", async ({ page }) => {
  await importFiles(page, "精读", [payload("history.txt", `Text 1\n${article}\n${q(21)}\n参考答案\n21. A`)]); await commit(page);
  const result = await page.evaluate(async () => {
    const probe = window.__WULIAO_IMPORT_E2E__, repo = probe.repository, s = await probe.answers(), r = (await repo.list("custom-pdfs"))[0], c = r.analysis.passages[0];
    localStorage.setItem(`wuliao:user:${encodeURIComponent(r.username)}:wuliao:deep-answers:${r.id}:${c.id}:first`, JSON.stringify({ 21: "A" }));
    let m = await s.readMaterialAnswers(r, c); await s.regradeMaterial(r, c, m); const before = (await repo.list("answer-evaluations")).length;
    await s.reviseMaterialAnswer({ resource: r, content: c, questionId: c.questions[0].id, value: "A", explanation: "只修改解释", previousId: m.records[0].id, expectedRevision: 1 });
    m = await s.readMaterialAnswers(r, c); await s.regradeMaterial(r, c, m);
    const after = (await repo.list("answer-evaluations")).length, ex = m.perQuestion[c.questions[0].id].explanation;
    await s.reviseMaterialAnswer({ resource: r, content: c, questionId: c.questions[0].id, previousId: m.records[0].id, expectedRevision: 1, revoke: true });
    m = await s.readMaterialAnswers(r, c); const revoked = m.records[0];
    await s.reviseMaterialAnswer({ resource: r, content: c, questionId: c.questions[0].id, value: "C", previousId: revoked.id, expectedRevision: 2 });
    return { before, after, ex, sources: (await repo.list("material-answers")).map((r) => r.source), revisions: (await repo.list("material-answers")).map((r) => r.revision), evaluations: (await repo.list("answer-evaluations")).length };
  });
  expect(result.before).toBe(result.after); expect(result.ex).toBe("只修改解释"); expect(result.revisions).toEqual([1, 2, 3]); expect(result.evaluations).toBe(3);
  expect(result.sources).toEqual(["source_document", "source_document", "manual"]);
});

test("saved-material AI regeneration waits for consent and bypasses the old candidate cache", async ({ page }) => {
  let calls = 0;
  await page.route("https://unified-import.invalid/**", async (route) => {
    calls++; const input = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: input.questions.map((q) => ({ questionId: q.questionId, value: calls === 1 ? "B" : "C", explanation: "Simulated regeneration" })) }) } }], usage: { total_tokens: 0 } }) });
  });
  await page.evaluate(() => { const user = localStorage.getItem("kaoyan_vocab_current_user"), prefix = `wuliao:user:${encodeURIComponent(user)}:`; localStorage.setItem(prefix + "wuliao:ai:apikey", "simulated-key"); localStorage.setItem(prefix + "wuliao:ai:model", "simulated-text"); localStorage.setItem(prefix + "wuliao:ai:api-config", JSON.stringify({ version: 1, baseUrl: "https://unified-import.invalid" })); });
  await importFiles(page, "精读", [payload("regenerate.txt", `Text 1\n${article}\n${q(21)}`)]); await commit(page);
  await page.getByRole("button", { name: "前往精读资料库" }).click(); await page.getByRole("tab", { name: /自定义库/ }).click(); await page.locator(".resource-card .resource-open").first().click();
  const manager = page.locator(".material-answer-manager"); await manager.locator("summary").first().click();
  await manager.getByRole("button", { name: "AI 生成", exact: true }).click(); expect(calls).toBe(0);
  await manager.getByRole("button", { name: "确认发送并生成", exact: true }).click(); await expect(manager.locator(".import-answer-row select")).toHaveValue("B"); expect(calls).toBe(1);
  await manager.getByRole("button", { name: "重新生成", exact: true }).click(); expect(calls).toBe(1);
  await manager.getByRole("button", { name: "确认发送并生成", exact: true }).click(); await expect(manager.locator(".import-answer-row select")).toHaveValue("C"); expect(calls).toBe(2);
  expect((await rows(page, "material-answers")).length).toBe(0);
  await manager.locator(".import-answer-row textarea").fill("User checked regeneration");
  await manager.getByRole("button", { name: "确认候选答案", exact: true }).click();
  await expect.poll(async () => (await rows(page, "material-answers")).map((a) => [a.value, a.source])).toEqual([["C", "ai_generated"]]);
  await manager.getByRole("button", { name: "查看答案与评分历史", exact: true }).click();
  await expect(manager.locator("p").filter({ hasText: /解析.*v1.*Simulated regeneration/ })).toBeVisible();
  await expect(manager.locator("p").filter({ hasText: /解析.*v2.*User checked regeneration/ })).toBeVisible();
});

test("post-import edited AI retains its generated version and restart resumes interrupted local scoring", async ({ page }) => {
  await importFiles(page, "精读", [payload("later-answer.txt", `Text 1\n${article}\n${q(21)}`)]); await commit(page);
  const saved = await page.evaluate(async () => {
    const p = window.__WULIAO_IMPORT_E2E__, repo = p.repository, service = await p.answers(), r = (await repo.list("custom-pdfs"))[0], c = r.analysis.passages[0];
    await service.resumeAnswerRegrading();
    const key = `wuliao:user:${encodeURIComponent(r.username)}:wuliao:deep-answers:${r.id}:${c.id}:first`;
    localStorage.setItem(key, JSON.stringify({ 21: "C" }));
    const candidates = await (await p.ai()).generateReferenceAnswers({ id: r.id, target: "reading", content: c, revision: r.materialRevision, answers: [] }, { consent: true, request: async () => ({ content: JSON.stringify({ answers: [{ questionId: c.questions[0].id, value: "B", explanation: "Simulated generated explanation" }] }) }) });
    const put = repo.put.bind(repo); repo.put = (store, record) => store === "answer-evaluations" ? Promise.reject(new Error("simulated shutdown before scoring")) : put(store, record);
    let interrupted = false;
    try { await service.confirmAiAnswer(r, c, { ...candidates[0], value: "C", explanation: "User checked explanation" }); }
    catch (error) { interrupted = /simulated shutdown/.test(error.message); }
    finally { repo.put = put; }
    return { interrupted, key, answers: (await repo.list("material-answers")).map((a) => [a.value, a.source, a.revision, a.reviewStatus]), explanations: (await repo.list("material-explanations")).map((e) => e.text) };
  });
  expect(saved.interrupted).toBe(true);
  expect(saved.answers).toEqual([["B", "ai_generated", 1, "candidate"], ["C", "ai_generated", 2, "confirmed"]]);
  expect(saved.explanations).toEqual(["Simulated generated explanation", "User checked explanation"]);
  await page.reload(); await expect(page.getByRole("heading", { name: "资料导入", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.__WULIAO_IMPORT_E2E__.repository.list("answer-evaluations")).filter((e) => e.scores.reference.correct === 1 && e.scores.reference.denominator === 1).length)).toBe(1);
  const result = await page.evaluate(async (key) => { const p = window.__WULIAO_IMPORT_E2E__, count = (await p.repository.list("answer-evaluations")).length; await (await p.answers()).resumeAnswerRegrading(); return { count, after: (await p.repository.list("answer-evaluations")).length, attempts: localStorage.getItem(key), formal: (await p.repository.list("answer-evaluations")).map((e) => e.scores.official.denominator) }; }, saved.key);
  expect(result.count).toBe(result.after); expect(result.attempts).toBe('{"21":"C"}'); expect(result.formal.every((n) => n === 0)).toBe(true);
});

test("PNG and scanned PDF use bundled local OCR without external requests", async ({ page }) => {
  test.setTimeout(180000); const external = []; page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1") && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) external.push(r.url()); });
  await page.getByRole("radio", { name: "精读", exact: true }).check(); await page.getByLabel("选择批量导入文件").setInputFiles([path.resolve("e2e/fixtures/unified-import/reading.png"), path.resolve("e2e/fixtures/unified-import/scanned.pdf")]);
  await expect(page.locator(".import-file").last()).toContainText("待检查", { timeout: 150000 });
  await expect(page.locator(".import-candidate")).toHaveCount(2);
  const result = await page.evaluate(() => window.__WULIAO_IMPORT_E2E__.controller.state.files.map((f) => ({ status: f.status, source: f.extracted.pages[0].textSource, hasText: /People learn/i.test(f.extracted.pages[0].text) })));
  expect(result.every((f) => f.source === "ocr" && f.hasText)).toBe(true); expect(external).toEqual([]);
  await page.screenshot({ path: "output/unified-import/20261009/local-ocr.png" });
});

test("late extraction cannot write after account switches away and back", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const p = window.__WULIAO_IMPORT_E2E__, c = p.controller, repo = p.repository, events = await p.events(), original = c.extract;
    let release, started; const entered = new Promise((resolve) => { started = resolve; });
    c.extract = async () => { started(); await new Promise((resolve) => { release = resolve; }); return { format: "text", pages: [{ pageNumber: 1, text: "Local reading material with enough English words to parse and preserve.", textSource: "text" }], assets: [] }; };
    const oldUser = localStorage.getItem("kaoyan_vocab_current_user");
    const pending = c.start([new File(["delayed reading"], "delayed.txt", { type: "text/plain" })], "reading").then(() => "unexpected success", (e) => e.code || e.message);
    await entered; localStorage.setItem("kaoyan_vocab_current_user", "different-account"); events.emitAppEvent("wuliao:account-changed", {});
    localStorage.setItem("kaoyan_vocab_current_user", oldUser); events.emitAppEvent("wuliao:account-changed", {});
    release(); const status = await pending; c.extract = original;
    return { status, formal: (await repo.list("custom-pdfs")).length, cached: (await repo.list("import-cache")).length };
  });
  expect(result).toEqual({ status: "account-changed", formal: 0, cached: 0 });
});

test("cancelling one file retains the remaining file and commits only selected valid material", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = window.__WULIAO_IMPORT_E2E__.controller, original = c.extract; let release, started;
    const entered = new Promise((resolve) => { started = resolve; });
    c.extract = async (file) => { if (file.name === "cancel.txt") { started(); await new Promise((resolve) => { release = resolve; }); } return { format: "text", pages: [{ pageNumber: 1, text: "People learn through practice. Every careful reader checks the original source and keeps enough evidence to support a useful conclusion.", textSource: "text" }], assets: [] }; };
    const pending = c.start([new File(["first"], "cancel.txt", { type: "text/plain" }), new File(["second"], "valid.txt", { type: "text/plain" })], "reading");
    await entered; const liveState = c.state; await c.restore(); const preserved = c.state === liveState;
    await c.cancelFile("file-1"); release(); await pending; c.extract = original;
    const files = c.state.files.map((f) => f.status), count = c.state.candidates.length; await c.commit();
    return { files, count, preserved, saved: (await window.__WULIAO_IMPORT_E2E__.repository.list("custom-pdfs")).length };
  });
  expect(result).toEqual({ files: ["cancelled", "review_required"], count: 1, preserved: true, saved: 1 });
});

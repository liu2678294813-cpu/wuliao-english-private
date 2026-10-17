import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";
import { TRAINING_SOURCE, TRAINING_SENTENCE_B, TRAINING_SENTENCE_C, TRAINING_FINGERPRINT, TRAINING_EVALUATION, qualityItem, QUALITY_CORPUS } from "../scripts/fixtures/long-sentence-quality.mjs";

const RESOURCE = "custom-long-sentence-fixture", PASSAGE = "passage-training";
const OTHER_SOURCE = "The students who attended the lecture understood the argument.";
const loc = (page, name) => page.getByTestId(`long-sentence-${name}`);
function sentenceKey(text, index) { let hash = 5381; for (const char of text.replace(/\s+/g, " ").trim().toLowerCase()) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0; return `p1s${index + 1}:x${(hash >>> 0).toString(36)}`; }
const SOURCE_KEY = sentenceKey(TRAINING_SOURCE, 0), OTHER_KEY = sentenceKey(OTHER_SOURCE, 1);
const scoped = (user, key) => `wuliao:user:${encodeURIComponent(user)}:${key}`;

// Every test runs in Playwright's fresh context and a fresh app account. The
// seed represents completed original-reading facts, never production data.
async function seedOriginalFacts(page, username, { secondDifficult = false } = {}) {
  await page.evaluate(async ({ user, resourceId, passageId, source, other, sourceKey, otherKey, secondDifficult }) => {
    const key = value => `wuliao:user:${encodeURIComponent(user)}:${value}`, now = Date.now();
    localStorage.setItem(key("wuliao:ai:apikey"), "test-long-sentence-key");
    localStorage.setItem(key("wuliao:feature:longSentenceTrainingEnabled"), "true");
    const entry = reviewStatus => ({ translationStatus: "corrected", reviewStatus, translatedAt: now - 2000, correctedAt: now - 1000, reviewedAt: now, translationFingerprint: "fixture" });
    localStorage.setItem(key(`wuliao:translation-progress:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 1, resourceId, passageId, updatedAt: now, sentences: { [sourceKey]: entry("needs_review"), [otherKey]: entry(secondDifficult ? "needs_review" : "mastered") }, paragraphs: {} }));
    localStorage.setItem(key(`wuliao:deep-answers:${resourceId}:${passageId}:first`), JSON.stringify({ 1: "B" }));
    localStorage.setItem(key(`wuliao:deep-answers:${resourceId}:${passageId}:redo`), JSON.stringify({ 1: "C" }));
    localStorage.setItem(key(`wuliao:question-evidence:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 2, resourceId, passageId, entries: {}, updatedAt: now }));
    const stages = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
    localStorage.setItem(key(`wuliao:reading-flow:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 2, resourceId, passageId, currentStage: "deep-translation", stages: Object.fromEntries(stages.map((id, index) => [id, { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? now - 1000 : null }])), timedReading: { phase: "done", elapsedMs: 1000, startedAt: now - 3000, pausedAt: null, completedAt: now - 2000 }, updatedAt: now }));
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["custom-pdfs", "unknown-words"], "readwrite");
        transaction.objectStore("custom-pdfs").put({ id: resourceId, kind: "custom", category: "custom", username: user, title: "长难句隔离测试资料", subtitle: "测试资料", year: 2025, fingerprint: "long-sentence-e2e-fixture", addedAt: now, conversionStatus: "ready", size: 0, file: new Blob([], { type: "application/pdf" }), analysis: { title: "长难句隔离测试资料", passages: [{ id: passageId, label: "Text A", text: source + " " + other, paragraphs: [{ number: 1, text: source + " " + other, sentences: [source, other] }], questions: [], correctAnswers: {} }] } });
        for (const word of ["reinforce", "constrain"]) transaction.objectStore("unknown-words").put({ id: `${user}:${word}`, username: user, resourceId, passageId, passageLabel: "Text A", chapter: "2025 阅读", sourceType: "reading", word, normalizedWord: word, meaning: word === "reinforce" ? "加强" : "限制", occurrences: [sourceKey], createdAt: now, updatedAt: now });
        transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, { user: username, resourceId: RESOURCE, passageId: PASSAGE, source: TRAINING_SOURCE, other: OTHER_SOURCE, sourceKey: SOURCE_KEY, otherKey: OTHER_KEY, secondDifficult });
  await page.reload(); await page.locator(".home-page").waitFor();
}
async function rows(page, store) {
  return page.evaluate(async name => { const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); try { return await new Promise((resolve, reject) => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } finally { db.close(); } }, store);
}
async function originalSnapshot(page, user) {
  return page.evaluate(({ prefix, resource, passage }) => Object.fromEntries([`wuliao:deep-answers:${resource}:${passage}:first`, `wuliao:deep-answers:${resource}:${passage}:redo`, `wuliao:question-evidence:${resource}:${passage}`, `wuliao:reading-flow:${resource}:${passage}`].map(key => [key, localStorage.getItem(prefix + key)])), { prefix: scoped(user, ""), resource: RESOURCE, passage: PASSAGE });
}
async function reviewState(page, user) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`)); }
const COVERED_SENTENCE_C = "Even though the investigators whose findings reinforce earlier warnings concede that budget limits constrain further inspections, their report indicates that the coastal bridges remain unsafe.";
const COVERED_SENTENCE_D = "The conservators, who must constrain chemical treatments to protect pigments that reinforce the painting's authenticity, argue that restoration should proceed only if independent tests confirm the canvas can withstand it.";
function block(messages, tag) { const content = messages.filter(message => message.role === "user").map(message => message.content).join("\n"); const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(content); return match ? JSON.parse(match[1]) : null; }
async function mockAi(page, { failEvaluate = false, failGenerate = false, badGenerationItem = false, holdSupplement = false } = {}) {
  const requests = []; let generationCalls = 0, evaluateCalls = 0;
  let releaseSupplement;
  const supplementGate = holdSupplement ? new Promise(resolve => { releaseSupplement = resolve; }) : null;
  await page.route("https://api.deepseek.com/**", async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const analyzing = block(body.messages, "DATA_sources");
    const verifying = block(body.messages, "DATA_verification");
    if (analyzing) {
      const result = { sources: analyzing.map(source => ({ sourceReviewId: source.sourceReviewId, difficulty: 2,
        requirements: [{ description: "来源的从句与主句关系", evidence: [source.text], relation: "保留从属关系及主句结论", commonPitfall: "混淆从句与主句" }] })) };
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(result) } }] } }); return;
    }
    if (verifying) {
      const result = { items: verifying.items.map((item, index) => ({ index, natural: true, aboveSource: true,
        addedComplexityEvidence: [item.text], reason: "固定测试样例结构有效",
        wordChecks: verifying.words.filter(word => item.text.includes(word.word)).map(word => ({ wordId: word.wordId, surfaceForm: word.word, meaningMatches: true, reason: "固定词义" })),
        requirementChecks: verifying.requirements.filter(requirement => item.sourceReviewIds.includes(requirement.sourceReviewId)).map(requirement => ({ requirementId: requirement.id, evidence: [item.text], reason: "固定结构关系" })) })) };
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(result) } }] } }); return;
    }
    const sources = block(body.messages, "source_sentences");
    if (sources) {
      generationCalls += 1;
      if (failGenerate) {
        await route.fulfill({ status: 503, json: { error: { message: "generation unavailable" } } });
        return;
      }
      if (holdSupplement && generationCalls === 2) {
        await supplementGate;
        await route.fulfill({ status: 503, json: { error: { message: "supplement unavailable" } } });
        return;
      }
      const parameters = block(body.messages, "generation_parameters"), words = block(body.messages, "target_words");
      const candidates = [TRAINING_SENTENCE_B, COVERED_SENTENCE_C, COVERED_SENTENCE_D, QUALITY_CORPUS[1].generated, QUALITY_CORPUS[2].generated];
      const items = Array.from({ length: parameters.count }, (_, index) => qualityItem({ text: candidates[(generationCalls - 1 + index) % candidates.length], sourceReviewIds: sources.filter((_source, sourceIndex) => Math.floor(sourceIndex / 2) % parameters.count === index).slice(0,2).map(source => source.sourceReviewId).concat(sources.length <= index * 2 ? [sources[0].sourceReviewId] : []), fingerprint: parameters.structureFingerprint || TRAINING_FINGERPRINT, uses: words.filter(word => candidates[(generationCalls - 1 + index) % candidates.length].includes(word.word)).slice(0, 3).map(({ wordId, word }) => ({ wordId, word, surfaceForm: word })) }));
      // Difficulty covers all selected sources; actual structural references
      // can remain a subset of that selection.
      for (const item of items) {
        const sourceDifficulties = sources.map(source => ({ sourceReviewId: source.sourceReviewId, difficulty: source.difficulty ?? 2 }));
        const sourceDifficulty = Math.max(...sourceDifficulties.map(source => source.difficulty));
        Object.assign(item.difficultyMetadata, { sourceDifficulties, sourceDifficulty, targetDifficulty: sourceDifficulty + 1, difficultyDelta: 1 });
      }
      if (badGenerationItem && generationCalls === 1) items[items.length - 1].difficultyPolicy = "match_source";
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items }) } }] } });
    } else {
      evaluateCalls += 1;
      if (failEvaluate && evaluateCalls === 1) await route.fulfill({ status: 429, json: { error: { message: "quota exceeded" } } });
      else await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(TRAINING_EVALUATION) } }] } });
    }
  });
  return { requests, releaseSupplement, generationCount: () => generationCalls, evaluationCount: () => evaluateCalls };
}
async function openGenerator(page, { count = 1 } = {}) {
  await navTo(page, "长难句"); await expect(loc(page, "page")).toBeVisible();
  await page.getByRole("tab", { name: "生成训练", exact: true }).click();
  await loc(page, "count").selectOption("1");
  await loc(page, "source-checkbox").first().check();
  for (const word of ["reinforce", "constrain"]) await page.getByRole("checkbox", { name: new RegExp(word) }).check();
  const countControl = loc(page, "count");
  if (await countControl.evaluate(element => element.tagName === "SELECT")) await countControl.selectOption(String(count));
  else await countControl.fill(String(count));
  await loc(page, "generate").click(); await expect(loc(page, "sentence")).toBeVisible();
}
async function drawAnalysis(page) {
  const surface = page.locator(".writing-ink-surface"); await expect(surface).toBeVisible();
  const handwriting = page.getByRole("button", { name: "手写批注", exact: true });
  if (await handwriting.count()) await handwriting.click();
  await surface.scrollIntoViewIfNeeded(); const box = await surface.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + 24, box.y + 48); await page.mouse.down();
  await page.mouse.move(box.x + Math.min(240, box.width - 24), box.y + 52, { steps: 14 }); await page.mouse.up();
  await expect.poll(async () => (await rows(page, "long-sentence-ink")).reduce((total, row) => total + row.strokes.length, 0)).toBeGreaterThan(0);
}

test("主链：原句困难 → 新句书写翻译 → 自评隔离 → 原句正确复习 → 同 Skill 新句", async ({ page }) => {
  const username = await createAccount(page); await seedOriginalFacts(page, username);
  const before = await originalSnapshot(page, username), unknownBefore = await rows(page, "unknown-words");
  const mock = await mockAi(page); await openGenerator(page);
  await expect(loc(page, "sentence")).toHaveText(TRAINING_SENTENCE_B);
  await page.screenshot({ path: "artifacts/long-sentence-ink-20261017/long-sentence-training.png", fullPage: true });
  expect(mock.generationCount()).toBe(1); expect(mock.evaluationCount()).toBe(0);
  await expect(loc(page, "evaluation")).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain(TRAINING_EVALUATION.referenceTranslation);
  expect(await rows(page, "long-sentence-evaluations")).toHaveLength(0);
  const generatedRows = await rows(page, "long-sentence-items"); expect(JSON.stringify(generatedRows)).not.toContain("referenceTranslation");
  await drawAnalysis(page);
  await loc(page, "translation").fill("尽管大气条件限制推断，天文学家的研究仍表明遥远的行星适宜居住。");
  await loc(page, "submit").click(); await expect(loc(page, "evaluation")).toContainText("AI 参考");
  expect(mock.evaluationCount()).toBe(1);
  const evaluationPayload = block(mock.requests.at(-1).messages, "evaluation_data");
  expect(evaluationPayload.userTranslation).toContain("限制推断");
  expect(Object.keys(evaluationPayload).sort()).toEqual(["difficultyMetadata", "generatedSentence", "promptVersion", "structureFingerprint", "targetWordUses", "userTranslation"].sort());
  await page.getByRole("button", { name: "已掌握", exact: true }).click();
  await expect.poll(async () => (await rows(page, "long-sentence-attempts"))[0]?.userRating).toBe("mastered");
  expect((await reviewState(page, username))[SOURCE_KEY].reviewStatus).toBe("needs_review");
  expect(await originalSnapshot(page, username)).toEqual(before); expect(await rows(page, "unknown-words")).toEqual(unknownBefore);
  await navTo(page, "长难句"); await page.getByRole("tab", { name: "已学习", exact: true }).click();
  await expect(loc(page, "page")).not.toContainText(TRAINING_SOURCE);
  await page.getByRole("tab", { name: "待掌握", exact: true }).click();
  await expect(loc(page, "page")).toContainText(TRAINING_SOURCE);
  await page.getByRole("button", { name: "复习原句", exact: true }).first().click();
  await expect(page.locator(".review-session")).toBeVisible();
  await page.getByRole("button", { name: "现在能独立理解", exact: true }).click();
  await expect.poll(async () => (await reviewState(page, username))[SOURCE_KEY].reviewStatus).toBe("mastered");
  await page.getByRole("button", { name: "完成本次复查", exact: true }).click();
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await navTo(page, "长难句"); await page.getByRole("tab", { name: "已学习", exact: true }).click();
  await expect(loc(page, "page")).toContainText(TRAINING_SOURCE);
  await page.getByRole("tab", { name: "待掌握", exact: true }).click();
  await expect(loc(page, "page")).not.toContainText(TRAINING_SOURCE);
  const skills = await rows(page, "long-sentence-skills"); expect(skills).toHaveLength(1);
  await page.clock.setFixedTime(new Date(`${skills[0].nextDueAt}T12:00:00`));
  await page.reload(); await navTo(page, "长难句");
  await page.getByRole("tab", { name: "待复习", exact: true }).click();
  await page.getByRole("button", { name: "开始复习", exact: true }).first().click();
  await expect(loc(page, "sentence")).toHaveText(COVERED_SENTENCE_C);
  const last = (await rows(page, "long-sentence-items")).find(item => item.text === COVERED_SENTENCE_C);
  expect(last.structureFingerprint).toBe(TRAINING_FINGERPRINT); expect(last.difficultyMetadata.targetDifficulty).toBeGreaterThan(last.difficultyMetadata.sourceDifficulty);
  expect(last.text).not.toBe(TRAINING_SOURCE); expect(last.text).not.toBe(TRAINING_SENTENCE_B);
});

test("坏项修复整批且验证通过后一次发布，不创建部分正式练习", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  const mock = await mockAi(page, { badGenerationItem: true }); await openGenerator(page, { count: 2 });
  expect(mock.generationCount()).toBe(2);
  const generations = mock.requests.filter(request => block(request.messages, "generation_parameters"));
  expect(block(generations[1].messages, "generation_parameters").count).toBe(2);
  expect(await rows(page, "long-sentence-items")).toHaveLength(2);
  expect((await rows(page, "long-sentence-sessions"))[0].status).toBe("ready");
  await expect(loc(page, "page")).toContainText("通过 AI 覆盖复核");
});

test("覆盖修复失败不提前创建练习，刷新保留候选草稿与完整目标", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  const mock = await mockAi(page, { badGenerationItem: true, holdSupplement: true });
  await navTo(page, "长难句"); await loc(page, "count").selectOption("2");
  await loc(page, "source-checkbox").first().check();
  await loc(page, "generate").click();
  await expect.poll(() => mock.generationCount()).toBe(2);
  expect(await rows(page, "long-sentence-items")).toHaveLength(0);
  await expect(loc(page, "translation")).toHaveCount(0);
  mock.releaseSupplement();
  await expect(page.getByRole("button", { name: "重试生成", exact: true })).toBeEnabled();
  expect(await rows(page, "long-sentence-items")).toHaveLength(0);
  await page.reload();
  await expect(loc(page, "page")).toContainText("已保留来源和选择");
  expect((await rows(page, "long-sentence-sessions"))[0].count).toBe(2);
});

test("生成 503 不自动重试，空训练保留五句目标，手动重试仍请求五句", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  const mock = await mockAi(page, { failGenerate: true });
  await navTo(page, "长难句");
  await loc(page, "count").selectOption("1");
  await loc(page, "source-checkbox").first().check();
  await loc(page, "count").selectOption("5");
  await loc(page, "generate").click();
  const retry = page.getByRole("button", { name: "重试生成", exact: true });
  await expect(retry).toBeEnabled();
  await expect(loc(page, "page").getByRole("alert")).toBeVisible();
  expect(mock.generationCount()).toBe(1);
  expect(block(mock.requests.filter(request => block(request.messages, "generation_parameters"))[0].messages, "generation_parameters").count).toBe(5);
  const firstSession = (await rows(page, "long-sentence-sessions"))[0];
  expect(firstSession.count).toBe(5);
  await retry.click();
  await expect.poll(() => mock.generationCount()).toBe(2);
  await expect(retry).toBeEnabled();
  expect(mock.generationCount()).toBe(2);
  expect(block(mock.requests.filter(request => block(request.messages, "generation_parameters"))[1].messages, "generation_parameters").count).toBe(5);
  const sessions = await rows(page, "long-sentence-sessions");
  expect(sessions).toHaveLength(1); expect(sessions[0].id).toBe(firstSession.id); expect(sessions[0].count).toBe(5);
  expect(await rows(page, "long-sentence-items")).toHaveLength(0);
  expect(await rows(page, "long-sentence-evaluations")).toHaveLength(0);
  await expect(loc(page, "sentence")).toHaveCount(0);
  expect(mock.evaluationCount()).toBe(0);
  expect((await reviewState(page, user))[SOURCE_KEY].reviewStatus).toBe("needs_review");
});

test("来源在页面加载后变更时阻止生成，不发送旧句给 AI", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  const mock = await mockAi(page);
  await navTo(page, "长难句");
  await loc(page, "count").selectOption("1");
  await loc(page, "source-checkbox").first().check();
  await page.evaluate(async resourceId => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("custom-pdfs", "readwrite"), store = transaction.objectStore("custom-pdfs"), request = store.get(resourceId);
        request.onsuccess = () => {
          const resource = request.result, passage = resource.analysis.passages[0];
          const changed = "The revised material no longer contains the original difficult sentence.";
          passage.text = changed; passage.paragraphs[0].text = changed; passage.paragraphs[0].sentences = [changed];
          resource.fingerprint = "changed-after-selection"; store.put(resource);
        };
        transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, RESOURCE);
  await loc(page, "generate").click();
  await expect(loc(page, "page").getByRole("alert")).toBeVisible();
  expect(mock.generationCount()).toBe(0); expect(mock.requests).toHaveLength(0);
  expect(await rows(page, "long-sentence-items")).toHaveLength(0);
  expect(await rows(page, "long-sentence-evaluations")).toHaveLength(0);
});

test("平板句纸工具栏不覆盖首行，所有可见控件可横向滚动到达", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  await mockAi(page); await openGenerator(page);
  const toolbar = page.locator(".ls-paper-workspace > .annotation-toolbar");
  for (const width of [1104, 832, 544]) {
    await page.setViewportSize({ width, height: 844 });
    await toolbar.scrollIntoViewIfNeeded();
    const toolsBox = await toolbar.boundingBox(), paperBox = await page.locator(".ls-paper-host").boundingBox();
    expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(paperBox.y + 1);
    expect(toolsBox.x).toBeGreaterThanOrEqual(0);
    expect(toolsBox.x + toolsBox.width).toBeLessThanOrEqual(width + 1);
    const controls = toolbar.locator("button:visible, input:visible, select:visible");
    expect(await controls.count()).toBeGreaterThan(3);
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded();
      const reached = await control.evaluate(element => {
        const rect = element.getBoundingClientRect(), host = element.closest(".annotation-toolbar").getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y);
        return x >= host.left && x <= host.right && y >= host.top && y <= host.bottom && x >= 0 && x <= innerWidth && Boolean(hit && (hit === element || element.contains(hit)));
      });
      expect(reached, `toolbar control must be reachable at ${width}px`).toBe(true);
    }
  }
});

test("429 保留草稿和笔迹，主动重试才调用；解析有误保留旧解析", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user);
  const mock = await mockAi(page, { failEvaluate: true }); await openGenerator(page); await drawAnalysis(page);
  const translation = "这是测试译文，不能因网络或限额错误丢失。";
  await loc(page, "translation").fill(translation); await loc(page, "submit").click();
  await expect(loc(page, "page")).toContainText("限额"); expect(mock.evaluationCount()).toBe(1);
  expect((await rows(page, "long-sentence-attempts"))[0].userTranslation).toBe(translation);
  expect((await rows(page, "long-sentence-ink"))[0].strokes.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: /重试解析|重新解析|重试批改/ }).first().click();
  await expect(loc(page, "evaluation")).toBeVisible(); expect(mock.evaluationCount()).toBe(2);
  await page.getByRole("button", { name: "解析有误", exact: true }).click();
  await expect.poll(async () => (await rows(page, "long-sentence-evaluations"))[0]?.analysisFeedback).toBe("incorrect");
  expect(mock.evaluationCount()).toBe(2);
  await page.getByRole("button", { name: "重新解析", exact: true }).click();
  await expect.poll(async () => (await rows(page, "long-sentence-evaluations")).length).toBe(2);
  expect((await rows(page, "long-sentence-evaluations"))[0].analysisFeedback).toBe("incorrect");
  expect((await rows(page, "long-sentence-attempts"))[0].userRating).toBeNull();
  expect((await reviewState(page, user))[SOURCE_KEY].reviewStatus).toBe("needs_review");
  const oldInk = await rows(page, "long-sentence-ink");
  const oldAttemptId = (await rows(page, "long-sentence-attempts"))[0].id;
  await page.getByRole("button", { name: "重新作答", exact: true }).click();
  await expect(loc(page, "translation")).toHaveValue("");
  await page.getByRole("region", { name: "历史题目与作答", exact: true }).getByRole("button").first().click();
  const history = page.getByRole("region", { name: "历史作答详情", exact: true });
  await expect(history).toContainText(translation);
  const oldSurface = history.locator(".writing-ink-surface");
  await expect(oldSurface).toHaveAttribute("aria-readonly", "true");
  await expect(history.getByRole("button", { name: "清空笔迹", exact: true })).toHaveCount(0);
  await oldSurface.scrollIntoViewIfNeeded(); const box = await oldSurface.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 35); await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 60, { steps: 10 }); await page.mouse.up();
  await history.getByRole("button", { name: "收起详情", exact: true }).click();
  expect(await rows(page, "long-sentence-ink")).toEqual(oldInk);
  expect((await rows(page, "long-sentence-attempts")).find(attempt => attempt.id === oldAttemptId).userTranslation).toBe(translation);
});

test("多选半选、草稿和书写刷新恢复、离线浏览与多宽度不溢出", async ({ page, context }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user, { secondDifficult: true }); await mockAi(page);
  await navTo(page, "长难句"); await expect(loc(page, "source-checkbox")).toHaveCount(2);
  await loc(page, "count").selectOption("1");
  await loc(page, "source-checkbox").first().check();
  expect(await loc(page, "page").locator("input[type=checkbox]").evaluateAll(elements => elements.some(element => element.indeterminate))).toBe(true);
  await openGenerator(page); await drawAnalysis(page);
  const draft = "尚未提交的中文草稿。"; await loc(page, "translation").fill(draft);
  await expect.poll(async () => (await rows(page, "long-sentence-attempts"))[0]?.userTranslation).toBe(draft);
  await page.reload(); await expect(loc(page, "translation")).toHaveValue(draft);
  expect((await rows(page, "long-sentence-ink"))[0].strokes.length).toBeGreaterThan(0);
  await context.setOffline(true); await expect(loc(page, "translation")).toBeEditable();
  await loc(page, "translation").fill(draft + "离线仍可编辑。");
  await expect.poll(async () => (await rows(page, "long-sentence-attempts"))[0]?.userTranslation).toContain("离线仍可编辑");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  await context.setOffline(false); await loc(page, "submit").click(); await expect(loc(page, "evaluation")).toBeVisible();
});

test("额外练习与换句不推进正式调度，关闭入口保留训练及原学习数据", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user); await mockAi(page); await openGenerator(page);
  await loc(page, "translation").fill("第一次正式训练的译文。"); await loc(page, "submit").click();
  await expect(loc(page, "evaluation")).toBeVisible(); await page.getByRole("button", { name: "已掌握", exact: true }).click();
  await expect.poll(async () => (await rows(page, "long-sentence-skills")).length).toBe(1);
  const formalSkill = (await rows(page, "long-sentence-skills"))[0];
  await page.getByRole("button", { name: "现在再来一句", exact: true }).click();
  await expect(loc(page, "sentence")).toHaveText(COVERED_SENTENCE_C);
  await loc(page, "translation").fill("这是额外练习的译文。"); await loc(page, "submit").click();
  await expect(loc(page, "evaluation")).toBeVisible(); await page.getByRole("button", { name: "仍困难", exact: true }).click();
  await expect.poll(async () => (await rows(page, "long-sentence-attempts")).filter(attempt => attempt.userRating).length).toBe(2);
  expect((await rows(page, "long-sentence-skills"))[0]).toEqual(formalSkill);
  await page.getByRole("button", { name: "换一句", exact: true }).click();
  await expect(loc(page, "sentence")).toHaveText(COVERED_SENTENCE_D);
  expect((await rows(page, "long-sentence-attempts")).filter(attempt => attempt.userRating)).toHaveLength(2);
  expect((await rows(page, "long-sentence-skills"))[0]).toEqual(formalSkill);
  const items = await rows(page, "long-sentence-items"), original = await originalSnapshot(page, user);
  await page.getByRole("button", { name: /^设置/ }).click();
  // Turning this feature off intentionally closes its settings modal, so use
  // click and assert the resulting navigation instead of detached checkbox state.
  await page.getByRole("checkbox", { name: "长难句训练", exact: true }).click();
  await expect(page.locator(".ds-rail .ds-nav button", { hasText: "长难句" })).toHaveCount(0);
  expect(await rows(page, "long-sentence-items")).toEqual(items);
  expect(await originalSnapshot(page, user)).toEqual(original);
  expect((await reviewState(page, user))[SOURCE_KEY].reviewStatus).toBe("needs_review");
});


test("large saved source selection is bounded without deleting any selected originals", async ({ page }) => {
  const user = await createAccount(page);
  await seedOriginalFacts(page, user);
  await page.evaluate(async ({ user, resourceId, passageId }) => {
    const extras = Array.from({ length: 79 }, (_, index) =>
      `Although the panel considered the evidence in its review number ${index + 1}, the researchers who examined the records recommended further investigation.`);
    const sentenceKey = (text, index) => {
      let hash = 5381;
      for (const char of text.replace(/\s+/g, " ").trim().toLowerCase()) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
      return `p1s${index + 1}:x${(hash >>> 0).toString(36)}`;
    };
    const key = `wuliao:user:${encodeURIComponent(user)}:wuliao:translation-progress:${resourceId}:${passageId}`;
    const progress = JSON.parse(localStorage.getItem(key));
    for (let index = 0; index < extras.length; index++) {
      progress.sentences[sentenceKey(extras[index], index + 2)] = {
        translationStatus: "corrected", reviewStatus: "needs_review",
        translatedAt: Date.now() - 2000, correctedAt: Date.now() - 1000, reviewedAt: Date.now(),
      };
    }
    localStorage.setItem(key, JSON.stringify(progress));
    localStorage.setItem(`wuliao:user:${encodeURIComponent(user)}:wuliao:long-sentence:selection`, JSON.stringify({ count: 1, countConfirmed: true, selected: Object.entries(progress.sentences).filter(([_key, state]) => state.reviewStatus === "needs_review").map(([sentenceKey]) => JSON.stringify([resourceId, passageId, sentenceKey])), selectedWordIds: [] }));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("custom-pdfs", "readwrite");
        const store = tx.objectStore("custom-pdfs"), request = store.get(resourceId);
        request.onsuccess = () => {
          const resource = request.result, passage = resource.analysis.passages[0];
          passage.paragraphs[0].sentences.push(...extras);
          passage.paragraphs[0].text = passage.paragraphs[0].sentences.join(" ");
          passage.text = passage.paragraphs[0].text;
          store.put(resource);
        };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { user, resourceId: RESOURCE, passageId: PASSAGE });
  await page.reload();
  await page.locator(".home-page").waitFor();
  const mock = await mockAi(page);
  await navTo(page, "长难句");
  await expect(loc(page, "source-checkbox")).toHaveCount(80);
  await expect(loc(page, "generate")).toBeDisabled();
  await expect(loc(page, "page")).toContainText("选择超过当前句数的额度");
  await expect(loc(page, "page")).toContainText("原句 80/2");
  expect(mock.requests).toHaveLength(0);
  await navTo(page, "首页");
  const selection = await page.evaluate(user => JSON.parse(localStorage.getItem(`wuliao:user:${encodeURIComponent(user)}:wuliao:long-sentence:selection`)), user);
  expect(selection.selected).toHaveLength(80);
});

test("先选句数、陌生词上限与减少句数保留选择，桌面及手机布局可用", async ({ page }) => {
  const user = await createAccount(page); await seedOriginalFacts(page, user, { secondDifficult: true });
  await page.evaluate(async ({ user, resourceId, passageId }) => {
    const db = await new Promise((resolve,reject) => { const req = indexedDB.open("wuliao-english"); req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); });
    try { await new Promise((resolve,reject) => { const tx=db.transaction("unknown-words","readwrite");
      for (const word of ["adapt","assess"]) tx.objectStore("unknown-words").put({ id: `${user}:${word}`, username:user, resourceId,passageId,word,normalizedWord:word,meaning:"测试词义",occurrences:[],createdAt:Date.now() });
      tx.oncomplete=resolve; tx.onabort=tx.onerror=()=>reject(tx.error); }); } finally { db.close(); }
  }, { user, resourceId: RESOURCE, passageId: PASSAGE });
  await navTo(page, "长难句");
  await expect(loc(page,"source-checkbox").first()).toBeDisabled();
  await loc(page,"count").selectOption("1");
  await page.getByRole("checkbox", { name: /全选可用原句/ }).check();
  for (const word of ["reinforce","constrain","adapt"]) await page.getByRole("checkbox", { name: new RegExp(word) }).check();
  await page.getByRole("checkbox", { name: /assess/ }).click();
  await expect(page.getByRole("checkbox", { name: /assess/ })).not.toBeChecked();
  await expect(loc(page,"page")).toContainText("最多选择 3 个词或义项");
  await page.screenshot({ path: "artifacts/long-sentence-ink-20261017/long-sentence-selection-desktop.png", fullPage:true });
  await loc(page,"count").selectOption("2");
  await page.getByRole("checkbox", { name: /assess/ }).check();
  await loc(page,"count").selectOption("1");
  await expect(loc(page,"generate")).toBeDisabled();
  for (const word of ["reinforce","constrain","adapt","assess"]) await expect(page.getByRole("checkbox", { name: new RegExp(word) })).toBeChecked();
  await page.setViewportSize({ width:390,height:844 });
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.screenshot({ path: "artifacts/long-sentence-ink-20261017/long-sentence-selection-mobile.png", fullPage:true });
});

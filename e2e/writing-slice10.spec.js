import { test, expect } from "@playwright/test";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";
import { GENERATED_WRITING_QUESTIONS } from "../src/writing/questions/generatedWritingQuestionData.js";

const FAKE_BASE = "https://e2e-writing.invalid/v1";
const FORBIDDEN_W7 = [
  "E2E_SAMPLE_SECRET",
  "E2E_TRANSLATION_SECRET",
  "E2E_DIAG_SECRET",
  "E2E_SKELETON_SECRET",
  "E2E_RECON_SECRET",
  "E2E_ADVICE_SECRET",
];

const A_ESSAY = `Notice
Professor Smith's campus sports research project is recruiting one student assistant. The successful applicant will help distribute questionnaires, organize interview notes, check activity records, and arrange weekly meetings with the research team. Candidates should be responsible, careful, cooperative, and interested in sports studies. Basic spreadsheet skills and clear written English are required. Experience in student organizations is preferred but not essential. Please send a short introduction and your available hours to the project office before Friday. We welcome every qualified student who hopes to gain practical research experience.
Li Ming`;

const B_ESSAY = `The picture presents a thoughtful contrast between quick online reactions and patient personal growth. A young student watches countless messages move across a screen while a small plant beside the desk develops one leaf at a time. The scene suggests that meaningful progress rarely follows the speed of digital attention. Public praise may arrive immediately and disappear just as quickly, whereas knowledge, character, and ability need sustained effort.

This message matters especially to university students. Online platforms can provide information and encouragement, but they can also tempt people to measure achievement through likes, rankings, or brief excitement. When external responses become the only standard, learners may abandon difficult tasks before improvement becomes visible.

In my view, we should use technology as a tool while keeping long-term goals at the center of daily life. A practical schedule, regular reflection, and honest feedback can turn small actions into lasting competence. Like the plant in the picture, genuine development depends on steady care rather than instant applause. Patience is therefore not passive waiting; it is disciplined action repeated until real change takes root.`;

const RAW_VISION = "raw vision draft with E2E spelling eror";
const VERIFIED_VISION = "Verified vision text with the spelling error deliberately corrected by the user.";

function countWords(value) {
  return (String(value).match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || []).length;
}

function sampleFor(payload, mode = "pass") {
  if (mode === "fail") {
    return {
      taskType: payload.taskType,
      promptFingerprint: payload.promptFingerprint,
      essayText: "too short",
      segments: [{ unitId: "sample-unit-1", text: "too short" }],
    };
  }
  const essayText = payload.taskType.endsWith("writing-a") ? A_ESSAY : B_ESSAY;
  return {
    taskType: payload.taskType,
    promptFingerprint: payload.promptFingerprint,
    essayText,
    segments: [{ unitId: "sample-unit-1", text: essayText }],
  };
}

function criticFor(taskType) {
  const writingA = taskType.endsWith("writing-a");
  return {
    pass: true,
    predictedBand: 5,
    predictedScoreRange: writingA ? { min: 9, max: 10 } : { min: 18, max: 19 },
    fatalIssues: [],
    defects: [],
    checks: {
      taskFulfillment: "pass",
      formatRegister: "pass",
      coherence: "pass",
      languageAccuracy: "pass",
      languageRange: "pass",
      naturalness: "pass",
    },
  };
}

function compareFor(payload) {
  return {
    units: payload.sampleEssaySnapshot.segments.map((unit) => ({
      unitId: unit.unitId,
      meaning: { status: "preserved", evidence: "The confirmed back translation preserves the central meaning." },
      grammar: [],
      collocation: [],
      naturalness: [],
      register: [],
      learnablePatterns: [],
    })),
  };
}

function scoreFor(payload) {
  const writingA = payload.promptSnapshot.taskType.endsWith("writing-a");
  const dimension = { rating: "excellent", comment: "The verified response satisfies this dimension.", evidence: [] };
  return {
    finalScore: writingA ? 9 : 18,
    band: 5,
    zeroReason: null,
    dimensions: {
      taskFulfillment: dimension,
      contentCoverage: dimension,
      organizationCoherence: dimension,
      languageAccuracy: dimension,
      languageRange: dimension,
      formatRegister: dimension,
    },
    issues: [],
    strengths: ["The response is complete and coherent."],
    revisionAdvice: ["Keep the main claim explicit in the next draft."],
  };
}

function rewriteFor(payload) {
  return {
    referenceText: `${payload.revisionAttempt.verifiedText.text} This separate reference ending improves emphasis.`,
    changeNotes: [{ category: "ending", fromExcerpt: "original ending", toExcerpt: "improved ending", reason: "Makes the conclusion more explicit." }],
    rationale: ["The reference keeps the user's central meaning while tightening the ending."],
  };
}

async function installFakeProviders(page, { sampleSequence = ["pass"], vision = "success" } = {}) {
  const calls = { sample: 0, critic: 0, compare: 0, score: 0, rewrite: 0, vision: 0, models: 0, visionMode: vision, compareMode: "success", scoreMode: "success", rewriteMode: "success" };
  await page.route(`${FAKE_BASE}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      calls.models += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "fake-model-v1" }] }) });
      return;
    }
    const body = request.postDataJSON();
    const messages = body.messages || [];
    const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
    let response;
    if (system.includes("Faithfully transcribe")) {
      calls.vision += 1;
      if (calls.visionMode === "network") {
        await route.abort("internetdisconnected");
        return;
      }
      if (calls.visionMode !== "success") {
        const status = calls.visionMode === "unsupported" ? 400 : calls.visionMode === "rate_limit" ? 429 : 503;
        const message = calls.visionMode === "unsupported" ? "This model does not support image input" : "fake provider failure";
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { message } }) });
        return;
      }
      const prompt = messages[1]?.content?.[0]?.text || "";
      const pageId = /pageId\s+([^\.\s]+)/.exec(prompt)?.[1] || "page-1";
      response = { pageId, text: RAW_VISION, segments: [{ text: RAW_VISION, confidence: 0.72, unsure: true }] };
    } else if (system.includes("high-quality postgraduate English sample")) {
      const payload = JSON.parse(messages[1].content);
      const mode = sampleSequence[Math.min(calls.sample, sampleSequence.length - 1)] || "pass";
      calls.sample += 1;
      response = sampleFor(payload, mode);
    } else if (system.includes("Independently assess the candidate")) {
      calls.critic += 1;
      const payload = JSON.parse(messages[1].content);
      response = criticFor(payload.promptSnapshot.taskType);
    } else if (system.includes("Score only the supplied verified essay")) {
      calls.score += 1;
      if (calls.scoreMode !== "success") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "fake score failure" } }) });
        return;
      }
      response = scoreFor(JSON.parse(messages[1].content));
    } else {
      const payload = JSON.parse(messages[1].content);
      if (payload.sampleEssaySnapshot && payload.backTranslationAttempt) {
        calls.compare += 1;
        if (calls.compareMode !== "success") {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "fake compare failure" } }) });
          return;
        }
        response = compareFor(payload);
      } else if (payload.revisionAttempt && payload.scoreReport) {
        calls.rewrite += 1;
        if (calls.rewriteMode !== "success") {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "fake rewrite failure" } }) });
          return;
        }
        response = rewriteFor(payload);
      } else {
        throw new Error(`Unknown fake Writing request: ${messages[1]?.content}`);
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { total_tokens: 0 } }),
    });
  });
  return calls;
}

async function configureFakeProviders(page, username) {
  await page.evaluate(({ user, base }) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    localStorage.setItem(`${prefix}wuliao:ai:apikey`, "e2e-text-key");
    localStorage.setItem(`${prefix}wuliao:ai:model`, "fake-text-v1");
    localStorage.setItem(`${prefix}wuliao:ai:api-config`, JSON.stringify({ version: 1, baseUrl: base }));
    localStorage.setItem(`${prefix}wuliao:writing:vision-api-key`, "e2e-vision-key");
    localStorage.setItem(`${prefix}wuliao:writing:vision-model:v1`, "fake-vision-v1");
    localStorage.setItem(`${prefix}wuliao:writing:vision-api-config:v1`, JSON.stringify({ providerKind: "openai-compatible", baseUrl: base, transportVersion: "writing-vision-openai-v1" }));
  }, { user: username, base: FAKE_BASE });
}

function attachBrowserGates(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const unhandled = [];
  const unexpectedExternal = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "e2e-writing.invalid"].includes(url.hostname)) unexpectedExternal.push(request.url());
  });
  page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      (window.__E2E_UNHANDLED__ ||= []).push(String(event.reason?.message || event.reason));
    });
  });
  return {
    async assertClean({ consoleWhitelist = [] } = {}) {
      unhandled.push(...await page.evaluate(() => window.__E2E_UNHANDLED__ || []));
      const unexpectedConsoleErrors = consoleErrors.filter((message) => !consoleWhitelist.some((pattern) => pattern.test(message)));
      expect(unexpectedConsoleErrors, `console.error: ${consoleErrors.join(" ;; ")}`).toEqual([]);
      expect(pageErrors, `pageerror: ${pageErrors.join(" ;; ")}`).toEqual([]);
      expect(unhandled, `unhandledrejection: ${unhandled.join(" ;; ")}`).toEqual([]);
      expect(unexpectedExternal, `unexpected external calls: ${unexpectedExternal.join(" ;; ")}`).toEqual([]);
    },
  };
}

async function writingRecords(page, username) {
  return page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const result = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}wuliao:writing-`)) continue;
      const shortKey = key.slice(prefix.length);
      try { result[shortKey] = JSON.parse(localStorage.getItem(key)); } catch { result[shortKey] = localStorage.getItem(key); }
    }
    return result;
  }, username);
}

async function sessionRecord(page, username) {
  const records = await writingRecords(page, username);
  const entry = Object.entries(records).find(([key]) => key.startsWith("wuliao:writing-session:v1:"));
  return entry ? entry[1] : null;
}

async function mutateSessionPointer(page, username, currentStage) {
  return page.evaluate(async ({ user, stage }) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:writing-session:v1:`;
    const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
    if (!key) throw new Error("Writing Session fixture is missing");
    const session = JSON.parse(localStorage.getItem(key));
    session.currentStage = stage;
    session.fingerprint = await window.__WULIAO_WRITING_E2E__.computeWritingFingerprint(session);
    localStorage.setItem(key, JSON.stringify(session));
    return { key, raw: localStorage.getItem(key), sessionId: session.sessionId };
  }, { user: username, stage: currentStage });
}

async function rawStorageValue(page, key) {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function expectStage(page, stage) {
  await expect(page.locator(`[aria-label="当前阶段 ${stage}"]`)).toBeVisible({ timeout: 30000 });
}

async function startQuestion(page, year, kind) {
  await navTo(page, "写作");
  await expect(page.locator(".writing-library")).toBeVisible();
  await page.getByLabel("按年份筛选写作").selectOption(String(year));
  await page.getByRole("button", { name: new RegExp(`查看 ${year} 年.*Writing ${kind}`) }).click();
  const preview = page.locator(".writing-question-preview");
  await expect(preview).toBeVisible();
  const aiButton = preview.getByRole("button", { name: /使用 AI 生成范文|用这道题开始训练/ });
  await aiButton.click();
  await expectStage(page, "W1");
}

async function completeW1ToW5(page, { compareAi = false, translation = "E2E_TRANSLATION_SECRET 中文译文", backTranslation = "Confirmed back translation for the formal comparison." } = {}) {
  await page.getByRole("button", { name: "完成范文精读" }).click();
  await expectStage(page, "W2");
  const translationArea = page.getByLabel("完整中文译文");
  await translationArea.fill(translation);
  await page.getByRole("button", { name: "提交完整中文译文" }).click();
  await expectStage(page, "W3");
  await page.locator(".writing-editor-card textarea").fill(backTranslation);
  await page.getByRole("button", { name: "准备提交完整反译" }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expectStage(page, "W4");
  if (compareAi) {
    await page.getByRole("button", { name: "开始分析" }).click();
    await expect(page.locator(".writing-diagnosis-units")).toBeVisible();
  }
  await page.getByRole("button", { name: "完成对照" }).click();
  await expectStage(page, "W5");
}

async function enterW7ThroughW6(page) {
  await page.getByLabel("骨架第 1 行内容").fill("E2E_SKELETON_SECRET: claim, evidence, conclusion");
  await page.getByRole("button", { name: "完成 → 重构练习" }).click();
  await page.getByRole("button", { name: "确认并继续" }).click();
  await expectStage(page, "W6");
  await page.locator(".writing-editor-card textarea").fill("E2E_RECON_SECRET reconstruction draft retained as formal history.");
  await page.getByRole("button", { name: "完成重构并继续" }).click();
  await expectStage(page, "W7");
}

async function enterW7BySkip(page) {
  await page.getByRole("button", { name: "跳过 → 独立作文" }).click();
  await page.getByRole("button", { name: "确认并继续" }).click();
  await expectStage(page, "W7");
}

async function submitTypedW7(page, text) {
  await page.locator(".writing-independent-editor textarea").fill(text);
  await page.getByRole("button", { name: "准备提交独立作文" }).click();
  await page.getByRole("button", { name: "确认正式提交" }).click();
  await expectStage(page, "W8");
}

async function drawStroke(page) {
  const paper = page.locator(".writing-paper");
  await paper.scrollIntoViewIfNeeded();
  const box = await paper.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + 80, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 130, { steps: 8 });
  await page.mouse.move(box.x + 260, box.y + 90, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".writing-ink-composer")).toContainText("1 笔");
}

test("Slice 10 golden A：2023 Writing A typed W1→DONE、围栏、显式 AI、复习集成", async ({ page }) => {
  const gates = attachBrowserGates(page);
  const calls = await installFakeProviders(page);
  const username = await createAccount(page, uniqueUsername("writing-a-golden"));
  await configureFakeProviders(page, username);

  await navTo(page, "写作");
  await expect(page.locator(".writing-library")).toBeVisible();
  expect(calls.sample + calls.critic + calls.compare + calls.score + calls.rewrite + calls.vision).toBe(0);
  await page.getByLabel("按年份筛选写作").selectOption("2023");
  await page.getByRole("button", { name: /查看 2023 年.*Writing A/ }).click();
  await expect(page.locator(".writing-question-preview")).toContainText("Prof. Smith");
  expect(calls.sample).toBe(0);
  await page.locator(".writing-question-preview").getByRole("button", { name: "使用 AI 生成范文" }).click();
  await expectStage(page, "W1");
  expect(calls.sample).toBe(1);
  expect(calls.critic).toBe(1);
  expect(countWords(A_ESSAY)).toBeGreaterThanOrEqual(80);

  const firstSession = await sessionRecord(page, username);
  expect(firstSession.year).toBe(2023);
  expect(firstSession.taskType).toBe("postgrad-en1-writing-a");
  expect(firstSession.promptSnapshot.questionId).toBe("postgrad-en1-2023-writing-a");
  expect(firstSession.promptSnapshot.fingerprint).toBe("a971ce00912e128674b4a00866d379257702dbc7a248aa2198d1a5f339c70bb0");

  const unknown = page.getByRole("button", { name: /标记陌生词 Professor/i }).first();
  await unknown.click();
  await completeW1ToW5(page, { compareAi: true, backTranslation: "Confirmed back translation with E2E_DIAG_SECRET context kept only in its formal source." });
  expect(calls.compare).toBe(1);
  await enterW7ThroughW6(page);

  const w7Text = await page.locator("body").innerText();
  for (const secret of FORBIDDEN_W7) expect(w7Text).not.toContain(secret);
  expect(w7Text).toContain("Prof. Smith");
  await page.addInitScript((secrets) => {
    window.__E2E_FENCE_SEEN__ = [];
    const scan = () => {
      const text = document.body?.textContent || "";
      for (const secret of secrets) if (text.includes(secret) && !window.__E2E_FENCE_SEEN__.includes(secret)) window.__E2E_FENCE_SEEN__.push(secret);
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  }, FORBIDDEN_W7);
  await page.reload();
  await expectStage(page, "W7");
  expect(await page.evaluate(() => window.__E2E_FENCE_SEEN__ || [])).toEqual([]);
  const refreshedText = await page.locator("body").innerText();
  for (const secret of FORBIDDEN_W7) expect(refreshedText).not.toContain(secret);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 360, height: 800 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    const geometry = await page.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth,
        debug: [".ds-shell", ".ds-main", ".ds-content", ".writing-workspace-frame", ".writing-stage", ".writing-progress"].map((selector) => {
          const element = document.querySelector(selector);
          const rect = element?.getBoundingClientRect();
          return { selector, rect: rect ? { left: rect.left, right: rect.right, width: rect.width } : null, clientWidth: element?.clientWidth, scrollWidth: element?.scrollWidth, minWidth: element ? getComputedStyle(element).minWidth : null, overflowX: element ? getComputedStyle(element).overflowX : null };
        }),
        offenders: [...document.querySelectorAll("body *")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName, className: element.className?.toString?.() || "", text: element.textContent?.trim().slice(0, 60) || "", left: rect.left, right: rect.right, width: rect.width };
        }).filter((item) => item.right > clientWidth + 1 || item.left < -1).slice(0, 12),
      };
    });
    expect(geometry.scrollWidth, JSON.stringify({ debug: geometry.debug, offenders: geometry.offenders }, null, 2)).toBeLessThanOrEqual(geometry.clientWidth + 1);
    const bodyText = await page.locator("body").innerText();
    for (const secret of FORBIDDEN_W7) expect(bodyText).not.toContain(secret);
  }

  const independent = "My independent typed essay answers the real recruitment notice with duties, requirements, contact details, and a clear deadline.";
  await submitTypedW7(page, independent);
  expect(calls.score).toBe(0);
  const rewriteButton = page.getByRole("button", { name: "先提交二稿" });
  await expect(rewriteButton).toBeDisabled();
  expect(calls.rewrite).toBe(0);
  await page.getByRole("button", { name: "获取 AI 评分" }).evaluate((button) => { button.click(); button.click(); });
  await expect(page.locator(".writing-score-report")).toContainText("9");
  expect(calls.score).toBe(1);
  const revision = "My revised typed essay keeps the user's response separate from the AI reference rewrite.";
  await page.locator(".writing-revision-section textarea").fill(revision);
  await page.getByRole("button", { name: "提交我的二稿" }).click();
  await expect(page.locator(".writing-revision-section textarea")).toHaveValue(revision);
  await page.getByRole("button", { name: "生成参考改写" }).evaluate((button) => { button.click(); button.click(); });
  await expect(page.locator(".writing-rewrite-result")).toBeVisible();
  expect(calls.rewrite).toBe(1);
  await expect(page.locator(".writing-revision-section textarea")).toHaveValue(revision);
  await page.getByRole("button", { name: "完成本次训练" }).click();
  await expectStage(page, "DONE");
  await expect(page.getByRole("heading", { name: "本次写作已完成" })).toBeVisible();

  const session = await sessionRecord(page, username);
  expect(session.status).toBe("COMPLETED");
  const scheduled = await page.evaluate(async (sessionId) => window.__WULIAO_WRITING_E2E__.integration.ensureWritingReviewTasksForCompletedSession({ sessionId }), session.sessionId);
  expect(scheduled.tasks.map((item) => item.reviewType).sort()).toEqual(["D1", "D3", "D7"]);
  const repeated = await page.evaluate(async (sessionId) => window.__WULIAO_WRITING_E2E__.integration.ensureWritingReviewTasksForCompletedSession({ sessionId }), session.sessionId);
  expect(repeated.tasks).toHaveLength(3);
  expect(repeated.createdCount).toBe(0);

  const records = await writingRecords(page, username);
  expect(Object.keys(records).filter((key) => key.startsWith("wuliao:writing-review-task:v1:"))).toHaveLength(3);
  expect(Object.values(records).some((record) => record?.verifiedText?.text === independent)).toBe(true);
  expect(Object.values(records).some((record) => record?.verifiedText?.text === revision)).toBe(true);
  await gates.assertClean();
});

test("Slice 10 golden B：2001 visual asset、W5 skip、W7 handwriting fake Vision→W8→DONE", async ({ page }) => {
  const gates = attachBrowserGates(page);
  const calls = await installFakeProviders(page);
  const username = await createAccount(page, uniqueUsername("writing-b-golden"));
  await configureFakeProviders(page, username);
  await navTo(page, "写作");
  await page.getByLabel("按年份筛选写作").selectOption("2001");
  await page.getByRole("button", { name: /查看 2001 年.*Writing B/ }).click();
  const image = page.locator(".writing-question-preview img");
  await expect(image).toBeVisible();
  const asset = await image.evaluate((element) => ({ src: element.getAttribute("src"), complete: element.complete, width: element.naturalWidth, height: element.naturalHeight }));
  expect(asset.src).toBe("/writing/questions/2001/postgrad-en1-2001-writing-b/prompt.png");
  expect(asset.complete).toBe(true);
  expect(asset.width).toBeGreaterThan(0);
  expect(asset.height).toBeGreaterThan(0);
  expect(asset.src).not.toMatch(/^data:|^https?:/);
  await page.locator(".writing-question-preview").getByRole("button", { name: "用这道题开始训练" }).click();
  await expectStage(page, "W1");
  await completeW1ToW5(page, { translation: "视觉题的中文译文", backTranslation: "A back translation for the 2001 visual prompt." });
  await enterW7BySkip(page);
  expect(calls.vision).toBe(0);
  await page.getByRole("button", { name: "手写", exact: true }).click();
  await drawStroke(page);
  await page.setViewportSize({ width: 800, height: 1280 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".writing-ink-composer")).toContainText("1 笔");
  await page.getByRole("button", { name: "识别手写作文" }).click();
  await expect(page.getByRole("heading", { name: "AI 转写草稿" })).toBeVisible();
  await expectStage(page, "W7");
  expect(calls.vision).toBe(1);
  const verifyArea = page.locator(".writing-verification textarea");
  await expect(verifyArea).toHaveValue(RAW_VISION);
  await verifyArea.fill(VERIFIED_VISION);
  await page.getByRole("button", { name: "确认文字并提交" }).click();
  await expectStage(page, "W8");
  await page.getByRole("button", { name: "获取 AI 评分" }).click();
  await expect(page.locator(".writing-score-report")).toContainText("18");
  await page.getByRole("button", { name: "完成本次训练" }).click();
  await expectStage(page, "DONE");

  const session = await sessionRecord(page, username);
  expect(session.promptSnapshot.questionId).toBe("postgrad-en1-2001-writing-b");
  expect(session.promptSnapshot.assets[0].assetId).toBe("postgrad-en1-2001-writing-b-prompt");
  const records = Object.values(await writingRecords(page, username));
  const transcription = records.find((record) => record?.rawTranscript === RAW_VISION);
  const attempt = records.find((record) => record?.verifiedText?.text === VERIFIED_VISION);
  const score = records.find((record) => record?.sourceAttemptId === attempt?.attemptId && Number.isFinite(record?.finalScore));
  expect(transcription).toBeTruthy();
  expect(attempt.status).toBe("submitted");
  expect(attempt.verifiedText.source).toBe("transcription");
  expect(attempt.verifiedText.sourceTranscriptionId).toBe(transcription.transcriptionId);
  expect(attempt.inkRef).toBeTruthy();
  expect(score).toBeTruthy();
  expect(JSON.stringify(score)).not.toContain(RAW_VISION);
  expect(JSON.stringify(score)).not.toContain("strokes");
  expect(JSON.stringify(score)).not.toContain("confidence");
  await gates.assertClean();
});

test("Slice 10 focused W3：handwriting fake Vision 不自动推进，编辑确认后仅 VerifiedText 进入 W4", async ({ page }) => {
  const gates = attachBrowserGates(page);
  const calls = await installFakeProviders(page);
  const username = await createAccount(page, uniqueUsername("writing-w3-vision"));
  await configureFakeProviders(page, username);
  await startQuestion(page, 2022, "A");
  await page.getByRole("button", { name: "完成范文精读" }).click();
  await expectStage(page, "W2");
  await page.getByLabel("完整中文译文").fill("只允许这份冻结译文出现在 W3");
  await page.getByRole("button", { name: "提交完整中文译文" }).click();
  await expectStage(page, "W3");
  const w3Body = await page.locator("body").innerText();
  expect(w3Body).not.toContain(A_ESSAY);
  expect(w3Body).not.toContain("AI 对照分析");
  await page.getByRole("button", { name: "手写", exact: true }).click();
  await drawStroke(page);
  await page.getByRole("button", { name: "识别手写内容" }).click();
  await expect(page.getByRole("heading", { name: "AI 识别结果" })).toBeVisible();
  await expectStage(page, "W3");
  const verifyingRecords = Object.values(await writingRecords(page, username));
  expect(verifyingRecords.some((record) => record?.status === "verifying" && record?.transcriptionId)).toBe(true);
  await page.locator(".writing-verification textarea").fill(VERIFIED_VISION);
  await page.getByRole("button", { name: "确认文字并提交" }).click();
  await expectStage(page, "W4");
  const records = Object.values(await writingRecords(page, username));
  const attempt = records.find((record) => record?.verifiedText?.text === VERIFIED_VISION);
  expect(attempt.verifiedText.source).toBe("transcription");
  expect(attempt.typedText).not.toBe(RAW_VISION);
  expect(calls.vision).toBe(1);
  await gates.assertClean();
});

test("Slice 10 failure paths：Vision unsupported/network manual fallback、Compare nonblocking、Score/Rewrite retry", async ({ page }) => {
  const gates = attachBrowserGates(page);
  const calls = await installFakeProviders(page, { vision: "unsupported" });
  const username = await createAccount(page, uniqueUsername("writing-failures"));
  await configureFakeProviders(page, username);
  await startQuestion(page, 2020, "A");
  await page.getByRole("button", { name: "完成范文精读" }).click();
  await expectStage(page, "W2");
  await page.getByLabel("完整中文译文").fill("失败路径的冻结中文译文");
  await page.getByRole("button", { name: "提交完整中文译文" }).click();
  await expectStage(page, "W3");
  await page.getByRole("button", { name: "手写", exact: true }).click();
  await drawStroke(page);
  await page.getByRole("button", { name: "识别手写内容" }).click();
  await expect(page.getByRole("alert")).toContainText("不支持");
  await expectStage(page, "W3");
  await page.locator(".writing-ai-action-row").getByRole("button", { name: "手动录入" }).click();
  await expect(page.getByRole("heading", { name: "手动录入" })).toBeVisible();
  await page.locator(".writing-verification textarea").fill("Manual back translation after unsupported Vision.");
  await page.getByRole("button", { name: "确认文字并提交" }).click();
  await expectStage(page, "W4");

  calls.compareMode = "failure";
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByRole("alert")).toContainText("操作未完成");
  await expect(page.locator(".writing-base-compare")).toBeVisible();
  await expect(page.getByRole("button", { name: "完成对照" })).toBeEnabled();
  await page.getByRole("button", { name: "完成对照" }).click();
  await expectStage(page, "W5");
  await enterW7BySkip(page);

  calls.visionMode = "network";
  await page.getByRole("button", { name: "手写", exact: true }).click();
  await drawStroke(page);
  await page.getByRole("button", { name: "识别手写作文" }).click();
  await expect(page.getByRole("alert")).toContainText("网络");
  await expectStage(page, "W7");
  await page.locator(".writing-ai-action-row").getByRole("button", { name: "手动录入" }).click();
  const manualEssay = "Manual independent essay retained after a fake network failure and explicitly confirmed by the user.";
  await page.locator(".writing-verification textarea").fill(manualEssay);
  await page.getByRole("button", { name: "确认文字并提交" }).click();
  await expectStage(page, "W8");

  calls.scoreMode = "failure";
  await page.getByRole("button", { name: "获取 AI 评分" }).click();
  await expect(page.getByRole("alert")).toContainText("操作未完成");
  await expect(page.locator(".writing-score-report")).toHaveCount(0);
  await expect(page.locator(".writing-original-submission")).toContainText(manualEssay);
  expect((await page.locator("body").innerText()).includes("0 / 10")).toBe(false);
  calls.scoreMode = "success";
  await page.getByRole("button", { name: "获取 AI 评分" }).click();
  await expect(page.locator(".writing-score-report")).toContainText("9");

  const revision = "The user's revision remains unchanged across a failed reference rewrite request.";
  await page.locator(".writing-revision-section textarea").fill(revision);
  await page.getByRole("button", { name: "提交我的二稿" }).click();
  calls.rewriteMode = "failure";
  await page.getByRole("button", { name: "生成参考改写" }).click();
  await expect(page.getByRole("alert")).toContainText("操作未完成");
  await expect(page.locator(".writing-rewrite-result")).toHaveCount(0);
  await expect(page.locator(".writing-revision-section textarea")).toHaveValue(revision);
  calls.rewriteMode = "success";
  await page.getByRole("button", { name: "生成参考改写" }).click();
  await expect(page.locator(".writing-rewrite-result")).toBeVisible();
  await expect(page.locator(".writing-revision-section textarea")).toHaveValue(revision);

  const records = Object.values(await writingRecords(page, username));
  const manualAttempts = records.filter((record) => record?.verifiedText?.source === "manual_entry");
  expect(manualAttempts).toHaveLength(2);
  expect(manualAttempts.every((record) => record.inkRef)).toBe(true);
  expect(calls.vision).toBe(2);
  expect(calls.compare).toBe(1);
  expect(calls.score).toBe(2);
  expect(calls.rewrite).toBe(2);
  await gates.assertClean({ consoleWhitelist: [/^Failed to load resource:/] });
});

test("Slice 10 recovery browser gate：pointer ahead、facts ahead、damaged fail-closed 且 load 零写入", async ({ browser }) => {
  const contextPointer = await browser.newContext();
  const pointerPage = await contextPointer.newPage();
  await installFakeProviders(pointerPage);
  const pointerUser = await createAccount(pointerPage, uniqueUsername("writing-pointer-ahead"));
  await configureFakeProviders(pointerPage, pointerUser);
  await startQuestion(pointerPage, 2019, "A");
  await completeW1ToW5(pointerPage);
  const pointerFixture = await mutateSessionPointer(pointerPage, pointerUser, "W7_INDEPENDENT");
  await pointerPage.reload();
  await expectStage(pointerPage, "W5");
  expect(await rawStorageValue(pointerPage, pointerFixture.key)).toBe(pointerFixture.raw);
  const pointerPersisted = await sessionRecord(pointerPage, pointerUser);
  expect(pointerPersisted.currentStage).toBe("W7_INDEPENDENT");
  await pointerPage.evaluate(() => localStorage.setItem("kaoyan_vocab_current_user", "e2e-account-bob"));
  await pointerPage.reload();
  await expect(pointerPage.getByRole("heading", { name: "为现有账号设置密码" })).toBeVisible();
  await expect(pointerPage.locator("[aria-label^='当前阶段']")).toHaveCount(0);
  expect(await pointerPage.locator("body").innerText()).not.toContain(pointerPersisted.promptSnapshot.promptText);
  await contextPointer.close();

  const contextFacts = await browser.newContext();
  const factsPage = await contextFacts.newPage();
  await installFakeProviders(factsPage);
  const factsUser = await createAccount(factsPage, uniqueUsername("writing-facts-ahead"));
  await configureFakeProviders(factsPage, factsUser);
  await startQuestion(factsPage, 2018, "A");
  await completeW1ToW5(factsPage);
  await enterW7BySkip(factsPage);
  await submitTypedW7(factsPage, "Facts ahead independent response with explicit verified text for recovery.");
  const factsFixture = await mutateSessionPointer(factsPage, factsUser, "W5_SKELETON");
  await factsPage.reload();
  await expectStage(factsPage, "W8");
  expect(await rawStorageValue(factsPage, factsFixture.key)).toBe(factsFixture.raw);

  await factsPage.evaluate((key) => {
    const session = JSON.parse(localStorage.getItem(key));
    session.fingerprint = "0".repeat(64);
    localStorage.setItem(key, JSON.stringify(session));
  }, factsFixture.key);
  const damagedRaw = await rawStorageValue(factsPage, factsFixture.key);
  await factsPage.reload();
  await expect(factsPage.getByRole("heading", { name: "写作记录需要修复" })).toBeVisible();
  await expect(factsPage.locator("[aria-label^='当前阶段']")).toHaveCount(0);
  expect(await rawStorageValue(factsPage, factsFixture.key)).toBe(damagedRaw);
  await contextFacts.close();
});

test("Slice 10 Sample Gate：首候选失败后仅第二候选入 Session；三次失败不建 Session", async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const callsA = await installFakeProviders(pageA, { sampleSequence: ["fail", "pass"] });
  const userA = await createAccount(pageA, uniqueUsername("writing-sample-retry"));
  await configureFakeProviders(pageA, userA);
  await startQuestion(pageA, 2023, "A");
  expect(callsA.sample).toBe(2);
  expect(callsA.critic).toBe(1);
  const recordsA = await writingRecords(pageA, userA);
  expect(Object.keys(recordsA).filter((key) => key.startsWith("wuliao:writing-session:v1:"))).toHaveLength(1);
  expect(JSON.stringify(recordsA)).not.toContain("too short");
  await contextA.close();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const callsB = await installFakeProviders(pageB, { sampleSequence: ["fail", "fail", "fail"] });
  const userB = await createAccount(pageB, uniqueUsername("writing-sample-fail"));
  await configureFakeProviders(pageB, userB);
  await navTo(pageB, "写作");
  await pageB.getByLabel("按年份筛选写作").selectOption("2023");
  await pageB.getByRole("button", { name: /查看 2023 年.*Writing A/ }).click();
  await pageB.locator(".writing-question-preview").getByRole("button", { name: "使用 AI 生成范文" }).click();
  await expect(pageB.getByRole("alert")).toContainText("训练尚未创建");
  expect(callsB.sample).toBe(3);
  expect(callsB.critic).toBe(0);
  const recordsB = await writingRecords(pageB, userB);
  expect(Object.keys(recordsB).filter((key) => key.startsWith("wuliao:writing-session:v1:"))).toHaveLength(0);
  await expect(pageB.locator(".writing-question-preview")).toBeVisible();
  await expect(pageB.getByRole("button", { name: "重试" })).toBeVisible();
  await contextB.close();
});

test("Slice 10 question bank：2001–2023 coverage 与全部 bundled visual assets 可加载解码", async ({ page, request }) => {
  const years = [...new Set(GENERATED_WRITING_QUESTIONS.map((item) => item.year))].sort((a, b) => a - b);
  expect(years).toEqual(Array.from({ length: 23 }, (_, index) => 2001 + index));
  expect(GENERATED_WRITING_QUESTIONS).toHaveLength(42);
  const assets = GENERATED_WRITING_QUESTIONS.flatMap((question) => question.assets.map((asset) => ({ ...asset, questionId: question.questionId })));
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    expect(asset.src).not.toMatch(/^data:|^https?:/);
    const response = await request.get(asset.src);
    expect(response.ok(), `${asset.questionId} ${asset.src}`).toBe(true);
  }
  await page.goto("/");
  const decoded = await page.evaluate(async (sources) => Promise.all(sources.map((src) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ src, ok: true, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ src, ok: false, width: 0, height: 0 });
    image.src = src;
  }))), assets.map((asset) => asset.src));
  expect(decoded.every((item) => item.ok && item.width > 0 && item.height > 0)).toBe(true);
});

test("Bundled sample clean profile：无 pending seed / 空 private store 仍可离线开始", async ({ page }) => {
  await createAccount(page, uniqueUsername("writing-private-clean"));
  await navTo(page, "写作");
  await page.getByLabel("按年份筛选写作").selectOption("2023");
  await page.getByRole("button", { name: /查看 2023 年.*Writing A/ }).click();
  const preview = page.locator(".writing-question-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("button", { name: "使用设备私有参考范文" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "使用随应用范文" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "使用 AI 生成范文" })).toBeVisible();
  const privateCount = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("device-private-writing-samples", "readonly")
          .objectStore("device-private-writing-samples").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
  expect(privateCount).toBe(0);
  const catalog = await page.evaluate(() => window.__WULIAO_WRITING_E2E__.privateSamples.getCatalogMetadata());
  expect(catalog.activeQuestionIds).toHaveLength(34);
  expect(catalog.contentHash).toMatch(/^[0-9a-f]{64}$/);
  const externalRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5199") externalRequests.push(request.url());
  });
  await preview.getByRole("button", { name: "使用随应用范文" }).click();
  await expectStage(page, "W1");
  expect(externalRequests).toEqual([]);
});

test("W2 tablet workspace：双模式、顶部提交、共享中线、独立滚动与 Reader toolbar", async ({ page }) => {
  const gates = attachBrowserGates(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await installFakeProviders(page);
  const username = await createAccount(page, uniqueUsername("writing-w2-layout"));
  await configureFakeProviders(page, username);
  await startQuestion(page, 2023, "A");
  await page.getByRole("button", { name: "完成范文精读" }).click();
  await expectStage(page, "W2");

  await expect(page.getByRole("button", { name: "混合输入", exact: true })).toHaveCount(0);
  await expect(page.locator(".writing-stage-header")).toHaveCount(0);
  await expect(page.locator(".writing-compact-toolbar")).not.toContainText("左侧阅读完整英文范文");
  await expect(page.locator(".writing-split-pane > header p")).toHaveCount(0);
  await expect(page.locator(".writing-compact-toolbar").getByRole("button", { name: "提交完整中文译文" })).toBeVisible();
  const translation = "键盘草稿在两种输入模式之间保持不变。";
  await page.getByLabel("完整中文译文").fill(translation);

  async function readLayout() {
    return page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height } : null;
      };
      const sourceScroll = document.querySelector(".writing-split-source > .writing-split-scroll");
      const workScroll = document.querySelector(".writing-split-work > .writing-split-scroll");
      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        stage: rect(".writing-stage-w2"),
        compactToolbar: rect(".writing-compact-toolbar"),
        progress: rect(".writing-progress"),
        workspace: rect(".writing-split-workspace"),
        sourceHeader: rect(".writing-split-source > header"),
        workHeader: rect(".writing-split-work > header"),
        sourceScroll: rect(".writing-split-source > .writing-split-scroll"),
        workScroll: rect(".writing-split-work > .writing-split-scroll"),
        action: rect(".writing-stage-header-actions"),
        counter: rect(".writing-stage-counter"),
        sourceOverflowY: getComputedStyle(sourceScroll).overflowY,
        workOverflowY: getComputedStyle(workScroll).overflowY,
      };
    });
  }

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1536, height: 1024 }, { width: 832, height: 544 }]) {
    await page.setViewportSize(viewport);
    const layout = await readLayout();
    expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.stage.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.compactToolbar.height).toBeLessThanOrEqual(56);
    expect(layout.progress).toBeNull();
    expect(Math.abs(layout.sourceHeader.right - layout.workHeader.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.sourceScroll.right - layout.workScroll.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.sourceHeader.bottom - layout.sourceScroll.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.workHeader.bottom - layout.workScroll.top)).toBeLessThanOrEqual(1);
    expect(layout.sourceOverflowY).toBe("auto");
    expect(layout.workOverflowY).toBe("auto");
    expect(layout.action.height).toBeLessThanOrEqual(44);
    expect(layout.counter).toBeNull();
    expect(layout.action.right).toBeLessThanOrEqual(layout.stage.right);
  }
  await expect(page.locator(".writing-stage > footer")).toHaveCount(0);
  await page.getByRole("button", { name: "手写", exact: true }).click();
  const toolbar = page.getByLabel("批注工具");
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".writing-compact-toolbar-center").getByLabel("批注工具")).toBeVisible();
  await expect(page.locator(".writing-split-scroll").getByLabel("批注工具")).toHaveCount(0);
  expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(44);
  await expect(toolbar.getByRole("button", { name: "笔", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "橡皮", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "撤销", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "清空笔迹", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "陌生词", exact: true })).toHaveCount(0);
  await expect(toolbar.locator(".color-picker button")).toHaveCount(3);
  const toolbarColors = await toolbar.evaluate((element) => {
    const textButtons = [...element.querySelectorAll(":scope > button")];
    return {
      background: getComputedStyle(element).backgroundColor,
      inactiveForegrounds: textButtons.filter((button) => !button.classList.contains("active")).map((button) => getComputedStyle(button).color),
      activeStyles: textButtons.filter((button) => button.classList.contains("active")).map((button) => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor })),
    };
  });
  expect(toolbarColors.background).toBe("rgb(251, 250, 246)");
  expect(new Set(toolbarColors.inactiveForegrounds)).toEqual(new Set(["rgb(8, 43, 58)"]));
  // Existing study-approved-a.css gives selected tools a teal fill and contrasting white label.
  expect(toolbarColors.activeStyles).toEqual([{ color: "rgb(255, 255, 255)", background: "rgb(23, 111, 121)" }]);
  const compactChrome = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom } : null;
    };
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      left: rect(".writing-compact-toolbar-left"),
      center: rect(".writing-compact-toolbar-center"),
      right: rect(".writing-compact-toolbar-right"),
    };
  });
  expect(compactChrome.scrollWidth).toBeLessThanOrEqual(compactChrome.viewportWidth + 1);
  expect(compactChrome.left.right).toBeLessThanOrEqual(compactChrome.center.left + 1);
  expect(compactChrome.center.right).toBeLessThanOrEqual(compactChrome.right.left + 1);
  expect(Math.max(compactChrome.left.top, compactChrome.center.top, compactChrome.right.top))
    .toBeLessThan(Math.min(compactChrome.left.bottom, compactChrome.center.bottom, compactChrome.right.bottom));
  const size = toolbar.getByRole("slider", { name: "画笔粗细" });
  await size.focus();
  await size.press("End");
  await expect(size).toHaveAttribute("aria-valuenow", "10");
  await drawStroke(page);
  const inkGeometry = await page.evaluate(() => {
    const paper = document.querySelector(".writing-paper");
    const paperStyle = getComputedStyle(paper);
    const source = document.querySelector(".writing-split-source > .writing-split-scroll");
    const work = document.querySelector(".writing-split-work > .writing-split-scroll");
    const sourceContent = source.firstElementChild;
    const sourceStyle = getComputedStyle(source);
    const sourcePadding = (Number.parseFloat(sourceStyle.paddingTop) || 0) + (Number.parseFloat(sourceStyle.paddingBottom) || 0);
    const sourceContentHeight = Math.max(sourceContent.scrollHeight, sourceContent.getBoundingClientRect().height) + sourcePadding;
    return {
      paperHeight: paper.getBoundingClientRect().height,
      paperBackgroundColor: paperStyle.backgroundColor,
      paperBackgroundImage: paperStyle.backgroundImage,
      sourceContentHeight,
      workViewportHeight: work.clientHeight,
    };
  });
  expect(inkGeometry.paperBackgroundColor).toBe("rgb(255, 254, 250)");
  expect(inkGeometry.paperBackgroundImage).toContain("repeating-linear-gradient");
  expect(inkGeometry.paperBackgroundImage).not.toContain("90deg");
  expect(inkGeometry.paperHeight).toBeLessThanOrEqual(Math.max(inkGeometry.sourceContentHeight * 2, inkGeometry.workViewportHeight) + 1);
  expect(inkGeometry.paperHeight).toBeGreaterThanOrEqual(inkGeometry.workViewportHeight - 1);
  const workScroll = page.locator(".writing-split-work > .writing-split-scroll");
  await expect(page.locator(".writing-ink-surface")).toHaveCSS("touch-action", "pan-y");
  await expect(page.locator(".writing-ink-content")).toHaveCSS("touch-action", "pan-y");
  const scrollRange = await workScroll.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(scrollRange).toBeGreaterThan(0);
  await workScroll.evaluate((element) => { element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight); });
  await expect.poll(() => workScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const [scrolledToolbarBox, compactToolbarBox] = await Promise.all([toolbar.boundingBox(), page.locator(".writing-compact-toolbar").boundingBox()]);
  expect(scrolledToolbarBox.y).toBeGreaterThanOrEqual(compactToolbarBox.y);
  expect(scrolledToolbarBox.y + scrolledToolbarBox.height).toBeLessThanOrEqual(compactToolbarBox.y + compactToolbarBox.height + 1);

  const splitWorkspace = page.locator(".writing-split-workspace");
  const sourceBefore = await page.locator(".writing-split-source > .writing-split-scroll").boundingBox();
  const verticalDivider = page.locator(".writing-split-divider");
  await expect(verticalDivider).toHaveCSS("touch-action", "pan-y");
  const verticalBox = await verticalDivider.boundingBox();
  await page.mouse.move(verticalBox.x + verticalBox.width / 2, verticalBox.y + verticalBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(380);
  await page.mouse.move(verticalBox.x + verticalBox.width / 2 + 100, verticalBox.y + verticalBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const sourceAfter = await page.locator(".writing-split-source > .writing-split-scroll").boundingBox();
  expect(sourceAfter.width).toBeGreaterThan(sourceBefore.width + 50);
  await expect(page.locator(".writing-ink-composer")).toContainText("1 笔");

  await page.getByRole("button", { name: "切换双区布局" }).click();
  await expect(splitWorkspace).toHaveAttribute("data-writing-layout", "stacked");
  await expect(verticalDivider).toHaveCSS("touch-action", "pan-x");
  const topBefore = await page.locator(".writing-split-source > .writing-split-scroll").boundingBox();
  const horizontalBox = await verticalDivider.boundingBox();
  await page.mouse.move(horizontalBox.x + horizontalBox.width / 2, horizontalBox.y + horizontalBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(380);
  await page.mouse.move(horizontalBox.x + horizontalBox.width / 2, horizontalBox.y + horizontalBox.height / 2 + 70, { steps: 5 });
  await page.mouse.up();
  const topAfter = await page.locator(".writing-split-source > .writing-split-scroll").boundingBox();
  expect(topAfter.height).toBeGreaterThan(topBefore.height + 30);
  await expect(page.locator(".writing-ink-composer")).toContainText("1 笔");

  await page.locator(".writing-compact-toolbar .back-button").click();
  await expect(page.locator(".writing-library")).toBeVisible();
  await page.locator(".writing-library-card button").first().click();
  await expectStage(page, "W2");
  await expect(page.getByLabel("批注工具")).toBeVisible();
  await expect(page.locator(".writing-ink-composer")).toContainText("1 笔");
  await page.getByRole("button", { name: "键盘输入", exact: true }).click();
  await expect(page.getByLabel("完整中文译文")).toHaveValue(translation);
  await expect(page.getByLabel("批注工具")).toHaveCount(0);
  await gates.assertClean();
});

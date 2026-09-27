import { test, expect } from "@playwright/test";
import {
  createAccount,
  clickClozeAction,
  openOfficialCloze,
  setScopedJson,
  expectNoConsoleErrors,
} from "./helpers.js";

// Flow 12：R6 完形学习结果与长期档案升级。
// 1) 完成全文回读 → 自动出现本篇学习结果 → 关闭后回资料库，卡片仍已完成
// 2) 旧 completed 记录可从资料卡打开"学习结果"，零 backfill
// 3) 长期档案：7d/30d/all、状态、年份筛选；official / answerless 语义；优先复盘
// 4) D+1 due 从结果页直接进入现有复习会话；完成后 D+7 future 不提前开始
// 5) AI history 确定性关联：第 2 空显示"AI 当时的推测"，点击打开现有
//    AiFloatWindow，无网络请求，关闭后仍在结果页
//
// 注意：官方完形正文经 normalizeCloze 后不保留 id，应用实际使用的
// clozeId 恒等于 resourceId（与 R5 E2E seed 一致）。

const OFFICIAL_2020 = "postgraduate-2020-cloze";
const OFFICIAL_2009 = "postgraduate-2009-cloze";

function localDateKeyAt(daysAgo) {
  const now = new Date();
  now.setDate(now.getDate() - daysAgo);
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function stageCompleted(now) {
  return { status: "completed", completedAt: now };
}

function seedCompletedFlow(page, username, resourceId, now) {
  const clozeId = resourceId;
  return setScopedJson(page, username, `wuliao:cloze-flow:${resourceId}:${clozeId}`, {
    schemaVersion: 1,
    resourceId,
    clozeId,
    stages: {
      "cloze-cover": stageCompleted(now),
      "cloze-first-attempt": stageCompleted(now),
      "cloze-self-review": stageCompleted(now),
      "cloze-correction": stageCompleted(now),
      "cloze-analysis": stageCompleted(now),
      "cloze-final-read": stageCompleted(now),
    },
    currentStage: "cloze-final-read",
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });
}

function seedFinalReadCurrentFlow(page, username, resourceId, now) {
  const clozeId = resourceId;
  return setScopedJson(page, username, `wuliao:cloze-flow:${resourceId}:${clozeId}`, {
    schemaVersion: 1,
    resourceId,
    clozeId,
    stages: {
      "cloze-cover": stageCompleted(now),
      "cloze-first-attempt": stageCompleted(now),
      "cloze-self-review": stageCompleted(now),
      "cloze-correction": stageCompleted(now),
      "cloze-analysis": stageCompleted(now),
      "cloze-final-read": { status: "current", completedAt: null },
    },
    currentStage: "cloze-final-read",
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });
}

// blank1 正确；blank2 高置信错误；blank3 自查纠正（first 错 → review 对官方答案 D）
function seedProgress2020(page, username, now) {
  const attempt = (number, first, review, firstConf, reviewConf, extra = {}) => ({
    blankId: `blank-${number}`,
    number,
    firstAnswer: first,
    reviewAnswer: review,
    firstConfidence: firstConf,
    reviewConfidence: reviewConf,
    confidence: firstConf,
    prediction: "",
    basisTypes: [],
    references: [],
    corrected: true,
    analyzed: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return setScopedJson(page, username, `wuliao:cloze-progress:${OFFICIAL_2020}:${OFFICIAL_2020}`, {
    schemaVersion: 2,
    resourceId: OFFICIAL_2020,
    clozeId: OFFICIAL_2020,
    attempts: {
      1: attempt(1, "B", "B", "confident", "confident"),
      2: attempt(2, "C", "C", "confident", "confident"),
      3: attempt(3, "C", "D", "uncertain", "confident"),
    },
    activeBlank: 1,
    firstSubmitted: true,
    reviewSubmitted: true,
    updatedAt: now,
  });
}

function seedD1Task(page, username, { sourceDate, dueDate, blankIds = [2], reasons = { 2: ["high-confidence-wrong"] } }) {
  const resourceId = OFFICIAL_2020;
  const clozeId = OFFICIAL_2020;
  const taskKey = `cloze-review:d1:${resourceId}:${clozeId}:${sourceDate}`;
  return setScopedJson(page, username, `wuliao:cloze-review-task:${taskKey}`, {
    schemaVersion: 1,
    taskKey,
    type: "d1",
    resourceId,
    clozeId,
    sourceDate,
    dueDate,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    currentIndex: 0,
    targetBlankIds: blankIds,
    targetReasons: reasons,
    attempts: {},
    updatedAt: Date.now(),
  });
}

async function countReviewTaskKeys(page) {
  return page.evaluate(() => {
    let count = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      if (localStorage.key(index).includes("cloze-review-task")) count += 1;
    }
    return count;
  });
}

async function openClozeArchive(page) {
  const link = page.locator(".today-support-link", { hasText: "学习档案" });
  await expect(link).toBeVisible({ timeout: 20000 });
  await link.click();
  const hub = page.locator(".archive-hub");
  await expect(hub).toBeVisible({ timeout: 10000 });
  await hub.locator("button", { hasText: "完形档案" }).click();
  await expect(page.locator(".cloze-archive-modal")).toBeVisible({ timeout: 10000 });
}

async function openSummaryFromArchive(page, titleText) {
  const row = page.locator(".cloze-archive-row", { hasText: titleText }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.locator(".cloze-archive-summary-button").click();
  await expect(page.locator(".cloze-summary-panel")).toBeVisible({ timeout: 10000 });
}

test("R6-1 完成全文回读 → 自动出现本篇学习结果 → 关闭后回资料库且卡片仍已完成", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const username = await createAccount(page);
  const now = Date.now();
  await seedFinalReadCurrentFlow(page, username, OFFICIAL_2020, now);
  await seedProgress2020(page, username, now);

  await openOfficialCloze(page, "2020 英语（一）完形填空");
  await expect(page.locator(".cloze-final-banner")).toBeVisible({ timeout: 30000 });
  await clickClozeAction(page, "完成全文回读");

  // 自动出现本篇学习结果
  const summary = page.locator(".cloze-summary-panel");
  await expect(summary).toBeVisible({ timeout: 15000 });
  await expect(summary).toContainText("本篇学习结果");
  await expect(summary).toContainText("2020 英语（一）完形填空");
  await expect(summary).toContainText("训练状态：已完成");
  await expect(summary).toContainText("最终正确");
  await expect(summary).toContainText("高置信错误");
  await expect(summary).toContainText("自查纠正");

  // 关闭结果 → 回到完形资料库
  await page.locator(".cloze-summary-header .icon-button").click();
  await expect(page.locator(".library-page")).toBeVisible({ timeout: 10000 });
  const card = page.locator(".cloze-resource-card", { hasText: "2020 英语（一）完形填空" }).first();
  await expect(card.locator(".cloze-resource-note")).toContainText("已完成", { timeout: 10000 });
  await expect(card.locator(".resource-summary-button")).toContainText("学习结果");

  // 完成时按现有逻辑创建了 D+1（1 个 task，非 backfill）
  expect(await countReviewTaskKeys(page)).toBe(1);
  expect(errors.filter((text) => !text.includes("favicon"))).toEqual([]);
});

async function openSummaryFromLibrary(page, titleText) {
  const nav = page.locator(".ds-rail .ds-nav button", { hasText: "完形" }).first();
  await nav.click();
  await page.locator(".library-page").waitFor({ state: "visible" });
  const card = page.locator(".cloze-resource-card", { hasText: titleText }).first();
  await expect(card.locator(".cloze-resource-note")).toContainText("已完成", { timeout: 20000 });
  await card.locator(".resource-summary-button").click();
  await expect(page.locator(".cloze-summary-panel")).toBeVisible({ timeout: 10000 });
  return card;
}

test("R6-2 旧 completed 记录可从资料卡打开学习结果，且不生成任何复习任务", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedCompletedFlow(page, username, OFFICIAL_2020, now);
  await seedProgress2020(page, username, now);
  expect(await countReviewTaskKeys(page)).toBe(0);

  const card = await openSummaryFromLibrary(page, "2020 英语（一）完形填空");
  const summary = page.locator(".cloze-summary-panel");
  await expect(summary).toContainText("最终正确");
  await expect(summary).toContainText("暂未生成 D+1 任务");
  await expect(summary).toContainText("暂未生成 D+7 任务");

  // 零 backfill：打开结果不产生任何复习任务
  expect(await countReviewTaskKeys(page)).toBe(0);

  await page.locator(".cloze-summary-header .icon-button").click();
  await expect(page.locator(".library-page")).toBeVisible({ timeout: 10000 });
  await expect(card.locator(".cloze-resource-note")).toContainText("已完成");
});

test("R6-3 长期档案：时间/状态/年份筛选 + official/answerless 语义 + 优先复盘", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // 官方 2020：昨天完成 + 今天到期的 D+1（高置信错误空 2）
  await seedCompletedFlow(page, username, OFFICIAL_2020, now - day);
  await seedProgress2020(page, username, now);
  await seedD1Task(page, username, { sourceDate: localDateKeyAt(1), dueDate: localDateKeyAt(0) });
  // 官方 2009：40 天前完成，无任务
  await seedCompletedFlow(page, username, OFFICIAL_2009, now - 40 * day);
  // 自定义无答案：2 天前完成
  await seedCompletedFlow(page, username, "custom-e2e-1", now - 2 * day);

  await openClozeArchive(page);
  const modal = page.locator(".cloze-archive-modal");

  // 全部 → 3 篇；总览有官方分母
  await expect(modal).toContainText("完成完形");
  await expect(modal).toContainText("有官方答案资料 · 最终正确");
  await expect(modal.locator(".cloze-archive-list")).toBeVisible({ timeout: 10000 });
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(3);

  // 最近 7 天 → 2（2020 + 自定义）
  await modal.locator(".learning-filter-group button", { hasText: "最近 7 天" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(2);
  // 最近 30 天 → 2（2009 被排除）
  await modal.locator(".learning-filter-group button", { hasText: "最近 30 天" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(2);
  // 全部
  await modal.locator(".learning-filter-group button", { hasText: "全部" }).first().click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(3);

  // 状态：待复习 → 1（2020 D+1 due）；仍不稳定 → 1；高置信错误 → 1（只有官方资料）
  await modal.locator(".learning-filter-group button", { hasText: "待复习" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(1);
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toContainText("2020 英语（一）完形填空");
  await modal.locator(".learning-filter-group button", { hasText: "仍不稳定" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(1);
  await modal.locator(".learning-filter-group button", { hasText: "高置信错误" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(1);
  await modal.locator(".learning-filter-group button", { hasText: "改答后错" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(0);

  // 年份：2020 → 1；自定义 → 1；全部年份（先重置状态筛选为"全部"）
  await modal.locator(".learning-filter-group button", { hasText: "全部" }).nth(1).click();
  await modal.locator(".learning-filter-group button", { hasText: "全部年份" }).click();
  await modal.locator(".learning-filter-group button", { hasText: "2020" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(1);
  await modal.locator(".learning-filter-group button", { hasText: "自定义" }).click();
  await expect(modal.locator(".cloze-archive-list .cloze-archive-row")).toHaveCount(1);
  const customRow = modal.locator(".cloze-archive-row", { hasText: "custom-e2e-1" });
  await expect(customRow).toContainText("无官方答案");
  await modal.locator(".learning-filter-group button", { hasText: "全部年份" }).click();

  // 展开 2020 行：详情表格 + 有答案语义
  const row2020 = modal.locator(".cloze-archive-row", { hasText: "2020 英语（一）完形填空" }).first();
  await row2020.locator(".cloze-archive-row-toggle").click();
  await expect(row2020.locator(".cloze-archive-table")).toBeVisible({ timeout: 10000 });

  // 优先复盘：D+1 今天到期应出现，点击进入同一本篇结果
  await expect(modal.locator(".cloze-archive-priority-item")).toHaveCount(1, { timeout: 10000 });
  await modal.locator(".cloze-archive-priority-item").click();
  const summary = page.locator(".cloze-summary-panel");
  await expect(summary).toBeVisible({ timeout: 10000 });
  await expect(summary).toContainText("2020 英语（一）完形填空");
  await expect(summary).toContainText("今天到期");
  // 关闭结果回到档案
  await summary.locator(".cloze-summary-header .icon-button").click();
  await expect(modal).toBeVisible({ timeout: 10000 });
});

test("R6-4 D+1 从结果页直接进入现有复习会话；完成后 D+7 future 不提前开始", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedCompletedFlow(page, username, OFFICIAL_2020, now - 24 * 60 * 60 * 1000);
  await seedProgress2020(page, username, now);
  await seedD1Task(page, username, { sourceDate: localDateKeyAt(1), dueDate: localDateKeyAt(0) });

  await openClozeArchive(page);
  await openSummaryFromArchive(page, "2020 英语（一）完形填空");

  const summary = page.locator(".cloze-summary-panel");
  await expect(summary).toContainText("今天到期");
  const startButton = summary.locator("button", { hasText: "开始 D+1" });
  await expect(startButton).toBeVisible();
  await startButton.click();

  // 进入现有 ClozeReviewSession
  const reviewPage = page.locator(".cloze-review-page");
  await expect(reviewPage).toBeVisible({ timeout: 15000 });
  await expect(reviewPage).toContainText("完形 D+1 复习");
  // 作答：第 2 空官方答案为 A（选项按钮文本以 key 开头）
  const optionA = reviewPage.locator(".cloze-option").filter({ hasText: /^A/ }).first();
  await optionA.click();
  await reviewPage.locator(".cloze-confidence-row button", { hasText: "确定" }).click();
  await reviewPage.locator("button", { hasText: "提交作答" }).click();
  await reviewPage.locator("button", { hasText: "完成复习" }).click();

  // 完成视图 → 返回首页
  await expect(reviewPage.locator("button", { hasText: "返回首页" })).toBeVisible({ timeout: 10000 });
  await reviewPage.locator("button", { hasText: "返回首页" }).click();
  await expect(page.locator(".home-page")).toBeVisible({ timeout: 10000 });

  // 重新打开档案：D+1 已完成；D+7 已创建但未到期（future，不提前开始）
  await openClozeArchive(page);
  await openSummaryFromArchive(page, "2020 英语（一）完形填空");
  await expect(summary).toContainText("已完成");
  await expect(summary).toContainText("D+7");
  await expect(summary).toContainText("到期");
  await expect(summary.locator("button", { hasText: "开始 D+7" })).toHaveCount(0);
  await expect(summary.locator("button", { hasText: "继续 D+7" })).toHaveCount(0);
});

test("R6-5 AI history 确定性关联：打开现有 AiFloatWindow 且无网络请求", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedCompletedFlow(page, username, OFFICIAL_2020, now);
  await seedProgress2020(page, username, now);

  // 注入带稳定 cloze metadata 的 AI history（第 2 空）
  await setScopedJson(page, username, "wuliao:ai:history", [{
    id: "ai-e2e-1",
    name: "完形第 2 空 · cloze-diagnosis",
    chapter: "完形填空",
    sentence: "sentence",
    kind: "cloze-diagnosis",
    model: "deepseek-chat",
    messages: [{ role: "assistant", content: "AI 推测内容（E2E 注入）" }],
    createdAt: now,
    updatedAt: now,
    favorite: false,
    metadata: { sourceType: "cloze", resourceId: OFFICIAL_2020, clozeId: OFFICIAL_2020, blankNumber: 2, taskType: "cloze-diagnosis" },
  }]);

  const aiRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("api.deepseek.com")) aiRequests.push(request.url());
  });

  await openSummaryFromLibrary(page, "2020 英语（一）完形填空");
  const summary = page.locator(".cloze-summary-panel");
  await expect(summary).toBeVisible({ timeout: 10000 });

  // 展开逐空详情 → 第 2 空显示"AI 当时的推测"
  await summary.locator(".cloze-summary-blanks-tools button", { hasText: "展开" }).click();
  const blank2 = summary.locator(".cloze-summary-blank", { hasText: "第 2 空" }).first();
  await expect(blank2.locator(".cloze-summary-blank-ai-title")).toContainText("AI 当时的推测 · 1 条", { timeout: 10000 });

  // 点击打开现有 AiFloatWindow（复用，不新建 modal、不发请求）
  await blank2.locator(".cloze-summary-blank-ai-link").click();
  const aiWindow = page.locator(".ai-float-window");
  await expect(aiWindow).toBeVisible({ timeout: 10000 });
  await expect(aiWindow).toContainText("AI 推测内容（E2E 注入）");
  await page.waitForTimeout(600);
  expect(aiRequests).toEqual([]);

  // 关闭 AI → 仍停留在本篇结果
  await aiWindow.locator(".ai-float-close").click();
  await expect(aiWindow).not.toBeVisible();
  await expect(summary).toBeVisible();

  // 免责标注存在
  await expect(summary).toContainText("不作为长期事实统计");
  await expectNoConsoleErrors(page);
});

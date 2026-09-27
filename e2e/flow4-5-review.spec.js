import { test, expect } from "@playwright/test";
import { createAccount, setScopedJson, scopedKey, todayKey } from "./helpers.js";

// Flow 4：阅读复习（Today Planner → ReviewSession → 返回 → Planner 更新）。
// Flow 5：完形复习（Planner → ClozeReviewSession → 完成 → 首页更新）。
// 使用 fixture 种子（独立 context 内），不污染真实用户数据。

test("阅读复习：今日任务 → ReviewSession → 完成 → 返回首页", async ({ page }) => {
  const username = await createAccount(page);
  const today = await todayKey(page);
  const resourceId = "postgraduate-2007-text-1";
  const passageId = "passage-text-1";
  const taskKey = `review:next_day_article:${encodeURIComponent(resourceId)}:${encodeURIComponent(passageId)}:${today}`;

  await setScopedJson(page, username, `wuliao:review-task:${taskKey}`, {
    schemaVersion: 1,
    taskKey,
    type: "next_day_article",
    resourceId,
    passageId,
    sourceDate: today,
    dueDate: today,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    sentenceKeys: [],
    session: {
      currentStep: "reread",
      startedAt: null,
      updatedAt: null,
      activeDurationMs: 0,
      activeSince: null,
      paragraphRecall: {},
      sentenceResults: {},
      reviewAnswers: {},
      checkUnlocked: false,
      completedAt: null,
      summary: null,
    },
  });

  // 首页 Planner 出现阅读复习任务
  await page.reload();
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  // The home container mounts before the asynchronous planner finishes.
  // Wait for the same required task content, rather than taking a loading snapshot.
  await expect(page.locator(".home-page")).toContainText("2007 英语（一）Text 1");

  // 打开 ReviewSession（开始复读）
  const startButton = page.locator(".today-task-card button, .today-planned button, .review-card button", { hasText: "学习" }).first();
  if (await startButton.count()) {
    await startButton.click();
  } else {
    await page.locator("button", { hasText: /学习/ }).first().click();
  }
  await page.locator(".reader-page, .review-session, .stage-nav").first().waitFor({ timeout: 60000 });

  // 返回首页，Planner 仍在（任务保留）
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 30000 });
  await expect(page.locator(".study-planner")).toBeVisible();
});

test("完形复习：种子 D+1 任务 → 今日任务 → ClozeReviewSession 完成 → 首页更新", async ({ page }) => {
  const username = await createAccount(page);
  const today = await todayKey(page);
  const resourceId = "postgraduate-2007-cloze";
  const clozeId = resourceId;
  const taskKey = `cloze:review:d1:${encodeURIComponent(resourceId)}:${encodeURIComponent(clozeId)}:${today}`;

  await setScopedJson(page, username, `wuliao:cloze-review-task:${taskKey}`, {
    schemaVersion: 1,
    taskKey,
    type: "d1",
    resourceId,
    clozeId,
    sourceDate: today,
    dueDate: today,
    targetBlankIds: [1, 2],
    attempts: {},
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    updatedAt: Date.now(),
  });

  await page.reload();
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  const homeText = await page.locator(".home-page").innerText();
  expect(homeText).toContain("完形");

  // Planner 出现「开始复习」计划项 → 打开 ClozeReviewSession
  const reviewButton = page.locator(".study-planner .primary-button", { hasText: "学习" }).first();
  await expect(reviewButton).toBeVisible({ timeout: 30000 });
  await reviewButton.click();
  await page.locator(".cloze-review-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".cloze-option").first()).toBeVisible({ timeout: 30000 });

  // 作答两空并完成（官方答案模式，无需自评）
  const blankCount = await page.locator(".cloze-review-dot").count();
  for (let index = 0; index < blankCount; index += 1) {
    await page.locator(".cloze-option").nth(0).click();
    await page.locator(".cloze-confidence-row button", { hasText: "确定" }).click();
    await page.locator("button", { hasText: "提交作答" }).click();
    const isLast = index === blankCount - 1;
    await page.locator("button", { hasText: isLast ? "完成复习" : "下一空" }).click();
    await page.waitForTimeout(200);
  }
  await expect(page.locator("body")).toContainText("完形 D+1 复习完成", { timeout: 15000 });

  // 返回首页
  await page.locator("button", { hasText: "返回首页" }).first().click();
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 30000 });
});

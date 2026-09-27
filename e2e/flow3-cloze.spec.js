import { test, expect } from "@playwright/test";
import { clickClozeAction, clickClozeBlank, createAccount, openOfficialCloze, setScopedJson, scopedKey } from "./helpers.js";

// Flow 3：完形正式流程。
// cloze-cover → cloze-first-attempt → cloze-self-review → cloze-correction →
// cloze-analysis → cloze-final-read → completed。
// 交互阶段真实驱动；最终阶段用 fixture 种子推进（不污染真实用户数据）。

test("完形：导读 → 初做 → 复查 → 订正 → 精析（交互 + 刷新恢复 + Back）", async ({ page }) => {
  await createAccount(page);
  await openOfficialCloze(page, "2007 英语（一）完形填空");

  // cover
  await expect(page.locator(".cloze-reader-stage")).toContainText("导读");
  await expect(page.locator(".cloze-blank")).toHaveCount(20);

  // first attempt
  await clickClozeAction(page, "开始限时初做");
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做");
  await expect(page.locator(".cloze-timer-bar strong")).toBeVisible();

  // Blank 点击 → 题窗联动
  await clickClozeBlank(page, page.locator(".cloze-blank").nth(4));
  await expect(page.locator(".cloze-question-head strong")).toContainText("5");

  // option 作答 + confidence
  await page.locator(".cloze-option").first().click();
  await page.locator(".cloze-confidence-row button", { hasText: "确定" }).click();
  await expect(page.locator(".cloze-confidence-row button.is-active")).toContainText("确定");

  // 自动下一空
  await page.locator(".cloze-question-head strong").waitFor();
  const head = await page.locator(".cloze-question-head strong").innerText();
  expect(head).toMatch(/[67]/);

  // 返回上一空
  await clickClozeBlank(page, page.locator(".cloze-blank").nth(4));
  await expect(page.locator(".cloze-question-head strong")).toContainText("5");

  // 初做提交前允许改选：A → B，刷新后仍以最后一次选择为 firstAnswer。
  const replacement = await page.locator(".cloze-option").nth(1).innerText();
  await page.locator(".cloze-option").nth(1).click();
  await page.reload();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做");
  await clickClozeBlank(page, page.locator(".cloze-blank").nth(4));
  await expect(page.locator(".cloze-option").nth(1)).toHaveClass(/is-chosen/);
  const persistedInitialAnswer = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.includes("cloze-progress"));
    const progress = key ? JSON.parse(localStorage.getItem(key)) : null;
    return progress?.attempts?.["5"]?.firstAnswer || "";
  });
  expect(replacement).toContain(persistedInitialAnswer);

  // 提交初做 → 自主复查（first/review 隔离）
  await clickClozeAction(page, "提交并进入复查");
  await expect(page.locator(".cloze-reader-stage")).toContainText("自主复查");
  const progressState = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes("cloze-progress"));
    const progress = key ? JSON.parse(localStorage.getItem(key)) : null;
    return progress ? { first: progress.attempts?.["5"]?.firstAnswer, firstSubmitted: progress.firstSubmitted } : null;
  });
  expect(progressState?.firstSubmitted).toBe(true);

  // 复查改答案：firstAnswer 不变
  await clickClozeBlank(page, page.locator(".cloze-blank").nth(4));
  const beforeFirst = progressState.first;
  await page.locator(".cloze-option").nth(1).click();
  await page.waitForTimeout(300);
  const afterReview = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes("cloze-progress"));
    const progress = key ? JSON.parse(localStorage.getItem(key)) : null;
    return progress ? { first: progress.attempts?.["5"]?.firstAnswer, review: progress.attempts?.["5"]?.reviewAnswer } : null;
  });
  expect(afterReview.first).toBe(beforeFirst);
  expect(afterReview.review).toBeTruthy();

  // 订正
  await clickClozeAction(page, "完成复查并订正");
  await expect(page.locator(".cloze-reader-stage")).toContainText("统一订正");
  if (!(await page.locator('.cloze-question-panel[data-motion-state="open"]').isVisible())) {
    await page.getByRole("button", { name: "展开题窗", exact: true }).click();
  }
  await expect(page.locator(".cloze-correction-official strong")).toBeVisible();
  const optionsLocked = await page.locator(".cloze-option").first().isDisabled();
  expect(optionsLocked).toBe(true);

  // 逐空精析
  await clickClozeAction(page, "完成订正，进入逐空精析");
  await expect(page.locator(".cloze-reader-stage")).toContainText("逐空精析");
  if (!(await page.locator('.cloze-question-panel[data-motion-state="open"]').isVisible())) {
    await page.getByRole("button", { name: "展开题窗", exact: true }).click();
  }
  await expect(page.locator(".cloze-analysis-complete")).toBeVisible();

  // 刷新恢复：仍在精析阶段
  await page.reload();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".cloze-reader-stage")).toContainText("逐空精析", { timeout: 30000 });

  // Back → 资料库（刷新恢复后重建栈可能直接回首页）
  await page.locator(".cloze-reader-header .back-button").click();
  await page.locator(".home-page, .library-page").first().waitFor({ state: "visible" });
});

test("完形：final-read → completed（fixture 种子推进）并生成 D+1 任务", async ({ page, baseURL }) => {
  const username = await createAccount(page);
  const resourceId = "postgraduate-2007-cloze";
  const clozeId = resourceId;
  const now = Date.now();

  // 种子：progress 全部已作答/已精析；flow 推进到全文回读。
  const numbers = Array.from({ length: 20 }, (_, index) => index + 1);
  const attempts = {};
  for (const number of numbers) {
    attempts[number] = {
      blankId: `blank-${number}`,
      number,
      firstAnswer: "A",
      reviewAnswer: "A",
      firstConfidence: "confident",
      reviewConfidence: "confident",
      confidence: "confident",
      prediction: "",
      basisTypes: [],
      references: [],
      corrected: true,
      analyzed: true,
      createdAt: now,
      updatedAt: now,
    };
  }
  await setScopedJson(page, username, `wuliao:cloze-progress:${resourceId}:${clozeId}`, {
    schemaVersion: 2,
    resourceId,
    clozeId,
    attempts,
    activeBlank: 1,
    firstSubmitted: true,
    reviewSubmitted: true,
    updatedAt: now,
  });
  const stageStatus = { status: "completed", completedAt: now };
  await setScopedJson(page, username, `wuliao:cloze-flow:${resourceId}:${clozeId}`, {
    schemaVersion: 1,
    resourceId,
    clozeId,
    stages: {
      "cloze-cover": stageStatus,
      "cloze-first-attempt": stageStatus,
      "cloze-self-review": stageStatus,
      "cloze-correction": stageStatus,
      "cloze-analysis": stageStatus,
      "cloze-final-read": { status: "current", completedAt: null },
    },
    currentStage: "cloze-final-read",
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-reader-stage")).toContainText("全文回读", { timeout: 30000 });

  // 完成全文回读 → 完成即返回资料库（业务行为），并自动展示本篇学习结果（R6）
  await clickClozeAction(page, "完成全文回读");
  await page.locator(".library-page").waitFor({ state: "visible", timeout: 30000 });
  const summaryPanel = page.locator(".cloze-summary-panel");
  await expect(summaryPanel).toBeVisible({ timeout: 15000 });
  await summaryPanel.locator(".cloze-summary-header .icon-button").click();
  await expect(summaryPanel).not.toBeVisible({ timeout: 10000 });

  // 完成应生成 D+1 复习任务（真实业务规则）
  const d1Task = await page.evaluate(({ userPrefix }) => {
    const prefix = `${userPrefix}wuliao:cloze-review-task:`;
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).length;
  }, { userPrefix: await scopedKey(username, "") });
  expect(d1Task).toBeGreaterThan(0);

  // 重进同一完形：显示已完成态（返回完形资料库）
  const card = page.locator(".cloze-resource-card", { hasText: "2007 英语（一）完形填空" }).first();
  await card.locator(".resource-open").click();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
  if (await page.locator(".cloze-panel-expand-fab").isVisible()) {
    await page.locator(".cloze-panel-expand-fab").click();
  }
  await expect(page.locator(".cloze-stage-actions button", { hasText: "返回完形资料库" })).toBeVisible({ timeout: 30000 });
});

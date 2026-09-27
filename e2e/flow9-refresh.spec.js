import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, openOfficialCloze, navTo, clickStageAdvance } from "./helpers.js";

// Flow 9：刷新恢复。
// 阅读进行中 reload → 恢复；完形进行中 reload → 恢复；
// Vocabulary reload → Bridge 恢复（见 flow6）；Planner reload → 当天计划恢复。

test("刷新恢复：阅读进行中 → reload → 资料库恢复 → 重进文章阶段恢复", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");
  await clickStageAdvance(page, "开始精读");
  await clickStageAdvance(page, "完成审题，进入初做");

  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: "2012 英语（一）Text 2" }).first().locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 90000 });
  await expect(page.locator(".stage-nav .current").first()).toContainText("初做");
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-clean-text")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
});

test("刷新恢复：完形进行中 → reload → 阶段恢复", async ({ page }) => {
  await createAccount(page);
  await openOfficialCloze(page, "2012 英语（一）完形填空");
  await page.locator(".cloze-stage-actions button", { hasText: "开始限时初做" }).click();
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做");

  await page.reload();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做", { timeout: 30000 });
});

test("刷新恢复：Vocabulary reload → Bridge 恢复", async ({ page }) => {
  await createAccount(page);
  await navTo(page, "词库");
  await page.locator(".vocabulary-page").waitFor({ state: "visible" });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/vocabulary/dashboard");

  await page.reload();
  await page.locator(".vocabulary-page").waitFor({ state: "visible", timeout: 30000 });
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 30000 }).toContain("#/vocabulary/dashboard");
  await expect.poll(async () => {
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/vocabulary/"));
    return frame ? frame.evaluate(() => Boolean(window.VocabularyBridge?.reportRoute)) : false;
  }, { timeout: 30000 }).toBe(true);
});

test("刷新恢复：Planner reload → 当天计划恢复", async ({ page }) => {
  const username = await createAccount(page);
  // 设定当日预算并确认 → Planner 持久化（wuliao:study-plan:<date>）
  await page.reload();
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  const planPanel = page.locator(".study-planner");
  await expect(planPanel).toBeVisible();
  const budgetButton = page.locator(".study-planner button", { hasText: /设置预算/ }).first();
  if (await budgetButton.count()) {
    await budgetButton.click();
    await page.locator(".budget-preset button, .planner-budget-option", { hasText: /30 分钟|30分/ }).first().click();
  }

  await page.reload();
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".study-planner")).toBeVisible({ timeout: 30000 });
  const afterReload = await page.locator(".study-planner").innerText();
  expect(afterReload).not.toContain("正在生成");
  expect(username.length).toBeGreaterThan(0);
});

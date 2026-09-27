import { test, expect } from "@playwright/test";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openX1AndStart(page, year = 2007) {
  await navTo(page, "模拟");
  await expect(page.locator(".exam-year-grid")).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${year} `) }).click();
  const start = page.getByRole("button", { name: "开始计时" });
  await expect(start).toBeEnabled({ timeout: 120000 });
  await start.click();
  await expect(page.locator(".exam-session")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".exam-navigator button")).toHaveCount(40);
}

test("X1：真实 40 题预检、切题、恢复、交卷、历史与显式 handoff", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("x1-main"));
  await openX1AndStart(page);

  await expect(page.getByLabel("剩余时间")).toContainText(/\d{2}:\d{2}/);
  await expect(page.locator(".exam-inline-blank")).toHaveCount(20);
  const clozeOptions = page.locator(".exam-question.current .exam-options button");
  const firstOption = await clozeOptions.nth(0).innerText();
  const secondOption = await clozeOptions.nth(1).innerText();
  const firstOptionText = firstOption.replace(/^[A-D]\.\s*/, "");
  const secondOptionText = secondOption.replace(/^[A-D]\.\s*/, "");
  const firstBlank = page.locator(".exam-inline-blank").first();
  await clozeOptions.nth(0).click();
  await expect(firstBlank).toHaveText(new RegExp(`^1\\s+${escapeRegExp(firstOptionText)}$`));
  await clozeOptions.nth(1).click();
  await expect(firstBlank).toHaveText(new RegExp(`^1\\s+${escapeRegExp(secondOptionText)}$`));
  const persistedAnswer = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:exam-session:v1:`;
    const [, raw] = Object.entries(localStorage).find(([key]) => key.startsWith(prefix)) || [];
    const session = raw ? JSON.parse(raw) : null;
    const blank = session?.items?.find((entry) => entry.blankNumber === 1);
    return blank ? session.answers?.[blank.id] : null;
  }, username);
  expect(persistedAnswer).toBe("B");

  await page.evaluate(() => window.scrollTo({ top: 0 }));
  const statusBar = page.locator(".exam-status-bar");
  await expect(statusBar).toContainText("已答 1 / 40");
  await expect(statusBar).toContainText("当前第 1 题");
  const toolbar = page.locator(".exam-page.exam-session > .annotation-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar).not.toContainText(/完形填空\s*·\s*第\s*\d+\/40\s*题/);
  const toolbarGap = await page.evaluate(() => {
    const headerElement = document.querySelector(".exam-status-bar");
    const toolbarElement = document.querySelector(".exam-page.exam-session > .annotation-toolbar");
    if (!headerElement || !toolbarElement) return null;
    return toolbarElement.getBoundingClientRect().top - headerElement.getBoundingClientRect().bottom;
  });
  expect(toolbarGap).not.toBeNull();
  expect(toolbarGap).toBeGreaterThanOrEqual(0);
  expect(toolbarGap).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo({ top: 420, behavior: "auto" }));
  const stickyToolbarGap = await page.evaluate(() => {
    const headerElement = document.querySelector(".exam-status-bar");
    const toolbarElement = document.querySelector(".exam-page.exam-session > .annotation-toolbar");
    if (!headerElement || !toolbarElement) return null;
    return toolbarElement.getBoundingClientRect().top - headerElement.getBoundingClientRect().bottom;
  });
  expect(stickyToolbarGap).not.toBeNull();
  expect(stickyToolbarGap).toBeGreaterThanOrEqual(0);
  expect(stickyToolbarGap).toBeLessThanOrEqual(1);
  await toolbar.getByRole("button", { name: "收起工具" }).click();
  await expect(toolbar).toHaveClass(/collapsed/);
  await expect(toolbar).not.toContainText(/完形填空\s*·\s*第\s*\d+\/40\s*题/);
  await toolbar.getByRole("button", { name: "展开工具" }).click();
  await expect(toolbar).not.toContainText(/完形填空\s*·\s*第\s*\d+\/40\s*题/);
  await page.locator(".exam-navigator button").nth(20).click();

  await expect(page.locator(".exam-ink-surface")).toBeVisible();
  await expect(page.locator(".exam-question")).toHaveCount(5);
  const passageLength = await page.locator(".exam-passage").innerText().then((text) => text.trim().length);
  expect(passageLength).toBeGreaterThan(500);

  await page.locator(".exam-navigator button").nth(30).click();
  await page.locator(".exam-navigator button").first().click();
  await expect(page.locator(".exam-options button").nth(1)).toHaveClass(/selected/);
  await expect(page.getByLabel("剩余时间")).not.toHaveText("100:00", { timeout: 3000 });
  const beforeReload = await page.getByLabel("剩余时间").innerText();

  await page.reload();
  await expect(page.locator(".exam-session")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".exam-navigator button")).toHaveCount(40);
  await expect(page.locator(".exam-options button").nth(1)).toHaveClass(/selected/);
  const afterReload = await page.getByLabel("剩余时间").innerText();
  expect(afterReload).not.toBe("100:00");
  expect(Number(afterReload.replace(":", ""))).toBeLessThanOrEqual(Number(beforeReload.replace(":", "")));

  const examLeaks = await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => (
    key.startsWith(prefix)
    && (/wuliao:(?:reading-flow|cloze-progress|reading-review|cloze-review)/).test(key)
  )), `wuliao:user:${encodeURIComponent(username)}:`);
  expect(examLeaks).toEqual([]);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "交卷" }).click();
  await expect(page.getByRole("heading", { name: "考试结果" })).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".exam-score strong")).toContainText(/\/ 40$/);
  await expect(page.locator(".exam-result-breakdown").getByText("完形填空")).toBeVisible();
  await expect(page.locator(".exam-result-breakdown").getByText("Reading Text 4")).toBeVisible();

  const clozeTarget = page.getByRole("checkbox", { name: /完形填空/ });
  await clozeTarget.check();
  await page.getByRole("button", { name: "加入后续学习" }).click();
  await expect(page.getByRole("button", { name: "开始学习" })).toBeVisible();
  const handoff = await page.evaluate((prefix) => Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix) && key.includes("wuliao:exam-handoff:v1:"))
    .map((key) => JSON.parse(localStorage.getItem(key))), `wuliao:user:${encodeURIComponent(username)}:`);
  expect(handoff).toHaveLength(1);
  expect(handoff[0].status).toBe("selected");

  await page.getByRole("button", { name: "历史成绩" }).click();
  await expect(page.getByRole("heading", { name: "历史成绩" })).toBeVisible();
  await page.locator(".exam-history-row").first().click();
  await expect(page.getByRole("heading", { name: "考试结果" })).toBeVisible();
  await page.getByRole("checkbox", { name: /完形填空/ }).check();
  await page.getByRole("button", { name: "加入后续学习" }).click();
  await page.getByRole("button", { name: "开始学习" }).click();
  await expect(page.locator(".cloze-reader-page")).toBeVisible({ timeout: 60000 });

  const importedAnswers = await page.evaluate((prefix) => Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix) && key.includes("wuliao:cloze-progress:"))
    .map((key) => JSON.parse(localStorage.getItem(key)))
    .some((record) => Object.values(record?.attempts || {}).some((attempt) => attempt?.firstAnswer || attempt?.reviewAnswer)), `wuliao:user:${encodeURIComponent(username)}:`);
  expect(importedAnswers).toBe(false);
});

test("X1：同设备 A/B 账号只恢复各自 active Session", async ({ page }) => {
  const accountA = uniqueUsername("x1-a");
  const accountB = uniqueUsername("x1-b");
  await createAccount(page, accountA);
  await openX1AndStart(page);

  await page.goto("/");
  await expect(page.locator(".home-page")).toBeVisible({ timeout: 30000 });
  await page.locator(".ds-settings").click();
  await page.getByRole("button", { name: "切换账号" }).click();
  await page.getByRole("button", { name: "创建新账号" }).click();
  await page.getByRole("textbox", { name: "账号名" }).fill(accountB);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("testpass123");
  await passwords.nth(1).fill("testpass123");
  await page.locator(".account-submit").click();
  await expect(page.locator(".home-page")).toBeVisible();

  await navTo(page, "模拟");
  await expect(page.getByRole("button", { name: "继续未完成考试" })).toHaveCount(0);
  await expect(page.locator(".exam-year-grid button").first()).toBeEnabled();

  await page.locator(".ds-settings").click();
  await page.getByRole("button", { name: "切换账号" }).click();
  await page.locator("select").selectOption(accountA);
  await page.getByRole("textbox", { name: "密码" }).fill("testpass123");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".home-page, .exam-page").first()).toBeVisible({ timeout: 30000 });
  if (await page.locator(".exam-page").count() === 0) await navTo(page, "模拟");
  await expect(page.getByRole("heading", { name: "整卷模拟" })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续未完成考试" })).toBeVisible();
});

test("X1：平板阅读笔迹工具栏无横向页面溢出且触控尺寸协调", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1200 });
  await createAccount(page, uniqueUsername("x1-tablet"));
  await openX1AndStart(page);
  await page.locator(".exam-navigator button").nth(20).click();
  const toolbar = page.locator(".exam-page.exam-session > .annotation-toolbar");
  await expect(toolbar).toBeVisible();
  // Web 环境默认不启用 Android 呈现类；按 flow11 的视觉契约做法手动加上，
  // 验证共享 Toolbar 契约（40px 触控目标）与平板真机一致。
  await toolbar.evaluate((element) => element.classList.add("tablet-ink-toolbar"));
  const geometry = await toolbar.evaluate((element) => {
    const buttons = [...element.querySelectorAll(":scope > button")].map((button) => button.getBoundingClientRect());
    const colors = [...element.querySelectorAll(".color-picker button")].map((button) => button.getBoundingClientRect());
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeights: buttons.map((rect) => rect.height),
      colorSizes: colors.map((rect) => [rect.width, rect.height]),
      toolbarScrollsInternally: element.scrollWidth >= element.clientWidth,
    };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(Math.min(...geometry.buttonHeights)).toBeGreaterThanOrEqual(40);
  expect(geometry.colorSizes.every(([width, height]) => width >= 40 && height >= 40)).toBe(true);
  expect(geometry.toolbarScrollsInternally).toBe(true);
});

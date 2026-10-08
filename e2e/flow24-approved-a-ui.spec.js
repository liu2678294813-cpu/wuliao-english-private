import { expect, test } from "@playwright/test";
import { createAccount, openOfficialResource } from "./helpers.js";

test("approved home keeps budget, archive, rank and all navigation actions", async ({ page }) => {
  await createAccount(page);
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await expect(page.locator(".overview-metrics article")).toHaveCount(6);
  // Current product baseline has retired the exam entry; assert every retained
  // route explicitly so an accidentally missing button cannot pass by count.
  const navigation = page.locator(".ds-nav > button");
  await expect(navigation).toHaveCount(9);
  for (const label of ["首页", "精读", "完形", "长难句", "写作", "词库", "筛查", "背诵", "复习"]) {
    await expect(page.locator(".ds-nav").getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  const archiveBox = await page.getByRole("button", { name: "学习档案", exact: true }).boundingBox();
  const homeBox = await page.locator(".home-main").boundingBox();
  const greetingBox = await page.locator(".home-greeting").boundingBox();
  const dateBox = await page.locator(".home-greeting time").boundingBox();
  expect(Math.abs((archiveBox.x + archiveBox.width) - (homeBox.x + homeBox.width))).toBeLessThanOrEqual(2);
  expect(archiveBox.y).toBeLessThanOrEqual(greetingBox.y + 4);
  expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(archiveBox.x - 8);
  await page.getByRole("button", { name: "60 分钟", exact: true }).click();
  await expect(page.getByRole("button", { name: "60 分钟", exact: true })).toHaveClass("active");
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page.getByRole("spinbutton", { name: "自定义学习分钟数" }).fill("75");
  await page.locator(".study-planner-custom").getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByRole("button", { name: "自定义 · 75", exact: true })).toHaveClass("active");
  await page.getByRole("button", { name: "清除今日预算", exact: true }).click();
  await expect(page.getByText("未设置预算 · 当前为推荐顺序", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "学习档案", exact: true }).click();
  await expect(page.getByRole("button", { name: "阅读档案", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "完形档案", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭学习档案入口" }).click();
  await page.getByRole("button", { name: "段位详情", exact: true }).click();
  await expect(page.locator(".rank-row.current")).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "自定义", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) {
      const score = await page.locator(".overview-score").boundingBox();
      const metrics = await page.locator(".overview-metrics").boundingBox();
      expect(Math.abs(score.width - metrics.width)).toBeLessThan(2);
    }
  }
});

test("collapsed reader chrome keeps full toolbar and moves questions and AI panel below it", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2023 英语（一）Text 1");
  await page.getByRole("button", { name: "开始精读", exact: true }).click();
  await page.locator(".question-fab").click();
  const panel = page.locator(".reader-side-panel");
  await expect(panel).toHaveAttribute("data-motion-state", "open");
  const toolbar = page.locator(".annotation-toolbar");
  for (const width of [1104, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const expandedTop = (await panel.boundingBox()).y;
    await toolbar.getByRole("button", { name: "收起顶部" }).click();
    await expect(toolbar.getByRole("button", { name: "展开顶部" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "笔", exact: true })).toBeVisible();
    await expect.poll(async () => { const tools = await toolbar.boundingBox(); return (await panel.boundingBox()).y - (tools.y + tools.height); }).toBeGreaterThanOrEqual(0);
    const box = await panel.boundingBox();
    const tools = await toolbar.boundingBox();
    const topGap = 8;
    const bottomInset = width <= 760 ? 8 : 14;
    expect(Math.abs(box.y - (tools.y + tools.height + topGap))).toBeLessThanOrEqual(2);
    expect(Math.abs((box.y + box.height) - (844 - bottomInset))).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - (844 - bottomInset - tools.y - tools.height - topGap))).toBeLessThanOrEqual(2);
    await panel.getByRole("tab", { name: "AI", exact: true }).click();
    await expect(panel.locator(".ai-float-window")).toBeVisible();
    const draft = panel.locator(".ai-float-window textarea").last();
    await draft.fill("保留草稿");
    await toolbar.getByRole("button", { name: "展开顶部" }).click();
    await expect.poll(async () => (await panel.boundingBox()).y).toBeGreaterThan(50);
    expect(Math.abs((await panel.boundingBox()).y - expandedTop)).toBeLessThan(2);
    await expect(draft).toHaveValue("保留草稿");
    for (const name of ["收起顶部", "键盘输入", "手写批注", "陌生词"]) {
      await expect(toolbar.getByRole("button", { name, exact: false })).toBeVisible();
    }
    await panel.getByRole("tab", { name: "习题", exact: true }).click();
  }
});

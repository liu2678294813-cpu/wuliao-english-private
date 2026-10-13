import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";

test("unified full package retains bundled catalogs, every workspace and import", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await createAccount(page);
  await expect(page.getByRole("button", { name: "导入", exact: true })).toBeVisible();
  for (const label of ["精读", "完形"]) {
    await navTo(page, label);
    await expect(page.getByRole("tablist", { name: "题库分类" })).toBeVisible();
    await expect(page.getByRole("tab").first()).toBeVisible();
    await expect(page.locator(".resource-card").first()).toBeVisible();
    await expect(page.locator(".library-count strong")).toHaveText(/^[1-9]\d*$/);
    await expect(page.locator(".empty-library")).toHaveCount(0);
    await page.screenshot({ path: `output/ai-cache-20261013/browser/full-${label === "精读" ? "reading" : "cloze"}.png`, fullPage: true });
  }
  await navTo(page, "写作");
  await expect(page.locator(".writing-question-bank")).toBeVisible();
  await expect(page.locator(".writing-question-bank button").first()).toBeVisible();
  await expect(page.locator(".writing-imported-materials")).toContainText("请从首页导入作文题目或参考范文");
  await expect(page.getByRole("button", { name: "浏览历年真题", exact: true })).toBeVisible();
  for (const label of ["词库", "筛查", "背诵", "复习", "长难句"]) {
    await expect(page.locator(".ds-rail .ds-nav button", { hasText: label }).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "AI API", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  for (const resource of ["/library/postgraduate/2023/2023-text-1.pdf", "/library/postgraduate/2023/2023-cloze.json"]) {
    const response = await page.request.get(resource);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"] || "").toMatch(/application\/(pdf|json)/);
    if (resource.endsWith(".pdf")) {
      expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
    } else {
      expect(await response.json()).toBeTruthy();
    }
  }
  await page.screenshot({ path: "output/ai-cache-20261013/browser/full-writing.png", fullPage: true });
  await navTo(page, "首页");
  const importButton = page.getByRole("button", { name: "导入", exact: true });
  await importButton.click();
  await expect(importButton).toHaveAttribute("aria-expanded", "true");
  for (const label of ["精读", "完形", "作文"]) {
    await expect(page.getByRole("checkbox", { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("选择批量导入文件")).toHaveCount(1);
});

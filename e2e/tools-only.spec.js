import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";

test("tools-only package has empty article catalogs and retains every workspace and import", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await createAccount(page);
  await expect(page.getByRole("button", { name: "导入", exact: true })).toBeVisible();
  for (const label of ["精读", "完形"]) {
    await navTo(page, label);
    await expect(page.getByRole("tablist", { name: "题库分类" })).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.locator(".resource-card")).toHaveCount(0);
    await expect(page.locator(".library-count strong")).toHaveText("0");
    await expect(page.locator(".library-count span")).toHaveText(label === "精读" ? "篇导入精读" : "篇导入完形");
    await expect(page.locator(".empty-library")).toContainText("请从首页选择类型并导入资料");
    await page.screenshot({ path: `output/tools-only/20261009/tools-only-${label === "精读" ? "reading" : "cloze"}.png`, fullPage: true });
  }
  await navTo(page, "写作");
  await expect(page.locator(".writing-question-bank")).toHaveCount(0);
  await expect(page.locator(".writing-imported-materials")).toContainText("请从首页导入作文题目或参考范文");
  await expect(page.getByRole("button", { name: "查看导入作文", exact: true })).toBeVisible();
  for (const label of ["词库", "筛查", "背诵", "复习", "长难句"]) {
    await expect(page.locator(".ds-rail .ds-nav button", { hasText: label }).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "AI API", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  for (const resource of ["/library/postgraduate/2023/2023-text-1.pdf", "/library/postgraduate/2023/2023-cloze.json"]) {
    const response = await page.request.get(resource);
    // Vite preview can return the SPA fallback for an absent path.
    expect(response.headers()["content-type"] || "").not.toMatch(/application\/(pdf|json)/);
  }
  await page.screenshot({ path: "output/tools-only/20261009/tools-only-writing.png", fullPage: true });
});

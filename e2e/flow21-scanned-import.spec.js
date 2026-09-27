import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";

const fixture = path.resolve("tmp/pdfs/scanned-exam-fixture.pdf");

test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/make-scanned-exam-fixture-pdf.mjs", fixture], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
});

test("扫描 PDF：image-only 10 页可取消、可重试并完整组装完形与 Text 1–4", async ({ page }) => {
  test.setTimeout(360000);
  await createAccount(page, uniqueUsername("scan-import"));
  await navTo(page, "精读");
  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(fixture);
  await expect(page.locator(".import-parsing")).toBeVisible({ timeout: 30000 });
  await page.locator(".import-cancel").click();
  await expect(page.locator(".import-error")).toContainText("已取消导入，未保存任何内容");

  await page.getByRole("button", { name: "重试本地 OCR" }).click();
  await expect(page.locator(".import-preview")).toBeVisible({ timeout: 300000 });
  await expect(page.locator(".import-editor")).toBeVisible();
  await expect(page.locator(".import-preview-head")).toContainText("识别良好");
  await expect(page.locator(".import-ai-fallback")).toHaveCount(0);
  await expect(page.locator(".import-summary-card")).toHaveCount(5);
  await expect(page.locator(".import-summary-card", { hasText: "Section I" })).toContainText("20/20 空完整");
  await expect(page.locator(".import-summary-card", { hasText: "Text 1" })).toContainText("5 题");
  await expect(page.locator(".import-summary-card", { hasText: "Text 1" })).toContainText("2 段");
  for (const label of ["Text 2", "Text 3", "Text 4"]) {
    await expect(page.locator(".import-summary-card", { hasText: label })).toContainText("5 题");
  }
  // image-only fixture 的每一页都应留下“无文字层、已进入 OCR”来源诊断；
  // 这些不是结构解析错误，且不能为了得到零警告而伪造文字层。
  await expect(page.locator(".import-editor-actions")).toContainText("0 个错误 · 10 个警告");
  await expect(page.locator(".import-part-card textarea").first()).not.toHaveValue("");

  // 扫描件末页答案只作为边界；编辑器不会将其提升为可靠官方答案。
  await expect(page.locator(".import-editor-page")).not.toContainText(/可靠答案|正确答案/);
});

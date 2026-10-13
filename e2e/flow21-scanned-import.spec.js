import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createAccount, uniqueUsername } from "./helpers.js";

const fixture = path.resolve("tmp/pdfs/scanned-exam-fixture.pdf");

test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/make-scanned-exam-fixture-pdf.mjs", fixture], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
});

test("扫描 PDF：image-only 10 页可取消、可重试并完整组装完形与 Text 1–4", async ({ page }) => {
  test.setTimeout(360000);
  const externalRequests = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1") && !/^(?:blob:|data:)/.test(request.url())) {
      externalRequests.push(request.url());
    }
  });
  await createAccount(page, uniqueUsername("scan-import"));
  // Import moved from the reader to the unified Home flow. Exercise the real
  // current controls and OCR, without inventing a text layer or skipping OCR.
  await page.getByRole("button", { name: "导入", exact: true }).click();
  for (const label of ["精读", "完形"]) {
    await page.getByRole("checkbox", { name: label, exact: true }).check();
  }
  await page.getByLabel("选择批量导入文件").setInputFiles(fixture);
  await expect(page.locator(".import-file")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "取消此文件", exact: true }).click();
  await expect(page.locator(".import-file")).toContainText("已取消");
  expect(await page.evaluate(() => window.__WULIAO_IMPORT_E2E__.repository.list("custom-pdfs"))).toHaveLength(0);
  await expect(page.locator(".import-candidate")).toHaveCount(0);

  const retry = page.getByRole("button", { name: "重新处理此文件", exact: true });
  await expect(retry).toBeEnabled({ timeout: 30000 });
  await retry.click();
  await expect(page.locator(".import-candidate")).toHaveCount(5, { timeout: 300000 });
  await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
  const preview = await page.evaluate(() => {
    const state = window.__WULIAO_IMPORT_E2E__.controller.state;
    return { pages: state.files[0].extracted.pages.map((p) => ({ source: p.textSource, hasText: !!p.text.trim() })),
      candidates: state.candidates.map((c) => ({ target: c.target, label: c.content.label,
        questions: (c.target === "cloze" ? c.content.blanks : c.content.questions)?.length,
        paragraphs: c.content.paragraphs?.length,
        errors: c.validation.errors })) };
  });
  // All ten pages must be OCR provenance, never a fabricated PDF text layer.
  expect(preview.pages).toHaveLength(10);
  expect(preview.pages.every((p) => p.source === "ocr" && p.hasText)).toBe(true);
  expect(preview.candidates.every((c) => c.errors.length === 0)).toBe(true);
  expect(preview.candidates.filter((c) => c.target === "cloze").map((c) => c.questions)).toEqual([20]);
  const reading = preview.candidates.filter((c) => c.target === "reading");
  expect(reading.map((c) => c.questions)).toEqual([5, 5, 5, 5]);
  // The synthetic fixture spans Text 1 across two pages; Texts 2–4 each have
  // one paragraph. These are source counts, not OCR-generated expectations.
  expect(reading.map((c) => c.paragraphs)).toEqual([2, 1, 1, 1]);
  await expect(page.locator(".import-candidate textarea").first()).not.toHaveValue("");

  // 扫描件末页答案只作为边界；编辑器不会将其提升为可靠官方答案。
  await expect(page.locator(".unified-import")).not.toContainText(/可靠答案|正确答案/);
  expect(await page.evaluate(() => window.__WULIAO_IMPORT_E2E__.repository.list("custom-pdfs"))).toHaveLength(0);
  expect(externalRequests).toEqual([]);
});

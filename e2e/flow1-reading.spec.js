import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, navTo } from "./helpers.js";

// Flow 1：首页 → 官方精读 → Reader 出现 → 无 OCR loading → 返回恢复来源页。
// 覆盖 2007 / 2012 / 2023；68 篇完整性由 scripts/test-official-reading-parser.mjs 与
// audit 脚本覆盖（E2E 只做代表性年份的浏览器级回归）。

for (const year of [2007, 2012, 2023]) {
  test(`官方精读 ${year}：打开无 OCR loading，返回资料库`, async ({ page }) => {
    await createAccount(page);
    const title = `${year} 英语（一）Text 1`;
    await openOfficialResource(page, title);

    // Reader 正常出现
    await expect(page.locator(".reader-page")).toBeVisible();

    // 不出现 OCR loading（.import-parsing 是自定义导入的 OCR 界面；官方路径禁用 OCR）
    await expect(page.locator(".import-parsing")).toHaveCount(0);
    await expect(page.locator(".import-progress")).toHaveCount(0);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("正在加载本地 OCR");
    expect(bodyText).not.toContain("OCR 第");
    expect(bodyText).toContain("精读全流程");

    // 返回 → 恢复来源页（资料库）
    await page.locator(".reader-header .back-button").first().click();
    await page.locator(".library-page").waitFor({ state: "visible" });
    await expect(page.locator(".resource-card", { hasText: title }).first()).toBeVisible();
  });
}

test("首页 → 精读资料库 → 返回首页", async ({ page }) => {
  await createAccount(page);
  await navTo(page, "精读");
  await page.locator(".library-page").waitFor({ state: "visible" });
  await navTo(page, "首页");
  await page.locator(".home-page").waitFor({ state: "visible" });
});

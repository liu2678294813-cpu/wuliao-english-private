import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, openOfficialCloze, navTo } from "./helpers.js";

// Flow 8：Overlay / Back 优先级（R1 顺序）。
// Modal → Back → 只关 Modal；Drawer → Back → 只关 Drawer；
// AI → Back → 关 AI；Reader → Back → 来源页；Vocabulary root → Back → 主 App。

test("Back 优先级：Settings Modal → 只关 Modal；Reader → 返回资料库", async ({ page }) => {
  await createAccount(page);

  // 打开设置 Modal
  await page.locator(".ds-mobile-settings, .ds-settings").first().click();
  await page.locator(".settings-panel").waitFor({ state: "visible" });

  // 硬件 Back（window.__wuliaoHandleHardwareBack）→ 只关 Modal
  await page.evaluate(() => window.__wuliaoHandleHardwareBack?.());
  await expect(page.locator(".settings-panel")).toHaveCount(0);
  await expect(page.locator(".home-page")).toBeVisible();

  // Reader → Back → 返回资料库
  await openOfficialResource(page, "2023 英语（一）Text 1");
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".library-page").waitFor({ state: "visible" });
});

test("Back 优先级：Cloze Reader → Back → 返回资料库；词汇 root → Back → 首页", async ({ page }) => {
  await createAccount(page);
  await openOfficialCloze(page, "2023 英语（一）完形填空");
  await page.locator(".cloze-reader-header .back-button").click();
  await page.locator(".library-page").waitFor({ state: "visible" });

  // 完形资料库 → 首页（桌面 rail 返回）
  await navTo(page, "首页");
  await page.locator(".home-page").waitFor({ state: "visible" });

  // 词汇 root → 硬件 Back → 主 App
  await navTo(page, "词库");
  await page.locator(".vocabulary-page").waitFor({ state: "visible" });
  await page.evaluate(() => window.__wuliaoHandleHardwareBack?.());
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 30000 });
});

test("Back 优先级：AI 窗 → Back → 只关 AI 窗", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await page.locator(".ai-float-button").click();
  await page.locator(".ai-float-window").waitFor({ state: "visible" });

  await page.evaluate(() => window.__wuliaoHandleHardwareBack?.());
  // Embedded ReaderPanels keep the AI component mounted to preserve its state.
  // Back must close it visually and accessibly without leaving the reader.
  await expect(page.locator(".ai-float-window")).not.toBeInViewport();
  await expect(page.locator(".reader-side-panel")).toHaveAttribute("inert", "");
  await expect(page.locator(".ai-float-window")).toHaveAttribute("data-motion-state", "closed");
  await expect(page.locator(".ai-float-window")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".reader-page")).toBeVisible();
});

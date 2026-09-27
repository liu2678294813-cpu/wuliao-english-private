import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";

// Flow 6：VocabularyBridge。
// 首页 → 词库 → 筛查 → Back → 背诵 → Back → 复习 → Back → 主 App。
// 验证 READY / ROUTE_CHANGED / BACK / NAVIGATE（父→子 CustomEvent 链路）、
// iframe reload 后 handshake、invalid message 忽略。

function vocabularyFrame(page) {
  return page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/vocabulary/"));
}

async function frameHasBridge(page) {
  const frame = vocabularyFrame(page);
  return frame ? frame.evaluate(() => Boolean(window.VocabularyBridge?.reportRoute)) : false;
}

async function frameHash(page) {
  const frame = vocabularyFrame(page);
  return frame ? frame.evaluate(() => location.hash) : "";
}

test("词汇 Bridge：导航链路与协议回归", async ({ page }) => {
  await createAccount(page);

  // 词库（SPA /dashboard）
  await navTo(page, "词库");
  await page.locator(".vocabulary-page").waitFor({ state: "visible" });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/vocabulary/dashboard");
  await expect.poll(() => frameHasBridge(page), { timeout: 30000 }).toBe(true);
  // The bridge adapter is a synchronous script, while the route consumer is
  // deferred and the vocabulary app restores its initial route asynchronously.
  // Wait for the rendered dashboard and app-polish route acknowledgement before
  // sending NAVIGATE; the existence of reportRoute alone is not readiness.
  await expect(page.locator(".vocabulary-frame")).toHaveClass(/\bloaded\b/);
  await expect(page.frameLocator(".vocabulary-frame").locator("body")).toHaveAttribute("data-app-route", "dashboard");
  await expect(page.frameLocator(".vocabulary-frame").getByRole("heading", { name: "仪表盘", exact: true })).toBeVisible();

  // 父 → 子 NAVIGATE：点击侧栏筛查，frame 内部路由与父端 hash 同步
  await navTo(page, "筛查");
  await expect.poll(() => frameHash(page), { timeout: 20000 }).toContain("/screening");
  await expect.poll(() => page.evaluate(() => location.hash)).toContain("#/vocabulary/screening");

  // 子 → 父 ROUTE_CHANGED：frame 内部导航回 dashboard（hashchange → 协议上报）
  const frame = vocabularyFrame(page);
  await frame.evaluate(() => { location.hash = "#/dashboard"; });
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 20000 }).toBe("#/vocabulary/dashboard");

  // 背诵（static 页 + STATIC_PAGE 同步）
  await navTo(page, "背诵");
  await expect.poll(async () => page.frames().some((f) => f !== page.mainFrame() && f.url().includes("memorize.html")), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");

  // 复习（static 页）
  await navTo(page, "复习");
  await expect.poll(async () => page.frames().some((f) => f !== page.mainFrame() && f.url().includes("review.html")), { timeout: 30000 }).toBe(true);

  // 返回主 App（词库根 → 硬件 Back）
  await navTo(page, "词库");
  // Static pages also expose VocabularyBridge; wait for the requested SPA document
  // before Back so it cannot run against the departing review page.
  await expect.poll(() => vocabularyFrame(page)?.url() || "").toContain("/vocabulary/index.html");
  await expect.poll(() => frameHash(page)).toBe("#/dashboard");
  await expect(page.locator(".vocabulary-frame")).toHaveClass(/\bloaded\b/);
  await expect.poll(() => frameHasBridge(page), { timeout: 30000 }).toBe(true);
  await page.evaluate(() => window.__wuliaoHandleHardwareBack?.());
  await page.locator(".home-page").waitFor({ state: "visible", timeout: 30000 });

  // invalid message：父端收到非法 namespace/type 不触发任何导航
  await page.evaluate(() => {
    window.postMessage({ namespace: "wuliao:vocabulary", version: 99, type: "NAVIGATE", payload: { route: "/dashboard" } }, "*");
    window.postMessage({ namespace: "other", version: 1, type: "NAVIGATE", payload: { route: "/dashboard" } }, "*");
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => location.hash)).not.toContain("vocabulary");
});

test("词汇 iframe reload 后 handshake 恢复（父端 hash 保持）", async ({ page }) => {
  await createAccount(page);
  await navTo(page, "词库");
  await page.locator(".vocabulary-page").waitFor({ state: "visible" });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/vocabulary/dashboard");

  // 强制 iframe reload（模拟崩溃恢复），handshake 必须恢复
  await page.locator(".vocabulary-frame").evaluate((frame) => frame.contentWindow.location.reload());
  await page.waitForTimeout(2000);
  await expect.poll(() => frameHasBridge(page), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/vocabulary/dashboard");
});

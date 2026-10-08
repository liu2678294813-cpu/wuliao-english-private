import { expect, test } from "@playwright/test";
import { createAccount, expectNoConsoleErrors, navTo, openOfficialResource, uniqueUsername } from "./helpers.js";

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

test("资料库入口与导航均无整卷模拟", async ({ page }) => {
  await page.setViewportSize({ width: 1104, height: 720 });
  await createAccount(page, uniqueUsername("smooth-entry"));

  await navTo(page, "精读");
  await expect(page.getByRole("heading", { name: "精读资料库" })).toBeVisible();
  await expect(page.locator(".exam-library-button")).toHaveCount(0);

  await navTo(page, "完形");
  await expect(page.getByRole("heading", { name: "完形资料库" })).toBeVisible();
  await expect(page.locator(".exam-library-button")).toHaveCount(0);

  await expect(page.getByRole("button", { name: "模拟", exact: true })).toHaveCount(0);

  await navTo(page, "写作");
  await expect(page.locator(".writing-library")).toBeVisible();
  await expect(page.locator(".writing-library-hero .back-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "浏览历年真题" })).toBeVisible();
  await expectNoConsoleErrors(page);
});

test("侧栏折叠只在合成层过渡并能承受快速反向", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1104, height: 720 });
  await createAccount(page, uniqueUsername("smooth-shell"));

  const rail = page.locator(".ds-rail");
  const content = page.locator(".ds-shell-content");
  const brand = page.locator(".ds-brand");
  const before = await content.boundingBox();
  await brand.click();
  await expect(brand).toHaveAttribute("aria-label", "展开侧栏");
  await page.waitForTimeout(240);
  const after = await content.boundingBox();
  expect(Math.round(before.x - after.x)).toBe(126);
  await expect(rail).toHaveCSS("width", "64px");
  expect(await content.evaluate((node) => getComputedStyle(node).transitionProperty)).not.toContain("margin");
  expect(await rail.evaluate((node) => getComputedStyle(node).transitionProperty)).not.toContain("width");

  const perf = await page.evaluate(async () => {
    const button = document.querySelector(".ds-brand");
    const frames = [];
    const longTasks = [];
    let raf = 0;
    const tick = (time) => {
      frames.push(time);
      raf = requestAnimationFrame(tick);
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    raf = requestAnimationFrame(tick);
    for (let index = 0; index < 10; index += 1) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 240));
    }
    cancelAnimationFrame(raf);
    return { frames, longTasks };
  });
  const gaps = perf.frames.slice(1).map((time, index) => time - perf.frames[index]);
  const metrics = {
    frameCount: perf.frames.length,
    p95: percentile(gaps, 0.95),
    max: Math.max(0, ...gaps),
    longTasks: perf.longTasks,
  };
  await testInfo.attach("sidebar-frame-metrics", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  expect(metrics.frameCount).toBeGreaterThan(80);
  expect(metrics.p95).toBeLessThanOrEqual(20);
  expect(metrics.max).toBeLessThanOrEqual(50);
  expect(metrics.longTasks.filter((duration) => duration >= 50)).toEqual([]);
  await expect(brand).toHaveAttribute("aria-label", "展开侧栏");
});

test("平板题窗平滑避让正文、完整退场并支持中途反向", async ({ page }) => {
  await page.setViewportSize({ width: 1104, height: 720 });
  await createAccount(page, uniqueUsername("smooth-reader"));
  await openOfficialResource(page, "2023 英语（一）Text 1");

  const content = page.locator(".deep-reader-content");
  const drawer = page.locator(".question-drawer");
  const fab = page.locator(".question-fab");
  const before = await content.boundingBox();
  await fab.click();
  await expect(drawer).toHaveAttribute("data-motion-state", "open");
  await page.waitForTimeout(220);
  const opened = await content.boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect(opened.x).toBeLessThan(before.x - 40);
  expect(opened.width).toBeLessThan(before.width - 100);
  expect(opened.x + opened.width).toBeLessThanOrEqual(drawerBox.x - 12);
  // Scroll is adjusted to preserve the visible paper anchor after uniform scaling.
  expect(await content.evaluate((node) => node.offsetWidth)).toBe(before.width);

  await drawer.getByRole("button", { name: "关闭题窗" }).click();
  await expect(drawer).toHaveAttribute("data-motion-state", "closing");
  await expect(drawer).toHaveCSS("visibility", "visible");
  await page.waitForTimeout(50);
  await fab.click();
  await expect(drawer).toHaveAttribute("data-motion-state", "open");

  await drawer.getByRole("button", { name: "关闭题窗" }).click();
  await expect(drawer).toHaveAttribute("data-motion-state", "closed");
  await page.waitForTimeout(220);
  const restored = await content.boundingBox();
  expect(Math.abs(before.x - restored.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(before.width - restored.width)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1400, height: 900 });
  const wideClosed = await content.boundingBox();
  await fab.click();
  await expect(drawer).toHaveAttribute("data-motion-state", "open");
  await page.waitForTimeout(240);
  const wideOpen = await content.boundingBox();
  expect(wideOpen.x).toBeLessThan(wideClosed.x);
  expect(Math.abs(wideClosed.width - wideOpen.width)).toBeLessThanOrEqual(1);
  await expectNoConsoleErrors(page);
});

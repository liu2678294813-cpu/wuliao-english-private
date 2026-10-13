import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fingerprintAiInput } from "../src/aiTasks.js";
import { createAccount } from "./helpers.js";

// Synthetic events in a fresh browser context. They prove calculation/rendering,
// not a live provider's cache efficiency, billing, or real account history.
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`AI cache diagnostics: separate metrics, Unknown, account isolation and export at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const username = await createAccount(page);
    const scope = fingerprintAiInput(["ai-cache-account-v1", username]);
    await page.addInitScript(({ scope }) => {
      localStorage.setItem("wuliao:dev:mode:v1", "1");
      const base = { timestamp: Date.now(), sessionId: "cache-fixture", model: "deepseek-chat", taskType: "reading-hint-1", status: "success", durationMs: 100,
        metadata: { providerId: "deepseek", transportKind: "openai-chat-completions", accountScope: scope } };
      const event = (type, usage, extra = {}) => ({ ...base, eventType: type, metadata: { ...base.metadata, ...(usage === undefined ? {} : { usage }), ...extra } });
      const events = [event("ai.result_cache.memory_hit"), event("ai.result_cache.persistent_hit"), event("ai.result_cache.miss"), event("ai.result_cache.inflight_join"),
        event("ai.api_request_started"), event("ai.api_request_started"), event("ai.api_request_started"),
        event("ai.api_request", { promptTokens: 100, cacheUsage: { hitTokens: 90, missTokens: 10 } }),
        event("ai.api_request", { promptTokens: 900, cacheUsage: { hitTokens: 90, missTokens: 810 } }),
        event("ai.api_request", null), event("ai.api_request", { promptTokens: 9000 }, { accountScope: "other-account" })];
      localStorage.setItem("wuliao:telemetry:v1", JSON.stringify({ schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), lastFlushAt: 0, activeSessionId: "cache-fixture", events, errors: [], samples: {} }));
    }, { scope });
    await page.reload();
    await page.locator(".home-page").waitFor();
    await page.locator(".ds-settings:visible, .ds-mobile-settings:visible").first().click();
    await page.getByRole("button", { name: "打开开发者选项", exact: true }).click();
    const lab = page.locator(".dev-lab");
    await lab.getByRole("button", { name: "AI 缓存", exact: true }).click();
    const value = label => lab.locator(".dev-metric-row").filter({ has: page.locator("span", { hasText: label }) }).locator("strong");
    await expect(lab.getByText("deepseek / deepseek-chat", { exact: true })).toBeVisible();
    await expect(value("本地结果缓存命中率")).toHaveText("50.0%");
    await expect(value("Provider 输入缓存 Token 命中率")).toHaveText("18.0%（仅已报告样本）");
    await expect(value("缓存读 / 未命中 Token")).toHaveText("180 / 820");
    await expect(value("实际网络请求 / 取消")).toHaveText("3 / 0");
    await expect(value("缓存写入 Token")).toHaveText("Unknown");
    await expect(value("Provider 报告费用（USD）")).toHaveText("Unknown");
    await lab.getByRole("button", { name: "刷新缓存分析", exact: true }).click();
    await expect(value("内存 / 持久化命中")).toHaveText("1 / 1");
    await expect(lab.getByText("9000", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`cache-${viewport.width}-top.png`) });
    await lab.locator(".dev-lab-body").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: testInfo.outputPath(`cache-${viewport.width}-bottom.png`) });
    const overflow = await lab.locator(".dev-lab-body").evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    const download = page.waitForEvent("download");
    await lab.getByRole("button", { name: "导出诊断报告", exact: true }).click();
    const artifact = await download; const path = testInfo.outputPath("diagnostics.json"); await artifact.saveAs(path);
    const report = JSON.parse(await readFile(path, "utf8"));
    expect(report.aiCacheMetrics.rows[0].providerHitRatio).toBe(0.18);
    expect(report.aiCacheMetrics.rows[0].writeTokens).toBeNull();
    expect(JSON.stringify(report.aiCacheMetrics)).not.toContain(username);
    expect(JSON.stringify(report)).not.toMatch(/Authorization|apiKey|rawPrompt/);
    expect(errors).toEqual([]);
  });
}

import { test, expect } from "@playwright/test";
import { createAccount, setScopedJson, openOfficialResource } from "./helpers.js";

// Flow 7：AI lifecycle（浏览器级）。
// - 请求 A → 离开 Reader（上下文切换）→ 请求被 abort，不残留 loading；
// - 错误 → 展示可读错误 → 用户可重发（retry 路径）；
// - stale guard 由 contract 测试覆盖（scripts/test-r3-ai-lifecycle.mjs）。

async function seedApiKey(page, username) {
  await setScopedJson(page, username, "wuliao:ai:apikey", "test-deepseek-key");
}

async function openAiWindow(page) {
  await page.locator(".ai-float-button").click();
  await page.locator(".ai-float-window").waitFor({ state: "visible" });
}

async function sendChat(page, text) {
  await page.locator(".ai-float-input textarea").fill(text);
  await page.locator(".ai-float-input button", { hasText: "发送" }).click();
}

test("AI：离开 Reader 后 in-flight 请求被 abort，无残留 loading", async ({ page }) => {
  // 在页面侧记录 DeepSeek 请求的 AbortSignal（route 挂起时无法从 driver 侧观察 abort）
  // 必须在首次导航前注册
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, options = {}) => {
      if (String(url).includes("api.deepseek.com")) {
        window.__deepseekRequests = (window.__deepseekRequests || 0) + 1;
        options.signal?.addEventListener?.("abort", () => { window.__deepseekAborted = true; });
      }
      return originalFetch(url, options);
    };
  });
  let held = 0;
  await page.route("https://api.deepseek.com/**", async (route) => {
    held += 1;
    // 保持请求挂起直到测试结束/被 abort
    await new Promise((resolve) => setTimeout(resolve, 60000));
    await route.abort("canceled").catch(() => {});
  });

  const username = await createAccount(page);
  await seedApiKey(page, username);

  await openOfficialResource(page, "2012 英语（一）Text 2");
  await openAiWindow(page);
  await sendChat(page, "hello");
  await expect(page.locator(".ai-thinking")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__deepseekRequests || 0)).toBeGreaterThan(0);

  // 上下文切换：返回资料库 → Reader 卸载 → lifecycle 清空并 abort
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".library-page").waitFor({ state: "visible" });

  await expect.poll(() => page.evaluate(() => window.__deepseekAborted === true), { timeout: 15000 }).toBe(true);
  expect(held).toBe(1);

  // 重新进入 Reader：AI 窗不残留 loading
  const card = page.locator(".resource-card", { hasText: "2012 英语（一）Text 2" }).first();
  await card.locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 90000 });
  await expect(page.locator(".ai-thinking")).toHaveCount(0);
});

test("AI：请求失败展示可读错误，用户可重发成功", async ({ page }) => {
  const username = await createAccount(page);
  await seedApiKey(page, username);
  await openOfficialResource(page, "2012 英语（一）Text 2");

  let calls = 0;
  await page.route("https://api.deepseek.com/**", async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "DeepSeek 服务端暂时不可用" } }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        choices: [{ message: { content: "这是第二条回答", reasoning_content: "" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }) });
    }
  });

  await openAiWindow(page);
  await sendChat(page, "hello");
  await expect(page.locator(".ai-float-body")).toContainText("回答失败：DeepSeek 服务端暂时不可用", { timeout: 30000 });
  // 失败后 busy 结束，spinner 消失
  await expect(page.locator(".ai-thinking")).toHaveCount(0);
  // 重发 → 成功展示
  await sendChat(page, "hello again");
  await expect(page.locator(".ai-float-body")).toContainText("这是第二条回答", { timeout: 30000 });
});

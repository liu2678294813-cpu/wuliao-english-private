import { test, expect } from "@playwright/test";
import { createAccount, uniqueUsername, openOfficialResource, clickStageAdvance } from "./helpers.js";

const FIRST_TITLE = "2007 英语（一）Text 1";
const SECOND_TITLE = "2016 英语（一）Text 1";
const RESULT = "这个（快译缓存测试）";
test.use({ actionTimeout: 15000 });

async function openCard(page, title) {
  await page.locator(".library-page").waitFor({ state: "visible", timeout: 60000 });
  await page.locator(".resource-card", { hasText: title }).first().locator(".resource-open").click();
  await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
  // Reader deliberately reapplies its saved position at 420 ms after mount.
  // Finish that existing restoration before selecting a new visible word.
  await page.waitForTimeout(500);
}

async function prepareCurrentArticle(page, username) {
  const oldKeys = await page.evaluate(user => Object.keys(localStorage).filter(key => key.startsWith(`wuliao:user:${encodeURIComponent(user)}:wuliao:reading-flow:`)), username);
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(({ user, previous }) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:reading-flow:`;
    const flowKey = Object.keys(localStorage).find(key => key.startsWith(prefix) && !previous.includes(key));
    if (!flowKey) throw new Error("New article reading-flow fixture not found");
    const flow = JSON.parse(localStorage.getItem(flowKey));
    const ids = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
    ids.forEach((id, index) => { flow.stages[id] = { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? 100 : null }; });
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(flowKey, JSON.stringify(flow));
  }, { user: username, previous: oldKeys });
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
}

async function selectWordAndTranslate(page) {
  await page.locator(".annotation-toolbar").getByRole("button", { name: "键盘输入", exact: true }).click();
  const sentence = page.locator('[data-sentence-scope^="translation:"]').filter({ hasText: /\bthe\b/i }).first();
  await expect(sentence).toBeVisible();
  await sentence.scrollIntoViewIfNeeded();
  // Let the stage's scroll restoration and native scroll events finish before
  // creating a selection; scrolling intentionally dismisses the action bar.
  await sentence.evaluate(async element => {
    let previous = null, stable = 0;
    for (let frame = 0; frame < 60 && stable < 8; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = element.getBoundingClientRect();
      const current = `${rect.top}:${rect.left}:${window.scrollY}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
  });
  // Exercise the browser Selection entrypoint using the article's real text.
  // No AI event is dispatched directly and no DOM text is fabricated.
  const selected = await sentence.evaluate(async element => {
    // Selection must be created in the viewport, as a real drag would be.
    // Stage restoration can move the document after locator auto-scrolling.
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const match = /\bthe\b/i.exec(node.textContent || "");
      if (!match) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse" }));
      const rect = range.getBoundingClientRect();
      return { text: selection.toString(), top: rect.top, bottom: rect.bottom, height: innerHeight };
    }
    return { text: "" };
  });
  expect(selected.text.toLowerCase()).toBe("the");
  expect(selected.top).toBeGreaterThanOrEqual(0);
  expect(selected.bottom).toBeLessThan(selected.height);
  const bar = page.locator(".sentence-action-bar");
  await expect(bar.getByRole("button", { name: "本句词义", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "快译", exact: true }).click();
  await expect(page.locator(".ai-float-window")).toBeVisible();
  await expect(page.locator(".ai-float-body")).toContainText(RESULT);
  await expect(page.locator(".ai-thinking")).toHaveCount(0);
}

test("selected word quick translation is shared across years and survives reload with zero extra HTTP", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("quick-cache"));
  // Only this browser context is seeded; no connected device data is touched.
  await page.evaluate(user => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    localStorage.setItem(`${prefix}wuliao:ai:apikey`, "mock-quick-translation-key");
    localStorage.setItem(`${prefix}wuliao:ai:model`, "deepseek-chat");
    localStorage.setItem(`${prefix}wuliao:ai:api-config`, JSON.stringify({ baseUrl: "https://api.deepseek.com" }));
  }, username);
  // A reliable dictionary hit correctly avoids AI. Mock a dictionary miss to
  // specifically verify the business-result cache and HTTP request counts.
  await page.route("**/vocabulary/word-assets.json", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  let requests = 0;
  await page.route("https://api.deepseek.com/**", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().url()).toMatch(/\/chat\/completions$/);
    const body = route.request().postDataJSON();
    expect(body.messages.at(-1).content).toBe("the");
    requests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: RESULT } }], usage: { prompt_tokens: 50, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50, completion_tokens: 8, total_tokens: 58 } }) });
  });
  await openOfficialResource(page, FIRST_TITLE);
  await prepareCurrentArticle(page, username);
  await openCard(page, SECOND_TITLE);
  await prepareCurrentArticle(page, username);
  await openCard(page, FIRST_TITLE);
  await selectWordAndTranslate(page);
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "关闭 AI 悬浮窗", exact: true }).click();
  await page.locator(".reader-header .back-button").first().click();
  await openCard(page, SECOND_TITLE);
  await selectWordAndTranslate(page);
  expect(requests).toBe(1);
  await page.reload();
  await openCard(page, SECOND_TITLE);
  await selectWordAndTranslate(page);
  expect(requests).toBe(1);
});

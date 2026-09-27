import { expect } from "@playwright/test";

// 通用 E2E 工具：独立 context 内新建测试账号，所有数据仅存在于该 context。

export function uniqueUsername(prefix = "e2e") {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Read the application's current durable store, with legacy localStorage only
// as compatibility fallback. Never mutate test or real learning records.
export async function readDurableInkEntries(page, username) {
  return page.evaluate(async (user) => {
    user ||= localStorage.getItem("kaoyan_vocab_current_user")?.trim() || "";
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = db.objectStoreNames.contains("reader-ink") ? await new Promise((resolve, reject) => { const request = db.transaction("reader-ink").objectStore("reader-ink").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }) : [];
    db.close();
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const result = new Map(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix) && /wuliao:(?:deep-ink:|ink:|cloze-ink:v1:)/.test(key)).map(([key, value]) => [key.slice(prefix.length), value]));
    for (const row of rows) if (row.username === user) result.set(row.key, row.value);
    return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
  }, username);
}

export async function createAccount(page, username = uniqueUsername(), password = "testpass123") {
  await page.goto("/", { waitUntil: "commit", timeout: 60000 });
  await page.locator(".account-card").waitFor({ state: "visible" });
  await page.locator('input[autocomplete="username"]').fill(username);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(password);
  await passwords.nth(1).fill(password);
  await page.locator(".account-submit").click();
  await page.locator(".home-page").waitFor({ timeout: 30000 });
  return username;
}

export async function scopedKey(username, key) {
  return `wuliao:user:${encodeURIComponent(username)}:${key}`;
}

export async function setScopedJson(page, username, key, value) {
  await page.evaluate(({ fullKey, payload }) => {
    localStorage.setItem(fullKey, JSON.stringify(payload));
  }, { fullKey: await scopedKey(username, key), payload: value });
}

export async function navTo(page, label) {
  const button = page.locator(".ds-rail .ds-nav button", { hasText: label }).first();
  await expect(button).toBeVisible({ timeout: 15000 });
  await button.click();
}

export async function openOfficialResource(page, titleText) {
  await navTo(page, "精读");
  await page.locator(".library-page").waitFor({ state: "visible" });
  const card = page.locator(".resource-card", { hasText: titleText }).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 90000 });
}

export async function openOfficialCloze(page, titleText) {
  await navTo(page, "完形");
  await page.locator(".library-page").waitFor({ state: "visible" });
  const card = page.locator(".cloze-resource-card", { hasText: titleText }).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.locator(".resource-open").click();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
}

export async function clickStageAdvance(page, text) {
  const button = page.locator(".stage-advance-button", { hasText: text }).first();
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
}

export async function clickClozeAction(page, text) {
  const button = page.locator(".cloze-stage-actions button", { hasText: text }).first();
  if ((page.viewportSize()?.width || 0) < 1400) {
    const openPanel = page.locator('.cloze-question-panel[data-motion-state="open"]');
    const actionLivesInPanel = await button.evaluate((element) => Boolean(element.closest(".cloze-question-panel"))).catch(() => false);
    if (actionLivesInPanel && !(await openPanel.isVisible().catch(() => false))) {
      await page.locator(".cloze-panel-expand-fab").click();
      await expect(openPanel).toBeVisible();
    } else if (!actionLivesInPanel && await openPanel.isVisible().catch(() => false)) {
      await openPanel.locator(".cloze-panel-toggle").click();
      await expect(openPanel).toBeHidden();
    }
  }
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
}

export async function clickClozeBlank(page, locator) {
  if ((page.viewportSize()?.width || 0) < 1400) {
    const openPanel = page.locator('.cloze-question-panel[data-motion-state="open"]');
    if (await openPanel.isVisible().catch(() => false)) {
      await openPanel.locator(".cloze-panel-toggle").click();
      await expect(openPanel).toBeHidden();
    }
  }
  await locator.click();
  await expect(page.locator(".cloze-question-panel.is-open")).toBeVisible();
}

export async function clickNavStage(page, label) {
  const button = page.locator(".stage-nav button", { hasText: label }).first();
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
}

export function todayKey(page) {
  return page.evaluate(() => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
}

export async function expectNoConsoleErrors(page) {
  const errors = [];
  const handler = (message) => {
    if (message.type() === "error") errors.push(message.text());
  };
  page.on("console", handler);
  await page.waitForTimeout(600);
  page.off("console", handler);
  expect(errors, `console errors: ${errors.join(" ;; ")}`).toEqual([]);
}

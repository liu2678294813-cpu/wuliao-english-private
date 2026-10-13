import { test, expect } from "@playwright/test";
import path from "node:path";
import { createAccount, uniqueUsername, openOfficialResource, clickStageAdvance, navTo, readDurableInkEntries } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";
const ARTICLE = '[data-redo-article="true"]';
const OUTPUT = path.resolve("output/redo-article/20261013");

async function reopen(page, title = TITLE, custom = false) {
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  if (custom) await page.getByRole("tab", { name: /自定义库/ }).click();
  await page.locator(".resource-card", { hasText: title }).first().locator(".resource-open").click();
  await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
  await page.waitForTimeout(650);
}

async function ink(page, username, stage) {
  const rows = await readDurableInkEntries(page, username);
  const row = rows.find(({ key }) => key.startsWith("wuliao:deep-ink:v2:") && key.endsWith(`:${stage}`));
  return row ? JSON.parse(row.value) : [];
}

async function draw(page, selector) {
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const sentence = page.locator(selector).first();
  await sentence.scrollIntoViewIfNeeded();
  const point = await sentence.evaluate(async (element) => {
    await document.fonts.ready;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getClientRects()[0];
    return { x: rect.left + 20, y: rect.top + rect.height * 0.7, length: Math.min(65, rect.width - 30) };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + point.length, point.y + 2, { steps: 8 });
  await page.mouse.up();
}

async function inkPixels(page, selector) {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector).getBoundingClientRect();
    let count = 0;
    for (const tile of document.querySelectorAll(".deep-ink-tile")) {
      const rect = tile.getBoundingClientRect();
      const left = Math.max(rect.left, target.left), top = Math.max(rect.top, target.top);
      const right = Math.min(rect.right, target.right), bottom = Math.min(rect.bottom, target.bottom);
      if (right <= left || bottom <= top) continue;
      const x = Math.floor((left - rect.left) / rect.width * tile.width);
      const y = Math.floor((top - rect.top) / rect.height * tile.height);
      const width = Math.min(tile.width - x, Math.ceil((right - left) / rect.width * tile.width));
      const height = Math.min(tile.height - y, Math.ceil((bottom - top) / rect.height * tile.height));
      const pixels = tile.getContext("2d").getImageData(x, y, width, height).data;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
    }
    return count;
  }, selector);
}

async function seedTranslation(page, username, resourceId = null, passageId = null) {
  // Close the reader before seeding: its save boundary pauses the old timer.
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await expect(page.locator(".library-page")).toBeVisible();
  await page.evaluate(({ user, resourceId, passageId }) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const key = resourceId
      ? `${prefix}wuliao:reading-flow:${resourceId}:${passageId}`
      : Object.keys(localStorage).find((key) => key.startsWith(`${prefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(key));
    const ids = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
    flow.stages = Object.fromEntries(ids.map((id, index) => [id, { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? 100 : null }]));
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1200, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(key, JSON.stringify(flow));
  }, { user: username, resourceId, passageId });
}

async function expectIdenticalArticle(page) {
  await expect(page.locator(ARTICLE)).toBeVisible();
  const originals = await page.locator("#deep-clean-text .clean-natural-paragraph").allTextContents();
  expect(originals.length).toBeGreaterThan(0);
  expect(await page.locator(`${ARTICLE} .clean-natural-paragraph`).allTextContents()).toEqual(originals);
  expect(await page.locator(`${ARTICLE} .clean-paragraph-heading`).allTextContents()).toEqual(
    await page.locator("#deep-clean-text .clean-paragraph-heading").allTextContents(),
  );
  expect(await page.locator(ARTICLE).evaluate((article) => article.previousElementSibling.id === "deep-redo" && article.nextElementSibling.id === "deep-review")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, portrait: { width: 768, height: 1024 }, landscape: { width: 1024, height: 768 } })) {
  test(`redo article ${name}: identical body, independent durable ink and unchanged question geometry`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const username = await createAccount(page, uniqueUsername("redo-article"));
    await openOfficialResource(page, TITLE);
    await expect(page.locator(ARTICLE)).toHaveCount(0);
    await clickStageAdvance(page, "开始精读");
    await clickStageAdvance(page, "完成审题，进入初做");
    await draw(page, '#deep-clean-text [data-sentence-scope="clean:p1:s1"]');
    await expect.poll(async () => (await ink(page, username, "deep-first-quiz")).length).toBe(1);
    const initialInk = await ink(page, username, "deep-first-quiz");
    await seedTranslation(page, username);
    await reopen(page);
    await expect(page.locator(ARTICLE)).toHaveCount(0);
    await clickStageAdvance(page, "进入重做");
    await expectIdenticalArticle(page);
    const geometry = await page.locator(ARTICLE).evaluate((article) => {
      const redo = document.getElementById("deep-redo");
      const before = redo.getBoundingClientRect().height;
      article.style.display = "none";
      const withoutArticle = redo.getBoundingClientRect().height;
      article.style.removeProperty("display");
      return { before, withoutArticle };
    });
    expect(geometry.before).toBe(geometry.withoutArticle);
    await page.locator(`${ARTICLE} .clean-paragraph`).first().scrollIntoViewIfNeeded();
    await expect.poll(() => inkPixels(page, ARTICLE)).toBe(0);
    expect(await ink(page, username, "deep-redo")).toEqual([]);
    await draw(page, `${ARTICLE} [data-sentence-scope="redo:p1:s1"]`);
    await expect.poll(async () => (await ink(page, username, "deep-redo")).length).toBe(1);
    const redoInk = await ink(page, username, "deep-redo");
    expect(redoInk[0].deepAnchor.regionId).toMatch(/^sentence:redo:/);
    expect(await ink(page, username, "deep-first-quiz")).toEqual(initialInk);
    await page.locator(".stage-nav button", { hasText: "初做" }).click();
    await page.locator(".stage-nav button", { hasText: "重做" }).click();
    expect(await ink(page, username, "deep-redo")).toEqual(redoInk);
    await reopen(page);
    await expectIdenticalArticle(page);
    await page.locator(`${ARTICLE} .clean-paragraph`).first().scrollIntoViewIfNeeded();
    await expect.poll(() => inkPixels(page, ARTICLE)).toBeGreaterThan(0);
    expect(await ink(page, username, "deep-first-quiz")).toEqual(initialInk);
    expect(await ink(page, username, "deep-redo")).toEqual(redoInk);
    await page.screenshot({ path: path.join(OUTPUT, `${name}.png`) });
    expect(errors).toEqual([]);
  });
}

test("redo article: custom multi-passage material follows passage switching without mixing text", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("redo-custom"));
  const title = "重做正文测试资料";
  const resourceId = "custom:redo-article-fixture";
  await page.evaluate(async ({ username, title, resourceId }) => {
    const passages = ["First", "Second"].map((word, index) => ({
      id: `passage-${index + 1}`, label: `Text ${index + 1}`,
      paragraphs: [{ number: 1, sentences: [`${word} readers compare evidence with the original passage.`, "They preserve the full context, punctuation, and order."] }, { number: 2, sentences: [`${word} explanations should follow the author's argument.`] }],
      questions: [{ id: `q${index + 1}`, number: index + 1, stem: "What do readers compare?", options: ["Evidence", "Weather", "Prices", "Colours"].map((text, optionIndex) => ({ key: "ABCD"[optionIndex], text })) }],
    }));
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction("custom-pdfs", "readwrite");
    tx.objectStore("custom-pdfs").put({ id: resourceId, kind: "custom", category: "custom", target: "reading", username, title, size: 1024, file: new Blob([], { type: "application/pdf" }), addedAt: Date.now(), conversionStatus: "ready", analysis: { method: "text", passages, totals: { questions: 2 }, warnings: [] } });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, { username, title, resourceId });
  await page.reload();
  await expect(page.locator(".home-page")).toBeVisible();
  await navTo(page, "精读");
  await page.getByRole("tab", { name: /自定义库/ }).click();
  await page.locator(".resource-card", { hasText: title }).locator(".resource-open").click();
  await clickStageAdvance(page, "开始精读");
  await seedTranslation(page, username, resourceId, "passage-1");
  await reopen(page, title, true);
  await clickStageAdvance(page, "进入重做");
  await expectIdenticalArticle(page);
  await expect(page.locator(ARTICLE)).toContainText("First readers");
  await page.locator(".passage-switcher button", { hasText: "Text 2" }).click();
  await expect(page.locator(ARTICLE)).toHaveCount(0);
  await clickStageAdvance(page, "开始精读");
  await seedTranslation(page, username, resourceId, "passage-2");
  await reopen(page, title, true);
  await page.locator(".passage-switcher button", { hasText: "Text 2" }).click();
  await clickStageAdvance(page, "进入重做");
  await expectIdenticalArticle(page);
  await expect(page.locator(ARTICLE)).toContainText("Second readers");
  await expect(page.locator(ARTICLE)).not.toContainText("First readers");
  await page.locator(".passage-switcher button", { hasText: "Text 1" }).click();
  await expectIdenticalArticle(page);
  await expect(page.locator(ARTICLE)).toContainText("First readers");
});

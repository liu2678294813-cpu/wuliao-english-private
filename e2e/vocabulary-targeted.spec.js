import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";

async function openMemorize(page) {
  const username = await createAccount(page);
  await navTo(page, "词库");
  await expect(page.locator(".vocabulary-frame.loaded")).toBeVisible();
  await page.goto("/vocabulary/memorize.html");
  await expect(page.locator(".word-row").first()).toBeVisible();
  return username;
}

async function memoryRecord(page, username, listKey, wordId) {
  return page.evaluate(async ({ username, listKey, wordId }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("KaoyanVocabMemorizeDB");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("records").objectStore("records").get(`${username}:${listKey}:${wordId}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, { username, listKey, wordId });
}

test("复习答错和我不会提交真正的 0/3，答对保持 3/3", async ({ page }) => {
  const username = await openMemorize(page);
  const rows = page.locator(".word-row");
  const ids = await Promise.all([0, 1, 2].map((i) => rows.nth(i).getAttribute("data-word-id")));
  for (let i = 0; i < 3; i += 1) {
    for (let click = 0; click < 3; click += 1) {
      await rows.nth(i).locator(".mark-button").click();
      await expect.poll(async () => (await memoryRecord(page, username, "original", ids[i]))?.clickCount).toBe(click + 1);
    }
  }
  await page.goto("/vocabulary/review.html");
  await expect(page.locator("#quiz")).toBeVisible();
  await page.locator("#skipButton").click();
  await expect.poll(async () => (await memoryRecord(page, username, "original", ids[0]))?.lastReviewResult).toBe("wrong");
  await expect(page.locator("#positionLabel")).toContainText("2 / 3");
  await page.locator('.review-option[data-correct="true"]').click();
  await expect(page.locator("#positionLabel")).toContainText("3 / 3");
  await page.locator('.review-option[data-correct="false"]').first().click();
  await expect.poll(async () => (await memoryRecord(page, username, "original", ids[2]))?.lastReviewResult).toBe("wrong");
  await page.goto("/vocabulary/memorize.html");
  const first = page.locator(`.word-row[data-word-id="${ids[0]}"]`);
  await expect(first).not.toHaveClass(/masked/);
  await expect(first.locator(".mark-button")).toHaveText("记录 0/3");
  const wrong = await memoryRecord(page, username, "original", ids[0]);
  expect(wrong.sharedProgress).toEqual({ count: 0, masked: false });
  expect(wrong.modeProgress).toEqual({ default: 0, cycle: 0 });
  expect(wrong.maskedDates.length).toBeGreaterThan(0);
  expect((await memoryRecord(page, username, "original", ids[1])).sharedProgress).toEqual({ count: 3, masked: true });
  expect((await memoryRecord(page, username, "original", ids[2])).sharedProgress).toEqual({ count: 0, masked: false });
  await page.reload();
  await expect(first.locator(".mark-button")).toHaveText("记录 0/3");
});

test("切换词库时加载期间不能覆盖目标词库位置", async ({ page }) => {
  const username = await openMemorize(page);
  await page.evaluate(async (username) => {
    const db = await new Promise((resolve) => { const request = indexedDB.open("KaoyanVocabDB"); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction("wordLists", "readwrite");
    tx.objectStore("wordLists").put({ id: 99881, username, name: "位置测试词库", wordIds: Array.from({ length: 1735 }, (_, i) => `word_${String(i).padStart(4, "0")}`) });
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
  }, username);
  await page.reload();
  await expect(page.locator('#listSelect option[value="list-99881"]')).toHaveCount(1);
  await page.locator("#viewport").evaluate((element) => { element.scrollTop = 800 * 76; });
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76);
  await page.evaluate(async (username) => {
    const key = `kaoyan_vocab_memorize_progress:${username}`;
    const progress = JSON.parse(localStorage.getItem(key));
    progress.scrollPositions["list-99881"] = 120 * 76;
    localStorage.setItem(key, JSON.stringify(progress));
    const db = await new Promise((resolve) => { const request = indexedDB.open("KaoyanVocabMemorizeDB"); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction("records", "readwrite");
    let locked = true;
    window.__releaseVocabularyTestLock = () => { locked = false; };
    const spin = () => {
      const request = tx.objectStore("records").get("absent");
      request.onsuccess = () => { if (locked) spin(); };
    };
    spin();
    tx.oncomplete = () => db.close();
  }, username);
  await page.locator("#listSelect").selectOption("list-99881");
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(0);
  await page.evaluate(() => window.__releaseVocabularyTestLock());
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(120 * 76);
});

async function chooseRangeIndex(page, index) {
  await page.locator("#viewport").evaluate((element, top) => { element.scrollTop = top; }, index * 76);
  await page.locator(`.word-row[data-word-id="word_${String(index).padStart(4, "0")}"] .mark-button`).click();
}

test("区间正向反向均正式完成，已完成词不重复记历史", async ({ page }) => {
  const username = await openMemorize(page);
  await page.locator("#rangeButton").click();
  await chooseRangeIndex(page, 10);
  await chooseRangeIndex(page, 20);
  await expect(page.locator("#rangeDescription")).toContainText("共 11 个词");
  await page.locator("#rangeConfirm").click();
  await expect(page.locator("#rangePanel")).toBeHidden();
  const before = await memoryRecord(page, username, "original", "word_0015");
  expect(before.sharedProgress).toEqual({ count: 3, masked: true });
  expect(before.modeProgress).toEqual({ default: 1, cycle: 5 });
  await page.locator("#rangeButton").click();
  await chooseRangeIndex(page, 20);
  await chooseRangeIndex(page, 10);
  await page.locator("#rangeConfirm").click();
  const after = await memoryRecord(page, username, "original", "word_0015");
  expect(after).toEqual(before);
  for (let index = 10; index <= 20; index += 1) {
    expect((await memoryRecord(page, username, "original", `word_${String(index).padStart(4, "0")}`)).sharedProgress.count).toBe(3);
  }
});

test("区间单事务写入失败时没有任何词被完成", async ({ page }) => {
  const username = await openMemorize(page);
  await page.locator("#rangeButton").click();
  await chooseRangeIndex(page, 30);
  await chooseRangeIndex(page, 40);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "records" && ++calls === 6) throw new Error("injected batch failure");
      return original.apply(this, args);
    };
  });
  await page.locator("#rangeConfirm").click();
  await expect(page.locator("#message")).toContainText("保存失败");
  for (let index = 30; index <= 40; index += 1) {
    expect(await memoryRecord(page, username, "original", `word_${String(index).padStart(4, "0")}`)).toBeUndefined();
  }
  await expect(page.locator("#rangePanel")).toBeVisible();
});

test("大区间只渲染可见行，刷新后仍为 3/3", async ({ page }) => {
  const username = await openMemorize(page);
  await page.locator("#rangeButton").click();
  await chooseRangeIndex(page, 0);
  await chooseRangeIndex(page, 1734);
  await expect(page.locator("#rangeDescription")).toContainText("共 1735 个词");
  await page.locator("#rangeConfirm").click();
  await expect(page.locator("#rangePanel")).toBeHidden();
  expect(await page.locator(".word-row").count()).toBeLessThan(35);
  for (const index of [0, 500, 1734]) {
    const record = await memoryRecord(page, username, "original", `word_${String(index).padStart(4, "0")}`);
    expect(record.sharedProgress).toEqual({ count: 3, masked: true });
    expect(record.maskedDates.length).toBe(1);
  }
  await page.reload();
  const row = page.locator('.word-row[data-word-id="word_1734"]');
  await expect(row).toHaveClass(/masked/);
});

test("背诵控制区移动标题并删除四个入口，复习与发音资料仍可访问", async ({ page }) => {
  await openMemorize(page);
  for (const viewport of [{ width: 832, height: 544 }, { width: 544, height: 832 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".memory-list-controls h2")).toHaveText("背诵");
    const geometry = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const title = rect(".memory-list-controls h2"), list = rect("#listSelect"), modes = rect(".memory-mode-switches");
      return { titleAboveList: title.bottom < list.top, noOverlap: title.right <= modes.left || title.bottom <= modes.top, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry.titleAboveList).toBe(true);
    expect(geometry.noOverlap).toBe(true);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  }
  for (const text of ["学习单词", "今日复习", "当前位置自动保存", "发音来源"]) {
    await expect(page.locator("body")).not.toContainText(text);
  }
  await page.goto("/vocabulary/review.html");
  await expect(page.locator("#dateSelect")).toBeVisible();
  await page.goto("/vocabulary/pronunciation-credits.html");
  await expect(page.locator("body")).toContainText("发音");
});

test("位置恢复权威顺序为 wordId、index、旧 scrollTop", async ({ page }) => {
  const username = await openMemorize(page);
  const setAnchor = async (anchor) => page.evaluate(({ username, anchor }) => {
    const key = `kaoyan_vocab_memorize_progress:${username}`;
    const progress = JSON.parse(localStorage.getItem(key));
    progress.positionAnchors = { original: anchor };
    progress.scrollPositions = { original: 11 * 76 };
    localStorage.setItem(key, JSON.stringify(progress));
  }, { username, anchor });
  await page.goto("/vocabulary/review.html");
  await setAnchor({ wordId: "word_0800", index: 120, offset: 9 });
  await page.goto("/vocabulary/memorize.html");
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76 + 9);
  await page.goto("/vocabulary/review.html");
  await setAnchor({ wordId: "missing", index: 120, offset: 9 });
  await page.goto("/vocabulary/memorize.html");
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(120 * 76 + 9);
  await page.goto("/vocabulary/review.html");
  await setAnchor({ wordId: "missing", index: -1, offset: 9 });
  await page.goto("/vocabulary/memorize.html");
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(11 * 76);
});

test("App 内跨页返回和 iframe 重建保留背诵位置与标题布局", async ({ page }) => {
  await createAccount(page);
  await navTo(page, "背诵");
  const frame = page.frameLocator(".vocabulary-frame");
  await expect(frame.locator(".word-row").first()).toBeVisible();
  await frame.locator("#viewport").evaluate((element) => { element.scrollTop = 800 * 76 + 11; });
  await expect.poll(() => frame.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76 + 11);
  await navTo(page, "复习");
  await expect(frame.locator("#dateSelect")).toBeVisible();
  await navTo(page, "背诵");
  await expect.poll(() => frame.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76 + 11);
  await navTo(page, "精读");
  await navTo(page, "背诵");
  await expect.poll(() => frame.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76 + 11);
  await page.locator(".vocabulary-frame").evaluate((element) => element.contentWindow.location.reload());
  await expect.poll(() => frame.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(800 * 76 + 11);
  for (const size of [{ width: 832, height: 544 }, { width: 544, height: 832 }]) {
    await page.setViewportSize(size);
    await expect(frame.locator(".memory-list-controls h2")).toBeVisible();
    await expect(page.locator(".vocabulary-shell-title")).toHaveCount(0);
    const geometry = await frame.locator(".controls").evaluate((element) => {
      const title = element.querySelector("h2").getBoundingClientRect();
      const list = element.querySelector("#listSelect").getBoundingClientRect();
      const modes = element.querySelector(".memory-mode-switches").getBoundingClientRect();
      return { titleBeforeList: title.bottom < list.top, noOverlap: title.right <= modes.left || title.bottom <= modes.top, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geometry.titleBeforeList).toBe(true);
    expect(geometry.noOverlap).toBe(true);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/vocabulary-title-${size.width}x${size.height}.png` });
  }
});

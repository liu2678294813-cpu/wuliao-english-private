import { test, expect } from "@playwright/test";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function seedVocabularyRecord(page, username) {
  const maskedAt = Date.now() - 86_400_000;
  const maskedDate = localDateKey(maskedAt);
  const reviewDate = localDateKey();
  await page.evaluate(({ user, date, today, timestamp }) => new Promise((resolve, reject) => {
    localStorage.setItem("kaoyan_vocab_current_user", user);
    const open = indexedDB.open("KaoyanVocabMemorizeDB", 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", { keyPath: "memoryKey" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
      if (!db.objectStoreNames.contains("importedLists")) {
        const store = db.createObjectStore("importedLists", { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains("importedWords")) {
        const store = db.createObjectStore("importedWords", { keyPath: "wordId" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        memoryKey: `${user}:original:word_0000`,
        username: user,
        listKey: "original",
        wordId: "word_0000",
        clickCount: 3,
        maskedAt: timestamp,
        maskedDates: [date, today],
        lastReviewDate: "2026-01-01",
        lastReviewResult: "correct",
        reviewedAt: timestamp,
        updatedAt: timestamp,
      });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { user: username, date: maskedDate, today: reviewDate, timestamp: maskedAt });
  return maskedDate;
}

async function readVocabularyRecord(page, username) {
  return page.evaluate((user) => new Promise((resolve, reject) => {
    const open = indexedDB.open("KaoyanVocabMemorizeDB", 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("records", "readonly")
        .objectStore("records")
        .get(`${user}:original:word_0000`);
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
    };
  }), username);
}

test("词汇：3/3 单词答错后严格回到 0/3，并保留历史日期元数据", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("vocab-reset"));
  const maskedDate = await seedVocabularyRecord(page, username);

  await navTo(page, "复习");
  await page.setViewportSize({ width: 544, height: 832 });
  const frame = page.frameLocator(".vocabulary-frame");
  await expect(frame.locator("#wordButton")).toContainText("remote", { timeout: 30000 });
  await frame.locator("#skipButton").click();
  await expect(frame.locator("#answerHint")).toContainText(/正确答案|remote/);

  const downgraded = await readVocabularyRecord(page, username);
  expect(downgraded.clickCount).toBe(0);
  expect(downgraded.maskedAt).toBeTruthy();
  expect(downgraded.maskedDates).toContain(maskedDate);
  expect(downgraded.lastReviewResult).toBe("wrong");
  expect(downgraded.lastReviewDate).toBe(localDateKey());

  await page.locator(".ds-bottom-nav button", { hasText: "背诵" }).click();
  await expect(frame.locator("#listSelect")).toHaveValue("original", { timeout: 30000 });
  const firstRow = frame.locator(".word-row").first();
  await expect(firstRow).toContainText("remote");
  await expect(firstRow.locator(".mark-button")).toHaveText("记录 0/3");

  const portraitGeometry = await frame.locator("body").evaluate((body) => ({
    scrollWidth: body.scrollWidth,
    clientWidth: body.clientWidth,
  }));
  expect(portraitGeometry.scrollWidth).toBeLessThanOrEqual(portraitGeometry.clientWidth + 1);
});

test("Exam：832×544 三行头部紧凑且计时、交卷、工具栏均无重叠溢出", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page, uniqueUsername("exam-832"));
  await navTo(page, "模拟");
  await page.getByRole("button", { name: /^2007 / }).click();
  const start = page.getByRole("button", { name: "开始计时" });
  await expect(start).toBeEnabled({ timeout: 120000 });
  await start.click();
  await expect(page.locator(".exam-session")).toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel("剩余时间")).toBeVisible();
  await expect(page.getByRole("button", { name: "交卷" })).toBeVisible();
  await expect(page.locator(".exam-session > .annotation-toolbar")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height } : null;
    };
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      header: rect(".exam-session-header"),
      status: rect(".exam-status-bar"),
      toolbar: rect(".exam-session > .annotation-toolbar"),
      navigator: rect(".exam-navigator"),
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  for (const key of ["header", "status", "toolbar", "navigator"]) expect(geometry[key]).toBeTruthy();
  expect(geometry.header.bottom).toBeLessThanOrEqual(geometry.status.top + 1);
  expect(geometry.status.bottom).toBeLessThanOrEqual(geometry.toolbar.top + 1);
  expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.navigator.top + 1);
  expect(geometry.toolbar.height).toBeLessThan(150);
});

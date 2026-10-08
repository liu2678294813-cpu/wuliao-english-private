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

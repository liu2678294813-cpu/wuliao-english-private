import { test, expect } from "@playwright/test";
import { createAccount, navTo, openOfficialResource, clickStageAdvance } from "./helpers.js";

async function writeUnknown(page, username, rows = [], deletes = []) {
  await page.evaluate(async ({ username, rows, deletes }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("unknown-words", "readwrite"), store = tx.objectStore("unknown-words");
    for (const id of deletes) store.delete(id);
    for (const row of rows) store.put({ username, createdAt: 1, ...row });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    window.dispatchEvent(new CustomEvent("wuliao:unknown-words-updated"));
    window.dispatchEvent(new CustomEvent("wuliao:unknown-words-refresh", { detail: { username } }));
  }, { username, rows, deletes });
}

async function openUnknown(page, rows = []) {
  const username = await createAccount(page);
  await writeUnknown(page, username, rows);
  await page.goto("/vocabulary/memorize.html?list=unknown-words");
  await expect(page.locator("#listSelect")).toHaveValue("unknown-words");
  await expect(page.locator("#listSelect")).toBeEnabled();
  return username;
}
const issue = { id: "issue-reading", word: "Issue", normalizedWord: "issue", meaning: "问题" };
const rowFor = (page, wordId = "unknown:issue") => page.locator('.word-row[data-word-id="' + wordId + '"]');

async function memoryRecord(page, username, wordId = "unknown:issue") {
  return page.evaluate(async ({ username, wordId }) => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("KaoyanVocabMemorizeDB"); request.onsuccess = () => resolve(request.result);
    });
    const value = await new Promise((resolve) => {
      const request = db.transaction("records").objectStore("records").get(username + ":unknown-words:" + wordId);
      request.onsuccess = () => resolve(request.result || null);
    });
    db.close(); return value;
  }, { username, wordId });
}
async function swipe(page, direction) {
  await rowFor(page).locator(".word-content").evaluate(async (element, direction) => {
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 17, isPrimary: true, pointerType: "touch", button: 0, clientX: x, clientY: y,
    }));
    element.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 17, isPrimary: true, pointerType: "touch", button: 0,
      clientX: x + (direction === "right" ? 100 : -100), clientY: y,
    }));
    await new Promise(requestAnimationFrame);
  }, direction);
}

test("空陌生词库可选择，切回原始词库安全", async ({ page }) => {
  await openUnknown(page);
  await expect(page.locator('#listSelect option[value="unknown-words"]')).toHaveText("陌生词库（0词）");
  await expect(page.locator(".word-row")).toHaveCount(0);
  await expect(page.locator("#listSummary")).toContainText("陌生词库为空");
  await page.locator("#listSelect").selectOption("original");
  await expect(page.locator(".word-row").first()).toBeVisible();
});

test("多来源去重和多义合并，phrase 使用现有发音入口", async ({ page }) => {
  await openUnknown(page, [issue, { ...issue, id: "issue-cloze", meaning: "议题", createdAt: 2,
    senses: [{ contextKey: "s", meaning: "发行", meaningSource: "manual-context" }] },
    { id: "phrase", word: "take account of", meaning: "考虑到" }]);
  await expect(page.locator('#listSelect option[value="unknown-words"]')).toHaveText("陌生词库（2词）");
  await expect(rowFor(page).locator(".chinese")).toHaveText("问题；议题；发行");
  await expect(page.locator('.english', { hasText: /^issue$/ })).toHaveCount(1);
  await page.evaluate(() => {
    window.WuliaoPronunciation = { speak: (word) => { window.__spokenWord = word; return Promise.resolve(); } };
  });
  await rowFor(page, "unknown:take account of").locator(".english").click();
  await expect.poll(() => page.evaluate(() => window.__spokenWord)).toBe("take account of");
});

test("2/3 重载及删除重加恢复，清空当前列表不清除隐藏历史", async ({ page }) => {
  const username = await openUnknown(page, [issue, { id: "another", word: "zebra", meaning: "斑马" }]);
  for (let count = 1; count <= 2; count++) {
    await rowFor(page).locator(".mark-button").click();
    await expect.poll(async () => (await memoryRecord(page, username))?.clickCount).toBe(count);
  }
  await page.reload();
  await expect(rowFor(page).locator(".mark-button")).toHaveText("记录 2/3");
  await writeUnknown(page, username, [], ["issue-reading"]);
  await expect(rowFor(page)).toHaveCount(0);
  await rowFor(page, "unknown:zebra").locator(".mark-button").click();
  await expect.poll(async () => (await memoryRecord(page, username, "unknown:zebra"))?.clickCount).toBe(1);
  await page.locator("#clearButton").click();
  await expect.poll(async () => (await memoryRecord(page, username, "unknown:zebra"))?.clickCount).toBe(0);
  expect((await memoryRecord(page, username)).clickCount).toBe(2);
  await writeUnknown(page, username, [{ ...issue, id: "new-source", word: "ISSUE" }]);
  await expect(rowFor(page).locator(".mark-button")).toHaveText("记录 2/3");
  await expect(page.locator("#maskSummary")).toHaveText("已遮挡 0 个");
});

for (const rule of ["default", "cycle"]) for (const input of ["click", "swipe"]) {
  test("陌生词统一模式 " + rule + "/" + input + " 完成、撤销及重载", async ({ page }) => {
    const username = await openUnknown(page, [issue]);
    await page.locator('[data-memory-rule="' + rule + '"]').click();
    await page.locator('[data-memory-input="' + input + '"]').click();
    const steps = input === "click"
      ? (rule === "cycle" ? ["click", "click", "click", "click", "click"] : ["click", "click", "click"])
      : (rule === "cycle" ? ["right", "left", "right", "left", "right"] : ["right"]);
    for (const step of steps) {
      if (step === "click") await rowFor(page).locator(".mark-button").click();
      else await swipe(page, step);
      await expect.poll(async () => Boolean(await memoryRecord(page, username))).toBe(true);
      await expect(page.locator("#undoButton")).toBeEnabled();
    }
    await expect.poll(async () => (await memoryRecord(page, username))?.sharedProgress).toEqual({ count: 3, masked: true });
    await expect(page.locator("#todaySummary")).toHaveText("今日背词 1 个");
    await page.locator("#undoButton").click();
    await expect.poll(async () => (await memoryRecord(page, username))?.sharedProgress.masked).toBe(false);
    const lastStep = steps.at(-1);
    if (lastStep === "click") await rowFor(page).locator(".mark-button").click();
    else await swipe(page, lastStep);
    await expect.poll(async () => (await memoryRecord(page, username))?.sharedProgress).toEqual({ count: 3, masked: true });
    await page.reload();
    await expect(rowFor(page)).toHaveClass(/masked/);
    await expect(page.locator("#maskSummary")).toHaveText("已遮挡 1 个");
  });
}

test("陌生词区间完成和撤销复用统一保存，无变化刷新保持选择", async ({ page }) => {
  const username = await openUnknown(page, [issue, { id: "another", word: "zebra", meaning: "斑马" }]);
  await page.locator("#rangeButton").click();
  await rowFor(page).locator(".mark-button").click();
  await rowFor(page, "unknown:zebra").locator(".mark-button").click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator("#rangePanel")).toBeVisible();
  await expect(page.locator("#rangeDescription")).toContainText("共 2 个词");
  await page.locator("#rangeConfirm").click();
  await expect.poll(async () => (await memoryRecord(page, username))?.sharedProgress.count).toBe(3);
  await page.locator("#undoButton").click();
  await expect.poll(async () => (await memoryRecord(page, username))?.sharedProgress.count).toBe(0);
  await expect.poll(async () => (await memoryRecord(page, username, "unknown:zebra"))?.sharedProgress.count).toBe(0);
});

test("账号数量和 progress 隔离，不复制到导入词表", async ({ page }) => {
  const username = await openUnknown(page, [issue]);
  await rowFor(page).locator(".mark-button").click();
  await expect.poll(async () => (await memoryRecord(page, username))?.clickCount).toBe(1);
  await page.evaluate(() => localStorage.setItem("kaoyan_vocab_current_user", "isolated-user-b"));
  await page.reload();
  await expect(page.locator('#listSelect option[value="unknown-words"]')).toHaveText("陌生词库（0词）");
  expect(await memoryRecord(page, "isolated-user-b")).toBeNull();
  expect(await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("KaoyanVocabMemorizeDB"); r.onsuccess = () => resolve(r.result); });
    const rows = await Promise.all(["importedLists", "importedWords"].map((name) => new Promise((resolve) => {
      const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result);
    })));
    db.close(); return rows;
  })).toEqual([[], []]);
  await page.evaluate((username) => localStorage.setItem("kaoyan_vocab_current_user", username), username);
  await page.reload();
  await expect(rowFor(page).locator(".mark-button")).toHaveText("记录 1/3");
});

test("Review 解析陌生词与干扰选项，删除来源跳过，答错退回统一进度", async ({ page }) => {
  const username = await openUnknown(page, [issue, { id: "deleted", word: "zebra", meaning: "斑马" }]);
  for (const id of ["unknown:issue", "unknown:zebra"]) {
    for (let i = 0; i < 3; i++) {
      await rowFor(page, id).locator(".mark-button").click();
      await expect.poll(async () => (await memoryRecord(page, username, id))?.clickCount).toBe(i + 1);
    }
  }
  await writeUnknown(page, username, [], ["deleted"]);
  await page.goto("/vocabulary/review.html");
  await expect(page.locator("#wordButton")).toHaveText("issue");
  await expect(page.locator("#positionLabel")).toHaveText("1 / 1");
  await expect(page.locator(".review-option")).toHaveCount(12);
  await page.locator("#skipButton").click();
  await expect.poll(async () => (await memoryRecord(page, username))?.clickCount).toBe(0);
  expect((await memoryRecord(page, username, "unknown:zebra")).clickCount).toBe(3);
  await writeUnknown(page, username, [], ["issue-reading"]);
  await page.reload();
  await expect(page.locator("#emptyState")).toBeVisible();
});

test("保持 iframe 时通过可信 bridge 刷新，返回背诵无需重启", async ({ page }) => {
  const username = await createAccount(page);
  await navTo(page, "背诵");
  const frame = page.frameLocator(".vocabulary-frame");
  await frame.locator("#listSelect").selectOption("unknown-words");
  await writeUnknown(page, username, [issue]);
  await expect(frame.locator('.word-row[data-word-id="unknown:issue"]')).toBeVisible();
  await expect(frame.locator('#listSelect option[value="unknown-words"]')).toHaveText("陌生词库（1词）");
  await navTo(page, "首页");
  await writeUnknown(page, username, [{ id: "phrase", word: "take account of", meaning: "考虑到" }]);
  await navTo(page, "背诵");
  await frame.locator("#listSelect").selectOption("unknown-words");
  await expect(frame.locator('#listSelect option[value="unknown-words"]')).toHaveText("陌生词库（2词）");
});

test("打开失败独立提示，不影响内置词库", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kaoyan_vocab_current_user", "read-failure-user");
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, ...args) => {
      if (name === "wuliao-english") throw new Error("isolated read failure");
      return original(name, ...args);
    };
  });
  await page.goto("/vocabulary/memorize.html?list=unknown-words");
  await expect(page.locator("#listSummary")).toContainText("陌生词库读取失败");
  await page.locator("#listSelect").selectOption("original");
  await expect(page.locator(".word-row").first()).toBeVisible();
});

test("缺源数据库不会创建库，缺 store 不升级 schema", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kaoyan_vocab_current_user", "missing-source"));
  await page.goto("/vocabulary/memorize.html?list=unknown-words");
  await expect(page.locator("#listSelect")).toBeEnabled();
  await expect(page.locator("#listSummary")).toContainText("陌生词库为空");
  expect(await page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === "wuliao-english"))).toBe(false);
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("wuliao-english", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("unrelated");
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator("#listSelect")).toBeEnabled();
  expect(await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result);
    });
    const result = { version: db.version, stores: [...db.objectStoreNames] };
    db.close(); return result;
  })).toEqual({ version: 1, stores: ["unrelated"] });
});

test("保存中连续刷新等待提交，释义更新保持 1/3", async ({ page }) => {
  const username = await openUnknown(page, [issue]);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name === "KaoyanVocabMemorizeDB" && args[1] === "readwrite") {
        Object.defineProperty(tx, "oncomplete", { set(handler) {
          tx.addEventListener("complete", (event) => setTimeout(() => handler(event), 350), { once: true });
        } });
      }
      return tx;
    };
  });
  await rowFor(page).locator(".mark-button").click();
  await writeUnknown(page, username, [{ id: "new", word: "zebra", meaning: "斑马" },
    { ...issue, meaning: "问题；议题" }]);
  await page.evaluate((username) => {
    for (let i = 0; i < 8; i++) window.dispatchEvent(new CustomEvent("wuliao:unknown-words-refresh", { detail: { username } }));
  }, username);
  await expect(rowFor(page).locator(".mark-button")).toHaveText("记录 1/3");
  await expect(rowFor(page).locator(".chinese")).toHaveText("问题；议题");
  await expect(rowFor(page, "unknown:zebra")).toBeVisible();
  expect((await memoryRecord(page, username)).clickCount).toBe(1);
});

test("动态重排按 wordId 保持滚动锚点，锚点删除时位置有效", async ({ page }) => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: "source-" + i,
    word: "term" + String(i).padStart(3, "0") + "word", meaning: "释义" + i }));
  const username = await openUnknown(page, rows);
  await page.locator("#viewport").evaluate((element) => { element.scrollTop = 40 * 76 + 9; });
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(40 * 76 + 9);
  await writeUnknown(page, username, [{ id: "a", word: "aardvark", meaning: "土豚" }]);
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(41 * 76 + 9);
  await writeUnknown(page, username, [], ["source-40"]);
  await expect(page.locator("#listSelect")).toBeEnabled();
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(41 * 76 + 9);
  await page.reload();
  await expect.poll(() => page.locator("#viewport").evaluate((element) => element.scrollTop)).toBe(41 * 76 + 9);
});

test("迟到读取不能把旧账号词条带入新账号", async ({ page }) => {
  const username = await openUnknown(page, [issue]);
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, ...args) => {
      const request = original(name, ...args);
      if (name !== "wuliao-english") return request;
      const wrapper = {};
      request.onsuccess = () => setTimeout(() => {
        wrapper.result = request.result;
        wrapper.onsuccess?.();
      }, 400);
      request.onerror = () => { wrapper.error = request.error; wrapper.onerror?.(); };
      return wrapper;
    };
    window.dispatchEvent(new Event("focus"));
    localStorage.setItem("kaoyan_vocab_current_user", "late-read-user-b");
    window.dispatchEvent(new StorageEvent("storage", { key: "kaoyan_vocab_current_user", newValue: "late-read-user-b" }));
  });
  await expect(page.locator("#accountLabel")).toHaveText("late-read-user-b");
  await expect(page.locator("#listSelect")).toBeEnabled();
  await expect(page.locator(".word-row")).toHaveCount(0);
  expect(await memoryRecord(page, "late-read-user-b")).toBeNull();
  expect(await memoryRecord(page, username)).toBeNull();
});

test("缺释义可背诵，复习跳过；补齐释义后立即可复习且优先本库干扰项", async ({ page }) => {
  const username = await openUnknown(page, [{ ...issue, meaning: "" }, { id: "distractor", word: "zebra", meaning: "陌生词干扰义" }]);
  await expect(rowFor(page).locator(".chinese")).toHaveText("暂无释义");
  for (let i = 1; i <= 3; i++) {
    await rowFor(page).locator(".mark-button").click();
    await expect.poll(async () => (await memoryRecord(page, username))?.clickCount).toBe(i);
  }
  await page.goto("/vocabulary/review.html");
  await expect(page.locator("#emptyState")).toBeVisible();
  await writeUnknown(page, username, [{ ...issue, meaning: "问题" }]);
  await expect(page.locator("#wordButton")).toHaveText("issue");
  await expect(page.locator(".review-option")).toHaveCount(12);
  await expect(page.locator(".review-option", { hasText: "陌生词干扰义" })).toBeVisible();
  await writeUnknown(page, username, [], ["issue-reading"]);
  await expect(page.locator("#emptyState")).toBeVisible();
});

test("实际精读加词后返回背诵立即显示，截图与 console 验收", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const username = await createAccount(page);
  await page.screenshot({ path: testInfo.outputPath("home-wide.png") });
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await clickStageAdvance(page, "开始精读");
  await page.evaluate((username) => {
    const prefix = "wuliao:user:" + encodeURIComponent(username) + ":";
    const key = Object.keys(localStorage).find((key) => key.startsWith(prefix + "wuliao:reading-flow:"));
    const flow = JSON.parse(localStorage.getItem(key));
    for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) {
      flow.stages[id] = { status: "completed", completedAt: 100 };
    }
    flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(key, JSON.stringify(flow));
  }, username);
  await page.reload();
  await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
  const scope = page.locator('.sentence-source [data-unknown-scope]').first();
  await scope.scrollIntoViewIfNeeded();
  const token = await scope.evaluate(async (element) => {
    await document.fonts.ready;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const match = /[A-Za-z]+/.exec(node.data);
      if (!match) continue;
      const range = document.createRange();
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const box = range.getBoundingClientRect();
      return { word: match[0].toLowerCase(), x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect.poll(() => page.evaluate(async (username) => {
    const { readUnknownWordList } = await import("/vocabulary/unknown-word-list.js");
    return (await readUnknownWordList(username)).words.length;
  }, username)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("reader-toolbar-no-clear.png") });
  await page.locator(".reader-header .back-button").first().click();
  await expect(page.locator(".library-page")).toBeVisible();
  await navTo(page, "背诵");
  const frame = page.frameLocator(".vocabulary-frame");
  await frame.locator("#listSelect").selectOption("unknown-words");
  await expect(frame.locator(".english")).toHaveText(token.word);
  await expect(frame.locator("#listSelect")).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("unknown-memorize-wide.png") });
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(frame.locator(".english")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("unknown-memorize-narrow.png") });
  expect(errors).toEqual([]);
});

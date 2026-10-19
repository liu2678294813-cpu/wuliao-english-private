import { test, expect } from "@playwright/test";
import { createAccount, navTo } from "./helpers.js";

const EVIDENCE = "D:/codex库/01_无聊英语项目/无聊英语-重难句验收-20261019";
const RESOURCE = "custom-sentence-review-e2e", PASSAGE = "sentence-passage";
function keyFor(text, index) {
  let hash = 5381;
  for (const char of text.toLowerCase()) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  return `p1s${index + 1}:x${(hash >>> 0).toString(36)}`;
}
const SENTENCES = Array.from({ length: 23 }, (_, index) => `Although the evidence in case ${index + 1} was incomplete, the committee that reviewed the proposals approved the plan.`);
const KEYS = SENTENCES.map(keyFor);
const scoped = (user, key) => `wuliao:user:${encodeURIComponent(user)}:${key}`;
async function rows(page, store) {
  return page.evaluate(async name => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
  }, store);
}
async function seed(page, user, count = 8) {
  await page.evaluate(async ({ user, resourceId, passageId, sentences, keys, count }) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`, now = Date.now();
    const progress = { schemaVersion: 1, resourceId, passageId, updatedAt: now, paragraphs: {}, sentences: {} };
    sentences.forEach((text, index) => {
      progress.sentences[keys[index]] = { translationStatus: "corrected", reviewStatus: index < count ? "needs_review" : null, translatedAt: now - 3000, correctedAt: now - 2000, reviewedAt: index < count ? now - index : null, translationFingerprint: `original-translation-${index}` };
      localStorage.setItem(`${prefix}wuliao:deep-translation:${resourceId}:${passageId}:1:${index}`, `上次笔译，仅供核对 ${index + 1}`);
    });
    localStorage.setItem(`${prefix}wuliao:translation-progress:${resourceId}:${passageId}`, JSON.stringify(progress));
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("custom-pdfs", "readwrite");
        tx.objectStore("custom-pdfs").put({ id: resourceId, username: user, title: "重难句隔离测试资料", kind: "custom", category: "custom", year: 2023, conversionStatus: "ready", addedAt: now,
          analysis: { title: "重难句隔离测试资料", passages: [{ id: passageId, label: "Text A", text: sentences.join(" "), paragraphs: [{ number: 1, text: sentences.join(" "), sentences }], questions: [], correctAnswers: {} }] } });
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { user, resourceId: RESOURCE, passageId: PASSAGE, sentences: SENTENCES, keys: KEYS, count });
}
async function warehouse(page) {
  await navTo(page, "精读");
  const buttons = page.locator(".library-header-actions button");
  await expect(buttons.nth(0)).toHaveText("重难句仓库"); await expect(buttons.nth(1)).toHaveText("陌生词库");
  await buttons.nth(0).click();
  await expect(page.getByTestId("sentence-library")).toBeVisible();
  await expect(page.locator(".sr-sentence-card").first()).toBeVisible();
}
async function openFirst(page) {
  await page.locator(".sr-sentence-card").first().click();
  await expect(page.getByTestId("sentence-review-workspace")).toBeVisible();
  await expect(page.locator(".sr-paper")).toBeVisible();
}
async function setup(page, count = 8) { const user = await createAccount(page); await seed(page, user, count); await warehouse(page); return user; }
async function originalState(page, user) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`));
}

test("自动汇总 8→9、去重、分页搜索及资料库双入口", async ({ page }) => {
  const user = await setup(page);
  await expect(page.locator(".sr-sentence-card")).toHaveCount(8);
  await page.evaluate(({ key, sentenceKey }) => {
    const progress = JSON.parse(localStorage.getItem(key)); progress.sentences[sentenceKey].reviewStatus = "needs_review"; progress.sentences[sentenceKey].reviewedAt = Date.now();
    localStorage.setItem(key, JSON.stringify(progress)); window.dispatchEvent(new CustomEvent("wuliao:learning-state-invalidated"));
  }, { key: scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`), sentenceKey: KEYS[8] });
  await expect(page.locator(".sr-sentence-card")).toHaveCount(9);
  await page.reload(); await expect(page.locator(".sr-sentence-card")).toHaveCount(9);
  await page.getByLabel("搜索重难句").fill("case 9 "); await expect(page.locator(".sr-sentence-card")).toHaveCount(1);
  await page.screenshot({ path: `${EVIDENCE}/01-library-desktop.png` });
  await page.getByLabel("搜索重难句").fill("");
  await seed(page, user, 23); await page.reload(); await expect(page.locator(".sr-sentence-card")).toHaveCount(20);
  await page.getByRole("button", { name: /再显示 20 句/ }).click(); await expect(page.locator(".sr-sentence-card")).toHaveCount(23);
  await navTo(page, "完形"); await page.getByRole("button", { name: "重难句仓库", exact: true }).click();
  await expect(page.getByRole("tab", { name: /需复盘/ })).toContainText("23");
});

test("键入草稿、隐藏核对内容、换句和刷新恢复，以及浏览器返回", async ({ page }) => {
  const user = await setup(page); await openFirst(page);
  await expect(page.getByText("上次笔译，仅供核对 1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "键盘输入", exact: true }).click();
  await page.getByLabel("我的复盘译文").fill("本轮独立翻译，应当保留。");
  await page.getByRole("button", { name: "下一句", exact: true }).click(); await expect(page.locator(".sr-position")).toHaveText("第 2 / 8 句");
  await page.getByRole("button", { name: "上一句", exact: true }).click();
  await expect(page.getByLabel("我的复盘译文")).toHaveValue("本轮独立翻译，应当保留。");
  await page.getByRole("button", { name: "查看原记录", exact: true }).click();
  await expect(page.getByText("上次笔译，仅供核对 1", { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel("我的复盘译文")).toHaveValue("本轮独立翻译，应当保留。");
  expect((await originalState(page, user)).sentences[KEYS[0]].reviewStatus).toBe("needs_review");
  await page.goBack(); await expect(page.getByTestId("sentence-review-workspace")).toBeVisible();
  await page.getByRole("button", { name: "← 仓库", exact: true }).click(); await expect(page.getByTestId("sentence-library")).toBeVisible();
});

test("手写在左右上下、分隔线缩放、旋转及离线重开后保持原坐标", async ({ page, context }) => {
  await setup(page); await openFirst(page);
  const box = await page.locator(".sr-paper").boundingBox();
  await page.mouse.move(box.x + 30, box.y + 65); await page.mouse.down();
  await page.mouse.move(box.x + Math.min(220, box.width - 30), box.y + 110, { steps: 14 }); await page.mouse.up();
  await expect.poll(async () => (await rows(page, "sentence-review-ink"))[0]?.strokes.length || 0).toBeGreaterThan(0);
  const originalInk = (await rows(page, "sentence-review-ink"))[0].strokes;
  await page.getByLabel("切换双区布局").click(); await expect(page.locator(".writing-split-workspace")).toHaveAttribute("data-writing-layout", "stacked");
  await page.setViewportSize({ width: 820, height: 1180 });
  const divider = await page.getByRole("separator").boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 7); await page.mouse.down(); await page.waitForTimeout(380);
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 50, { steps: 8 }); await page.mouse.up();
  await page.screenshot({ path: `${EVIDENCE}/03-workspace-tablet-stacked.png` });
  await page.reload(); await expect(page.locator(".sr-paper")).toBeVisible();
  expect((await rows(page, "sentence-review-ink"))[0].strokes).toEqual(originalInk);
  await context.setOffline(true);
  await page.getByRole("button", { name: "下一句", exact: true }).click(); await expect(page.locator(".sr-position")).toContainText("第 2");
  await page.getByRole("button", { name: "上一句", exact: true }).click(); await expect(page.locator(".sr-paper")).toBeVisible();
  expect((await rows(page, "sentence-review-ink"))[0].strokes).toEqual(originalInk);
  await context.setOffline(false);
});

test("复盘通过写回原文，重新入库空白新轮次，历史只读", async ({ page }) => {
  const user = await setup(page); await openFirst(page);
  await page.getByRole("button", { name: "键盘输入", exact: true }).click(); await page.getByLabel("我的复盘译文").fill("第一轮译文留档");
  await page.getByRole("button", { name: "现在能独立理解", exact: true }).click();
  await expect(page.getByText("本轮：现在能独立理解", { exact: true })).toBeVisible();
  expect((await originalState(page, user)).sentences[KEYS[0]].reviewStatus).toBe("mastered");
  expect((await originalState(page, user)).sentences[KEYS[1]].reviewStatus).toBe("needs_review");
  await expect(page.getByRole("button", { name: "重新加入复盘", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新加入复盘", exact: true }).click();
  await page.getByRole("button", { name: "键盘输入", exact: true }).click(); await expect(page.getByLabel("我的复盘译文")).toHaveValue("");
  expect((await rows(page, "sentence-review-attempts")).length).toBe(2);
  await page.getByLabel("查看练习记录").selectOption((await rows(page, "sentence-review-attempts")).find(item => item.status === "completed").id);
  await expect(page.getByLabel("我的复盘译文")).toHaveValue("第一轮译文留档"); await expect(page.getByLabel("我的复盘译文")).toHaveAttribute("readonly", "");
  expect((await originalState(page, user)).sentences[KEYS[0]].reviewStatus).toBe("needs_review");
});

test("保存失败阻止换句，重试成功后草稿保留", async ({ page }) => {
  await setup(page); await openFirst(page); await page.getByRole("button", { name: "键盘输入", exact: true }).click();
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    window.__restoreSentenceTransaction = () => { IDBDatabase.prototype.transaction = original; };
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (String(stores).includes("sentence-review-attempts") && mode === "readwrite") throw new DOMException("模拟存储空间不足", "QuotaExceededError");
      return original.call(this, stores, mode, ...rest);
    };
  });
  await page.getByLabel("我的复盘译文").fill("保存失败后仍保留的草稿");
  await page.getByRole("button", { name: "下一句", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("模拟存储空间不足");
  await expect(page.locator(".sr-position")).toHaveText("第 1 / 8 句");
  await page.evaluate(() => window.__restoreSentenceTransaction());
  await page.getByRole("button", { name: "下一句", exact: true }).click(); await page.getByRole("button", { name: "上一句", exact: true }).click();
  await expect(page.getByLabel("我的复盘译文")).toHaveValue("保存失败后仍保留的草稿");
});

test("原文被修改时保留草稿并阻止结果写回", async ({ page }) => {
  const user = await setup(page); await openFirst(page);
  await page.evaluate(async resourceId => {
    const db = await new Promise(resolve => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("custom-pdfs", "readwrite"), store = tx.objectStore("custom-pdfs"), request = store.get(resourceId);
      request.onsuccess = () => { const resource = request.result; resource.analysis.passages[0].paragraphs[0].sentences[0] = "This original sentence has changed."; store.put(resource); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  }, RESOURCE);
  await page.getByRole("button", { name: "现在能独立理解", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("原句来源已变化");
  expect((await originalState(page, user)).sentences[KEYS[0]].reviewStatus).toBe("needs_review");
  expect((await rows(page, "sentence-review-attempts"))[0].status).toBe("draft");
});

test("桌面和平板页面身份、无错误覆盖层、控制台及布局视觉检查", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const consoleIssues = []; page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleIssues.push(message.text()); });
  let aiRequests = 0; page.on("request", request => { if (/api\.(openai|deepseek)|\/chat\/completions/.test(request.url())) aiRequests++; });
  await setup(page); await openFirst(page);
  await expect(page).toHaveURL(/#\/sentence-library\//); await expect(page).toHaveTitle(/无聊英语/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  for (const [name, width, height] of [["desktop", 1440, 900], ["tablet", 1180, 820], ["portrait", 820, 1180]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `${EVIDENCE}/02-workspace-${name}.png` });
    const geometry = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.documentElement.scrollWidth,
      footer: document.querySelector(".sr-review-footer").getBoundingClientRect().bottom, height: window.innerHeight }));
    expect(geometry.body).toBeLessThanOrEqual(geometry.viewport + 1); expect(geometry.footer).toBeLessThanOrEqual(geometry.height + 1);
  }
  expect(errors).toEqual([]); expect(consoleIssues).toEqual([]); expect(aiRequests).toBe(0);
});

test("手机沿用键盘输入策略且上下布局无横向溢出", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Desktop Chrome's client hints otherwise contradict the emulated phone UA.
  await context.addInitScript(() => Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { mobile: true } }));
  const page = await context.newPage();
  try {
    const user = await createAccount(page); await seed(page, user);
    await page.goto("/#/sentence-library"); await page.locator(".sr-sentence-card").first().click();
    await expect(page.getByLabel("我的复盘译文")).toBeVisible();
    await expect(page.getByRole("button", { name: "手写", exact: true })).toBeDisabled();
    await page.getByLabel("切换双区布局").click();
    await page.getByLabel("我的复盘译文").fill("手机上的独立译文");
    await page.getByRole("button", { name: "下一句", exact: true }).click();
    await expect(page.locator(".sr-position")).toContainText("第 2");
    await page.screenshot({ path: `${EVIDENCE}/04-workspace-phone.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const footer = await page.locator(".sr-review-footer").boundingBox();
    const nav = await page.locator(".ds-bottom-nav").boundingBox();
    expect(footer.y + footer.height).toBeLessThanOrEqual(nav.y);
    await expect(page.getByRole("button", { name: "现在能独立理解", exact: true })).toBeInViewport();
  } finally { await context.close(); }
});

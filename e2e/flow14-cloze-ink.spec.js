import { test, expect } from "@playwright/test";
import { clickClozeAction, clickClozeBlank, createAccount, openOfficialCloze, setScopedJson } from "./helpers.js";

// Flow 14：X1.1 普通完形正式笔系统（Shared Ink Runtime）。
// 1) 初做 → 写字 → 切 Blank → 笔迹保留 → reload → 笔迹保留
// 2) undo / 双笔迹 / lasso 圈选删除
// 3) 跨阶段（self-review / correction / analysis / final-read）canonical geometry 稳定（修改 1/2/8）

const RESOURCE_ID = "postgraduate-2007-cloze";

function stageCompleted(now) {
  return { status: "completed", completedAt: now };
}

function seedFlow(page, username, currentStage, now, extra = {}) {
  return setScopedJson(page, username, `wuliao:cloze-flow:${RESOURCE_ID}:${RESOURCE_ID}`, {
    schemaVersion: 1,
    resourceId: RESOURCE_ID,
    clozeId: RESOURCE_ID,
    stages: {
      "cloze-cover": stageCompleted(now),
      "cloze-first-attempt": stageCompleted(now),
      "cloze-self-review": stageCompleted(now),
      "cloze-correction": stageCompleted(now),
      "cloze-analysis": { status: "pending", completedAt: null },
      "cloze-final-read": { status: "pending", completedAt: null },
      ...extra.stages,
    },
    currentStage,
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });
}

function seedProgress(page, username, { firstSubmitted = false, attempts = {} } = {}) {
  return setScopedJson(page, username, `wuliao:cloze-progress:${RESOURCE_ID}:${RESOURCE_ID}`, {
    schemaVersion: 2,
    resourceId: RESOURCE_ID,
    clozeId: RESOURCE_ID,
    attempts,
    activeBlank: 1,
    firstSubmitted,
    reviewSubmitted: false,
    updatedAt: Date.now(),
  });
}

async function readInk(page, username) {
  return page.evaluate((user) => new Promise((resolve, reject) => {
    const open = indexedDB.open("wuliao-english");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("reader-ink").objectStore("reader-ink").index("username").getAll(user);
      request.onsuccess = () => { db.close(); resolve(request.result.filter((row) => row.key.startsWith("wuliao:cloze-ink:v1:")).map((row) => ({ key: row.key, value: JSON.parse(row.value) }))); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), username);
}

async function drawStroke(page, box, from = [0.25, 0.2], to = [0.45, 0.35]) {
  const startX = box.x + box.width * from[0];
  const startY = box.y + box.height * from[1];
  const endX = box.x + box.width * to[0];
  const endY = box.y + box.height * to[1];
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(450); // 等待 debounce 保存
}

async function passageBox(page) {
  const passage = page.locator(".cloze-passage");
  await expect(passage).toBeVisible();
  return passage.boundingBox();
}

async function anchorGeometry(page) {
  await expect(page.locator(".cloze-passage-pane")).not.toHaveAttribute("data-paper-moving", "true");
  return page.evaluate(() => {
    const passage = document.querySelector(".cloze-passage");
    if (!passage) return null;
    const rect = passage.getBoundingClientRect();
    // Compare canonical layout coordinates; opening the side lane intentionally
    // scales the entire paper and ink without changing their internal layout.
    const scale = new DOMMatrix(getComputedStyle(passage.closest(".cloze-passage-pane")).transform).a;
    const canonical = (value) => Math.round(Math.round(value / scale * 100) / 100);
    const sentence = passage.querySelector(".cloze-sentence");
    const blank = passage.querySelector(".cloze-blank");
    const sRect = sentence ? sentence.getBoundingClientRect() : null;
    const bRect = blank ? blank.getBoundingClientRect() : null;
    return {
      passage: { width: passage.offsetWidth, height: passage.offsetHeight },
      sentence: sRect ? { left: canonical(sRect.left - rect.left), top: canonical(sRect.top - rect.top), width: canonical(sRect.width) } : null,
      blank: bRect ? { left: canonical(bRect.left - rect.left), top: canonical(bRect.top - rect.top), width: canonical(bRect.width) } : null,
      scrollY: window.scrollY,
    };
  });
}

test("完形笔迹：初做写字 → 切 Blank → reload → 笔迹保留；undo / lasso 正常", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: true, attempts: { 1: { firstAnswer: "D" } } });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-ink-surface")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".cloze-reader-page > .annotation-toolbar")).toBeVisible();
  // 桌面 Web 默认键盘输入模式；写字前切到手写批注（与精读同一 noteMode 语义）
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  await expect(page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" })).toHaveClass(/active/);

  // 写字
  const box = await passageBox(page);
  await drawStroke(page, box);
  let ink = await readInk(page, username);
  expect(ink.length).toBe(1);
  expect(ink[0].value.length).toBe(1);
  expect(ink[0].value[0].tool).toBe("pen");

  // 切 Blank（点击正文第 1 空 → 打开题目窗）→ 笔迹仍在
  await clickClozeBlank(page, page.locator(".cloze-blank").first());
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(1, "切 Blank 不丢笔迹");

  // reload → 笔迹仍在
  await page.reload();
  await expect(page.locator(".cloze-ink-surface")).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(600);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(1, "reload 后笔迹仍在");
  await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
  // reload 后 noteMode 重置（桌面 Web 默认键盘输入模式），后续书写前重新切手写
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  await expect(page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" })).toHaveClass(/active/);

  // undo → 0 条
  await page.locator(".annotation-toolbar button", { hasText: "撤销" }).click();
  await page.waitForTimeout(450);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(0, "undo 后笔迹清空");

  // 写两条 → 切橡皮 → 自由套索圈选第一条 → 只删第一条
  await drawStroke(page, box, [0.2, 0.15], [0.35, 0.25]);
  await drawStroke(page, box, [0.6, 0.6], [0.75, 0.7]);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(2);

  await page.locator(".annotation-toolbar button", { hasText: "橡皮" }).click();
  await page.locator(".annotation-toolbar .tool-mode-picker button", { hasText: "自由套索" }).click();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.1, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(1, "套索只删除真实圈选范围内的笔迹");

  // 工具栏收起 / 展开后笔迹仍在
  await page.locator(".toolbar-collapse-toggle").click();
  await expect(page.locator(".toolbar-collapse-toggle", { hasText: "展开工具" })).toBeVisible();
  await page.locator(".toolbar-collapse-toggle").click();
  await page.waitForTimeout(300);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(1);

  // clear 只清当前完形 Ink；答案/进度不变，reload 后仍为空。
  const progressBeforeClear = await page.evaluate(({ user, resourceId }) => {
    const key = `wuliao:user:${encodeURIComponent(user)}:wuliao:cloze-progress:${resourceId}:${resourceId}`;
    return localStorage.getItem(key);
  }, { user: username, resourceId: RESOURCE_ID });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".annotation-toolbar button", { hasText: "清空笔迹" }).click();
  await page.waitForTimeout(450);
  expect(await readInk(page, username)).toEqual([]);
  const progressAfterClear = await page.evaluate(({ user, resourceId }) => {
    const key = `wuliao:user:${encodeURIComponent(user)}:wuliao:cloze-progress:${resourceId}:${resourceId}`;
    return localStorage.getItem(key);
  }, { user: username, resourceId: RESOURCE_ID });
  expect(progressAfterClear).toBe(progressBeforeClear);

  await page.reload();
  await expect(page.locator(".cloze-ink-surface")).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(600);
  expect(await readInk(page, username)).toEqual([]);
  await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeDisabled();
  await expect(page.locator(".annotation-toolbar button", { hasText: "清空笔迹" })).toBeDisabled();
});

test("完形正文显示：作答后可在 ABCD 与选项单词间切换，阶段切换保持锚点稳定", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-first-attempt", now, {
    stages: { "cloze-first-attempt": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: false });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-passage")).toBeVisible({ timeout: 30000 });

  const baseline = await anchorGeometry(page);
  expect(baseline.sentence).not.toBeNull();
  expect(baseline.blank).not.toBeNull();

  // 作答第一空（正文 Blank 字母展示，几何不变）
  await clickClozeBlank(page, page.locator(".cloze-blank").first());
  const selectedOptionText = await page.locator(".cloze-question-panel .cloze-option").first().locator("span").innerText();
  await page.locator(".cloze-question-panel .cloze-option").first().click();
  await page.waitForTimeout(200);
  let g = await anchorGeometry(page);
  expect(g.sentence.left).toBe(baseline.sentence.left);
  expect(g.sentence.top).toBe(baseline.sentence.top);
  expect(Math.abs(g.blank.width - baseline.blank.width)).toBeLessThanOrEqual(1);

  // answerDisplayMode 切换（ABCD ↔ 选项内容）：触屏下也直接把已选单词放进正文空位。
  await page.locator(".cloze-answer-display-toggle").click();
  await page.waitForTimeout(200);
  g = await anchorGeometry(page);
  expect(g.sentence.left).toBe(baseline.sentence.left);
  expect(g.sentence.top).toBe(baseline.sentence.top);
  await expect(page.locator(".cloze-answer-display-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cloze-blank").first()).toContainText(selectedOptionText);
  await expect(page.locator(".cloze-blank").first()).toHaveClass(/is-answer-text/);

  // 完成初做 → self-review
  await clickClozeAction(page, "提交并进入复查");
  await expect(page.locator(".cloze-reader-stage")).toContainText("自主复查", { timeout: 15000 });
  g = await anchorGeometry(page);
  expect(g.sentence.left).toBe(baseline.sentence.left);
  expect(g.sentence.top).toBe(baseline.sentence.top);

  // self-review → correction
  await clickClozeAction(page, "完成复查");
  await expect(page.locator(".cloze-reader-stage")).toContainText("统一订正", { timeout: 15000 });
  g = await anchorGeometry(page);
  expect(g.sentence.left).toBe(baseline.sentence.left);
  expect(g.sentence.top).toBe(baseline.sentence.top);

  // correction → analysis
  await clickClozeAction(page, "完成订正");
  await expect(page.locator(".cloze-reader-stage")).toContainText("逐空精析", { timeout: 15000 });
  g = await anchorGeometry(page);
  expect(g.sentence.left).toBe(baseline.sentence.left);
  expect(g.sentence.top).toBe(baseline.sentence.top);
});

// Flow B：折叠契约（DOM 层面子控件消失，非 CSS 隐藏）
test("完形工具栏折叠契约：收起后 slider/color/pen/eraser 从 DOM 消失，展开恢复", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: true, attempts: { 1: { firstAnswer: "D" } } });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  const bar = page.locator(".cloze-reader-page > .annotation-toolbar");
  await expect(bar).toBeVisible({ timeout: 30000 });

  // 展开态完整控件集
  await expect(bar.locator(".tool-size-range-track")).toHaveCount(1);
  await expect(bar.locator(".color-picker button")).toHaveCount(3);
  await expect(bar.locator("button", { hasText: "✎笔" })).toBeVisible();
  await expect(bar.locator("button", { hasText: "◇橡皮" })).toBeVisible();

  // 收起：DOM 只剩「展开工具 + stageHint」
  await bar.locator(".toolbar-collapse-toggle", { hasText: "收起工具" }).click();
  await expect(bar.locator(".toolbar-collapse-toggle", { hasText: "展开工具" })).toBeVisible();
  await expect(bar.locator(".tool-size-range-track")).toHaveCount(0);
  await expect(bar.locator(".color-picker button")).toHaveCount(0);
  await expect(bar.locator("button", { hasText: "✎笔" })).toHaveCount(0);
  await expect(bar.locator("button", { hasText: "◇橡皮" })).toHaveCount(0);
  await expect(bar.locator("button", { hasText: "↶撤销" })).toHaveCount(0);
  await expect(bar.locator(".toolbar-stage-hint")).toBeVisible();

  // 展开恢复
  await bar.locator(".toolbar-collapse-toggle").click();
  await expect(bar.locator(".tool-size-range-track")).toHaveCount(1);
  await expect(bar.locator(".color-picker button")).toHaveCount(3);
  await expect(bar.locator("button", { hasText: "✎笔" })).toBeVisible();
});

// Flow D：noteMode（键盘输入 ⇄ 手写批注）不丢 Blank 答案 / activeBlank / 笔迹
test("完形 noteMode：键盘⇄手写切换不丢答案 / activeBlank / 笔迹", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: true });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-ink-surface")).toBeVisible({ timeout: 30000 });
  const bar = page.locator(".cloze-reader-page > .annotation-toolbar");
  await expect(bar.locator(".input-mode-picker")).toBeVisible();

  // 桌面 Chrome 默认键盘输入模式：正文 Blank 可直接点击作答
  await expect(bar.locator(".input-mode-picker button", { hasText: "键盘输入" })).toHaveClass(/active/);
  await clickClozeBlank(page, page.locator(".cloze-blank").first());
  await page.locator(".cloze-question-panel .cloze-option").first().click();
  await page.waitForTimeout(300);

  // 切手写 → 写字
  await bar.locator(".input-mode-picker button", { hasText: "手写批注" }).click();
  await expect(bar.locator(".input-mode-picker button", { hasText: "手写批注" })).toHaveClass(/active/);
  await drawStroke(page, await passageBox(page));
  let ink = await readInk(page, username);
  expect(ink.length).toBe(1);
  expect(ink[0].value.length).toBe(1);

  // 切回键盘：答案 / activeBlank / 笔迹全部保留
  await bar.locator(".input-mode-picker button", { hasText: "键盘输入" }).click();
  await expect(bar.locator(".input-mode-picker button", { hasText: "键盘输入" })).toHaveClass(/active/);
  const progress = await page.evaluate((user) => {
    const scoped = (key) => `wuliao:user:${encodeURIComponent(user)}:${key}`;
    return JSON.parse(localStorage.getItem(scoped("wuliao:cloze-progress:postgraduate-2007-cloze:postgraduate-2007-cloze")));
  }, username);
  expect(progress.attempts[1].reviewAnswer).toBeTruthy();
  expect(progress.activeBlank).toBe(1);
  ink = await readInk(page, username);
  expect(ink[0].value.length).toBe(1, "noteMode 切换不丢笔迹");

  // 键盘模式下 Blank 仍可点击（Surface 不截获）
  await clickClozeBlank(page, page.locator(".cloze-blank").first());
});

// Flow C：陌生词完整能力（精析阶段）→ 同一 unknown-words store，sourceType=cloze
test("完形陌生词：精析阶段标记进入同一 unknown-words store（sourceType=cloze）", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-analysis", now, {
    stages: { "cloze-analysis": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: true });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  const bar = page.locator(".cloze-reader-page > .annotation-toolbar");
  const unknownBtn = bar.locator("button", { hasText: "陌生词" });
  await expect(unknownBtn).toBeVisible({ timeout: 30000 });
  // E2E dev 下离线词库 chunk 不可用（vite 已知降级），释义链走人工补充 prompt；
  // 自动接受，验证「标记 → 释义补充 → 同一 store」完整链路。
  page.on("dialog", (dialog) => dialog.accept("测试释义"));
  await unknownBtn.click();
  await expect(unknownBtn).toHaveClass(/active/);
  await page.waitForTimeout(250); // 等 React effect 同步 surface toolRef（tool=unknown）

  // 打开分析页时 goToBlank 会 smooth 滚动；先把目标句子滚到视口中央
  // （与产品 scrollIntoView 一致），再计算单词视口坐标，避免被 sticky header
  // 遮挡或坐标过期。
  const wordPoint = await page.evaluate(() => {
    const sentence = document.querySelector(".cloze-sentence");
    if (!sentence) return null;
    sentence.scrollIntoView({ behavior: "instant", block: "center" });
    const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !/[A-Za-z]/.test(node.data || "")) node = walker.nextNode();
    if (!node) return null;
    const match = node.data.match(/[A-Za-z]+/);
    if (!match) return null;
    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, word: match[0] };
  });
  expect(wordPoint).not.toBeNull();
  await page.waitForTimeout(150); // 等滚动 settle
  await page.mouse.move(wordPoint.x, wordPoint.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(800); // 等 IndexedDB 写入

  const records = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("wuliao-english");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise((resolve, reject) => {
      const tx = db.transaction("unknown-words", "readonly");
      const all = tx.objectStore("unknown-words").getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    });
  });
  const clozeRecords = records.filter((record) => record.sourceType === "cloze");
  expect(clozeRecords.length).toBeGreaterThan(0, "标记后 unknown-words 中存在 sourceType=cloze 记录");
  expect(clozeRecords.some((record) => record.normalizedWord === String(wordPoint.word).toLowerCase())).toBe(true);
  expect(clozeRecords[0].resourceId).toBe("postgraduate-2007-cloze");
});

// 832×544：折叠/展开/切空后笔迹几何零漂移（跨 Blank 长笔迹）
test.describe("832×544 完形笔迹几何", () => {
  test.use({ viewport: { width: 832, height: 544 } });

  test("折叠/展开/切空后 stroke 不移动", async ({ page }) => {
    const username = await createAccount(page);
  const now = Date.now();
  await seedFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedProgress(page, username, { firstSubmitted: true, attempts: { 1: { firstAnswer: "D" } } });

  await openOfficialCloze(page, "2007 英语（一）完形填空");
  const box = await passageBox(page);
  await page.locator(".input-mode-picker button", { hasText: "手写批注" }).click();
  await drawStroke(page, box, [0.15, 0.3], [0.5, 0.45]);
  const baseline = await anchorGeometry(page);
  const inkBefore = await readInk(page, username);
  expect(inkBefore[0].value.length).toBe(1);

  const strokePoints = () => readInk(page, username).then((ink) => JSON.stringify(ink[0].value[0].points));
  const originalPoints = await strokePoints();

  // 折叠 → 展开
  const bar = page.locator(".cloze-reader-page > .annotation-toolbar");
  await bar.locator(".toolbar-collapse-toggle", { hasText: "收起工具" }).click();
  await expect(bar.locator(".toolbar-collapse-toggle", { hasText: "展开工具" })).toBeVisible();
  await bar.locator(".toolbar-collapse-toggle").click();
  await page.waitForTimeout(300);
  expect(await strokePoints()).toBe(originalPoints);
  let g = await anchorGeometry(page);
  expect(Math.abs(g.blank.width - baseline.blank.width)).toBeLessThanOrEqual(1);
  expect(g.passage.width).toBe(baseline.passage.width);

  // 切下一空 → 笔迹不变
  await clickClozeBlank(page, page.locator(".cloze-blank").nth(1));
  await page.waitForTimeout(300);
  expect(await strokePoints()).toBe(originalPoints);
  g = await anchorGeometry(page);
  expect(g.passage.width).toBe(baseline.passage.width);
  });
});

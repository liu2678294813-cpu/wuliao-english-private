import { test, expect } from "@playwright/test";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";

// Flow 15：X1.1 考试统一笔系统 + 悬浮题窗。
// 1) Exam Cloze 写字 + 作答 → 切 Reading（显式 Surface flush）→ Reading 写字
// 2) 悬浮题窗选择答案 → 关闭题窗 → 笔迹 / Canvas geometry 稳定（修改 41/42）
// 3) reload → resume：cloze ink / reading ink / answers / timer 全部保留
// 4) 工具栏收起 / 展开 → 笔迹不漂移

async function openX1AndStart(page, year = 2007) {
  await navTo(page, "模拟");
  await expect(page.locator(".exam-year-grid")).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${year} `) }).click();
  const start = page.getByRole("button", { name: "开始计时" });
  await expect(start).toBeEnabled({ timeout: 120000 });
  await start.click();
  await expect(page.locator(".exam-session")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".exam-navigator button")).toHaveCount(40);
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
  await page.waitForTimeout(450);
}

async function dispatchSurfaceStroke(page, pointerId, offset = 0) {
  const surface = page.locator(".exam-ink-content");
  const box = await surface.boundingBox();
  const startX = box.x + 42 + offset;
  const startY = box.y + 42 + offset;
  const event = (x, y) => ({ pointerId, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y });
  await surface.dispatchEvent("pointerdown", event(startX, startY));
  await surface.dispatchEvent("pointermove", event(startX + 36, startY + 10));
  await surface.dispatchEvent("pointerup", { ...event(startX + 72, startY + 20), buttons: 0 });
  await page.waitForTimeout(450);
}

async function examInkSummary(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = [];
    await new Promise((resolve, reject) => {
      const tx = db.transaction("exam-ink", "readonly");
      const request = tx.objectStore("exam-ink").getAll();
      request.onsuccess = () => {
        rows.push(...(request.result || []).map((record) => ({
          surfaceId: record.surfaceId,
          sessionId: record.sessionId,
          revision: record.revision,
          strokes: (record.strokes || []).length,
        })));
        resolve();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
    });
    db.close();
    return rows;
  });
}

test("考试：完形写字+作答 → 切 Reading 写字 → 题窗选答案 → 收起/展开工具栏 → reload/resume 全部保留", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("x1-ink"));
  await openX1AndStart(page);

  // ---- Exam Cloze：写字 + 作答 ----
  await expect(page.locator(".exam-ink-surface")).toBeVisible();
  await dispatchSurfaceStroke(page, 43, 14);
  await page.locator(".exam-inline-blank").first().click();
  await expect(page.locator(".exam-question.current")).toBeVisible();
  await page.locator(".exam-options button").first().click();
  await expect(page.locator(".exam-options button").first()).toHaveClass(/selected/);

  // Exam Surface 的共享撤销/清除契约：只改当前 Ink，不触碰已经选择的答案。
  await page.locator(".exam-session > .annotation-toolbar button", { hasText: "撤销" }).click();
  await page.waitForTimeout(350);
  expect((await examInkSummary(page)).find((row) => row.surfaceId === "cloze:main")?.strokes || 0).toBe(0);
  await expect(page.locator(".exam-options button").first()).toHaveClass(/selected/);
  await dispatchSurfaceStroke(page, 41, 0);
  await dispatchSurfaceStroke(page, 42, 28);
  await expect.poll(async () => (await examInkSummary(page)).find((row) => row.surfaceId === "cloze:main")?.strokes).toBe(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".exam-session > .annotation-toolbar button", { hasText: "清空笔迹" }).click();
  await page.waitForTimeout(350);
  expect((await examInkSummary(page)).find((row) => row.surfaceId === "cloze:main")?.strokes || 0).toBe(0);
  await expect(page.locator(".exam-options button").first()).toHaveClass(/selected/);
  await dispatchSurfaceStroke(page, 44, 14);

  // ---- 切 Reading（显式 flush previous Surface）----
  await page.locator(".exam-navigator button").nth(20).click();
  await expect(page.locator(".exam-question")).toHaveCount(5);
  const readingBox = await page.locator(".exam-passage").boundingBox();
  await drawStroke(page, readingBox, [0.3, 0.25], [0.55, 0.4]);

  // 悬浮题窗：打开 → 选答案 → 关闭 → Canvas geometry 不改变
  await page.locator(".exam-question-fab").click();
  await expect(page.locator(".exam-question-drawer.open")).toBeVisible();
  const geometryBefore = await page.locator(".exam-ink-canvas").boundingBox();
  await page.locator(".exam-drawer-options button").first().click();
  await expect(page.locator(".exam-drawer-options button").first()).toHaveClass(/selected/);
  await page.locator(".exam-drawer-header .icon-button").click();
  await expect(page.locator(".exam-question-drawer.open")).toHaveCount(0);
  const geometryAfter = await page.locator(".exam-ink-canvas").boundingBox();
  expect(geometryAfter.width).toBe(geometryBefore.width);
  expect(geometryAfter.height).toBe(geometryBefore.height);
  expect(geometryAfter.x).toBe(geometryBefore.x);

  // 返回完形 → 笔迹 + 答案都在
  await page.locator(".exam-navigator button").first().click();
  await expect(page.locator(".exam-inline-blank")).toHaveCount(20);
  await page.waitForTimeout(400);
  const afterReturn = await examInkSummary(page);
  const clozeRecord = afterReturn.find((row) => row.surfaceId === "cloze:main");
  expect(clozeRecord).toBeTruthy();
  expect(clozeRecord.strokes).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".exam-inline-blank").first()).not.toHaveText(/^1$/);

  // 工具栏收起 / 展开 → 笔迹仍在（不重挂 / 不重载）
  await page.locator(".exam-session > .annotation-toolbar .toolbar-collapse-toggle").click();
  await expect(page.locator(".toolbar-collapse-toggle", { hasText: "展开工具" })).toBeVisible();
  await page.locator(".toolbar-collapse-toggle").click();
  await page.waitForTimeout(400);
  const afterCollapse = await examInkSummary(page);
  expect(afterCollapse.find((row) => row.surfaceId === "cloze:main").strokes).toBeGreaterThanOrEqual(1);

  // ---- reload → resume：全部保留 ----
  await page.reload();
  await expect(page.locator(".exam-session")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".exam-navigator button")).toHaveCount(40);
  const resumed = await examInkSummary(page);
  expect(resumed.find((row) => row.surfaceId === "cloze:main")).toBeTruthy();
  expect(resumed.find((row) => row.surfaceId === "cloze:main").strokes).toBeGreaterThanOrEqual(1);
  expect(resumed.find((row) => row.surfaceId === "reading:text-1").strokes).toBeGreaterThanOrEqual(1);
  // 答案保留
  await page.locator(".exam-navigator button").nth(20).click();
  await expect(page.locator(".exam-drawer-options, .exam-options button").first()).toHaveClass(/selected/);
  await expect(page.getByLabel("剩余时间")).not.toHaveText("100:00");
  expect(username.length).toBeGreaterThan(0);
});

test("考试：题窗只含题目信息且答案写 Exam Session（不写普通阅读答案）", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("x1-drawer"));
  await openX1AndStart(page);
  await page.locator(".exam-navigator button").nth(20).click();
  await page.locator(".exam-question-fab").click();
  await expect(page.locator(".exam-question-drawer.open")).toBeVisible();

  // 不展示订正 / AI / 证据 / 官方答案
  await expect(page.locator(".exam-question-drawer")).not.toContainText(/订正|AI|证据|正确答案/);
  // 题窗内选项
  await expect(page.locator(".exam-drawer-item")).toHaveCount(5);
  await page.locator(".exam-drawer-options button").nth(1).click();
  await expect(page.locator(".exam-drawer-options button").nth(1)).toHaveClass(/selected/);

  // 答案只存在于 Exam Session（wuliao:exam-session:*），不进入普通阅读答案存储
  const leaked = await page.evaluate((user) => {
    const scoped = (key) => `wuliao:user:${encodeURIComponent(user)}:${key}`;
    const keys = Object.keys(localStorage);
    return {
      ordinaryAnswers: keys.filter((key) => key.includes("wuliao:answers:") && !key.includes("exam")),
      evidence: keys.filter((key) => key.includes("question-evidence")),
      examSessions: keys.filter((key) => key.includes("wuliao:exam-session:v1:")),
    };
  }, username);
  expect(leaked.ordinaryAnswers).toEqual([]);
  expect(leaked.evidence).toEqual([]);
  expect(leaked.examSessions.length).toBeGreaterThanOrEqual(1);
});

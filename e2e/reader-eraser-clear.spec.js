import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { createAccount, uniqueUsername, openOfficialResource, readDurableInkEntries } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";
test.use({ actionTimeout: 15000 });

async function ink(page) {
  return { ...Object.fromEntries(["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"].map((id) => [id, []])), ...Object.fromEntries((await readDurableInkEntries(page))
    .filter(({ key }) => key.includes("wuliao:deep-ink:v2:"))
    .map(({ key, value }) => [key.split(":").at(-1), JSON.parse(value)])) };
}

async function setup(page) {
  await createAccount(page, uniqueUsername("eraser-undo"));
  await openOfficialResource(page, TITLE);
  await page.getByRole("button", { name: "手写批注", exact: true }).click();
  await page.getByRole("button", { name: "笔", exact: true }).click();
}

async function pointOn(page, selector) {
  return page.locator(selector).first().evaluate(async (node) => {
    node.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const rect = node.getBoundingClientRect();
    return { x: rect.left + Math.min(140, rect.width * .25), y: rect.top + rect.height / 2 };
  });
}

// Synthetic pen events exercise the production runtime and canvas renderer;
// this isolated browser test does not claim physical M-Pencil validation.
async function gesture(page, points, probe = null) {
  return page.locator(".deep-reader-content").evaluate(async (paper, { points, probe }) => {
    const alpha = () => {
      if (!probe) return null;
      let count = 0;
      for (const canvas of paper.querySelectorAll(".deep-ink-tile")) {
        const r = canvas.getBoundingClientRect();
        const l = Math.max(0, Math.floor((probe.x-8-r.left)/r.width*canvas.width));
        const t = Math.max(0, Math.floor((probe.y-12-r.top)/r.height*canvas.height));
        const right = Math.min(canvas.width, Math.ceil((probe.x+74-r.left)/r.width*canvas.width));
        const bottom = Math.min(canvas.height, Math.ceil((probe.y+18-r.top)/r.height*canvas.height));
        if (right<=l || bottom<=t) continue;
        const bytes = canvas.getContext("2d").getImageData(l,t,right-l,bottom-t).data;
        for(let i=3;i<bytes.length;i+=4) if(bytes[i]>20) count++;
      }
      return count;
    };
    const metrics = {};
    for (let i = 0; i < points.length; i++) {
      const type = i === 0 ? "pointerdown" : i === points.length - 1 ? "pointerup" : "pointermove";
      if (type === "pointerup") metrics.beforeUpAlpha = alpha();
      const started = performance.now();
      paper.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerId: 731, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1,
        pressure: .5, clientX: points[i][0], clientY: points[i][1] }));
      if (type === "pointerup") { metrics.handlerMs = performance.now()-started; metrics.afterUpAlpha = alpha(); }
      await new Promise(requestAnimationFrame);
    }
    metrics.nextFrameAlpha = alpha();
    return metrics;
  }, { points, probe });
}

async function drawAt(page, point) {
  await gesture(page, Array.from({ length: 9 }, (_, i) => [point.x + i * 8, point.y + i * .5]));
}

async function pixelsNear(page, point) {
  return page.evaluate(({ x, y }) => {
    let count = 0;
    for (const canvas of document.querySelectorAll(".deep-ink-tile")) {
      const rect = canvas.getBoundingClientRect();
      const left = Math.max(0, Math.floor((x - 8 - rect.left) / rect.width * canvas.width));
      const top = Math.max(0, Math.floor((y - 12 - rect.top) / rect.height * canvas.height));
      const right = Math.min(canvas.width, Math.ceil((x + 74 - rect.left) / rect.width * canvas.width));
      const bottom = Math.min(canvas.height, Math.ceil((y + 18 - rect.top) / rect.height * canvas.height));
      if (right <= left || bottom <= top) continue;
      const bytes = canvas.getContext("2d").getImageData(left, top, right-left, bottom-top).data;
      for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 20) count++;
    }
    return count;
  }, point);
}

async function lasso(page, point) {
  await page.getByRole("button", { name: "橡皮", exact: true }).click();
  await page.getByRole("button", { name: "自由套索", exact: true }).click();
  const { x, y } = point;
  return gesture(page, [[x-18,y-22], [x+32,y-22], [x+86,y-22], [x+86,y+28],
    [x+32,y+28], [x-18,y+28], [x-18,y-22]], point);
}

async function reloadAndAssert(page, before) {
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  await expect(page.locator(".reader-page")).toBeVisible();
  await expect.poll(() => ink(page)).toEqual(before);
  const point = await pointOn(page, "#deep-cover .deep-cover-subtitle");
  await expect.poll(() => pixelsNear(page, point)).toBeGreaterThan(0);
}

async function record(page, testInfo, label) {
  await testInfo.attach(label, { body: JSON.stringify(await ink(page), null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`) });
}

test("精读无清空入口，跨阶段笔迹可套索撤销并保存恢复", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("button", { name: "清空页面", exact: true })).toHaveCount(0);
  const cover = await pointOn(page, "#deep-cover .deep-cover-subtitle");
  await drawAt(page, cover);
  await expect.poll(async () => (await ink(page))["deep-cover"].length).toBe(1);
  await page.getByRole("button", { name: "开始精读", exact: true }).click();
  await drawAt(page, await pointOn(page, "#deep-first-read h2"));
  await expect.poll(async () => (await ink(page))["deep-first-read"].length).toBe(1);
  const before = await ink(page);
  await lasso(page, await pointOn(page, "#deep-cover .deep-cover-subtitle"));
  await expect.poll(async () => (await ink(page))["deep-cover"].length).toBe(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(() => ink(page)).toEqual(before);
  await page.locator(".reader-header .back-button").first().click();
  await expect(page.locator(".library-page")).toBeVisible();
  await page.reload();
  await expect.poll(() => ink(page)).toEqual(before);
});

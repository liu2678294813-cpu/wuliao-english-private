import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createAccount, navTo, openOfficialCloze, readDurableInkEntries } from "./helpers.js";

const evidence = "output/cloze-layout-qa";

async function settled(page) {
  await expect(page.locator(".cloze-passage-pane")).not.toHaveAttribute("data-paper-moving", "true");
  await page.waitForTimeout(250);
}

async function geometry(page) {
  return page.locator(".cloze-passage-pane").evaluate((paper) => {
    const rect = paper.getBoundingClientRect();
    const scale = rect.width / paper.offsetWidth;
    return {
      width: paper.offsetWidth, height: paper.offsetHeight, x: rect.x, right: rect.right, scale,
      tokens: [...paper.querySelectorAll(".cloze-blank")].map((node) => {
        const r = node.getBoundingClientRect();
        return [(r.x - rect.x) / scale, (r.y - rect.y) / scale, r.width / scale];
      }),
    };
  });
}

async function storedInk(page) {
  return (await readDurableInkEntries(page))
    .filter(({ key }) => key.includes("wuliao:cloze-ink:v1:"))
    .flatMap(({ value }) => JSON.parse(value));
}

async function firstAnswer(page) {
  return page.evaluate(() => {
    const entry = Object.entries(localStorage).find(([key]) => key.includes("wuliao:cloze-progress:"));
    return entry ? JSON.parse(entry[1]).attempts[1]?.firstAnswer : null;
  });
}

async function draw(page, pointerId = 77) {
  await page.locator(".cloze-ink-content").evaluate(async (surface, pointerId) => {
    for (let i = 0; i < 3; i++) {
      const r = surface.getBoundingClientRect();
      surface.dispatchEvent(new PointerEvent(["pointerdown", "pointermove", "pointerup"][i], {
        bubbles: true, cancelable: true, pointerType: "pen", pointerId, button: 0,
        buttons: i === 2 ? 0 : 1, pressure: .5,
        clientX: r.left + r.width * (.2 + i * .05), clientY: r.top + r.height * .15,
      }));
      await new Promise(requestAnimationFrame);
    }
  }, pointerId);
  await page.waitForTimeout(450);
}

for (const width of [1440, 1104, 820, 390]) {
  test(`cloze paper and whole toolbar match reading at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await createAccount(page);
    await openOfficialCloze(page, "2007 英语（一）完形填空");
    await page.getByRole("button", { name: "开始限时初做", exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    await settled(page);
    const panel = page.locator(".cloze-question-panel");
    if (await panel.getAttribute("data-motion-state") !== "closed") {
      await panel.locator(".cloze-panel-toggle").click();
      await settled(page);
    }
    await page.getByRole("button", { name: "手写批注", exact: true }).click();
    await draw(page);
    const ink = await storedInk(page);
    expect(ink).toHaveLength(1);
    const before = await geometry(page);
    await page.locator(".cloze-panel-expand-fab").click();
    await expect(panel).toHaveAttribute("data-motion-state", "open");
    await settled(page);
    const opened = await geometry(page);
    expect(opened.width).toBe(before.width);
    expect(opened.height).toBe(before.height);
    opened.tokens.forEach((box, i) => box.forEach((value, j) => expect(Math.abs(value - before.tokens[i][j])).toBeLessThan(1)));
    const panelBox = await panel.boundingBox();
    if (width > 760) {
      expect(opened.right).toBeLessThanOrEqual(panelBox.x - 15);
      const available = await page.locator(".cloze-reader-page").evaluate((node) => node.clientWidth);
      expect(Math.abs(panelBox.width - Math.min(360, Math.max(280, available * .28)))).toBeLessThan(1);
    } else {
      expect(panelBox.width).toBe(width - 16);
      expect(panelBox.height).toBeCloseTo(900 * .48, 0);
    }
    expect(await storedInk(page)).toEqual(ink);
    await draw(page, 78);
    const nextInk = await storedInk(page);
    expect(nextInk).toHaveLength(2);
    expect(nextInk[1].points[0].x).toBeCloseTo(.2, 2);
    expect(nextInk[1].points[0].y).toBeCloseTo(.15, 2);
    // The actual backing canvas retains layout pixels, even after resize and scale.
    const canvas = await page.locator(".cloze-ink-content").evaluate((node) => ({
      width: node.clientWidth, canvasWidth: parseFloat(node.querySelector("canvas").style.width),
    }));
    expect(canvas.canvasWidth).toBe(canvas.width);
    await page.locator(".cloze-option").first().click();
    await expect.poll(() => firstAnswer(page)).toBe("A");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/cloze-${width}-open.png` });
    const topBefore = (await page.locator(".cloze-passage-pane").boundingBox()).y;
    await page.getByRole("button", { name: "收起工具", exact: false }).click();
    await settled(page);
    await expect(page.locator(".cloze-reader-header")).toBeHidden();
    expect((await page.locator(".annotation-toolbar").boundingBox()).height).toBe(0);
    expect((await page.locator(".cloze-passage-pane").boundingBox()).y).toBeLessThan(topBefore);
    await expect(panel).toHaveAttribute("data-motion-state", "open");
    expect((await panel.boundingBox()).y).toBe(8);
    await expect(page.getByRole("button", { name: "展开工具", exact: false })).toBeVisible();
    await page.screenshot({ path: `${evidence}/cloze-${width}-collapsed.png` });
    await page.getByRole("button", { name: "展开工具", exact: false }).click();
    await settled(page);
    await expect(page.locator(".cloze-reader-header")).toBeVisible();
    await expect.poll(() => firstAnswer(page)).toBe("A");
    expect(await storedInk(page)).toEqual(nextInk);
    await panel.locator(".cloze-panel-toggle").click();
    await settled(page);
    const restored = await geometry(page);
    expect(restored.x).toBeCloseTo(before.x, 0);
    expect(restored.scale).toBeCloseTo(before.scale, 3);
    // Interrupt an opening transition with a close, then rotate the viewport.
    await page.locator(".cloze-panel-expand-fab").click();
    await panel.locator(".cloze-panel-toggle").evaluate((node) => node.click());
    await settled(page);
    expect((await geometry(page)).scale).toBeCloseTo(before.scale, 3);
    await page.setViewportSize({ width: width > 760 ? 820 : 760, height: 700 });
    await settled(page);
    expect(await storedInk(page)).toEqual(nextInk);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(await page.title()).toContain("无聊英语");
    if (width === 1104) {
      await page.locator(".cloze-panel-expand-fab").click();
      await settled(page);
      await page.getByRole("button", { name: "橡皮", exact: true }).click();
      await page.getByRole("button", { name: "自由套索", exact: true }).click();
      await page.locator(".cloze-ink-content").evaluate(async (surface) => {
        const points = [[.16, .12], [.34, .12], [.34, .18], [.16, .18], [.16, .12]];
        for (let i = 0; i < points.length; i++) {
          const r = surface.getBoundingClientRect();
          surface.dispatchEvent(new PointerEvent(i === 0 ? "pointerdown" : i === points.length - 1 ? "pointerup" : "pointermove", {
            bubbles: true, cancelable: true, pointerId: 80, pointerType: "pen", button: 0,
            buttons: i === points.length - 1 ? 0 : 1,
            clientX: r.left + r.width * points[i][0], clientY: r.top + r.height * points[i][1],
          }));
          await new Promise(requestAnimationFrame);
        }
      });
      await expect.poll(() => storedInk(page)).toHaveLength(0);
    }
    expect(errors).toEqual([]);
  });
}

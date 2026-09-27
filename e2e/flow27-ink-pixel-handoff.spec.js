import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createAccount, openOfficialResource, clickStageAdvance } from "./helpers.js";

async function openTranslation(page) {
  await createAccount(page);
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await openOfficialResource(page, "2013 英语（一）Text 1");
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.includes("wuliao:reading-flow:"));
    const flow = JSON.parse(localStorage.getItem(key));
    const now = Date.now();
    for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) {
      flow.stages[id] = { status: "completed", completedAt: now };
    }
    flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: now };
    localStorage.setItem(key, JSON.stringify(flow));
  });
  await page.reload();
  await page.locator(".library-page").waitFor();
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await page.locator(".resource-card", { hasText: "2013 英语（一）Text 1" }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  await page.locator("#deep-translation .translation-paragraph").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
}

async function displayedPrefix(page, png, input) {
  return page.evaluate(async ({ url, input }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas"), ratio = devicePixelRatio;
    canvas.width = Math.ceil(24 * ratio); canvas.height = Math.ceil(32 * ratio);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, -Math.round((input.x - 12) * ratio), -Math.round((input.y + 8) * ratio));
    bitmap.close();
    return { pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, ratio };
  }, { url: `data:image/png;base64,${png.toString("base64")}`, input });
}

for (const config of [
  { name: "fractional-origin", width: 1174, height: 768, scale: 1, dx: .237 },
  { name: "scaled-paper", width: 1174, height: 768, scale: .75, dx: .371 },
  { name: "portrait", width: 768, height: 1174, scale: 1, dx: .237 },
  { name: "tile-seam", width: 1174, height: 768, scale: 1, dx: .237, seam: true },
  { name: "scaled-tile-seam", width: 1174, height: 768, scale: .75, dx: .371, seam: true },
  { name: "question-panel", width: 1174, height: 768, panel: true },
]) {
  test(`2013 translation stable ink pixels survive pen-up: ${config.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: config.width, height: config.height });
    await openTranslation(page);
    if (config.panel) {
      await page.locator(".question-fab").click();
      await expect(page.locator(".question-drawer.open")).toBeVisible();
      await page.waitForTimeout(350);
    }
    await page.locator(".deep-reader-content").evaluate((element, config) => {
      element.dispatchEvent(new Event("reader-paper-settle"));
      element.dispatchEvent(new Event("reader-paper-will-layout"));
      if (config.scale) {
        element.style.transformOrigin = "0 0";
        element.style.transform = `translate(${config.dx}px,0px) scale(${config.scale})`;
      }
      element.dispatchEvent(new Event("reader-paper-layout"));
      if (config.seam) window.scrollBy(0, element.getBoundingClientRect().top + 2048 * config.scale - 280);
    }, config);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const backgroundPng = await page.screenshot();
    const input = await page.locator(".deep-reader-content").evaluate(element => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + 32.237, y = Math.max(250, rect.top + 150.137);
      window.__inkPixelInput = { x, y };
      const dispatch = (type, dy) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 712, pointerType: "pen", isPrimary: true,
        button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX: x, clientY: y + dy,
      }));
      dispatch("pointerdown", 0);
      for (const dy of [16, 32, 48, 64]) dispatch("pointermove", dy);
      window.__finishInkPixelInput = () => dispatch("pointerup", 64);
      // Compare the stable prefix, excluding the replaceable tail and its join.
      window.__readInkPixels = () => {
        const dpr = 4, out = document.createElement("canvas");
        out.width = 24 * dpr; out.height = 32 * dpr;
        const ctx = out.getContext("2d");
        ctx.scale(dpr, dpr); ctx.translate(-x + 12, -y - 8);
        for (const canvas of document.querySelectorAll(".deep-ink-tile,.custom-viewport-ink-preview,.custom-viewport-ink-tail")) {
          const box = canvas.getBoundingClientRect();
          if (canvas.width && canvas.height && box.width && box.height) ctx.drawImage(canvas, box.left, box.top, box.width, box.height);
        }
        const rgba = ctx.getImageData(0, 0, out.width, out.height).data;
        return Array.from({ length: out.width * out.height }, (_, i) => rgba[i * 4 + 3]);
      };
      return { x, y, rect: rect.toJSON() };
    });
    const before = await page.evaluate(() => window.__readInkPixels());
    const beforePng = await page.screenshot({ path: testInfo.outputPath("before-up.png") });
    await page.evaluate(() => window.__finishInkPixelInput());
    const committed = await page.evaluate(() => window.__readInkPixels());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const nextFrame = await page.evaluate(() => window.__readInkPixels());
    const afterPng = await page.screenshot({ path: testInfo.outputPath("after-up.png") });
    // Inspect browser-composited screenshots as well as the source bitmaps:
    // independent compositor layers may round differently on the actual screen.
    const screenBefore = await displayedPrefix(page, beforePng, input);
    const screenAfter = await displayedPrefix(page, afterPng, input);
    const background = await displayedPrefix(page, backgroundPng, input);
    const inkWeights = pixels => Array.from({ length: pixels.length / 4 }, (_, i) =>
      [0, 1, 2].reduce((sum, channel) => sum + Math.abs(pixels[i * 4 + channel] - background.pixels[i * 4 + channel]), 0));
    const screenInkBefore = inkWeights(screenBefore.pixels), screenInkAfter = inkWeights(screenAfter.pixels);
    const screenMass = values => values.reduce((a, b) => a + b, 0);
    const screenCenter = values => values.reduce((sum, value, i) => sum + value * (i % screenBefore.width), 0)
      / screenMass(values) / screenBefore.ratio;
    const screenComparison = {
      difference: screenInkAfter.reduce((sum, value, i) => sum + Math.abs(value - screenInkBefore[i]), 0) / screenMass(screenInkBefore),
      dx: screenCenter(screenInkAfter) - screenCenter(screenInkBefore),
    };
    const compare = (pixels) => {
      const mass = a => a.reduce((s, v) => s + v, 0);
      const center = a => a.reduce((s, v, i) => s + (i % 96) * v, 0) / mass(a) / 4;
      return { difference: pixels.reduce((sum, v, i) => sum + Math.abs(v - before[i]), 0) / mass(before), dx: center(pixels) - center(before) };
    };
    const geometry = await page.evaluate(() => [...document.querySelectorAll(".deep-ink-tile,.custom-viewport-ink-preview")].map(e => ({ rect:e.getBoundingClientRect().toJSON(), width:e.width, height:e.height })));
    const result = { input, committed: compare(committed), nextFrame: compare(nextFrame), screenComparison, geometry };
    await writeFile(testInfo.outputPath("pixel-comparison.json"), JSON.stringify(result, null, 2));
    await testInfo.attach("pixel-comparison", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(before.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(screenMass(screenInkBefore)).toBeGreaterThan(0);
    expect(Math.abs(screenComparison.dx), JSON.stringify(result)).toBeLessThan(.05);
    expect(screenComparison.difference, JSON.stringify(result)).toBeLessThan(.04);
    for (const comparison of [result.committed, result.nextFrame]) {
      expect(Math.abs(comparison.dx), JSON.stringify(result)).toBeLessThan(.05);
      expect(comparison.difference, JSON.stringify(result)).toBeLessThan(.04);
    }
  });
}

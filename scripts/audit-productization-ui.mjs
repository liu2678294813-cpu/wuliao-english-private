import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import axe from "axe-core";

const baseURL = process.env.WULIAO_AUDIT_URL || "http://127.0.0.1:5199";
const output = resolve(import.meta.dirname, "../output/audit/ui");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const viewports = [
  { name: "832x544", width: 832, height: 544 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844 },
  { name: "btk-w00-2560x1600", width: 1280, height: 800, deviceScaleFactor: 2 },
];
const report = [];

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor || 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const loading = page.locator(".brand-welcome");
  if (await loading.isVisible()) {
    await page.screenshot({ path: resolve(output, `${viewport.name}-loading.png`), fullPage: false });
  }
  await page.locator(".account-card").waitFor({ state: "visible" });
  const username = `audit-${viewport.name}-${Date.now()}`;
  await page.locator('input[autocomplete="username"]').fill(username);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("audit-pass-123");
  await passwords.nth(1).fill("audit-pass-123");
  await page.locator(".account-submit").click();
  const home = page.locator(".home-page");
  await home.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(output, `${viewport.name}-home.png`), fullPage: true });
  await page.locator(".ds-ai-api:visible, .ds-mobile-ai:visible").first().click();
  await page.locator(".ai-api-modal").waitFor({ state: "visible" });
  const providerCount = await page.locator('.provider-settings select').first().locator("option").count();
  if (providerCount !== 9) throw new Error(`${viewport.name}: expected 9 providers, received ${providerCount}`);
  await page.screenshot({ path: resolve(output, `${viewport.name}-ai-settings.png`), fullPage: true });
  await page.addScriptTag({ content: axe.source });
  const axeResult = await page.evaluate(async () => globalThis.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  }));
  report.push({
    viewport: viewport.name,
    providerCount,
    violations: axeResult.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
      help: item.help,
    })),
    passes: axeResult.passes.length,
    incomplete: axeResult.incomplete.length,
    consoleErrors,
  });
  await context.close();
}

await browser.close();
await writeFile(resolve(output, "axe-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

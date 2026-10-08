import test from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";

const built = await build({ configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' }, plugins: [react(), {
  name: "save-status-fixture",
  enforce: "pre",
  transform(source, id) {
    if (!id.includes("SaveStatus.jsx")) return;
    return source.replace(/import[^\n]+durableInkStorage[^\n]+/,
      "const inkStorageStatus=()=>globalThis.saveFixture.status; const subscribeInkStorage=(fn)=>{globalThis.saveFixture.notify=fn;return()=>{};}; const flushDurableInk=async()=>{globalThis.saveFixture.inkCalls++;};")
      .replace(/import[^\n]+saveCoordinator[^\n]+/,
        "const flushPendingSaves=()=>{globalThis.saveFixture.saveCalls++;return new Promise(r=>{globalThis.saveFixture.resolve=r;});};");
  },
}], build: { write: false, lib: { entry: "scripts/fixtures/save-status-fixture.jsx", name: "saveStatusTest", formats: ["iife"] } } });
const code = (Array.isArray(built) ? built[0] : built).output.find((item) => item.type === "chunk").code;

test("SaveStatus hides saved, shows saving, preserves error and functional retry", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<html><body></body></html>");
    await page.evaluate(() => { globalThis.saveFixture = { status: "saved", saveCalls: 0, inkCalls: 0 }; });
    await page.addScriptTag({ content: code });
    await page.evaluate(() => saveStatusTest.mount());
    await page.waitForFunction(() => typeof saveFixture.notify === "function", null, { timeout: 5000 });
    assert.equal(await page.locator(".learning-save-status").count(), 0);
    await page.evaluate(() => { saveFixture.status = "saving"; saveFixture.notify(); });
    await page.getByText("保存中…", { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("wuliao:save-failed")));
    await page.getByRole("button", { name: "重试保存" }).waitFor();
    await page.getByRole("button", { name: "重试保存" }).click();
    await page.waitForFunction(() => typeof saveFixture.resolve === "function");
    await page.evaluate(() => saveFixture.resolve());
    await page.waitForFunction(() => !document.querySelector(".learning-save-status"));
    assert.deepEqual(await page.evaluate(() => ({ save: saveFixture.saveCalls, ink: saveFixture.inkCalls })), { save: 1, ink: 1 });
  } finally { await browser.close(); }
});

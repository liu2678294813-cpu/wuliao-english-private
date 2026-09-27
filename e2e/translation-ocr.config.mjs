import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".", testMatch: ["translation-ocr.spec.js", "flow27-ink-pixel-handoff.spec.js"], workers: 1,
  timeout: 120000, expect: { timeout: 15000 }, reporter: "list",
  outputDir: "../output/translation-ocr-20260921/browser",
  use: { baseURL: "http://127.0.0.1:5208", channel: "chrome", viewport: { width: 1280, height: 840 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js preview --config vite.app.config.js --host 127.0.0.1 --port 5208 --strictPort",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:5208", reuseExistingServer: true },
});

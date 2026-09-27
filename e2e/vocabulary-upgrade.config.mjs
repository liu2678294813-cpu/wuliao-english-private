import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["vocabulary-upgrade.spec.js", "pronunciation-playback.spec.js"], timeout: 120000,
  expect: { timeout: 15000 }, workers: 1, reporter: "list",
  outputDir: "../output/vocabulary-upgrade-tests",
  use: { baseURL: "http://127.0.0.1:5199", channel: "chrome", viewport: { width: 1280, height: 840 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});

import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "android-compat.spec.js",
  timeout: 180000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  outputDir: `../output/android-compat-20261008/${process.env.COMPAT_RUN || "matrix"}/playwright`,
  reporter: [["list"], ["json", { outputFile: fileURLToPath(new URL(`../output/android-compat-20261008/${process.env.COMPAT_RUN || "matrix"}/results.json`, import.meta.url)) }]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.COMPAT_EXISTING_SERVER === "1" ? undefined : {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "corepack pnpm build && corepack pnpm exec vite preview --config vite.app.config.js --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    timeout: 180000,
    reuseExistingServer: false,
    env: { VITE_E2E_PROBES: "1", VITE_E2E_OVERLAY_OFF: "1" },
  },
});

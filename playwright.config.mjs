import { defineConfig } from "@playwright/test";

// R4 浏览器 E2E：唯一正式框架为 @playwright/test（固定版本，不使用 latest）。
// - Web：直接驱动本机 Chrome（channel: chrome），无需下载浏览器；
// - Android WebView：复用 connectOverCDP（见 scripts/test-r4-android-e2e.mjs）；
// - 每个 test 使用独立 browser context → storage 完全隔离，不污染真实用户。
export default defineConfig({
  testDir: "./e2e",
  timeout: 180000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    // Vite 8 dev transforms for the very large App module can block navigation
    // for several minutes. E2E should exercise the current production bundle,
    // which also makes startup deterministic and catches build-only failures.
    command: process.env.COMPAT_ISOLATED_PREVIEW === "1"
      ? "corepack pnpm build && node scripts/compat-preview.mjs"
      : "corepack pnpm build && corepack pnpm exec vite preview --config vite.app.config.js --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: false,
    timeout: 120000,
    env: { VITE_E2E_OVERLAY_OFF: "1", VITE_E2E_PROBES: "1" },
  },
});

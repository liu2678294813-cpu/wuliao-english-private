import { defineConfig } from "@playwright/test";
import base from "../playwright.config.mjs";
import { fileURLToPath } from "node:url";

export default defineConfig({ ...base, testDir: ".", testMatch: ["sentence-review.spec.js", "writing-slice10.spec.js"],
  outputDir: "D:/codex库/01_无聊英语项目/无聊英语-重难句验收-20261019/browser-results",
  use: { ...base.use, baseURL: "http://127.0.0.1:5201" },
  webServer: { ...base.webServer,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "node node_modules/vite/bin/vite.js build --config vite.app.config.js && node node_modules/vite/bin/vite.js preview --config vite.app.config.js --host 127.0.0.1 --port 5201 --strictPort",
    url: "http://127.0.0.1:5201" },
});

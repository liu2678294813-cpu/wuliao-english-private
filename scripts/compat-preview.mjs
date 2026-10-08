// Freeze the browser test assets so a concurrent Android production build cannot
// replace its chunks or E2E probes. Only generated files under output are copied.
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { preview } from "vite";
const outDir = resolve(`output/android-compat-20261008/preview-${process.pid}`);
mkdirSync(outDir, { recursive: true });
cpSync(resolve("dist"), outDir, { recursive: true });
const server = await preview({ configFile: resolve("vite.app.config.js"), build: { outDir },
  preview: { host: "127.0.0.1", port: 5199, strictPort: true } });
server.printUrls();

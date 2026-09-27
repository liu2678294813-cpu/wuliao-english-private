import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOcrPages } from "../src/ocrLifecycle.js";

test("OCR 顺序处理页面并始终释放 worker", async () => {
  let terminated = 0;
  const progress = [];
  const worker = { terminate: async () => { terminated += 1; } };
  const result = await runOcrPages({}, [1, 2], {
    createWorker: async () => worker,
    processPage: async ({ pageNumber }) => `page-${pageNumber}`,
    onProgress: (entry) => progress.push(entry),
    workerInitTimeoutMs: 50,
    pageTimeoutMs: 50,
  });
  assert.deepEqual(result, { 1: "page-1", 2: "page-2" });
  assert.equal(terminated, 1);
  assert.ok(progress.some((entry) => entry.stage === "worker-init"));
});

test("单页超时会中止页面并释放 worker", async () => {
  let terminated = 0;
  let pageAborted = false;
  await assert.rejects(
    runOcrPages({}, [7], {
      createWorker: async () => ({ terminate: async () => { terminated += 1; } }),
      processPage: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { pageAborted = true; resolve(""); }, { once: true });
      }),
      workerInitTimeoutMs: 50,
      pageTimeoutMs: 5,
    }),
    (error) => error?.code === "ocr-page-timeout",
  );
  assert.equal(pageAborted, true);
  assert.equal(terminated, 1);
});

test("用户取消会退出 OCR 并释放 worker", async () => {
  let terminated = 0;
  const controller = new AbortController();
  const pending = runOcrPages({}, [1], {
    signal: controller.signal,
    createWorker: async () => ({ terminate: async () => { terminated += 1; } }),
    processPage: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(""), { once: true });
    }),
    workerInitTimeoutMs: 50,
    pageTimeoutMs: 100,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === "cancelled");
  assert.equal(terminated, 1);
});

test("结构解析失败不得把已有可靠文字层的页面重新送入 OCR", () => {
  const source = readFileSync(new URL("../src/pdfParser.js", import.meta.url), "utf8");
  assert.match(source, /const attemptedOcrPages = new Set\(\)/);
  assert.doesNotMatch(source, /const remainingPages = pages/);
  assert.doesNotMatch(source, /const allPages = pages\.map/);
});

test("Android OCR 请求 aapt 实际保留的未压缩 traineddata 文件名", () => {
  const source = readFileSync(new URL("../src/pdfParser.js", import.meta.url), "utf8");
  assert.match(source, /import \{ isAndroidApp \} from "\.\/platform\.js"/);
  assert.match(source, /gzip: !isAndroidApp\(\)/);
});

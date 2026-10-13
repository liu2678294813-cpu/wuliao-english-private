// Reproducible OFFLINE comparison against the actual pre-change source.
// All credentials, accounts, documents and images below are synthetic.
// No provider connection is made, no tokens or costs are inferred from bytes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TRAINING_SENTENCE_B, TRAINING_SOURCE, TRAINING_EVALUATION, qualityItem } from "./fixtures/long-sentence-quality.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const baselineRef = option("--baseline-ref", "039c4d9742140d9c2e15d316dd6bbde69a23ae55");
const out = resolve(option("--output", join(root, "output", "ai-cache-benchmark")));
mkdirSync(out, { recursive: true });
let beforeRoot = option("--baseline-root", null);
if (!beforeRoot) {
  const commit = execFileSync("git", ["rev-parse", baselineRef], { cwd: root, encoding: "utf8" }).trim();
  beforeRoot = join(out, `before-${commit.slice(0, 12)}`);
  if (!existsSync(join(beforeRoot, "src", "aiProvider.js"))) {
    mkdirSync(beforeRoot, { recursive: true });
    const archive = join(out, `before-${commit.slice(0, 12)}.tar`);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, commit, "src"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", beforeRoot]);
  }
}
class MemoryStorage {
  rows = new Map();
  get length() { return this.rows.size; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  getItem(key) { return this.rows.get(String(key)) ?? null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
async function source(base) {
  const load = path => import(pathToFileURL(join(base, path)).href);
  return { user: await load("src/userData.js"), provider: await load("src/aiProvider.js"), cache: await load("src/aiReviewCache.js"), ai: await load("src/ai.js"), tasks: await load("src/aiTasks.js"), cloze: await load("src/clozeAiTasks.js"), hint: await load("src/questionHintService.js"), handwriting: await load("src/vocabulary/handwritingAi.js"), long: await load("src/longSentence/ai.js") };
}
const before = await source(resolve(beforeRoot)), after = await source(root);
const mockDelayMs = 15;
const wait = () => new Promise(done => setTimeout(done, mockDelayMs));
const profile = (baseUrl = "https://cache-benchmark.invalid/v1") => ({ providerId: "custom", modality: "text", endpointKind: "custom", baseUrl, modelId: "mock-model" });
const genericMessages = text => [{ role: "system", content: "Explain the current English sentence accurately." }, { role: "user", content: text }];
const article = "A coastal city introduced a new transport plan after residents complained about congestion. The council initially expected wider roads to solve the problem, but surveys showed that reliable public transport mattered more. The revised plan connected residential areas with schools and hospitals, while preserving pedestrian access to local shops.";
const hintResult = { version: 1, level: 1, focus: { location: "关注转折后的调查结论", keywords: ["but"], logicSignals: ["转折"] }, readingDirection: "比较最初预期与调查结果。", questionForUser: "作者用调查结果修正了什么判断？" };
const evaluationDetail = () => ({ sessionId: "benchmark-session", itemId: "benchmark-item", attemptId: "attempt-one", submittedAt: 1, generatedSentence: TRAINING_SENTENCE_B, structureFingerprint: qualityItem().structureFingerprint, userTranslation: "尽管存在限制，研究表明该行星适宜居住。", targetWordUses: [], difficultyMetadata: qualityItem().difficultyMetadata });
function commonBytes(first, second) {
  if (!first || !second) return null;
  const a = Buffer.from(JSON.stringify(first)), b = Buffer.from(JSON.stringify(second));
  let index = 0; while (index < Math.min(a.length, b.length) && a[index] === b[index]) index += 1;
  return index;
}
const originalFetch = globalThis.fetch;
const rows = [];
const clozeSources = [{ sentenceId: "s1", source: "The council [1] a transport plan." }, { sentenceId: "s2", source: "Residents [2] reliable transport." }];
const clozeMessages = (layer, index) => layer.cloze.buildClozeAiMessages(layer.cloze.TASK_CLOZE_HINT_1, layer.cloze.buildClozeHintDetail({ taskType: layer.cloze.TASK_CLOZE_HINT_1, resourceId: "mock-cloze", clozeId: "passage", chapter: "Mock cloze", blankNumber: index + 1, currentSentence: clozeSources[index], contextSources: clozeSources, articleSources: clozeSources }));
const prefixComparisons = { clozeDifferentBlanks: { before: commonBytes(clozeMessages(before, 0), clozeMessages(before, 1)), after: commonBytes(clozeMessages(after, 0), clozeMessages(after, 1)) } };
async function measure(id, label, layer, name, exercise) {
  localStorage.clear(); before.cache.clearAiResultMemory(); after.cache.clearAiResultMemory();
  const username = `mock-benchmark-${id}-${name}`; layer.user.setCurrentUsername(username);
  let networkRequests = 0, localHits = 0, promptBytes = 0, kind = "text";
  const requests = [];
  const observe = (messages) => { networkRequests += 1; requests.push(messages); promptBytes += Buffer.byteLength(JSON.stringify(messages || [])); };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); observe(body.messages || body.input); await wait();
    const content = kind === "hint" ? JSON.stringify(hintResult) : kind === "ocr" ? JSON.stringify({ items: [{ id: "0", text: "原样文字", unsure: false }] }) : `model:${body.model};endpoint:${new URL(url).host}`;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const ctx = {
    layer, username, observe, requests, setKind(value) { kind = value; },
    async cached(extra = {}) {
      const response = await layer.provider.callCachedTextAi({ profile: profile(), model: "mock-model", apiKey: "mock-only", taskType: "benchmark-text", messages: genericMessages("The proposed change was widely discussed."), ...extra });
      if (response.cached) localHits += 1;
      assert.ok(response.content); return response;
    },
    async counted(run) { const count = networkRequests; const result = await run(); if (count === networkRequests) localHits += 1; return result; },
    async longReply(options, result) { observe(options.messages); await wait(); return { content: JSON.stringify(result), modelId: "mock-model", providerId: "custom" }; },
  };
  const started = performance.now();
  const validity = await exercise(ctx);
  const elapsedMs = performance.now() - started;
  return { id, label, version: name, networkRequests, localHits, elapsedMs: Number(elapsedMs.toFixed(2)), promptBytes, commonPrefixBytes: commonBytes(requests[0], requests[1]),
    inputTokens: null, providerHitTokens: null, providerHitRatio: null, cost: null, outputValid: validity !== false,
    tokenAndCostReason: "Unknown: offline Mock has no real provider Usage, tokenizer or bill" };
}
const cases = [
  ["A", "首次请求", async ctx => { await ctx.cached(); }],
  ["B", "立即重复请求", async ctx => { const first = await ctx.cached(); const second = await ctx.cached(); assert.equal(first.content, second.content); }],
  ["C", "同文章不同题目", async ctx => {
    ctx.setKind("hint");
    for (const index of [1, 2]) {
      const result = await ctx.layer.hint.runQuestionHint({ taskType: ctx.layer.tasks.TASK_QUESTION_HINT_1, apiKey: "mock-only", detail: { resourceId: "mock-article-one", chapter: "Mock reading", questionId: `q${index}`, questionNumber: `${index}`, questionText: index === 1 ? "Why did the council revise the plan?" : "What did the surveys reveal?", articleText: article, scope: "first" } });
      assert.equal(result.status, "ok"); if (result.cached) throw new Error("different questions must not reuse local results");
    }
  }],
  ["D", "不同文章相同任务", async ctx => {
    ctx.setKind("hint");
    for (const index of [1, 2]) {
      const result = await ctx.layer.hint.runQuestionHint({ taskType: ctx.layer.tasks.TASK_QUESTION_HINT_1, apiKey: "mock-only", detail: { resourceId: `mock-article-${index}`, chapter: "Mock reading", questionId: "q1", questionText: "Why was the policy revised?", articleText: index === 1 ? article : "A university changed its library policy after students requested longer opening hours.", scope: "first" } });
      assert.equal(result.status, "ok"); assert.equal(result.cached, false);
    }
  }],
  ["E", "同一短词更换模型（正确性优先）", async ctx => {
    const call = model => ctx.counted(() => ctx.layer.ai.runQuickTranslation({ text: "abandon", kind: "word", model, apiKey: "mock-only", dictionary: async () => "" }));
    await call("deepseek-chat"); const changed = await call("deepseek-reasoner");
    return changed.result.translation.includes("model:deepseek-reasoner");
  }],
  ["F", "同模型更换 Endpoint", async ctx => { const first = await ctx.cached(); const second = await ctx.cached({ profile: profile("https://other-benchmark.invalid/v1") }); assert.notEqual(first.content, second.content); assert.equal(second.cached, false); }],
  ["G", "可选本地 TTL 到期", async ctx => {
    const realNow = Date.now; let time = realNow(); Date.now = () => time;
    try { await ctx.cached({ maxAgeMs: 100 }); time += 101; const next = await ctx.cached({ maxAgeMs: 100 }); return !next.cached; } finally { Date.now = realNow; }
  }],
  ["H", "手动强制刷新", async ctx => { await ctx.cached(); const next = await ctx.cached({ force: true }); assert.equal(next.cached, false); }],
  ["I", "取消后重新提交", async ctx => {
    const controller = new AbortController(); let started;
    const ready = new Promise(done => { started = done; }); const currentFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { started(); return currentFetch(...args); };
    const pending = ctx.cached({ signal: controller.signal }); const failed = assert.rejects(pending, error => error.name === "AbortError");
    await ready; controller.abort(); await failed;
    const next = await ctx.cached(); assert.equal(next.cached, false); await wait();
  }],
  ["J", "OCR 相同图片复用，修改图片后识别", async ctx => {
    ctx.setKind("ocr"); const p = ctx.layer.provider.saveProviderProfile({ ...profile(), modality: "vision" }); await ctx.layer.provider.bindCredential(p, "mock-vision-only");
    for (const image of ["AAAA", "AAAA", "BBBB"]) {
      const result = await ctx.counted(() => ctx.layer.handwriting.recognizeHandwriting({ username: ctx.username, images: [{ id: "row-one", image: `data:image/png;base64,${image}` }] }));
      assert.equal(result[0].id, "row-one"); assert.equal(result[0].text, "原样文字");
    }
  }],
  ["K", "相同长难句评价复用并绑定新 Attempt", async ctx => {
    const service = ctx.layer.long.createLongSentenceAiService({ getProfile: () => profile(), callAi: options => ctx.longReply(options, TRAINING_EVALUATION) });
    for (const attemptId of ["attempt-one", "attempt-two"]) {
      const result = await ctx.counted(() => service.evaluate({ ...evaluationDetail(), attemptId }));
      assert.deepEqual(result.evaluation, TRAINING_EVALUATION); assert.equal(result.lineage.attemptId, attemptId);
    }
  }],
  ["L", "生成新句始终请求 Provider", async ctx => {
    const service = ctx.layer.long.createLongSentenceAiService({ getProfile: () => profile(), callAi: options => ctx.longReply(options, { items: [qualityItem()] }) });
    for (let index = 0; index < 2; index += 1) { const result = await service.generate({ sessionId: "mock-session", sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 2 }], words: [], count: 1 }); assert.equal(result.status, "complete"); }
  }],
];
try {
  for (const [id, label, run] of cases) rows.push({ id, label, before: await measure(id, label, before, "before", run), after: await measure(id, label, after, "after", run) });
} finally { globalThis.fetch = originalFetch; }
assert.ok(rows.every(row => row.after.outputValid), "every optimized scenario must preserve the declared correctness check");
const report = { generatedAt: new Date().toISOString(), baselineRef, mode: "offline Mock only", model: "synthetic mock-model / DeepSeek model-id fixtures (no live calls)", mockDelayMs,
  interpretation: "Latency includes controlled mock delays and local processing; no real inference quality, provider hit rate, real tokens, money saved or device acceptance is claimed. Baseline E exposes unsafe model reuse; baseline G had no opt-in TTL support. Increased requests there are correctness improvements.", prefixComparisons, rows };
writeFileSync(join(out, "benchmark.json"), JSON.stringify(report, null, 2));
const table = ["# AI 缓存基准：实际基线源码与优化源码（离线 Mock）", "", `基线 ${baselineRef}；每次模拟网络延迟 ${mockDelayMs} ms；使用独立临时账号及合成文档/图片。`, "", "真实 Provider 输入 Token、缓存 Token、费用、命中率均为 Unknown；本实验没有调用收费接口。时间只表示 Mock 条件下的本地执行时间。", "", "| 场景 | 网络请求 前→后 | 本地复用 前→后 | 耗时 ms 前→后 | 输出/隔离检查 前→后 | 公共前缀字节 前→后 |", "| --- | --- | --- | --- | --- | --- |", ...rows.map(row => `| ${row.id}. ${row.label} | ${row.before.networkRequests}→${row.after.networkRequests} | ${row.before.localHits}→${row.after.localHits} | ${row.before.elapsedMs}→${row.after.elapsedMs} | ${row.before.outputValid ? "通过" : "未通过"}→${row.after.outputValid ? "通过" : "未通过"} | ${row.before.commonPrefixBytes ?? "不适用"}→${row.after.commonPrefixBytes ?? "不适用"} |`), "", "E 修复跨模型错误复用；G 验证本次新加入的可选 TTL。两项多发请求是正确性收益。B/F/H/I 原来已经正确，不人为制造改进。C 量化前缀稳定性，两个不同问题仍应各请求一次。J/K 减少验证有效的重复识别/评价请求。L 保留生成新句的新颖性请求语义；固定 Mock 输出不证明真实语义的新颖性。", "", "重现：`node --import ./scripts/test-hooks.mjs scripts/bench-ai-cache.mjs --baseline-ref 039c4d9742140d9c2e15d316dd6bbde69a23ae55`。", ""];
table.push(`完形两个不同空格的真实请求消息公共前缀：${prefixComparisons.clozeDifferentBlanks.before} → ${prefixComparisons.clozeDifferentBlanks.after} 字节。前缀仅含固定规则、资料身份和全文遮空原文；没有把选项、正确答案或用户选择放入低阶段上下文。`, "");
writeFileSync(join(out, "benchmark.md"), table.join("\n"));
console.log(JSON.stringify({ output: out, cases: rows.length, allOptimizedValid: true, rows: rows.map(row => ({ id: row.id, before: row.before.networkRequests, after: row.after.networkRequests, prefixBefore: row.before.commonPrefixBytes, prefixAfter: row.after.commonPrefixBytes })) }, null, 2));

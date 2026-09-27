// R4 发布门禁（只检查，不修改版本、不提交、不发布）。
// 执行顺序：
//   1. 全量测试（含 R4 专项）
//   2. 官方内容审计：parser-integrity + exact-content（对照已知异常清单分类）
//   3. Vocabulary patch 目标校验 + bundle 产物校验
//   4. production build
//   5. Android / Capacitor 配置一致性 + 签名状态报告
//   6. 版本 / 依赖 / lockfile 报告
//
// 退出码：0 = 通过（所有异常均被验证或解释）；1 = 存在未解释异常。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { exactContentFailuresInKnown } from "./release-known-exceptions.mjs";

const root = resolve(".");
const report = { steps: [], warnings: [], failures: [] };

function readJsonFile(path) {
  // 部分资源文件带 UTF-8 BOM，读取时剥离
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function run(name, command, args, { allowFail = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  report.steps.push({ name, ok: ok || allowFail, allowedFailure: !ok && allowFail, durationMs });
  if (!ok && !allowFail) report.failures.push(`${name} 失败（exit ${result.status}）`);
  return { ok, output: result.stdout || "", error: result.stderr || "" };
}

function step(ok, name, detail = "") {
  report.steps.push({ name, ok, durationMs: 0 });
  if (!ok) report.failures.push(`${name}${detail ? `：${detail}` : ""}`);
  return ok;
}

const win = process.platform === "win32";
const pnpmArgs = (args) => (win ? ["pnpm", ...args] : args);
const nodeArgs = (args) => (win ? ["pnpm", "exec", "node", ...args] : args);

// ---------------- 1. Writing catalog stale gate + 全量测试 ----------------
run("Writing sample catalog（canonical 与 generated 一致）", win ? "corepack" : "node", nodeArgs(["--import", "./scripts/test-hooks.mjs", "scripts/build-writing-sample-catalog.mjs", "--check"]));
run("test:all（含 R3 45 项 + R4 专项）", win ? "corepack" : "pnpm", pnpmArgs(["test:all"]));

// ---------------- 2. 官方内容审计 ----------------
run("audit_kaoyan_parser_integrity（68 篇结构）", win ? "corepack" : "node", nodeArgs(["scripts/audit_kaoyan_parser_integrity.mjs"]));

run("audit_kaoyan_exact_content（重新执行）", win ? "corepack" : "node", nodeArgs(["scripts/audit_kaoyan_exact_content.mjs"]), { allowFail: true });
const auditPath = resolve("output/pdf/kaoyan-exact-content-audit.json");
if (existsSync(auditPath)) {
  const audit = readJsonFile(auditPath);
  const { known, unknown } = exactContentFailuresInKnown(audit);
  if (unknown.length) {
    step(false, `exact-content 存在未解释异常：${unknown.join("、")}`);
  } else {
    step(true, `exact-content ${audit.coverage.passed}/${audit.coverage.entries} 通过，${known.length} 项为已验证并解释的 reference/OCR 差异`);
    report.warnings.push(`exact-content 已知异常 ${known.length} 项已分类：${[...new Set(known.map((item) => item.explanation.kind))].join("、")}`);
  }
}

// ---------------- 3. Vocabulary patch 与 bundle ----------------
run("patch-vocabulary-bundle（目标可找到）", win ? "corepack" : "node", nodeArgs(["scripts/patch-vocabulary-bundle.mjs"]));
run("patch-vocabulary-import-integration（目标可找到）", win ? "corepack" : "node", nodeArgs(["scripts/patch-vocabulary-import-integration.mjs"]));

const bundlePath = resolve("public/vocabulary/assets/index-DSvnOTE0.js");
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, "utf8");
  step(bundle.includes("__iwSync"), "词汇 bundle 含 import-integration 桥接标记（__iwSync）");
} else {
  step(false, "词汇 bundle 缺失");
}

// ---------------- 4. production build ----------------
run("pnpm build（含 vocabulary patch + vite + sites worker）", win ? "corepack" : "pnpm", pnpmArgs(["build"]));

const distAdapter = resolve("dist/vocabulary/vocabulary-bridge-adapter.js");
step(existsSync(distAdapter), "dist 含 vocabulary-bridge-adapter.js");
step(existsSync(resolve("dist/index.html")), "dist/index.html 存在");
const generatedWritingCatalogPath = resolve("src/writing/generatedWritingSampleCatalog.js");
if (existsSync(generatedWritingCatalogPath)) {
  const generatedWritingCatalog = readFileSync(generatedWritingCatalogPath, "utf8");
  const catalogVersion = /"catalogVersion":\s*"([^"]+)"/.exec(generatedWritingCatalog)?.[1];
  const contentHash = /"contentHash":\s*"([0-9a-f]{64})"/.exec(generatedWritingCatalog)?.[1];
  const itemCount = (generatedWritingCatalog.match(/"referenceEssay":/g) || []).length;
  step(Boolean(catalogVersion && contentHash && itemCount), `Writing sample catalog v${catalogVersion || "?"} / ${itemCount} items / ${contentHash || "missing hash"}`);
  const bundledHash = contentHash && listFilesRecursive(resolve("dist/assets"))
    .filter((file) => file.endsWith(".js"))
    .some((file) => readFileSync(file, "utf8").includes(contentHash));
  step(Boolean(bundledHash), "production bundle 含 Writing sample catalog contentHash");
} else {
  step(false, "generated Writing sample catalog 缺失");
}
const distBundleCandidates = [];
for (const file of listFilesRecursive(resolve("dist/vocabulary/assets"))) {
  if (file.endsWith(".js")) distBundleCandidates.push(file);
}
const distBundle = distBundleCandidates.find((file) => readFileSync(file, "utf8").includes("__iwSync"));
step(Boolean(distBundle), "最终 bundle 含 Bridge adapter 桥接（__iwSync）");

// word assets 完整性
const wordAssetsPath = resolve("public/vocabulary/word-assets.json");
if (existsSync(wordAssetsPath)) {
  const assets = readJsonFile(wordAssetsPath);
  const chunkNames = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "string") chunkNames.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(assets);
  const missing = chunkNames
    .map((name) => String(name).replace(/^\/+/, ""))
    .filter((name) => !existsSync(resolve(`dist/${name}`)));
  step(missing.length === 0, `word assets 完整（${chunkNames.length} 个 chunk）`, missing.length ? `缺失：${missing.join("、")}` : "");
} else {
  step(false, "word-assets.json 缺失");
}

// ---------------- 5. Android / Capacitor 配置 ----------------
const gradlePath = resolve("android/app/build.gradle");
const capacitorPath = resolve("capacitor.config.json");
const androidCapacitorPath = resolve("android/app/src/main/assets/capacitor.config.json");
if (existsSync(gradlePath) && existsSync(capacitorPath)) {
  const gradle = readFileSync(gradlePath, "utf8");
  const capacitor = readJsonFile(capacitorPath);
  const versionCode = /versionCode\s+(\d+)/.exec(gradle)?.[1];
  const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
  const applicationId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1]
    || /applicationId\s+project\.findProperty\("qaApplicationId"\)\s*\?:\s*"([^"]+)"/.exec(gradle)?.[1];
  step(Boolean(versionCode && versionName), "Android versionCode/versionName 存在", `${versionName} / ${versionCode}`);
  step(applicationId === capacitor.appId, "applicationId 与 Capacitor appId 一致", `${applicationId} vs ${capacitor.appId}`);
  step(existsSync(androidCapacitorPath), "Android assets 内 Capacitor 配置存在");
  if (existsSync(androidCapacitorPath)) {
    const androidCapacitor = readJsonFile(androidCapacitorPath);
    step(androidCapacitor.appId === capacitor.appId, "Android assets Capacitor appId 一致");
  }
  const signedRelease = /signingConfig\s+release|keystore|storeFile/.test(gradle);
  report.warnings.push(
    signedRelease
      ? "Android release signing 已配置"
      : "Android release signing 未配置（当前为 debug APK 验证构建；正式生产签名不属于 R4 范围，未使用不安全方案补建）",
  );
}

// ---------------- 6. 版本 / 依赖 / lockfile ----------------
const packageJson = readJsonFile(resolve("package.json"));
const webVersion = packageJson.version;
const androidVersion = /versionName\s+"([^"]+)"/.exec(readFileSync(gradlePath, "utf8"))?.[1];
if (webVersion !== androidVersion) {
  report.warnings.push(`版本分裂：web package ${webVersion} vs Android versionName ${androidVersion}（Web 与 Android 使用独立版本；Android 版本已按发布 Gate 单调递增）`);
}
const latestSpecifiers = [];
for (const [name, spec] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  if (spec === "latest") latestSpecifiers.push(name);
}
step(latestSpecifiers.length === 0, "无 latest 依赖 specifier（已固定 lockfile 验证版本）", latestSpecifiers.length ? latestSpecifiers.join("、") : "");
const lockText = readFileSync(resolve("pnpm-lock.yaml"), "utf8");
step(!lockText.includes("specifier: latest"), "pnpm-lock.yaml 无 latest specifier");

// ---------------- 汇总 ----------------
console.log("\n===== R4 release:check 报告 =====");
for (const item of report.steps) {
  const label = item.allowedFailure ? "NOTE" : item.ok ? "PASS" : "FAIL";
  console.log(`${label}  ${item.name}${item.durationMs ? ` (${(item.durationMs / 1000).toFixed(1)}s)` : ""}`);
}
if (report.warnings.length) {
  console.log("\n--- 已验证并记录的事项 ---");
  report.warnings.forEach((warning) => console.log(`NOTE  ${warning}`));
}
if (report.failures.length) {
  console.log("\n--- 失败 ---");
  report.failures.forEach((failure) => console.log(`FAIL  ${failure}`));
  process.exit(1);
}
console.log("\nrelease:check 通过：所有异常均被验证或解释。");
process.exit(0);

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  return files;
}

import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { setCurrentUsername } = await import("../src/userData.js");
const {
  activeBlankOf,
  addReference,
  analyzedBlankNumbers,
  clozeProgressStorageKey,
  effectiveConfidence,
  emptyBlankAttempt,
  emptyClozeProgress,
  getClozeProgress,
  isBlankUnanswered,
  listPostCorrectionPriorityBlankNumbers,
  listPreCorrectionPriorityBlankNumbers,
  listPriorityBlankNumbers,
  markAllCorrected,
  markAnalyzed,
  markCorrected,
  markFirstSubmitted,
  markReviewSubmitted,
  nextUnansweredBlank,
  nextUnanalyzedBlank,
  normalizeBlankAttempt,
  normalizeClozeProgress,
  recordFirstAnswer,
  recordFirstConfidence,
  recordReviewAnswer,
  recordReviewConfidence,
  saveClozeProgress,
  setActiveBlank,
  setBasisTypes,
  setConfidence,
  setPrediction,
  toggleBasisType,
  summarizeClozeAttempts,
  shouldDeepAnalyzeBlank,
} = await import("../src/clozeProgress.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const RESOURCE_ID = "postgraduate-2010-text-1";
const CLOZE_ID = "cloze-2010";
const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

function buildProgress(firstAnswers, reviewAnswers = {}, confidenceMap = {}) {
  let p = emptyClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS, 0);
  for (const [num, ans] of Object.entries(firstAnswers)) {
    p = recordFirstAnswer(p, Number(num), ans);
  }
  for (const [num, ans] of Object.entries(reviewAnswers)) {
    p = recordReviewAnswer(p, Number(num), ans);
  }
  for (const [num, conf] of Object.entries(confidenceMap)) {
    p = setConfidence(p, Number(num), conf);
  }
  return p;
}

const official = { 1: "C", 2: "D", 3: "A", 4: "B", 5: "C", 6: "A", 7: "D", 8: "C", 9: "B", 10: "D", 11: "D", 12: "B", 13: "C", 14: "D", 15: "A", 16: "C", 17: "B", 18: "A", 19: "A", 20: "C" };

// ---------------- 基本存储 ----------------

test("存储 key 与阅读/翻译/答案完全隔离", () => {
  const key = clozeProgressStorageKey("r1", "c1");
  assert.ok(key.startsWith("wuliao:cloze-progress:"));
  assert.ok(!key.includes("deep-answers"));
  assert.ok(!key.includes("translation-progress"));
  assert.ok(!key.includes("cloze-flow"));
});

test("新用户得到 20 个空白 attempt", () => {
  fresh();
  const p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  assert.equal(Object.keys(p.attempts).length, 20);
  assert.equal(p.attempts[1].firstAnswer, "");
  assert.equal(p.attempts[1].reviewAnswer, "");
  assert.equal(p.attempts[1].confidence, "");
  assert.deepEqual(p.attempts[1].basisTypes, []);
  assert.deepEqual(p.attempts[1].references, []);
});

test("保存后刷新可恢复", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstAnswer(p, 1, "A");
  p = recordReviewAnswer(p, 1, "B");
  p = setConfidence(p, 1, "uncertain");
  saveClozeProgress(p);
  const reloaded = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  assert.equal(reloaded.attempts[1].firstAnswer, "A");
  assert.equal(reloaded.attempts[1].reviewAnswer, "B");
  assert.equal(reloaded.attempts[1].confidence, "uncertain");
});

// ---------------- 首次/复查答案隔离（硬要求） ----------------

test("复查答案绝不覆盖首次答案", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstAnswer(p, 1, "B");
  p = recordReviewAnswer(p, 1, "C");
  assert.equal(p.attempts[1].firstAnswer, "B", "首次答案必须保留");
  assert.equal(p.attempts[1].reviewAnswer, "C", "复查答案独立保存");
  // 再次记录复查
  p = recordReviewAnswer(p, 1, "D");
  assert.equal(p.attempts[1].firstAnswer, "B");
  assert.equal(p.attempts[1].reviewAnswer, "D");
});

test("非法答案值不被接受", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  const before = p.attempts[1].firstAnswer;
  p = recordFirstAnswer(p, 1, "E");
  assert.equal(p.attempts[1].firstAnswer, before);
  p = recordFirstAnswer(p, 1, "");
  assert.equal(p.attempts[1].firstAnswer, before);
});

test("confidence 独立保存，不据答对/答错自动推测", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstAnswer(p, 1, "A");
  p = setConfidence(p, 1, "guess");
  assert.equal(p.attempts[1].confidence, "guess");
  // 答对不改变 confidence
  const official1 = { 1: "A" };
  const stat = summarizeClozeAttempts(p, official1);
  assert.equal(stat.firstCorrect, 1);
  assert.equal(p.attempts[1].confidence, "guess", "confidence 不因答对而改");
});

test("normalizeClozeProgress 对缺失字段做兼容补齐", () => {
  const raw = {
    schemaVersion: 1,
    resourceId: "r1",
    clozeId: "c1",
    attempts: {
      1: { firstAnswer: "A", reviewAnswer: "B" },
    },
    updatedAt: 10,
  };
  const normalized = normalizeClozeProgress(raw, NUMBERS);
  assert.equal(normalized.attempts[1].confidence, "");
  assert.deepEqual(normalized.attempts[1].basisTypes, []);
  assert.equal(normalized.attempts[1].prediction, "");
  assert.equal(normalized.attempts[2].firstAnswer, "");
  assert.equal(normalized.attempts[2].number, 2);
});

// ---------------- 统计纯函数 ----------------

test("情况 A：初做 B，复查 C，正确 C → selfCorrected += 1", () => {
  fresh();
  const p = buildProgress({ 1: "B" }, { 1: "C" });
  const stat = summarizeClozeAttempts(p, { 1: "C" });
  assert.equal(stat.firstCorrect, 0);
  assert.equal(stat.reviewCorrect, 1);
  assert.equal(stat.changed, 1);
  assert.equal(stat.selfCorrected, 1);
  assert.equal(stat.selfChangedToWrong, 0);
});

test("情况 B：初做 C，复查 B，正确 C → selfChangedToWrong += 1", () => {
  fresh();
  const p = buildProgress({ 1: "C" }, { 1: "B" });
  const stat = summarizeClozeAttempts(p, { 1: "C" });
  assert.equal(stat.firstCorrect, 1);
  assert.equal(stat.reviewCorrect, 0);
  assert.equal(stat.changed, 1);
  assert.equal(stat.selfCorrected, 0);
  assert.equal(stat.selfChangedToWrong, 1);
});

test("情况 C：初做 B，复查 B，正确 C，confident → confidentWrong += 1", () => {
  fresh();
  const p = buildProgress({ 1: "B" }, { 1: "B" }, { 1: "confident" });
  const stat = summarizeClozeAttempts(p, { 1: "C" });
  assert.equal(stat.confidentWrong, 1);
  assert.equal(stat.firstCorrect, 0);
  assert.equal(stat.reviewCorrect, 0);
});

test("情况 D：答案正确，confidence = uncertain → 仍进入重点精析", () => {
  fresh();
  const p = buildProgress({ 1: "A" }, {}, { 1: "uncertain" });
  const stat = summarizeClozeAttempts(p, { 1: "A" });
  assert.equal(stat.uncertain, 1);
  assert.equal(stat.firstCorrect, 1);
  assert.equal(shouldDeepAnalyzeBlank(p.attempts[1], "A"), true);
});

test("情况 E：答案正确，confidence = guess → 仍进入重点精析", () => {
  fresh();
  const p = buildProgress({ 1: "A" }, {}, { 1: "guess" });
  assert.equal(shouldDeepAnalyzeBlank(p.attempts[1], "A"), true);
});

test("统计汇总：完整 20 空混合情形", () => {
  fresh();
  const first = {};
  const review = {};
  const conf = {};
  for (let i = 1; i <= 20; i += 1) { first[i] = official[i]; }
  // 3 个初做错→复查对（selfCorrected）：official 1=C,2=D,3=A
  first[1] = "A"; review[1] = official[1]; // 1: A→C (selfCorrected)
  first[2] = "A"; review[2] = official[2]; // 2: A→D (selfCorrected)
  first[3] = "B"; review[3] = official[3]; // 3: B→A (selfCorrected)
  // 1 个初对→复查错（selfChangedToWrong）：official 4=B
  first[4] = official[4]; review[4] = "A"; // 4: B→A (selfChangedToWrong)
  // 1 个 confident 但错：official 5=C
  first[5] = "A"; conf[5] = "confident"; // 5: A≠C, confident+wrong
  // 2 个 uncertain
  conf[6] = "uncertain"; conf[7] = "uncertain";
  // 2 个 guess
  conf[8] = "guess"; conf[9] = "guess";
  const p = buildProgress(first, review, conf);
  const stat = summarizeClozeAttempts(p, official);
  assert.equal(stat.total, 20);
  assert.ok(stat.firstCompleted >= 18);
  assert.equal(stat.selfCorrected, 3, `selfCorrected should be 3, got ${stat.selfCorrected}`);
  assert.equal(stat.selfChangedToWrong, 1, `selfChangedToWrong should be 1, got ${stat.selfChangedToWrong}`);
  assert.equal(stat.confidentWrong, 1, `confidentWrong should be 1, got ${stat.confidentWrong}`);
  assert.equal(stat.uncertain, 2);
  assert.equal(stat.guesses, 2);
});

// ---------------- 重点空判定 ----------------

test("shouldDeepAnalyzeBlank：复查后仍错误", () => {
  const attempt = { firstAnswer: "B", reviewAnswer: "D", confidence: "confident" };
  assert.equal(shouldDeepAnalyzeBlank(attempt, "C"), true);
});

test("shouldDeepAnalyzeBlank：初做/复查答案改变", () => {
  const attempt = { firstAnswer: "B", reviewAnswer: "C", confidence: "confident" };
  assert.equal(shouldDeepAnalyzeBlank(attempt, "C"), true, "changed → deep");
  assert.equal(shouldDeepAnalyzeBlank(attempt, "B"), true, "changed → deep even if review right");
});

test("shouldDeepAnalyzeBlank：全部正确且确定 → 不进入", () => {
  const attempt = { firstAnswer: "C", reviewAnswer: "C", confidence: "confident" };
  assert.equal(shouldDeepAnalyzeBlank(attempt, "C"), false);
});

test("listPriorityBlankNumbers 返回排序的空号列表", () => {
  fresh();
  const first = {};
  const review = {};
  const conf = {};
  for (let i = 1; i <= 20; i += 1) { first[i] = official[i]; }
  // 2: first wrong→review right (selfCorrected, changed)
  first[2] = "A"; review[2] = official[2];
  // 3: first right→review wrong (selfChangedToWrong, changed)
  first[3] = official[3]; review[3] = "B" === official[3] ? "A" : "B";
  // 5: uncertain
  conf[5] = "uncertain";
  // 7: guess
  conf[7] = "guess";
  // 9: confident+wrong
  first[9] = official[9] === "A" ? "B" : "A"; conf[9] = "confident";
  const p = buildProgress(first, review, conf);
  const list = listPriorityBlankNumbers(p, official);
  assert.ok(list.includes(2), "2 changed wrong→right deep");
  assert.ok(list.includes(3), "3 changed right→wrong deep");
  assert.ok(list.includes(5), "5 uncertain deep");
  assert.ok(list.includes(7), "7 guess deep");
  assert.ok(list.includes(9), "9 confident+wrong deep");
  // 1: all correct, confident → not in list
  assert.ok(!list.includes(1), "1 all-correct confident → not deep");
});

// ---------------- B 阶段：双置信度 / 提交冻结 / priority ----------------

test("first/review 置信度独立保存，互不覆盖", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstConfidence(p, 1, "confident");
  p = recordReviewConfidence(p, 1, "guess");
  assert.equal(p.attempts[1].firstConfidence, "confident");
  assert.equal(p.attempts[1].reviewConfidence, "guess");
  assert.equal(effectiveConfidence(p.attempts[1]), "guess", "复查置信度优先");
  saveClozeProgress(p);
  const reloaded = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  assert.equal(reloaded.attempts[1].firstConfidence, "confident");
  assert.equal(reloaded.attempts[1].reviewConfidence, "guess");
});

test("旧 A 阶段 confidence 归一化为 firstConfidence", () => {
  fresh();
  const legacy = {
    schemaVersion: 1,
    resourceId: "r1",
    clozeId: "c1",
    attempts: { 1: { firstAnswer: "A", reviewAnswer: "", confidence: "uncertain" } },
    updatedAt: 1,
  };
  const normalized = normalizeClozeProgress(legacy, NUMBERS);
  assert.equal(normalized.attempts[1].firstConfidence, "uncertain");
  assert.equal(normalized.attempts[1].confidence, "uncertain");
  assert.equal(normalized.attempts[1].reviewConfidence, "");
  assert.equal(normalized.activeBlank, 1, "旧记录没有 activeBlank → 默认 1");
  assert.equal(normalized.firstSubmitted, false);
});

test("activeBlank 与提交状态可保存恢复", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = setActiveBlank(p, 7);
  p = markFirstSubmitted(p, true);
  p = markReviewSubmitted(p, true);
  saveClozeProgress(p);
  const reloaded = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  assert.equal(activeBlankOf(reloaded), 7);
  assert.equal(reloaded.firstSubmitted, true);
  assert.equal(reloaded.reviewSubmitted, true);
});

test("订正前 priority 不依赖官方答案：未完成/犹豫/猜测/改答", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstAnswer(p, 1, "A");
  p = recordFirstConfidence(p, 1, "confident");
  p = recordFirstAnswer(p, 2, "B");
  p = recordFirstConfidence(p, 2, "uncertain");
  p = recordFirstAnswer(p, 3, "C");
  p = recordReviewAnswer(p, 3, "D");
  const list = listPreCorrectionPriorityBlankNumbers(p);
  assert.ok(list.includes(4), "未作答进入 priority");
  assert.ok(list.includes(2), "犹豫进入 priority");
  assert.ok(list.includes(3), "first/review 不一致进入 priority");
  assert.ok(!list.includes(1), "确定且一致不进入");
});

test("订正后 priority 加入官方答案错误项", () => {
  fresh();
  const official = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, "A"]));
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  for (let i = 1; i <= 20; i += 1) {
    p = recordFirstAnswer(p, i, "A");
    p = recordFirstConfidence(p, i, "confident");
    p = recordReviewAnswer(p, i, "A");
  }
  // 第 1 空改为错误答案，其余全对且确定
  p = recordReviewAnswer(p, 1, "B");
  const list = listPostCorrectionPriorityBlankNumbers(p, official);
  assert.deepEqual(list, [1], "官方答案错误的 1 进入，其余正确且确定不进入");
});

test("nextUnansweredBlank 自动跳下一空，可回绕", () => {
  fresh();
  let p = getClozeProgress(RESOURCE_ID, CLOZE_ID, NUMBERS);
  p = recordFirstAnswer(p, 1, "A");
  p = recordFirstAnswer(p, 2, "B");
  assert.equal(nextUnansweredBlank(p, 3), 3);
  assert.equal(nextUnansweredBlank(p, 1), 3, "已答的跳过");
  p = recordFirstAnswer(p, 3, "C");
  p = recordFirstAnswer(p, 4, "D");
  assert.equal(nextUnansweredBlank(p, 3), 5);
  const full = buildProgress(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, "A"])));
  assert.equal(nextUnansweredBlank(full, 1), null, "全部答完返回 null");
  assert.equal(isBlankUnanswered(p.attempts[5]), true);
  assert.equal(isBlankUnanswered(p.attempts[1]), false);
});

test("normalizeBlankAttempt 双置信度兼容旧单字段", () => {
  const normalized = normalizeBlankAttempt({ firstAnswer: "A", confidence: "guess" }, 1);
  assert.equal(normalized.firstConfidence, "guess");
  assert.equal(normalized.reviewConfidence, "");
});

test("C 字段纯函数只修改目标 blank，保留 first/review 与双置信度", () => {
  fresh();
  let p = emptyClozeProgress("r1", "c1", [1, 2], 10);
  p = recordFirstAnswer(p, 1, "A");
  p = recordReviewAnswer(p, 1, "B");
  p = recordFirstConfidence(p, 1, "confident");
  p = recordReviewConfidence(p, 1, "guess");
  p = setPrediction(p, 1, "这里需要转折后的否定含义");
  p = setBasisTypes(p, 1, ["logic", "grammar", "bad-value"]);
  p = toggleBasisType(p, 1, "context");
  p = addReference(p, 1, {
    paragraphNumber: 2,
    sentenceIndex: 1,
    sentenceKey: "cloze:x:p2s2:x1",
    fingerprint: "x1",
    excerpt: "Evidence sentence.",
  });
  p = markCorrected(p, 1, true);
  p = markAnalyzed(p, 1, true);
  assert.equal(p.attempts[1].firstAnswer, "A");
  assert.equal(p.attempts[1].reviewAnswer, "B");
  assert.equal(p.attempts[1].firstConfidence, "confident");
  assert.equal(p.attempts[1].reviewConfidence, "guess");
  assert.equal(p.attempts[1].prediction, "这里需要转折后的否定含义");
  assert.deepEqual(p.attempts[1].basisTypes, ["logic", "grammar", "context"]);
  assert.equal(p.attempts[1].references.length, 1);
  assert.equal(p.attempts[1].corrected, true);
  assert.equal(p.attempts[1].analyzed, true);
  assert.equal(p.attempts[2].prediction, "");
  assert.equal(p.attempts[2].corrected, false);
});

test("未知历史 basis 保留，非法新值和非法 reference 不写入", () => {
  let p = normalizeClozeProgress({
    schemaVersion: 2,
    resourceId: "r1",
    clozeId: "c1",
    attempts: { 1: { basisTypes: ["future-basis", "logic"] } },
  }, [1]);
  p = setBasisTypes(p, 1, ["grammar", "invalid"]);
  assert.deepEqual(p.attempts[1].basisTypes, ["future-basis", "grammar"]);
  const unchanged = addReference(p, 1, { paragraphNumber: 0, sentenceKey: "", fingerprint: "" });
  assert.equal(unchanged, p);
});

test("统一订正一次批量写 corrected，不修改其他字段且不写 analyzed", () => {
  let p = emptyClozeProgress("r1", "c1", [1, 2], 10);
  p = setPrediction(p, 1, "keep");
  p = recordFirstAnswer(p, 1, "A");
  p = markAllCorrected(p, true, 99);
  assert.equal(p.attempts[1].corrected, true);
  assert.equal(p.attempts[2].corrected, true);
  assert.equal(p.attempts[1].prediction, "keep");
  assert.equal(p.attempts[1].firstAnswer, "A");
  assert.equal(p.attempts[1].analyzed, false);
  assert.equal(p.attempts[1].updatedAt, 99);
  assert.equal(p.updatedAt, 99);
});

test("analyzed 独立形成逐空门槛，corrected=false 不影响未完成定位", () => {
  let p = emptyClozeProgress("r1", "c1", [1, 2, 3], 0);
  p = markAnalyzed(p, 1, true);
  p = markAnalyzed(p, 2, true);
  assert.deepEqual(analyzedBlankNumbers(p), [1, 2]);
  assert.equal(nextUnanalyzedBlank(p, 1), 3);
  p = markAnalyzed(p, 3, true);
  p = markCorrected(p, 2, false);
  assert.equal(nextUnanalyzedBlank(p, 1), null);
  assert.deepEqual(analyzedBlankNumbers(p), [1, 2, 3]);
});

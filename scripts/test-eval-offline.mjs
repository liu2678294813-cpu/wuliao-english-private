import test from "node:test";
import assert from "node:assert/strict";

const { runOfflineEvalSuites } = await import("../src/eval/offlineRunner.js");
const { validateHintNoAnswerLeak } = await import("../src/questionHintSafety.js");
const { validateEvidenceAgainstContext } = await import("../src/questionDiagnosisEvidence.js");
const { parseTranslationReviewResult } = await import("../src/aiResultParsers.js");

test("Offline Eval 不联网（fetch 被调用即失败）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Offline Eval 不得调用 fetch"); };
  try {
    const report = await runOfflineEvalSuites();
    assert.equal(report.failed, 0);
    assert.equal(report.passed, report.caseCount);
    assert.ok(report.passRate === 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Answer Leak fixture 会被发现", () => {
  assert.equal(validateHintNoAnswerLeak("正确答案是 B。", 1).ok, false);
  assert.equal(validateHintNoAnswerLeak("排除 A 项。", 2).ok, false);
  assert.equal(validateHintNoAnswerLeak("请关注第二段的转折词 however。", 1).ok, true);
});

test("Invalid Evidence fixture 会被发现", () => {
  const article = "The new policy improved output in the short term.";
  const result = validateEvidenceAgainstContext(
    [{ source: "The government promised a tax cut that never happened.", explanation: "编造。" }],
    article,
  );
  assert.equal(result.ok, false);
  assert.equal(result.invalid.length, 1);
});

test("errorTags 白名单保护", () => {
  const raw = JSON.stringify({
    version: 1,
    summary: { level: "accurate", comment: "" },
    mainClause: { correct: true, comment: "" },
    clauseProblems: [],
    nonFiniteProblems: [],
    modifierProblems: [],
    referenceProblems: [],
    logicProblems: [],
    omissions: [],
    additions: [],
    wordChoiceProblems: [],
    chineseExpressionProblems: [],
    minimalRevision: "",
    referenceTranslation: "",
    errorTags: ["瞎编的标签", "漏译"],
  });
  const result = parseTranslationReviewResult(raw);
  assert.deepEqual(result.errorTags, ["漏译"]);
});

test("非法 evidence 不进入可信结果（服务级）", async () => {
  function memoryStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
  }
  globalThis.localStorage = memoryStorage({ "kaoyan_vocab_current_user": "eval-user" });
  const { runQuestionDiagnosis } = await import("../src/questionDiagnosisService.js");
  const invalidRaw = JSON.stringify({
    version: 1,
    questionType: "细节题",
    diagnosisBasis: "answers-only",
    confidence: "low",
    observedFacts: ["第一次选择 B，官方答案为 A"],
    evidence: [{ source: "The government promised a tax cut that never happened.", explanation: "编造。" }],
    paraphrases: [],
    selectedOptionAnalysis: [{ attempt: "first", selectedOption: "B", optionTrapType: "范围扩大", whyAttractive: "", whyWrong: "" }],
    attemptComparison: { available: false, comment: "" },
    inferredCause: { summary: "", userErrorTags: ["定位偏差"], reasoning: "", uncertainty: "" },
    nextTimeRule: "",
    selfCheckQuestions: [],
  });
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return { content: invalidRaw, reasoning: "" };
  };
  const result = await runQuestionDiagnosis({
    detail: {
      questionId: "q-eval",
      questionText: "What can be inferred?",
      options: [
        { key: "A", text: "Option A" },
        { key: "B", text: "Option B" },
        { key: "C", text: "Option C" },
        { key: "D", text: "Option D" },
      ],
      officialAnswer: "A",
      firstAnswer: "B",
      redoAnswer: "",
      articleText: "The new policy improved output in the short term.",
      chapter: "Eval",
      resourceId: "r1",
      questionNumber: 1,
      canShowFullExplanation: true,
    },
    apiKey: "fake-key",
    useCache: false,
    fetcher,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.evidenceValidated, false);
  assert.equal(fetchCount, 2); // 首次 + 严格重试
  assert.ok(!result.result.evidence.some((item) => item.source.includes("tax cut")));
});

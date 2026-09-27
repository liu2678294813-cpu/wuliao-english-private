// Offline Eval：纯离线、不联网、不消耗 API Key。核心是可重复运行的
// 测试脚本 + fixture + validator + report；React 页面只做按钮与展示。

import {
  parseQuestionDiagnosisResult,
  parseQuestionHintResult,
  parseTranslationReviewResult,
  reviewHasNoProblems,
} from "../aiResultParsers";
import { validateHintNoAnswerLeak } from "../questionHintSafety";
import { validateEvidenceAgainstContext } from "../questionDiagnosisEvidence";
import {
  buildQuestionHintLevel1Messages,
  buildQuestionHintLevel2Messages,
  TRANSLATION_REVIEW_ERROR_TAGS,
  USER_ERROR_TAGS,
  TRAP_TYPES,
  QUESTION_TYPES,
} from "../aiTasks";
import {
  DIAGNOSIS_RAW_CASES,
  EVIDENCE_CASES,
  HINT_LEAK_CASES,
  HINT_RAW_CASES,
  TRANSLATION_CASES,
} from "./fixtures";

function caseResult(name, pass, detail = "") {
  return { name, pass, detail };
}

function whitelisted(tags, allowed) {
  return (Array.isArray(tags) ? tags : []).every((tag) => allowed.includes(tag));
}

function parsersCases() {
  const cases = [];
  const validTranslation = parseTranslationReviewResult(TRANSLATION_CASES[0].raw);
  cases.push(caseResult("翻译 JSON 可解析", Boolean(validTranslation)));
  cases.push(caseResult(
    "翻译 errorTags 白名单",
    Boolean(validTranslation) && whitelisted(validTranslation.errorTags, TRANSLATION_REVIEW_ERROR_TAGS),
  ));
  const fenced = parseTranslationReviewResult(`\`\`\`json\n${TRANSLATION_CASES[1].raw}\n\`\`\``);
  cases.push(caseResult("翻译解析容忍代码围栏", Boolean(fenced)));
  cases.push(caseResult("翻译乱码返回 null", parseTranslationReviewResult("not json at all") === null));

  const level1 = parseQuestionHintResult(HINT_RAW_CASES.level1, 1);
  cases.push(caseResult("一级提示解析且 level=1", Boolean(level1) && level1.level === 1));
  cases.push(caseResult(
    "二级内容不能冒充一级",
    parseQuestionHintResult(HINT_RAW_CASES.level2, 1) === null,
  ));
  const level3 = parseQuestionHintResult(HINT_RAW_CASES.level3IncompleteCoverage, 3, ["A", "B", "C", "D"]);
  cases.push(caseResult(
    "三级提示选项覆盖不全被识别",
    Boolean(level3) && level3.hasFullOptionCoverage === false,
  ));

  const diagnosis = parseQuestionDiagnosisResult(DIAGNOSIS_RAW_CASES.valid, {
    optionKeys: ["A", "B", "C", "D"],
    firstAnswer: "B",
    redoAnswer: "",
    hasUserReasoning: false,
  });
  cases.push(caseResult("错因诊断 JSON 可解析", Boolean(diagnosis)));
  cases.push(caseResult(
    "无用户思路时 high 置信度被降级",
    Boolean(diagnosis) && diagnosis.confidence === "medium",
  ));
  cases.push(caseResult(
    "userErrorTags 白名单过滤",
    Boolean(diagnosis) && whitelisted(diagnosis.inferredCause.userErrorTags, USER_ERROR_TAGS),
  ));
  cases.push(caseResult(
    "选项只能来自本地作答",
    Boolean(diagnosis) && diagnosis.selectedOptionAnalysis.every((item) => item.selectedOption === "B"),
  ));

  const dirty = parseQuestionDiagnosisResult(DIAGNOSIS_RAW_CASES.invalidTagsAndConfidence, {
    optionKeys: ["A", "B", "C", "D"],
    firstAnswer: "B",
    redoAnswer: "",
    hasUserReasoning: false,
  });
  cases.push(caseResult(
    "非法 userErrorTags / optionTrapType 被清除",
    Boolean(dirty)
      && dirty.inferredCause.userErrorTags.length === 0
      && dirty.selectedOptionAnalysis.every((item) => item.optionTrapType === ""),
  ));
  cases.push(caseResult(
    "非法 questionType 归一化为其他",
    Boolean(dirty) && dirty.questionType === "其他",
  ));
  return cases;
}

function answerLeakCases() {
  const cases = [];
  for (const item of HINT_LEAK_CASES) {
    const check = validateHintNoAnswerLeak(item.text, item.level);
    cases.push(caseResult(
      item.name,
      item.leak ? check.ok === false : check.ok === true,
      check.ok ? "" : `reason=${check.reason}`,
    ));
  }
  const level1Messages = buildQuestionHintLevel1Messages({
    questionText: "What does the author suggest?",
    articleText: "The author suggests reading widely.",
    chapter: "Fixture",
    resourceId: "r1",
    options: [{ key: "A", text: "Option A" }],
    officialAnswer: "A",
    firstAnswer: "A",
    redoAnswer: "B",
    drawerAnswer: "A",
  });
  const level2Messages = buildQuestionHintLevel2Messages({
    questionText: "What does the author suggest?",
    articleText: "The author suggests reading widely.",
    chapter: "Fixture",
    resourceId: "r1",
    options: [{ key: "A", text: "Option A" }],
    officialAnswer: "A",
    firstAnswer: "A",
  });
  for (const [label, messages] of [["一级输入隔离", level1Messages], ["二级输入隔离", level2Messages]]) {
    const serialized = JSON.stringify(messages);
    const leaked = /【四个选项】|【官方答案】|首次答案|重做答案|悬浮题窗答案|Option A/.test(serialized);
    cases.push(caseResult(`${label}：输入构造不携带选项/答案`, !leaked));
  }
  return cases;
}

function evidenceCases() {
  const cases = [];
  for (const item of EVIDENCE_CASES) {
    const result = validateEvidenceAgainstContext(item.evidence, item.article);
    cases.push(caseResult(
      item.name,
      item.valid ? result.ok === true : result.ok === false,
      result.ok ? "" : `invalid=${result.invalid.length}`,
    ));
  }
  return cases;
}

function translationFixtureCases() {
  const cases = [];
  let expectedTagHitCount = 0;
  let expectedTagCases = 0;
  for (const item of TRANSLATION_CASES) {
    const result = parseTranslationReviewResult(item.raw);
    const parseOk = Boolean(result);
    const whitelistOk = parseOk && whitelisted(result.errorTags, TRANSLATION_REVIEW_ERROR_TAGS);
    let contentOk = true;
    let hit = false;
    if (parseOk) {
      if (item.expectedTags.length === 0) {
        contentOk = result.errorTags.length === 0 && reviewHasNoProblems(result);
      } else {
        hit = item.expectedTags.some((tag) => result.errorTags.includes(tag));
        expectedTagCases += 1;
        if (hit) expectedTagHitCount += 1;
      }
    }
    cases.push(caseResult(
      `翻译 fixture：${item.label}`,
      parseOk && whitelistOk && contentOk,
      parseOk ? `tags=${JSON.stringify(result.errorTags)}` : "parse failed",
    ));
  }
  return { cases, expectedTagHitCount, expectedTagCases };
}

function whitelistCases() {
  const cases = [];
  const badTags = parseTranslationReviewResult(
    JSON.stringify({
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
      errorTags: ["瞎编的标签"],
    }),
  );
  cases.push(caseResult("翻译 errorTags 拒绝白名单外标签", Boolean(badTags) && badTags.errorTags.length === 0));
  const trapCheck = parseQuestionHintResult(
    JSON.stringify({
      version: 1,
      level: 2,
      questionType: "细节题",
      questionIntent: "",
      paraphrases: [],
      reasoningSteps: [],
      trapTypes: ["不存在的陷阱"],
      finalCheck: "",
    }),
    2,
  );
  cases.push(caseResult("trapTypes 拒绝白名单外类型", Boolean(trapCheck) && trapCheck.trapTypes.length === 0));
  cases.push(caseResult("QUESTION_TYPES 常量可用", Array.isArray(QUESTION_TYPES) && QUESTION_TYPES.length > 0));
  cases.push(caseResult("TRAP_TYPES 常量可用", Array.isArray(TRAP_TYPES) && TRAP_TYPES.length > 0));
  return cases;
}

export async function runOfflineEvalSuites() {
  const timestamp = Date.now();
  const startedAt = timestamp;
  const suites = [];
  let passed = 0;
  let failed = 0;

  const suitesSpec = [
    { id: "parsers", name: "AI 解析器", build: parsersCases },
    { id: "answer-leak", name: "答案泄露检测", build: answerLeakCases },
    { id: "evidence", name: "Evidence 校验", build: evidenceCases },
    { id: "translation-fixtures", name: "翻译批改 Fixture", build: translationFixtureCases, hasTagRate: true },
    { id: "whitelists", name: "白名单保护", build: whitelistCases },
  ];

  for (const spec of suitesSpec) {
    const built = spec.build();
    const cases = Array.isArray(built) ? built : built.cases;
    const suitePassed = cases.filter((item) => item.pass).length;
    const suiteFailed = cases.length - suitePassed;
    passed += suitePassed;
    failed += suiteFailed;
    const suite = {
      id: spec.id,
      name: spec.name,
      caseCount: cases.length,
      passed: suitePassed,
      failed: suiteFailed,
      passRate: cases.length ? suitePassed / cases.length : null,
      parseSuccessRate: null,
      answerLeakRate: null,
      evidenceValidationRate: null,
      expectedTagHitRate: null,
    };
    if (spec.id === "parsers") {
      suite.parseSuccessRate = cases.filter((item) => item.pass).length / Math.max(1, cases.length);
    }
    if (spec.id === "answer-leak") {
      const leakNames = new Set(HINT_LEAK_CASES.filter((item) => item.leak).map((item) => item.name));
      const leakCases = cases.filter((item) => leakNames.has(item.name));
      suite.answerLeakRate = leakCases.length ? leakCases.filter((item) => item.pass).length / leakCases.length : null;
    }
    if (spec.id === "evidence") {
      const invalidNames = new Set(EVIDENCE_CASES.filter((item) => !item.valid).map((item) => item.name));
      const invalidCases = cases.filter((item) => invalidNames.has(item.name));
      suite.evidenceValidationRate = invalidCases.length
        ? invalidCases.filter((item) => item.pass).length / invalidCases.length
        : null;
    }
    if (spec.hasTagRate && !Array.isArray(built)) {
      suite.expectedTagHitRate = built.expectedTagCases
        ? built.expectedTagHitCount / built.expectedTagCases
        : null;
    }
    suites.push(suite);
  }

  return {
    suite: "offline",
    timestamp,
    generatedAt: new Date(timestamp).toISOString(),
    appVersion: "0.1.0",
    caseCount: passed + failed,
    passed,
    failed,
    passRate: passed + failed ? passed / (passed + failed) : null,
    durationMs: Date.now() - startedAt,
    suites,
  };
}

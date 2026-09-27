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
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  setTimeout,
  clearTimeout,
};
globalThis.CustomEvent = class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };

const { setCurrentUsername } = await import("../src/userData.js");
const {
  TASK_CLOZE_CONTEXT_REVIEW,
  TASK_CLOZE_DIAGNOSIS,
  TASK_CLOZE_EXPLANATION,
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
  buildClozeAiMessages,
  buildClozeAnalysisDetail,
  buildClozeHintDetail,
  clozeAiAvailability,
} = await import("../src/clozeAiTasks.js");
const {
  detectClozeHintLeak,
  hasAuthenticClozeEvidence,
  parseClozeAiResult,
} = await import("../src/clozeAiResultParsers.js");
const { clearClozeAiInflightForTests, runClozeAiTask } = await import("../src/clozeAiService.js");

function fresh(username = "alice") {
  localStorage.clear();
  setCurrentUsername(username);
  clearClozeAiInflightForTests();
}

const sentence = {
  sentenceId: "cloze:resource:p1s1:abc",
  source: "People usually __CLOZE_BLANK_4__ this pattern in context.",
};
const nearby = [{ sentenceId: "cloze:resource:p1s2:def", source: "The following sentence supplies a contrast." }];
const options = [
  { key: "A", text: "classify" },
  { key: "B", text: "record" },
  { key: "C", text: "describe" },
  { key: "D", text: "connect" },
];

function hintDetail(taskType = TASK_CLOZE_HINT_1) {
  return buildClozeHintDetail({
    taskType,
    resourceId: "postgraduate-2023-cloze",
    clozeId: "cloze-2023",
    blankNumber: 4,
    chapter: "2023 完形",
    currentSentence: sentence,
    contextSources: nearby,
    options,
    officialAnswer: "C",
    firstAnswer: "A",
    reviewAnswer: "B",
    confidence: "guess",
  });
}

function analysisDetail(taskType = TASK_CLOZE_EXPLANATION, overrides = {}) {
  return buildClozeAnalysisDetail({
    taskType,
    resourceId: "postgraduate-2023-cloze",
    clozeId: "cloze-2023",
    blankNumber: 4,
    chapter: "2023 完形",
    currentSentence: sentence,
    evidenceSources: nearby,
    options,
    officialAnswer: "C",
    firstAnswer: "A",
    reviewAnswer: "C",
    manualAnalysis: {
      prediction: "这里需要表达描述一群人",
      basisTypes: ["context", "collocation"],
      references: nearby,
      translation: "人们通常在语境中描述这种模式。",
      confidence: "guess",
      corrected: true,
      analyzed: true,
    },
    ...overrides,
  });
}

test("阶段门禁：cover/初做/订正/final-read 均不开放完形 AI", () => {
  for (const stageId of ["cloze-cover", "cloze-first-attempt", "cloze-correction", "cloze-final-read"]) {
    assert.deepEqual(clozeAiAvailability({ stageId, analyzed: true, hasOfficial: true, officialAnswer: "A", firstAnswer: "B" }), {
      hint1: false, hint2: false, explanation: false, diagnosis: false, contextReview: false,
    });
  }
});

test("self-review 只开放两级提示", () => {
  assert.deepEqual(clozeAiAvailability({ stageId: "cloze-self-review" }), {
    hint1: true, hint2: true, explanation: false, diagnosis: false, contextReview: false,
  });
});

test("analysis analyzed=false 不开放 D AI", () => {
  assert.equal(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: false, hasOfficial: true, officialAnswer: "C", firstAnswer: "A" }).explanation, false);
});

test("analysis 有官方答案时开放完整讲解", () => {
  const result = clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: true, officialAnswer: "C" });
  assert.equal(result.explanation, true);
  assert.equal(result.contextReview, false);
});

test("初做错误时开放错因分析", () => {
  assert.equal(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: true, officialAnswer: "C", firstAnswer: "A", reviewAnswer: "C" }).diagnosis, true);
});

test("复查错误时开放错因分析", () => {
  assert.equal(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: true, officialAnswer: "C", firstAnswer: "C", reviewAnswer: "B" }).diagnosis, true);
});

test("两次正确或未作答时不开放错因分析", () => {
  assert.equal(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: true, officialAnswer: "C", firstAnswer: "C", reviewAnswer: "C" }).diagnosis, false);
  assert.equal(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: true, officialAnswer: "C" }).diagnosis, false);
});

test("analysis 无官方答案只开放语境复盘", () => {
  assert.deepEqual(clozeAiAvailability({ stageId: "cloze-analysis", analyzed: true, hasOfficial: false }), {
    hint1: false, hint2: false, explanation: false, diagnosis: false, contextReview: true,
  });
});

test("hint DTO 白名单裁剪：没有 options/officialAnswer/first/review/confidence", () => {
  const detail = hintDetail();
  for (const key of ["options", "officialAnswer", "firstAnswer", "reviewAnswer", "confidence", "localAttempts", "manualAnalysis"]) {
    assert.equal(Object.hasOwn(detail, key), false, `hint detail 不应含 ${key}`);
  }
  assert.equal(detail.currentSentence.sentenceId, sentence.sentenceId);
});

test("hint 1/2 消息不含选项、答案、作答与 confidence", () => {
  for (const type of [TASK_CLOZE_HINT_1, TASK_CLOZE_HINT_2]) {
    const serialized = JSON.stringify(buildClozeAiMessages(type, hintDetail(type)));
    for (const secret of ["classify", "record", "describe", "connect", "officialAnswer", "firstAnswer", "reviewAnswer", "confidence"]) {
      assert.equal(serialized.includes(secret), false, `${type} 不得发送 ${secret}`);
    }
  }
});

test("analysis DTO 只保留允许的 C 阶段人工字段", () => {
  const detail = analysisDetail();
  assert.deepEqual(Object.keys(detail.manualAnalysis).sort(), ["basisTypes", "prediction", "references", "translation"]);
  assert.equal(JSON.stringify(detail.manualAnalysis).includes("confidence"), false);
  assert.equal(JSON.stringify(detail.manualAnalysis).includes("corrected"), false);
  assert.equal(JSON.stringify(detail.manualAnalysis).includes("analyzed"), false);
});

test("无答案语境复盘 DTO 不含 options/officialAnswer/localAttempts", () => {
  const detail = analysisDetail(TASK_CLOZE_CONTEXT_REVIEW, { officialAnswer: "", options: [] });
  assert.equal(Object.hasOwn(detail, "options"), false);
  assert.equal(Object.hasOwn(detail, "officialAnswer"), false);
  assert.equal(Object.hasOwn(detail, "localAttempts"), false);
});

test("本地作答事实计算 first/review 正误，不读取 AI 判断", () => {
  const detail = analysisDetail(TASK_CLOZE_DIAGNOSIS);
  assert.deepEqual(detail.localAttempts.first, { answered: true, answer: "A", result: "wrong" });
  assert.deepEqual(detail.localAttempts.review, { answered: true, answer: "C", result: "correct" });
});

test("答案字母泄露检测", () => {
  assert.equal(detectClozeHintLeak("正确答案是 C", options.map((item) => item.text)).leaked, true);
  assert.equal(detectClozeHintLeak("建议选择 B 项", options.map((item) => item.text)).leaked, true);
});

test("option 原词泄露检测", () => {
  assert.deepEqual(detectClozeHintLeak("这里可直接填 describe", options.map((item) => item.text)).reasons, ["option-text"]);
});

test("正常方向提示不会误判泄露", () => {
  assert.equal(detectClozeHintLeak("观察及物动词与宾语的语义搭配，再看前文定义。", options.map((item) => item.text)).leaked, false);
});

test("hint 泄露后只 strict retry 一次，第二次安全结果可用", async () => {
  fresh();
  const calls = [];
  const responses = [
    '{"level":1,"focus":"正确答案是 C describe","grammarSignals":[],"logicSignals":[],"selfCheckQuestion":""}',
    '{"level":1,"focus":"观察动词与宾语的语义关系","grammarSignals":["及物动词"],"logicSignals":[],"selfCheckQuestion":"前文如何定义这群人？"}',
  ];
  const result = await runClozeAiTask({
    taskType: TASK_CLOZE_HINT_1,
    detail: hintDetail(),
    safetyOptionTexts: options.map((item) => item.text),
    apiKey: "test",
    useCache: false,
    callAi: async (request) => { calls.push(request); return { content: responses[calls.length - 1] }; },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /上一次回答未通过/);
  assert.equal(result.status, "ok");
});

test("连续两次泄露会拦截，不展示原始答案", async () => {
  fresh();
  let calls = 0;
  const result = await runClozeAiTask({
    taskType: TASK_CLOZE_HINT_1,
    detail: hintDetail(),
    safetyOptionTexts: options.map((item) => item.text),
    apiKey: "test",
    useCache: false,
    callAi: async () => { calls += 1; return { content: '{"level":1,"focus":"答案为 C","grammarSignals":[],"logicSignals":[],"selfCheckQuestion":""}' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "unsafe");
  assert.equal(result.assistant.content.includes("答案为 C"), false);
});

test("service 发给模型的 hint request 不含安全侧 optionTexts", async () => {
  fresh();
  let sent = "";
  await runClozeAiTask({
    taskType: TASK_CLOZE_HINT_1,
    detail: hintDetail(),
    safetyOptionTexts: options.map((item) => item.text),
    apiKey: "test",
    useCache: false,
    callAi: async (request) => {
      sent = JSON.stringify(request.messages);
      return { content: '{"level":1,"focus":"观察局部句法","grammarSignals":[],"logicSignals":[],"selfCheckQuestion":"空后接什么？"}' };
    },
  });
  for (const option of options) assert.equal(sent.includes(option.text), false);
});

test("完整讲解解析忽略模型返回的 correct/wrong 与 correctAnswer", () => {
  const detail = analysisDetail();
  const raw = JSON.stringify({
    correctAnswer: "A",
    coreRequirement: "需要与宾语形成语义搭配",
    grammar: "及物动词",
    contextLogic: "定义关系",
    optionNotes: [{ key: "A", correct: true, result: "correct", explanation: "词义不合" }],
    evidence: [{ sentenceId: sentence.sentenceId, source: sentence.source, explanation: "所在句" }],
    takeaway: "先定语义角色",
  });
  const parsed = parseClozeAiResult(raw, TASK_CLOZE_EXPLANATION, detail);
  assert.equal(Object.hasOwn(parsed, "correctAnswer"), false);
  assert.equal(Object.hasOwn(parsed.optionNotes[0], "correct"), false);
  assert.equal(Object.hasOwn(parsed.optionNotes[0], "result"), false);
});

test("evidence 必须同时匹配 stable sentenceId 与逐字 source", () => {
  const detail = analysisDetail();
  const raw = JSON.stringify({
    coreRequirement: "语义角色",
    evidence: [
      { sentenceId: sentence.sentenceId, source: "伪造原文", explanation: "bad" },
      { sentenceId: "fake-id", source: sentence.source, explanation: "bad" },
      { sentenceId: sentence.sentenceId, source: sentence.source, explanation: "good" },
    ],
  });
  const parsed = parseClozeAiResult(raw, TASK_CLOZE_EXPLANATION, detail);
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].explanation, "good");
  assert.equal(hasAuthenticClozeEvidence(parsed, TASK_CLOZE_EXPLANATION), true);
});

test("无真实 evidence 的 analysis 响应 strict retry 后仍失败并拦截原文", async () => {
  fresh();
  let calls = 0;
  const result = await runClozeAiTask({
    taskType: TASK_CLOZE_EXPLANATION,
    detail: analysisDetail(),
    apiKey: "test",
    useCache: false,
    callAi: async () => {
      calls += 1;
      return { content: JSON.stringify({ coreRequirement: "猜测", evidence: [{ sentenceId: "fake", source: "fake" }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "parse-failed");
  assert.equal(result.assistant.content.includes("猜测"), false);
});

test("AI 运行不修改人工分析与学习状态对象", async () => {
  fresh();
  const learningState = {
    firstAnswer: "A",
    reviewAnswer: "C",
    confidence: "guess",
    corrected: true,
    analyzed: true,
    prediction: "我的预判",
    basisTypes: ["context"],
    references: [{ ...nearby[0] }],
  };
  const before = structuredClone(learningState);
  const detail = analysisDetail(TASK_CLOZE_CONTEXT_REVIEW, {
    officialAnswer: "",
    options: [],
    manualAnalysis: {
      prediction: learningState.prediction,
      basisTypes: learningState.basisTypes,
      references: learningState.references,
      translation: "我的译文",
    },
  });
  await runClozeAiTask({
    taskType: TASK_CLOZE_CONTEXT_REVIEW,
    detail,
    apiKey: "test",
    useCache: false,
    callAi: async () => ({ content: JSON.stringify({
      contextLogic: "只做语境复盘",
      manualAnalysisFeedback: "继续核对逻辑",
      evidence: [{ sentenceId: sentence.sentenceId, source: sentence.source, explanation: "所在句" }],
      reviewQuestions: ["转折在哪里？"],
    }) }),
  });
  assert.deepEqual(learningState, before);
});

test("cloze AI cache 按现有账号作用域隔离", async () => {
  fresh("alice");
  let calls = 0;
  const request = {
    taskType: TASK_CLOZE_HINT_1,
    detail: hintDetail(),
    safetyOptionTexts: options.map((item) => item.text),
    apiKey: "test",
    callAi: async () => {
      calls += 1;
      return { content: '{"level":1,"focus":"观察局部句法","grammarSignals":[],"logicSignals":[],"selfCheckQuestion":"空后接什么？"}' };
    },
  };
  await runClozeAiTask(request);
  await runClozeAiTask(request);
  assert.equal(calls, 1, "同账号命中缓存");
  setCurrentUsername("bob");
  await runClozeAiTask(request);
  assert.equal(calls, 2, "另一账号不得读取 Alice 缓存");
});


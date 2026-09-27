import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const {
  QUESTION_DIAGNOSIS_PROMPT_VERSION,
  TASK_QUESTION_DIAGNOSIS,
  buildQuestionDiagnosisFingerprint,
  buildQuestionDiagnosisMessages,
  buildQuestionDiagnosisStrictMessages,
  buildQuestionDiagnosisUserMessage,
} = await import("../src/aiTasks.js");
const { parseQuestionDiagnosisResult } = await import("../src/aiResultParsers.js");
const { normalizeEvidenceText, validateEvidenceAgainstContext } = await import("../src/questionDiagnosisEvidence.js");
const {
  getQuestionDiagnosisEntryLabel,
  runQuestionDiagnosis,
} = await import("../src/questionDiagnosisService.js");
const { questionHintKey } = await import("../src/questionHintService.js");
const { readQuestionDiagnosisCache } = await import("../src/aiReviewCache.js");
const { listAiHistory } = await import("../src/ai.js");
const {
  getCurrentUsername,
  getUserItem,
  removeUserItem,
  setCurrentUsername,
  setUserItem,
} = await import("../src/userData.js");

const safeDetail = {
  resourceId: "resource-2018-text2",
  chapter: "英一.18.text2",
  questionId: "q-2-22-0",
  questionNumber: "22",
  questionText: "The author suggests that the special needs of women…",
  articleText: "Paragraph one.\n\nParagraph two with however.",
  passageLabel: "Text 2",
  scope: "first",
  options: [
    { key: "A", text: "Alpha option" },
    { key: "B", text: "Beta option" },
    { key: "C", text: "Gamma option" },
    { key: "D", text: "Delta option" },
  ],
  officialAnswer: "D",
  firstAnswer: "B",
  redoAnswer: "D",
  canShowFullExplanation: true,
};

const legalDiagnosis = {
  version: 1,
  questionType: "推理题",
  diagnosisBasis: "answers-and-redo",
  confidence: "medium",
  observedFacts: ["第一次选择 B，官方答案为 D", "重做选择 D"],
  evidence: [
    { source: "Paragraph two with however.", explanation: "however 后是作者观点" },
  ],
  paraphrases: [
    { questionExpression: "作者建议", sourceExpression: "the author suggests", explanation: "同义替换" },
  ],
  selectedOptionAnalysis: [
    { attempt: "first", selectedOption: "B", optionTrapType: "范围扩大", whyAttractive: "B 与第二段名词相近", whyWrong: "扩大了范围" },
    { attempt: "redo", selectedOption: "D", optionTrapType: "", whyAttractive: "", whyWrong: "" },
  ],
  attemptComparison: { available: true, comment: "重做回到正确证据" },
  inferredCause: {
    summary: "可能最初只看到表面词",
    userErrorTags: ["同义替换未识别"],
    reasoning: "B 与原文词面相近",
    uncertainty: "无法确认真实过程",
  },
  nextTimeRule: "定位后核对选项是否与原文同义替换",
  selfCheckQuestions: ["这个选项的每个词都能在原文找到对应吗？"],
};

function jsonResponse(value) {
  return { content: JSON.stringify(value), reasoning: "" };
}

test("测试 1：入口标签按本地作答计算（A-E + 仅重做）", () => {
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "B", redoAnswer: "", officialAnswer: "D" }), "AI 错因诊断");
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "B", redoAnswer: "D", officialAnswer: "D" }), "复盘首次错因");
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "B", redoAnswer: "C", officialAnswer: "D" }), "AI 错因诊断");
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "D", redoAnswer: "B", officialAnswer: "D" }), "诊断重做错误");
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "D", redoAnswer: "D", officialAnswer: "D" }), null);
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "", redoAnswer: "", officialAnswer: "D" }), null);
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "", redoAnswer: "C", officialAnswer: "D" }), "AI 错因诊断");
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "", redoAnswer: "D", officialAnswer: "D" }), null);
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "D", redoAnswer: "", officialAnswer: "D" }), null);
  assert.equal(getQuestionDiagnosisEntryLabel({ firstAnswer: "B", redoAnswer: "D", officialAnswer: "" }), null);
});

test("测试 2：诊断请求体只含显式字段，不含无关数据", () => {
  const messages = buildQuestionDiagnosisMessages({
    ...safeDetail,
    userReasoning: "我看到第二段的 however，所以选了 B",
  });
  const all = JSON.stringify(messages);
  assert.match(all, /The author suggests/);
  assert.match(all, /\[A\] Alpha option/);
  assert.match(all, /【官方答案】D/);
  assert.match(all, /用户首次答案：B/);
  assert.match(all, /用户重做答案：D/);
  assert.match(all, /Paragraph two with however/);
  assert.match(all, /我当时是怎么想的/);
  assert.doesNotMatch(messages[1].content, /drawerAnswer|correctAnswer|secret/);
});

test("测试 2b：用户历史消息包含题干摘要与补充思路", () => {
  const userMessage = buildQuestionDiagnosisUserMessage({
    ...safeDetail,
    userReasoning: "我当时觉得 B 和第二段是同义词",
  });
  assert.equal(userMessage.label, "错因诊断");
  assert.match(userMessage.content, /Q22/);
  assert.match(userMessage.content, /我当时是怎么想的：我当时觉得 B 和第二段是同义词/);
});

test("测试 3：权限不允许时逻辑层拒绝且不发请求", async () => {
  let calls = 0;
  const response = await runQuestionDiagnosis({
    detail: { ...safeDetail, canShowFullExplanation: false },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(response.status, "blocked");
  assert.equal(calls, 0);
  assert.equal(response.assistant.structured, undefined);

  const noAnswer = await runQuestionDiagnosis({
    detail: { ...safeDetail, officialAnswer: "" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(noAnswer.status, "blocked");
  assert.equal(calls, 0);
});

test("测试 4：无作答或两次都对时不虚构诊断", async () => {
  const noRecords = await runQuestionDiagnosis({
    detail: { ...safeDetail, firstAnswer: "", redoAnswer: "" },
    apiKey: "test-key",
    fetcher: async () => jsonResponse(legalDiagnosis),
  });
  assert.equal(noRecords.status, "invalid");

  const bothCorrect = await runQuestionDiagnosis({
    detail: { ...safeDetail, firstAnswer: "D", redoAnswer: "D" },
    apiKey: "test-key",
    fetcher: async () => jsonResponse(legalDiagnosis),
  });
  assert.equal(bothCorrect.status, "invalid");
});

test("测试 5：结构化解析支持围栏/缺字段/非法标签/置信度与依据本地约束", () => {
  const fenced = `前言\n\`\`\`json\n${JSON.stringify(legalDiagnosis)}\n\`\`\`\n后记`;
  const parsed = parseQuestionDiagnosisResult(fenced, {
    optionKeys: ["A", "B", "C", "D"],
    firstAnswer: "B",
    redoAnswer: "D",
    hasUserReasoning: false,
  });
  assert.equal(parsed.questionType, "推理题");
  assert.equal(parsed.diagnosisBasis, "answers-and-redo");
  assert.deepEqual(parsed.selectedOptionAnalysis[0], {
    attempt: "first",
    selectedOption: "B",
    optionTrapType: "范围扩大",
    whyAttractive: "B 与第二段名词相近",
    whyWrong: "扩大了范围",
  });
  assert.equal(parsed.attemptComparison.available, true);
  assert.equal("correctAnswer" in parsed, false);

  const dirty = parseQuestionDiagnosisResult(JSON.stringify({
    ...legalDiagnosis,
    questionType: "作文题",
    confidence: "very-high",
    diagnosisBasis: "answers-only",
    inferredCause: { summary: "x", userErrorTags: ["粗心", "脑子没转过来", "阅读能力差", "同义替换未识别"] },
    selectedOptionAnalysis: [
      { attempt: "first", selectedOption: "E", optionTrapType: "范围扩大", whyAttractive: "x", whyWrong: "y" },
      { attempt: "redo", selectedOption: "D", optionTrapType: "不存在类型", whyAttractive: "x", whyWrong: "y" },
      { attempt: "third", selectedOption: "B", optionTrapType: "范围缩小", whyAttractive: "x", whyWrong: "y" },
    ],
  }), {
    optionKeys: ["A", "B", "C", "D"],
    firstAnswer: "B",
    redoAnswer: "D",
    hasUserReasoning: false,
  });
  assert.equal(dirty.questionType, "其他");
  assert.equal(dirty.confidence, "low");
  assert.equal(dirty.diagnosisBasis, "answers-and-redo");
  assert.deepEqual(dirty.inferredCause.userErrorTags, ["同义替换未识别"]);
  assert.equal(dirty.selectedOptionAnalysis.length, 2);
  assert.equal(dirty.selectedOptionAnalysis[0].selectedOption, "B");
  assert.equal(dirty.selectedOptionAnalysis[1].optionTrapType, "");

  const withReasoning = parseQuestionDiagnosisResult(JSON.stringify({
    ...legalDiagnosis,
    confidence: "high",
    diagnosisBasis: "answers-only",
  }), {
    optionKeys: ["A", "B", "C", "D"],
    firstAnswer: "B",
    redoAnswer: "D",
    hasUserReasoning: true,
  });
  assert.equal(withReasoning.confidence, "high");
  assert.equal(withReasoning.diagnosisBasis, "user-reasoning");

  const missing = parseQuestionDiagnosisResult(JSON.stringify({
    version: 1,
    questionType: "细节题",
  }), {
    firstAnswer: "B",
    redoAnswer: "",
    hasUserReasoning: false,
  });
  assert.equal(missing.attemptComparison.available, false);
  assert.deepEqual(missing.selectedOptionAnalysis, []);
  assert.equal(missing.confidence, "low");

  assert.equal(parseQuestionDiagnosisResult("not json at all", { firstAnswer: "B" }), null);
});

test("测试 5b：超长字段被裁剪", () => {
  const long = parseQuestionDiagnosisResult(JSON.stringify({
    ...legalDiagnosis,
    nextTimeRule: "x".repeat(5000),
  }), {
    firstAnswer: "B",
    redoAnswer: "D",
    hasUserReasoning: false,
  });
  assert.equal(long.nextTimeRule.length, 4001);
  assert.match(long.nextTimeRule, /…$/);
});

test("测试 6：证据校验支持引号/破折号归一化并拦截伪造原文", () => {
  assert.equal(normalizeEvidenceText("  It’s — really— “quoted”  "), "It's-really-\"quoted\"");

  const context = "The plan — though risky — was bold. She said “yes”.";
  assert.equal(validateEvidenceAgainstContext([
    { source: "The plan--though risky--was bold." },
    { source: "She said \"yes\"." },
  ], context).ok, true);

  const invented = validateEvidenceAgainstContext([
    { source: "This sentence does not exist in the article." },
  ], context);
  assert.equal(invented.ok, false);
  assert.equal(invented.invalid.length, 1);

  assert.equal(validateEvidenceAgainstContext([], context).ok, true);
});

test("测试 7：证据失败自动严格重试一次，通过后正常缓存", async () => {
  setCurrentUsername("A");
  const messagesSeen = [];
  let calls = 0;
  const response = await runQuestionDiagnosis({
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async ({ messages }) => {
      calls += 1;
      messagesSeen.push(messages);
      if (calls === 1) {
        return jsonResponse({ ...legalDiagnosis, evidence: [{ source: "Invented fake evidence.", explanation: "x" }] });
      }
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(calls, 2);
  assert.equal(response.status, "ok");
  assert.equal(response.result.evidenceValidated, true);
  assert.match(messagesSeen[1][0].content, /严格重试要求/);

  const hit = await runQuestionDiagnosis({
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(hit.status, "ok");
  assert.equal(hit.cached, true);
  assert.equal(calls, 2);
});

test("测试 7b：两次证据都未通过时不缓存并标记可重试", async () => {
  setCurrentUsername("A");
  let calls = 0;
  const response = await runQuestionDiagnosis({
    detail: { ...safeDetail, questionId: "q-2-23-0", questionNumber: "23" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse({
        ...legalDiagnosis,
        evidence: [{ source: "Still not in the article.", explanation: "x" }],
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(response.status, "ok");
  assert.equal(response.result.evidenceValidated, false);
  assert.deepEqual(response.result.evidence, []);
  assert.equal(response.assistant.retryable, true);
  const fingerprint = buildQuestionDiagnosisFingerprint({
    taskType: TASK_QUESTION_DIAGNOSIS,
    model: "deepseek-chat",
    promptVersion: QUESTION_DIAGNOSIS_PROMPT_VERSION,
    resourceId: safeDetail.resourceId,
    chapter: safeDetail.chapter,
    questionId: "q-2-23-0",
    questionText: safeDetail.questionText,
    options: safeDetail.options,
    officialAnswer: "D",
    firstAnswer: "B",
    redoAnswer: "D",
    articleText: safeDetail.articleText,
    userReasoning: "",
  });
  assert.equal(readQuestionDiagnosisCache(fingerprint), null);
});

test("测试 8：解析失败降级为原始回答且不缓存", async () => {
  setCurrentUsername("A");
  const response = await runQuestionDiagnosis({
    detail: { ...safeDetail, questionId: "q-2-24-0", questionNumber: "24" },
    apiKey: "test-key",
    fetcher: async () => ({ content: "这不是 JSON", reasoning: "" }),
  });
  assert.equal(response.status, "parse-failed");
  assert.equal(response.assistant.parseFallback, true);
  assert.equal(response.assistant.content, "这不是 JSON");
  const fingerprint = buildQuestionDiagnosisFingerprint({
    taskType: TASK_QUESTION_DIAGNOSIS,
    model: "deepseek-chat",
    promptVersion: QUESTION_DIAGNOSIS_PROMPT_VERSION,
    resourceId: safeDetail.resourceId,
    chapter: safeDetail.chapter,
    questionId: "q-2-24-0",
    questionText: safeDetail.questionText,
    options: safeDetail.options,
    officialAnswer: "D",
    firstAnswer: "B",
    redoAnswer: "D",
    articleText: safeDetail.articleText,
    userReasoning: "",
  });
  assert.equal(readQuestionDiagnosisCache(fingerprint), null);
});

test("测试 9：缓存命中与 redoAnswer/userReasoning 变更后失效", async () => {
  setCurrentUsername("A");
  let calls = 0;
  const base = { ...safeDetail, questionId: "q-2-25-0", questionNumber: "25" };

  const first = await runQuestionDiagnosis({
    detail: base,
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(first.status, "ok");
  assert.equal(first.cached, false);
  assert.equal(calls, 1);

  const hit = await runQuestionDiagnosis({
    detail: base,
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(hit.status, "ok");
  assert.equal(hit.cached, true);
  assert.equal(calls, 1);

  const redoChanged = await runQuestionDiagnosis({
    detail: { ...base, redoAnswer: "C" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(redoChanged.cached, false);
  assert.equal(calls, 2);

  const reasoningChanged = await runQuestionDiagnosis({
    detail: { ...base, redoAnswer: "C", userReasoning: "我当时看到第二段所以选了 B" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(reasoningChanged.cached, false);
  assert.equal(calls, 3);
});

test("测试 10：账号隔离 - A 的诊断缓存 B 不可见", async () => {
  setCurrentUsername("A");
  let aCalls = 0;
  const detailA = { ...safeDetail, questionId: "q-2-26-0", questionNumber: "26" };
  await runQuestionDiagnosis({
    detail: detailA,
    apiKey: "test-key",
    fetcher: async () => {
      aCalls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(aCalls, 1);

  setCurrentUsername("B");
  let bCalls = 0;
  const bRun = await runQuestionDiagnosis({
    detail: detailA,
    apiKey: "test-key",
    fetcher: async () => {
      bCalls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  assert.equal(bRun.cached, false);
  assert.equal(bCalls, 1);
});

test("测试 11：题目隔离 - Q 键不同", () => {
  const keyA = questionHintKey({ resourceId: "r", chapter: "c", questionId: "q-27" });
  const keyB = questionHintKey({ resourceId: "r", chapter: "c", questionId: "q-28" });
  assert.notEqual(keyA, keyB);
});

test("测试 12：历史复用同一道题的 question-help 记录", async () => {
  setCurrentUsername("A");
  const detail = { ...safeDetail, questionId: "q-2-27-0", questionNumber: "27" };
  await runQuestionDiagnosis({
    detail,
    apiKey: "test-key",
    fetcher: async () => jsonResponse(legalDiagnosis),
  });
  await runQuestionDiagnosis({
    detail: { ...detail, userReasoning: "补充：我当时觉得 B 和第二段是同义词" },
    apiKey: "test-key",
    fetcher: async () => jsonResponse(legalDiagnosis),
  });
  const records = listAiHistory().filter((record) => (
    record.kind === "question-help"
    && record.chapter === safeDetail.chapter
    && record.name.includes("Q27")
  ));
  assert.equal(records.length, 1);
  assert.equal(records[0].messages.length, 4);
});

test("测试 13：并发重复提交只产生一个有效请求", async () => {
  setCurrentUsername("A");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = runQuestionDiagnosis({
    detail: { ...safeDetail, questionId: "q-2-28-0", questionNumber: "28" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      await gate;
      return jsonResponse(legalDiagnosis);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = runQuestionDiagnosis({
    detail: { ...safeDetail, questionId: "q-2-28-0", questionNumber: "28" },
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalDiagnosis);
    },
  });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "ok");
  assert.equal(secondResult.status, "ok");
  assert.deepEqual(secondResult.result, firstResult.result);
  assert.equal(calls, 1);
});

test("账号隔离的键级验证", () => {
  setCurrentUsername("A");
  setUserItem("wuliao:test:diagnosis-isolation", "value-a");
  setCurrentUsername("B");
  assert.equal(getUserItem("wuliao:test:diagnosis-isolation"), null);
  setUserItem("wuliao:test:diagnosis-isolation", "value-b");
  setCurrentUsername("A");
  assert.equal(getUserItem("wuliao:test:diagnosis-isolation"), "value-a");
  setCurrentUsername("B");
  assert.equal(getUserItem("wuliao:test:diagnosis-isolation"), "value-b");
  removeUserItem("wuliao:test:diagnosis-isolation");
  setCurrentUsername("A");
  removeUserItem("wuliao:test:diagnosis-isolation");
  setCurrentUsername("");
  assert.equal(getCurrentUsername(), "");
});

test("共享诊断中首个消费者离开不影响第二个消费者，也不重复保存历史", async () => {
  setCurrentUsername("diagnosis-abort-user");
  const detail = { ...safeDetail, questionId: "q-shared-abort", questionNumber: "61" };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  let calls = 0, networkSignal;
  const fetcher = async ({ signal }) => { calls += 1; networkSignal = signal; started(); await gate; return jsonResponse(legalDiagnosis); };
  const first = runQuestionDiagnosis({ detail, apiKey: "test-key", signal: controller.signal, fetcher });
  await ready;
  const second = runQuestionDiagnosis({ detail, apiKey: "test-key", fetcher });
  controller.abort();
  assert.equal((await first).status, "aborted");
  assert.equal(networkSignal.aborted, false);
  release();
  const result = await second;
  assert.equal(result.status, "ok");
  assert.equal(calls, 1);
  const history = listAiHistory().filter(record => record.kind === "question-help" && record.name.includes("Q61"));
  assert.equal(history.length, 1);
  assert.equal(history[0].messages.length, 2);
  assert.equal((await runQuestionDiagnosis({ detail, apiKey: "test-key", fetcher })).cached, true);
  assert.equal(calls, 1);
});

test("无讲解权限的诊断调用不能加入同内容的合法在途请求", async () => {
  setCurrentUsername("diagnosis-permission-user");
  const detail = { ...safeDetail, questionId: "q-permission-flight", questionNumber: "62" };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const fetcher = async () => { calls += 1; started(); await gate; return jsonResponse(legalDiagnosis); };
  const first = runQuestionDiagnosis({ detail, apiKey: "test-key", fetcher });
  await ready;
  const forbidden = runQuestionDiagnosis({ detail: { ...detail, canShowFullExplanation: false }, apiKey: "test-key", fetcher });
  release();
  const [valid, blocked] = await Promise.all([first, forbidden]);
  assert.equal(valid.status, "ok");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.assistant.structured, undefined);
  assert.equal(calls, 1);
});

test("结构化诊断按 questionId 隔离：首请求取消不能写入首题或返回首题元数据", async () => {
  setCurrentUsername("diagnosis-question-identity-user");
  const firstDetail = { ...safeDetail, questionId: "diagnosis-identity-first" };
  const secondDetail = { ...firstDetail, questionId: "diagnosis-identity-second" };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const controller = new AbortController();
  const fetcher = async () => { calls += 1; started(); await gate; return jsonResponse(legalDiagnosis); };
  const first = runQuestionDiagnosis({ detail: firstDetail, apiKey: "test-key", signal: controller.signal, fetcher });
  await ready;
  const second = runQuestionDiagnosis({ detail: secondDetail, apiKey: "test-key", fetcher });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await first).status, "aborted");
  release();
  const response = await second;
  assert.equal(response.status, "ok");
  const progress = JSON.parse(getUserItem("wuliao:ai:question-hint-progress") || "{}");
  assert.deepEqual({
    calls,
    metadataIdentity: questionHintKey(response.assistant.diagnosisMeta),
    progressIdentities: Object.keys(progress),
    historyLinkedToSecond: progress[questionHintKey(secondDetail)]?.historyId === response.historyId,
  }, {
    calls: 2,
    metadataIdentity: questionHintKey(secondDetail),
    progressIdentities: [questionHintKey(secondDetail)],
    historyLinkedToSecond: true,
  });
});

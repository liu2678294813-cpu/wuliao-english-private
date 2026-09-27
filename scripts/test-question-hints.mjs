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
  QUESTION_HINT_PROMPT_VERSION,
  TASK_QUESTION_EXPLANATION,
  TASK_QUESTION_HINT_1,
  TASK_QUESTION_HINT_2,
  buildQuestionExplanationMessages,
  buildQuestionHintFingerprint,
  buildQuestionHintLevel1Messages,
  buildQuestionHintLevel2Messages,
  buildQuestionHintStrictMessages,
} = await import("../src/aiTasks.js");
const { parseQuestionHintResult } = await import("../src/aiResultParsers.js");
const { validateHintNoAnswerLeak } = await import("../src/questionHintSafety.js");
const {
  buildQuestionHintUserMessage,
  questionHintKey,
  runQuestionHint,
} = await import("../src/questionHintService.js");
const {
  getCurrentUsername,
  getUserItem,
  removeUserItem,
  setCurrentUsername,
  setUserItem,
} = await import("../src/userData.js");
const { readQuestionHintCache, writeQuestionHintCache } = await import("../src/aiReviewCache.js");

const safeDetail = {
  resourceId: "resource-2018-text2",
  chapter: "英一.18.text2",
  questionId: "q-2-22-0",
  questionNumber: "22",
  questionText: "The author suggests that the special needs of women…",
  articleText: "Paragraph one.\n\nParagraph two with however.",
  passageLabel: "Text 2",
  scope: "first",
};

const legalLevel1 = {
  version: 1,
  level: 1,
  focus: {
    location: "重点查看第三段转折后的内容",
    keywords: ["however"],
    logicSignals: ["转折"],
  },
  readingDirection: "重读第三段，注意作者态度的变化。",
  questionForUser: "作者批评的是现象本身，还是对该现象的解释？",
};

function jsonResponse(value) {
  return { content: JSON.stringify(value), reasoning: "" };
}

test("测试 1：LEVEL 1 请求体只含题干与文章，不含选项/答案", () => {
  const messages = buildQuestionHintLevel1Messages(safeDetail);
  const user = messages[1].content;
  assert.match(user, /The author suggests/);
  assert.match(user, /Paragraph one/);
  const all = JSON.stringify(messages);
  assert.doesNotMatch(all, /officialAnswer|firstAnswer|redoAnswer|drawerAnswer/);
  assert.doesNotMatch(all, /\[A\]|\[B\]|\[C\]|\[D\]/);
  assert.doesNotMatch(all, /"options"/);
});

test("测试 2：LEVEL 2 请求体同样不含选项/答案", () => {
  const messages = buildQuestionHintLevel2Messages(safeDetail);
  const user = messages[1].content;
  assert.match(user, /The author suggests/);
  assert.match(user, /Paragraph one/);
  const all = JSON.stringify(messages);
  assert.doesNotMatch(all, /officialAnswer|firstAnswer|redoAnswer|drawerAnswer/);
  assert.doesNotMatch(all, /\[A\]|\[B\]|\[C\]|\[D\]/);
  assert.doesNotMatch(all, /"options"/);
});

test("测试 3：LEVEL 3 请求体携带选项与官方答案", () => {
  const messages = buildQuestionExplanationMessages({
    ...safeDetail,
    options: [
      { key: "A", text: "Alpha option" },
      { key: "B", text: "Beta option" },
    ],
    officialAnswer: "B",
    firstAnswer: "A",
  });
  const all = JSON.stringify(messages);
  assert.match(all, /【四个选项】/);
  assert.match(all, /Alpha option/);
  assert.match(all, /Beta option/);
  assert.match(all, /【官方答案】B/);
  assert.match(all, /用户首次答案：A/);
});

test("测试 4a：权限不允许时 LEVEL 3 在逻辑层被拒绝", async () => {
  const response = await runQuestionHint({
    taskType: TASK_QUESTION_EXPLANATION,
    detail: {
      ...safeDetail,
      options: [{ key: "A", text: "x" }],
      officialAnswer: "",
      canShowFullExplanation: false,
    },
    apiKey: "",
  });
  assert.equal(response.status, "blocked");
  assert.equal(response.assistant.structured, undefined);
});

test("测试 4b：LEVEL 1 请求携带答案数据时被拒绝", async () => {
  const response = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: { ...safeDetail, officialAnswer: "B" },
    apiKey: "",
  });
  assert.equal(response.status, "invalid");
});

test("测试 4c：LEVEL 1/2 泄露答案被拦截，自动严格重试一次后仍泄露则不返回原回答", async () => {
  setCurrentUsername("hint-leak-safety-user");
  let calls = 0;
  const leaked = JSON.stringify({
    version: 1,
    level: 1,
    focus: { location: "第三段" },
    readingDirection: "",
    questionForUser: "所以应该选择 C 项。",
  });
  const response = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return { content: leaked, reasoning: "" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(response.status, "leak-blocked");
  assert.equal(response.assistant.structured, undefined);
  assert.match(response.assistant.content, /已自动拦截/);
  assert.equal(response.assistant.retryable, true);
});

test("测试 5/6：合法 LEVEL 1/2 文案通过校验", () => {
  assert.equal(validateHintNoAnswerLeak("重点查看第三段转折后的内容，注意 however。", 1).ok, true);
  assert.equal(validateHintNoAnswerLeak("本题是细节题，注意题干与原文的同义替换。", 2).ok, true);
  assert.equal(validateHintNoAnswerLeak("正确答案是 B。", 1).ok, false);
  assert.equal(validateHintNoAnswerLeak("所以应该选择 C 项。", 2).ok, false);
  assert.equal(validateHintNoAnswerLeak("正确答案是 B。", 3).ok, true);
});

test("测试 7：结构化解析支持围栏/缺数组/白名单过滤/级别校验", () => {
  const fenced = `前言\n\`\`\`json\n${JSON.stringify(legalLevel1)}\n\`\`\`\n后记`;
  const level1 = parseQuestionHintResult(fenced, 1);
  assert.equal(level1.level, 1);
  assert.deepEqual(level1.focus.keywords, ["however"]);
  assert.equal(parseQuestionHintResult(JSON.stringify({ level: 2 }), 1), null);

  const level2 = parseQuestionHintResult(JSON.stringify({
    version: 1,
    level: 2,
    questionType: "细节题",
    questionIntent: "问作者对现象的态度",
    reasoningSteps: ["先定位", "再找同义替换"],
    trapTypes: ["过度推断", "不存在的类型", "无中生有"],
    finalCheck: "检查程度限定",
  }), 2);
  assert.deepEqual(level2.trapTypes, ["过度推断", "无中生有"]);
  assert.deepEqual(level2.paraphrases, []);
});

test("测试 7b：LEVEL 3 选项分析按实际选项过滤并报告覆盖情况", () => {
  const level3 = parseQuestionHintResult(JSON.stringify({
    version: 1,
    level: 3,
    questionType: "细节题",
    correctAnswer: "B",
    coreConclusion: "作者支持该解释",
    evidence: [{ source: "第三段", explanation: "however 后是作者观点" }],
    paraphrases: [],
    optionAnalysis: [
      { option: "A", result: "wrong", reasonType: "范围扩大", explanation: "扩大范围" },
      { option: "B", result: "correct", reasonType: "", explanation: "对应原文" },
      { option: "X", result: "correct", reasonType: "", explanation: "非法选项" },
    ],
    solvingRule: "先定位转折后的观点",
  }), 3, ["A", "B", "C", "D"]);
  assert.equal(level3.optionAnalysis.length, 2);
  assert.equal(level3.hasFullOptionCoverage, false);
  assert.equal(level3.correctAnswer, "B");
});

test("测试 8：题目提示状态按题目隔离", () => {
  const key21 = questionHintKey({ ...safeDetail, questionId: "q-2-21-0", questionNumber: "21" });
  const key22 = questionHintKey(safeDetail);
  assert.notEqual(key21, key22);
});

test("测试 9：账号隔离 - A 用户的提示状态与缓存 B 用户不可见", async () => {
  setCurrentUsername("A");
  const first = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async () => jsonResponse(legalLevel1),
  });
  assert.equal(first.status, "ok");
  assert.equal(first.cached, false);

  let bCalls = 0;
  setCurrentUsername("B");
  const second = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async () => {
      bCalls += 1;
      return jsonResponse(legalLevel1);
    },
  });
  assert.equal(second.status, "ok");
  assert.equal(second.cached, false);
  assert.equal(bCalls, 1);
});

test("测试 10：缓存命中与 prompt version 失效", async () => {
  setCurrentUsername("A");
  let calls = 0;
  const hit = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: safeDetail,
    apiKey: "test-key",
    fetcher: async () => {
      calls += 1;
      return jsonResponse(legalLevel1);
    },
  });
  assert.equal(hit.status, "ok");
  assert.equal(hit.cached, true);
  assert.equal(calls, 0);

  const fingerprintV1 = buildQuestionHintFingerprint({
    taskType: TASK_QUESTION_HINT_1,
    model: "deepseek-chat",
    promptVersion: QUESTION_HINT_PROMPT_VERSION,
    resourceId: safeDetail.resourceId,
    chapter: safeDetail.chapter,
    questionId: safeDetail.questionId,
    questionText: safeDetail.questionText,
    articleText: safeDetail.articleText,
  });
  const fingerprintV2 = buildQuestionHintFingerprint({
    taskType: TASK_QUESTION_HINT_1,
    model: "deepseek-chat",
    promptVersion: QUESTION_HINT_PROMPT_VERSION + 1,
    resourceId: safeDetail.resourceId,
    chapter: safeDetail.chapter,
    questionId: safeDetail.questionId,
    questionText: safeDetail.questionText,
    articleText: safeDetail.articleText,
  });
  assert.notEqual(fingerprintV1, fingerprintV2);
  assert.equal(readQuestionHintCache(fingerprintV2), null);

  const resultObj = { level: 1, focus: { location: "x" } };
  writeQuestionHintCache(fingerprintV2, resultObj, 1);
  assert.deepEqual(readQuestionHintCache(fingerprintV2), resultObj);
});

test("严格重试提示词与用户消息标签", () => {
  const strict = buildQuestionHintStrictMessages(TASK_QUESTION_HINT_1, [
    { role: "system", content: "系统提示" },
    { role: "user", content: "用户内容" },
  ]);
  assert.match(strict[0].content, /泄露了选择题答案/);
  assert.equal(strict[1].content, "用户内容");

  const userMessage = buildQuestionHintUserMessage(TASK_QUESTION_HINT_2, safeDetail);
  assert.equal(userMessage.label, "再提示一步");
  assert.match(userMessage.content, /Q22/);
});

test("账号隔离的键级验证", () => {
  setCurrentUsername("A");
  setUserItem("wuliao:test:isolation", "value-a");
  setCurrentUsername("B");
  assert.equal(getUserItem("wuliao:test:isolation"), null);
  setUserItem("wuliao:test:isolation", "value-b");
  setCurrentUsername("A");
  assert.equal(getUserItem("wuliao:test:isolation"), "value-a");
  setCurrentUsername("B");
  assert.equal(getUserItem("wuliao:test:isolation"), "value-b");
  removeUserItem("wuliao:test:isolation");
  setCurrentUsername("A");
  removeUserItem("wuliao:test:isolation");
  setCurrentUsername("");
  assert.equal(getCurrentUsername(), "");
});

test("相同提示并发复用，首个消费者取消不影响另一消费者", async () => {
  setCurrentUsername("hint-shared-abort-user");
  const detail = { ...safeDetail, questionId: "q-hint-shared", questionNumber: "63" };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0, networkSignal;
  const controller = new AbortController();
  const fetcher = async ({ signal }) => { calls += 1; networkSignal = signal; started(); await gate; return { content: JSON.stringify(legalLevel1) }; };
  const first = runQuestionHint({ taskType: TASK_QUESTION_HINT_1, detail, apiKey: "test-key", signal: controller.signal, fetcher });
  await ready;
  const second = runQuestionHint({ taskType: TASK_QUESTION_HINT_1, detail, apiKey: "test-key", fetcher });
  controller.abort();
  assert.equal((await first).status, "aborted");
  assert.equal(networkSignal.aborted, false);
  release();
  assert.equal((await second).status, "ok");
  assert.equal(calls, 1);
  assert.equal((await runQuestionHint({ taskType: TASK_QUESTION_HINT_1, detail, apiKey: "test-key", fetcher })).cached, true);
  assert.equal(calls, 1);
});

test("无权限的完整讲解调用不能共享正在生成的答案", async () => {
  setCurrentUsername("hint-permission-user");
  const detail = { ...safeDetail, questionId: "q-hint-permission", questionNumber: "64", canShowFullExplanation: true, officialAnswer: "B", options: [{ key: "A", text: "Alpha" }, { key: "B", text: "Beta" }] };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const fetcher = async () => {
    calls += 1; started(); await gate;
    return { content: JSON.stringify({ version: 1, level: 3, correctAnswer: "B", coreConclusion: "结论", optionAnalysis: [{ option: "A", result: "wrong", explanation: "错误" }, { option: "B", result: "correct", explanation: "正确" }] }) };
  };
  const valid = runQuestionHint({ taskType: TASK_QUESTION_EXPLANATION, detail, apiKey: "test-key", fetcher });
  await ready;
  const forbidden = runQuestionHint({ taskType: TASK_QUESTION_EXPLANATION, detail: { ...detail, canShowFullExplanation: false }, apiKey: "test-key", fetcher });
  release();
  const [answer, blocked] = await Promise.all([valid, forbidden]);
  assert.equal(answer.status, "ok");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.assistant.structured, undefined);
  assert.equal(calls, 1);
});

for (const identityField of ["resourceId", "questionId"]) {
  test(`结构化提示按 ${identityField} 隔离：首请求取消后元数据与学习记录只属于有效请求`, async () => {
    setCurrentUsername(`hint-identity-${identityField}-user`);
    const firstDetail = { ...safeDetail, resourceId: `identity-${identityField}-resource`, questionId: "identity-question-first" };
    const secondDetail = { ...firstDetail, [identityField]: `${firstDetail[identityField]}-second` };
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    let calls = 0;
    const controller = new AbortController();
    // Ignore transport cancellation deliberately: the service must reject a late
    // response before writing history or progress for the cancelled identity.
    const fetcher = async () => { calls += 1; started(); await gate; return jsonResponse(legalLevel1); };
    const first = runQuestionHint({ taskType: TASK_QUESTION_HINT_1, detail: firstDetail, apiKey: "test-key", signal: controller.signal, fetcher });
    await ready;
    const second = runQuestionHint({ taskType: TASK_QUESTION_HINT_1, detail: secondDetail, apiKey: "test-key", fetcher });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal((await first).status, "aborted");
    release();
    const response = await second;
    assert.equal(response.status, "ok");
    const progress = JSON.parse(getUserItem("wuliao:ai:question-hint-progress") || "{}");
    assert.deepEqual({
      calls,
      metadataIdentity: questionHintKey(response.assistant.questionHintMeta),
      progressIdentities: Object.keys(progress),
      historyLinkedToSecond: progress[questionHintKey(secondDetail)]?.historyId === response.historyId,
    }, {
      calls: 2,
      metadataIdentity: questionHintKey(secondDetail),
      progressIdentities: [questionHintKey(secondDetail)],
      historyLinkedToSecond: true,
    });
  });
}

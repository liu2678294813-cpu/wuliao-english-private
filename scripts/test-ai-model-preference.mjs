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
  setTimeout,
  clearTimeout,
};

const { getUserItem, setCurrentUsername, setUserItem } = await import("../src/userData.js");
const {
  AI_API_CONFIG_STORAGE_KEY,
  AI_MODEL_STORAGE_KEY,
  DEFAULT_AI_API_BASE_URL,
  DEFAULT_AI_MODEL,
  SUPPORTED_AI_MODELS,
  callDeepSeek,
  createAiHistoryRecord,
  getAiApiConfig,
  getAiModelCatalog,
  getAiModelOptions,
  getPreferredAiModel,
  listAiProviderModels,
  lookupWordMeaningWithAi,
  normalizeAiApiBaseUrl,
  resolveAiModel,
  setAiApiConfig,
  setAiModelCatalog,
  setPreferredAiModel,
} = await import("../src/ai.js");
const {
  TASK_TRANSLATION_REVIEW,
  TASK_QUESTION_DIAGNOSIS,
  TASK_QUESTION_HINT_1,
  buildQuestionDiagnosisFingerprint,
  buildQuestionHintFingerprint,
  buildTranslationReviewFingerprint,
} = await import("../src/aiTasks.js");
const { runTranslationReview } = await import("../src/aiReviewService.js");
const { runQuestionHint } = await import("../src/questionHintService.js");
const { runQuestionDiagnosis } = await import("../src/questionDiagnosisService.js");
const { runClozeAiTask, clearClozeAiInflightForTests } = await import("../src/clozeAiService.js");
const {
  TASK_CLOZE_HINT_1,
  buildClozeAiFingerprint,
} = await import("../src/clozeAiTasks.js");

function fresh() {
  localStorage.clear();
  setCurrentUsername("model-test-user");
  clearClozeAiInflightForTests();
}

const hintDetail = {
  resourceId: "resource-model-test",
  chapter: "英一.18.text2",
  questionId: "q-model-1",
  questionNumber: "22",
  questionText: "What does the author suggest?",
  articleText: "The article has a clear contrast in its second paragraph.",
  scope: "first",
};

const diagnosisDetail = {
  ...hintDetail,
  questionId: "q-model-diagnosis",
  options: [
    { key: "A", text: "Alpha" },
    { key: "B", text: "Beta" },
    { key: "C", text: "Gamma" },
    { key: "D", text: "Delta" },
  ],
  officialAnswer: "D",
  firstAnswer: "B",
  redoAnswer: "D",
  canShowFullExplanation: true,
};

const clozeDetail = {
  resourceId: "cloze-model-test",
  clozeId: "cloze-model-test",
  blankNumber: 4,
  chapter: "2023 完形",
  currentSentence: {
    sentenceId: "cloze:model:p1s1",
    source: "People usually __CLOZE_BLANK_4__ this pattern in context.",
  },
  evidenceSources: [
    { sentenceId: "cloze:model:p1s1", source: "People usually __CLOZE_BLANK_4__ this pattern in context." },
  ],
};

test("全局模型偏好默认 chat、允许接口返回和手工模型 ID 且不删除 API Key 或历史", () => {
  fresh();
  assert.deepEqual(SUPPORTED_AI_MODELS, ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(getPreferredAiModel(), DEFAULT_AI_MODEL);

  setUserItem("wuliao:ai:apikey", "kept-key");
  const history = createAiHistoryRecord({ kind: "chat", text: "keep this history" });
  assert.equal(history.model, DEFAULT_AI_MODEL);

  assert.equal(setPreferredAiModel("deepseek-reasoner"), "deepseek-reasoner");
  assert.equal(getPreferredAiModel(), "deepseek-reasoner");
  assert.equal(getUserItem(AI_MODEL_STORAGE_KEY), "deepseek-reasoner");
  assert.equal(resolveAiModel(TASK_TRANSLATION_REVIEW), "deepseek-reasoner");
  assert.equal(resolveAiModel(TASK_QUESTION_HINT_1), "deepseek-reasoner");
  assert.equal(getUserItem("wuliao:ai:apikey"), "kept-key");

  assert.equal(setPreferredAiModel("deepseek-flash"), "deepseek-flash");
  assert.equal(getPreferredAiModel(), "deepseek-flash");
  assert.equal(setPreferredAiModel("invalid\u0000model"), DEFAULT_AI_MODEL);
  assert.equal(getPreferredAiModel(), DEFAULT_AI_MODEL);
  assert.equal(getUserItem("wuliao:ai:history").includes(history.id), true);
});

test("正式 AI 服务和本地缓存指纹使用当前选中的接口模型", async () => {
  fresh();
  setPreferredAiModel("deepseek-flash");

  let hintModel = "";
  const hint = await runQuestionHint({
    taskType: TASK_QUESTION_HINT_1,
    detail: hintDetail,
    apiKey: "test-key",
    useCache: false,
    fetcher: async (request) => {
      hintModel = request.model;
      return {
        content: JSON.stringify({
          version: 1,
          level: 1,
          focus: { location: "第二段", keywords: ["contrast"], logicSignals: ["转折"] },
          readingDirection: "查看转折后的句子。",
          questionForUser: "作者的态度是否发生变化？",
        }),
      };
    },
  });
  assert.equal(hint.status, "ok");
  assert.equal(hintModel, "deepseek-flash");

  let diagnosisModel = "";
  const diagnosis = await runQuestionDiagnosis({
    detail: diagnosisDetail,
    apiKey: "test-key",
    useCache: false,
    fetcher: async (request) => {
      diagnosisModel = request.model;
      return {
        content: JSON.stringify({
          questionType: "细节题",
          confidence: "medium",
          observedFacts: [],
          evidence: [],
          paraphrases: [],
          selectedOptionAnalysis: [],
          attemptComparison: { comment: "" },
          inferredCause: { summary: "", userErrorTags: [], reasoning: "", uncertainty: "" },
          nextTimeRule: "回到原文定位。",
          selfCheckQuestions: [],
        }),
      };
    },
  });
  assert.equal(diagnosis.status, "ok");
  assert.equal(diagnosisModel, "deepseek-flash");

  let clozeModel = "";
  const cloze = await runClozeAiTask({
    taskType: TASK_CLOZE_HINT_1,
    detail: clozeDetail,
    apiKey: "test-key",
    useCache: false,
    callAi: async (request) => {
      clozeModel = request.model;
      return {
        content: JSON.stringify({
          level: 1,
          focus: "观察句法关系。",
          grammarSignals: ["及物动词"],
          logicSignals: [],
          selfCheckQuestion: "空后需要什么语义角色？",
        }),
      };
    },
  });
  assert.equal(cloze.status, "ok");
  assert.equal(clozeModel, "deepseek-flash");

  const translationChat = buildTranslationReviewFingerprint({ sentence: "s", paragraph: "p", userTranslation: "t", model: "deepseek-chat" });
  const translationFlash = buildTranslationReviewFingerprint({ sentence: "s", paragraph: "p", userTranslation: "t", model: "deepseek-flash" });
  const translationFlashOtherProvider = buildTranslationReviewFingerprint({ sentence: "s", paragraph: "p", userTranslation: "t", model: "deepseek-flash", provider: "https://other.example/v1" });
  const hintChat = buildQuestionHintFingerprint({ taskType: TASK_QUESTION_HINT_1, model: "deepseek-chat", resourceId: "r", questionId: "q", questionText: "text", articleText: "article" });
  const hintFlash = buildQuestionHintFingerprint({ taskType: TASK_QUESTION_HINT_1, model: "deepseek-flash", resourceId: "r", questionId: "q", questionText: "text", articleText: "article" });
  const diagnosisChat = buildQuestionDiagnosisFingerprint({ taskType: TASK_QUESTION_DIAGNOSIS, model: "deepseek-chat", resourceId: "r", questionId: "q", questionText: "text", articleText: "article" });
  const diagnosisFlash = buildQuestionDiagnosisFingerprint({ taskType: TASK_QUESTION_DIAGNOSIS, model: "deepseek-flash", resourceId: "r", questionId: "q", questionText: "text", articleText: "article" });
  const clozeChat = buildClozeAiFingerprint(TASK_CLOZE_HINT_1, clozeDetail, "deepseek-chat");
  const clozeFlash = buildClozeAiFingerprint(TASK_CLOZE_HINT_1, clozeDetail, "deepseek-flash");
  for (const [chat, flash] of [[translationChat, translationFlash], [hintChat, hintFlash], [diagnosisChat, diagnosisFlash], [clozeChat, clozeFlash]]) {
    assert.notEqual(chat, flash);
  }
  assert.notEqual(translationFlash, translationFlashOtherProvider);
});

test("OpenAI-compatible API 枚举全部模型、归一化地址并使用选中模型发起请求", async () => {
  fresh();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, request = {}) => {
    requests.push({ url: String(url), request });
    if (String(url).endsWith("/models")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "deepseek-chat" },
            { id: "deepseek-flash" },
            { id: "deepseek-flash" },
            { id: "provider/custom-model" },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
  };
  try {
    assert.equal(DEFAULT_AI_API_BASE_URL, "https://api.deepseek.com");
    assert.equal(
      normalizeAiApiBaseUrl("https://gateway.example.test/v1/chat/completions/"),
      "https://gateway.example.test/v1",
    );
    const config = setAiApiConfig({ baseUrl: "https://gateway.example.test/v1/chat/completions" });
    assert.equal(config.baseUrl, "https://gateway.example.test/v1");
    assert.equal(getAiApiConfig().baseUrl, config.baseUrl);
    assert.equal(JSON.parse(getUserItem(AI_API_CONFIG_STORAGE_KEY)).baseUrl, config.baseUrl);

    const models = await listAiProviderModels({ apiKey: "test-key", baseUrl: config.baseUrl });
    assert.deepEqual(models, ["deepseek-chat", "deepseek-flash", "provider/custom-model"]);
    assert.equal(requests[0].url, "https://gateway.example.test/v1/models");
    assert.equal(requests[0].request.headers.Authorization, "Bearer test-key");

    setAiModelCatalog(models, { baseUrl: config.baseUrl });
    assert.deepEqual(getAiModelCatalog(), models);
    assert.equal(setPreferredAiModel("deepseek-flash"), "deepseek-flash");
    assert.deepEqual(getAiModelOptions(), models);
    await callDeepSeek({
      apiKey: "test-key",
      messages: [{ role: "user", content: "hello" }],
      taskType: "custom-model-test",
    });
    assert.equal(requests[1].url, "https://gateway.example.test/v1/chat/completions");
    assert.equal(JSON.parse(requests[1].request.body).model, "deepseek-flash");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chat Completions HTTP failures retain status without exposing credentials", async () => {
  fresh();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: { message: "Model Not Exist", code: "model_not_found" } }),
  });
  try {
    await assert.rejects(
      () => callDeepSeek({ apiKey: "secret-must-not-appear", model: "missing-model", messages: [{ role: "user", content: "hello" }] }),
      (error) => error.status === 404
        && error.providerCode === "model_not_found"
        && !error.message.includes("secret-must-not-appear"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("翻译批改和词义回退在未传 model 时使用当前偏好", async () => {
  fresh();
  setPreferredAiModel("deepseek-reasoner");
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  const requestedUrls = [];
  globalThis.fetch = async (url, request) => {
    requestedUrls.push(String(url));
    requestedModels.push(JSON.parse(request.body).model);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: { level: "accurate", comment: "" },
              mainClause: { correct: true, comment: "" },
              clauseProblems: [], nonFiniteProblems: [], modifierProblems: [], referenceProblems: [], logicProblems: [],
              omissions: [], additions: [], wordChoiceProblems: [], chineseExpressionProblems: [],
              minimalRevision: "", referenceTranslation: "测试译文", errorTags: [],
            }),
          },
        }],
      }),
    };
  };
  try {
    const review = await runTranslationReview({
      detail: { sentence: "A test sentence.", userTranslation: "测试译文", resourceId: "r", chapter: "c", sentenceId: "s" },
      apiKey: "test-key",
      useCache: false,
    });
    assert.equal(review.status, "ok");
    await lookupWordMeaningWithAi({ apiKey: "test-key", word: "test", sentence: "A test sentence." });
    assert.deepEqual(requestedModels, ["deepseek-reasoner", "deepseek-reasoner"]);
    assert.deepEqual(requestedUrls, ["https://api.deepseek.com/chat/completions", "https://api.deepseek.com/chat/completions"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

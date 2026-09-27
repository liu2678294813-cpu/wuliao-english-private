import { computeWritingFingerprint } from "./writingRepository.js";
import { getWritingQuestion, promptSnapshotForWritingQuestion } from "./writingQuestionBank.js";

export class WritingQuestionSessionError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "WritingQuestionSessionError";
    this.code = code;
    this.cause = cause;
  }
}

export const WritingSampleSource = Object.freeze({
  AI_GENERATED: "ai_generated",
  DEVICE_PRIVATE: "device_private",
  APK_BUNDLE: "apk_bundle",
});

const START_FAILURE_COPY = Object.freeze({
  text_ai_not_configured: "请先配置文本 AI。",
  auth_error: "文本 AI 认证失败，请检查 API Key",
  model_unavailable: "当前文本模型不可用，请检查 Model ID",
  rate_limit: "服务请求频率受限，请稍后重试",
  network_error: "无法连接文本 AI 服务",
  timeout: "文本 AI 请求超时，请重试",
  provider_error: "文本 AI 服务暂时异常",
  invalid_response: "文本 AI 返回内容无法验证，请重试",
});

function startFailure(cause) {
  const code = START_FAILURE_COPY[cause?.code] ? cause.code : "provider_error";
  const error = new WritingQuestionSessionError(code, START_FAILURE_COPY[code], cause);
  for (const field of ["requestStage", "provider", "modelId", "taskId", "promptVersion"]) {
    if (cause?.[field]) error[field] = cause[field];
  }
  return error;
}

function makeId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${random}`;
}

async function freezeSampleSnapshot(sampleEssaySnapshot) {
  const source = sampleEssaySnapshot || {};
  const snapshot = {
    ...source,
    generatorMetadata: [WritingSampleSource.DEVICE_PRIVATE, WritingSampleSource.APK_BUNDLE].includes(source.sourceType) ? null : source.generatorMetadata || {
      provider: source.generatorProvider || null,
      modelId: source.generatorModelId || null,
      criticProvider: source.criticProvider || null,
      criticModelId: source.criticModelId || null,
      generatorPromptVersion: source.generatorPromptVersion || null,
      criticPromptVersion: source.criticPromptVersion || null,
    },
  };
  delete snapshot.fingerprint;
  return { ...snapshot, fingerprint: await computeWritingFingerprint(snapshot) };
}

export function createWritingQuestionSessionService({ commands, textAi, privateSamples, getCurrentUsername, createId = makeId } = {}) {
  return Object.freeze({
    async startQuestionTraining(questionId, { sampleSource = WritingSampleSource.AI_GENERATED } = {}) {
      const question = getWritingQuestion(questionId);
      if (!question) throw new WritingQuestionSessionError("question-not-found", "这道写作题不存在或尚未导入。");
      const username = String(await getCurrentUsername?.() || "").trim();
      if (!username) throw new WritingQuestionSessionError("account-missing", "当前账号不可用，请重新登录后再试。");
      if (![WritingSampleSource.AI_GENERATED, WritingSampleSource.DEVICE_PRIVATE, WritingSampleSource.APK_BUNDLE].includes(sampleSource)) {
        throw new WritingQuestionSessionError("invalid-sample-source", "未知的范文来源。没有创建训练记录。");
      }
      if (sampleSource === WritingSampleSource.AI_GENERATED && typeof textAi?.getConfigurationStatus === "function") {
        let configuration;
        try {
          configuration = await textAi.getConfigurationStatus();
        } catch (cause) {
          throw startFailure(cause);
        }
        if (!configuration?.apiKeyConfigured || !configuration?.baseUrlConfigured || !configuration?.modelConfigured) {
          throw new WritingQuestionSessionError("text_ai_not_configured", START_FAILURE_COPY.text_ai_not_configured);
        }
      }
      const promptSnapshot = promptSnapshotForWritingQuestion(question.questionId);
      const sessionId = createId("writing-session");
      let sourceSnapshot;
      if ([WritingSampleSource.DEVICE_PRIVATE, WritingSampleSource.APK_BUNDLE].includes(sampleSource)) {
        try {
          sourceSnapshot = await privateSamples?.getSampleSnapshot?.(question.questionId, { sourceType: sampleSource });
        } catch (cause) {
          throw new WritingQuestionSessionError("private-sample-unavailable", cause?.message || "这道题没有可用的本地参考范文。", cause);
        }
        if (!sourceSnapshot) throw new WritingQuestionSessionError("private-sample-unavailable", "这道题没有可用的本地参考范文。");
      } else {
        let generated;
        try {
          generated = await textAi.generateSample({
            promptSnapshot,
            requiredContentPoints: question.requiredContentPoints,
            sessionId,
            sampleEssayId: createId("writing-sample"),
          });
        } catch (cause) {
          throw startFailure(cause);
        }
        if (generated?.status !== "accepted" || !generated.sampleEssaySnapshot) {
          const failure = new WritingQuestionSessionError("quality_gate_exhausted", "本次未生成达到训练标准的范文，请重试。");
          failure.requestStage = "quality_gate";
          throw failure;
        }
        sourceSnapshot = generated.sampleEssaySnapshot;
      }
      if (String(await getCurrentUsername?.() || "").trim() !== username) {
        throw new WritingQuestionSessionError("account-changed", "生成期间账号已切换，没有创建训练记录。请在当前账号重试。");
      }
      const sampleEssaySnapshot = await freezeSampleSnapshot(sourceSnapshot);
      return commands.startWritingSession({
        sessionId,
        taskType: question.taskType,
        year: question.year,
        promptSnapshot,
        sampleEssaySnapshot,
      });
    },
  });
}

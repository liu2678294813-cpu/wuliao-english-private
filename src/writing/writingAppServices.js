import { getCurrentUsername } from "../userData.js";
import { createWritingAiService } from "./writingAiService.js";
import { createWritingCommandService } from "./writingCommands.js";
import { createWritingIntegrationService } from "./writingIntegration.js";
import { createWritingReadModelService } from "./writingReadModels.js";
import { computeWritingFingerprint, WritingRepository } from "./writingRepository.js";
import { createWritingUnknownWordsService } from "./writingUnknownWords.js";
import { createWritingVisionService } from "./writingVisionService.js";
import { writingQuestionBank } from "./writingQuestionBank.js";
import { createWritingQuestionSessionService } from "./writingQuestionSessions.js";
import { createWritingPrivateSamplesService } from "./writingPrivateSamples.js";

export function createWritingAppServices({ username, inkFlushBridge } = {}) {
  const repository = new WritingRepository({ username });
  const account = () => getCurrentUsername();
  const commands = createWritingCommandService({
    repository,
    getCurrentUsername: account,
    flushInk: (context) => inkFlushBridge.flush(context),
  });
  const textAi = createWritingAiService({ repository, getCurrentUsername: account });
  const privateSamples = createWritingPrivateSamplesService({ username, getCurrentUsername: account });
  const privateSamplesReady = privateSamples.consumePendingAndroidSeed().catch((error) => ({
    status: "failed",
    importedCount: 0,
    code: error?.code || "private-sample-import-failed",
  }));

  const services = Object.freeze({
    repository,
    commands,
    readModels: createWritingReadModelService({ repository, getCurrentUsername: account }),
    integration: createWritingIntegrationService({ repository, getCurrentUsername: account }),
    textAi,
    questionBank: writingQuestionBank,
    privateSamples,
    privateSamplesReady,
    questionSessions: createWritingQuestionSessionService({ commands, textAi, privateSamples, getCurrentUsername: account }),
    vision: createWritingVisionService({ repository, getCurrentUsername: account }),
    unknownWords: createWritingUnknownWordsService({ repository, getCurrentUsername: account }),
  });
  if (import.meta.env?.VITE_E2E_PROBES === "1" && typeof window !== "undefined") {
    window.__WULIAO_WRITING_E2E__ = Object.freeze({ ...services, computeWritingFingerprint });
  }
  return services;
}

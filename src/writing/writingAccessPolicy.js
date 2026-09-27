import {
  WRITING_STAGES,
  WRITING_STAGE_LABELS,
  WritingInputCapability,
  WritingSkeletonOutcome,
  WritingStage,
  assertWritingStage,
  normalizeWritingFacts,
} from "./writingModels.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value !== null && typeof value === "object") return { ...value };
  return value;
}

function copyIfPresent(target, source, key, outputKey = key) {
  if (source && hasOwn(source, key)) target[outputKey] = cloneValue(source[key]);
}

const ORDINARY_INPUT_CAPABILITIES = Object.freeze([
  WritingInputCapability.KEYBOARD,
  WritingInputCapability.HANDWRITING,
  WritingInputCapability.INK,
]);

const VISION_INPUT_CAPABILITIES = Object.freeze([
  ...ORDINARY_INPUT_CAPABILITIES,
  WritingInputCapability.VISION_TRANSCRIPTION,
  WritingInputCapability.TRANSCRIPT_VERIFICATION,
]);

const STAGE_INPUT_CAPABILITIES = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: Object.freeze([
    WritingInputCapability.UNKNOWN_WORDS,
    WritingInputCapability.INK,
  ]),
  [WritingStage.W2_EN_ZH]: VISION_INPUT_CAPABILITIES,
  [WritingStage.W3_BACK_TRANSLATION]: VISION_INPUT_CAPABILITIES,
  [WritingStage.W4_COMPARE_DIAGNOSE]: Object.freeze([
    WritingInputCapability.UNKNOWN_WORDS,
    WritingInputCapability.INK,
  ]),
  [WritingStage.W5_SKELETON]: ORDINARY_INPUT_CAPABILITIES,
  [WritingStage.W6_RECONSTRUCTION]: ORDINARY_INPUT_CAPABILITIES,
  [WritingStage.W7_INDEPENDENT]: VISION_INPUT_CAPABILITIES,
  [WritingStage.W8_SCORE_REWRITE]: ORDINARY_INPUT_CAPABILITIES,
  [WritingStage.DONE]: Object.freeze([]),
});

function inputCapabilitiesFrom(stage, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = STAGE_INPUT_CAPABILITIES[stage];
  const entries = allowed
    .filter((capability) => typeof value[capability] === "boolean")
    .map((capability) => [capability, value[capability]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function baseViewModel(stage, session) {
  const stageIndex = WRITING_STAGES.indexOf(stage);
  const viewModel = {
    stage,
    stageMetadata: {
      id: stage,
      label: WRITING_STAGE_LABELS[stage],
      stepNumber: stage === WritingStage.DONE ? 8 : stageIndex + 1,
      totalSteps: 8,
      terminal: stage === WritingStage.DONE,
    },
  };
  const inputCapabilities = inputCapabilitiesFrom(stage, session?.inputCapabilities);
  if (inputCapabilities) viewModel.inputCapabilities = inputCapabilities;
  return viewModel;
}

export function buildWritingStageViewModel({ stage, session = {}, facts = {} } = {}) {
  assertWritingStage(stage);
  const source = session && typeof session === "object" ? session : {};
  const normalizedFacts = normalizeWritingFacts(facts);
  const viewModel = baseViewModel(stage, source);

  switch (stage) {
    case WritingStage.W1_SAMPLE_READING:
      copyIfPresent(viewModel, source, "prompt");
      copyIfPresent(viewModel, source, "sampleEssay");
      break;
    case WritingStage.W2_EN_ZH:
      copyIfPresent(viewModel, source, "prompt");
      copyIfPresent(viewModel, source, "sampleEssay");
      copyIfPresent(viewModel, source, "currentTranslationDraft");
      if (normalizedFacts.translationSnapshot) {
        viewModel.translationSnapshot = normalizedFacts.translationSnapshot;
      }
      break;
    case WritingStage.W3_BACK_TRANSLATION:
      if (normalizedFacts.translationSnapshot) {
        viewModel.translationSnapshot = normalizedFacts.translationSnapshot;
      }
      copyIfPresent(viewModel, source, "currentBackTranslationDraft");
      copyIfPresent(viewModel, source, "currentBackTranslationAttempt");
      break;
    case WritingStage.W4_COMPARE_DIAGNOSE:
      copyIfPresent(viewModel, source, "prompt");
      copyIfPresent(viewModel, source, "sampleEssay");
      if (normalizedFacts.translationSnapshot) {
        viewModel.translationSnapshot = normalizedFacts.translationSnapshot;
      }
      copyIfPresent(viewModel, source, "backTranslationAttempt");
      copyIfPresent(viewModel, source, "comparison");
      copyIfPresent(viewModel, source, "comparisonDiagnosis");
      copyIfPresent(viewModel, source, "referenceExpressions");
      break;
    case WritingStage.W5_SKELETON:
      copyIfPresent(viewModel, source, "prompt");
      copyIfPresent(viewModel, source, "sampleSkeleton");
      copyIfPresent(viewModel, source, "currentSkeletonRevision");
      break;
    case WritingStage.W6_RECONSTRUCTION: {
      const skeletonRevisionId = source.skeletonRevisionId;
      viewModel.skeletonRevisionId = normalizedFacts.skeletonOutcome === WritingSkeletonOutcome.COMPLETED
        && typeof skeletonRevisionId === "string"
        && skeletonRevisionId.trim()
        ? skeletonRevisionId
        : null;
      copyIfPresent(viewModel, source, "currentReconstructionDraft");
      copyIfPresent(viewModel, source, "currentReconstructionAttempt");
      break;
    }
    case WritingStage.W7_INDEPENDENT:
      copyIfPresent(viewModel, source, "prompt");
      copyIfPresent(viewModel, source, "currentIndependentDraft");
      copyIfPresent(viewModel, source, "currentIndependentAttempt");
      copyIfPresent(viewModel, source, "currentWritingInkRef");
      break;
    case WritingStage.W8_SCORE_REWRITE:
      copyIfPresent(viewModel, source, "prompt");
      if (normalizedFacts.scoreReport) viewModel.scoreReport = normalizedFacts.scoreReport;
      copyIfPresent(viewModel, source, "currentRevisionDraft");
      copyIfPresent(viewModel, source, "currentRevisionAttempt");
      viewModel.fullReferenceRewriteAllowed = normalizedFacts.revisionAttemptSubmitted;
      break;
    case WritingStage.DONE:
      if (normalizedFacts.scoreReport) viewModel.scoreReport = normalizedFacts.scoreReport;
      break;
    default:
      break;
  }

  return viewModel;
}

import { computeFileFingerprint } from "../fingerprint.js";
import { getUserItem, listUserItems, setUserItem } from "../userData.js";
import {
  WRITING_SCHEMA_VERSION,
  WRITING_STAGES,
  WritingAiArtifactType,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingInputMethod,
  WritingLearningItemKind,
  WritingLearningItemOrigin,
  WritingReconstructionOutcome,
  WritingReviewMode,
  WritingReviewStatus,
  WritingReviewType,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
  WritingTaskType,
  WritingVerifiedTextSource,
} from "./writingModels.js";

const TASK_TYPES = new Set(Object.values(WritingTaskType));
const SESSION_STATUSES = new Set(Object.values(WritingSessionStatus));
const DRAFT_STATUSES = new Set(Object.values(WritingDraftStatus));
const ATTEMPT_TYPES = new Set(Object.values(WritingAttemptType));
const ATTEMPT_STATUSES = new Set(Object.values(WritingAttemptStatus));
const INPUT_METHODS = new Set(Object.values(WritingInputMethod));
const VERIFIED_TEXT_SOURCES = new Set(Object.values(WritingVerifiedTextSource));
const REVIEW_TYPES = new Set(Object.values(WritingReviewType));
const REVIEW_STATUSES = new Set(Object.values(WritingReviewStatus));
const AI_ARTIFACT_TYPES = new Set(Object.values(WritingAiArtifactType));
const LEARNING_ITEM_KINDS = new Set(Object.values(WritingLearningItemKind));
const LEARNING_ITEM_ORIGINS = new Set(Object.values(WritingLearningItemOrigin));
const PROMPT_SOURCE_TYPES = new Set(["official", "embedded", "manual_import"]);
const SAMPLE_SOURCE_TYPES = new Set(["ai_generated", "embedded", "manual_import", "web_import", "device_private", "apk_bundle"]);
const SKELETON_BLOCK_KINDS = new Set(["idea", "logic", "phrase", "keyword"]);
const SCORE_ZERO_REASONS = new Set(["blank", "no_effective_english", "fully_off_topic"]);
const SCORE_RUBRIC_VERSIONS = Object.freeze({
  [WritingTaskType.POSTGRAD_EN1_WRITING_A]: "postgrad-en1-writing-a-v1",
  [WritingTaskType.POSTGRAD_EN1_WRITING_B]: "postgrad-en1-writing-b-v1",
});
const ATTEMPT_STATUS_ORDER = Object.freeze({ drafting: 0, raw_submitted: 1, verifying: 2, submitted: 3 });
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const KEY_PREFIXES = Object.freeze({
  session: "wuliao:writing-session:v1:",
  translationRevision: "wuliao:writing-translation:v1:",
  translationSnapshot: "wuliao:writing-translation-snapshot:v1:",
  attempt: "wuliao:writing-attempt:v1:",
  transcription: "wuliao:writing-transcription:v1:",
  skeletonRevision: "wuliao:writing-skeleton:v1:",
  learningItem: "wuliao:writing-learning-item:v1:",
  aiArtifact: "wuliao:writing-ai-artifact:v1:",
  scoreReport: "wuliao:writing-score:v1:",
  reviewTask: "wuliao:writing-review-task:v1:",
});

export class WritingDataError extends Error {
  constructor(message, code = "damaged") {
    super(message);
    this.name = "WritingDataError";
    this.code = code;
  }
}

export class WritingConflictError extends WritingDataError {
  constructor(message = "Writing record conflicts with an existing record") {
    super(message, "conflict");
    this.name = "WritingConflictError";
  }
}

export class WritingStaleRevisionError extends WritingConflictError {
  constructor(expectedRevision, actualRevision) {
    super("Writing record was changed by a newer runtime");
    this.name = "WritingStaleRevisionError";
    this.code = "stale-revision";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WritingImmutableError extends WritingConflictError {
  constructor(message = "Writing record is immutable") {
    super(message);
    this.name = "WritingImmutableError";
    this.code = "immutable";
  }
}

export class WritingAccountMismatchError extends WritingDataError {
  constructor(message = "Writing record belongs to another account") {
    super(message, "account-mismatch");
    this.name = "WritingAccountMismatchError";
  }
}

function assert(condition, message, code = "invalid-record") {
  if (!condition) throw new WritingDataError(message, code);
}

function requiredString(value, name) {
  assert(typeof value === "string" && value.trim(), `${name} is required`);
  return value.trim();
}

function nullableString(value, name) {
  if (value === null) return null;
  return requiredString(value, name);
}

function stringOrNull(value, name) {
  assert(value === null || typeof value === "string", `${name} must be a string or null`);
  return value;
}

function stringArray(value, name) {
  assert(Array.isArray(value), `${name} must be an array`);
  const normalized = value.map((entry, index) => requiredString(entry, `${name}[${index}]`));
  assert(new Set(normalized).size === normalized.length, `${name} must not contain duplicates`);
  return normalized;
}

function assertExactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(canonicalWritingJson(actual) === canonicalWritingJson(wanted), `${name} fields are invalid`);
}

function assertTimestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  assert((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim()), `${name} is invalid`);
}

function assertRevision(value, name = "revision", { allowZero = false } = {}) {
  assert(Number.isInteger(value) && value >= (allowZero ? 0 : 1), `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeJsonValue(value, path = "record") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => entry === undefined ? null : normalizeJsonValue(entry, `${path}[${index}]`));
  assert(isPlainObject(value), `${path} must contain JSON-compatible plain values`);
  const next = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) next[key] = normalizeJsonValue(value[key], `${path}.${key}`);
  }
  return next;
}

function cloneRecord(value) {
  return normalizeJsonValue(value);
}

function withoutTopLevelFingerprint(value) {
  const next = cloneRecord(value);
  delete next.fingerprint;
  return next;
}

export function canonicalWritingJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalWritingJson(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalWritingJson(value[key])}`).join(",")}}`;
}

export async function computeWritingFingerprint(value) {
  const normalized = withoutTopLevelFingerprint(value);
  const fingerprint = await computeFileFingerprint(new TextEncoder().encode(canonicalWritingJson(normalized)));
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw new WritingDataError("SHA-256 is unavailable for Writing fingerprints", "fingerprint-unavailable");
  }
  return fingerprint;
}

export async function fingerprintWritingRecord(value) {
  const normalized = withoutTopLevelFingerprint(value);
  return { ...normalized, fingerprint: await computeWritingFingerprint(normalized) };
}

async function hasValidFingerprint(record) {
  return typeof record?.fingerprint === "string"
    && record.fingerprint === await computeWritingFingerprint(record);
}

function assertNoStrokes(value, path = "record") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoStrokes(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    assert(key !== "strokes", `${path}.${key} is forbidden; localStorage may only contain inkRef`);
    assertNoStrokes(entry, `${path}.${key}`);
  }
}

function assertInkRef(value, name = "inkRef", { ownerRecordId = null, surfaceId = null } = {}) {
  if (value === null) return;
  assert(isPlainObject(value), `${name} must be an object or null`);
  for (const field of ["id", "surfaceId", "fingerprint", "sourceFingerprint", "ownerRecordId"]) requiredString(value[field], `${name}.${field}`);
  assertRevision(value.revision, `${name}.revision`);
  assertTimestamp(value.updatedAt, `${name}.updatedAt`);
  if (ownerRecordId !== null) assert(value.ownerRecordId === ownerRecordId, `${name}.ownerRecordId does not match its owner`, "lineage-mismatch");
  if (surfaceId !== null) assert(value.surfaceId === surfaceId, `${name}.surfaceId does not match its owner`, "lineage-mismatch");
  assertNoStrokes(value, name);
}

function assertBase(record, idField, expectedId, username) {
  assert(isPlainObject(record), "Writing record must be an object");
  assert(record.schemaVersion === WRITING_SCHEMA_VERSION, "Unsupported Writing schemaVersion", "wrong-schema");
  const recordId = requiredString(record[idField], idField);
  if (expectedId !== undefined) assert(recordId === expectedId, `${idField} does not match its storage identity`, "identity-mismatch");
  const recordUsername = requiredString(record.username, "username");
  if (recordUsername !== username) throw new WritingAccountMismatchError();
  requiredString(record.fingerprint, "fingerprint");
}

async function assertNestedFingerprint(value, name) {
  assert(isPlainObject(value) && typeof value.fingerprint === "string", `${name}.fingerprint is required`);
  assert(await hasValidFingerprint(value), `${name}.fingerprint is invalid`, "bad-fingerprint");
}

function assertTaskType(taskType) {
  assert(TASK_TYPES.has(taskType), "Unsupported Writing taskType");
}

function maxScoreForTaskType(taskType) {
  return taskType === WritingTaskType.POSTGRAD_EN1_WRITING_A ? 10 : 20;
}

async function validatePromptSnapshot(snapshot, session) {
  assert(isPlainObject(snapshot), "promptSnapshot is required");
  for (const field of ["questionId", "promptText", "directions"]) requiredString(snapshot[field], `promptSnapshot.${field}`);
  stringOrNull(snapshot.promptKind, "promptSnapshot.promptKind");
  assert(PROMPT_SOURCE_TYPES.has(snapshot.sourceType), "promptSnapshot.sourceType is invalid");
  assert(snapshot.taskType === session.taskType, "promptSnapshot.taskType must match Session");
  assert(snapshot.year === session.year, "promptSnapshot.year must match Session");
  assert(snapshot.maxScore === maxScoreForTaskType(session.taskType), "promptSnapshot.maxScore does not match taskType");
  assert(Array.isArray(snapshot.assets), "promptSnapshot.assets must be an array");
  const assetJson = canonicalWritingJson(snapshot.assets);
  assert(!/data:[^,]*;base64,/i.test(assetJson), "promptSnapshot.assets must not contain base64 data URLs");
  assert(isPlainObject(snapshot.targetWordRange), "promptSnapshot.targetWordRange is required");
  assert(Number.isInteger(snapshot.targetWordRange.min) && snapshot.targetWordRange.min >= 0, "promptSnapshot.targetWordRange.min is invalid");
  assert(Number.isInteger(snapshot.targetWordRange.max) && snapshot.targetWordRange.max >= snapshot.targetWordRange.min, "promptSnapshot.targetWordRange.max is invalid");
  await assertNestedFingerprint(snapshot, "promptSnapshot");
}

async function validateSampleEssaySnapshot(snapshot) {
  assert(isPlainObject(snapshot), "sampleEssaySnapshot is required");
  requiredString(snapshot.essayId, "sampleEssaySnapshot.essayId");
  assert(SAMPLE_SOURCE_TYPES.has(snapshot.sourceType), "sampleEssaySnapshot.sourceType is invalid");
  assert(typeof snapshot.text === "string" && snapshot.text.trim(), "sampleEssaySnapshot.text is required");
  assert(Number.isInteger(snapshot.wordCount) && snapshot.wordCount >= 0, "sampleEssaySnapshot.wordCount is invalid");
  assert(Array.isArray(snapshot.segments) && snapshot.segments.length > 0, "sampleEssaySnapshot.segments is required");
  const unitIds = new Set();
  snapshot.segments.forEach((segment, index) => {
    assert(isPlainObject(segment), `sampleEssaySnapshot.segments[${index}] is invalid`);
    const unitId = requiredString(segment.unitId, `sampleEssaySnapshot.segments[${index}].unitId`);
    assert(!unitIds.has(unitId), `Duplicate sample segment unitId: ${unitId}`);
    unitIds.add(unitId);
  });
  assert(snapshot.qualityStatus === "passed", "Only passed SampleEssaySnapshot may enter a Session");
  requiredString(snapshot.qualityGateVersion, "sampleEssaySnapshot.qualityGateVersion");
  requiredString(snapshot.qualityReportFingerprint, "sampleEssaySnapshot.qualityReportFingerprint");
  if (snapshot.sourceType === "ai_generated") {
    assert(isPlainObject(snapshot.generatorMetadata), "AI-generated SampleEssaySnapshot requires generatorMetadata");
  } else if (snapshot.sourceType === "device_private") {
    assert(snapshot.distributionScope === "device_private", "Device-private SampleEssaySnapshot requires device_private distributionScope");
    assert(snapshot.sourceKind === "private_reference", "Device-private SampleEssaySnapshot requires private_reference sourceKind");
    requiredString(snapshot.sourceDocumentFingerprint, "sampleEssaySnapshot.sourceDocumentFingerprint");
    assert(snapshot.generatorMetadata === null, "设备私有范文的 generatorMetadata 必须为 null");
  } else if (snapshot.sourceType === "apk_bundle") {
    assert(snapshot.distributionScope === "apk_bundle", "APK-bundled SampleEssaySnapshot requires apk_bundle distributionScope");
    assert(snapshot.sourceKind === "bundled_reference", "APK-bundled SampleEssaySnapshot requires bundled_reference sourceKind");
    requiredString(snapshot.sourceDocumentFingerprint, "sampleEssaySnapshot.sourceDocumentFingerprint");
    requiredString(snapshot.catalogVersion, "sampleEssaySnapshot.catalogVersion");
    const catalogContentHash = requiredString(snapshot.catalogContentHash, "sampleEssaySnapshot.catalogContentHash");
    assert(SHA256_PATTERN.test(catalogContentHash), "sampleEssaySnapshot.catalogContentHash must be a SHA-256 fingerprint");
    assert(snapshot.generatorMetadata === null, "随应用范文的 generatorMetadata 必须为 null");
  } else {
    assert(snapshot.generatorMetadata === null || isPlainObject(snapshot.generatorMetadata), "sampleEssaySnapshot.generatorMetadata must be an object or null");
  }
  await assertNestedFingerprint(snapshot, "sampleEssaySnapshot");
}

function validateStageFacts(facts) {
  assert(isPlainObject(facts), "stageFacts is required");
  assertTimestamp(facts.w1ReadingCompletedAt, "stageFacts.w1ReadingCompletedAt", { nullable: true });
  assertTimestamp(facts.w4CompareCompletedAt, "stageFacts.w4CompareCompletedAt", { nullable: true });
  assert(Object.values(WritingSkeletonOutcome).includes(facts.w5Outcome), "stageFacts.w5Outcome is invalid");
  assertTimestamp(facts.w5EndedAt, "stageFacts.w5EndedAt", { nullable: true });
  nullableString(facts.committedSkeletonRevisionId, "stageFacts.committedSkeletonRevisionId");
  assert(Object.values(WritingReconstructionOutcome).includes(facts.w6Outcome), "stageFacts.w6Outcome is invalid");
  assertTimestamp(facts.w6EndedAt, "stageFacts.w6EndedAt", { nullable: true });
  nullableString(facts.w6AttemptId, "stageFacts.w6AttemptId");
  assert(Array.isArray(facts.viewedScoreReportIds), "stageFacts.viewedScoreReportIds must be an array");
  const viewed = facts.viewedScoreReportIds.map((id, index) => requiredString(id, `stageFacts.viewedScoreReportIds[${index}]`));
  assert(new Set(viewed).size === viewed.length, "stageFacts.viewedScoreReportIds must not contain duplicates");
  nullableString(facts.completedByScoreReportId, "stageFacts.completedByScoreReportId");
  if (facts.w5Outcome === null) {
    assert(facts.w5EndedAt === null && facts.committedSkeletonRevisionId === null, "Unfinished W5 cannot contain terminal facts");
  }
  if (facts.w5Outcome === WritingSkeletonOutcome.COMPLETED) {
    assert(facts.w5EndedAt !== null && facts.committedSkeletonRevisionId !== null, "Completed W5 requires its end time and committed Skeleton");
  }
  if (facts.w5Outcome === WritingSkeletonOutcome.SKIPPED) {
    assert(facts.w5EndedAt !== null && facts.committedSkeletonRevisionId === null, "Skipped W5 must be explicit and cannot bind a Skeleton");
  }
  if (facts.w6Outcome === null) assert(facts.w6EndedAt === null && facts.w6AttemptId === null, "Unfinished W6 cannot contain terminal facts");
  if (facts.w6Outcome === WritingReconstructionOutcome.SUBMITTED) assert(facts.w6EndedAt !== null && facts.w6AttemptId !== null, "Submitted W6 requires its end time and Attempt");
  if (facts.w6Outcome === WritingReconstructionOutcome.SKIPPED) assert(facts.w6EndedAt !== null && facts.w6AttemptId === null, "Skipped W6 must be explicit and cannot bind an Attempt");
}

async function validateSession(record, id, username) {
  assertBase(record, "sessionId", id, username);
  assertTaskType(record.taskType);
  assert(record.year === null || (Number.isInteger(record.year) && record.year >= 1900), "Session year is invalid");
  assert(SESSION_STATUSES.has(record.status), "Session status is invalid");
  assert(WRITING_STAGES.includes(record.currentStage), "Session currentStage is invalid");
  assertRevision(record.revision);
  for (const field of ["createdAt", "startedAt", "lastActiveAt", "updatedAt"]) assertTimestamp(record[field], field);
  assertTimestamp(record.completedAt, "completedAt", { nullable: true });
  await validatePromptSnapshot(record.promptSnapshot, record);
  await validateSampleEssaySnapshot(record.sampleEssaySnapshot);
  validateStageFacts(record.stageFacts);
  if (record.status === WritingSessionStatus.COMPLETED) {
    assert(record.currentStage === WritingStage.DONE, "Completed Session must point to DONE");
    assert(record.completedAt !== null, "Completed Session requires completedAt");
    assert(record.stageFacts.completedByScoreReportId !== null, "Completed Session requires first score evidence");
  } else {
    assert(record.currentStage !== WritingStage.DONE, "Active Session cannot point to DONE");
    assert(record.completedAt === null, "Active Session cannot have completedAt");
    assert(record.stageFacts.completedByScoreReportId === null, "Active Session cannot contain completion evidence");
  }
  if (record.stageFacts.completedByScoreReportId !== null) {
    assert(record.stageFacts.viewedScoreReportIds.includes(record.stageFacts.completedByScoreReportId), "Completion score must appear in viewedScoreReportIds");
  }
}

function assertAppendOnly(previous, next, name) {
  assert(next.length >= previous.length && previous.every((value, index) => next[index] === value), `${name} is append-only`);
}

function validateSessionTransition(current, next) {
  assert(current.sessionId === next.sessionId && current.username === next.username, "Session identity cannot change");
  assert(current.taskType === next.taskType && current.year === next.year, "Session task identity cannot change");
  assert(current.createdAt === next.createdAt && current.startedAt === next.startedAt, "Session creation identity cannot change");
  assert(current.promptSnapshot.fingerprint === next.promptSnapshot.fingerprint, "PromptSnapshot is immutable");
  assert(current.sampleEssaySnapshot.fingerprint === next.sampleEssaySnapshot.fingerprint, "SampleEssaySnapshot is immutable");
  assertAppendOnly(current.stageFacts.viewedScoreReportIds, next.stageFacts.viewedScoreReportIds, "viewedScoreReportIds");
  for (const field of ["w1ReadingCompletedAt", "w4CompareCompletedAt"]) {
    if (current.stageFacts[field] !== null) assert(next.stageFacts[field] === current.stageFacts[field], `${field} is frozen once completed`);
  }
  for (const fields of [
    ["w5Outcome", "w5EndedAt", "committedSkeletonRevisionId"],
    ["w6Outcome", "w6EndedAt", "w6AttemptId"],
  ]) {
    if (current.stageFacts[fields[0]] !== null) {
      for (const field of fields) assert(next.stageFacts[field] === current.stageFacts[field], `${fields[0]} terminal facts are frozen`);
    }
  }
  if (current.stageFacts.completedByScoreReportId !== null) {
    assert(next.stageFacts.completedByScoreReportId === current.stageFacts.completedByScoreReportId, "completedByScoreReportId is frozen");
  }
  if (current.status === WritingSessionStatus.COMPLETED) {
    assert(next.status === WritingSessionStatus.COMPLETED, "Completed Session cannot become active");
    assert(next.currentStage === WritingStage.DONE, "Completed Session must remain DONE");
    assert(next.completedAt === current.completedAt, "completedAt is frozen");
    const previousFacts = { ...current.stageFacts, viewedScoreReportIds: [] };
    const nextFacts = { ...next.stageFacts, viewedScoreReportIds: [] };
    assert(canonicalWritingJson(previousFacts) === canonicalWritingJson(nextFacts), "Completed Session facts are frozen except viewed score history");
  }
}

function validateTranslationUnits(units, name, revisionId) {
  assert(Array.isArray(units), `${name} must be an array`);
  const ids = new Set();
  units.forEach((unit, index) => {
    assert(isPlainObject(unit), `${name}[${index}] is invalid`);
    const unitId = requiredString(unit.unitId, `${name}[${index}].unitId`);
    assert(!ids.has(unitId), `${name} has duplicate unitId ${unitId}`);
    ids.add(unitId);
    assert(INPUT_METHODS.has(unit.inputMethod), `${name}[${index}].inputMethod is invalid`);
    assert(typeof unit.typedText === "string", `${name}[${index}].typedText must be a string`);
    assertInkRef(unit.inkRef, `${name}[${index}].inkRef`, {
      ownerRecordId: revisionId,
      surfaceId: `w2:translation:${revisionId}`,
    });
  });
}

export function assertTranslationUnitsMatchSample(translationRevision, sampleEssaySnapshot) {
  const sampleUnitIds = new Set((sampleEssaySnapshot?.segments || []).map((segment) => segment?.unitId));
  assert(sampleUnitIds.size > 0, "SampleEssaySnapshot segments are required for Translation lineage", "lineage-mismatch");
  for (const unit of translationRevision?.units || []) {
    assert(sampleUnitIds.has(unit.unitId), `Translation unit ${unit.unitId} does not exist in SampleEssaySnapshot`, "lineage-mismatch");
  }
  return true;
}

async function validateTranslationRevision(record, id, username) {
  assertBase(record, "revisionId", id, username);
  requiredString(record.sessionId, "sessionId");
  assertRevision(record.revisionNumber, "revisionNumber");
  assert(DRAFT_STATUSES.has(record.status), "Translation status is invalid");
  nullableString(record.basedOnRevisionId, "basedOnRevisionId");
  validateTranslationUnits(record.units, "units", record.revisionId);
  for (const field of ["createdAt", "updatedAt"]) assertTimestamp(record[field], field);
  assertTimestamp(record.committedAt, "committedAt", { nullable: true });
  assertRevision(record.revision);
  if (record.status === WritingDraftStatus.COMMITTED) assert(record.committedAt !== null, "Committed Translation requires committedAt");
  else assert(record.committedAt === null, "Draft Translation cannot have committedAt");
  assertNoStrokes(record);
}

function validateTranslationRevisionTransition(current, next) {
  for (const field of ["revisionId", "sessionId", "username", "revisionNumber", "basedOnRevisionId", "createdAt"]) {
    assert(current[field] === next[field], `TranslationRevision.${field} is frozen`);
  }
}

async function validateTranslationSnapshot(record, id, username) {
  assertBase(record, "snapshotId", id, username);
  requiredString(record.sessionId, "sessionId");
  requiredString(record.translationRevisionId, "translationRevisionId");
  requiredString(record.revisionFingerprint, "revisionFingerprint");
  validateTranslationUnits(record.units, "units", record.translationRevisionId);
  assertTimestamp(record.createdAt, "createdAt");
  assertNoStrokes(record);
}

export function assertTranslationSnapshotLineage(snapshot, committedRevision) {
  assert(committedRevision?.status === WritingDraftStatus.COMMITTED, "TranslationSnapshot requires a committed TranslationRevision", "lineage-mismatch");
  assert(snapshot?.username === committedRevision.username && snapshot?.sessionId === committedRevision.sessionId, "TranslationSnapshot account/session lineage does not match", "lineage-mismatch");
  assert(snapshot?.translationRevisionId === committedRevision.revisionId, "TranslationSnapshot revision identity does not match", "lineage-mismatch");
  assert(snapshot?.revisionFingerprint === committedRevision.fingerprint, "TranslationSnapshot revision fingerprint does not match", "lineage-mismatch");
  assert(canonicalWritingJson(snapshot?.units) === canonicalWritingJson(committedRevision.units), "TranslationSnapshot units must be a self-contained copy of the committed revision", "lineage-mismatch");
  return true;
}

export async function fingerprintVerifiedText(attemptId, verifiedText) {
  const value = cloneRecord(verifiedText);
  delete value.fingerprint;
  return computeWritingFingerprint({ attemptId: requiredString(attemptId, "attemptId"), verifiedText: value });
}

export async function createVerifiedText(attemptId, value) {
  const normalized = cloneRecord(value);
  delete normalized.fingerprint;
  normalized.text = requiredString(normalized.text, "verifiedText.text");
  assert(VERIFIED_TEXT_SOURCES.has(normalized.source), "verifiedText.source is invalid");
  if (normalized.source === WritingVerifiedTextSource.TRANSCRIPTION) requiredString(normalized.sourceTranscriptionId, "verifiedText.sourceTranscriptionId");
  else assert(normalized.sourceTranscriptionId === null, "Non-transcription verifiedText must use sourceTranscriptionId=null");
  assertTimestamp(normalized.confirmedAt, "verifiedText.confirmedAt");
  return { ...normalized, fingerprint: await fingerprintVerifiedText(attemptId, normalized) };
}

async function validateVerifiedText(attemptId, value) {
  assert(isPlainObject(value), "verifiedText is invalid");
  requiredString(value.text, "verifiedText.text");
  assert(VERIFIED_TEXT_SOURCES.has(value.source), "verifiedText.source is invalid");
  if (value.source === WritingVerifiedTextSource.TRANSCRIPTION) requiredString(value.sourceTranscriptionId, "verifiedText.sourceTranscriptionId");
  else assert(value.sourceTranscriptionId === null, "Non-transcription verifiedText must use sourceTranscriptionId=null");
  assertTimestamp(value.confirmedAt, "verifiedText.confirmedAt");
  requiredString(value.fingerprint, "verifiedText.fingerprint");
  assert(value.fingerprint === await fingerprintVerifiedText(attemptId, value), "verifiedText.fingerprint is invalid", "bad-fingerprint");
}

function validateAttemptContext(record) {
  assert(isPlainObject(record.context), "Attempt context is required");
  if (record.attemptType === WritingAttemptType.BACK_TRANSLATION) {
    assert(record.stageId === WritingStage.W3_BACK_TRANSLATION, "Back translation must belong to W3");
    assertExactKeys(record.context, ["translationSnapshotId"], "W3 context");
    requiredString(record.context.translationSnapshotId, "context.translationSnapshotId");
  } else if (record.attemptType === WritingAttemptType.RECONSTRUCTION) {
    assert(record.stageId === WritingStage.W6_RECONSTRUCTION, "Reconstruction must belong to W6");
    assertExactKeys(record.context, ["skeletonRevisionId"], "W6 context");
    nullableString(record.context.skeletonRevisionId, "context.skeletonRevisionId");
  } else if (record.attemptType === WritingAttemptType.INDEPENDENT) {
    assert(record.stageId === WritingStage.W7_INDEPENDENT, "Independent Attempt must belong to W7");
    assertExactKeys(record.context, ["promptFingerprint"], "W7 context");
    requiredString(record.context.promptFingerprint, "context.promptFingerprint");
  } else if (record.attemptType === WritingAttemptType.REVISION) {
    assert(record.stageId === WritingStage.W8_SCORE_REWRITE, "Revision Attempt must belong to W8");
    assertExactKeys(record.context, ["promptFingerprint"], "W8 context");
    requiredString(record.context.promptFingerprint, "context.promptFingerprint");
  } else if (record.attemptType === WritingAttemptType.REVIEW_D1) {
    assert(record.stageId === null, "D1 review Attempt stageId must be null");
    assertExactKeys(record.context, ["reviewTaskId", "translationSnapshotId", "learningItemIds"], "D1 review context");
    requiredString(record.context.reviewTaskId, "context.reviewTaskId");
    requiredString(record.context.translationSnapshotId, "context.translationSnapshotId");
    stringArray(record.context.learningItemIds, "context.learningItemIds");
  } else if (record.attemptType === WritingAttemptType.REVIEW_D3) {
    assert(record.stageId === null, "D3 review Attempt stageId must be null");
    assertExactKeys(record.context, ["reviewTaskId", "skeletonRevisionId"], "D3 review context");
    requiredString(record.context.reviewTaskId, "context.reviewTaskId");
    nullableString(record.context.skeletonRevisionId, "context.skeletonRevisionId");
  } else if (record.attemptType === WritingAttemptType.REVIEW_D7) {
    assert(record.stageId === null, "D7 review Attempt stageId must be null");
    assertExactKeys(record.context, ["reviewTaskId", "assignedPromptFingerprint", "learningItemIds"], "D7 review context");
    requiredString(record.context.reviewTaskId, "context.reviewTaskId");
    requiredString(record.context.assignedPromptFingerprint, "context.assignedPromptFingerprint");
    stringArray(record.context.learningItemIds, "context.learningItemIds");
  } else {
    assert(false, "Unsupported review Attempt");
  }
}

function attemptInkSurface(record) {
  if (record.attemptType === WritingAttemptType.BACK_TRANSLATION) return `w3:back:${record.attemptId}`;
  if (record.attemptType === WritingAttemptType.RECONSTRUCTION) return `w6:reconstruction:${record.attemptId}`;
  if (record.attemptType === WritingAttemptType.INDEPENDENT) return `w7:independent:${record.attemptId}`;
  if (record.attemptType === WritingAttemptType.REVISION) return `w8:revision:${record.attemptId}`;
  const reviewType = record.attemptType.slice("review_".length).toUpperCase();
  return `review:${reviewType}:${record.attemptId}`;
}

async function validateAttempt(record, id, username) {
  assertBase(record, "attemptId", id, username);
  requiredString(record.sessionId, "sessionId");
  assert(ATTEMPT_TYPES.has(record.attemptType), "Attempt type is invalid");
  const isReview = [WritingAttemptType.REVIEW_D1, WritingAttemptType.REVIEW_D3, WritingAttemptType.REVIEW_D7].includes(record.attemptType);
  if (isReview) assert(record.stageId === null, "Review Attempt stageId must be null");
  else assert(WRITING_STAGES.includes(record.stageId) && record.stageId !== WritingStage.DONE, "Attempt stageId is invalid");
  assert(ATTEMPT_STATUSES.has(record.status), "Attempt status is invalid");
  if (record.attemptType === WritingAttemptType.REVISION) requiredString(record.parentAttemptId, "parentAttemptId");
  else assert(record.parentAttemptId === null, "Only revision Attempts may have parentAttemptId");
  validateAttemptContext(record);
  assert(INPUT_METHODS.has(record.inputMethod), "Attempt inputMethod is invalid");
  stringOrNull(record.typedText, "Attempt typedText");
  assertInkRef(record.inkRef, "inkRef", { ownerRecordId: record.attemptId, surfaceId: attemptInkSurface(record) });
  nullableString(record.transcriptionId, "transcriptionId");
  assert(record.timing === null || isPlainObject(record.timing), "Attempt timing must be an object or null");
  for (const field of ["createdAt", "updatedAt"]) assertTimestamp(record[field], field);
  for (const field of ["rawSubmittedAt", "submittedAt"]) assertTimestamp(record[field], field, { nullable: true });
  assertRevision(record.revision);
  if (record.verifiedText !== null) await validateVerifiedText(record.attemptId, record.verifiedText);
  if (record.verifiedText?.source === WritingVerifiedTextSource.TRANSCRIPTION) {
    assert(record.transcriptionId === record.verifiedText.sourceTranscriptionId, "verifiedText must reference the Attempt transcriptionId", "lineage-mismatch");
  }
  if ([WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(record.status)) {
    assert([WritingAttemptType.BACK_TRANSLATION, WritingAttemptType.INDEPENDENT].includes(record.attemptType), "Only W3/W7 Attempts may await handwriting verification");
    assert([WritingInputMethod.HANDWRITING, WritingInputMethod.MIXED].includes(record.inputMethod), "Raw/verifying Attempt must use handwriting input");
    assert(record.inkRef !== null, "Raw/verifying handwriting Attempt requires inkRef");
    assert(record.rawSubmittedAt !== null, "Raw/verifying handwriting Attempt requires rawSubmittedAt");
    assert(record.verifiedText === null, "Raw/verifying Attempt cannot contain verifiedText");
    if (record.status === WritingAttemptStatus.VERIFYING) requiredString(record.transcriptionId, "transcriptionId");
  }
  if (record.status === WritingAttemptStatus.SUBMITTED) {
    assert(record.submittedAt !== null, "Submitted Attempt requires submittedAt");
    if ([WritingAttemptType.BACK_TRANSLATION, WritingAttemptType.INDEPENDENT].includes(record.attemptType)) assert(record.verifiedText !== null, "Submitted W3/W7 Attempt requires verifiedText");
  } else assert(record.submittedAt === null, "Only a submitted Attempt may contain submittedAt");
  assertNoStrokes(record);
}

function validateAttemptTransition(current, next) {
  for (const field of ["sessionId", "attemptType", "stageId", "parentAttemptId", "createdAt"]) {
    assert(current[field] === next[field], `Attempt.${field} is frozen`);
  }
  assert(canonicalWritingJson(current.context) === canonicalWritingJson(next.context), "Attempt.context is frozen");
  if (current.rawSubmittedAt !== null) assert(next.rawSubmittedAt === current.rawSubmittedAt, "Attempt.rawSubmittedAt is frozen once set");
  if (current.submittedAt !== null) assert(next.submittedAt === current.submittedAt, "Attempt.submittedAt is frozen once set");
  assert(ATTEMPT_STATUS_ORDER[next.status] >= ATTEMPT_STATUS_ORDER[current.status], "Attempt status cannot move backward");
}

async function validateSkeletonRevision(record, id, username) {
  assertBase(record, "revisionId", id, username);
  requiredString(record.sessionId, "sessionId");
  assertRevision(record.revisionNumber, "revisionNumber");
  assert(DRAFT_STATUSES.has(record.status), "Skeleton status is invalid");
  nullableString(record.basedOnRevisionId, "basedOnRevisionId");
  assert(Array.isArray(record.blocks), "Skeleton blocks must be an array");
  const orders = new Set();
  record.blocks.forEach((block, index) => {
    assert(isPlainObject(block), `blocks[${index}] is invalid`);
    assert(SKELETON_BLOCK_KINDS.has(block.kind), `blocks[${index}].kind is invalid`);
    assert(typeof block.text === "string", `blocks[${index}].text must be a string`);
    assert(Number.isInteger(block.order) && block.order >= 0, `blocks[${index}].order must be a non-negative integer`);
    assert(!orders.has(block.order), `Skeleton block order ${block.order} is duplicated`);
    orders.add(block.order);
  });
  assertInkRef(record.inkRef, "inkRef", { ownerRecordId: record.revisionId, surfaceId: `w5:skeleton:${record.revisionId}` });
  for (const field of ["createdAt", "updatedAt"]) assertTimestamp(record[field], field);
  assertTimestamp(record.committedAt, "committedAt", { nullable: true });
  assertRevision(record.revision);
  if (record.status === WritingDraftStatus.COMMITTED) assert(record.committedAt !== null, "Committed Skeleton requires committedAt");
  else assert(record.committedAt === null, "Draft Skeleton cannot have committedAt");
  assertNoStrokes(record);
}

function validateSkeletonRevisionTransition(current, next) {
  for (const field of ["revisionId", "sessionId", "username", "revisionNumber", "basedOnRevisionId", "createdAt"]) {
    assert(current[field] === next[field], `SkeletonRevision.${field} is frozen`);
  }
}

async function validateTranscription(record, id, username) {
  assertBase(record, "transcriptionId", id, username);
  requiredString(record.sessionId, "sessionId");
  requiredString(record.sourceAttemptId, "sourceAttemptId");
  assert(record.sourceInkRef !== null, "Successful TranscriptionRecord requires sourceInkRef");
  assertInkRef(record.sourceInkRef, "sourceInkRef", { ownerRecordId: record.sourceAttemptId });
  if (Object.prototype.hasOwnProperty.call(record, "sourceInkFingerprint")) {
    requiredString(record.sourceInkFingerprint, "sourceInkFingerprint");
    assert(record.sourceInkFingerprint === record.sourceInkRef.fingerprint, "sourceInkFingerprint does not match sourceInkRef", "lineage-mismatch");
  }
  assert(typeof record.rawTranscript === "string", "rawTranscript must be a string");
  assert(record.segments === null || Array.isArray(record.segments), "segments must be an array or null");
  for (const field of ["provider", "modelId", "promptVersion", "adapterVersion"]) requiredString(record[field], field);
  assert(isPlainObject(record.requestMetadata), "requestMetadata is required");
  if (record.requestMetadata.taskId === "writing.vision.transcribe.v1") {
    requiredString(record.sourceInkFingerprint, "sourceInkFingerprint");
    const pages = record.segments;
    assert(Array.isArray(pages) && pages.length > 0, "Formal Vision segments must contain page transcripts");
    const pageIds = new Set();
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      assertExactKeys(page, ["pageId", "text", "segments"], `segments[${pageIndex}]`);
      const pageId = requiredString(page.pageId, `segments[${pageIndex}].pageId`);
      assert(!pageIds.has(pageId), "Formal Vision pageId must be unique");
      pageIds.add(pageId);
      assert(typeof page.text === "string", `segments[${pageIndex}].text must be a string`);
      assert(Array.isArray(page.segments), `segments[${pageIndex}].segments must be an array`);
      page.segments.forEach((segment, segmentIndex) => {
        assertExactKeys(segment, ["text", "confidence", "unsure"], `segments[${pageIndex}].segments[${segmentIndex}]`);
        assert(typeof segment.text === "string", `segments[${pageIndex}].segments[${segmentIndex}].text must be a string`);
        assert(segment.confidence === null || (Number.isFinite(segment.confidence) && segment.confidence >= 0 && segment.confidence <= 1), `segments[${pageIndex}].segments[${segmentIndex}].confidence is invalid`);
        assert(typeof segment.unsure === "boolean", `segments[${pageIndex}].segments[${segmentIndex}].unsure must be boolean`);
      });
    }
    const pageOrder = record.requestMetadata.pageOrder;
    assert(Array.isArray(pageOrder) && canonicalWritingJson(pageOrder) === canonicalWritingJson(pages.map((page) => page.pageId)), "requestMetadata.pageOrder must match formal segments");
    assert(record.rawTranscript === pages.map((page) => page.text).join("\n\n"), "rawTranscript must be the stable page-order join");
    for (const field of ["renderVersion", "providerKind", "baseUrlIdentity", "sourceInkFingerprint", "requestContextFingerprint"]) requiredString(record.requestMetadata[field], `requestMetadata.${field}`);
    assert(record.requestMetadata.sourceInkFingerprint === record.sourceInkFingerprint, "requestMetadata source ink lineage mismatch", "lineage-mismatch");
  }
  assertTimestamp(record.createdAt, "createdAt");
  for (const forbidden of ["error", "failure", "timedOut", "timeout"]) {
    assert(!Object.prototype.hasOwnProperty.call(record, forbidden), `Successful TranscriptionRecord cannot contain ${forbidden}`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "status")) assert(["success", "succeeded"].includes(record.status), "Repository only accepts successful TranscriptionRecord");
}

async function validateAiArtifact(record, id, username) {
  assertBase(record, "artifactId", id, username);
  requiredString(record.sessionId, "sessionId");
  requiredString(record.sourceAttemptId, "sourceAttemptId");
  assert(AI_ARTIFACT_TYPES.has(record.artifactType), "AI artifactType is invalid");
  for (const field of ["provider", "modelId", "promptVersion", "payloadVersion"]) requiredString(record[field], field);
  assert(isPlainObject(record.result) && Object.keys(record.result).length > 0, "AI artifact result must be a validated non-empty object");
  assertTimestamp(record.createdAt, "createdAt");
  for (const forbidden of ["error", "failure", "timedOut", "timeout"]) {
    assert(!Object.prototype.hasOwnProperty.call(record, forbidden), `Successful WritingAiArtifact cannot contain ${forbidden}`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "status")) assert(["success", "succeeded"].includes(record.status), "Repository only accepts successful WritingAiArtifact");
}

async function validateScoreReport(record, id, username) {
  assertBase(record, "scoreReportId", id, username);
  requiredString(record.sessionId, "sessionId");
  requiredString(record.sourceAttemptId, "sourceAttemptId");
  requiredString(record.sourceTextFingerprint, "sourceTextFingerprint");
  assertTaskType(record.taskType);
  assert(record.maxScore === maxScoreForTaskType(record.taskType), "Score maxScore does not match taskType");
  assert(typeof record.finalScore === "number" && Number.isFinite(record.finalScore) && record.finalScore >= 0 && record.finalScore <= record.maxScore, "finalScore is out of range");
  assert(typeof record.band === "number" && Number.isFinite(record.band) && record.band >= 0 && record.band <= 5, "band is out of range");
  if (record.finalScore === 0) assert(SCORE_ZERO_REASONS.has(record.zeroReason), "A zero score requires a valid zeroReason");
  else assert(record.zeroReason === null, "A non-zero score must use zeroReason=null");
  assert(record.rubricVersion === SCORE_RUBRIC_VERSIONS[record.taskType], "rubricVersion does not match taskType");
  for (const field of ["promptVersion", "provider", "modelId"]) requiredString(record[field], field);
  assert(isPlainObject(record.dimensions) && Object.keys(record.dimensions).length > 0, "Score dimensions are required");
  assert(Number.isInteger(record.wordCount) && record.wordCount >= 0, "wordCount is invalid");
  for (const field of ["issues", "strengths", "revisionAdvice"]) assert(Array.isArray(record[field]), `${field} must be an array`);
  assert(record.handwritingAssessed === false, "handwritingAssessed must be false in v1");
  assertTimestamp(record.createdAt, "createdAt");
}

export function assertScoreReportLineage(scoreReport, sourceAttempt) {
  assert(sourceAttempt, "ScoreReport source Attempt does not exist", "lineage-mismatch");
  assert(sourceAttempt?.attemptId === scoreReport?.sourceAttemptId, "ScoreReport sourceAttemptId does not match Attempt", "lineage-mismatch");
  assert(sourceAttempt?.username === scoreReport?.username && sourceAttempt?.sessionId === scoreReport?.sessionId, "ScoreReport account/session lineage does not match Attempt", "lineage-mismatch");
  assert(sourceAttempt?.status === WritingAttemptStatus.SUBMITTED, "ScoreReport requires a submitted Attempt", "lineage-mismatch");
  assert(isPlainObject(sourceAttempt?.verifiedText), "ScoreReport requires verifiedText", "lineage-mismatch");
  assert(sourceAttempt?.verifiedText?.fingerprint === scoreReport?.sourceTextFingerprint, "ScoreReport sourceTextFingerprint does not match verifiedText", "lineage-mismatch");
  return true;
}

async function validateLearningItem(record, id, username) {
  assertBase(record, "itemId", id, username);
  requiredString(record.sessionId, "sessionId");
  assert(LEARNING_ITEM_KINDS.has(record.kind), "LearningItem kind is invalid");
  requiredString(record.sourceText, "sourceText");
  nullableString(record.sourceUnitId, "sourceUnitId");
  nullableString(record.sourceAttemptId, "sourceAttemptId");
  assert(record.sourceUnitId !== null || record.sourceAttemptId !== null, "LearningItem requires sourceUnitId or sourceAttemptId");
  assert(LEARNING_ITEM_ORIGINS.has(record.origin), "LearningItem origin is invalid");
  stringOrNull(record.cueZh, "cueZh");
  assertTimestamp(record.confirmedAt, "confirmedAt");
}

export function writingReviewTaskId(sessionId, reviewType) {
  const normalizedSessionId = requiredString(sessionId, "sessionId");
  assert(REVIEW_TYPES.has(reviewType), "reviewType is invalid");
  return `writing-review:v1:${normalizedSessionId}:${reviewType.toLowerCase()}`;
}

function assertCalendarDate(value, name) {
  const date = requiredString(value, name);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  assert(match, `${name} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  assert(parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day, `${name} is not a valid calendar date`);
}

function validateReviewSourceRefs(record) {
  assert(isPlainObject(record.sourceRefs), "ReviewTask sourceRefs is required");
  if (record.reviewType === WritingReviewType.D1) {
    assertExactKeys(record.sourceRefs, ["translationSnapshotId", "learningItemIds"], "D1 sourceRefs");
    requiredString(record.sourceRefs.translationSnapshotId, "sourceRefs.translationSnapshotId");
    stringArray(record.sourceRefs.learningItemIds, "sourceRefs.learningItemIds");
    assert(record.mode === null, "D1 mode must be null");
  } else if (record.reviewType === WritingReviewType.D3) {
    assertExactKeys(record.sourceRefs, ["skeletonRevisionId", "promptFingerprint"], "D3 sourceRefs");
    nullableString(record.sourceRefs.skeletonRevisionId, "sourceRefs.skeletonRevisionId");
    requiredString(record.sourceRefs.promptFingerprint, "sourceRefs.promptFingerprint");
    const expectedMode = record.sourceRefs.skeletonRevisionId === null ? WritingReviewMode.PROMPT_ONLY : WritingReviewMode.SKELETON_ONLY;
    assert(record.mode === expectedMode, "D3 mode does not match skeletonRevisionId");
  } else {
    assertExactKeys(record.sourceRefs, ["learningItemIds", "sourcePromptFingerprint"], "D7 sourceRefs");
    stringArray(record.sourceRefs.learningItemIds, "sourceRefs.learningItemIds");
    requiredString(record.sourceRefs.sourcePromptFingerprint, "sourceRefs.sourcePromptFingerprint");
    assert(record.mode === null, "D7 mode must be null");
  }
}

async function validateReviewTask(record, id, username) {
  assertBase(record, "taskId", id, username);
  requiredString(record.sourceSessionId, "sourceSessionId");
  assert(REVIEW_TYPES.has(record.reviewType), "ReviewTask reviewType is invalid");
  assert(record.taskId === writingReviewTaskId(record.sourceSessionId, record.reviewType), "ReviewTask taskId is not deterministic", "identity-mismatch");
  assertCalendarDate(record.scheduledDate, "scheduledDate");
  assert(REVIEW_STATUSES.has(record.status), "ReviewTask status is invalid");
  validateReviewSourceRefs(record);
  nullableString(record.activeAttemptId, "activeAttemptId");
  nullableString(record.completedAttemptId, "completedAttemptId");
  for (const field of ["createdAt", "updatedAt"]) assertTimestamp(record[field], field);
  assertTimestamp(record.completedAt, "completedAt", { nullable: true });
  assertRevision(record.revision);
  if (record.status === WritingReviewStatus.COMPLETED) {
    assert(record.completedAttemptId !== null && record.completedAt !== null, "Completed ReviewTask requires completedAttemptId and completedAt");
  } else assert(record.completedAt === null, "Non-completed ReviewTask must use completedAt=null");
}

function validateReviewTaskTransition(current, next) {
  for (const field of ["taskId", "sourceSessionId", "reviewType", "scheduledDate", "mode", "createdAt"]) {
    assert(current[field] === next[field], `ReviewTask.${field} is frozen`);
  }
  assert(canonicalWritingJson(current.sourceRefs) === canonicalWritingJson(next.sourceRefs), "ReviewTask.sourceRefs is frozen");
  if (current.status === WritingReviewStatus.COMPLETED) {
    assert(next.status === WritingReviewStatus.COMPLETED, "Completed ReviewTask cannot be reopened");
    assert(next.completedAttemptId === current.completedAttemptId, "completedAttemptId is frozen");
    assert(next.completedAt === current.completedAt, "completedAt is frozen");
  }
}

function keyFor(prefix, id) {
  return `${prefix}${requiredString(id, "record id")}`;
}

export const writingKeys = Object.freeze({
  session: (id) => keyFor(KEY_PREFIXES.session, id),
  translationRevision: (id) => keyFor(KEY_PREFIXES.translationRevision, id),
  translationSnapshot: (id) => keyFor(KEY_PREFIXES.translationSnapshot, id),
  attempt: (id) => keyFor(KEY_PREFIXES.attempt, id),
  transcription: (id) => keyFor(KEY_PREFIXES.transcription, id),
  skeletonRevision: (id) => keyFor(KEY_PREFIXES.skeletonRevision, id),
  learningItem: (id) => keyFor(KEY_PREFIXES.learningItem, id),
  aiArtifact: (id) => keyFor(KEY_PREFIXES.aiArtifact, id),
  scoreReport: (id) => keyFor(KEY_PREFIXES.scoreReport, id),
  reviewTask: (id) => keyFor(KEY_PREFIXES.reviewTask, id),
});

function parseStoredRecord(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    assert(isPlainObject(parsed), "Writing record JSON must contain an object");
    return parsed;
  } catch (error) {
    if (error instanceof WritingDataError) throw error;
    throw new WritingDataError("Writing record is not valid JSON", "invalid-json");
  }
}

function normalizeExpectedRevision(value) {
  assertRevision(value, "expectedRevision", { allowZero: true });
  return value;
}

async function validateStored(record, validator, id, username) {
  await validator(record, id, username);
  assert(await hasValidFingerprint(record), "Writing record fingerprint is invalid", "bad-fingerprint");
  return cloneRecord(record);
}

export class WritingRepository {
  constructor({ username, getItem = getUserItem, setItem = setUserItem, listItems = listUserItems } = {}) {
    this.username = requiredString(username, "username");
    this.getItem = getItem;
    this.setItem = setItem;
    this.listItems = listItems;
  }

  async _read(key, validator, id) {
    const record = parseStoredRecord(this.getItem(key, this.username));
    if (!record) return null;
    return validateStored(record, validator, id, this.username);
  }

  async _saveMutable({ key, id, candidate, expectedRevision, validator, isTerminal, transition }) {
    const expected = normalizeExpectedRevision(expectedRevision);
    const current = await this._read(key, validator, id);
    const actualRevision = current?.revision || 0;
    if (actualRevision !== expected) throw new WritingStaleRevisionError(expected, actualRevision);
    const input = withoutTopLevelFingerprint(candidate);
    if (input.username !== this.username) throw new WritingAccountMismatchError();
    if (current && isTerminal(current)) {
      const sameVersion = await fingerprintWritingRecord({ ...input, revision: current.revision });
      await validator(sameVersion, id, this.username);
      if (sameVersion.fingerprint === current.fingerprint) return current;
      throw new WritingImmutableError();
    }
    const next = await fingerprintWritingRecord({ ...input, revision: actualRevision + 1 });
    await validator(next, id, this.username);
    if (current && transition) transition(current, next);
    this.setItem(key, JSON.stringify(next), this.username);
    let verified;
    try {
      verified = await this._read(key, validator, id);
    } catch (error) {
      throw new WritingConflictError(`Writing record post-write verification failed: ${error.message}`);
    }
    if (!verified || verified.revision !== next.revision || verified.fingerprint !== next.fingerprint) {
      throw new WritingConflictError("Writing record post-write verification failed");
    }
    return verified;
  }

  async _createOnce({ key, id, candidate, validator, lineage }) {
    const input = withoutTopLevelFingerprint(candidate);
    if (input.username !== this.username) throw new WritingAccountMismatchError();
    const next = await fingerprintWritingRecord(input);
    const existing = await this._read(key, validator, id);
    if (existing) {
      if (existing.fingerprint === next.fingerprint) return existing;
      throw new WritingConflictError("A different immutable Writing record already exists");
    }
    await validator(next, id, this.username);
    if (lineage) await lineage(next);
    this.setItem(key, JSON.stringify(next), this.username);
    let verified;
    try {
      verified = await this._read(key, validator, id);
    } catch (error) {
      throw new WritingConflictError(`Immutable Writing record post-write verification failed: ${error.message}`);
    }
    if (!verified || verified.fingerprint !== next.fingerprint) throw new WritingConflictError("Immutable Writing record post-write verification failed");
    return verified;
  }

  readSession(id) { return this._read(writingKeys.session(id), validateSession, id); }
  saveSession(candidate, { expectedRevision } = {}) {
    return this._saveMutable({ key: writingKeys.session(candidate?.sessionId), id: candidate?.sessionId, candidate, expectedRevision, validator: validateSession, isTerminal: () => false, transition: validateSessionTransition });
  }

  readTranslationRevision(id) { return this._read(writingKeys.translationRevision(id), validateTranslationRevision, id); }
  async saveTranslationRevision(candidate, { expectedRevision } = {}) {
    const session = await this.readSession(candidate?.sessionId);
    assert(session, "TranslationRevision requires its persisted Session", "lineage-mismatch");
    assertTranslationUnitsMatchSample(candidate, session.sampleEssaySnapshot);
    const saved = await this._saveMutable({ key: writingKeys.translationRevision(candidate?.revisionId), id: candidate?.revisionId, candidate, expectedRevision, validator: validateTranslationRevision, isTerminal: (record) => record.status === WritingDraftStatus.COMMITTED, transition: validateTranslationRevisionTransition });
    return saved;
  }

  readTranslationSnapshot(id) { return this._read(writingKeys.translationSnapshot(id), validateTranslationSnapshot, id); }
  createTranslationSnapshot(candidate) {
    return this._createOnce({
      key: writingKeys.translationSnapshot(candidate?.snapshotId),
      id: candidate?.snapshotId,
      candidate,
      validator: validateTranslationSnapshot,
      lineage: async (record) => {
        const revision = await this.readTranslationRevision(record.translationRevisionId);
        assert(revision, "TranslationSnapshot requires its persisted committed TranslationRevision", "lineage-mismatch");
        assertTranslationSnapshotLineage(record, revision);
      },
    });
  }

  readAttempt(id) { return this._read(writingKeys.attempt(id), validateAttempt, id); }
  saveAttempt(candidate, { expectedRevision } = {}) {
    return this._saveMutable({ key: writingKeys.attempt(candidate?.attemptId), id: candidate?.attemptId, candidate, expectedRevision, validator: validateAttempt, isTerminal: (record) => record.status === WritingAttemptStatus.SUBMITTED, transition: validateAttemptTransition });
  }

  readSkeletonRevision(id) { return this._read(writingKeys.skeletonRevision(id), validateSkeletonRevision, id); }
  saveSkeletonRevision(candidate, { expectedRevision } = {}) {
    return this._saveMutable({ key: writingKeys.skeletonRevision(candidate?.revisionId), id: candidate?.revisionId, candidate, expectedRevision, validator: validateSkeletonRevision, isTerminal: (record) => record.status === WritingDraftStatus.COMMITTED, transition: validateSkeletonRevisionTransition });
  }

  readTranscription(id) { return this._read(writingKeys.transcription(id), validateTranscription, id); }
  createTranscription(candidate) {
    return this._createOnce({
      key: writingKeys.transcription(candidate?.transcriptionId),
      id: candidate?.transcriptionId,
      candidate,
      validator: validateTranscription,
      lineage: candidate?.requestMetadata?.taskId === "writing.vision.transcribe.v1" ? async (record) => {
        const attempt = await this.readAttempt(record.sourceAttemptId);
        assert(attempt && attempt.sessionId === record.sessionId, "TranscriptionRecord requires its persisted source Attempt", "lineage-mismatch");
        assert([WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status), "TranscriptionRecord source Attempt is not awaiting verification", "lineage-mismatch");
        assert(canonicalWritingJson(attempt.inkRef) === canonicalWritingJson(record.sourceInkRef), "TranscriptionRecord sourceInkRef does not match Attempt.inkRef", "lineage-mismatch");
      } : null,
    });
  }

  readAiArtifact(id) { return this._read(writingKeys.aiArtifact(id), validateAiArtifact, id); }
  createAiArtifact(candidate) {
    return this._createOnce({ key: writingKeys.aiArtifact(candidate?.artifactId), id: candidate?.artifactId, candidate, validator: validateAiArtifact });
  }

  readScoreReport(id) { return this._read(writingKeys.scoreReport(id), validateScoreReport, id); }
  createScoreReport(candidate) {
    return this._createOnce({
      key: writingKeys.scoreReport(candidate?.scoreReportId),
      id: candidate?.scoreReportId,
      candidate,
      validator: validateScoreReport,
      lineage: async (record) => {
        const sourceAttempt = await this.readAttempt(record.sourceAttemptId);
        assertScoreReportLineage(record, sourceAttempt);
      },
    });
  }

  readLearningItem(id) { return this._read(writingKeys.learningItem(id), validateLearningItem, id); }
  createLearningItem(candidate) {
    return this._createOnce({ key: writingKeys.learningItem(candidate?.itemId), id: candidate?.itemId, candidate, validator: validateLearningItem });
  }

  readReviewTask(id) { return this._read(writingKeys.reviewTask(id), validateReviewTask, id); }
  saveReviewTask(candidate, { expectedRevision } = {}) {
    return this._saveMutable({ key: writingKeys.reviewTask(candidate?.taskId), id: candidate?.taskId, candidate, expectedRevision, validator: validateReviewTask, isTerminal: () => false, transition: validateReviewTaskTransition });
  }

  async listSessions() {
    return this._list(KEY_PREFIXES.session, (id) => this.readSession(id));
  }

  async listTranslationRevisions() {
    return this._list(KEY_PREFIXES.translationRevision, (id) => this.readTranslationRevision(id));
  }

  async listTranslationSnapshots() {
    return this._list(KEY_PREFIXES.translationSnapshot, (id) => this.readTranslationSnapshot(id));
  }

  async listAttempts() {
    return this._list(KEY_PREFIXES.attempt, (id) => this.readAttempt(id));
  }

  async listTranscriptions() {
    return this._list(KEY_PREFIXES.transcription, (id) => this.readTranscription(id));
  }

  async listSkeletonRevisions() {
    return this._list(KEY_PREFIXES.skeletonRevision, (id) => this.readSkeletonRevision(id));
  }

  async listAiArtifacts() {
    return this._list(KEY_PREFIXES.aiArtifact, (id) => this.readAiArtifact(id));
  }

  async listScoreReports() {
    return this._list(KEY_PREFIXES.scoreReport, (id) => this.readScoreReport(id));
  }

  async listLearningItems() {
    return this._list(KEY_PREFIXES.learningItem, (id) => this.readLearningItem(id));
  }

  async listReviewTasks() {
    return this._list(KEY_PREFIXES.reviewTask, (id) => this.readReviewTask(id));
  }

  async _list(prefix, read) {
    const rows = this.listItems(prefix, this.username);
    const records = [];
    for (const row of rows) {
      const id = row.key.slice(prefix.length);
      try {
        records.push(await read(id));
      } catch (error) {
        records.push({ damaged: true, id, errorCode: error.code || "damaged" });
      }
    }
    return records;
  }
}

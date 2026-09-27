import {
  getDevicePrivateWritingSample,
  listDevicePrivateWritingSamples,
  putDevicePrivateWritingSamples,
} from "../storage.js";
import { computeWritingFingerprint } from "./writingRepository.js";
import { getWritingQuestion } from "./writingQuestionBank.js";
import { BUNDLED_WRITING_SAMPLE_CATALOG } from "./generatedWritingSampleCatalog.js";

export const WRITING_PRIVATE_SAMPLE_FORMAT = "wuliao-writing-private-samples";
export const WRITING_PRIVATE_SAMPLE_VERSION = 1;
export const WRITING_PRIVATE_SAMPLE_SOURCE_TYPE = "device_private";
export const WRITING_PRIVATE_DISTRIBUTION_SCOPE = "device_private";
export const WRITING_BUNDLED_SAMPLE_SOURCE_TYPE = "apk_bundle";
export const WRITING_BUNDLED_DISTRIBUTION_SCOPE = "apk_bundle";

export class WritingPrivateSampleError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "WritingPrivateSampleError";
    this.code = code;
    this.details = details;
  }
}

function requiredText(value, field) {
  const result = String(value || "").trim();
  if (!result) throw new WritingPrivateSampleError("invalid-private-sample", `${field} 缺失。`);
  return result;
}

function wordCount(value) {
  return (String(value || "").match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || []).length;
}

function exactQuestion(item) {
  const questionId = requiredText(item?.questionId, "questionId");
  const question = getWritingQuestion(questionId);
  if (!question) throw new WritingPrivateSampleError("question-not-found", `题目 ${questionId} 不在当前真题库中。`);
  if (item.year !== question.year || item.taskType !== question.taskType || item.promptFingerprint !== question.fingerprint) {
    throw new WritingPrivateSampleError("question-identity-mismatch", `题目 ${questionId} 的年份、题型或题面指纹不匹配。`);
  }
  return question;
}

function assertSha256(value, field) {
  const result = requiredText(value, field);
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new WritingPrivateSampleError("invalid-private-sample", `${field} 不是 SHA-256 指纹。`);
  return result.toLowerCase();
}

async function normalizeItem(item, username, importedAt) {
  const question = exactQuestion(item);
  const referenceEssay = requiredText(item.referenceEssay, "referenceEssay");
  const sourceDocumentFingerprint = assertSha256(item.sourceDocumentFingerprint, "sourceDocumentFingerprint");
  const sourceLabel = requiredText(item.sourceLabel, "sourceLabel");
  const record = {
    id: `${encodeURIComponent(username)}::${question.questionId}`,
    username,
    questionId: question.questionId,
    year: question.year,
    taskType: question.taskType,
    promptFingerprint: question.fingerprint,
    referenceEssay,
    sourceDocumentFingerprint,
    sourceLabel,
    sourceLocator: String(item.sourceLocator || "").trim() || null,
    origin: String(item.origin || "device_private_import"),
    importedAt,
    schemaVersion: WRITING_PRIVATE_SAMPLE_VERSION,
  };
  return { ...record, recordFingerprint: await computeWritingFingerprint(record) };
}

async function validateStoredRecord(record, username, questionId) {
  if (!record || record.username !== username || record.questionId !== questionId) return null;
  const { recordFingerprint, ...body } = record;
  if (!recordFingerprint || await computeWritingFingerprint(body) !== recordFingerprint) {
    throw new WritingPrivateSampleError("private-sample-corrupt", "设备私有范文未通过完整性校验。", { questionId });
  }
  exactQuestion(record);
  requiredText(record.referenceEssay, "referenceEssay");
  assertSha256(record.sourceDocumentFingerprint, "sourceDocumentFingerprint");
  return record;
}

async function snapshotFromRecord(record) {
  const qualityReportFingerprint = await computeWritingFingerprint({
    gate: "device-private-import-v1",
    recordFingerprint: record.recordFingerprint,
    promptFingerprint: record.promptFingerprint,
  });
  const snapshot = {
    essayId: `device-private:${record.questionId}:${record.recordFingerprint.slice(0, 16)}`,
    sourceType: WRITING_PRIVATE_SAMPLE_SOURCE_TYPE,
    distributionScope: WRITING_PRIVATE_DISTRIBUTION_SCOPE,
    sourceKind: "private_reference",
    sourceLabel: record.sourceLabel,
    sourceDocumentFingerprint: record.sourceDocumentFingerprint,
    sourceLocator: record.sourceLocator,
    text: record.referenceEssay,
    wordCount: wordCount(record.referenceEssay),
    segments: [{ unitId: `private:${record.questionId}:document`, text: record.referenceEssay }],
    qualityStatus: "passed",
    qualityGateVersion: "device-private-import-v1",
    qualityReportFingerprint,
    generatorMetadata: null,
  };
  return { ...snapshot, fingerprint: await computeWritingFingerprint(snapshot) };
}

async function snapshotFromBundledItem(item, catalog) {
  const qualityReportFingerprint = await computeWritingFingerprint({
    gate: "apk-writing-sample-catalog-v1",
    catalogVersion: catalog.catalogVersion,
    contentHash: catalog.contentHash,
    questionId: item.questionId,
    referenceEssayFingerprint: item.referenceEssayFingerprint,
  });
  const snapshot = {
    essayId: `apk-bundle:${item.questionId}:${item.referenceEssayFingerprint.slice(0, 16)}`,
    sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE,
    distributionScope: WRITING_BUNDLED_DISTRIBUTION_SCOPE,
    sourceKind: "bundled_reference",
    sourceLabel: item.sourceLabel,
    sourceDocumentFingerprint: item.sourceFingerprint,
    sourceLocator: item.sourceLocator,
    catalogVersion: catalog.catalogVersion,
    catalogContentHash: catalog.contentHash,
    text: item.referenceEssay,
    wordCount: wordCount(item.referenceEssay),
    segments: [{ unitId: `apk-bundle:${item.questionId}:document`, text: item.referenceEssay }],
    qualityStatus: "passed",
    qualityGateVersion: "apk-writing-sample-catalog-v1",
    qualityReportFingerprint,
    generatorMetadata: null,
  };
  return { ...snapshot, fingerprint: await computeWritingFingerprint(snapshot) };
}

function matchesBundledItem(record, item) {
  return record.questionId === item.questionId
    && record.year === item.year
    && record.taskType === item.taskType
    && record.promptFingerprint === item.promptFingerprint
    && record.referenceEssay === item.referenceEssay
    && record.sourceDocumentFingerprint === item.sourceFingerprint;
}

async function matchesRetiredItem(record, retired) {
  return record.questionId === retired.questionId
    && record.promptFingerprint === retired.promptFingerprint
    && record.sourceDocumentFingerprint === retired.sourceFingerprint
    && await computeWritingFingerprint({ referenceEssay: record.referenceEssay }) === retired.referenceEssayFingerprint;
}

function androidBridge() {
  return typeof window !== "undefined" ? window.AndroidPrivateWritingSamples : null;
}

export function createWritingPrivateSamplesService({
  username,
  getCurrentUsername = () => username,
  putRecords = putDevicePrivateWritingSamples,
  getRecord = getDevicePrivateWritingSample,
  listRecords = listDevicePrivateWritingSamples,
  now = () => Date.now(),
  catalog = BUNDLED_WRITING_SAMPLE_CATALOG,
} = {}) {
  const account = async () => requiredText(await getCurrentUsername?.(), "username");
  const bundledByQuestion = new Map((catalog?.items || []).map((item) => [item.questionId, item]));
  const retiredByQuestion = new Map((catalog?.retiredSamples || []).map((item) => [item.questionId, item]));

  async function importPayload(payload) {
    const activeUsername = await account();
    if (!payload || payload.format !== WRITING_PRIVATE_SAMPLE_FORMAT || payload.version !== WRITING_PRIVATE_SAMPLE_VERSION || !Array.isArray(payload.items)) {
      throw new WritingPrivateSampleError("invalid-private-payload", "私有范文包格式或版本不受支持。");
    }
    const seen = new Set();
    const seenEssayFingerprints = new Set();
    const records = [];
    for (const item of payload.items) {
      const record = await normalizeItem(item, activeUsername, now());
      if (seen.has(record.questionId)) throw new WritingPrivateSampleError("duplicate-question", `题目 ${record.questionId} 出现重复范文。`);
      const essayFingerprint = await computeWritingFingerprint({ referenceEssay: record.referenceEssay });
      if (seenEssayFingerprints.has(essayFingerprint)) {
        throw new WritingPrivateSampleError("duplicate-reference-essay", `题目 ${record.questionId} 的范文正文与另一道题完全相同，已拒绝导入。`);
      }
      seen.add(record.questionId);
      seenEssayFingerprints.add(essayFingerprint);
      records.push(record);
    }
    if (String(await getCurrentUsername?.() || "").trim() !== activeUsername) {
      throw new WritingPrivateSampleError("account-changed", "导入期间账号发生变化，未写入私有范文。");
    }
    await putRecords(records);
    return { importedCount: records.length, questionIds: records.map((record) => record.questionId) };
  }

  async function consumePendingAndroidSeed() {
    const bridge = androidBridge();
    if (!bridge?.readPendingSeed) return { status: "unavailable", importedCount: 0 };
    const serialized = String(bridge.readPendingSeed() || "");
    if (!serialized) return { status: "empty", importedCount: 0 };
    let payload;
    try {
      payload = JSON.parse(serialized);
    } catch (cause) {
      throw new WritingPrivateSampleError("invalid-private-payload", "设备侧载文件不是有效 JSON。", cause);
    }
    const result = await importPayload(payload);
    bridge.clearPendingSeed?.();
    return { status: "imported", ...result };
  }

  async function listAvailableSamples() {
    const activeUsername = await account();
    const records = await listRecords(activeUsername);
    const recordsByQuestion = new Map((records || []).map((record) => [record.questionId, record]));
    const available = [];
    for (const item of catalog?.items || []) {
      const stored = recordsByQuestion.get(item.questionId);
      if (stored) {
        try {
          const valid = await validateStoredRecord(stored, activeUsername, item.questionId);
          if (!valid || !matchesBundledItem(valid, item)) continue;
        } catch {
          continue;
        }
      }
      available.push({ questionId: item.questionId, sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE });
    }
    for (const record of records || []) {
      if (bundledByQuestion.has(record.questionId)) continue;
      try {
        const valid = await validateStoredRecord(record, activeUsername, record.questionId);
        if (!valid) continue;
        const retired = retiredByQuestion.get(valid.questionId);
        if (valid.origin === WRITING_BUNDLED_SAMPLE_SOURCE_TYPE || (retired && await matchesRetiredItem(valid, retired))) continue;
        available.push({ questionId: valid.questionId, sourceType: WRITING_PRIVATE_SAMPLE_SOURCE_TYPE });
      } catch {
        // 损坏或题面已变化的记录 fail closed，不向 UI 宣称可用。
      }
    }
    return [...new Map(available.map((item) => [item.questionId, item])).values()]
      .sort((left, right) => left.questionId.localeCompare(right.questionId));
  }

  async function listAvailableQuestionIds() {
    return (await listAvailableSamples()).map((item) => item.questionId);
  }

  async function getSampleSnapshot(questionId, { sourceType = null } = {}) {
    const activeUsername = await account();
    const bundled = bundledByQuestion.get(questionId);
    const record = await getRecord(activeUsername, questionId);
    if (sourceType === WRITING_BUNDLED_SAMPLE_SOURCE_TYPE && !bundled) {
      throw new WritingPrivateSampleError("bundled-sample-unavailable", "这道题不在当前 APK 范文目录中。");
    }
    if (bundled) {
      if (record) {
        const validLegacy = await validateStoredRecord(record, activeUsername, questionId);
        if (!validLegacy || !matchesBundledItem(validLegacy, bundled)) {
          throw new WritingPrivateSampleError("bundled-private-conflict", "当前设备中的旧范文与 APK 目录指纹不一致，已停止使用以避免静默覆盖。", { questionId });
        }
      }
      return snapshotFromBundledItem(bundled, catalog);
    }
    const valid = await validateStoredRecord(record, activeUsername, questionId);
    if (!valid) throw new WritingPrivateSampleError("private-sample-unavailable", "这道题没有通过校验的设备私有参考范文。");
    const retired = retiredByQuestion.get(questionId);
    if (valid.origin === WRITING_BUNDLED_SAMPLE_SOURCE_TYPE || (retired && await matchesRetiredItem(valid, retired))) {
      throw new WritingPrivateSampleError("private-sample-retired", "这篇随应用范文已从当前目录退役，不再用于新训练。");
    }
    return snapshotFromRecord(valid);
  }

  function getCatalogMetadata() {
    return Object.freeze({
      catalogSchemaVersion: catalog.catalogSchemaVersion,
      catalogVersion: catalog.catalogVersion,
      contentHash: catalog.contentHash,
      activeQuestionIds: [...catalog.activeQuestionIds],
      retiredQuestionIds: [...catalog.retiredQuestionIds],
    });
  }

  return Object.freeze({ importPayload, consumePendingAndroidSeed, listAvailableSamples, listAvailableQuestionIds, getSampleSnapshot, getCatalogMetadata });
}

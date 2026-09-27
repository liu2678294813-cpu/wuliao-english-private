/**
 * 数据备份 / 恢复 —— R4 数据安全能力（不是学习功能）。
 *
 * 设计原则：
 * - 版本化 manifest（format: "wuliao-backup", version: 1）；
 * - 只备份"账号作用域内的学习数据"，绝不导出 API Key / 密码 verifier /
 *   可再生缓存 / telemetry / snapshot 等非学习或敏感数据；
 * - 恢复只支持安全 merge（保留现有数据，补入不存在的数据），重复恢复幂等；
 * - 恢复严格按当前账号隔离：A 的备份不可能隐式恢复到 B；
 * - 跨存储（localStorage / IndexedDB）无法做到单一原子事务，因此采用
 *   preflight → write → verify → journal 流程；中途失败会如实报告，
 *   不会让用户误以为恢复成功。
 *
 * 本模块为纯逻辑核心（可注入 storage/IDB 适配器，Node 可测）；
 * 浏览器适配器见下方 defaultBackupSources / defaultRestoreSources。
 */

import { openHandwritingDatabase, HANDWRITING_DB } from "./vocabulary/handwritingStorage.js";
import { getTelemetry } from "./telemetry/telemetry";
import { openWuliaoEnglishDatabase } from "./storage";
import { flushDurableInk, inkStorageReady, isDurableInkKey, listDurableInk, writeDurableInk } from "./durableInkStorage.js";

// Backup v1 keeps logical learning keys, independent of their physical store.
function includeDurableEntries(entries, storage) {
  const username = storage?.getItem(CURRENT_USER_KEY) || "";
  if (storage !== globalThis.localStorage || !inkStorageReady(username)) return entries;
  const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
  const map = new Map(entries.map((entry) => [entry.key, entry]));
  for (const entry of listDurableInk(username)) map.set(prefix + entry.key, { key: prefix + entry.key, value: entry.value });
  return [...map.values()];
}

export const BACKUP_FORMAT = "wuliao-backup";
export const BACKUP_VERSION = 1;

export const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
export const LEGACY_OWNER_KEY = "wuliao_auth_legacy_owner";
export const BACKUP_JOURNAL_KEY = "wuliao:backup:journal";

export const USER_PREFIX = "wuliao:user:";

const X1_CURRENT_LOGICAL_KEY_PREFIXES = [
  "wuliao:exam-session:v1:",
  "wuliao:exam-session-recovery:v1:",
  "wuliao:exam-result:v1:",
  "wuliao:exam-handoff:v1:",
];

const WRITING_LOGICAL_KEY_PREFIXES = [
  "wuliao:writing-session:v1:",
  "wuliao:writing-translation:v1:",
  "wuliao:writing-translation-snapshot:v1:",
  "wuliao:writing-attempt:v1:",
  "wuliao:writing-transcription:v1:",
  "wuliao:writing-skeleton:v1:",
  "wuliao:writing-learning-item:v1:",
  "wuliao:writing-ai-artifact:v1:",
  "wuliao:writing-score:v1:",
  "wuliao:writing-review-task:v1:",
];

// 数据库与 store 的备份范围（regenerable / secret 不进备份）。
export const IDB_INCLUDED = {
  WuliaoVocabHandwritingDB: { answers: {}, sessions: {} },
  "wuliao-english": {
    "custom-pdfs": { includeBlob: true },
    "unknown-words": {},
    "exam-ink": { mergeByFingerprint: true },
    "writing-ink": { mergeByFingerprint: true },
  },
  KaoyanVocabDB: {
    wordLists: {},
    screeningProgress: {},
    screeningSessions: {},
    wordRecords: {},
    confusionPairs: {},
  },
  KaoyanVocabMemorizeDB: {
    records: {},
    importedLists: {},
    importedWords: {},
  },
};

export const IDB_EXCLUDED_STORES = {
  "wuliao-english": ["pdf-parse-cache", "device-private-writing-samples"],
  KaoyanVocabDB: ["users"],
};

export const REGENERABLE_KEYS = new Set([
  "wuliao:ai:translation-review-cache",
  "wuliao:ai:question-hint-cache",
  "wuliao:ai:question-diagnosis-cache",
  "wuliao:ai:cloze-task-cache",
  "wuliao:writing:vision-probe-cache:v1",
  "wuliao:writing:vision-model-catalog:v1",
]);

export const DEVICE_ONLY_KEYS = new Set([
  "wuliao:dev:mode:v1",
  "wuliao:telemetry:v1",
  "wuliao:telemetry:latest-eval:v1",
  "wuliao:telemetry:eval-visible:v1",
]);

// 设备级词汇设置：随备份携带（settings 而非学习事实），恢复写回原 key。
export const DEVICE_VOCAB_KEYS = new Set([
  "wuliao:vocabulary:auto-pronounce",
  "wuliao:vocabulary:shuffle-screening",
  "wuliao:vocabulary:current-learning-list",
]);

const SECRET_KEY_PATTERN = /(apikey|api[_-]?key|password|passwd|passwordhash|passwordsalt|pin|token|secret|credential)/i;

export class BackupError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.cause = cause;
  }
}

function classifyLocalKey(key, { username, legacyOwner }) {
  if (!key) return "excluded";
  if (key === CURRENT_USER_KEY || key === LEGACY_OWNER_KEY || key === BACKUP_JOURNAL_KEY) return "excluded";
  if (SECRET_KEY_PATTERN.test(key)) return "secret";
  // 用户作用域的缓存 key 形如 wuliao:user:<u>:wuliao:ai:*，去前缀后按逻辑 key 判定
  const logicalKey = key.replace(/^wuliao:user:[^:]+:/, "");
  if (REGENERABLE_KEYS.has(key) || REGENERABLE_KEYS.has(logicalKey)) return "regenerable";
  if (DEVICE_ONLY_KEYS.has(key)) return "excluded";
  if (key.startsWith(userStoragePrefix(username))) return "user";
  if (key.startsWith(USER_PREFIX)) return "excluded";
  if (key.startsWith("wuliao:") && legacyOwner === username) return "legacy";
  if (DEVICE_VOCAB_KEYS.has(key)) return "device";
  if (
    key === `wuliao:memory:rule:${username}`
    || key === `wuliao:memory:input:${username}`
    || key === `kaoyan_vocab_memorize_progress:${username}`
    || key.startsWith(`kaoyan_vocab_daily_review:${username}:`)
    || key === `wuliao:vocab:last-source-list:${username}`
  ) {
    return "user-raw";
  }
  return "excluded";
}

function userStoragePrefix(username) {
  return `${USER_PREFIX}${encodeURIComponent(username)}:`;
}

export function plainStoredValue(value) {
  return String(value ?? "").replace(/^"(.*)"$/, "$1");
}

function collectLocalStorageEntries(entries, { username, legacyOwner }) {
  const user = [];
  const userRaw = [];
  const legacy = [];
  const device = [];
  for (const item of entries || []) {
    const key = String(item?.key || "");
    const value = String(item?.value ?? "");
    if (value === "" || value === null || value === undefined) continue;
    if (/data:image\/[a-z0-9.+-]+;base64,/i.test(value)) continue;
    const kind = classifyLocalKey(key, { username, legacyOwner: plainStoredValue(legacyOwner) });
    if (kind === "user") user.push({ key: key.slice(userStoragePrefix(username).length), value });
    else if (kind === "user-raw") userRaw.push({ key, value });
    else if (kind === "legacy") legacy.push({ key, value });
    else if (kind === "device") device.push({ key, value });
    // secret / regenerable / excluded 一律不进入备份
  }
  return { user, userRaw, legacy, device };
}

function parsedStoredRecord(item) {
  try {
    const value = JSON.parse(String(item?.value || ""));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function omitDevicePrivateWritingRecords(local) {
  const writingEntries = [...local.user, ...local.legacy].filter((item) => {
    const key = String(item?.key || "").replace(/^wuliao:user:[^:]+:/, "");
    return WRITING_LOGICAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
  });
  const privateSessionIds = new Set(writingEntries.map(parsedStoredRecord)
    .filter((record) => record?.sampleEssaySnapshot?.sourceType === "device_private")
    .map((record) => record.sessionId)
    .filter(Boolean));
  if (!privateSessionIds.size) return { local, privateSessionIds };
  const keep = (item) => {
    const key = String(item?.key || "").replace(/^wuliao:user:[^:]+:/, "");
    if (!WRITING_LOGICAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
    const record = parsedStoredRecord(item);
    return !privateSessionIds.has(record?.sessionId) && !privateSessionIds.has(record?.sourceSessionId);
  };
  return {
    local: { ...local, user: local.user.filter(keep), legacy: local.legacy.filter(keep) },
    privateSessionIds,
  };
}

function sha256Hex(text) {
  if (globalThis.crypto?.subtle?.digest) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(
      (digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  }
  // 无 WebCrypto（老 WebView / 部分测试环境）时退化为确定性 FNV-1a。
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Promise.resolve(`fnv-${hash.toString(16).padStart(8, "0")}`);
}

async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16).padStart(8, "0")}`;
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 创建备份。
 * sources:
 *   { entries: [{key,value}], databases: [{ name, stores: [{ name, records: [{ key, value }] }] }] }
 * record.value 中的 Blob/File 会被提取为附件（浏览器适配器负责编码）。
 */
export async function createBackup({
  sources,
  username = "",
  appVersion = "0.0.0",
  now = Date.now(),
  onProgress = null,
  encodeAttachment = null,
} = {}) {
  if (!username) throw new BackupError("no-account", "请先登录账号再导出备份");
  const legacyOwner = (sources.entries || []).find((item) => item.key === LEGACY_OWNER_KEY)?.value || "";
  const collectedLocal = collectLocalStorageEntries(sources.entries, { username, legacyOwner });
  const { local, privateSessionIds } = omitDevicePrivateWritingRecords(collectedLocal);
  const databases = typeof sources.databases === "function" ? await sources.databases() : (sources.databases || []);

  const accounts = [{ username }];
  const sections = {
    localStorage: {
      user: local.user,
      userRaw: local.userRaw,
      legacy: local.legacy,
      device: local.device,
    },
    indexedDB: {},
  };
  const attachments = {};
  let attachmentIndex = 0;
  let totalBlobs = 0;

  for (const database of databases) {
    const includedStores = IDB_INCLUDED[database.name];
    if (!includedStores) continue;
    sections.indexedDB[database.name] = {};
    for (const store of database.stores || []) {
      if (!includedStores[store.name]) continue;
      const records = [];
      for (const record of store.records || []) {
        if (!record || !record.value || typeof record.value !== "object") continue;
        if (record.value.username != null && record.value.username !== username) continue;
        if (privateSessionIds.has(record.value.sessionId) || privateSessionIds.has(record.value.sourceSessionId)) continue;
        const value = { ...record.value };
        let needsAttachment = false;
        if (includedStores[store.name].includeBlob && value.file && value.file.constructor?.name === "Blob") {
          needsAttachment = true;
        } else if (includedStores[store.name].includeBlob && value.file && typeof value.file === "object" && typeof value.file.arrayBuffer === "function") {
          needsAttachment = true;
        }
        if (needsAttachment && encodeAttachment) {
          const attachmentId = `att-${++attachmentIndex}`;
          const encoded = await encodeAttachment(value.file, {
            onProgress: (percent) => onProgress?.({
              phase: "blob",
              id: attachmentId,
              name: value.file?.name || "",
              percent,
            }),
          });
          attachments[attachmentId] = {
            name: value.file?.name || "",
            type: value.file?.type || "application/pdf",
            size: encoded.size,
            sha256: encoded.sha256,
            data: encoded.data,
          };
          value.file = { __backupAttachment: attachmentId };
          totalBlobs += 1;
        }
        records.push({ key: record.key, value });
      }
      if (records.length) sections.indexedDB[database.name][store.name] = records;
    }
  }

  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    appVersion: String(appVersion || ""),
    schemaDescription: "wuliao-english R4 backup v1: user-scoped localStorage learning facts + user-scoped IndexedDB learning records (custom PDFs as base64 attachments); excludes API keys, password verifiers, regenerable caches, telemetry and runtime snapshots.",
    accounts,
    sections,
    attachments,
    checksum: "",
  };

  const { checksum, ...canonical } = manifest;
  const canonicalText = JSON.stringify(canonical);
  manifest.checksum = await sha256Hex(canonicalText);

  onProgress?.({ phase: "done", blobs: totalBlobs, bytes: canonicalText.length });
  return { manifest, fileText: JSON.stringify(manifest), counts: summarizeBackup(manifest) };
}

export function summarizeBackup(manifest) {
  const counts = { localStorage: 0, indexedDB: 0, customPdfs: 0 };
  for (const group of Object.values(manifest.sections?.localStorage || {})) {
    counts.localStorage += Array.isArray(group) ? group.length : 0;
  }
  for (const stores of Object.values(manifest.sections?.indexedDB || {})) {
    for (const records of Object.values(stores || {})) {
      counts.indexedDB += Array.isArray(records) ? records.length : 0;
    }
  }
  counts.customPdfs = Object.keys(manifest.attachments || {}).length;
  return counts;
}

// ---------------- 解析 / 校验 ----------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function parseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (error) {
    throw new BackupError("corrupt-json", "备份文件不是有效的 JSON", error);
  }
  if (!isPlainObject(parsed)) throw new BackupError("corrupt-backup", "备份文件结构无效");
  if (parsed.format !== BACKUP_FORMAT) throw new BackupError("unknown-format", "不是无聊英语备份文件");
  if (parsed.version !== BACKUP_VERSION) {
    throw new BackupError("unknown-version", `备份版本 ${String(parsed.version)} 不受支持（当前支持 v${BACKUP_VERSION}）`);
  }
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new BackupError("corrupt-backup", "备份缺少账号信息");
  }
  if (!isPlainObject(parsed.sections) || !isPlainObject(parsed.sections.localStorage) || !isPlainObject(parsed.sections.indexedDB)) {
    throw new BackupError("corrupt-backup", "备份缺少数据区");
  }
  if (!isPlainObject(parsed.attachments)) throw new BackupError("corrupt-backup", "备份缺少附件区");

  const { checksum, ...canonical } = parsed;
  const expected = await sha256Hex(JSON.stringify(canonical));
  if (!checksum || expected !== checksum) {
    throw new BackupError("corrupt-backup", "备份校验和失败：文件可能已损坏或被修改");
  }
  return parsed;
}

export function previewRestore(manifest, currentUsername) {
  const counts = summarizeBackup(manifest);
  const accounts = (manifest.accounts || []).map((account) => account?.username).filter(Boolean);
  return {
    accounts,
    counts,
    currentUsername,
    sameAccount: accounts.includes(currentUsername),
    containsCustomPdfs: counts.customPdfs > 0,
    secretsExcluded: true,
    conflictCounts: null,
  };
}

// ---------------- 恢复（安全 merge） ----------------

function scopedTargetKey(username, key) {
  return `${userStoragePrefix(username)}${key}`;
}

function storedRecordFingerprint(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return typeof parsed?.fingerprint === "string" && parsed.fingerprint ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

function isX1CurrentLogicalKey(key) {
  return X1_CURRENT_LOGICAL_KEY_PREFIXES.some((prefix) => String(key || "").startsWith(prefix));
}

function isWritingLogicalKey(key) {
  return WRITING_LOGICAL_KEY_PREFIXES.some((prefix) => String(key || "").startsWith(prefix));
}

export function planRestoreWrites(manifest, { username, existingEntries = [] }) {
  const existing = new Map(existingEntries.map((item) => [item.key, item.value]));
  const legacyOwner = plainStoredValue(existingEntries.find((item) => item.key === LEGACY_OWNER_KEY)?.value || "");
  const local = manifest.sections?.localStorage || {};
  const writes = [];
  const localStorageConflicts = [];

  for (const item of local.user || []) {
    const target = scopedTargetKey(username, item.key);
    if (existing.has(target)) {
      if (isX1CurrentLogicalKey(item.key) || isWritingLogicalKey(item.key)) {
        const existingFingerprint = storedRecordFingerprint(existing.get(target));
        const incomingFingerprint = storedRecordFingerprint(item.value);
        if (!existingFingerprint || !incomingFingerprint || existingFingerprint !== incomingFingerprint) {
          localStorageConflicts.push({
            storage: "localStorage",
            key: target,
            code: "conflict",
            message: isWritingLogicalKey(item.key)
              ? "Existing Writing record fingerprint differs; local data was preserved"
              : "Existing X1 snapshot differs; local data was preserved",
          });
        }
      }
      continue;
    }
    writes.push({ storage: "localStorage", key: target, value: item.value });
  }
  for (const item of local.userRaw || []) {
    // 用户名直接拼接的旧 key：只允许恢复到同名账号，且目标不存在时写入
    const suffix = `:${username}`;
    if (!item.key.endsWith(suffix) && !item.key.includes(`:${username}:`)) continue;
    if (existing.has(item.key)) continue;
    writes.push({ storage: "localStorage", key: item.key, value: item.value });
  }
  for (const item of local.legacy || []) {
    // legacy 原始 key 属于"第一个登录账号"；只有本设备 owner 为空或等于
    // 当前账号且 scoped 副本不存在时才写回，防止跨账号污染。
    if (legacyOwner && legacyOwner !== username) continue;
    if (existing.has(scopedTargetKey(username, item.key))) continue;
    if (existing.has(item.key)) continue;
    writes.push({ storage: "localStorage-legacy", key: item.key, value: item.value });
  }
  for (const item of local.device || []) {
    if (existing.has(item.key)) continue;
    writes.push({ storage: "localStorage", key: item.key, value: item.value });
  }

  const idbWrites = [];
  for (const [dbName, stores] of Object.entries(manifest.sections?.indexedDB || {})) {
    for (const [storeName, records] of Object.entries(stores || {})) {
      for (const record of records || []) {
        if (!record?.value || typeof record.value !== "object") continue;
        if (record.value.username != null && record.value.username !== username) continue;
        idbWrites.push({ storage: "indexedDB", db: dbName, store: storeName, key: record.key, value: record.value });
      }
    }
  }
  return { localStorageWrites: writes, localStorageConflicts, idbWrites };
}

export function decodeAttachment(manifest, value) {
  const attachmentId = value?.file?.__backupAttachment;
  if (!attachmentId) return null;
  const attachment = manifest.attachments?.[attachmentId];
  if (!attachment) throw new BackupError("corrupt-backup", `备份缺少附件 ${attachmentId}`);
  return {
    attachment,
    bytes: bytesFromBase64(attachment.data),
    fileMeta: { name: attachment.name, type: attachment.type, size: attachment.size, sha256: attachment.sha256 },
  };
}

/**
 * 执行恢复（merge）：
 * - existingEntries：恢复目标设备当前 localStorage 全部键值；
 * - writeLocal：({key, value}) => void（merge 只写不存在的 key，由调用方保证）；
 * - idb: { listExists(db, store, key), get?(db, store, key), put(db, store, key, value), createFile(meta, bytes) }
 * 返回 { writtenLocal, writtenIdb, skipped, errors, verified }。
 */
export async function restoreBackup({
  manifest,
  username,
  existingEntries,
  writeLocal,
  idb,
  createFile,
  journal = null,
} = {}) {
  if (!username) throw new BackupError("no-account", "请先登录账号再恢复备份");
  const plan = planRestoreWrites(manifest, { username, existingEntries });
  const errors = [...plan.localStorageConflicts];
  let writtenLocal = 0;
  let writtenIdb = 0;

  // preflight：确认目标账号与 IDB 环境可用
  const sameAccount = (manifest.accounts || []).some((account) => account?.username === username);
  if (!sameAccount) {
    throw new BackupError("account-mismatch", `这份备份属于 ${(manifest.accounts || []).map((a) => a?.username).join("、")}，不能恢复到当前账号 ${username}`);
  }

  // write localStorage
  for (const write of plan.localStorageWrites) {
    try {
      await writeLocal({ ...write, restoringUsername: username });
      writtenLocal += 1;
    } catch (error) {
      errors.push({ storage: "localStorage", key: write.key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // write IndexedDB（含附件还原）
  for (const write of plan.idbWrites) {
    try {
      const exists = await idb.listExists(write.db, write.store, write.key);
      const storeRule = IDB_INCLUDED[write.db]?.[write.store];
      if (exists) {
        if (storeRule?.mergeByFingerprint) {
          const existing = await idb.get?.(write.db, write.store, write.key);
          const incomingFingerprint = write.value?.fingerprint;
          if (!existing || !incomingFingerprint || existing.fingerprint !== incomingFingerprint) {
            errors.push({
              storage: "indexedDB",
              db: write.db,
              store: write.store,
              key: write.key,
              code: "conflict",
              message: "Existing fingerprinted ink snapshot differs; local data was preserved",
            });
          }
        }
        continue;
      }
      let value = write.value;
      if (value.file?.__backupAttachment) {
        const decoded = decodeAttachment(manifest, value);
        const file = createFile(decoded.fileMeta, decoded.bytes);
        value = { ...value, file };
      }
      await idb.put(write.db, write.store, write.key, value);
      writtenIdb += 1;
    } catch (error) {
      errors.push({ storage: "indexedDB", db: write.db, store: write.store, key: write.key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // verify：抽样回读
  const verified = { local: 0, idb: 0 };
  const sampleLocal = plan.localStorageWrites.slice(0, 5);
  for (const write of sampleLocal) {
    try {
      if (writeLocal.read && writeLocal.read(write.key) === write.value) verified.local += 1;
      else if (writeLocal.readAll?.().find((item) => item.key === write.key)?.value === write.value) verified.local += 1;
    } catch {
      // 抽样失败不视为恢复失败（已报告错误则说明写入有问题）
    }
  }
  if (plan.idbWrites.length && idb.sampleCount) {
    try {
      verified.idb = await idb.sampleCount(username);
    } catch {
      // 同上
    }
  }

  // journal（尽力而为，非数据）
  if (journal) {
    try {
      journal({ restoredAt: Date.now(), username, writtenLocal, writtenIdb, errors: errors.length });
    } catch {
      // journal 失败不影响恢复结果
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    writtenLocal,
    writtenIdb,
    skipped: plan.localStorageWrites.length + plan.idbWrites.length - writtenLocal - writtenIdb,
    errors,
    verified,
    transactionBoundary: "localStorage 与 IndexedDB 无法共享单一事务；恢复采用 preflight → write → verify → journal，中途失败会如实上报。",
  };
}

// ---------------- 浏览器适配器 ----------------

export function defaultBackupSources({ storage = globalThis.localStorage, indexedDb = globalThis.indexedDB } = {}) {
  const entries = [];
  if (storage) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = storage.getItem(key);
      if (key != null && value != null) entries.push({ key, value });
    }
  }
  return {
    entries: includeDurableEntries(entries, storage),
    databases: indexedDb ? () => readAllIndexedDb(indexedDb) : async () => [],
  };
}

async function readAllIndexedDb(indexedDb) {
  const databases = [];
  let names = [];
  try {
    names = await indexedDb.databases();
  } catch {
    names = [];
  }
  const candidates = [...new Set([...(names || []).map((db) => db.name), "wuliao-english", "KaoyanVocabDB", "KaoyanVocabMemorizeDB", HANDWRITING_DB])];
  for (const name of candidates) {
    if (!IDB_INCLUDED[name]) continue;
    const db = await (name === HANDWRITING_DB ? openHandwritingDatabase(indexedDb) : new Promise((resolve, reject) => {
      const request = indexedDb.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })).catch(() => null);
    if (!db) continue;
    try {
      const stores = [];
      for (const storeName of Object.keys(IDB_INCLUDED[name])) {
        const records = await new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => {};
        }).catch(() => []);
        stores.push({
          name: storeName,
          records: (records || []).map((value) => ({
            key: value?.id ?? value?.cacheKey ?? value?.memoryKey ?? value?.wordId ?? value?.sessionKey ?? value?.username,
            value,
          })),
        });
      }
      databases.push({ name, stores });
    } finally {
      db.close();
    }
  }
  return databases;
}

async function encodeBlobToBase64(blob, { onProgress = null } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const data = base64FromBytes(bytes);
  onProgress?.(100);
  return { data, size: bytes.length, sha256: await sha256Bytes(bytes) };
}

export function browserEncodeAttachment(blob, { onProgress } = {}) {
  return encodeBlobToBase64(blob, { onProgress });
}

export function browserCreateFile(meta, bytes) {
  return new File([bytes], meta.name || "backup.pdf", { type: meta.type || "application/pdf" });
}

export function defaultRestoreSources({ storage = globalThis.localStorage, indexedDb = globalThis.indexedDB } = {}) {
  const existingEntries = [];
  if (storage) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = storage.getItem(key);
      if (key != null && value != null) existingEntries.push({ key, value });
    }
  }
  const writeLocal = async (write) => {
    const username = write.restoringUsername;
    const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
    const logicalKey = write.key.startsWith(prefix) ? write.key.slice(prefix.length) : write.key;
    if (storage === globalThis.localStorage && inkStorageReady(username) && isDurableInkKey(logicalKey)) {
      writeDurableInk(username, logicalKey, write.value);
      await flushDurableInk(username);
      return;
    }
    if (write.storage === "localStorage-legacy") {
      storage.setItem(write.key, write.value);
      // legacy 原始 key 只对 owner 账号可读；本设备无 owner 时标记当前账号
      const owner = storage.getItem(LEGACY_OWNER_KEY);
      if (!owner && write.restoringUsername) storage.setItem(LEGACY_OWNER_KEY, write.restoringUsername);
      return;
    }
    storage.setItem(write.key, write.value);
  };
  writeLocal.readAll = () => {
    const items = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = storage.getItem(key);
      if (key != null && value != null) items.push({ key, value });
    }
    return includeDurableEntries(items, storage);
  };
  const openDb = (name) => {
    if (name === HANDWRITING_DB) return openHandwritingDatabase(indexedDb);
    if (name === "wuliao-english") return openWuliaoEnglishDatabase(indexedDb);
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  const readRecord = async (dbName, storeName, key) => {
    const db = await openDb(dbName);
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(key);
        let result = null;
        request.onsuccess = () => { result = request.result || null; };
        request.onerror = () => reject(request.error || transaction.error);
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB read failed"));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB read aborted"));
      });
    } finally {
      db.close();
    }
  };
  return {
    existingEntries: includeDurableEntries(existingEntries, storage),
    writeLocal,
    idb: {
      async listExists(dbName, storeName, key) {
        return (await readRecord(dbName, storeName, key)) != null;
      },
      async get(dbName, storeName, key) {
        return readRecord(dbName, storeName, key);
      },
      async put(dbName, storeName, key, value) {
        const db = await openDb(dbName);
        try {
          await new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, "readwrite");
            const request = transaction.objectStore(storeName).put(value);
            request.onsuccess = () => {};
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          db.close();
        }
      },
      async sampleCount(username) {
        const db = await openDb("wuliao-english");
        try {
          return await new Promise((resolve, reject) => {
            const transaction = db.transaction("unknown-words", "readonly");
            const request = transaction.objectStore("unknown-words").index("username").getAll(username);
            request.onsuccess = () => resolve((request.result || []).length);
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      },
    },
    createFile: browserCreateFile,
  };
}

export function recordBackupTelemetry(eventType, { status, counts, errors = 0, durationMs }) {
  try {
    getTelemetry().recordEvent({
      eventType,
      taskType: "backup",
      status,
      durationMs,
      metadata: { counts: counts || null, errors },
    });
  } catch {
    // telemetry 异常不影响备份本身
  }
}

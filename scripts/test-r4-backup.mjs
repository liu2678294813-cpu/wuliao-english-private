import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  createBackup,
  parseBackup,
  previewRestore,
  planRestoreWrites,
  restoreBackup,
  decodeAttachment,
  BackupError,
  BACKUP_JOURNAL_KEY,
  LEGACY_OWNER_KEY,
  CURRENT_USER_KEY,
} from "../src/backup.js";

const USER = "alice";
const PREFIX = `wuliao:user:${encodeURIComponent(USER)}:`;

test("手写筛选答案与会话纳入同账号备份及恢复，不混入其他账号", async () => {
  const value = { id: "answer-a", username: USER, wordId: "word_0001", text: "放弃", revision: 4, verdict: "correct" };
  const { manifest } = await createBackup({ username: USER, sources: {
    entries: [{ key: "wuliao:memory:rule:alice", value: "cycle" }],
    databases: [{ name: "WuliaoVocabHandwritingDB", stores: [
      { name: "answers", records: [{ key: value.id, value }, { key: "bob", value: { ...value, id: "bob", username: "bob" } }] },
      { name: "sessions", records: [{ key: "session-a", value: { id: "session-a", username: USER, page: 3 } }] },
    ] }],
  } });
  assert.equal(manifest.sections.indexedDB.WuliaoVocabHandwritingDB.answers.length, 1);
  const plan = planRestoreWrites(manifest, { username: USER });
  assert.equal(plan.idbWrites.filter((w) => w.db === "WuliaoVocabHandwritingDB").length, 2);
  assert.equal(plan.localStorageWrites.find((w) => w.key === "wuliao:memory:rule:alice").value, "cycle");
  assert.equal(planRestoreWrites(manifest, { username: "bob" }).idbWrites.length, 0);
});

function entriesFrom(record) {
  return Object.entries(record).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
}

function makeSources({ username = USER, extraEntries = [], extraDatabases = [] } = {}) {
  const localStorageRecord = {
    "wuliao:user:alice:wuliao:reading-flow:r1:p1": { stage: "deep-cover" },
    "wuliao:user:alice:wuliao:cloze-progress:c1:c1": { firstSubmitted: true },
    "wuliao:user:alice:wuliao:study-plan:2026-08-10": { budgetMinutes: 30 },
    "wuliao:user:alice:wuliao:ai:learning-records": [{ id: "lr-1" }],
    "wuliao:user:alice:wuliao:ai:history": [{ id: "h-1" }],
    "wuliao:user:alice:wuliao:deep-answers:r1:p1:first": { 21: "A" },
    "wuliao:user:alice:wuliao:translation-progress:r1:p1": { sentences: {} },
    "wuliao:user:alice:wuliao:review-task:review:next_day_article:r1:p1:2026-08-10": { taskKey: "t" },
    "wuliao:user:alice:wuliao:question-evidence:r1:p1": { store: {} },
    "wuliao:user:alice:wuliao:cloze-review-task:cloze-review:d1:c1:c1:2026-08-10": { taskKey: "ct" },
    "wuliao:user:alice:wuliao:cloze-translation:c1:c1": { sentences: {} },
    "wuliao:user:alice:wuliao:pref:pen-mode": "ballpoint",
    "wuliao:user:alice:wuliao:ai:model": "deepseek-chat",
    "wuliao:user:alice:wuliao:ai:button-pos": { x: 1 },
    "wuliao:user:alice:wuliao:ai:apikey": "sk-secret-key",
    "wuliao:user:alice:wuliao:writing:vision-api-key": "vision-secret-key",
    "wuliao:user:alice:wuliao:writing:vision-probe-cache:v1": { status: "supported" },
    "wuliao:user:alice:wuliao:ai:question-hint-cache": { cached: true },
    "wuliao:user:alice:wuliao:ai:cloze-task-cache": { cached: true },
    "wuliao:user:alice:wuliao:deep-ink:r1:p1": [[{ x: 1, y: 2 }]],
    "kaoyan_vocab_memorize_progress:alice": { done: 3 },
    "kaoyan_vocab_daily_review:alice:2026-08-10": { done: 1 },
    "wuliao:vocab:last-source-list:alice": "5",
    "wuliao:vocabulary:auto-pronounce": "true",
    "wuliao:vocabulary:shuffle-screening": "false",
    "wuliao:vocabulary:current-learning-list": "3",
    "wuliao:telemetry:v1": { events: [] },
    "wuliao:dev:mode:v1": "1",
    [LEGACY_OWNER_KEY]: "alice",
    "wuliao:progress:postgraduate-2007-text-1": { page: 3 }, // legacy 数据
    [CURRENT_USER_KEY]: "alice",
    ...extraEntries,
  };
  if (username !== USER) {
    for (const key of Object.keys(localStorageRecord)) {
      if (key.includes("alice")) delete localStorageRecord[key];
    }
  }
  const databases = [
    {
      name: "wuliao-english",
      stores: [
        {
          name: "custom-pdfs",
          records: [{
            key: "custom-1",
            value: {
              id: "custom-1",
              username,
              title: "test.pdf",
              fingerprint: "fp-1",
              file: {
                name: "test.pdf",
                type: "application/pdf",
                arrayBuffer: async () => new TextEncoder().encode("PDF-CONTENT").buffer,
              },
            },
          }],
        },
        {
          name: "unknown-words",
          records: [{ key: `u:${username}:r1:p1:w1`, value: { id: `u:${username}:r1:p1:w1`, username, word: "hello" } }],
        },
        {
          name: "pdf-parse-cache",
          records: [{ key: "fp-1:5", value: { cacheKey: "fp-1:5", analysis: {} } }],
        },
      ],
    },
    {
      name: "KaoyanVocabDB",
      stores: [
        {
          name: "wordLists",
          records: [{ key: 1, value: { id: 1, username, name: "list" } }],
        },
        {
          name: "users",
          records: [{ key: "alice", value: { username: "alice", passwordHash: "h", passwordSalt: "s" } }],
        },
      ],
    },
    {
      name: "KaoyanVocabMemorizeDB",
      stores: [
        {
          name: "records",
          records: [{ key: `k:${username}:1`, value: { memoryKey: `k:${username}:1`, username, wordId: "w1" } }],
        },
      ],
    },
    ...extraDatabases,
  ];
  return { entries: entriesFrom(localStorageRecord), databases };
}

async function fakeEncodeAttachment(blob, { onProgress } = {}) {
  const bytes = new Uint8Array(await awaitableBytes(blob));
  onProgress?.(50);
  onProgress?.(100);
  return {
    data: Buffer.from(bytes).toString("base64"),
    size: bytes.length,
    sha256: "fake-sha",
  };
}

function awaitableBytes(blob) {
  return typeof blob?.arrayBuffer === "function" ? blob.arrayBuffer() : new TextEncoder().encode(String(blob?.name || "blob"));
}

function makeFakeIdb({ failPut = false } = {}) {
  const existing = new Map();
  return {
    store: existing,
    async listExists(_db, _store, key) {
      return existing.has(key);
    },
    async get(_db, _store, key) {
      return existing.get(key) || null;
    },
    async put(_db, _store, key, value) {
      if (failPut && key === "custom-1") throw new Error("quota exceeded");
      existing.set(key, value);
    },
    async sampleCount() {
      return existing.size;
    },
  };
}

async function makeBackup(username = USER) {
  const sources = makeSources({ username });
  const result = await createBackup({
    sources,
    username,
    appVersion: "1.0.53",
    now: 1780000000000,
    encodeAttachment: fakeEncodeAttachment,
  });
  return result;
}

test("1/2. localStorage 与 IndexedDB 导出：用户数据进入备份", async () => {
  const { manifest } = await makeBackup();
  const local = manifest.sections.localStorage;
  const keys = [...local.user.map((item) => item.key), ...local.legacy.map((item) => item.key), ...local.userRaw.map((item) => item.key), ...local.device.map((item) => item.key)];
  assert.ok(keys.includes("wuliao:reading-flow:r1:p1"));
  assert.ok(keys.includes("wuliao:cloze-progress:c1:c1"));
  assert.ok(keys.includes("wuliao:study-plan:2026-08-10"));
  assert.ok(keys.includes("wuliao:ai:learning-records"));
  assert.ok(keys.includes("wuliao:deep-answers:r1:p1:first"));
  assert.ok(keys.includes("wuliao:review-task:review:next_day_article:r1:p1:2026-08-10"));
  assert.ok(keys.includes("wuliao:progress:postgraduate-2007-text-1"), "legacy owner 数据应进入");
  assert.ok(keys.includes("kaoyan_vocab_memorize_progress:alice"));
  assert.ok(keys.includes("wuliao:vocabulary:auto-pronounce"));
  assert.equal(manifest.sections.indexedDB["wuliao-english"]["custom-pdfs"].length, 1);
  assert.equal(manifest.sections.indexedDB["wuliao-english"]["unknown-words"].length, 1);
  assert.equal(manifest.sections.indexedDB.KaoyanVocabDB.wordLists.length, 1);
  assert.equal(manifest.sections.indexedDB.KaoyanVocabMemorizeDB.records.length, 1);
});

test("3/4. secret 与 derived cache 一律不导出", async () => {
  const { manifest } = await makeBackup();
  const all = JSON.stringify(manifest);
  assert.ok(!all.includes("sk-secret-key"), "API Key 不得进入备份");
  assert.ok(!all.includes("vision-secret-key"), "Vision API Key 不得进入备份");
  assert.ok(!all.includes("vision-probe-cache"), "Vision capability cache 不得进入备份");
  assert.ok(!all.includes("passwordHash"), "密码 verifier 不得进入备份");
  assert.ok(!all.includes("question-hint-cache"), "AI 缓存不得进入备份");
  assert.ok(!all.includes("cloze-task-cache"), "完形 AI 缓存不得进入备份");
  assert.ok(!all.includes("pdf-parse-cache"), "解析缓存 store 不得进入备份");
  assert.ok(!all.includes("wuliao:telemetry:v1"), "telemetry 不得进入备份");
  assert.ok(!all.includes("wuliao:dev:mode:v1"), "开发开关不得进入备份");
  assert.ok(!all.includes(CURRENT_USER_KEY), "当前账号指针不得进入备份");
});

test("5. manifest 校验：格式 / 版本 / 校验和", async () => {
  const { manifest, fileText } = await makeBackup();
  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.equal(manifest.version, BACKUP_VERSION);
  assert.equal(manifest.accounts[0].username, "alice");
  assert.ok(manifest.checksum.length >= 32);
  const parsed = await parseBackup(fileText);
  assert.deepEqual(parsed.accounts, manifest.accounts);
});

test("6. corrupt backup rejection：损坏与非法 JSON 一律拒绝", async () => {
  await assert.rejects(parseBackup("not json at all"), (error) => error instanceof BackupError && error.code === "corrupt-json");
  const { fileText } = await makeBackup();
  const corrupted = fileText.replace("alice", "aliceX");
  await assert.rejects(parseBackup(corrupted), (error) => error instanceof BackupError && error.code === "corrupt-backup");
  await assert.rejects(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION })), (error) => error.code === "corrupt-backup");
});

test("7. unknown version rejection", async () => {
  const { fileText } = await makeBackup();
  const future = JSON.parse(fileText);
  future.version = 2;
  await assert.rejects(parseBackup(JSON.stringify(future)), (error) => error instanceof BackupError && error.code === "unknown-version");
});

test("8. merge restore：保留现有，补入缺失；legacy owner 保护", async () => {
  const { manifest } = await makeBackup();
  const existing = new Map();
  existing.set(`${PREFIX}wuliao:reading-flow:r1:p1`, JSON.stringify({ stage: "deep-cover" }));
  existing.set(LEGACY_OWNER_KEY, "bob"); // 设备 owner 是 bob → alice 的 legacy 不写
  const writes = planRestoreWrites(manifest, { username: USER, existingEntries: [...existing.entries()].map(([key, value]) => ({ key, value })) });
  const keys = writes.localStorageWrites.map((write) => write.key);
  assert.ok(!keys.includes(`${PREFIX}wuliao:reading-flow:r1:p1`), "已存在的不覆盖");
  assert.ok(keys.includes(`${PREFIX}wuliao:cloze-progress:c1:c1`), "缺失的补入");
  assert.ok(!keys.some((key) => key === "wuliao:progress:postgraduate-2007-text-1"), "owner 不是 alice 时 legacy 不写");

  // owner 为空时 legacy 写回
  const writes2 = planRestoreWrites(manifest, { username: USER, existingEntries: [{ key: LEGACY_OWNER_KEY, value: "" }] });
  assert.ok(writes2.localStorageWrites.some((write) => write.key === "wuliao:progress:postgraduate-2007-text-1"));
});

test("9. duplicate restore 幂等：第二次不重复写入", async () => {
  const { manifest } = await makeBackup();
  const localStore = new Map();
  const idb = makeFakeIdb();
  const sources = {
    existingEntries: [],
    writeLocal: (write) => localStore.set(write.key, write.value),
    idb,
    createFile: (meta, bytes) => ({ meta, bytes }),
  };
  const first = await restoreBackup({ manifest, username: USER, ...sources });
  assert.equal(first.ok, true);
  const firstWritten = first.writtenLocal + first.writtenIdb;
  assert.ok(firstWritten > 0);

  const sources2 = {
    existingEntries: [...localStore.entries()].map(([key, value]) => ({ key, value })),
    writeLocal: (write) => localStore.set(write.key, write.value),
    idb, // 复用第一次恢复后的 IndexedDB 状态（幂等验证）
    createFile: (meta, bytes) => ({ meta, bytes }),
  };
  const second = await restoreBackup({ manifest, username: USER, ...sources2 });
  assert.equal(second.ok, true);
  assert.equal(second.writtenLocal, 0, "localStorage 不得重复写");
  assert.equal(second.writtenIdb, 0, "IndexedDB 不得重复写");
});

test("10. 账号隔离：A 的备份禁止恢复到 B", async () => {
  const { manifest } = await makeBackup();
  await assert.rejects(
    restoreBackup({ manifest, username: "bob", existingEntries: [], writeLocal: () => {}, idb: makeFakeIdb(), createFile: () => ({}) }),
    (error) => error instanceof BackupError && error.code === "account-mismatch",
  );
  const plan = planRestoreWrites(manifest, { username: "bob", existingEntries: [] });
  assert.ok(plan.localStorageWrites.every((write) => !write.key.startsWith(`${PREFIX}`)));
});

test("11. partial failure：如实报告错误而非假装成功", async () => {
  const { manifest } = await makeBackup();
  const failedKey = `${PREFIX}wuliao:cloze-progress:c1:c1`;
  const result = await restoreBackup({
    manifest,
    username: USER,
    existingEntries: [],
    writeLocal: (write) => {
      if (write.key === failedKey) throw new Error("quota exceeded");
    },
    idb: makeFakeIdb({ failPut: true }),
    createFile: (meta, bytes) => ({ meta, bytes }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.storage === "localStorage" && error.key === failedKey));
  assert.ok(result.errors.some((error) => error.storage === "indexedDB"));
  assert.equal(result.transactionBoundary.includes("preflight"), true);
});

test("12. custom PDF：附件导出与恢复还原", async () => {
  const { manifest } = await makeBackup();
  assert.equal(Object.keys(manifest.attachments).length, 1);
  const attachmentId = Object.keys(manifest.attachments)[0];
  assert.equal(manifest.attachments[attachmentId].name, "test.pdf");
  assert.equal(manifest.attachments[attachmentId].type, "application/pdf");

  const record = manifest.sections.indexedDB["wuliao-english"]["custom-pdfs"][0];
  assert.equal(record.value.file.__backupAttachment, attachmentId);
  const decoded = decodeAttachment(manifest, record.value);
  assert.equal(decoded.fileMeta.name, "test.pdf");
  assert.equal(new TextDecoder().decode(decoded.bytes), "PDF-CONTENT");
});

test("13/14/15/16/17. reading / cloze / planner / AI records / 词库数据覆盖", async () => {
  const { manifest } = await makeBackup();
  const userKeys = manifest.sections.localStorage.user.map((item) => item.key);
  assert.ok(userKeys.includes("wuliao:reading-flow:r1:p1"));
  assert.ok(userKeys.includes("wuliao:cloze-progress:c1:c1"));
  assert.ok(userKeys.includes("wuliao:cloze-review-task:cloze-review:d1:c1:c1:2026-08-10"));
  assert.ok(userKeys.includes("wuliao:study-plan:2026-08-10"));
  assert.ok(userKeys.includes("wuliao:ai:learning-records"));
  assert.ok(userKeys.includes("wuliao:deep-ink:r1:p1"), "笔迹数据应包含");
  assert.ok(manifest.sections.indexedDB.KaoyanVocabDB.wordLists.length === 1);
  assert.ok(!manifest.sections.indexedDB.KaoyanVocabDB.users, "users store 绝不导出");
  assert.ok(previewRestore(manifest, USER).sameAccount === true);
  assert.equal(previewRestore(manifest, USER).containsCustomPdfs, true);
});

test("X1.1 普通完形笔迹备份：导出 / 恢复 / 幂等 / 跨账号隔离（无需升级 Backup format）", async () => {
  const clozeInkStrokes = [{ tool: "pen", points: [{ x: 0.1, y: 0.2 }] }, { tool: "eraser", version: 2, points: [{ x: 0.3, y: 0.4 }] }];
  const { manifest, raw } = await createBackup({
    username: USER,
    sources: {
      entries: entriesFrom({
        [PREFIX + "wuliao:cloze-ink:v1:c1:c1"]: clozeInkStrokes,
      }),
      databases: [],
    },
  });
  // 导出：cloze-ink 作为 user-scoped 学习数据进入备份（prefix 枚举天然覆盖）
  const userKeys = manifest.sections.localStorage.user.map((item) => item.key);
  assert.ok(userKeys.includes("wuliao:cloze-ink:v1:c1:c1"), "cloze ink 必须进入备份");
  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.equal(manifest.version, 1, "不因 cloze-ink 升级 Backup format");

  // 恢复（空目标）：写入账号 scope
  const localStore = new Map();
  const restoreSources = (existing) => ({
    existingEntries: existing,
    writeLocal: (write) => localStore.set(write.key, write.value),
    idb: makeFakeIdb(),
    createFile: (meta, bytes) => ({ meta, bytes }),
  });
  const first = await restoreBackup({ manifest, username: USER, ...restoreSources([]) });
  assert.ok(first.writtenLocal >= 1, "cloze ink 应被恢复");
  assert.deepEqual(JSON.parse(localStore.get(PREFIX + "wuliao:cloze-ink:v1:c1:c1")), clozeInkStrokes);

  // 幂等：重复恢复不覆盖已有数据
  const second = await restoreBackup({
    manifest,
    username: USER,
    ...restoreSources([...localStore.entries()].map(([key, value]) => ({ key, value }))),
  });
  assert.equal(second.writtenLocal, 0, "重复恢复必须幂等（保留已有数据）");

  // 跨账号隔离：B 恢复不写入 A 的数据
  await assert.rejects(
    restoreBackup({ manifest, username: "bob", ...restoreSources([]) }),
    (error) => error instanceof BackupError && error.code === "account-mismatch",
  );
});

test("跨账号导入：用户原始 key（用户名拼接）只恢复到同名账号", async () => {
  const { manifest } = await makeBackup();
  const plan = planRestoreWrites(manifest, { username: USER, existingEntries: [] });
  assert.ok(plan.localStorageWrites.some((write) => write.key === "kaoyan_vocab_memorize_progress:alice"));
  assert.ok(plan.localStorageWrites.some((write) => write.key === "kaoyan_vocab_daily_review:alice:2026-08-10"));
});

test("备份元信息：appVersion / createdAt / schema 描述", async () => {
  const { manifest } = await makeBackup();
  assert.equal(manifest.appVersion, "1.0.53");
  assert.equal(manifest.createdAt, 1780000000000);
  assert.ok(manifest.schemaDescription.includes("excludes API keys"));
});

test("账号前缀精确隔离：alice 导出不得夹带 bob、ann、anna 或 Unicode 账号", async () => {
  const unicodeUser = "张 三";
  const { manifest } = await createBackup({
    username: "alice",
    sources: {
      entries: [
        { key: "wuliao:user:alice:wuliao:reading-flow:owned", value: "alice-value" },
        { key: "wuliao:user:bob:wuliao:reading-flow:other", value: "bob-value" },
        { key: "wuliao:user:ann:wuliao:reading-flow:other", value: "ann-value" },
        { key: "wuliao:user:anna:wuliao:reading-flow:other", value: "anna-value" },
        { key: `wuliao:user:${encodeURIComponent(unicodeUser)}:wuliao:reading-flow:other`, value: "unicode-value" },
        { key: "wuliao:user:alice:wuliao:ai:apikey", value: "secret" },
      ],
      databases: [],
    },
  });
  assert.deepEqual(manifest.sections.localStorage.user, [{ key: "wuliao:reading-flow:owned", value: "alice-value" }]);
  assert.equal(JSON.stringify(manifest).includes("bob-value"), false);
  assert.equal(JSON.stringify(manifest).includes("ann-value"), false);
  assert.equal(JSON.stringify(manifest).includes("anna-value"), false);
  assert.equal(JSON.stringify(manifest).includes("unicode-value"), false);
  assert.equal(JSON.stringify(manifest).includes("secret"), false);
});

test("exam ink 备份按 username 过滤；同 fingerprint 幂等，不同 fingerprint 保留本机并报告 conflict", async () => {
  const record = {
    id: "alice::session-1::reading%3Atext-1",
    username: "alice",
    sessionId: "session-1",
    surfaceId: "reading:text-1",
    revision: 2,
    sourceFingerprint: "source-1",
    fingerprint: "ink-fp-1",
    updatedAt: 1,
    strokes: [[{ x: 1, y: 2 }]],
  };
  const { manifest } = await createBackup({
    username: "alice",
    sources: {
      entries: [],
      databases: [{
        name: "wuliao-english",
        stores: [{
          name: "exam-ink",
          records: [
            { key: record.id, value: record },
            { key: "bob::session-1::reading%3Atext-1", value: { ...record, id: "bob::session-1::reading%3Atext-1", username: "bob" } },
          ],
        }],
      }],
    },
  });
  const records = manifest.sections.indexedDB["wuliao-english"]["exam-ink"];
  assert.deepEqual(records, [{ key: record.id, value: record }]);

  const matching = makeFakeIdb();
  matching.store.set(record.id, { ...record });
  const matchingResult = await restoreBackup({
    manifest,
    username: "alice",
    existingEntries: [],
    writeLocal: () => {},
    idb: matching,
    createFile: () => ({}),
  });
  assert.equal(matchingResult.errors.length, 0);
  assert.equal(matchingResult.writtenIdb, 0);

  const conflicting = makeFakeIdb();
  conflicting.store.set(record.id, { ...record, fingerprint: "ink-fp-local" });
  const conflictResult = await restoreBackup({
    manifest,
    username: "alice",
    existingEntries: [],
    writeLocal: () => {},
    idb: conflicting,
    createFile: () => ({}),
  });
  assert.equal(conflictResult.ok, false);
  assert.equal(conflictResult.errors[0]?.code, "conflict");
  assert.equal(conflicting.store.get(record.id).fingerprint, "ink-fp-local");
});

test("X1 current snapshots 的 localStorage restore 只接受同 fingerprint；冲突必须保留本机并上报", async () => {
  const logicalKeys = [
    "wuliao:exam-session:v1:x1-1",
    "wuliao:exam-session-recovery:v1:x1-1",
    "wuliao:exam-result:v1:x1-1",
    "wuliao:exam-handoff:v1:exam-result%3Av1%3Ax1-1:reading%3Atext-1",
  ];
  const entries = logicalKeys.map((logicalKey, index) => ({
    key: `${PREFIX}${logicalKey}`,
    value: JSON.stringify({ fingerprint: `x1-fingerprint-${index}`, payload: index }),
  }));
  const { manifest } = await createBackup({ username: USER, sources: { entries, databases: [] } });
  const localStore = new Map(entries.map((entry) => [entry.key, entry.value]));
  const same = await restoreBackup({
    manifest,
    username: USER,
    existingEntries: [...localStore.entries()].map(([key, value]) => ({ key, value })),
    writeLocal: (write) => localStore.set(write.key, write.value),
    idb: makeFakeIdb(),
    createFile: () => ({}),
  });
  assert.equal(same.ok, true);
  assert.equal(same.writtenLocal, 0);
  assert.equal(same.errors.length, 0);

  for (const [key, value] of localStore) {
    localStore.set(key, value.replace("x1-fingerprint-", "local-fingerprint-"));
  }
  const conflicting = await restoreBackup({
    manifest,
    username: USER,
    existingEntries: [...localStore.entries()].map(([key, value]) => ({ key, value })),
    writeLocal: (write) => localStore.set(write.key, write.value),
    idb: makeFakeIdb(),
    createFile: () => ({}),
  });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.errors.length, logicalKeys.length);
  assert.ok(conflicting.errors.every((error) => error.storage === "localStorage" && error.code === "conflict"));
  assert.equal(JSON.parse(localStore.get(`${PREFIX}wuliao:exam-result:v1:x1-1`)).fingerprint, "local-fingerprint-2");
});

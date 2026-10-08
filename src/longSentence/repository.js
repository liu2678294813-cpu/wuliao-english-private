import { openWuliaoEnglishDatabase, isLongSentenceStorageAvailable } from "../storage.js";
import { getCurrentUsername } from "../userData.js";
import { localDateKey } from "../readingReview.js";
import { sentenceTextFingerprint } from "../translationProgress.js";
import { LONG_SENTENCE_STORES as S, listRecords } from "./data.js";
import { nextSkillSchedule, skillIdFor } from "./schedule.js";

const own = (record, username) => record && record.username === username;
const makeId = (username, type) => `${encodeURIComponent(username)}::long-sentence::${type}::${globalThis.crypto.randomUUID()}`;
const assertOwner = (username) => {
  if (!username || username !== getCurrentUsername()) throw new Error("账号已切换，请重新打开长难句训练");
};

function currentAccount() {
  const username = getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  return username;
}

function transact(names, mode, work, expectedUsername = null) {
  const username = currentAccount();
  if (expectedUsername && username !== expectedUsername) throw new Error("账号已切换，请重新打开长难句训练");
  return openWuliaoEnglishDatabase().then((db) => new Promise((resolve, reject) => {
    if (!isLongSentenceStorageAvailable()) { db.close(); reject(new Error("长难句存储升级失败，当前只允许使用旧功能")); return; }
    let tx;
    let result;
    let forcedError;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(error);
      else resolve(result);
    };
    try {
      assertOwner(username);
      tx = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
      const fail = (error) => { forcedError = error; tx.abort(); };
      const setResult = (value) => { result = value; };
      work({ stores, username, fail, setResult });
      tx.oncomplete = () => settle(null);
      tx.onerror = () => settle(forcedError || tx.error || new Error("长难句保存失败"));
      tx.onabort = () => settle(forcedError || tx.error || new Error("长难句保存已取消"));
    } catch (error) {
      if (tx) { forcedError = error; tx.abort(); }
      else settle(error);
    }
  }));
}

function readOwned(store, id, username, fail, next) {
  const request = store.get(id);
  request.onsuccess = () => {
    if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
    if (!own(request.result, username)) { fail(new Error("长难句记录不存在或账号不符")); return; }
    next(request.result);
  };
}

function readonlyGet(store, id, username, fail, next) {
  const request = store.get(id);
  request.onsuccess = () => {
    if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
    if (request.result && !own(request.result, username)) { fail(new Error("长难句记录账号不符")); return; }
    next(request.result || null);
  };
}

function sourceSnapshot(source) {
  if (source?.status && source.status !== "resolved") throw new Error("来源原文不可用，不能生成训练");
  if (!source?.sourceReviewId || !source?.text || !source?.sentenceKey) throw new Error("来源缺少原句快照");
  return {
    sourceReviewId: source.sourceReviewId, resourceId: source.resourceId,
    passageId: source.passageId, sentenceKey: source.sentenceKey,
    text: source.text, textFingerprint: source.textFingerprint,
    year: source.year || null, chapter: source.chapter || "", articleLabel: source.articleLabel || "",
    resourceTitle: source.resourceTitle || "",
  };
}

function wordSnapshot(word) {
  return { wordId: word.wordId || word.normalizedWord, word: word.word,
    normalizedWord: word.normalizedWord || word.wordId, meaning: word.meaning || "", refs: word.refs || [] };
}

export async function createSession({ sources, words = [], count = 5, originContext = null, skillId = null,
  extraPractice = false, now = Date.now() } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("每次只能生成 1–5 句");
  if (!Array.isArray(sources) || !sources.length) throw new Error("请先选择困难原句");
  const username = currentAccount();
  const id = makeId(username, "session");
  const session = { id, sessionId: id, username, sources: sources.map(sourceSnapshot),
    words: words.map(wordSnapshot), count, originContext, skillId, extraPractice: Boolean(extraPractice),
    itemIds: [], savedBatchKeys: [], currentItemIndex: 0, requestVersion: 0, status: "draft", createdAt: now, updatedAt: now };
  await transact([S.sessions], "readwrite", ({ stores, setResult }) => {
    stores[S.sessions].add(session);
    setResult(session);
  }, username);
  return session;
}

const sessionPatchKeys = new Set(["currentItemIndex", "requestVersion", "status", "selectedSourceIds", "selectedWordIds", "lastError", "originContext"]);
export async function updateSession({ sessionId, patch = {}, expectedRequestVersion, now = Date.now() } = {}) {
  if (!sessionId || !patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length
    || Object.keys(patch).some((key) => !sessionPatchKeys.has(key))
    || (patch.currentItemIndex != null && (!Number.isInteger(patch.currentItemIndex) || patch.currentItemIndex < 0))
    || (patch.requestVersion != null && (!Number.isInteger(patch.requestVersion) || patch.requestVersion < 1
      || !Number.isInteger(expectedRequestVersion)))
    || (patch.status != null && !["draft", "generating", "partial", "ready", "error"].includes(patch.status))
    || [patch.selectedSourceIds, patch.selectedWordIds].some((ids) => ids != null
      && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")))
    || (patch.lastError != null && typeof patch.lastError !== "string")
    || (patch.originContext != null && (typeof patch.originContext !== "object" || Array.isArray(patch.originContext)))) {
    throw new Error("会话修改字段无效");
  }
  return transact([S.sessions], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.sessions], sessionId, username, fail, (session) => {
      if (expectedRequestVersion != null && session.requestVersion !== expectedRequestVersion) {
        fail(new Error("生成请求已过期")); return;
      }
      if (patch.requestVersion != null && patch.requestVersion !== session.requestVersion + 1) {
        fail(new Error("生成请求版本必须逐次递增")); return;
      }
      if (patch.currentItemIndex != null && patch.currentItemIndex >= Math.max(1, session.itemIds?.length || 0)) {
        fail(new Error("题号超出本次训练范围")); return;
      }
      const next = { ...session, ...patch, updatedAt: now };
      stores[S.sessions].put(next);
      setResult(next);
    });
  });
}

function safeGeneratedItem(item) {
  if (!item || typeof item !== "object" || !String(item.text || item.sentence || "").trim()) {
    throw new Error("生成句为空");
  }
  if (["referenceTranslation", "canonicalStructure", "translationEvaluation", "answer"].some((key) => key in item)) {
    throw new Error("生成结果包含提交前答案");
  }
  const { id: _id, itemId: _itemId, attemptId: _attemptId, username: _username, sessionId: _sessionId,
    ...safe } = item;
  return { ...safe, text: String(item.text || item.sentence).trim() };
}

export async function saveGeneratedItems({ sessionId, requestVersion, items, replaceItemId = null,
  batchIndex = 0, now = Date.now() } = {}) {
  if (!sessionId || !Number.isInteger(requestVersion) || !Array.isArray(items) || !items.length || items.length > 5) {
    throw new Error("生成保存参数无效");
  }
  if (batchIndex !== 0 && batchIndex !== 1) throw new Error("一次生成最多保存两批");
  if (replaceItemId && items.length !== 1) throw new Error("换一句只能替换当前一题");
  if (replaceItemId && batchIndex !== 0) throw new Error("换一句不能使用补齐批次");
  const safeItems = items.map(safeGeneratedItem);
  return transact([S.sessions, S.items, S.attempts], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.sessions], sessionId, username, fail, (session) => {
      if (session.requestVersion !== requestVersion) { fail(new Error("生成请求已过期")); return; }
      const batchKey = `${requestVersion}:${batchIndex}`;
      const savedBatchKeys = Array.isArray(session.savedBatchKeys) ? session.savedBatchKeys : [];
      if (savedBatchKeys.includes(batchKey)
        || (batchIndex === 0 && session.lastSavedRequestVersion === requestVersion && !savedBatchKeys.length)) {
        fail(new Error("这批生成已保存，请先发起新请求")); return;
      }
      if (batchIndex === 1 && !savedBatchKeys.includes(`${requestVersion}:0`)) {
        fail(new Error("补齐批次缺少已保存的首批句子")); return;
      }
      const activeIds = Array.isArray(session.itemIds) ? [...session.itemIds] : [];
      const replaceIndex = replaceItemId ? activeIds.indexOf(replaceItemId) : -1;
      if (replaceItemId && replaceIndex < 0) { fail(new Error("要替换的题目已变化")); return; }
      if (replaceIndex < 0 && activeIds.length + safeItems.length > session.count) {
        fail(new Error("生成句数量超过本次训练上限")); return;
      }
      const createdItems = [];
      const attempts = [];
      for (const data of safeItems) {
        if (!data.skillId && !session.skillId && !data.structureFingerprint) {
          fail(new Error("生成句缺少核心结构身份")); return;
        }
        const itemId = makeId(username, "item");
        const attemptId = makeId(username, "attempt");
        let itemSkillId;
        try {
          itemSkillId = data.skillId || session.skillId || skillIdFor({
            sources: session.sources, structureFingerprint: data.structureFingerprint,
          });
        } catch (error) { fail(error); return; }
        const item = { ...data, id: itemId, itemId, username, sessionId,
          attemptId, skillId: itemSkillId, createdAt: now, updatedAt: now };
        const attempt = { id: attemptId, attemptId, username, sessionId, itemId, version: 0,
          userTranslation: "", submittedAt: null, submissionVersion: 0, userRating: null,
          latestEvaluationId: null, layout: null, createdAt: now, updatedAt: now };
        stores[S.items].add(item);
        stores[S.attempts].add(attempt);
        createdItems.push(item);
        attempts.push(attempt);
      }
      if (replaceIndex >= 0) activeIds.splice(replaceIndex, 1, createdItems[0].id);
      else activeIds.push(...createdItems.map((item) => item.id));
      const next = { ...session, itemIds: activeIds, savedBatchKeys: [...savedBatchKeys, batchKey],
        lastSavedRequestVersion: requestVersion,
        currentItemIndex: Math.min(Math.max(0, session.currentItemIndex || 0), Math.max(0, activeIds.length - 1)),
        status: activeIds.length >= session.count ? "ready" : "partial", updatedAt: now };
      stores[S.sessions].put(next);
      setResult({ session: next, items: createdItems, attempts });
    });
  });
}

export async function createAttempt({ sessionId, itemId, now = Date.now() } = {}) {
  return transact([S.items, S.attempts], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.items], itemId, username, fail, (item) => {
      if (item.sessionId !== sessionId) { fail(new Error("题目不属于当前会话")); return; }
      const id = makeId(username, "attempt");
      const attempt = { id, attemptId: id, username, sessionId, itemId, version: 0,
        userTranslation: "", submittedAt: null, submissionVersion: 0, userRating: null,
        latestEvaluationId: null, layout: null, createdAt: now, updatedAt: now };
      stores[S.attempts].add(attempt);
      const nextItem = { ...item, attemptId: id, updatedAt: now };
      stores[S.items].put(nextItem);
      setResult({ item: nextItem, attempt });
    });
  });
}

const attemptPatchKeys = new Set(["userTranslation", "submittedAt", "submissionVersion", "layout", "inkId"]);
export async function saveAttempt({ sessionId, itemId, attemptId, patch = {}, expectedVersion, now = Date.now() } = {}) {
  if (!sessionId || !itemId || !attemptId || !Number.isInteger(expectedVersion) || expectedVersion < 0
    || !patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length
    || Object.keys(patch).some((key) => !attemptPatchKeys.has(key))
    || (patch.userTranslation != null && typeof patch.userTranslation !== "string")
    || (patch.submittedAt != null && (!Number.isFinite(patch.submittedAt) || patch.submittedAt <= 0))
    || (patch.submissionVersion != null && (!Number.isInteger(patch.submissionVersion) || patch.submissionVersion < 1))
    || (patch.submittedAt != null && patch.submissionVersion == null)
    || (patch.submissionVersion != null && patch.submittedAt == null)
    || (patch.inkId != null && typeof patch.inkId !== "string")
    || (patch.layout != null && (typeof patch.layout !== "object" || Array.isArray(patch.layout)
      || !Number.isFinite(patch.layout.width) || patch.layout.width <= 0
      || !Number.isFinite(patch.layout.height) || patch.layout.height <= 0
      || !Number.isInteger(patch.layout.version) || patch.layout.version < 1))) {
    throw new Error("作答修改字段无效");
  }
  return transact([S.attempts], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.attempts], attemptId, username, fail, (attempt) => {
      if (attempt.sessionId !== sessionId || attempt.itemId !== itemId) { fail(new Error("作答不属于当前题目")); return; }
      if (expectedVersion !== attempt.version) { fail(new Error("作答版本已变化，请重新载入")); return; }
      if (attempt.userRating) { fail(new Error("已完成自评，请新建作答")); return; }
      if (attempt.submittedAt && (patch.userTranslation != null || patch.submittedAt != null || patch.submissionVersion != null)) {
        fail(new Error("已提交的译文不能修改，请新建作答")); return;
      }
      if (patch.submissionVersion != null && patch.submissionVersion < attempt.submissionVersion) {
        fail(new Error("提交版本不能回退")); return;
      }
      if (patch.submissionVersion != null && patch.submissionVersion !== attempt.version + 1) {
        fail(new Error("提交对应的作答版本已过期")); return;
      }
      const next = { ...attempt, ...patch, version: attempt.version + 1, updatedAt: now };
      if (next.submittedAt && !String(next.userTranslation || "").trim()) {
        fail(new Error("请先填写译文")); return;
      }
      stores[S.attempts].put(next);
      setResult(next);
    });
  });
}

export async function appendEvaluation({ sessionId, itemId, attemptId, evaluationVersion,
  submissionVersion, evaluation, rawOutput = "", requestSource = null, now = Date.now() } = {}) {
  if (!sessionId || !itemId || !attemptId || !Number.isInteger(evaluationVersion) || evaluationVersion < 1
    || !Number.isInteger(submissionVersion) || submissionVersion < 1
    || !evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    throw new Error("解析版本或内容无效");
  }
  return transact([S.attempts, S.evaluations], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.attempts], attemptId, username, fail, (attempt) => {
      if (attempt.sessionId !== sessionId || attempt.itemId !== itemId || !attempt.submittedAt
        || attempt.submissionVersion !== submissionVersion) {
        fail(new Error("解析对应的译文提交已过期")); return;
      }
      const id = `${attemptId}::evaluation::${evaluationVersion}`;
      readonlyGet(stores[S.evaluations], id, username, fail, (existing) => {
        const currentVersion = Number(/::evaluation::(\d+)$/.exec(attempt.latestEvaluationId || "")?.[1] || 0);
        if (existing) {
          if (existing.submissionVersion !== submissionVersion) { fail(new Error("旧解析与当前提交不匹配")); return; }
          if (JSON.stringify(existing.evaluation) !== JSON.stringify(evaluation)) {
            fail(new Error("解析版本冲突，已保留首次保存的结果")); return;
          }
          setResult({ evaluation: existing, attempt, alreadySaved: true }); return;
        }
        if (evaluationVersion !== currentVersion + 1) { fail(new Error("解析请求版本已过期")); return; }
        const record = { id, username, sessionId, itemId, attemptId, evaluationVersion,
          submissionVersion, evaluation, rawOutput, requestSource, analysisFeedback: null,
          createdAt: now };
        stores[S.evaluations].add(record);
        const nextAttempt = { ...attempt, latestEvaluationId: id, updatedAt: now };
        stores[S.attempts].put(nextAttempt);
        setResult({ evaluation: record, attempt: nextAttempt, alreadySaved: false });
      });
    });
  });
}

export async function setEvaluationFeedback({ evaluationId, feedback, now = Date.now() } = {}) {
  if (!evaluationId || feedback !== "incorrect") throw new Error("解析反馈无效");
  return transact([S.evaluations], "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.evaluations], evaluationId, username, fail, (evaluation) => {
      if (evaluation.analysisFeedback === feedback) { setResult(evaluation); return; }
      const next = { ...evaluation, analysisFeedback: feedback, feedbackAt: now };
      stores[S.evaluations].put(next);
      setResult(next);
    });
  });
}

export async function rateAttempt({ sessionId, attemptId, userRating, now = Date.now() } = {}) {
  if (userRating !== "mastered" && userRating !== "difficult") throw new Error("自评结果无效");
  return transact([S.sessions, S.items, S.attempts, S.evaluations, S.skills, S.schedules],
    "readwrite", ({ stores, username, fail, setResult }) => {
      readOwned(stores[S.sessions], sessionId, username, fail, (session) => {
        readOwned(stores[S.attempts], attemptId, username, fail, (attempt) => {
          if (attempt.sessionId !== sessionId || !attempt.submittedAt) { fail(new Error("请先提交当前译文")); return; }
          if (attempt.userRating) {
            if (attempt.userRating !== userRating) { fail(new Error("这次作答已完成自评")); return; }
            if (!attempt.skillId) { fail(new Error("已评分作答缺少技能身份")); return; }
            const eventId = `${attempt.skillId}::${attempt.id}`;
            readOwned(stores[S.schedules], eventId, username, fail, (event) => {
              readonlyGet(stores[S.skills], attempt.skillId, username, fail, (skill) => {
                if (!skill && event.changed !== false) { fail(new Error("已评分作答缺少技能记录")); return; }
                const resolvedSkill = skill || { id: attempt.skillId, username, ...event.after };
                setResult({ attempt, skill: resolvedSkill, event, alreadyRated: true });
              });
            });
            return;
          }
          readOwned(stores[S.items], attempt.itemId, username, fail, (item) => {
            let plainSkillId;
            try {
              plainSkillId = item.skillId || session.skillId || skillIdFor({
                sources: session.sources, structureFingerprint: item.structureFingerprint,
              });
            } catch (error) { fail(error); return; }
            const accountPrefix = `${encodeURIComponent(username)}::`;
            const skillId = plainSkillId.startsWith(accountPrefix) ? plainSkillId : `${accountPrefix}${plainSkillId}`;
            const evaluationId = attempt.latestEvaluationId;
            const evaluate = (evaluation) => {
              readonlyGet(stores[S.skills], skillId, username, fail, (existingSkill) => {
                const skill = existingSkill || { id: skillId, username, sourceReviewIds: session.sources.map((s) => s.sourceReviewId),
                  sources: session.sources, words: session.words,
                  structureFingerprint: item.structureFingerprint || "", attemptCount: 0, masteredStage: 0,
                  lapseCount: 0, nextDueAt: null, sentenceHistory: [], sentenceHistoryFingerprints: [], createdAt: now };
                const transition = nextSkillSchedule({ skill, attemptId, userRating,
                  aiTranslationAssessment: evaluation?.evaluation || null,
                  analysisFeedback: evaluation?.analysisFeedback || null,
                  extraPractice: session.extraPractice, now });
                const event = { ...transition.event, username, sessionId, itemId: item.id,
                  evaluationId: evaluation?.id || null };
                readonlyGet(stores[S.schedules], event.id, username, fail, (existingEvent) => {
                  if (existingEvent) { fail(new Error("调度事件已存在，作答状态不一致")); return; }
                  const rated = { ...attempt, userRating, ratedAt: now, skillId, updatedAt: now };
                  stores[S.attempts].put(rated);
                  const nextSkill = { ...transition.skill, username,
                    sentenceHistory: [...new Set([...(skill.sentenceHistory || []), item.text])],
                    sentenceHistoryFingerprints: [...new Set([...(skill.sentenceHistoryFingerprints || []), sentenceTextFingerprint(item.text)])] };
                  if (!session.extraPractice) stores[S.skills].put(nextSkill);
                  stores[S.schedules].add(event);
                  setResult({ attempt: rated, skill: session.extraPractice ? skill : nextSkill, event, alreadyRated: false });
                });
              });
            };
            if (evaluationId) readOwned(stores[S.evaluations], evaluationId, username, fail, evaluate);
            else evaluate(null);
          });
        });
      });
    });
}

export async function loadSession(sessionId) {
  return transact([S.sessions, S.items, S.attempts, S.evaluations], "readonly", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.sessions], sessionId, username, fail, (session) => {
      const names = [S.items, S.attempts, S.evaluations];
      const result = { session, items: [], attempts: [], evaluations: [] };
      let remaining = names.length;
      for (const name of names) {
        const request = stores[name].index("usernameSession").getAll([username, sessionId]);
        request.onsuccess = () => {
          result[name === S.items ? "items" : name === S.attempts ? "attempts" : "evaluations"] = request.result;
          remaining -= 1;
          if (remaining === 0) {
            const ids = Array.isArray(session.itemIds) ? session.itemIds : [];
            const byId = new Map(result.items.map((item) => [item.id, item]));
            result.allItems = result.items;
            result.items = ids.map((id) => byId.get(id)).filter(Boolean);
            result.historyItems = result.allItems.filter((item) => !ids.includes(item.id));
            result.evaluations.sort((a, b) => a.createdAt - b.createdAt || a.evaluationVersion - b.evaluationVersion);
            setResult(result);
          }
        };
      }
    });
  });
}

export function listSessions({ offset = 0, limit = 50 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("分页参数无效");
  }
  return transact([S.sessions], "readonly", ({ stores, username, fail, setResult }) => {
    const range = IDBKeyRange.bound([username, 0], [username, Number.MAX_SAFE_INTEGER]);
    const request = stores[S.sessions].index("usernameCreated").openCursor(range, "prev");
    const records = [];
    let skipped = 0;
    request.onsuccess = () => {
      if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
      const cursor = request.result;
      if (!cursor || records.length >= limit) { setResult(records); return; }
      if (skipped < offset) skipped += 1;
      else records.push(cursor.value);
      cursor.continue();
    };
  });
}

export function listSkills({ offset = 0, limit = 50 } = {}) {
  return listRecords(S.skills, { offset, limit });
}

export function getSkill(skillId) {
  const username = currentAccount();
  if (typeof skillId !== "string" || !skillId) return Promise.resolve(null);
  const prefix = `${encodeURIComponent(username)}::`;
  const ownedId = skillId.startsWith(prefix) ? skillId : `${prefix}${skillId}`;
  return transact([S.skills], "readonly", ({ stores, fail, setResult }) => {
    readonlyGet(stores[S.skills], ownedId, username, fail, setResult);
  }, username);
}

function dueSkillRange(username, today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)
    || localDateKey(new Date(`${today}T12:00:00`)) !== today) {
    throw new Error("到期日期无效");
  }
  return IDBKeyRange.bound([username, ""], [username, today]);
}

export function listDueSkills({ offset = 0, limit = 50, today = localDateKey() } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("分页参数无效");
  }
  const username = currentAccount();
  const range = dueSkillRange(username, today);
  return transact([S.skills], "readonly", ({ stores, fail, setResult }) => {
    const request = stores[S.skills].index("usernameDue").openCursor(range);
    const records = [];
    let skipped = 0;
    request.onsuccess = () => {
      if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
      const cursor = request.result;
      if (!cursor || records.length >= limit) { setResult(records); return; }
      if (cursor.value?.username !== username) { fail(new Error("长难句记录账号不符")); return; }
      if (skipped < offset) skipped += 1;
      else records.push(cursor.value);
      cursor.continue();
    };
  }, username);
}

export function countDueSkills({ today = localDateKey() } = {}) {
  const username = currentAccount();
  const range = dueSkillRange(username, today);
  return transact([S.skills], "readonly", ({ stores, fail, setResult }) => {
    const request = stores[S.skills].index("usernameDue").count(range);
    request.onsuccess = () => {
      if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
      setResult(request.result);
    };
  }, username);
}

export async function listSkillItems(skillId, { offset = 0, limit = 500 } = {}) {
  const username = currentAccount();
  const rawId = skillId.startsWith(`${encodeURIComponent(username)}::`) ? skillId.slice(`${encodeURIComponent(username)}::`.length) : skillId;
  const matches = [];
  for (let page = 0; ; page += 1) {
    const items = await listRecords(S.items, { offset: page * 500, limit: 500 });
    matches.push(...items.filter((item) => item.skillId === rawId || item.skillId === skillId));
    if (items.length < 500) break;
  }
  return matches.slice(offset, offset + limit);
}

export async function deleteSession(sessionId) {
  const names = [S.sessions, S.items, S.attempts, S.evaluations, S.ink, S.skills];
  return transact(names, "readwrite", ({ stores, username, fail, setResult }) => {
    readOwned(stores[S.sessions], sessionId, username, fail, () => {
      let pending = 4;
      let removed = 0;
      let deletedItems = [];
      for (const name of [S.items, S.attempts, S.evaluations, S.ink]) {
        const request = stores[name].index("usernameSession").getAll([username, sessionId]);
        request.onsuccess = () => {
          if (getCurrentUsername() !== username) { fail(new Error("账号已切换，请重新打开长难句训练")); return; }
          if (name === S.items) deletedItems = request.result;
          for (const record of request.result) {
            stores[name].delete(record.id);
            removed += 1;
          }
          pending -= 1;
          if (pending === 0) {
            // Skills and schedule remain; remove deleted sentence text from skill metadata.
            const textBySkill = new Map();
            for (const item of deletedItems) {
              if (!item.skillId || !item.text) continue;
              const prefix = `${encodeURIComponent(username)}::`;
              const skillId = item.skillId.startsWith(prefix) ? item.skillId : `${prefix}${item.skillId}`;
              if (!textBySkill.has(skillId)) textBySkill.set(skillId, new Set());
              textBySkill.get(skillId).add(item.text);
            }
            for (const [skillId, texts] of textBySkill) {
              readonlyGet(stores[S.skills], skillId, username, fail, (skill) => {
                if (!skill) return;
                stores[S.skills].put({ ...skill, sentenceHistory: (skill.sentenceHistory || [])
                  .filter((text) => !texts.has(text)) });
              });
            }
            stores[S.sessions].delete(sessionId);
            setResult({ deleted: true, removed });
          }
        };
      }
    });
  });
}

import { computeFileFingerprint } from "../fingerprint";
import { getUserItem, listUserItems, scopedUserKey, setUserItem } from "../userData";

export const EXAM_SCHEMA_VERSION = 1;
export const EXAM_DURATION_MS = 100 * 60 * 1000;
export const MAX_HANDOFF_TARGETS = 5;

export const ExamStatus = Object.freeze({
  IN_PROGRESS: "in_progress",
  SUBMITTED: "submitted",
  TIMED_OUT: "timed_out",
  ABANDONED: "abandoned",
});

export const HandoffStatus = Object.freeze({
  SELECTED: "selected",
  STARTED: "started",
  COMPLETED: "completed",
  DISMISSED: "dismissed",
});

const TERMINAL_STATUSES = new Set([ExamStatus.SUBMITTED, ExamStatus.TIMED_OUT, ExamStatus.ABANDONED]);
const HANDOFF_TRANSITIONS = new Map([
  [HandoffStatus.SELECTED, new Set([HandoffStatus.STARTED, HandoffStatus.DISMISSED])],
  [HandoffStatus.STARTED, new Set([HandoffStatus.COMPLETED, HandoffStatus.DISMISSED])],
  [HandoffStatus.DISMISSED, new Set([HandoffStatus.SELECTED])],
  [HandoffStatus.COMPLETED, new Set()],
]);

export class ExamConflictError extends Error {
  constructor(message = "Exam data changed in another runtime") {
    super(message);
    this.name = "ExamConflictError";
  }
}

export class ExamDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExamDataError";
  }
}

export class ExamTimeoutError extends ExamDataError {
  constructor() { super("Exam time has elapsed; answers are locked"); this.name = "ExamTimeoutError"; }
}

function assert(condition, message) {
  if (!condition) throw new ExamDataError(message);
}

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export async function examFingerprint(value) {
  return computeFileFingerprint(new TextEncoder().encode(canonicalJson(value)));
}

async function fingerprinted(value) {
  const withoutFingerprint = { ...value };
  delete withoutFingerprint.fingerprint;
  return { ...withoutFingerprint, fingerprint: await examFingerprint(withoutFingerprint) };
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function examSessionKey(sessionId) {
  return `wuliao:exam-session:v1:${sessionId}`;
}

export function examRecoveryKey(sessionId) {
  return `wuliao:exam-session-recovery:v1:${sessionId}`;
}

export function examResultKey(sessionId) {
  return `wuliao:exam-result:v1:${sessionId}`;
}

export function examHandoffKey(examResultId, targetId) {
  return `wuliao:exam-handoff:v1:${examResultId}:${targetId}`;
}

export function clozeItemId(resourceId, blankNumber) {
  return `cloze:${resourceId}:blank:${Number(blankNumber)}`;
}

export function readingItemId(resourceId, questionNumber) {
  return `reading:${resourceId}:q${Number(questionNumber)}`;
}

export function readingTargetId(resourceId) {
  return `reading:${resourceId}`;
}

export function clozeTargetId(resourceId) {
  return `cloze:${resourceId}`;
}

export function normalizeExamItems(items) {
  assert(Array.isArray(items) && items.length === 40, "X1 must contain exactly 40 items");
  const ids = new Set();
  return items.map((item, index) => {
    assert(item?.id && !ids.has(item.id), `Duplicate or missing exam item at ${index}`);
    assert(item.officialAnswer != null, `Missing official answer for ${item.id}`);
    ids.add(item.id);
    return {
      ...item,
      order: index + 1,
      officialAnswer: String(item.officialAnswer),
      section: item.section === "cloze" ? "cloze" : "reading",
    };
  });
}

export async function createExamSession({ username, year, items, sourceFingerprint, now = Date.now(), sessionId = `x1-${randomId()}` }) {
  assert(username, "A username is required");
  const normalizedItems = normalizeExamItems(items);
  const session = {
    schemaVersion: EXAM_SCHEMA_VERSION,
    sessionId,
    username,
    paperId: `postgraduate-${year}-english1-x1`,
    year: Number(year),
    status: ExamStatus.IN_PROGRESS,
    revision: 0,
    startedAt: now,
    updatedAt: now,
    durationMs: EXAM_DURATION_MS,
    elapsedMs: 0,
    sourceFingerprint: sourceFingerprint || await examFingerprint(normalizedItems.map(({ id, officialAnswer }) => ({ id, officialAnswer }))),
    items: normalizedItems,
    answers: {},
    currentItemId: normalizedItems[0].id,
    navigation: { section: "cloze", itemOrder: normalizedItems.map((item) => item.id) },
    resultRef: null,
    inkRefs: {},
    terminal: null,
  };
  return fingerprinted(session);
}

export function elapsedForSession(session, { now = Date.now(), monotonicElapsedMs = 0 } = {}) {
  const wallElapsed = Math.max(0, Number(now) - Number(session.startedAt ?? now));
  return Math.min(session.durationMs || EXAM_DURATION_MS, Math.max(Number(session.elapsedMs || 0), wallElapsed, Number(monotonicElapsedMs || 0)));
}

export function shouldTimeOut(session, clock) {
  return session.status === ExamStatus.IN_PROGRESS && elapsedForSession(session, clock) >= (session.durationMs || EXAM_DURATION_MS);
}

export function reconcileSessionOnLoad(session, clock) {
  const elapsedMs = elapsedForSession(session, clock);
  return {
    session: { ...session, elapsedMs },
    action: shouldTimeOut(session, { ...clock, monotonicElapsedMs: elapsedMs }) ? "timed_out" : "resume",
  };
}

export async function updateSession(session, changes, { now = Date.now(), monotonicElapsedMs = 0 } = {}) {
  assert(session?.status === ExamStatus.IN_PROGRESS, "Only an active Session can be updated");
  if (elapsedForSession(session, { now, monotonicElapsedMs }) >= (session.durationMs || EXAM_DURATION_MS)) throw new ExamTimeoutError();
  const next = {
    ...session,
    ...changes,
    revision: Number(session.revision || 0) + 1,
    updatedAt: now,
    elapsedMs: elapsedForSession(session, { now, monotonicElapsedMs }),
  };
  return fingerprinted(next);
}

export async function answerExamItem(session, itemId, answer, clock) {
  assert(session.items.some((item) => item.id === itemId), "Unknown exam item");
  return updateSession(session, {
    answers: { ...session.answers, [itemId]: answer == null || answer === "" ? null : String(answer) },
    currentItemId: itemId,
  }, clock);
}

export function scoreExam(session) {
  const sections = { cloze: { total: 0, correct: 0, unanswered: 0 }, reading: { total: 0, correct: 0, unanswered: 0 } };
  const items = session.items.map((item) => {
    const answer = session.answers?.[item.id] ?? null;
    const unanswered = answer == null || answer === "";
    const correct = !unanswered && String(answer) === String(item.officialAnswer);
    const bucket = sections[item.section];
    bucket.total += 1;
    bucket.correct += Number(correct);
    bucket.unanswered += Number(unanswered);
    return { itemId: item.id, questionNumber: item.order, section: item.section, answer, officialAnswer: item.officialAnswer, correct, unanswered, resourceId: item.resourceId, passageIdAtSubmission: item.passageId, sourceQuestionIdAtSubmission: item.questionId, stemFingerprintAtSubmission: item.stemFingerprint };
  });
  const correct = items.filter((item) => item.correct).length;
  const unanswered = items.filter((item) => item.unanswered).length;
  return { total: items.length, correct, unanswered, rate: items.length ? correct / items.length : 0, sections, items };
}

export async function createExamResult(session, { reason, submittedAt = Date.now(), finalElapsedMs, inkRefs = {}, inkStatus = "complete" } = {}) {
  assert(session && (reason === ExamStatus.SUBMITTED || reason === ExamStatus.TIMED_OUT), "Result requires a submission reason");
  const elapsedMs = Math.min(session.durationMs || EXAM_DURATION_MS, finalElapsedMs ?? elapsedForSession(session, { now: submittedAt }));
  const scoring = scoreExam(session);
  const result = {
    schemaVersion: EXAM_SCHEMA_VERSION,
    id: `exam-result:v1:${session.sessionId}`,
    sessionId: session.sessionId,
    username: session.username,
    paperId: session.paperId,
    year: session.year,
    reason,
    startedAt: session.startedAt,
    submittedAt,
    finalElapsedMs: elapsedMs,
    sourceFingerprint: session.sourceFingerprint,
    answerKeyFingerprint: await examFingerprint(session.items.map(({ id, officialAnswer }) => ({ id, officialAnswer }))),
    inkRefs,
    inkStatus,
    scoring,
  };
  const withFingerprint = await fingerprinted(result);
  return { ...withFingerprint, resultFingerprint: withFingerprint.fingerprint };
}

export async function terminalizeSession(session, result, { status = result.reason, now = result.submittedAt } = {}) {
  assert(session.status === ExamStatus.IN_PROGRESS, "Only an active Session can become terminal");
  assert(result?.resultFingerprint, "Terminal Session requires a verified Result fingerprint");
  assert(status === ExamStatus.SUBMITTED || status === ExamStatus.TIMED_OUT, "Unsupported terminal status");
  return fingerprinted({
    ...session,
    status,
    revision: Number(session.revision || 0) + 1,
    updatedAt: now,
    elapsedMs: result.finalElapsedMs,
    resultRef: result.id,
    inkRefs: result.inkRefs || {},
    terminal: {
      resultFingerprint: result.resultFingerprint,
      submittedAt: result.submittedAt,
      finalElapsedMs: result.finalElapsedMs,
      inkStatus: result.inkStatus || "complete",
    },
  });
}

export async function abandonExamSession(session, { now = Date.now(), inkRefs = session.inkRefs || {}, inkStatus = "complete" } = {}) {
  assert(session?.status === ExamStatus.IN_PROGRESS, "Only an active Session can be abandoned");
  return fingerprinted({
    ...session,
    status: ExamStatus.ABANDONED,
    revision: Number(session.revision || 0) + 1,
    updatedAt: now,
    elapsedMs: elapsedForSession(session, { now }),
    resultRef: null,
    inkRefs,
    terminal: { resultFingerprint: null, submittedAt: null, finalElapsedMs: elapsedForSession(session, { now }), inkStatus },
  });
}

function parseAndVerify(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ExamDataError("Exam record is not valid JSON");
  }
}

async function verifyFingerprint(record) {
  if (!record?.fingerprint) return false;
  const copy = { ...record };
  delete copy.fingerprint;
  return (await examFingerprint(copy)) === record.fingerprint;
}

async function verifyResultFingerprint(result) {
  if (!result?.fingerprint || !result?.resultFingerprint || result.fingerprint !== result.resultFingerprint) return false;
  const copy = { ...result };
  delete copy.fingerprint;
  delete copy.resultFingerprint;
  return (await examFingerprint(copy)) === result.fingerprint;
}

export class ExamSessionRepository {
  constructor({ username, getItem = getUserItem, setItem = setUserItem } = {}) {
    assert(username, "A username is required");
    this.username = username;
    this.getItem = getItem;
    this.setItem = setItem;
  }

  async read(sessionId, { allowRecovery = true } = {}) {
    const current = parseAndVerify(this.getItem(examSessionKey(sessionId), this.username));
    if (current && current.username === this.username && current.sessionId === sessionId && await verifyFingerprint(current)) return current;
    if (!allowRecovery) {
      if (current) throw new ExamDataError("Current Session is damaged");
      return null;
    }
    const recovery = parseAndVerify(this.getItem(examRecoveryKey(sessionId), this.username));
    if (recovery && recovery.username === this.username && recovery.sessionId === sessionId && await verifyFingerprint(recovery)) return recovery;
    if (current || recovery) throw new ExamDataError("Session and recovery records are damaged");
    return null;
  }

  async write(next, { expectedRevision, controller } = {}) {
    if (controller && !controller.active) throw new ExamConflictError("Exam controller is inactive");
    const key = examSessionKey(next.sessionId);
    const current = parseAndVerify(this.getItem(key, this.username));
    if (current && Number(current.revision) !== Number(expectedRevision)) {
      if (controller) controller.invalidate("revision-conflict");
      throw new ExamConflictError();
    }
    if (next.username !== this.username) throw new ExamConflictError("Session belongs to another account");
    if (!(await verifyFingerprint(next))) throw new ExamDataError("Refusing to write an invalid Session fingerprint");
    if (current && await verifyFingerprint(current)) {
      this.setItem(examRecoveryKey(next.sessionId), JSON.stringify(current), this.username);
    }
    this.setItem(key, JSON.stringify(next), this.username);
    const verified = parseAndVerify(this.getItem(key, this.username));
    if (!verified || verified.fingerprint !== next.fingerprint || verified.revision !== next.revision) {
      if (controller) controller.invalidate("post-write-conflict");
      throw new ExamConflictError("Session post-write verification failed");
    }
    return verified;
  }

  async listActive() {
    const records = await this.listAll();
    return records.filter((record) => record?.status === ExamStatus.IN_PROGRESS || record?.damaged)
      .sort((a, b) => (b?.startedAt || 0) - (a?.startedAt || 0) || (b?.revision || 0) - (a?.revision || 0));
  }

  async listAll() {
    const prefix = "wuliao:exam-session:v1:";
    const records = await Promise.all(listUserItems(prefix).map(async ({ key }) => {
      const sessionId = key.slice(prefix.length);
      try { return await this.read(sessionId, { allowRecovery: false }); } catch { return { damaged: true, sessionId }; }
    }));
    return records.sort((a, b) => (b?.startedAt || 0) - (a?.startedAt || 0) || (b?.revision || 0) - (a?.revision || 0));
  }
}

export function createSessionController(sessionId) {
  let active = true;
  let reason = null;
  return {
    sessionId,
    get active() { return active; },
    get invalidReason() { return reason; },
    invalidate(nextReason = "external-change") { active = false; reason = nextReason; },
    observeStorageEvent(event, username) {
      if (event?.key !== scopedUserKey(examSessionKey(sessionId), username)) return false;
      this.invalidate("storage-event");
      return true;
    },
    observeResultStorageEvent(event, username) {
      if (event?.key !== scopedUserKey(examResultKey(sessionId), username)) return false;
      this.invalidate("result-fence");
      return true;
    },
  };
}

export class ExamResultRepository {
  constructor({ username, getItem = getUserItem, setItem = setUserItem } = {}) {
    assert(username, "A username is required");
    this.username = username;
    this.getItem = getItem;
    this.setItem = setItem;
  }

  async createOnce(result) {
    assert(result?.username === this.username, "Result belongs to another account");
    if (!(await verifyResultFingerprint(result))) throw new ExamDataError("Refusing to write an invalid Result fingerprint");
    const key = examResultKey(result.sessionId);
    const existing = parseAndVerify(this.getItem(key, this.username));
    if (existing) {
      if ((await verifyResultFingerprint(existing)) && existing.resultFingerprint === result.resultFingerprint) return existing;
      throw new ExamConflictError("A different immutable Result already exists");
    }
    this.setItem(key, JSON.stringify(result), this.username);
    const verified = parseAndVerify(this.getItem(key, this.username));
    if (!verified || verified.resultFingerprint !== result.resultFingerprint) throw new ExamConflictError("Result post-write verification failed");
    return verified;
  }

  async read(sessionId) {
    const result = parseAndVerify(this.getItem(examResultKey(sessionId), this.username));
    if (!result) return null;
    if (result.username !== this.username || result.sessionId !== sessionId || !(await verifyResultFingerprint(result))) {
      throw new ExamDataError("Result is damaged");
    }
    return result;
  }

  async list() {
    const prefix = "wuliao:exam-result:v1:";
    const results = await Promise.all(listUserItems(prefix).map(async ({ key }) => {
      try { return await this.read(key.slice(prefix.length)); } catch { return { damaged: true, sessionId: key.slice(prefix.length) }; }
    }));
    return results.filter(Boolean).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  }
}

/**
 * A terminal Session can be repaired only when its frozen Result fingerprint
 * agrees with a freshly reconstructed immutable Result.  Callers own the
 * actual create-once write; this pure gate prevents an expired session from
 * being reopened merely because its Result record was lost.
 */
export function canRebuildTerminalResult(session, rebuiltResult) {
  return Boolean(
    isTerminalSession(session)
      && session.status !== ExamStatus.ABANDONED
      && session.terminal?.resultFingerprint
      && rebuiltResult?.resultFingerprint
      && session.terminal.resultFingerprint === rebuiltResult.resultFingerprint
      && session.terminal.submittedAt === rebuiltResult.submittedAt
      && session.terminal.finalElapsedMs === rebuiltResult.finalElapsedMs,
  );
}

export async function rebuildTerminalResult(session) {
  if (!isTerminalSession(session) || session.status === ExamStatus.ABANDONED || !session.terminal) return null;
  const rebuilt = await createExamResult(session, {
    reason: session.status,
    submittedAt: session.terminal.submittedAt,
    finalElapsedMs: session.terminal.finalElapsedMs,
    inkRefs: session.inkRefs || {},
    inkStatus: session.terminal.inkStatus || "complete",
  });
  return canRebuildTerminalResult(session, rebuilt) ? rebuilt : null;
}

export async function flushWithWatchdog(flush, { timeoutMs = 1500, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let timer;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(flush).then((value) => ({ state: "complete", value })),
      new Promise((resolve) => { timer = setTimeoutFn(() => resolve({ state: "flush-timeout" }), timeoutMs); }),
    ]);
    return outcome;
  } catch (error) {
    return { state: "partial", error };
  } finally {
    if (timer) clearTimeoutFn(timer);
  }
}

export async function submitExam({ session, sessionRepository, resultRepository, expectedRevision, reason, flushInk, now = Date.now(), controller }) {
  assert(reason === ExamStatus.SUBMITTED || reason === ExamStatus.TIMED_OUT, "Unsupported submission reason");
  const existingResult = await resultRepository.read(session.sessionId);
  if (existingResult) {
    if (session.status === ExamStatus.IN_PROGRESS) {
      const repaired = await terminalizeSession(session, existingResult, { status: existingResult.reason, now: existingResult.submittedAt });
      const persisted = await sessionRepository.write(repaired, { expectedRevision, controller });
      return { session: persisted, result: existingResult, inkStatus: existingResult.inkStatus || "complete" };
    }
    return { session, result: existingResult, inkStatus: existingResult.inkStatus || "complete" };
  }
  assert(session.status === ExamStatus.IN_PROGRESS, "Submission requires an active Session or existing Result");
  const effectiveReason = reason === ExamStatus.TIMED_OUT || shouldTimeOut(session, { now })
    ? ExamStatus.TIMED_OUT
    : ExamStatus.SUBMITTED;
  let inkRefs = session.inkRefs || {};
  let inkStatus = "complete";
  if (typeof flushInk === "function") {
    const outcome = effectiveReason === ExamStatus.TIMED_OUT
      ? await flushWithWatchdog(flushInk)
      : await Promise.resolve().then(flushInk).then((value) => ({ state: "complete", value })).catch((error) => ({ state: "partial", error }));
    if (outcome.value?.inkRefs) inkRefs = outcome.value.inkRefs;
    if (outcome.state !== "complete") inkStatus = outcome.state;
    else if (outcome.value?.inkStatus === "partial") inkStatus = "partial";
  }
  const result = await createExamResult(session, {
    reason: effectiveReason,
    submittedAt: now,
    finalElapsedMs: effectiveReason === ExamStatus.TIMED_OUT ? EXAM_DURATION_MS : elapsedForSession(session, { now }),
    inkRefs,
    inkStatus,
  });
  const persistedResult = await resultRepository.createOnce(result);
  const terminal = await terminalizeSession(session, persistedResult, { status: effectiveReason, now });
  await sessionRepository.write(terminal, { expectedRevision, controller });
  return { session: terminal, result: persistedResult, inkStatus };
}

export function deriveHandoffTargets(result) {
  const targets = new Map();
  for (const item of result?.scoring?.items || []) {
    const id = item.section === "cloze" ? clozeTargetId(item.resourceId) : readingTargetId(item.resourceId);
    const current = targets.get(id) || { targetId: id, section: item.section, resourceId: item.resourceId, focusItemIds: [] };
    if (!item.correct) current.focusItemIds.push(item.itemId);
    targets.set(id, current);
  }
  return [...targets.values()]
    .sort((a, b) => (a.section === "cloze" ? -1 : 0) - (b.section === "cloze" ? -1 : 0) || a.targetId.localeCompare(b.targetId))
    .slice(0, MAX_HANDOFF_TARGETS);
}

export async function createOrUpdateHandoff({ username, examResultId, targetId, status = HandoffStatus.SELECTED, current, now = Date.now() }) {
  assert(Object.values(HandoffStatus).includes(status), "Unknown handoff status");
  if (current) {
    assert(current.username === username && current.examResultId === examResultId && current.targetId === targetId, "Handoff identity cannot change");
    if (current.status === status) return current;
    if (current.status !== status && !HANDOFF_TRANSITIONS.get(current.status)?.has(status)) throw new ExamDataError("Invalid handoff state transition");
  }
  return fingerprinted({
    schemaVersion: EXAM_SCHEMA_VERSION,
    username,
    examResultId,
    targetId,
    status,
    revision: Number(current?.revision || 0) + 1,
    updatedAt: now,
  });
}

export class ExamHandoffRepository {
  constructor({ username, getItem = getUserItem, setItem = setUserItem } = {}) {
    assert(username, "A username is required");
    this.username = username;
    this.getItem = getItem;
    this.setItem = setItem;
  }

  async read(examResultId, targetId) {
    const handoff = parseAndVerify(this.getItem(examHandoffKey(examResultId, targetId), this.username));
    if (!handoff) return null;
    if (handoff.username !== this.username || handoff.examResultId !== examResultId || handoff.targetId !== targetId || !(await verifyFingerprint(handoff))) {
      throw new ExamDataError("Handoff is damaged");
    }
    return handoff;
  }

  async save(next, { expectedRevision } = {}) {
    const key = examHandoffKey(next.examResultId, next.targetId);
    const current = parseAndVerify(this.getItem(key, this.username));
    if (current && Number(current.revision) !== Number(expectedRevision)) throw new ExamConflictError("Handoff changed before save");
    if (!(await verifyFingerprint(next))) throw new ExamDataError("Refusing to write invalid Handoff fingerprint");
    this.setItem(key, JSON.stringify(next), this.username);
    const verified = parseAndVerify(this.getItem(key, this.username));
    if (!verified || verified.fingerprint !== next.fingerprint) throw new ExamConflictError("Handoff post-write verification failed");
    return verified;
  }
}

export function isTerminalSession(session) {
  return TERMINAL_STATUSES.has(session?.status);
}

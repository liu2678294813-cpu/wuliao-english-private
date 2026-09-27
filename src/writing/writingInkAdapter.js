import {
  getWritingInkSnapshot,
  saveWritingInkSnapshot,
  writingInkRefFromSnapshot,
} from "./writingInkStorage.js";

const READY_STATUSES = new Set(["missing", "ok", "pending", "persist-failed", "stale-revision"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function requiredString(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new WritingInkSurfaceError("invalid-identity", `${name} is required`);
  return normalized;
}

function normalizeIdentity(value = {}) {
  return {
    username: requiredString(value.username, "username"),
    sessionId: requiredString(value.sessionId, "sessionId"),
    surfaceId: requiredString(value.surfaceId, "surfaceId"),
    stageId: value.stageId === null ? null : requiredString(value.stageId, "stageId"),
    ownerRecordId: requiredString(value.ownerRecordId, "ownerRecordId"),
    sourceFingerprint: requiredString(value.sourceFingerprint, "sourceFingerprint"),
  };
}

export function writingInkIdentityKey(identity) {
  const value = normalizeIdentity(identity);
  return canonical(value);
}

export class WritingInkSurfaceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WritingInkSurfaceError";
    this.code = code;
    this.identity = options.identity ? clone(options.identity) : null;
  }
}

function errorFor(code, message, cause, identity) {
  if (cause instanceof WritingInkSurfaceError && cause.code === code) return cause;
  return new WritingInkSurfaceError(code, message, { cause, identity });
}

export function createWritingInkAdapter({
  getSnapshot = getWritingInkSnapshot,
  saveSnapshot = saveWritingInkSnapshot,
  autosaveDelay = 250,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
  onStrokesChange = () => {},
  onInkRefChange = () => {},
  onStatusChange = () => {},
  onError = () => {},
} = {}) {
  let identity = null;
  let identityKey = "";
  let generation = 0;
  let status = "idle";
  let strokes = [];
  let history = [];
  let revision = 0;
  let mutationRevision = 0;
  let lastSnapshot = null;
  let lastPersistedCanonical = canonical([]);
  let dirty = false;
  let saveTimer = null;
  let saveTail = Promise.resolve();
  let transitionTail = Promise.resolve();
  let requestedIdentityKey = "";
  let attachRevision = 0;
  let latestAttachPromise = Promise.resolve();
  let beforeDetach = null;
  let disposed = false;

  function state() {
    return {
      identity: identity ? clone(identity) : null,
      status,
      strokes: clone(strokes),
      revision,
      dirty,
      inkRef: writingInkRefFromSnapshot(lastSnapshot),
      canUndo: history.length > 0 || strokes.length > 0,
      canClear: strokes.length > 0,
    };
  }

  function publishStatus(nextStatus) {
    status = nextStatus;
    onStatusChange(state());
  }

  function publishStrokes(next, meta = {}) {
    strokes = clone(next);
    onStrokesChange(clone(strokes), meta);
    onStatusChange(state());
  }

  function report(error) {
    onError(error);
    return error;
  }

  function clearScheduledSave() {
    if (saveTimer !== null) clearTimer(saveTimer);
    saveTimer = null;
  }

  function assertAttached() {
    if (disposed) throw errorFor("disposed", "Writing ink adapter is disposed", null, identity);
    if (!identity) throw errorFor("disposed", "Writing ink surface is not attached", null, identity);
  }

  function storageArgs(nextStrokes, expectedRevision) {
    return {
      ...identity,
      strokes: clone(nextStrokes),
      expectedRevision,
    };
  }

  function queuePersist() {
    assertAttached();
    clearScheduledSave();
    if (!dirty) return Promise.resolve(writingInkRefFromSnapshot(lastSnapshot));

    const taskGeneration = generation;
    const taskIdentityKey = identityKey;
    const taskIdentity = clone(identity);
    const taskMutationRevision = mutationRevision;
    const taskStrokes = clone(strokes);
    const taskCanonical = canonical(taskStrokes);

    const task = saveTail.then(async () => {
      if (disposed || taskGeneration !== generation || taskIdentityKey !== identityKey) return null;
      const expectedRevision = revision;
      let saved;
      try {
        saved = await saveSnapshot(storageArgs(taskStrokes, expectedRevision));
      } catch (cause) {
        if (!disposed && taskGeneration === generation && taskIdentityKey === identityKey) {
          const code = cause?.code === "stale-revision" ? "stale-revision" : "persist-failed";
          if (taskIdentityKey === requestedIdentityKey) {
            publishStatus(code);
            report(errorFor(code, "Writing ink persistence failed", cause, taskIdentity));
          }
        }
        throw cause;
      }
      if (disposed || taskGeneration !== generation || taskIdentityKey !== identityKey) return null;
      revision = saved.revision;
      lastSnapshot = clone(saved);
      lastPersistedCanonical = taskCanonical;
      dirty = canonical(strokes) !== lastPersistedCanonical;
      const mayPublish = taskIdentityKey === requestedIdentityKey;
      if (mayPublish && mutationRevision === taskMutationRevision && !dirty) publishStatus("ok");
      const ref = writingInkRefFromSnapshot(saved);
      if (mayPublish) {
        onInkRefChange(ref);
        onStatusChange(state());
      }
      return ref;
    });
    saveTail = task.catch(() => null);
    return task;
  }

  function schedulePersist() {
    clearScheduledSave();
    publishStatus("pending");
    saveTimer = setTimer(() => {
      saveTimer = null;
      queuePersist().catch(() => {});
    }, autosaveDelay);
  }

  function replaceCommitted(nextStrokes, { recordHistory = true, schedule = true, ...meta } = {}) {
    assertAttached();
    if (!Array.isArray(nextStrokes)) throw errorFor("invalid-strokes", "Writing ink strokes must be an array", null, identity);
    const next = clone(nextStrokes);
    if (canonical(next) === canonical(strokes)) return false;
    if (recordHistory) history.push(clone(strokes));
    mutationRevision += 1;
    dirty = canonical(next) !== lastPersistedCanonical;
    publishStrokes(next, meta);
    if (schedule && dirty) schedulePersist();
    else if (!dirty) {
      clearScheduledSave();
      publishStatus(lastSnapshot ? "ok" : "missing");
    }
    return true;
  }

  async function flushInternal() {
    assertAttached();
    clearScheduledSave();
    await saveTail;
    while (dirty) {
      try {
        await queuePersist();
      } catch (cause) {
        throw errorFor("flush-failed", "Writing ink flush failed", cause, identity);
      }
    }
    return writingInkRefFromSnapshot(lastSnapshot);
  }

  async function attachNow(nextIdentity, options = {}, requestRevision) {
    if (disposed) throw errorFor("disposed", "Writing ink adapter is disposed", null, identity);
    const normalized = normalizeIdentity(nextIdentity);
    const nextKey = canonical(normalized);
    if (identityKey === nextKey) {
      beforeDetach = options.beforeDetach || beforeDetach;
      return state();
    }

    if (identity) {
      publishStatus("switching");
      beforeDetach?.();
      // Hide the old runtime copy immediately while its identity-scoped flush completes.
      // The adapter keeps its private committed copy until persistence finishes.
      onStrokesChange([], { reason: "identity-switch-mask" });
      try {
        await flushInternal();
      } catch (cause) {
        report(errorFor("flush-failed", "Previous Writing ink surface could not be flushed before identity switch", cause, identity));
      }
    }

    generation += 1;
    identity = normalized;
    identityKey = nextKey;
    beforeDetach = options.beforeDetach || null;
    revision = 0;
    mutationRevision = 0;
    lastSnapshot = null;
    lastPersistedCanonical = canonical([]);
    dirty = false;
    history = [];
    publishStrokes([], { reason: "identity-change" });
    onInkRefChange(null);
    publishStatus("loading");

    const restoreGeneration = generation;
    let loaded;
    try {
      loaded = await getSnapshot({
        username: normalized.username,
        sessionId: normalized.sessionId,
        surfaceId: normalized.surfaceId,
        expectedSourceFingerprint: normalized.sourceFingerprint,
      });
    } catch (cause) {
      if (restoreGeneration !== generation || nextKey !== identityKey) return state();
      publishStatus("restore-failed");
      report(errorFor("restore-failed", "Writing ink restore failed", cause, normalized));
      return state();
    }
    if (disposed
      || restoreGeneration !== generation
      || nextKey !== identityKey
      || requestRevision !== attachRevision
      || nextKey !== requestedIdentityKey) return state();
    if (loaded?.status === "ok") {
      const snapshot = loaded.snapshot;
      const mismatchedField = ["username", "sessionId", "surfaceId", "stageId", "ownerRecordId", "sourceFingerprint"]
        .find((field) => snapshot?.[field] !== normalized[field]);
      if (mismatchedField) {
        const code = mismatchedField === "username" ? "account-mismatch" : "identity-mismatch";
        publishStatus(code);
        report(errorFor(code, `Restored Writing ink ${mismatchedField} does not match the mounted surface`, null, normalized));
        return state();
      }
      revision = snapshot.revision;
      lastSnapshot = clone(snapshot);
      lastPersistedCanonical = canonical(snapshot.strokes);
      publishStrokes(snapshot.strokes, { reason: "restore" });
      onInkRefChange(writingInkRefFromSnapshot(snapshot));
      publishStatus("ok");
      return state();
    }
    if (loaded?.status === "missing") {
      publishStatus("missing");
      return state();
    }
    const code = loaded?.status === "source-mismatch" ? "source-mismatch" : "damaged";
    revision = Number.isInteger(loaded?.revision) ? loaded.revision : 0;
    publishStatus(code);
    report(errorFor(code, code === "source-mismatch"
      ? "Writing ink source fingerprint does not match"
      : "Writing ink snapshot is damaged", null, normalized));
    return state();
  }

  function attach(nextIdentity, options = {}) {
    const normalized = normalizeIdentity(nextIdentity);
    const nextKey = canonical(normalized);
    if (nextKey === requestedIdentityKey) {
      if (options.beforeDetach) beforeDetach = options.beforeDetach;
      return latestAttachPromise.then(() => state());
    }
    requestedIdentityKey = nextKey;
    attachRevision += 1;
    const requestRevision = attachRevision;
    const task = transitionTail.catch(() => null).then(() => attachNow(normalized, options, requestRevision));
    transitionTail = task;
    latestAttachPromise = task;
    return task;
  }

  function assertFlushContext(context = {}) {
    assertAttached();
    for (const field of ["username", "sessionId", "surfaceId", "ownerRecordId"]) {
      if (context[field] !== undefined && context[field] !== identity[field]) {
        const code = field === "username" ? "account-mismatch" : "identity-mismatch";
        throw errorFor(code, `Writing ink ${field} does not match the mounted surface`, null, identity);
      }
    }
    if (context.stageId !== undefined && context.stageId !== identity.stageId) {
      throw errorFor("identity-mismatch", "Writing ink stageId does not match the mounted surface", null, identity);
    }
  }

  async function flush(context = {}) {
    assertFlushContext(context);
    return flushInternal();
  }

  function undo() {
    assertAttached();
    if (!strokes.length) return false;
    const previous = history.length ? history.pop() : strokes.slice(0, -1);
    return replaceCommitted(previous, { recordHistory: false, reason: "undo" });
  }

  function clear() {
    assertAttached();
    if (!strokes.length) return false;
    return replaceCommitted([], { reason: "clear" });
  }

  async function dispose() {
    if (disposed) return writingInkRefFromSnapshot(lastSnapshot);
    beforeDetach?.();
    let result = null;
    try {
      if (identity) result = await flushInternal();
    } finally {
      disposed = true;
      generation += 1;
      clearScheduledSave();
      status = "disposed";
    }
    return result;
  }

  return {
    attach,
    replaceCommitted,
    flush,
    undo,
    clear,
    dispose,
    getState: state,
    getIdentity: () => identity ? clone(identity) : null,
    isInteractive: () => !disposed && READY_STATUSES.has(status),
  };
}

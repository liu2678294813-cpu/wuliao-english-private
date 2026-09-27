/**
 * Testable debounced localStorage writer used by deep-reader text inputs.
 *
 * The writer owns the timer and the "cleared" flag so a page clear can
 * cancel pending writes and make later blur/pagehide/unmount flushes remove
 * storage instead of writing back a stale value.
 */
export function createDebouncedStorageWriter({
  read,
  write,
  remove,
  schedule,
  cancel,
  delay,
}) {
  if (typeof read !== "function") throw new Error("debounced writer requires read()");
  if (typeof write !== "function") throw new Error("debounced writer requires write()");
  if (typeof remove !== "function") throw new Error("debounced writer requires remove()");
  if (typeof schedule !== "function") throw new Error("debounced writer requires schedule()");
  if (typeof cancel !== "function") throw new Error("debounced writer requires cancel()");
  if (!Number.isFinite(Number(delay)) || Number(delay) < 0) {
    throw new Error("debounced writer requires a non-negative delay");
  }

  let latest = String(read() ?? "");
  let timer = null;
  let cleared = false;
  let dirty = false;

  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (cleared) {
      remove();
      return;
    }
    if (!dirty) return;
    write(latest);
    dirty = false;
  };

  const scheduleWrite = () => {
    clearTimer();
    timer = schedule(flush, Number(delay));
  };

  return {
    latest: () => latest,
    hasPending: () => timer !== null,
    isCleared: () => cleared,
    setLatest(next) {
      latest = String(next ?? "");
      cleared = false;
      dirty = true;
      scheduleWrite();
    },
    replaceLatest(next) {
      latest = String(next ?? "");
      cleared = false;
      dirty = false;
      clearTimer();
    },
    reset() {
      cleared = true;
      latest = "";
      clearTimer();
      remove();
    },
    flush,
  };
}

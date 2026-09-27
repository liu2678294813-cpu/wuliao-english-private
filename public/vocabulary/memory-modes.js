// One state for every rule/input combination. The encoded step also gives undo
// a lossless snapshot: 0, 1 masked, 1 visible, 2 masked, 2 visible, 3 complete.
export function memoryProgress(record = {}) {
  if (record.sharedProgress) {
    const count = Math.max(0, Math.min(3, Math.trunc(record.sharedProgress.count) || 0));
    return count === 3 ? 5 : count * 2 - Number(count > 0 && record.sharedProgress.masked === true);
  }
  if (record.modeProgress) {
    const cycle = Math.max(0, Math.min(5, Math.trunc(record.modeProgress.cycle) || 0));
    return record.modeProgress.default === 1 || cycle === 5 ? 5 : cycle;
  }
  const count = Math.max(0, Math.min(3, Math.trunc(record.clickCount) || 0));
  return count === 3 ? 5 : count * 2;
}

export function memoryState(record, rule) {
  const step = memoryProgress(record, rule);
  return { step, count: Math.ceil(step / 2), masked: step % 2 === 1, locked: step === 5 };
}

export function advanceMemory(record, rule, direction = "click") {
  const current = memoryState(record, rule);
  if (current.locked) return current.step;
  if (rule === "default") {
    if (direction === "right") return 5;
    if (direction !== "click") return current.step;
    const count = current.count + 1;
    return count === 3 ? 5 : count * 2 - Number(current.masked);
  }
  if (direction !== "click" && direction !== (current.masked ? "left" : "right")) return current.step;
  return current.step + 1;
}

export function swipeDirection(dx, dy) {
  return Math.abs(dx) >= 44 && Math.abs(dx) > Math.abs(dy) * 1.7 ? (dx > 0 ? "right" : "left") : null;
}

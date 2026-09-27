// Immutable strokes are shared with storage/rendering. Retain only changed
// strokes, rather than a full historical array for every pen operation.
export function createInkUndoPatch(before, after) {
  if (before === after) return current => current;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = new Set(after.filter(stroke => !beforeSet.has(stroke)));
  const removed = before.flatMap((stroke, index) => afterSet.has(stroke) ? [] : [{ stroke, index }]);
  return current => {
    const restored = current.filter(stroke => !added.has(stroke));
    for (const { stroke, index } of removed) restored.splice(index, 0, stroke);
    return restored;
  };
}

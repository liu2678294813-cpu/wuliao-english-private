import { getUserItem, setUserItem } from "./userData";

const CACHE_KEY = "wuliao:ai:cloze-task-cache";
const CACHE_LIMIT = 60;

function readCache() {
  try {
    const parsed = JSON.parse(getUserItem(CACHE_KEY) || "");
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
  } catch {
    // 缓存损坏时降级为空；不改动任何学习进度。
  }
  return [];
}

export function readClozeAiCache(fingerprint) {
  return readCache().find((entry) => entry.fingerprint === fingerprint)?.result || null;
}

export function writeClozeAiCache(fingerprint, result) {
  if (!fingerprint || !result) return;
  const entries = readCache().filter((entry) => entry.fingerprint !== fingerprint);
  entries.push({ fingerprint, result, savedAt: Date.now() });
  try {
    setUserItem(CACHE_KEY, JSON.stringify({
      entries: entries.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0)).slice(-CACHE_LIMIT),
    }));
  } catch {
    // 容量或账号状态不允许时只跳过缓存。
  }
}


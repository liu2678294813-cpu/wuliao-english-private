import { getCurrentUsername, getUserItem, listUserItems, setUserItem } from '../userData.js';

const PREFIX = 'wuliao:writing-example:v1:';
function assertAccount(username) {
  if (!username || getCurrentUsername() !== username) throw new Error('账号已切换，请重新打开例句仓库');
}
export function listExamples(username) {
  assertAccount(username);
  return listUserItems(PREFIX, username).map(({ value }) => {
    try { const item = JSON.parse(value); return item?.version === 1 && item.username === username ? item : null; } catch { return null; }
  }).filter(item => item && !item.deletedAt).sort((a, b) => b.createdAt - a.createdAt);
}
export function saveExample(username, { text, source, start = null, end = null }) {
  assertAccount(username);
  const original = String(text || '').trim();
  if (!original || (!source?.sessionId && !source?.materialId) || !source?.documentId) throw new Error('请在同一篇作文内选择文字');
  const normalized = original.replace(/\s+/g, ' ');
  const previous = listExamples(username).find(item => item.source.documentId === source.documentId && item.text.replace(/\s+/g, ' ') === normalized);
  if (previous) return { item: previous, duplicate: true };
  const now = Date.now(), id = crypto.randomUUID();
  const item = { version: 1, id, username, text: original, source: { ...source }, start, end, createdAt: now, updatedAt: now };
  const key = PREFIX + id, serialized = JSON.stringify(item);
  setUserItem(key, serialized, username);
  if (getUserItem(key, username) !== serialized) throw new Error('例句未能可靠保存，请重试');
  return { item, duplicate: false };
}
export function deleteExample(username, id) {
  assertAccount(username);
  const key = PREFIX + id, existing = getUserItem(key, username);
  if (!existing) return;
  const item = JSON.parse(existing);
  if (item.username !== username) throw new Error('例句账号不匹配');
  // A tombstone prevents an older backup from resurrecting a removed favorite.
  const next = JSON.stringify({ ...item, deletedAt: Date.now(), updatedAt: Date.now() });
  setUserItem(key, next, username);
  if (getUserItem(key, username) !== next) throw new Error('删除尚未保存，请重试');
}

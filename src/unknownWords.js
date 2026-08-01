let dictionaryPromise = null;

export function normalizeUnknownWord(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^[^a-z]+|[^a-z']+$/g, "");
}

async function loadDictionary() {
  const response = await fetch("/vocabulary/word-assets.json", { cache: "force-cache" });
  if (!response.ok) throw new Error(`离线词库读取失败（${response.status}）`);
  const manifest = await response.json();
  const modules = await Promise.all(Object.values(manifest).map((source) => import(/* @vite-ignore */ source)));
  const dictionary = new Map();
  modules.flatMap((module) => module.default?.entries || []).forEach((entry) => {
    const normalized = normalizeUnknownWord(entry.english);
    if (normalized && !dictionary.has(normalized)) dictionary.set(normalized, entry.chinese || "");
  });
  return dictionary;
}

export async function lookupUnknownWordMeaning(word) {
  dictionaryPromise ||= loadDictionary();
  const dictionary = await dictionaryPromise;
  return dictionary.get(normalizeUnknownWord(word)) || "";
}

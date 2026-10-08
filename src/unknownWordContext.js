import { getAiApiKey, lookupWordMeaningWithAi } from "./ai.js";
import { lookupUnknownWordMeaning } from "./unknownWords.js";
import { updateUnknownWordContextMeaning } from "./storage.js";

const pending = new Map();

// Storage and Ink remain independent of this small contextual-meaning resolver.
export function resolveUnknownContextMeaning(record, contextKey, {
  signal, isCurrent = () => true, getKey = getAiApiKey, lookup = lookupWordMeaningWithAi,
  dictionary = lookupUnknownWordMeaning, update = updateUnknownWordContextMeaning,
} = {}) {
  const sense = record.senses.find((item) => item.contextKey === contextKey);
  if (!sense || ["context-ai", "manual-context"].includes(sense.meaningSource)) return Promise.resolve(record);
  const key = JSON.stringify([record.username, record.id, contextKey, sense.meaningRevision]);
  if (pending.has(key)) return pending.get(key);
  const current = () => !signal?.aborted && isCurrent();
  const job = Promise.resolve().then(async () => {
    if (!current()) return null;
    let meaning = "", meaningSource = "pending-context";
    try {
      const apiKey = await getKey();
      if (!current()) return null;
      if (apiKey) {
        meaning = String(await lookup({ apiKey, word: record.word, sentence: sense.sentence, signal, isCurrent: current }) || "").trim();
        if (meaning) meaningSource = "context-ai";
      }
    } catch (reason) {
      if (!current() || reason?.name === "AbortError") return null;
    }
    if (!current()) return null;
    if (!meaning && !record.normalizedWord.includes(" ")) {
      meaning = await dictionary(record.word).catch(() => "");
      if (meaning) meaningSource = "dictionary-fallback";
    }
    if (!current() || !meaning) return null;
    return update(record.id, contextKey, meaning, { username: record.username, meaningSource,
      expectedRevision: sense.meaningRevision, isCurrent: current });
  }).finally(() => { if (pending.get(key) === job) pending.delete(key); });
  pending.set(key, job);
  return job;
}

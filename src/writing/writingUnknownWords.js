import { toggleUnknownWord } from "../storage.js";
import { getCurrentUsername as readCurrentUsername } from "../userData.js";
import { normalizeUnknownWord } from "../unknownWords.js";
import { WritingAccountMismatchError } from "./writingRepository.js";

export const WRITING_UNKNOWN_WORD_SOURCE = "writing";

function requiredString(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(`${name} is required`);
  return result;
}

export function buildWritingUnknownWordEntry({
  sessionId,
  sampleEssayFingerprint,
  unitId = null,
  sourceLabel = "Writing Sample",
  word,
  normalizedWord = normalizeUnknownWord(word),
  occurrenceId,
  meaning = "",
} = {}) {
  const id = requiredString(sessionId, "sessionId");
  const sampleFingerprint = requiredString(sampleEssayFingerprint, "sampleEssayFingerprint");
  const normalized = requiredString(normalizedWord, "normalizedWord");
  return {
    resourceId: `writing:${id}`,
    passageId: `sample:${sampleFingerprint}`,
    passageLabel: String(sourceLabel || "Writing Sample"),
    year: null,
    chapter: "Writing Sample",
    word: requiredString(word, "word"),
    normalizedWord: normalized,
    meaning: String(meaning || "").trim(),
    occurrenceId: requiredString(occurrenceId, "occurrenceId"),
    sourceType: WRITING_UNKNOWN_WORD_SOURCE,
    sessionId: id,
    sampleEssayFingerprint: sampleFingerprint,
    unitId: unitId === null ? null : requiredString(unitId, "unitId"),
    sourceLabel: String(sourceLabel || "Writing Sample"),
  };
}

export function createWritingUnknownWordsService({
  repository,
  getCurrentUsername = readCurrentUsername,
  saveSharedUnknownWord = toggleUnknownWord,
} = {}) {
  if (!repository) throw new TypeError("repository is required");

  async function saveWritingUnknownWord(input = {}) {
    const username = requiredString(getCurrentUsername?.(), "current username");
    if (username !== repository.username) {
      throw new WritingAccountMismatchError("The active account no longer matches this WritingRepository");
    }
    const sessionId = requiredString(input.sessionId, "sessionId");
    const session = await repository.readSession(sessionId);
    if (!session) throw new Error("Writing Session does not exist");
    if (session.username !== username) throw new WritingAccountMismatchError();
    if (input.sampleEssayFingerprint !== session.sampleEssaySnapshot.fingerprint) {
      throw new Error("sampleEssayFingerprint does not match the Writing Session");
    }
    if (input.unitId !== null && input.unitId !== undefined) {
      const unit = session.sampleEssaySnapshot.segments.find((entry) => entry.unitId === input.unitId);
      if (!unit) throw new Error("unitId does not belong to the Writing sample");
    }
    const entry = buildWritingUnknownWordEntry(input);
    return saveSharedUnknownWord(entry);
  }

  return Object.freeze({ saveWritingUnknownWord });
}

import { readAiResult, writeClozeResult } from "./aiReviewCache";

export function readClozeAiCache(fingerprint) {
  return readAiResult("cloze-task", fingerprint)?.result || null;
}

export function writeClozeAiCache(fingerprint, result) {
  writeClozeResult(fingerprint, result);
}


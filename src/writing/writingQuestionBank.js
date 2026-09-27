import { GENERATED_WRITING_QUESTIONS } from "./questions/generatedWritingQuestionData.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const QUESTIONS = deepFreeze(clone(GENERATED_WRITING_QUESTIONS));
const BY_ID = new Map(QUESTIONS.map((question) => [question.questionId, question]));
const YEARS = Object.freeze([...new Set(QUESTIONS.map((question) => question.year))].sort((left, right) => right - left));

export function listWritingQuestionYears() {
  return YEARS;
}

export function listWritingQuestions() {
  return QUESTIONS;
}

export function listWritingQuestionsByYear(year) {
  return deepFreeze(QUESTIONS.filter((question) => question.year === Number(year)));
}

export function getWritingQuestion(questionId) {
  return BY_ID.get(String(questionId || "")) || null;
}

export function promptSnapshotForWritingQuestion(questionId) {
  const question = getWritingQuestion(questionId);
  if (!question) return null;
  const { requiredContentPoints: _requiredContentPoints, ...snapshot } = question;
  return deepFreeze(clone(snapshot));
}

export const writingQuestionBank = Object.freeze({
  listYears: listWritingQuestionYears,
  list: listWritingQuestions,
  listByYear: listWritingQuestionsByYear,
  get: getWritingQuestion,
  promptSnapshot: promptSnapshotForWritingQuestion,
});

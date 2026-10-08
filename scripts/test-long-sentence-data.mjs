import test from "node:test";
import assert from "node:assert/strict";

const { nextSkillSchedule, skillIdFor, isSkillDue } = await import("../src/longSentence/schedule.js");
const { aggregateSelectedWords, selectionState, sourceReviewIdFor, listDifficultSources, groupSourcesTree } = await import("../src/longSentence/source.js");
const { sentenceKeyFor } = await import("../src/translationProgress.js");
const { setCurrentUsername, setUserItem } = await import("../src/userData.js");

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

test("skill identity ignores source order and new difficulty features", () => {
  const a = { sourceReviewId: sourceReviewIdFor({ resourceId: "a", passageId: "p", sentenceKey: "s1" }) };
  const b = { sourceReviewId: sourceReviewIdFor({ resourceId: "b", passageId: "p", sentenceKey: "s2" }) };
  assert.equal(skillIdFor({ sources: [a, b], structureFingerprint: " Relative Clause " }),
    skillIdFor({ sources: [b, a], structureFingerprint: "relative   clause", difficulty: 5 }));
});

test("skill scheduling is calendar-day based, retains self rating, and does not advance extra practice", () => {
  const id = "skill-1";
  const day = new Date(2026, 8, 29, 23, 30).getTime();
  let skill = { id };
  let result = nextSkillSchedule({ skill, attemptId: "a1", userRating: "difficult", now: day });
  assert.equal(result.skill.nextDueAt, "2026-09-30");
  assert.equal(result.skill.lapseCount, 0);
  skill = result.skill;
  result = nextSkillSchedule({ skill, attemptId: "a2", userRating: "mastered", now: day });
  assert.equal(result.skill.nextDueAt, "2026-10-02");
  assert.equal(result.skill.masteredStage, 1);
  skill = result.skill;
  result = nextSkillSchedule({ skill, attemptId: "a3", userRating: "mastered", now: day,
    aiTranslationAssessment: { issues: [{ category: "logic", severity: "major" }] } });
  assert.equal(result.event.userRating, "mastered");
  assert.equal(result.event.reason, "major_structure_or_logic_error");
  assert.equal(result.skill.nextDueAt, "2026-09-30");
  assert.equal(result.skill.masteredStage, 0);
  assert.equal(result.skill.lapseCount, 0);
  const nested = nextSkillSchedule({ skill: { id: "nested" }, attemptId: "n1", userRating: "mastered", now: day,
    aiTranslationAssessment: { translationEvaluation: { structuralUnderstandingErrors: [{ severity: "major", explanation: "misread clause" }] } } });
  assert.equal(nested.event.reason, "major_structure_or_logic_error");
  const relapse = nextSkillSchedule({ skill: result.skill, attemptId: "a4", userRating: "difficult", now: day });
  assert.equal(relapse.skill.lapseCount, 1);
  assert.equal(isSkillDue(result.skill, "2026-09-29"), false);
  assert.equal(isSkillDue(result.skill, "2026-09-30"), true);
  const extra = nextSkillSchedule({ skill: result.skill, attemptId: "extra", userRating: "mastered", now: day, extraPractice: true });
  assert.deepEqual(extra.skill, result.skill);
  assert.equal(extra.event.changed, false);
});

test("disputed AI feedback does not shorten a mastered interval", () => {
  const result = nextSkillSchedule({ skill: { id: "s" }, attemptId: "a", userRating: "mastered", now: new Date(2026, 8, 29).getTime(),
    analysisFeedback: { incorrect: true }, aiTranslationAssessment: { issues: [{ category: "structure", severity: "major" }] } });
  assert.equal(result.skill.nextDueAt, "2026-10-02");
});

test("source selection deduplicates words but preserves every article and occurrence", () => {
  const s1 = { sourceReviewId: "s1", status: "resolved", resourceId: "r", passageId: "p1" };
  const s2 = { sourceReviewId: "s2", status: "resolved", resourceId: "r", passageId: "p2" };
  const records = [
    { id: "w1", resourceId: "r", passageId: "p1", word: "Yield", occurrences: ["o1", "o2"] },
    { id: "w2", resourceId: "r", passageId: "p2", word: "yield", occurrences: ["o3"] },
  ];
  const words = aggregateSelectedWords(records, [s1, s2], ["s1", "s2"]);
  assert.equal(words.length, 1);
  assert.equal(words[0].wordId, "yield");
  assert.deepEqual(words[0].refs.map((ref) => ref.occurrences), [["o1", "o2"], ["o3"]]);
  assert.deepEqual(selectionState([s1, s2], ["s1"]), { selectedCount: 1, total: 2, checked: false, indeterminate: true });
});

test("official sources group by year, Text, article and sentence", () => {
  const sources = [
    { sourceReviewId: "s1", year: 2020, resourceId: "r1", resourceTitle: "2020 Text 1", passageId: "p1", articleLabel: "文章 1" },
    { sourceReviewId: "s2", year: 2020, resourceId: "r1", resourceTitle: "2020 Text 1", passageId: "p1", articleLabel: "文章 1" },
    { sourceReviewId: "s3", year: 2020, resourceId: "r2", resourceTitle: "2020 Text 2", passageId: "p2", articleLabel: "文章 2" },
  ];
  const tree = groupSourcesTree(sources);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].label, "2020 英语（一）");
  assert.equal(tree[0].sections.length, 2);
  assert.equal(tree[0].sections[0].articles[0].sentences.length, 2);
});

test("difficult source listing reads original progress without changing it and rejects changed text", async () => {
  setCurrentUsername("alice");
  const sentence = "Although the evidence was incomplete, the committee approved the plan.";
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: sentence });
  const passage = { id: "passage-a", label: "Text A", paragraphs: [{ number: 1, sentences: [sentence] }] };
  const resource = { id: "custom-a", kind: "custom", username: "alice", title: "Custom", conversionStatus: "ready", analysis: { passages: [passage] } };
  const progress = { resourceId: resource.id, passageId: passage.id, sentences: { [key]: { reviewStatus: "needs_review" } } };
  setUserItem(`wuliao:translation-progress:${resource.id}:${passage.id}`, JSON.stringify(progress));
  const found = await listDifficultSources({ resources: [], customPdfs: [resource] });
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "resolved");
  assert.equal(found[0].text, sentence);
  assert.equal(found[0].sourceReviewId, JSON.stringify([resource.id, passage.id, key]));
  assert.equal(progress.sentences[key].reviewStatus, "needs_review");
  const changed = await listDifficultSources({ resources: [], customPdfs: [{ ...resource, analysis: { passages: [{ ...passage, paragraphs: [{ number: 1, sentences: ["Different text."] }] }] } }] });
  assert.equal(changed[0].status, "text_changed");
  assert.equal(changed[0].text, "");
});

// Fixed, synthetic English samples. Difficulty values are fixture assertions,
// not a claim that metadata alone proves linguistic quality of live output.
export const TRAINING_SOURCE = "Although the evidence was incomplete, the committee approved the plan.";
export const TRAINING_FINGERPRINT = "concession + embedded relative clause + complement";
export const TRAINING_SENTENCE_B = "Although the astronomers, whose instruments reinforce observations recorded decades earlier, acknowledge that atmospheric conditions constrain what can be inferred, their findings suggest a distant planet remains habitable.";
export const TRAINING_SENTENCE_C = "Even though the historians whose discoveries challenged the accepted chronology concede that several documents may have been altered, the account they reconstructed explains why the expedition was abandoned.";
export const TRAINING_EVALUATION = {
  canonicalStructure: { mainClause: "their findings suggest a distant planet remains habitable", subject: "their findings", predicate: "suggest", objectOrComplement: "a distant planet remains habitable", clauses: ["Although 引导让步从句，whose 引导从句中的定语从句"], modifiers: ["recorded decades earlier 修饰 observations"], logicalRelations: ["让步关系"] },
  referenceTranslation: "尽管天文学家承认大气条件限制了能够作出的推断，而他们的仪器印证了数十年前的观测，其研究结果仍表明一颗遥远的行星适宜居住。",
  vocabularyNotes: [{ word: "reinforce", meaning: "印证；加强" }, { word: "constrain", meaning: "限制" }],
  translationEvaluation: { structuralUnderstandingErrors: [], wordMeaningErrors: [], logicalRelationErrors: [], chineseExpressionIssues: [], correctPoints: ["准确把握让步和主句结论"], nextTrainingFocus: ["留意从句内部的修饰关系"] },
};
export function qualityItem({ text = TRAINING_SENTENCE_B, sourceReviewIds = ["source-1"], difficulties = sourceReviewIds.map(() => 2), fingerprint = TRAINING_FINGERPRINT, uses = [] } = {}) {
  const sourceDifficulty = Math.max(...difficulties);
  return { text, sourceReviewIds, targetWordUses: uses, structureFingerprint: fingerprint, difficultyPolicy: "above_source", difficultyMetadata: { sourceDifficulties: sourceReviewIds.map((sourceReviewId, index) => ({ sourceReviewId, difficulty: difficulties[index] })), sourceDifficulty, targetDifficulty: sourceDifficulty + 1, difficultyDelta: 1, addedComplexityFeatures: ["clause nesting within a concession"] } };
}
export const QUALITY_CORPUS = [
  { id: "concession-nesting", source: TRAINING_SOURCE, sourceDifficulty: 2, generated: TRAINING_SENTENCE_B, feature: "clause nesting", explanation: "Adds a relative clause and nested complement inside the concession, then a distinct main-clause complement; topic changes from policy to astronomy." },
  { id: "condition-nonfinite", source: "If the results are reliable, the method should be adopted.", sourceDifficulty: 2, generated: "Were the museum to acquire the manuscript believed to have been concealed before the revolution, establishing who commissioned it would require evidence that the surviving accounts fail to provide.", feature: "nonfinite relation and conditional inversion", explanation: "An inverted conditional contains a passive infinitival modifier, while the main clause embeds an interrogative and relative clause; topic changes to provenance." },
  { id: "reference-distance", source: "The students who attended the lecture understood the argument.", sourceDifficulty: 2, generated: "The coastal settlements whose remaining inhabitants, having been warned that the barrier might fail, refused to abandon their homes now depend on a rescue operation which worsening weather has repeatedly delayed.", feature: "modifier distance and reference complexity", explanation: "A relative clause contains a nonfinite supplement and its complement, separating subject from predicate; topic changes to coastal rescue." },
];

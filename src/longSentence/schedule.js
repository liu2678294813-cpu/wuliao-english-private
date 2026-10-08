import { addCalendarDays, localDateKey } from "../readingReview.js";

export const MASTERED_INTERVAL_DAYS = Object.freeze([3, 7, 14, 30]);

export function normalizeStructureFingerprint(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function skillIdFor({ sources = [], structureFingerprint }) {
  const ids = [...new Set(sources.map((source) => source?.sourceReviewId || JSON.stringify([
    source?.resourceId || "", source?.passageId || "", source?.sentenceKey || "",
  ])))].sort();
  const structure = normalizeStructureFingerprint(structureFingerprint);
  if (!ids.length || !structure) throw new Error("技能身份缺少来源或核心结构");
  return JSON.stringify([ids, structure]);
}

function hasMajorError(assessment) {
  if (!assessment || typeof assessment !== "object") return false;
  const evaluation = assessment.translationEvaluation || assessment;
  const structuralOrLogical = [
    ...(Array.isArray(evaluation.structuralUnderstandingErrors) ? evaluation.structuralUnderstandingErrors : []),
    ...(Array.isArray(evaluation.logicalRelationErrors) ? evaluation.logicalRelationErrors : []),
  ];
  if (structuralOrLogical.some((issue) => issue?.severity === "major")) return true;
  const issues = [
    ...(Array.isArray(evaluation.issues) ? evaluation.issues : []),
    ...(Array.isArray(evaluation.problems) ? evaluation.problems : []),
  ];
  return issues.some((issue) => issue?.severity === "major"
    && /structure|logic|结构|逻辑/i.test(`${issue.category || ""} ${issue.type || ""}`));
}

export function isSkillDue(skill, today = localDateKey()) {
  return Boolean(skill?.nextDueAt && skill.nextDueAt <= today);
}

// Pure transition: caller persists event and updated skill after checking attempt idempotency.
export function nextSkillSchedule({
  skill,
  attemptId,
  userRating,
  aiTranslationAssessment = null,
  analysisFeedback = null,
  now = Date.now(),
  extraPractice = false,
} = {}) {
  if (!skill?.id || !attemptId) throw new Error("调度缺少技能或作答身份");
  if (userRating !== "mastered" && userRating !== "difficult") throw new Error("请选择已掌握或仍困难");
  const previous = {
    attemptCount: Number(skill.attemptCount) || 0,
    masteredStage: Number(skill.masteredStage) || 0,
    lapseCount: Number(skill.lapseCount) || 0,
    nextDueAt: skill.nextDueAt || null,
  };
  const today = localDateKey(now);
  if (extraPractice) {
    return {
      skill: { ...skill },
      event: { id: `${skill.id}::${attemptId}`, skillId: skill.id, attemptId, date: today, userRating, reason: "extra_practice", before: previous, after: previous, changed: false },
    };
  }
  const assessmentDisputed = analysisFeedback === "incorrect" || analysisFeedback?.incorrect === true;
  const majorConflict = !assessmentDisputed && userRating === "mastered" && hasMajorError(aiTranslationAssessment);
  const difficult = userRating === "difficult" || majorConflict;
  const stage = difficult ? 0 : Math.min(previous.masteredStage + 1, MASTERED_INTERVAL_DAYS.length);
  const days = difficult ? 1 : MASTERED_INTERVAL_DAYS[stage - 1];
  const after = {
    attemptCount: previous.attemptCount + 1,
    masteredStage: stage,
    lapseCount: previous.lapseCount + (userRating === "difficult" && previous.attemptCount > 0 ? 1 : 0),
    nextDueAt: addCalendarDays(today, days),
  };
  const reason = majorConflict ? "major_structure_or_logic_error" : difficult ? "difficult" : "mastered";
  return {
    skill: { ...skill, ...after, updatedAt: now },
    event: {
      id: `${skill.id}::${attemptId}`,
      skillId: skill.id,
      attemptId,
      date: today,
      userRating,
      reason,
      before: previous,
      after,
      changed: true,
      createdAt: now,
    },
  };
}

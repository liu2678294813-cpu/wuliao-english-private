const POST_REDO_STAGES = new Set(["deep-review"]);

export function hasReliableOfficialAnswer({ resource, officialAnswers, questionNumber } = {}) {
  if (resource?.kind !== "official") return false;
  const answer = officialAnswers?.[questionNumber] ?? officialAnswers?.[String(questionNumber)] ?? "";
  return /^[A-D]$/.test(String(answer).trim().toUpperCase());
}

export function questionCapabilities({
  flowStage,
  correctionRevealed = false,
  hasReliableOfficialAnswer: reliableAnswer = false,
  redoCompleted = false,
} = {}) {
  const firstAttempt = flowStage === "deep-first-quiz" || flowStage === "deep-clean-text";
  const redo = flowStage === "deep-redo";
  const postRedo = POST_REDO_STAGES.has(flowStage);
  const correction = Boolean(correctionRevealed && reliableAnswer);
  const redoAnalysisUnlocked = Boolean((redo && redoCompleted) || postRedo);

  return {
    canEditAnswer: firstAttempt ? !correctionRevealed : redo ? !correctionRevealed : false,
    showCorrection: correction,
    showEvidence: redoAnalysisUnlocked,
    showAiHint: redo,
    showDiagnosis: Boolean(redoAnalysisUnlocked && correction),
    showExplanation: Boolean(redoAnalysisUnlocked && correction),
    showAnalysis: redoAnalysisUnlocked,
    showArchive: postRedo,
  };
}

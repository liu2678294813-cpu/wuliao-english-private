import { useEffect, useMemo, useState } from "react";
import { getCurrentUsername } from "./userData";
import { questionKeyFor } from "./questionEvidence";
import { listNeedsReviewSentenceKeys } from "./translationProgress";
import {
  completeReviewSession,
  ensureSentenceRecheckTask,
  markOriginalSentenceLearned,
  reconcileOriginalSentenceCompletions,
  resolveSentenceKeys,
  TASK_TYPE_SENTENCE_RECHECK,
  updateReviewSession,
  wrongQuestionKeys,
} from "./readingReview";

function formatArticleText(value) {
  return String(value || "")
    .replace(/[—–―]/g, "--")
    .replace(/[‐‑]/g, "-")
    .replace(/(^|\s)-(?=\s|$)/g, "$1--");
}

function countOfficial(questions, answers, correctAnswers) {
  let correct = 0;
  let total = 0;
  for (const question of questions) {
    const official = String(correctAnswers?.[question.number] || "").trim();
    if (!official) continue;
    total += 1;
    if (String(answers?.[question.number] || "").trim().toUpperCase() === official) correct += 1;
  }
  return { correct, total };
}

const NEXT_DAY_STEPS = [
  ["reread", "盲读原文"],
  ["difficult_sentences", "困难句"],
  ["wrong_questions", "错题重做"],
  ["check", "核对"],
];

const RECHECK_STEPS = [
  ["difficult_sentences", "困难句复查"],
  ["check", "完成"],
];

export default function ReviewSession({
  task,
  resource,
  passage,
  translationProgress,
  correctAnswers = {},
  firstAnswers = {},
  redoAnswers = {},
  onSentenceMastered,
  onTaskChanged,
  onExit,
}) {
  const [error, setError] = useState("");
  const [storageUsername] = useState(getCurrentUsername);
  const [draftSummaries, setDraftSummaries] = useState({});
  const taskKey = task?.taskKey || "";
  const isRecheck = task?.type === TASK_TYPE_SENTENCE_RECHECK;
  const step = task?.session?.currentStep || (isRecheck ? "difficult_sentences" : "reread");
  const session = task?.session || {};

  const needsReviewKeys = useMemo(
    () => listNeedsReviewSentenceKeys(translationProgress),
    [translationProgress],
  );

  useEffect(() => {
    if (!taskKey) return;
    const result = reconcileOriginalSentenceCompletions(taskKey, storageUsername);
    if (storageUsername !== getCurrentUsername()) { setError("账号已切换，请重新打开复习"); return; }
    if (!result.ok) { setError(result.error || "复习记录恢复失败，请重试"); return; }
    const keys = new Set([...Object.keys(result.task?.session?.sentenceResults || {}), ...Object.keys(task?.session?.sentenceResults || {})]);
    if ([...keys].some((key) => result.task.session.sentenceResults[key] !== task?.session?.sentenceResults?.[key])) onTaskChanged?.(result.task);
  }, [taskKey]);

  const difficultItems = useMemo(() => {
    const pending = Object.keys(session.sentenceCompletions || {})
      .filter((key) => session.sentenceResults?.[key] !== "mastered");
    const keys = isRecheck ? [...new Set([...(task.sentenceKeys || []), ...pending])]
      : [...new Set([...needsReviewKeys, ...pending])];
    return resolveSentenceKeys(passage, keys);
  }, [isRecheck, task?.sentenceKeys, needsReviewKeys, passage, session.sentenceCompletions, session.sentenceResults]);

  const resolvedDifficult = difficultItems.filter((item) => item.status === "resolved");
  const unresolvedCount = difficultItems.filter((item) => item.status === "unresolved").length;
  const allDifficultJudged = resolvedDifficult.every((item) => (
    session.sentenceResults?.[item.key] === "mastered"
    || session.sentenceResults?.[item.key] === "difficult"
  ));
  const difficultStepReady = resolvedDifficult.length === 0 || allDifficultJudged;

  const wrongSet = useMemo(() => wrongQuestionKeys({
    resourceId: resource.id,
    passageId: passage.id,
    questions: passage.questions,
    firstAnswers,
    redoAnswers,
    correctAnswers,
  }), [resource.id, passage.id, passage.questions, firstAnswers, redoAnswers, correctAnswers]);

  const allReviewAnswersDone = wrongSet.questions.every((question, index) => {
    const key = questionKeyFor({
      resourceId: resource.id,
      passageId: passage.id,
      questionNumber: question.number,
      questionStem: question.stem,
      questionIndex: passage.questions.findIndex((item) => item.id === question.id),
    });
    return Boolean(session.reviewAnswers?.[key]);
  });

  const allParagraphsDone = passage.paragraphs.every((paragraph) => (
    Boolean(session.paragraphRecall?.[String(paragraph.number)]?.completedAt)
  ));

  function applyPatch(patch) {
    const result = updateReviewSession(taskKey, patch, Date.now(), storageUsername);
    if (storageUsername !== getCurrentUsername()) { setError("账号已切换，请重新打开复习"); return null; }
    if (!result.ok) {
      setError(`复读进度保存失败：${result.error || "存储空间不足"}`);
      return null;
    }
    setError("");
    onTaskChanged?.(result.task);
    return result.task;
  }

  function completeParagraph(paragraphNumber) {
    const summary = String(draftSummaries[String(paragraphNumber)] || "").trim();
    applyPatch({
      paragraphRecall: {
        [String(paragraphNumber)]: { completedAt: Date.now(), summary },
      },
    });
  }

  function judgeSentence(item, result) {
    if (result === "mastered") {
      const saved = markOriginalSentenceLearned(taskKey, item, Date.now(), storageUsername);
      if (saved.accountChanged || storageUsername !== getCurrentUsername()) {
        setError("账号已切换，请重新打开复习");
        return null;
      }
      if (saved.task) onTaskChanged?.(saved.task);
      if (saved.progress) onSentenceMastered?.(item.key, result, saved.progress);
      if (!saved.ok) { setError(saved.error || "原句复习保存失败"); return null; }
      setError("");
      return saved.task;
    }
    if (result === "difficult") {
      const scheduled = ensureSentenceRecheckTask({
        resourceId: resource.id,
        passageId: passage.id,
        sentenceKeys: [item.key],
        excludeTaskKey: taskKey,
        username: storageUsername,
      });
      if (!scheduled.ok) { setError(scheduled.error || "后续复查保存失败，请重试"); return null; }
    }
    const next = applyPatch({
      sentenceResults: { [item.key]: result },
    });
    return next;
  }

  function nextAfterReread() {
    if (resolvedDifficult.length) return "difficult_sentences";
    return wrongSet.skipped ? "check" : "wrong_questions";
  }

  function nextAfterDifficult() {
    return wrongSet.skipped ? "check" : "wrong_questions";
  }

  function unlockCheck() {
    applyPatch({ currentStep: "check", checkUnlocked: true });
  }

  function completeRecheck() {
    const values = Object.values(session.sentenceResults || {});
    const summary = {
      reviewedSentenceKeys: Object.keys(session.sentenceResults || {}),
      masteredCount: values.filter((value) => value === "mastered").length,
      difficultCount: values.filter((value) => value === "difficult").length,
      unresolvedCount,
      taskType: TASK_TYPE_SENTENCE_RECHECK,
    };
    const result = completeReviewSession(taskKey, summary, Date.now(), storageUsername);
    if (storageUsername !== getCurrentUsername()) { setError("账号已切换，请重新打开复习"); return; }
    if (!result.ok) {
      setError(`复读完成保存失败：${result.error || "存储空间不足"}`);
      return;
    }
    setError("");
    onTaskChanged?.(result.task);
  }

  if (!taskKey) return null;

  const steps = isRecheck ? RECHECK_STEPS : NEXT_DAY_STEPS;
  const activeIndex = Math.max(0, steps.findIndex(([id]) => id === step));

  return (
    <div className="review-session">
      <header className="review-session-header">
        <div className="review-session-title">
          <small>REVIEW SESSION</small>
          <h2>{isRecheck ? "困难句复查" : "次日复读"}</h2>
          <p>{passage.label} · {resource.title}</p>
        </div>
        <button type="button" className="review-exit-button" onClick={onExit}>退出复读</button>
      </header>

      <nav className="review-step-nav" aria-label="复读步骤">
        {steps.map(([id, label], index) => (
          <span key={id} className={`review-step-chip ${id === step ? "active" : ""} ${index < activeIndex ? "done" : ""}`}>
            {index < activeIndex ? "✓" : index + 1}<em>{label}</em>
          </span>
        ))}
      </nav>

      {error && <div className="review-error" role="alert">{error}</div>}

      {!isRecheck && step === "reread" && (
        <section className="review-panel">
          <div className="review-panel-heading">
            <h3>第一步：盲读原文</h3>
            <p>先独立回忆。AI、查词、昨天译文、题目答案与原 PDF 在核对前保持关闭；本阶段不开启画笔，手指可正常滚动。</p>
          </div>
          {passage.paragraphs.map((paragraph) => {
            const recall = session.paragraphRecall?.[String(paragraph.number)];
            const done = Boolean(recall?.completedAt);
            return (
              <article className="review-paragraph" key={paragraph.number}>
                <header><span>[P{paragraph.number}]</span>{done ? "已在本轮重新读懂" : "待确认"}</header>
                <div className="review-paragraph-text">
                  {paragraph.sentences.map((sentence, sentenceIndex) => (
                    <p key={`${paragraph.number}-s${sentenceIndex}`}>
                      <span>S{sentenceIndex + 1}</span>{formatArticleText(sentence)}
                    </p>
                  ))}
                </div>
                <textarea
                  className="review-summary-input"
                  rows={2}
                  placeholder="我的一句话概括（可选，不强制）"
                  value={draftSummaries[String(paragraph.number)] ?? recall?.summary ?? ""}
                  onChange={(event) => setDraftSummaries((current) => ({
                    ...current,
                    [String(paragraph.number)]: event.target.value,
                  }))}
                />
                <button
                  type="button"
                  className={`review-paragraph-button ${done ? "done" : ""}`}
                  onClick={() => completeParagraph(paragraph.number)}
                  disabled={done}
                >
                  {done ? "已完成本段" : "这一段我已经重新读懂并能概括"}
                </button>
              </article>
            );
          })}
          <div className="review-step-action">
            {allParagraphsDone ? (
              <button
                type="button"
                className="stage-advance-button"
                onClick={() => applyPatch({ currentStep: nextAfterReread() })}
              >
                {resolvedDifficult.length
                  ? "进入困难句复查"
                  : wrongSet.skipped ? "没有困难句与错题，进入核对" : "进入错题重做"}
              </button>
            ) : (
              <small className="review-step-hint">完成全部段落确认后继续</small>
            )}
          </div>
        </section>
      )}

      {step === "difficult_sentences" && (
        <section className="review-panel">
          <div className="review-panel-heading">
            <h3>{isRecheck ? "困难句复查" : "第二步：困难句复查"}</h3>
            <p>只显示英文原句。请先默译 / 口译 / 回忆句法，再选择“现在能独立理解”或“仍然困难”。不需要重新写整句翻译。</p>
          </div>
          {!difficultItems.length && (
            <div className="review-empty">
              <p>{isRecheck ? "这份复查任务没有可恢复的困难句。" : "这篇没有标记「需复盘」的句子，已自动跳过。"}</p>
              {!isRecheck && (
                <button type="button" className="stage-advance-button" onClick={() => {
                  const next = nextAfterDifficult();
                  if (next === "check") unlockCheck();
                  else applyPatch({ currentStep: next });
                }}>
                  {wrongSet.skipped ? "进入核对" : "进入错题重做"}
                </button>
              )}
            </div>
          )}
          {difficultItems.map((item) => {
            const judged = session.sentenceResults?.[item.key];
            const completion = session.sentenceCompletions?.[item.key];
            const sourceEntry = translationProgress?.sentences?.[item.key];
            const pendingConfirmation = !judged && completion && sourceEntry?.reviewStatus === "mastered"
              && sourceEntry.reviewedAt === completion.learnedAt;
            if (item.status === "unresolved") {
              return (
                <div className="review-sentence unresolved" key={item.key}>
                  <p>原文结构已变化，无法精确恢复该句子（不跳转到其他句子）。</p>
                </div>
              );
            }
            return (
              <article className={`review-sentence ${judged ? "judged" : ""}`} key={item.key}>
                <header><span>P{item.paragraphNumber} · S{item.sentenceIndex + 1}</span></header>
                <p>{formatArticleText(item.sentenceText)}</p>
                {!judged ? (
                  <div className="review-sentence-judge">
                    <button type="button" className="review-judge-button mastered" onClick={() => judgeSentence(item, "mastered")}>
                      {pendingConfirmation ? "重试保存复习记录" : "现在能独立理解"}
                    </button>
                    {!pendingConfirmation && <button type="button" className="review-judge-button difficult" onClick={() => judgeSentence(item, "difficult")}>
                      仍然困难
                    </button>}
                  </div>
                ) : (
                  <small className="review-sentence-result">
                    {judged === "mastered" ? "已标记：现在能独立理解" : "已标记：仍然困难（3 天后复查）"}
                  </small>
                )}
              </article>
            );
          })}
          {unresolvedCount > 0 && (
            <small className="review-unresolved-note">另有 {unresolvedCount} 句因原文结构变化无法恢复，已跳过。</small>
          )}
          <div className="review-step-action">
            {isRecheck ? (
              difficultStepReady && resolvedDifficult.length > 0 ? (
                <button type="button" className="stage-advance-button" onClick={completeRecheck}>
                  完成本次复查
                </button>
              ) : (
                resolvedDifficult.length === 0 && (
                  <button type="button" className="stage-advance-button" onClick={completeRecheck}>
                    {difficultItems.length ? "句子无法恢复，直接完成" : "无句子可复查，直接完成"}
                  </button>
                )
              )
            ) : (
              difficultStepReady ? (
                <button type="button" className="stage-advance-button" onClick={() => {
                  const next = nextAfterDifficult();
                  if (next === "check") unlockCheck();
                  else applyPatch({ currentStep: next });
                }}>
                  {wrongSet.skipped ? "进入核对" : "进入错题重做"}
                </button>
              ) : (
                <small className="review-step-hint">
                  {resolvedDifficult.length ? "请先对每个句子做出判断" : "正在读取困难句状态…"}
                </small>
              )
            )}
          </div>
        </section>
      )}

      {!isRecheck && step === "wrong_questions" && (
        <section className="review-panel">
          <div className="review-panel-heading">
            <h3>第三步：错题重做</h3>
            <p>只重做第一天或重做时答错的题。提交前不会显示任何旧答案；本轮只要求重新选择答案。</p>
          </div>
          {wrongSet.skipped ? (
            <div className="review-empty">
              <p>
                {wrongSet.reason === "no-questions"
                  ? "本篇没有识别到选择题，已自动跳过。"
                  : wrongSet.reason === "no-answer-key"
                    ? "本篇没有官方答案，无法确定错题，已自动跳过。"
                    : "第一次与重做都没有错题，已自动跳过。"}
              </p>
              <button type="button" className="stage-advance-button" onClick={unlockCheck}>进入核对</button>
            </div>
          ) : (
            <>
              {wrongSet.questions.map((question) => {
                const questionIndex = passage.questions.findIndex((item) => item.id === question.id);
                const key = questionKeyFor({
                  resourceId: resource.id,
                  passageId: passage.id,
                  questionNumber: question.number,
                  questionStem: question.stem,
                  questionIndex,
                });
                const selected = session.reviewAnswers?.[key];
                return (
                  <article className="review-question" key={question.id}>
                    <h3><span>{question.number}</span>{question.stem}</h3>
                    <div className="review-question-options">
                      {question.options.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          className={selected === option.key ? "selected" : ""}
                          onClick={() => applyPatch({ reviewAnswers: { [key]: option.key } })}
                        >
                          <span>{option.key}</span><p>{option.text}</p>
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
              <div className="review-step-action">
                {allReviewAnswersDone ? (
                  <button type="button" className="stage-advance-button" onClick={unlockCheck}>
                    全部重做完成，进入核对
                  </button>
                ) : (
                  <small className="review-step-hint">请先重新选择全部复查题的答案</small>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function ReviewCheckPanel({
  task,
  resource,
  passage,
  firstAnswers = {},
  redoAnswers = {},
  correctAnswers = {},
  onComplete,
  onExit,
}) {
  const session = task?.session || {};
  const first = countOfficial(passage.questions, firstAnswers, correctAnswers);
  const redo = countOfficial(passage.questions, redoAnswers, correctAnswers);
  const wrongSet = wrongQuestionKeys({
    resourceId: resource.id,
    passageId: passage.id,
    questions: passage.questions,
    firstAnswers,
    redoAnswers,
    correctAnswers,
  });
  const reviewedCount = Object.keys(session.reviewAnswers || {}).length;
  const sentenceValues = Object.values(session.sentenceResults || {});
  const masteredCount = sentenceValues.filter((value) => value === "mastered").length;
  const difficultCount = sentenceValues.filter((value) => value === "difficult").length;
  const sentenceTotal = Object.keys(session.sentenceResults || {}).length;

  return (
    <section className="review-check-panel">
      <header>
        <div>
          <small>CHECK STAGE</small>
          <h2>现在可以核对昨天记录</h2>
          <p>已解锁：昨天笔译、AI 批改、段落中心思想、first/redo 答案与证据、官方答案、原 PDF 与 AI 均已恢复。核对阶段只读，不会修改原有记录。</p>
        </div>
        <button type="button" className="review-exit-button" onClick={onExit}>退出复读</button>
      </header>
      <div className="review-yesterday-today">
        <div className="review-stat-card">
          <small>昨天 · 第一次</small>
          <strong>{first.correct} / {first.total}</strong>
          <span>答对题数</span>
        </div>
        <div className="review-stat-card">
          <small>昨天 · 重做</small>
          <strong>{redo.correct} / {redo.total}</strong>
          <span>答对题数</span>
        </div>
        <div className="review-stat-card">
          <small>今天 · 错题复查</small>
          <strong>{reviewedCount} / {wrongSet.questions.length}</strong>
          <span>已重新作答</span>
        </div>
        <div className="review-stat-card">
          <small>困难句</small>
          <strong>{masteredCount} 掌握 · {difficultCount} 仍困难</strong>
          <span>共 {sentenceTotal} 句</span>
        </div>
      </div>
      <button type="button" className="primary-button review-complete-button" onClick={onComplete}>
        完成本次复读
      </button>
    </section>
  );
}

export function ReviewCompleteCard({ task, resource, passage, onExit }) {
  const summary = task?.session?.summary || {};
  const isRecheck = task?.type === TASK_TYPE_SENTENCE_RECHECK;
  return (
    <div className="review-complete-card">
      <span className="review-complete-mark">✓</span>
      <small>REVIEW COMPLETE</small>
      <h2>{isRecheck ? "困难句复查完成" : "次日复读完成"}</h2>
      <p>{resource.title} · {passage.label}</p>
      <dl className="review-complete-stats">
        {!isRecheck && (
          <div><dt>全文盲读</dt><dd>{summary.paragraphRecallCount || 0} / {passage.paragraphs.length} 段</dd></div>
        )}
        <div><dt>困难句</dt><dd>{summary.masteredCount || 0} 句已掌握{summary.difficultCount ? ` · ${summary.difficultCount} 句将在 3 天后复查` : "，无需复查"}</dd></div>
        {!isRecheck && (
          <div><dt>错题</dt><dd>{summary.reviewAnswersTotal || 0} / {summary.reviewQuestionTotal || 0} 已重做</dd></div>
        )}
      </dl>
      <button type="button" className="primary-button" onClick={onExit}>返回首页</button>
    </div>
  );
}

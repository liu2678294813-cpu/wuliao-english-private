import MaterialAnswers from "./import/MaterialAnswers.jsx";
// 完形长期复习会话（E 阶段）：D+1 选择性检索 / D+7 保持确认。
//
// 领域边界：
//   - 围绕 Blank 展开，不复用 Reading ReviewSession 的 question/sentence
//     语义；也不往 Reading 组件里散落 cloze 分支。
//   - 作答只写入 cloze review sidecar（recordClozeReviewAttempt），绝不覆盖
//     firstAnswer / reviewAnswer / confidence / prediction / basisTypes /
//     references / corrected / analyzed / translation。
//   - correctness 只由本地 officialAnswer 计算；无答案资料禁止出现
//     correct/wrong/正确答案/错题/accuracy 等表述。
//   - AI 完全不参与调度与判定；只允许作为复习后的可选辅助解释入口
//     （cloze-context-review），并明确标注为"AI 推测"。
//   - 恢复：任务进度在 sidecar 中即时持久化，reload 后从 currentIndex 继续。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildClozeSentenceModel,
} from "./clozeSentences";
import { buildClozeSupportSignals, getClozeReviewTask } from "./clozeReview";
import {
  CLOZE_BASIS_TYPE_LABELS,
  getClozeProgress,
} from "./clozeProgress";
import {
  completeClozeReviewTask,
  computeD1AttemptOutcome,
  computeD7AttemptOutcome,
  recordClozeReviewAttempt,
  SELF_RATING_STABLE,
  SELF_RATING_UNSTABLE,
  scheduleClozeD7Task,
  startClozeReviewTask,
  TASK_TYPE_D1,
  TASK_TYPE_D7,
} from "./clozeReview";
import { loadClozeTranslationProgress, translationEntryFor } from "./clozeTranslationProgress";
import { clozeBlankNumbers, officialAnswerFor } from "./clozeView";
import { priorityTranslationTargets } from "./clozeSentences";
import { listPostCorrectionPriorityBlankNumbers } from "./clozeProgress";
import { loadOfficialCloze, postgraduateClozeResources } from "./library";
import { listCustomPdfs } from "./storage";

const CONFIDENCE_LABELS = { confident: "确定", uncertain: "犹豫", guess: "猜测" };

function confidenceLabel(value) {
  return CONFIDENCE_LABELS[value] || "";
}

function translationStatusLabel(entry) {
  if (!entry) return "—";
  if (entry.status === "corrected") return "已订正";
  if (entry.status === "translated") return "已翻译，待订正";
  return "待笔译";
}

function sentenceTokens(sentence) {
  return sentence?.tokens || [];
}

// 单个 Blank 的上下文：所在句 + 前后邻句（可展开）。
function BlankContext({ sentenceModel, blankId, expanded, onExpand }) {
  const sentence = sentenceModel?.blankToSentence?.[blankId];
  if (!sentence) {
    return <p className="cloze-review-context-empty">找不到该空的句子上下文。</p>;
  }
  const allSentences = sentenceModel.paragraphs.flatMap((paragraph) => paragraph.sentences || []);
  const index = allSentences.findIndex((item) => item.sentenceKey === sentence.sentenceKey);
  const before = allSentences.slice(Math.max(0, index - (expanded ? 2 : 1)), index);
  const after = allSentences.slice(index + 1, index + 1 + (expanded ? 2 : 1));
  const renderSentence = (item, isTarget) => (
    <p key={item.sentenceKey} className={`cloze-review-sentence ${isTarget ? "is-target" : ""}`}>
      <small>第 {item.paragraphNumber} 段</small>
      {sentenceTokens(item).map((token, tokenIndex) => {
        if (token.type === "blank") {
          return (
            <span key={`${item.sentenceKey}-${tokenIndex}`} className="cloze-review-blank-marker">
              [空{token.number}]
            </span>
          );
        }
        return <span key={`${item.sentenceKey}-${tokenIndex}`}>{token.text}</span>;
      })}
    </p>
  );
  return (
    <div className="cloze-review-context">
      {before.map((item) => renderSentence(item, false))}
      {renderSentence(sentence, true)}
      {after.map((item) => renderSentence(item, false))}
      <button type="button" className="cloze-review-context-toggle" onClick={onExpand}>
        {expanded ? "收起更多上下文" : "展开更多上下文"}
      </button>
    </div>
  );
}

function ReasonChips({ reasons }) {
  const labels = {
    "high-confidence-wrong": "高置信错误",
    "changed-to-wrong": "改答后错误",
    "final-wrong": "最终仍错",
    "self-corrected": "自查纠正",
    "changed-answer": "改答",
    guess: "猜测",
    uncertain: "犹豫",
    "d1-wrong": "D+1 仍错",
    "d1-low-confidence": "D+1 低置信",
    "d1-changed": "D+1 改答",
    "d1-self-rating-unstable": "D+1 自评不稳",
    "d7-confirmation": "高置信错误复查",
    "translation-unresolved": "译文未订正",
    "answerless-changed": "改答",
    "answerless-low-confidence": "低置信",
  };
  return (
    <div className="cloze-review-reasons">
      {(reasons || []).map((reason) => (
        <span key={reason}>{labels[reason] || reason}</span>
      ))}
    </div>
  );
}

function CheckPanel({ task, blankId, draft, cloze, progress, translationProgress, sentenceModel, officialAnswer, hasOfficial, onNext, isLast }) {
  const attempt = progress?.attempts?.[blankId] || {};
  const sentence = sentenceModel?.blankToSentence?.[blankId];
  const translation = translationEntryFor(translationProgress, sentence?.sentenceKey);
  const changed = Boolean(draft.answer && attempt.reviewAnswer && draft.answer !== attempt.reviewAnswer);
  const correct = hasOfficial && Boolean(officialAnswer && draft.answer === officialAnswer);
  const isD7 = task?.type === TASK_TYPE_D7;

  return (
    <div className="cloze-review-check">
      {hasOfficial ? (
        <>
          <div className="cloze-review-check-row">
            <span>本次作答</span>
            <strong>
              {draft.answer} · {confidenceLabel(draft.confidence) || "未标记"}
            </strong>
            <em className={correct ? "is-correct" : "is-wrong"}>
              {correct ? "本次正确" : "本次错误"}
            </em>
          </div>
          <div className="cloze-review-check-row">
            <span>官方答案</span>
            <strong>{officialAnswer || "—"}</strong>
          </div>
        </>
      ) : (
        <div className="cloze-review-check-row">
          <span>本次作答</span>
          <strong>{draft.answer} · {confidenceLabel(draft.confidence) || "未标记"}</strong>
        </div>
      )}
      <div className="cloze-review-check-row">
        <span>D 当天</span>
        <strong>
          初做 {attempt.firstAnswer || "—"} · {confidenceLabel(attempt.firstConfidence || attempt.confidence) || "—"}
          {"　"}
          复查 {attempt.reviewAnswer || "—"} · {confidenceLabel(attempt.reviewConfidence) || "—"}
        </strong>
      </div>
      {hasOfficial && (
        <div className="cloze-review-check-row">
          <span>本次对比</span>
          <strong>
            {changed ? `已改答（原 ${attempt.reviewAnswer || attempt.firstAnswer || "—"}）` : "与当天一致"}
            {draft.basisTypes?.length ? ` · 依据 ${draft.basisTypes.map((id) => CLOZE_BASIS_TYPE_LABELS[id] || id).join("、")}` : ""}
          </strong>
        </div>
      )}
      {!hasOfficial && (
        <div className="cloze-review-check-row">
          <span>稳定度</span>
          <strong>
            {draft.selfRating === SELF_RATING_STABLE ? "稳定" : "仍不确定"}
            {draft.basisTypes?.length ? ` · 依据 ${draft.basisTypes.map((id) => CLOZE_BASIS_TYPE_LABELS[id] || id).join("、")}` : ""}
          </strong>
        </div>
      )}
      <div className="cloze-review-check-row">
        <span>D 当天分析</span>
        <strong>
          依据：{(attempt.basisTypes || []).length
            ? attempt.basisTypes.map((id) => CLOZE_BASIS_TYPE_LABELS[id] || id).join("、")
            : "未标记"}
          {"　"}定位：{(attempt.references || []).length ? `${attempt.references.length} 处` : "无"}
          {"　"}译文：{translationStatusLabel(translation)}
        </strong>
      </div>
      {!hasOfficial && (
        <p className="cloze-review-no-answer-note">
          此资料没有可靠官方答案：只记录你的作答变化与自评，不判断对错。
        </p>
      )}
      {isD7 && <p className="cloze-review-d7-note">D+7 是短确认：不再要求完整分析，只确认是否脱离错误模式。</p>}
      <button type="button" className="primary-button" onClick={onNext}>
        {isLast ? "完成复习" : "下一空"}
      </button>
    </div>
  );
}

function ReviewCompletion({ task, resourceTitle, hasOfficial, onClose }) {
  const targets = task?.targetBlankIds || [];
  const attempts = task?.attempts || {};
  const withAnswerOutcomes = targets.filter((blankId) => {
    const attempt = attempts[blankId];
    return attempt?.outcome === "correct";
  }).length;
  const stableCount = targets.filter((blankId) => {
    const attempt = attempts[blankId];
    return attempt?.selfRating === SELF_RATING_STABLE;
  }).length;
  const doneCount = targets.filter((blankId) => attempts[blankId]).length;
  return (
    <div className="cloze-review-complete">
      <h2>{task?.type === TASK_TYPE_D7 ? "完形 D+7 确认完成" : "完形 D+1 复习完成"}</h2>
      <p>{resourceTitle} · {doneCount}/{targets.length} 空已完成</p>
      <div className="cloze-review-complete-stats">
        <span>{hasOfficial ? `本次正确 ${withAnswerOutcomes} 空` : `自评稳定 ${stableCount} 空`}</span>
        <span>加入复习 {targets.length} 空</span>
      </div>
      {task?.type === TASK_TYPE_D7 && (
        <p className="cloze-review-d7-note">
          仍未稳定的项目会保留在长期档案中，可随时手动复盘。
        </p>
      )}
      {task?.type === TASK_TYPE_D1 && (
        <p className="cloze-review-d7-note">
          需要确认的项目会自动安排 D+7 短确认（完成日 + 7 天）。
        </p>
      )}
      <button type="button" className="primary-button" onClick={onClose}>返回首页</button>
    </div>
  );
}

export default function ClozeReviewSession({ taskKey, onClose }) {
  const [status, setStatus] = useState("正在读取复习任务");
  const [error, setError] = useState("");
  const [task, setTask] = useState(null);
  const [cloze, setCloze] = useState(null);
  const [progress, setProgress] = useState(null);
  const [translationProgress, setTranslationProgress] = useState(null);
  const [sentenceModel, setSentenceModel] = useState(null);
  const [officialAnswers, setOfficialAnswers] = useState({});
  const [hasOfficial, setHasOfficial] = useState(false);
  const [resourceTitle, setResourceTitle] = useState("");
  const [translationTargetKeys, setTranslationTargetKeys] = useState(null);
  const [draft, setDraft] = useState({ answer: "", confidence: "", basisTypes: [], selfRating: null });
  const [submitted, setSubmitted] = useState(false);
  const [submittedBlank, setSubmittedBlank] = useState(null);
  const [expandedContext, setExpandedContext] = useState(false);
  const [completedView, setCompletedView] = useState(false);
  const finalizingRef = useRef(false);
  const justSubmittedRef = useRef(false);
  const resourceRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("正在读取复习任务");
    setError("");
    (async () => {
      const reviewTask = getClozeReviewTask(taskKey);
      if (!reviewTask) {
        if (!cancelled) {
          setError("复习任务不存在或已被移除。");
          setStatus("读取失败");
        }
        return;
      }
      const resource = postgraduateClozeResources.find((item) => item.id === reviewTask.resourceId)
        || (await listCustomPdfs()).find((item) => item.id === reviewTask.resourceId)
        || null;
      if (!resource) {
        if (!cancelled) {
          setError("无法打开该完形资料：数据可能已被删除。");
          setStatus("读取失败");
        }
        return;
      }
      let nextCloze;
      let nextClozeId;
      const isOfficial = Boolean(resource.clozeSource);
      const customCloze = resource.analysis?.clozes?.[0];
      if (customCloze) {
        nextCloze = customCloze;
        nextClozeId = resource.id;
      } else if (isOfficial) {
        nextCloze = await loadOfficialCloze(resource);
        nextClozeId = nextCloze.id || resource.id;
      } else {
        throw new Error("完形资料缺少正文数据");
      }
      const numbers = clozeBlankNumbers(nextCloze);
      const nextProgress = getClozeProgress(reviewTask.resourceId, nextClozeId, numbers);
      const nextTranslation = loadClozeTranslationProgress(reviewTask.resourceId, nextClozeId);
      const model = buildClozeSentenceModel(nextCloze, reviewTask.resourceId, nextClozeId);
      const answers = isOfficial
        ? officialAnswerFor("cloze-final-read", resource, nextClozeId, true) || {}
        : {};
      const priorityList = listPostCorrectionPriorityBlankNumbers(nextProgress, answers);
      const targetKeys = new Set(
        priorityTranslationTargets(model, priorityList, nextTranslation.targetOverrides || {})
          .map((sentence) => sentence.sentenceKey),
      );
      const active = getClozeReviewTask(taskKey);
      const started = startClozeReviewTask(taskKey);
      if (cancelled) return;
      resourceRef.current = resource;
      setTask(started || active || reviewTask);
      setCloze(nextCloze);
      setProgress(nextProgress);
      setTranslationProgress(nextTranslation);
      setSentenceModel(model);
      setTranslationTargetKeys(targetKeys);
      setOfficialAnswers(answers);
      setHasOfficial(isOfficial && Object.keys(answers).length > 0);
      setResourceTitle(resource.title || reviewTask.resourceId);
      setStatus("复习任务已就绪");
    })().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("复习任务读取失败");
      }
    });
    return () => { cancelled = true; };
  }, [taskKey]);

  const targetBlankIds = task?.targetBlankIds || [];
  const currentIndex = Math.min(Math.max(0, task?.currentIndex || 0), targetBlankIds.length);
  const activeBlank = targetBlankIds[currentIndex];
  const submittedIndex = submittedBlank != null ? targetBlankIds.indexOf(Number(submittedBlank)) : -1;
  const checkBlank = submittedIndex >= 0 ? targetBlankIds[submittedIndex] : null;
  const isLast = submitted
    ? submittedIndex >= targetBlankIds.length - 1
    : currentIndex >= targetBlankIds.length - 1;
  const isD7 = task?.type === TASK_TYPE_D7;
  const allDone = Boolean(
    task
    && !task.completedAt
    && targetBlankIds.length > 0
    && targetBlankIds.every((blankId) => task.attempts?.[blankId]),
  );

  const supportByBlank = useMemo(
    () => buildClozeSupportSignals({
      progress,
      sentenceModel,
      translationProgress,
      translationTargetKeys,
    }),
    [progress, sentenceModel, translationProgress, translationTargetKeys],
  );

  // 完成任务（D+1 完成时按方案 B materialize D+7）。只调用一次。
  // 刚提交最后一空时先展示 check 面板，由"完成复习"按钮触发；
  // 若用户在提交后直接退出，reload 时（justSubmitted=false）自动收尾。
  function finalizeCompletion() {
    if (finalizingRef.current || !task) return;
    finalizingRef.current = true;
    const completed = completeClozeReviewTask(task.taskKey);
    setTask(completed);
    if (task.type === TASK_TYPE_D1) {
      try {
        scheduleClozeD7Task({
          resourceId: task.resourceId,
          clozeId: task.clozeId,
          sourceDate: task.sourceDate,
          d1Task: completed,
          progress,
          officialAnswers,
          supportByBlank,
        });
      } catch {
        // D+7 安排失败不影响 D+1 完成
      }
    }
    setCompletedView(true);
  }

  useEffect(() => {
    if (!allDone || finalizingRef.current || justSubmittedRef.current) return;
    finalizeCompletion();
  }, [allDone]);

  if (status === "正在读取复习任务") {
    return <div className="cloze-review-page"><p className="cloze-review-loading">{status}…</p></div>;
  }
  if (error) {
    return (
      <div className="cloze-review-page">
        <div className="cloze-review-error">
          <h2>无法开始复习</h2>
          <p>{error}</p>
          <button type="button" className="primary-button" onClick={onClose}>返回</button>
        </div>
      </div>
    );
  }
  if (completedView) {
    return (
      <div className="cloze-review-page">
        <ReviewCompletion task={task} resourceTitle={resourceTitle} hasOfficial={hasOfficial} onClose={onClose} />
      </div>
    );
  }
  const checkOfficial = checkBlank != null
    ? (officialAnswers[checkBlank] || officialAnswers[String(checkBlank)] || "")
    : "";
  const record = checkBlank != null ? (task?.attempts?.[String(checkBlank)] || null) : null;
  const checkPanelReady = Boolean(submitted && checkBlank != null && record);

  if (!activeBlank || !task || !cloze) {
    if (checkPanelReady) {
      // 最后一空已提交：先展示 check 面板，由"完成复习"按钮收尾。
    } else if (allDone) {
      // 全部作答完成但任务尚未收尾：由 finalize effect 完成收尾。
      return <div className="cloze-review-page"><p className="cloze-review-loading">正在收尾复习…</p></div>;
    } else {
      return (
        <div className="cloze-review-page">
          <div className="cloze-review-error">
            <h2>复习任务为空</h2>
            <p>该任务没有需要复习的空位，可返回首页。</p>
            <button type="button" className="primary-button" onClick={onClose}>返回首页</button>
          </div>
        </div>
      );
    }
  }

  const attempt = progress?.attempts?.[activeBlank] || {};
  const official = officialAnswers[activeBlank] || officialAnswers[String(activeBlank)] || "";
  const reasons = task.targetReasons?.[String(activeBlank)] || [];

  function selectAnswer(answer) {
    setDraft((current) => ({ ...current, answer }));
  }

  function selectConfidence(confidence) {
    setDraft((current) => ({ ...current, confidence }));
  }

  function toggleBasis(basisId) {
    setDraft((current) => ({
      ...current,
      basisTypes: current.basisTypes.includes(basisId)
        ? current.basisTypes.filter((item) => item !== basisId)
        : [...current.basisTypes, basisId],
    }));
  }

  function submitAttempt() {
    if (!draft.answer) return;
    if (!hasOfficial && !draft.selfRating) return;
    const outcome = isD7
      ? computeD7AttemptOutcome({
        attempt: draft,
        officialAnswer: hasOfficial ? official : "",
        selfRating: hasOfficial ? undefined : draft.selfRating,
      })
      : computeD1AttemptOutcome({
        attempt: draft,
        officialAnswer: hasOfficial ? official : "",
        selfRating: hasOfficial ? undefined : draft.selfRating,
      });
    const nextTask = recordClozeReviewAttempt({
      taskKey: task.taskKey,
      blankId: activeBlank,
      attempt: {
        answer: draft.answer,
        confidence: draft.confidence,
        basisTypes: draft.basisTypes,
        selfRating: hasOfficial ? undefined : draft.selfRating,
        outcome,
      },
    });
    if (nextTask) setTask(nextTask);
    justSubmittedRef.current = true;
    setSubmittedBlank(String(activeBlank));
    setSubmitted(true);
  }

  function goNext() {
    if (isLast) {
      finalizeCompletion();
      return;
    }
    justSubmittedRef.current = false;
    setSubmitted(false);
    setSubmittedBlank(null);
    setExpandedContext(false);
    setDraft({ answer: "", confidence: "", basisTypes: [], selfRating: null });
  }

  const blank = (cloze.blanks || []).find((item) => Number(item.number) === activeBlank);

  return (
    <div className="cloze-review-page">
      {resourceRef.current?.importVersion && <MaterialAnswers resource={resourceRef.current} content={cloze} attempts={Object.fromEntries(Object.entries(task?.attempts || {}).map(([n, a]) => [n, a.answer || ""]))} label="复习作答" reveal={submitted} />}
      <header className="cloze-review-header">
        <div>
          <small>{isD7 ? "CLOZE D+7 CONFIRMATION" : "CLOZE D+1 RETRIEVAL"}</small>
          <h2>{isD7 ? "完形 D+7 确认" : "完形 D+1 复习"} · {resourceTitle}</h2>
          <span>第 {Math.min((submitted && submittedIndex >= 0 ? submittedIndex : currentIndex) + 1, targetBlankIds.length)} / {targetBlankIds.length} 空</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="退出复习">×</button>
      </header>

      {!submitted && (
        <div className="cloze-review-body">
          <div className="cloze-review-progress">
            {targetBlankIds.map((blankId, index) => (
              <span
                key={blankId}
                className={[
                  "cloze-review-dot",
                  task.attempts?.[blankId] ? "is-done" : "",
                  index === currentIndex ? "is-active" : "",
                ].filter(Boolean).join(" ")}
              />
            ))}
          </div>
          <div className="cloze-review-question">
            <div className="cloze-review-question-head">
              <strong>第 {activeBlank} 空</strong>
              <ReasonChips reasons={reasons} />
            </div>
            <BlankContext
              sentenceModel={sentenceModel}
              blankId={String(activeBlank)}
              expanded={expandedContext}
              onExpand={() => setExpandedContext((value) => !value)}
            />
            <div className="cloze-question-options">
              {(blank?.options || []).map((option) => (
                <button
                  type="button"
                  className={`cloze-option ${draft.answer === option.key ? "is-chosen" : ""}`}
                  key={option.key}
                  onClick={() => selectAnswer(option.key)}
                >
                  <b>{option.key}</b><span>{option.text || "（选项缺失）"}</span>
                </button>
              ))}
            </div>
            <div className="cloze-confidence-row" aria-label="判断程度">
              {["confident", "uncertain", "guess"].map((value) => (
                <button
                  type="button"
                  key={value}
                  className={draft.confidence === value ? "is-active" : ""}
                  onClick={() => selectConfidence(value)}
                >
                  {confidenceLabel(value)}
                </button>
              ))}
            </div>
            <div className="cloze-review-basis-row">
              <span>本次依据（可选）</span>
              <div>
                {Object.entries(CLOZE_BASIS_TYPE_LABELS).map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    className={draft.basisTypes.includes(id) ? "is-active" : ""}
                    onClick={() => toggleBasis(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!hasOfficial && (
              <div className="cloze-confidence-row" aria-label="本次自评">
                {[SELF_RATING_STABLE, SELF_RATING_UNSTABLE].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={draft.selfRating === value ? "is-active" : ""}
                    onClick={() => setDraft((current) => ({ ...current, selfRating: value }))}
                  >
                    {value === SELF_RATING_STABLE ? "稳定" : "仍不确定"}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={!draft.answer || (!hasOfficial && !draft.selfRating)}
              onClick={submitAttempt}
            >
              提交作答
            </button>
            {!hasOfficial && (
              <p className="cloze-review-no-answer-note">无官方答案：提交后只比较作答变化与自评，不判断对错。</p>
            )}
          </div>
        </div>
      )}

      {submitted && record && checkBlank != null && (
        <div className="cloze-review-body">
          <CheckPanel
            task={task}
            blankId={String(checkBlank)}
            draft={{ ...draft, answer: record.answer, confidence: record.confidence, basisTypes: record.basisTypes, selfRating: record.selfRating }}
            cloze={cloze}
            progress={progress}
            translationProgress={translationProgress}
            sentenceModel={sentenceModel}
            officialAnswer={hasOfficial ? checkOfficial : ""}
            hasOfficial={hasOfficial}
            onNext={goNext}
            isLast={isLast}
          />
        </div>
      )}
    </div>
  );
}

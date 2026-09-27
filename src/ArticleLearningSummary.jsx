import { useMemo, useState } from "react";
import { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } from "./aiTasks";
import {
  buildArticleLearningSummary,
  recordIsQuestionDiagnosis,
} from "./articleLearningSummary";
import { localDateKey } from "./readingReview";
import ModalShell from "./ui/Overlay";

const CONFIDENCE_LABELS = {
  low: "低置信度",
  medium: "中置信度",
  high: "高置信度",
};

const TYPE_LABELS = {
  [TASK_TRANSLATION_REVIEW]: "翻译批改",
  [TASK_QUESTION_DIAGNOSIS]: "阅读错因",
};

function sectionCount(summary) {
  const pkg = summary.reviewPackage;
  return pkg.sentences.length + pkg.questions.length + pkg.words.length + pkg.tags.length;
}

function TagChip({ name, count, onClick, active }) {
  return (
    <button
      type="button"
      className={`article-summary-tag ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {name}<em>×{count}</em>
    </button>
  );
}

function RecordLine({ record, onConfirmTag, onDismissTag, onJumpToSentence, onJumpToQuestion, passage }) {
  const isTranslation = record.taskType === TASK_TRANSLATION_REVIEW;
  const isDiagnosis = recordIsQuestionDiagnosis(record);
  const label = isTranslation
    ? (record.summary?.itemLabel || "逐句笔译")
    : `Q${record.questionNumber || "—"}`;
  const canJump = isTranslation
    ? /::p\d+s\d+$/.test(String(record.sentenceId || ""))
    : isDiagnosis && Boolean(
      (passage?.questions || []).find((question) => (
        String(question.number) === String(record.questionNumber)
        || String(question.id) === String(record.questionId)
      )),
    );

  function jump() {
    if (isTranslation) {
      const match = /::p(\d+)s(\d+)$/.exec(String(record.sentenceId || ""));
      if (match) onJumpToSentence?.({
        paragraphNumber: Number(match[1]),
        sentenceIndex: Number(match[2]) - 1,
      });
      return;
    }
    const question = (passage?.questions || []).find((item) => (
      String(item.number) === String(record.questionNumber)
      || String(item.id) === String(record.questionId)
    ));
    if (question) onJumpToQuestion?.(question);
  }

  return (
    <div className="article-summary-record">
      <div className="article-summary-record-main">
        <span className="article-summary-record-type">{TYPE_LABELS[record.taskType] || record.taskType}</span>
        <strong>{label}</strong>
        <small>{record.chapter || ""}</small>
        <div className="article-summary-record-tags">
          {(record.tags || [])
            .filter((tag) => tag.status !== "dismissed")
            .map((tag) => (
              <span
                className={`article-summary-mini-tag ${tag.status === "confirmed" ? "confirmed" : ""}`}
                key={`${record.id}-${tag.name}`}
              >
                {tag.name}
                <button
                  type="button"
                  title={tag.status === "confirmed" ? "取消确认" : "确认标签"}
                  onClick={() => onConfirmTag?.(record.id, tag.name)}
                >
                  ✓
                </button>
                <button
                  type="button"
                  title="否定标签"
                  onClick={() => onDismissTag?.(record.id, tag.name)}
                >
                  ×
                </button>
              </span>
            ))}
        </div>
      </div>
      <button
        type="button"
        className="article-summary-jump-button"
        disabled={!canJump}
        onClick={jump}
      >
        {isTranslation ? "回到原句" : "回到原题"}
      </button>
    </div>
  );
}

function DiagnosisDetail({ record, onConfirmTag, onDismissTag }) {
  if (!record) return null;
  const summary = record.summary || {};
  return (
    <div className="article-summary-diagnosis">
      <p>
        <span>题型</span>
        {summary.questionType || "未识别"}
        <span>置信度</span>
        {CONFIDENCE_LABELS[summary.confidence] || summary.confidence || "—"}
      </p>
      {summary.inferredCauseSummary && (
        <p><span>错因判断</span>{summary.inferredCauseSummary}</p>
      )}
      <div className="article-summary-record-tags">
        {(record.tags || [])
          .filter((tag) => tag.status !== "dismissed")
          .map((tag) => (
            <span
              className={`article-summary-mini-tag ${tag.status === "confirmed" ? "confirmed" : ""}`}
              key={`${record.id}-${tag.name}`}
            >
              {tag.name}
              <button type="button" onClick={() => onConfirmTag?.(record.id, tag.name)}>✓</button>
              <button type="button" onClick={() => onDismissTag?.(record.id, tag.name)}>×</button>
            </span>
          ))}
      </div>
    </div>
  );
}

export default function ArticleLearningSummaryPanel({
  open = true,
  initialTab = "summary",
  onClose,
  resource,
  passage,
  flow,
  storedFlowExists = false,
  translationProgress,
  evidenceStore,
  answers = {},
  redoAnswers = {},
  correctAnswers = {},
  reviewTasks = [],
  unknownWords = [],
  learningRecords = [],
  onContinueReading,
  onJumpToSentence,
  onJumpToQuestion,
  onMarkSentenceMastered,
  onRemoveUnknownWord,
  onConfirmTag,
  onDismissTag,
  onViewEvidence,
  onStartReview,
}) {
  const [tab, setTab] = useState(initialTab === "review" ? "review" : "summary");
  const [expandedTag, setExpandedTag] = useState(null);
  const [expandedDiagnosis, setExpandedDiagnosis] = useState(null);
  const [showAllWords, setShowAllWords] = useState(false);
  const [showAllSentences, setShowAllSentences] = useState(false);

  const summary = useMemo(
    () => buildArticleLearningSummary({
      resource,
      passage,
      flow,
      storedFlowExists,
      translationProgress,
      evidenceStore,
      firstAnswers: answers,
      redoAnswers,
      correctAnswers,
      reviewTasks,
      unknownWords,
      learningRecords,
      today: localDateKey(),
    }),
    [
      answers,
      correctAnswers,
      evidenceStore,
      flow,
      learningRecords,
      passage,
      redoAnswers,
      resource,
      reviewTasks,
      storedFlowExists,
      translationProgress,
      unknownWords,
    ],
  );

  if (!open) return null;

  const pkg = summary.reviewPackage;
  const totalCount = sectionCount(summary);
  const questions = summary.questions;
  const review = summary.review;
  const visibleSentences = showAllSentences ? pkg.sentences : pkg.sentences.slice(0, 8);
  const visibleWords = showAllWords ? pkg.words : pkg.words.slice(0, 8);

  return (
    <ModalShell open onClose={onClose} className="article-summary-backdrop" label="本篇学习结果">
      <div
        className="article-summary-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="article-summary-header">
          <div>
            <small>ARTICLE LEARNING SUMMARY</small>
            <h2>本篇学习结果</h2>
            <p>{resource.title} · {passage.label}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭学习结果">×</button>
        </header>

        <nav className="article-summary-tabs" aria-label="学习结果视图">
          <button
            type="button"
            className={tab === "summary" ? "active" : ""}
            onClick={() => setTab("summary")}
          >
            学习结果
          </button>
          <button
            type="button"
            className={tab === "review" ? "active" : ""}
            onClick={() => setTab("review")}
          >
            复习这篇{totalCount > 0 ? ` · ${totalCount}` : ""}
          </button>
        </nav>

        {tab === "summary" ? (
          <div className="article-summary-sections">
            <section className="article-summary-section">
              <h3>精读流程</h3>
              {summary.flow.completed ? (
                <p className="article-summary-value done">
                  ✓ 已完成{summary.flow.historyOnly ? " · 历史记录" : ""}{summary.flow.skippedStageLabels?.length ? ` · 已跳过：${summary.flow.skippedStageLabels.join("、")}` : ""}
                </p>
              ) : (
                <div className="article-summary-value">
                  进行中 · 当前「{summary.flow.currentStageLabel || "导读"}」
                  {onContinueReading && (
                    <button type="button" className="article-summary-action" onClick={onContinueReading}>
                      继续精读
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="article-summary-section">
              <h3>逐句笔译</h3>
              {summary.translation.hasSentenceRecords ? (
                <div className="article-summary-value">
                  <strong>{summary.translation.total} 句</strong>
                  <span>已订正 {summary.translation.correctedCount}</span>
                  <span>已掌握 {summary.translation.masteredCount}</span>
                  {summary.translation.needsReviewCount > 0 ? (
                    <button
                      type="button"
                      className="article-summary-action"
                      onClick={() => setTab("review")}
                    >
                      需复盘 {summary.translation.needsReviewCount}
                    </button>
                  ) : (
                    <span className="article-summary-calm">无需复盘</span>
                  )}
                </div>
              ) : (
                <p className="article-summary-value calm">暂无句级记录</p>
              )}
            </section>

            {questions.hasQuestions && (
              <section className="article-summary-section">
                <h3>阅读题</h3>
                {!questions.hasAnswerKey ? (
                  <p className="article-summary-value calm">
                    共 {questions.hasQuestions ? passage.questions.length : 0} 题 · 暂无官方答案
                  </p>
                ) : (
                  <div className="article-summary-value">
                    <strong>第一次 {questions.first.correct} / {questions.first.total}</strong>
                    <strong>重做 {questions.redo.correct} / {questions.redo.total}</strong>
                    {questions.answerChangedCount > 0 && (
                      <span>答案改变 {questions.answerChangedCount} 题</span>
                    )}
                    {questions.evidenceChangedCount > 0 && (
                      <span>证据改变 {questions.evidenceChangedCount} 题</span>
                    )}
                    {questions.correctedCount > 0 && (
                      <span>第一次错、重做已纠正 {questions.correctedCount} 题</span>
                    )}
                    {!questions.hasEvidenceRecords && (
                      <span className="article-summary-calm">没有证据链记录</span>
                    )}
                    {questions.reviewNeeded.length > 0 ? (
                      <button
                        type="button"
                        className="article-summary-action"
                        onClick={() => setTab("review")}
                      >
                        仍需关注 {questions.reviewNeeded.length} 题
                      </button>
                    ) : (
                      <span className="article-summary-calm">暂无待复盘题</span>
                    )}
                  </div>
                )}
              </section>
            )}

            {summary.unknownWords.count > 0 && (
              <section className="article-summary-section">
                <h3>陌生词</h3>
                <div className="article-summary-value">
                  <strong>{summary.unknownWords.count}</strong>
                  <button
                    type="button"
                    className="article-summary-action"
                    onClick={() => setTab("review")}
                  >
                    查看
                  </button>
                </div>
              </section>
            )}

            <section className="article-summary-section">
              <h3>学习档案</h3>
              {summary.learning.records.length === 0 ? (
                <p className="article-summary-value calm">暂无 AI 学习记录</p>
              ) : (
                <div className="article-summary-learning">
                  {summary.learning.reliableTags.length > 0 ? (
                    <div className="article-summary-tags">
                      {summary.learning.reliableTags.map((tag) => (
                        <TagChip
                          key={tag.name}
                          name={tag.name}
                          count={tag.count}
                          active={expandedTag === tag.name}
                          onClick={() => setExpandedTag(
                            expandedTag === tag.name ? null : tag.name,
                          )}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="article-summary-value calm">暂无可靠错误标签</p>
                  )}
                  {summary.learning.pendingTagCount > 0 && (
                    <p className="article-summary-pending-note">
                      另有 {summary.learning.pendingTagCount} 条低置信度 AI 推测待确认
                    </p>
                  )}
                  {expandedTag && (
                    <div className="article-summary-record-list">
                      {summary.learning.reliableTags
                        .find((tag) => tag.name === expandedTag)
                        ?.records.map((record) => (
                          <RecordLine
                            key={record.id}
                            record={record}
                            passage={passage}
                            onConfirmTag={onConfirmTag}
                            onDismissTag={onDismissTag}
                            onJumpToSentence={onJumpToSentence}
                            onJumpToQuestion={onJumpToQuestion}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="article-summary-section">
              <h3>次日复读</h3>
              <div className="article-summary-value">
                <span>{review.label}</span>
                {review.nextDayTask
                  && ["due", "overdue", "in_progress"].includes(review.nextDayStatus)
                  && onStartReview && (
                    <button
                      type="button"
                      className="article-summary-action"
                      onClick={() => onStartReview(review.nextDayTask)}
                    >
                      开始复读
                    </button>
                  )}
              </div>
              {review.recheckTasks.length > 0 && (
                <div className="article-summary-recheck">
                  {review.recheckTasks.map((item) => (
                    <span key={item.task.taskKey}>
                      困难句复查任务 · {item.sentenceCount} 句 · {item.status === "scheduled" ? "已安排" : item.status}
                    </span>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="article-summary-review">
            {totalCount === 0 ? (
              <div className="article-summary-review-empty">
                <span>✓</span>
                <h3>没有待复盘内容</h3>
                <p>困难句、错题、陌生词与可靠错误标签都已处理，这篇文章暂时不需要复习。</p>
              </div>
            ) : (
              <>
                {pkg.sentences.length > 0 && (
                  <section className="article-summary-section">
                    <h3>困难句 <em>{pkg.sentences.length}</em></h3>
                    <div className="article-summary-list">
                      {visibleSentences.map((item) => (
                        <article className="article-summary-item" key={item.key}>
                          <span className="article-summary-item-label">
                            P{item.paragraphNumber} · S{item.sentenceIndex + 1}
                          </span>
                          <p>{item.sentenceText}</p>
                          <div className="article-summary-item-actions">
                            <button
                              type="button"
                              className="article-summary-action"
                              onClick={() => onJumpToSentence?.({
                                paragraphNumber: item.paragraphNumber,
                                sentenceIndex: item.sentenceIndex,
                              })}
                            >
                              回到原句
                            </button>
                            <button
                              type="button"
                              className="article-summary-action primary"
                              onClick={() => onMarkSentenceMastered?.(item.key)}
                            >
                              现在已掌握
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                    {pkg.sentences.length > visibleSentences.length && (
                      <button
                        type="button"
                        className="article-summary-more"
                        onClick={() => setShowAllSentences((value) => !value)}
                      >
                        {showAllSentences ? "收起" : `还有 ${pkg.sentences.length - visibleSentences.length} 句`}
                      </button>
                    )}
                  </section>
                )}

                {pkg.questions.length > 0 && (
                  <section className="article-summary-section">
                    <h3>仍需关注的题 <em>{pkg.questions.length}</em></h3>
                    <div className="article-summary-list">
                      {pkg.questions.map((item) => {
                        const diagnosis = summary.learning.records.find((record) => (
                          recordIsQuestionDiagnosis(record)
                          && (
                            String(record.questionNumber) === String(item.question.number)
                            || String(record.questionId) === String(item.question.id)
                          )
                        ));
                        return (
                          <article className="article-summary-item" key={item.key}>
                            <span className="article-summary-item-label">
                              Q{item.question.number}
                              {item.status === "review-wrong" ? " · 次日复读再次错误" : " · 重做仍错误"}
                            </span>
                            <p>{item.question.stem}</p>
                            <div className="article-summary-item-actions">
                              <button
                                type="button"
                                className="article-summary-action"
                                onClick={() => onJumpToQuestion?.(item.question)}
                              >
                                回到原题
                              </button>
                              {onViewEvidence && (
                                <button
                                  type="button"
                                  className="article-summary-action"
                                  onClick={() => onViewEvidence(item.question, "redo")}
                                >
                                  查看我的证据
                                </button>
                              )}
                              <button
                                type="button"
                                className="article-summary-action"
                                onClick={() => setExpandedDiagnosis(
                                  expandedDiagnosis === item.key ? null : item.key,
                                )}
                              >
                                查看诊断
                              </button>
                            </div>
                            {expandedDiagnosis === item.key && (
                              <DiagnosisDetail
                                record={diagnosis}
                                onConfirmTag={onConfirmTag}
                                onDismissTag={onDismissTag}
                              />
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {pkg.words.length > 0 && (
                  <section className="article-summary-section">
                    <h3>陌生词 <em>{pkg.words.length}</em></h3>
                    <div className="article-summary-list">
                      {visibleWords.map((word) => (
                        <article className="article-summary-item article-summary-word" key={word.id}>
                          <strong>{word.word || word.normalizedWord}</strong>
                          <span>{word.meaning || "暂无释义"}</span>
                          <button
                            type="button"
                            className="article-summary-action"
                            onClick={() => onRemoveUnknownWord?.(word.id)}
                          >
                            移出陌生词
                          </button>
                        </article>
                      ))}
                    </div>
                    {pkg.words.length > visibleWords.length && (
                      <button
                        type="button"
                        className="article-summary-more"
                        onClick={() => setShowAllWords((value) => !value)}
                      >
                        {showAllWords ? "收起" : `还有 ${pkg.words.length - visibleWords.length} 个`}
                      </button>
                    )}
                  </section>
                )}

                {pkg.tags.length > 0 && (
                  <section className="article-summary-section">
                    <h3>可靠错误标签 <em>{pkg.tags.length}</em></h3>
                    <div className="article-summary-tags">
                      {pkg.tags.map((tag) => (
                        <TagChip
                          key={tag.name}
                          name={tag.name}
                          count={tag.count}
                          active={expandedTag === tag.name}
                          onClick={() => setExpandedTag(
                            expandedTag === tag.name ? null : tag.name,
                          )}
                        />
                      ))}
                    </div>
                    {expandedTag && (
                      <div className="article-summary-record-list">
                        {pkg.tags
                          .find((tag) => tag.name === expandedTag)
                          ?.records.map((record) => (
                            <RecordLine
                              key={record.id}
                              record={record}
                              passage={passage}
                              onConfirmTag={onConfirmTag}
                              onDismissTag={onDismissTag}
                              onJumpToSentence={onJumpToSentence}
                              onJumpToQuestion={onJumpToQuestion}
                            />
                          ))}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

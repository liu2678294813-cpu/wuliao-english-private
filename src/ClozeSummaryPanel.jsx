// 本篇完形学习结果（R6）—— 纯派生 projection UI。
//
// 三个入口共用同一份详情：
//   1) 完成全文回读（cloze-final-read）后自动展示；
//   2) 完形资料卡"学习结果"；
//   3) 完形长期档案记录行"学习结果"。
//
// 原则：
//   - 不创建任何新事实存储；不生成 / 重启任何长期复习任务（历史数据零 backfill）。
//   - 有官方答案才显示 correctness 类表述；无答案资料不出现
//     正确/错误/错题/正确率/高置信错误/改答后错。
//   - AI history 只按稳定 metadata 关联，显示为"AI 当时的推测"链接，
//     不进入统计；无 metadata 的旧记录不关联。
//   - 复习直接复用现有 ClozeReviewSession（onStartReview）；
//     AI 历史查看复用现有 AiFloatWindow（openHistoryId 局部 prop 接线）。

import { useEffect, useMemo, useRef, useState } from "react";
import { postgraduateClozeResources } from "./library";
import { listCustomPdfs, listUnknownWords } from "./storage";
import { listAiHistory } from "./ai";
import { CLOZE_BASIS_TYPE_LABELS, getClozeProgress } from "./clozeProgress";
import { loadClozeTranslationProgress, translationEntryFor } from "./clozeTranslationProgress";
import { verifiedOfficialAnswers } from "./import/answers.js";
import { findClozeReviewTasksForEntry, listCompletedClozeRecords } from "./clozeLearningArchive";
import { listClozeReviewTasks } from "./clozeReview";
import {
  buildClozeLearningSummary,
  CLOZE_REVIEW_REASON_LABELS,
  clozeYearOfResourceId,
} from "./clozeLearningSummary";
import { buildClozeSentenceModel } from "./clozeSentences";
import { loadOfficialCloze } from "./library";
import { clozeAiTaskLabel } from "./clozeAiTasks";
import { localDateKey } from "./readingReview";
import ModalShell from "./ui/Overlay";
import { BACK_PRIORITY } from "./ui/backController";
import AiFloatWindow from "./AiFloatWindow.jsx";
import MaterialAnswers from "./import/MaterialAnswers.jsx";

const CONFIDENCE_LABELS = { confident: "确定", uncertain: "犹豫", guess: "猜测" };

function confidenceLabel(value) {
  return CONFIDENCE_LABELS[value] || "—";
}

function dateLabel(value) {
  if (!value) return "—";
  return new Date(Number(value)).toLocaleDateString("zh-CN");
}

function dateKeyLabel(value) {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (match) return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
  return String(value);
}

function translationStatusLabel(entry) {
  if (!entry) return "—";
  if (entry.status === "corrected") return "已订正";
  if (entry.status === "translated") return "已笔译，待订正";
  return "待笔译";
}

function ReasonChips({ reasons }) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (!list.length) return null;
  return (
    <span className="cloze-summary-reasons">
      {list.map((reason) => (
        <em key={reason}>{CLOZE_REVIEW_REASON_LABELS[reason] || reason}</em>
      ))}
    </span>
  );
}

const PRIORITY_STATUS_LABELS = {
  "d7-unresolved": "D+7 仍未稳定",
  "task-overdue": "复习已逾期",
  "task-due": "复习今日到期",
  "task-in_progress": "复习进行中",
  "d1-unresolved": "D+1 仍未稳定",
  "high-confidence-wrong": "当天高置信错误",
  "final-wrong": "当天最终仍错",
  "translation-unresolved": "译文仍未订正",
};

function MetricCell({ label, value, tone = "" }) {
  return (
    <div className={`cloze-summary-metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TaskReviewCard({ title, view, onStartReview, onViewUnstable }) {
  const action =
    view.status === "due" || view.status === "overdue" || view.status === "in_progress"
      ? (onStartReview ? (
        <button type="button" className="cloze-summary-action primary" onClick={onStartReview}>
          {view.status === "in_progress" ? `继续 ${title}` : `开始 ${title}`}
        </button>
      ) : null)
      : null;
  const future = view.status === "scheduled" && view.dueDate;
  return (
    <section className="cloze-summary-review-card">
      <h3>{title}</h3>
      {!view.exists ? (
        <p className="cloze-summary-calm">暂未生成 {title} 任务</p>
      ) : (
        <div className="cloze-summary-review-body">
          <p>
            目标 {view.targetCount} 空 · 已完成 {view.completedCount}/{view.targetCount}
            <span> · 已稳定 {view.resolvedCount}</span>
            {view.unresolvedCount > 0 && <span className="is-warn"> · 仍不稳定 {view.unresolvedCount}</span>}
          </p>
          <p className="cloze-summary-review-status">
            {view.status === "due" && "今天到期"}
            {view.status === "overdue" && "已逾期"}
            {view.status === "in_progress" && "进行中"}
            {view.status === "completed" && "已完成"}
            {future && `${dateKeyLabel(view.dueDate)} 到期`}
            {view.status === "scheduled" && !future && "已安排"}
          </p>
          {action}
          {view.status === "completed" && view.unresolvedCount > 0 && onViewUnstable && (
            <button type="button" className="cloze-summary-action" onClick={onViewUnstable}>
              查看仍不稳定空
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function BlankDetail({ blank, sentenceModel, translationProgress, onOpenAiHistory, highlighted = false }) {
  const sentence = sentenceModel?.blankToSentence?.[blank.blankId];
  const textEntry = sentence ? translationEntryFor(translationProgress, sentence.sentenceKey) : null;
  const dayFacts = [];
  if (blank.highConfidenceWrong) dayFacts.push("高置信错误");
  if (blank.changedToWrong) dayFacts.push("改答后错");
  if (blank.selfCorrected) dayFacts.push("自查纠正");
  if (blank.changed) dayFacts.push("改答");

  return (
    <article
      className={`cloze-summary-blank ${highlighted ? "is-highlighted" : ""}`}
      id={`cloze-summary-blank-${blank.blankId}`}
    >
      <div className="cloze-summary-blank-head">
        <strong>第 {blank.number} 空</strong>
        <span className={`cloze-summary-blank-state ${blank.resolved == null ? "" : blank.resolved ? "is-stable" : "is-unstable"}`}>
          {blank.resolved == null
            ? "未进入长期复习"
            : blank.resolved ? "长期已稳定" : "仍未稳定"}
        </span>
      </div>
      <div className="cloze-summary-blank-grid">
        <p><span>初做</span>{blank.firstAnswer ? `${blank.firstAnswer} · ${confidenceLabel(blank.firstConfidence)}` : "—"}</p>
        <p><span>复查</span>{blank.reviewAnswer ? `${blank.reviewAnswer} · ${confidenceLabel(blank.reviewConfidence)}` : "—"}</p>
        <p><span>最终</span>{blank.reviewAnswer || blank.firstAnswer || "—"}</p>
        {blank.officialAnswer && (
          <p className="cloze-summary-blank-official">
            <span>官方答案</span>
            {blank.officialAnswer}
            {blank.finalWrong ? <em>· 当天错</em> : blank.finalCorrect ? <em>· 当天对</em> : ""}
          </p>
        )}
      </div>
      {dayFacts.length > 0 && (
        <p className="cloze-summary-blank-facts"><span>当天</span>{dayFacts.join(" · ")}</p>
      )}
      {blank.prediction && <p className="cloze-summary-blank-line"><span>Prediction</span>{blank.prediction}</p>}
      {blank.basisTypes.length > 0 && (
        <p className="cloze-summary-blank-line">
          <span>依据</span>{blank.basisTypes.map((id) => CLOZE_BASIS_TYPE_LABELS[id] || id).join("、")}
        </p>
      )}
      <p className="cloze-summary-blank-line">
        <span>定位</span>{blank.referencesCount > 0 ? `${blank.referencesCount} 处` : "无"}
      </p>
      <p className="cloze-summary-blank-line">
        <span>重点句笔译</span>{translationStatusLabel(textEntry)}
      </p>
      <p className="cloze-summary-blank-line">
        <span>D+1</span>
        {blank.inD1
          ? `${blank.d1Outcome === "correct" ? "对" : blank.d1Outcome === "wrong" ? "错" : blank.d1Outcome === "stable" ? "稳定" : blank.d1Outcome === "unstable" ? "不稳" : "未作答"}${blank.d1ReviewedAt ? ` · ${dateLabel(blank.d1ReviewedAt)}` : ""}`
          : "未进入"}
      </p>
      <p className="cloze-summary-blank-line">
        <span>D+7</span>
        {blank.inD7
          ? `${blank.d7Outcome === "correct" ? "对" : blank.d7Outcome === "wrong" ? "错" : blank.d7Outcome === "stable" ? "稳定" : blank.d7Outcome === "unstable" ? "不稳" : "未作答"}${blank.d7ReviewedAt ? ` · ${dateLabel(blank.d7ReviewedAt)}` : ""}`
          : "未进入"}
      </p>
      {blank.aiHistory.length > 0 && (
        <div className="cloze-summary-blank-ai">
          <span className="cloze-summary-blank-ai-title">AI 当时的推测 · {blank.aiHistory.length} 条</span>
          <div className="cloze-summary-blank-ai-list">
            {blank.aiHistory.map((item) => (
              <button
                type="button"
                key={item.id}
                className="cloze-summary-blank-ai-link"
                onClick={() => onOpenAiHistory?.(item.id)}
              >
                {clozeAiTaskLabel(item.taskType) || item.taskType || "AI 对话"}
                <small>{dateLabel(item.updatedAt || item.createdAt)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export default function ClozeSummaryPanel({
  onClose,
  resourceId,
  clozeId,
  completedAt = null,
  title = "",
  onStartReview = null,
}) {
  const [resource, setResource] = useState(() => (
    postgraduateClozeResources.find((item) => item.id === resourceId) || null
  ));
  const [resolvedCompletedAt, setResolvedCompletedAt] = useState(completedAt);
  const [reviewTasks, setReviewTasks] = useState([]);
  const [unknownWords, setUnknownWords] = useState([]);
  const [aiHistoryRecords, setAiHistoryRecords] = useState([]);
  const [clozeDetail, setClozeDetail] = useState(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [blanksExpanded, setBlanksExpanded] = useState(false);
  const [unstableOnly, setUnstableOnly] = useState(false);
  const [highlightBlank, setHighlightBlank] = useState("");
  const [openAiHistoryId, setOpenAiHistoryId] = useState("");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const official = postgraduateClozeResources.find((item) => item.id === resourceId);
      let resolved = official || null;
      if (!resolved) {
        try {
          const custom = await listCustomPdfs();
          resolved = custom.find((item) => item.id === resourceId) || null;
        } catch {
          resolved = null;
        }
      }
      if (cancelled) return;
      setResource(resolved);
      if (completedAt == null && resolved) {
        const latest = listCompletedClozeRecords().find((record) => (
          String(record.resourceId) === String(resourceId)
          && String(record.clozeId) === String(clozeId || resourceId)
        ));
        if (latest) setResolvedCompletedAt(latest.completedAt);
      }
    })();
    return () => { cancelled = true; };
  }, [resourceId, clozeId, completedAt]);

  useEffect(() => {
    const refresh = () => {
      setReviewTasks(listClozeReviewTasks());
      setUnknownWords([]);
      setAiHistoryRecords(listAiHistory());
      listUnknownWords().then((items) => {
        if (aliveRef.current) setUnknownWords(Array.isArray(items) ? items : []);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("wuliao:cloze-review-tasks-updated", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("wuliao:account-changed", refresh);
    return () => {
      window.removeEventListener("wuliao:cloze-review-tasks-updated", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("wuliao:account-changed", refresh);
    };
  }, []);

  const year = useMemo(
    () => Number(resource?.year) || clozeYearOfResourceId(resourceId) || 0,
    [resource, resourceId],
  );

  const taskPair = useMemo(() => {
    const sourceDate = resolvedCompletedAt ? localDateKey(Number(resolvedCompletedAt)) : "";
    const matches = findClozeReviewTasksForEntry(reviewTasks, resourceId, clozeId || resourceId, sourceDate);
    return matches;
  }, [reviewTasks, resourceId, clozeId, resolvedCompletedAt]);

  const summary = useMemo(() => {
    const officialAnswers = verifiedOfficialAnswers(resource, "cloze");
    return buildClozeLearningSummary({
      resource,
      resourceId,
      clozeId: clozeId || resourceId,
      completedAt: Number(resolvedCompletedAt) || 0,
      progress: getClozeProgress(resourceId, clozeId || resourceId),
      translationProgress: loadClozeTranslationProgress(resourceId, clozeId || resourceId),
      d1Task: taskPair.d1Task,
      d7Task: taskPair.d7Task,
      officialAnswers,
      unknownWords,
      aiHistoryRecords,
    });
  }, [resource, resourceId, clozeId, resolvedCompletedAt, taskPair, unknownWords, aiHistoryRecords, year]);

  // 逐空详情按需加载正文模型（选项/句子上下文不进入总览扫描）。
  useEffect(() => {
    if (!blanksExpanded || clozeDetail || detailFailed || detailLoading) return undefined;
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      let cloze = null;
      if (resource?.analysis?.clozes?.[0]) {
        cloze = resource.analysis.clozes[0];
      } else if (resource?.clozeSource) {
        cloze = await loadOfficialCloze(resource);
      }
      if (cancelled || !cloze) return;
      setClozeDetail({
        sentenceModel: buildClozeSentenceModel(cloze, resourceId, clozeId || resourceId),
        translationProgress: loadClozeTranslationProgress(resourceId, clozeId || resourceId),
      });
    })().catch(() => {
      if (!cancelled) setDetailFailed(true);
    }).finally(() => {
      if (!cancelled) setDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [blanksExpanded, clozeDetail, detailFailed, detailLoading, resource, resourceId, clozeId]);

  const c = summary.counts;
  const review = summary.review;
  const priorityItems = summary.priorityReview;

  const visibleBlanks = useMemo(() => {
    const list = summary.blanks;
    if (!unstableOnly) return list;
    return list.filter((blank) => (blank.inD1 || blank.inD7) && blank.resolved === false);
  }, [summary.blanks, unstableOnly]);

  const showDate = summary.completedAt ? dateLabel(summary.completedAt) : "";

  function openBlankDetail(blankId) {
    setBlanksExpanded(true);
    setUnstableOnly(false);
    setHighlightBlank(String(blankId));
    window.setTimeout(() => {
      document.getElementById(`cloze-summary-blank-${blankId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }

  return (
    <ModalShell open onClose={onClose} className="cloze-summary-backdrop" label="本篇完形学习结果">
      <div className="cloze-summary-panel" onClick={(event) => event.stopPropagation()}>
        <header className="cloze-summary-header">
          <div>
            <small>CLOZE LEARNING SUMMARY</small>
            <h2>本篇学习结果</h2>
            <p>{summary.title || resourceId}{summary.year ? ` · ${summary.year}` : ""}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭学习结果">×</button>
        </header>

        <div className="cloze-summary-body">
          {resource?.importVersion && resource.analysis?.clozes?.[0] && <MaterialAnswers resource={resource} content={resource.analysis.clozes[0]} attempts={Object.fromEntries(Object.entries(getClozeProgress(resourceId, clozeId || resourceId)?.attempts || {}).map(([n, a]) => [n, a.reviewAnswer || a.firstAnswer || ""]))} label="复查作答" reveal />}
          <section className="cloze-summary-section">
            <h3>训练状态</h3>
            <div className="cloze-summary-topline">
              <span>完成日期 {showDate}</span>
              <span>训练状态：已完成</span>
              <span>长期复习：
                {review.d1.exists || review.d7.exists
                  ? review.d1.status === "completed" && review.d7.status === "completed"
                    ? "已稳定"
                    : "进行中"
                  : "暂无长期任务"}
              </span>
            </div>
            {!summary.hasOfficial && (
              <p className="cloze-summary-answerless-note">
                此资料没有可靠官方答案，以下只展示你的作答变化、自评与复习状态。
              </p>
            )}
          </section>

          <section className="cloze-summary-section">
            <h3>当天作答表现</h3>
            {summary.hasOfficial ? (
              <div className="cloze-summary-metrics">
                <MetricCell value={`${c.finalCorrect ?? 0}/${summary.blanks.length}`} label="最终正确" />
                <MetricCell value={c.changed} label="改答" />
                <MetricCell value={c.selfCorrected ?? 0} label="自查纠正" />
                <MetricCell value={c.changedToWrong ?? 0} label="改答后错" />
                <MetricCell value={c.highConfidenceWrong ?? 0} label="高置信错误" tone="is-warn" />
              </div>
            ) : (
              <div className="cloze-summary-metrics">
                <MetricCell value={`${c.firstCompleted}/${summary.blanks.length}`} label="初做完成" />
                <MetricCell value={`${c.reviewCompleted}/${summary.blanks.length}`} label="复查完成" />
                <MetricCell value={c.changed} label="改答" />
                <MetricCell value={summary.confidence.confident} label="高置信作答" />
                <MetricCell value={summary.confidence.uncertain} label="犹豫" />
                <MetricCell value={summary.confidence.guesses} label="猜测" />
              </div>
            )}
          </section>

          <section className="cloze-summary-section">
            <h3>精析完成度</h3>
            <div className="cloze-summary-facts">
              <span>逐空精析 {summary.analysis.analyzed}/{summary.analysis.total}</span>
              <span>已写 prediction {summary.analysis.predictions}</span>
              <span>已标依据 {summary.analysis.withBasis}</span>
              <span>已做定位 {summary.analysis.withReferences}</span>
              <span>重点句笔译 {summary.analysis.translation.translated}</span>
              <span>重点句已订正 {summary.analysis.translation.corrected}</span>
              <span>陌生词 {summary.unknownWords.count}</span>
            </div>
          </section>

          {priorityItems.length > 0 && (
            <section className="cloze-summary-section">
              <h3>优先复盘 <span>{priorityItems.length}</span></h3>
              <div className="cloze-summary-priority">
                {priorityItems.map((item) => (
                  <button
                    type="button"
                    className="cloze-summary-priority-item"
                    key={item.key}
                    onClick={() => openBlankDetail(item.blankId)}
                  >
                    <strong>{item.title} · 第 {item.blankId} 空</strong>
                    <span>{PRIORITY_STATUS_LABELS[item.statusKey] || item.statusKey}</span>
                    <ReasonChips reasons={item.reasons} />
                    {item.lastReviewedAt ? <small>最后复习 {dateLabel(item.lastReviewedAt)}</small> : null}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="cloze-summary-section">
            <h3>长期复习</h3>
            <div className="cloze-summary-review-grid">
              <TaskReviewCard
                title="D+1"
                view={review.d1}
                onStartReview={review.d1.task ? () => onStartReview?.(review.d1.task) : null}
              />
              <TaskReviewCard
                title="D+7"
                view={review.d7}
                onViewUnstable={review.d7.unresolvedCount > 0 ? () => { setBlanksExpanded(true); setUnstableOnly(true); } : null}
                onStartReview={review.d7.task ? () => onStartReview?.(review.d7.task) : null}
              />
            </div>
            <p className="cloze-summary-calm">
              长期已稳定 {review.longTerm.stable}/{review.longTerm.total}
              {review.longTerm.lastReviewedAt ? ` · 最后复习 ${dateLabel(review.longTerm.lastReviewedAt)}` : ""}
            </p>
          </section>

          <section className="cloze-summary-section">
            <div className="cloze-summary-blanks-head">
              <h3>逐空详情 <span>{summary.blanks.length}</span></h3>
              <div className="cloze-summary-blanks-tools">
                <button
                  type="button"
                  className={unstableOnly ? "is-active" : ""}
                  onClick={() => setUnstableOnly((value) => !value)}
                >
                  {unstableOnly ? "全部" : "只看仍不稳定"}
                </button>
                <button type="button" onClick={() => { setBlanksExpanded((value) => !value); setHighlightBlank(""); }}>
                  {blanksExpanded ? "收起" : "展开"}
                </button>
              </div>
            </div>
            {blanksExpanded && (
              <div className="cloze-summary-blanks">
                {detailFailed && (
                  <p className="cloze-summary-detail-failed">
                    正文模型读取失败。
                    <button type="button" onClick={() => { setDetailFailed(false); setClozeDetail(null); }}>重新加载</button>
                  </p>
                )}
                {visibleBlanks.map((blank) => (
                  <BlankDetail
                    key={blank.blankId}
                    blank={blank}
                    sentenceModel={clozeDetail?.sentenceModel || null}
                    translationProgress={clozeDetail?.translationProgress || null}
                    onOpenAiHistory={(historyId) => setOpenAiHistoryId(historyId)}
                    highlighted={highlightBlank === String(blank.blankId)}
                  />
                ))}
                {unstableOnly && visibleBlanks.length === 0 && (
                  <p className="cloze-summary-calm">没有仍不稳定的空位。</p>
                )}
              </div>
            )}
            {summary.aiHistoryTotal > 0 && (
              <p className="cloze-summary-ai-note">
                空位中的 AI 记录为 AI 当时的推测，不作为长期事实统计。
              </p>
            )}
          </section>
        </div>
      </div>

      <AiFloatWindow
        mode="default"
        available={false}
        openHistoryId={openAiHistoryId}
        onHistoryOpenHandled={() => setOpenAiHistoryId("")}
        backPriorityOverride={BACK_PRIORITY.modal}
      />
    </ModalShell>
  );
}

// 完形长期学习档案（E 阶段 + R6）—— derived projection UI。
//
// 只展示派生结果：
//   - 数据源 = cloze-flow 完成记录 + clozeProgress + clozeReview sidecar +
//     clozeTranslationProgress；
//   - 有官方答案才显示 correctness 类统计；无答案资料不出现
//     accuracy / 错题 / correct / wrong / 高置信错误 / 改答后错；
//   - 总览 correctness 聚合分母只包含有官方答案的资料；
//   - 优先复盘严格基于事实（D+1/D+7 状态、目标原因快照、当天风险），
//     不使用 AI 推测，不用 basisTypes 推断能力；
//   - 不生成任何长期复习任务（历史数据零 backfill）；
//   - "学习结果"打开与资料卡 / 完成页完全相同的本篇结果页（单一详情 UI）。

import { useEffect, useMemo, useState } from "react";
import { postgraduateClozeResources } from "./library";
import { listCustomPdfs } from "./storage";
import {
  buildClozeArchiveEntry,
  basisDistributionInReviewTargets,
  findClozeReviewTasksForEntry,
  listCompletedClozeRecords,
} from "./clozeLearningArchive";
import {
  buildClozeArchiveOverview,
  buildClozePriorityReviewItems,
  buildClozeRecent7,
  CLOZE_REVIEW_REASON_LABELS,
  filterClozeArchiveEntries,
} from "./clozeLearningSummary";
import {
  CLOZE_BASIS_TYPE_LABELS,
  getClozeProgress,
} from "./clozeProgress";
import { loadClozeTranslationProgress, translationEntryFor } from "./clozeTranslationProgress";
import { verifiedOfficialAnswers } from "./import/answers.js";
import MaterialAnswers from "./import/MaterialAnswers.jsx";
import { listClozeReviewTasks } from "./clozeReview";
import { buildClozeSentenceModel } from "./clozeSentences";
import { loadOfficialCloze } from "./library";
import ClozeSummaryPanel from "./ClozeSummaryPanel";
import ModalShell from "./ui/Overlay";

const RANGE_OPTIONS = [
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "all", label: "全部" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "pending-review", label: "待复习" },
  { value: "unresolved", label: "仍不稳定" },
  { value: "high-confidence-wrong", label: "高置信错误" },
  { value: "changed-to-wrong", label: "改答后错" },
];

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

function confidenceLabel(value) {
  if (value === "confident") return "确定";
  if (value === "uncertain") return "犹豫";
  if (value === "guess") return "猜测";
  return "—";
}

function translationStatusLabel(entry) {
  if (!entry) return "—";
  if (entry.status === "corrected") return "已订正";
  if (entry.status === "translated") return "待订正";
  return "待笔译";
}

function MetricCell({ label, value, tone = "" }) {
  return (
    <div className={`cloze-archive-metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EntryRow({ record, d1Task, d7Task, expanded, onToggle, title = "", entry: entryProp = null, onOpenSummary = null }) {
  const [entry, setEntry] = useState(null);
  const [clozeDetail, setClozeDetail] = useState(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    if (entryProp) {
      setEntry(entryProp);
      return;
    }
    const resource = postgraduateClozeResources.find((item) => item.id === record.resourceId);
    const year = Number(resource?.year) || Number(String(record.resourceId || "").match(/\d{4}/)?.[1] || 0);
    const progress = getClozeProgress(record.resourceId, record.clozeId);
    const translationProgress = loadClozeTranslationProgress(record.resourceId, record.clozeId);
    const officialAnswers = verifiedOfficialAnswers(resource, "cloze");
    setEntry(buildClozeArchiveEntry({
      progress,
      translationProgress,
      d1Task,
      d7Task,
      officialAnswers,
      completedAt: record.completedAt,
    }));
  }, [record.resourceId, record.clozeId, record.completedAt, d1Task, d7Task, entryProp]);

  // 展开时按需加载正文模型（翻译状态按句关联）。
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setDetailFailed(false);
    (async () => {
      const resource = postgraduateClozeResources.find((item) => item.id === record.resourceId)
        || (await listCustomPdfs()).find((item) => item.id === record.resourceId)
        || null;
      if (!resource) return;
      let cloze = null;
      const customCloze = resource.analysis?.clozes?.[0];
      if (customCloze) cloze = customCloze;
      else if (resource.clozeSource) cloze = await loadOfficialCloze(resource);
      if (!cancelled && cloze) {
        setClozeDetail({
          resource,
          cloze,
          sentenceModel: buildClozeSentenceModel(cloze, record.resourceId, record.clozeId),
          translationProgress: loadClozeTranslationProgress(record.resourceId, record.clozeId),
        });
      }
    })().catch(() => {
      if (!cancelled) setDetailFailed(true);
    });
    return () => { cancelled = true; };
  }, [expanded, record.resourceId, record.clozeId, entry]);

  if (!entry) {
    return (
      <article className="cloze-archive-row">
        <div className="cloze-archive-row-main">
          <strong>{title || record.resourceId}</strong>
          <span>正在读取…</span>
        </div>
      </article>
    );
  }

  const c = entry.counts;
  const r = entry.review;
  return (
    <article className="cloze-archive-row">
      <button type="button" className="cloze-archive-row-toggle" onClick={onToggle} aria-expanded={expanded}>
        <div className="cloze-archive-row-main">
          <strong>{title || record.resourceId}</strong>
          <span>
            完成于 {new Date(entry.completedAt).toLocaleDateString("zh-CN")}
            {entry.hasOfficial ? ` · 复查正确 ${c.finalCorrect}/${entry.total}` : " · 无官方答案"}
            {r.lastReviewedAt ? ` · 最后复习 ${new Date(r.lastReviewedAt).toLocaleDateString("zh-CN")}` : ""}
          </span>
          <span className="cloze-archive-row-stats">
            {entry.hasOfficial && (
              <>
                <em>{c.finalWrong} 空仍错</em>
                <em>{c.highConfidenceWrong} 高置信错误</em>
                <em>{c.changedToWrong} 改答后错</em>
                <em>{c.selfCorrected} 自查纠正</em>
              </>
            )}
            {!entry.hasOfficial && (
              <>
                <em>改答 {c.changed}</em>
                <em>猜测 {c.guesses}</em>
                <em>犹豫 {c.uncertain}</em>
              </>
            )}
            <em>D+1 {r.d1CompletedCount}/{r.d1TargetCount}</em>
            {r.d7TargetCount > 0 && <em>D+7 {r.d7CompletedCount}/{r.d7TargetCount}</em>}
          </span>
        </div>
        <span className="cloze-archive-row-arrow">{expanded ? "收起" : "展开"}</span>
      </button>

      {onOpenSummary && (
        <button type="button" className="cloze-archive-summary-button" onClick={onOpenSummary}>
          学习结果
        </button>
      )}

      {expanded && (
        <div className="cloze-archive-detail">
          {clozeDetail?.resource?.importVersion && <MaterialAnswers resource={clozeDetail.resource} content={clozeDetail.cloze} attempts={Object.fromEntries(Object.entries(getClozeProgress(record.resourceId, record.clozeId)?.attempts || {}).map(([n, a]) => [n, a.reviewAnswer || a.firstAnswer || ""]))} label="复查作答" reveal />}
          {detailFailed && (
            <p className="cloze-archive-detail-failed">正文模型读取失败，可重新展开重试。</p>
          )}
          <div className="cloze-archive-overview">
            <p>
              初做完成 {c.firstCompleted}/{entry.total} · 复查完成 {c.reviewCompleted}/{entry.total}
              {entry.hasOfficial ? ` · 初做正确 ${c.firstCorrect}` : ""}
            </p>
            {entry.hasOfficial ? (
              <p>
                复查正确 {c.finalCorrect}/{entry.total} · 仍错 {c.finalWrong} · 高置信错误 {c.highConfidenceWrong} ·
                改答 {c.changed}（其中改答后错 {c.changedToWrong}、自查纠正 {c.selfCorrected}）
              </p>
            ) : (
              <p className="cloze-archive-answerless-note">
                无官方答案：只统计作答变化与置信度，不计算正确率。
              </p>
            )}
            <p>
              译文：已订正 {entry.translation.corrected} 句 · 待订正 {entry.translation.translated} 句
            </p>
            <p>
              D+1 目标 {r.d1TargetCount}（完成 {r.d1CompletedCount}，稳定 {r.d1ResolvedCount}）
              {r.d7TargetCount > 0 ? ` · D+7 目标 ${r.d7TargetCount}（完成 ${r.d7CompletedCount}，仍未解决 ${r.d7UnresolvedCount}）` : ""}
            </p>
          </div>

          <table className="cloze-archive-table">
            <thead>
              <tr>
                <th>空</th>
                <th>初做</th>
                <th>复查</th>
                <th>依据</th>
                <th>定位</th>
                <th>译文</th>
                {entry.hasOfficial && <th>当天结果</th>}
                <th>D+1</th>
                {r.d7TargetCount > 0 && <th>D+7</th>}
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {entry.blanks.map((blank) => {
                let translationStatus = "—";
                const sentence = clozeDetail?.sentenceModel?.blankToSentence?.[blank.blankId];
                if (sentence) {
                  const textEntry = translationEntryFor(clozeDetail.translationProgress, sentence.sentenceKey);
                  translationStatus = translationStatusLabel(textEntry);
                }
                return (
                  <tr key={blank.blankId}>
                    <td>{blank.number}</td>
                    <td>{blank.firstAnswer ? `${blank.firstAnswer}·${confidenceLabel(blank.firstConfidence)}` : "—"}</td>
                    <td>{blank.reviewAnswer ? `${blank.reviewAnswer}·${confidenceLabel(blank.reviewConfidence)}` : "—"}</td>
                    <td>{blank.basisTypes.length ? blank.basisTypes.map((id) => CLOZE_BASIS_TYPE_LABELS[id] || id).join("、") : "—"}</td>
                    <td>{blank.referencesCount > 0 ? `${blank.referencesCount} 处` : "无"}</td>
                    <td>{translationStatus}</td>
                    {entry.hasOfficial && (
                      <td>
                        {blank.finalWrong ? "错" : blank.finalCorrect ? "对" : "—"}
                        {blank.changed ? "·改答" : ""}
                      </td>
                    )}
                    <td>
                      {blank.inD1
                        ? blank.d1Outcome === "correct" ? "对" : blank.d1Outcome === "wrong" ? "错" : blank.d1Outcome === "stable" ? "稳定" : blank.d1Outcome === "unstable" ? "不稳" : "—"
                        : "—"}
                    </td>
                    {r.d7TargetCount > 0 && (
                      <td>
                        {blank.inD7
                          ? blank.d7Outcome === "correct" ? "对" : blank.d7Outcome === "wrong" ? "错" : blank.d7Outcome === "stable" ? "稳定" : blank.d7Outcome === "unstable" ? "不稳" : "—"
                          : "—"}
                      </td>
                    )}
                    <td>
                      {blank.resolved == null ? "—" : blank.resolved ? "已稳定" : "仍不稳定"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!entry.hasOfficial && (
            <p className="cloze-archive-answerless-note">无答案资料：表格中的 D+1/D+7 结果只表示自评稳定度，不表示对错。</p>
          )}
        </div>
      )}
    </article>
  );
}

export default function ClozeLearningArchiveModal({ onClose, onStartReview = null }) {
  const [records, setRecords] = useState([]);
  const [reviewTasks, setReviewTasks] = useState([]);
  const [customTitles, setCustomTitles] = useState({});
  const [expandedId, setExpandedId] = useState("");
  const [range, setRange] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");
  const [summaryTarget, setSummaryTarget] = useState(null);

  useEffect(() => {
    const refresh = () => {
      setRecords(listCompletedClozeRecords());
      setReviewTasks(listClozeReviewTasks());
      listCustomPdfs().then((items) => (
        setCustomTitles(Object.fromEntries(items.map((item) => [item.id, item.title])))
      )).catch(() => {});
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

  const titleFor = (record) => (
    postgraduateClozeResources.find((item) => item.id === record.resourceId)?.title
    || customTitles[record.resourceId]
    || record.resourceId
  );

  // 每篇只构建一次 archive entry；总览 / 筛选 / 优先复盘 / 行详情共用。
  const items = useMemo(() => records.map((record) => {
    const resource = postgraduateClozeResources.find((item) => item.id === record.resourceId);
    const year = Number(resource?.year) || Number(String(record.resourceId || "").match(/\d{4}/)?.[1] || 0) || null;
    const officialAnswers = verifiedOfficialAnswers(resource, "cloze");
    const tasks = findClozeReviewTasksForEntry(reviewTasks, record.resourceId, record.clozeId, record.sourceDate);
    return {
      record,
      title: titleFor(record),
      year,
      d1Task: tasks.d1Task,
      d7Task: tasks.d7Task,
      officialAnswers,
      entry: buildClozeArchiveEntry({
        progress: getClozeProgress(record.resourceId, record.clozeId),
        translationProgress: loadClozeTranslationProgress(record.resourceId, record.clozeId),
        d1Task: tasks.d1Task,
        d7Task: tasks.d7Task,
        officialAnswers,
        completedAt: record.completedAt,
      }),
    };
  }), [records, reviewTasks]);

  const overview = useMemo(() => buildClozeArchiveOverview(items, { range }), [items, range]);
  const recent7 = useMemo(() => buildClozeRecent7(items), [items]);
  const filtered = useMemo(
    () => filterClozeArchiveEntries(items, { range, status: statusFilter, year: yearFilter }),
    [items, range, statusFilter, yearFilter],
  );
  const priorityItems = useMemo(() => buildClozePriorityReviewItems(items), [items]);

  const yearOptions = useMemo(() => {
    const years = new Set();
    let hasCustom = false;
    for (const item of items) {
      if (item.year == null) hasCustom = true;
      else years.add(Number(item.year));
    }
    return {
      years: [...years].sort((a, b) => b - a),
      hasCustom,
    };
  }, [items]);

  const basisStats = useMemo(() => basisDistributionInReviewTargets(items.map((item) => item.entry)), [items]);

  return (
    <ModalShell open onClose={onClose} className="review-plan-backdrop" label="完形长期学习档案">
      <div className="review-plan-modal cloze-archive-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <div><small>CLOZE LEARNING ARCHIVE</small><h2>完形长期档案</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭完形档案">×</button>
        </header>

        <section className="review-plan-section cloze-archive-filters" aria-label="完形档案筛选">
          <div className="learning-filter-group" role="group" aria-label="时间范围">
            {RANGE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={range === option.value ? "active" : ""}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="learning-filter-group" role="group" aria-label="状态筛选">
            {STATUS_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={statusFilter === option.value ? "active" : ""}
                onClick={() => setStatusFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="learning-filter-group" role="group" aria-label="年份筛选">
            <button
              type="button"
              className={yearFilter === "all" ? "active" : ""}
              onClick={() => setYearFilter("all")}
            >
              全部年份
            </button>
            {yearOptions.years.map((year) => (
              <button
                type="button"
                key={year}
                className={yearFilter === String(year) ? "active" : ""}
                onClick={() => setYearFilter(String(year))}
              >
                {year}
              </button>
            ))}
            {yearOptions.hasCustom && (
              <button
                type="button"
                className={yearFilter === "custom" ? "active" : ""}
                onClick={() => setYearFilter("custom")}
              >
                自定义
              </button>
            )}
          </div>
        </section>

        <section className="review-plan-section">
          <h3>总览</h3>
          <div className="cloze-archive-metrics" aria-label="完形档案总览">
            <MetricCell label="完成完形" value={overview.completedCount} />
            <MetricCell label="待长期复习" value={overview.awaitingReviewCount} />
            <MetricCell label="仍不稳定空" value={overview.unstableBlankCount} tone={overview.unstableBlankCount > 0 ? "is-warn" : ""} />
            <MetricCell label="自查纠正" value={overview.selfCorrectedCount} />
            {overview.official.present && (
              <>
                <MetricCell label="高置信错误" value={overview.highConfidenceWrongCount} />
                <MetricCell label="改答后错" value={overview.changedToWrongCount} />
              </>
            )}
          </div>
          <div className="cloze-archive-overview-lines">
            {overview.official.present && (
              <p>
                有官方答案资料 · 最终正确 {overview.official.finalCorrectTotal} / {overview.official.finalCorrectTotal + overview.official.finalWrongTotal}
                <small>（{overview.official.entryCount} 篇；无答案资料不计入正确率分母）</small>
              </p>
            )}
            <p>
              长期已稳定 {overview.longTerm.stable} / {overview.longTerm.total} · D+1 已稳定 {overview.d1.stable}/{overview.d1.target} · D+7 已稳定 {overview.d7.stable}/{overview.d7.target} · 重点句已订正 {overview.translationCorrected}
            </p>
            <p className="cloze-archive-range-note">时间筛选以完成日期（completedAt）为基准；复习相关日期以最后复习时间为准。</p>
          </div>
        </section>

        <section className="review-plan-section">
          <h3>最近 7 天</h3>
          <div className="cloze-archive-recent7">
            <MetricCell label="完成篇数" value={recent7.completedCount} />
            <MetricCell label="进入 D+1 空数" value={recent7.d1BlankCount} />
            <MetricCell label="进入 D+7 空数" value={recent7.d7BlankCount} />
            <MetricCell label="仍未稳定空数" value={recent7.unstableBlankCount} tone={recent7.unstableBlankCount > 0 ? "is-warn" : ""} />
          </div>
        </section>

        {priorityItems.length > 0 && (
          <section className="review-plan-section">
            <h3>优先复盘 <span>{priorityItems.length}</span></h3>
            <div className="cloze-archive-priority">
              {priorityItems.map((item) => (
                <button
                  type="button"
                  className="cloze-archive-priority-item"
                  key={item.key}
                  onClick={() => setSummaryTarget(item.record)}
                >
                  <div>
                    <strong>{item.title} · 第 {item.blankId} 空</strong>
                    <span>{PRIORITY_STATUS_LABELS[item.statusKey] || item.statusKey}</span>
                    <span className="cloze-archive-priority-reasons">
                      {(item.reasons || []).map((reason) => (
                        <em key={reason}>{CLOZE_REVIEW_REASON_LABELS[reason] || reason}</em>
                      ))}
                    </span>
                  </div>
                  <small>最后复习 {item.lastReviewedAt ? new Date(Number(item.lastReviewedAt)).toLocaleDateString("zh-CN") : "—"}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="review-plan-section">
          <h3>已完成的完形训练 <span>{filtered.length}</span></h3>
          {filtered.length === 0 ? (
            <p className="review-plan-empty">
              {records.length === 0
                ? "还没有完成的完形训练。完成一篇训练后会自动进入长期复习闭环。"
                : "当前筛选条件下没有记录。调整时间 / 状态 / 年份筛选后重试。"}
              <small>历史完成数据只在这里展示，不会自动生成复习欠债。</small>
            </p>
          ) : (
            <div className="cloze-archive-list">
              {filtered.map((item) => {
                const rowKey = `${item.record.resourceId}:${item.record.clozeId}:${item.record.sourceDate}`;
                return (
                  <EntryRow
                    key={rowKey}
                    record={item.record}
                    d1Task={item.d1Task}
                    d7Task={item.d7Task}
                    entry={item.entry}
                    title={item.title}
                    expanded={expandedId === rowKey}
                    onToggle={() => setExpandedId(expandedId === rowKey ? "" : rowKey)}
                    onOpenSummary={() => setSummaryTarget(item.record)}
                  />
                );
              })}
            </div>
          )}
        </section>

        {basisStats.reviewedBlankCount > 0 && (
          <section className="review-plan-section">
            <h3>复习目标中的依据分布（不是错误类型） <span>{basisStats.reviewedBlankCount} 空</span></h3>
            <p className="cloze-archive-basis-note">
              以下统计的是：进入长期复习的空位中，你标注使用了哪些依据类别。
              依据不等于错误，不能据此推断"某方面能力差"。
            </p>
            <div className="cloze-archive-basis-list">
              {basisStats.distribution.map((item) => (
                <span key={item.basis}>
                  {CLOZE_BASIS_TYPE_LABELS[item.basis] || item.basis} {item.count} 次
                </span>
              ))}
            </div>
          </section>
        )}
      </div>

      {summaryTarget && (
        <ClozeSummaryPanel
          resourceId={summaryTarget.resourceId}
          clozeId={summaryTarget.clozeId}
          completedAt={summaryTarget.completedAt}
          title={titleFor(summaryTarget)}
          onClose={() => setSummaryTarget(null)}
          onStartReview={onStartReview}
        />
      )}
    </ModalShell>
  );
}

import { useMemo, useState } from "react";
import {
  filterRecordsByRange,
  filterRecordsByType,
  getOverview,
  getPendingTagEntries,
  getQuestionTypeCounts,
  getRecent7Summary,
  getReliableTagCounts,
  getReviewSuggestions,
  getTrapCounts,
} from "./aiLearningStats";
import { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } from "./aiTasks";

const RANGE_OPTIONS = [
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "all", label: "全部" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "translation", label: "翻译" },
  { value: "reading", label: "阅读" },
  { value: "review", label: "待复盘" },
  { value: "pending", label: "待确认" },
];

const LEVEL_LABELS = {
  accurate: "基本准确",
  "mostly-accurate": "大体准确",
  "needs-revision": "需要修改",
};

const BASIS_LABELS = {
  "answers-only": "仅依据作答结果",
  "answers-and-redo": "依据首次与重做作答",
  "user-reasoning": "依据你填写的思路",
};

const CONFIDENCE_LABELS = {
  low: "低置信度",
  medium: "中置信度",
  high: "高置信度",
};

const TYPE_LABELS = {
  [TASK_TRANSLATION_REVIEW]: "翻译批改",
  [TASK_QUESTION_DIAGNOSIS]: "阅读错因",
};

function formatDate(timestamp) {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function CountCard({ label, value }) {
  return (
    <article className="learning-count-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function BarList({ items, maxCount }) {
  if (!items || !items.length) return <p className="learning-empty-note">暂无数据。</p>;
  const max = maxCount || Math.max(...items.map((item) => item.count));
  return (
    <div className="learning-bar-list">
      {items.map((item) => (
        <div className="learning-bar-row" key={item.name}>
          <span className="learning-bar-name">{item.name}</span>
          <span className="learning-bar-track">
            <i style={{ width: `${Math.max(6, Math.round((item.count / max) * 100))}%` }} />
          </span>
          <strong className="learning-bar-count">{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function TagActions({ recordId, tag, onConfirm, onDismiss }) {
  const confirmed = tag.status === "confirmed";
  const dismissed = tag.status === "dismissed";
  return (
    <span className="learning-tag-actions">
      <button
        type="button"
        className={`learning-tag-button ${confirmed ? "active" : ""}`}
        onClick={() => onConfirm(recordId, tag.name)}
      >
        {confirmed ? "已确认" : "确认"}
      </button>
      <button
        type="button"
        className={`learning-tag-button ${dismissed ? "active" : ""}`}
        onClick={() => onDismiss(recordId, tag.name)}
      >
        {dismissed ? "已否定" : "不适用"}
      </button>
    </span>
  );
}

function RecordTags({ record, onConfirm, onDismiss }) {
  const tags = record.tags || [];
  if (!tags.length) return <p className="learning-empty-note">无错误标签。</p>;
  return (
    <div className="learning-record-tags">
      {tags.map((tag) => (
        <span className={`learning-tag ${tag.status === "dismissed" ? "dismissed" : ""} ${tag.status === "confirmed" ? "confirmed" : ""}`} key={tag.name}>
          <em>{tag.name}</em>
          <small>
            {tag.source === "user-confirmed"
              ? "已确认"
              : tag.status === "dismissed"
                ? "已否定"
                : record.taskType === TASK_QUESTION_DIAGNOSIS
                  ? (CONFIDENCE_LABELS[tag.confidence] || tag.confidence)
                  : "AI 批改"}
          </small>
          <TagActions recordId={record.id} tag={tag} onConfirm={onConfirm} onDismiss={onDismiss} />
        </span>
      ))}
    </div>
  );
}

function RecordDetail({ record, onConfirm, onDismiss, onToggleResolved, onDeleteRecord, onOpenHistory, onJump, currentResourceId, showHistory = true }) {
  const isTranslation = record.taskType === TASK_TRANSLATION_REVIEW;
  const canJump = Boolean(
    currentResourceId
    && record.resourceId === currentResourceId
    && record.metadata?.passageId
    && (record.sentenceId || record.questionId),
  );
  const summary = record.summary || {};
  return (
    <div className="learning-record-detail">
      {isTranslation ? (
        <>
          {record.metadata?.sentenceSnippet && (
            <p className="learning-detail-line">
              <span>原句</span>{record.metadata.sentenceSnippet}
            </p>
          )}
          <p className="learning-detail-line">
            <span>批改结论</span>{LEVEL_LABELS[summary.level] || summary.level || "未识别"}
          </p>
          <p className="learning-detail-line">
            <span>输入方式</span>{summary.inputMethod === "handwriting-transcribed" ? "手写补录" : "文字输入"}
          </p>
        </>
      ) : (
        <>
          <p className="learning-detail-line">
            <span>题号</span>{summary.questionType ? `Q${record.questionNumber || "—"} · ${summary.questionType}` : `Q${record.questionNumber || "—"}`}
          </p>
          <p className="learning-detail-line">
            <span>作答</span>
            {[
              summary.firstAnswer ? `首次 ${summary.firstAnswer}${summary.firstCorrect ? " ✓" : " ✕"}` : "",
              summary.redoAnswer ? `重做 ${summary.redoAnswer}${summary.redoCorrect ? " ✓" : " ✕"}` : "",
            ].filter(Boolean).join("　") || "无作答记录"}
          </p>
          <p className="learning-detail-line">
            <span>依据</span>{BASIS_LABELS[summary.diagnosisBasis] || summary.diagnosisBasis || "—"}
          </p>
          <p className="learning-detail-line">
            <span>置信度</span>{CONFIDENCE_LABELS[summary.confidence] || summary.confidence || "—"}
          </p>
          {summary.inferredCauseSummary && (
            <p className="learning-detail-line">
              <span>错因判断</span>{summary.inferredCauseSummary}
            </p>
          )}
          {(record.optionTrapTypes || []).length > 0 && (
            <p className="learning-detail-line">
              <span>干扰项类型</span>
              <span className="learning-inline-chips">
                {record.optionTrapTypes.map((trap) => <i key={trap}>{trap}</i>)}
              </span>
            </p>
          )}
        </>
      )}
      <p className="learning-detail-line">
        <span>批改/诊断次数</span>{record.reviewCount} 次
      </p>
      <p className="learning-detail-line">
        <span>最近更新</span>{formatDate(record.updatedAt)}
      </p>
      {record.metadata?.previousTagNames?.length > 0 && (
        <p className="learning-detail-line">
          <span>上次错因</span>{record.metadata.previousTagNames.join("、")}
        </p>
      )}
      {(record.metadata?.tagHistory && Object.keys(record.metadata.tagHistory).length > 0) && (
        <p className="learning-detail-line">
          <span>曾否定</span>
          {Object.entries(record.metadata.tagHistory)
            .filter(([, info]) => info.lastStatus === "dismissed")
            .map(([name]) => name)
            .join("、") || "无"}
        </p>
      )}

      <div className="learning-detail-actions">
        <button type="button" className="learning-action-button" onClick={() => onToggleResolved(record.id)}>
          {record.resolved ? "重新加入复盘" : "已掌握"}
        </button>
        {showHistory && record.historyId && (
          <button type="button" className="learning-action-button" onClick={() => onOpenHistory(record.historyId)}>
            查看 AI 历史
          </button>
        )}
        <button
          type="button"
          className="learning-action-button"
          disabled={!canJump}
          onClick={() => canJump && onJump(record)}
          title={canJump ? "" : "仅当当前资料与记录一致时可用"}
        >
          {isTranslation ? "回到原句" : "回到原题"}
        </button>
        <button type="button" className="learning-action-button danger" onClick={() => onDeleteRecord(record.id)}>
          删除
        </button>
      </div>
    </div>
  );
}

function RecordRow({ record, expanded, onToggle, ...detailProps }) {
  const summary = record.summary || {};
  const label = record.taskType === TASK_TRANSLATION_REVIEW
    ? summary.itemLabel || "逐句笔译"
    : `Q${record.questionNumber || "—"}`;
  const tagNames = (record.tags || []).filter((tag) => tag.status !== "dismissed").map((tag) => tag.name);
  return (
    <article className={`learning-record ${expanded ? "expanded" : ""}`}>
      <button type="button" className="learning-record-head" onClick={() => onToggle(record.id)}>
        <span className="learning-record-meta">
          <time>{formatDate(record.updatedAt)}</time>
          <strong>{record.chapter || "自定义资料"}</strong>
          <small>{label}</small>
        </span>
        <span className="learning-record-type">{TYPE_LABELS[record.taskType] || record.taskType}</span>
        <span className="learning-record-tags-summary">
          {tagNames.length ? tagNames.slice(0, 3).map((name) => <i key={name}>{name}</i>) : <i className="none">无标签</i>}
          {tagNames.length > 3 && <em>+{tagNames.length - 3}</em>}
        </span>
        <span className={`learning-record-resolved ${record.resolved ? "done" : ""}`}>
          {record.resolved ? "已掌握" : "待复盘"}
        </span>
        <span className="learning-record-arrow">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="learning-record-body">
          <RecordTags record={record} onConfirm={detailProps.onConfirm} onDismiss={detailProps.onDismiss} />
          <RecordDetail record={record} {...detailProps} />
        </div>
      )}
    </article>
  );
}

export default function LearningArchivePanel({
  records = [],
  currentResourceId = "",
  detailId = null,
  onDetailChange = () => {},
  onBack = () => {},
  onConfirmTag = () => {},
  onDismissTag = () => {},
  onToggleResolved = () => {},
  onDeleteRecord = () => {},
  onClearAll = () => {},
  onOpenHistory = () => {},
  onJump = () => {},
  saveError = false,
  initialTypeFilter = "all",
  showHistory = true,
}) {
  const [range, setRange] = useState("30d");
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);

  const overview = useMemo(() => getOverview(records, range), [records, range]);
  const reliable = useMemo(() => getReliableTagCounts(records, range), [records, range]);
  const pendingEntries = useMemo(() => getPendingTagEntries(records, range), [records, range]);
  const traps = useMemo(() => getTrapCounts(records, range), [records, range]);
  const questionTypes = useMemo(() => getQuestionTypeCounts(records, range), [records, range]);
  const recent7 = useMemo(() => getRecent7Summary(records), [records]);
  const suggestions = useMemo(() => getReviewSuggestions(records), [records]);
  const visibleRecords = useMemo(
    () => filterRecordsByType(filterRecordsByRange(records, range), typeFilter),
    [records, range, typeFilter],
  );
  const smallSample = reliable.totalRecords > 0 && reliable.totalRecords < 5;

  const detailProps = {
    onConfirm: onConfirmTag,
    onDismiss: onDismissTag,
    onToggleResolved,
    onDeleteRecord,
    onOpenHistory,
    onJump,
    currentResourceId,
    showHistory,
  };

  return (
    <div className="learning-archive-panel">
      <div className="learning-archive-toolbar">
        <button type="button" className="learning-back-button" onClick={onBack}>← 返回</button>
        <strong>学习档案</strong>
        <button type="button" className="learning-clear-button" onClick={onClearAll}>清空档案</button>
      </div>

      <div className="learning-archive-filters">
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
        <div className="learning-filter-group" role="group" aria-label="记录类型">
          {TYPE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={typeFilter === option.value ? "active" : ""}
              onClick={() => setTypeFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {saveError && <p className="learning-save-error">学习档案保存失败，本次改动未写入。</p>}

      <div className="learning-archive-columns">
        <aside className="learning-archive-stats">
          <section className="learning-stats-grid" aria-label="学习档案总览">
            <CountCard label="翻译批改" value={overview.translationReviews} />
            <CountCard label="发现翻译问题" value={overview.translationWithProblems} />
            <CountCard label="阅读错因诊断" value={overview.diagnosisCount} />
            <CountCard label="待复盘" value={overview.pendingCount} />
          </section>

          <section className="learning-stat-block">
            <h4>最近 7 天</h4>
            <div className="learning-recent-lines">
              <p><span>翻译批改</span><strong>{recent7.translationCount}</strong></p>
              <p><span>阅读诊断</span><strong>{recent7.diagnosisCount}</strong></p>
              <p><span>新增可靠错误标签</span><strong>{recent7.addedReliableTagNames}</strong></p>
              <p><span>待复盘</span><strong>{recent7.pendingCount}</strong></p>
            </div>
          </section>

          {suggestions.length > 0 && (
            <section className="learning-stat-block">
              <h4>本周优先复盘</h4>
              <ol className="learning-suggestions">
                {suggestions.map((item, index) => (
                  <li key={item.name}>{index + 1}. {item.name} <span>{item.count} 次</span></li>
                ))}
              </ol>
            </section>
          )}

          <section className="learning-stat-block">
            <h4>核心错误</h4>
            {smallSample && <p className="learning-sample-note">数据较少，以下仅供复盘。</p>}
            <BarList items={reliable.sorted} />
          </section>

          <section className="learning-stat-block">
            <h4>你曾被这些干扰项吸引</h4>
            <p className="learning-trap-note">这是错误选项的类型，不等同于你的个人阅读弱点。</p>
            <BarList items={traps} />
          </section>

          {questionTypes.length > 0 && (
            <section className="learning-stat-block">
              <h4>已诊断题型</h4>
              <div className="learning-type-list">
                {questionTypes.map((item) => (
                  <p key={item.name}><span>{item.name}</span><strong>{item.count}</strong></p>
                ))}
              </div>
            </section>
          )}

          {pendingEntries.length > 0 && (
            <section className="learning-stat-block">
              <h4>待确认</h4>
              <p className="learning-sample-note">低置信度 AI 推测，确认后才会进入核心统计。</p>
              <div className="learning-pending-list">
                {pendingEntries.map(({ record, tag }) => (
                  <div className="learning-pending-item" key={`${record.id}-${tag.name}`}>
                    <span className="learning-pending-name">{tag.name}</span>
                    <small>{record.chapter || ""}{record.questionNumber ? ` · Q${record.questionNumber}` : ""}</small>
                    <TagActions recordId={record.id} tag={tag} onConfirm={onConfirmTag} onDismiss={onDismissTag} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <p className="learning-stats-basis">
            统计依据：{overview.translationReviews} 条翻译批改 · {overview.diagnosisCount} 道阅读诊断
          </p>
        </aside>

        <section className="learning-archive-list" aria-label="学习记录列表">
          {visibleRecords.length ? visibleRecords.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              expanded={detailId === record.id}
              onToggle={onDetailChange}
              {...detailProps}
            />
          )) : (
            <div className="learning-list-empty">
              <strong>暂无学习档案</strong>
              <p>完成一次 AI 翻译批改或阅读错因诊断后，结构化结果会自动沉淀到这里。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

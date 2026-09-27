import {
  TASK_CLOZE_CONTEXT_REVIEW,
  TASK_CLOZE_DIAGNOSIS,
  TASK_CLOZE_EXPLANATION,
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
} from "./clozeAiTasks";

function TextList({ items }) {
  if (!items?.length) return null;
  return <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>;
}

function EvidenceList({ items }) {
  if (!items?.length) return null;
  return (
    <div className="cloze-ai-evidence">
      <strong>原文证据</strong>
      {items.map((item) => (
        <blockquote key={`${item.sentenceId}-${item.source}`}>
          <p>{item.source}</p>
          {item.explanation && <small>{item.explanation}</small>}
        </blockquote>
      ))}
    </div>
  );
}

function LocalFacts({ meta }) {
  if (!meta?.officialAnswer) return null;
  return (
    <div className="cloze-ai-local-facts">
      <strong>本地答案事实</strong>
      <span>官方答案 {meta.officialAnswer}</span>
      {meta.localAttempts?.first?.answered && <span>初做 {meta.localAttempts.first.answer} · {meta.localAttempts.first.result === "correct" ? "正确" : "错误"}</span>}
      {meta.localAttempts?.review?.answered && <span>复查 {meta.localAttempts.review.answer} · {meta.localAttempts.review.result === "correct" ? "正确" : "错误"}</span>}
    </div>
  );
}

export default function ClozeAiCard({ taskType, result, meta, cached = false, busy = false, onNextHint, onRegenerate }) {
  return (
    <div className="cloze-ai-card">
      {cached && <small className="ai-review-cached">已读取本账号缓存</small>}
      {(taskType === TASK_CLOZE_EXPLANATION || taskType === TASK_CLOZE_DIAGNOSIS) && <LocalFacts meta={meta} />}

      {taskType === TASK_CLOZE_HINT_1 && (
        <>
          <h3>先找方向</h3>
          <p>{result.focus}</p>
          <TextList items={[...(result.grammarSignals || []), ...(result.logicSignals || [])]} />
          {result.selfCheckQuestion && <p className="cloze-ai-self-check">自检：{result.selfCheckQuestion}</p>}
        </>
      )}
      {taskType === TASK_CLOZE_HINT_2 && (
        <>
          <h3>再走一步</h3>
          <p>{result.requiredRole}</p>
          <TextList items={result.reasoningSteps} />
          {!!result.eliminationDimensions?.length && <p>比较维度：{result.eliminationDimensions.join("、")}</p>}
          {result.selfCheckQuestion && <p className="cloze-ai-self-check">自检：{result.selfCheckQuestion}</p>}
        </>
      )}
      {taskType === TASK_CLOZE_EXPLANATION && (
        <>
          <h3>{result.coreRequirement}</h3>
          {result.grammar && <p><strong>句法/搭配：</strong>{result.grammar}</p>}
          {result.contextLogic && <p><strong>上下文：</strong>{result.contextLogic}</p>}
          {!!result.optionNotes?.length && (
            <div className="cloze-ai-option-notes">
              {result.optionNotes.map((item) => (
                <p key={item.key}>
                  <strong>{item.key}</strong>
                  <span><small>{item.key === meta?.officialAnswer ? "本地正确" : "本地排除"}</small>{item.explanation}</span>
                </p>
              ))}
            </div>
          )}
          <EvidenceList items={result.evidence} />
          {result.takeaway && <p className="cloze-ai-self-check">可复用规则：{result.takeaway}</p>}
        </>
      )}
      {taskType === TASK_CLOZE_DIAGNOSIS && (
        <>
          <h3>为什么会错</h3>
          {result.observedPattern && <p>{result.observedPattern}</p>}
          {result.likelyCause && <p><strong>可能错因：</strong>{result.likelyCause}</p>}
          {!!result.errorTypes?.length && <p>错因类型：{result.errorTypes.join("、")}</p>}
          {result.attemptComparison && <p><strong>两次作答：</strong>{result.attemptComparison}</p>}
          <EvidenceList items={result.evidence} />
          {result.nextTimeRule && <p className="cloze-ai-self-check">下次动作：{result.nextTimeRule}</p>}
          <TextList items={result.selfCheckQuestions} />
        </>
      )}
      {taskType === TASK_CLOZE_CONTEXT_REVIEW && (
        <>
          <h3>语境复盘（无官方答案）</h3>
          <p>{result.contextLogic}</p>
          {result.manualAnalysisFeedback && <p><strong>人工分析反馈：</strong>{result.manualAnalysisFeedback}</p>}
          <EvidenceList items={result.evidence} />
          <TextList items={result.reviewQuestions} />
        </>
      )}

      <div className="cloze-ai-card-actions">
        {taskType === TASK_CLOZE_HINT_1 && <button type="button" disabled={busy} onClick={() => onNextHint?.(TASK_CLOZE_HINT_2)}>查看提示 2</button>}
        {onRegenerate && <button type="button" disabled={busy} onClick={onRegenerate}>重新生成</button>}
      </div>
    </div>
  );
}

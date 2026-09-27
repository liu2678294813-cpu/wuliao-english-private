import { TASK_QUESTION_EXPLANATION, TASK_QUESTION_HINT_2 } from "./aiTasks";

function Field({ label, value }) {
  if (!value) return null;
  return (
    <p className="ai-hint-field">
      <span>{label}</span>{value}
    </p>
  );
}

function ChipList({ title, items }) {
  if (!items || !items.length) return null;
  return (
    <section className="ai-review-card ai-question-hint-section">
      <h4>{title}</h4>
      <div className="ai-hint-chips">
        {items.map((item, index) => (
          <span className="ai-hint-chip" key={`${title}-${index}`}>{item}</span>
        ))}
      </div>
    </section>
  );
}

function ListSection({ title, items, renderItem }) {
  if (!items || !items.length) return null;
  return (
    <section className="ai-review-card ai-question-hint-section">
      <h4>{title}</h4>
      <div className="ai-hint-list">
        {items.map((item, index) => (
          <div className="ai-hint-list-item" key={`${title}-${index}`}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </section>
  );
}

function OrderedSteps({ title, items }) {
  if (!items || !items.length) return null;
  return (
    <section className="ai-review-card ai-question-hint-section">
      <h4>{title}</h4>
      <ol className="ai-hint-steps">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ol>
    </section>
  );
}

function Level1Body({ result }) {
  return (
    <>
      <Field label="定位方向" value={result.focus?.location} />
      <ChipList title="关键词" items={result.focus?.keywords} />
      <ChipList title="逻辑信号" items={result.focus?.logicSignals} />
      <Field label="阅读方向" value={result.readingDirection} />
      <Field label="请你重新思考" value={result.questionForUser} />
    </>
  );
}

function Level2Body({ result }) {
  return (
    <>
      <Field label="题型" value={result.questionType} />
      <Field label="题干真正问什么" value={result.questionIntent} />
      <ListSection
        title="同义替换"
        items={result.paraphrases}
        renderItem={(item) => (
          <>
            <Field label="题干表述" value={item.questionExpression} />
            <Field label="原文表述" value={item.sourceExpression} />
            <Field label="说明" value={item.explanation} />
          </>
        )}
      />
      <OrderedSteps title="推理步骤" items={result.reasoningSteps} />
      <ChipList title="常见干扰项特征" items={result.trapTypes} />
      <Field label="最后检查" value={result.finalCheck} />
    </>
  );
}

function Level3Body({ result }) {
  return (
    <>
      <Field label="题型" value={result.questionType} />
      <p className="ai-hint-correct-answer">
        <span>正确答案</span>
        <strong>{result.correctAnswer || "（未提供）"}</strong>
      </p>
      <Field label="核心结论" value={result.coreConclusion} />
      <ListSection
        title="原文证据"
        items={result.evidence}
        renderItem={(item) => (
          <>
            <Field label="原文" value={item.source} />
            <Field label="说明" value={item.explanation} />
          </>
        )}
      />
      <ListSection
        title="同义替换"
        items={result.paraphrases}
        renderItem={(item) => (
          <>
            <Field label="题干表述" value={item.questionExpression} />
            <Field label="原文表述" value={item.sourceExpression} />
            <Field label="说明" value={item.explanation} />
          </>
        )}
      />
      <section className="ai-review-card ai-question-hint-section">
        <h4>选项分析</h4>
        {(result.optionAnalysis || []).length ? (
          <div className="ai-hint-option-list">
            {(result.optionAnalysis || []).map((item, index) => (
              <div className="ai-hint-option" key={`option-${index}`}>
                <p className={`ai-hint-option-line ${item.result === "correct" ? "correct" : "wrong"}`}>
                  <span className="ai-hint-option-key">{item.option}</span>
                  <span className="ai-hint-option-result">{item.result === "correct" ? "正确" : "错误"}</span>
                  {item.reasonType && <span className="ai-hint-option-reason">{item.reasonType}</span>}
                </p>
                {item.explanation && <p className="ai-hint-option-explanation">{item.explanation}</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="ai-hint-empty-note">未提供选项分析。</p>
        )}
      </section>
      {result.hasFullOptionCoverage === false && (
        <p className="ai-hint-coverage-note">AI 未覆盖全部选项，请结合原文核对。</p>
      )}
      <Field label="本题方法" value={result.solvingRule} />
    </>
  );
}

export default function QuestionHintCard({
  result,
  level,
  cached = false,
  busy = false,
  canShowFullExplanation = false,
  canContinue = true,
  onNextLevel,
}) {
  if (!result) return null;

  const title = level === 1 ? "一级提示" : level === 2 ? "二级提示" : "完整讲解";

  return (
    <div className="ai-question-hint-result">
      {cached && <p className="ai-review-cached-note">已读取本地提示结果（未重新请求 AI）。</p>}

      <section className="ai-review-card ai-question-hint-card">
        <h4>{title}</h4>
        {level === 1 && <Level1Body result={result} />}
        {level === 2 && <Level2Body result={result} />}
        {level === 3 && <Level3Body result={result} />}
      </section>

      {(level === 1 || level === 2) && (
        <div className="ai-hint-next-actions">
          {level === 1 ? (
            <button
              type="button"
              className="ai-hint-next-button"
              disabled={busy || !canContinue}
              onClick={() => onNextLevel?.(TASK_QUESTION_HINT_2)}
            >
              再提示一步
            </button>
          ) : canShowFullExplanation ? (
            <button
              type="button"
              className="ai-hint-next-button"
              disabled={busy || !canContinue}
              onClick={() => onNextLevel?.(TASK_QUESTION_EXPLANATION)}
            >
              查看完整讲解
            </button>
          ) : (
            <button type="button" className="ai-hint-next-button" disabled>
              {canContinue ? "点击「订正」后可查看完整讲解" : "请从题卡重新发起提示以继续"}
            </button>
          )}
          {!canContinue && <small className="ai-hint-continue-note">请从题卡重新发起提示以继续</small>}
        </div>
      )}
    </div>
  );
}

import { getQuestionDiagnosisEntryLabel } from "./questionDiagnosisService";

const BASIS_LABELS = {
  "answers-only": "仅依据作答结果",
  "answers-and-redo": "依据首次与重做作答",
  "user-reasoning": "依据你填写的思路",
};

const CONFIDENCE_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
};

const ATTEMPT_LABELS = {
  first: "第一次",
  redo: "重做",
};

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

function AttemptLine({ label, answer, correct }) {
  if (!answer) return null;
  return (
    <p className={`ai-diagnosis-attempt ${correct ? "correct" : "wrong"}`}>
      <span>{label}</span>
      <strong>{answer}</strong>
      <i>{correct ? "✓" : "✕"}</i>
    </p>
  );
}

export default function QuestionDiagnosisCard({
  result,
  meta = {},
  cached = false,
  busy = false,
  onRegenerate,
  onRedoWithReasoning,
}) {
  if (!result) return null;

  const officialAnswer = String(meta.officialAnswer || "").toUpperCase();
  const firstAnswer = String(meta.firstAnswer || "").toUpperCase();
  const redoAnswer = String(meta.redoAnswer || "").toUpperCase();
  const hasFirst = /^[A-D]$/.test(firstAnswer);
  const hasRedo = /^[A-D]$/.test(redoAnswer);
  const firstCorrect = hasFirst && firstAnswer === officialAnswer;
  const redoCorrect = hasRedo && redoAnswer === officialAnswer;
  const userReasoning = String(meta.userReasoning || "").trim();
  const title = getQuestionDiagnosisEntryLabel({ firstAnswer, redoAnswer, officialAnswer }) || "错因诊断";
  const questionLabel = meta.questionNumber ? `Q${meta.questionNumber}` : "";
  const comparison = result.attemptComparison || {};
  const inferredCause = result.inferredCause || {};

  return (
    <div className="ai-question-hint-result">
      {cached && <p className="ai-review-cached-note">已读取本地错因诊断（未重新请求 AI）。</p>}

      <section className="ai-review-card ai-question-hint-card">
        <h4>{title}{questionLabel ? ` · ${questionLabel}` : ""}</h4>
        {meta.chapter && <p className="ai-diagnosis-source">{meta.chapter}</p>}

        <section className="ai-review-card ai-question-hint-section">
          <h4>你的作答</h4>
          <div className="ai-diagnosis-attempts">
            <AttemptLine label="第一次" answer={hasFirst ? firstAnswer : ""} correct={firstCorrect} />
            <AttemptLine label="重做" answer={hasRedo ? redoAnswer : ""} correct={redoCorrect} />
            <p className="ai-diagnosis-answer-line">
              <span>正确答案</span>
              <strong>{officialAnswer || "（未提供）"}</strong>
            </p>
          </div>
        </section>

        {!userReasoning && (
          <p className="ai-diagnosis-note">
            以下错因属于根据作答结果和原文证据进行的推测，无法确认这就是你当时真实的思考过程。
          </p>
        )}

        <div className="ai-hint-chips ai-diagnosis-chips">
          {result.questionType && <span className="ai-hint-chip">题型：{result.questionType}</span>}
          <span className="ai-hint-chip">依据：{BASIS_LABELS[result.diagnosisBasis] || "—"}</span>
          <span className="ai-hint-chip">置信度：{CONFIDENCE_LABELS[result.confidence] || "—"}</span>
        </div>

        <ListSection
          title="客观可观察事实"
          items={result.observedFacts}
          renderItem={(item) => <p className="ai-hint-field">{item}</p>}
        />

        <section className="ai-review-card ai-question-hint-section">
          <h4>原文证据</h4>
          {result.evidenceValidated === false ? (
            <p className="ai-diagnosis-evidence-warning">AI 给出的证据未通过原文校验，本次诊断未采用。</p>
          ) : (result.evidence || []).length ? (
            <div className="ai-hint-list">
              {(result.evidence || []).map((item, index) => (
                <div className="ai-hint-list-item" key={`evidence-${index}`}>
                  <Field label="原文" value={item.source} />
                  <Field label="说明" value={item.explanation} />
                </div>
              ))}
            </div>
          ) : (
            <p className="ai-hint-empty-note">未提供可通过校验的原文证据。</p>
          )}
        </section>

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
          <h4>选项陷阱分析</h4>
          {(result.selectedOptionAnalysis || []).length ? (
            <div className="ai-hint-option-list">
              {(result.selectedOptionAnalysis || []).map((item, index) => (
                <div className="ai-hint-option" key={`diagnosis-option-${index}`}>
                  <p className="ai-hint-option-line wrong">
                    <span className="ai-hint-option-key">{item.selectedOption}</span>
                    <span className="ai-hint-option-result">{ATTEMPT_LABELS[item.attempt] || item.attempt}</span>
                    {item.optionTrapType && <span className="ai-hint-option-reason">{item.optionTrapType}</span>}
                  </p>
                  <Field label="为什么容易被选" value={item.whyAttractive} />
                  <Field label="错在哪里" value={item.whyWrong} />
                </div>
              ))}
            </div>
          ) : (
            <p className="ai-hint-empty-note">未提供选项陷阱分析。</p>
          )}
        </section>

        {comparison.available && hasFirst && hasRedo && (
          <section className="ai-review-card ai-question-hint-section">
            <h4>第一次 → 重做</h4>
            {!firstCorrect && redoCorrect && <p className="ai-diagnosis-note">重点看：你在重做时纠正了什么。</p>}
            {!firstCorrect && !redoCorrect && <p className="ai-diagnosis-note">重点看：两次是否重复落入同一种干扰。</p>}
            {firstCorrect && !redoCorrect && <p className="ai-diagnosis-note">重点看：为什么重做反而偏离正确证据。</p>}
            <Field label="变化" value={comparison.comment} />
          </section>
        )}

        <section className="ai-review-card ai-question-hint-section">
          <h4>可能错因</h4>
          <Field label="判断" value={inferredCause.summary} />
          {(inferredCause.userErrorTags || []).length ? (
            <ChipList title="错因标签" items={inferredCause.userErrorTags} />
          ) : (
            <p className="ai-hint-empty-note">当前信息不足以确认具体错因。</p>
          )}
          <Field label="依据" value={inferredCause.reasoning} />
          <Field label="无法确认的部分" value={inferredCause.uncertainty} />
        </section>

        <Field label="下次怎么检查" value={result.nextTimeRule} />
        <ListSection
          title="自检问题"
          items={result.selfCheckQuestions}
          renderItem={(item) => <p className="ai-hint-field">{item}</p>}
        />
      </section>

      {(onRegenerate || onRedoWithReasoning) && (
        <div className="ai-diagnosis-actions">
          {onRegenerate && (
            <button type="button" className="ai-hint-next-button" onClick={onRegenerate} disabled={busy}>
              重新生成
            </button>
          )}
          {onRedoWithReasoning && !userReasoning && result.confidence === "low" && (
            <button
              type="button"
              className="ai-diagnosis-secondary-button"
              onClick={onRedoWithReasoning}
              disabled={busy}
            >
              补充我的思路后重新诊断
            </button>
          )}
        </div>
      )}
    </div>
  );
}

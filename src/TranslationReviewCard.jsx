import { useState } from "react";

const LEVEL_LABELS = {
  accurate: "基本准确",
  "mostly-accurate": "大体准确",
  "needs-revision": "需要修改",
};

function ProblemCard({ title, items, renderItem }) {
  if (!items || !items.length) return null;
  return (
    <section className="ai-review-card">
      <h4>{title}</h4>
      {items.map((item, index) => (
        <div className="ai-review-item" key={`${title}-${index}`}>
          {renderItem(item)}
        </div>
      ))}
    </section>
  );
}

function fieldLine(label, value) {
  if (!value) return null;
  return <p className="ai-review-field"><span>{label}</span>{value}</p>;
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走降级方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export default function TranslationReviewCard({
  result,
  userTranslation = "",
  cached = false,
  onRegenerate,
  corrected = false,
  onCorrected = null,
}) {
  const [copied, setCopied] = useState(false);
  if (!result) return null;

  const levelLabel = LEVEL_LABELS[result.summary?.level] || "未识别";
  const summaryComment = result.summary?.comment || "";
  const mainClause = result.mainClause || {};
  const noProblems = [
    result.clauseProblems,
    result.nonFiniteProblems,
    result.modifierProblems,
    result.referenceProblems,
    result.logicProblems,
    result.omissions,
    result.additions,
    result.wordChoiceProblems,
    result.chineseExpressionProblems,
  ].every((list) => !list || list.length === 0);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(result.minimalRevision || "");
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div className="ai-review-result">
      {cached && <p className="ai-review-cached-note">已读取本地批改结果（未重新请求 AI）。</p>}

      <section className="ai-review-card ai-review-user-card">
        <h4>你的译文</h4>
        <p className="ai-review-user-translation">{userTranslation || "（未提供）"}</p>
      </section>

      <section className="ai-review-card">
        <h4>整体判断</h4>
        <p className="ai-review-level">{levelLabel}</p>
        {summaryComment && <p className="ai-review-comment">{summaryComment}</p>}
      </section>

      <section className="ai-review-card">
        <h4>主干</h4>
        <p className={mainClause.correct ? "ai-review-ok" : "ai-review-warn"}>
          {mainClause.correct === true ? "主干传达正确" : "主干传达需要复核"}
        </p>
        {mainClause.comment && <p className="ai-review-comment">{mainClause.comment}</p>}
      </section>

      <ProblemCard
        title="从句关系"
        items={result.clauseProblems}
        renderItem={(item) => (
          <>
            {fieldLine("英文成分", item.source)}
            {fieldLine("类型", item.type)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="非谓语结构"
        items={result.nonFiniteProblems}
        renderItem={(item) => (
          <>
            {fieldLine("英文成分", item.source)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="修饰关系"
        items={result.modifierProblems}
        renderItem={(item) => (
          <>
            {fieldLine("修饰对象", item.source)}
            {fieldLine("你的译法", item.userVersion)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="代词指代"
        items={result.referenceProblems}
        renderItem={(item) => (
          <>
            {fieldLine("指代词", item.source)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="逻辑关系"
        items={result.logicProblems}
        renderItem={(item) => (
          <>
            {fieldLine("逻辑结构", item.source)}
            {fieldLine("关系类型", item.logicType)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="漏译"
        items={result.omissions}
        renderItem={(item) => (
          <>
            {fieldLine("漏译成分", item.source)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="增译"
        items={result.additions}
        renderItem={(item) => (
          <>
            {fieldLine("你增加的内容", item.userVersion)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="词义选择"
        items={result.wordChoiceProblems}
        renderItem={(item) => (
          <>
            {fieldLine("英文词", item.word)}
            {fieldLine("你的译法", item.userVersion)}
            {fieldLine("语境义", item.contextMeaning)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />
      <ProblemCard
        title="中文表达"
        items={result.chineseExpressionProblems}
        renderItem={(item) => (
          <>
            {fieldLine("你的原表达", item.userVersion)}
            {fieldLine("说明", item.comment)}
          </>
        )}
      />

      {noProblems && <p className="ai-review-clean">未发现明显问题。</p>}

      <section className="ai-review-card ai-review-revision-card">
        <h4>最小修改版</h4>
        <p className="ai-review-revision">{result.minimalRevision || "（未提供）"}</p>
      </section>

      <section className="ai-review-card ai-review-reference-card">
        <h4>参考译文</h4>
        <p className="ai-review-reference">{result.referenceTranslation || "（未提供）"}</p>
      </section>

      {result.errorTags?.length > 0 && (
        <section className="ai-review-card">
          <h4>错误标签</h4>
          <div className="ai-review-tags">
            {result.errorTags.map((tag) => <span className="ai-review-tag" key={tag}>{tag}</span>)}
          </div>
        </section>
      )}

      <div className="ai-review-actions">
        {onCorrected && (
          <button
            type="button"
            className="ai-review-action ai-review-corrected-button"
            onClick={onCorrected}
            disabled={corrected}
          >
            {corrected ? "已订正" : "我已完成订正"}
          </button>
        )}
        <button type="button" className="ai-review-action" onClick={handleCopy} disabled={!result.minimalRevision}>
          {copied ? "已复制" : "复制最小修改版"}
        </button>
        <button type="button" className="ai-review-action" onClick={() => onRegenerate?.()}>
          {cached ? "重新生成（重新请求 AI）" : "重新生成"}
        </button>
      </div>
    </div>
  );
}

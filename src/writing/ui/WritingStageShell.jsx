import { createContext, useContext, useState } from "react";
import { WRITING_STAGES, WritingStage } from "../writingModels.js";

const WritingToolbarHostContext = createContext(undefined);

export function useWritingStageToolbarHost() {
  return useContext(WritingToolbarHostContext);
}

export const WRITING_STAGE_TITLES = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: "范文精读",
  [WritingStage.W2_EN_ZH]: "英译中",
  [WritingStage.W3_BACK_TRANSLATION]: "回译",
  [WritingStage.W4_COMPARE_DIAGNOSE]: "对照诊断",
  [WritingStage.W5_SKELETON]: "思想骨架",
  [WritingStage.W6_RECONSTRUCTION]: "重构练习",
  [WritingStage.W7_INDEPENDENT]: "独立作文",
  [WritingStage.W8_SCORE_REWRITE]: "评分与改写",
  [WritingStage.DONE]: "已完成",
});

export const WRITING_STAGE_SHORT = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: "W1",
  [WritingStage.W2_EN_ZH]: "W2",
  [WritingStage.W3_BACK_TRANSLATION]: "W3",
  [WritingStage.W4_COMPARE_DIAGNOSE]: "W4",
  [WritingStage.W5_SKELETON]: "W5",
  [WritingStage.W6_RECONSTRUCTION]: "W6",
  [WritingStage.W7_INDEPENDENT]: "W7",
  [WritingStage.W8_SCORE_REWRITE]: "W8",
  [WritingStage.DONE]: "DONE",
});

export function WritingStageNotice({ tone = "info", title, children, role }) {
  return (
    <div className={`writing-notice writing-notice-${tone}`} role={role}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function WritingConfirmPanel({ title, children, confirmLabel = "确认", busy = false, onConfirm, onCancel }) {
  return (
    <section className="writing-confirm-panel" aria-label={title}>
      <div>
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
      <div className="writing-confirm-actions">
        <button type="button" className="writing-button-ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
          {busy ? "正在处理…" : confirmLabel}
        </button>
      </div>
    </section>
  );
}

export default function WritingStageShell({
  stage,
  title = WRITING_STAGE_TITLES[stage],
  description,
  onBack,
  status,
  children,
  actions,
  compact = false,
  immersive = false,
}) {
  const activeIndex = stage === WritingStage.DONE ? 8 : WRITING_STAGES.indexOf(stage);
  const progressStages = WRITING_STAGES.slice(0, 8);
  const [toolbarHost, setToolbarHost] = useState(null);
  return (
    <WritingToolbarHostContext.Provider value={compact ? toolbarHost : undefined}>
    <main
      className={`writing-workspace writing-stage writing-stage-${WRITING_STAGE_SHORT[stage]?.toLowerCase() || "unknown"} ${compact ? "is-compact-workspace" : ""} ${immersive ? "is-immersive" : ""}`.trim()}
      aria-label={`当前阶段 ${WRITING_STAGE_SHORT[stage]}`}
    >
      <header className={compact ? "writing-compact-toolbar" : "writing-stage-header"}>
        {compact ? (
          <>
            <div className="writing-compact-toolbar-left">{onBack ? <button type="button" className="back-button" onClick={onBack}>← 返回</button> : null}</div>
            <div ref={setToolbarHost} className="writing-compact-toolbar-center" data-writing-toolbar-slot="center" />
            <div className="writing-compact-toolbar-right">{actions ? <div className="writing-stage-header-actions">{actions}</div> : null}</div>
          </>
        ) : (
          <>
        <div className="writing-stage-header-main">
          {onBack ? <button type="button" className="back-button" onClick={onBack}>返回</button> : null}
          <div>
            <p className="writing-kicker">WRITING · {WRITING_STAGE_SHORT[stage]}</p>
            <h1>{title}</h1>
            {description ? <p className="writing-stage-description">{description}</p> : null}
          </div>
        </div>
        <div className="writing-stage-header-trailing">
          {actions ? <div className="writing-stage-header-actions">{actions}</div> : null}
          <div className="writing-stage-counter">
            <strong>{stage === WritingStage.DONE ? "8" : activeIndex + 1}</strong><span>/ 8</span>
          </div>
        </div>
          </>
        )}
      </header>

      {!compact ? <nav className="writing-progress" aria-label="写作训练阶段">
        {progressStages.map((stageId, index) => {
          const current = stageId === stage;
          const completed = stage === WritingStage.DONE || index < activeIndex;
          return (
            <span
              key={stageId}
              className={`${current ? "is-current" : ""} ${completed ? "is-completed" : ""}`.trim()}
              aria-current={current ? "step" : undefined}
            >
              <b>{index + 1}</b>
              <small>{WRITING_STAGE_TITLES[stageId]}</small>
            </span>
          );
        })}
      </nav> : null}

      {status ? <div className="writing-stage-status" aria-live="polite">{status}</div> : null}
      <div className="writing-stage-content">{children}</div>
    </main>
    </WritingToolbarHostContext.Provider>
  );
}

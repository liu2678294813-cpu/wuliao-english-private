import { ImportedAsset } from "./ImportedWritingLibrary.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WritingInputMethod,
  WritingLearningItemKind,
  WritingLearningItemOrigin,
  WritingReconstructionOutcome,
  WritingSkeletonOutcome,
  WritingStage,
  WritingVerifiedTextSource,
} from "../writingModels.js";
import WritingStageShell, {
  WritingConfirmPanel,
  WritingStageNotice,
} from "./WritingStageShell.jsx";
import WritingInkComposer from "./WritingInkComposer.jsx";
import WritingSplitWorkspace from "./WritingSplitWorkspace.jsx";
import WritingInkSurface from "../WritingInkSurface.jsx";
import {
  paragraphList,
  translationDocument,
  wholeDocumentTranslationUnit,
} from "../writingDocument.js";

const INPUT_MODES = Object.freeze([
  [WritingInputMethod.TYPED, "键盘输入"],
  [WritingInputMethod.HANDWRITING, "手写"],
]);

const DIMENSION_LABELS = Object.freeze({
  taskFulfillment: "任务完成度",
  contentCoverage: "内容覆盖",
  organizationCoherence: "组织与连贯",
  languageAccuracy: "语言准确性",
  languageRange: "语言丰富度",
  formatRegister: "格式与语域",
});

const RATING_LABELS = Object.freeze({
  excellent: "非常出色",
  strong: "表现扎实",
  adequate: "基本达成",
  weak: "仍需加强",
  critical: "需要重点修正",
});

function useStableValue(valueFactory) {
  const ref = useRef(null);
  if (ref.current === null) ref.current = valueFactory();
  return ref.current;
}

function useMountedFlag() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

function draftFingerprint(ownerRecordId, inkRef = null) {
  return inkRef?.sourceFingerprint || `writing-ui-draft:${ownerRecordId}`;
}

function useDraftPersistence({ changeToken, snapshot, saveDraft, registerExitBarrier, onDraftError }) {
  const latestRef = useRef(snapshot);
  const saveRef = useRef(saveDraft);
  const queueRef = useRef(Promise.resolve());
  const timerRef = useRef(null);
  latestRef.current = snapshot;
  saveRef.current = saveDraft;

  const enqueue = useCallback((options = {}) => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const task = queueRef.current
      .catch(() => {})
      .then(() => saveRef.current(latestRef.current, options));
    queueRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    if (!changeToken) return undefined;
    timerRef.current = window.setTimeout(() => {
      enqueue({ flushInk: false }).catch((error) => onDraftError?.(error));
    }, 450);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [changeToken, enqueue, onDraftError]);

  useEffect(() => {
    if (!registerExitBarrier) return undefined;
    return registerExitBarrier(() => enqueue({ flushInk: true }));
  }, [enqueue, registerExitBarrier]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return enqueue;
}

function WorkspaceViewActions({ layout, onToggleLayout, immersive, onToggleImmersive, primaryAction = null }) {
  return (
    <>
      <button type="button" className="writing-button-secondary writing-view-action writing-layout-action" data-compact-label={layout === "split" ? "上下" : "左右"} onClick={onToggleLayout} aria-label="切换双区布局">
        {layout === "split" ? "上下布局" : "左右布局"}
      </button>
      {!immersive ? <button type="button" className="writing-button-secondary writing-view-action writing-immersive-action" onClick={onToggleImmersive}>沉浸学习</button> : null}
      {!immersive ? primaryAction : null}
    </>
  );
}

function ReadOnlyTranslationInk({ username, sessionId, inkRef, InkSurface = WritingInkSurface }) {
  const pageRef = useRef(null);
  const pageRegions = useMemo(() => [{ pageId: "page-1", ref: pageRef }], []);
  if (!inkRef) return null;
  return (
    <section className="writing-readonly-ink" aria-label="W2 中文手写译文（只读）">
      <InkSurface
        username={username}
        sessionId={sessionId}
        surfaceId={inkRef.surfaceId}
        stageId={inkRef.stageId}
        ownerRecordId={inkRef.ownerRecordId}
        sourceFingerprint={inkRef.sourceFingerprint}
        readOnly
        pageRegions={pageRegions}
      >
        <div ref={pageRef} className="writing-paper" data-writing-page="page-1"><span>W2 中文手写译文（只读）</span></div>
      </InkSurface>
    </section>
  );
}

function FrozenTranslationSource({ username, sessionId, snapshot, InkSurface = WritingInkSurface }) {
  const typedText = translationDocument(snapshot?.units);
  const inkRef = snapshot?.units?.find((unit) => unit.inkRef)?.inkRef || null;
  return (
    <div className="writing-frozen-translation-source">
      {typedText.trim() ? <DocumentText text={typedText} /> : null}
      <ReadOnlyTranslationInk username={username} sessionId={sessionId} inkRef={inkRef} InkSurface={InkSurface} />
      {!typedText.trim() && !inkRef ? <p className="writing-empty-copy">W2 没有可显示的冻结译文。</p> : null}
    </div>
  );
}

function InputModePicker({ value, onChange, disabled = false }) {
  return (
    <div className="writing-input-modes" role="group" aria-label="输入方式">
      {INPUT_MODES.map(([mode, label]) => (
        <button
          type="button"
          key={mode}
          className={value === mode ? "is-active" : ""}
          aria-pressed={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function visibleInputMethod(inputMethod, typedText = "") {
  if (inputMethod === WritingInputMethod.HANDWRITING) return WritingInputMethod.HANDWRITING;
  if (inputMethod === WritingInputMethod.MIXED) return typedText.trim() ? WritingInputMethod.TYPED : WritingInputMethod.HANDWRITING;
  return WritingInputMethod.TYPED;
}

function PromptCard({ prompt, compact = false }) {
  if (!prompt) return null;
  return (
    <section className={`writing-prompt-card ${compact ? "is-compact" : ""}`}>
      <small>作文题</small>
      <h2>{prompt.promptText}</h2>
      {(prompt.assets || []).map((asset) => <ImportedAsset key={asset.assetId} asset={asset} />)}
      {prompt.directions ? <p>{prompt.directions}</p> : null}
      {prompt.targetWordRange ? <span>建议 {prompt.targetWordRange.min}–{prompt.targetWordRange.max} 词</span> : null}
    </section>
  );
}

function DocumentText({ text, empty = "暂无可显示内容" }) {
  const paragraphs = paragraphList(text);
  if (!paragraphs.length) return <p className="writing-empty-copy">{empty}</p>;
  return <article className="writing-document-text">{paragraphs.map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 24)}`}>{paragraph}</p>)}</article>;
}

function actionButton(label, action, busyAction, onClick, options = {}) {
  return (
    <button
      type="button"
      className={options.className || "primary-button"}
      disabled={busyAction === action || options.disabled}
      onClick={onClick}
    >
      {busyAction === action ? options.busyLabel || "正在处理…" : label}
    </button>
  );
}

function attemptInput(current, attemptId, inputMethod, typedText, createdAt) {
  return {
    ...(current || {}),
    attemptId,
    inputMethod,
    typedText,
    createdAt: current?.createdAt ?? createdAt,
    revision: current?.revision ?? 0,
  };
}

function normalizeWords(text) {
  return String(text || "").split(/([A-Za-z]+(?:['-][A-Za-z]+)*)/g).filter(Boolean);
}

export function W1SampleReadingStage({ vm, commandContext, services, busyAction, onAction, onBack }) {
  const mounted = useMountedFlag();
  const [marked, setMarked] = useState(() => new Set());
  const sample = vm.sampleEssaySnapshot;
  const passed = sample?.qualityStatus === "passed";

  async function toggleWord(word, unitId, occurrenceId) {
    await onAction(`w1-word:${occurrenceId}`, async () => {
      await services.unknownWords.saveWritingUnknownWord({
        sessionId: vm.sessionId,
        sampleEssayFingerprint: sample.fingerprint,
        unitId,
        word,
        occurrenceId,
        sourceLabel: "Writing 范文",
      });
      if (!mounted.current) return;
      setMarked((current) => {
        const next = new Set(current);
        if (next.has(occurrenceId)) next.delete(occurrenceId);
        else next.add(occurrenceId);
        return next;
      });
    }, { reload: false });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W1_SAMPLE_READING}
      onBack={onBack}
      description="先看清一篇合格范文如何完成任务，再进入自己的表达。"
      actions={passed ? actionButton("完成范文精读", "w1-complete", busyAction, () => onAction("w1-complete", () => services.commands.completeReadingAndEnterW2(commandContext))) : null}
    >
      <PromptCard prompt={vm.promptSnapshot} />
      {!passed ? (
        <WritingStageNotice tone="error" title="范文不可用于训练" role="alert">
          当前会话没有通过质量门槛的冻结范文。为保护训练质量，页面已阻断，且不会自动重新生成。
        </WritingStageNotice>
      ) : (
        <section className="writing-reading-sheet">
          <div className="writing-section-heading">
            <div><h2>训练范文</h2><p>点按英文单词可显式加入或取消陌生词。</p></div>
            <span>{sample.wordCount} 词</span>
          </div>
          <article>
            {sample.segments.map((segment, segmentIndex) => (
              <p key={segment.unitId} data-unit-id={segment.unitId}>
                <small>{String(segmentIndex + 1).padStart(2, "0")}</small>
                <span>
                  {normalizeWords(segment.text).map((part, partIndex) => {
                    if (!/^[A-Za-z]/.test(part)) return <span key={`${segment.unitId}:${partIndex}`}>{part}</span>;
                    const occurrenceId = `${segment.unitId}:${partIndex}:${part.toLowerCase()}`;
                    return (
                      <button
                        type="button"
                        key={occurrenceId}
                        className={marked.has(occurrenceId) ? "is-marked" : ""}
                        aria-pressed={marked.has(occurrenceId)}
                        aria-label={`${marked.has(occurrenceId) ? "取消" : "标记"}陌生词 ${part}`}
                        onClick={() => toggleWord(part, segment.unitId, occurrenceId)}
                      >
                        {part}
                      </button>
                    );
                  })}
                </span>
              </p>
            ))}
          </article>
        </section>
      )}
    </WritingStageShell>
  );
}

export function W2TranslationStage({ vm, commandContext, services, username, createId, inkFlushBridge, busyAction, onAction, onBack, registerExitBarrier, onDraftError, layout = "split", onToggleLayout, immersive = false, onToggleImmersive, onExitImmersive, InkComposer = WritingInkComposer, InkSurfaceComponent }) {
  const current = vm.currentTranslationRevision;
  const persistedRef = useRef(current);
  const revisionId = useStableValue(() => current?.revisionId || createId("translation"));
  const snapshotId = useStableValue(() => createId("translation-snapshot"));
  const createdAt = useStableValue(() => Date.now());
  const [typedText, setTypedText] = useState(() => translationDocument(current?.units));
  const [inputMethod, setInputMethod] = useState(() => current?.units?.some((unit) => unit.inputMethod === WritingInputMethod.HANDWRITING)
    ? WritingInputMethod.HANDWRITING
    : WritingInputMethod.TYPED);
  const [latestInkRef, setLatestInkRef] = useState(vm.translationInkRef || null);
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const showsText = inputMethod === WritingInputMethod.TYPED;
  const showsInk = inputMethod === WritingInputMethod.HANDWRITING;

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { typedText, inputMethod, latestInkRef },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot, { flushInk = false } = {}) => {
      const persisted = persistedRef.current;
      if (typeof services.commands.saveTranslationDraft !== "function") return persisted;
      const translationRevision = {
        ...(persisted || {}),
        revisionId,
        revisionNumber: persisted?.revisionNumber || 1,
        status: "draft",
        basedOnRevisionId: persisted?.basedOnRevisionId ?? null,
        units: [wholeDocumentTranslationUnit({
          sampleSegments: vm.sampleSegments,
          typedText: draftSnapshot.typedText,
          inputMethod: draftSnapshot.inputMethod,
          inkRef: draftSnapshot.latestInkRef || persisted?.units?.[0]?.inkRef || null,
        })],
        createdAt: persisted?.createdAt ?? createdAt,
        updatedAt: Date.now(),
        committedAt: null,
        revision: persisted?.revision ?? 0,
      };
      const result = await services.commands.saveTranslationDraft({
        ...commandContext,
        revisionId,
        translationRevision,
        translationExpectedRevision: persisted?.revision ?? 0,
        flushInk: flushInk && draftSnapshot.inputMethod === WritingInputMethod.HANDWRITING,
      });
      persistedRef.current = result.translationRevision;
      const savedInkRef = result.translationRevision?.units?.find((unit) => unit.inkRef)?.inkRef || null;
      if (savedInkRef) setLatestInkRef(savedInkRef);
      return result.translationRevision;
    },
  });

  async function commit() {
    await onAction("w2-commit", async () => {
      await saveDraft({ flushInk: showsInk });
      const persisted = persistedRef.current;
      const translationRevision = {
      ...(persisted || {}),
      revisionId,
      revisionNumber: persisted?.revisionNumber || 1,
      status: "draft",
      basedOnRevisionId: persisted?.basedOnRevisionId ?? null,
      units: [wholeDocumentTranslationUnit({
        sampleSegments: vm.sampleSegments,
        typedText,
        inputMethod,
        inkRef: latestInkRef || persisted?.units?.[0]?.inkRef || null,
      })],
      createdAt: persisted?.createdAt ?? createdAt,
      updatedAt: Date.now(),
      committedAt: null,
      revision: persisted?.revision ?? 0,
    };
      return services.commands.commitTranslationAndEnterW3({
      ...commandContext,
      revisionId,
      snapshotId,
      translationRevision,
      translationExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W2_EN_ZH}
      onBack={immersive ? onExitImmersive : onBack}
      compact
      immersive={immersive}
      actions={<WorkspaceViewActions layout={layout} onToggleLayout={onToggleLayout} immersive={immersive} onToggleImmersive={onToggleImmersive} primaryAction={actionButton("提交完整中文译文", "w2-commit", busyAction, commit, { disabled: showsText && !typedText.trim() })} />}
    >
      <WritingSplitWorkspace
        stage={WritingStage.W2_EN_ZH}
        username={username}
        layout={layout}
        sourceLabel="完整英文范文"
        sourcePane={<DocumentText text={vm.sampleEssayText} />}
        workLabel="我的完整中文翻译"
        workActions={<InputModePicker value={inputMethod} onChange={(value) => { setInputMethod(value); setDraftChangeToken((token) => token + 1); }} disabled={busyAction === "w2-commit"} />}
        workPane={(
          <>
            {showsText ? <section className="writing-editor-card writing-document-editor"><label><span>完整中文译文</span><textarea rows={20} value={typedText} onChange={(event) => { setTypedText(event.target.value); setDraftChangeToken((token) => token + 1); }} placeholder="在这里完成整篇中文翻译，可按自然段分隔" /></label></section> : null}
            {showsInk ? (
              <InkComposer
                username={username}
                sessionId={vm.sessionId}
                stageId={WritingStage.W2_EN_ZH}
                ownerRecordId={revisionId}
                surfaceId={`w2:translation:${revisionId}`}
                sourceFingerprint={draftFingerprint(revisionId, latestInkRef || vm.translationInkRef)}
                flushBridge={inkFlushBridge}
                InkSurface={InkSurfaceComponent}
                onInkRefChange={(inkRef) => {
                  setLatestInkRef(inkRef);
                  if (inkRef?.fingerprint !== persistedRef.current?.units?.find((unit) => unit.inkRef)?.inkRef?.fingerprint) {
                    setDraftChangeToken((token) => token + 1);
                  }
                }}
                showHeading={false}
                pageLabel="按自然段完成整篇中文译文"
              />
            ) : null}
          </>
        )}
      />
    </WritingStageShell>
  );
}

function VerificationEditor({ value, onChange, title = "AI 转写草稿", hint, busy, onConfirm, onManual }) {
  return (
    <section className="writing-verification">
      <div className="writing-section-heading"><div><h2>{title}</h2><p>{hint}</p></div><span>等待你的确认</span></div>
      <label><span>核对后的文字</span><textarea rows={12} value={value} onChange={(event) => onChange(event.target.value)} /></label>
      <div className="writing-inline-actions">
        {onManual ? <button type="button" className="writing-button-ghost" disabled={busy} onClick={onManual}>改为手动录入</button> : null}
        <button type="button" className="primary-button" disabled={busy || !value.trim()} onClick={onConfirm}>{busy ? "正在提交…" : "确认文字并提交"}</button>
      </div>
    </section>
  );
}

export function W3BackTranslationStage({ vm, commandContext, services, username, createId, inkFlushBridge, busyAction, onAction, onBack, registerExitBarrier, onDraftError, layout = "split", onToggleLayout, immersive = false, onToggleImmersive, onExitImmersive, InkComposer = WritingInkComposer, ReadonlyInkSurface = WritingInkSurface }) {
  const mounted = useMountedFlag();
  const current = vm.currentBackTranslationAttempt;
  const persistedRef = useRef(current);
  const attemptId = useStableValue(() => current?.attemptId || createId("w3-attempt"));
  const attemptCreatedAt = useStableValue(() => current?.createdAt || Date.now());
  const transcriptionId = useStableValue(() => vm.transcriptionDraft?.transcriptionId || createId("w3-transcription"));
  const [inputMethod, setInputMethod] = useState(() => visibleInputMethod(current?.inputMethod, current?.typedText));
  const [typedText, setTypedText] = useState(current?.typedText || "");
  const [confirmTyped, setConfirmTyped] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [verificationText, setVerificationText] = useState(vm.transcriptionDraft?.rawTranscript || "");
  const [localTranscriptionId, setLocalTranscriptionId] = useState(null);
  const [verificationAttemptRevision, setVerificationAttemptRevision] = useState(null);
  const [latestInkRef, setLatestInkRef] = useState(current?.inkRef || null);
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const verifying = Boolean(vm.transcriptionDraft || localTranscriptionId || manualMode || vm.transcriptionVerificationState === "verifying");

  useEffect(() => {
    if (vm.transcriptionDraft?.rawTranscript && !verificationText) setVerificationText(vm.transcriptionDraft.rawTranscript);
  }, [verificationText, vm.transcriptionDraft]);

  const draft = () => attemptInput(persistedRef.current, attemptId, inputMethod, typedText, attemptCreatedAt);

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { inputMethod, typedText, latestInkRef },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot, { flushInk = false } = {}) => {
      const persisted = persistedRef.current;
      if (typeof services.commands.saveAttemptDraft !== "function") return persisted;
      const result = await services.commands.saveAttemptDraft({
        ...commandContext,
        stageId: WritingStage.W3_BACK_TRANSLATION,
        attemptId,
        attempt: {
          ...attemptInput(persisted, attemptId, draftSnapshot.inputMethod, draftSnapshot.typedText, attemptCreatedAt),
          inkRef: draftSnapshot.latestInkRef || persisted?.inkRef || null,
        },
        attemptExpectedRevision: persisted?.revision ?? 0,
        flushInk: flushInk && draftSnapshot.inputMethod === WritingInputMethod.HANDWRITING,
      });
      persistedRef.current = result.attempt;
      if (result.attempt?.inkRef) setLatestInkRef(result.attempt.inkRef);
      return result.attempt;
    },
  });

  async function prepareRaw() {
    await saveDraft({ flushInk: true });
    const persisted = persistedRef.current;
    if (["raw_submitted", "verifying"].includes(persisted?.status)) return persisted;
    return services.commands.prepareBackTranslationHandwritingForVerification({
      ...commandContext,
      attemptId,
      attempt: { ...draft(), inputMethod: WritingInputMethod.HANDWRITING },
      translationSnapshotId: vm.translationSnapshot.snapshotId,
      attemptExpectedRevision: persisted?.revision ?? 0,
    });
  }

  async function recognize() {
    await onAction("w3-vision", async () => {
      const prepared = await prepareRaw();
      const attempt = prepared?.attempt || prepared || current;
      const transcription = await services.vision.transcribeWritingAttempt({ sessionId: vm.sessionId, attemptId, transcriptionId });
      const attached = await services.commands.attachTranscriptionForVerification({
        ...commandContext,
        attemptId,
        transcriptionId: transcription.transcriptionId,
        attemptExpectedRevision: attempt.revision,
      });
      if (mounted.current) {
        setManualMode(false);
        setLocalTranscriptionId(transcription.transcriptionId);
        setVerificationAttemptRevision(attached?.attempt?.revision ?? attached?.revision ?? null);
        setVerificationText(transcription.rawTranscript || "");
      }
    });
  }

  async function openManual() {
    await onAction("w3-manual", async () => {
      const prepared = await prepareRaw();
      if (mounted.current) {
        setManualMode(true);
        setVerificationAttemptRevision(prepared?.attempt?.revision ?? prepared?.revision ?? null);
        if (!verificationText) setVerificationText(typedText);
      }
    });
  }

  async function submitVerified() {
    const source = (vm.transcriptionDraft || localTranscriptionId) && !manualMode
      ? WritingVerifiedTextSource.TRANSCRIPTION
      : WritingVerifiedTextSource.MANUAL_ENTRY;
    await onAction("w3-verify", () => services.commands.submitBackTranslationHandwritingAndEnterW4({
      ...commandContext,
      attemptId,
      translationSnapshotId: vm.translationSnapshot.snapshotId,
      text: verificationText,
      source,
      transcriptionId: source === WritingVerifiedTextSource.TRANSCRIPTION ? vm.transcriptionDraft?.transcriptionId || localTranscriptionId : null,
      attemptExpectedRevision: verificationAttemptRevision ?? persistedRef.current?.revision ?? 0,
    }));
  }

  async function submitTyped() {
    await onAction("w3-typed", async () => {
      await saveDraft({ flushInk: false });
      const persisted = persistedRef.current;
      return services.commands.submitBackTranslationAndEnterW4({
      ...commandContext,
      attemptId,
      translationSnapshotId: vm.translationSnapshot.snapshotId,
      attempt: { ...draft(), inputMethod: WritingInputMethod.TYPED, typedText },
      attemptExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W3_BACK_TRANSLATION}
      onBack={immersive ? onExitImmersive : onBack}
      compact
      immersive={immersive}
      actions={<WorkspaceViewActions
        layout={layout}
        onToggleLayout={onToggleLayout}
        immersive={immersive}
        onToggleImmersive={onToggleImmersive}
        primaryAction={inputMethod === WritingInputMethod.TYPED
          ? actionButton("提交完整英文反译", "w3-typed", busyAction, () => setConfirmTyped(true), { disabled: !typedText.trim() })
          : !verifying
            ? actionButton("识别手写内容", "w3-vision", busyAction, recognize, { busyLabel: "正在识别…" })
            : null}
      />}
    >
      <WritingSplitWorkspace
        stage={WritingStage.W3_BACK_TRANSLATION}
        username={username}
        layout={layout}
        sourceLabel="我在 W2 保存的完整中文译文"
        sourcePane={<FrozenTranslationSource username={username} sessionId={vm.sessionId} snapshot={vm.translationSnapshot} InkSurface={ReadonlyInkSurface} />}
        workLabel="我的完整英文反译"
        workActions={<InputModePicker value={inputMethod} onChange={(value) => { setInputMethod(value); setDraftChangeToken((token) => token + 1); }} />}
        workPane={(
          <>
            {inputMethod === WritingInputMethod.TYPED ? (
              <section className="writing-editor-card writing-document-editor">
                <label><span>完整英文反译</span><textarea rows={20} value={typedText} onChange={(event) => { setTypedText(event.target.value); setDraftChangeToken((token) => token + 1); }} placeholder="根据左侧完整中文译文，重写整篇英文" /></label>
                {!confirmTyped ? <button type="button" className="primary-button" disabled={!typedText.trim()} onClick={() => setConfirmTyped(true)}>准备提交完整反译</button> : (
                  <WritingConfirmPanel title="提交正式回译？" confirmLabel="确认提交" busy={busyAction === "w3-typed"} onCancel={() => setConfirmTyped(false)} onConfirm={submitTyped}>
                    确认后的整篇文字会进入下一阶段，与范文进行对照。
                  </WritingConfirmPanel>
                )}
              </section>
            ) : (
              <>
                <InkComposer
                  username={username}
                  sessionId={vm.sessionId}
                  stageId={WritingStage.W3_BACK_TRANSLATION}
                  ownerRecordId={attemptId}
                  surfaceId={`w3:back:${attemptId}`}
                  sourceFingerprint={draftFingerprint(attemptId, latestInkRef || current?.inkRef)}
                  flushBridge={inkFlushBridge}
                  onInkRefChange={(inkRef) => {
                    setLatestInkRef(inkRef);
                    if (inkRef?.fingerprint !== persistedRef.current?.inkRef?.fingerprint) setDraftChangeToken((token) => token + 1);
                  }}
                  showHeading={false}
                  pageLabel="根据左侧中文译文完成整篇英文"
                />
                {!verifying ? (
                  <div className="writing-ai-action-row">
                    {immersive ? actionButton("识别手写内容", "w3-vision", busyAction, recognize, { busyLabel: "正在识别…" }) : null}
                    <button type="button" className="writing-button-ghost" disabled={busyAction === "w3-manual"} onClick={openManual}>手动录入</button>
                  </div>
                ) : (
                  <VerificationEditor
                    value={verificationText}
                    onChange={setVerificationText}
                    title={manualMode ? "手动录入" : "AI 识别结果"}
                    hint="请核对识别结果。只有确认后的文字会用于后续对照。"
                    busy={busyAction === "w3-verify"}
                    onManual={() => setManualMode(true)}
                    onConfirm={submitVerified}
                  />
                )}
              </>
            )}
          </>
        )}
      />
    </WritingStageShell>
  );
}

function DiagnosisList({ label, items }) {
  if (!items?.length) return null;
  return (
    <section className="writing-diagnosis-group"><h4>{label}</h4>{items.map((item, index) => (
      <article key={`${label}:${index}`}><q>{item.excerpt}</q><p>{item.explanation}</p><strong>{item.suggestion}</strong></article>
    ))}</section>
  );
}

export function W4CompareStage({ vm, commandContext, services, createId, busyAction, onAction, onBack }) {
  const mounted = useMountedFlag();
  const artifactId = useStableValue(() => vm.compareDiagnosisArtifactId || createId("compare"));
  const [savedPatterns, setSavedPatterns] = useState(() => new Set());
  const [compareMode, setCompareMode] = useState("document");
  const userText = vm.submittedBackTranslation?.verifiedText?.text || "";
  const sampleById = new Map(vm.sampleSegments.map((unit) => [unit.unitId, unit]));

  async function diagnose() {
    await onAction("w4-ai", () => services.textAi.diagnoseWritingComparison({
      sessionId: vm.sessionId,
      backTranslationAttemptId: vm.submittedBackTranslation.attemptId,
      artifactId,
    }));
  }

  async function savePattern(unitId, pattern, patternIndex) {
    const key = `${unitId}:${patternIndex}`;
    if (!pattern.userExcerpt || !vm.compareDiagnosisArtifactId) return;
    await onAction(`w4-learning:${key}`, async () => {
      await services.integration.confirmWritingLearningItem({
        itemId: createId("learning-item"),
        sessionId: vm.sessionId,
        sourceText: pattern.userExcerpt,
        sourceUnitId: unitId,
        sourceAttemptId: vm.submittedBackTranslation.attemptId,
        sourceArtifactId: vm.compareDiagnosisArtifactId,
        kind: WritingLearningItemKind.EXPRESSION,
        origin: WritingLearningItemOrigin.AI_SUGGESTED_CONFIRMED,
        cueZh: pattern.reason,
      });
      if (mounted.current) setSavedPatterns((current) => new Set(current).add(key));
    }, { reload: false });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W4_COMPARE_DIAGNOSE}
      onBack={onBack}
      description="先看原表达和你的回译差异；AI 分析是可选辅助，不会阻塞流程。"
      actions={actionButton("完成对照", "w4-complete", busyAction, () => onAction("w4-complete", () => services.commands.completeCompareAndEnterW5(commandContext)))}
    >
      <section className="writing-base-compare">
        <div className="writing-section-heading">
          <div><h2>整篇对照</h2><p>默认同时查看我的中文、我的反译和范文原文。</p></div>
          <div className="writing-view-modes" role="group" aria-label="对照视图">
            <button type="button" className={compareMode === "document" ? "is-active" : ""} aria-pressed={compareMode === "document"} onClick={() => setCompareMode("document")}>整篇</button>
            <button type="button" className={compareMode === "diagnostic" ? "is-active" : ""} aria-pressed={compareMode === "diagnostic"} onClick={() => setCompareMode("diagnostic")}>逐句诊断</button>
          </div>
        </div>
        {compareMode === "document" ? (
          <div className="writing-compare-document-grid">
            <section><h3>我的中文</h3><DocumentText text={translationDocument(vm.translationSnapshot.units)} /></section>
            <section><h3>我的反译</h3><DocumentText text={userText} /></section>
            <section><h3>范文原文</h3><DocumentText text={vm.sampleEssayText} /></section>
          </div>
        ) : (
          <div className="writing-compare-grid">
            <div>{vm.sampleSegments.map((unit) => <p key={unit.unitId}>{unit.text}</p>)}</div>
            <div><p>{userText}</p></div>
          </div>
        )}
      </section>
      <section className="writing-ai-panel">
        <div className="writing-section-heading">
          <div><h2>AI 对照分析</h2><p>从含义、语法、搭配、自然度与语域逐项诊断。</p></div>
          {actionButton(vm.compareDiagnosis ? "重新分析" : "开始分析", "w4-ai", busyAction, diagnose, { className: "writing-button-secondary", busyLabel: "正在分析…" })}
        </div>
        {!vm.compareDiagnosis ? <p className="writing-empty-copy">尚未请求 AI 分析。你仍可直接完成本阶段。</p> : (
          <div className="writing-diagnosis-units">
            {vm.compareDiagnosis.units.map((unit, unitIndex) => (
              <article key={unit.unitId} className="writing-diagnosis-unit">
                <header><span>{String(unitIndex + 1).padStart(2, "0")}</span><strong>{sampleById.get(unit.unitId)?.text}</strong></header>
                <div className="writing-meaning-row"><b>含义</b><span>{unit.meaning.status}</span><p>{unit.meaning.evidence}</p></div>
                <DiagnosisList label="语法" items={unit.grammar} />
                <DiagnosisList label="搭配" items={unit.collocation} />
                <DiagnosisList label="自然度" items={unit.naturalness} />
                <DiagnosisList label="语域" items={unit.register} />
                {unit.learnablePatterns?.length ? (
                  <section className="writing-learning-patterns"><h4>可学习表达</h4>{unit.learnablePatterns.map((pattern, patternIndex) => {
                    const key = `${unit.unitId}:${patternIndex}`;
                    return (
                      <article key={key}>
                        <div><strong>{pattern.sampleExcerpt}</strong><p>{pattern.reason}</p></div>
                        <button type="button" disabled={!pattern.userExcerpt || savedPatterns.has(key)} onClick={() => savePattern(unit.unitId, pattern, patternIndex)}>
                          {savedPatterns.has(key) ? "已加入" : pattern.userExcerpt ? "加入学习项" : "缺少用户片段"}
                        </button>
                      </article>
                    );
                  })}</section>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </WritingStageShell>
  );
}

const SKELETON_KIND_LABELS = Object.freeze({ idea: "观点", logic: "逻辑", phrase: "表达", keyword: "关键词" });

export function W5SkeletonStage({ vm, commandContext, services, username, createId, inkFlushBridge, busyAction, onAction, onBack, registerExitBarrier, onDraftError, InkComposer = WritingInkComposer }) {
  const current = vm.currentSkeletonRevision;
  const persistedRef = useRef(current);
  const revisionId = useStableValue(() => current?.revisionId || createId("skeleton"));
  const revisionCreatedAt = useStableValue(() => current?.createdAt || Date.now());
  const w6AttemptId = useStableValue(() => createId("w6-attempt"));
  const w6CreatedAt = useStableValue(() => Date.now());
  const [blocks, setBlocks] = useState(() => current?.blocks?.length
    ? current.blocks.map((block) => ({ ...block }))
    : [{ order: 0, kind: "idea", text: "" }]);
  const [showInk, setShowInk] = useState(Boolean(current?.inkRef));
  const [pendingChoice, setPendingChoice] = useState(null);
  const [latestInkRef, setLatestInkRef] = useState(current?.inkRef || null);
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const usableBlocks = blocks.filter((block) => block.text.trim()).map((block, index) => ({ ...block, order: index }));

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { blocks, showInk, latestInkRef },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot, { flushInk = false } = {}) => {
      const persisted = persistedRef.current;
      if (typeof services.commands.saveSkeletonDraft !== "function") return persisted;
      const result = await services.commands.saveSkeletonDraft({
        ...commandContext,
        revisionId,
        skeletonRevision: {
          ...(persisted || {}),
          revisionId,
          revisionNumber: persisted?.revisionNumber || 1,
          status: "draft",
          basedOnRevisionId: persisted?.basedOnRevisionId ?? null,
          blocks: draftSnapshot.blocks.map((block, order) => ({ ...block, order })),
          inkRef: draftSnapshot.showInk ? draftSnapshot.latestInkRef || persisted?.inkRef || null : null,
          createdAt: persisted?.createdAt ?? revisionCreatedAt,
          updatedAt: Date.now(),
          committedAt: null,
          revision: persisted?.revision ?? 0,
        },
        skeletonExpectedRevision: persisted?.revision ?? 0,
        requiresInk: draftSnapshot.showInk,
        flushInk: flushInk && draftSnapshot.showInk,
      });
      persistedRef.current = result.skeletonRevision;
      if (result.skeletonRevision?.inkRef) setLatestInkRef(result.skeletonRevision.inkRef);
      return result.skeletonRevision;
    },
  });

  function updateBlock(index, patchValue) {
    setBlocks((items) => items.map((block, blockIndex) => blockIndex === index ? { ...block, ...patchValue } : block));
    setDraftChangeToken((token) => token + 1);
  }

  function moveBlock(index, direction) {
    setBlocks((items) => {
      const target = index + direction;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((block, order) => ({ ...block, order }));
    });
    setDraftChangeToken((token) => token + 1);
  }

  async function confirmBranch() {
    const [outcome, nextStage] = pendingChoice.split(":");
    const completing = outcome === WritingSkeletonOutcome.COMPLETED;
    const enteringW6 = nextStage === WritingStage.W6_RECONSTRUCTION;
    await onAction("w5-branch", async () => {
      if (completing) await saveDraft({ flushInk: showInk });
      const persisted = persistedRef.current;
      const skeletonRevision = completing ? {
        ...(persisted || {}),
        revisionId,
        revisionNumber: persisted?.revisionNumber || 1,
        status: "draft",
        basedOnRevisionId: persisted?.basedOnRevisionId ?? null,
        blocks: usableBlocks,
        inkRef: latestInkRef || persisted?.inkRef || null,
        createdAt: persisted?.createdAt ?? revisionCreatedAt,
        updatedAt: Date.now(),
        committedAt: null,
        revision: persisted?.revision ?? 0,
      } : null;
      return services.commands.finishOrSkipSkeleton({
        ...commandContext,
        outcome,
        nextStage,
        skeletonRevisionId: completing ? revisionId : null,
        skeletonRevision,
        skeletonExpectedRevision: persisted?.revision ?? 0,
        requiresInk: completing && showInk,
        inputMethod: showInk ? WritingInputMethod.MIXED : WritingInputMethod.TYPED,
        w6AttemptId: enteringW6 ? w6AttemptId : null,
        w6Attempt: enteringW6 ? {
          attemptId: w6AttemptId,
          inputMethod: WritingInputMethod.TYPED,
          typedText: "",
          createdAt: w6CreatedAt,
          revision: 0,
        } : null,
      });
    });
  }

  const choiceText = pendingChoice?.startsWith(WritingSkeletonOutcome.SKIPPED)
    ? "跳过后不会创建虚假的骨架记录。"
    : "当前骨架会正式冻结，后续只绑定这一个版本。";

  return (
    <WritingStageShell stage={WritingStage.W5_SKELETON} onBack={onBack} description="可以先整理观点与逻辑，也可以明确跳过。是否做骨架不会改变正式阶段编号。">
      <WritingStageNotice title="本阶段可选">你可以完成骨架后进入重构练习，也可以直接进入独立作文。</WritingStageNotice>
      <section className="writing-skeleton-editor">
        <div className="writing-section-heading">
          <div><h2>骨架编辑器</h2><p>用观点、逻辑、表达和关键词搭出文章路线。</p></div>
          <button type="button" className="writing-button-secondary" onClick={() => { setBlocks((items) => [...items, { order: items.length, kind: "idea", text: "" }]); setDraftChangeToken((token) => token + 1); }}>新增一行</button>
        </div>
        <div className="writing-skeleton-blocks">
          {blocks.map((block, index) => (
            <article key={`${index}:${block.order}`}>
              <span className="writing-drag-index">{String(index + 1).padStart(2, "0")}</span>
              <select aria-label={`骨架第 ${index + 1} 行类型`} value={block.kind} onChange={(event) => updateBlock(index, { kind: event.target.value })}>
                {Object.entries(SKELETON_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input aria-label={`骨架第 ${index + 1} 行内容`} value={block.text} onChange={(event) => updateBlock(index, { text: event.target.value })} placeholder="写下这一行的核心内容" />
              <div className="writing-order-actions">
                <button type="button" aria-label="上移" disabled={index === 0} onClick={() => moveBlock(index, -1)}>↑</button>
                <button type="button" aria-label="下移" disabled={index === blocks.length - 1} onClick={() => moveBlock(index, 1)}>↓</button>
                <button type="button" aria-label="删除" disabled={blocks.length === 1} onClick={() => { setBlocks((items) => items.filter((_, itemIndex) => itemIndex !== index).map((item, order) => ({ ...item, order }))); setDraftChangeToken((token) => token + 1); }}>×</button>
              </div>
            </article>
          ))}
        </div>
        <label className="writing-ink-toggle"><input type="checkbox" checked={showInk} onChange={(event) => { setShowInk(event.target.checked); setDraftChangeToken((token) => token + 1); }} /><span>同时保留手写补充</span></label>
      </section>
      {showInk ? (
        <InkComposer
          username={username}
          sessionId={vm.sessionId}
          stageId={WritingStage.W5_SKELETON}
          ownerRecordId={revisionId}
          surfaceId={`w5:skeleton:${revisionId}`}
          sourceFingerprint={draftFingerprint(revisionId, latestInkRef || current?.inkRef)}
          flushBridge={inkFlushBridge}
          onInkRefChange={(inkRef) => {
            setLatestInkRef(inkRef);
            if (inkRef?.fingerprint !== persistedRef.current?.inkRef?.fingerprint) setDraftChangeToken((token) => token + 1);
          }}
          title="骨架手写补充"
          pageLabel="补充结构、箭头或关键词"
        />
      ) : null}
      <section className="writing-branch-grid" aria-label="骨架下一步">
        <article><h3>完成骨架</h3><p>冻结当前骨架，再选择是否做重构练习。</p><div><button type="button" disabled={!usableBlocks.length && !showInk} onClick={() => setPendingChoice(`${WritingSkeletonOutcome.COMPLETED}:${WritingStage.W6_RECONSTRUCTION}`)}>完成 → 重构练习</button><button type="button" disabled={!usableBlocks.length && !showInk} onClick={() => setPendingChoice(`${WritingSkeletonOutcome.COMPLETED}:${WritingStage.W7_INDEPENDENT}`)}>完成 → 独立作文</button></div></article>
        <article><h3>跳过骨架</h3><p>不创建骨架记录，继续后续正式流程。</p><div><button type="button" onClick={() => setPendingChoice(`${WritingSkeletonOutcome.SKIPPED}:${WritingStage.W6_RECONSTRUCTION}`)}>跳过 → 重构练习</button><button type="button" onClick={() => setPendingChoice(`${WritingSkeletonOutcome.SKIPPED}:${WritingStage.W7_INDEPENDENT}`)}>跳过 → 独立作文</button></div></article>
      </section>
      {pendingChoice ? <WritingConfirmPanel title="确认这条学习路径？" confirmLabel="确认并继续" busy={busyAction === "w5-branch"} onCancel={() => setPendingChoice(null)} onConfirm={confirmBranch}>{choiceText}</WritingConfirmPanel> : null}
    </WritingStageShell>
  );
}

export function W6ReconstructionStage({ vm, commandContext, services, username, createId, inkFlushBridge, busyAction, onAction, onBack, registerExitBarrier, onDraftError, layout = "split", onToggleLayout, immersive = false, onToggleImmersive, onExitImmersive, InkComposer = WritingInkComposer }) {
  const current = vm.currentReconstructionAttempt;
  const persistedRef = useRef(current);
  const attemptId = useStableValue(() => current?.attemptId || createId("w6-attempt"));
  const attemptCreatedAt = useStableValue(() => current?.createdAt || Date.now());
  const [inputMethod, setInputMethod] = useState(() => visibleInputMethod(current?.inputMethod, current?.typedText));
  const [typedText, setTypedText] = useState(current?.typedText || "");
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [latestInkRef, setLatestInkRef] = useState(current?.inkRef || null);
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const showsText = inputMethod === WritingInputMethod.TYPED;
  const showsInk = inputMethod === WritingInputMethod.HANDWRITING;
  const draft = () => attemptInput(persistedRef.current, attemptId, inputMethod, typedText, attemptCreatedAt);

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { inputMethod, typedText, latestInkRef },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot, { flushInk = false } = {}) => {
      const persisted = persistedRef.current;
      if (typeof services.commands.saveAttemptDraft !== "function") return persisted;
      const result = await services.commands.saveAttemptDraft({
        ...commandContext,
        stageId: WritingStage.W6_RECONSTRUCTION,
        attemptId,
        attempt: {
          ...attemptInput(persisted, attemptId, draftSnapshot.inputMethod, draftSnapshot.typedText, attemptCreatedAt),
          inkRef: draftSnapshot.latestInkRef || persisted?.inkRef || null,
        },
        attemptExpectedRevision: persisted?.revision ?? 0,
        flushInk: flushInk && draftSnapshot.inputMethod === WritingInputMethod.HANDWRITING,
      });
      persistedRef.current = result.attempt;
      if (result.attempt?.inkRef) setLatestInkRef(result.attempt.inkRef);
      return result.attempt;
    },
  });

  async function submit() {
    await onAction("w6-submit", async () => {
      await saveDraft({ flushInk: showsInk });
      const persisted = persistedRef.current;
      return services.commands.finishOrSkipReconstruction({
      ...commandContext,
      outcome: WritingReconstructionOutcome.SUBMITTED,
      attemptId,
      attempt: draft(),
      attemptExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  async function skip() {
    await onAction("w6-skip", async () => {
      await saveDraft({ flushInk: showsInk });
      const persisted = persistedRef.current;
      return services.commands.finishOrSkipReconstruction({
      ...commandContext,
      outcome: WritingReconstructionOutcome.SKIPPED,
      attempt: draft(),
      attemptExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W6_RECONSTRUCTION}
      onBack={immersive ? onExitImmersive : onBack}
      compact
      immersive={immersive}
      actions={<WorkspaceViewActions layout={layout} onToggleLayout={onToggleLayout} immersive={immersive} onToggleImmersive={onToggleImmersive} primaryAction={actionButton("完成重构并继续", "w6-submit", busyAction, submit, { disabled: showsText && !typedText.trim() })} />}
    >
      <WritingSplitWorkspace
        stage={WritingStage.W6_RECONSTRUCTION}
        username={username}
        layout={layout}
        sourceLabel="我的思想骨架"
        sourcePane={vm.skeletonRevision?.blocks?.length ? (
          <ol className="writing-skeleton-source">{vm.skeletonRevision.blocks.map((block) => <li key={`${block.order}:${block.kind}:${block.text}`}><small>{SKELETON_KIND_LABELS[block.kind] || block.kind}</small><p>{block.text}</p></li>)}</ol>
        ) : <WritingStageNotice title="本次未使用骨架">可以直接完成重构，也可以跳过进入独立作文。</WritingStageNotice>}
        workLabel="闭卷重构"
        workActions={<InputModePicker value={inputMethod} onChange={(value) => { setInputMethod(value); setDraftChangeToken((token) => token + 1); }} />}
        workPane={(
          <>
            {showsText ? <section className="writing-editor-card writing-document-editor"><label><span>完整重构稿</span><textarea rows={20} value={typedText} onChange={(event) => { setTypedText(event.target.value); setDraftChangeToken((token) => token + 1); }} placeholder="根据左侧思想骨架重新组织一篇完整英文" /></label></section> : null}
            {showsInk ? (
              <InkComposer
                username={username}
                sessionId={vm.sessionId}
                stageId={WritingStage.W6_RECONSTRUCTION}
                ownerRecordId={attemptId}
                surfaceId={`w6:reconstruction:${attemptId}`}
                sourceFingerprint={draftFingerprint(attemptId, latestInkRef || current?.inkRef)}
                flushBridge={inkFlushBridge}
                onInkRefChange={(inkRef) => {
                  setLatestInkRef(inkRef);
                  if (inkRef?.fingerprint !== persistedRef.current?.inkRef?.fingerprint) setDraftChangeToken((token) => token + 1);
                }}
                showHeading={false}
                pageLabel="根据左侧骨架完成整篇重构"
              />
            ) : null}
          </>
        )}
      />
      <div className="writing-skip-row"><button type="button" className="writing-button-ghost" onClick={() => setConfirmSkip(true)}>跳过重构</button><span>跳过会保留当前草稿与笔迹，不会提交为正式重构。</span></div>
      {confirmSkip ? <WritingConfirmPanel title="确认跳过重构？" confirmLabel="保留草稿并跳过" busy={busyAction === "w6-skip"} onCancel={() => setConfirmSkip(false)} onConfirm={skip}>你将直接进入独立作文；当前 W6 草稿与笔迹不会被清除。</WritingConfirmPanel> : null}
    </WritingStageShell>
  );
}

export function W7IndependentStage({ vm, commandContext, services, username, createId, inkFlushBridge, busyAction, onAction, onBack, registerExitBarrier, onDraftError, layout = "split", onToggleLayout, immersive = false, onToggleImmersive, onExitImmersive, InkComposer = WritingInkComposer }) {
  const mounted = useMountedFlag();
  const current = vm.currentIndependentAttempt;
  const persistedRef = useRef(current);
  const attemptId = useStableValue(() => current?.attemptId || createId("w7-attempt"));
  const attemptCreatedAt = useStableValue(() => current?.createdAt || Date.now());
  const transcriptionId = useStableValue(() => vm.transcriptionDraft?.transcriptionId || createId("w7-transcription"));
  const [inputMethod, setInputMethod] = useState(() => visibleInputMethod(current?.inputMethod, current?.typedText));
  const [typedText, setTypedText] = useState(current?.typedText || "");
  const [confirmTyped, setConfirmTyped] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [verificationText, setVerificationText] = useState(vm.transcriptionDraft?.rawTranscript || "");
  const [localTranscriptionId, setLocalTranscriptionId] = useState(null);
  const [verificationAttemptRevision, setVerificationAttemptRevision] = useState(null);
  const [latestInkRef, setLatestInkRef] = useState(current?.inkRef || null);
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const verifying = Boolean(vm.transcriptionDraft || localTranscriptionId || manualMode || vm.transcriptionVerificationState === "verifying");

  useEffect(() => {
    if (vm.transcriptionDraft?.rawTranscript && !verificationText) setVerificationText(vm.transcriptionDraft.rawTranscript);
  }, [verificationText, vm.transcriptionDraft]);

  const draft = () => attemptInput(persistedRef.current, attemptId, inputMethod, typedText, attemptCreatedAt);

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { inputMethod, typedText, latestInkRef },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot, { flushInk = false } = {}) => {
      const persisted = persistedRef.current;
      if (typeof services.commands.saveAttemptDraft !== "function") return persisted;
      const result = await services.commands.saveAttemptDraft({
        ...commandContext,
        stageId: WritingStage.W7_INDEPENDENT,
        attemptId,
        attempt: {
          ...attemptInput(persisted, attemptId, draftSnapshot.inputMethod, draftSnapshot.typedText, attemptCreatedAt),
          inkRef: draftSnapshot.latestInkRef || persisted?.inkRef || null,
        },
        attemptExpectedRevision: persisted?.revision ?? 0,
        flushInk: flushInk && draftSnapshot.inputMethod === WritingInputMethod.HANDWRITING,
      });
      persistedRef.current = result.attempt;
      if (result.attempt?.inkRef) setLatestInkRef(result.attempt.inkRef);
      return result.attempt;
    },
  });

  async function prepareRaw() {
    await saveDraft({ flushInk: true });
    const persisted = persistedRef.current;
    if (["raw_submitted", "verifying"].includes(persisted?.status)) return persisted;
    return services.commands.prepareIndependentHandwritingForVerification({
      ...commandContext,
      attemptId,
      attempt: { ...draft(), inputMethod: WritingInputMethod.HANDWRITING },
      attemptExpectedRevision: persisted?.revision ?? 0,
    });
  }

  async function recognize() {
    await onAction("w7-vision", async () => {
      const prepared = await prepareRaw();
      const attempt = prepared?.attempt || prepared || current;
      const transcription = await services.vision.transcribeWritingAttempt({ sessionId: vm.sessionId, attemptId, transcriptionId });
      const attached = await services.commands.attachTranscriptionForVerification({
        ...commandContext,
        attemptId,
        transcriptionId: transcription.transcriptionId,
        attemptExpectedRevision: attempt.revision,
      });
      if (mounted.current) {
        setManualMode(false);
        setLocalTranscriptionId(transcription.transcriptionId);
        setVerificationAttemptRevision(attached?.attempt?.revision ?? attached?.revision ?? null);
        setVerificationText(transcription.rawTranscript || "");
      }
    });
  }

  async function openManual() {
    await onAction("w7-manual", async () => {
      const prepared = await prepareRaw();
      if (mounted.current) {
        setManualMode(true);
        setVerificationAttemptRevision(prepared?.attempt?.revision ?? prepared?.revision ?? null);
        if (!verificationText) setVerificationText(typedText);
      }
    });
  }

  async function submitVerified() {
    const source = (vm.transcriptionDraft || localTranscriptionId) && !manualMode ? WritingVerifiedTextSource.TRANSCRIPTION : WritingVerifiedTextSource.MANUAL_ENTRY;
    await onAction("w7-verify", () => services.commands.submitIndependentHandwriting({
      ...commandContext,
      attemptId,
      text: verificationText,
      source,
      transcriptionId: source === WritingVerifiedTextSource.TRANSCRIPTION ? vm.transcriptionDraft?.transcriptionId || localTranscriptionId : null,
      attemptExpectedRevision: verificationAttemptRevision ?? persistedRef.current?.revision ?? 0,
    }));
  }

  async function submitTyped() {
    await onAction("w7-typed", async () => {
      await saveDraft({ flushInk: false });
      const persisted = persistedRef.current;
      return services.commands.submitIndependentTyped({
      ...commandContext,
      attemptId,
      typedText,
      attempt: { ...draft(), inputMethod: WritingInputMethod.TYPED, typedText },
      attemptExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  return (
    <WritingStageShell
      stage={WritingStage.W7_INDEPENDENT}
      onBack={immersive ? onExitImmersive : onBack}
      compact
      immersive={immersive}
      actions={<WorkspaceViewActions
        layout={layout}
        onToggleLayout={onToggleLayout}
        immersive={immersive}
        onToggleImmersive={onToggleImmersive}
        primaryAction={inputMethod === WritingInputMethod.TYPED
          ? actionButton("提交独立作文", "w7-typed", busyAction, () => setConfirmTyped(true), { disabled: !typedText.trim() })
          : !verifying
            ? actionButton("识别手写作文", "w7-vision", busyAction, recognize, { busyLabel: "正在识别…" })
            : null}
      />}
    >
      <WritingSplitWorkspace
        stage={WritingStage.W7_INDEPENDENT}
        username={username}
        layout={layout}
        sourceLabel="原始作文题与约束"
        sourcePane={<PromptCard prompt={vm.promptSnapshot} />}
        workLabel="我的独立作文"
        workActions={<InputModePicker value={inputMethod} onChange={(value) => { setInputMethod(value); setDraftChangeToken((token) => token + 1); }} />}
        workPane={(
          <>
          {inputMethod === WritingInputMethod.TYPED ? (
            <section className="writing-editor-card writing-independent-editor writing-document-editor">
              <label><span>我的独立作文</span><textarea rows={20} value={typedText} onChange={(event) => { setTypedText(event.target.value); setDraftChangeToken((token) => token + 1); }} /></label>
              {!confirmTyped ? <button type="button" className="primary-button" disabled={!typedText.trim()} onClick={() => setConfirmTyped(true)}>准备提交独立作文</button> : (
                <WritingConfirmPanel title="即将作为正式独立作文提交" confirmLabel="确认正式提交" busy={busyAction === "w7-typed"} onCancel={() => setConfirmTyped(false)} onConfirm={submitTyped}>提交成功后才会进入评分阶段；原稿会被永久保留。</WritingConfirmPanel>
              )}
            </section>
          ) : (
            <>
              <InkComposer
                username={username}
                sessionId={vm.sessionId}
                stageId={WritingStage.W7_INDEPENDENT}
                ownerRecordId={attemptId}
                surfaceId={`w7:independent:${attemptId}`}
                sourceFingerprint={draftFingerprint(attemptId, latestInkRef || current?.inkRef)}
                flushBridge={inkFlushBridge}
                onInkRefChange={(inkRef) => {
                  setLatestInkRef(inkRef);
                  if (inkRef?.fingerprint !== persistedRef.current?.inkRef?.fingerprint) setDraftChangeToken((token) => token + 1);
                }}
                showHeading={false}
                pageLabel="只根据题目完成正式作文"
              />
              {!verifying ? <div className="writing-ai-action-row">{immersive ? actionButton("识别手写作文", "w7-vision", busyAction, recognize, { busyLabel: "正在识别…" }) : null}<button type="button" className="writing-button-ghost" disabled={busyAction === "w7-manual"} onClick={openManual}>手动录入</button></div> : (
                <VerificationEditor
                  value={verificationText}
                  onChange={setVerificationText}
                  title={manualMode ? "手动录入正式文字" : "AI 转写草稿"}
                  hint="请核对并修改识别错误。确认后文字才会作为正式作文评分。"
                  busy={busyAction === "w7-verify"}
                  onManual={() => setManualMode(true)}
                  onConfirm={submitVerified}
                />
              )}
            </>
          )}
          </>
        )}
      />
    </WritingStageShell>
  );
}

function ScoreReportView({ score }) {
  if (!score) return null;
  return (
    <section className="writing-score-report">
      <header><div><small>正式评分</small><strong>{score.finalScore}<span>/ {score.maxScore}</span></strong></div><div><b>Band {score.band}</b><span>{score.wordCount} 词 · {score.lengthIssue === "too_short" ? "篇幅偏短" : score.lengthIssue === "too_long" ? "篇幅偏长" : "篇幅合适"}</span></div></header>
      <div className="writing-score-dimensions">
        {Object.entries(DIMENSION_LABELS).map(([key, label]) => {
          const dimension = score.dimensions?.[key];
          return <article key={key}><div><strong>{label}</strong><span>{dimension ? RATING_LABELS[dimension.rating] || dimension.rating : "暂无"}</span></div>{dimension?.comment ? <p>{dimension.comment}</p> : null}{dimension?.evidence?.map((excerpt) => <q key={excerpt}>{excerpt}</q>)}</article>;
        })}
      </div>
      <div className="writing-score-notes">
        <section><h3>做得好的地方</h3>{score.strengths?.length ? <ul>{score.strengths.map((item) => <li key={item}>{item}</li>)}</ul> : <p>本次报告未单列优势。</p>}</section>
        <section><h3>下一稿建议</h3>{score.revisionAdvice?.length ? <ul>{score.revisionAdvice.map((item) => <li key={item}>{item}</li>)}</ul> : <p>本次报告未单列改写建议。</p>}</section>
      </div>
      {score.issues?.length ? <section className="writing-score-issues"><h3>具体问题</h3>{score.issues.map((issue, index) => <article key={`${issue.category}:${index}`}><q>{issue.excerpt}</q><p>{issue.explanation}</p><strong>{issue.suggestion}</strong></article>)}</section> : null}
    </section>
  );
}

export function W8ScoreRewriteStage({ vm, commandContext, services, createId, busyAction, onAction, onBack, registerExitBarrier, onDraftError }) {
  const mounted = useMountedFlag();
  const latestScore = vm.scoreReports.at(-1) || null;
  const latestSubmittedRevision = vm.revisionAttempts.at(-1) || null;
  const latestRevision = vm.currentRevisionAttempt || latestSubmittedRevision;
  const persistedRef = useRef(latestRevision);
  const [selectedScoreId, setSelectedScoreId] = useState(latestScore?.scoreReportId || "");
  const [scoreRequestId, setScoreRequestId] = useState(() => createId("score"));
  const [revisionText, setRevisionText] = useState(latestRevision?.typedText || "");
  const [draftChangeToken, setDraftChangeToken] = useState(0);
  const revisionAttemptId = useStableValue(() => latestRevision?.attemptId || createId("revision"));
  const revisionCreatedAt = useStableValue(() => latestRevision?.createdAt || Date.now());
  const [rewriteRequestId, setRewriteRequestId] = useState(() => createId("reference-rewrite"));
  const selectedScore = vm.scoreReports.find((score) => score.scoreReportId === selectedScoreId) || latestScore;
  const submittedRevision = latestRevision?.status === "submitted" ? latestRevision : latestSubmittedRevision;
  const rewrite = vm.referenceRewriteArtifacts.find((artifact) => artifact.sourceAttemptId === submittedRevision?.attemptId) || null;

  const saveDraft = useDraftPersistence({
    changeToken: draftChangeToken,
    snapshot: { revisionText },
    registerExitBarrier,
    onDraftError,
    saveDraft: async (draftSnapshot) => {
      if (typeof services.commands.saveAttemptDraft !== "function") return persistedRef.current;
      if (persistedRef.current?.status === "submitted") return persistedRef.current;
      const persisted = persistedRef.current;
      const result = await services.commands.saveAttemptDraft({
        ...commandContext,
        stageId: WritingStage.W8_SCORE_REWRITE,
        attemptId: revisionAttemptId,
        parentAttemptId: vm.submittedIndependentAttempt.attemptId,
        attempt: {
          ...attemptInput(persisted, revisionAttemptId, WritingInputMethod.TYPED, draftSnapshot.revisionText, revisionCreatedAt),
          parentAttemptId: vm.submittedIndependentAttempt.attemptId,
        },
        attemptExpectedRevision: persisted?.revision ?? 0,
      });
      persistedRef.current = result.attempt;
      return result.attempt;
    },
  });

  useEffect(() => {
    if (latestScore && !vm.scoreReports.some((score) => score.scoreReportId === selectedScoreId)) setSelectedScoreId(latestScore.scoreReportId);
  }, [latestScore, selectedScoreId, vm.scoreReports]);

  async function requestScore() {
    const requestedId = scoreRequestId;
    await onAction("w8-score", async () => {
      await services.textAi.scoreWritingAttempt({
        sessionId: vm.sessionId,
        attemptId: vm.submittedIndependentAttempt.attemptId,
        scoreReportId: requestedId,
      });
      if (mounted.current) {
        setSelectedScoreId(requestedId);
        setScoreRequestId(createId("score"));
      }
    });
  }

  async function submitRevision() {
    await onAction("w8-revision", async () => {
      await saveDraft();
      const persisted = persistedRef.current;
      return services.commands.submitRevisionAttempt({
      ...commandContext,
      attemptId: revisionAttemptId,
      parentAttemptId: vm.submittedIndependentAttempt.attemptId,
      typedText: revisionText,
      attempt: {
        attemptId: revisionAttemptId,
        parentAttemptId: vm.submittedIndependentAttempt.attemptId,
        inputMethod: WritingInputMethod.TYPED,
        typedText: revisionText,
        createdAt: revisionCreatedAt,
        revision: latestRevision?.revision ?? 0,
      },
      attemptExpectedRevision: persisted?.revision ?? 0,
      });
    });
  }

  async function requestRewrite() {
    if (!submittedRevision || !selectedScore) return;
    const requestedId = rewriteRequestId;
    await onAction("w8-rewrite", async () => {
      await services.textAi.generateReferenceRewrite({
        sessionId: vm.sessionId,
        revisionAttemptId: submittedRevision.attemptId,
        scoreReportId: selectedScore.scoreReportId,
        artifactId: requestedId,
      });
      if (mounted.current) setRewriteRequestId(createId("reference-rewrite"));
    });
  }

  async function complete() {
    await onAction("w8-complete", () => services.commands.completeAfterScoreView({
      ...commandContext,
      scoreReportId: selectedScore.scoreReportId,
    }));
  }

  return (
    <WritingStageShell
      stage={WritingStage.W8_SCORE_REWRITE}
      onBack={onBack}
      description="评分、二稿和参考改写彼此独立；每一步都由你主动触发。"
      actions={selectedScore ? actionButton("完成本次训练", "w8-complete", busyAction, complete) : null}
    >
      <PromptCard prompt={vm.promptSnapshot} compact />
      <section className="writing-original-submission">
        <div className="writing-section-heading"><div><h2>我的独立作文</h2><p>评分只使用这份已确认的正式文字。</p></div><span>{vm.submittedIndependentAttempt.verifiedText?.source === "typed" ? "键盘提交" : "已核对转写"} · {normalizeWords(vm.submittedIndependentAttempt.verifiedText?.text).filter((part) => /^[A-Za-z]/.test(part)).length} 词</span></div>
        <p>{vm.submittedIndependentAttempt.verifiedText?.text}</p>
      </section>
      <section className="writing-score-section">
        <div className="writing-section-heading">
          <div><h2>AI 评分</h2><p>页面打开时不会自动请求；技术失败也不会显示虚假的 0 分。</p></div>
          {actionButton(vm.scoreReports.length ? "重新评分" : "获取 AI 评分", "w8-score", busyAction, requestScore, { className: "writing-button-secondary", busyLabel: "正在评分…" })}
        </div>
        {vm.scoreReports.length > 1 ? <label className="writing-score-history"><span>评分记录</span><select value={selectedScore?.scoreReportId || ""} onChange={(event) => setSelectedScoreId(event.target.value)}>{[...vm.scoreReports].reverse().map((score, index) => <option key={score.scoreReportId} value={score.scoreReportId}>{index === 0 ? "最新评分" : `历史评分 ${vm.scoreReports.length - index}`} · {score.finalScore}/{score.maxScore}</option>)}</select></label> : null}
        {selectedScore ? <ScoreReportView score={selectedScore} /> : <p className="writing-empty-copy">尚无评分报告。你可以先检查原稿，再主动获取评分。</p>}
      </section>
      <section className="writing-revision-section" data-reserved-ink-surface-id={`w8:revision:${revisionAttemptId}`}>
        <div className="writing-section-heading"><div><h2>我的二稿</h2><p>二稿是独立 Attempt，不会覆盖原独立作文。</p></div>{submittedRevision ? <span>已正式提交</span> : <span>草稿</span>}</div>
        <label><span>根据评分完成改写</span><textarea rows={16} value={revisionText} readOnly={Boolean(submittedRevision)} onChange={(event) => { setRevisionText(event.target.value); setDraftChangeToken((token) => token + 1); }} /></label>
        {!submittedRevision ? <button type="button" className="primary-button" disabled={!revisionText.trim() || busyAction === "w8-revision"} onClick={submitRevision}>{busyAction === "w8-revision" ? "正在提交…" : "提交我的二稿"}</button> : null}
      </section>
      <section className="writing-reference-rewrite">
        <div className="writing-section-heading"><div><h2>AI 参考改写</h2><p>必须先正式提交自己的二稿，之后才可单独生成。</p></div><button type="button" className="writing-button-secondary" disabled={!submittedRevision || !selectedScore || busyAction === "w8-rewrite"} onClick={requestRewrite}>{busyAction === "w8-rewrite" ? "正在生成…" : submittedRevision ? "生成参考改写" : "先提交二稿"}</button></div>
        {rewrite ? <div className="writing-rewrite-result"><article><small>AI 参考文本</small><p>{rewrite.result.referenceText}</p></article><section><h3>改动说明</h3>{rewrite.result.changeNotes.map((note, index) => <article key={`${note.category}:${index}`}><strong>{note.category}</strong><p><del>{note.fromExcerpt}</del> → <ins>{note.toExcerpt}</ins></p><span>{note.reason}</span></article>)}</section><section><h3>整体理由</h3><ul>{rewrite.result.rationale.map((item) => <li key={item}>{item}</li>)}</ul></section></div> : <p className="writing-empty-copy">参考改写会显示在独立区域，绝不会写入“我的二稿”输入框。</p>}
      </section>
    </WritingStageShell>
  );
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}

export function WritingDoneStage({ vm, onBack }) {
  const review = vm.reviewStatusSummary || {};
  return (
    <WritingStageShell stage={WritingStage.DONE} onBack={onBack} description="本次写作训练已经完整保存。">
      <section className="writing-done-hero"><span aria-hidden="true">✓</span><div><small>TRAINING COMPLETE</small><h2>本次写作已完成</h2><p>完成日期：{formatDate(vm.completedAt)}</p></div></section>
      <div className="writing-done-grid">
        <article><small>首次完成评分</small>{vm.completionScore ? <strong>{vm.completionScore.finalScore}<span>/ {vm.completionScore.maxScore}</span></strong> : <p>无可用评分摘要</p>}</article>
        <article><small>最新评分</small>{vm.latestScore ? <strong>{vm.latestScore.finalScore}<span>/ {vm.latestScore.maxScore}</span></strong> : <p>无可用评分摘要</p>}</article>
        <article><small>复习任务</small><strong>{(review.pending || 0) + (review.in_progress || 0)}<span> 待处理</span></strong><p>已完成 {review.completed || 0}</p></article>
      </div>
      <WritingStageNotice title="完成状态为只读">打开本页不会修改阶段、评分或复习任务。</WritingStageNotice>
    </WritingStageShell>
  );
}

export const WRITING_STAGE_COMPONENTS = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: W1SampleReadingStage,
  [WritingStage.W2_EN_ZH]: W2TranslationStage,
  [WritingStage.W3_BACK_TRANSLATION]: W3BackTranslationStage,
  [WritingStage.W4_COMPARE_DIAGNOSE]: W4CompareStage,
  [WritingStage.W5_SKELETON]: W5SkeletonStage,
  [WritingStage.W6_RECONSTRUCTION]: W6ReconstructionStage,
  [WritingStage.W7_INDEPENDENT]: W7IndependentStage,
  [WritingStage.W8_SCORE_REWRITE]: W8ScoreRewriteStage,
  [WritingStage.DONE]: WritingDoneStage,
});

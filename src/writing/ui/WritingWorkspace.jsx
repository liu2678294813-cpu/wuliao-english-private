import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAppEvent } from "../../events/appEvents.js";
import { AppEvent } from "../../events/eventTypes.js";
import { createWritingInkFlushBridge } from "./WritingInkComposer.jsx";
import { getUserItem, setUserItem } from "../../userData.js";
import { useBackHandler } from "../../ui/BackContext.jsx";
import { BACK_PRIORITY } from "../../ui/backController.js";
import { WritingStageNotice } from "./WritingStageShell.jsx";
import { WRITING_STAGE_COMPONENTS } from "./WritingStages.jsx";
import "../writing.css";

const ERROR_MESSAGES = Object.freeze({
  "account-mismatch": "当前登录账号与这份写作记录不一致。请切回原账号后重试。",
  account_mismatch: "当前登录账号与这份写作记录不一致。请切回原账号后重试。",
  "source-mismatch": "题目或范文来源已经变化，无法安全继续这次训练。",
  source_mismatch: "题目或范文来源已经变化，无法安全继续这次训练。",
  "stale-session": "记录刚刚在别处更新，请重新载入后继续。",
  "illegal-transition": "当前操作与已保存阶段不一致，请重新载入。",
  "prerequisite-missing": "前置学习记录不完整，无法安全推进。",
  "lineage-mismatch": "关联记录不一致，已停止本次操作以保护数据。",
  "dependent-record-missing": "所需学习记录缺失，无法安全继续。",
  "dependent-record-damaged": "所需学习记录已损坏，无法安全继续。",
  "ink-flush-failed": "笔迹尚未可靠保存，请检查后重试。",
  "provider-unavailable": "AI 服务暂时不可用，你的草稿没有丢失。",
  "invalid-response": "AI 返回内容无法验证，请稍后重试。",
  invalid_response: "AI 返回内容无法验证，请重试，或改为手动录入。",
  vision_not_configured: "尚未配置手写识别模型。你可以手动录入文字后继续。",
  unsupported: "当前环境不支持手写识别。你可以手动录入文字后继续。",
  auth_error: "AI 服务认证失败。你的草稿与笔迹仍已保留。",
  rate_limit: "AI 服务请求过于频繁，请稍后重试。",
  network_error: "网络暂时不可用，请重试，或使用手动录入。",
  timeout: "AI 请求超时，请重试，或使用手动录入。",
  provider_error: "AI 服务暂时不可用，请稍后重试。",
  stale: "请求期间源记录已变化，旧结果没有写入。请重新载入。",
  identity_conflict: "请求记录与当前内容不一致，已停止写入以保护数据。",
  lineage_mismatch: "关联记录不一致，已停止本次操作以保护数据。",
});

function defaultCreateId(prefix) {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${token}`;
}

function messageFor(error) {
  const code = error?.code || error?.name;
  return ERROR_MESSAGES[code] || "操作未完成，你的当前输入仍保留在页面中。请重试。";
}

function BlockingState({ title, children, onRetry, onBack, retryLabel = "重新载入" }) {
  return (
    <main className="writing-workspace writing-blocking-state">
      <div className="writing-blocking-card">
        <span aria-hidden="true">!</span>
        <small>WRITING WORKSPACE</small>
        <h1>{title}</h1>
        <p>{children}</p>
        <div>
          {onBack ? <button type="button" className="writing-button-ghost" onClick={onBack}>返回写作库</button> : null}
          {onRetry ? <button type="button" className="primary-button" onClick={onRetry}>{retryLabel}</button> : null}
        </div>
      </div>
    </main>
  );
}

export default function WritingWorkspace({
  sessionId,
  username,
  services,
  createId = defaultCreateId,
  inkFlushBridge: suppliedInkFlushBridge = null,
  onBack,
  onImmersiveChange,
  hostLeaveBarrierRef,
}) {
  const requestedKey = `${String(username || "")}::${String(sessionId || "")}`;
  const [loadState, setLoadState] = useState({ key: "", status: "idle", workspace: null });
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const actionLock = useRef(false);
  const exitBarrierRef = useRef(null);
  const exitPendingRef = useRef(false);
  const loadGeneration = useRef(0);
  const mountedRef = useRef(true);
  const requestedKeyRef = useRef(requestedKey);
  requestedKeyRef.current = requestedKey;
  const inkFlushBridge = useMemo(
    () => suppliedInkFlushBridge || createWritingInkFlushBridge(),
    [suppliedInkFlushBridge],
  );
  const [layout, setLayout] = useState(() => (
    getUserItem("wuliao:pref:writing-workspace-layout:v1", username) === "stacked" ? "stacked" : "split"
  ));
  const [immersive, setImmersive] = useState(false);

  const registerExitBarrier = useCallback((barrier) => {
    exitBarrierRef.current = typeof barrier === "function" ? barrier : null;
    return () => {
      if (exitBarrierRef.current === barrier) exitBarrierRef.current = null;
    };
  }, []);

  const toggleLayout = useCallback(() => {
    setLayout((current) => {
      const next = current === "split" ? "stacked" : "split";
      setUserItem("wuliao:pref:writing-workspace-layout:v1", next, username);
      return next;
    });
  }, [username]);

  const exitImmersive = useCallback(() => setImmersive(false), []);
  const toggleImmersive = useCallback(() => setImmersive((current) => !current), []);
  const handleDraftError = useCallback((error) => setActionError(messageFor(error)), []);

  const requestWorkspaceBack = useCallback(() => {
    if (immersive) {
      exitImmersive();
      return;
    }
    if (exitPendingRef.current) return;
    exitPendingRef.current = true;
    Promise.resolve(exitBarrierRef.current?.())
      .then(() => onBack?.())
      .catch((error) => {
        if (mountedRef.current) setActionError(messageFor(error));
      })
      .finally(() => { exitPendingRef.current = false; });
  }, [exitImmersive, immersive, onBack]);

  useEffect(() => {
    if (!hostLeaveBarrierRef) return undefined;
    const barrier = async () => {
      try {
        return await exitBarrierRef.current?.();
      } catch (error) {
        if (mountedRef.current) setActionError(messageFor(error));
        throw error;
      }
    };
    hostLeaveBarrierRef.current = barrier;
    return () => {
      if (hostLeaveBarrierRef.current === barrier) hostLeaveBarrierRef.current = null;
    };
  }, [hostLeaveBarrierRef]);

  useBackHandler(() => {
    requestWorkspaceBack();
    return true;
  }, {
    enabled: Boolean(onBack),
    priority: BACK_PRIORITY.temporary,
    key: requestedKey,
  });

  useEffect(() => {
    onImmersiveChange?.(immersive);
    return () => onImmersiveChange?.(false);
  }, [immersive, onImmersiveChange]);

  const load = useCallback(async ({ foreground = true } = {}) => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    if (foreground) setLoadState({ key: requestedKey, status: "loading", workspace: null });
    setActionError("");
    if (!sessionId || !username || !services?.readModels?.loadWritingWorkspace) {
      setLoadState({ key: requestedKey, status: "invalid", workspace: null });
      return;
    }
    try {
      const workspace = await services.readModels.loadWritingWorkspace({ sessionId });
      if (loadGeneration.current !== generation) return;
      setLoadState({ key: requestedKey, status: "ready", workspace });
    } catch (error) {
      if (loadGeneration.current !== generation) return;
      setLoadState({ key: requestedKey, status: "failed", workspace: null });
      setActionError(messageFor(error));
    }
  }, [requestedKey, services, sessionId, username]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => onAppEvent(AppEvent.ACCOUNT_CHANGED, () => load()), [load]);

  const onAction = useCallback(async (actionName, work, { reload = true } = {}) => {
    if (actionLock.current) return null;
    const actionContextKey = requestedKey;
    actionLock.current = true;
    setBusyAction(actionName);
    setActionError("");
    try {
      const result = await work();
      if (requestedKeyRef.current !== actionContextKey || !mountedRef.current) return null;
      if (reload) await load({ foreground: false });
      return result;
    } catch (error) {
      if (requestedKeyRef.current === actionContextKey && mountedRef.current) setActionError(messageFor(error));
      return null;
    } finally {
      actionLock.current = false;
      if (requestedKeyRef.current === actionContextKey && mountedRef.current) setBusyAction("");
    }
  }, [load, requestedKey]);

  if (loadState.key !== requestedKey || loadState.status === "idle" || loadState.status === "loading") {
    return <BlockingState title="正在恢复写作现场">正在核对已保存阶段与关联记录，不会预先显示任何训练内容。</BlockingState>;
  }
  if (loadState.status === "invalid") {
    return <BlockingState title="无法打开写作训练" onBack={onBack}>缺少账号、Session 或 Writing 服务。</BlockingState>;
  }
  if (loadState.status === "failed") {
    return <BlockingState title="写作记录暂时无法读取" onRetry={load} onBack={onBack}>{actionError}</BlockingState>;
  }

  const workspace = loadState.workspace;
  if (!workspace?.safeStage || !workspace.stageViewModel || ["damaged", "account_mismatch", "source_mismatch", "not_found", "repository_error"].includes(workspace.status)) {
    const title = workspace?.status === "account_mismatch"
      ? "账号不匹配"
      : workspace?.status === "source_mismatch"
        ? "来源内容已变化"
        : workspace?.status === "not_found"
          ? "没有找到这次写作记录"
          : workspace?.status === "repository_error"
            ? "本地写作资料暂时无法读取"
            : "写作记录需要修复";
    const body = workspace?.status === "account_mismatch"
      ? ERROR_MESSAGES.account_mismatch
      : workspace?.status === "source_mismatch"
        ? ERROR_MESSAGES.source_mismatch
        : workspace?.status === "not_found"
          ? "该 Session 不存在，页面不会把它当成一场新训练。"
          : workspace?.status === "repository_error"
            ? "本地资料库读取失败。重新载入只会再次读取，不会生成或覆盖任何记录。"
            : "恢复检查发现缺失、损坏或不一致的关联记录。为避免错误推进，页面已停止在安全边界。";
    return <BlockingState title={title} onRetry={load} onBack={onBack}>{body}</BlockingState>;
  }

  const StageComponent = WRITING_STAGE_COMPONENTS[workspace.safeStage];
  if (!StageComponent) {
    return <BlockingState title="未知的写作阶段" onRetry={load} onBack={onBack}>当前记录包含客户端尚不支持的阶段。</BlockingState>;
  }
  const commandContext = {
    sessionId: workspace.sessionId,
    sessionExpectedRevision: workspace.sessionRevision,
    sessionFingerprint: workspace.sessionFingerprint,
  };

  return (
    <div className="writing-workspace-frame">
      {actionError ? <WritingStageNotice tone="error" title="操作未完成" role="alert">{actionError}</WritingStageNotice> : null}
      <StageComponent
        key={`${workspace.sessionId}:${workspace.safeStage}`}
        vm={workspace.stageViewModel}
        commandContext={commandContext}
        services={services}
        username={username}
        createId={createId}
        inkFlushBridge={inkFlushBridge}
        busyAction={busyAction}
        onAction={onAction}
        onBack={requestWorkspaceBack}
        registerExitBarrier={registerExitBarrier}
        onDraftError={handleDraftError}
        layout={layout}
        onToggleLayout={toggleLayout}
        immersive={immersive}
        onToggleImmersive={toggleImmersive}
        onExitImmersive={exitImmersive}
      />
    </div>
  );
}

export { defaultCreateId as createWritingUiId };

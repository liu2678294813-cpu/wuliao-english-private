import "../vocabulary/handwriting.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isVocabularySpaRoute, shouldReloadVocabularyDocument } from "../navigation";
import { VocabMessageType } from "../vocabulary/vocabularyBridge";
import { vocabularyMessageTargetOrigin } from "../vocabulary/vocabularyProtocol";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { flushPendingSaves, reportSaveFailure } from "../saveCoordinator.js";
import { onAppEvent } from "../events/appEvents.js";
import { AppEvent } from "../events/eventTypes.js";

const HandwritingScreening = lazy(() => import("../vocabulary/HandwritingScreening.jsx"));

function isTrustedFrameMessage(event, frameWindow) {
  if (!event || !frameWindow) return false;
  if (event.source !== frameWindow) return false;
  const protocol = window.location.protocol;
  const usesHttp = protocol === "http:" || protocol === "https:";
  if (!usesHttp || event.origin === window.location.origin) return true;
  return false;
}

export default function VocabularyWorkspace({ username, onBack, workspace, route, onRouteChange, bridge }) {
  const [screeningMode, setScreeningMode] = useState("choice");
  const [modeSaving, setModeSaving] = useState(false);
  const changeScreeningMode = async (next) => {
    if (modeSaving || next === screeningMode) return;
    setModeSaving(true);
    try { await flushPendingSaves(); setScreeningMode(next); }
    catch { reportSaveFailure(); }
    finally { setModeSaving(false); }
  };
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const iframeRef = useRef(null);
  useSaveBoundary(() => bridge?.isReady() ? bridge.flush() : iframeRef.current?.contentWindow?.__wuliaoFlushVocabulary?.());
  const [shuffleOn, setShuffleOn] = useState(
    () => localStorage.getItem("wuliao:vocabulary:shuffle-screening") === "true",
  );
  const [autoSpeakOn, setAutoSpeakOn] = useState(
    () => localStorage.getItem("wuliao:vocabulary:auto-pronounce") === "true",
  );
  const workspaceKey = workspace.kind === "static"
    ? `static:${workspace.page}:${workspace.nonce || 0}`
    : `spa:${workspace.nonce || 0}`;
  const [documentSrc, setDocumentSrc] = useState(() => (
    workspace.kind === "static"
      ? workspace.src
      : `/vocabulary/index.html#${route}`
  ));
  const workspaceKeyRef = useRef(workspaceKey);
  useEffect(() => {
    const refresh = () => bridge?.send(VocabMessageType.UNKNOWN_WORDS_CHANGED, { username });
    const off = onAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED, refresh);
    const offBridge = bridge?.on(({ type }) => {
      if (type === VocabMessageType.READY) refresh();
    });
    if (loaded) refresh();
    return () => { off(); offBridge?.(); };
  }, [username, bridge, loaded]);

  const handleShuffleChange = (event) => {
    const next = event.target.checked;
    localStorage.setItem("wuliao:vocabulary:shuffle-screening", String(next));
    setShuffleOn(next);
    if (bridge) {
      bridge.send(VocabMessageType.SET_SHUFFLE, { enabled: next });
    } else {
      iframeRef.current?.contentWindow?.dispatchEvent(new Event("wuliao:shuffle-restart"));
    }
  };

  const handleAutoSpeakChange = (event) => {
    const next = event.target.checked;
    localStorage.setItem("wuliao:vocabulary:auto-pronounce", String(next));
    setAutoSpeakOn(next);
    syncAutoSpeakToFrame(next);
  };

  const sendRouteToFrame = () => {
    if (workspace.kind !== "spa" || !isVocabularySpaRoute(route)) return;
    if (iframeRef.current?.contentWindow?.location?.hash === `#${route}`) return;
    if (bridge) {
      bridge.send(VocabMessageType.NAVIGATE, { route });
    } else {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "wuliao:vocabulary-navigate", route },
        vocabularyMessageTargetOrigin(),
      );
    }
  };

  const syncAutoSpeakToFrame = (enabled = autoSpeakOn) => {
    if (bridge) {
      bridge.send(VocabMessageType.SET_AUTO_SPEAK, { enabled: Boolean(enabled) });
    } else {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "wuliao:vocabulary-auto-pronounce", enabled: Boolean(enabled) },
        vocabularyMessageTargetOrigin(),
      );
    }
  };

  useEffect(() => {
    setLoaded(false);
    setLoadFailed(false);
  }, [documentSrc]);

  useEffect(() => {
    if (loaded) return;
    const timer = window.setTimeout(() => {
      setLoadFailed(true);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [documentSrc, loaded]);

  useEffect(() => {
    try {
      sessionStorage.setItem("wuliao:vocab:embedded-fresh", "1");
    } catch {
      // sessionStorage may be unavailable in some embedded contexts; history fallback still applies.
    }
  }, [documentSrc]);

  useEffect(() => {
    if (workspaceKeyRef.current !== workspaceKey) {
      workspaceKeyRef.current = workspaceKey;
      const currentPathname = iframeRef.current?.contentWindow?.location?.pathname || "";
      if (!shouldReloadVocabularyDocument({
        targetKind: workspace.kind,
        targetPage: workspace.page,
        currentPathname,
      })) {
        // The child already navigated itself to this document. Rewriting src
        // now races with the in-flight navigation and can leave loaded=false
        // forever (the final hash change fires no iframe load event).
        if (workspace.kind === "spa" && isVocabularySpaRoute(route)) sendRouteToFrame();
        return;
      }
      setDocumentSrc(
        workspace.kind === "static"
          ? workspace.src
          : `/vocabulary/index.html#${route}`,
      );
    }
  }, [workspaceKey, workspace.kind, workspace.page, route]);

  useEffect(() => {
    if (!loaded) return;
    sendRouteToFrame();
  }, [loaded, route, workspace.kind]);

  useEffect(() => {
    const handleMessage = (event) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || !isTrustedFrameMessage(event, frameWindow)) return;
      if (event.data?.type !== "wuliao:vocabulary-route") return;
      if (!isVocabularySpaRoute(event.data.route)) return;
      onRouteChange(event.data.route);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onRouteChange]);

  const showShuffle = workspace.kind === "spa" && route.startsWith("/screening");

  const handleRetry = () => {
    setDocumentSrc((previous) => {
      const hashIndex = previous.indexOf("#");
      const base = hashIndex >= 0 ? previous.slice(0, hashIndex) : previous;
      const hash = hashIndex >= 0 ? previous.slice(hashIndex) : "";
      const separator = base.includes("?") ? "&" : "?";
      return `${base}${separator}reload=${Date.now()}${hash}`;
    });
  };

  return (
    <div className={`vocabulary-page${workspace.kind === "static" && workspace.page === "memorize" ? " vocabulary-page-memorize" : ""}`}>
      {!(workspace.kind === "static" && workspace.page === "memorize") && <header className="vocabulary-shell-header">
        <button className="back-button light" onClick={onBack}>← 返回</button>
        <div className="vocabulary-shell-title">
          <small>VOCABULARY WORKSPACE</small>
          <strong>{workspace.label}</strong>
        </div>
        {showShuffle && <div className="vocab-screening-modes" role="group" aria-label="筛选模式">
          <button disabled={modeSaving} aria-pressed={screeningMode === "choice"} onClick={() => changeScreeningMode("choice")}>选择模式</button>
          <button disabled={modeSaving} aria-pressed={screeningMode === "handwriting"} onClick={() => changeScreeningMode("handwriting")}>手写模式</button>
        </div>}
        {showShuffle && screeningMode === "choice" && (
          <div className="vocabulary-shell-toggles">
            <label className="vocabulary-shuffle-toggle">
              <input type="checkbox" checked={autoSpeakOn} onChange={handleAutoSpeakChange} />
              <span>自动读音</span>
            </label>
            <label className="vocabulary-shuffle-toggle">
              <input type="checkbox" checked={shuffleOn} onChange={handleShuffleChange} />
              <span>乱序筛查</span>
            </label>
          </div>
        )}
      </header>}
      <div className="vocabulary-frame-wrap">
        {!loaded && !loadFailed && <div className="vocabulary-frame-loading"><span>词</span><strong>正在载入单词软件…</strong></div>}
        {!loaded && loadFailed && (
          <div className="vocabulary-frame-error">
            <span>！</span>
            <strong>单词页面加载失败</strong>
            <button type="button" onClick={handleRetry}>重新加载</button>
          </div>
        )}
        <iframe
          style={showShuffle && screeningMode === "handwriting" ? { visibility: "hidden", pointerEvents: "none" } : undefined}
          ref={iframeRef}
          className={`vocabulary-frame ${loaded ? "loaded" : ""}`}
          title={`无聊英语 · ${workspace.label}`}
          src={documentSrc}
          onLoad={() => {
            setLoaded(true);
            if (workspace.kind === "spa") {
              syncAutoSpeakToFrame();
            }
          }}
        />
        {showShuffle && screeningMode === "handwriting" && <Suspense fallback={<div className="vocab-handwriting">正在打开手写筛选…</div>}>
          <HandwritingScreening frameRef={iframeRef} route={route} onUpdated={() => iframeRef.current?.contentWindow?.VocabularyBridge?.reportSessionUpdated?.()} />
        </Suspense>}
      </div>
    </div>
  );
}

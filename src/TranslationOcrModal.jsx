import { useEffect, useRef, useState } from "react";
import ModalShell from "./ui/Overlay";
import { recognizeTranslationInk } from "./translationOcrAi.js";
import { renderTranslationInk } from "./translationOcrImage.js";

export default function TranslationOcrModal({ target, onCancel, onSave }) {
  const [text, setText] = useState(target.initialText);
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unsure, setUnsure] = useState(false);
  const [notice, setNotice] = useState(target.notice || "");
  const requestRef = useRef(null);
  const fingerprintRef = useRef(target.snapshot?.fingerprint ?? null);
  const sourceRef = useRef(target.metadata?.source || "manual");
  const legacyRef = useRef(null);
  const activeRef = useRef(true);

  function assertCurrent() {
    if (!activeRef.current || !target.isCurrent()) throw new Error("当前句已关闭或账号已切换，请重新打开");
  }

  async function recognize() {
    if (requestRef.current || target.readOnly) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true); setError("");
    try {
      assertCurrent();
      const snapshot = target.capture();
      const nextImage = renderTranslationInk(snapshot);
      setImage(nextImage);
      if (!nextImage) throw new Error("当前笔译横线区没有可识别的笔迹，可直接手动录入");
      const result = await recognizeTranslationInk({ image: nextImage, signal: controller.signal });
      if (controller.signal.aborted) return;
      assertCurrent();
      if (target.capture().fingerprint !== snapshot.fingerprint) throw new Error("笔迹已更新，请重新识别；已有译文未被覆盖");
      if (!result.text) throw new Error("没有识别到文字，请重试或手动录入");
      fingerprintRef.current = snapshot.fingerprint;
      sourceRef.current = "ocr";
      legacyRef.current = null;
      setText(result.text); setUnsure(result.unsure); setNotice("");
    } catch (reason) {
      if (!controller.signal.aborted && activeRef.current) setError(reason.message || "识别失败，请重试");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (activeRef.current && !controller.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    activeRef.current = true;
    try { if (target.snapshot) setImage(renderTranslationInk(target.snapshot)); }
    catch (reason) { setError(reason.message); }
    if (target.mode === "recognize") void recognize();
    return () => {
      activeRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  function close() {
    activeRef.current = false;
    requestRef.current?.abort();
    onCancel();
  }

  function confirm() {
    if (busy || target.readOnly) return;
    setError("");
    try {
      assertCurrent();
      const snapshot = target.capture();
      if (fingerprintRef.current !== null && snapshot.fingerprint !== fingerprintRef.current) throw new Error("笔迹已更新，请重新识别或重新打开后校对");
      if (text.includes("［不清楚］")) throw new Error("请先补全结果中的［不清楚］，再确认保存");
      onSave(target, { text, inkFingerprint: snapshot.fingerprint, source: sourceRef.current, legacy: legacyRef.current, expectedText: target.initialText });
    } catch (reason) { setError(reason.message || "保存失败，请重试"); }
  }

  return (
    <ModalShell open onClose={close} className="transcription-overlay translation-ocr-overlay" label="笔译识别与校对">
      <div className="transcription-panel translation-ocr-panel">
        <header className="transcription-header">
          <div><small>{target.itemLabel}</small><h2>{target.readOnly ? "查看电子译文" : "笔译识别与校对"}</h2></div>
          <button type="button" className="icon-button transcription-close" onClick={close} aria-label="关闭识别弹窗">×</button>
        </header>
        <div className="transcription-panel-body">
          <div className="transcription-sentence"><small>当前英文原句</small><p>{target.sentence}</p></div>
          {image && <figure className="translation-ocr-preview"><figcaption>当前句原笔迹</figcaption><img src={image} alt="当前笔译横线区的原始笔迹" /></figure>}
          <p className="transcription-note">校对后保存电子译文，再点击 AI 批改。原手写笔迹保留在书写区。</p>
          {notice && <p className="translation-ocr-notice" role="status">{notice}</p>}
          {target.legacy && !target.readOnly && <div className="translation-ocr-legacy">
            <strong>待确认旧译文</strong><p>{target.legacy.text}</p>
            <small>这份旧文字没有可靠的文章归属。仅在确定属于当前句时使用。</small>
            <button type="button" disabled={busy} onClick={() => {
              setText(target.legacy.text); legacyRef.current = target.legacy; sourceRef.current = "legacy";
              setUnsure(false); setError(""); setNotice("确认保存后，这份旧文字将绑定当前句；原记录会保留。");
            }}>这是本句译文，使用并校对</button>
          </div>}
          <label className="translation-ocr-label" htmlFor="translation-ocr-text">电子译文{busy ? " · 正在识别…" : ""}</label>
          <textarea id="translation-ocr-text" className="transcription-input" value={text} rows={5}
            readOnly={target.readOnly || busy} aria-busy={busy} placeholder="识别结果会显示在这里，也可以手动录入…"
            onChange={(event) => { setText(event.target.value); setError(""); }} />
          {unsure && <p className="translation-ocr-notice">部分内容无法确定，请对照原笔迹逐字校对。</p>}
          {error && <p className="transcription-error" role="alert">{error}</p>}
        </div>
        <footer className="transcription-actions translation-ocr-actions">
          <button type="button" className="transcription-cancel" onClick={close}>{target.readOnly ? "关闭" : "取消"}</button>
          {!target.readOnly && <>
            <button type="button" className="transcription-cancel" disabled={busy} onClick={recognize}>{busy ? "正在识别…" : "重新识别"}</button>
            <button type="button" className="transcription-submit" disabled={busy || !text.trim()} onClick={confirm}>确认保存</button>
          </>}
        </footer>
      </div>
    </ModalShell>
  );
}

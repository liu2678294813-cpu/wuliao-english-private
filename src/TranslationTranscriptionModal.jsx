import { useEffect, useRef, useState } from "react";
import ModalShell from "./ui/Overlay";

const TRANSCRIPTION_NOTE = "AI 暂时不能可靠读取当前手写笔迹。\n请将你的手写译文录入为文字后再提交批改。\n原手写笔迹不会被修改。";

export default function TranslationTranscriptionModal({ open, sentence, onCancel, onConfirm }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const textareaRef = useRef(null);

  useEffect(() => {
    if (open) {
      setText("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  const handleConfirm = () => {
    const value = text.trim();
    if (!value) {
      setError("请先录入你的译文后再提交。");
      return;
    }
    setError("");
    onConfirm(value);
  };

  return (
    <ModalShell open onClose={onCancel} className="transcription-overlay" label="补录译文">
      <div className="transcription-panel">
        <header className="transcription-header">
          <div>
            <small>HANDWRITING TO TEXT</small>
            <h2>录入译文后批改</h2>
          </div>
          <button type="button" className="icon-button transcription-close" onClick={onCancel} aria-label="关闭补录弹窗">×</button>
        </header>

        <div className="transcription-panel-body">
          <div className="transcription-sentence">
            <small>当前英文原句</small>
            <p>{sentence}</p>
          </div>

          <p className="transcription-note">{TRANSCRIPTION_NOTE}</p>

          <textarea
            ref={textareaRef}
            className="transcription-input"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (error) setError("");
            }}
            placeholder="在这里输入你的译文…"
            rows={6}
            autoFocus
            enterKeyHint="done"
          />
          {error && <p className="transcription-error">{error}</p>}
        </div>

        <footer className="transcription-actions">
          <button type="button" className="transcription-cancel" onClick={onCancel}>取消</button>
          <button type="button" className="transcription-submit" onClick={handleConfirm}>提交并批改</button>
        </footer>
      </div>
    </ModalShell>
  );
}

import { useEffect, useState } from "react";
import LearningArchivePanel from "./LearningArchivePanel";
import {
  clearLearningRecords,
  deleteLearningRecord,
  listLearningRecords,
  setLearningRecordResolved,
  updateTagStatus,
} from "./aiLearningRecords";
import ModalShell from "./ui/Overlay";

/**
 * 首页轻量学习档案弹层：复用现有 LearningArchivePanel，
 * 默认过滤「待复盘」。AI 历史按钮在首页隐藏（精读页 AI 窗口仍可用）。
 */
export default function LearningArchiveModal({ onClose }) {
  const [records, setRecords] = useState(() => listLearningRecords());
  const [detailId, setDetailId] = useState(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    const refresh = () => setRecords(listLearningRecords());
    window.addEventListener("wuliao:learning-records-updated", refresh);
    return () => window.removeEventListener("wuliao:learning-records-updated", refresh);
  }, []);

  function apply(action) {
    let ok = false;
    try {
      ok = action();
    } catch {
      ok = false;
    }
    setSaveError(!ok);
    setRecords(listLearningRecords());
    return ok;
  }

  function handleDelete(recordId) {
    if (!window.confirm("删除这条学习档案记录？AI 历史、译文、答案与笔迹不受影响。")) return;
    apply(() => deleteLearningRecord(recordId));
  }

  function handleClearAll() {
    if (!window.confirm("清空本账号全部学习档案？只删除学习档案，不会影响 AI 历史、译文、答案与笔迹。")) return;
    apply(() => clearLearningRecords());
  }

  return (
    <ModalShell open onClose={onClose} className="learning-archive-backdrop" label="学习档案">
      <div
        className="learning-archive-shell"
        onClick={(event) => event.stopPropagation()}
      >
        <LearningArchivePanel
          records={records}
          currentResourceId=""
          detailId={detailId}
          onDetailChange={setDetailId}
          onBack={onClose}
          onConfirmTag={(recordId, name) => apply(() => Boolean(updateTagStatus(recordId, name, "confirmed")))}
          onDismissTag={(recordId, name) => apply(() => Boolean(updateTagStatus(recordId, name, "dismissed")))}
          onToggleResolved={(recordId) => {
            const record = records.find((item) => item.id === recordId);
            apply(() => Boolean(setLearningRecordResolved(recordId, !record?.resolved)));
          }}
          onDeleteRecord={handleDelete}
          onClearAll={handleClearAll}
          onOpenHistory={() => {}}
          onJump={() => {}}
          saveError={saveError}
          initialTypeFilter="review"
          showHistory={false}
        />
      </div>
    </ModalShell>
  );
}

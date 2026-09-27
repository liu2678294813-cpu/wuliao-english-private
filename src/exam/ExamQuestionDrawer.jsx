// 考试悬浮题窗（floating-only）。
// 只提供：题号 / 题干 / A/B/C/D / 当前已选择答案。
// 考试进行中必须保持考试隔离：不展示任何答案判读、订正、智能提示、原文证据或学习结果。
// 答案选择必须走 onChoose → answerExamItem → Exam Session.answers；
// 严禁写入普通阅读答案存储、原文证据或重做答案。
// 固定定位浮动（不改变正文宽度），打开 / 关闭不触发 Canvas resize，不影响笔迹 geometry。

import { useEffect, useRef, useState } from "react";
import { useBackHandler } from "../ui/BackContext";
import { BACK_PRIORITY } from "../ui/backController";
import { useMotionPresence } from "../ui/useMotionPresence";

export default function ExamQuestionDrawer({
  open = false,
  onOpenChange,
  questions = [],
  answers = {},
  onChoose = () => {},
  disabled = false,
}) {
  const [expanded, setExpanded] = useState(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(12, (typeof window !== "undefined" ? window.innerWidth : 1280) - 348 - 16), y: 96 }));
  const motion = useMotionPresence(open);
  const drawerRef = useRef(null);
  const posRef = useRef(pos);
  const dragRef = useRef(null);
  const dragFrameRef = useRef(0);

  useEffect(() => { posRef.current = pos; }, [pos]);
  useEffect(() => () => {
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  useBackHandler(() => {
    if (!open) return false;
    onOpenChange?.(false);
    return true;
  }, {
    enabled: open,
    priority: BACK_PRIORITY.drawer,
  });

  if (!questions.length) return null;

  const currentExpanded = questions.some((question) => question.number === expanded)
    ? expanded
    : questions[0].number;

  function startDrawerDrag(event) {
    if (event.target.closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = drawerRef.current?.getBoundingClientRect();
    const baseLeft = rect?.left ?? posRef.current?.x ?? Math.max(12, window.innerWidth - 348 - 16);
    const baseTop = rect?.top ?? posRef.current?.y ?? 96;
    drawerRef.current?.setAttribute("data-dragging", "true");
    dragRef.current = { startX, startY, baseLeft, baseTop };
    const move = (moveEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = {
        x: Math.min(Math.max(0, drag.baseLeft + moveEvent.clientX - drag.startX), Math.max(0, window.innerWidth - 348)),
        y: Math.min(Math.max(0, drag.baseTop + moveEvent.clientY - drag.startY), Math.max(0, window.innerHeight - 96)),
      };
      drag.next = next;
      posRef.current = next;
      if (dragFrameRef.current) return;
      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        const active = dragRef.current;
        const node = drawerRef.current;
        if (!active?.next || !node) return;
        node.style.transform = `translate(${active.next.x - active.baseLeft}px, ${active.next.y - active.baseTop}px)`;
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = 0;
      }
      const next = dragRef.current?.next || posRef.current;
      if (next && drawerRef.current) {
        drawerRef.current.style.left = `${next.x}px`;
        drawerRef.current.style.top = `${next.y}px`;
        drawerRef.current.style.transform = "";
        setPos(next);
      }
      drawerRef.current?.removeAttribute("data-dragging");
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <>
      <button
        type="button"
        className={`exam-question-fab ${motion.state !== "closed" ? "hidden" : ""}`}
        onClick={() => onOpenChange?.(true)}
        aria-label="打开题目窗"
      >
        <span>题</span><strong>题目</strong><small>{questions.length}</small>
      </button>
      <aside
        ref={drawerRef}
        className={`exam-question-drawer ${motion.visible ? "open" : ""}`}
        data-motion-state={motion.state}
        style={{ left: pos?.x ?? Math.max(12, window.innerWidth - 348 - 16), top: pos?.y ?? 96 }}
        aria-hidden={motion.state === "closed"}
      >
        <div className="exam-drawer-header" onPointerDown={startDrawerDrag}>
          <div><small>EXAM QUESTION</small><strong>当前 Text 题目</strong></div>
          <button className="icon-button" type="button" onClick={() => onOpenChange?.(false)} aria-label="关闭题窗">×</button>
        </div>
        <div className="exam-drawer-list">
          {questions.map((question) => {
            const isExpanded = question.number === currentExpanded;
            const selected = answers[question.id] || "";
            return (
              <section className={`exam-drawer-item ${isExpanded ? "expanded" : ""}`} key={question.id}>
                <button
                  type="button"
                  className="exam-drawer-stem"
                  onClick={() => setExpanded(isExpanded ? null : question.number)}
                >
                  <strong>{question.order}. {question.stem || `第 ${question.order} 题`}</strong>
                  <i>{isExpanded ? "−" : "+"}</i>
                </button>
                {isExpanded && (
                  <div className="exam-drawer-options">
                    {(question.options || []).map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        disabled={disabled}
                        className={selected === option.key ? "selected" : ""}
                        onClick={() => onChoose(question.id, option.key)}
                      >
                        <span>{option.key}</span><p>{option.text}</p>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </aside>
    </>
  );
}

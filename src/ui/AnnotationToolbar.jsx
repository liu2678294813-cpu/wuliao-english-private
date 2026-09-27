import { useLayoutEffect, useRef, useState } from "react";

// 共享笔工具栏（唯一 source of truth）。
// 精读 / 普通完形 / 模拟考试必须使用同一份实现与同一份视觉契约。
// 视觉尺寸契约位于 src/redesign/reader.css（.reader-page > .annotation-toolbar 系列）。

function viewportSafeInsets() {
  const viewport = window.visualViewport;
  if (!viewport) return { top: 0, right: 0, bottom: 0, left: 0 };
  const left = Math.max(0, viewport.offsetLeft || 0);
  const top = Math.max(0, viewport.offsetTop || 0);
  const right = Math.max(0, (window.innerWidth || 0) - left - (viewport.width || 0));
  const bottom = Math.max(0, (window.innerHeight || 0) - top - (viewport.height || 0));
  return { top, right, bottom, left };
}

function RangeTrackSlider({ value, onChange, min = 1, max = 10, step = 0.5, ariaLabel = "画笔粗细" }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  const clamp = (v) => Math.min(max, Math.max(min, v));
  const snap = (v) => Math.round(clamp(v) / step) * step;

  const valueFromClientX = (clientX) => {
    const track = trackRef.current;
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    return snap(min + ratio * (max - min));
  };

  const handlePointerDown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    draggingRef.current = true;
    onChange(valueFromClientX(event.clientX));
  };

  const handlePointerMove = (event) => {
    event.stopPropagation();
    if (draggingRef.current) onChange(valueFromClientX(event.clientX));
  };

  const handlePointerEnd = (event) => {
    event.stopPropagation();
    draggingRef.current = false;
  };

  const handleKeyDown = (event) => {
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + (event.shiftKey ? step * 2 : step);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - (event.shiftKey ? step * 2 : step);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      onChange(snap(next));
    }
  };

  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <span
      ref={trackRef}
      className="tool-size-range-track"
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} 像素`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={(event) => onChange(valueFromClientX(event.clientX))}
      onKeyDown={handleKeyDown}
    >
      <span className="tool-size-range-fill" style={{ width: `${percent}%` }} />
      <span className="tool-size-range-thumb" style={{ left: `${percent}%` }} />
    </span>
  );
}

export function AnnotationToolbar({
  tool,
  color,
  annotations,
  canUndo,
  onTool,
  onColor,
  onUndo,
  onClear,
  canClear,
  clearLabel = "清空本页",
  noteMode,
  onToggleNoteMode,
  penSize = 2.6,
  onPenSize,
  penMode = "ballpoint",
  eraserMode = "normal",
  eraserSize = 24,
  onEraserMode,
  onEraserSize,
  collapsible = false,
  collapsed: collapsedProp,
  onCollapsedChange,
  collapseMode = "pill",
  unknownEnabled = false,
  tabletInk = false,
  stageHint = "",
  compactPenOnly = false,
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [pillOffset, setPillOffset] = useState({ x: 0, y: 0 });
  const [pillDragging, setPillDragging] = useState(false);
  const pillDragRef = useRef(null);
  const suppressPillClickRef = useRef(false);
  const collapsed = collapsible && (collapsedProp !== undefined ? collapsedProp : internalCollapsed);
  const pillCollapsed = collapsed && collapseMode !== "chrome-only";
  const toolbarRef = useRef(null);
  useLayoutEffect(() => {
    if (collapseMode !== "chrome-only") return;
    const toolbar = toolbarRef.current, page = toolbar?.parentElement;
    if (!page) return;
    const measure = () => page.style.setProperty("--reader-panel-toolbar-height", `${toolbar.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [collapseMode, collapsed]);
  const clearDisabled = canClear === undefined ? !annotations.length : !canClear;
  // 未提供 noteMode 的宿主（普通完形 / 模拟考试）视为始终处于手写模式。
  const handwritingMode = noteMode ?? true;

  function toggleCollapsed() {
    const next = !collapsed;
    setInternalCollapsed(next);
    onCollapsedChange?.(next);
  }

  // 折叠后的“展开工具”pill：<6px 视为点击，>=6px 进入二维拖拽（仅本次手势不触发展开）。
  function startPillDrag(event) {
    if (!collapsed) return;
    suppressPillClickRef.current = false;
    setPillDragging(false);
    const button = event.currentTarget;
    try {
      button.setPointerCapture?.(event.pointerId);
    } catch {
      // Android WebView 可能拒绝 capture；继续拖拽不受影响。
    }
    const rect = button.getBoundingClientRect();
    pillDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseLeft: rect.left - pillOffset.x,
      baseTop: rect.top - pillOffset.y,
      baseOffsetX: pillOffset.x,
      baseOffsetY: pillOffset.y,
      moved: false,
    };
    event.preventDefault();
    event.stopPropagation();
  }

  function movePillDrag(event) {
    const drag = pillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      suppressPillClickRef.current = true;
      setPillDragging(true);
    }
    const button = event.currentTarget;
    const width = button.offsetWidth || 118;
    const height = button.offsetHeight || 44;
    const insets = viewportSafeInsets();
    const minX = 12 + insets.left;
    const minY = 12 + insets.top;
    const maxX = window.innerWidth - 12 - insets.right - width;
    const maxY = window.innerHeight - 12 - insets.bottom - height;
    const clampX = Math.max(minX - drag.baseLeft, maxX - drag.baseLeft);
    const clampY = Math.max(minY - drag.baseTop, maxY - drag.baseTop);
    setPillOffset({
      x: Math.min(Math.max(minX - drag.baseLeft, drag.baseOffsetX + dx), clampX),
      y: Math.min(Math.max(minY - drag.baseTop, drag.baseOffsetY + dy), clampY),
    });
  }

  function endPillDrag(event) {
    const drag = pillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasMoved = drag.moved;
    pillDragRef.current = null;
    if (wasMoved) {
      setPillDragging(false);
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handlePillClick(event) {
    if (suppressPillClickRef.current) {
      suppressPillClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    toggleCollapsed();
  }

  return (
    <div ref={toolbarRef} className={`annotation-toolbar ${pillCollapsed ? "collapsed" : ""} ${collapseMode === "chrome-only" ? "chrome-only-toolbar" : ""} ${tabletInk ? "tablet-ink-toolbar" : ""} ${compactPenOnly ? "is-compact-pen-only" : ""}`} aria-label="批注工具">
      {collapsible && (
        <button
          type="button"
          className="toolbar-collapse-toggle"
          aria-expanded={!collapsed}
          onClick={handlePillClick}
          onPointerDown={pillCollapsed ? startPillDrag : undefined}
          onPointerMove={pillCollapsed ? movePillDrag : undefined}
          onPointerUp={pillCollapsed ? endPillDrag : undefined}
          onPointerCancel={pillCollapsed ? endPillDrag : undefined}
          style={pillCollapsed ? { transform: `translate3d(${pillOffset.x}px, ${pillOffset.y}px, 0)`, touchAction: "none" } : undefined}
        >
          <span className="toolbar-icon" aria-hidden="true">{collapsed ? "⌄" : "⌃"}</span>{collapseMode === "chrome-only" ? (collapsed ? "展开顶部" : "收起顶部") : (collapsed ? "展开工具" : "收起工具")}
        </button>
      )}
      {pillCollapsed && stageHint && !pillDragging && <span className="toolbar-stage-hint">{stageHint}</span>}
      {/* 折叠契约：collapsed 时 DOM 只保留「展开工具 + stageHint」，
          其余控件全部不渲染（不得依赖 CSS 压缩隐藏，WebView 下会残留）。 */}
      {!pillCollapsed && (
        <>
      {onToggleNoteMode && (
        <div className="input-mode-picker" aria-label="输入方式">
          <button className={!noteMode ? "active" : ""} onClick={() => { if (noteMode) onToggleNoteMode(); }}><span className="toolbar-icon" aria-hidden="true">⌨</span>键盘输入</button>
          <button className={noteMode ? "active" : ""} onClick={() => { if (!noteMode) onToggleNoteMode(); }}><span className="toolbar-icon" aria-hidden="true">✍</span>手写批注</button>
        </div>
      )}
      <button type="button" className={tool === "pen" && handwritingMode ? "active" : ""} onClick={() => onTool("pen")}><span className="toolbar-icon" aria-hidden="true">✎</span>笔</button>
      {!compactPenOnly && <button type="button" className={tool === "eraser" && handwritingMode ? "active" : ""} onClick={() => onTool("eraser")}><span className="toolbar-icon" aria-hidden="true">◇</span>橡皮</button>}
      {!compactPenOnly && unknownEnabled && <button type="button" className={tool === "unknown" && handwritingMode ? "active" : ""} onClick={() => onTool("unknown")}>陌生词</button>}
      {tool === "pen" && (
        <>
          <label className="tool-size-control">粗细
            <RangeTrackSlider value={penSize} min={1} max={10} step={0.5} onChange={(next) => onPenSize?.(next)} />
            <output>{penSize}</output>
          </label>
          {!compactPenOnly && <div className="color-picker" aria-label="笔迹颜色">
            {["#173a62", "#0b7b77", "#e26f51"].map((value) => (
              <button key={value} className={color === value ? "active" : ""} style={{ backgroundColor: value }} onClick={() => onColor(value)} aria-label={`选择颜色 ${value}`} />
            ))}
          </div>}
        </>
      )}
      {!compactPenOnly && tool === "eraser" && (
        <>
          <div className="tool-mode-picker" aria-label="橡皮模式">
            <button className={eraserMode === "normal" ? "active" : ""} onClick={() => onEraserMode?.("normal")}>普通</button>
            <button className={eraserMode === "lasso" ? "active" : ""} onClick={() => onEraserMode?.("lasso")}>自由套索</button>
          </div>
          {eraserMode === "normal" && (
            <label className="tool-size-control">大小
              <RangeTrackSlider value={eraserSize} min={10} max={54} step={2} ariaLabel="普通橡皮大小" onChange={onEraserSize} />
              <output>{eraserSize}</output>
            </label>
          )}
        </>
      )}
      {!compactPenOnly && <span className="toolbar-divider" />}
      {!compactPenOnly && <button onClick={onUndo} disabled={canUndo === undefined ? !annotations.length : !canUndo}><span className="toolbar-icon" aria-hidden="true">↶</span>撤销</button>}
      {!compactPenOnly && <button onClick={onClear} disabled={clearDisabled}>{clearLabel}</button>}
      {!compactPenOnly && <small>{!handwritingMode ? "键盘输入模式：横线文本框接收文字" : tool === "unknown" ? "用笔点按或划过英文单词，自动加入陌生词库" : tool === "eraser" && eraserMode === "lasso" ? "虚线随笔尖移动，松笔后删除真实圈选范围" : tool === "pen" && penMode === "fountain" ? "钢笔直接跟随笔尖并保留笔压；长按临时套索" : tool === "pen" ? "圆珠笔直接跟随笔尖并保持固定粗细；长按临时套索" : "普通橡皮；手指仍可上下滑动"}</small>}
        </>
      )}
    </div>
  );
}

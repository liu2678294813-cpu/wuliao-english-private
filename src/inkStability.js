// 最小化 M-Pencil 稳定性修复：长按 timer 生命周期与抬笔抖动过滤的纯函数。
// 不在此处实现任何绘制、状态机或笔迹格式逻辑。

export const INK_PEN_UP_JITTER_CSS_PX = 1;

// Pen 长按固定进入临时自由套索，与工具栏永久 eraserMode（normal/lasso）无关。
// 用户主动点击“橡皮”仍完整保留 Normal / Lasso 两种永久工具语义。
export function temporaryInkMode() {
  return "lasso";
}

// pointer 会话是否仍是当前活跃会话。
export function isCurrentInkSession(activeRef, active) {
  return activeRef.current === active && activeRef.current?.id === active.id;
}

// 可靠清理一笔已结束（或已取消）的 long-press timer。
export function clearInkTimer(active) {
  if (active?.timer) {
    window.clearTimeout(active.timer);
    active.timer = null;
  }
}

// 启动 long-press timer，回调先经过 stale-session 守卫。
export function startInkLongPress(active, activeRef, delay, trigger) {
  active.timer = window.setTimeout(() => {
    if (!isCurrentInkSession(activeRef, active)) return;
    trigger();
  }, delay);
  return active.timer;
}

// pointerup 是否应追加为真实终点。
// 用 CSS px 距离过滤抬笔机械抖动：距离 <= thresholdCssPx 不追加。
export function shouldAppendPointerUpPoint(active, upPoint, thresholdCssPx = INK_PEN_UP_JITTER_CSS_PX) {
  const last = active?.stroke?.points?.[active.stroke.points.length - 1];
  if (!last) return true;
  const lastPixel = active?.lastPixel;
  const pixel = upPoint?.pixel;
  if (!lastPixel || !pixel) return true;
  return Math.hypot(pixel.x - lastPixel.x, pixel.y - lastPixel.y) > thresholdCssPx;
}

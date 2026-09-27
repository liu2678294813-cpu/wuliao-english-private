import { useLayoutEffect, useRef } from "react";
import { MOTION_DURATION_MS } from "./useMotionPresence";

// Layout width stays unchanged. Only this common paper/ink surface is transformed.
export function useReaderPaperLayout(bridgeRef, open, paperKey, {
  pageSelector = ".custom-workbook-page",
  paperSelector = ".deep-reader-content",
} = {}) {
  const settleRef = useRef(() => {});
  useLayoutEffect(() => {
    const page = bridgeRef.current?.closest(pageSelector);
    const paper = page?.querySelector(paperSelector);
    if (!paper || !paper.offsetWidth) return;
    let animation;
    let disposed = false;
    const update = (animate = true) => {
      paper.dispatchEvent(new Event("reader-paper-will-layout"));
      const rect = paper.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(paper).transform);
      animation?.cancel();
      const width = paper.offsetWidth;
      const available = page.clientWidth;
      const panelWidth = Math.min(360, Math.max(280, available * .28));
      page.style.setProperty("--reader-side-width", `${panelWidth}px`);
      const desktop = available > 760;
      const gutter = desktop ? 18 : 8;
      const lane = available - gutter * 2 - (open && desktop ? panelWidth + 16 : 0);
      const scale = Math.min(1, lane / width);
      const x = gutter + (lane - width * scale) / 2 - (available - width) / 2;
      const anchor = Math.max(rect.top, Math.min(window.innerHeight * .38, rect.bottom));
      const localAnchor = (anchor - rect.top) / matrix.a;
      const baseTop = rect.top - matrix.f;
      const desiredY = anchor - baseTop - localAnchor * scale;
      const oldMargin = parseFloat(paper.style.marginBottom) || 0;
      const nextMargin = (scale - 1) * paper.offsetHeight;
      const pageTop = page.getBoundingClientRect().top + window.scrollY;
      const nextMaxScroll = Math.max(0, pageTop + page.offsetHeight + nextMargin - oldMargin - window.innerHeight);
      // Near either document edge, an impossible scroll target would snap at finish.
      const y = Math.max(window.scrollY - nextMaxScroll, Math.min(window.scrollY, desiredY));
      const end = `translate(${x}px, ${y}px) scale(${scale})`;
      const finish = () => {
        if (disposed) return;
        animation?.cancel();
        animation = null;
        settleRef.current = () => {};
        // Normalize the vertical transform into scroll position in one paint.
        // Otherwise scrolling back upwards would reveal empty space above the paper.
        const nextScroll = window.scrollY - y;
        paper.style.transform = `translate(${x}px, 0px) scale(${scale})`;
        paper.style.marginBottom = `${(scale - 1) * paper.offsetHeight}px`;
        paper.dataset.paperScale = String(scale);
        paper.removeAttribute("data-paper-moving");
        window.scrollTo({ top: nextScroll, behavior: "instant" });
        paper.dispatchEvent(new Event("reader-paper-layout"));
      };
      settleRef.current = finish;
      paper.style.transform = end;
      if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        paper.dataset.paperMoving = "true";
        animation = paper.animate([
          { transform: matrix.toString() }, { transform: end },
        ], { duration: MOTION_DURATION_MS, easing: "cubic-bezier(.2,.8,.2,1)" });
        animation.onfinish = finish;
      } else finish();
    };
    update();
    const resize = () => update(false);
    const settle = () => settleRef.current();
    const observer = new ResizeObserver(() => {
      // Content growth changes scroll extent, never its layout width on panel toggles.
      if (!animation) paper.style.marginBottom = `${((Number(paper.dataset.paperScale) || 1) - 1) * paper.offsetHeight}px`;
    });
    observer.observe(paper);
    window.addEventListener("resize", resize);
    paper.addEventListener("reader-paper-settle", settle);
    return () => {
      // Preserve the current interpolated pose when interrupted by another toggle.
      const current = getComputedStyle(paper).transform;
      disposed = true;
      animation?.cancel();
      paper.style.transform = current;
      observer.disconnect();
      window.removeEventListener("resize", resize);
      paper.removeEventListener("reader-paper-settle", settle);
    };
  }, [bridgeRef, open, paperKey, pageSelector, paperSelector]);
}

import { useEffect, useState } from "react";

export const MOTION_DURATION_MS = 200;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function useMotionPresence(open, duration = MOTION_DURATION_MS) {
  const [state, setState] = useState(open ? "open" : "closed");

  useEffect(() => {
    let frame = 0;
    let timer = 0;
    const reduced = prefersReducedMotion();

    if (open) {
      setState((current) => current === "open" ? current : "opening");
      frame = window.requestAnimationFrame(() => setState("open"));
    } else {
      setState((current) => {
        if (current === "closed") return current;
        return reduced ? "closed" : "closing";
      });
      if (!reduced) timer = window.setTimeout(() => setState("closed"), duration);
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [duration, open]);

  return {
    state,
    present: state !== "closed",
    visible: state === "opening" || state === "open",
  };
}

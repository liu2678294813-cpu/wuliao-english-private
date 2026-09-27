import { useLayoutEffect, useRef } from "react";
import { registerPendingSave } from "./saveCoordinator.js";

export function useSaveBoundary(flush) {
  const latest = useRef(flush);
  useLayoutEffect(() => { latest.current = flush; });
  useLayoutEffect(() => registerPendingSave(() => latest.current()), []);
}

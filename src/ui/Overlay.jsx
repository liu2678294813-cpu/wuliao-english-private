import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { BACK_PRIORITY } from "./backController";
import { useBackHandler } from "./BackContext";

let scrollLockCount = 0;
let previousBodyOverflow = "";

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = previousBodyOverflow;
}

function focusableElements(root) {
  return root.querySelectorAll(
    "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])"
  );
}

export default function ModalShell({
  open,
  onClose,
  className = "ds-modal-backdrop",
  label,
  children,
}) {
  const [portalTarget, setPortalTarget] = useState(null);
  const layerRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useBackHandler(() => {
    onClose?.();
    return true;
  }, {
    enabled: open,
    priority: BACK_PRIORITY.modal,
  });

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    lockBodyScroll();
    const frame = window.requestAnimationFrame(() => {
      const first = layerRef.current && focusableElements(layerRef.current)[0];
      first?.focus?.({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unlockBodyScroll();
      const previous = previousFocusRef.current;
      if (previous instanceof HTMLElement && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div
      ref={layerRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose?.();
        }
      }}
    >
      {children}
    </div>,
    portalTarget,
  );
}

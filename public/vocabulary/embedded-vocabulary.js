(() => {
  const IS_EMBEDDED = window.parent !== window;
  if (!IS_EMBEDDED) return;

  document.documentElement.classList.add("vocab-embedded");
  const INITIAL_HISTORY_LENGTH = history.length;
  const staticPage = location.pathname.includes("memorize.html")
    ? "memorize"
    : location.pathname.includes("review.html")
      ? "review"
      : location.pathname.includes("import.html")
        ? "import"
        : "";
  let hasPreviousDocument = false;
  try {
    hasPreviousDocument = sessionStorage.getItem("wuliao:vocab:embedded-fresh") !== "1";
    sessionStorage.removeItem("wuliao:vocab:embedded-fresh");
  } catch {
    // Storage unavailable: fall back to history length comparison.
  }

  const usesHttpMessagingOrigin = () => location.protocol === "http:" || location.protocol === "https:";
  const parentMessageTargetOrigin = () => usesHttpMessagingOrigin() ? location.origin : "*";
  const isTrustedParentMessage = (event) => event.source === window.parent
    && (!usesHttpMessagingOrigin() || event.origin === location.origin);

  if (staticPage) {
    if (window.VocabularyBridge?.reportStaticPage) {
      window.VocabularyBridge.reportStaticPage(staticPage);
    } else {
      window.parent.postMessage(
        { type: "wuliao:vocabulary-static", page: staticPage },
        parentMessageTargetOrigin(),
      );
    }
  }

  const handleParentHardwareBack = () => {
    if (hasPreviousDocument || history.length > INITIAL_HISTORY_LENGTH) {
      history.back();
      if (window.VocabularyBridge?.respondHardwareBack) {
        window.VocabularyBridge.respondHardwareBack(false);
      } else {
        window.parent.postMessage(
          { type: "wuliao:hardware-back-response", atRoot: false },
          parentMessageTargetOrigin(),
        );
      }
      return;
    }
    if (window.VocabularyBridge?.respondHardwareBack) {
      window.VocabularyBridge.respondHardwareBack(true);
    } else {
      window.parent.postMessage(
        { type: "wuliao:hardware-back-response", atRoot: true },
        parentMessageTargetOrigin(),
      );
    }
  };

  window.addEventListener("message", (event) => {
    if (!isTrustedParentMessage(event)) return;
    if (event.data?.type !== "wuliao:hardware-back") return;
    handleParentHardwareBack();
  });

  // 新协议父消息由 vocabulary-bridge-adapter.js 转换为旧格式 CustomEvent。
  window.addEventListener("wuliao:hardware-back", () => handleParentHardwareBack());

  document.addEventListener("click", (event) => {
    const backLink = event.target.closest(".topbar .back-link");
    if (!backLink) return;
    event.preventDefault();
    if (window.VocabularyBridge?.requestBack) {
      window.VocabularyBridge.requestBack();
    } else {
      window.parent.postMessage({ type: "wuliao:vocabulary-back" }, parentMessageTargetOrigin());
    }
  });
})();

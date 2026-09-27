const PANEL_OPEN_EVENT = "wuliao:panel-open";

const PANEL_FAMILIES = Object.freeze({
  questions: "reader-workspace",
  "cloze-questions": "reader-workspace",
  ai: "reader-workspace",
});

export function panelFamily(panel) {
  return PANEL_FAMILIES[panel] || "reader-workspace";
}

export function panelPolicy(current, next) {
  if (!current || current === next) return "ignore";
  if (current === "questions" && next === "ai") return "coexist";
  if (current === "ai" && next === "questions") return "coexist";
  return "exclusive";
}

export function openPanel(panel, { scope = "reader" } = {}) {
  window.dispatchEvent(new CustomEvent(PANEL_OPEN_EVENT, {
    detail: { panel, scope, family: panelFamily(panel) },
  }));
}

export function onOtherPanelOpen(current, handler, { scope = "reader" } = {}) {
  const listener = (event) => {
    const panel = event.detail?.panel;
    if (panel && panel !== current && (event.detail?.scope || "reader") === scope) {
      handler(panel, event.detail);
    }
  };
  window.addEventListener(PANEL_OPEN_EVENT, listener);
  return () => window.removeEventListener(PANEL_OPEN_EVENT, listener);
}

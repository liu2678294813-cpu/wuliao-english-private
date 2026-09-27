export const RESPONSIVE_BREAKPOINTS = Object.freeze({
  compactMax: 599,
  phoneMax: 760,
  tabletMax: 899,
  wideTabletMax: 1099,
  readerDockedMin: 1400,
});

export function responsiveBand(width) {
  const value = Number(width);
  if (!Number.isFinite(value)) return "desktop";
  if (value <= RESPONSIVE_BREAKPOINTS.compactMax) return "compact";
  if (value <= RESPONSIVE_BREAKPOINTS.phoneMax) return "phone";
  if (value <= RESPONSIVE_BREAKPOINTS.tabletMax) return "tablet";
  if (value <= RESPONSIVE_BREAKPOINTS.wideTabletMax) return "wide-tablet";
  return "desktop";
}

export function hasWorkspaceMobileNav(width, mode = "workspace") {
  return mode === "workspace" && Number(width) <= RESPONSIVE_BREAKPOINTS.phoneMax;
}

export function clozeQuestionPanelMode(width) {
  return Number(width) <= RESPONSIVE_BREAKPOINTS.tabletMax ? "bottom-sheet" : "side-panel";
}

export function readerPanelMode(width) {
  return Number(width) >= RESPONSIVE_BREAKPOINTS.readerDockedMin ? "docked" : "overlay";
}

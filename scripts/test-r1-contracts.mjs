import test from "node:test";
import assert from "node:assert/strict";
import {
  BACK_PRIORITY,
  createBackController,
  resolveBackAction,
} from "../src/ui/backController.js";
import {
  clozeQuestionPanelMode,
  hasWorkspaceMobileNav,
  readerPanelMode,
  responsiveBand,
} from "../src/responsiveContract.js";
import { panelFamily, panelPolicy } from "../src/panelBus.js";
import { navigationBackTarget } from "../src/navigation.js";

test("R1 Back priority resolves one layer at a time", () => {
  assert.equal(resolveBackAction({ modal: true, drawer: true, immersive: true }), "close-modal");
  assert.equal(resolveBackAction({ drawer: true, temporary: true, immersive: true }), "close-drawer");
  assert.equal(resolveBackAction({ temporary: true, immersive: true }), "close-temporary");
  assert.equal(resolveBackAction({ immersive: true }), "exit-immersive");
  assert.equal(resolveBackAction({ hasHistory: true }), "history-back");
  assert.equal(resolveBackAction({ iframeHasRoute: true }), "iframe-back");
  assert.equal(resolveBackAction(), "home-fallback");
});

test("immersive sessions return to their recorded source view", () => {
  assert.equal(navigationBackTarget(["home", "library"]), "library");
  assert.equal(navigationBackTarget(["home", "cloze-library"]), "cloze-library");
  assert.equal(navigationBackTarget([]), "home");
});

test("Back controller invokes only the highest active handler", () => {
  const controller = createBackController();
  const calls = [];
  const removeDrawer = controller.register(() => {
    calls.push("drawer");
    return true;
  }, { priority: BACK_PRIORITY.drawer });
  controller.register(() => {
    calls.push("modal");
    return true;
  }, { priority: BACK_PRIORITY.modal });

  assert.equal(controller.handle(), true);
  assert.deepEqual(calls, ["modal"]);
  removeDrawer();
  assert.equal(controller.handle(), true);
  assert.deepEqual(calls, ["modal", "modal"]);
});

test("Reader panel policy keeps classic question/AI coexistence and isolates Cloze", () => {
  assert.equal(panelPolicy("questions", "ai"), "coexist");
  assert.equal(panelPolicy("ai", "questions"), "coexist");
  assert.equal(panelPolicy("cloze-questions", "ai"), "exclusive");
  assert.equal(panelPolicy("ai", "cloze-questions"), "exclusive");
  assert.equal(panelFamily("questions"), "reader-workspace");
  assert.equal(panelFamily("cloze-questions"), "reader-workspace");
});

test("R1 responsive contract has no 760/899 gap", () => {
  assert.equal(responsiveBand(599), "compact");
  assert.equal(responsiveBand(600), "phone");
  assert.equal(responsiveBand(760), "phone");
  assert.equal(responsiveBand(761), "tablet");
  assert.equal(responsiveBand(899), "tablet");
  assert.equal(responsiveBand(900), "wide-tablet");
  assert.equal(responsiveBand(1099), "wide-tablet");
  assert.equal(responsiveBand(1100), "desktop");
  assert.equal(clozeQuestionPanelMode(899), "bottom-sheet");
  assert.equal(clozeQuestionPanelMode(900), "side-panel");
  assert.equal(readerPanelMode(1399), "overlay");
  assert.equal(readerPanelMode(1400), "docked");
});

test("mobile navigation offset depends on Shell mode, not just viewport", () => {
  assert.equal(hasWorkspaceMobileNav(760, "workspace"), true);
  assert.equal(hasWorkspaceMobileNav(761, "workspace"), false);
  assert.equal(hasWorkspaceMobileNav(390, "immersive"), false);
});

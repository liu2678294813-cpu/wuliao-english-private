import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const css = await readFile(new URL("../src/writing/writing.css", import.meta.url), "utf8");
const shellCss = await readFile(new URL("../src/redesign/app-shell.css", import.meta.url), "utf8");

test("Writing responsive CSS is scoped and avoids viewport-width body overflow", () => {
  assert.doesNotMatch(css, /^\s*(button|textarea|input|header|main|\.card)\s*\{/m);
  assert.doesNotMatch(css, /100vw/);
  assert.match(css, /\.writing-library \{ width: 100%;/);
  assert.match(css, /\.writing-progress[\s\S]*overflow-x: auto/);
  assert.match(css, /\.writing-stage[\s\S]*var\(--ds-shell-bottom-offset/);
});

test("Whole-document workspaces keep the selected split/stacked layout at every breakpoint", () => {
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.writing-branch-grid[\s\S]*\.writing-score-dimensions[\s\S]*\.writing-compare-grid[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.writing-stage-header[\s\S]*flex-direction: column/);
  assert.match(css, /\.writing-split-workspace\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, var\(--writing-split-source-fr, 40fr\)\) minmax\(0, var\(--writing-split-work-fr, 60fr\)\)/);
  assert.match(css, /\.writing-split-workspace\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(css, /\.writing-split-pane\s*\{\s*display:\s*contents/);
  assert.match(css, /\.writing-split-source > \.writing-split-scroll\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2/);
  assert.match(css, /\.writing-split-work > \.writing-split-scroll\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2/);
  assert.match(css, /\.writing-split-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.writing-split-header-actions\s*\{[^}]*align-self:\s*center/);
  assert.doesNotMatch(css, /@media \(max-width: 760px\)[\s\S]*\.writing-split-workspace,[\s\S]*grid-template-columns: 1fr/);
});

test("Writing toolbar uses the compact header center slot and never fixed positioning", () => {
  assert.match(css, /\.writing-ink-composer \.annotation-toolbar \{ position: sticky;[^}]*top: 0/);
  assert.match(css, /\.writing-compact-toolbar-center \.annotation-toolbar\s*\{[\s\S]*position:\s*static/);
  assert.match(css, /\.writing-compact-toolbar-center \.annotation-toolbar\s*\{[^}]*color:\s*var\(--ds-ink\)/);
  assert.match(css, /\.writing-compact-toolbar-center \.annotation-toolbar > button\.active,[\s\S]*color:\s*var\(--ds-ink\)/);
  assert.match(css, /\.writing-stage-w7 \.writing-ink-surface,[\s\S]*min-height: clamp\(460px, 56dvh, 680px\)/);
  assert.doesNotMatch(css, /\.writing-(?:ink-composer|compact-toolbar-center) \.annotation-toolbar[^}]*position:\s*fixed/);
  assert.match(css, /\.writing-split-work \.writing-ink-composer\s*\{[^}]*overflow:\s*visible;[^}]*padding:\s*0/);
});

test("Every Writing paper keeps the original light background and uses horizontal rules only", () => {
  const paperRule = css.match(/(?:^|\n)\.writing-paper\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(paperRule, /background-color:\s*#fffefa/);
  assert.match(paperRule, /background-image:\s*repeating-linear-gradient\(to bottom/);
  assert.doesNotMatch(paperRule, /linear-gradient\(90deg/);
});

test("W2 uses a compact viewport shell, bounded scrollable ink document, and header action", async () => {
  const splitSource = await readFile(new URL("../src/writing/ui/WritingSplitWorkspace.jsx", import.meta.url), "utf8");
  assert.match(css, /\.writing-stage-w2\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*display:\s*flex/);
  assert.match(css, /\.writing-stage-w2 \.writing-stage-content\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0/);
  assert.match(css, /\.writing-stage-header-actions\s*\{[^}]*display:\s*flex/);
  assert.doesNotMatch(css, /\.writing-stage-actions\s*\{/);
  assert.match(css, /\.writing-stage-w2 \.writing-ink-surface,[\s\S]*height:\s*var\(--writing-ink-document-height\)/);
  assert.match(css, /\.writing-ink-composer \.annotation-toolbar\s*\{[^}]*height:\s*42px;[^}]*min-height:\s*42px/);
  assert.match(css, /\.writing-ink-surface\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.writing-ink-content\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(splitSource, /Math\.max\(sourceContentHeight \* 2, workViewportHeight, 1\)/);
  assert.match(splitSource, /ResizeObserver/);
  assert.match(splitSource, /--writing-ink-document-height/);
});

test("compact immersive and stacked layouts reuse the same panes without restoring removed chrome", async () => {
  const stageSource = await readFile(new URL("../src/writing/ui/WritingStageShell.jsx", import.meta.url), "utf8");
  const splitSource = await readFile(new URL("../src/writing/ui/WritingSplitWorkspace.jsx", import.meta.url), "utf8");
  assert.match(css, /\.writing-stage\.is-compact-workspace\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden/);
  assert.match(css, /\.writing-compact-toolbar\s*\{[^}]*min-height:\s*46px/);
  assert.match(css, /\.writing-split-workspace\.is-stacked\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-rows:\s*auto minmax\(0, var\(--writing-stacked-source-fr, 50fr\)\) auto minmax\(0, var\(--writing-stacked-work-fr, 50fr\)\)/);
  assert.match(css, /\.writing-stage\.is-compact-workspace\.is-immersive/);
  assert.match(stageSource, /compact \? "writing-compact-toolbar" : "writing-stage-header"/);
  assert.match(stageSource, /data-writing-toolbar-slot="center"/);
  assert.match(stageSource, /!compact \? <nav className="writing-progress"/);
  assert.match(splitSource, /data-writing-layout=\{layout\}/);
  assert.doesNotMatch(splitSource, /key=\{layout\}/);
});

test("Mobile navigation accommodates all nine top-level leaves inside its own scroll container", () => {
  assert.match(shellCss, /grid-template-columns: repeat\(9, minmax\(44px, 1fr\)\)/);
  assert.match(shellCss, /\.ds-bottom-nav[\s\S]*overflow-x: auto/);
});

test("W7 fence remains absent at desktop/tablet landscape/tablet portrait/narrow DOM widths", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "localStorage", "Event", "HTMLElement", "HTMLTextAreaElement", "Node"]) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ReactModule = await import("react");
  const React = ReactModule.default;
  const { act } = ReactModule;
  const { createRoot } = await import("react-dom/client");
  const vite = await createViteModuleRunner(repositoryRoot);
  const { W7IndependentStage } = await vite.import("/src/writing/ui/WritingStages.jsx");
  const root = createRoot(document.getElementById("root"));
  const forbidden = ["UNIQUE_SAMPLE_SECRET", "UNIQUE_TRANSLATION_SECRET", "UNIQUE_BACK_TRANSLATION_SECRET", "UNIQUE_DIAG_SECRET", "UNIQUE_SKELETON_SECRET", "UNIQUE_RECON_SECRET", "UNIQUE_ADVICE_SECRET"];
  const vm = {
    sessionId: "session-responsive",
    promptSnapshot: { promptText: "Write an independent essay.", directions: "About 100 words.", targetWordRange: { min: 90, max: 120 }, fingerprint: "prompt-fp" },
    currentIndependentAttempt: null,
    transcriptionDraft: null,
    transcriptionVerificationState: "drafting",
    sampleEssaySnapshot: { text: forbidden[0] },
    translationSnapshot: { text: forbidden[1] },
    submittedBackTranslation: { text: forbidden[2] },
    compareDiagnosis: { text: forbidden[3] },
    currentSkeletonRevision: { text: forbidden[4] },
    currentReconstructionAttempt: { text: forbidden[5] },
    previousAdvice: forbidden[6],
  };
  for (const [label, width, height] of [["desktop", 1440, 900], ["tablet-landscape", 1280, 800], ["tablet-portrait", 800, 1280], ["narrow", 600, 900]]) {
    await t.test(label, async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      await act(async () => {
        root.render(React.createElement(W7IndependentStage, {
          vm,
          commandContext: { sessionId: vm.sessionId, sessionExpectedRevision: 1, sessionFingerprint: "session-fp" },
          services: { commands: { submitIndependentTyped: async () => {} } },
          username: "alice",
          createId: (prefix) => `${prefix}-responsive`,
          busyAction: "",
          onAction: (_name, work) => work(),
        }));
      });
      const text = document.getElementById("root").textContent;
      assert.match(text, /Write an independent essay/);
      for (const marker of forbidden) assert.ok(!text.includes(marker), `${marker} leaked at ${width}x${height}`);
      assert.ok(document.querySelector(".writing-split-workspace"));
      assert.ok(document.querySelector("[aria-label='原始作文题与约束']"));
      assert.ok(document.querySelector(".writing-independent-editor textarea"));
    });
  }
  await act(async () => root.unmount());
  await vite.close();
});

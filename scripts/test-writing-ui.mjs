import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "https://localhost/",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "localStorage", "CustomEvent", "Event", "InputEvent", "MouseEvent", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "Node"]) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);

const ReactModule = await import("react");
const React = ReactModule.default;
const { act, useEffect } = ReactModule;
const { createRoot } = await import("react-dom/client");

const vite = await createViteModuleRunner(repositoryRoot);
const { default: WritingWorkspace } = await vite.import("/src/writing/ui/WritingWorkspace.jsx");
const { default: WritingLibrary } = await vite.import("/src/writing/ui/WritingLibrary.jsx");
const { createWritingReadModelService } = await vite.import("/src/writing/writingReadModels.js");
const { writingKeys } = await vite.import("/src/writing/writingRepository.js");
const {
  W1SampleReadingStage,
  W2TranslationStage,
  W3BackTranslationStage,
  W4CompareStage,
  W5SkeletonStage,
  W6ReconstructionStage,
  W7IndependentStage,
  W8ScoreRewriteStage,
  WritingDoneStage,
} = await vite.import("/src/writing/ui/WritingStages.jsx");
const {
  default: WritingInkComposer,
  createWritingInkFlushBridge,
} = await vite.import("/src/writing/ui/WritingInkComposer.jsx");
const { AnnotationToolbar } = await vite.import("/src/ui/AnnotationToolbar.jsx");
const {
  WritingAttemptStatus,
  WritingAttemptType,
  WritingInputMethod,
  WritingStage,
} = await vite.import("/src/writing/writingModels.js");
const {
  ALICE,
  NOW,
  createAttempt,
  createRepository,
  createSession,
  scopedStore,
  setupWritingStage,
} = await import("./writing-slice7-fixtures.mjs");

const USERNAME = "writing-ui-user";
let mountedRoot = null;

function wait(milliseconds = 0) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function render(element) {
  if (mountedRoot) {
    await act(async () => { mountedRoot.unmount(); await wait(); });
  }
  const container = document.getElementById("root");
  container.replaceChildren();
  mountedRoot = createRoot(container);
  await act(async () => { mountedRoot.render(element); await wait(); });
  return container;
}

async function rerender(element) {
  await act(async () => { mountedRoot.render(element); await wait(); });
  return document.getElementById("root");
}

async function click(element) {
  assert.ok(element, "click target should exist");
  await act(async () => { element.click(); await wait(); });
}

async function setText(element, value) {
  assert.ok(element, "text input should exist");
  const previous = element.value;
  const prototype = element.tagName === "TEXTAREA"
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element._valueTracker?.setValue(previous);
  await act(async () => {
    element.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait();
  });
}

async function waitForSelector(container, selector, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const match = container.querySelector(selector);
    if (match) return match;
    await act(async () => { await wait(10); });
  }
  assert.fail(`Timed out waiting for ${selector}; rendered text: ${container.textContent}`);
}

async function waitForText(container, pattern, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (pattern.test(container.textContent)) return;
    await act(async () => { await wait(10); });
  }
  assert.fail(`Timed out waiting for ${pattern}; rendered text: ${container.textContent}`);
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function idFactory(prefix) {
  return `${prefix}-fixed`;
}

function commandContext() {
  return { sessionId: "session-ui", sessionExpectedRevision: 7, sessionFingerprint: "session-fingerprint" };
}

function promptSnapshot() {
  return {
    promptText: "Write a notice about an English club meeting.",
    directions: "Write about 100 words.",
    targetWordRange: { min: 90, max: 120 },
    fingerprint: "prompt-fingerprint",
  };
}

function stageVm(stage, extra = {}) {
  return { sessionId: "session-ui", stage, safeStage: stage, stageMetadata: {}, ...extra };
}

function immediateAction(actionName, work) {
  return work();
}

function countFormalRepositoryWrites(repository) {
  let count = 0;
  for (const method of [
    "saveSession",
    "saveTranslationRevision",
    "createTranslationSnapshot",
    "saveAttempt",
    "saveSkeletonRevision",
    "saveTranscription",
    "createAiArtifact",
    "createScoreReport",
    "createLearningItem",
    "saveReviewTask",
  ]) {
    const original = repository[method]?.bind(repository);
    if (!original) continue;
    repository[method] = async (...args) => {
      count += 1;
      return original(...args);
    };
  }
  return () => count;
}

function countCommandMutations() {
  let count = 0;
  return {
    commands: new Proxy({}, {
      get: () => async () => {
        count += 1;
      },
    }),
    read: () => count,
  };
}

function InkProbe(props) {
  return React.createElement("div", {
    "data-testid": "ink-probe",
    "data-surface-id": props.surfaceId,
    "data-owner-id": props.ownerRecordId,
    "data-stage-id": props.stageId,
  }, "共享手写 Surface");
}

function FlushableInkProbe(props) {
  useEffect(() => props.flushBridge?.attach({
    sessionId: props.sessionId,
    surfaceId: props.surfaceId,
    stageId: props.stageId,
    ownerRecordId: props.ownerRecordId,
  }, async () => ({
    id: `ink:${props.ownerRecordId}`,
    surfaceId: props.surfaceId,
    stageId: props.stageId,
    ownerRecordId: props.ownerRecordId,
    sourceFingerprint: props.sourceFingerprint,
    fingerprint: `ink-fingerprint:${props.ownerRecordId}`,
    revision: 1,
    updatedAt: NOW,
  })), [props.flushBridge, props.ownerRecordId, props.sessionId, props.sourceFingerprint, props.stageId, props.surfaceId]);
  return React.createElement("div", {
    "data-testid": "flushable-ink-probe",
    "data-surface-id": props.surfaceId,
    "data-owner-id": props.ownerRecordId,
  }, "可 flush 手写 Surface");
}

function ReadonlyInkProbe(props) {
  return React.createElement("section", { "aria-readonly": props.readOnly ? "true" : undefined },
    props.children,
    React.createElement("canvas", { className: "writing-ink-preview" }),
  );
}

test("UI source contracts keep formal writes behind services and preserve every exact ink identity", async () => {
  const stages = await readFile(new URL("../src/writing/ui/WritingStages.jsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../src/writing/ui/WritingWorkspace.jsx", import.meta.url), "utf8");
  const combined = `${stages}\n${workspace}`;
  for (const forbidden of ["writingRepository", "writingInkStorage", "localStorage.setItem", ".currentStage =", "saveSession("]) {
    assert.equal(combined.includes(forbidden), false, `${forbidden} must not appear in formal Writing UI`);
  }
  for (const contract of [
    "w2:translation:${revisionId}",
    "w3:back:${attemptId}",
    "w5:skeleton:${revisionId}",
    "w6:reconstruction:${attemptId}",
    "w7:independent:${attemptId}",
    "w8:revision:${revisionAttemptId}",
  ]) assert.ok(stages.includes(contract), `${contract} should be exact`);
  assert.ok(combined.includes("loadWritingWorkspace"), "first frame must come from recovery-aware Read Model");
  assert.ok(workspace.includes("workspace.safeStage"), "renderer must select the safe stage");
});

test("ink flush bridge accepts only the exact mounted identity", async () => {
  const bridge = createWritingInkFlushBridge();
  const identity = { sessionId: "s", stageId: "W3_BACK_TRANSLATION", ownerRecordId: "a", surfaceId: "w3:back:a" };
  bridge.attach(identity, async () => ({ fingerprint: "ink-fingerprint" }));
  assert.deepEqual(await bridge.flush(identity), { fingerprint: "ink-fingerprint" });
  await assert.rejects(bridge.flush({ ...identity, surfaceId: "w7:independent:a" }), /does not match/);
});

test("WritingInkComposer mounts the shared toolbar and exposes its verified flush handle", async () => {
  localStorage.clear();
  localStorage.setItem("kaoyan_vocab_current_user", USERNAME);
  const bridge = createWritingInkFlushBridge();
  function FakeToolbar() { return React.createElement("div", { "data-testid": "shared-toolbar" }, "共享批注工具栏"); }
  function FakeInkSurface({ onFlushHandleChange, onToolbarApiChange, onStrokesCountChange, children }) {
    useEffect(() => {
      onFlushHandleChange(async () => ({ fingerprint: "verified-ink" }));
      onToolbarApiChange({ undo() {}, clear() {}, canClear: true });
      onStrokesCountChange(3);
      return () => onFlushHandleChange(null);
    }, [onFlushHandleChange, onStrokesCountChange, onToolbarApiChange]);
    return React.createElement("div", { "data-testid": "ink-surface" }, children);
  }
  const identity = { sessionId: "session-ui", stageId: WritingStage.W3_BACK_TRANSLATION, ownerRecordId: "attempt-ink", surfaceId: "w3:back:attempt-ink" };
  const container = await render(React.createElement(WritingInkComposer, {
    username: USERNAME,
    ...identity,
    sourceFingerprint: "source-fingerprint",
    flushBridge: bridge,
    InkSurface: FakeInkSurface,
    Toolbar: FakeToolbar,
  }));
  assert.ok(container.querySelector("[data-testid=shared-toolbar]"));
  assert.match(container.textContent, /3 笔/);
  assert.deepEqual(await bridge.flush(identity), { fingerprint: "verified-ink" });
});

test("WritingInkComposer wires Shared Ink canUndo into the shared toolbar", async () => {
  const composerSource = await readFile(new URL("../src/writing/ui/WritingInkComposer.jsx", import.meta.url), "utf8");
  const stagesSource = await readFile(new URL("../src/writing/ui/WritingStages.jsx", import.meta.url), "utf8");
  const toolbarSource = await readFile(new URL("../src/ui/AnnotationToolbar.jsx", import.meta.url), "utf8");
  assert.match(composerSource, /canUndo=\{Boolean\(toolbarApi\?\.canUndo\)\}/);
  assert.match(composerSource, /unknownEnabled=\{false\}/);
  assert.doesNotMatch(composerSource, /controlProfile|compactPenOnly/);
  assert.doesNotMatch(composerSource, /compactPenOnly/);
  assert.doesNotMatch(stagesSource, /includeMixed/);
  assert.doesNotMatch(stagesSource.match(/const INPUT_MODES[\s\S]*?\]\);/)?.[0] || "", /WritingInputMethod\.MIXED/);
  assert.match(toolbarSource, /canUndo === undefined \? !annotations\.length : !canUndo/);
});

test("shared toolbar defaults to the full Reader controls", async () => {
  const container = await render(React.createElement(AnnotationToolbar, {
    tool: "pen",
    color: "#173a62",
    annotations: [],
    onTool: () => {},
    onColor: () => {},
    onUndo: () => {},
    onClear: () => {},
    penSize: 2.6,
    onPenSize: () => {},
    unknownEnabled: false,
  }));
  assert.ok(container.querySelector("[role=slider][aria-label='画笔粗细']"));
  assert.match(container.textContent, /粗细2\.6/);
  assert.match(container.textContent, /橡皮|撤销|清空/);
  assert.doesNotMatch(container.textContent, /陌生词/);
  assert.equal(container.querySelectorAll(".color-picker button").length, 3);
});

test("Writing uses the unchanged full shared toolbar controls", async () => {
  const container = await render(React.createElement(AnnotationToolbar, {
    tool: "pen",
    color: "#173a62",
    annotations: [],
    onTool: () => {},
    onColor: () => {},
    onUndo: () => {},
    onClear: () => {},
    penSize: 2.6,
    onPenSize: () => {},
    unknownEnabled: false,
  }));
  for (const expected of ["笔", "橡皮", "粗细", "2.6", "撤销", "清空本页"]) assert.match(container.textContent, new RegExp(expected));
  assert.doesNotMatch(container.textContent, /陌生词/);
  assert.ok(container.querySelector("[role=slider][aria-label='画笔粗细']"));
  assert.equal(container.querySelectorAll(".color-picker button").length, 3);
});

test("Workspace first frame waits for recovery and never flashes W1 or the previous Session", async () => {
  const first = deferred();
  const second = deferred();
  const services = {
    readModels: { loadWritingWorkspace: ({ sessionId }) => sessionId === "session-a" ? first.promise : second.promise },
  };
  const props = { username: USERNAME, services, createId: idFactory };
  let container = await render(React.createElement(WritingWorkspace, { ...props, sessionId: "session-a" }));
  assert.match(container.textContent, /正在恢复写作现场/);
  assert.doesNotMatch(container.textContent, /范文精读|SECRET_A/);
  first.resolve({
    sessionId: "session-a", safeStage: WritingStage.W7_INDEPENDENT, status: "active", sessionRevision: 1, sessionFingerprint: "a",
    stageViewModel: stageVm(WritingStage.W7_INDEPENDENT, { sessionId: "session-a", promptSnapshot: { ...promptSnapshot(), promptText: "SECRET_A prompt" }, currentIndependentAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting" }),
  });
  await act(async () => { await first.promise; await wait(); });
  assert.match(container.textContent, /SECRET_A prompt/);
  container = await rerender(React.createElement(WritingWorkspace, { ...props, sessionId: "session-b" }));
  assert.match(container.textContent, /正在恢复写作现场/);
  assert.doesNotMatch(container.textContent, /SECRET_A/);
  second.resolve({
    sessionId: "session-b", safeStage: WritingStage.DONE, status: "completed", sessionRevision: 2, sessionFingerprint: "b",
    stageViewModel: stageVm(WritingStage.DONE, { sessionId: "session-b", completedAt: Date.now(), completionScore: null, latestScore: null, reviewStatusSummary: {} }),
  });
  await act(async () => { await second.promise; await wait(); });
  assert.match(container.textContent, /本次写作已完成/);
});

test("Workspace renders account mismatch and damaged recovery as blocking states", async () => {
  for (const [status, expected] of [["account_mismatch", "账号不匹配"], ["damaged", "写作记录需要修复"]]) {
    const services = { readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: null, status, stageViewModel: null, diagnostics: [] }) } };
    const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services }));
    assert.match(container.textContent, new RegExp(expected));
    assert.equal(container.querySelector(".writing-progress"), null);
  }
});

test("Workspace pointer-ahead recovery renders safe W5 without blocking or formal writes", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W5_SKELETON);
  await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W7_INDEPENDENT,
    updatedAt: NOW + 20,
    lastActiveAt: NOW + 20,
  }, { expectedRevision: setup.session.revision });
  const repositoryWrites = countFormalRepositoryWrites(repository);
  const commandMutations = countCommandMutations();
  const readModels = createWritingReadModelService({ repository, getCurrentUsername: () => ALICE });
  const container = await render(React.createElement(WritingWorkspace, {
    sessionId: setup.session.sessionId,
    username: ALICE,
    services: { readModels, commands: commandMutations.commands },
    createId: idFactory,
  }));

  await waitForSelector(container, ".writing-stage-w5");
  assert.equal(container.querySelector(".writing-stage-w7"), null);
  assert.equal(container.querySelector(".writing-blocking-state"), null);
  assert.equal(repositoryWrites(), 0);
  assert.equal(commandMutations.read(), 0);
});

test("Workspace facts-ahead recovery renders safe W8 without blocking or formal writes", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W6_RECONSTRUCTION);
  await createAttempt(repository, setup.session, {
    attemptId: "attempt-w6-recovered",
    attemptType: WritingAttemptType.RECONSTRUCTION,
    stageId: WritingStage.W6_RECONSTRUCTION,
    context: { skeletonRevisionId: null },
    status: WritingAttemptStatus.SUBMITTED,
    typedText: "Recovered reconstruction",
    submittedText: "Recovered reconstruction",
  });
  await createAttempt(repository, setup.session, {
    attemptId: "attempt-w7-recovered",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: setup.session.promptSnapshot.fingerprint },
    status: WritingAttemptStatus.SUBMITTED,
    typedText: "Recovered independent essay",
    submittedText: "Recovered independent essay",
  });
  await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W5_SKELETON,
    updatedAt: NOW + 20,
    lastActiveAt: NOW + 20,
  }, { expectedRevision: setup.session.revision });
  const repositoryWrites = countFormalRepositoryWrites(repository);
  const commandMutations = countCommandMutations();
  const readModels = createWritingReadModelService({ repository, getCurrentUsername: () => ALICE });
  const container = await render(React.createElement(WritingWorkspace, {
    sessionId: setup.session.sessionId,
    username: ALICE,
    services: { readModels, commands: commandMutations.commands },
    createId: idFactory,
  }));

  await waitForSelector(container, ".writing-stage-w8");
  assert.equal(container.querySelector(".writing-stage-w5"), null);
  assert.equal(container.querySelector(".writing-blocking-state"), null);
  assert.equal(repositoryWrites(), 0);
  assert.equal(commandMutations.read(), 0);
});

test("Workspace pointer-ahead recovery to W7 preserves the W7 information fence", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W7_INDEPENDENT, { skeletonMode: "completed" });
  await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W8_SCORE_REWRITE,
    updatedAt: NOW + 20,
    lastActiveAt: NOW + 20,
  }, { expectedRevision: setup.session.revision });
  const realReadModels = createWritingReadModelService({ repository, getCurrentUsername: () => ALICE });
  const readModels = {
    async loadWritingWorkspace(args) {
      return {
        ...await realReadModels.loadWritingWorkspace(args),
        recoverySourceAudit: {
          sampleEssay: "UNIQUE_SAMPLE_SECRET",
          translation: "UNIQUE_TRANSLATION_SECRET",
          diagnosis: "UNIQUE_DIAG_SECRET",
          skeleton: "UNIQUE_SKELETON_SECRET",
          reconstruction: "UNIQUE_RECON_SECRET",
        },
      };
    },
  };
  const container = await render(React.createElement(WritingWorkspace, {
    sessionId: setup.session.sessionId,
    username: ALICE,
    services: { readModels, commands: {} },
    createId: idFactory,
  }));

  await waitForSelector(container, ".writing-stage-w7");
  assert.equal(container.querySelector(".writing-blocking-state"), null);
  for (const secret of [
    "UNIQUE_SAMPLE_SECRET",
    "UNIQUE_TRANSLATION_SECRET",
    "UNIQUE_DIAG_SECRET",
    "UNIQUE_SKELETON_SECRET",
    "UNIQUE_RECON_SECRET",
  ]) assert.equal(container.textContent.includes(secret), false, `${secret} leaked during W7 recovery`);
});

test("Workspace blocks a real bad fingerprint and account mismatch without leaking user content", async () => {
  const store = scopedStore();
  const repository = createRepository(store);
  const session = await createSession(repository);
  const rawKey = store.physical(writingKeys.session(session.sessionId), ALICE);
  const stored = JSON.parse(store.values.get(rawKey));
  store.values.set(rawKey, JSON.stringify({ ...stored, currentStage: WritingStage.W2_EN_ZH }));
  const damagedReadModels = createWritingReadModelService({ repository, getCurrentUsername: () => ALICE });
  let container = await render(React.createElement(WritingWorkspace, {
    sessionId: session.sessionId,
    username: ALICE,
    services: { readModels: damagedReadModels, commands: {} },
    createId: idFactory,
  }));
  await waitForText(container, /写作记录需要修复/);
  assert.ok(container.querySelector(".writing-blocking-state"));
  assert.equal(container.querySelector(".writing-stage"), null);
  assert.doesNotMatch(container.textContent, /SAMPLE_SECRET/);

  const cleanRepository = createRepository(scopedStore());
  const cleanSession = await createSession(cleanRepository, { sessionId: "account-mismatch-session" });
  const mismatchReadModels = createWritingReadModelService({ repository: cleanRepository, getCurrentUsername: () => "bob" });
  container = await render(React.createElement(WritingWorkspace, {
    sessionId: cleanSession.sessionId,
    username: "bob",
    services: { readModels: mismatchReadModels, commands: {} },
    createId: idFactory,
  }));
  await waitForText(container, /账号不匹配/);
  assert.ok(container.querySelector(".writing-blocking-state"));
  assert.match(container.textContent, /账号不匹配/);
  assert.equal(container.querySelector(".writing-stage"), null);
  assert.doesNotMatch(container.textContent, /SAMPLE_SECRET/);
});

test("Workspace synchronously suppresses a W1 double submit", async () => {
  const gate = deferred();
  let calls = 0;
  const vm = stageVm(WritingStage.W1_SAMPLE_READING, {
    promptSnapshot: promptSnapshot(),
    sampleEssaySnapshot: { fingerprint: "sample", qualityStatus: "passed", wordCount: 4, segments: [{ unitId: "u1", text: "A careful sample sentence." }] },
  });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W1_SAMPLE_READING, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    commands: { completeReadingAndEnterW2: async () => { calls += 1; return gate.promise; } },
    unknownWords: { saveWritingUnknownWord: async () => {} },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  const submit = buttonByText(container, "完成范文精读");
  await act(async () => { submit.click(); submit.click(); await wait(); });
  assert.equal(calls, 1);
  gate.resolve({});
  await act(async () => { await gate.promise; await wait(); });
});

test("W1 renders only a passed frozen sample and toggles Unknown Words only by explicit click", async () => {
  const calls = [];
  const vm = stageVm(WritingStage.W1_SAMPLE_READING, {
    promptSnapshot: promptSnapshot(),
    sampleEssaySnapshot: { fingerprint: "sample-fingerprint", qualityStatus: "passed", wordCount: 3, segments: [{ unitId: "u1", text: "Explicit vocabulary action." }] },
  });
  const services = { unknownWords: { saveWritingUnknownWord: async (args) => { calls.push(args); } }, commands: {} };
  const container = await render(React.createElement(W1SampleReadingStage, { vm, commandContext: commandContext(), services, busyAction: "", onAction: immediateAction }));
  const word = buttonByText(container.querySelector(".writing-reading-sheet"), "vocabulary");
  assert.equal(calls.length, 0);
  await click(word);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sampleEssayFingerprint, "sample-fingerprint");
  assert.equal(word.getAttribute("aria-pressed"), "true");
  await click(word);
  assert.equal(calls.length, 2, "shared Unknown Words toggle is called again for explicit cancellation");
  assert.equal(word.getAttribute("aria-pressed"), "false");
});

test("W1 command failure stays on W1 and retains the frozen sample", async () => {
  const vm = stageVm(WritingStage.W1_SAMPLE_READING, {
    promptSnapshot: promptSnapshot(), sampleEssaySnapshot: { fingerprint: "sample", qualityStatus: "passed", wordCount: 2, segments: [{ unitId: "u1", text: "FROZEN_SAMPLE_REMAINS" }] },
  });
  const failure = Object.assign(new Error("internal storage details"), { code: "repository_error" });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W1_SAMPLE_READING, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    commands: { completeReadingAndEnterW2: async () => { throw failure; } }, unknownWords: { saveWritingUnknownWord: async () => {} },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await click(buttonByText(container, "完成范文精读"));
  assert.match(container.textContent, /FROZEN_SAMPLE_REMAINS/);
  assert.match(container.textContent, /操作未完成/);
  assert.doesNotMatch(container.textContent, /internal storage details/);
});

test("W2 builds a formal revision and immutable snapshot request with deterministic IDs", async () => {
  let received = null;
  const vm = stageVm(WritingStage.W2_EN_ZH, {
    sampleSegments: [{ unitId: "u1", text: "First sentence." }, { unitId: "u2", text: "Second sentence." }],
    currentTranslationRevision: null,
    translationInkRef: null,
  });
  const services = { commands: { commitTranslationAndEnterW3: async (args) => { received = args; } } };
  const container = await render(React.createElement(W2TranslationStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction, InkComposer: InkProbe }));
  assert.equal(buttonByText(container, "混合输入"), undefined, "W2 no longer exposes mixed input mode");
  assert.ok(container.querySelector(".writing-compact-toolbar"), "W2 uses the compact toolbar");
  assert.equal(container.querySelector(".writing-stage-header"), null, "the former large blue stage header is removed");
  assert.equal(container.querySelector(".writing-progress"), null, "compact dual-pane stages do not reserve progress chrome");
  assert.equal(container.querySelectorAll(".writing-split-pane > header p").length, 0, "W2 pane hints are removed to keep both headers compact");
  const areas = container.querySelectorAll("textarea");
  assert.equal(areas.length, 1, "W2 uses one whole-document editor rather than sentence cards");
  await setText(areas[0], "第一段。\n\n第二段。");
  await click(buttonByText(container, "提交完整中文译文"));
  assert.equal(received.revisionId, "translation-fixed");
  assert.equal(received.snapshotId, "translation-snapshot-fixed");
  assert.deepEqual(received.translationRevision.units.map((unit) => unit.unitId), ["u1"]);
  assert.equal(received.translationRevision.units[0].typedText, "第一段。\n\n第二段。");
  const sourceBeforeModeSwitch = container.querySelector("[aria-label='完整英文范文']").textContent;
  await click(buttonByText(container, "手写"));
  assert.equal(container.querySelector("[data-testid=ink-probe]").dataset.surfaceId, "w2:translation:translation-fixed");
  assert.equal(container.querySelector("textarea"), null);
  assert.ok(container.querySelector(".writing-stage-header-actions button"));
  assert.equal(container.querySelector(".writing-stage > footer"), null);
  await click(buttonByText(container, "键盘输入"));
  assert.equal(container.querySelector("textarea").value, "第一段。\n\n第二段。");
  assert.equal(container.querySelector("[data-testid=ink-probe]"), null);
  assert.equal(container.querySelector("[aria-label='完整英文范文']").textContent, sourceBeforeModeSwitch);
});

test("handwriting toolbar portals into compact top chrome and keyboard mode leaves no placeholder controls", async () => {
  let inkMounts = 0;
  function FakeInkSurface({ surfaceId, ownerRecordId, onFlushHandleChange, onToolbarApiChange, onStrokesCountChange, children }) {
    useEffect(() => {
      inkMounts += 1;
      onFlushHandleChange?.(async () => null);
      onToolbarApiChange?.({ canUndo: false, canClear: false });
      onStrokesCountChange?.(0);
      return () => onFlushHandleChange?.(null);
    }, [onFlushHandleChange, onStrokesCountChange, onToolbarApiChange]);
    return React.createElement("div", { "data-testid": "portal-ink", "data-surface-id": surfaceId, "data-owner-id": ownerRecordId }, children);
  }
  const vm = stageVm(WritingStage.W2_EN_ZH, {
    sampleSegments: [{ unitId: "u1", text: "Reference" }], currentTranslationRevision: null, translationInkRef: null,
  });
  const container = await render(React.createElement(W2TranslationStage, {
    vm, commandContext: commandContext(), services: { commands: {} }, username: USERNAME, createId: idFactory,
    busyAction: "", onAction: immediateAction, onBack: () => {}, InkSurfaceComponent: FakeInkSurface,
  }));
  assert.equal(container.querySelector(".writing-compact-toolbar-center .annotation-toolbar"), null);
  await click(buttonByText(container, "手写"));
  const toolbar = container.querySelector(".writing-compact-toolbar-center .annotation-toolbar");
  assert.ok(toolbar, container.innerHTML);
  assert.equal(container.querySelector(".writing-split-scroll .annotation-toolbar"), null);
  for (const expected of ["笔", "橡皮", "粗细", "撤销", "清空笔迹"]) assert.match(toolbar.textContent, new RegExp(expected));
  assert.doesNotMatch(toolbar.textContent, /陌生词/);
  assert.equal(toolbar.querySelectorAll(".color-picker button").length, 3);
  const identity = container.querySelector("[data-testid=portal-ink]").dataset;
  assert.equal(identity.surfaceId, "w2:translation:translation-fixed");
  assert.equal(identity.ownerId, "translation-fixed");
  assert.equal(inkMounts, 1);
  await click(buttonByText(container, "键盘输入"));
  assert.equal(container.querySelector(".writing-compact-toolbar-center .annotation-toolbar"), null);
  assert.equal(container.querySelector(".writing-compact-toolbar-center").textContent, "");
});

test("W2 Back barrier persists typed and handwriting drafts, then remount restores the same identity", async () => {
  const bridge = createWritingInkFlushBridge();
  let exitBarrier = null;
  let stored = null;
  let lastSave = null;
  const registerExitBarrier = (barrier) => {
    exitBarrier = barrier;
    return () => { if (exitBarrier === barrier) exitBarrier = null; };
  };
  const services = {
    commands: {
      saveTranslationDraft: async (args) => {
        lastSave = args;
        const inkRef = args.flushInk ? await bridge.flush({
          sessionId: args.sessionId,
          stageId: WritingStage.W2_EN_ZH,
          ownerRecordId: args.revisionId,
          surfaceId: `w2:translation:${args.revisionId}`,
        }) : args.translationRevision.units[0].inkRef;
        stored = {
          ...args.translationRevision,
          units: args.translationRevision.units.map((unit) => ({ ...unit, inkRef })),
          revision: (stored?.revision || 0) + 1,
        };
        return { translationRevision: stored };
      },
    },
  };
  const baseVm = stageVm(WritingStage.W2_EN_ZH, {
    sampleSegments: [{ unitId: "u1", text: "First sentence." }],
    currentTranslationRevision: null,
    translationInkRef: null,
  });
  let container = await render(React.createElement(W2TranslationStage, {
    vm: baseVm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory,
    busyAction: "", onAction: immediateAction, registerExitBarrier, inkFlushBridge: bridge,
    InkComposer: FlushableInkProbe,
  }));
  await setText(container.querySelector("textarea"), "返回资料库后仍存在");
  await act(async () => { await exitBarrier(); });
  assert.equal(lastSave.flushInk, false);
  assert.equal(stored.units[0].typedText, "返回资料库后仍存在");
  assert.equal(stored.revisionId, "translation-fixed");

  container = await render(React.createElement(W2TranslationStage, {
    vm: { ...baseVm, currentTranslationRevision: stored }, commandContext: commandContext(), services,
    username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction,
    registerExitBarrier, inkFlushBridge: bridge, InkComposer: FlushableInkProbe,
  }));
  assert.equal(container.querySelector("textarea").value, "返回资料库后仍存在");
  await click(buttonByText(container, "手写"));
  await act(async () => { await exitBarrier(); });
  assert.equal(lastSave.flushInk, true);
  assert.equal(stored.revisionId, "translation-fixed");
  assert.equal(stored.units[0].inkRef.surfaceId, "w2:translation:translation-fixed");
  assert.equal(stored.units[0].inkRef.ownerRecordId, "translation-fixed");
  assert.equal(container.querySelector("[data-testid=flushable-ink-probe]").dataset.surfaceId, stored.units[0].inkRef.surfaceId);
});

test("dual-pane presentation toggles do not remount input or invoke formal commands", async () => {
  let formalCalls = 0;
  const vm = stageVm(WritingStage.W2_EN_ZH, {
    sampleSegments: [{ unitId: "u1", text: "Reference" }],
    currentTranslationRevision: null,
    translationInkRef: null,
  });
  function PresentationHarness() {
    const [layout, setLayout] = ReactModule.useState("split");
    const [immersive, setImmersive] = ReactModule.useState(false);
    return React.createElement(W2TranslationStage, {
      vm, commandContext: commandContext(), username: USERNAME, createId: idFactory,
      services: { commands: { commitTranslationAndEnterW3: async () => { formalCalls += 1; } } },
      busyAction: "", onAction: immediateAction, layout, immersive,
      onToggleLayout: () => setLayout((value) => value === "split" ? "stacked" : "split"),
      onToggleImmersive: () => setImmersive(true), onExitImmersive: () => setImmersive(false),
      onBack: () => {}, InkComposer: InkProbe,
    });
  }
  const container = await render(React.createElement(PresentationHarness));
  await setText(container.querySelector("textarea"), "stable draft");
  await click(buttonByText(container, "上下布局"));
  assert.equal(container.querySelector(".writing-split-workspace").dataset.writingLayout, "stacked");
  assert.equal(container.querySelector("textarea").value, "stable draft");
  await click(buttonByText(container, "左右布局"));
  assert.equal(container.querySelector(".writing-split-workspace").dataset.writingLayout, "split");
  await click(buttonByText(container, "沉浸学习"));
  assert.ok(container.querySelector(".writing-stage.is-immersive"));
  assert.equal(container.querySelector("textarea").value, "stable draft");
  await click(buttonByText(container, "返回"));
  assert.equal(container.querySelector(".writing-stage.is-immersive"), null);
  assert.equal(container.querySelector("textarea").value, "stable draft");
  assert.equal(formalCalls, 0);
});

test("W3 DOM contains only frozen translation and own editor, with no sample or diagnosis leakage", async () => {
  const vm = stageVm(WritingStage.W3_BACK_TRANSLATION, {
    translationSnapshot: { snapshotId: "snapshot", units: [{ unitId: "u1", typedText: "只允许的中文译文" }] },
    currentBackTranslationAttempt: null,
    transcriptionDraft: null,
    transcriptionVerificationState: "drafting",
  });
  const container = await render(React.createElement(W3BackTranslationStage, { vm, commandContext: commandContext(), services: { commands: {} }, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.match(container.textContent, /只允许的中文译文/);
  assert.equal(container.querySelectorAll("textarea").length, 1, "W3 has one whole-document editor");
  assert.doesNotMatch(container.querySelector(".writing-stage-content").textContent, /SAMPLE_SECRET|DIAGNOSIS_SECRET|SKELETON_SECRET/);
  assert.match(container.textContent, /我在 W2 保存的完整中文译文/);
  assert.equal(container.querySelector(".writing-stage-content > .writing-notice"), null, "W3 does not reserve an auxiliary notice card above the workspace");
});

test("W3 projects the frozen W2 handwriting surface read-only and keeps W3 input independent", async () => {
  const w2InkRef = {
    id: "ink:translation-fixed",
    surfaceId: "w2:translation:translation-fixed",
    stageId: WritingStage.W2_EN_ZH,
    ownerRecordId: "translation-fixed",
    sourceFingerprint: "writing-ui-draft:translation-fixed",
    fingerprint: "frozen-w2-ink",
    revision: 2,
    updatedAt: NOW,
  };
  const vm = stageVm(WritingStage.W3_BACK_TRANSLATION, {
    translationSnapshot: {
      snapshotId: "snapshot",
      units: [{ unitId: "u1", inputMethod: WritingInputMethod.HANDWRITING, typedText: "", inkRef: w2InkRef }],
    },
    currentBackTranslationAttempt: null,
    transcriptionDraft: null,
    transcriptionVerificationState: "drafting",
  });
  const container = await render(React.createElement(W3BackTranslationStage, {
    vm, commandContext: commandContext(), services: { commands: {} }, username: USERNAME,
    createId: idFactory, busyAction: "", onAction: immediateAction, InkComposer: InkProbe, ReadonlyInkSurface: ReadonlyInkProbe,
  }));
  const source = container.querySelector("[aria-label='我在 W2 保存的完整中文译文']");
  const readonly = source.querySelector("[aria-readonly='true']");
  assert.ok(readonly, "the frozen W2 inkRef is mounted through the shared read-only surface");
  assert.equal(readonly.querySelector(".annotation-toolbar"), null);
  assert.equal(readonly.querySelector("canvas.writing-ink-preview") !== null, true);
  await click(buttonByText(container, "手写"));
  const w3Input = container.querySelector("[data-testid=ink-probe]");
  assert.equal(w3Input.dataset.surfaceId, "w3:back:w3-attempt-fixed");
  assert.notEqual(w3Input.dataset.surfaceId, w2InkRef.surfaceId);
});

test("W3 typed input requires the explicit formal confirmation before command submission", async () => {
  let received = null;
  const vm = stageVm(WritingStage.W3_BACK_TRANSLATION, {
    translationSnapshot: { snapshotId: "snapshot", units: [{ unitId: "u1", typedText: "中文译文" }] },
    currentBackTranslationAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting",
  });
  const services = { commands: { submitBackTranslationAndEnterW4: async (args) => { received = args; } } };
  const container = await render(React.createElement(W3BackTranslationStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction, InkComposer: InkProbe }));
  await setText(container.querySelector("textarea"), "My formal back translation.");
  await click(buttonByText(container, "准备提交完整反译"));
  assert.equal(received, null);
  await click(buttonByText(container, "确认提交"));
  assert.equal(received.attempt.inputMethod, WritingInputMethod.TYPED);
  assert.equal(received.attempt.typedText, "My formal back translation.");
});

test("W3 handwriting Vision remains verifying until edited text is explicitly confirmed", async () => {
  let finalSubmission = null;
  let attachCalls = 0;
  const vm = stageVm(WritingStage.W3_BACK_TRANSLATION, {
    translationSnapshot: { snapshotId: "snapshot", units: [{ unitId: "u1", typedText: "中文译文" }] },
    currentBackTranslationAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting",
  });
  const services = {
    vision: { transcribeWritingAttempt: async () => ({ transcriptionId: "transcription-fixed", rawTranscript: "AI raw back text" }) },
    commands: {
      prepareBackTranslationHandwritingForVerification: async () => ({ attempt: { revision: 1 } }),
      attachTranscriptionForVerification: async () => { attachCalls += 1; return { attempt: { revision: 2 } }; },
      submitBackTranslationHandwritingAndEnterW4: async (args) => { finalSubmission = args; },
    },
  };
  const container = await render(React.createElement(W3BackTranslationStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction, InkComposer: InkProbe }));
  await click(buttonByText(container, "手写"));
  assert.equal(container.querySelector("[data-testid=ink-probe]").dataset.surfaceId, "w3:back:w3-attempt-fixed");
  await click(buttonByText(container, "识别手写内容"));
  assert.equal(attachCalls, 1);
  assert.equal(finalSubmission, null, "Vision success must not submit or advance");
  assert.match(container.textContent, /AI 识别结果/);
  await setText(container.querySelector(".writing-verification textarea"), "User corrected back text.");
  await click(buttonByText(container, "确认文字并提交"));
  assert.equal(finalSubmission.text, "User corrected back text.");
  assert.equal(finalSubmission.source, "transcription");
  assert.equal(finalSubmission.transcriptionId, "transcription-fixed");
  assert.equal(finalSubmission.attemptExpectedRevision, 2);
});

test("W4 performs no AI work on render and starts diagnosis only after an explicit click", async () => {
  let calls = 0;
  const vm = stageVm(WritingStage.W4_COMPARE_DIAGNOSE, {
    translationSnapshot: { snapshotId: "snapshot", units: [] },
    submittedBackTranslation: { attemptId: "back", verifiedText: { text: "My back translation." } },
    sampleSegments: [{ unitId: "u1", text: "Sample sentence." }],
    compareDiagnosis: null,
    compareDiagnosisArtifactId: null,
  });
  const services = { textAi: { diagnoseWritingComparison: async () => { calls += 1; } }, commands: {} };
  const container = await render(React.createElement(W4CompareStage, { vm, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.equal(calls, 0);
  assert.match(container.textContent, /尚未请求 AI 分析/);
  assert.equal(container.querySelector("[aria-label='对照视图'] button[aria-pressed='true']").textContent, "整篇");
  assert.equal(container.querySelectorAll(".writing-compare-document-grid > section").length, 3);
  await click(buttonByText(container, "开始分析"));
  assert.equal(calls, 1);
});

test("W4 renders structured diagnosis, persists a LearningItem only on click, and completion stays independent", async () => {
  let learningCalls = 0;
  let completionCalls = 0;
  const vm = stageVm(WritingStage.W4_COMPARE_DIAGNOSE, {
    translationSnapshot: { snapshotId: "snapshot", units: [] },
    submittedBackTranslation: { attemptId: "back", verifiedText: { text: "My user excerpt." } },
    sampleSegments: [{ unitId: "u1", text: "Natural sample wording." }],
    compareDiagnosisArtifactId: "artifact-1",
    compareDiagnosis: { units: [{
      unitId: "u1",
      meaning: { status: "adequate", evidence: "Core meaning retained." },
      grammar: [{ excerpt: "user grammar", explanation: "Grammar reason", suggestion: "Grammar fix" }],
      collocation: [], naturalness: [], register: [],
      learnablePatterns: [{ sampleExcerpt: "Natural sample", userExcerpt: "My user excerpt", reason: "More idiomatic" }],
    }] },
  });
  const services = {
    textAi: { diagnoseWritingComparison: async () => {} },
    integration: { confirmWritingLearningItem: async () => { learningCalls += 1; } },
    commands: { completeCompareAndEnterW5: async () => { completionCalls += 1; } },
  };
  const container = await render(React.createElement(W4CompareStage, { vm, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.match(container.textContent, /Grammar reason|Natural sample|More idiomatic/);
  assert.equal(learningCalls, 0);
  await click(buttonByText(container, "加入学习项"));
  assert.equal(learningCalls, 1);
  await click(buttonByText(container, "完成对照"));
  assert.equal(completionCalls, 1);
});

test("W5 exposes all four explicit branches and submits the confirmed exact branch", async () => {
  let received = null;
  const vm = stageVm(WritingStage.W5_SKELETON, { promptSnapshot: promptSnapshot(), currentSkeletonRevision: null });
  const services = { commands: { finishOrSkipSkeleton: async (args) => { received = args; } } };
  const container = await render(React.createElement(W5SkeletonStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction }));
  for (const label of ["完成 → 重构练习", "完成 → 独立作文", "跳过 → 重构练习", "跳过 → 独立作文"]) assert.ok(buttonByText(container, label));
  await click(buttonByText(container, "跳过 → 独立作文"));
  await click(buttonByText(container, "确认并继续"));
  assert.equal(received.outcome, "skipped");
  assert.equal(received.nextStage, WritingStage.W7_INDEPENDENT);
  assert.equal(received.skeletonRevisionId, null);
  assert.equal(received.w6AttemptId, null);
});

test("W6 keeps the information fence, exposes no Vision action, and sends its draft on skip", async () => {
  let received = null;
  const vm = stageVm(WritingStage.W6_RECONSTRUCTION, {
    skeletonRevisionId: "skeleton-frozen-id",
    skeletonRevision: { revisionId: "skeleton-frozen-id", blocks: [{ order: 0, kind: "idea", text: "MY_FROZEN_IDEA" }] },
    currentReconstructionAttempt: { attemptId: "w6-existing", inputMethod: WritingInputMethod.TYPED, typedText: "draft before skip", createdAt: 10, revision: 2, inkRef: null },
  });
  const services = {
    vision: { transcribeWritingAttempt: async () => { throw new Error("Vision must not be called in W6"); } },
    commands: { finishOrSkipReconstruction: async (args) => { received = args; } },
  };
  const container = await render(React.createElement(W6ReconstructionStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.doesNotMatch(container.querySelector(".writing-stage-content").textContent, /识别手写|AI 转写|SAMPLE_SECRET/);
  assert.match(container.textContent, /MY_FROZEN_IDEA/);
  await click(buttonByText(container, "跳过重构"));
  await click(buttonByText(container, "保留草稿并跳过"));
  assert.equal(received.outcome, "skipped");
  assert.equal(received.attempt.attemptId, "w6-existing");
  assert.equal(received.attempt.typedText, "draft before skip");
});

test("W7 prompt-only contract renders no earlier-stage material and requires explicit typed confirmation", async () => {
  let submissions = 0;
  const vm = stageVm(WritingStage.W7_INDEPENDENT, {
    promptSnapshot: promptSnapshot(), currentIndependentAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting",
  });
  const services = { commands: { submitIndependentTyped: async () => { submissions += 1; } } };
  const container = await render(React.createElement(W7IndependentStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.match(container.textContent, /原始作文题与约束/);
  assert.equal(container.querySelector(".writing-stage-content > .writing-notice"), null, "W7 keeps the prompt fence without an extra chrome card");
  assert.doesNotMatch(container.textContent, /SAMPLE_SECRET|中文译文|回译内容|诊断建议|骨架内容|重构草稿/);
  await setText(container.querySelector("textarea"), "My independent formal response.");
  await click(buttonByText(container, "准备提交独立作文"));
  assert.equal(submissions, 0);
  await click(buttonByText(container, "确认正式提交"));
  assert.equal(submissions, 1);
});

test("W7 handwriting offers manual fallback after Vision failure and preserves exact independent ink identity", async () => {
  let manualSubmission = null;
  const errors = [];
  const vm = stageVm(WritingStage.W7_INDEPENDENT, { promptSnapshot: promptSnapshot(), currentIndependentAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting" });
  const services = {
    vision: { transcribeWritingAttempt: async () => { const error = new Error("secret provider details"); error.code = "vision_not_configured"; throw error; } },
    commands: {
      prepareIndependentHandwritingForVerification: async () => ({ attempt: { revision: 1 } }),
      submitIndependentHandwriting: async (args) => { manualSubmission = args; },
    },
  };
  const catchingAction = async (name, work) => { try { return await work(); } catch (error) { errors.push(error.code); return null; } };
  const container = await render(React.createElement(W7IndependentStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: catchingAction, InkComposer: InkProbe }));
  await click(buttonByText(container, "手写"));
  assert.equal(container.querySelector("[data-testid=ink-probe]").dataset.surfaceId, "w7:independent:w7-attempt-fixed");
  await click(buttonByText(container, "识别手写作文"));
  assert.deepEqual(errors, ["vision_not_configured"]);
  assert.ok(buttonByText(container, "手动录入"), "fallback remains available after Vision failure");
  await click(buttonByText(container, "手动录入"));
  await setText(container.querySelector(".writing-verification textarea"), "Manually entered final essay.");
  await click(buttonByText(container, "确认文字并提交"));
  assert.equal(manualSubmission.source, "manual_entry");
  assert.equal(manualSubmission.text, "Manually entered final essay.");
  assert.equal(manualSubmission.transcriptionId, null);
});

test("W7 Vision success creates an editable draft but never submits before user confirmation", async () => {
  let finalSubmission = null;
  const vm = stageVm(WritingStage.W7_INDEPENDENT, { promptSnapshot: promptSnapshot(), currentIndependentAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting" });
  const services = {
    vision: { transcribeWritingAttempt: async () => ({ transcriptionId: "w7-transcription-fixed", rawTranscript: "AI raw independent essay" }) },
    commands: {
      prepareIndependentHandwritingForVerification: async () => ({ attempt: { revision: 3 } }),
      attachTranscriptionForVerification: async () => ({ attempt: { revision: 4 } }),
      submitIndependentHandwriting: async (args) => { finalSubmission = args; },
    },
  };
  const container = await render(React.createElement(W7IndependentStage, { vm, commandContext: commandContext(), services, username: USERNAME, createId: idFactory, busyAction: "", onAction: immediateAction, InkComposer: InkProbe }));
  await click(buttonByText(container, "手写"));
  await click(buttonByText(container, "识别手写作文"));
  assert.equal(finalSubmission, null);
  assert.match(container.textContent, /AI 转写草稿/);
  await setText(container.querySelector(".writing-verification textarea"), "User verified independent essay.");
  await click(buttonByText(container, "确认文字并提交"));
  assert.equal(finalSubmission.source, "transcription");
  assert.equal(finalSubmission.text, "User verified independent essay.");
  assert.equal(finalSubmission.transcriptionId, "w7-transcription-fixed");
  assert.equal(finalSubmission.attemptExpectedRevision, 4);
});

test("W2 rapid double commit invokes the formal command only once", async () => {
  const gate = deferred();
  let calls = 0;
  const vm = stageVm(WritingStage.W2_EN_ZH, { sampleSegments: [{ unitId: "u1", text: "Translate this." }], currentTranslationRevision: null, translationInkRef: null });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W2_EN_ZH, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    commands: { commitTranslationAndEnterW3: async () => { calls += 1; return gate.promise; } },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await setText(container.querySelector("textarea"), "翻译内容");
  const submit = buttonByText(container, "提交完整中文译文");
  await act(async () => { submit.click(); submit.click(); await wait(); });
  assert.equal(calls, 1);
  gate.resolve({});
  await act(async () => { await gate.promise; await wait(); });
  assert.equal(container.querySelector("textarea").value, "翻译内容", "same-stage refresh keeps the controlled draft");
});

test("W2 command failure preserves the typed draft and keeps the safe stage", async () => {
  const vm = stageVm(WritingStage.W2_EN_ZH, { sampleSegments: [{ unitId: "u1", text: "Translate this." }], currentTranslationRevision: null, translationInkRef: null });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W2_EN_ZH, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    commands: { commitTranslationAndEnterW3: async () => { throw Object.assign(new Error("raw conflict"), { code: "ink-flush-failed" }); } },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await setText(container.querySelector("textarea"), "应当保留的译文");
  await click(buttonByText(container, "提交完整中文译文"));
  assert.equal(container.querySelector("textarea").value, "应当保留的译文");
  assert.match(container.textContent, /笔迹尚未可靠保存/);
  assert.match(container.textContent, /完整英文范文/);
});

test("W7 rapid double confirmation invokes the formal submit command only once", async () => {
  const gate = deferred();
  let calls = 0;
  const vm = stageVm(WritingStage.W7_INDEPENDENT, { promptSnapshot: promptSnapshot(), currentIndependentAttempt: null, transcriptionDraft: null, transcriptionVerificationState: "drafting" });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W7_INDEPENDENT, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    commands: { submitIndependentTyped: async () => { calls += 1; return gate.promise; } },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await setText(container.querySelector("textarea"), "My independent response.");
  await click(buttonByText(container, "准备提交独立作文"));
  const submit = buttonByText(container, "确认正式提交");
  await act(async () => { submit.click(); submit.click(); await wait(); });
  assert.equal(calls, 1);
  gate.resolve({});
  await act(async () => { await gate.promise; await wait(); });
});

test("W8 rapid double score request creates only one paid service call", async () => {
  const gate = deferred();
  let calls = 0;
  const vm = stageVm(WritingStage.W8_SCORE_REWRITE, {
    promptSnapshot: promptSnapshot(), submittedIndependentAttempt: { attemptId: "independent", verifiedText: { text: "Original essay.", source: "typed" } },
    scoreReports: [], revisionAttempts: [], referenceRewriteArtifacts: [], scoreViewed: false,
  });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W8_SCORE_REWRITE, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    textAi: { scoreWritingAttempt: async () => { calls += 1; return gate.promise; }, generateReferenceRewrite: async () => {} },
    commands: {},
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  const score = buttonByText(container, "获取 AI 评分");
  await act(async () => { score.click(); score.click(); await wait(); });
  assert.equal(calls, 1);
  gate.resolve({});
  await act(async () => { await gate.promise; await wait(); });
});

test("W4 AI failure is actionable but never disables the non-AI completion path", async () => {
  let completionCalls = 0;
  const vm = stageVm(WritingStage.W4_COMPARE_DIAGNOSE, {
    translationSnapshot: { snapshotId: "snapshot", units: [] }, submittedBackTranslation: { attemptId: "back", verifiedText: { text: "User text." } },
    sampleSegments: [{ unitId: "u1", text: "Sample text." }], compareDiagnosis: null, compareDiagnosisArtifactId: null,
  });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W4_COMPARE_DIAGNOSE, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    textAi: { diagnoseWritingComparison: async () => { throw Object.assign(new Error("raw provider response"), { code: "network_error" }); } },
    commands: { completeCompareAndEnterW5: async () => { completionCalls += 1; } },
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await click(buttonByText(container, "开始分析"));
  assert.match(container.textContent, /网络暂时不可用/);
  assert.doesNotMatch(container.textContent, /raw provider response/);
  assert.equal(buttonByText(container, "完成对照").disabled, false);
  await click(buttonByText(container, "完成对照"));
  assert.equal(completionCalls, 1);
});

test("W8 technical score failure displays no fake zero and preserves the original essay", async () => {
  const vm = stageVm(WritingStage.W8_SCORE_REWRITE, {
    promptSnapshot: promptSnapshot(), submittedIndependentAttempt: { attemptId: "independent", verifiedText: { text: "ORIGINAL_ESSAY_REMAINS", source: "typed" } },
    scoreReports: [], revisionAttempts: [], referenceRewriteArtifacts: [], scoreViewed: false,
  });
  const services = {
    readModels: { loadWritingWorkspace: async () => ({ sessionId: "session-ui", safeStage: WritingStage.W8_SCORE_REWRITE, status: "active", sessionRevision: 1, sessionFingerprint: "fp", stageViewModel: vm }) },
    textAi: { scoreWritingAttempt: async () => { throw Object.assign(new Error("invalid raw JSON"), { code: "invalid_response" }); }, generateReferenceRewrite: async () => {} }, commands: {},
  };
  const container = await render(React.createElement(WritingWorkspace, { sessionId: "session-ui", username: USERNAME, services, createId: idFactory }));
  await click(buttonByText(container, "获取 AI 评分"));
  assert.match(container.textContent, /ORIGINAL_ESSAY_REMAINS/);
  assert.match(container.textContent, /AI 返回内容无法验证/);
  assert.doesNotMatch(container.textContent, /0\s*\/\s*10/);
  assert.equal(container.querySelector(".writing-score-report"), null);
});

function sixDimensionScore() {
  const dimension = { rating: "strong", comment: "Clear evidence.", evidence: ["short excerpt"] };
  return {
    scoreReportId: "score-1", finalScore: 8, maxScore: 10, band: "A", wordCount: 102, lengthIssue: "ok",
    dimensions: { taskFulfillment: dimension, contentCoverage: dimension, organizationCoherence: dimension, languageAccuracy: dimension, languageRange: dimension, formatRegister: dimension },
    strengths: ["Clear purpose"], revisionAdvice: ["Vary sentence openings"], issues: [], createdAt: 20,
  };
}

test("W8 scoring is user-triggered, shows six dimensions, and keeps reference rewrite locked before own revision", async () => {
  let scoreCalls = 0;
  const score = sixDimensionScore();
  const baseVm = stageVm(WritingStage.W8_SCORE_REWRITE, {
    promptSnapshot: promptSnapshot(),
    submittedIndependentAttempt: { attemptId: "independent", verifiedText: { text: "Original independent essay.", source: "typed" } },
    scoreReports: [], revisionAttempts: [], referenceRewriteArtifacts: [], scoreViewed: false,
  });
  const services = { textAi: { scoreWritingAttempt: async () => { scoreCalls += 1; }, generateReferenceRewrite: async () => {} }, commands: {} };
  let container = await render(React.createElement(W8ScoreRewriteStage, { vm: baseVm, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  assert.equal(scoreCalls, 0);
  assert.equal(buttonByText(container, "先提交二稿").disabled, true);
  await click(buttonByText(container, "获取 AI 评分"));
  assert.equal(scoreCalls, 1);
  const scoredVm = { ...baseVm, scoreReports: [score] };
  container = await render(React.createElement(W8ScoreRewriteStage, { vm: scoredVm, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  for (const label of ["任务完成度", "内容覆盖", "组织与连贯", "语言准确性", "语言丰富度", "格式与语域"]) assert.match(container.textContent, new RegExp(label));
});

test("W8 revision is a separate Attempt and an existing submitted revision unlocks a non-overwriting rewrite", async () => {
  let revisionArgs = null;
  let rewriteArgs = null;
  const score = sixDimensionScore();
  const base = stageVm(WritingStage.W8_SCORE_REWRITE, {
    promptSnapshot: promptSnapshot(), submittedIndependentAttempt: { attemptId: "independent", verifiedText: { text: "Original independent essay.", source: "typed" } },
    scoreReports: [score], revisionAttempts: [], referenceRewriteArtifacts: [], scoreViewed: false,
  });
  const services = {
    commands: { submitRevisionAttempt: async (args) => { revisionArgs = args; }, completeAfterScoreView: async () => {} },
    textAi: { scoreWritingAttempt: async () => {}, generateReferenceRewrite: async (args) => { rewriteArgs = args; } },
  };
  let container = await render(React.createElement(W8ScoreRewriteStage, { vm: base, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  await setText(container.querySelector(".writing-revision-section textarea"), "My own second draft.");
  await click(buttonByText(container, "提交我的二稿"));
  assert.equal(revisionArgs.attemptId, "revision-fixed");
  assert.equal(revisionArgs.parentAttemptId, "independent");
  assert.equal(revisionArgs.typedText, "My own second draft.");

  const submittedRevision = { attemptId: "revision-fixed", parentAttemptId: "independent", typedText: "My own second draft.", status: "submitted", createdAt: 30, revision: 1 };
  container = await render(React.createElement(W8ScoreRewriteStage, { vm: { ...base, revisionAttempts: [submittedRevision] }, commandContext: commandContext(), services, createId: idFactory, busyAction: "", onAction: immediateAction }));
  const revisionArea = container.querySelector(".writing-revision-section textarea");
  assert.equal(revisionArea.readOnly, true);
  await click(buttonByText(container, "生成参考改写"));
  assert.equal(rewriteArgs.revisionAttemptId, "revision-fixed");
  assert.equal(revisionArea.value, "My own second draft.", "AI request must not overwrite the user's textarea");
});

test("DONE is read-only and distinguishes completion score from latest score", async () => {
  const vm = stageVm(WritingStage.DONE, {
    completedAt: Date.now(),
    completionScore: { finalScore: 7, maxScore: 10 },
    latestScore: { finalScore: 9, maxScore: 10 },
    reviewStatusSummary: { pending: 2, in_progress: 1, completed: 3 },
  });
  const container = await render(React.createElement(WritingDoneStage, { vm }));
  assert.match(container.textContent, /首次完成评分7\/ 10/);
  assert.match(container.textContent, /最新评分9\/ 10/);
  assert.match(container.textContent, /复习任务3 待处理/);
  assert.equal(container.querySelectorAll("textarea, input, select").length, 0);
});

test("Writing Library separates recoverable active work, completed history, and damaged records", async () => {
  const model = {
    activeItems: [{ sessionId: "active", status: "active", safeStage: WritingStage.W5_SKELETON, taskType: "notice", year: 2026, promptText: "Active prompt", lastActiveAt: Date.now(), latestScore: null }],
    completedItems: [{ sessionId: "done", status: "completed", safeStage: WritingStage.DONE, taskType: "letter", year: 2025, promptText: "Completed prompt", completedAt: Date.now(), latestScore: { finalScore: 8, maxScore: 10 } }],
    damagedItems: [{ sessionId: "broken", errorCode: "damaged" }], diagnostics: [],
  };
  const opened = [];
  const container = await render(React.createElement(WritingLibrary, { username: USERNAME, services: { readModels: { buildWritingLibrary: async () => model } }, onOpenSession: (id) => opened.push(id) }));
  assert.match(container.textContent, /Active prompt/);
  assert.match(container.textContent, /Completed prompt/);
  assert.match(container.textContent, /1 条记录未展示/);
  await click(buttonByText(container, "Active prompt"));
  assert.deepEqual(opened, ["active"]);
});

test.after(async () => {
  if (mountedRoot) await act(async () => { mountedRoot.unmount(); await wait(); });
  await vite.close();
  dom.window.close();
});

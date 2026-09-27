import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type;
  }
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { setCurrentUsername, setUserItem, getUserItem } = await import("../src/userData.js");
const {
  MAX_SENTENCE_EVIDENCE,
  MAX_TEXT_EVIDENCE_RANGES,
  QUESTION_EVIDENCE_SCHEMA_VERSION,
  addTextRange,
  addSentenceRef,
  buildSentenceRef,
  buildTextRange,
  buildTextSegment,
  clearEvidence,
  cloneStore,
  compareAttempts,
  countEvidenceComplete,
  draftFromEntry,
  emptyEvidenceEntry,
  emptyEvidenceStore,
  emptyTextEvidenceEntry,
  entryComplete,
  entryFor,
  entryNeedsType,
  entryResolutionOk,
  entrySummaryLabel,
  evidenceStorageKey,
  loadEvidenceStore,
  normalizeEvidenceStore,
  questionEvidenceComplete,
  questionKeyFor,
  quizCompletion,
  removeSentenceRef,
  resolveEntry,
  resolveSentenceRef,
  resolveTextSegment,
  saveEvidenceStore,
  setEvidence,
  setEvidenceMode,
  setEvidenceNote,
  setGlobalType,
  setTextType,
  textRangeExcerpt,
} = await import("../src/questionEvidence.js");
const {
  evidenceRangeFromSelection,
  showEvidenceHighlight,
} = await import("../src/questionEvidenceHighlight.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const RESOURCE = { id: "r1" };
const PASSAGE = { id: "passage-1" };

function question(number, stem = `Question ${number} stem`, index = number - 21) {
  return { number: String(number), stem, id: `q-${index}-${number}`, options: [] };
}

function storeFor(questions = [question(21)], resourceId = "r1", passageId = "passage-1") {
  return emptyEvidenceStore(resourceId, passageId);
}

function keyFor(store, questionItem, index = 0) {
  return questionKeyFor({
    resourceId: store.resourceId,
    passageId: store.passageId,
    questionNumber: questionItem.number,
    questionStem: questionItem.stem,
    questionIndex: index,
  });
}

function refsFor(passage, pairs) {
  return pairs.map(([paragraphNumber, sentenceIndex]) => {
    const text = passage.paragraphs[paragraphNumber - 1].sentences[sentenceIndex];
    return buildSentenceRef({ paragraphNumber, sentenceIndex, sentenceText: text });
  });
}

function samplePassage() {
  return {
    id: "passage-1",
    paragraphs: [
      { number: 1, text: "Alpha first. Alpha second.", sentences: ["Alpha first.", "Alpha second."] },
      { number: 2, text: "Beta only.", sentences: ["Beta only."] },
      { number: 3, text: "Gamma extra.", sentences: ["Gamma extra."] },
    ],
  };
}

function sentence(passage, paragraphNumber, sentenceIndex) {
  return passage.paragraphs[paragraphNumber - 1].sentences[sentenceIndex];
}

test("1. first / redo 证据完全隔离", () => {
  fresh();
  const store = storeFor();
  const q = question(21);
  const key = keyFor(store, q);
  const firstRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  const redoRef = buildSentenceRef({ paragraphNumber: 2, sentenceIndex: 0, sentenceText: "Beta only." });

  const withFirst = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [firstRef],
  });
  assert.equal(entryFor(withFirst, key, "first").references.length, 1);
  assert.equal(entryFor(withFirst, key, "redo"), null);

  const withBoth = setEvidence(withFirst, key, "redo", {
    ...emptyEvidenceEntry(),
    references: [redoRef],
  });
  assert.equal(entryFor(withBoth, key, "first").references[0].sentenceKey, firstRef.sentenceKey);
  assert.equal(entryFor(withBoth, key, "redo").references[0].sentenceKey, redoRef.sentenceKey);
});

test("2. sentence evidence 可以保存 1～3 条", () => {
  fresh();
  let draft = emptyEvidenceEntry();
  const passage = samplePassage();
  for (const [paragraphNumber, sentenceIndex] of [[1, 0], [1, 1], [2, 0]]) {
    const result = addSentenceRef(
      draft,
      buildSentenceRef({
        paragraphNumber,
        sentenceIndex,
        sentenceText: sentence(passage, paragraphNumber, sentenceIndex),
      }),
    );
    assert.equal(result.rejected, false);
    draft = result.draft;
  }
  assert.equal(draft.references.length, 3);
  assert.equal(entryComplete(draft), true);
});

test("3. 超过 3 条不会被接受", () => {
  fresh();
  let draft = emptyEvidenceEntry();
  const passage = samplePassage();
  const candidates = [
    [1, 0], [1, 1], [2, 0],
  ];
  for (const [paragraphNumber, sentenceIndex] of candidates) {
    const result = addSentenceRef(
      draft,
      buildSentenceRef({
        paragraphNumber,
        sentenceIndex,
        sentenceText: sentence(passage, paragraphNumber, sentenceIndex),
      }),
    );
    draft = result.draft;
  }
  assert.equal(draft.references.length, MAX_SENTENCE_EVIDENCE);
  const fourth = addSentenceRef(
    draft,
    buildSentenceRef({ paragraphNumber: 3, sentenceIndex: 0, sentenceText: "Gamma extra." }),
  );
  assert.equal(fourth.rejected, true);
  assert.equal(fourth.reason, "limit");
  assert.equal(fourth.draft.references.length, 3);
});

test("4. sentence mode 与 global mode 互斥", () => {
  fresh();
  const passage = samplePassage();
  let draft = emptyEvidenceEntry();
  draft = addSentenceRef(
    draft,
    buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: sentence(passage, 1, 0) }),
  ).draft;
  assert.equal(draft.references.length, 1);

  const globalDraft = setGlobalType(draft, "main_idea");
  assert.equal(globalDraft.mode, "global");
  assert.equal(globalDraft.references.length, 0);
  assert.equal(globalDraft.globalType, "main_idea");

  const sentenceDraft = setEvidenceMode(globalDraft, "sentences");
  assert.equal(sentenceDraft.mode, "sentences");
  assert.equal(sentenceDraft.globalType, null);
  assert.equal(sentenceDraft.references.length, 0);

  const rejected = addSentenceRef(
    globalDraft,
    buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: sentence(passage, 1, 0) }),
  );
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.reason, "mode");
});

test("5. global evidence 无需 sentence reference", () => {
  fresh();
  const store = storeFor();
  const key = keyFor(store, question(21));
  const withGlobal = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    mode: "global",
    globalType: "structure",
  });
  assert.equal(entryFor(withGlobal, key, "first").references.length, 0);
  assert.equal(questionEvidenceComplete(withGlobal, key, "first"), true);
  assert.equal(entrySummaryLabel(entryFor(withGlobal, key, "first")), "篇章结构");
  assert.equal(entryResolutionOk(entryFor(withGlobal, key, "first"), null), true);
});

test("6. evidence 与答案存储互不覆盖", () => {
  fresh();
  const store = storeFor();
  const q = question(21);
  const key = keyFor(store, q);
  const withEvidence = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    mode: "global",
    globalType: "main_idea",
  });
  saveEvidenceStore(withEvidence);
  setUserItem(`wuliao:deep-answers:${RESOURCE.id}:${PASSAGE.id}:first`, JSON.stringify({ 21: "A" }));
  setUserItem(`wuliao:answers:${RESOURCE.id}`, JSON.stringify({ 21: "B" }));

  assert.equal(evidenceStorageKey("r1", "passage-1").includes("question-evidence"), true);
  assert.notEqual(
    evidenceStorageKey("r1", "passage-1"),
    `wuliao:deep-answers:${RESOURCE.id}:${PASSAGE.id}:first`,
  );
  assert.equal(getUserItem(`wuliao:deep-answers:${RESOURCE.id}:${PASSAGE.id}:first`), JSON.stringify({ 21: "A" }));
  const reloaded = loadEvidenceStore("r1", "passage-1");
  assert.equal(entryFor(reloaded, key, "first").globalType, "main_idea");
  assert.equal(JSON.parse(getUserItem(`wuliao:answers:${RESOURCE.id}`))["21"], "B");
});

test("7. questionKey 跨 passage 隔离", () => {
  fresh();
  const a = questionKeyFor({
    resourceId: "r1", passageId: "passage-1",
    questionNumber: "21", questionStem: "Same stem", questionIndex: 0,
  });
  const b = questionKeyFor({
    resourceId: "r1", passageId: "passage-2",
    questionNumber: "21", questionStem: "Same stem", questionIndex: 0,
  });
  assert.notEqual(a, b);

  const storeA = emptyEvidenceStore("r1", "passage-1");
  const storeB = emptyEvidenceStore("r1", "passage-2");
  const withA = setEvidence(storeA, a, "first", { ...emptyEvidenceEntry(), mode: "global", globalType: "attitude" });
  assert.equal(entryFor(withA, a, "first").globalType, "attitude");
  assert.equal(entryFor(withA, b, "first"), null);
  assert.equal(entryFor(storeB, a, "first"), null);
});

test("8. 句文本变化后旧 evidence 不错误绑定", () => {
  fresh();
  const original = samplePassage();
  const ref = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  const changed = {
    paragraphs: [
      { number: 1, text: "Rewritten sentence here. Alpha second.", sentences: ["Rewritten sentence here.", "Alpha second."] },
      { number: 2, text: "Beta only.", sentences: ["Beta only."] },
    ],
  };
  const resolution = resolveSentenceRef(ref, changed);
  assert.equal(resolution.status, "unresolved");
  assert.notEqual(resolution.ref?.sentenceKey, "Alpha first.");
});

test("9. sentenceKey 找不到但 normalized text 唯一匹配时可以恢复", () => {
  fresh();
  const original = samplePassage();
  const ref = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  // 段落/句位改变，但句子文本唯一保留
  const reordered = {
    paragraphs: [
      { number: 1, text: "Alpha second. Beta only.", sentences: ["Alpha second.", "Beta only."] },
      { number: 2, text: "Alpha first.", sentences: ["Alpha first."] },
    ],
  };
  const resolution = resolveSentenceRef(ref, reordered);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.ref.paragraphNumber, 2);
  assert.equal(resolution.ref.sentenceIndex, 0);
  assert.notEqual(resolution.ref.sentenceKey, ref.sentenceKey);
});

test("10. 无法恢复时标记 unresolved 而不是错误跳转", () => {
  fresh();
  const original = samplePassage();
  const ref = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  const empty = { paragraphs: [] };
  const missing = resolveSentenceRef(ref, empty);
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.ref, null);

  const duplicate = {
    paragraphs: [
      { number: 1, text: "Rewritten first. Alpha first.", sentences: ["Rewritten first.", "Alpha first."] },
      { number: 2, text: "Alpha first.", sentences: ["Alpha first."] },
    ],
  };
  const ambiguous = resolveSentenceRef(ref, duplicate);
  assert.equal(ambiguous.status, "unresolved");
  assert.equal(ambiguous.reason, "ambiguous-fingerprint");
});

test("11. 修改 evidence 使用 draft，取消不会覆盖正式记录", () => {
  fresh();
  const store = storeFor();
  const q = question(21);
  const key = keyFor(store, q);
  const firstRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  const committed = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [firstRef],
  });
  const before = cloneStore(committed);

  let draft = draftFromEntry(entryFor(committed, key, "first"));
  draft = removeSentenceRef(draft, firstRef.sentenceKey);
  draft = addSentenceRef(
    draft,
    buildSentenceRef({ paragraphNumber: 2, sentenceIndex: 0, sentenceText: "Beta only." }),
  ).draft;
  draft = setEvidenceMode(draft, "global");
  draft = setGlobalType(draft, "attitude");
  draft = setEvidenceNote(draft, "取消前不保存");

  // 未调用 setEvidence：正式记录保持不变
  assert.equal(entryFor(committed, key, "first").references.length, 1);
  assert.equal(entryFor(committed, key, "first").mode, "sentences");
  assert.deepEqual(cloneStore(committed), before);

  const overwritten = setEvidence(committed, key, "first", draft);
  assert.equal(entryFor(overwritten, key, "first").mode, "global");
  assert.equal(entryFor(overwritten, key, "first").globalType, "attitude");
});

test("12. first quiz：答案完成但 evidence 未完成 → 不能完成阶段", () => {
  fresh();
  const questions = [question(21), question(22, "Question 22 stem", 1)];
  const store = storeFor(questions);
  const key = keyFor(store, questions[0]);
  const withOne = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." })],
  });
  const state = quizCompletion({
    questions,
    answers: { 21: "A", 22: "B" },
    store: withOne,
    attempt: "first",
  });
  assert.equal(state.answerComplete, true);
  assert.equal(state.evidenceComplete, false);
  assert.equal(state.evidenceCompleted, 1);
  assert.equal(state.canComplete, false);
  assert.deepEqual(state.remainingWithoutEvidence, ["22"]);
});

test("13. first quiz：答案 + evidence 全部完成 → 可以完成", () => {
  fresh();
  const questions = [question(21), question(22, "Question 22 stem", 1)];
  let store = storeFor(questions);
  for (let index = 0; index < questions.length; index += 1) {
    store = setEvidence(store, keyFor(store, questions[index], index), "first", {
      ...emptyEvidenceEntry(),
      mode: "global",
      globalType: "main_idea",
    });
  }
  const state = quizCompletion({
    questions,
    answers: { 21: "A", 22: "B" },
    store,
    attempt: "first",
  });
  assert.equal(state.answerComplete, true);
  assert.equal(state.evidenceComplete, true);
  assert.equal(state.canComplete, true);
});

test("14. redo 同样逻辑", () => {
  fresh();
  const questions = [question(21)];
  let store = storeFor(questions);
  const key = keyFor(store, questions[0]);
  store = setEvidence(store, key, "redo", {
    ...emptyEvidenceEntry(),
    references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "Alpha second." })],
  });
  const done = quizCompletion({
    questions,
    answers: { 21: "C" },
    store,
    attempt: "redo",
  });
  assert.equal(done.canComplete, true);

  const without = quizCompletion({
    questions,
    answers: { 21: "C" },
    store: emptyEvidenceStore("r1", "passage-1"),
    attempt: "redo",
  });
  assert.equal(without.canComplete, false);
});

test("15. global evidence 可以满足 evidenceComplete", () => {
  fresh();
  const questions = [question(21)];
  let store = storeFor(questions);
  store = setEvidence(store, keyFor(store, questions[0]), "first", {
    ...emptyEvidenceEntry(),
    mode: "global",
    globalType: "other",
    note: "整篇判断",
  });
  const state = quizCompletion({ questions, answers: { 21: "D" }, store, attempt: "first" });
  assert.equal(state.evidenceComplete, true);
  assert.equal(state.canComplete, true);
  assert.equal(entrySummaryLabel(entryFor(store, keyFor(store, questions[0]), "first")), "其他整体判断");
});

test("16. 历史 deep-first-quiz completed：没有 evidence → 仍保持 completed", () => {
  fresh();
  const questions = [question(21)];
  const state = quizCompletion({
    questions,
    answers: { 21: "A" },
    store: emptyEvidenceStore("r1", "passage-1"),
    attempt: "first",
    stageCompleted: true,
  });
  assert.equal(state.evidenceComplete, false);
  assert.equal(state.canComplete, true);
});

test("17. 历史 deep-redo completed 同理", () => {
  fresh();
  const questions = [question(21)];
  const state = quizCompletion({
    questions,
    answers: { 21: "B" },
    store: emptyEvidenceStore("r1", "passage-1"),
    attempt: "redo",
    stageCompleted: true,
  });
  assert.equal(state.evidenceComplete, false);
  assert.equal(state.canComplete, true);
});

test("18. 无题文章不被 evidence 系统卡死", () => {
  fresh();
  const state = quizCompletion({
    questions: [],
    answers: {},
    store: emptyEvidenceStore("r1", "passage-1"),
    attempt: "first",
  });
  assert.equal(state.answerComplete, true);
  assert.equal(state.evidenceComplete, true);
  assert.equal(state.canComplete, true);
  assert.equal(countEvidenceComplete([], emptyEvidenceStore("r1", "passage-1"), "first").completed, 0);
});

test("19. 删除 evidence 后当前新流程重新变 incomplete", () => {
  fresh();
  const questions = [question(21)];
  let store = storeFor(questions);
  const key = keyFor(store, questions[0]);
  store = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." })],
  });
  assert.equal(questionEvidenceComplete(store, key, "first"), true);
  store = clearEvidence(store, key, "first");
  assert.equal(entryFor(store, key, "first"), null);
  assert.equal(questionEvidenceComplete(store, key, "first"), false);
  const state = quizCompletion({ questions, answers: { 21: "A" }, store, attempt: "first" });
  assert.equal(state.canComplete, false);
});

test("20. 已完成历史文章删除补录 evidence 时不会破坏原 completion", () => {
  fresh();
  const questions = [question(21)];
  let store = storeFor(questions);
  const key = keyFor(store, questions[0]);
  store = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." })],
  });
  store = clearEvidence(store, key, "first");
  const state = quizCompletion({
    questions,
    answers: { 21: "A" },
    store,
    attempt: "first",
    stageCompleted: true,
  });
  assert.equal(state.evidenceComplete, false);
  assert.equal(state.canComplete, true);
});

test("归一化：旧数据截断到 3 条且不保留非法引用", () => {
  fresh();
  const raw = {
    schemaVersion: 1,
    resourceId: "r1",
    passageId: "passage-1",
    questions: {
      key1: {
        first: {
          mode: "sentences",
          references: [
            { paragraphNumber: 1, sentenceIndex: 0, sentenceKey: "k1", fingerprint: "f1", excerpt: "Alpha first." },
            { paragraphNumber: 1, sentenceIndex: 1, sentenceKey: "k2", fingerprint: "f2", excerpt: "Alpha second." },
            { paragraphNumber: 2, sentenceIndex: 0, sentenceKey: "k3", fingerprint: "f3", excerpt: "Beta only." },
            { paragraphNumber: 9, sentenceIndex: 9, sentenceKey: "k4", fingerprint: "f4", excerpt: "Too many." },
          ],
        },
        redo: null,
      },
    },
  };
  const normalized = normalizeEvidenceStore(raw, "r1", "passage-1");
  assert.equal(normalized.questions.key1.first.references.length, 3);
  assert.equal(normalized.questions.key1.first.references[2].excerpt, "Beta only.");
});

test("resolveEntry 与 compareAttempts 标签", () => {
  fresh();
  const passage = samplePassage();
  const firstRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." });
  const redoRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "Alpha second." });
  const first = { ...emptyEvidenceEntry(), references: [firstRef] };
  const redo = { ...emptyEvidenceEntry(), references: [redoRef] };
  assert.equal(resolveEntry(first, passage).length, 1);
  assert.equal(resolveEntry(first, passage)[0].status, "resolved");

  const changed = compareAttempts({ firstEntry: first, redoEntry: redo, firstAnswer: "A", redoAnswer: "C" });
  assert.deepEqual(changed.tags, ["答案改变", "证据改变"]);

  const same = compareAttempts({ firstEntry: first, redoEntry: first, firstAnswer: "A", redoAnswer: "A" });
  assert.deepEqual(same.tags, ["答案未变", "证据未变"]);

  const globalVsSentence = compareAttempts({
    firstEntry: { ...emptyEvidenceEntry(), mode: "global", globalType: "attitude" },
    redoEntry: first,
    firstAnswer: "A",
    redoAnswer: "A",
  });
  assert.deepEqual(globalVsSentence.tags, ["答案未变", "证据改变"]);
});

test("存储往返：saveEvidenceStore / loadEvidenceStore", () => {
  fresh();
  let store = emptyEvidenceStore("r1", "passage-1");
  const key = questionKeyFor({
    resourceId: "r1", passageId: "passage-1",
    questionNumber: "21", questionStem: "Stem", questionIndex: 0,
  });
  store = setEvidence(store, key, "first", {
    ...emptyEvidenceEntry(),
    references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." })],
  });
  assert.equal(saveEvidenceStore(store), true);
  const reloaded = loadEvidenceStore("r1", "passage-1");
  assert.equal(entryFor(reloaded, key, "first").references[0].sentenceKey.includes("p1s1"), true);
});

function textRangeFor(passage, selections) {
  return buildTextRange({
    segments: selections.map(([paragraphNumber, sentenceIndex, startOffset, endOffset]) => buildTextSegment({
      paragraphNumber,
      sentenceIndex,
      sentenceText: sentence(passage, paragraphNumber, sentenceIndex),
      startOffset,
      endOffset,
    })),
  });
}

test("v2 text：单句与跨句 range 归一化、类型和存储往返", () => {
  fresh();
  const passage = samplePassage();
  const single = textRangeFor(passage, [[1, 0, 0, 5]]);
  const crossing = textRangeFor(passage, [[1, 0, 6, 12], [1, 1, 0, 5]]);
  let draft = emptyTextEvidenceEntry(100);
  draft = addTextRange(draft, single).draft;
  draft = addTextRange(draft, crossing).draft;
  draft = setTextType(draft, "direct");
  assert.equal(draft.ranges.length, 2);
  assert.equal(draft.ranges[1].segments.length, 2);
  assert.equal(textRangeExcerpt(draft.ranges[1]), "first. Alpha");
  assert.equal(entryComplete(draft), true);

  const store = emptyEvidenceStore("r1", "passage-1");
  const key = keyFor(store, question(21));
  const saved = setEvidence(store, key, "first", draft);
  assert.equal(saved.schemaVersion, QUESTION_EVIDENCE_SCHEMA_VERSION);
  saveEvidenceStore(saved);
  const reloaded = loadEvidenceStore("r1", "passage-1");
  assert.equal(entryFor(reloaded, key, "first").mode, "text");
  assert.equal(entryFor(reloaded, key, "first").textType, "direct");
  assert.equal(entryFor(reloaded, key, "first").ranges[1].segments.length, 2);
});

test("v2 text：必须同时有合法 range 与 textType，非法段被拒绝且最多 3 处", () => {
  fresh();
  const passage = samplePassage();
  let draft = emptyTextEvidenceEntry();
  assert.equal(entryComplete(draft), false);
  draft = setTextType(draft, "inference");
  assert.equal(entryComplete(draft), false);
  const invalid = addTextRange(draft, { segments: [{
    paragraphNumber: 1,
    sentenceIndex: 0,
    startOffset: 5,
    endOffset: 5,
    selectedText: "",
  }] });
  assert.equal(invalid.rejected, true);
  for (const selection of [[1, 0, 0, 5], [1, 0, 6, 12], [1, 1, 0, 5]]) {
    draft = addTextRange(draft, textRangeFor(passage, [selection])).draft;
  }
  assert.equal(draft.ranges.length, MAX_TEXT_EVIDENCE_RANGES);
  assert.equal(addTextRange(draft, textRangeFor(passage, [[2, 0, 0, 4]])).reason, "limit");
  assert.equal(entryComplete(draft), true);

  const normalized = normalizeEvidenceStore({ questions: { bad: { first: {
    mode: "text",
    textType: "not-a-type",
    ranges: [{ segments: [{ paragraphNumber: 0, sentenceIndex: -1, startOffset: 3, endOffset: 1, selectedText: "x" }] }],
  } } } }, "r1", "passage-1");
  assert.equal(entryComplete(normalized.questions.bad.first), false);
  assert.equal(normalized.questions.bad.first.ranges.length, 0);
  const mismatchedLength = normalizeEvidenceStore({ questions: { bad: { first: {
    mode: "text",
    textType: "direct",
    ranges: [{ segments: [{
      paragraphNumber: 1,
      sentenceIndex: 0,
      startOffset: 0,
      endOffset: 10,
      selectedText: "short",
    }] }],
  } } } }, "r1", "passage-1");
  assert.equal(mismatchedLength.questions.bad.first.ranges.length, 0);
  assert.equal(entryComplete(mismatchedLength.questions.bad.first), false);
});

test("v2 current gate：至少一处完整 range 可重定位；全部失效时阻断，历史完成仍 bypass", () => {
  fresh();
  const passage = samplePassage();
  const validRange = textRangeFor(passage, [[1, 0, 0, 5]]);
  const staleRange = buildTextRange({ segments: [buildTextSegment({
    paragraphNumber: 2,
    sentenceIndex: 0,
    sentenceText: "Gone sentence.",
    startOffset: 0,
    endOffset: 4,
  })] });
  const partialEntry = setTextType({ ...emptyTextEvidenceEntry(), ranges: [validRange, staleRange] }, "direct");
  assert.equal(entryResolutionOk(partialEntry, passage), true);

  const questions = [question(21)];
  const base = emptyEvidenceStore("r1", "passage-1");
  const key = keyFor(base, questions[0]);
  const partialStore = setEvidence(base, key, "first", partialEntry);
  assert.equal(quizCompletion({
    questions, answers: { 21: "A" }, store: partialStore, attempt: "first", passage,
  }).canComplete, true);

  const staleOnly = setEvidence(base, key, "first", setTextType({
    ...emptyTextEvidenceEntry(), ranges: [staleRange],
  }, "direct"));
  assert.equal(entryResolutionOk(entryFor(staleOnly, key, "first"), passage), false);
  assert.equal(quizCompletion({
    questions, answers: { 21: "A" }, store: staleOnly, attempt: "first", passage,
  }).canComplete, false);
  assert.equal(quizCompletion({
    questions, answers: { 21: "A" }, store: staleOnly, attempt: "first", passage, stageCompleted: true,
  }).canComplete, true);
});

test("legacy sentences：load/save 不批量迁移，仅打开 draft 后明确确认才可写 text v2", () => {
  fresh();
  const passage = samplePassage();
  const raw = {
    schemaVersion: 1,
    resourceId: "r1",
    passageId: "passage-1",
    questions: {
      old: { first: { mode: "sentences", references: [buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Alpha first." })] } },
      untouched: { first: { mode: "sentences", references: [buildSentenceRef({ paragraphNumber: 2, sentenceIndex: 0, sentenceText: "Beta only." })] } },
    },
  };
  setUserItem(evidenceStorageKey("r1", "passage-1"), JSON.stringify(raw));
  const loaded = loadEvidenceStore("r1", "passage-1");
  assert.equal(loaded.questions.old.first.mode, "sentences");
  assert.equal(loaded.questions.untouched.first.mode, "sentences");
  const draft = draftFromEntry(loaded.questions.old.first, passage);
  assert.equal(draft.mode, "text");
  assert.equal(draft.ranges[0].segments[0].selectedText, "Alpha first.");
  assert.equal(entryComplete(draft), false);
  const confirmed = setEvidence(loaded, "old", "first", setTextType(draft, "direct"));
  assert.equal(confirmed.questions.old.first.mode, "text");
  assert.equal(confirmed.questions.untouched.first.mode, "sentences");
});

test("legacy global null：当前流程需补类型；历史完成仍完成且 completedAt 不变、不伪造类型", () => {
  fresh();
  const questions = [question(21)];
  const store = normalizeEvidenceStore({
    questions: {
      [keyFor(emptyEvidenceStore("r1", "passage-1"), questions[0])]: {
        first: { mode: "global", globalType: null, completedAt: 12345 },
      },
    },
  }, "r1", "passage-1");
  const key = keyFor(store, questions[0]);
  const entry = entryFor(store, key, "first");
  assert.equal(entryNeedsType(entry), true);
  assert.equal(entryComplete(entry), false);
  assert.equal(entry.globalType, null);
  assert.equal(entry.completedAt, 12345);
  const current = quizCompletion({ questions, answers: { 21: "A" }, store, attempt: "first" });
  assert.equal(current.canComplete, false);
  const historical = quizCompletion({ questions, answers: { 21: "A" }, store, attempt: "first", stageCompleted: true });
  assert.equal(historical.canComplete, true);
  const reloaded = normalizeEvidenceStore(store, "r1", "passage-1");
  assert.equal(entryFor(reloaded, key, "first").completedAt, 12345);
  assert.equal(entryFor(reloaded, key, "first").globalType, null);
});

test("text segment：offset 失效时由 context 唯一恢复；歧义时不猜", () => {
  fresh();
  const original = {
    paragraphs: [{ number: 1, text: "Lead target tail.", sentences: ["Lead target tail."] }],
  };
  const segment = buildTextSegment({
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: "Lead target tail.",
    startOffset: 5,
    endOffset: 11,
  });
  const shifted = {
    paragraphs: [{ number: 1, text: "New Lead target tail.", sentences: ["New Lead target tail."] }],
  };
  const recovered = resolveTextSegment(segment, shifted);
  assert.equal(recovered.status, "resolved");
  assert.equal(recovered.ref.startOffset, 9);

  const ambiguous = {
    paragraphs: [
      { number: 1, text: "Lead target tail.", sentences: ["Lead target tail."] },
      { number: 2, text: "Lead target tail.", sentences: ["Lead target tail."] },
    ],
  };
  const unresolved = resolveTextSegment({ ...segment, sentenceKey: "", fingerprint: "" }, ambiguous);
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.reason, "ambiguous-selection");
});

test("DOM helper：native Selection 跨句分段；无 Custom Highlight 时只装饰 parent", () => {
  fresh();
  const passage = samplePassage();
  const dom = new JSDOM(`
    <div class="clean-article">
      <div class="clean-sentence"><p data-evidence-paragraph="1" data-evidence-sentence="0">Alpha first.</p></div>
      <div class="clean-sentence"><p data-evidence-paragraph="1" data-evidence-sentence="1">Alpha second.</p></div>
    </div>
  `);
  const article = dom.window.document.querySelector(".clean-article");
  const paragraphs = article.querySelectorAll("p");
  const nativeRange = dom.window.document.createRange();
  nativeRange.setStart(paragraphs[0].firstChild, 6);
  nativeRange.setEnd(paragraphs[1].firstChild, 5);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(nativeRange);

  const range = evidenceRangeFromSelection(selection, article, passage);
  assert.equal(range.segments.length, 2);
  assert.equal(range.segments[0].selectedText, "first.");
  assert.equal(range.segments[1].selectedText, "Alpha");

  const domMissingRange = textRangeFor(passage, [[2, 0, 0, 4]]);
  const entry = setTextType({ ...emptyTextEvidenceEntry(), ranges: [range, domMissingRange] }, "direct");
  const previousCss = globalThis.CSS;
  const previousHighlight = globalThis.Highlight;
  globalThis.CSS = undefined;
  globalThis.Highlight = undefined;
  try {
    const shown = showEvidenceHighlight({ entry, passage, articleElement: article });
    assert.equal(shown.ok, true);
    assert.equal(shown.partial, true);
    assert.equal(shown.method, "parent-decoration");
    assert.equal(article.querySelectorAll(".evidence-highlight-fallback").length, 2);
    shown.clear();
    assert.equal(article.querySelectorAll(".evidence-highlight-fallback").length, 0);
  } finally {
    globalThis.CSS = previousCss;
    globalThis.Highlight = previousHighlight;
  }
});

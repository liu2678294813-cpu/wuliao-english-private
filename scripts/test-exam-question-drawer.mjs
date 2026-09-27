// X1.1 考试悬浮题窗契约（修改 38–42）：
// - 只提供：题号 / 题干 / A/B/C/D / 当前已选择答案；
// - 禁止：正确答案 / 订正 / AI Hint / AI Diagnosis / evidence / 学习结果 / 官方答案高亮；
// - 答案选择必须走 onChoose → answerExamItem → Exam Session.answers；
// - 默认 floating（不改变正文宽度 → 不触发 Canvas resize → 笔迹 geometry 稳定）；
// - 不重新 mount / 不改变 surfaceId / 不重载 strokes。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const source = read("src/exam/ExamQuestionDrawer.jsx");

test("题窗只渲染题号 / 题干 / 选项 / 已选答案，禁止学习业务元素", () => {
  assert.match(source, /question\.order/);
  assert.match(source, /question\.stem/);
  assert.match(source, /question\.options/);
  assert.match(source, /answers\[question\.id\]/);
  assert.doesNotMatch(source, /correction|officialAnswer|answerKey\(/);
  assert.doesNotMatch(source, /AI|aiRequest|hint|diagnosis|evidence/);
  assert.doesNotMatch(source, /questionEvidence|readingFlow|redo/);
  assert.doesNotMatch(source, /wuliao:answers/);
});

test("题窗答案必须走 onChoose（→ Exam Session），不触碰普通阅读答案存储", () => {
  assert.match(source, /onChoose\(question\.id, option\.key\)/);
  assert.doesNotMatch(source, /setUserItem|localStorage|saveReadingAnswers|wuliao:answers/);
});

test("题窗默认 floating 固定定位，不改变正文宽度 / 不重挂 Ink Surface", () => {
  assert.match(source, /style=\{\{ left/);
  assert.doesNotMatch(source, /docked|onDockedChange/);
  assert.doesNotMatch(source, /ExamInkSurface/);
  assert.doesNotMatch(source, /reload|loadCloze|getExamInkSnapshot/);
  assert.match(source, /exam-question-fab/);
});

test("题窗关闭不销毁答案（通过 Exam Session answers 读写，选择即保存）", () => {
  assert.match(source, /answers = \{\}/);
  assert.match(source, /onChoose = \(\) => \{\}/);
  assert.match(source, /className=\{selected === option\.key \? "selected" : ""\}/);
});

test("考试题窗与普通精读 QuestionDrawer 业务隔离（ExamSession 使用轻量组件）", () => {
  const screens = read("src/exam/ExamScreens.jsx");
  assert.doesNotMatch(screens, /from "\.\.\/PdfReader"/);
  assert.doesNotMatch(screens, /\bQuestionDrawer\b/);
  assert.match(screens, /ExamQuestionDrawer/);
  assert.match(screens, /item\.section === "reading"/);
});

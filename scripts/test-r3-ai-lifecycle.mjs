import test from "node:test";
import assert from "node:assert/strict";

import { createAiRequestLifecycle, aiRequestContext } from "../src/aiRequestLifecycle.js";

test("closing one panel cancels its consumers, preserves another panel and permits reopening", () => {
  const first = createAiRequestLifecycle(), second = createAiRequestLifecycle();
  const context = { resourceId: "reader", passageId: "p1" };
  first.setActiveContext(context); second.setActiveContext(context);
  const a = new AbortController(), b = new AbortController();
  first.beginRequest({ requestId: 1, context, controller: a });
  second.beginRequest({ requestId: 1, context, controller: b });
  first.cancelAll();
  assert.equal(a.signal.aborted, true);
  assert.equal(first.isContextStale(1), true);
  assert.equal(b.signal.aborted, false);
  assert.equal(second.isContextStale(1), false);
  first.beginRequest({ requestId: 2, context, controller: new AbortController() });
  assert.equal(first.isContextStale(2), false);
});

test("requestId 单调递增", () => {
  const lifecycle = createAiRequestLifecycle();
  const a = lifecycle.nextRequestId();
  const b = lifecycle.nextRequestId();
  assert.ok(b > a);
});

test("success：请求完成后结果不属于 stale", async () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  const controller = new AbortController();
  const requestId = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId,
    context: { resourceId: "r1", passageId: "p1", taskType: "question-hint-1" },
    controller,
  });
  await Promise.resolve();
  assert.equal(lifecycle.isContextStale(requestId), false);
  lifecycle.endRequest(requestId);
});

test("error：同上下文内错误结果不视为 stale", () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1" });
  const requestId = lifecycle.nextRequestId();
  lifecycle.beginRequest({ requestId, context: { resourceId: "r1" }, controller: new AbortController() });
  assert.equal(lifecycle.isContextStale(requestId), false);
  lifecycle.endRequest(requestId);
});

test("abort：切换文章/段落自动 abort 所有 in-flight 请求", () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  const controller = new AbortController();
  const requestId = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId,
    context: { resourceId: "r1", passageId: "p1", taskType: "translation-review" },
    controller,
  });
  assert.equal(controller.signal.aborted, false);
  lifecycle.setActiveContext({ resourceId: "r2", passageId: "p1" });
  assert.equal(controller.signal.aborted, true);
  assert.equal(lifecycle.inflightCount(), 0);
  assert.equal(lifecycle.isContextStale(requestId), true);
});

test("切换段落 / 题目后旧请求被判定 stale", () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  const requestId = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId,
    context: { resourceId: "r1", passageId: "p1", questionId: "q1", taskType: "question-hint-2" },
    controller: new AbortController(),
  });

  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1", questionId: "q2", taskType: "question-hint-2" });
  assert.equal(lifecycle.isContextStale(requestId), true);

  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p2", questionId: "q2", taskType: "question-hint-2" });
  assert.equal(lifecycle.isContextStale(requestId), true);
});

test("同一位置不同任务（hint1 → hint2 延续）不视为 stale", () => {
  const lifecycle = createAiRequestLifecycle();
  const active = { resourceId: "r1", passageId: "p1", questionId: "q1" };
  lifecycle.setActiveContext(active);
  const first = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId: first,
    context: { ...active, taskType: "question-hint-1" },
    controller: new AbortController(),
  });
  lifecycle.beginRequest({
    requestId: lifecycle.nextRequestId(),
    context: { ...active, taskType: "question-hint-2" },
    controller: new AbortController(),
  });
  assert.equal(lifecycle.isContextStale(first), false);
});

test("同一位置发起新题目请求时旧题目请求被取代（abort + stale）", () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });
  const oldController = new AbortController();
  const oldRequest = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId: oldRequest,
    context: { resourceId: "r1", passageId: "p1", questionId: "q1", taskType: "question-hint-1" },
    controller: oldController,
  });
  assert.equal(oldController.signal.aborted, false);

  lifecycle.beginRequest({
    requestId: lifecycle.nextRequestId(),
    context: { resourceId: "r1", passageId: "p1", questionId: "q2", taskType: "question-hint-1" },
    controller: new AbortController(),
  });
  assert.equal(oldController.signal.aborted, true);
  assert.equal(lifecycle.isContextStale(oldRequest), true);
});

test("同一位置同一题目同一任务重复提交不算 stale", () => {
  const lifecycle = createAiRequestLifecycle();
  const ctx = { resourceId: "r1", passageId: "p1", questionId: "q1", taskType: "cloze-hint-1" };
  lifecycle.setActiveContext(ctx);
  const first = lifecycle.nextRequestId();
  lifecycle.beginRequest({ requestId: first, context: ctx, controller: new AbortController() });
  const second = lifecycle.nextRequestId();
  lifecycle.beginRequest({ requestId: second, context: ctx, controller: new AbortController() });
  assert.equal(lifecycle.isContextStale(first), false);
  assert.equal(lifecycle.isContextStale(second), false);
});

test("阅读 / 完形 task router 的上下文键正确派生", () => {
  assert.deepEqual(
    aiRequestContext({ resourceId: "r1", passageId: "p1", type: "question-hint-1" }),
    { resourceId: "r1", passageId: "p1", clozeId: "", questionId: "", sentenceId: "", taskType: "question-hint-1" },
  );
  assert.deepEqual(
    aiRequestContext({ resourceId: "c1", clozeId: "cloze-1", taskType: "cloze-diagnosis", sentenceId: "s1" }),
    { resourceId: "c1", passageId: "", clozeId: "cloze-1", questionId: "", sentenceId: "s1", taskType: "cloze-diagnosis" },
  );
  assert.equal(
    aiRequestContext({ resourceId: "r1", passageId: "p1", questionId: "q1" }).questionId,
    "q1",
  );
});

test("stale 结果丢弃后不影响后续新请求", async () => {
  const lifecycle = createAiRequestLifecycle();
  lifecycle.setActiveContext({ resourceId: "r1", passageId: "p1" });

  const oldRequest = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId: oldRequest,
    context: { resourceId: "r1", passageId: "p1", taskType: "translation-review" },
    controller: new AbortController(),
  });

  lifecycle.setActiveContext({ resourceId: "r2", passageId: "p1" });
  assert.equal(lifecycle.isContextStale(oldRequest), true);

  const newRequest = lifecycle.nextRequestId();
  lifecycle.beginRequest({
    requestId: newRequest,
    context: { resourceId: "r2", passageId: "p1", taskType: "translation-review" },
    controller: new AbortController(),
  });
  await Promise.resolve();
  assert.equal(lifecycle.isContextStale(newRequest), false);
  lifecycle.endRequest(newRequest);
});

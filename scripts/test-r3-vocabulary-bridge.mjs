import test from "node:test";
import assert from "node:assert/strict";

import {
  createVocabularyBridge,
  VocabMessageType,
} from "../src/vocabulary/vocabularyBridge.js";
import {
  buildVocabularyMessage,
  isVocabularyMessage,
  validateVocabularyPayload,
  VOCABULARY_NAMESPACE,
  VOCABULARY_PROTOCOL_VERSION,
} from "../src/vocabulary/vocabularyProtocol.js";

class MockFrame {
  constructor() {
    this.messages = [];
  }

  postMessage(message, origin) {
    this.messages.push({ message, origin });
  }
}

function makeBridge() {
  const frame = new MockFrame();
  const events = [];
  const bridge = createVocabularyBridge({
    frameWindow: () => frame,
    messageTargetOrigin: () => "*",
    expectedOrigin: "",
    onEvent: (normalized) => events.push(normalized),
  });
  return { frame, events, bridge };
}

function childMessage(frame, type, payload) {
  return {
    source: frame,
    origin: "",
    data: buildVocabularyMessage(type, payload),
  };
}

test("flush waits for its own trusted response, propagates failure and rejects on reset", async () => {
  const {bridge,frame}=makeBridge();
  const first=bridge.flush(),second=bridge.flush();
  const ids=frame.messages.map(({message})=>message.payload.requestId);
  bridge.handleMessage(childMessage({},'FLUSH_RESULT',{requestId:ids[0],ok:true}));
  bridge.handleMessage(childMessage(frame,'FLUSH_RESULT',{requestId:ids[1],ok:false,error:'disk full'}));
  await assert.rejects(second,/disk full/);
  bridge.handleMessage(childMessage(frame,'FLUSH_RESULT',{requestId:ids[0],ok:true}));await first;
  const third=bridge.flush();bridge.reset();await assert.rejects(third,/已切换/);
});

test("READY：子端握手后 bridge 就绪且回调收到", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage(childMessage(frame, "READY", null));
  assert.equal(bridge.isReady(), true);
  assert.equal(events[0].type, VocabMessageType.READY);
});

test("NAVIGATE：父端发送新协议消息到 iframe", () => {
  const { frame, bridge } = makeBridge();
  bridge.send(VocabMessageType.NAVIGATE, { route: "/lists" });
  const sent = frame.messages[0].message;
  assert.equal(sent.namespace, VOCABULARY_NAMESPACE);
  assert.equal(sent.version, VOCABULARY_PROTOCOL_VERSION);
  assert.equal(sent.type, VocabMessageType.NAVIGATE);
  assert.deepEqual(sent.payload, { route: "/lists" });
});

test("ROUTE_CHANGED / BACK / SESSION_UPDATED 回调分发", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage(childMessage(frame, "ROUTE_CHANGED", { route: "/screening/1" }));
  bridge.handleMessage(childMessage(frame, "BACK", null));
  bridge.handleMessage(childMessage(frame, "SESSION_UPDATED", null));
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["ROUTE_CHANGED", "BACK", "SESSION_UPDATED"],
  );
  assert.equal(events[0].payload.route, "/screening/1");
});

test("invalid message：namespace / version / type 不匹配一律忽略", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage({ source: frame, origin: "", data: { namespace: "other", version: 1, type: "READY" } });
  bridge.handleMessage({ source: frame, origin: "", data: { namespace: VOCABULARY_NAMESPACE, version: 99, type: "READY" } });
  bridge.handleMessage({ source: frame, origin: "", data: { namespace: VOCABULARY_NAMESPACE, version: 1, type: "NOT_A_TYPE" } });
  bridge.handleMessage({ source: frame, origin: "", data: "not-an-object" });
  bridge.handleMessage({ source: frame, origin: "", data: null });
  assert.equal(events.length, 0);
  assert.equal(bridge.isReady(), false);
});

test("unrelated iframe message 被忽略（source 不匹配）", () => {
  const { bridge, events } = makeBridge();
  bridge.handleMessage({
    source: { other: true },
    origin: "",
    data: buildVocabularyMessage("ROUTE_CHANGED", { route: "/lists" }),
  });
  assert.equal(events.length, 0);
});

test("payload 形状校验：非法 payload 被忽略", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage({ source: frame, origin: "", data: buildVocabularyMessage("NAVIGATE", { route: 123 }) });
  bridge.handleMessage({ source: frame, origin: "", data: buildVocabularyMessage("SET_AUTO_SPEAK", { enabled: "yes" }) });
  assert.equal(events.length, 0);
  assert.equal(validateVocabularyPayload("NAVIGATE", { route: "/lists" }), true);
  assert.equal(validateVocabularyPayload("NAVIGATE", null), false);
  assert.equal(isVocabularyMessage(buildVocabularyMessage("READY", null)), true);
});

test("account switch：reset 后就绪态清空，绝不跨账号复用", () => {
  const { bridge, frame } = makeBridge();
  bridge.handleMessage(childMessage(frame, "READY", null));
  assert.equal(bridge.isReady(), true);
  bridge.reset();
  assert.equal(bridge.isReady(), false);
});

test("reload / remount：重新 READY 后重新握手", () => {
  const { bridge, frame } = makeBridge();
  bridge.handleMessage(childMessage(frame, "READY", null));
  bridge.reset();
  bridge.handleMessage(childMessage(frame, "READY", null));
  assert.equal(bridge.isReady(), true);
});

test("HARDWARE_BACK_RESPONSE：atRoot 语义透传", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage(childMessage(frame, "HARDWARE_BACK_RESPONSE", { atRoot: true }));
  bridge.handleMessage(childMessage(frame, "HARDWARE_BACK_RESPONSE", { atRoot: false }));
  assert.deepEqual(
    events.map((entry) => entry.payload.atRoot),
    [true, false],
  );
});

test("STATIC_PAGE 透传 page 标识", () => {
  const { bridge, frame, events } = makeBridge();
  bridge.handleMessage(childMessage(frame, "STATIC_PAGE", { page: "review" }));
  assert.equal(events[0].payload.page, "review");
});

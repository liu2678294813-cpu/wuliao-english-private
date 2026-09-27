import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "localStorage", "Event", "InputEvent", "MouseEvent", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Node"]) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactModule = await import("react");
const React = ReactModule.default;
const { act } = ReactModule;
const { createRoot } = await import("react-dom/client");
const vite = await createViteModuleRunner(repositoryRoot);
const { default: WritingVisionSettings, WRITING_VISION_PROBE_COPY } = await vite.import("/src/writing/ui/WritingVisionSettings.jsx");

let mountedRoot = null;
function wait(milliseconds = 0) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function fakeEnvironment({ probeStatus = "supported", cachedProbe = null, savedKey = "vision-secret" } = {}) {
  const state = {
    config: { providerKind: "openai-compatible", baseUrl: "https://vision.example/v1" },
    model: "vision-model",
    models: [],
    probe: cachedProbe,
    key: savedKey,
    textConfig: { baseUrl: "https://text.example/v1", model: "text-model", key: "text-secret" },
  };
  const calls = { getApiKey: 0, setApiKey: [], setConfig: [], setModel: [], listModels: 0, probe: 0 };
  const api = {
    getApiKey: async () => { calls.getApiKey += 1; return state.key; },
    getConfig: () => ({ ...state.config }),
    getModel: () => state.model,
    getModelCatalog: () => [...state.models],
    getProbeCache: () => state.probe,
    setApiKey: async (value) => { calls.setApiKey.push(value); state.key = value; state.probe = null; },
    setConfig: (value) => {
      if (!/^https?:\/\//.test(value.baseUrl)) throw new Error("Vision Base URL 必须是合法的 http(s) 地址");
      calls.setConfig.push(value.baseUrl);
      state.config = { providerKind: "openai-compatible", baseUrl: value.baseUrl.replace(/\/$/, "") };
      state.probe = null;
      return { ...state.config };
    },
    setModel: (value) => { calls.setModel.push(value); state.model = String(value || "").trim(); state.probe = null; return state.model; },
    setModelCatalog: (models) => { state.models = [...models]; return [...state.models]; },
    setProbeCache: (result) => { state.probe = { ...result, cachedAt: 1 }; return state.probe; },
  };
  const provider = {
    async listModels() { calls.listModels += 1; return ["vision-a", "vision-b"]; },
    async probe() { calls.probe += 1; return { status: probeStatus }; },
  };
  return { state, calls, api, providerFactory: () => provider, createProbeImage: async () => ({ type: "image/png" }) };
}

async function render(environment) {
  if (mountedRoot) await act(async () => { mountedRoot.unmount(); await wait(); });
  const container = document.getElementById("root");
  container.replaceChildren();
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot.render(React.createElement(WritingVisionSettings, { username: "alice", ...environment }));
    await wait();
  });
  return container;
}

async function clickByText(container, label) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  assert.ok(button, `missing button ${label}`);
  await act(async () => { button.click(); await wait(); });
}

async function setText(input, value) {
  const previous = input.value;
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
  input._valueTracker?.setValue(previous);
  await act(async () => {
    input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait();
  });
}

async function selectValue(select, value) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(select, value);
  await act(async () => {
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait();
  });
}

test("Vision Settings mount 不联网，密钥 masked 且不回显已保存明文", async () => {
  const env = fakeEnvironment();
  const container = await render(env);
  const keyInput = [...container.querySelectorAll("input")].find((input) => input.parentElement.textContent.includes("Vision API Key"));
  assert.equal(env.calls.listModels, 0);
  assert.equal(env.calls.probe, 0);
  assert.equal(keyInput.type, "password");
  assert.equal(keyInput.value, "");
  assert.match(keyInput.placeholder, /已保存/);
  assert.ok(!container.textContent.includes("vision-secret"));
});

test("保存与清除 Vision Key 不改变 Text AI 配置", async () => {
  const env = fakeEnvironment();
  const before = structuredClone(env.state.textConfig);
  const container = await render(env);
  const inputs = [...container.querySelectorAll("input")];
  const keyInput = inputs.find((input) => input.type === "password");
  await setText(keyInput, "vision-new-secret");
  await clickByText(container, "保存 Vision 配置");
  assert.deepEqual(env.calls.setApiKey, ["vision-new-secret"]);
  assert.deepEqual(env.state.textConfig, before);
  await clickByText(container, "清除 Vision Key");
  assert.deepEqual(env.calls.setApiKey, ["vision-new-secret", ""]);
  assert.deepEqual(env.state.textConfig, before);
});

test("模型列表与 capability probe 只在显式点击后调用", async () => {
  const env = fakeEnvironment();
  const container = await render(env);
  assert.equal(env.calls.listModels, 0);
  assert.equal(env.calls.probe, 0);
  await clickByText(container, "刷新模型列表");
  assert.equal(env.calls.listModels, 1);
  assert.match(container.textContent, /2 个 Vision 模型/);
  assert.equal(env.calls.probe, 0);
  await clickByText(container, "测试图片能力");
  assert.equal(env.calls.probe, 1);
  assert.match(container.textContent, /仅证明图片输入链可用/);
});

test("Android 可用的真实 select 能选择 Vision 模型并同步到模型 ID", async () => {
  const env = fakeEnvironment();
  const container = await render(env);
  await clickByText(container, "刷新模型列表");
  const select = container.querySelector("select");
  assert.ok(select, "模型拉取成功后应渲染原生 select");
  assert.deepEqual([...select.options].map((option) => option.value), ["", "vision-a", "vision-b"]);
  await selectValue(select, "vision-b");
  const modelInput = [...container.querySelectorAll("input")].find((input) => input.parentElement.textContent.includes("Vision Model ID"));
  assert.equal(modelInput.value, "vision-b");
  await clickByText(container, "保存 Vision 配置");
  assert.equal(env.calls.setModel.at(-1), "vision-b");
});

test("Probe UI 精确映射 supported/unsupported/auth/rate/network/timeout/provider/invalid-response", async (t) => {
  for (const status of ["supported", "unsupported", "auth_error", "rate_limit", "network_error", "timeout", "provider_error", "invalid_response"]) {
    await t.test(status, async () => {
      const env = fakeEnvironment({ probeStatus: status });
      const container = await render(env);
      await clickByText(container, "测试图片能力");
      assert.ok(container.textContent.includes(WRITING_VISION_PROBE_COPY[status]));
      assert.equal(env.calls.probe, 1);
    });
  }
});

test("model/baseURL/key 编辑后旧 supported 状态立即失效", async () => {
  for (const label of ["Vision Base URL", "Vision API Key", "Vision Model ID"]) {
    const env = fakeEnvironment({ cachedProbe: { status: "supported", cachedAt: 1 } });
    const container = await render(env);
    assert.match(container.textContent, /仅证明图片输入链可用/);
    const input = [...container.querySelectorAll("input")].find((item) => item.parentElement.textContent.includes(label));
    await setText(input, `${input.value || "changed"}-changed`);
    assert.match(container.textContent, /未测试图片能力/);
    assert.ok(!container.textContent.includes("仅证明图片输入链可用"));
  }
});

test.after(async () => {
  if (mountedRoot) await act(async () => mountedRoot.unmount());
  await vite.close();
});

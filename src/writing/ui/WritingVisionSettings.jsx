import { useEffect, useRef, useState } from "react";
import { normalizeAiApiBaseUrl } from "../../ai.js";
import {
  getWritingVisionApiKey,
  getWritingVisionConfig,
  getWritingVisionModel,
  getWritingVisionModelCatalog,
  getWritingVisionProbeCache,
  setWritingVisionApiKey,
  setWritingVisionConfig,
  setWritingVisionModel,
  setWritingVisionModelCatalog,
  setWritingVisionProbeCache,
} from "../writingVisionConfig.js";
import { createOpenAiCompatibleVisionProvider, createWl7ProbeImage } from "../writingVisionProvider.js";

const DEFAULT_API = Object.freeze({
  getApiKey: getWritingVisionApiKey,
  getConfig: getWritingVisionConfig,
  getModel: getWritingVisionModel,
  getModelCatalog: getWritingVisionModelCatalog,
  getProbeCache: getWritingVisionProbeCache,
  setApiKey: setWritingVisionApiKey,
  setConfig: setWritingVisionConfig,
  setModel: setWritingVisionModel,
  setModelCatalog: setWritingVisionModelCatalog,
  setProbeCache: setWritingVisionProbeCache,
});

export const WRITING_VISION_PROBE_COPY = Object.freeze({
  supported: "该模型已通过图片能力测试。此结果仅证明图片输入链可用。",
  unsupported: "该模型不支持图片输入。",
  auth_error: "认证失败，请检查 Vision API Key。",
  rate_limit: "请求过于频繁，请稍后再试。",
  network_error: "网络失败，请检查连接与 Vision Base URL。",
  timeout: "请求超时，请稍后重试。",
  provider_error: "服务异常，请稍后重试。",
  invalid_response: "返回内容无效，未通过图片能力测试。",
});

function probeTone(status) {
  if (status === "supported") return "ok";
  if (status === "unsupported") return "warning";
  return status ? "error" : "";
}

function categoryFor(error) {
  return error?.category || error?.code || "provider_error";
}

export default function WritingVisionSettings({
  username,
  api = DEFAULT_API,
  providerFactory = createOpenAiCompatibleVisionProvider,
  createProbeImage = createWl7ProbeImage,
}) {
  const initialConfig = api.getConfig();
  const initialModel = api.getModel();
  const [baseUrl, setBaseUrl] = useState(initialConfig.baseUrl || "");
  const [model, setModel] = useState(initialModel);
  const [models, setModels] = useState(() => api.getModelCatalog(initialConfig));
  const [keyDraft, setKeyDraft] = useState("");
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");
  const [probeResult, setProbeResult] = useState(() => api.getProbeCache(initialConfig, initialModel));
  const savedKeyRef = useRef("");

  useEffect(() => {
    let active = true;
    api.getApiKey({ username }).then((value) => {
      if (!active) return;
      savedKeyRef.current = String(value || "");
      setHasSavedKey(Boolean(value));
      setLoaded(true);
    }).catch(() => {
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, [api, username]);

  function clearProbeDisplay() {
    setProbeResult(null);
  }

  function normalizedDraftConfig() {
    const normalized = normalizeAiApiBaseUrl(baseUrl);
    if (!normalized) throw new Error("Vision Base URL 必须是合法的 http(s) 地址");
    return { providerKind: "openai-compatible", baseUrl: normalized };
  }

  function effectiveKey() {
    return String(keyDraft || savedKeyRef.current || "").trim();
  }

  async function persistSettings() {
    const config = api.setConfig({ baseUrl });
    const savedModel = api.setModel(model);
    if (!savedModel) throw new Error("请填写 Vision Model");
    if (keyDraft.trim()) {
      await api.setApiKey(keyDraft, { username });
      savedKeyRef.current = keyDraft.trim();
      setKeyDraft("");
      setHasSavedKey(true);
    }
    return { config, modelId: savedModel, apiKey: effectiveKey() };
  }

  async function save() {
    setBusy("save");
    setMessage("");
    try {
      await persistSettings();
      setProbeResult(null);
      setMessage("Vision AI 配置已保存；文本 AI 配置未改变。");
      setMessageType("ok");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vision AI 配置保存失败");
      setMessageType("error");
    } finally {
      setBusy("");
    }
  }

  async function clearKey() {
    setBusy("clear");
    setMessage("");
    try {
      await api.setApiKey("", { username });
      savedKeyRef.current = "";
      setKeyDraft("");
      setHasSavedKey(false);
      setProbeResult(null);
      setMessage("已清除本账号 Vision API Key；文本 AI Key 未改变。");
      setMessageType("ok");
    } catch {
      setMessage("Vision API Key 清除失败，请重试。");
      setMessageType("error");
    } finally {
      setBusy("");
    }
  }

  async function refreshModels() {
    setBusy("models");
    setMessage("");
    try {
      const config = normalizedDraftConfig();
      const apiKey = effectiveKey();
      if (!apiKey) throw new Error("请先保存或填写 Vision API Key");
      const received = await providerFactory().listModels({ config, apiKey });
      const persistedConfig = api.setConfig(config);
      setBaseUrl(persistedConfig.baseUrl);
      const saved = api.setModelCatalog(received, persistedConfig);
      setModels(saved);
      setMessage(`已读取 ${saved.length} 个 Vision 模型；模型列表不代表图片能力。`);
      setMessageType("ok");
    } catch (error) {
      const copy = WRITING_VISION_PROBE_COPY[categoryFor(error)];
      setMessage(copy || (error instanceof Error ? error.message : "模型列表读取失败"));
      setMessageType("error");
    } finally {
      setBusy("");
    }
  }

  async function probe() {
    setBusy("probe");
    setMessage("");
    setProbeResult(null);
    try {
      const saved = await persistSettings();
      if (!saved.apiKey) throw new Error("请先保存或填写 Vision API Key");
      const imageBlob = await createProbeImage();
      const result = await providerFactory().probe({
        config: saved.config,
        apiKey: saved.apiKey,
        modelId: saved.modelId,
        imageBlob,
      });
      const cached = api.setProbeCache(result, saved.config, saved.modelId);
      setProbeResult(cached);
    } catch (error) {
      setProbeResult({ status: categoryFor(error) });
    } finally {
      setBusy("");
    }
  }

  const probeStatus = probeResult?.status || "";

  return (
    <section className="writing-vision-settings" aria-labelledby="writing-vision-settings-title">
      <header>
        <div>
          <small>MULTIMODAL · HANDWRITING</small>
          <h3 id="writing-vision-settings-title">多模态 / 手写识别 AI</h3>
        </div>
        <span>与文本 AI 独立</span>
      </header>
      <p className="writing-vision-settings-note">仅用于 W3 / W7 手写转写。模型出现在列表中不代表支持图片输入；能力测试也不代表手写识别质量。</p>
      {!loaded ? <p className="ai-api-loading">正在读取 Vision 配置…</p> : (
        <div className="writing-vision-settings-fields">
          <label className="ai-api-field">Vision Base URL
            <input
              value={baseUrl}
              onChange={(event) => { setBaseUrl(event.target.value); clearProbeDisplay(); }}
              placeholder="https://example.com/v1"
              autoComplete="url"
              inputMode="url"
            />
          </label>
          <label className="ai-api-field">Vision API Key
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => { setKeyDraft(event.target.value); clearProbeDisplay(); }}
              placeholder={hasSavedKey ? "已保存；输入新密钥可更新" : "输入 Vision API Key"}
              autoComplete="new-password"
              aria-describedby="writing-vision-key-status"
            />
            <small id="writing-vision-key-status">{hasSavedKey ? "已保存的密钥不会回显。" : "当前账号尚未保存 Vision API Key。"}</small>
          </label>
          {models.length > 0 ? (
            <label className="ai-api-field">接口返回的 Vision 模型
              <select
                value={models.includes(model) ? model : ""}
                onChange={(event) => {
                  if (event.target.value) setModel(event.target.value);
                  clearProbeDisplay();
                }}
              >
                <option value="">从列表选择（全部 {models.length} 个）</option>
                {models.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
              </select>
            </label>
          ) : null}
          <label className="ai-api-field">Vision Model ID
            <input
              value={model}
              onChange={(event) => { setModel(event.target.value); clearProbeDisplay(); }}
              placeholder="从上方选择或手动输入模型 ID"
              maxLength={256}
              autoComplete="off"
              spellCheck="false"
            />
            <small>接口不支持模型列表时仍可手动填写。</small>
          </label>
          <div className="writing-vision-model-actions">
            <button type="button" className="ai-api-test" disabled={Boolean(busy)} onClick={refreshModels}>{busy === "models" ? "正在刷新…" : "刷新模型列表"}</button>
            <span>{models.length ? `${models.length} 个已读取模型` : "尚未读取模型列表"}</span>
          </div>
          <div className="writing-vision-actions">
            <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={save}>{busy === "save" ? "正在保存…" : "保存 Vision 配置"}</button>
            <button type="button" className="ai-api-test" disabled={Boolean(busy)} onClick={probe}>{busy === "probe" ? "测试中…" : "测试图片能力"}</button>
            <button type="button" className="ai-api-clear" disabled={Boolean(busy) || !hasSavedKey} onClick={clearKey}>清除 Vision Key</button>
          </div>
        </div>
      )}
      <p className={`writing-vision-probe ${probeTone(probeStatus)}`} role="status" aria-live="polite">
        {busy === "probe" ? "测试中：正在验证图片输入链…" : probeStatus ? WRITING_VISION_PROBE_COPY[probeStatus] || WRITING_VISION_PROBE_COPY.provider_error : "未测试图片能力。"}
      </p>
      {message ? <p className={`ai-api-message ${messageType}`} role="status">{message}</p> : null}
    </section>
  );
}

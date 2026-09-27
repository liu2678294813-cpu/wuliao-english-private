import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALIBABA_REGIONS,
  RUNTIME_STATUS,
  SUPPORT_STATUS,
  TRANSPORT_KINDS,
  bindCredential,
  credentialBindingStatus,
  fetchProviderModels,
  getCachedProviderModels,
  getBuiltinProviderModels,
  getCredential,
  getProviderProfile,
  listAiProviders,
  normalizeProviderProfile,
  rebindCredential,
  recordRuntimeEvidence,
  saveProviderProfile,
  testProviderConnection,
} from "../aiProvider.js";
import { getAppInfo } from "../appInfo.js";
import { createOpenAiCompatibleVisionProvider, createWl7ProbeImage } from "../writing/writingVisionProvider.js";

const PROVIDERS = listAiProviders();

function freshProfile(modality, providerId) {
  const provider = PROVIDERS.find((item) => item.id === providerId) || PROVIDERS[0];
  const base = {
    version: 2,
    modality,
    providerId: provider.id,
    endpointKind: provider.endpointKinds[0],
    baseUrl: provider.defaultBaseUrl || "",
    modelId: provider.defaultModel || "",
  };
  if (provider.id === "alibaba") return { ...base, endpointKind: "shared", region: "cn-beijing" };
  if (provider.id === "custom") return { ...base, endpointKind: "custom", transportOverride: TRANSPORT_KINDS.CHAT };
  return base;
}

function reasonCopy(error) {
  const code = error?.code || error?.category;
  if (code === "runtime_network_compatibility" || code === "network_error") return "当前运行时没有取得 HTTP 响应，可能受 CORS、DNS、TLS 或网络策略限制。";
  if (code === "credential_unbound") return "当前端点尚未绑定 API Key。";
  if (code === "unsupported_protocol") return "该模型使用本版本尚未实现的协议。";
  if (code === "auth_error") return "认证失败，请检查当前端点对应的 API Key。";
  if (code === "rate_limit") return "请求频率受限，请稍后再试。";
  if (code === "timeout") return "连接超时，请检查网络后重试。";
  return error instanceof Error ? error.message : "操作失败，请检查配置。";
}

function changeAlibabaRegion(draft, regionId) {
  const region = ALIBABA_REGIONS.find((item) => item.id === regionId);
  const endpointKind = (draft.endpointKind === "trial" && !region?.trial)
    || (draft.endpointKind === "shared" && !region?.sharedHost)
    ? "workspace-dedicated"
    : draft.endpointKind;
  return { region: regionId, endpointKind };
}

export default function AiProviderSettings({ modality = "text", username, onSaved }) {
  const fallback = freshProfile(modality, modality === "vision" ? "gemini" : "deepseek");
  const initial = getProviderProfile(modality) || normalizeProviderProfile(fallback);
  const [draft, setDraft] = useState(initial);
  const [savedProfile, setSavedProfile] = useState(initial);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState("loading");
  const [models, setModels] = useState(() => getCachedProviderModels(initial)?.models || getBuiltinProviderModels(initial));
  const [modelSearch, setModelSearch] = useState("");
  const [catalogTime, setCatalogTime] = useState(() => getCachedProviderModels(initial)?.updatedAt || 0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const currentKeyRef = useRef("");
  const requestRef = useRef({ revision: 0, controller: null });
  function cancelRequest() {
    requestRef.current.revision += 1;
    requestRef.current.controller?.abort();
    setBusy("");
  }
  useEffect(() => () => {
    requestRef.current.revision += 1;
    requestRef.current.controller?.abort();
  }, [username]);
  const provider = PROVIDERS.find((item) => item.id === draft.providerId) || PROVIDERS[0];
  const normalizedDraft = useMemo(() => {
    try { return normalizeProviderProfile(draft); } catch { return null; }
  }, [draft]);
  const binding = normalizedDraft ? credentialBindingStatus(savedProfile, normalizedDraft) : "unbound";

  useEffect(() => {
    let active = true;
    if (!normalizedDraft) {
      currentKeyRef.current = "";
      setKeyStatus("unbound");
      return () => { active = false; };
    }
    setKeyStatus("loading");
    currentKeyRef.current = "";
    getCredential(normalizedDraft, { username, migrateLegacy: false }).then((result) => {
      if (!active) return;
      currentKeyRef.current = result.value;
      setKeyStatus(result.status);
    }).catch((error) => {
      if (!active) return;
      currentKeyRef.current = "";
      setKeyStatus("error");
      setNotice({ tone: "error", text: reasonCopy(error) });
    });
    return () => { active = false; };
  }, [binding, normalizedDraft?.credentialScopeId, username]);
  useEffect(() => {
    if (!normalizedDraft) { setModels([]); setCatalogTime(0); return; }
    const cached = getCachedProviderModels(normalizedDraft);
    setModels(cached?.models || getBuiltinProviderModels(normalizedDraft));
    setCatalogTime(cached?.updatedAt || 0);
    setModelSearch("");
  }, [normalizedDraft?.credentialScopeId, username]);

  function changeProvider(providerId) {
    cancelRequest();
    currentKeyRef.current = "";
    setDraft(freshProfile(modality, providerId));
    const next = freshProfile(modality, providerId);
    try {
      const normalized = normalizeProviderProfile(next);
      const cached = getCachedProviderModels(normalized);
      setModels(cached?.models || getBuiltinProviderModels(normalized));
      setCatalogTime(cached?.updatedAt || 0);
    } catch {
      setModels([]);
      setCatalogTime(0);
    }
    setKeyDraft("");
    setNotice(null);
  }

  function patchDraft(patch) {
    cancelRequest();
    if (Object.keys(patch).some((key) => key !== "modelId" && key !== "transportOverride")) {
      currentKeyRef.current = "";
      setKeyDraft("");
    }
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  async function persist({ allowEmptyKey = true, commit = true } = {}) {
    const revision = requestRef.current.revision;
    const profile = normalizeProviderProfile(draft);
    let apiKey = keyDraft.trim();
    if (keyDraft.trim()) {
      await bindCredential(profile, keyDraft, { username });
    } else {
      apiKey = (await getCredential(profile, { username, migrateLegacy: false })).value;
    }
    if (revision !== requestRef.current.revision) throw Object.assign(new Error("配置已切换"), { code: "cancelled" });
    if (!apiKey && !allowEmptyKey) throw Object.assign(new Error("当前端点未绑定 API Key"), { code: "credential_unbound" });
    if (apiKey) {
      currentKeyRef.current = apiKey;
      setKeyDraft("");
      setKeyStatus("bound");
    }
    if (commit) {
      saveProviderProfile(profile);
      setDraft(profile);
      setSavedProfile(profile);
      onSaved?.();
    }
    return profile;
  }

  async function loadModels(profile) {
    const controller = new AbortController();
    requestRef.current.controller?.abort();
    requestRef.current.controller = controller;
    const revision = requestRef.current.revision;
    const catalog = await fetchProviderModels(profile, { apiKey: currentKeyRef.current, username, signal: controller.signal });
    if (revision !== requestRef.current.revision) throw Object.assign(new Error("配置已切换"), { code: "cancelled" });
    setModels(catalog.models);
    setCatalogTime(catalog.updatedAt);
    return catalog;
  }

  async function save() {
    cancelRequest();
    const revision = requestRef.current.revision;
    setBusy("save");
    setNotice(null);
    try {
      const profile = await persist();
      setNotice({ tone: "ok", text: "配置已保存，正在获取模型…" });
      if (currentKeyRef.current) {
        try {
          const catalog = await loadModels(profile);
          setNotice({ tone: "ok", text: `配置已保存，已获取 ${catalog.models.length} 个模型。选择其他模型后点击保存即可生效。` });
        } catch (error) {
          if (revision === requestRef.current.revision && error.code !== "cancelled") setNotice({ tone: "error", text: `配置已保存；${reasonCopy(error)} 原列表与所选模型已保留。` });
        }
      } else setNotice({ tone: "ok", text: "配置已保存；填写 API Key 后可获取模型。" });
    } catch (error) { if (revision === requestRef.current.revision && error.code !== "cancelled") setNotice({ tone: "error", text: reasonCopy(error) }); }
    finally { if (revision === requestRef.current.revision) setBusy(""); }
  }

  async function refreshModels() {
    cancelRequest();
    const revision = requestRef.current.revision;
    setBusy("models");
    setNotice(null);
    try {
      const profile = await persist({ allowEmptyKey: false, commit: false });
      const catalog = await loadModels(profile);
      setNotice({ tone: "ok", text: catalog.models.length ? `已读取 ${catalog.models.length} 个模型；选择后点击保存生效，能力以实际测试为准。` : "接口返回空目录；仍可手动输入 Model ID。" });
    } catch (error) { if (revision === requestRef.current.revision && error.code !== "cancelled") setNotice({ tone: "error", text: `${reasonCopy(error)} 原列表与所选模型已保留。` }); }
    finally { if (revision === requestRef.current.revision) setBusy(""); }
  }

  async function rebind() {
    setBusy("rebind");
    setNotice(null);
    try {
      const next = normalizeProviderProfile(draft);
      await rebindCredential(savedProfile, next, { username, confirm: true });
      saveProviderProfile(next);
      setSavedProfile(next);
      currentKeyRef.current = (await getCredential(next, { username, migrateLegacy: false })).value;
      setKeyStatus("bound");
      setNotice({ tone: "ok", text: "已将旧密钥写入并校验到新端点绑定。" });
      onSaved?.();
    } catch (error) { setNotice({ tone: "error", text: reasonCopy(error) }); }
    finally { setBusy(""); }
  }

  async function clearKey() {
    setBusy("clear");
    setNotice(null);
    try {
      const profile = normalizeProviderProfile(draft);
      await bindCredential(profile, "", { username });
      currentKeyRef.current = "";
      setKeyDraft("");
      setKeyStatus("missing");
      setNotice({ tone: "ok", text: "已清除当前端点的 API Key。" });
      onSaved?.();
    } catch (error) { setNotice({ tone: "error", text: reasonCopy(error) }); }
    finally { setBusy(""); }
  }

  async function testConnection() {
    setBusy("test");
    setNotice(null);
    try {
      const profile = await persist({ allowEmptyKey: false });
      const apiKey = keyDraft.trim() || currentKeyRef.current || (await getCredential(profile, { username })).value;
      if (!apiKey) throw Object.assign(new Error(), { code: "credential_unbound" });
      const appVersion = getAppInfo().appVersion;
      if (modality === "vision") {
        const transport = profile.transportOverride || models.find((item) => item.id === profile.modelId)?.transportKind || provider.defaultTransport;
        if (transport !== TRANSPORT_KINDS.CHAT) throw Object.assign(new Error(), { code: "unsupported_protocol" });
        const imageBlob = await createWl7ProbeImage();
        const result = await createOpenAiCompatibleVisionProvider().probe({
          config: { baseUrl: profile.baseUrl }, apiKey, modelId: profile.modelId, imageBlob,
        });
        if (result.status !== "supported") throw Object.assign(new Error(), { code: result.status, category: result.status });
        recordRuntimeEvidence(profile, profile.modelId, RUNTIME_STATUS.VERIFIED, { appVersion });
        setNotice({ tone: "ok", text: "真实微型图片测试通过，当前运行时已验证。" });
      } else {
        const result = await testProviderConnection(profile, { apiKey, appVersion });
        setNotice({ tone: "ok", text: `连接成功 · ${result.modelId} · ${result.transportKind}` });
      }
    } catch (error) { setNotice({ tone: "error", text: reasonCopy(error) }); }
    finally { setBusy(""); }
  }

  const endpointNeedsUrl = draft.endpointKind === "custom" || provider.id === "custom";
  const selectedModel = models.find((item) => item.id === draft.modelId);
  const unsupported = selectedModel?.textStatus === SUPPORT_STATUS.UNSUPPORTED_PROTOCOL
    || (modality === "text" && selectedModel?.textStatus === SUPPORT_STATUS.UNSUPPORTED)
    || (modality === "vision" && selectedModel?.visionStatus === SUPPORT_STATUS.UNSUPPORTED_PROTOCOL);

  return (
    <section className="provider-settings" aria-label={`${modality === "text" ? "文本" : "视觉"} AI Provider 设置`}>
      <div className="provider-settings-grid">
        <label className="ai-api-field">Provider
          <select value={draft.providerId} onChange={(event) => changeProvider(event.target.value)}>
            {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>

        {provider.id === "alibaba" ? (
          <div className="provider-endpoint-grid">
            <label className="ai-api-field">区域
              <select value={draft.region || "cn-beijing"} onChange={(event) => patchDraft(changeAlibabaRegion(draft, event.target.value))}>
                {ALIBABA_REGIONS.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.id}</option>)}
              </select>
            </label>
            <label className="ai-api-field">端点类型
              <select value={draft.endpointKind} onChange={(event) => patchDraft({ endpointKind: event.target.value })}>
                <option value="workspace-dedicated">Workspace 专属</option>
                {ALIBABA_REGIONS.find((item) => item.id === draft.region)?.sharedHost ? <option value="shared">Shared / Legacy</option> : null}
                {ALIBABA_REGIONS.find((item) => item.id === draft.region)?.trial ? <option value="trial">Trial</option> : null}
                <option value="custom">Custom Base URL</option>
              </select>
            </label>
            {draft.endpointKind === "workspace-dedicated" ? (
              <label className="ai-api-field provider-span">Workspace ID
                <input value={draft.workspaceId || ""} onChange={(event) => patchDraft({ workspaceId: event.target.value })} autoComplete="off" />
              </label>
            ) : null}
          </div>
        ) : provider.id === "glm" ? (
          <label className="ai-api-field">服务区域
            <select value={draft.endpointKind} onChange={(event) => patchDraft({ endpointKind: event.target.value })}>
              <option value="china">中国</option><option value="global">全球</option><option value="custom">自定义</option>
            </select>
          </label>
        ) : null}

        {endpointNeedsUrl ? (
          <label className="ai-api-field">API Base URL
            <input value={draft.baseUrl || ""} onChange={(event) => patchDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="url" inputMode="url" />
          </label>
        ) : (
          <div className="provider-endpoint-readonly"><span>Endpoint</span><code>{normalizedDraft?.baseUrl || "请完成端点配置"}</code></div>
        )}

        <label className="ai-api-field">API Key
          <input type="password" value={keyDraft} onChange={(event) => { cancelRequest(); setKeyDraft(event.target.value); }} placeholder={keyStatus === "bound" ? "已安全保存；输入新密钥可替换" : "输入当前端点的 API Key"} autoComplete="new-password" />
          <small>{keyStatus === "bound" ? "已绑定当前端点，密钥不会回显。" : keyStatus === "unbound" ? "端点身份已改变，旧密钥不会被自动发送。" : keyStatus === "error" ? "安全存储不可用，Android 请求已阻止。" : "尚未绑定当前端点。"}</small>
        </label>

        <div className="ai-api-field provider-model-picker">
          <label>搜索模型<input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="按名称或 Model ID 搜索" /></label>
          <label>选择模型<select aria-label="选择模型" value={models.some((item) => item.id === draft.modelId) ? draft.modelId : ""} onChange={(event) => { if (event.target.value) patchDraft({ modelId: event.target.value }); }}>
            <option value="">{models.length ? "请选择，或在下方手动输入" : "暂无目录，请获取模型或手动输入"}</option>
            {models.filter((item) => item.id === draft.modelId || `${item.id} ${item.name}`.toLowerCase().includes(modelSearch.toLowerCase())).map((item) => <option key={item.id} value={item.id}>{item.id}{item.name !== item.id ? ` · ${item.name}` : ""}</option>)}
          </select></label>
          <label>Model ID（可手动输入）<input value={draft.modelId || ""} onChange={(event) => patchDraft({ modelId: event.target.value })} placeholder="输入服务商提供的完整模型 ID" maxLength={256} autoComplete="off" spellCheck="false" /></label>
          <small>目录不代表账号调用权限。未验证的模型可保存，实际能力以连接测试为准。</small>
        </div>

        <details className="provider-advanced">
          <summary>高级设置</summary>
          <label className="ai-api-field">协议覆盖
            <select value={draft.transportOverride || ""} onChange={(event) => patchDraft({ transportOverride: event.target.value || undefined })}>
              <option value="">跟随模型目录</option>
              <option value={TRANSPORT_KINDS.CHAT}>Chat Completions</option>
              <option value={TRANSPORT_KINDS.RESPONSES}>Responses</option>
              <option value={TRANSPORT_KINDS.MESSAGES}>Anthropic Messages（未实现）</option>
              <option value={TRANSPORT_KINDS.GEMINI}>Native Gemini（未实现）</option>
            </select>
          </label>
        </details>
      </div>

      {binding === "unbound" && savedProfile ? (
        <div className="credential-unbound" role="status">
          <span>旧 API Key 仍留在原端点，不会发送到这里。</span>
          <button type="button" disabled={Boolean(busy)} onClick={rebind}>确认重新绑定旧 Key</button>
        </div>
      ) : null}

      <div className="provider-actions">
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={save}>{busy === "save" ? "保存中…" : "保存"}</button>
        <button type="button" disabled={Boolean(busy)} onClick={refreshModels}>{busy === "models" ? "刷新中…" : "刷新模型"}</button>
        <button type="button" disabled={Boolean(busy) || unsupported} onClick={testConnection}>{busy === "test" ? "测试中…" : modality === "vision" ? "测试图片能力" : "连接测试"}</button>
        <button className="danger" type="button" disabled={Boolean(busy) || keyStatus !== "bound"} onClick={clearKey}>清除 Key</button>
      </div>
      <p className="provider-catalog-status">{catalogTime ? `官方接口／当前端点目录 · 更新于 ${new Date(catalogTime).toLocaleString("zh-CN")}` : models.length ? "内置候选 · 来源：服务商官方文档（2026-09-09），不是账号实时可用列表" : "暂无模型缓存"}</p>
      {unsupported ? <p className="provider-notice error" role="alert">unsupported_protocol：此模型保留在目录中，但当前版本禁止调用。</p> : null}
      {notice ? <p className={`provider-notice ${notice.tone}`} role="status" aria-live="polite">{notice.text}</p> : null}
    </section>
  );
}

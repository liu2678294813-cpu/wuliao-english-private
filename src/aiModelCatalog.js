// Official model-discovery contracts, verified 2026-09-09. No generation calls.
// https://ai.google.dev/api/models
// https://help.aliyun.com/zh/model-studio/list-models
// https://platform.kimi.com/docs/api/list-models
// https://docs.bigmodel.cn/cn/guide/start/model-overview
export function modelCatalogRequest(profile) {
  const url = new URL(`${profile.baseUrl}/models`);
  let kind = "compatible";
  if (profile.endpointKind !== "custom") {
    if (profile.providerId === "gemini") {
      kind = "gemini";
      url.pathname = "/v1beta/models";
      url.searchParams.set("pageSize", "1000");
    } else if (profile.providerId === "alibaba") {
      kind = "alibaba";
      url.pathname = "/api/v1/models";
      url.searchParams.set("page_no", "1");
      url.searchParams.set("page_size", "100");
    }
  }
  return { url, kind };
}

export function modelCatalogPage(data, kind) {
  const rows = Array.isArray(data) ? data : data?.data || data?.models || data?.output?.models || data?.result?.data;
  if (!Array.isArray(rows)) throw new Error("模型目录格式无法识别");
  return rows.map((row) => {
    if (kind === "gemini") return {
      ...row, id: String(row.name || "").replace(/^models\//, ""), name: row.displayName || row.name,
      textUnsupported: Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes("generateContent"),
    };
    if (kind === "alibaba") return {
      ...row, id: row.model, input_modalities: row.inference_metadata?.request_modality,
      textUnsupported: Array.isArray(row.inference_metadata?.response_modality) && !row.inference_metadata.response_modality.includes("Text"),
    };
    return row;
  });
}

export function nextModelCatalogPage(data, request, collectedCount) {
  const next = new URL(request.url);
  if (request.kind === "gemini" && data?.nextPageToken) next.searchParams.set("pageToken", data.nextPageToken);
  else if (request.kind === "alibaba" && Number(data?.output?.total) > collectedCount) {
    next.searchParams.set("page_no", String(Number(next.searchParams.get("page_no")) + 1));
  } else if (data?.has_more === true && data.last_id) next.searchParams.set("after", data.last_id);
  else return null;
  return { ...request, url: next };
}

export function builtinModelRows(profile) {
  // These are documented candidates, not a claim of account access or a complete list.
  if (profile.endpointKind === "custom") return [];
  const ids = profile.providerId === "glm"
    ? ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx", "glm-4.6", "glm-4.5-air", "glm-4.5-flash", "glm-4.6v", "glm-4.6v-flash"]
    : profile.providerId === "alibaba" ? ["qwen-plus", "qwen-flash", "qwen3-max"] : [];
  return ids.map((id) => ({ id }));
}

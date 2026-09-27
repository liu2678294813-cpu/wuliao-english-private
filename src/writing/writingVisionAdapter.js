import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";
import { validateVisionPageTranscript } from "./writingAiSchemas.js";
import { renderWritingInkPage, stableWritingInkPageOrder } from "./writingVisionRenderer.js";

export class WritingVisionAdapterError extends Error {
  constructor(code, message, cause = null) { super(message); this.name = "WritingVisionAdapterError"; this.code = code; this.cause = cause; }
}

export async function transcribeWritingInkSnapshot({ snapshot, provider, config, apiKey, modelId, signal, renderPage = renderWritingInkPage, pageOrder = null } = {}) {
  if (!provider?.transcribePage) throw new TypeError("Vision provider.transcribePage is required");
  const pages = pageOrder === null ? stableWritingInkPageOrder(snapshot) : [...pageOrder];
  if (pages.some((pageId) => typeof pageId !== "string" || !pageId.trim()) || new Set(pages).size !== pages.length) {
    throw new WritingVisionAdapterError("invalid_page_order", "Vision pageOrder must contain unique non-empty page ids");
  }
  if (!pages.length) throw new WritingVisionAdapterError("no_pages", "Writing ink contains no canonical pages");
  const transcripts = [];
  for (const pageId of pages) {
    let rendered;
    try {
      rendered = await renderPage(snapshot, pageId);
      const output = await provider.transcribePage({ config, apiKey, modelId, imageBlob: rendered.imageBlob, pageId, promptVersion: WRITING_AI_PROMPT_VERSIONS.transcription, signal });
      transcripts.push(validateVisionPageTranscript(output, { pageId }));
    } catch (cause) {
      // Do not return a partial formal transcription. The successful temporary
      // page values stay only in this call frame for an explicit retry.
      throw new WritingVisionAdapterError(cause?.code || cause?.category || "provider_error", `Vision transcription failed for ${pageId}`, cause);
    } finally {
      try { rendered?.imageBlob?.close?.(); } catch { /* Blob has no required close API */ }
    }
  }
  return { pageOrder: [...pages], pages: transcripts, rawTranscript: transcripts.map((item) => item.text).join("\n\n"), promptVersion: WRITING_AI_PROMPT_VERSIONS.transcription, adapterVersion: WRITING_AI_PROMPT_VERSIONS.visionOpenAi, renderVersion: WRITING_AI_PROMPT_VERSIONS.visionRender };
}

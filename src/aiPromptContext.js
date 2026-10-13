// A boundary in plain user data, never a new instruction or permission scope.
export const AI_DYNAMIC_CONTEXT_MARKER = "\n\n【本次任务】\n";
export const AI_CONTEXT_VERSION = 1;

export function buildArticlePromptContext({ articleText, chapter, resourceId }) {
  return [
    chapter || resourceId ? `【资料】${String(chapter || "").trim()}${resourceId ? `（ID: ${String(resourceId).trim()}）` : ""}` : "",
    articleText ? `【当前文章】\n${String(articleText).trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function withDynamicAiContext(stable, dynamic) {
  return `${stable || ""}${AI_DYNAMIC_CONTEXT_MARKER}${dynamic || ""}`;
}

export function stableAiPrefix(messages) {
  const prefix = [];
  for (const message of messages || []) {
    if (["system", "developer"].includes(message?.role)) {
      prefix.push({ role: message.role, content: message.content });
      continue;
    }
    if (typeof message?.content === "string" && message.content.includes(AI_DYNAMIC_CONTEXT_MARKER)) {
      prefix.push({ role: message.role, content: message.content.split(AI_DYNAMIC_CONTEXT_MARKER)[0] });
    }
    break;
  }
  return prefix;
}

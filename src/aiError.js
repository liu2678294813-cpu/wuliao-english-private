// AI 错误分类纯函数：Telemetry 与用户提示共用同一套分类逻辑。
// 文案保持 provider-neutral；aiReviewService 原样 re-export。

export function classifyAiError(reason) {
  if (!reason) return { message: "AI 请求失败，请稍后重试", category: "unknown" };
  if (reason && reason.name === "AbortError") {
    return { message: "请求超时（可能超过服务端处理时限），请重试", category: "timeout" };
  }
  if (reason instanceof TypeError) {
    return { message: "网络连接失败，请检查网络后重试", category: "network" };
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!message) return { message: "AI 请求失败，请稍后重试", category: "unknown" };
  if (/Insufficient Balance|余额|insufficient/i.test(message)) {
    return { message: "接口余额或额度不足，请充值后重试", category: "insufficient-balance" };
  }
  if (/throttl|rate limit|429|限流/i.test(message)) {
    return { message: "服务端限流，请稍后再试", category: "rate-limit" };
  }
  if (/authentication|invalid.*api|invalid.*key|401|403/i.test(message)) {
    return { message: "AI API Key 无效，请检查后重试", category: "auth" };
  }
  if (/timeout|超时|timed out/i.test(message)) {
    return { message: "请求超时，请稍后重试", category: "timeout" };
  }
  if (/返回为空|empty response|invalid response/i.test(message)) {
    return { message, category: "invalid-response" };
  }
  if (/500|502|503|server error|服务端异常/i.test(message)) {
    return { message: "AI API 服务端暂时不可用，请稍后重试", category: "server" };
  }
  return { message, category: "unknown" };
}

// 统一隐私清洗：Telemetry 永远不保存 API Key / Authorization / 密码 / PIN /
// 完整 Prompt / 完整 Response / 文章 / 译文 / 聊天 / 笔迹点数据。

// 注意：promptTokens / totalTokens 等用量字段不是密钥，不能命中敏感规则。
const SENSITIVE_KEY_PATTERN = /(apikey|api[_-]?key|authorization|auth[_-]?(token|key|secret)|secret|passwd|password|pin|credential|access[_-]?token|refresh[_-]?token|bearer|(?:^|[^a-z])token(?:$|[^a-z]))/i;
const TEXT_LIMIT = 200;
const ERROR_TEXT_LIMIT = 500;
const ARRAY_LIMIT = 50;

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key || ""));
}

export function sanitizeText(value, limit = TEXT_LIMIT) {
  const text = String(value == null ? "" : value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function sanitizeErrorText(message) {
  return sanitizeText(message, ERROR_TEXT_LIMIT);
}

export function sanitizeMetadata(value, depth = 0) {
  if (depth > 5) return "[max-depth]";
  if (value == null) return null;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, ARRAY_LIMIT).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = sanitizeMetadata(item, depth + 1);
    }
    return output;
  }
  return null;
}

// 供测试使用：找出对象中残留的敏感键名（值已被遮蔽仍算残留键）。
export function findSensitiveKeys(value, depth = 0, path = "") {
  const found = [];
  if (depth > 5 || value == null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findSensitiveKeys(item, depth + 1, `${path}[${index}]`));
    });
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    const full = path ? `${path}.${key}` : key;
    if (isSensitiveKey(key)) found.push(full);
    found.push(...findSensitiveKeys(item, depth + 1, full));
  }
  return found;
}

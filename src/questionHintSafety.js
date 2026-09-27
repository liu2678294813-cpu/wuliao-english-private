// 阅读题一级/二级提示的答案泄露检测。
// 只拦截“结合中文答案语境 + 选项字母”的明显泄露格式，
// 不盲目禁止普通英文文本中的 A-D 字母。

const LEAK_PATTERNS = [
  /正确答案\s*(?:是|为)?\s*[:：]?\s*[A-D]/i,
  /本题答案\s*(?:是|为)?\s*[:：]?\s*[A-D]/i,
  /答案\s*(?:是|为)\s*[:：]?\s*[A-D]/i,
  /正确选项\s*(?:是|为)?\s*[:：]?\s*[A-D]/i,
  /标准答案\s*(?:是|为)?\s*[:：]?\s*[A-D]/i,
  /官方答案\s*(?:是|为)?\s*[:：]?\s*[A-D]/i,
  /(?:应|应当|应该|建议|推荐)选(?:择)?\s*[A-D](?:\s*项)?/i,
  /选(?:择)?\s*[A-D](?:\s*项)?(?:是|更|较|最)(?:正确|合适|符合)/i,
  /因(?:此|而)\s*选(?:择)?\s*[A-D]/i,
  /故\s*选(?:择)?\s*[A-D]/i,
  /所以\s*选(?:择)?\s*[A-D]/i,
  /[A-D]\s*项(?:正确|错误|符合题意|不符合题意|应选|排除)/i,
  /排除\s*[A-D](?:\s*项)?/i,
  /[A-D](?:\s*项)?\s*(?:正确|错误|符合|不符合)/i,
  /不是\s*[A-D](?:\s*项)?/i,
  /[A-D]\s*错[，,、]?\s*[A-D]\s*对/i,
];

export function validateHintNoAnswerLeak(text, level) {
  if (level !== 1 && level !== 2) return { ok: true };
  const source = String(text == null ? "" : text);
  if (!source) return { ok: true };
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(source)) {
      return { ok: false, reason: pattern.source };
    }
  }
  return { ok: true };
}

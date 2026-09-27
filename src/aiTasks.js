export const TASK_TRANSLATION_REVIEW = "translation-review";
export const TRANSLATION_REVIEW_PROMPT_VERSION = 2;

// Stable, synchronous SHA-256 keeps existing fingerprint builder interfaces.
const SHA_K = [], SHA_H = [];
for (let n = 2; SHA_K.length < 64; n += 1) {
  let prime = true;
  for (let d = 2; d * d <= n; d += 1) if (n % d === 0) { prime = false; break; }
  if (prime) {
    if (SHA_H.length < 8) SHA_H.push((Math.sqrt(n) % 1 * 0x100000000) | 0);
    SHA_K.push((Math.cbrt(n) % 1 * 0x100000000) | 0);
  }
}
export function sha256AiInput(text) {
  const input = new TextEncoder().encode(String(text));
  const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  data.set(input); data[input.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(data.length - 4, input.length * 8);
  const h = [...SHA_H], w = new Int32Array(64);
  const rotr = (x,n) => (x >>> n) | (x << (32-n));
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i=0;i<16;i++) w[i]=view.getInt32(offset+i*4);
    for (let i=16;i<64;i++) { const a=w[i-15], b=w[i-2]; w[i]=(w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))|0; }
    let [a,b,c,d,e,f,g,j]=h;
    for (let i=0;i<64;i++) {
      const t1=(j+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+SHA_K[i]+w[i])|0;
      const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))|0;
      j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,j].forEach((value,i)=>{h[i]=(h[i]+value)|0;});
  }
  return h.map(value=>(value>>>0).toString(16).padStart(8,"0")).join("");
}
export function stableAiIdentity(value) {
  if (Array.isArray(value)) return `[${value.map(stableAiIdentity).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(key=>value[key] !== undefined).map(key=>`${JSON.stringify(key)}:${stableAiIdentity(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const fingerprintAiInput = value => sha256AiInput(stableAiIdentity(value));

export const TRANSLATION_REVIEW_ERROR_TAGS = [
  "主干识别错误",
  "从句关系错误",
  "非谓语识别错误",
  "修饰范围错误",
  "代词指代错误",
  "逻辑关系错误",
  "词义选择错误",
  "漏译",
  "增译",
  "中文表达生硬",
];

export const TRANSLATION_REVIEW_SYSTEM_PROMPT = `你是一位英语精读批改老师。你的任务不是重新翻译，而是批改学生已经写出的中文译文。
我会提供【文章】【所在段落】【当前句（英文）】以及学生确认后的【我的译文】。

请按以下顺序批改：
1. 先判断学生的译文是否基本准确；
2. 检查英文主干（主语、谓语、宾语或表语）是否正确传达；
3. 检查从句与非谓语动词结构及其句法关系；
4. 检查修饰范围（定语、状语分别修饰什么）；
5. 检查逻辑关系（转折、因果、让步、条件、递进、并列等）；
6. 检查代词指代；
7. 检查词义选择（必须结合本句语境）；
8. 检查漏译和增译；
9. 检查中文表达是否自然；
10. 在此基础上只修改必要的问题，给出尽量保留学生原文的最小修改版；
11. 最后给出完整、自然的参考译文。

批改纪律：
- 不空泛鼓励，不为了显得严格而虚构错误；
- 没有问题的分类必须返回空数组；
- 明确区分“翻译错误”与“仅中文表达不够自然”；
- 尽量保留学生的原译文，最小修改版不能变成完全重写；
- 本功能输入的学生译文均为学生确认后的内容，不要猜测或归因任何 OCR 识别问题。

只输出一个 JSON 对象，不要附加任何 Markdown、解释、围栏或前后缀文字。
JSON 结构如下：
{
  "version": 1,
  "summary": { "level": "accurate | mostly-accurate | needs-revision", "comment": "整体判断" },
  "mainClause": { "correct": true, "comment": "" },
  "clauseProblems": [ { "source": "对应英文主句/从句", "type": "从句关系错误", "comment": "" } ],
  "nonFiniteProblems": [ { "source": "分词/不定式/动名词", "comment": "" } ],
  "modifierProblems": [ { "source": "被修饰的英文成分", "userVersion": "学生对应译法", "comment": "" } ],
  "referenceProblems": [ { "source": "代词或指代词", "comment": "" } ],
  "logicProblems": [ { "source": "逻辑词或结构", "logicType": "转折 | 因果 | 让步 | 条件 | 递进 | 并列 | 其他", "comment": "" } ],
  "omissions": [ { "source": "漏译的英文成分", "comment": "漏译内容和句法作用" } ],
  "additions": [ { "userVersion": "学生增加的内容", "comment": "为什么属于原文没有的信息" } ],
  "wordChoiceProblems": [ { "word": "英文词或短语", "userVersion": "学生译法", "contextMeaning": "本句语境义", "comment": "" } ],
  "chineseExpressionProblems": [ { "userVersion": "学生原表达", "comment": "仅说明中文表达问题，不夸大为理解错误" } ],
  "minimalRevision": "尽量保留学生原译文，只修必要问题",
  "referenceTranslation": "完整参考译文",
  "errorTags": ["只允许出现下方白名单中的标签"]
}
errorTags 只能从以下白名单中选择，且只选择确实存在的问题：
主干识别错误、从句关系错误、非谓语识别错误、修饰范围错误、代词指代错误、逻辑关系错误、词义选择错误、漏译、增译、中文表达生硬。
如果学生译文准确：errorTags 返回空数组，各问题数组返回空数组，minimalRevision 可以与学生译文相同或只做轻微润色。`;

export function buildTranslationReviewMessages({ sentence, paragraph, chapter, userTranslation }) {
  const contextParts = [];
  if (chapter) contextParts.push(`【文章】${chapter}`);
  if (paragraph) contextParts.push(`【所在段落】\n${paragraph}`);
  const context = contextParts.join("\n");
  const user = [
    context ? `${context}\n` : "",
    `【当前句（英文）】\n${sentence}`,
    `\n【我的译文】\n${userTranslation}`,
  ].join("");
  return [
    { role: "system", content: TRANSLATION_REVIEW_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildTranslationReviewFingerprint({ sentence, paragraph, chapter = "", userTranslation, model, provider = "" }) {
  const payload = stableAiIdentity([
    TASK_TRANSLATION_REVIEW,
    String(TRANSLATION_REVIEW_PROMPT_VERSION),
    String(provider || ""),
    String(model || ""),
    String(chapter || ""),
    String(sentence || ""),
    String(paragraph || ""),
    String(userTranslation || ""),
  ]);
  return `tr${sha256AiInput(payload)}`;
}

// ============================================================================
// B 阶段：阅读题 AI 三级提示
// ============================================================================

export const TASK_QUESTION_HINT_1 = "question-hint-1";
export const TASK_QUESTION_HINT_2 = "question-hint-2";
export const TASK_QUESTION_EXPLANATION = "question-explanation";
export const QUESTION_HINT_PROMPT_VERSION = 2;

export const QUESTION_TYPES = [
  "细节题",
  "推理题",
  "词义题",
  "例证题",
  "主旨题",
  "作者态度题",
  "其他",
];

export const TRAP_TYPES = [
  "偷换概念",
  "范围扩大",
  "范围缩小",
  "因果倒置",
  "过度推断",
  "无中生有",
  "以偏概全",
  "忽略否定",
  "忽略程度限定",
  "忽略转折",
  "作者态度误判",
  "把例子当主旨",
];

const QUESTION_HINT_STRICT_NOTE =
  "（严格重试要求：你的上一结果泄露了选择题答案。重新生成提示。不得出现任何选项字母、正确选项或排除结果。）";

export const QUESTION_HINT_LEVEL1_SYSTEM_PROMPT = `你是考研英语阅读精读老师。学生正在独立做一道阅读选择题，需要“给我一点提示”：只帮助他重新定位和观察原文，绝不能直接或间接说出正确答案。

本次输入只包含：
- 当前资料
- 当前题干
- 当前文章正文

你不得知道、也不得推断后输出：
- 正确答案、选项字母、四个选项的内容
- “选择”“排除”“A 错 B 对”等任何判题表述
- 用户的选择或作答情况

要求：
1. 指出应该重点查看哪里；如果无法可靠定位，必须明确写“无法精确定位”，不得虚构段落位置，不得声称“我已经精确定位到第 X 段”。
2. 提示应关注哪些关键词。
3. 提示应关注哪些逻辑信号（指代、转折、因果、让步、态度变化等）。
4. 给用户一个重新阅读的方向。
5. 给用户一个反问自己的问题（questionForUser），让他重新思考，不要替他把推理链走完，不要给出结论。

只输出一个 JSON 对象，不要附加任何 Markdown、解释、围栏或前后缀文字。
JSON 结构如下：
{
  "version": 1,
  "level": 1,
  "focus": {
    "location": "建议查看的位置。如果无法可靠定位则明确写无法精确定位",
    "keywords": [],
    "logicSignals": []
  },
  "readingDirection": "",
  "questionForUser": ""
}`;

export const QUESTION_HINT_LEVEL2_SYSTEM_PROMPT = `你是考研英语阅读精读老师。学生已完成一级提示并再次思考，现在需要“再提示一步”：理解这道题应该怎么做，但仍不能告诉他正确答案，也不能代替他排除选项。

本次输入只包含：
- 当前资料
- 当前题干
- 当前文章正文

你不得知道、也不得推断后输出：
- 正确答案、选项字母、四个选项的内容
- “正确答案是……”“应该选择……”“A 项……”“B 项……”等任何指向具体选项的判题表述
- 明确描述正确选项的内容
- 直接完成整条推理链并给出结论

允许输出：
1. 题型判断。
2. 题干真正问的是什么。
3. 题干与原文之间可能存在的同义替换。
4. 关键逻辑链与推理步骤。
5. 常见干扰项类型（从白名单选择）。
6. 用户重新判断选项时应该检查什么。

只输出一个 JSON 对象，不要附加任何 Markdown、解释、围栏或前后缀文字。
JSON 结构如下：
{
  "version": 1,
  "level": 2,
  "questionType": "",
  "questionIntent": "",
  "paraphrases": [
    { "questionExpression": "", "sourceExpression": "", "explanation": "" }
  ],
  "reasoningSteps": [],
  "trapTypes": [],
  "finalCheck": ""
}
questionType 只能从以下白名单中选择：细节题、推理题、词义题、例证题、主旨题、作者态度题、其他。
trapTypes 只能从以下白名单中选择：偷换概念、范围扩大、范围缩小、因果倒置、过度推断、无中生有、以偏概全、忽略否定、忽略程度限定、忽略转折、作者态度误判、把例子当主旨。`;

export const QUESTION_HINT_LEVEL3_SYSTEM_PROMPT = `你是考研英语阅读精读老师。学生已完成当前作答流程并允许查看答案，请给出完整讲解。

本次输入包含：
- 当前资料
- 当前题干
- 四个选项
- 官方答案
- 当前文章正文
- 用户首次答案、重做答案、悬浮题窗答案（如果已有）

要求：
1. 先判断题型并给出正确答案。
2. 给出核心结论。
3. 逐条给出原文证据。
4. 给出题干与原文的同义替换。
5. 对输入中实际存在的每个选项逐一分析：result 为 correct 或 wrong，reasonType 从陷阱白名单选择（正确选项为空）。
6. 给出本题通用解题方法。
7. 用户答案只作为当前题目上下文参考，不要建立长期错因档案、不要做统计或画像。

只输出一个 JSON 对象，不要附加任何 Markdown、解释、围栏或前后缀文字。
JSON 结构如下：
{
  "version": 1,
  "level": 3,
  "questionType": "细节题",
  "correctAnswer": "B",
  "coreConclusion": "",
  "evidence": [
    { "source": "原文证据", "explanation": "" }
  ],
  "paraphrases": [
    { "questionExpression": "", "sourceExpression": "", "explanation": "" }
  ],
  "optionAnalysis": [
    { "option": "A", "result": "wrong", "reasonType": "范围扩大", "explanation": "" },
    { "option": "B", "result": "correct", "reasonType": "", "explanation": "" }
  ],
  "solvingRule": ""
}
questionType 只能从以下白名单中选择：细节题、推理题、词义题、例证题、主旨题、作者态度题、其他。
optionAnalysis 必须覆盖输入中实际存在的所有选项，不能假定永远恰好四项。
reasonType 只能从以下白名单中选择：偷换概念、范围扩大、范围缩小、因果倒置、过度推断、无中生有、以偏概全、忽略否定、忽略程度限定、忽略转折、作者态度误判、把例子当主旨。`;

function joinQuestionHintUserParts(parts) {
  return parts.filter(Boolean).join("\n");
}

export function buildQuestionHintLevel1Messages({ questionText, articleText, chapter, resourceId }) {
  const user = joinQuestionHintUserParts([
    articleText ? `【当前文章】\n${String(articleText).trim()}` : "",
    `【当前题干】\n${String(questionText || "").trim()}`,
    chapter || resourceId
      ? `【资料】${String(chapter || "").trim()}${resourceId ? `（ID: ${String(resourceId).trim()}）` : ""}`
      : "",
  ]);
  return [
    { role: "system", content: QUESTION_HINT_LEVEL1_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildQuestionHintLevel2Messages({ questionText, articleText, chapter, resourceId }) {
  const user = joinQuestionHintUserParts([
    articleText ? `【当前文章】\n${String(articleText).trim()}` : "",
    `【当前题干】\n${String(questionText || "").trim()}`,
    chapter || resourceId
      ? `【资料】${String(chapter || "").trim()}${resourceId ? `（ID: ${String(resourceId).trim()}）` : ""}`
      : "",
  ]);
  return [
    { role: "system", content: QUESTION_HINT_LEVEL2_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildQuestionExplanationMessages({
  questionText,
  options,
  officialAnswer,
  articleText,
  chapter,
  resourceId,
  firstAnswer,
  redoAnswer,
  drawerAnswer,
}) {
  const optionLines = (Array.isArray(options) ? options : [])
    .filter((option) => option && option.key && option.text)
    .map((option) => `[${option.key}] ${option.text}`)
    .join("\n");
  const userAnswers = [];
  if (firstAnswer) userAnswers.push(`用户首次答案：${firstAnswer}`);
  if (redoAnswer) userAnswers.push(`用户重做答案：${redoAnswer}`);
  if (drawerAnswer) userAnswers.push(`用户悬浮题窗答案：${drawerAnswer}`);
  const user = joinQuestionHintUserParts([
    articleText ? `【当前文章】\n${String(articleText).trim()}` : "",
    `【当前题干】\n${String(questionText || "").trim()}`,
    `【四个选项】\n${optionLines || "（未提供）"}`,
    `【官方答案】${String(officialAnswer || "").trim()}`,
    chapter || resourceId
      ? `【资料】${String(chapter || "").trim()}${resourceId ? `（ID: ${String(resourceId).trim()}）` : ""}`
      : "",
    userAnswers.length ? `【用户作答情况】\n${userAnswers.join("\n")}` : "",
  ]);
  return [
    { role: "system", content: QUESTION_HINT_LEVEL3_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildQuestionHintStrictMessages(taskType, baseMessages) {
  const strictNote = `\n\n${QUESTION_HINT_STRICT_NOTE}`;
  return (Array.isArray(baseMessages) ? baseMessages : []).map((message, index) => (
    index === 0 && message
      ? { ...message, content: `${String(message.content || "")}${strictNote}` }
      : message
  ));
}

export function buildQuestionHintFingerprint({
  taskType,
  model,
  provider = "",
  promptVersion,
  resourceId,
  chapter,
  questionId,
  questionText,
  articleText,
  options = [], officialAnswer = "", firstAnswer = "", redoAnswer = "", drawerAnswer = "", attempt = "",
}) {
  const payload = stableAiIdentity([
    String(taskType || ""),
    String(promptVersion ?? QUESTION_HINT_PROMPT_VERSION),
    String(provider || ""),
    String(model || ""),
    String(resourceId || ""),
    String(chapter || ""),
    String(questionId || ""),
    String(questionText || ""),
    String(articleText || ""),
    stableAiIdentity(options), officialAnswer, firstAnswer, redoAnswer, drawerAnswer, attempt,
  ]);
  return `qh${sha256AiInput(payload)}`;
}

// ============================================================================
// C 阶段：阅读题 AI 错因诊断
// ============================================================================

export const TASK_QUESTION_DIAGNOSIS = "question-diagnosis";
export const QUESTION_DIAGNOSIS_PROMPT_VERSION = 2;

// 用户错因标签白名单。与 B 阶段 TRAP_TYPES 同名的标签使用完全相同的字符串，
// 避免出现“范围扩大 / 扩大范围”这类重复标签。
export const USER_ERROR_TAGS = [
  "未定位原文",
  "定位偏差",
  "同义替换未识别",
  "忽略转折",
  "忽略否定",
  "忽略程度限定",
  "主体对象混淆",
  "范围扩大",
  "范围缩小",
  "偷换概念",
  "因果倒置",
  "过度推断",
  "无中生有",
  "以偏概全",
  "把例子当主旨",
  "作者态度误判",
  "词义理解错误",
  "时间条件遗漏",
  "只凭印象选择",
];

export const DIAGNOSIS_BASIS_LEVELS = ["answers-only", "answers-and-redo", "user-reasoning"];
export const DIAGNOSIS_CONFIDENCE_LEVELS = ["low", "medium", "high"];

export const QUESTION_DIAGNOSIS_SYSTEM_PROMPT = `你是考研英语阅读精读老师。学生已经完成作答并允许查看官方答案，现在需要你分析“为什么这道题会错”。

你的任务不是重新讲一遍答案（完整讲解由另一功能负责），而是回答三个问题：
1. 学生为什么会被这个错误选项吸引；
2. 学生的作答在哪一步偏离了原文证据链；
3. 首次作答与正式重做之间发生了什么变化。

本次输入包含：
- 当前题干
- 当前选项
- 官方答案
- 用户首次答案、重做答案（如果已有）
- 当前文章正文
- 用户填写的“我当时是怎么想的”（如果填写）

分析顺序必须严格为：
1. 先从原文证据出发：复制与本题直接相关的连续英文原文；
2. 再分析错误选项：该选项与原文具体差在哪里、为什么具有迷惑性；
3. 再分析用户作答：选择行为与证据链的偏离点；
4. 最后才推测用户错因，并且推测必须标注置信度。

纪律：
- 明确区分 observedFacts（程序和原文能客观确认的事实）与 inferredCause（AI 推测）；
- 没有证据时不得硬贴标签；不得仅因为“用户选错”就返回“未定位原文”或“只凭印象选择”；
- 如果用户填写了“我当时是怎么想的”，必须优先依据该真实思路分析，不要无视它；
- 不空泛鼓励、不辱骂、不讽刺；
- 不使用“粗心”作为万能解释；
- 不因为选错就自动归因为“词汇不好”；
- 不输出“你一直……”“你经常……”“你的阅读习惯是……”等任何长期心理画像，只分析当前这一道题；
- 不输出 correctAnswer 字段：官方答案由程序本地提供，你不要重复判断正确答案；
- 只分析输入中实际存在的作答；没有重做就不要假装存在重做变化；
- evidence.source 必须是【当前文章】中逐字存在的连续英文原文，禁止概括、改写或拼接后冒充原文；
- 如果证据来源无法确定，宁可不给证据，也不要编造。

只输出一个 JSON 对象，不要附加任何 Markdown、解释、围栏或前后缀文字。
JSON 结构如下：
{
  "version": 1,
  "questionType": "细节题",
  "diagnosisBasis": "answers-only | answers-and-redo | user-reasoning",
  "confidence": "low | medium | high",
  "observedFacts": ["第一次选择 B，官方答案为 D"],
  "evidence": [
    { "source": "必须直接来自给定原文的连续文本", "explanation": "为什么该句是本题核心证据" }
  ],
  "paraphrases": [
    { "questionExpression": "题干或正确选项中的表达", "sourceExpression": "原文对应表达", "explanation": "" }
  ],
  "selectedOptionAnalysis": [
    {
      "attempt": "first | redo",
      "selectedOption": "B",
      "optionTrapType": "范围扩大",
      "whyAttractive": "这个错误项为什么容易被选中",
      "whyWrong": "它与原文具体差在哪里"
    }
  ],
  "attemptComparison": {
    "available": true,
    "comment": "如果有首次+重做，解释两次作答发生了什么变化"
  },
  "inferredCause": {
    "summary": "对用户错因的谨慎判断",
    "userErrorTags": [],
    "reasoning": "为什么做出这一判断",
    "uncertainty": "哪些部分无法确认"
  },
  "nextTimeRule": "下次遇到同类题最应该执行的一条检查规则",
  "selfCheckQuestions": ["下次做类似题时可以问自己的问题"]
}
questionType 只能从以下白名单中选择：细节题、推理题、词义题、例证题、主旨题、作者态度题、其他。
optionTrapType 只能从以下白名单中选择：偷换概念、范围扩大、范围缩小、因果倒置、过度推断、无中生有、以偏概全、忽略否定、忽略程度限定、忽略转折、作者态度误判、把例子当主旨。
userErrorTags 只能从以下白名单中选择：未定位原文、定位偏差、同义替换未识别、忽略转折、忽略否定、忽略程度限定、主体对象混淆、范围扩大、范围缩小、偷换概念、因果倒置、过度推断、无中生有、以偏概全、把例子当主旨、作者态度误判、词义理解错误、时间条件遗漏、只凭印象选择。
optionTrapType 描述的是错误选项本身的陷阱类型，不能直接当成用户个人错误标签；只有你能根据用户思路或明确作答行为合理支持时，才把同类标签放入 userErrorTags，否则 userErrorTags 返回空数组。`;

export const QUESTION_DIAGNOSIS_EVIDENCE_RETRY_NOTE =
  "（严格重试要求：上一回答的证据无法在给定原文中找到。请只复制给定【当前文章】中实际存在的连续英文原文，禁止改写、概括、拼接或编造证据；如果找不到可靠证据，将 evidence 返回空数组。）";

function joinQuestionDiagnosisParts(parts) {
  return parts.filter(Boolean).join("\n");
}

export function buildQuestionDiagnosisMessages({
  questionText,
  options,
  officialAnswer,
  firstAnswer,
  redoAnswer,
  articleText,
  chapter,
  resourceId,
  questionNumber,
  userReasoning,
  userEvidence,
}) {
  const optionLines = (Array.isArray(options) ? options : [])
    .filter((option) => option && option.key && option.text)
    .map((option) => `[${option.key}] ${option.text}`)
    .join("\n");
  const answerLines = [];
  if (firstAnswer) answerLines.push(`用户首次答案：${firstAnswer}`);
  if (redoAnswer) answerLines.push(`用户重做答案：${redoAnswer}`);
  const user = joinQuestionDiagnosisParts([
    articleText ? `【当前文章】\n${String(articleText).trim()}` : "",
    `【当前题干】\n${String(questionText || "").trim()}`,
    `【当前选项】\n${optionLines || "（未提供）"}`,
    `【官方答案】${String(officialAnswer || "").trim()}`,
    answerLines.length ? `【用户作答】\n${answerLines.join("\n")}` : "",
    userReasoning ? `【我当时是怎么想的】\n${String(userReasoning).trim()}` : "",
    userEvidence ? `【用户自己标记的原文证据】\n${String(userEvidence).trim()}` : "",
    chapter || resourceId
      ? `【资料】${String(chapter || "").trim()}${resourceId ? `（ID: ${String(resourceId).trim()}）` : ""}`
      : "",
  ]);
  return [
    { role: "system", content: QUESTION_DIAGNOSIS_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildQuestionDiagnosisStrictMessages(baseMessages) {
  const strictNote = `\n\n${QUESTION_DIAGNOSIS_EVIDENCE_RETRY_NOTE}`;
  return (Array.isArray(baseMessages) ? baseMessages : []).map((message, index) => (
    index === 0 && message
      ? { ...message, content: `${String(message.content || "")}${strictNote}` }
      : message
  ));
}

export function buildQuestionDiagnosisUserMessage(detail) {
  const number = detail?.questionNumber ? `Q${String(detail.questionNumber)}` : "";
  const text = String(detail?.questionText || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const reasoning = String(detail?.userReasoning || "").trim();
  const content = [
    `错因诊断${number ? ` ${number}` : ""}${text ? `：${text}` : ""}`,
    reasoning ? `\n我当时是怎么想的：${reasoning}` : "",
  ].filter(Boolean).join("");
  return {
    role: "user",
    content,
    label: "错因诊断",
  };
}

export function buildQuestionDiagnosisFingerprint({
  taskType,
  model,
  provider = "",
  promptVersion,
  resourceId,
  chapter,
  questionId,
  questionText,
  options,
  officialAnswer,
  firstAnswer,
  redoAnswer,
  articleText,
  userReasoning,
  userEvidence,
}) {
  const optionPayload = stableAiIdentity((Array.isArray(options) ? options : [])
    .map((option) => ({ key: String(option?.key || ""), text: String(option?.text || "") })));
  const payload = stableAiIdentity([
    String(taskType || ""),
    String(promptVersion ?? QUESTION_DIAGNOSIS_PROMPT_VERSION),
    String(provider || ""),
    String(model || ""),
    String(resourceId || ""),
    String(chapter || ""),
    String(questionId || ""),
    String(questionText || ""),
    optionPayload,
    String(officialAnswer || ""),
    String(firstAnswer || ""),
    String(redoAnswer || ""),
    String(articleText || ""),
    String(userReasoning || ""),
    String(userEvidence || ""),
  ]);
  return `qd${sha256AiInput(payload)}`;
}

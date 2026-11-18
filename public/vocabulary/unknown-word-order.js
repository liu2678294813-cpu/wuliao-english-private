import { normalizeUnknownListTerm } from "./unknown-word-list.js";

export const UNKNOWN_SORTS = [
  ["frequency", "按遇见次数"],
  ["article", "按文章顺序"],
  ["alphabetical", "按字母顺序"],
];

const familyGroups = [
  "be am is are was were been being", "have has had having", "do does did done doing",
  "go goes went gone going", "come came coming", "run ran running runner",
  "make made making", "take took taken taking", "write wrote written writing writer",
  "read reading reader", "give gave given giving", "get got gotten getting",
  "see saw seen seeing", "say said saying", "buy bought", "bring brought",
  "think thought thinking", "feel felt feeling", "find found finding",
  "child children", "person people", "man men", "woman women",
  "foot feet", "tooth teeth", "mouse mice", "criterion criteria",
  "phenomenon phenomena", "datum data", "medium media",
  "teach taught teaching teacher", "learn learnt learned learning learner",
  "choose chose chosen choice", "speak spoke spoken speech", "grow grew grown growth",
  "know knew known knowledge", "understand understood understanding",
  "lead led leading leader leadership", "lie lay lain lying", "lay laid laying",
  "decide decides decided deciding decision decisions decisive decisively",
  "apply applies applied applying application applications applicable",
  "produce produces produced producing production producer productive",
  "reduce reduces reduced reducing reduction",
  "expand expands expanded expanding expansion",
  "explain explains explained explaining explanation",
  "describe describes described describing description descriptive",
  "respond responds responded responding response responsive",
  "permit permits permitted permitting permission",
  "admit admits admitted admitting admission",
  "receive receives received receiving reception",
  "assume assumes assumed assuming assumption",
  "persuade persuades persuaded persuading persuasion",
  "conclude concludes concluded concluding conclusion",
  "believe believes believed believing belief",
  "succeed succeeded succeeding success successful successfully",
  "analyse analyses analysed analysing analyze analyzes analyzed analyzing analysis",
  "differ differs differed differing different differently difference differences",
  "perform performs performed performing performance performances",
  "develop develops developed developing development developments",
  "achieve achieves achieved achieving achievement achievements",
];
const families = new Map(familyGroups.flatMap((group) => {
  const forms = group.split(" ");
  return forms.map((form) => [form, forms[0]]);
}));
const collator = new Intl.Collator("zh-CN", { numeric: true });
const compareEnglish = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const meaningKey = (meaning) => meaning.normalize("NFKC").toLowerCase()
  .replace(/^(?:(?:\[(?:[a-z.]+)\]|\((?:[a-z.]+)\)|(?:vt|vi|adj|adv|prep|pron|conj|noun|verb|n|v)\.)\s*)+/i, "")
  .replace(/\s+|[。.!！]+$/g, "");
const key = (...parts) => JSON.stringify(parts);

function roots(term) {
  if (!/^[a-z]+$/.test(term)) return [term];
  const known = families.get(term);
  if (known) return [known];
  const candidates = [term];
  const append = (stem, endings = [""]) => {
    if (stem.length >= 3) candidates.push(...endings.map((ending) => stem + ending));
  };
  if (term.endsWith("ies")) append(term.slice(0, -3), ["y"]);
  if (term.endsWith("s") && !term.endsWith("ss")) append(term.slice(0, -1));
  if (/(?:[sxz]|ch|sh)es$/.test(term)) append(term.slice(0, -2));
  const suffix = term.match(/(?:ing|ed|er|est|ers|ly|ment|ments|ness|ations|ation|izers|izer|ization|ications|ication)$/)?.[0];
  if (suffix) {
    const stem = term.slice(0, -suffix.length);
    append(stem, suffix.startsWith("icat") ? ["y"] : ["", "e"]);
    if (stem.endsWith("i")) append(stem.slice(0, -1), ["y"]);
    if (/(.)\1$/.test(stem)) append(stem.slice(0, -1));
  }
  return candidates.map((candidate) => families.get(candidate) || candidate);
}

export function unknownArticle(record) {
  const year = String(record.year || "自定义资料");
  const chapter = String(record.chapter || record.passageLabel || "未命名章节");
  const source = record.sourceType === "cloze" ? "完形" : "精读";
  const id = key(record.resourceId ?? record.clozeId ?? year, record.passageId ?? chapter);
  return { id, year, chapter, source, label: record.sourceLabel || record.passageLabel || chapter };
}

export function compareUnknownArticles(left, right) {
  return collator.compare(right.year, left.year)
    || (right.updatedAt || 0) - (left.updatedAt || 0)
    || collator.compare(left.chapter, right.chapter)
    || compareEnglish(left.id, right.id);
}

function contextualMarks(record, english, article) {
  const marks = [];
  const covered = new Set();
  const senses = Array.isArray(record.senses) ? record.senses.filter(Boolean) : [];
  for (const sense of senses) {
    const positions = [...new Set((sense.occurrenceIds || []).filter(Boolean))]
      .sort((a, b) => collator.compare(a, b));
    const width = english.split(" ").length;
    const spans = [];
    for (let i = 0; i < positions.length; i += width) spans.push(positions.slice(i, i + width));
    if (!positions.length && !(record.occurrences || []).length) spans.push(["context", sense.contextKey]);
    for (const span of spans) {
      if (span.every((id) => covered.has(id))) continue;
      span.forEach((id) => covered.add(id));
      marks.push({
        id: key(record.id, span),
        chinese: sense.meaningSource === "pending-context" ? "" : String(sense.meaning || "").trim(),
        confirmed: !["pending-context", "dictionary-fallback"].includes(sense.meaningSource),
      });
    }
  }
  const remaining = [...new Set((record.occurrences || []).filter((id) => id && !covered.has(id)))];
  for (const position of remaining.length ? remaining : senses.length ? [] : [record.occurrenceId || null]) {
    marks.push({
      id: key(record.id, position == null ? ["legacy"] : [position]),
      chinese: /^(?:pending-context|context-ai|manual-context|dictionary-fallback)$/.test(record.meaning)
        ? "" : String(record.meaning || "").trim(),
      confirmed: true,
    });
  }
  return marks.map((mark) => ({ ...mark, english, articleId: article.id }));
}

export function buildUnknownWordStats(records, username) {
  const articles = new Map();
  const marks = new Map();
  const formsByMeaning = new Map();
  const candidatesByMeaning = new Map();
  for (const record of records) {
    if (!username || record?.username !== username) continue;
    const english = normalizeUnknownListTerm(record.normalizedWord) || normalizeUnknownListTerm(record.word);
    if (!english) continue;
    const article = unknownArticle(record);
    const existing = articles.get(article.id);
    const updatedAt = Number(record.updatedAt || record.createdAt) || 0;
    if (!existing || updatedAt > existing.updatedAt) articles.set(article.id, { ...article, updatedAt });
    for (const mark of contextualMarks(record, english, article)) {
      mark.meaningKey = meaningKey(mark.chinese);
      marks.set(mark.id, mark);
      if (!mark.confirmed || !mark.meaningKey) continue;
      if (!formsByMeaning.has(mark.meaningKey)) formsByMeaning.set(mark.meaningKey, new Set());
      const forms = formsByMeaning.get(mark.meaningKey);
      if (forms.has(english)) continue;
      forms.add(english);
      if (!candidatesByMeaning.has(mark.meaningKey)) candidatesByMeaning.set(mark.meaningKey, new Map());
      const candidates = candidatesByMeaning.get(mark.meaningKey);
      for (const root of new Set(roots(english))) {
        candidates.set(root, (candidates.get(root) || 0) + 1);
      }
    }
  }

  const frequencies = new Map();
  for (const mark of marks.values()) {
    const [head, ...candidates] = roots(mark.english);
    const knownForms = formsByMeaning.get(mark.meaningKey);
    const confirmed = mark.confirmed && mark.meaningKey;
    const matchingForms = confirmed ? candidates.find((root) => knownForms?.has(root)) : undefined;
    const rootSupport = candidatesByMeaning.get(mark.meaningKey);
    // Two distinct forms with a common candidate and the same gloss can match even without a saved base form.
    const sharedRoot = confirmed ? [head, ...candidates].find((root) => rootSupport?.get(root) > 1) : undefined;
    const family = confirmed ? matchingForms || sharedRoot || head : mark.english;
    mark.familyKey = key(family, mark.meaningKey, confirmed ? "" : "unconfirmed");
    mark.entryKey = key(mark.english, mark.meaningKey);
    frequencies.set(mark.familyKey, (frequencies.get(mark.familyKey) || 0) + 1);
  }
  const sortedArticles = [...articles.values()].sort(compareUnknownArticles);
  return {
    marks: [...marks.values()],
    articles: sortedArticles,
    articleRank: new Map(sortedArticles.map((article, index) => [article.id, index])),
    frequencies,
  };
}

function entriesFor(stats, marks, groupKey) {
  const entries = new Map();
  for (const mark of marks) {
    const id = mark[groupKey];
    let entry = entries.get(id);
    if (!entry) {
      entry = { wordId: "unknown:" + mark.english, english: mark.english, chinese: mark.chinese, sources: new Set(), groups: new Map() };
      entries.set(id, entry);
    }
    entry.sources.add(mark.articleId);
    const count = stats.frequencies.get(mark.familyKey);
    entry.groups.set(mark.familyKey, { meaning: mark.chinese, count, family: mark.familyKey });
  }
  return [...entries.values()].map((entry) => {
    const sources = [...entry.sources].sort((a, b) => stats.articleRank.get(a) - stats.articleRank.get(b));
    const groups = [...entry.groups.values()].sort((a, b) => b.count - a.count || compareEnglish(a.family, b.family));
    return { ...entry, sources, groups, rank: stats.articleRank.get(sources[0]), count: groups[0].count };
  });
}

function sortEntries(entries, order) {
  return entries.sort((a, b) => (order === "frequency"
    ? b.count - a.count || compareEnglish(a.groups[0]?.family, b.groups[0]?.family)
    : order === "article" ? a.rank - b.rank : 0)
    || compareEnglish(a.english, b.english) || collator.compare(a.chinese, b.chinese));
}

export function unknownMemoryOrder(words, stats, order) {
  const byWord = new Map(entriesFor(stats, stats.marks, "english").map((entry) => [entry.wordId, entry]));
  return sortEntries(words.map((word) => {
    const entry = byWord.get(word.wordId);
    return { ...word, rank: entry?.rank ?? Infinity, groups: entry?.groups || [], count: entry?.count || 0, sources: entry?.sources || [] };
  }), order);
}

export function unknownExportSelection(stats, articles, state, exported, order) {
  const marks = stats.marks.filter((mark) => articles.has(mark.articleId)
    && (state === "all" || exported.has(mark.id) === (state === "exported")));
  return { marks, entries: sortEntries(entriesFor(stats, marks, "entryKey"), order) };
}

const currentUser = "kaoyan_vocab_current_user";
const userPrefix = (username) => "wuliao:user:" + encodeURIComponent(username) + ":wuliao:unknown-library-";
const batchPrefix = (username) => userPrefix(username) + "export-batch:";
const eventName = "wuliao:unknown-export-updated";

export function readUnknownSort(username, surface) {
  const value = localStorage.getItem(userPrefix(username) + "sort:" + surface);
  return UNKNOWN_SORTS.some(([id]) => id === value) ? value : "alphabetical";
}

export function saveUnknownSort(username, surface, value) {
  if (localStorage.getItem(currentUser)?.trim() === username) {
    localStorage.setItem(userPrefix(username) + "sort:" + surface, value);
  }
}

export function readUnknownExportHistory(username) {
  const prefix = batchPrefix(username);
  const batches = [];
  const exported = new Set();
  for (const storageKey of Object.keys(localStorage)) {
    if (!storageKey.startsWith(prefix) || storageKey.endsWith(":undone")) continue;
    try {
      const batch = JSON.parse(localStorage.getItem(storageKey));
      if (!Array.isArray(batch?.marks) || localStorage.getItem(storageKey + ":undone")) continue;
      batches.push({ ...batch, id: storageKey.slice(prefix.length) });
      batch.marks.forEach((mark) => exported.add(mark));
    } catch { /* A malformed account entry can be skipped. */ }
  }
  return { batches: batches.sort((a, b) => b.createdAt - a.createdAt || compareEnglish(b.id, a.id)), exported };
}

export function recordUnknownExport(username, marks, type) {
  if (localStorage.getItem(currentUser)?.trim() !== username) throw new Error("账号已切换");
  if (!marks.length) return;
  const id = crypto.randomUUID();
  localStorage.setItem(batchPrefix(username) + id, JSON.stringify({
    type, createdAt: Date.now(), marks: marks.map((mark) => mark.id),
  }));
  window.dispatchEvent(new Event(eventName));
}

export function undoUnknownExport(username, id) {
  if (localStorage.getItem(currentUser)?.trim() !== username) throw new Error("账号已切换");
  const storageKey = batchPrefix(username) + id;
  if (!localStorage.getItem(storageKey)) return;
  // Keep the undo in backups so merging a backup cannot resurrect a reverted batch.
  localStorage.setItem(storageKey + ":undone", "1");
  window.dispatchEvent(new Event(eventName));
}


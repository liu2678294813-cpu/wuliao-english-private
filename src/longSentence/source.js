import { postgraduateResources } from "../library.js";
import { listCustomPdfs, listUnknownWords } from "../storage.js";
import { getCurrentUsername, listUserItems } from "../userData.js";
import { listLearnedSourceEntries, resolveSentenceKeys } from "../readingReview.js";
import { listNeedsReviewSentenceKeys, sentenceTextFingerprint } from "../translationProgress.js";
import { normalizeUnknownWord } from "../unknownWords.js";
import { loadOfficialAnalysis } from "../officialAnalysis.js";

const PROGRESS_PREFIX = "wuliao:translation-progress:";

export function sourceReviewIdFor({ resourceId, passageId, sentenceKey }) {
  return JSON.stringify([String(resourceId || ""), String(passageId || ""), String(sentenceKey || "")]);
}

function difficultProgressByResource() {
  const byResource = new Map();
  for (const { key, value } of listUserItems(PROGRESS_PREFIX)) {
    try {
      const progress = JSON.parse(value);
      const resourceId = String(progress?.resourceId || "");
      const passageId = String(progress?.passageId || "");
      if (!resourceId || !passageId || key !== `${PROGRESS_PREFIX}${resourceId}:${passageId}`) continue;
      const sentenceKeys = listNeedsReviewSentenceKeys(progress);
      if (!sentenceKeys.length) continue;
      if (!byResource.has(resourceId)) byResource.set(resourceId, []);
      byResource.get(resourceId).push({ passageId, sentenceKeys });
    } catch {
      // Damaged original progress is ignored; no synthetic training source is made.
    }
  }
  return byResource;
}

async function analysisFor(resource, signal) {
  if (resource.kind === "custom") {
    if (resource.conversionStatus !== "ready" || !resource.analysis?.passages?.length) {
      throw new Error("自定义资料尚未完成解析");
    }
    return resource.analysis;
  }
  return loadOfficialAnalysis(resource, { signal });
}

function sourceBase(resource, passageId, sentenceKey) {
  return {
    sourceReviewId: sourceReviewIdFor({ resourceId: resource.id, passageId, sentenceKey }),
    resourceId: resource.id,
    passageId,
    sentenceKey,
    year: resource.year || null,
    chapter: resource.text ? `Text ${resource.text}` : resource.title || "",
    resourceTitle: resource.title || "未命名资料",
  };
}

function articleTextFor(passage) {
  return String(passage?.text || passage?.content || (passage?.paragraphs || [])
    .map((paragraph) => paragraph.text || (paragraph.sentences || []).join(" "))
    .filter(Boolean).join("\n\n")).trim();
}

// 只扫描已经有原句困难事实的文章；解析失败的来源留在树中并禁止生成。
export async function listDifficultSources({ resources = postgraduateResources, customPdfs, signal } = {}) {
  const customs = customPdfs ?? await listCustomPdfs();
  const owner = getCurrentUsername();
  const all = [...resources, ...customs.filter((resource) => !resource.username || resource.username === owner)];
  const progressByResource = difficultProgressByResource();
  const output = [];
  for (const resource of all) {
    if (signal?.aborted) throw signal.reason || new Error("已取消来源读取");
    const progressEntries = progressByResource.get(String(resource.id || "")) || [];
    if (!progressEntries.length) continue;
    let analysis;
    let error = "";
    try { analysis = await analysisFor(resource, signal); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    for (const { passageId, sentenceKeys } of progressEntries) {
      const passage = analysis?.passages?.find((item) => String(item.id) === passageId);
      const resolved = passage ? resolveSentenceKeys(passage, sentenceKeys) : sentenceKeys.map((key) => ({ key, status: "unresolved" }));
      for (const item of resolved) {
        const base = sourceBase(resource, passageId, item.key);
        const status = item.status === "resolved" ? "resolved" : error ? "source_unavailable" : "text_changed";
        output.push({
          ...base,
          articleLabel: passage?.label || passage?.title || passageId,
          articleText: passage ? articleTextFor(passage) : "",
          status,
          error: status === "resolved" ? "" : error || "原句在当前文章中无法定位，原文可能已变化",
          text: status === "resolved" ? item.sentenceText : "",
          textFingerprint: status === "resolved" ? sentenceTextFingerprint(item.sentenceText) : "",
          paragraphNumber: item.paragraphNumber ?? null,
          sentenceIndex: item.sentenceIndex ?? null,
        });
      }
    }
  }
  return output;
}

// Entry authority is the original ReviewSession completion evidence, not generic mastered state.
export async function listLearnedSources({ resources = postgraduateResources, customPdfs, signal } = {}) {
  const customs = customPdfs ?? await listCustomPdfs();
  const owner = getCurrentUsername();
  const byResource = new Map([...resources, ...customs.filter((resource) => !resource.username || resource.username === owner)]
    .map((resource) => [String(resource.id), resource]));
  const entries = listLearnedSourceEntries(owner);
  const analysisCache = new Map();
  const output = [];
  for (const entry of entries) {
    if (signal?.aborted) throw signal.reason || new Error("已取消来源读取");
    const { resourceId, passageId, sentenceKey } = entry.sourceRef || {};
    const resource = byResource.get(String(resourceId));
    if (!resource) {
      output.push({ ...entry, sourceReviewId: sourceReviewIdFor(entry.sourceRef), status: "source_unavailable" });
      continue;
    }
    if (!analysisCache.has(resourceId)) {
      try { analysisCache.set(resourceId, { analysis: await analysisFor(resource, signal) }); }
      catch (error) { analysisCache.set(resourceId, { error: error instanceof Error ? error.message : String(error) }); }
    }
    const loaded = analysisCache.get(resourceId);
    const passage = loaded.analysis?.passages?.find((item) => String(item.id) === String(passageId));
    const resolved = passage ? resolveSentenceKeys(passage, [sentenceKey])[0] : null;
    const sameText = resolved?.status === "resolved"
      && sentenceTextFingerprint(resolved.sentenceText) === sentenceTextFingerprint(entry.sourceSnapshot?.text);
    output.push({
      ...sourceBase(resource, passageId, sentenceKey),
      ...entry,
      articleLabel: passage?.label || passage?.title || passageId,
      articleText: passage ? articleTextFor(passage) : "",
      text: sameText ? resolved.sentenceText : entry.sourceSnapshot?.text || "",
      textFingerprint: sameText ? sentenceTextFingerprint(resolved.sentenceText) : "",
      status: sameText ? "resolved" : loaded.error ? "source_unavailable" : "text_changed",
      error: sameText ? "" : loaded.error || "当前资料中的原句已变化",
    });
  }
  return output;
}

export function aggregateSelectedWords(records, sources, selectedSourceIds = sources.map((source) => source.sourceReviewId)) {
  const selected = new Set(selectedSourceIds);
  const articleIds = new Set(sources.filter((source) => selected.has(source.sourceReviewId) && source.status === "resolved")
    .map((source) => JSON.stringify([source.resourceId, source.passageId])));
  const words = new Map();
  for (const record of records || []) {
    if (!articleIds.has(JSON.stringify([record.resourceId, record.passageId]))) continue;
    const normalized = normalizeUnknownWord(record.normalizedWord || record.word);
    if (!normalized) continue;
    const ref = {
      recordId: record.id,
      resourceId: record.resourceId,
      passageId: record.passageId,
      passageLabel: record.passageLabel || "",
      chapter: record.chapter || "",
      occurrences: [...new Set(Array.isArray(record.occurrences) ? record.occurrences : [])],
    };
    const existing = words.get(normalized);
    if (existing) {
      existing.refs.push(ref);
      if (!existing.meaning && record.meaning) existing.meaning = record.meaning;
    } else {
      words.set(normalized, {
        wordId: normalized,
        word: record.word || normalized,
        normalizedWord: normalized,
        meaning: record.meaning || "",
        refs: [ref],
      });
    }
  }
  return [...words.values()].sort((a, b) => a.wordId.localeCompare(b.wordId));
}

export async function listSelectedWords({ sources = [], selectedSourceIds, unknownWords } = {}) {
  const records = unknownWords ?? await listUnknownWords();
  return aggregateSelectedWords(records, sources, selectedSourceIds);
}

export function selectionState(sources, selectedSourceIds) {
  const ids = new Set(selectedSourceIds || []);
  const total = sources.length;
  const selectedCount = sources.filter((source) => ids.has(source.sourceReviewId)).length;
  return { selectedCount, total, checked: total > 0 && selectedCount === total, indeterminate: selectedCount > 0 && selectedCount < total };
}

export function groupSourcesTree(sources) {
  const chapters = new Map();
  for (const source of sources || []) {
    const chapterId = source.year ? `year:${source.year}` : `custom:${source.resourceId}`;
    const sectionId = String(source.resourceId);
    const articleId = JSON.stringify([source.resourceId, source.passageId]);
    if (!chapters.has(chapterId)) chapters.set(chapterId, {
      id: chapterId, label: source.year ? `${source.year} 英语（一）` : "自定义资料", sections: new Map(),
    });
    const chapter = chapters.get(chapterId);
    if (!chapter.sections.has(sectionId)) chapter.sections.set(sectionId, {
      id: sectionId, label: source.resourceTitle || source.chapter || sectionId, articles: new Map(),
    });
    const section = chapter.sections.get(sectionId);
    if (!section.articles.has(articleId)) section.articles.set(articleId, {
      id: articleId, label: source.articleLabel || source.passageId, text: source.articleText || "", sentences: [],
    });
    section.articles.get(articleId).sentences.push(source);
  }
  return [...chapters.values()].map((chapter) => ({
    ...chapter,
    sections: [...chapter.sections.values()].map((section) => ({ ...section, articles: [...section.articles.values()] })),
  }));
}

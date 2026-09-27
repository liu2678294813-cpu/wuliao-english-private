// 完形陌生词接入 —— 与精读共享同一个陌生词库（IndexedDB `unknown-words`）。
//
// 原则：
//   - 不新建第二套生词库 / DB / store，不升级 IndexedDB version，不迁移旧记录。
//   - 主键语义保持 `username + resourceId + passageId + normalizedWord` 不变。
//   - 新记录只增加可选元数据：sourceType / clozeId / sentenceKey / blankNumber /
//     sourceLabel。旧记录缺失 sourceType 时一律按精读 (reading) 处理。
//   - 阶段门控由调用方（ClozeReader）保证为两态：初做 / 自主复查 / 统一订正
//     整个陌生词入口隐藏；逐空精析 / 全文回读 100% 精读完整能力（标记 / 释义 /
//     AI / 人工补充），不存在 mark-only 中间态。
//   - 标记 / 释义交互不再由本模块实现：ClozeReader 直接消费共享
//     unknownWordInteraction（hit-test / highlight / beforeInk* 钩子）与
//     storage.toggleUnknownWord，本模块只保留完形专属的 entry 元数据构建。

export const UNKNOWN_SOURCE_CLOZE = "cloze";
export const UNKNOWN_SOURCE_READING = "reading";

// 旧记录无 sourceType → reading（兼容规则）。
export function unknownWordSourceType(record) {
  return record?.sourceType === UNKNOWN_SOURCE_CLOZE
    ? UNKNOWN_SOURCE_CLOZE
    : UNKNOWN_SOURCE_READING;
}

// 完形没有 passage 概念，passageId 用稳定占位符，与精读 passage.id 不冲突。
export function clozePassageId(resource) {
  return "cloze";
}

export function clozeWordChapter(resource) {
  return "完形填空";
}

export function clozeSourceLabel(resource) {
  return String(resource?.title || "");
}

// 完形陌生词 entry 构建（纯函数）。
export function buildClozeUnknownEntry({
  resource,
  word,
  normalizedWord,
  occurrenceId,
  meaning = "",
}) {
  return {
    resourceId: String(resource?.id || ""),
    passageId: clozePassageId(resource),
    passageLabel: String(resource?.title || ""),
    year: resource?.year || null,
    chapter: clozeWordChapter(resource),
    word,
    normalizedWord,
    meaning,
    occurrenceId,
    sourceType: UNKNOWN_SOURCE_CLOZE,
    clozeId: String(resource?.id || ""),
    sourceLabel: clozeSourceLabel(resource),
  };
}

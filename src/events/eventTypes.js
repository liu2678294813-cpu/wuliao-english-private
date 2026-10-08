/**
 * 应用事件契约：事件名集中定义，禁止在业务代码中散落魔法字符串。
 *
 * 命名规则：
 *   - wuliao:learning-*         学习状态类（Snapshot 失效、复习任务变更）
 *   - wuliao:ai-*               AI 请求与学习档案
 *   - wuliao:reader-*           精读器内部通知
 *   - wuliao:translation-review 翻译批改状态
 *   - wuliao:account-changed    账号切换（全 App 广播）
 *
 * 迁移原则：既有业务模块仍可继续导出自己的常量名（例如
 * REVIEW_TASKS_UPDATED），但其值必须与本表一致；新代码一律引用本表。
 */

export const AppEvent = Object.freeze({
  ACCOUNT_CHANGED: "wuliao:account-changed",

  REVIEW_TASKS_UPDATED: "wuliao:review-tasks-updated",
  CLOZE_REVIEW_TASKS_UPDATED: "wuliao:cloze-review-tasks-updated",
  RANK_UPDATED: "wuliao:rank-updated",
  UNKNOWN_WORDS_UPDATED: "wuliao:unknown-words-updated",
  STUDY_PLAN_UPDATED: "wuliao:study-plan-updated",

  LEARNING_RECORDS_UPDATED: "wuliao:learning-records-updated",
  LEARNING_RECORDS_SAVE_FAILED: "wuliao:learning-records-save-failed",
  DEEP_TRANSLATION_UPDATED: "wuliao:deep-translation:updated",
  LEARNING_STATE_INVALIDATED: "wuliao:learning-state-invalidated",
  VOCABULARY_SESSION_UPDATED: "wuliao:vocabulary-session-updated",

  AI_REQUEST: "wuliao:ai-request",
  AI_HINT_NEXT: "wuliao:ai-hint-next",
  LEARNING_ARCHIVE_JUMP: "wuliao:learning-archive-jump",
  READER_TOAST: "wuliao:reader-toast",
  TRANSLATION_REVIEW_START: "wuliao:translation-review:start",
  TRANSLATION_REVIEW_FINISH: "wuliao:translation-review:finish",
});

export const AppEventName = new Set(Object.values(AppEvent));

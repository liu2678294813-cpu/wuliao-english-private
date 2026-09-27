/**
 * LearningStateSnapshot —— R3 学习状态快照。
 *
 * 性质（严格遵守）：
 *   - 只读运行时 derived cache：从 localStorage / IndexedDB / 业务模块聚合；
 *   - 绝不成为新的持久化数据源，不新增 storage key，不迁移任何学习数据；
 *   - 按账号隔离（username 参与缓存键与校验），切换账号后旧快照立即失效；
 *   - 可失效（LEARNING_STATE_INVALIDATED 等业务事件）、可强制刷新、可测试。
 *
 * 业务规则（Planner / Rank 等）不进入本模块：调用方拿到 scan 数据后
 * 各自计算业务结果。本模块只负责“聚合一次、共享多次”。
 */

import { getCurrentUsername } from "./userData";
import {
  getLearningScanCount,
  getLearningScanRevision,
  scanLearningState,
} from "./todayTasks";

/**
 * 返回当前账号的运行时学习快照。
 *
 * - force: true 时强制重新扫描（首次进入、前台恢复、账号切换后使用）；
 * - force: false 时优先返回同一账号/同一日期的缓存结果；
 * - revision 与 scan 成对返回：revision 在缓存写入时固化，调用方可用它
 *   判断结果是否过期（stale async 结果不得覆盖新 revision）。
 */
export function getLearningSnapshot({ today, force = false } = {}) {
  const username = getCurrentUsername();
  const scan = scanLearningState({ today, force });
  return {
    username,
    today: scan.today,
    revision: getLearningScanRevision(),
    scan,
  };
}

export function getLearningSnapshotRevision() {
  return getLearningScanRevision();
}

export function getLearningSnapshotScanCount() {
  return getLearningScanCount();
}

/**
 * 判断快照是否已被更新的 revision 取代。
 * 异步流程发起请求时保存 snapshot 引用，settle 后先调用本函数：
 * 若已过期，禁止把旧结果写回任何以新 snapshot 为准的 UI/派生状态。
 */
export function isSnapshotStale(snapshot) {
  return Boolean(snapshot)
    && snapshot.revision !== getLearningScanRevision();
}

/**
 * 用户安全删除服务 — 平台层能力
 *
 * 删除用户前检查该用户是否还有活跃的平台任务（PENDING / LEASED / RUNNING / RETRY_SCHEDULED），
 * 如有则拒绝删除并返回 409 + 活跃任务摘要。
 *
 * 设计决策：
 * - 此约束依赖平台任务状态 project_tasks，不是单纯的业务用户状态，属于平台不变量。
 * - 回滚补偿路径（注册失败后的 deleteUser）不经过此检查，因为那是事务补偿，正常不会有任务。
 */

import { taskRepository } from "../repositories/task.repository";
import { logger } from "../utils/logger";

export interface ActiveTasksCheckResult {
  /** 是否允许安全删除 */
  safe: boolean;
  /** 活跃任务数 */
  activeTaskCount: number;
  /** 活跃任务摘要（最多 100 条） */
  activeTasks: Array<{ id: string; task_type: string; status: string }>;
}

/**
 * 检查指定项目内某用户是否有活跃的平台任务。
 *
 * @param projectRef 项目 ref
 * @param userId 用户 ID（对应 payload.auth.invoker_user_id）
 * @returns 检查结果：safe=true 表示无活跃任务，可以安全删除
 */
export async function checkUserActiveTasks(
  projectRef: string,
  userId: string,
): Promise<ActiveTasksCheckResult> {
  try {
    const { count, tasks } = await taskRepository.countActiveTasksByInvoker(projectRef, userId);
    return {
      safe: count === 0,
      activeTaskCount: count,
      activeTasks: tasks,
    };
  } catch (err) {
    // 查询失败时安全降级：记录警告但不阻止删除，避免因任务系统不可用而阻塞用户管理
    logger.warn(
      `[UserSafety] Failed to check active tasks for user ${userId} in project ${projectRef}, allowing delete (degraded): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      safe: true,
      activeTaskCount: 0,
      activeTasks: [],
    };
  }
}

export const userSafetyService = {
  checkUserActiveTasks,
};

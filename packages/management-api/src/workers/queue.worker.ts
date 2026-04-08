import { logger } from "../utils/logger";
import { config } from "../config";
import { db, TaskStatus } from "../db/index";
import { createPgListener, type PgListenerHandle } from "../utils/pg-listen";

/**
 * 这是一个通用的长周期任务/消息队列底座 (Queue Base)
 * 基于原生 PostgreSQL LISTEN/NOTIFY 的事件驱动架构实现。
 * 为类似消息队列、MQTT、以及后台模型生成等长时间连接的异步服务提供统一调度。
 */
export class QueueWorker {
  private listener: PgListenerHandle | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  public start() {
    logger.info("[QueueWorker] Starting foundation queue worker...");

    // 1. 建立 LISTEN/NOTIFY 监听
    this.listener = createPgListener(
      config.databaseUrl,
      ["task_pending"], // `project_tasks` 触发器通过 `task_pending` 广播插入事件
      (channel, payload) => {
        logger.debug(`[QueueWorker] Received event on ${channel}: ${payload}`);
        if (channel === "task_pending") {
          // 收到新任务立刻丢进微任务/异步池触发处理，防阻塞 Socket 收包
          setImmediate(() => this.triggerSweep());
        }
      }
    );

    // 2. 启动 10s 定时兜底扫描
    // 防止网络抖动断连丢包（LISTEN 无法感知连接断开期间插入的记录）
    this.intervalTimer = setInterval(() => {
      this.triggerSweep();
    }, 10_000);

    // 3. 服务启动时的首扫（处理启动前积压数据）
    this.triggerSweep();
  }

  public stop() {
    logger.info("[QueueWorker] Stopping foundation queue worker...");
    if (this.listener) {
      this.listener.close();
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
  }

  /**
   * 触发执行器
   * 负责拉起循环防止重入（Re-entrancyLock）
   */
  private triggerSweep() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    // 不用 await 直接 catch，避免阻塞发起方
    this.processPendingTasks()
      .catch((error) => {
        logger.error("[QueueWorker] Error during sweep:", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.isProcessing = false;
      });
  }

  private async processPendingTasks() {
    // 每次限制 10 条处理，并发过高可能引发数据库连接池拥堵
    // FOR UPDATE SKIP LOCKED 解决单点 / 多节点部署下的排它锁读：只能拿到没被其他进程锁住的记录
    const tasks = await db.sql`
      SELECT id, project_ref, task_type, payload 
      FROM project_tasks 
      WHERE status = 'pending'
      ORDER BY created_at ASC 
      LIMIT 10
      FOR UPDATE SKIP LOCKED;
    `;

    if (tasks.length === 0) {
      return;
    }

    logger.info(`[QueueWorker] Fetched ${tasks.length} pending tasks from queue.`);

    // 串行执行或并行执行，考虑到长周期特性，这里可以采用串形或者限制 Promise.all()
    for (const task of tasks) {
      try {
        await this.processTask(task);
      } catch (e) {
        logger.error(`[QueueWorker] Failed to process task ${task.id}`, { error: e instanceof Error ? e.message : String(e) });
        await db.sql`
          UPDATE project_tasks 
          SET 
            status = 'failed', 
            error = ${e instanceof Error ? e.message : String(e)}, 
            updated_at = NOW()
          WHERE id = ${task.id}
        `;
      }
    }

    // 如果一次直接拉满了 10 个，说明大概率队列里还有数据，直接连环追击
    if (tasks.length === 10) {
      setImmediate(() => this.triggerSweep());
    }
  }

  /**
   * 按业务策略处理具体单一任务
   */
  private async processTask(task: any) {
    // 锁定状态 (从 pending -> processing)
    // 注意：虽然 SKIP LOCKED 锁了该行，但状态机更新能够使得其他扫描跳过它
    await db.sql`
      UPDATE project_tasks
      SET status = 'processing', updated_at = NOW()
      WHERE id = ${task.id}
    `;

    logger.debug(`[QueueWorker] Executing dispatch for task [${task.task_type}] ID: ${task.id}`);

    const taskType = String(task.task_type);
    const payload = task.payload as Record<string, any>;
    
    // ----- TASK DISPATCHER (业务分发路由) -----
    if (taskType.startsWith('ai_')) {
        // [AI 引擎调度] eg. 'ai_generation', 'ai_vision', etc.
        logger.info(`[QueueWorker] Dispatching AI Inference Task: ${task.id}`);
        // TODO: 接入 SiliconFlow SDK，或是其他的远程 RPC 调用
        await Bun.sleep(1000); // 占位逻辑
    } 
    else if (taskType === 'mqtt_event' || taskType === 'ws_push') {
        // [通讯底座调度] 长连接/消息队列的推送与消息下发
        logger.info(`[QueueWorker] Delivering Web/MQTT messaging payload for Task: ${task.id}`);
        await Bun.sleep(200); // 占位逻辑
    } 
    else {
        // [管理层底座调度] 例如 provision_db, provision_s3 等基础设施任务 
        logger.info(`[QueueWorker] Processing infrastructure task [${taskType}] for Project [${task.project_ref}]`);
        await Bun.sleep(500); // 占位逻辑
    }

    // 更新任务完成
    await db.sql`
      UPDATE project_tasks
      SET status = 'completed', updated_at = NOW()
      WHERE id = ${task.id}
    `;
    logger.info(`[QueueWorker] Processed completely: Task [${task.task_type}] ID: ${task.id}.`);
  }
}

// 单例模式，提供优雅启动与退出钩子
const workerInstances: QueueWorker[] = [];

export function startQueueWorker() {
  const worker = new QueueWorker();
  worker.start();
  workerInstances.push(worker);
}

export function stopQueueWorker() {
  for (const worker of workerInstances) {
    worker.stop();
  }
  workerInstances.length = 0;
}

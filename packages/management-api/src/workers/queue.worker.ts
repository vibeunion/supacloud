import { logger } from "../utils/logger";
import { config } from "../config";
import { db } from "../db/index";
import { createPgListener, type PgListenerHandle } from "../lib/pg-listen";

/**
 * A general-purpose long-running task / message queue foundation (Queue Base)
 * Implemented based on native PostgreSQL LISTEN/NOTIFY event-driven architecture.
 * Provides unified scheduling for long-lived asynchronous services like message queues, MQTT, and background AI model generation.
 */
export class QueueWorker {
  private listener: PgListenerHandle | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  public start() {
    logger.info("[QueueWorker] Starting foundation queue worker...");

    // 1. Establish LISTEN/NOTIFY subscription
    this.listener = createPgListener({
      url: config.databaseUrl,
      channels: ["task_pending"], // `project_tasks` trigger broadcasts insert events via `task_pending`
      onNotification: (channel, payload) => {
        logger.debug(`[QueueWorker] Received event on ${channel}: ${payload}`);
        if (channel === "task_pending") {
          // Immediately dispatch new tasks to the microtask/async pool to prevent blocking the socket
          setImmediate(() => this.triggerSweep());
        }
      },
      applicationName: "supacloud-queue-worker",
    });

    // 2. Start a 10s fallback sweep timer
    // Prevents missed events due to network jitter/disconnects (LISTEN cannot detect records inserted during disconnects)
    this.intervalTimer = setInterval(() => {
      this.triggerSweep();
    }, 10_000);

    // 3. Initial sweep on service startup (to process any backlogged data)
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
   * Trigger the executor
   * Responsible for initiating the loop and preventing re-entrancy (Re-entrancyLock)
   */
  private triggerSweep() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    // Catch errors without await to avoid blocking the caller
    this.processPendingTasks()
      .catch((error) => {
        logger.error("[QueueWorker] Error during sweep:", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.isProcessing = false;
      });
  }

  private async processPendingTasks() {
    // Limit to 10 records per batch; excessive concurrency could cause database connection pool congestion
    // FOR UPDATE SKIP LOCKED solves exclusive partial locking in single/multi-node deployments: only fetches records not locked by other processes
    const tasks = await db.sql`
      SELECT id, project_ref, task_type, payload 
      FROM project_tasks 
      WHERE status = 'pending'
        AND (
          task_type LIKE 'ai\_%' ESCAPE '\'
          OR task_type IN ('mqtt_event', 'ws_push')
        )
      ORDER BY created_at ASC 
      LIMIT 10
      FOR UPDATE SKIP LOCKED;
    `;

    if (tasks.length === 0) {
      return;
    }

    logger.info(`[QueueWorker] Fetched ${tasks.length} pending tasks from queue.`);

    // Serial or parallel execution. Given long-running characteristics, serial execution or rate-limited Promise.all() can be used here.
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

    // If a full batch of 10 was fetched, it's highly likely there is more data in the queue; immediately trigger the next sweep
    if (tasks.length === 10) {
      setImmediate(() => this.triggerSweep());
    }
  }

  /**
   * Process a single specific task based on business logic via strategic dispatch
   */
  private async processTask(task: any) {
    // Lock the status (pending -> processing)
    // Note: Although SKIP LOCKED locks the row, updating the state machine ensures other sweeps skip it
    await db.sql`
      UPDATE project_tasks
      SET status = 'processing', updated_at = NOW()
      WHERE id = ${task.id}
    `;

    logger.debug(`[QueueWorker] Executing dispatch for task [${task.task_type}] ID: ${task.id}`);

    const taskType = String(task.task_type);
    const payload = task.payload as Record<string, any>;
    
    // ----- TASK DISPATCHER (Business Routing) -----
    if (taskType.startsWith('ai_') || taskType === 'edge_function') {
        // [AI Engine Dispatch] eg. 'ai_generation', 'ai_vision', etc.
        logger.info(`[QueueWorker] Dispatching Edge Function / AI Task: ${task.id} for project ${task.project_ref}`);
        
        // We do not directly invoke heavy workloads like SiliconFlow here. Instead, as a foundational mechanism,
        // we POST the task back to the specific Edge Function unique to each tenant's environment.
        // This achieves concurrency control, Token protection, and flexible business isolation.
        const webhookUrl = payload.webhook_url;
        if (webhookUrl) {
           const maxRetries = payload.max_retries || 1;
           let lastError = null;
           for(let i = 0; i < maxRetries; i++) {
             try {
               const res = await fetch(webhookUrl, {
                 method: "POST",
                 headers: {
                   "Content-Type": "application/json",
                   // If the tenant has configured custom Tokens, they can be passed via headers
                   ...(payload.headers || {})
                 },
                 body: JSON.stringify(payload.data || {})
               });
               if (!res.ok) {
                 throw new Error(`Edge Function returned HTTP ${res.status}`);
               }
               logger.info(`[QueueWorker] Webhook dispatch succeeded: ${task.id}`);
               lastError = null;
               break; // Break out of the retry loop upon success
             } catch(err) {
               lastError = err;
               logger.warn(`[QueueWorker] Webhook dispatch attempt ${i+1} failed: ${task.id}`);
               await Bun.sleep(1000);
             }
           }
           if (lastError) throw lastError;
        } else {
           logger.error(`[QueueWorker] Missing webhook_url for AI task ${task.id}`);
           throw new Error("Missing webhook_url in task payload");
        }
    } 
    else if (taskType === 'mqtt_event' || taskType === 'ws_push') {
        // [Communication Foundation Dispatch] Long connections/message queue pushes and dispatch
        logger.info(`[QueueWorker] Delivering Web/MQTT messaging payload for Task: ${task.id}`);
        await Bun.sleep(200); // Placeholder logic
    } 
    else {
        throw new Error(`Unsupported task type for QueueWorker: ${taskType}`);
    }

    // Update task as completed
    await db.sql`
      UPDATE project_tasks
      SET status = 'completed', updated_at = NOW()
      WHERE id = ${task.id}
    `;
    logger.info(`[QueueWorker] Processed completely: Task [${task.task_type}] ID: ${task.id}.`);
  }
}

// Singleton pattern, providing graceful startup and shutdown hooks
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

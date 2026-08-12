import { taskRepository } from "../repositories/task.repository";
import { projectRepository } from "../repositories/project.repository";
import { databaseService } from "./database.service";
import { storageService } from "./storage.service";
import { routerService } from "./router.service";
import { gatewayService } from "./gateway.service";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { logger } from "../utils/logger";
import { createPgListener, type PgListenerHandle } from "../lib/pg-listen";
import { config } from "../config";
import type { Project, ProjectTask } from "../db";
import { resolveDbName, TaskStatus, TaskType } from "../db";
import { broadcastTaskUpdate } from "../routes/ws";
import { realtimeService } from "./realtime.service";
import {
    normalizeProjectRoutingConfig,
    resolveProjectApiHost,
    resolveProjectStudioHost,
} from "../utils/project-routing";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import { runtimeEnvService } from "./runtime-env.service";
import { jwtService } from "./jwt.service";
import { resolveStoredServiceRoleKey } from "../utils/service-role";

async function repairInvalidServiceRoleKey(project: Project): Promise<void> {
    if (resolveStoredServiceRoleKey(project)) return;

    const serviceRoleKey = await jwtService.generateServiceRoleKey(project.jwt_secret);
    await projectRepository.updateApiKeys(project.ref, {
        jwt_secret: project.jwt_secret,
        anon_key: project.anon_key,
        service_role_key: serviceRoleKey,
    });
}

export class TaskWorker {
    private isRunning = false;
    private isProcessing = false;
    private intervalId?: Timer;
    private delayedWakeupId?: Timer;
    private listener?: PgListenerHandle;

    start(intervalMs = 10000) {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info("Starting Task Worker...");

        // Primary: event-driven via PostgreSQL LISTEN/NOTIFY
        try {
            this.listener = createPgListener({
                url: config.databaseUrl,
                channels: ["task_pending", "task_retry_scheduled"],
                onNotification: (channel, payload) => {
                    if (channel === "task_retry_scheduled") {
                        this.scheduleDelayedWakeup(payload);
                        return;
                    }
                    logger.info(`[TaskWorker] NOTIFY received, triggering immediate poll`);
                    this.poll();
                },
            });
        } catch (err: unknown) {
            logger.warn(`[TaskWorker] Failed to start pg-listen, falling back to polling only`, { error: err instanceof Error ? err.message : String(err) });
        }

        // Fallback: 10s safety-net polling (increased from 3s since LISTEN is primary)
        this.intervalId = setInterval(() => this.poll(), intervalMs);
    }

    stop() {
        this.isRunning = false;
        this.listener?.close();
        this.listener = undefined;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        if (this.delayedWakeupId) {
            clearTimeout(this.delayedWakeupId);
            this.delayedWakeupId = undefined;
        }
        logger.info("Task Worker stopped.");
    }

    private scheduleDelayedWakeup(payload?: string) {
        if (!this.isRunning) return;
        const nextRunAt = this.extractNextRunAt(payload);
        if (!nextRunAt) return;
        const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());
        if (this.delayedWakeupId) {
            clearTimeout(this.delayedWakeupId);
        }
        this.delayedWakeupId = setTimeout(() => {
            this.delayedWakeupId = undefined;
            void this.poll();
        }, delayMs);
    }

    private extractNextRunAt(payload?: string): Date | null {
        if (!payload) return null;
        try {
            const parsed = JSON.parse(payload) as { next_run_at?: unknown };
            if (typeof parsed.next_run_at !== "string") return null;
            const nextRunAt = new Date(parsed.next_run_at);
            return Number.isNaN(nextRunAt.getTime()) ? null : nextRunAt;
        } catch {
            return null;
        }
    }

    private async poll() {
        if (!this.isRunning || this.isProcessing) return;
        this.isProcessing = true;

        try {
            const task = await taskRepository.claimNextTask({
                workerId: `task-worker-${process.pid}`,
                concurrencyByProject: 1,
                allowedTaskTypes: [
                    TaskType.PROVISION_DB,
                    TaskType.PROVISION_S3,
                    TaskType.PROVISION_RUNTIME,
                    TaskType.PROVISION_REALTIME,
                    TaskType.PROVISION_ROUTER,
                    TaskType.PROVISION_GATEWAY,
                    TaskType.PROVISION_SECRETS,
                    TaskType.CLEANUP_DB,
                    TaskType.CLEANUP_S3,
                    TaskType.CLEANUP_RUNTIME,
                    TaskType.CLEANUP_REALTIME,
                    TaskType.CLEANUP_ROUTER,
                ],
                leaseSeconds: 600,
            });
            if (!task) return; // No pending tasks

            logger.info(`[TaskWorker] Processing task: ${task.id} (${task.task_type}) for project ${task.project_ref}`);

            // Broadcast task start via WebSocket
            await taskRepository.markTaskRunning(task.id);
            broadcastTaskUpdate({ taskId: task.id, projectRef: task.project_ref, taskType: task.task_type, status: TaskStatus.RUNNING });

            const success = await this.executeTask(task);

            if (success) {
                await taskRepository.markTaskSucceeded(task.id);
                broadcastTaskUpdate({ taskId: task.id, projectRef: task.project_ref, taskType: task.task_type, status: TaskStatus.SUCCEEDED });
                await this.handleTaskCompletion(task);
            } else {
                await this.handleTaskFailure(task);
            }
        } catch (err: unknown) {
            logger.error(`[TaskWorker] Error processing task loop`, { error: err instanceof Error ? err.message : String(err) });
        } finally {
            this.isProcessing = false;
        }
    }

    private async executeTask(task: ProjectTask): Promise<boolean> {
        const { project_ref, task_type, payload } = task;

        // Cleanup tasks don't require project to exist
        const isCleanupTask = task_type.startsWith("cleanup_");

        const project = await projectRepository.findByRef(project_ref);
        if (!project && !isCleanupTask) {
            logger.error(`[TaskWorker] Project ${project_ref} not found for task ${task.id}`);
            return false;
        }

        try {
            switch (task_type) {
                case "provision_db": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_db`);
                        return false;
                    }
                    const res = await databaseService.createDatabase(project_ref, project.db_password);
                    if (!res.success) {
                        logger.error(`[TaskWorker] provision_db failed for ${project_ref}`, { error: res.error });
                        await taskRepository.updateTaskError(task.id, res.error || "Unknown error");
                    }
                    return res.success;
                }

                case "provision_s3": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_s3`);
                        return false;
                    }
                    const res = await storageService.createBucket(project_ref);
                    return res.success;
                }

                case "provision_runtime": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_runtime`);
                        return false;
                    }

                    if (process.env.TEST_FIXED_JWT_SECRET) {
                        logger.info(`[TaskWorker] Running in CI mode, skipping actual runtime provision for ${project_ref}`);
                        await projectRepository.updateConfig(project_ref, mergeProjectConfig(project.config, {
                            postgrest_port: 3000,
                            gotrue_port: 9999,
                            realtime_port: 4000
                        }));
                        return true;
                    }

                    // Start tenant-specific PostgREST process
                    const startRes = await databaseService.startRuntime(project_ref);
                    if (!startRes.success) return false;

                    // Extract port numbers from output
                    const portMatch = startRes.output.match(/PORT=(\d+)/);
                    const gotruePortMatch = startRes.output.match(/GOTRUE_PORT=(\d+)/);
                    const port = portMatch ? portMatch[1] : "";
                    const gotruePort = gotruePortMatch ? gotruePortMatch[1] : "";
                    if (!port || !gotruePort) {
                        logger.error(`[TaskWorker] Cannot determine PostgREST/GoTrue port for ${project_ref}`);
                        return false;
                    }

                    // Register this tenant's independent upstream in the configured gateway
                    const upstreamRes = await databaseService.setupUpstream(project_ref, port, gotruePort);
                    if (!upstreamRes.success) {
                        logger.error(`[TaskWorker] Failed to setup gateway upstream for ${project_ref}`);
                        return false;
                    }

                    // Save ports to project config
                    await projectRepository.updateConfig(project_ref, mergeProjectConfig(project.config, {
                        postgrest_port: parseInt(port),
                        gotrue_port: parseInt(gotruePort),
                    }));

                    logger.info(`[TaskWorker] Runtime started for ${project_ref} on ports (pgrst:${port}, gotrue:${gotruePort})`);
                    return true;
                }

                case "provision_realtime": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_realtime`);
                        return false;
                    }

                    const dbName = await resolveDbName(project_ref);
                    const res = await realtimeService.registerTenant({
                        projectRef: project_ref,
                        jwtSecret: project.jwt_secret,
                        dbName,
                        dbPassword: project.db_password,
                    });
                    if (!res) {
                        logger.error(`[TaskWorker] Failed to provision realtime for ${project_ref}`);
                    }
                    return res;
                }

                case "provision_router": {
                    if (process.env.TEST_FIXED_JWT_SECRET) {
                        logger.info(`[TaskWorker] Running in CI mode, skipping actual router provision for ${project_ref}`);
                        return true;
                    }
                    const routingConfig = normalizeProjectRoutingConfig(
                        normalizeProjectConfig(project?.config),
                    ) || {};
                    if (!routingConfig.custom_domain && typeof payload?.domain === "string" && payload.domain.trim()) {
                        routingConfig.custom_domain = payload.domain.trim();
                    }

                    const domains = routingConfig.custom_domain || routingConfig.api_domain || routingConfig.studio_domain
                        ? {
                            apiDomain: resolveProjectApiHost(project_ref, routingConfig),
                            studioDomain: resolveProjectStudioHost(project_ref, routingConfig),
                        }
                        : undefined;

                    const res = await routerService.addRoute(project_ref, domains);
                    // API driven gateway no longer requires reload
                    return res.success;
                }

                case "provision_gateway": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_gateway`);
                        return false;
                    }
                    if (process.env.TEST_FIXED_JWT_SECRET) {
                        logger.info(`[TaskWorker] Running in CI mode, skipping actual gateway provision for ${project_ref}`);
                        return true;
                    }
                    // Apply JWT credentials, CORS, and rate limiting through the gateway provider
                    try {
                        await gatewayService.setupJwt(project_ref, project.jwt_secret);
                        await gatewayService.setCors(project_ref);
                        await gatewayService.setRateLimit(project_ref, "free");
                        logger.info(`[TaskWorker] Gateway policy configured for ${project_ref}`);
                        return true;
                    } catch (err: unknown) {
                        logger.error(`[TaskWorker] Gateway config failed for ${project_ref}`, { error: err instanceof Error ? err.message : String(err) });
                        return false;
                    }
                }

                case "provision_secrets": {
                    if (!project) {
                        logger.error(`[TaskWorker] Project ${project_ref} not found for provision_secrets`);
                        return false;
                    }
                    await repairInvalidServiceRoleKey(project);
                    const runtimeEnv = await runtimeEnvService.buildProjectRuntimeEnv(project_ref);
                    if (!runtimeEnv) return false;
                    for (const [name, value] of Object.entries(runtimeEnv)) {
                        const ok = await databaseService.upsertSecret(project_ref, name, value);
                        if (!ok) {
                            logger.error(`[TaskWorker] Failed to seed secret ${name} for ${project_ref}`);
                            return false;
                        }
                    }
                    logger.info(`[TaskWorker] Seeded ${Object.keys(runtimeEnv).length} runtime secrets for ${project_ref}`);
                    return true;
                }

                case "cleanup_db": {
                    const res = await databaseService.deleteDatabase(project_ref);
                    return res.success;
                }

                case "cleanup_s3": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    const result = await storageService.deleteBucket(project_ref);
                    if (!result.success) {
                        logger.error(`[TaskWorker] cleanup_s3 failed for ${project_ref}`, {
                            outcome: result.error === "Bucket is not empty" ? "not_empty" : "unknown",
                        });
                    }
                    return result.success;
                }

                case "cleanup_runtime": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    // Stop tenant PostgREST + GoTrue processes and clean config files
                    await tenantRuntimeService.stopRuntime(project_ref);
                    // Remove gateway routes.
                    try {
                        await gatewayService.removeService(project_ref);
                    } catch (e: unknown) {
                        logger.warn(`[TaskWorker] Gateway cleanup failed for ${project_ref} (non-fatal): ${e}`);
                    }
                    return true;
                }

                case "cleanup_realtime": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    const res = await realtimeService.removeTenant(project_ref);
                    return res;
                }

                case "cleanup_router": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    await routerService.removeRoute(project_ref);
                    // API driven gateway no longer requires reload
                    return true;
                }

                default:
                    logger.warn(`[TaskWorker] Unknown task type: ${task_type}`);
                    return false;
            }
        } catch (err: unknown) {
            logger.error(`[TaskWorker] Error executing ${task_type} for ${project_ref}`, { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }

    private async handleTaskCompletion(task: ProjectTask) {
        const { project_ref, task_type } = task;

        // Workflow orchestration: queue the next task upon completion
        // Pipeline: provision_db → provision_s3 → provision_runtime → provision_router → provision_gateway → provision_secrets
        if (task_type === "provision_db") {
            await taskRepository.createTask(project_ref, "provision_s3");
        } else if (task_type === "provision_s3") {
            await taskRepository.createTask(project_ref, "provision_runtime");
        } else if (task_type === "provision_runtime") {
            await taskRepository.createTask(project_ref, "provision_realtime");
        } else if (task_type === "provision_realtime") {
            await taskRepository.createTask(project_ref, "provision_router");
        } else if (task_type === "provision_router") {
            await taskRepository.createTask(project_ref, "provision_gateway");
        } else if (task_type === "provision_gateway") {
            await taskRepository.createTask(project_ref, "provision_secrets");
        } else if (task_type === "provision_secrets") {
            // Final step completed, activate project
            await projectRepository.updateStatus(project_ref, "active");
            logger.info(`[TaskWorker] Project ${project_ref} fully provisioned and activated.`);
        } else if (task_type === "cleanup_runtime") {
            // After runtime cleanup, cleanup realtime
            await taskRepository.createTask(project_ref, "cleanup_realtime");
        } else if (task_type === "cleanup_realtime") {
            // After realtime cleanup, cleanup S3
            await taskRepository.createTask(project_ref, "cleanup_s3");
        } else if (task_type === "cleanup_s3") {
            // After S3 cleanup, cleanup DB
            await taskRepository.createTask(project_ref, "cleanup_db");
        } else if (task_type === "cleanup_db") {
            // After database cleanup, cleanup router
            await taskRepository.createTask(project_ref, "cleanup_router");
        } else if (task_type === "cleanup_router") {
            // Cleanup complete
            logger.info(`[TaskWorker] Project ${project_ref} fully cleaned up.`);
        }
    }

    private async handleTaskFailure(task: ProjectTask) {
        const { project_ref, task_type, retries } = task;
        const failureMessage = "Task execution failed";

        // Realtime is optional for the current tenant model. Preserve DB/runtime
        // and continue the remaining provisioning pipeline instead of blocking on
        // retries or destroying the tenant database after a later-stage addon failure.
        if (task_type === "provision_realtime") {
            await this.recordTerminalFailure(task, failureMessage);
            logger.warn(`[TaskWorker] Realtime provisioning failed for ${project_ref}. Preserving core resources and continuing without realtime.`);
            await taskRepository.createTask(project_ref, "provision_router");
            return;
        }

        // Cleanup tasks get more retries (10) to ensure resources are freed
        const maxRetries = task_type.startsWith("cleanup_") ? 10 : 3;

        if (retries < maxRetries) {
            // Re-queue the failed task with exponential backoff so it is actually
            // retried. Without this the task stays in FAILED forever and the saga
            // compensation below is never reached, stalling the whole pipeline.
            const baseDelayMs = 5_000;
            const cappedAttempt = Math.min(Math.max(retries, 1), 6);
            const nextRunAt = new Date(Date.now() + baseDelayMs * Math.pow(2, cappedAttempt - 1));
            logger.warn(`[TaskWorker] Task ${task_type} for ${project_ref} failed, scheduling retry ${retries + 1}/${maxRetries} at ${nextRunAt.toISOString()}`);
            await taskRepository.scheduleRetry(task.id, failureMessage, nextRunAt);
            broadcastTaskUpdate({ taskId: task.id, projectRef: project_ref, taskType: task_type, status: TaskStatus.RETRY_SCHEDULED, error: failureMessage });
            return;
        }

        await this.recordTerminalFailure(task, failureMessage);
        logger.error(`[TaskWorker] Saga compensation triggered for ${project_ref} failed permanently at ${task_type}`);

        // Mark project as paused/error (Only for critical creation tasks)
        if (task_type === "provision_db" || task_type === "provision_s3" || task_type === "provision_runtime") {
            await projectRepository.updateStatus(project_ref, "paused");
        }

        // Saga Compensation Logic
        if (task_type === "provision_s3" || task_type === "provision_runtime") {
            // If S3 or runtime provision failed, we need to rollback DB and S3
            logger.info(`[TaskWorker] Rolling back resources for ${project_ref} due to provisioning failure.`);
            await taskRepository.createTask(project_ref, "cleanup_runtime");
            await taskRepository.createTask(project_ref, "cleanup_s3");
            await taskRepository.createTask(project_ref, "cleanup_db");
        } else if (task_type.startsWith("cleanup_")) {
            // Cleanup failed permanently after all retries
            logger.error(`[TaskWorker] CRITICAL: Cleanup task ${task_type} for ${project_ref} failed permanently after ${maxRetries} retries. Manual intervention required!`);
        } else if (task_type === "provision_router" || task_type === "provision_gateway") {
            // When router/gateway fails, preserve DB and S3 resources to avoid data loss
            // Admin can manually troubleshoot and retry, or trigger cleanup via API
            logger.warn(`[TaskWorker] ${task_type} failed for ${project_ref}. DB and S3 resources preserved for manual intervention.`);
        }
    }

    private async recordTerminalFailure(task: ProjectTask, failureMessage: string): Promise<void> {
        await taskRepository.markTaskFailed(task.id, failureMessage);
        broadcastTaskUpdate({
            taskId: task.id,
            projectRef: task.project_ref,
            taskType: task.task_type,
            status: TaskStatus.FAILED,
            error: failureMessage,
        });
    }
}

export const taskWorker = new TaskWorker();

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
import type { ProjectTask } from "../db";
import { resolveDbName, TaskStatus, TaskType } from "../db";
import { broadcastTaskUpdate } from "../routes/ws";
import { realtimeService } from "./realtime.service";
import {
    normalizeProjectRoutingConfig,
    resolveProjectApiHost,
    resolveProjectApiUrl,
    resolveProjectStudioHost,
} from "../utils/project-routing";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";

export class TaskWorker {
    private isRunning = false;
    private isProcessing = false;
    private intervalId?: Timer;
    private listener?: PgListenerHandle;

    start(intervalMs = 10000) {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info("Starting Task Worker...");

        // Primary: event-driven via PostgreSQL LISTEN/NOTIFY
        try {
            this.listener = createPgListener({
                url: config.databaseUrl,
                channels: ["task_pending"],
                onNotification: (_channel, _payload) => {
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
        }
        logger.info("Task Worker stopped.");
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
                await taskRepository.markTaskFailed(task.id, "Task execution failed");
                broadcastTaskUpdate({ taskId: task.id, projectRef: task.project_ref, taskType: task.task_type, status: TaskStatus.FAILED, error: "Task execution failed" });
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

                    // Register this tenant's independent upstream in Kong (declarative)
                    const upstreamRes = await databaseService.setupUpstream(project_ref, port, gotruePort);
                    if (!upstreamRes.success) {
                        logger.error(`[TaskWorker] Failed to setup Kong upstream for ${project_ref}`);
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
                    // Apply JWT credentials, CORS, and rate limiting via Kong Admin API
                    try {
                        await gatewayService.setupJwt(project_ref, project.jwt_secret);
                        await gatewayService.setCors(project_ref);
                        await gatewayService.setRateLimit(project_ref, "free");
                        logger.info(`[TaskWorker] Kong gateway plugins configured for ${project_ref}`);
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
                    // Auto-inject standard environment variables into project_secrets
                    // so Edge Functions can verify JWTs, access Supabase APIs, etc.
                    const routingConfig = normalizeProjectRoutingConfig(
                        normalizeProjectConfig(project.config),
                    );
                    const supabaseUrl = resolveProjectApiUrl(project_ref, routingConfig);
                    const standardSecrets = [
                        { name: "SUPABASE_URL", value: supabaseUrl },
                        { name: "SUPABASE_ANON_KEY", value: project.anon_key },
                        { name: "SUPABASE_SERVICE_ROLE_KEY", value: project.service_role_key },
                        { name: "JWT_SECRET", value: project.jwt_secret },
                        { name: "X_PROJECT_REF", value: project_ref },
                    ];
                    for (const s of standardSecrets) {
                        const ok = await databaseService.upsertSecret(project_ref, s.name, s.value);
                        if (!ok) {
                            logger.error(`[TaskWorker] Failed to seed secret ${s.name} for ${project_ref}`);
                            return false;
                        }
                    }
                    logger.info(`[TaskWorker] Seeded ${standardSecrets.length} standard secrets for ${project_ref}`);
                    return true;
                }

                case "cleanup_db": {
                    const res = await databaseService.deleteDatabase(project_ref);
                    return res.success;
                }

                case "cleanup_s3": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    await storageService.deleteBucket(project_ref);
                    return true;
                }

                case "cleanup_runtime": {
                    if (process.env.TEST_FIXED_JWT_SECRET) return true;
                    // Stop tenant PostgREST + GoTrue processes and clean config files
                    await tenantRuntimeService.stopRuntime(project_ref);
                    // Remove Kong Service/Route
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

        // Cleanup tasks get more retries (10) to ensure resources are freed
        const maxRetries = task_type.startsWith("cleanup_") ? 10 : 3;

        if (retries < maxRetries) {
            logger.warn(`[TaskWorker] Task ${task_type} for ${project_ref} failed but has retries left (${retries}/${maxRetries})`);
            // Re-queue cleanup tasks with exponential backoff via a new pending task
            if (task_type.startsWith("cleanup_") && retries >= 3) {
                logger.info(`[TaskWorker] Re-queuing cleanup task ${task_type} for ${project_ref} (retry ${retries + 1})`);
                await taskRepository.createTask(project_ref, task_type, task.payload);
            }
            return;
        }

        logger.error(`[TaskWorker] Saga compensation triggered for ${project_ref} failed permanently at ${task_type}`);

        if (task_type === "provision_realtime") {
            // Realtime is optional for the current tenant model. Preserve DB/runtime
            // and continue the remaining provisioning pipeline instead of destroying
            // the tenant database after a later-stage addon failure.
            logger.warn(`[TaskWorker] Realtime provisioning failed for ${project_ref}. Preserving core resources and continuing without realtime.`);
            await taskRepository.createTask(project_ref, "provision_router");
            return;
        }

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
}

export const taskWorker = new TaskWorker();

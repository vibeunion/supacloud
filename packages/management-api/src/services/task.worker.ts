import { taskRepository } from "../repositories/task.repository";
import { projectRepository } from "../repositories/project.repository";
import { databaseService } from "./database.service";
import { storageService } from "./storage.service";
import { routerService } from "./router.service";
import { gatewayService } from "./gateway.service";
import type { ProjectTask } from "../db";

export class TaskWorker {
    private isRunning = false;
    private intervalId?: Timer;

    start(intervalMs = 3000) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("Starting Task Worker...");
        this.intervalId = setInterval(() => this.poll(), intervalMs);
    }

    stop() {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        console.log("Task Worker stopped.");
    }

    private async poll() {
        try {
            const task = await taskRepository.claimNextTask();
            if (!task) return; // No pending tasks

            console.log(`[TaskWorker] Processing task: ${task.id} (${task.task_type}) for project ${task.project_ref}`);

            const success = await this.executeTask(task);

            if (success) {
                await taskRepository.updateStatus(task.id, "completed");
                await this.handleTaskCompletion(task);
            } else {
                await taskRepository.updateStatus(task.id, "failed", "Task execution failed");
                await this.handleTaskFailure(task);
            }
        } catch (err: any) {
            console.error(`[TaskWorker] Error processing task:`, err);
        }
    }

    private async executeTask(task: ProjectTask): Promise<boolean> {
        const { project_ref, task_type, payload } = task;

        // Cleanup tasks don't require project to exist
        const isCleanupTask = task_type.startsWith("cleanup_");

        const project = await projectRepository.findByRef(project_ref);
        if (!project && !isCleanupTask) {
            console.error(`[TaskWorker] Project ${project_ref} not found for task ${task.id}`);
            return false;
        }

        try {
            switch (task_type) {
                case "provision_db": {
                    const res = await databaseService.createDatabase(project_ref, project.db_password);
                    if (!res.success) {
                        console.error(`[TaskWorker] provision_db failed for ${project_ref}:`, res.error);
                        await taskRepository.updateTaskError(task.id, res.error || "Unknown error");
                    }
                    return res.success;
                }

                case "provision_s3": {
                    const res = await storageService.createBucket(project_ref);
                    if (res.success && res.accessKey && res.secretKey) {
                        await projectRepository.updateConfig(project_ref, {
                            ...project.config,
                            s3_access_key: res.accessKey,
                            s3_secret_key: res.secretKey,
                        });
                    }
                    return res.success;
                }

                case "provision_runtime": {
                    // Start tenant-specific PostgREST process
                    const startRes = await databaseService.startRuntime(project_ref);
                    if (!startRes.success) return false;

                    // Extract port numbers from output
                    const portMatch = startRes.output.match(/PORT=(\d+)/);
                    const gotruePortMatch = startRes.output.match(/GOTRUE_PORT=(\d+)/);
                    const port = portMatch ? portMatch[1] : "";
                    const gotruePort = gotruePortMatch ? gotruePortMatch[1] : "";
                    if (!port || !gotruePort) {
                        console.error(`[TaskWorker] Cannot determine PostgREST/GoTrue port for ${project_ref}`);
                        return false;
                    }

                    // Register this tenant's independent upstream in Kong (declarative)
                    const upstreamRes = await databaseService.setupUpstream(project_ref, port, gotruePort);
                    if (!upstreamRes.success) {
                        console.error(`[TaskWorker] Failed to setup Kong upstream for ${project_ref}`);
                        return false;
                    }

                    // Save ports to project config
                    await projectRepository.updateConfig(project_ref, {
                        ...project.config,
                        postgrest_port: parseInt(port),
                        gotrue_port: parseInt(gotruePort),
                    });

                    console.log(`[TaskWorker] Runtime started for ${project_ref} on ports (pgrst:${port}, gotrue:${gotruePort})`);
                    return true;
                }

                case "provision_router": {
                    const res = await routerService.addRoute(project_ref);
                    await routerService.reload();
                    return res.success;
                }

                case "provision_gateway": {
                    // Kong uses declarative config (KONG_DATABASE=off), Admin API is read-only.
                    // CORS and rate-limiting are already configured in the YAML template.
                    // This task is a no-op for now, but can be extended for other gateway configs.
                    console.log(`[TaskWorker] Gateway config skipped for ${project_ref} (Kong declarative mode)`);
                    return true;
                }

                case "cleanup_db": {
                    const res = await databaseService.deleteDatabase(project_ref);
                    return res.success;
                }

                case "cleanup_s3": {
                    await storageService.deleteBucket(project_ref);
                    return true;
                }

                case "cleanup_runtime": {
                    // Stop tenant PostgREST process
                    await databaseService.stopRuntime(project_ref);
                    // Remove Kong Service/Route
                    await databaseService.removeService(project_ref);
                    return true;
                }

                case "cleanup_router": {
                    await routerService.removeRoute(project_ref);
                    await routerService.reload();
                    return true;
                }

                default:
                    console.warn(`[TaskWorker] Unknown task type: ${task_type}`);
                    return false;
            }
        } catch (err: any) {
            console.error(`[TaskWorker] Error executing ${task_type} for ${project_ref}:`, err);
            return false;
        }
    }

    private async handleTaskCompletion(task: ProjectTask) {
        const { project_ref, task_type } = task;

        // Workflow orchestration: queue the next task upon completion
        // Pipeline: provision_db → provision_s3 → provision_runtime → provision_router → provision_gateway
        if (task_type === "provision_db") {
            await taskRepository.createTask(project_ref, "provision_s3");
        } else if (task_type === "provision_s3") {
            await taskRepository.createTask(project_ref, "provision_runtime");
        } else if (task_type === "provision_runtime") {
            await taskRepository.createTask(project_ref, "provision_router");
        } else if (task_type === "provision_router") {
            await taskRepository.createTask(project_ref, "provision_gateway");
        } else if (task_type === "provision_gateway") {
            // Final step completed, activate project
            await projectRepository.updateStatus(project_ref, "active");
            console.log(`[TaskWorker] Project ${project_ref} fully provisioned and activated.`);
        } else if (task_type === "cleanup_runtime") {
            // After runtime cleanup, cleanup router
            await taskRepository.createTask(project_ref, "cleanup_router");
        } else if (task_type === "cleanup_db") {
            console.log(`[TaskWorker] Cleanup for ${project_ref} db done.`);
        }
    }

    private async handleTaskFailure(task: ProjectTask) {
        const { project_ref, task_type } = task;
        console.error(`[TaskWorker] Saga compensation triggered for ${project_ref} failed at ${task_type}`);

        // Mark project as paused/error
        await projectRepository.updateStatus(project_ref, "paused");

        // Saga Compensation Logic
        if (task_type === "provision_s3") {
            // If S3 failed, we need to rollback DB
            console.log(`[TaskWorker] Rolling back DB for ${project_ref}`);
            await taskRepository.createTask(project_ref, "cleanup_db");
        } else if (task_type === "provision_router" || task_type === "provision_gateway") {
            // When router/gateway fails, preserve DB and S3 resources to avoid data loss
            // Admin can manually troubleshoot and retry, or trigger cleanup via API
            console.warn(`[TaskWorker] ${task_type} failed for ${project_ref}. DB and S3 resources preserved for manual intervention.`);
            console.warn(`[TaskWorker] To retry: update task status to 'pending'. To cleanup: manually delete project.`);
        }
    }
}

export const taskWorker = new TaskWorker();

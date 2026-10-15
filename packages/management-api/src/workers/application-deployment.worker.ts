import { parseApplicationDeployResult } from "@supacloud/delivery";
import { sql, type ProjectTask } from "../db";
import { claimNextTask } from "../repositories/task.repository";
import { createPgListener, type PgListenerHandle } from "../lib/pg-listen";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  APPLICATION_DEPLOYMENT_TASK_TYPE, parseApplicationDeploymentTask,
} from "../services/application-deployment-task";
import {
  ApplicationDeploymentOrchestrationError, type ApplicationDeploymentOrchestrator,
} from "../services/application-deployment-orchestrator";

type Outcome = "succeeded" | "failed" | "retry_scheduled";
export interface ApplicationDeploymentWorkerPorts {
  claim(): Promise<ProjectTask | null>;
  heartbeat(task: ProjectTask): Promise<boolean>;
  finish(task: ProjectTask, outcome: Outcome, code: string | null): Promise<void>;
}

const LEASE_SECONDS = 120;
const ports: ApplicationDeploymentWorkerPorts = {
  claim: () => claimNextTask({
    workerId: `application-deploy-${process.pid}`,
    allowedTaskTypes: [APPLICATION_DEPLOYMENT_TASK_TYPE],
    concurrencyByProject: 1, leaseSeconds: LEASE_SECONDS,
  }),
  async heartbeat(task) {
    const rows = await sql`
      UPDATE project_tasks SET lease_until = clock_timestamp() + (${LEASE_SECONDS} * INTERVAL '1 second')
      WHERE id = ${task.id} AND attempt = ${task.attempt}
        AND status IN ('leased', 'running') AND lease_until > clock_timestamp()
        AND cancel_requested_at IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  },
  async finish(task, outcome, code) {
    await sql`
      UPDATE project_tasks
      SET status = ${outcome}, error = ${code}, lease_until = NULL, updated_at = clock_timestamp(),
        completed_at = CASE WHEN ${outcome} = 'retry_scheduled' THEN NULL ELSE clock_timestamp() END,
        next_run_at = clock_timestamp() + INTERVAL '2 seconds'
      WHERE id = ${task.id} AND attempt = ${task.attempt}
        AND status IN ('leased', 'running') AND lease_until > clock_timestamp()
        AND cancel_requested_at IS NULL
    `;
  },
};

/** Queue delivery may repeat; effects are owned and fenced by the mutation journal. */
export class ApplicationDeploymentWorker {
  private running = false;
  private run: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listener: PgListenerHandle | undefined;

  constructor(
    private readonly orchestrator: Pick<ApplicationDeploymentOrchestrator, "execute" | "status">,
    private readonly tasks: ApplicationDeploymentWorkerPorts = ports,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.listener = createPgListener({
        url: config.databaseUrl, channels: ["task_pending"],
        onNotification: () => this.wake(),
      });
    } catch {
      logger.warn("[application-deployment] LISTEN unavailable; using safety polling");
    }
    this.timer = setInterval(() => this.wake(), 1_000);
    this.wake();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.listener?.close();
    this.listener = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.run;
  }

  private wake(): void {
    if (!this.running || this.run) return;
    this.run = Promise.all(Array.from({ length: 4 }, () => this.drain().catch(() => {
      logger.error("[application-deployment] queue scan unavailable");
    })))
      .then(() => undefined)
      .finally(() => { this.run = undefined; });
  }

  private async drain(): Promise<void> {
    while (this.running) {
      const task = await this.tasks.claim();
      if (!task) return;
      await this.process(task);
    }
  }

  async process(task: ProjectTask): Promise<void> {
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.tasks.heartbeat(task).then(owned => { leaseLost ||= !owned; })
        .catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
    }, 30_000);
    let outcome: Outcome = "failed";
    let code: string | null = "APPLICATION_DEPLOYMENT_TASK_FAILED";
    let effectsMayHaveStarted = false;
    try {
      const input = parseApplicationDeploymentTask(task);
      const existing = await this.orchestrator.status(input.projectRef, input.request.mutation_id);
      if (existing && existing.status !== "succeeded") {
        effectsMayHaveStarted = true;
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECONCILIATION_REQUIRED", 409);
      }
      if (!await this.tasks.heartbeat(task)) {
        leaseLost = true;
        return;
      }
      // A stored success is read, not executed again after a lost queue acknowledgement.
      const receipt = existing?.receipt ?? await this.orchestrator.execute(input);
      parseApplicationDeployResult(receipt, {
        project_ref: input.projectRef, application_id: input.applicationId,
        environment_id: input.environmentId, request: input.request,
      });
      outcome = "succeeded";
      code = null;
    } catch (error) {
      try {
        const input = parseApplicationDeploymentTask(task);
        effectsMayHaveStarted ||= await this.orchestrator.status(input.projectRef, input.request.mutation_id) !== null;
      } catch {
        effectsMayHaveStarted = true;
      }
      if (error instanceof ApplicationDeploymentOrchestrationError) code = error.code;
      const retryable = !(error instanceof ApplicationDeploymentOrchestrationError) || error.statusCode >= 500;
      if (!effectsMayHaveStarted && retryable && task.attempt < task.max_attempts) outcome = "retry_scheduled";
    } finally {
      clearInterval(heartbeat);
      await renewal;
      if (!leaseLost) await this.tasks.finish(task, outcome, code);
    }
  }
}

import {
  ApplicationDeployRequestSchema, ApplicationIdSchema, parseApplicationDeployResult,
  type ApplicationDeployRequest,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import type { ProjectTask } from "../db";
import {
  createTask, getTaskByIdempotencyKey,
} from "../repositories/task.repository";
import type { MutationPrincipal } from "./project-mutation.service";
import {
  ApplicationDeploymentOrchestrationError,
  type ApplicationDeploymentOrchestrationInput, type ApplicationDeploymentOrchestrator,
  type ApplicationDeploymentStatus,
} from "./application-deployment-orchestrator";
import { ApplicationConfigurations } from "./application-configuration";
import { stableSha256 } from "../utils/stable-json";

export const APPLICATION_DEPLOYMENT_TASK_TYPE = "application_deploy";
const PAYLOAD_SCHEMA = "supacloud.application-deployment-task.v1";

interface DeploymentPayload extends Record<string, unknown> {
  schema: typeof PAYLOAD_SCHEMA;
  project_ref: string;
  application_id: string;
  environment_id: string;
  request: ApplicationDeployRequest;
  principal: MutationPrincipal;
}

export interface ApplicationDeploymentTaskPorts {
  create: typeof createTask;
  read: typeof getTaskByIdempotencyKey;
  configurations: Pick<ApplicationConfigurations, "put" | "read">;
}

function key(mutationId: string): string {
  return `application.release.deploy:${mutationId}`;
}

function invalid(): never {
  throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOYMENT_TASK_INVALID", 503);
}

export function parseApplicationDeploymentTask(task: ProjectTask): ApplicationDeploymentOrchestrationInput {
  const value = task.payload;
  const actor = value.principal;
  if (task.task_type !== APPLICATION_DEPLOYMENT_TASK_TYPE || value.schema !== PAYLOAD_SCHEMA
    || value.project_ref !== task.project_ref
    || !Value.Check(ApplicationIdSchema, value.application_id)
    || !Value.Check(ApplicationIdSchema, value.environment_id)
    || !Value.Check(ApplicationDeployRequestSchema, value.request)
    || value.request.configuration_write !== undefined
    || value.request.configuration_id === undefined
    || task.idempotency_key !== key(value.request.mutation_id)
    || task.business_task_id !== value.request.mutation_id
    || !actor || typeof actor !== "object" || Array.isArray(actor)
    || !("type" in actor) || !["master", "admin", "project"].includes(String(actor.type))
    || !("id" in actor) || typeof actor.id !== "string" || !actor.id.trim()
    || task.metadata?.payload_sha256 !== stableSha256(value)) invalid();
  return {
    projectRef: task.project_ref, applicationId: value.application_id,
    environmentId: value.environment_id, request: value.request,
    principal: { type: actor.type as MutationPrincipal["type"], id: actor.id },
  };
}

export class ApplicationDeploymentTasks {
  constructor(
    private readonly orchestrator: Pick<ApplicationDeploymentOrchestrator, "status">,
    private readonly ports: ApplicationDeploymentTaskPorts = {
      create: createTask, read: getTaskByIdempotencyKey, configurations: new ApplicationConfigurations(),
    },
  ) {}

  async submit(input: ApplicationDeploymentOrchestrationInput): Promise<{ replayed: boolean }> {
    input = structuredClone(input);
    if (!/^[a-z0-9-]{1,20}$/.test(input.projectRef)
      || !Value.Check(ApplicationIdSchema, input.applicationId)
      || !Value.Check(ApplicationIdSchema, input.environmentId)
      || !Value.Check(ApplicationDeployRequestSchema, input.request)
      || (input.request.configuration_write && input.request.configuration_id !== undefined
        && input.request.configuration_id !== input.request.configuration_write.configuration_id)) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_REQUEST_INVALID", 400);
    }
    const requestFingerprint = stableSha256(input);
    const existing = await this.ports.read(input.projectRef, key(input.request.mutation_id));
    if (existing) {
      this.assertReplay(existing, requestFingerprint);
      if (["failed", "dead_lettered", "cancelled"].includes(existing.status)) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECONCILIATION_REQUIRED", 409);
      }
      return { replayed: true };
    }
    const scope = {
      projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
    };
    const { configuration_write: write, ...requestWithoutWrite } = input.request;
    const configuration = write
      ? await this.ports.configurations.put(scope, write)
      : await this.ports.configurations.read(scope, requestWithoutWrite.configuration_id);
    if (!configuration) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_RELEASE_CONFIGURATION_REQUIRED", 400);
    }
    if (configuration.project_ref !== input.projectRef || configuration.application_id !== input.applicationId
      || configuration.environment_id !== input.environmentId
      || (requestWithoutWrite.configuration_id !== undefined
        && configuration.configuration_id !== requestWithoutWrite.configuration_id)
      || (write && configuration.configuration_id !== write.configuration_id)) invalid();
    const payload: DeploymentPayload = {
      schema: PAYLOAD_SCHEMA, project_ref: input.projectRef, application_id: input.applicationId,
      environment_id: input.environmentId,
      request: { ...requestWithoutWrite, configuration_id: configuration.configuration_id },
      principal: input.principal,
    };
    const task = await this.ports.create({
      ref: input.projectRef, type: APPLICATION_DEPLOYMENT_TASK_TYPE, payload,
      maxAttempts: 3, timeoutSec: 3600,
      idempotencyKey: key(input.request.mutation_id), businessTaskId: input.request.mutation_id,
      metadata: {
        schema: "supacloud.application-deployment-task.v1",
        request_sha256: requestFingerprint, payload_sha256: stableSha256(payload),
      },
    });
    this.assertReplay(task, requestFingerprint);
    return { replayed: task.status !== "pending" };
  }

  async status(projectRef: string, mutationId: string): Promise<ApplicationDeploymentStatus | null> {
    const task = await this.ports.read(projectRef, key(mutationId));
    if (!task) return this.orchestrator.status(projectRef, mutationId);
    const input = parseApplicationDeploymentTask(task);
    if (input.projectRef !== projectRef || input.request.mutation_id !== mutationId) invalid();
    const observed = await this.orchestrator.status(projectRef, mutationId);
    if (observed) {
      if (observed.project_ref !== projectRef || observed.application_id !== input.applicationId
        || observed.environment_id !== input.environmentId || observed.mutation_id !== mutationId) invalid();
      if (observed.status === "succeeded") {
        parseApplicationDeployResult(observed.receipt, {
          project_ref: projectRef, application_id: input.applicationId,
          environment_id: input.environmentId, request: input.request,
        });
      }
      if (observed.status === "running" && ["failed", "dead_lettered", "cancelled"].includes(task.status)) {
        return { ...observed, status: "outcome_unknown", failure_code: "APPLICATION_DEPLOY_RECONCILIATION_REQUIRED" };
      }
      return observed;
    }
    const status = task.status === "pending" ? "pending"
      : task.status === "retry_scheduled" ? "failed_retryable"
      : task.status === "running" || task.status === "leased" ? "running"
      : task.status === "succeeded" ? "outcome_unknown" : "failed_terminal";
    return {
      mutation_id: mutationId, operation: "application.release.deploy",
      status, phase: "queued", project_ref: projectRef,
      application_id: input.applicationId, environment_id: input.environmentId,
      receipt: null,
      failure_code: status === "outcome_unknown" ? "APPLICATION_DEPLOY_RECEIPT_INVALID"
        : task.error === null ? null : "APPLICATION_DEPLOYMENT_TASK_FAILED",
    };
  }

  private assertReplay(task: ProjectTask, requestFingerprint: string): void {
    parseApplicationDeploymentTask(task);
    if (task.metadata?.request_sha256 !== requestFingerprint) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOYMENT_TASK_ID_CONFLICT", 409);
    }
  }
}

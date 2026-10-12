import {
  ApplicationConfigurationIdSchema, ApplicationDeployRequestSchema, ApplicationIdSchema, ApplicationReleaseIdSchema,
  parseApplicationDeployResult, parseApplicationDeployPlan,
  parseApplicationReleaseRecord, type ApplicationBackendReceipt, type ApplicationDeployRequest,
  type ApplicationDeployResult,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import type { FrontendReleaseService } from "./frontend-release.service";
import type { ApplicationDeploymentService } from "./application-deployment";
import type { ApplicationDeployPlans } from "./application-deploy-plan";
import type { ApplicationConfigurations } from "./application-configuration";
import type { ApplicationMigrations } from "./application-migrations";
import type { ApplicationReleaseStorage } from "./application-release-storage";
import {
  applicationActivationMutations, type ApplicationActivationMutations,
} from "./application-activation";
import type { MutationPrincipal, ProjectMutationState } from "./project-mutation.service";
import { stableSha256 } from "../utils/stable-json";

const OPERATION = "application.release.deploy";
const CHECKPOINT_SCHEMA = "supacloud.application-deploy-operation.v1";

interface Scope {
  projectRef: string;
  applicationId: string;
  environmentId: string;
}

interface PostgrestStatus {
  actual: string;
  health: string;
}

interface ResolvedWebRequest {
  deployment_id: string;
  release_id: string;
  expected_active_release_id: "absent" | string;
  expected_activation_id: "absent" | string;
  mutation_id: string;
}

interface DeployCheckpoint extends Record<string, unknown> {
  schema: typeof CHECKPOINT_SCHEMA;
  mutation_id: string;
  phase: "prepared" | "migrating" | "activating" | "binding-web" | "verifying";
  request: {
    project_ref: string;
    application_id: string;
    environment_id: string;
    release_id: string;
    configuration_id: string;
    mutation_id: string;
    plan_sha256: string;
    approved_migration_digest: string | null;
    web_release: ApplicationDeployRequest["web_release"] | null;
  };
  plan: ReturnType<typeof parseApplicationDeployPlan>;
  backup_id: string;
  activation_id: string;
  backend_receipt?: ApplicationBackendReceipt;
  web?: ApplicationDeployResult["web"];
}

export interface ApplicationDeploymentOrchestrationInput extends Scope {
  request: ApplicationDeployRequest;
  principal: MutationPrincipal;
}

export class ApplicationDeploymentOrchestrationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface ApplicationDeploymentOrchestratorDependencies {
  storage: Pick<ApplicationReleaseStorage, "readRelease">;
  configurations: Pick<ApplicationConfigurations, "put">
    & Partial<Pick<ApplicationConfigurations, "read">>;
  deployPlans: Pick<ApplicationDeployPlans, "read">;
  migrations: Pick<ApplicationMigrations, "readExecutionPlan" | "apply" | "inspect">;
  deployment: Pick<ApplicationDeploymentService, "activateConfigured">;
  frontends?: Pick<FrontendReleaseService, "release" | "activeReleaseSnapshot" | "activateRelease">;
  postgrestStatus?: (projectRef: string) => Promise<PostgrestStatus>;
  mutations?: ApplicationActivationMutations;
}

export interface ApplicationDeploymentStatus {
  mutation_id: string;
  operation: typeof OPERATION;
  status: ProjectMutationState["status"];
  phase: DeployCheckpoint["phase"] | "queued";
  project_ref: string;
  application_id: string;
  environment_id: string;
  receipt: Record<string, unknown> | null;
  failure_code: string | null;
}

function resourceId(scope: Scope): string {
  return stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId });
}

function backupId(scope: Scope, mutationId: string, planSha256: string): string {
  return `logical-full_${scope.projectRef}_${stableSha256({
    mutation_id: mutationId, application_id: scope.applicationId,
    environment_id: scope.environmentId, plan_sha256: planSha256,
  }).slice(0, 32)}`;
}

function requestBinding(
  input: ApplicationDeploymentOrchestrationInput,
  configurationId: string,
  planSha256: string,
) {
  return {
    project_ref: input.projectRef,
    application_id: input.applicationId,
    environment_id: input.environmentId,
    release_id: input.request.release_id,
    configuration_id: configurationId,
    mutation_id: input.request.mutation_id,
    plan_sha256: planSha256,
    approved_migration_digest: input.request.approved_migration_digest ?? null,
    web_release: input.request.web_release ?? null,
  };
}

function derivedWebMutationId(input: {
  mutationId: string;
  deploymentId: string;
  releaseId: string;
}): string {
  const digest = stableSha256(input);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function success(state: ProjectMutationState): boolean {
  return state.status === "succeeded" && state.responseStatus !== null
    && state.responseStatus >= 200 && state.responseStatus < 300;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "APPLICATION_DEPLOY_OUTCOME_UNKNOWN";
}

function mapError(error: unknown, details: Record<string, unknown>): ApplicationDeploymentOrchestrationError {
  const code = errorCode(error);
  const conflict = [
    "APPLICATION_DEPLOY_PLAN_BUSY", "APPLICATION_DEPLOY_PLAN_CHANGED",
    "APPLICATION_ACTIVATION_REVISION_CONFLICT", "APPLICATION_RELEASE_CONFIGURATION_MISMATCH",
    "APPLICATION_MIGRATION_PLAN_CHANGED", "APPLICATION_MIGRATION_CONFLICT",
    "APPLICATION_MIGRATION_REVIEW_REQUIRED", "APPLICATION_MIGRATION_SQL_UNSUPPORTED",
    "APPLICATION_OPERATOR_PROVISIONING_REQUIRED", "FRONTEND_RELEASE_MUTATION_CONFLICT",
    "FRONTEND_RELEASE_BUSY",
  ].includes(code);
  if (code.startsWith("APPLICATION_MIGRATION_") && code !== "APPLICATION_MIGRATION_OUTCOME_UNKNOWN"
    && code !== "APPLICATION_MIGRATION_READBACK_FAILED") {
    return new ApplicationDeploymentOrchestrationError(code, conflict ? 409 : 503, details);
  }
  return new ApplicationDeploymentOrchestrationError(
    conflict ? code : "APPLICATION_DEPLOY_OUTCOME_UNKNOWN",
    conflict ? 409 : 503,
    details,
  );
}

function receiptFromState(
  state: ProjectMutationState,
  input: ApplicationDeploymentOrchestrationInput,
  replayed = true,
): ApplicationDeployResult {
  if (!success(state) || state.operation !== OPERATION || !state.receipt) {
    throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_OUTCOME_UNKNOWN", 503, {
      project_ref: input.projectRef, mutation_id: input.request.mutation_id,
    });
  }
  try {
    if (state.projectRef !== input.projectRef || state.mutationId !== input.request.mutation_id) {
      throw new Error();
    }
    const result = parseApplicationDeployResult(state.receipt, {
      project_ref: input.projectRef, application_id: input.applicationId,
      environment_id: input.environmentId, request: input.request,
    });
    return {
      ...result,
      replayed,
      execution_performed: replayed ? false : result.execution_performed,
    };
  } catch {
    throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503, {
      project_ref: input.projectRef, mutation_id: input.request.mutation_id,
    });
  }
}

function assertCheckpoint(checkpoint: Record<string, unknown>, input: ApplicationDeploymentOrchestrationInput): DeployCheckpoint {
  if (checkpoint["schema"] !== CHECKPOINT_SCHEMA || checkpoint["mutation_id"] !== input.request.mutation_id
    || checkpoint["request"] === null
    || typeof checkpoint["request"] !== "object" || Array.isArray(checkpoint["request"])
    || (checkpoint["request"] as Record<string, unknown>)["mutation_id"] !== input.request.mutation_id) {
    throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_CHECKPOINT_INVALID", 503);
  }
  return checkpoint as DeployCheckpoint;
}

export class ApplicationDeploymentOrchestrator {
  private readonly mutations: ApplicationActivationMutations;

  constructor(private readonly dependencies: ApplicationDeploymentOrchestratorDependencies) {
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
  }

  async status(projectRef: string, mutationId: string): Promise<ApplicationDeploymentStatus | null> {
    const state = await this.mutations.read(projectRef, mutationId);
    if (!state || state.operation !== OPERATION) return null;
    const checkpointRequest = state.checkpoint["request"];
    const requestRecord = checkpointRequest && typeof checkpointRequest === "object" && !Array.isArray(checkpointRequest)
      ? checkpointRequest as Record<string, unknown> : null;
    if (state.projectRef !== projectRef || state.mutationId !== mutationId
      || state.checkpoint["schema"] !== CHECKPOINT_SCHEMA || state.checkpoint["mutation_id"] !== mutationId
      || !requestRecord || requestRecord["project_ref"] !== projectRef || requestRecord["mutation_id"] !== mutationId
      || !Value.Check(ApplicationIdSchema, requestRecord["application_id"])
      || !Value.Check(ApplicationIdSchema, requestRecord["environment_id"])
      || !Value.Check(ApplicationConfigurationIdSchema, requestRecord["configuration_id"])
      || !Value.Check(ApplicationReleaseIdSchema, requestRecord["release_id"])
      || !Value.Check(ApplicationReleaseIdSchema, requestRecord["plan_sha256"])) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_CHECKPOINT_INVALID", 503);
    }
    const request = {
      mutation_id: mutationId,
      release_id: requestRecord["release_id"],
      configuration_id: requestRecord["configuration_id"],
      expected_plan_sha256: requestRecord["plan_sha256"],
      ...(requestRecord["approved_migration_digest"] === null ? {} : {
        approved_migration_digest: requestRecord["approved_migration_digest"],
      }),
      ...(requestRecord["web_release"] === null ? {} : { web_release: requestRecord["web_release"] }),
    };
    if (!Value.Check(ApplicationDeployRequestSchema, request)) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_CHECKPOINT_INVALID", 503);
    }
    const phaseValue = state.checkpoint["phase"];
    const phase = phaseValue === "prepared" || phaseValue === "migrating"
      || phaseValue === "activating" || phaseValue === "binding-web" || phaseValue === "verifying"
      ? phaseValue : "queued";
    let receipt: ApplicationDeployResult | null = null;
    if (state.status === "succeeded") {
      if (!success(state) || phase !== "verifying") {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503);
      }
      receipt = receiptFromState(state, {
        projectRef, applicationId: requestRecord["application_id"],
        environmentId: requestRecord["environment_id"], request, principal: state.principal,
      });
    }
    return {
      mutation_id: state.mutationId,
      operation: OPERATION,
      status: state.status,
      phase,
      project_ref: projectRef,
      application_id: requestRecord["application_id"],
      environment_id: requestRecord["environment_id"],
      receipt,
      failure_code: state.failureCode,
    };
  }

  async execute(input: ApplicationDeploymentOrchestrationInput): Promise<ApplicationDeployResult> {
    const request = structuredClone(input.request);
    if (!Value.Check(ApplicationDeployRequestSchema, request)) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_REQUEST_INVALID", 400);
    }
    const release = parseApplicationReleaseRecord(await this.dependencies.storage.readRelease(
      input.projectRef, input.applicationId, request.release_id,
    ));
    if (release.project_ref !== input.projectRef || release.application_id !== input.applicationId
      || release.release_id !== request.release_id) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_IDENTITY_INVALID", 409);
    }

    let configurationId = request.configuration_id;
    if (request.configuration_write !== undefined) {
      if (configurationId !== undefined && configurationId !== request.configuration_write.configuration_id) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_RELEASE_CONFIGURATION_MISMATCH", 409);
      }
      configurationId = (await this.dependencies.configurations.put(
        { projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId },
        request.configuration_write,
      )).configuration_id;
    }
    if (configurationId === undefined && this.dependencies.configurations.read) {
      try {
        configurationId = (await this.dependencies.configurations.read({
          projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
        }))?.configuration_id;
      } catch {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_CONFIGURATION_UNAVAILABLE", 503, {
          project_ref: input.projectRef, application_id: input.applicationId,
          environment_id: input.environmentId,
        });
      }
    }
    if (configurationId === undefined) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_RELEASE_CONFIGURATION_REQUIRED", 400);
    }

    let plan;
    try {
      plan = parseApplicationDeployPlan(await this.dependencies.deployPlans.read({
        projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
        releaseId: request.release_id, configurationId,
      }));
    } catch (error) {
      throw mapError(error, { project_ref: input.projectRef, release_id: request.release_id, configuration_id: configurationId });
    }
    if (plan.project_ref !== input.projectRef || plan.application_id !== input.applicationId
      || plan.environment_id !== input.environmentId || plan.candidate.release_id !== request.release_id
      || plan.candidate.configuration_id !== configurationId) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_IDENTITY_INVALID", 409);
    }
    const planSha256 = stableSha256(plan);
    let webRequest: ResolvedWebRequest | undefined;
    if (request.web_release !== undefined) {
      if (!this.dependencies.frontends) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_WEB_UNAVAILABLE", 503);
      }
      const active = await this.dependencies.frontends.activeReleaseSnapshot(
        input.projectRef, request.web_release.deployment_id,
      );
      const webRelease = await this.dependencies.frontends.release(
        input.projectRef, request.web_release.deployment_id, request.web_release.release_id,
      );
      if (webRelease.project_ref !== input.projectRef
        || webRelease.deployment_id !== request.web_release.deployment_id
        || webRelease.release_id !== request.web_release.release_id) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_WEB_RELEASE_MISMATCH", 409);
      }
      webRequest = {
        deployment_id: request.web_release.deployment_id,
        release_id: request.web_release.release_id,
        expected_active_release_id: active.active_release_id ?? "absent",
        expected_activation_id: active.active_activation_id ?? "absent",
        mutation_id: derivedWebMutationId({
          mutationId: request.mutation_id,
          deploymentId: request.web_release.deployment_id,
          releaseId: request.web_release.release_id,
        }),
      };
    }
    const binding = requestBinding(input, configurationId, planSha256);
    if (request.expected_plan_sha256 !== undefined && request.expected_plan_sha256 !== planSha256) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_PLAN_CHANGED", 409, binding);
    }

    const begun = await this.mutations.begin({
      projectRef: input.projectRef,
      mutationId: request.mutation_id,
      operation: OPERATION,
      resource: { type: "application_deploy", id: resourceId(input) },
      principal: input.principal,
      requestFingerprint: stableSha256({ schema: "supacloud.application-deploy-request.v1", ...binding }),
    });
    if (!begun.lease) {
      if (!success(begun.state)) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECONCILIATION_REQUIRED", 503, binding);
      }
      return receiptFromState(begun.state, input);
    }

    const lease = begun.lease;
    const checkpoint: DeployCheckpoint = {
      schema: CHECKPOINT_SCHEMA,
      mutation_id: request.mutation_id,
      phase: "prepared",
      request: binding,
      plan,
      backup_id: backupId(input, request.mutation_id, planSha256),
      activation_id: plan.action === "no-op" && plan.current
        ? plan.current.activation_id : crypto.randomUUID(),
    };
    let effectsStarted = false;
    let completed = false;
    try {
      if (Object.keys(begun.state.checkpoint).length !== 0) {
        assertCheckpoint(begun.state.checkpoint, input);
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECONCILIATION_REQUIRED", 503, binding);
      }
      await this.mutations.checkpoint(lease, checkpoint);

      if (plan.action === "no-op" && plan.migrations.project_migrations_applied) {
        checkpoint.backend_receipt = await this.backendReceipt(input, checkpoint, null, false);
      } else {
        const executionPlan = await this.dependencies.migrations.readExecutionPlan({
          projectRef: input.projectRef, applicationId: input.applicationId, releaseId: request.release_id,
        });
        if (executionPlan.ledger_digest !== plan.migrations.ledger_digest) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_MIGRATION_PLAN_CHANGED", 409, binding);
        }
        if (!executionPlan.ledger_compatible) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_MIGRATION_CONFLICT", 409, binding);
        }
        if (executionPlan.operator_provisioning_required) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_OPERATOR_PROVISIONING_REQUIRED", 409, binding);
        }
        if (executionPlan.migrations.some(entry => entry.unsupported.length || entry.non_transactional.length)) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_MIGRATION_SQL_UNSUPPORTED", 409, binding);
        }
        if (executionPlan.migrations.length > 0) {
          checkpoint.phase = "migrating";
          await this.mutations.checkpoint(lease, checkpoint);
          effectsStarted = true;
          await this.mutations.protect(lease, async () => {
            const migration = await this.dependencies.migrations.apply({
              projectRef: input.projectRef, applicationId: input.applicationId, releaseId: request.release_id,
              expectedLedgerDigest: executionPlan.ledger_digest, backupId: checkpoint.backup_id,
              ...(request.approved_migration_digest === undefined ? {} : {
                approvedMigrationDigest: request.approved_migration_digest,
              }),
            });
            checkpoint.backend_receipt = await this.backendReceipt(input, checkpoint, migration, true);
          });
        } else {
          checkpoint.backend_receipt = await this.backendReceipt(input, checkpoint, null, false);
        }
      }

      if (!checkpoint.backend_receipt) {
        throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503, binding);
      }
      if (plan.action === "activate") {
        checkpoint.phase = "activating";
        await this.mutations.checkpoint(lease, checkpoint);
        effectsStarted = true;
        const activation = await this.dependencies.deployment.activateConfigured({
          runtime: { release, environmentId: input.environmentId, activationId: checkpoint.activation_id },
          configurationId,
          expectedActivationId: plan.expected_activation_id,
          principal: input.principal,
        });
        if (activation.project_ref !== input.projectRef || activation.application_id !== input.applicationId
          || activation.environment_id !== input.environmentId || activation.release_id !== request.release_id
          || activation.activation_id !== checkpoint.activation_id) {
          throw new Error("APPLICATION_DEPLOY_ACTIVATION_UNVERIFIED");
        }
      }

      if (webRequest !== undefined) {
        if (!this.dependencies.frontends) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_WEB_UNAVAILABLE", 503, binding);
        }
        checkpoint.phase = "binding-web";
        await this.mutations.checkpoint(lease, checkpoint);
        effectsStarted = true;
        const webRelease = await this.dependencies.frontends.release(
          input.projectRef, webRequest.deployment_id, webRequest.release_id,
        );
        if (webRelease.project_ref !== input.projectRef || webRelease.deployment_id !== webRequest.deployment_id
          || webRelease.release_id !== webRequest.release_id) {
          throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_WEB_RELEASE_MISMATCH", 409, binding);
        }
        const web = await this.dependencies.frontends.activateRelease({
          projectRef: input.projectRef,
          deploymentId: webRequest.deployment_id,
          releaseId: webRequest.release_id,
          expectedActiveReleaseId: webRequest.expected_active_release_id,
          expectedActivationId: webRequest.expected_activation_id,
          mutationId: webRequest.mutation_id,
          principal: input.principal,
        });
        checkpoint.web = {
          deployment_id: web.deployment_id,
          release_id: web.active_release_id,
          activation_id: web.activation_id,
          replayed: web.mutation.replayed,
        };
      }

      checkpoint.phase = "verifying";
      await this.mutations.checkpoint(lease, checkpoint);
      const result: ApplicationDeployResult = {
        schema: "supacloud.application-deploy.v1",
        project_ref: input.projectRef,
        application_id: input.applicationId,
        environment_id: input.environmentId,
        mutation_id: request.mutation_id,
        release_id: request.release_id,
        configuration_id: configurationId,
        activation_id: checkpoint.activation_id,
        expected_activation_id: plan.expected_activation_id,
        plan_sha256: planSha256,
        action: plan.action,
        replayed: false,
        execution_performed: effectsStarted,
        backend_receipt: checkpoint.backend_receipt,
        ...(checkpoint.web === undefined ? {} : { web: checkpoint.web }),
      };
      const verified = parseApplicationDeployResult(result, {
        project_ref: input.projectRef, application_id: input.applicationId,
        environment_id: input.environmentId, request,
      });
      await this.mutations.success(lease, verified);
      completed = true;
      const stored = await this.mutations.read(input.projectRef, request.mutation_id);
      if (!stored) throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503, binding);
      return receiptFromState(stored, input, false);
    } catch (error) {
      if (!completed) await this.mutations.failure(lease, effectsStarted, !effectsStarted);
      if (error instanceof ApplicationDeploymentOrchestrationError) throw error;
      throw mapError(error, binding);
    }
  }

  private async backendReceipt(
    input: ApplicationDeploymentOrchestrationInput,
    checkpoint: DeployCheckpoint,
    migration: Awaited<ReturnType<ApplicationMigrations["apply"]>> | null,
    schemaReloaded: boolean,
  ): Promise<ApplicationBackendReceipt> {
    const after = migration?.after ?? await this.dependencies.migrations.inspect(
      input.projectRef, input.applicationId, input.request.release_id,
    );
    if (after.project_ref !== input.projectRef || after.application_id !== input.applicationId
      || after.release_id !== input.request.release_id || !after.ledger_compatible || !after.project_migrations_applied) {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503);
    }
    const postgrest = this.dependencies.postgrestStatus
      ? await this.dependencies.postgrestStatus(input.projectRef)
      : { actual: "running", health: "healthy" };
    if (postgrest.actual !== "running" || postgrest.health !== "healthy") {
      throw new ApplicationDeploymentOrchestrationError("APPLICATION_POSTGREST_NOT_READY", 503, {
        project_ref: input.projectRef, mutation_id: input.request.mutation_id,
      });
    }
    const appliedVersions = migration?.applied.map(entry => entry.version) ?? [];
    return {
      schema: "supacloud.application-backend-receipt.v1",
      project_ref: input.projectRef,
      application_id: input.applicationId,
      environment_id: input.environmentId,
      release_id: input.request.release_id,
      manifest_sha256: after.manifest_sha256,
      mutation_id: input.request.mutation_id,
      plan_sha256: checkpoint.request.plan_sha256,
      backup_id: migration?.backup?.backup_id ?? null,
      before_ledger_digest: migration?.before.ledger_digest ?? checkpoint.plan.migrations.ledger_digest,
      after_ledger_digest: after.ledger_digest,
      applied_versions: [...new Set(appliedVersions)].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0),
      schema_reloaded: schemaReloaded,
      postgrest_healthy: true,
    };
  }
}

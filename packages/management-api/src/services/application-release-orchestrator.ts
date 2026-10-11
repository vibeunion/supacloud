import {
  ApplicationReleaseRequestSchema, parseApplicationDeployPlan, parseApplicationReleaseRecord,
  type ApplicationReleaseRequest, type ApplicationReleaseResult,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import type { ApplicationDeploymentService } from "./application-deployment";
import type { ApplicationDeployPlans } from "./application-deploy-plan";
import type { ApplicationConfigurations } from "./application-configuration";
import type { ApplicationReleaseStorage } from "./application-release-storage";
import type { MutationPrincipal } from "./project-mutation.service";
import { stableSha256 } from "../utils/stable-json";

interface Scope {
  projectRef: string;
  applicationId: string;
  environmentId: string;
}

export interface ApplicationReleaseOrchestrationInput extends Scope {
  request: ApplicationReleaseRequest;
  principal: MutationPrincipal;
}

export class ApplicationReleaseOrchestrationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

interface Dependencies {
  storage: Pick<ApplicationReleaseStorage, "readRelease">;
  configurations: Pick<ApplicationConfigurations, "put">;
  deployPlans: Pick<ApplicationDeployPlans, "read">;
  deployment: Pick<ApplicationDeploymentService, "activateConfigured">;
}

const CONFLICT_CODES = new Set([
  "APPLICATION_DEPLOY_PLAN_BUSY",
  "APPLICATION_ACTIVATION_REVISION_CONFLICT",
  "APPLICATION_PORT_ALLOCATION_CONFLICT",
  "APPLICATION_RELEASE_PLAN_CHANGED",
]);
const RECOVERY_CODES = new Set([
  "APPLICATION_ACTIVATION_OUTCOME_UNRESOLVED",
  "APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED",
  "APPLICATION_ACTIVATION_RECOVERY_OBSERVATION_REQUIRED",
  "APPLICATION_ACTIVATION_NOT_RECOVERABLE",
]);
const SAFE_ERROR_CODES = new Set([
  ...CONFLICT_CODES,
  ...RECOVERY_CODES,
  "APPLICATION_ACTIVATION_OUTCOME_UNKNOWN",
  "APPLICATION_ACTIVATION_IDENTITY_INVALID",
  "APPLICATION_RUNTIME_RELEASE_MISMATCH",
  "APPLICATION_PORT_ALLOCATION_MISMATCH",
  "APPLICATION_DEPLOYMENT_NOT_READY",
]);

function identity(scope: Scope, request: ApplicationReleaseRequest, configurationId?: string) {
  return {
    project_ref: scope.projectRef,
    application_id: scope.applicationId,
    environment_id: scope.environmentId,
    release_id: request.release_id,
    ...(configurationId === undefined ? {} : { configuration_id: configurationId }),
    ...(request.activation_id === undefined ? {} : { activation_id: request.activation_id }),
    ...(request.expected_activation_id === undefined ? {} : {
      expected_activation_id: request.expected_activation_id,
    }),
  };
}

function orchestrationError(error: unknown, details: Record<string, unknown>): ApplicationReleaseOrchestrationError {
  const rawCode = error instanceof Error ? error.message : "APPLICATION_RELEASE_OUTCOME_UNKNOWN";
  const code = RECOVERY_CODES.has(rawCode)
    ? "APPLICATION_RELEASE_RECONCILIATION_REQUIRED"
    : rawCode === "APPLICATION_ACTIVATION_OUTCOME_UNKNOWN"
      ? "APPLICATION_RELEASE_OUTCOME_UNKNOWN"
      : SAFE_ERROR_CODES.has(rawCode) ? rawCode : "APPLICATION_RELEASE_OUTCOME_UNKNOWN";
  return new ApplicationReleaseOrchestrationError(
    code,
    CONFLICT_CODES.has(rawCode) ? 409 : 503,
    details,
  );
}

/** One authenticated platform mutation for configuration, planning and activation. */
export class ApplicationReleaseOrchestrator {
  constructor(private readonly dependencies: Dependencies) {}

  async execute(input: ApplicationReleaseOrchestrationInput): Promise<ApplicationReleaseResult> {
    const request = structuredClone(input.request);
    if (!Value.Check(ApplicationReleaseRequestSchema, request)) {
      throw new ApplicationReleaseOrchestrationError("APPLICATION_RELEASE_REQUEST_INVALID", 400);
    }
    const release = parseApplicationReleaseRecord(await this.dependencies.storage.readRelease(
      input.projectRef, input.applicationId, request.release_id,
    ));
    if (release.project_ref !== input.projectRef || release.application_id !== input.applicationId
      || release.release_id !== request.release_id) {
      throw new ApplicationReleaseOrchestrationError("APPLICATION_RELEASE_IDENTITY_INVALID", 409);
    }

    let configurationId = request.configuration_id;
    if (request.configuration_write !== undefined) {
      if (configurationId !== undefined && configurationId !== request.configuration_write.configuration_id) {
        throw new ApplicationReleaseOrchestrationError("APPLICATION_RELEASE_CONFIGURATION_MISMATCH", 409);
      }
      configurationId = (await this.dependencies.configurations.put(
        { projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId },
        request.configuration_write,
      )).configuration_id;
    }
    if (configurationId === undefined) {
      throw new ApplicationReleaseOrchestrationError("APPLICATION_RELEASE_CONFIGURATION_REQUIRED", 400);
    }

    let plan;
    try {
      plan = parseApplicationDeployPlan(await this.dependencies.deployPlans.read({
        projectRef: input.projectRef, applicationId: input.applicationId, environmentId: input.environmentId,
        releaseId: request.release_id, configurationId,
      }));
    } catch (error) {
      throw orchestrationError(error, identity(input, request, configurationId));
    }
    const planSha256 = stableSha256(plan);
    const baseIdentity = {
      ...identity(input, request, configurationId),
      expected_activation_id: plan.expected_activation_id,
      plan_sha256: planSha256,
    };
    if (request.expected_plan_sha256 !== undefined && request.expected_plan_sha256 !== planSha256) {
      throw new ApplicationReleaseOrchestrationError("APPLICATION_RELEASE_PLAN_CHANGED", 409, baseIdentity);
    }
    if (request.expected_activation_id !== undefined
      && request.expected_activation_id !== plan.expected_activation_id) {
      throw new ApplicationReleaseOrchestrationError("APPLICATION_ACTIVATION_REVISION_CONFLICT", 409, baseIdentity);
    }

    if (plan.action === "no-op") {
      return {
        schema: "supacloud.application-release.v1",
        project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
        release_id: request.release_id, configuration_id: configurationId,
        activation_id: plan.current!.activation_id, expected_activation_id: plan.expected_activation_id,
        plan_sha256: planSha256, action: "no-op", replayed: false, execution_performed: false,
      };
    }

    const activationId = request.activation_id ?? crypto.randomUUID();
    if (activationId === plan.expected_activation_id) {
      throw new ApplicationReleaseOrchestrationError(
        "APPLICATION_ACTIVATION_REVISION_CONFLICT", 409, { ...baseIdentity, activation_id: activationId },
      );
    }
    const operationIdentity = { ...baseIdentity, activation_id: activationId };
    try {
      const result = await this.dependencies.deployment.activateConfigured({
        runtime: { release, environmentId: input.environmentId, activationId },
        configurationId,
        expectedActivationId: plan.expected_activation_id,
        principal: input.principal,
      });
      if (result.project_ref !== input.projectRef || result.application_id !== input.applicationId
        || result.environment_id !== input.environmentId || result.release_id !== request.release_id
        || result.activation_id !== activationId) {
        throw new Error("APPLICATION_RELEASE_ACTIVATION_UNVERIFIED");
      }
      return {
        schema: "supacloud.application-release.v1",
        project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId,
        release_id: request.release_id, configuration_id: configurationId,
        activation_id: result.activation_id, expected_activation_id: plan.expected_activation_id,
        plan_sha256: planSha256, action: "activate", replayed: result.replayed,
        execution_performed: !result.replayed,
      };
    } catch (error) {
      throw orchestrationError(error, operationIdentity);
    }
  }
}

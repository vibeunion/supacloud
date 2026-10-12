import { Elysia, status, t } from "elysia";
import {
  ApplicationConfigurationIdSchema, ApplicationConfigurationWriteSchema, ApplicationDeployRequestSchema,
  ApplicationDeployWebRequestSchema, ApplicationIdSchema, ApplicationReleaseIdSchema,
  parseApplicationDeployResult,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import { requireProjectOrAdminAuth, getVerifiedRequestPrincipal } from "../middleware/auth";
import {
  ApplicationDeploymentOrchestrationError, type ApplicationDeploymentOrchestrator,
  type ApplicationDeploymentStatus,
} from "../services/application-deployment-orchestrator";

const projectRef = t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" });
const environmentId = t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const applicationId = ApplicationIdSchema;
const deploymentId = t.String({ format: "uuid" });
const sha256 = ApplicationReleaseIdSchema;

const requestBody = t.Object({
  deployment_id: deploymentId,
  application_id: applicationId,
  release_id: sha256,
  configuration_id: t.Optional(ApplicationConfigurationIdSchema),
  configuration_write: t.Optional(ApplicationConfigurationWriteSchema),
  expected_plan_sha256: t.Optional(sha256),
  approved_migration_digest: t.Optional(sha256),
  web: t.Optional(ApplicationDeployWebRequestSchema),
}, { additionalProperties: false });

function publicStatus(state: ApplicationDeploymentStatus | null) {
  if (state === null) return null;
  return {
    schema: "supacloud.project-deployment-status.v1",
    deployment_id: state.mutation_id,
    status: state.status,
    phase: state.phase,
    operation: state.operation,
    project_ref: state.project_ref,
    application_id: state.application_id,
    environment_id: state.environment_id,
    ...(state.receipt === null ? {} : { receipt: state.receipt }),
    ...(state.failure_code === null ? {} : { failure_code: state.failure_code }),
  };
}

export function createProjectDeploymentRoutes(
  orchestrator: Pick<ApplicationDeploymentOrchestrator, "execute" | "status">,
) {
  return new Elysia({ prefix: "/v1/projects/:ref/environments/:environmentId/deployments", name: "project-deployments" })
    .beforeHandle(async ({ params, request }) => {
      const denied = await requireProjectOrAdminAuth(request, params.ref);
      if (denied) return status(denied.status, denied.body);
    })
    .post("", {
      params: t.Object({ ref: projectRef, environmentId }),
      body: requestBody,
      detail: { tags: ["deployments"], summary: "Deploy the project backend and Web as one durable mutation" },
    }, async ({ params, body, request }) => {
      const principal = await getVerifiedRequestPrincipal(request);
      if (!principal) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      const requestValue = {
        mutation_id: body.deployment_id,
        release_id: body.release_id,
        ...(body.configuration_id === undefined ? {} : { configuration_id: body.configuration_id }),
        ...(body.configuration_write === undefined ? {} : { configuration_write: body.configuration_write }),
        ...(body.expected_plan_sha256 === undefined ? {} : { expected_plan_sha256: body.expected_plan_sha256 }),
        ...(body.approved_migration_digest === undefined ? {} : {
          approved_migration_digest: body.approved_migration_digest,
        }),
        ...(body.web === undefined ? {} : { web: body.web }),
      };
      if (!Value.Check(ApplicationDeployRequestSchema, requestValue)) {
        return status(400, { code: "PROJECT_DEPLOYMENT_REQUEST_INVALID", error: "Invalid deployment request" });
      }
      try {
        const receipt = await orchestrator.execute({
          projectRef: params.ref,
          applicationId: body.application_id,
          environmentId: params.environmentId,
          request: requestValue,
          principal,
        });
        return { ok: true, ...parseApplicationDeployResult(receipt) };
      } catch (error) {
        const code = error instanceof Error ? error.message : "PROJECT_DEPLOYMENT_OUTCOME_UNKNOWN";
        const statusCode = error instanceof ApplicationDeploymentOrchestrationError
          ? error.statusCode : 503;
        return status(statusCode, {
          ok: false,
          code,
          error: "Project deployment could not be completed",
          deployment_id: body.deployment_id,
          project_ref: params.ref,
          application_id: body.application_id,
          environment_id: params.environmentId,
        });
      }
    })
    .get("/:deploymentId", {
      params: t.Object({ ref: projectRef, environmentId, deploymentId }),
      detail: { tags: ["deployments"], summary: "Read one project deployment receipt and phase" },
    }, async ({ params }) => {
      const state = await orchestrator.status(params.ref, params.deploymentId);
      if (state === null) return status(404, { code: "PROJECT_DEPLOYMENT_NOT_FOUND", error: "Deployment not found" });
      if (state.environment_id !== params.environmentId) {
        return status(404, { code: "PROJECT_DEPLOYMENT_NOT_FOUND", error: "Deployment not found" });
      }
      return publicStatus(state);
    })
    .post("/:deploymentId/reconcile", {
      params: t.Object({ ref: projectRef, environmentId, deploymentId }),
      body: t.Object({}, { additionalProperties: false }),
      detail: { tags: ["deployments"], summary: "Re-read a project deployment after an unknown response" },
    }, async ({ params }) => {
      const state = await orchestrator.status(params.ref, params.deploymentId);
      if (state === null || state.environment_id !== params.environmentId) {
        return status(404, { code: "PROJECT_DEPLOYMENT_NOT_FOUND", error: "Deployment not found" });
      }
      if (state.status !== "succeeded") {
        return status(409, {
          ...publicStatus(state),
          code: "PROJECT_DEPLOYMENT_RECONCILIATION_REQUIRED",
          error: "Deployment has not reached a verified terminal state",
        });
      }
      return { ok: true, ...publicStatus(state), replayed: true };
    });
}

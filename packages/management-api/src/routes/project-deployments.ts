import { Elysia, status, t } from "elysia";
import { FRONTEND_ARCHIVE_CONTENT_TYPE } from "@supacloud/delivery/frontend-archive";
import {
  ApplicationConfigurationIdSchema, ApplicationConfigurationWriteSchema, ApplicationDeployRequestSchema,
  ApplicationIdSchema, ApplicationReleaseIdSchema,
  parseApplicationDeployResult,
} from "@supacloud/delivery";
import { Value } from "typebox/value";
import { requireProjectOrAdminAuth, getVerifiedRequestPrincipal } from "../middleware/auth";
import {
  ApplicationDeploymentOrchestrationError, type ApplicationDeploymentOrchestrator,
  type ApplicationDeploymentStatus,
} from "../services/application-deployment-orchestrator";
import {
  FRONTEND_RELEASE_ARCHIVE_MAX_BYTES,
  FrontendReleaseError,
  frontendReleaseService,
} from "../services/frontend-release.service";
import type { FrontendReleaseService } from "../services/frontend-release.service";

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
  web_release: t.Optional(t.Object({
    deployment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
    release_id: sha256,
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const uploadChunkBytes = 64 * 1024;

function uploadLength(request: Request): number {
  const value = request.headers.get("content-length");
  if (value === null || !/^[1-9]\d*$/u.test(value)) {
    throw new FrontendReleaseError(
      "FRONTEND_RELEASE_CONTENT_LENGTH_INVALID", 411, "Frontend archive requires Content-Length",
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > FRONTEND_RELEASE_ARCHIVE_MAX_BYTES) {
    throw new FrontendReleaseError(
      "FRONTEND_RELEASE_ARCHIVE_TOO_LARGE", 413, "Frontend archive is too large",
    );
  }
  return length;
}

async function* uploadChunks(request: Request, expectedLength: number): AsyncGenerator<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new FrontendReleaseError("FRONTEND_RELEASE_ARCHIVE_INVALID", 400, "Frontend archive is empty");
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > expectedLength) {
        throw new FrontendReleaseError(
          "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH", 400, "Frontend archive length does not match Content-Length",
        );
      }
      for (let offset = 0; offset < chunk.value.byteLength; offset += uploadChunkBytes) {
        yield chunk.value.subarray(offset, offset + uploadChunkBytes);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (received !== expectedLength) {
    throw new FrontendReleaseError(
      "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH", 400, "Frontend archive length does not match Content-Length",
    );
  }
}

function uploadError(error: unknown) {
  if (error instanceof FrontendReleaseError) {
    return status(error.statusCode, { code: error.code, error: error.message });
  }
  return status(503, { code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN", error: "Frontend release upload outcome is unknown" });
}

function publicStatus(state: ApplicationDeploymentStatus | null) {
  if (state === null) return null;
  const receipt = state.status === "succeeded" ? parseApplicationDeployResult(state.receipt) : null;
  if (receipt && (receipt.project_ref !== state.project_ref || receipt.application_id !== state.application_id
    || receipt.environment_id !== state.environment_id || receipt.mutation_id !== state.mutation_id
    || state.phase !== "verifying")) {
    throw new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_RECEIPT_INVALID", 503);
  }
  return {
    schema: "supacloud.project-deployment-status.v1",
    deployment_id: state.mutation_id,
    status: state.status,
    phase: state.phase,
    operation: state.operation,
    project_ref: state.project_ref,
    application_id: state.application_id,
    environment_id: state.environment_id,
    ...(receipt === null ? {} : { receipt }),
    ...(state.failure_code === null ? {} : {
      failure_code: /^[A-Z][A-Z0-9_]{0,63}$/.test(state.failure_code)
        ? state.failure_code : "PROJECT_DEPLOYMENT_UNAVAILABLE",
    }),
  };
}

export function createProjectDeploymentRoutes(
  orchestrator: Pick<ApplicationDeploymentOrchestrator, "execute" | "status">,
  auth: {
    authorize?: typeof requireProjectOrAdminAuth;
    principal?: typeof getVerifiedRequestPrincipal;
  } = {},
  frontend: Pick<FrontendReleaseService, "prepareReleaseUpload" | "createRelease"> = frontendReleaseService,
) {
  const authorize = auth.authorize ?? requireProjectOrAdminAuth;
  const principalFor = auth.principal ?? getVerifiedRequestPrincipal;
  return new Elysia({ prefix: "/v1/projects/:ref/environments/:environmentId/deployments", name: "project-deployments" })
    .error(({ error }) => {
      if (error instanceof Error && "code" in error && (error.code === "validation" || error.code === "parse")) {
        return status(400, { ok: false, code: "PROJECT_DEPLOYMENT_REQUEST_INVALID", error: "Invalid deployment request" });
      }
      return status(503, {
        ok: false, code: "PROJECT_DEPLOYMENT_UNAVAILABLE", error: "Project deployment state is unavailable",
      });
    })
    .beforeHandle(async ({ params, request, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const denied = await authorize(request, params.ref);
      if (denied) return status(denied.status, denied.body);
    })
    .get("/protocol", {
      params: t.Object({ ref: projectRef, environmentId }),
      detail: { tags: ["deployments"], summary: "Check the current project deployment protocol before uploading" },
    }, ({ params }) => ({
      protocol: "supacloud.project-deployment.v1",
      project_ref: params.ref,
      environment_id: params.environmentId,
    }))
    .post("/web-release", {
      params: t.Object({ ref: projectRef, environmentId }),
      query: t.Object({ deployment_id: t.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" }) }),
      parse: "none",
      detail: { tags: ["deployments"], summary: "Upload one immutable Web release for a project deployment" },
    }, async ({ params, query, request, set }) => {
      try {
        if (request.headers.get("content-type")?.trim().toLowerCase() !== FRONTEND_ARCHIVE_CONTENT_TYPE) {
          return status(415, {
            code: "FRONTEND_RELEASE_CONTENT_TYPE_INVALID",
            error: `Frontend archive requires ${FRONTEND_ARCHIVE_CONTENT_TYPE}`,
          });
        }
        const expectedLength = uploadLength(request);
        const expectedSha256 = request.headers.get("x-supacloud-content-sha256")?.trim() || "";
        const upload = await frontend.prepareReleaseUpload(params.ref, query.deployment_id, expectedLength);
        try {
          for await (const chunk of uploadChunks(request, expectedLength)) {
            await upload.write(chunk);
          }
          const archive = await upload.finish(expectedSha256);
          const release = await frontend.createRelease(params.ref, query.deployment_id, archive);
          set.status = 201;
          return {
            ok: true,
            project_ref: params.ref,
            environment_id: params.environmentId,
            deployment_id: query.deployment_id,
            release_id: release.release_id,
            release,
          };
        } finally {
          await upload.abort();
        }
      } catch (error: unknown) {
        return uploadError(error);
      }
    })
    .post("", {
      params: t.Object({ ref: projectRef, environmentId }),
      body: requestBody,
      detail: { tags: ["deployments"], summary: "Deploy the project backend and Web as one durable mutation" },
    }, async ({ params, body, request }) => {
      const principal = await principalFor(request);
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
        ...(body.web_release === undefined ? {} : { web_release: body.web_release }),
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
        return { ok: true, ...parseApplicationDeployResult(receipt, {
          project_ref: params.ref, application_id: body.application_id,
          environment_id: params.environmentId, request: requestValue,
        }) };
      } catch (error) {
        const code = error instanceof ApplicationDeploymentOrchestrationError
          && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
          ? error.code : "PROJECT_DEPLOYMENT_OUTCOME_UNKNOWN";
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
      if (state.environment_id !== params.environmentId || state.project_ref !== params.ref
        || state.mutation_id !== params.deploymentId) {
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
      if (state === null || state.environment_id !== params.environmentId
        || state.project_ref !== params.ref || state.mutation_id !== params.deploymentId) {
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

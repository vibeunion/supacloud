import { Elysia, status, t } from "elysia";
import {
  ApplicationConfigurationWriteSchema, ApplicationConfigurationIdSchema,
  ApplicationActivationIdSchema, ApplicationActivationWriteSchema, ApplicationActivationResultSchema,
  ApplicationActivationRetirementResultSchema,
} from "@supacloud/delivery";
import { sql } from "../db";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { ApplicationReleaseError, ApplicationReleaseStorage } from "../services/application-release-storage";
import { ApplicationDevelopmentError, extractApplicationDevelopment } from "../services/application-development.service";
import { ReleaseEvidenceError, createReleaseEvidence } from "../services/application-release-evidence.service";
import { ReleaseExecutionError, createReleaseExecution } from "../services/application-release-execution.service";
import type { ReleaseExecutionStore } from "../services/application-release-execution-store";
import { uploadApplicationRelease } from "../services/application-release-upload";
import { ApplicationActiveStorage } from "../services/application-active-storage";
import { ApplicationReadiness } from "../services/application-readiness";
import { ApplicationMigrations } from "../services/application-migrations";
import { ApplicationConfigurations, ApplicationConfigurationError } from "../services/application-configuration";
import { stableStringify } from "../utils/stable-json";
import type { ApplicationDeploymentService } from "../services/application-deployment";
import { ConflictError } from "../utils/errors";

function activationFailure(error: unknown, identity: {
  project_ref: string; application_id: string; environment_id: string; activation_id: string;
}) {
  const code = error instanceof Error ? error.message : "";
  if (error instanceof ApplicationReleaseError || error instanceof ApplicationConfigurationError) {
    throw error;
  }
  if (error instanceof ConflictError || [
    "APPLICATION_ACTIVATION_REVISION_CONFLICT", "APPLICATION_PORT_ALLOCATION_CONFLICT",
    "APPLICATION_ACTIVATION_RECOVERY_IDENTITY_MISMATCH",
    "APPLICATION_ACTIVE_ALLOCATION_CANNOT_RETIRE",
  ].includes(code)) {
    return status(409, { ...identity, code: "APPLICATION_ACTIVATION_CONFLICT", error: "Application activation conflict" });
  }
  const recoveryRequired = [
    "APPLICATION_ACTIVATION_OUTCOME_UNRESOLVED", "APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED",
    "APPLICATION_ACTIVATION_RECOVERY_OBSERVATION_REQUIRED", "APPLICATION_ACTIVATION_NOT_RECOVERABLE",
  ].includes(code);
  return status(503, {
    ...identity, code: recoveryRequired ? "APPLICATION_ACTIVATION_RECONCILIATION_REQUIRED" : "APPLICATION_ACTIVATION_OUTCOME_UNKNOWN",
    error: "Application activation outcome requires observation",
  });
}

interface ApplicationRouteDependencies {
  storage?: ApplicationReleaseStorage;
  authorize?: typeof requireProjectOrAdminAuth;
  projectExists?: (projectRef: string) => Promise<boolean>;
  active?: Pick<ApplicationActiveStorage, "readForApplication">;
  readiness?: Pick<ApplicationReadiness, "inspect">;
  migrations?: Pick<ApplicationMigrations, "inspect">;
  configurations?: Pick<ApplicationConfigurations, "read" | "put">;
  deployment?: Pick<ApplicationDeploymentService, "activateConfigured" | "reconcile" | "retireConfigured">;
  executions?: ReleaseExecutionStore;
  retirementVerifier?: unknown;
  principal?: typeof getVerifiedRequestPrincipal;
}

async function projectExists(ref: string): Promise<boolean> {
  const rows: unknown = await sql`SELECT ref FROM projects WHERE ref = ${ref} AND deleted_at IS NULL LIMIT 1`;
  return Array.isArray(rows) && rows.length === 1;
}

const params = t.Object({
  ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }),
  id: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
});

export function createApplicationRoutes(dependencies: ApplicationRouteDependencies = {}) {
  const storage = dependencies.storage ?? new ApplicationReleaseStorage();
  const authorize = dependencies.authorize ?? requireProjectOrAdminAuth;
  const exists = dependencies.projectExists ?? projectExists;
  const active = dependencies.active ?? new ApplicationActiveStorage();
  const readiness = dependencies.readiness ?? new ApplicationReadiness();
  const migrations = dependencies.migrations ?? new ApplicationMigrations({ storage });
  const configurations = dependencies.configurations ?? new ApplicationConfigurations();
  const executions = dependencies.executions;
  const environmentParams = t.Object({
    ...params.properties, ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
    environmentId: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  });
  const scope = (values: { ref: string; id: string; environmentId: string }) => ({
    projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
  });
  const routes = new Elysia({ prefix: "/v1/projects/:ref/applications", name: "application-releases" })
    .error(({ error }) => {
      if (error instanceof ApplicationReleaseError || error instanceof ApplicationConfigurationError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof ApplicationDevelopmentError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof ReleaseEvidenceError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof ReleaseExecutionError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof Error && "code" in error && error.code === "not-found") {
        return status(404, { code: "APPLICATION_ROUTE_NOT_FOUND", error: "Application route not found" });
      }
      if (error instanceof Error && "code" in error
        && (error.code === "validation" || error.code === "parse")) {
        return status(error.code === "parse" ? 400 : 422,
          { code: "APPLICATION_REQUEST_INVALID", error: "Invalid application request" });
      }
      return status(500, { code: "APPLICATION_RELEASE_FAILED", error: "Application release request failed" });
    })
    .beforeHandle(async ({ request, params: values }) => {
      const denied = await authorize(request, values.ref);
      if (denied) return status(denied.status, denied.body);
      if (!await exists(values.ref)) return status(404, { code: "PROJECT_NOT_FOUND", error: "Project not found" });
    })
    .get("/:id/environments/:environmentId/configuration", {
      params: environmentParams,
      detail: { tags: ["applications"], summary: "Read current environment configuration metadata without variable values" },
    }, async ({ params: values }) => ({
      project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
      configuration: await configurations.read(scope(values)),
    }))
    .get("/:id/environments/:environmentId/configurations/:configurationId", {
      params: t.Object({ ...environmentParams.properties, configurationId: ApplicationConfigurationIdSchema }),
      detail: { tags: ["applications"], summary: "Read an immutable configuration revision without variable values" },
    }, async ({ params: values }) => {
      const configuration = await configurations.read(scope(values), values.configurationId);
      if (!configuration) return status(404, { code: "APPLICATION_CONFIGURATION_NOT_FOUND", error: "Configuration not found" });
      return { project_ref: values.ref, application_id: values.id, environment_id: values.environmentId, configuration };
    })
    .put("/:id/environments/:environmentId/configuration", {
      params: environmentParams, body: ApplicationConfigurationWriteSchema,
      detail: { tags: ["applications"], summary: "Save an environment configuration revision without activating it" },
    }, async ({ params: values, body }) => ({
      project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
      configuration: await configurations.put(scope(values), body),
    }))
    .get("/:id/environments/:environmentId/runtime", {
      params: t.Object({
        ...params.properties, ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
        environmentId: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
      }),
      detail: { tags: ["applications"], summary: "Observe the active application runtime without changing it" },
    }, async ({ params: values }) => {
      const read = () => active.readForApplication(values.ref, values.id, values.environmentId);
      const current = await read();
      const report = current === null ? null : await readiness.inspect(current.runtime);
      if (stableStringify(current) !== stableStringify(await read())) {
        return status(409, { code: "APPLICATION_RUNTIME_CHANGED", error: "Application activation changed during observation" });
      }
      return {
        project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
        ...(current?.configurationId ? { configuration_id: current.configurationId } : {}),
        readiness: report,
      };
    })
    .get("/:id/releases", {
      params,
      query: t.Object({
        cursor: t.Optional(t.String({ pattern: "^[a-f0-9]{64}$" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      detail: { tags: ["applications"], summary: "List stored application releases" },
    }, ({ params: values, query }) =>
      storage.listReleases(values.ref, values.id, query))
    .get("/:id/releases/:releaseId/migrations", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      detail: { tags: ["applications"], summary: "Compare archived release migrations with the project ledger without executing SQL" },
    }, ({ params: values }) =>
      migrations.inspect(values.ref, values.id, values.releaseId))
    .get("/:id/releases/:releaseId", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      detail: { tags: ["applications"], summary: "Read and verify an application release" },
    }, async ({ params: values }) => ({
      project_ref: values.ref, application_id: values.id,
      release: await storage.readRelease(values.ref, values.id, values.releaseId),
    }))
    .get("/:id/releases/:releaseId/development", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      query: t.Object({ target: t.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }) }),
      detail: { tags: ["applications"], summary: "Read the validated application development contract from an immutable release target" },
    }, async ({ params: values, query }) => {
      const { archive } = await storage.readArchive(values.ref, values.id, values.releaseId);
      const development = extractApplicationDevelopment(archive, query.target);
      return {
        project_ref: values.ref, application_id: values.id, release_id: values.releaseId,
        target: development.delivery.target, object_id: development.delivery.objectId,
        correlation: development.correlation, context: development.context,
      };
    })
    .get("/:id/releases/:releaseId/evidence", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      query: t.Object({ target: t.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }) }),
      detail: { tags: ["applications"], summary: "Summarize one immutable release target as verified release evidence" },
    }, async ({ params: values, query }) => {
      const { record, archive } = await storage.readArchive(values.ref, values.id, values.releaseId);
      const { archives } = await storage.readMigrations(values.ref, values.id, values.releaseId);
      return {
        project_ref: values.ref, application_id: values.id, release_id: values.releaseId,
        ...createReleaseEvidence({ record, archive, migrations: archives, target: query.target }),
      };
    })
    .post("/:id/releases/:releaseId/execution", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      query: t.Object({ target: t.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }) }),
      body: t.Object({
        observations: t.Optional(t.Object({
          application: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
          migrations: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
          configuration: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
          resources: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
          secrets: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
          health: t.Optional(t.Object({ status: t.Union([t.Literal("succeeded"), t.Literal("failed"), t.Literal("unknown")]), version: t.Optional(t.String({ maxLength: 128 })), detail: t.Optional(t.String({ maxLength: 512 })), observedAt: t.Optional(t.String({ maxLength: 64 })) }, { additionalProperties: false })),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      detail: { tags: ["applications"], summary: "Record per-component release execution results without a store" },
    }, async ({ params: values, query, body }) => {
      const { record } = await storage.readArchive(values.ref, values.id, values.releaseId);
      const document = createReleaseExecution({ record, target: query.target, observations: body.observations });
      if (executions) await executions.save(values.ref, values.id, document);
      return {
        project_ref: values.ref, application_id: values.id,
        stored: executions !== undefined,
        ...document,
      };
    })
    .get("/:id/releases/:releaseId/execution", {
      params: t.Object({ ...params.properties, releaseId: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
      query: t.Object({ target: t.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }) }),
      detail: { tags: ["applications"], summary: "Read a recorded per-component release execution result" },
    }, async ({ params: values, query }) => {
      if (!executions) {
        return status(501, { code: "RELEASE_EXECUTION_STORE_UNAVAILABLE", error: "Release execution store is not configured" });
      }
      const document = await executions.read(values.ref, values.id, values.releaseId, query.target);
      if (!document) return status(404, { code: "RELEASE_EXECUTION_NOT_RECORDED", error: "Release execution is not recorded" });
      return { project_ref: values.ref, application_id: values.id, ...document };
    })
    .post("/:id/releases", {
      params, parse: "none",
      detail: { tags: ["applications"], summary: "Upload an immutable HTTP/Worker release without activating it" },
    }, async ({ params: values, request }) => {
      const release = await uploadApplicationRelease(request, values.ref, values.id, storage);
      return status(201, { project_ref: values.ref, application_id: values.id, release });
    });
  // Register writes only with a composed deployment service, including its
  // mandatory application compatibility verifier. Upload-only hosts stay inert.
  const deployment = dependencies.deployment;
  if (deployment) {
    const principal = dependencies.principal ?? getVerifiedRequestPrincipal;
    const failure = t.Object({
      project_ref: t.String(), application_id: t.String(), environment_id: t.String(),
      activation_id: ApplicationActivationIdSchema, code: t.String(), error: t.String(),
    });
    const response = {
      200: ApplicationActivationResultSchema,
      401: t.Object({ code: t.Optional(t.String()), error: t.String() }),
      409: failure,
      503: failure,
    };
    routes.post("/:id/environments/:environmentId/activations", {
      params: environmentParams, body: ApplicationActivationWriteSchema,
      response,
      detail: { tags: ["applications"], summary: "Activate a stored release using an immutable configuration revision" },
    }, async ({ params: values, body, request }) => {
      const actor = await principal(request);
      if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
      try {
        const release = await storage.readRelease(values.ref, values.id, body.release_id);
        return await deployment.activateConfigured({
          runtime: { release, environmentId: values.environmentId, activationId: body.activation_id },
          configurationId: body.configuration_id, expectedActivationId: body.expected_activation_id,
          principal: actor,
        });
      } catch (error) {
        return activationFailure(error, {
          project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
          activation_id: body.activation_id,
        });
      }
    });
    routes.post("/:id/environments/:environmentId/activations/:activationId/reconcile",
      {
        params: t.Object({ ...environmentParams.properties, activationId: ApplicationActivationIdSchema }),
        body: t.Object({}, { additionalProperties: false }),
        response,
        detail: { tags: ["applications"], summary: "Confirm an already committed activation without replaying runtime effects" },
      }, async ({ params: values, request }) => {
        const actor = await principal(request);
        if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
        try {
          return await deployment.reconcile({ ...scope(values), activationId: values.activationId, principal: actor });
        } catch (error) {
          return activationFailure(error, {
            project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
            activation_id: values.activationId,
          });
        }
      });
    if (dependencies.retirementVerifier) routes.post("/:id/environments/:environmentId/activations/:activationId/retire",
      {
        params: t.Object({ ...environmentParams.properties, activationId: ApplicationActivationIdSchema }),
        body: t.Object({}, { additionalProperties: false }),
        response: { 200: ApplicationActivationRetirementResultSchema, 401: response[401], 409: response[409], 503: response[503] },
        detail: { tags: ["applications"], summary: "Release a stopped and unrouted activation allocation with explicit verifier proof" },
      }, async ({ params: values, request }) => {
        const actor = await principal(request);
        if (!actor) return status(401, { code: "UNAUTHORIZED", error: "Verified principal required" });
        try {
          return await deployment.retireConfigured({
            projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
            activationId: values.activationId, principal: actor,
          });
        } catch (error) {
          return activationFailure(error, {
            project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
            activation_id: values.activationId,
          });
        }
      });
  }
  return routes;
}

export const applicationRoutes = createApplicationRoutes();

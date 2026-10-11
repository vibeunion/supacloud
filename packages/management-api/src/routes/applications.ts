import { Elysia, status, t } from "elysia";
import {
  ApplicationConfigurationWriteSchema, ApplicationConfigurationIdSchema,
  ApplicationActivationIdSchema, ApplicationActivationWriteSchema, ApplicationActivationResultSchema,
  ApplicationActivationRetirementResultSchema, ApplicationRollbackSnapshotSchema, DeploymentEvidenceSchema, parseDeploymentEvidence,
  ApplicationReleaseTransferPlanSchema, ApplicationReleaseTransferResultSchema,
  ApplicationPromotionPlanSchema,
  ApplicationActivationHistorySchema, ApplicationActivationHistoryCursorSchema, type DeploymentEvidence,
} from "@supacloud/delivery";
import { sql } from "../db";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { ApplicationReleaseError, ApplicationReleaseStorage } from "../services/application-release-storage";
import { ApplicationReleaseTransfers, ApplicationReleaseTransferError } from "../services/application-release-transfer";
import { ApplicationDevelopmentError, extractApplicationDevelopment } from "../services/application-development.service";
import { uploadApplicationRelease } from "../services/application-release-upload";
import { ApplicationActiveStorage } from "../services/application-active-storage";
import { ApplicationReadiness } from "../services/application-readiness";
import { ApplicationMigrations } from "../services/application-migrations";
import { ApplicationConfigurations, ApplicationConfigurationError } from "../services/application-configuration";
import { stableStringify } from "../utils/stable-json";
import type { ApplicationDeploymentService } from "../services/application-deployment";
import { ConflictError } from "../utils/errors";
import { ApplicationDeploymentEvidenceStorage } from "../services/application-deployment-evidence";
import { ApplicationDeploymentEvidenceObserver } from "../services/application-deployment-evidence-observer";
import { victoriaLogsService } from "../services/victorialogs.service";
import { applicationRuntimePlan } from "../services/application-runtime";
import { buildApplicationPreviewReceipt } from "../services/application-preview-contract";
import { ApplicationPreviewService, APPLICATION_PREVIEW_MIN_TTL_SECONDS, APPLICATION_PREVIEW_MAX_TTL_SECONDS } from "../services/application-preview.service";
import { ApplicationDeployPlans, ApplicationDeployPlanError } from "../services/application-deploy-plan";
import { ApplicationRollbackError, ApplicationRollbackSnapshots } from "../services/application-rollback";
import { ApplicationActivationHistoryReader, ApplicationHistoryError } from "../services/application-history";
import {
  ApplicationPromotions, ApplicationPromotionError, createDefaultApplicationPromotions,
} from "../services/application-promotion";

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
  promotions?: Pick<ApplicationPromotions, "readPlan">;
  transfers?: Pick<ApplicationReleaseTransfers, "readPlan" | "transfer">;
  deployPlans?: Pick<ApplicationDeployPlans, "read">;
  storage?: ApplicationReleaseStorage;
  authorize?: typeof requireProjectOrAdminAuth;
  projectExists?: (projectRef: string) => Promise<boolean>;
  active?: Pick<ApplicationActiveStorage, "readForApplication">;
  readiness?: Pick<ApplicationReadiness, "inspect">;
  migrations?: Pick<ApplicationMigrations, "inspect">;
  configurations?: Pick<ApplicationConfigurations, "read" | "put">;
  evidence?: Pick<ApplicationDeploymentEvidenceStorage, "read" | "write">;
  evidenceObserver?: Pick<ApplicationDeploymentEvidenceObserver, "observe">;
  deployment?: Pick<ApplicationDeploymentService, "activateConfigured" | "reconcile" | "retireConfigured">;
  retirementVerifier?: unknown;
  principal?: typeof getVerifiedRequestPrincipal;
  previews?: ApplicationPreviewService;
  rollback?: Pick<ApplicationRollbackSnapshots, "read">;
  history?: Pick<ApplicationActivationHistoryReader, "read">;
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
  const transfers = dependencies.transfers ?? new ApplicationReleaseTransfers(storage);
  const promotions = dependencies.promotions ?? createDefaultApplicationPromotions();
  const sourceAccess = async (request: Request, ref: string, id: string, releaseId: string) => {
    const url = new URL(request.url);
    url.pathname = `/v1/projects/${ref}/applications/${id}/releases/${releaseId}`;
    url.search = "";
    // 重新构造源 GET 请求，使项目 scope 和委托读取权限均基于源路径。
    const sourceRequest = new Request(url, { method: "GET", headers: request.headers });
    const denied = await authorize(sourceRequest, ref);
    if (denied) throw new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_SOURCE_DENIED", denied.status);
    if (!await exists(ref)) throw new ApplicationReleaseTransferError("APPLICATION_RELEASE_TRANSFER_SOURCE_NOT_FOUND", 404);
  };
  const active = dependencies.active ?? new ApplicationActiveStorage();
  const readiness = dependencies.readiness ?? new ApplicationReadiness();
  const migrations = dependencies.migrations ?? new ApplicationMigrations({ storage });
  const configurations = dependencies.configurations ?? new ApplicationConfigurations();
  const evidence = dependencies.evidence ?? new ApplicationDeploymentEvidenceStorage();
  const evidenceObserver = dependencies.evidenceObserver;
  const previews = dependencies.previews ?? new ApplicationPreviewService({ releases: storage });
  const deployPlans = dependencies.deployPlans ?? new ApplicationDeployPlans({
    releases: storage, active, readiness, migrations,
  });
  const rollback = dependencies.rollback ?? new ApplicationRollbackSnapshots({ active, releases: storage });
  const history = dependencies.history ?? new ApplicationActivationHistoryReader({ active });
  const persistObservedEvidence = async (values: { ref: string; id: string; environmentId: string }) => {
    if (!evidenceObserver) return;
    try {
      const observed = await evidenceObserver.observe(scope(values));
      if (observed) await evidence.write(observed);
    } catch {
      // Evidence is a readback artifact. A failed observer must not replay or
      // invalidate an already committed activation; the next refresh exposes it.
    }
  };
  const environmentParams = t.Object({
    ...params.properties, ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
    environmentId: t.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  });
  const scope = (values: { ref: string; id: string; environmentId: string }) => ({
    projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
  });
  const routes = new Elysia({ prefix: "/v1/projects/:ref/applications", name: "application-releases" })
    .error(({ error }) => {
      if (error instanceof ApplicationPromotionError) {
        return status(error.statusCode, { code: error.code, error: "Application promotion plan is unavailable" });
      }
      if (error instanceof ApplicationReleaseTransferError) {
        return status(error.statusCode, { code: error.code, error: "Application release transfer is unavailable" });
      }
      if (error instanceof ApplicationDeployPlanError) {
        return status(error.statusCode, { code: error.code, error: "Application deploy plan is unavailable" });
      }
      if (error instanceof ApplicationReleaseError || error instanceof ApplicationConfigurationError) {
        return status(error.statusCode, { code: error.code, error: error.message });
      }
      if (error instanceof ApplicationRollbackError) {
        return status(error.statusCode, { code: error.code, error: "Application rollback snapshot is unavailable" });
      }
      if (error instanceof ApplicationHistoryError) {
        return status(error.statusCode, { code: error.code, error: "Application activation history is unavailable" });
      }
      if (error instanceof ApplicationDevelopmentError) {
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
    .get("/:id/environments/:environmentId/promotion-plan", {
      params: environmentParams,
      response: { 200: ApplicationPromotionPlanSchema },
      query: t.Object({
        source_ref: t.String({ pattern: "^[a-z0-9-]{1,20}$" }),
        source_environment_id: environmentParams.properties.environmentId,
        source_release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
        configuration_id: t.Optional(ApplicationConfigurationIdSchema),
      }, { additionalProperties: false }),
      beforeHandle: async ({ params: values, query, request }) => {
        await sourceAccess(request, query.source_ref, values.id, query.source_release_id);
        const url = new URL(request.url);
        url.pathname = `/v1/projects/${query.source_ref}/applications/${values.id}/environments/${query.source_environment_id}/runtime`;
        url.search = "";
        const denied = await authorize(new Request(url, { method: "GET", headers: request.headers }), query.source_ref);
        if (denied) throw new ApplicationPromotionError("APPLICATION_PROMOTION_SOURCE_DENIED", denied.status);
      },
      detail: { tags: ["applications"], summary: "Plan an immutable environment promotion without executing changes" },
    }, ({ params: values, query }) => promotions.readPlan({
      projectRef: values.ref, applicationId: values.id, environmentId: values.environmentId,
      sourceProjectRef: query.source_ref, sourceEnvironmentId: query.source_environment_id,
      sourceReleaseId: query.source_release_id,
      ...(query.configuration_id === undefined ? {} : { configurationId: query.configuration_id }),
    }))
    .get("/:id/environments/:environmentId/deploy-plan", {
      params: environmentParams,
      query: t.Object({
        release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
        configuration_id: ApplicationConfigurationIdSchema,
      }),
      detail: { tags: ["applications"], summary: "Compare a stored candidate with verified active state without runtime effects" },
    }, ({ params: values, query }) => deployPlans.read({
      ...scope(values), releaseId: query.release_id, configurationId: query.configuration_id,
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
    .get("/:id/environments/:environmentId/history", {
      params: environmentParams,
      query: t.Object({
        cursor: t.Optional(ApplicationActivationHistoryCursorSchema),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      response: { 200: ApplicationActivationHistorySchema },
      detail: { tags: ["applications"], summary: "Read successful activation journal history without inspecting artifacts" },
    }, ({ params: values, query }) => history.read(scope(values), query))
    .get("/:id/environments/:environmentId/rollback-snapshot", {
      params: environmentParams,
      response: { 200: ApplicationRollbackSnapshotSchema },
      detail: { tags: ["applications"], summary: "Observe the journal-verified previous activation and current rollback CAS" },
    }, ({ params: values }) => rollback.read(scope(values)))
    .get("/:id/environments/:environmentId/deployment-evidence", {
      params: environmentParams,
      detail: { tags: ["applications"], summary: "Read the last validated single-node deployment evidence" },
    }, async ({ params: values }) => ({
      project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
      evidence: await evidence.read(values.ref, values.id, values.environmentId),
    }))
    .get("/:id/environments/:environmentId/logs", {
      params: environmentParams,
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 1000, multipleOf: 1 })),
        offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000, multipleOf: 1 })),
        service: t.Optional(t.String()),
        search: t.Optional(t.String()),
        start: t.Optional(t.String()),
        end: t.Optional(t.String()),
      }),
      detail: { tags: ["applications"], summary: "Read logs for the current application activation" },
    }, async ({ params: values, query }) => {
      const current = await active.readForApplication(values.ref, values.id, values.environmentId);
      if (!current) {
        return {
          project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
          release_id: null, activation_id: null, result: [], pagination: {
            offset: query.offset ?? 0, limit: query.limit ?? 200, total: 0,
          },
        };
      }
      const runtime = current.runtime;
      const plan = applicationRuntimePlan(runtime);
      const targets = query.service && query.service !== "all"
        ? plan.targets.filter(target => target.name === query.service || target.sourceTarget === query.service)
        : plan.targets;
      if (query.service && query.service !== "all" && targets.length === 0) {
        return {
          project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
          release_id: runtime.release.release_id, activation_id: runtime.activationId, result: [], pagination: {
            offset: query.offset ?? 0, limit: query.limit ?? 200, total: 0,
          },
        };
      }
      const result = await victoriaLogsService.queryProjectLogs(values.ref, {
        units: targets.map(target => target.unit),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.start === undefined ? {} : { start: query.start }),
        ...(query.end === undefined ? {} : { end: query.end }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
      return {
        project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
        release_id: runtime.release.release_id, activation_id: runtime.activationId,
        result,
        pagination: {
          offset: query.offset ?? 0, limit: query.limit ?? 200, total: result.length,
        },
      };
    })
    .get("/:id/environments/:environmentId/preview-plan", {
      params: environmentParams,
      query: t.Object({
        release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
        branch_ref: t.String({ pattern: "^[A-Za-z0-9_-]{1,20}$" }),
        data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
        configuration_id: t.Optional(t.String({ format: "uuid" })),
        ttl_seconds: t.Optional(t.Integer({ minimum: APPLICATION_PREVIEW_MIN_TTL_SECONDS, maximum: APPLICATION_PREVIEW_MAX_TTL_SECONDS })),
      }),
      detail: { tags: ["applications"], summary: "Build a read-only isolated application preview plan" },
    }, async ({ params: values, query }) => {
      const release = await storage.readRelease(values.ref, values.id, query.release_id);
      return buildApplicationPreviewReceipt({
        previewId: crypto.randomUUID(),
        projectRef: values.ref,
        applicationId: values.id,
        environmentId: values.environmentId,
        releaseId: release.release_id,
        branchRef: query.branch_ref,
        dataMode: query.data_mode ?? "schema_only",
        ...(query.ttl_seconds === undefined ? {} : { expiresAt: new Date(Date.now() + query.ttl_seconds * 1000).toISOString() }),
      });
    })
    .get("/:id/environments/:environmentId/previews", {
      params: environmentParams,
      detail: { tags: ["applications"], summary: "List application preview receipts" },
    }, async ({ params: values }) => ({
      project_ref: values.ref,
      application_id: values.id,
      environment_id: values.environmentId,
      previews: await previews.list(values.ref, values.id, values.environmentId),
    }))
    .post("/:id/environments/:environmentId/previews", {
      params: environmentParams,
      body: t.Object({
        release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
        branch_name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
        data_mode: t.Optional(t.Union([t.Literal("schema_only"), t.Literal("full_clone")])),
        configuration_id: t.Optional(t.String({ format: "uuid" })),
        ttl_seconds: t.Optional(t.Integer({ minimum: APPLICATION_PREVIEW_MIN_TTL_SECONDS, maximum: APPLICATION_PREVIEW_MAX_TTL_SECONDS })),
      }),
      detail: { tags: ["applications"], summary: "Provision an isolated application preview" },
    }, async ({ params: values, body }) => {
      const receipt = await previews.create({
        projectRef: values.ref,
        applicationId: values.id,
        environmentId: values.environmentId,
        releaseId: body.release_id,
        ...(body.branch_name === undefined ? {} : { branchName: body.branch_name }),
        ...(body.data_mode === undefined ? {} : { dataMode: body.data_mode }),
        ...(body.configuration_id === undefined ? {} : { configurationId: body.configuration_id }),
        ...(body.ttl_seconds === undefined ? {} : { ttlSeconds: body.ttl_seconds }),
      });
      return status(202, receipt);
    })
    .get("/:id/environments/:environmentId/previews/:previewId", {
      params: t.Object({ ...environmentParams.properties, previewId: t.String({ pattern: "^[a-f0-9-]{8,64}$" }) }),
      detail: { tags: ["applications"], summary: "Read an application preview receipt" },
    }, async ({ params: values }) => {
      const receipt = await previews.read(values.ref, values.previewId);
      if (!receipt || receipt.application_id !== values.id || receipt.environment_id !== values.environmentId) {
        return status(404, { code: "APPLICATION_PREVIEW_NOT_FOUND", error: "Application preview not found" });
      }
      return await previews.get(values.ref, values.previewId);
    })
    .delete("/:id/environments/:environmentId/previews/:previewId", {
      params: t.Object({ ...environmentParams.properties, previewId: t.String({ pattern: "^[a-f0-9-]{8,64}$" }) }),
      detail: { tags: ["applications"], summary: "Clean up an application preview" },
    }, async ({ params: values }) => {
      const receipt = await previews.read(values.ref, values.previewId);
      if (!receipt || receipt.application_id !== values.id || receipt.environment_id !== values.environmentId) {
        return status(404, { code: "APPLICATION_PREVIEW_NOT_FOUND", error: "Application preview not found" });
      }
      return await previews.cleanup(values.ref, values.previewId);
    })
    .put("/:id/environments/:environmentId/deployment-evidence", {
      params: environmentParams,
      body: DeploymentEvidenceSchema,
      detail: { tags: ["applications"], summary: "Persist validated single-node deployment evidence" },
    }, async ({ params: values, body }) => {
      const parsed = parseDeploymentEvidence(body as DeploymentEvidence);
      if (parsed.scope.project_ref !== values.ref
        || parsed.scope.application_id !== values.id
        || parsed.scope.environment_id !== values.environmentId) {
        return status(409, {
          code: "APPLICATION_DEPLOYMENT_EVIDENCE_SCOPE_MISMATCH",
          error: "Evidence scope does not match the route",
        });
      }
      return {
        project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
        evidence: await evidence.write(parsed),
      };
    })
    .post("/:id/environments/:environmentId/deployment-evidence/refresh", {
      params: environmentParams,
      detail: { tags: ["applications"], summary: "Observe and persist current single-node deployment evidence" },
    }, async ({ params: values }) => {
      if (!evidenceObserver) {
        return status(503, {
          code: "APPLICATION_DEPLOYMENT_EVIDENCE_OBSERVER_UNAVAILABLE",
          error: "Deployment evidence observer is unavailable",
        });
      }
      const observed = await evidenceObserver.observe(scope(values));
      if (!observed) {
        return status(409, {
          code: "APPLICATION_DEPLOYMENT_EVIDENCE_RUNTIME_NOT_ACTIVE",
          error: "No active application runtime is available for evidence observation",
        });
      }
      return {
        project_ref: values.ref, application_id: values.id, environment_id: values.environmentId,
        evidence: await evidence.write(observed),
      };
    })
    .get("/:id/release-transfer-plan", {
      params,
      response: { 200: ApplicationReleaseTransferPlanSchema },
      query: t.Object({
        source_ref: params.properties.ref,
        source_release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
      }, { additionalProperties: false }),
      beforeHandle: ({ params: values, query, request }) =>
        sourceAccess(request, query.source_ref, values.id, query.source_release_id),
      detail: { tags: ["applications"], summary: "Compare a verified source artifact with target inventory without copying or activating" },
    }, ({ params: values, query }) =>
      transfers.readPlan({
        projectRef: values.ref, applicationId: values.id,
        sourceProjectRef: query.source_ref, sourceReleaseId: query.source_release_id,
      }))
    .post("/:id/release-transfers", {
      params,
      response: { 200: ApplicationReleaseTransferResultSchema },
      body: t.Object({
        source_ref: params.properties.ref,
        source_release_id: t.String({ pattern: "^[a-f0-9]{64}$" }),
        expected_manifest_sha256: t.String({ pattern: "^[a-f0-9]{64}$" }),
      }, { additionalProperties: false }),
      beforeHandle: ({ params: values, body, request }) =>
        sourceAccess(request, body.source_ref, values.id, body.source_release_id),
      detail: { tags: ["applications"], summary: "Materialize a verified artifact in the target project without build, configuration copying or activation" },
    }, ({ params: values, body }) =>
      transfers.transfer({
        projectRef: values.ref, applicationId: values.id, sourceProjectRef: body.source_ref,
        sourceReleaseId: body.source_release_id, expectedManifestSha256: body.expected_manifest_sha256,
      }))
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
        const result = await deployment.activateConfigured({
          runtime: { release, environmentId: values.environmentId, activationId: body.activation_id },
          configurationId: body.configuration_id, expectedActivationId: body.expected_activation_id,
          principal: actor,
        });
        await persistObservedEvidence(values);
        return result;
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
          const result = await deployment.reconcile({ ...scope(values), activationId: values.activationId, principal: actor });
          await persistObservedEvidence(values);
          return result;
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

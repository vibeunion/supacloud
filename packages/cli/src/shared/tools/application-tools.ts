import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  applicationReleaseId, parseApplicationReleaseRecord, readDeliveryExecutableArchive,
  parseApplicationReadinessReport,
  parseApplicationConfigurationWrite, parseApplicationConfigurationView,
  parseDeploymentEvidence,
  parseApplicationActivationHistory, parseApplicationHistoryCursor, applicationHistoryPositionBefore,
  parseApplicationDeployPlan, type ApplicationDeployPlan, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationReleaseRecordSchema,
  ApplicationConfigurationIdSchema, ApplicationActivationIdSchema, ApplicationActivationWriteSchema,
  ApplicationActivationResultSchema, ApplicationActivationRetirementResultSchema, ApplicationRollbackSnapshotSchema,
  ApplicationActivationHistoryCursorSchema,
} from "./application-schemas";
import { canonical, digest } from "@supacloud/delivery/files";
import { optional, stringEnum, withDescription, type ToolSchema } from "../schema";
import { projectRefPathSegment } from "../project-ref";
import type { HttpResult, HttpTransport } from "../transports/http";
import { registerTool, type ToolServer } from "../tool-server";
import {
  releaseControlFailure, releaseControlMutationFailure, releaseControlSuccess, type ReleaseControlToolResponse,
} from "./release-control-response";
import { APPLICATION_PREVIEW_ACTIONS, APPLICATION_PREVIEW_FIELDS, applicationPreviewAction } from "./application-preview-tools";

export const APPLICATION_TOOL_SCHEMA = {
  action: withDescription(stringEnum([
    "list_releases", "get_release", "upload_release", "get_runtime", "get_deployment_evidence",
    "get_configuration", "put_configuration", "get_deploy_plan", "deploy_release",
    "activate_release", "rollback_release", "get_rollback_snapshot", "get_history", "reconcile_activation", "retire_activation",
    ...APPLICATION_PREVIEW_ACTIONS,
    "logs",
  ]), "Action"),
  ref: withDescription(Type.String(), "Project ref"),
  id: withDescription(ApplicationIdSchema, "Application ID"),
  environment_id: optional(withDescription(ApplicationIdSchema, "[get_runtime/get_configuration/put_configuration/get_deploy_plan/deploy_release/get_rollback_snapshot/rollback_release/get_history] Environment ID")),
  configuration_id: optional(ApplicationConfigurationIdSchema, "[get_configuration/get_deploy_plan/deploy_release/activate_release/rollback_release/get_history] Immutable revision; required for deployment"),
  activation_id: optional(ApplicationActivationIdSchema, "[deploy_release/activate_release/reconcile_activation/retire_activation/rollback_release/get_history] Stable activation ID; generated for automatic deployment/rollback if omitted"),
  expected_activation_id: optional(Type.Union([ApplicationActivationIdSchema, Type.Null(), Type.Literal("absent")]),
    "[deploy_release/activate_release/rollback_release] Current activation ID, or absent for first activation; selected from verified plan for automatic deployment"),
  configuration_path: optional(Type.String(), "[put_configuration] Local configuration write JSON including revision and expected revision"),
  manifest_path: optional(Type.String(), "[upload_release] Local delivery.manifest.json"),
  release_id: optional(ApplicationReleaseIdSchema, "[get_release/get_deploy_plan/deploy_release/activate_release/reconcile_activation/rollback_release] Immutable application release ID; platform selects previous for default rollback"),
  cursor: optional(Type.Union([ApplicationReleaseIdSchema, ApplicationActivationHistoryCursorSchema]), "[list_releases/get_history] Returned page cursor"),
  limit: optional(Type.Integer({ minimum: 1, maximum: 100 }), "[list_releases/get_history] Page size, default 50/20"),
  offset: optional(Type.Integer({ minimum: 0, maximum: 1_000_000 }), "[logs] Result offset"),
  service: optional(Type.String(), "[logs] Application target/service filter"),
  search: optional(Type.String(), "[logs] Full-text log filter"),
  start: optional(Type.String(), "[logs] ISO start timestamp"),
  end: optional(Type.String(), "[logs] ISO end timestamp"),
  ...APPLICATION_PREVIEW_FIELDS,
};
const responseSchema = Type.Object({
  project_ref: Type.String(), application_id: ApplicationIdSchema, release: ApplicationReleaseRecordSchema,
});
const inventorySchema = Type.Object({
  project_ref: Type.String(), application_id: ApplicationIdSchema,
  releases: Type.Array(ApplicationReleaseRecordSchema, { maxItems: 100 }),
  next_cursor: Type.Union([ApplicationReleaseIdSchema, Type.Null()]),
});

function text(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`'${field}' is required`);
  return value.trim();
}

function boundRelease(value: unknown, ref: string, id: string): ApplicationReleaseRecord {
  const release = parseApplicationReleaseRecord(value);
  if (release.project_ref !== ref || release.application_id !== id) throw new Error("Unbound application release");
  return release;
}

async function readDeployPlan(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const ref = text(args, "ref"), id = text(args, "id"), environmentId = text(args, "environment_id");
  const releaseId = text(args, "release_id"), configurationId = text(args, "configuration_id");
  if (!Value.Check(ApplicationIdSchema, environmentId) || !Value.Check(ApplicationReleaseIdSchema, releaseId)
    || !Value.Check(ApplicationConfigurationIdSchema, configurationId)) throw new Error("Invalid deployment plan identity");
  const identity = { project_ref: ref, application_id: id, environment_id: environmentId,
    release_id: releaseId, configuration_id: configurationId };
  const query = new URLSearchParams({ release_id: releaseId, configuration_id: configurationId });
  const response = await http.get(
    `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/deploy-plan?${query}`,
    { maxJsonBytes: 65_536, responseTimeoutMs: 30_000 },
  );
  const operation = `applications.${text(args, "action")}`;
  if (!response.ok) return { failure: releaseControlFailure(operation, "HTTP_ERROR",
    response.transportError ? null : response.status, identity) };
  let plan: ApplicationDeployPlan;
  try {
    if (response.status !== 200) throw new Error("Incomplete deployment plan response");
    plan = parseApplicationDeployPlan(response.data);
    if (plan.project_ref !== ref || plan.application_id !== id || plan.environment_id !== environmentId
      || plan.candidate.release_id !== releaseId || plan.candidate.configuration_id !== configurationId) throw new Error();
  } catch { return { failure: releaseControlFailure(operation, "INVALID_RESPONSE", response.status, identity) }; }
  return { plan, identity };
}

async function deployAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const activationId = args["activation_id"], expected = args["expected_activation_id"];
  if (activationId !== undefined && !Value.Check(ApplicationActivationIdSchema, activationId)) {
    throw new Error("Invalid application activation ID");
  }
  if (expected !== undefined && expected !== null && expected !== "absent"
    && !Value.Check(ApplicationActivationIdSchema, expected)) throw new Error("Invalid expected activation ID");
  // 显式重试保留原请求身份和 CAS，不重新规划，不重放未知结果。
  if (activationId !== undefined && expected !== undefined) {
    return activationAction(http, { ...args, action: "activate_release" }, project, {
      operation: "applications.deploy_release", configuration_id: args["configuration_id"],
      expected_activation_id: expected === "absent" ? null : expected,
    });
  }
  const observed = await readDeployPlan(http, args, project);
  if (observed.failure) return observed.failure;
  const { plan, identity } = observed;
  if (expected !== undefined && (expected === "absent" ? null : expected) !== plan.expected_activation_id) {
    return releaseControlFailure("applications.deploy_release", "HTTP_ERROR", 409, {
      ...identity, reason: "EXPECTED_ACTIVATION_CONFLICT", expected_activation_id: plan.expected_activation_id,
    });
  }
  if (plan.action === "no-op") return releaseControlSuccess("applications.deploy_release", {
    ...identity, no_op: true, execution_performed: false,
    activation_id: plan.current!.activation_id, expected_activation_id: plan.expected_activation_id, plan,
    ...(activationId === undefined ? {} : { requested_activation_id: activationId }),
  });
  const selectedId = activationId ?? crypto.randomUUID();
  if (selectedId === plan.expected_activation_id) throw new Error("Deployment requires a new activation ID");
  return activationAction(http, {
    ...args, action: "activate_release", activation_id: selectedId, expected_activation_id: plan.expected_activation_id,
  }, project, {
    operation: "applications.deploy_release", configuration_id: args["configuration_id"],
    expected_activation_id: plan.expected_activation_id,
  });
}

async function configurationAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const action = text(args, "action"), ref = text(args, "ref"), id = text(args, "id");
  const environmentId = text(args, "environment_id"), operation = `applications.${action}`;
  if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
  const path = `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}`;
  let expectedId: string | undefined, result: HttpResult<unknown>;
  if (action === "put_configuration") {
    const file = Bun.file(text(args, "configuration_path"));
    if (file.size > 256 * 1024) throw new Error("Application configuration exceeds size limit");
    let input;
    try { input = parseApplicationConfigurationWrite(await file.json()); }
    catch { throw new Error("Invalid application configuration file"); }
    expectedId = input.configuration_id;
    result = await http.put(`${path}/configuration`, input, { maxJsonBytes: 524_288, responseTimeoutMs: 30_000 });
  } else {
    if (args["configuration_id"] !== undefined && !Value.Check(ApplicationConfigurationIdSchema, args["configuration_id"])) {
      throw new Error("Invalid application configuration ID");
    }
    expectedId = args["configuration_id"] as string | undefined;
    result = await http.get(expectedId ? `${path}/configurations/${expectedId}` : `${path}/configuration`,
      { maxJsonBytes: 524_288, responseTimeoutMs: 30_000 });
  }
  const identity = { project_ref: ref, application_id: id, environment_id: environmentId,
    ...(expectedId ? { configuration_id: expectedId } : {}) };
  if (!result.ok) return action === "put_configuration"
    ? releaseControlMutationFailure(operation, result, identity)
    : releaseControlFailure(operation, "HTTP_ERROR", result.status);
  try {
    const body = result.data;
    if (!body || typeof body !== "object" || !("project_ref" in body) || body.project_ref !== ref
      || !("application_id" in body) || body.application_id !== id
      || !("environment_id" in body) || body.environment_id !== environmentId || !("configuration" in body)) throw new Error();
    const configuration = body.configuration === null ? null : parseApplicationConfigurationView(body.configuration);
    if ((configuration === null && (action === "put_configuration" || expectedId))
      || (configuration && (configuration.project_ref !== ref || configuration.application_id !== id
        || configuration.environment_id !== environmentId
        || (expectedId && configuration.configuration_id !== expectedId)))) throw new Error();
    return releaseControlSuccess(operation, { ...identity, configuration });
  } catch {
    return releaseControlFailure(operation, action === "put_configuration" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
      result.status, identity);
  }
}

async function activationAction(http: HttpTransport, args: Record<string, unknown>, project: string,
  selection?: { operation: string; configuration_id: unknown; expected_activation_id: unknown }) {
  const action = text(args, "action"), ref = text(args, "ref"), id = text(args, "id");
  const environmentId = text(args, "environment_id"), activationId = text(args, "activation_id");
  const releaseId = args["release_id"] === undefined ? undefined : text(args, "release_id");
  if (action === "retire_activation" && releaseId !== undefined) {
    throw new Error("release_id is not accepted for retire_activation");
  }
  if (!Value.Check(ApplicationIdSchema, environmentId)
    || !Value.Check(ApplicationActivationIdSchema, activationId)
    || (action !== "retire_activation" && !Value.Check(ApplicationReleaseIdSchema, releaseId))) {
    throw new Error("Invalid application activation identity");
  }
  const operation = selection?.operation ?? `applications.${action}`;
  const path = `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/activations`;
  const identity = {
    project_ref: ref, application_id: id, environment_id: environmentId,
    activation_id: activationId, ...(releaseId ? { release_id: releaseId } : {}),
  };
  const selectedState = selection ? {
    configuration_id: selection.configuration_id, expected_activation_id: selection.expected_activation_id,
  } : {};
  const safeState = { ...identity, ...selectedState };
  let body: unknown = {};
  if (action === "activate_release") {
    body = {
      activation_id: activationId, release_id: releaseId,
      configuration_id: args["configuration_id"],
      expected_activation_id: args["expected_activation_id"] === "absent" ? null : args["expected_activation_id"],
    };
    if (!Value.Check(ApplicationActivationWriteSchema, body)) throw new Error("Invalid application activation request");
  }
  const endpoint = action === "activate_release" ? path
    : `${path}/${activationId}/${action === "retire_activation" ? "retire" : "reconcile"}`;
  const result = await http.post(endpoint, body,
    { timeoutMs: 120_000, maxJsonBytes: 65_536, responseTimeoutMs: 30_000 });
  if (!result.ok) return releaseControlMutationFailure(operation, result, safeState);
  // These synchronous mutation contracts only acknowledge completion with HTTP 200.
  // An accepted/partial response is not a completed activation, even with valid JSON.
  if (result.status !== 200) return releaseControlFailure(operation, "OUTCOME_UNKNOWN", result.status, safeState);
  if (action === "retire_activation") {
    if (!Value.Check(ApplicationActivationRetirementResultSchema, result.data)
      || Object.entries(identity).some(([key, value]) => Reflect.get(result.data as object, key) !== value)) {
      return releaseControlFailure(operation, "OUTCOME_UNKNOWN", result.status, identity);
    }
    return releaseControlSuccess(operation, result.data);
  }
  if (!Value.Check(ApplicationActivationResultSchema, result.data)
    || Object.entries(identity).some(([key, value]) => Reflect.get(result.data as object, key) !== value)
    || (action === "reconcile_activation" && !result.data.replayed)) {
    return releaseControlFailure(operation, "OUTCOME_UNKNOWN", result.status, safeState);
  }
  return releaseControlSuccess(operation, { ...result.data, ...selectedState });
}

async function rollbackAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const ref = text(args, "ref"), id = text(args, "id"), environmentId = text(args, "environment_id");
  if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
  const operation = `applications.${text(args, "action")}`;
  const identity = { project_ref: ref, application_id: id, environment_id: environmentId };
  let activationId = args["activation_id"];
  if (activationId !== undefined && !Value.Check(ApplicationActivationIdSchema, activationId)) {
    throw new Error("Invalid application activation ID");
  }
  let releaseId = args["release_id"], configurationId = args["configuration_id"];
  let expectedActivationId = args["expected_activation_id"];
  if (releaseId === undefined || args["action"] === "get_rollback_snapshot") {
    if (releaseId !== undefined || configurationId !== undefined || expectedActivationId !== undefined) {
      throw new Error("Default rollback selection cannot mix explicit release/configuration/CAS flags");
    }
    const response = await http.get(
      `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/rollback-snapshot`,
      { maxJsonBytes: 65_536, responseTimeoutMs: 30_000 },
    );
    if (!response.ok) return releaseControlFailure(operation, "HTTP_ERROR",
      response.transportError ? null : response.status, identity);
    const snapshot = response.data;
    if (response.status !== 200 || !Value.Check(ApplicationRollbackSnapshotSchema, snapshot)
      || snapshot.project_ref !== ref || snapshot.application_id !== id || snapshot.environment_id !== environmentId
      || (snapshot.previous !== null && (snapshot.active === null
        || snapshot.previous.activation_id === snapshot.active.activation_id))) {
      return releaseControlFailure(operation, "INVALID_RESPONSE", response.status, identity);
    }
    if (args["action"] === "get_rollback_snapshot") return releaseControlSuccess(operation, { ...identity, snapshot });
    if (!snapshot.active || !snapshot.previous) {
      return releaseControlFailure(operation, "MUTATION_NOT_SUCCEEDED", response.status, {
        ...identity, reason: "NO_PREVIOUS_ACTIVATION",
      });
    }
    if (activationId === snapshot.active.activation_id || activationId === snapshot.previous.activation_id) {
      throw new Error("Rollback requires a new activation ID");
    }
    releaseId = snapshot.previous.release_id;
    configurationId = snapshot.previous.configuration_id;
    expectedActivationId = snapshot.active.activation_id;
  }
  activationId ??= crypto.randomUUID();
  return activationAction(http, {
    ...args, action: "activate_release", activation_id: activationId,
    release_id: releaseId, configuration_id: configurationId, expected_activation_id: expectedActivationId,
  }, project, {
    operation: "applications.rollback_release",
    configuration_id: configurationId,
    expected_activation_id: expectedActivationId === "absent" ? null : expectedActivationId,
  });
}

async function historyAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const ref = text(args, "ref"), id = text(args, "id"), environmentId = text(args, "environment_id");
  if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
  const limit = args["limit"] ?? 20, cursor = args["cursor"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100
    || (cursor !== undefined && typeof cursor !== "string")) throw new Error("Invalid history page");
  const query = new URLSearchParams({ limit: String(limit) });
  const scope = { project_ref: ref, application_id: id, environment_id: environmentId };
  const before = typeof cursor === "string" ? parseApplicationHistoryCursor(cursor, scope) : null;
  if (typeof cursor === "string") query.set("cursor", cursor);
  const operation = "applications.get_history";
  const response = await http.get(
    `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/history?${query}`,
    { maxJsonBytes: 262_144, responseTimeoutMs: 30_000 },
  );
  if (!response.ok) return releaseControlFailure(operation, "HTTP_ERROR",
    response.transportError ? null : response.status, scope);
  try {
    if (response.status !== 200) throw new Error();
    const history = parseApplicationActivationHistory(response.data);
    if (history.project_ref !== ref || history.application_id !== id || history.environment_id !== environmentId
      || history.activations.length > limit || (history.next_cursor !== null && history.activations.length !== limit)
      || (before && history.activations.some(entry => !applicationHistoryPositionBefore(entry, before)))) throw new Error();
    return releaseControlSuccess(operation, { project_ref: ref, application_id: id, environment_id: environmentId, history });
  } catch {
    return releaseControlFailure(operation, "INVALID_RESPONSE", response.status, scope);
  }
}

export function registerApplicationTools(server: ToolServer, http: HttpTransport): void {
  registerTool(server, "applications", "Store, inspect and explicitly activate immutable HTTP/Worker application releases. Upload does not activate a release.",
    APPLICATION_TOOL_SCHEMA, async (args) => {
      const action = text(args, "action"), ref = text(args, "ref"), id = text(args, "id");
      const project = projectRefPathSegment(ref, "Applications");
      if (!Value.Check(ApplicationIdSchema, id)) throw new Error("Invalid application ID");
      const path = `/v1/projects/${project}/applications/${encodeURIComponent(id)}/releases`;
      const operation = `applications.${action}`;
      if (action === "get_deploy_plan") {
        const observed = await readDeployPlan(http, args, project);
        return observed.failure ?? releaseControlSuccess(operation, { ...observed.identity, plan: observed.plan });
      }
      if (action === "deploy_release") return deployAction(http, args, project);
      if (action === "rollback_release" || action === "get_rollback_snapshot") {
        return rollbackAction(http, args, project);
      }
      if (action === "get_history") return historyAction(http, args, project);
      if (APPLICATION_PREVIEW_ACTIONS.some(value => value === action)) {
        return applicationPreviewAction(http, args, project);
      }
      if (action === "activate_release" || action === "reconcile_activation" || action === "retire_activation") {
        return activationAction(http, args, project);
      }
      if (action === "get_configuration" || action === "put_configuration") {
        return configurationAction(http, args, project);
      }
      if (action === "get_runtime") {
        const environmentId = text(args, "environment_id");
        if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
        const result = await http.get(
          `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/runtime`,
          { maxJsonBytes: 65_536, responseTimeoutMs: 30_000 },
        );
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
        try {
          const data = result.data;
          if (!data || typeof data !== "object" || !("project_ref" in data) || data.project_ref !== ref
            || !("application_id" in data) || data.application_id !== id
            || !("environment_id" in data) || data.environment_id !== environmentId || !("readiness" in data)) throw new Error();
          const readiness = data.readiness === null ? null : parseApplicationReadinessReport(data.readiness);
          if (readiness && (readiness.project_ref !== ref || readiness.application_id !== id
            || readiness.environment_id !== environmentId)) throw new Error();
          if ("configuration_id" in data && !Value.Check(ApplicationConfigurationIdSchema, data.configuration_id)) throw new Error();
          return releaseControlSuccess(operation, {
            project_ref: ref, application_id: id, environment_id: environmentId, readiness,
            ...("configuration_id" in data ? { configuration_id: data.configuration_id } : {}),
          });
        } catch { return releaseControlFailure(operation, "INVALID_RESPONSE", result.status); }
      }
      if (action === "get_deployment_evidence") {
        const environmentId = text(args, "environment_id");
        if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
        const result = await http.get(
          `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/deployment-evidence`,
          { maxJsonBytes: 262_144, responseTimeoutMs: 30_000 },
        );
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
        try {
          const data = result.data;
          if (!data || typeof data !== "object"
            || !("project_ref" in data) || data.project_ref !== ref
            || !("application_id" in data) || data.application_id !== id
            || !("environment_id" in data) || data.environment_id !== environmentId
            || !("evidence" in data)) throw new Error();
          const evidence = data.evidence === null ? null : parseDeploymentEvidence(data.evidence);
          if (evidence && (evidence.scope.project_ref !== ref
            || evidence.scope.application_id !== id || evidence.scope.environment_id !== environmentId)) throw new Error();
          return releaseControlSuccess(operation, {
            project_ref: ref, application_id: id, environment_id: environmentId, evidence,
          });
        } catch {
          return releaseControlFailure(operation, "INVALID_RESPONSE", result.status);
        }
      }
      if (action === "logs") {
        const environmentId = text(args, "environment_id");
        if (!Value.Check(ApplicationIdSchema, environmentId)) throw new Error("Invalid environment ID");
        const query = new URLSearchParams();
        for (const [key, value] of [
          ["limit", args["limit"]], ["offset", args["offset"]], ["service", args["service"]],
          ["search", args["search"]], ["start", args["start"]], ["end", args["end"]],
        ] as const) {
          if (value !== undefined) query.set(key, String(value));
        }
        const result = await http.get(
          `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/logs${query.size ? `?${query}` : ""}`,
          { maxJsonBytes: 1_048_576, responseTimeoutMs: 30_000 },
        );
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
        if (!result.data || typeof result.data !== "object"
          || !("project_ref" in result.data) || result.data.project_ref !== ref
          || !("application_id" in result.data) || result.data.application_id !== id
          || !("environment_id" in result.data) || result.data.environment_id !== environmentId
          || !("result" in result.data) || !Array.isArray(result.data.result)) {
          return releaseControlFailure(operation, "INVALID_RESPONSE", result.status);
        }
        return releaseControlSuccess(operation, result.data);
      }
      if (action === "list_releases") {
        const limit = args["limit"] ?? 50;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100
          || (args["cursor"] !== undefined && !Value.Check(ApplicationReleaseIdSchema, args["cursor"]))) {
          throw new Error("Invalid release page");
        }
        const query = new URLSearchParams({ limit: String(limit) });
        if (typeof args["cursor"] === "string") query.set("cursor", args["cursor"]);
        const result = await http.get(`${path}?${query}`);
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
        try {
          if (!Value.Check(inventorySchema, result.data)
            || result.data.project_ref !== ref || result.data.application_id !== id
            || result.data.releases.length > limit) throw new Error();
          const releases = result.data.releases.map(value => boundRelease(value, ref, id));
          let previous = typeof args["cursor"] === "string" ? args["cursor"] : "";
          for (const release of releases) {
            if (release.release_id <= previous) throw new Error();
            previous = release.release_id;
          }
          if (result.data.next_cursor !== null
            && (releases.length !== limit || result.data.next_cursor !== previous)) throw new Error();
          return releaseControlSuccess(operation, {
            project_ref: ref, application_id: id, releases, next_cursor: result.data.next_cursor,
          });
        } catch { return releaseControlFailure(operation, "INVALID_RESPONSE", result.status); }
      }
      let expectedId: string, expectedManifest: string | undefined;
      let result: HttpResult<unknown>;
      if (action === "upload_release") {
        const archive = await readDeliveryExecutableArchive(text(args, "manifest_path"));
        const manifest = canonical(archive.manifest);
        expectedManifest = digest(manifest);
        expectedId = applicationReleaseId(ref, id, expectedManifest);
        const form = new FormData();
        form.set("manifest", manifest);
        form.set("expected_objects", canonical(Object.fromEntries(
          archive.objects.map(({ object }) => [object.name, object.objectId]))));
        for (const { object, files } of archive.objects) {
          for (const [name, bytes] of files) {
            form.set(`objects/${object.objectId}/${name}`, new Blob([Uint8Array.from(bytes)]), "artifact.bin");
          }
        }
        result = await http.postMultipart(path, form, {
          timeoutMs: 120_000, maxJsonBytes: 196_608, responseTimeoutMs: 30_000,
        });
        if (!result.ok) return releaseControlMutationFailure(operation, result, {
          project_ref: ref, application_id: id, release_id: expectedId,
        });
      } else if (action === "get_release") {
        expectedId = text(args, "release_id");
        if (!Value.Check(ApplicationReleaseIdSchema, expectedId)) throw new Error("Invalid release ID");
        result = await http.get(`${path}/${expectedId}`);
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
      } else {
        throw new Error("Unknown applications action");
      }
      try {
        if (!Value.Check(responseSchema, result.data)
          || result.data.project_ref !== ref || result.data.application_id !== id) throw new Error();
        const release = boundRelease(result.data.release, ref, id);
        if (release.release_id !== expectedId
          || (expectedManifest !== undefined && release.manifest_sha256 !== expectedManifest)) throw new Error();
        return releaseControlSuccess(operation, { project_ref: ref, application_id: id, release });
      } catch {
        return releaseControlFailure(operation, action === "upload_release" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", result.status, {
          project_ref: ref, application_id: id, release_id: expectedId,
        });
      }
    });
}
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  applicationReleaseId, parseApplicationReleaseRecord, readDeliveryExecutableArchive,
  parseApplicationReadinessReport,
  parseApplicationConfigurationWrite, parseApplicationConfigurationView,
  type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import {
  ApplicationIdSchema, ApplicationReleaseIdSchema, ApplicationReleaseRecordSchema,
  ApplicationConfigurationIdSchema, ApplicationActivationIdSchema, ApplicationActivationWriteSchema,
  ApplicationActivationResultSchema, ApplicationActivationRetirementResultSchema,
} from "./application-schemas";
import { canonical, digest } from "@supacloud/delivery/files";
import { optional, stringEnum, withDescription, type ToolSchema } from "../schema";
import { projectRefPathSegment } from "../project-ref";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
  releaseControlFailure, releaseControlMutationFailure, releaseControlSuccess, type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolServer = {
  tool(name: string, description: string, schema: ToolSchema,
    callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>): void;
};
export const APPLICATION_TOOL_SCHEMA: ToolSchema = {
  action: withDescription(stringEnum([
    "list_releases", "get_release", "upload_release", "get_runtime", "get_configuration", "put_configuration",
    "activate_release", "reconcile_activation", "retire_activation",
  ]), "Action"),
  ref: withDescription(Type.String(), "Project ref"),
  id: withDescription(ApplicationIdSchema, "Application ID"),
  environment_id: optional(withDescription(ApplicationIdSchema, "[get_runtime/get_configuration/put_configuration] Environment ID")),
  configuration_id: optional(ApplicationConfigurationIdSchema, "[get_configuration/activate_release] Immutable revision; required for activation"),
  activation_id: optional(ApplicationActivationIdSchema, "[activate_release/reconcile_activation/retire_activation] Explicit stable activation ID"),
  expected_activation_id: optional(Type.Union([ApplicationActivationIdSchema, Type.Null(), Type.Literal("absent")]),
    "[activate_release] Current activation ID, or absent for first activation"),
  configuration_path: optional(Type.String(), "[put_configuration] Local configuration write JSON including revision and expected revision"),
  manifest_path: optional(Type.String(), "[upload_release] Local delivery.manifest.json"),
  release_id: optional(ApplicationReleaseIdSchema, "[get_release/activate_release/reconcile_activation] Immutable application release ID"),
  cursor: optional(ApplicationReleaseIdSchema, "[list_releases] Last release ID"),
  limit: optional(Type.Integer({ minimum: 1, maximum: 100 }), "[list_releases] Page size, default 50"),
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
    if (args.configuration_id !== undefined && !Value.Check(ApplicationConfigurationIdSchema, args.configuration_id)) {
      throw new Error("Invalid application configuration ID");
    }
    expectedId = args.configuration_id as string | undefined;
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

async function activationAction(http: HttpTransport, args: Record<string, unknown>, project: string) {
  const action = text(args, "action"), ref = text(args, "ref"), id = text(args, "id");
  const environmentId = text(args, "environment_id"), activationId = text(args, "activation_id");
  const releaseId = args.release_id === undefined ? undefined : text(args, "release_id");
  if (action === "retire_activation" && releaseId !== undefined) {
    throw new Error("release_id is not accepted for retire_activation");
  }
  if (!Value.Check(ApplicationIdSchema, environmentId)
    || !Value.Check(ApplicationActivationIdSchema, activationId)
    || (action !== "retire_activation" && !Value.Check(ApplicationReleaseIdSchema, releaseId))) {
    throw new Error("Invalid application activation identity");
  }
  const operation = `applications.${action}`;
  const path = `/v1/projects/${project}/applications/${encodeURIComponent(id)}/environments/${encodeURIComponent(environmentId)}/activations`;
  const identity = {
    project_ref: ref, application_id: id, environment_id: environmentId,
    activation_id: activationId, ...(releaseId ? { release_id: releaseId } : {}),
  };
  let body: unknown = {};
  if (action === "activate_release") {
    body = {
      activation_id: activationId, release_id: releaseId,
      configuration_id: args.configuration_id,
      expected_activation_id: args.expected_activation_id === "absent" ? null : args.expected_activation_id,
    };
    if (!Value.Check(ApplicationActivationWriteSchema, body)) throw new Error("Invalid application activation request");
  }
  const endpoint = action === "activate_release" ? path
    : `${path}/${activationId}/${action === "retire_activation" ? "retire" : "reconcile"}`;
  const result = await http.post(endpoint, body,
    { timeoutMs: 120_000, maxJsonBytes: 65_536, responseTimeoutMs: 30_000 });
  if (!result.ok) return releaseControlMutationFailure(operation, result, identity);
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
    return releaseControlFailure(operation, "OUTCOME_UNKNOWN", result.status, identity);
  }
  return releaseControlSuccess(operation, result.data);
}

export function registerApplicationTools(server: ToolServer, http: HttpTransport): void {
  server.tool("applications", "Store, inspect and explicitly activate immutable HTTP/Worker application releases. Upload does not activate a release.",
    APPLICATION_TOOL_SCHEMA, async args => {
      const action = text(args, "action"), ref = text(args, "ref"), id = text(args, "id");
      const project = projectRefPathSegment(ref, "Applications");
      if (!Value.Check(ApplicationIdSchema, id)) throw new Error("Invalid application ID");
      const path = `/v1/projects/${project}/applications/${encodeURIComponent(id)}/releases`;
      const operation = `applications.${action}`;
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
      if (action === "list_releases") {
        const limit = args.limit ?? 50;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100
          || (args.cursor !== undefined && !Value.Check(ApplicationReleaseIdSchema, args.cursor))) {
          throw new Error("Invalid release page");
        }
        const query = new URLSearchParams({ limit: String(limit) });
        if (typeof args.cursor === "string") query.set("cursor", args.cursor);
        const result = await http.get(`${path}?${query}`);
        if (!result.ok) return releaseControlFailure(operation, "HTTP_ERROR", result.status);
        try {
          if (!Value.Check(inventorySchema, result.data)
            || result.data.project_ref !== ref || result.data.application_id !== id
            || result.data.releases.length > limit) throw new Error();
          const releases = result.data.releases.map(value => boundRelease(value, ref, id));
          let previous = typeof args.cursor === "string" ? args.cursor : "";
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

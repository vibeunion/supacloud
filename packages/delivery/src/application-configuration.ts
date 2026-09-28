import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationIdSchema } from "./application-release";

export const ApplicationConfigurationIdSchema = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
});
const targetName = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const variableName = Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" });
const kind = Type.Union([Type.Literal("http"), Type.Literal("worker")]);
const hosts = Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 32, uniqueItems: true });
const bunVersion = Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$", maxLength: 32 });
export const ApplicationConfigurationSchema = Type.Object({
  bun_version: bunVersion,
  targets: Type.Array(Type.Object({
    name: targetName, kind, hosts,
    environment: Type.Record(variableName, Type.String({ maxLength: 16_384 }), {
      maxProperties: 128, additionalProperties: false,
    }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
export const ApplicationConfigurationWriteSchema = Type.Object({
  configuration_id: ApplicationConfigurationIdSchema,
  expected_configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
  configuration: ApplicationConfigurationSchema,
}, { additionalProperties: false });
export const ApplicationConfigurationViewSchema = Type.Object({
  schema: Type.Literal("supacloud.application-configuration.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema, environment_id: ApplicationIdSchema,
  configuration_id: ApplicationConfigurationIdSchema, created_at: Type.String(),
  bun_version: bunVersion,
  targets: Type.Array(Type.Object({
    name: targetName, kind, hosts,
    environment_names: Type.Array(variableName, { maxItems: 128, uniqueItems: true }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
export type ApplicationConfiguration = Static<typeof ApplicationConfigurationSchema>;
export type ApplicationConfigurationWrite = Static<typeof ApplicationConfigurationWriteSchema>;
export type ApplicationConfigurationView = Static<typeof ApplicationConfigurationViewSchema>;
export interface ApplicationConfigurationScope {
  projectRef: string;
  applicationId: string;
  environmentId: string;
}

export function assertApplicationConfigurationScope(scope: ApplicationConfigurationScope): void {
  if (!/^[a-z0-9-]{1,20}$/.test(scope.projectRef)
    || !Value.Check(ApplicationIdSchema, scope.applicationId) || !Value.Check(ApplicationIdSchema, scope.environmentId)) {
    throw new Error("Invalid application configuration scope");
  }
}

// Systemd owns these variables; neither a saved revision nor a direct activation can replace them.
export const APPLICATION_RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "NODE_ENV", "HOST", "PORT", "SHUTDOWN_TIMEOUT_MS", "NODE_OPTIONS", "BUN_OPTIONS",
  "SUPACLOUD_PROJECT_REF", "SUPACLOUD_APPLICATION_ID", "SUPACLOUD_RELEASE_ID", "SUPACLOUD_ACTIVATION_ID",
  "SUPACLOUD_ENVIRONMENT_ID", "SUPACLOUD_TARGET", "SUPACLOUD_OBJECT_ID",
]);

function assertTargets(targets: ApplicationConfiguration["targets"] | ApplicationConfigurationView["targets"]): void {
  const names = new Set<string>(), usedHosts = new Set<string>();
  for (const target of targets) {
    if (names.has(target.name) || (target.kind === "http" ? target.hosts.length === 0 : target.hosts.length !== 0)) {
      throw new Error("Invalid application configuration targets");
    }
    names.add(target.name);
    for (const host of target.hosts) {
      if (host !== host.toLowerCase() || usedHosts.has(host)
        || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("Invalid application configuration hosts");
      }
      usedHosts.add(host);
    }
  }
}

export function parseApplicationConfigurationWrite(value: unknown): ApplicationConfigurationWrite {
  if (!Value.Check(ApplicationConfigurationWriteSchema, value)
    || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Error("Invalid application configuration");
  assertTargets(value.configuration.targets);
  for (const target of value.configuration.targets) {
    for (const [name, entry] of Object.entries(target.environment)) {
      if (APPLICATION_RESERVED_ENVIRONMENT_NAMES.has(name) || /[\x00-\x1f\x7f]/.test(entry)) {
        throw new Error("Invalid application environment variable");
      }
    }
  }
  return structuredClone(value);
}

export function parseApplicationConfigurationView(value: unknown): ApplicationConfigurationView {
  if (!Value.Check(ApplicationConfigurationViewSchema, value)
    || !Number.isFinite(Date.parse(value.created_at)) || new Date(value.created_at).toISOString() !== value.created_at) {
    throw new Error("Invalid application configuration view");
  }
  assertTargets(value.targets);
  return value;
}

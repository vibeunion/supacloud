import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stable-json";
import { PreviewEnvironmentError } from "./preview-environment.service";
import { base32Lower, normalizePreviewSlug } from "./preview-naming";

/**
 * Immutable Preview configuration. It is built from the release contract plus
 * Preview defaults and secret references only: copying a parent project's
 * production configuration is never allowed, and every external service must be
 * explicitly `sandbox` or `disabled`.
 */
export const PREVIEW_CONFIGURATION_SCHEMA_VERSION = 1;

export interface PreviewConfiguration {
  schemaVersion: typeof PREVIEW_CONFIGURATION_SCHEMA_VERSION;
  projectId: string;
  previewRef: string;
  releaseId: string;
  application: { command: string; port: number; healthcheck?: { path: string; timeoutMs: number } };
  environment: Record<string, string | number | boolean>;
  secretRefs: string[];
  resourceRefs: { database?: string; queues?: string[]; storageBuckets?: string[] };
  externalServices: Record<string, { mode: "sandbox" | "disabled"; secretRef?: string }>;
}

export interface PreviewConfigurationInput {
  projectId: string;
  previewRef: string;
  releaseId: string;
  command: string;
  port: number;
  healthcheck?: { path: string; timeoutMs: number };
  environment: Record<string, string | number | boolean>;
  allowedEnvironmentKeys: ReadonlyArray<string>;
  secretRefs?: ReadonlyArray<string>;
  resourceRefs?: PreviewConfiguration["resourceRefs"];
  externalServices?: PreviewConfiguration["externalServices"];
}

export interface BuiltPreviewConfiguration {
  configurationId: string;
  configuration: PreviewConfiguration;
}

const SECRET_REF = /^secret:\/\/preview\/[a-z0-9_]{1,40}\/[a-z0-9-]{1,48}\/[a-z0-9_-]{1,64}$/;
const PRODUCTION_SHAPE = /^(?:prod|production|live|release)(?:[-_]|$)/i;
const NAMESPACED_REF = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function invalid(): never {
  throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
}

function isProductionValue(value: string | number | boolean): boolean {
  if (typeof value !== "string") return false;
  return PRODUCTION_SHAPE.test(value.trim()) || /:\/\//.test(value);
}

/** Validate a configuration in place; throws `PREVIEW_ENVIRONMENT_INVALID` on any violation. */
export function validatePreviewConfiguration(
  configuration: PreviewConfiguration,
  allowedEnvironmentKeys: ReadonlyArray<string>,
): void {
  if (configuration.schemaVersion !== PREVIEW_CONFIGURATION_SCHEMA_VERSION
    || typeof configuration.projectId !== "string" || typeof configuration.previewRef !== "string"
    || !/^[a-f0-9]{64}$/.test(configuration.releaseId)
    || typeof configuration.application?.command !== "string" || configuration.application.command.length === 0
    || !Number.isSafeInteger(configuration.application.port)
    || configuration.application.port < 1 || configuration.application.port > 65535) invalid();

  normalizePreviewSlug(configuration.previewRef);

  const allowed = new Set(allowedEnvironmentKeys);
  if (!allowed.has("__all__")) {
    for (const key of Object.keys(configuration.environment)) if (!allowed.has(key)) invalid();
  }
  for (const [key, value] of Object.entries(configuration.environment)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) invalid();
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") invalid();
    if (isProductionValue(value)) invalid();
  }

  const secretRefs = new Set<string>();
  for (const ref of configuration.secretRefs) {
    if (!SECRET_REF.test(ref) || secretRefs.has(ref)) invalid();
    secretRefs.add(ref);
  }

  const resourceRefs = configuration.resourceRefs;
  if (resourceRefs.database !== undefined && !NAMESPACED_REF.test(resourceRefs.database)) invalid();
  for (const list of [resourceRefs.queues ?? [], resourceRefs.storageBuckets ?? []]) {
    if (list.length > 64 || new Set(list).size !== list.length) invalid();
    for (const ref of list) if (!NAMESPACED_REF.test(ref)) invalid();
  }

  for (const [provider, service] of Object.entries(configuration.externalServices)) {
    if (provider.length === 0 || provider.length > 64 || /[\u0000-\u001f\u007f]/.test(provider)) invalid();
    if (service.mode !== "sandbox" && service.mode !== "disabled") invalid();
    if (service.secretRef !== undefined && !secretRefs.has(service.secretRef)) invalid();
    if (service.mode === "disabled" && service.secretRef !== undefined) invalid();
  }
}

/** RFC 8785-style canonical JSON for hashing. */
export function canonicalizePreviewConfiguration(configuration: PreviewConfiguration): string {
  return stableStringify(configuration);
}

/** Content-addressed configuration revision id. */
export function deriveConfigurationId(canonicalConfiguration: string): string {
  return `cfg_${base32Lower(createHash("sha256").update(canonicalConfiguration, "utf8").digest())}`;
}

/** Build, validate and content-address an immutable configuration revision. */
export function buildPreviewConfiguration(input: PreviewConfigurationInput): BuiltPreviewConfiguration {
  const configuration: PreviewConfiguration = {
    schemaVersion: PREVIEW_CONFIGURATION_SCHEMA_VERSION,
    projectId: input.projectId,
    previewRef: input.previewRef,
    releaseId: input.releaseId,
    application: {
      command: input.command,
      port: input.port,
      ...(input.healthcheck ? { healthcheck: { ...input.healthcheck } } : {}),
    },
    environment: { ...input.environment },
    secretRefs: [...(input.secretRefs ?? [])].sort((a, b) => a.localeCompare(b)),
    resourceRefs: {
      ...(input.resourceRefs?.database ? { database: input.resourceRefs.database } : {}),
      queues: [...(input.resourceRefs?.queues ?? [])].sort((a, b) => a.localeCompare(b)),
      storageBuckets: [...(input.resourceRefs?.storageBuckets ?? [])].sort((a, b) => a.localeCompare(b)),
    },
    externalServices: Object.fromEntries(Object.entries(input.externalServices ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
  validatePreviewConfiguration(configuration, input.allowedEnvironmentKeys);
  const configurationId = deriveConfigurationId(canonicalizePreviewConfiguration(configuration));
  return { configurationId, configuration };
}
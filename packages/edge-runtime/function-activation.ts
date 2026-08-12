import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const EDGE_FUNCTION_ACTIVATION_SCHEMA = "supacloud.edge-function-activation.v1" as const;
export const EDGE_FUNCTION_ACTIVATION_FIELD = "_supacloud_activation" as const;

const ACTIVATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FUNCTION_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const AUTHORITY_KEYS = [
  "activation_generation",
  "activation_id",
  "artifact_sha256",
  "previous_activation_id",
  "schema",
  "target_state",
] as const;

export type EdgeFunctionActivationAuthority = {
  schema: typeof EDGE_FUNCTION_ACTIVATION_SCHEMA;
  activation_id: string;
  activation_generation: number;
  previous_activation_id: string | null;
  target_state: "active" | "absent";
  artifact_sha256: string | null;
};

export type EdgeFunctionActivationConfig = {
  verify_jwt: boolean;
  version: string | null;
};

export type EdgeFunctionActivationManifest = {
  authority: EdgeFunctionActivationAuthority | null;
  config: EdgeFunctionActivationConfig;
};

export type EdgeFunctionActivationFence = {
  candidate: EdgeFunctionActivationManifest & {
    authority: EdgeFunctionActivationAuthority;
  };
  preheated: {
    runtimeInstanceId: string;
    foregroundGeneration: number;
    backgroundGeneration: number;
  } | null;
};

export type EdgeFunctionActivationState =
  | "fenced"
  | "commit_pending"
  | "committed"
  | "aborted"
  | "uncertain";

function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function hasExactAuthorityKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === AUTHORITY_KEYS.length
    && AUTHORITY_KEYS.every((key, index) => keys[index] === key);
}

function parseAuthority(candidate: unknown): EdgeFunctionActivationAuthority {
  if (!isPlainRecord(candidate) || !hasExactAuthorityKeys(candidate)) {
    throw new Error("Function activation authority has an invalid shape");
  }
  const previousId = candidate.previous_activation_id;
  if (candidate.schema !== EDGE_FUNCTION_ACTIVATION_SCHEMA
    || typeof candidate.activation_id !== "string"
    || !ACTIVATION_ID_PATTERN.test(candidate.activation_id)
    || !Number.isSafeInteger(candidate.activation_generation)
    || Number(candidate.activation_generation) < 1
    || (previousId !== null
      && (typeof previousId !== "string" || !ACTIVATION_ID_PATTERN.test(previousId)))
    || (candidate.target_state !== "active" && candidate.target_state !== "absent")) {
    throw new Error("Function activation authority contains invalid identity fields");
  }
  if (candidate.target_state === "active") {
    if (typeof candidate.artifact_sha256 !== "string"
      || !SHA256_PATTERN.test(candidate.artifact_sha256)) {
      throw new Error("Active Function activation requires an artifact digest");
    }
  } else if (candidate.artifact_sha256 !== null) {
    throw new Error("Absent Function activation cannot identify an artifact");
  }
  return candidate as EdgeFunctionActivationAuthority;
}

function parseConfig(document: Record<string, unknown>): EdgeFunctionActivationConfig {
  const rawVersion = document.version;
  if (rawVersion !== undefined
    && (typeof rawVersion !== "string" || !VERSION_PATTERN.test(rawVersion))) {
    throw new Error("Function activation config contains an invalid version");
  }
  return {
    verify_jwt: document.verify_jwt !== false,
    version: rawVersion ?? null,
  };
}

export function parseEdgeFunctionActivationManifest(
  rawManifest: string,
): EdgeFunctionActivationManifest {
  const document: unknown = JSON.parse(rawManifest);
  if (!isPlainRecord(document)) throw new Error("Function config must be a plain object");
  const rawAuthority = document[EDGE_FUNCTION_ACTIVATION_FIELD];
  const authority = rawAuthority === undefined ? null : parseAuthority(rawAuthority);
  const config = parseConfig(document);
  if (authority?.target_state === "active" && config.version === null) {
    throw new Error("Active Function activation must identify a version");
  }
  if (authority?.target_state === "absent" && config.version !== null) {
    throw new Error("Absent Function activation cannot identify a version");
  }
  return { authority, config };
}

export function edgeFunctionActivationGenerationPath(
  projectRoot: string,
  functionSlug: string,
  activationId: string,
): string {
  if (!FUNCTION_SLUG_PATTERN.test(functionSlug)) {
    throw new Error("Invalid Function slug");
  }
  if (!ACTIVATION_ID_PATTERN.test(activationId)) {
    throw new Error("Invalid Function activation identifier");
  }
  return resolve(
    projectRoot,
    ".activation-generations",
    functionSlug,
    `${activationId}.json`,
  );
}

export function isEdgeFunctionActivationId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && ACTIVATION_ID_PATTERN.test(candidate);
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export async function readEdgeFunctionActivationGeneration(
  projectRoot: string,
  functionSlug: string,
  activationId: string,
): Promise<EdgeFunctionActivationManifest & { authority: EdgeFunctionActivationAuthority }> {
  const generationPath = edgeFunctionActivationGenerationPath(
    projectRoot,
    functionSlug,
    activationId,
  );
  const generationRoot = resolve(projectRoot, ".activation-generations", functionSlug);
  const [resolvedPath, metadata] = await Promise.all([
    realpath(generationPath),
    stat(generationPath),
  ]);
  if (!metadata.isFile()
    || !isPathWithin(resolvedPath, generationRoot)
    || dirname(resolvedPath) !== generationRoot) {
    throw new Error("Function activation generation escapes its trusted directory");
  }
  const manifest = parseEdgeFunctionActivationManifest(await readFile(resolvedPath, "utf8"));
  if (!manifest.authority || manifest.authority.activation_id !== activationId) {
    throw new Error("Function activation generation identity does not match its path");
  }
  return { ...manifest, authority: manifest.authority };
}

export function activationAuthorityId(
  manifest: EdgeFunctionActivationManifest,
): string | null {
  return manifest.authority?.activation_id ?? null;
}

export function activationFenceKey(projectRef: string, functionSlug: string): string {
  return `${projectRef}/${functionSlug}`;
}

export function activationState(
  fence: EdgeFunctionActivationFence | undefined,
  currentActivationId: string | null,
  requestedActivationId: string,
): EdgeFunctionActivationState {
  if (currentActivationId === requestedActivationId) {
    if (!fence) return "committed";
    return fence.candidate.authority.activation_id === requestedActivationId
      ? "commit_pending"
      : "uncertain";
  }
  if (!fence) return "uncertain";
  if (fence.candidate.authority.activation_id !== requestedActivationId) return "uncertain";
  return currentActivationId === fence.candidate.authority.previous_activation_id
    ? "fenced"
    : "uncertain";
}

export function assertActivationSuccessor(
  candidate: EdgeFunctionActivationManifest & { authority: EdgeFunctionActivationAuthority },
  current: EdgeFunctionActivationManifest,
): void {
  const currentId = activationAuthorityId(current);
  const currentGeneration = current.authority?.activation_generation ?? 0;
  if (candidate.authority.previous_activation_id !== currentId
    || candidate.authority.activation_generation !== currentGeneration + 1) {
    throw new Error("Function activation candidate is not the current authority successor");
  }
}

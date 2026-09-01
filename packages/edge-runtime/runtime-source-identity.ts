import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import packageMetadata from "./package.json";

const IDENTITY_FILE_NAME = ".supacloud-source-identity.json";
const PACKAGE_NAME = "@supacloud/edge-runtime";
const STABLE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type RuntimeSourceIdentity = {
  packageVersion: string | null;
  sourceSha256: string | null;
};

type AttestedRuntimeSourceIdentity = {
  schemaVersion: 1;
  packageName: typeof PACKAGE_NAME;
  packageVersion: string;
  sourceSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRuntimeSourceIdentity(value: unknown): AttestedRuntimeSourceIdentity {
  if (!isRecord(value)) {
    throw new Error("Edge Runtime source identity must be an object");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["packageName", "packageVersion", "schemaVersion", "sourceSha256"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Edge Runtime source identity fields are invalid");
  }
  if (value.schemaVersion !== 1 || value.packageName !== PACKAGE_NAME) {
    throw new Error("Edge Runtime source identity contract is invalid");
  }
  if (typeof value.packageVersion !== "string" || !STABLE_VERSION_PATTERN.test(value.packageVersion)) {
    throw new Error("Edge Runtime source identity version is invalid");
  }
  if (typeof value.sourceSha256 !== "string" || !SHA256_PATTERN.test(value.sourceSha256)) {
    throw new Error("Edge Runtime source identity digest is invalid");
  }
  return value as AttestedRuntimeSourceIdentity;
}

export function readRuntimeSourceIdentity(identityFile: string): RuntimeSourceIdentity {
  const metadata = lstatSync(identityFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Edge Runtime source identity file is unsafe");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(identityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Edge Runtime source identity is unreadable: ${message}`);
  }
  const identity = parseRuntimeSourceIdentity(parsed);
  const packageFile = path.resolve(path.dirname(identityFile), "package.json");
  let packageMetadata: unknown;
  try {
    packageMetadata = JSON.parse(readFileSync(packageFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Edge Runtime package identity is unreadable: ${message}`);
  }
  if (!isRecord(packageMetadata)
    || packageMetadata.name !== PACKAGE_NAME
    || packageMetadata.version !== identity.packageVersion) {
    throw new Error("Edge Runtime package identity does not match its source identity");
  }
  return {
    packageVersion: identity.packageVersion,
    sourceSha256: identity.sourceSha256,
  };
}

function localPackageVersion(): string | null {
  if (packageMetadata.name === PACKAGE_NAME && STABLE_VERSION_PATTERN.test(packageMetadata.version)) {
    return packageMetadata.version;
  }
  const candidates = [
    path.resolve(import.meta.dir, "package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (parsed.name === PACKAGE_NAME
        && typeof parsed.version === "string"
        && STABLE_VERSION_PATTERN.test(parsed.version)) {
        return parsed.version;
      }
    } catch {
      // Development fallback only. An explicitly configured identity is fail-closed.
    }
  }
  return null;
}

export function resolveRuntimeSourceIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeSourceIdentity {
  const identityMode = environment.SUPACLOUD_EDGE_RUNTIME_IDENTITY_MODE?.trim();
  if (identityMode && identityMode !== "source" && identityMode !== "compiled") {
    throw new Error(`Edge Runtime identity mode is invalid: ${identityMode}`);
  }
  if (identityMode === "compiled") {
    return {
      packageVersion: localPackageVersion(),
      sourceSha256: null,
    };
  }
  const explicitFile = environment.SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE?.trim();
  if (explicitFile) {
    if (!path.isAbsolute(explicitFile)) {
      throw new Error("Edge Runtime source identity path must be absolute");
    }
    return readRuntimeSourceIdentity(explicitFile);
  }

  const candidates = [
    path.resolve(import.meta.dir, IDENTITY_FILE_NAME),
    path.resolve(process.cwd(), IDENTITY_FILE_NAME),
    path.resolve("/opt/supacloud/edge-runtime", IDENTITY_FILE_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readRuntimeSourceIdentity(candidate);
  }

  return {
    packageVersion: localPackageVersion(),
    sourceSha256: null,
  };
}

export const runtimeSourceIdentity = resolveRuntimeSourceIdentity();

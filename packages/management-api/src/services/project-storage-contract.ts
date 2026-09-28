/** Internal, encrypted project binding. This is not a client-selectable backend. */
export const PROJECT_STORAGE_SECRET = { scope: "connector", name: "supacloud.storage.s3" } as const;

export class ProjectStorageError extends Error {
  constructor(readonly code: "STORAGE_CONFIG_INVALID" | "STORAGE_CONFIG_CONFLICT" | "STORAGE_CONFIG_UNAVAILABLE" | "STORAGE_BACKEND_UNAVAILABLE" | "STORAGE_ADOPTION_SOURCE_CHANGED" | "STORAGE_ADOPTION_LIMIT", readonly statusCode: 400 | 409 | 413 | 503 = 503) {
    super(code);
    this.name = "ProjectStorageError";
  }
}

/**
 * Hard cap for the synchronous adoption migration. The migration runs while the
 * project is quiesced under an exclusive lock for the whole copy and cutover.
 * Larger projects need an offline migration.
 */
export const PROJECT_STORAGE_ADOPTION_MAX_OBJECTS = 10000;

/** A read-only inventory of a project's current (platform) objects. */
export interface ProjectStorageInventory {
  buckets: number;
  objects: number;
  /** Covers bucket names, object keys, content hashes and MIME metadata. */
  fingerprint: string;
  entries: { bucket: string; key: string; digest: string; contentType: string }[];
}

/** The public, non-secret result of an adoption plan or completed adoption. */
export interface ProjectStorageAdoptionPlan {
  buckets: number;
  objects: number;
  fingerprint: string;
}

export interface ProjectS3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  virtualHostedStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  enabled: boolean;
}

export interface ProjectS3Configuration extends ProjectS3Settings {
  version: 1;
  projectRef: string;
  revision: string;
}

function invalid(): never { throw new ProjectStorageError("STORAGE_CONFIG_INVALID", 400); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /^\*+$/.test(value) || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
export function assertProjectRef(ref: string): void {
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(ref)) invalid();
}
export function storagePath(value: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) invalid();
  if (allowEmpty && value === "") return "";
  if (!value || value.split("/").some((part) => !part || part === "." || part === "..")) invalid();
  // Reject malformed Unicode before it reaches a URL encoder.
  try { encodeURIComponent(value); } catch { invalid(); }
  return value;
}
export function logicalBucket(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || /^\.+$/.test(value)) invalid();
  return value;
}

/** Syntax only; permission to contact an origin is checked separately at runtime. */
export function parseProjectS3Settings(value: unknown): Readonly<ProjectS3Settings> {
  if (!record(value)) invalid();
  const endpoint = text(value.endpoint, 2048);
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || endpoint.includes("\\")) invalid();
  const region = text(value.region, 64);
  if (!/^[a-z0-9-]+$/.test(region)) invalid();
  const bucket = text(value.bucket, 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) invalid();
  const rawPrefix = value.prefix ?? "";
  if (typeof rawPrefix !== "string" || rawPrefix.startsWith("/")) invalid();
  const prefix = storagePath(rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix, true);
  if (value.virtualHostedStyle !== undefined && typeof value.virtualHostedStyle !== "boolean") invalid();
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") invalid();
  const sessionToken = value.sessionToken === undefined ? undefined : text(value.sessionToken, 16384);
  return Object.freeze({
    endpoint: url.origin, region, bucket, prefix: prefix ? `${prefix}/` : "",
    virtualHostedStyle: value.virtualHostedStyle ?? false,
    accessKeyId: text(value.accessKeyId, 256),
    secretAccessKey: text(value.secretAccessKey, 4096),
    ...(sessionToken === undefined ? {} : { sessionToken }),
    enabled: value.enabled ?? true,
  });
}

export function parseStoredProjectS3(ref: string, value: unknown): Readonly<ProjectS3Configuration> {
  assertProjectRef(ref);
  if (!record(value) || value.version !== 1 || value.projectRef !== ref
    || typeof value.revision !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.revision)) {
    throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
  }
  try {
    return Object.freeze({ ...parseProjectS3Settings(value), version: 1, projectRef: ref, revision: value.revision });
  } catch { throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE"); }
}

export function assertProjectS3Origin(settings: ProjectS3Settings, allowedOrigins: string): void {
  // Operator-owned exact origins. No wildcards, request-supplied URLs or redirects.
  const allowed = allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!allowed.includes(settings.endpoint)) throw new ProjectStorageError("STORAGE_CONFIG_UNAVAILABLE");
}

export function sameStorageNamespace(left: ProjectS3Settings, right: ProjectS3Settings): boolean {
  return left.endpoint === right.endpoint && left.region === right.region && left.bucket === right.bucket
    && left.prefix === right.prefix && left.virtualHostedStyle === right.virtualHostedStyle;
}

export interface ConfiguredStorageSummary {
  backend: "s3"; configured: true; revision: string; endpoint: string; region: string;
  bucket: string; prefix: string; virtualHostedStyle: boolean; enabled: boolean; credentialsConfigured: true;
}
export interface PlatformStorageSummary { backend: "platform"; configured: false; }
export function publicProjectStorage(config: ProjectS3Configuration): ConfiguredStorageSummary;
export function publicProjectStorage(config: null): PlatformStorageSummary;
export function publicProjectStorage(config: ProjectS3Configuration | null): ConfiguredStorageSummary | PlatformStorageSummary;
export function publicProjectStorage(config: ProjectS3Configuration | null): ConfiguredStorageSummary | PlatformStorageSummary {
  if (!config) return { backend: "platform" as const, configured: false as const };
  return {
    backend: "s3" as const, configured: true as const, revision: config.revision,
    endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix,
    virtualHostedStyle: config.virtualHostedStyle, enabled: config.enabled, credentialsConfigured: true,
  };
}

export function overlappingStorageNamespace(left: ProjectS3Settings, right: ProjectS3Settings): boolean {
  return left.endpoint === right.endpoint && left.bucket === right.bucket
    && (left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix));
}

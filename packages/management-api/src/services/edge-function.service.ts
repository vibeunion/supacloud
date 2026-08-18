import { logger } from "../utils/logger";
import { config } from "../config";
import { ServiceUnavailableError } from "../utils/errors";
import { normalizeEdgeRuntimeBundle } from "./edge-runtime-bundle";
import path from "path";
import fs from "fs/promises";
import type { Dirent } from "node:fs";
import { acquireSupaCloudUpgradeLock, type SupaCloudUpgradeLock } from "../upgrade-lock";
import {
  validateEdgeRuntimePreheat,
  type ExpectedEdgeRuntimePreheat,
  type ValidatedEdgeRuntimePreheat,
} from "./edge-runtime-preheat-attestation";
import {
  EDGE_FUNCTION_ACTIVATION_ID_PATTERN,
  EDGE_FUNCTION_ACTIVATION_SCHEMA,
  EdgeFunctionActivationDurabilityError,
  confirmEdgeFunctionActivationManifestDurable,
  parseEdgeFunctionActivationManifest,
  preflightEdgeFunctionMutationDirectories,
  replaceEdgeFunctionActivationManifest,
  writeEdgeFunctionActivationGeneration,
  type EdgeFunctionActivationAuthority,
} from "./edge-function-activation-manifest";

/** Per-function configuration (mirrors Supabase config.toml [functions.xxx]) */
export interface EdgeFunctionConfig {
  verify_jwt: boolean;
  import_map?: string;
  entrypoint?: string;
  version?: string;
  background_routes?: string[];
}

export interface EdgeFunctionVersionRecord {
  version: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  bundle_path: string | null;
  source_path: string | null;
  source_dir_path: string | null;
  has_bundle: boolean;
  has_source: boolean;
  has_source_dir: boolean;
}

export interface EdgeFunctionVersionDetail extends EdgeFunctionVersionRecord {
  bundle_code: string | null;
  source_code: string | null;
}

export interface EdgeFunctionDeployResult {
  success: boolean;
  previous_active_version?: EdgeFunctionActiveVersion;
  active_version?: string;
  version?: string;
  bundled?: boolean;
  files?: number;
  import_map?: string | null;
  bundle_hash?: string;
  bundle_size_bytes?: number;
  import_count?: number;
  content_path?: string | null;
  external_packages?: string[];
  preheat?: EdgeFunctionPreheatResult;
  config?: EdgeFunctionConfigSnapshot;
  error_code?: typeof EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE;
  expected_active_version?: EdgeFunctionActiveVersion;
  expected_activation_id?: EdgeFunctionActivationId;
  activation_id?: EdgeFunctionActivationId;
  error?: string;
}

export const EDGE_FUNCTION_ABSENT_ACTIVE_VERSION = "absent" as const;
export const EDGE_FUNCTION_LEGACY_ACTIVATION_ID = "legacy" as const;
export const EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE = "FUNCTION_ACTIVE_VERSION_CONFLICT" as const;
export const EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE = "Active function artifact is missing";
export const EDGE_FUNCTION_SHA256_HEX_PATTERN = "^[a-f0-9]{64}$";
export type EdgeFunctionActiveVersion = string;
export type EdgeFunctionActivationId = string;

export type EdgeFunctionConfigSnapshot = EdgeFunctionConfig & {
  activation_id: EdgeFunctionActivationId;
};

export type EdgeFunctionStateSnapshot = {
  config: EdgeFunctionConfigSnapshot;
  active_version: EdgeFunctionActiveVersion;
};

export interface EdgeFunctionActivationResult {
  previous_active_version: EdgeFunctionActiveVersion;
  active_version: string;
  activation_id: EdgeFunctionActivationId;
  config: EdgeFunctionConfigSnapshot;
}

export type EdgeFunctionDeploymentConfig = Pick<
  Partial<EdgeFunctionConfig>,
  "verify_jwt" | "background_routes"
>;

type EdgeFunctionReleaseBase = {
  ref: string;
  slug: string;
  config?: EdgeFunctionDeploymentConfig;
};

type EdgeFunctionReleaseRequest = EdgeFunctionReleaseBase & (
  | {
    code: string;
    minify?: boolean;
    prebundled?: false;
    expectedSha256?: never;
    files?: never;
    entrypoint?: never;
  }
  | {
    code: string;
    prebundled: true;
    expectedSha256: string;
    minify?: never;
    files?: never;
    entrypoint?: never;
  }
  | {
    files: Record<string, string>;
    entrypoint?: string;
    minify?: boolean;
    code?: never;
    prebundled?: never;
    expectedSha256?: never;
  }
);

export type EdgeFunctionDeploymentRequest = EdgeFunctionReleaseRequest & {
  expectedActiveVersion: EdgeFunctionActiveVersion;
  expectedActivationId: EdgeFunctionActivationId;
};

export interface EdgeFunctionPreheatPoolResult {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
  error?: string;
}

export interface EdgeFunctionPreheatResult {
  ok: boolean;
  status?: number;
  duration_ms: number;
  attempted: number;
  succeeded: number;
  cache_hits: number;
  cache_misses: number;
  foreground?: EdgeFunctionPreheatPoolResult;
  background?: EdgeFunctionPreheatPoolResult;
  error?: string;
}

export interface EdgeFunctionDeployMetrics {
  total_deploys: number;
  total_bundle_size_bytes: number;
  last_bundle_size_bytes: number;
  total_import_count: number;
  last_import_count: number;
  total_preheat_duration_ms: number;
  last_preheat_duration_ms: number;
  total_preheat_attempted: number;
  total_preheat_succeeded: number;
  total_preheat_cache_hits: number;
  total_preheat_cache_misses: number;
}

const DEFAULT_FUNCTION_CONFIG: EdgeFunctionConfig = {
  verify_jwt: true, // Default: require JWT (same as Supabase)
};

/**
 * Edge Function file management — handles function source files on disk.
 *
 * Deployment pipeline (inspired by Supabase's ESZip approach, adapted for Bun):
 *   1. Write source files to disk (preserved as .src.ts for debugging)
 *   2. Run Bun.build() to bundle all dependencies into a single self-contained .js
 *   3. Worker loads the bundled .js — zero runtime dependency resolution needed
 *
 * Supports:
 *   - Single-file deploy (code string)
 *   - Multi-file bundle deploy (file dictionary with _shared/ etc.)
 *   - Optional minification
 */

const VERSIONED_DIR = ".versions";
const BUNDLED_SOURCE_RUNTIME_ENTRY = ".supacloud-entry.js";
const FUNCTION_VERSION_METADATA_FILE = ".supacloud-version.json";
const SAFE_REF_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_SLUG_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const EXTERNAL_PACKAGE_REGEX = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
const CANONICAL_VERSION_REGEX = /^(?:0|[1-9]\d*)$/;
const SHA256_HEX_REGEX = new RegExp(EDGE_FUNCTION_SHA256_HEX_PATTERN);
const CONTENT_ADDRESSED_ARTIFACT_REGEX = /^index\.([a-f0-9]{16})\.js$/;
const functionDeployLocks = new Map<string, Promise<void>>();
const FUNCTION_LOCK_TIMEOUT_MS = 30_000;
const deployMetrics: EdgeFunctionDeployMetrics = {
  total_deploys: 0,
  total_bundle_size_bytes: 0,
  last_bundle_size_bytes: 0,
  total_import_count: 0,
  last_import_count: 0,
  total_preheat_duration_ms: 0,
  last_preheat_duration_ms: 0,
  total_preheat_attempted: 0,
  total_preheat_succeeded: 0,
  total_preheat_cache_hits: 0,
  total_preheat_cache_misses: 0,
};

type BundleFunctionResult = {
  code: string;
  sizeBytes: number;
  importCount: number;
};

type BundleFunctionRequest = {
  entrypoint: string;
  outdir: string;
  minify: boolean;
  importMapPath?: string;
};

type RuntimeControlStatus = {
  ok: boolean;
  status?: number;
  error?: string;
};

type RuntimePreheatOutcome = {
  summary: EdgeFunctionPreheatResult;
  attestation: ValidatedEdgeRuntimePreheat | null;
};

type RuntimeFunctionActivationState =
  | "fenced"
  | "commit_pending"
  | "committed"
  | "aborted"
  | "uncertain";

type RuntimeFunctionActivationAck = {
  activationId: string;
  state: RuntimeFunctionActivationState;
  runtimeInstanceId: string;
  foregroundGeneration: number;
  backgroundGeneration: number;
  cancelledQueued: number;
};

type RuntimeFunctionActivationControl = RuntimeControlStatus & {
  acknowledgement: RuntimeFunctionActivationAck | null;
};

function resolveExternalPackages(): string[] {
  return (process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES || "")
    .split(",")
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0 && EXTERNAL_PACKAGE_REGEX.test(pkg));
}

function validateRef(ref: string): string {
  if (!SAFE_REF_REGEX.test(ref)) {
    throw new Error("Invalid project ref");
  }
  return ref;
}

function validateSlug(slug: string): string {
  if (!SAFE_SLUG_REGEX.test(slug)) {
    throw new Error("Invalid function slug");
  }
  return slug;
}

function parseVersionNumber(value: unknown): number | null {
  if (typeof value !== "string" || !CANONICAL_VERSION_REGEX.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Function version exceeds the safe integer range");
  return parsed;
}

function canonicalFunctionVersion(value: unknown): string {
  const parsedVersion = parseVersionNumber(value);
  if (parsedVersion === null) throw new Error("Function config contains an invalid active version");
  return String(parsedVersion);
}

export function activeFunctionVersionNumber(version: EdgeFunctionActiveVersion): number | null {
  if (version === EDGE_FUNCTION_ABSENT_ACTIVE_VERSION) return null;
  const parsedVersion = parseVersionNumber(version);
  if (parsedVersion === null) throw new Error("Function config contains an invalid active version");
  return parsedVersion;
}

function validatedExpectedActiveVersion(value: unknown): EdgeFunctionActiveVersion {
  if (value === EDGE_FUNCTION_ABSENT_ACTIVE_VERSION) return value;
  if (typeof value !== "string" || !CANONICAL_VERSION_REGEX.test(value)
    || !Number.isSafeInteger(Number(value))) {
    throw new Error("Expected active Function version must be a canonical safe integer or 'absent'");
  }
  return value;
}

export class EdgeFunctionActiveVersionConflictError extends Error {
  readonly code = EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE;

  constructor(
    readonly expectedActiveVersion: EdgeFunctionActiveVersion,
    readonly activeVersion: EdgeFunctionActiveVersion,
    readonly expectedActivationId: EdgeFunctionActivationId,
    readonly activationId: EdgeFunctionActivationId,
  ) {
    super("Function activation identity changed before the requested mutation");
    this.name = "EdgeFunctionActiveVersionConflictError";
  }
}

async function acquireLocalFunctionLock(
  ref: string,
  slug: string,
): Promise<() => void> {
  const key = JSON.stringify([ref, slug]);
  const previous = functionDeployLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(() => current);
  functionDeployLocks.set(key, queueTail);
  await previous;
  return () => {
    release();
    if (functionDeployLocks.get(key) === queueTail) functionDeployLocks.delete(key);
  };
}

function isFunctionLockBusy(error: unknown): boolean {
  return error instanceof Error
    && error.message === "Another SupaCloud upgrade is already running";
}

async function acquireCrossProcessFunctionLock(
  ref: string,
  slug: string,
): Promise<SupaCloudUpgradeLock> {
  const functionDirectory = await prepareTrustedFunctionProjectDirectory(ref, slug);
  const lockPath = assertInside(
    functionDirectory,
    path.join(functionDirectory, `.${validateSlug(slug)}.activation.lock`),
  );
  const deadline = Date.now() + FUNCTION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      if (process.platform === "linux" || process.platform === "darwin") {
        return acquireSupaCloudUpgradeLock(lockPath);
      }
      throw new Error("Function activation lock is unsupported on this platform");
    } catch (error: unknown) {
      if (!isFunctionLockBusy(error) || Date.now() >= deadline) throw error;
      await Bun.sleep(20);
    }
  }
}

async function acquireFunctionDeployLock(
  ref: string,
  slug: string,
): Promise<() => void> {
  const releaseLocal = await acquireLocalFunctionLock(ref, slug);
  try {
    const crossProcessLock = await acquireCrossProcessFunctionLock(ref, slug);
    return () => {
      crossProcessLock.release();
      releaseLocal();
    };
  } catch (error: unknown) {
    releaseLocal();
    throw error;
  }
}

async function preflightAndAcquireFunctionDeployLock(
  ref: string,
  slug: string,
): Promise<() => void> {
  await preflightFunctionMutation(ref, slug);
  return acquireFunctionDeployLock(ref, slug);
}

function getFunctionsRoot(): string {
  return path.resolve(process.env.EDGE_FUNCTIONS_DIR || config.edgeFunctionsDir);
}

function assertInside(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  throw new Error("Path escapes function root");
}

function resolveInside(base: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Invalid bundle file path");
  }
  return assertInside(base, path.resolve(base, normalized));
}

function getFuncDir(ref: string): string {
  const functionsRoot = getFunctionsRoot();
  return assertInside(functionsRoot, path.join(functionsRoot, validateRef(ref)));
}

async function preflightFunctionMutation(ref: string, slug: string): Promise<void> {
  await preflightEdgeFunctionMutationDirectories({
    projectDirectory: getFuncDir(ref),
    functionSlug: validateSlug(slug),
  });
}

async function prepareTrustedFunctionProjectDirectory(
  ref: string,
  slug: string,
): Promise<string> {
  const functionDirectory = getFuncDir(ref);
  try {
    await fs.mkdir(functionDirectory, { mode: 0o755 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await preflightFunctionMutation(ref, slug);
  return functionDirectory;
}

function getFuncPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.js`));
}

function getVersionedFuncPath(ref: string, slug: string, version: string): string {
  const versionDir = getFunctionVersionDir(ref, slug, version);
  return assertInside(versionDir, path.join(versionDir, "index.js"));
}

function getSrcPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.src.ts`));
}

function getVersionedSrcPath(ref: string, slug: string, version: string): string {
  const versionDir = getFunctionVersionDir(ref, slug, version);
  return assertInside(versionDir, path.join(versionDir, "index.src.ts"));
}

function getConfigPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.config.json`));
}

function getVersionRoot(ref: string, slug: string): string {
  const dir = getFuncDir(ref);
  return assertInside(dir, path.join(dir, VERSIONED_DIR, validateSlug(slug)));
}

function getFunctionVersionDir(ref: string, slug: string, version: string): string {
  const versionRoot = getVersionRoot(ref, slug);
  return assertInside(versionRoot, path.join(versionRoot, canonicalFunctionVersion(version)));
}

function getLegacySourceDir(ref: string, slug: string): string {
  const dir = getFuncDir(ref);
  return assertInside(dir, path.join(dir, `.src-${validateSlug(slug)}`));
}

async function frozenLegacyRuntimePath(ref: string, slug: string): Promise<string | null> {
  const candidates = [
    path.join(getLegacySourceDir(ref, slug), BUNDLED_SOURCE_RUNTIME_ENTRY),
    getFuncPath(ref, slug),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function readOptionalFunctionFile(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validatedFunctionConfig(
  configRecord: Record<string, unknown>,
): EdgeFunctionConfig {
  const functionConfig = { ...DEFAULT_FUNCTION_CONFIG, ...configRecord } as EdgeFunctionConfig;
  if (functionConfig.version !== undefined) {
    functionConfig.version = canonicalFunctionVersion(functionConfig.version);
  }
  return functionConfig;
}

type FunctionManifestState = {
  config: EdgeFunctionConfig;
  authority: EdgeFunctionActivationAuthority | null;
  hadManifest: boolean;
};

async function readFunctionManifestState(
  ref: string,
  slug: string,
): Promise<FunctionManifestState> {
  try {
    const raw = await Bun.file(getConfigPath(ref, slug)).text();
    const manifest = parseEdgeFunctionActivationManifest(raw);
    return {
      config: validatedFunctionConfig(manifest.config),
      authority: manifest.authority,
      hadManifest: true,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      config: { ...DEFAULT_FUNCTION_CONFIG },
      authority: null,
      hadManifest: false,
    };
  }
}

function publicActivationId(
  authority: EdgeFunctionActivationAuthority | null,
): EdgeFunctionActivationId {
  return authority?.activation_id ?? EDGE_FUNCTION_LEGACY_ACTIVATION_ID;
}

function functionConfigSnapshot(state: FunctionManifestState): EdgeFunctionConfigSnapshot {
  return {
    ...state.config,
    activation_id: publicActivationId(state.authority),
  };
}

async function activeVersionFromState(
  ref: string,
  slug: string,
  state: FunctionManifestState,
): Promise<EdgeFunctionActiveVersion> {
  if (state.authority?.target_state === "absent") {
    return EDGE_FUNCTION_ABSENT_ACTIVE_VERSION;
  }
  if (state.config.version !== undefined) {
    return state.config.version;
  }
  return await frozenLegacyRuntimePath(ref, slug) === null
    ? EDGE_FUNCTION_ABSENT_ACTIVE_VERSION
    : "0";
}

async function activeFunctionVersion(
  ref: string,
  slug: string,
): Promise<EdgeFunctionActiveVersion> {
  return activeVersionFromState(ref, slug, await readFunctionManifestState(ref, slug));
}

function validatedExpectedActivationId(value: unknown): EdgeFunctionActivationId {
  if (value === EDGE_FUNCTION_LEGACY_ACTIVATION_ID) return value;
  if (typeof value !== "string" || !EDGE_FUNCTION_ACTIVATION_ID_PATTERN.test(value)) {
    throw new Error("Expected Function activation identifier must be a UUID or 'legacy'");
  }
  return value;
}

async function assertExpectedFunctionState(
  ref: string,
  slug: string,
  expectedVersion: unknown,
  expectedActivationId: unknown,
): Promise<{ state: FunctionManifestState; activeVersion: EdgeFunctionActiveVersion }> {
  const expectedActiveVersion = validatedExpectedActiveVersion(expectedVersion);
  const expectedId = validatedExpectedActivationId(expectedActivationId);
  const state = await readFunctionManifestState(ref, slug);
  const activeVersion = await activeVersionFromState(ref, slug, state);
  const activationId = publicActivationId(state.authority);
  if (activeVersion !== expectedActiveVersion || activationId !== expectedId) {
    throw new EdgeFunctionActiveVersionConflictError(
      expectedActiveVersion,
      activeVersion,
      expectedId,
      activationId,
    );
  }
  return { state, activeVersion };
}

async function assertExpectedActivationIdentity(
  ref: string,
  slug: string,
  expectedActivationId: unknown,
): Promise<FunctionManifestState> {
  const expectedId = validatedExpectedActivationId(expectedActivationId);
  const state = await readFunctionManifestState(ref, slug);
  const activationId = publicActivationId(state.authority);
  if (activationId === expectedId) return state;
  const activeVersion = await activeVersionFromState(ref, slug, state);
  throw new EdgeFunctionActiveVersionConflictError(
    activeVersion,
    activeVersion,
    expectedId,
    activationId,
  );
}

/**
 * Validate that function code is non-empty and has some meaningful content.
 * Syntax validation is delegated to Bun.build().
 */
function validateFunctionCode(code: string): {
  valid: boolean;
  error?: string;
} {
  if (!code || code.trim().length === 0) {
    return { valid: false, error: "Function code is empty" };
  }
  if (code.trim().length < 10) {
    return { valid: false, error: "Function code is too short to be valid" };
  }
  // Keep syntax validation mode-specific so prebundled artifacts never pass through Bun.build().
  return { valid: true };
}

export function isCanonicalEdgeFunctionSha256(candidate: string): boolean {
  return SHA256_HEX_REGEX.test(candidate);
}

// Build and final artifact policy failures must escape before a version can be written or preheated.
async function buildFunctionCode(request: BundleFunctionRequest): Promise<string> {
  const buildOptions: Parameters<typeof Bun.build>[0] & { importMap?: string } = {
    entrypoints: [request.entrypoint],
    outdir: request.outdir,
    naming: "index.[ext]",
    target: "bun",
    minify: request.minify,
    external: resolveExternalPackages(),
  };
  if (request.importMapPath) buildOptions.importMap = request.importMapPath;
  const buildResult = await Bun.build(buildOptions);
  if (!buildResult.success) {
    const messages = buildResult.logs
      .map((logEntry: { message?: string }) => logEntry.message || String(logEntry))
      .join("\n");
    logger.error(`[EdgeFunction] Bun.build() failed:\n${messages}`);
    throw new Error("Bun.build() failed while bundling the function");
  }

  const artifact = buildResult.outputs.find((output) => output.kind === "entry-point")
    ?? buildResult.outputs[0];
  if (!artifact) throw new Error("Bun.build() produced no function artifact");
  return artifact.text();
}

async function bundleFunction(request: BundleFunctionRequest): Promise<BundleFunctionResult> {
  const builtCode = await buildFunctionCode(request);
  const normalizedBundle = normalizeEdgeRuntimeBundle(builtCode);
  return {
    code: normalizedBundle.code,
    sizeBytes: bundleSizeBytes(normalizedBundle.code),
    importCount: normalizedBundle.importCount,
  };
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bundleSizeBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function recordDeployMetrics(sizeBytes: number, importCount: number, preheat: EdgeFunctionPreheatResult): void {
  deployMetrics.total_deploys++;
  deployMetrics.total_bundle_size_bytes += sizeBytes;
  deployMetrics.last_bundle_size_bytes = sizeBytes;
  deployMetrics.total_import_count += importCount;
  deployMetrics.last_import_count = importCount;
  deployMetrics.total_preheat_duration_ms += preheat.duration_ms;
  deployMetrics.last_preheat_duration_ms = preheat.duration_ms;
  deployMetrics.total_preheat_attempted += preheat.attempted;
  deployMetrics.total_preheat_succeeded += preheat.succeeded;
  deployMetrics.total_preheat_cache_hits += preheat.cache_hits;
  deployMetrics.total_preheat_cache_misses += preheat.cache_misses;
}

function snapshotDeployMetrics(): EdgeFunctionDeployMetrics {
  return { ...deployMetrics };
}

type PreparedFunctionVersion = {
  version: string;
  bundled: boolean;
  files?: number;
  entrypoint: string | null;
  importMap: string | null;
  bundleHash: string;
  artifactSha256: string;
  bundleSizeBytes: number;
  importCount: number;
  contentPath: string;
};

type FunctionVersionMetadata = {
  version: string;
  verify_jwt: boolean;
  artifact_sha256: string | null;
  background_routes: string[];
  import_map: string | null;
  entrypoint: string | null;
};

type PreparedFunctionRelease = {
  prepared: PreparedFunctionVersion;
  config: EdgeFunctionConfig;
};

type LegacyVersionSnapshotRequest = {
  ref: string;
  slug: string;
  version: string;
  functionConfig: EdgeFunctionConfig;
  runtimePath: string;
};

type CurrentRollbackSnapshotRequest = {
  ref: string;
  slug: string;
  currentState: FunctionManifestState;
};

async function writePreparedBundle(
  stageDir: string,
  finalDir: string,
  code: string,
  artifactSizeBytes?: number,
): Promise<Pick<
  PreparedFunctionVersion,
  "bundleHash" | "artifactSha256" | "bundleSizeBytes" | "contentPath"
>> {
  const artifactSha256 = await sha256Hex(code);
  const bundleHash = artifactSha256.slice(0, 16);
  const sizeBytes = artifactSizeBytes ?? bundleSizeBytes(code);
  await Bun.write(path.join(stageDir, "index.js"), code);
  const contentPath = path.join(stageDir, `index.${bundleHash}.js`);
  await Bun.write(contentPath, code);
  await fs.chmod(contentPath, 0o444);
  return {
    bundleHash,
    artifactSha256,
    bundleSizeBytes: sizeBytes,
    contentPath: path.join(finalDir, `index.${bundleHash}.js`),
  };
}

async function writePreparedReleaseBundle(
  stageDir: string,
  finalDir: string,
  code: string,
  artifactSizeBytes?: number,
): Promise<Pick<
  PreparedFunctionVersion,
  "bundleHash" | "artifactSha256" | "bundleSizeBytes" | "contentPath"
>> {
  const artifact = await writePreparedBundle(stageDir, finalDir, code, artifactSizeBytes);
  const sourceDir = path.join(stageDir, "src");
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o755 });
  const runtimeEntry = path.join(sourceDir, BUNDLED_SOURCE_RUNTIME_ENTRY);
  await Bun.write(runtimeEntry, code);
  await fs.chmod(runtimeEntry, 0o444);
  return artifact;
}

async function prepareSingleFunctionVersion(
  request: EdgeFunctionReleaseRequest & { code: string },
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  const validation = validateFunctionCode(request.code);
  if (!validation.valid) throw new Error(validation.error);
  await fs.mkdir(stageDir, { recursive: true, mode: 0o755 });
  const sourcePath = path.join(stageDir, "index.src.ts");
  const buildDir = path.join(stageDir, ".build");
  await Bun.write(sourcePath, request.code);
  const bundle = await bundleFunction({
    entrypoint: sourcePath,
    outdir: buildDir,
    minify: request.minify ?? false,
  });
  const artifact = await writePreparedReleaseBundle(stageDir, finalDir, bundle.code, bundle.sizeBytes);
  await fs.rm(buildDir, { recursive: true, force: true });
  return {
    version,
    bundled: true,
    entrypoint: null,
    importMap: null,
    importCount: bundle.importCount,
    ...artifact,
  };
}

async function preparePrebundledFunctionVersion(
  request: EdgeFunctionReleaseRequest & {
    code: string;
    prebundled: true;
    expectedSha256: string;
  },
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  const normalization = await validatedPrebundledBundle(request);
  await fs.mkdir(stageDir, { recursive: true, mode: 0o755 });
  await Bun.write(path.join(stageDir, "index.src.ts"), request.code);
  const artifact = await writePreparedReleaseBundle(stageDir, finalDir, request.code);
  return {
    version,
    bundled: true,
    entrypoint: null,
    importMap: null,
    importCount: normalization.importCount,
    ...artifact,
  };
}

async function validatedPrebundledBundle(
  request: EdgeFunctionReleaseRequest & {
    code: string;
    prebundled: true;
    expectedSha256: string;
  },
) {
  const validation = validateFunctionCode(request.code);
  if (!validation.valid) throw new Error(validation.error);
  if (!isCanonicalEdgeFunctionSha256(request.expectedSha256)) {
    throw new Error("Prebundled function expected SHA-256 is invalid");
  }
  if (await sha256Hex(request.code) !== request.expectedSha256) {
    throw new Error("Prebundled function SHA-256 does not match expected_sha256");
  }
  const normalization = normalizeEdgeRuntimeBundle(request.code);
  if (normalization.code !== request.code) {
    throw new Error("Prebundled function would be modified by Edge Runtime normalization");
  }
  return normalization;
}

async function detectedImportMap(sourceDir: string): Promise<string | null> {
  for (const candidate of ["import_map.json", "import_map", "deno.json", "deno.jsonc"]) {
    if (await fileExists(resolveInside(sourceDir, candidate))) return candidate;
  }
  return null;
}

function validatedBundleEntrypoint(
  request: EdgeFunctionReleaseRequest & { files: Record<string, string> },
): string {
  const entrypoint = request.entrypoint ?? "index.ts";
  if (!request.files[entrypoint]) throw new Error(`Entrypoint '${entrypoint}' not found in file map`);
  if (Object.hasOwn(request.files, BUNDLED_SOURCE_RUNTIME_ENTRY)) {
    throw new Error(`Bundle path '${BUNDLED_SOURCE_RUNTIME_ENTRY}' is reserved by the runtime`);
  }
  const validation = validateFunctionCode(request.files[entrypoint]);
  if (!validation.valid) throw new Error(validation.error);
  return entrypoint;
}

async function writeBundleSources(
  sourceDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolveInside(sourceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
    await Bun.write(filePath, content);
  }
}

async function prepareBundleFunctionVersion(
  request: EdgeFunctionReleaseRequest & { files: Record<string, string> },
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  const entrypoint = validatedBundleEntrypoint(request);
  const sourceDir = path.join(stageDir, "src");
  await writeBundleSources(sourceDir, request.files);
  const importMap = await detectedImportMap(sourceDir);
  const buildDir = path.join(stageDir, ".build");
  const bundle = await bundleFunction({
    entrypoint: resolveInside(sourceDir, entrypoint),
    outdir: buildDir,
    minify: request.minify ?? false,
    importMapPath: importMap ? resolveInside(sourceDir, importMap) : undefined,
  });
  const artifact = await writePreparedReleaseBundle(stageDir, finalDir, bundle.code, bundle.sizeBytes);
  await fs.rm(buildDir, { recursive: true, force: true });
  return {
    version,
    bundled: true,
    files: Object.keys(request.files).length,
    entrypoint,
    importMap,
    importCount: bundle.importCount,
    ...artifact,
  };
}

function functionVersionMetadata(
  version: string,
  functionConfig: EdgeFunctionConfig,
  artifactSha256: string,
): FunctionVersionMetadata {
  if (typeof functionConfig.verify_jwt !== "boolean") {
    throw new Error("Function version config contains an invalid verify_jwt policy");
  }
  const backgroundRoutes = functionConfig.background_routes ?? [];
  if (!backgroundRoutes.every((route) => typeof route === "string" && route.trim().length > 0)) {
    throw new Error("Function version config contains invalid background routes");
  }
  return {
    version,
    verify_jwt: functionConfig.verify_jwt,
    artifact_sha256: artifactSha256,
    background_routes: backgroundRoutes,
    import_map: functionConfig.import_map ?? null,
    entrypoint: functionConfig.entrypoint ?? null,
  };
}

async function versionArtifactSha256(
  ref: string,
  slug: string,
  version: string,
): Promise<string> {
  const artifactPath = await getVersionedArtifactPath(ref, slug, version);
  if (!artifactPath) throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
  const artifactSha256 = await sha256Hex(await Bun.file(artifactPath).text());
  const metadata = await readFunctionVersionMetadata(ref, slug, version);
  if (metadata.artifact_sha256 !== artifactSha256) {
    throw new Error("Function version artifact does not match its immutable metadata");
  }
  return artifactSha256;
}

async function writeFunctionVersionMetadata(
  stageDir: string,
  metadata: FunctionVersionMetadata,
): Promise<void> {
  const metadataPath = path.join(stageDir, FUNCTION_VERSION_METADATA_FILE);
  await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
  await fs.chmod(metadataPath, 0o444);
}

async function replaceFunctionVersionMetadata(
  versionDir: string,
  metadata: FunctionVersionMetadata,
): Promise<void> {
  const metadataPath = path.join(versionDir, FUNCTION_VERSION_METADATA_FILE);
  const pendingPath = path.join(
    versionDir,
    `.${FUNCTION_VERSION_METADATA_FILE}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(pendingPath, JSON.stringify(metadata, null, 2));
    await fs.chmod(pendingPath, 0o444);
    await fs.rename(pendingPath, metadataPath);
  } finally {
    await fs.rm(pendingPath, { force: true }).catch(() => {});
  }
}

function nullableMetadataPath(
  metadataRecord: Record<string, unknown>,
  field: "import_map" | "entrypoint",
): string | null {
  const metadataPath = metadataRecord[field];
  if (metadataPath === null) return null;
  if (typeof metadataPath !== "string" || metadataPath.trim().length === 0) {
    throw new Error(`Function version metadata contains an invalid ${field}`);
  }
  return metadataPath;
}

async function validateFunctionVersionMetadataPaths(
  versionDir: string,
  metadata: FunctionVersionMetadata,
): Promise<void> {
  if (metadata.entrypoint === null) {
    if (metadata.import_map !== null) {
      throw new Error("Single-file function version metadata cannot define an import map");
    }
    return;
  }
  const sourceDir = path.join(versionDir, "src");
  if (!(await fileExists(resolveInside(sourceDir, metadata.entrypoint)))) {
    throw new Error("Function version metadata references a missing entrypoint");
  }
  if (metadata.import_map && !(await fileExists(resolveInside(sourceDir, metadata.import_map)))) {
    throw new Error("Function version metadata references a missing import map");
  }
}

async function readFunctionVersionMetadata(
  ref: string,
  slug: string,
  version: string,
): Promise<FunctionVersionMetadata> {
  const versionDir = getFunctionVersionDir(ref, slug, version);
  const metadataPath = path.join(versionDir, FUNCTION_VERSION_METADATA_FILE);
  const metadataRecord = JSON.parse(await Bun.file(metadataPath).text()) as Record<string, unknown>;
  if (!metadataRecord || typeof metadataRecord !== "object" || Array.isArray(metadataRecord)) {
    throw new Error("Function version metadata must be an object");
  }
  if (metadataRecord.version !== version
    || typeof metadataRecord.verify_jwt !== "boolean"
    || (metadataRecord.artifact_sha256 !== undefined
      && (typeof metadataRecord.artifact_sha256 !== "string"
        || !SHA256_HEX_REGEX.test(metadataRecord.artifact_sha256)))) {
    throw new Error("Function version metadata does not match the requested version and policy");
  }
  if (!Array.isArray(metadataRecord.background_routes)
    || !metadataRecord.background_routes.every(
      (route) => typeof route === "string" && route.trim().length > 0,
    )) {
    throw new Error("Function version metadata contains invalid background routes");
  }
  const metadata: FunctionVersionMetadata = {
    version,
    verify_jwt: metadataRecord.verify_jwt,
    artifact_sha256: typeof metadataRecord.artifact_sha256 === "string"
      ? metadataRecord.artifact_sha256
      : null,
    background_routes: metadataRecord.background_routes as string[],
    import_map: nullableMetadataPath(metadataRecord, "import_map"),
    entrypoint: nullableMetadataPath(metadataRecord, "entrypoint"),
  };
  await validateFunctionVersionMetadataPaths(versionDir, metadata);
  return metadata;
}

async function inferredVersionEntrypoint(
  sourceDir: string,
  configuredEntrypoint?: string,
): Promise<string | null> {
  if (configuredEntrypoint
    && await fileExists(resolveInside(sourceDir, configuredEntrypoint))) {
    return configuredEntrypoint;
  }
  if (await fileExists(path.join(sourceDir, "index.ts"))) return "index.ts";
  if (await fileExists(path.join(sourceDir, BUNDLED_SOURCE_RUNTIME_ENTRY))) {
    return BUNDLED_SOURCE_RUNTIME_ENTRY;
  }
  return null;
}

async function sourceMetadataConfig(
  functionConfig: EdgeFunctionConfig,
  version: string,
  versionDir: string,
): Promise<EdgeFunctionConfig> {
  const versionConfig = { ...functionConfig, version };
  if (await fileExists(path.join(versionDir, "index.src.ts"))) {
    delete versionConfig.entrypoint;
    delete versionConfig.import_map;
    return versionConfig;
  }
  const sourceDir = path.join(versionDir, "src");
  const entrypoint = await inferredVersionEntrypoint(sourceDir, functionConfig.entrypoint);
  if (entrypoint === null) {
    delete versionConfig.entrypoint;
    delete versionConfig.import_map;
    return versionConfig;
  }
  versionConfig.entrypoint = entrypoint;
  versionConfig.import_map = await detectedImportMap(sourceDir) ?? undefined;
  return versionConfig;
}

async function backfillActiveVersionMetadata(
  ref: string,
  slug: string,
  version: string,
  functionConfig: EdgeFunctionConfig,
): Promise<void> {
  const versionDir = getFunctionVersionDir(ref, slug, version);
  let existingMetadata: FunctionVersionMetadata | null = null;
  try {
    existingMetadata = await readFunctionVersionMetadata(ref, slug, version);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourceConfig = existingMetadata
    ? restoredFunctionConfig(functionConfig, {
        ...existingMetadata,
        verify_jwt: functionConfig.verify_jwt,
        background_routes: functionConfig.background_routes ?? [],
      })
    : await sourceMetadataConfig(functionConfig, version, versionDir);
  if (existingMetadata?.artifact_sha256) {
    await getVersionedArtifactPath(ref, slug, version);
    await replaceFunctionVersionMetadata(
      versionDir,
      functionVersionMetadata(version, sourceConfig, existingMetadata.artifact_sha256),
    );
    return;
  }
  const immutableArtifact = await legacyImmutableArtifact(versionDir);
  const legacyArtifact = getVersionedFuncPath(ref, slug, version);
  if (immutableArtifact === null && !await fileExists(legacyArtifact)) {
    throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
  }
  const runtimeCode = immutableArtifact?.code ?? await Bun.file(legacyArtifact).text();
  const artifactSha256 = immutableArtifact?.sha256 ?? await sha256Hex(runtimeCode);
  const contentAddressedPath = path.join(
    versionDir,
    `index.${artifactSha256.slice(0, 16)}.js`,
  );
  if (!await fileExists(contentAddressedPath)) {
    await preflightFunctionMutation(ref, slug);
    await Bun.write(contentAddressedPath, runtimeCode);
    await fs.chmod(contentAddressedPath, 0o444);
  }
  await preflightFunctionMutation(ref, slug);
  await replaceFunctionVersionMetadata(
    versionDir,
    functionVersionMetadata(version, sourceConfig, artifactSha256),
  );
}

async function legacyImmutableArtifact(
  versionDir: string,
): Promise<{ code: string; sha256: string } | null> {
  const candidates = (await fs.readdir(versionDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && CONTENT_ADDRESSED_ARTIFACT_REGEX.test(entry.name));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new Error("Function version contains ambiguous content-addressed artifacts");
  }
  const candidate = candidates[0]!;
  const code = await Bun.file(path.join(versionDir, candidate.name)).text();
  const sha256 = await sha256Hex(code);
  if (candidate.name !== `index.${sha256.slice(0, 16)}.js`) {
    throw new Error("Function version content-addressed artifact does not match its name");
  }
  return { code, sha256 };
}

async function migrateImmutableVersionArtifact(
  ref: string,
  slug: string,
  version: string,
): Promise<boolean> {
  const versionDir = getFunctionVersionDir(ref, slug, version);
  let metadata: FunctionVersionMetadata | null = null;
  try {
    metadata = await readFunctionVersionMetadata(ref, slug, version);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
  }
  if (metadata?.artifact_sha256) {
    await getVersionedArtifactPath(ref, slug, version);
    return false;
  }
  await preflightFunctionMutation(ref, slug);
  const immutableArtifact = await legacyImmutableArtifact(versionDir);
  const legacyArtifact = getVersionedFuncPath(ref, slug, version);
  if (immutableArtifact === null && !await fileExists(legacyArtifact)) {
    if (metadata === null) return false;
    throw new Error("Function version artifact is missing during startup migration");
  }
  const runtimeCode = immutableArtifact?.code ?? await Bun.file(legacyArtifact).text();
  const artifactSha256 = immutableArtifact?.sha256 ?? await sha256Hex(runtimeCode);
  const contentAddressedPath = assertInside(
    versionDir,
    path.join(versionDir, `index.${artifactSha256.slice(0, 16)}.js`),
  );
  if (await fileExists(contentAddressedPath)) {
    const existingSha256 = await sha256Hex(await Bun.file(contentAddressedPath).text());
    if (existingSha256 !== artifactSha256) {
      throw new Error("Function version content-addressed artifact is ambiguous");
    }
  } else {
    await preflightFunctionMutation(ref, slug);
    await Bun.write(contentAddressedPath, runtimeCode);
    await fs.chmod(contentAddressedPath, 0o444);
  }
  const sourceConfig = metadata
    ? restoredFunctionConfig({ verify_jwt: metadata.verify_jwt }, metadata)
    : await sourceMetadataConfig({ verify_jwt: true }, version, versionDir);
  await preflightFunctionMutation(ref, slug);
  await replaceFunctionVersionMetadata(
    versionDir,
    functionVersionMetadata(version, sourceConfig, artifactSha256),
  );
  return true;
}

async function migrateProjectImmutableVersions(ref: string): Promise<number> {
  const versionsRoot = assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR));
  let migrated = 0;
  for (const slugEntry of await fs.readdir(versionsRoot, { withFileTypes: true }).catch((error) => {
    if (isMissingPathError(error)) return [];
    throw error;
  })) {
    if (!slugEntry.isDirectory()) {
      throw new Error("Function version root contains an invalid entry");
    }
    const slug = validateSlug(slugEntry.name);
    for (const version of await listVersionDirectories(ref, slug)) {
      if (await migrateImmutableVersionArtifact(ref, slug, version)) migrated += 1;
    }
  }
  return migrated;
}

async function snapshotFrozenLegacyVersion(
  snapshot: LegacyVersionSnapshotRequest,
): Promise<EdgeFunctionConfig> {
  const versionRoot = getVersionRoot(snapshot.ref, snapshot.slug);
  const finalDir = getFunctionVersionDir(snapshot.ref, snapshot.slug, snapshot.version);
  if (await fileExists(finalDir)) {
    return completeFrozenLegacyVersionSnapshot(snapshot, finalDir);
  }
  const stageDir = assertInside(
    versionRoot,
    path.join(versionRoot, `.pending-legacy-${snapshot.version}-${crypto.randomUUID()}`),
  );
  await fs.mkdir(stageDir, { recursive: true, mode: 0o755 });
  try {
    const runtimeCode = await Bun.file(snapshot.runtimePath).text();
    const artifact = await writePreparedBundle(stageDir, finalDir, runtimeCode);
    await copyFrozenLegacySource(snapshot.ref, snapshot.slug, stageDir);
    const snapshotConfig = await sourceMetadataConfig(
      snapshot.functionConfig,
      snapshot.version,
      stageDir,
    );
    await writeFunctionVersionMetadata(
      stageDir,
      functionVersionMetadata(snapshot.version, snapshotConfig, artifact.artifactSha256),
    );
    await fs.rename(stageDir, finalDir);
    return snapshotConfig;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyFrozenLegacySource(
  ref: string,
  slug: string,
  targetDir: string,
): Promise<void> {
  if (await fileExists(path.join(targetDir, "src"))
    || await fileExists(path.join(targetDir, "index.src.ts"))) return;
  const legacySourceDir = getLegacySourceDir(ref, slug);
  if (await fileExists(legacySourceDir)) {
    await fs.cp(legacySourceDir, path.join(targetDir, "src"), { recursive: true });
    return;
  }
  const legacySourcePath = getSrcPath(ref, slug);
  if (await fileExists(legacySourcePath)) {
    await fs.copyFile(legacySourcePath, path.join(targetDir, "index.src.ts"));
  }
}

async function completeFrozenLegacyVersionSnapshot(
  snapshot: LegacyVersionSnapshotRequest,
  versionDir: string,
): Promise<EdgeFunctionConfig> {
  const pendingDir = assertInside(
    getVersionRoot(snapshot.ref, snapshot.slug),
    path.join(
      getVersionRoot(snapshot.ref, snapshot.slug),
      `.pending-artifact-${snapshot.version}-${crypto.randomUUID()}`,
    ),
  );
  await fs.mkdir(pendingDir, { recursive: true, mode: 0o755 });
  try {
    const runtimeCode = await Bun.file(snapshot.runtimePath).text();
    const artifact = await writePreparedBundle(pendingDir, versionDir, runtimeCode);
    await fs.rename(
      path.join(pendingDir, path.basename(artifact.contentPath)),
      artifact.contentPath,
    );
    await fs.rename(path.join(pendingDir, "index.js"), path.join(versionDir, "index.js"));
    await copyFrozenLegacySource(snapshot.ref, snapshot.slug, versionDir);
    const snapshotConfig = await sourceMetadataConfig(
      snapshot.functionConfig,
      snapshot.version,
      versionDir,
    );
    await replaceFunctionVersionMetadata(
      versionDir,
      functionVersionMetadata(snapshot.version, snapshotConfig, artifact.artifactSha256),
    );
    return snapshotConfig;
  } finally {
    await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureConfiguredRollbackSnapshot(
  ref: string,
  slug: string,
  currentConfig: EdgeFunctionConfig,
): Promise<EdgeFunctionConfig> {
  const version = currentConfig.version!;
  if (parseVersionNumber(version) === null) {
    throw new Error("Function config contains an invalid version");
  }
  const modernArtifact = getVersionedFuncPath(ref, slug, version);
  if (await fileExists(modernArtifact) || await getVersionedArtifactPath(ref, slug, version)) {
    await backfillActiveVersionMetadata(ref, slug, version, currentConfig);
    return currentConfig;
  }
  throw new Error("Active function version artifact is missing");
}

async function ensureLegacyVersionZeroSnapshot(
  snapshot: CurrentRollbackSnapshotRequest,
  legacyRuntimePath: string,
): Promise<FunctionManifestState> {
  const currentConfig = snapshot.currentState.config;
  const versionZeroArtifact = await getVersionedArtifactPath(snapshot.ref, snapshot.slug, "0");
  const versionZeroConfig = versionZeroArtifact
    ? await sourceMetadataConfig(
        currentConfig,
        "0",
        path.join(getVersionRoot(snapshot.ref, snapshot.slug), "0"),
      )
    : await snapshotFrozenLegacyVersion({
        ref: snapshot.ref,
        slug: snapshot.slug,
        version: "0",
        functionConfig: currentConfig,
        runtimePath: legacyRuntimePath,
      });
  if (versionZeroArtifact) {
    await replaceFunctionVersionMetadata(
      path.join(getVersionRoot(snapshot.ref, snapshot.slug), "0"),
      functionVersionMetadata(
        "0",
        versionZeroConfig,
        await versionArtifactSha256(snapshot.ref, snapshot.slug, "0"),
      ),
    );
  }
  await commitFunctionActivation({
    ref: snapshot.ref,
    slug: snapshot.slug,
    previousState: snapshot.currentState,
    nextConfig: versionZeroConfig,
    artifactSha256: await sha256Hex(
      await Bun.file(
        await getVersionedArtifactPath(snapshot.ref, snapshot.slug, "0")
          ?? getVersionedFuncPath(snapshot.ref, snapshot.slug, "0"),
      ).text(),
    ),
  });
  return readFunctionManifestState(snapshot.ref, snapshot.slug);
}

async function ensureCurrentRollbackSnapshot(
  snapshot: CurrentRollbackSnapshotRequest,
): Promise<FunctionManifestState> {
  if (snapshot.currentState.config.version) {
    await ensureConfiguredRollbackSnapshot(
      snapshot.ref,
      snapshot.slug,
      snapshot.currentState.config,
    );
    return snapshot.currentState;
  }
  const legacyRuntimePath = await frozenLegacyRuntimePath(snapshot.ref, snapshot.slug);
  if (!legacyRuntimePath) return snapshot.currentState;
  return ensureLegacyVersionZeroSnapshot(snapshot, legacyRuntimePath);
}

async function functionActivationArtifactSha256(
  ref: string,
  slug: string,
  state: FunctionManifestState,
): Promise<string | null> {
  if (state.authority?.target_state === "absent") return null;
  const version = state.config.version;
  if (!version) {
    if (await frozenLegacyRuntimePath(ref, slug) === null) return null;
    throw new Error("Legacy Function must be snapshotted before activation");
  }
  const artifactPath = await getVersionedArtifactPath(ref, slug, version);
  if (!artifactPath) throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
  return sha256Hex(await Bun.file(artifactPath).text());
}

const MAX_RUNTIME_CONTROL_BYTES = 64 * 1024;
const RUNTIME_INSTANCE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function hasExactRecordKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

async function runtimeControlChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ chunks: Uint8Array[]; byteLength: number }> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return { chunks, byteLength };
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_RUNTIME_CONTROL_BYTES) {
      await reader.cancel();
      throw new Error("Edge Runtime control response is too large");
    }
    chunks.push(chunk.value);
  }
}

function joinRuntimeControlChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readRuntimeControlBody(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_RUNTIME_CONTROL_BYTES) {
    throw new Error("Edge Runtime control response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Edge Runtime control response is empty");
  try {
    const { chunks, byteLength } = await runtimeControlChunks(reader);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      joinRuntimeControlChunks(chunks, byteLength),
    );
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Edge Runtime control response must be an object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    reader.releaseLock();
  }
}

function emptyPreheatPool(): EdgeFunctionPreheatPoolResult {
  return { attempted: 0, succeeded: 0, cacheHits: 0, cacheMisses: 0, durationMs: 0 };
}

function publicPreheatPool(
  pool: ValidatedEdgeRuntimePreheat["foreground"] | undefined,
): EdgeFunctionPreheatPoolResult {
  if (!pool) return emptyPreheatPool();
  return {
    attempted: pool.attempted,
    succeeded: pool.succeeded,
    cacheHits: pool.cacheHits,
    cacheMisses: pool.cacheMisses,
    durationMs: pool.durationMs,
  };
}

async function preheatRuntimeFunction(
  expected: ExpectedEdgeRuntimePreheat,
): Promise<RuntimePreheatOutcome> {
  const start = performance.now();
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const headers = runtimeInternalHeaders();
    if (expected.requestedVersion) {
      headers["x-supacloud-function-version"] = expected.requestedVersion;
    }
    if (expected.activationId) {
      headers["x-supacloud-activation-id"] = expected.activationId;
    }
    const preheatRes = await fetch(
      `${runtimeUrl}/preheat/${expected.projectRef}/${expected.functionSlug}`,
      {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const durationMs = Math.round(performance.now() - start);
    const acknowledgement = validateEdgeRuntimePreheat(
      await readRuntimeControlBody(preheatRes),
      expected,
    );
    const foreground = publicPreheatPool(acknowledgement?.foreground);
    const background = publicPreheatPool(acknowledgement?.background);
    const acknowledgementError = acknowledgement
      ? undefined
      : "Edge Runtime returned an invalid preheat attestation";
    return {
      summary: {
        ok: preheatRes.ok && acknowledgement !== null,
        status: preheatRes.status,
        duration_ms: durationMs,
        attempted: foreground.attempted + background.attempted,
        succeeded: foreground.succeeded + background.succeeded,
        cache_hits: foreground.cacheHits + background.cacheHits,
        cache_misses: foreground.cacheMisses + background.cacheMisses,
        foreground,
        background,
        error: acknowledgementError,
      },
      attestation: acknowledgement,
    };
  } catch (error) {
    return {
      summary: {
        ok: false,
        duration_ms: Math.round(performance.now() - start),
        attempted: 0,
        succeeded: 0,
        cache_hits: 0,
        cache_misses: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      attestation: null,
    };
  }
}

/**
 * Clear module caches so Worker threads pick up the new version.
 */
function runtimeInternalHeaders(): Record<string, string> {
  return { "x-supacloud-internal-auth": config.edgeRuntimeMasterKey || config.masterToken };
}

const RUNTIME_FUNCTION_ACTIVATION_SCHEMA =
  "supacloud.edge-runtime-function-activation.v1";
const RUNTIME_FUNCTION_ACTIVATION_KEYS = [
  "schema",
  "activation_id",
  "state",
  "runtime_instance_id",
  "foreground_generation",
  "background_generation",
  "cancelled_queued",
] as const;
const RUNTIME_FUNCTION_ACTIVATION_STATES: readonly RuntimeFunctionActivationState[] = [
  "fenced",
  "commit_pending",
  "committed",
  "aborted",
  "uncertain",
];

function runtimeFunctionActivationAck(
  payload: Record<string, unknown>,
  activationId: string,
): RuntimeFunctionActivationAck | null {
  if (!hasExactRecordKeys(payload, RUNTIME_FUNCTION_ACTIVATION_KEYS)
    || payload.schema !== RUNTIME_FUNCTION_ACTIVATION_SCHEMA
    || payload.activation_id !== activationId
    || !RUNTIME_FUNCTION_ACTIVATION_STATES.includes(
      payload.state as RuntimeFunctionActivationState,
    )
    || typeof payload.runtime_instance_id !== "string"
    || !RUNTIME_INSTANCE_ID_PATTERN.test(payload.runtime_instance_id)
    || !Number.isSafeInteger(payload.foreground_generation)
    || Number(payload.foreground_generation) < 0
    || !Number.isSafeInteger(payload.background_generation)
    || Number(payload.background_generation) < 0
    || !Number.isSafeInteger(payload.cancelled_queued)
    || Number(payload.cancelled_queued) < 0) return null;
  return {
    activationId,
    state: payload.state as RuntimeFunctionActivationState,
    runtimeInstanceId: payload.runtime_instance_id,
    foregroundGeneration: payload.foreground_generation as number,
    backgroundGeneration: payload.background_generation as number,
    cancelledQueued: payload.cancelled_queued as number,
  };
}

type RuntimeFunctionActivationRequest = {
  ref: string;
  slug: string;
  activationId: string;
  action: "begin" | "commit" | "abort" | "status";
};

async function runtimeFunctionActivationControl(
  request: RuntimeFunctionActivationRequest,
): Promise<RuntimeFunctionActivationControl> {
  try {
    const response = await fetch(
      `http://${config.edgeRuntimeInternal}/internal/function-activation/${request.ref}/${request.slug}/${request.action}`,
      {
        method: request.action === "status" ? "GET" : "POST",
        headers: {
          ...runtimeInternalHeaders(),
          "x-supacloud-activation-id": request.activationId,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    const acknowledgement = runtimeFunctionActivationAck(
      await readRuntimeControlBody(response),
      request.activationId,
    );
    return {
      ok: response.ok && acknowledgement !== null,
      status: response.status,
      acknowledgement,
      ...(acknowledgement === null
        ? { error: "Edge Runtime returned an invalid Function activation acknowledgement" }
        : {}),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      acknowledgement: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function settleRuntimeFunctionActivation(
  ref: string,
  slug: string,
  state: FunctionManifestState,
): Promise<void> {
  const activationId = state.authority?.activation_id;
  if (!activationId) return;
  const status = await requiredRuntimeActivationState({
    ref,
    slug,
    activationId,
    action: "status",
  }, ["committed", "commit_pending"]);
  await confirmEdgeFunctionActivationManifestDurable(
    getConfigPath(ref, slug),
    activationId,
  );
  if (status.state === "commit_pending") {
    await requiredRuntimeActivationState({
      ref,
      slug,
      activationId,
      action: "commit",
    }, ["committed"]);
  }
}

function throwRuntimeControlFailure(
  control: RuntimeControlStatus,
  operation: string,
): never {
  const status = control.status === undefined ? "" : ` (HTTP ${control.status})`;
  throw new ServiceUnavailableError(
    "Edge Runtime function activation",
    `${operation}${status}: ${control.error || "control request failed"}`,
  );
}

function requiredPreheatAttestation(
  preheat: RuntimePreheatOutcome,
  operation: string,
): ValidatedEdgeRuntimePreheat {
  if (!preheat.summary.ok || !preheat.attestation) {
    throwRuntimeControlFailure(preheat.summary, operation);
  }
  return preheat.attestation;
}

async function readConfiguredFunctionVersion(ref: string, slug: string): Promise<number> {
  try {
    const raw = await Bun.file(getConfigPath(ref, slug)).text();
    const parsed = JSON.parse(raw) as EdgeFunctionConfig;
    if (parsed.version === undefined) return 0;
    const version = parseVersionNumber(parsed.version);
    if (version === null) throw new Error("Function config contains an invalid version");
    return version;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return 0;
  }
}

async function maxHistoricalFunctionVersion(ref: string, slug: string): Promise<number> {
  const history = await listVersionDirectories(ref, slug);
  return history.reduce((maximum, version) => Math.max(maximum, Number(version)), 0);
}

async function assertFunctionVersionAvailable(ref: string, slug: string, version: number): Promise<void> {
  const candidate = getFunctionVersionDir(ref, slug, String(version));
  try {
    await fs.access(candidate);
    throw new Error(`Function version directory already exists: ${version}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function computeNextFunctionVersion(ref: string, slug: string): Promise<string> {
  const configured = await readConfiguredFunctionVersion(ref, slug);
  const historical = await maxHistoricalFunctionVersion(ref, slug);
  const next = Math.max(configured, historical) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Function version exceeds the safe integer range");
  await assertFunctionVersionAvailable(ref, slug, next);
  return String(next);
}

async function readVersionedFunctionCode(ref: string, slug: string, version: string): Promise<string | null> {
  const candidate = await getVersionedArtifactPath(ref, slug, version);
  if (!candidate) return null;
  if (!(await fileExists(candidate))) return null;
  return await Bun.file(candidate).text();
}

async function readVersionedFunctionSource(
  ref: string,
  slug: string,
  version: string,
  entrypoint: string = "index.ts",
): Promise<string | null> {
  const versionRoot = getFunctionVersionDir(ref, slug, version);
  const candidates = [
    getVersionedSrcPath(ref, slug, version),
    resolveInside(path.join(versionRoot, "src"), entrypoint),
    assertInside(versionRoot, path.join(versionRoot, "src", BUNDLED_SOURCE_RUNTIME_ENTRY)),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return Bun.file(candidate).text();
  }
  return null;
}

export async function getVersionedArtifactPath(
  ref: string,
  slug: string,
  version: string,
): Promise<string | null> {
  const dir = getFunctionVersionDir(ref, slug, version);
  const metadataPath = path.join(dir, FUNCTION_VERSION_METADATA_FILE);
  if (!await fileExists(metadataPath)) return null;
  const metadata = await readFunctionVersionMetadata(ref, slug, version);
  if (metadata.artifact_sha256 === null) {
    throw new Error("Function version metadata is missing its artifact digest");
  }
  const contentAddressedPath = assertInside(
    dir,
    path.join(dir, `index.${metadata.artifact_sha256.slice(0, 16)}.js`),
  );
  if (!await fileExists(contentAddressedPath)) {
    throw new Error("Function version artifact is missing for immutable metadata");
  }
  const actualSha256 = await sha256Hex(await Bun.file(contentAddressedPath).text());
  if (actualSha256 !== metadata.artifact_sha256) {
    throw new Error("Function version artifact does not match its immutable metadata");
  }
  return contentAddressedPath;
}

async function listVersionDirectories(ref: string, slug: string): Promise<string[]> {
  const dir = assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug)));
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && parseVersionNumber(entry.name) !== null)
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function statIso(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

function parseLegacyVersionedFile(entry: string): { slug: string; version: string; kind: "js" | "src" } | null {
  const jsMatch = entry.match(/^(.*)\.v(\d+)\.js$/);
  if (jsMatch) {
    return { slug: jsMatch[1], version: jsMatch[2], kind: "js" };
  }

  const srcMatch = entry.match(/^(.*)\.v(\d+)\.src\.ts$/);
  if (srcMatch) {
    return { slug: srcMatch[1], version: srcMatch[2], kind: "src" };
  }

  return null;
}

function parseLegacyVersionedSourceDir(entry: string): { slug: string; version: string } | null {
  const match = entry.match(/^\.src-(.*)-v(\d+)$/);
  if (!match) return null;
  return { slug: match[1], version: match[2] };
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function directoryEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function removeFunctionArtifacts(ref: string, slug: string): Promise<void> {
  const dir = getFuncDir(ref);
  const safeSlug = validateSlug(slug);
  const entries = await directoryEntries(dir);
  const legacyArtifacts = entries.filter((entry) =>
    parseLegacyVersionedFile(entry)?.slug === safeSlug
    || parseLegacyVersionedSourceDir(entry)?.slug === safeSlug
  );
  const exactTargets = [
    getFuncPath(ref, safeSlug),
    getSrcPath(ref, safeSlug),
    getLegacySourceDir(ref, safeSlug),
    getVersionRoot(ref, safeSlug),
    ...legacyArtifacts.map((entry) => resolveInside(dir, entry)),
  ];
  await Promise.all(exactTargets.map((target) =>
    fs.rm(target, { recursive: true, force: true })
  ));
}

async function functionProjectDirectories(): Promise<Dirent[]> {
  try {
    return await fs.readdir(getFunctionsRoot(), { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function assertLegacyMigrationSource(
  sourcePath: string,
  expectedType: "file" | "directory",
): Promise<void> {
  const metadata = await fs.lstat(sourcePath);
  const expectedTypePresent = expectedType === "file"
    ? metadata.isFile()
    : metadata.isDirectory();
  if (!expectedTypePresent) {
    throw new Error("Legacy Function migration source has an invalid type");
  }
}

async function migrateLegacyVersionedFile(
  ref: string,
  directory: string,
  entry: string,
  parsed: { slug: string; version: string; kind: "js" | "src" },
): Promise<void> {
  const slug = validateSlug(parsed.slug);
  const version = canonicalFunctionVersion(parsed.version);
  const sourcePath = resolveInside(directory, entry);
  await preflightFunctionMutation(ref, slug);
  await assertLegacyMigrationSource(sourcePath, "file");
  const targetPath = parsed.kind === "js"
    ? getVersionedFuncPath(ref, slug, version)
    : getVersionedSrcPath(ref, slug, version);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  await preflightFunctionMutation(ref, slug);
  await fs.rm(targetPath, { force: true });
  await fs.rename(sourcePath, targetPath);
}

async function migrateLegacyVersionedSourceDirectory(
  ref: string,
  directory: string,
  entry: string,
  parsed: { slug: string; version: string },
): Promise<void> {
  const slug = validateSlug(parsed.slug);
  const version = canonicalFunctionVersion(parsed.version);
  const sourceDirectory = resolveInside(directory, entry);
  await preflightFunctionMutation(ref, slug);
  await assertLegacyMigrationSource(sourceDirectory, "directory");
  const versionDirectory = getFunctionVersionDir(ref, slug, version);
  const targetDirectory = assertInside(versionDirectory, path.join(versionDirectory, "src"));
  await fs.mkdir(path.dirname(targetDirectory), { recursive: true, mode: 0o755 });
  await preflightFunctionMutation(ref, slug);
  await fs.rm(targetDirectory, { recursive: true, force: true });
  await fs.rename(sourceDirectory, targetDirectory);
}

async function migrateLegacyProjectArtifacts(ref: string): Promise<number> {
  const directory = getFuncDir(ref);
  let moved = 0;
  for (const entry of await directoryEntries(directory)) {
    const versionedFile = parseLegacyVersionedFile(entry);
    if (versionedFile) {
      await migrateLegacyVersionedFile(ref, directory, entry, versionedFile);
      moved += 1;
      continue;
    }
    const sourceDirectory = parseLegacyVersionedSourceDir(entry);
    if (!sourceDirectory) continue;
    await migrateLegacyVersionedSourceDirectory(ref, directory, entry, sourceDirectory);
    moved += 1;
  }
  return moved + await migrateProjectImmutableVersions(ref);
}

export async function migrateLegacyVersionArtifacts(): Promise<{ moved: number }> {
  let moved = 0;
  for (const projectDirectory of await functionProjectDirectories()) {
    if (!projectDirectory.isDirectory() || projectDirectory.name === ".cache") continue;
    moved += await migrateLegacyProjectArtifacts(validateRef(projectDirectory.name));
  }
  return { moved };
}

async function immutableFunctionVersion(
  request: EdgeFunctionReleaseRequest,
  version: string,
  currentConfig: EdgeFunctionConfig,
): Promise<PreparedFunctionRelease> {
  const versionRoot = getVersionRoot(request.ref, request.slug);
  const finalDir = getFunctionVersionDir(request.ref, request.slug, version);
  const stageDir = assertInside(
    versionRoot,
    path.join(versionRoot, `.pending-${version}-${crypto.randomUUID()}`),
  );
  await fs.mkdir(versionRoot, { recursive: true, mode: 0o755 });
  await preflightFunctionMutation(request.ref, request.slug);
  try {
    const prepared = await prepareImmutableFunctionVersion(request, version, stageDir, finalDir);
    const functionConfig = activatedFunctionConfig(currentConfig, request.config, prepared);
    await writeFunctionVersionMetadata(
      stageDir,
      functionVersionMetadata(version, functionConfig, prepared.artifactSha256),
    );
    await fs.rename(stageDir, finalDir);
    return { prepared, config: functionConfig };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareImmutableFunctionVersion(
  request: EdgeFunctionReleaseRequest,
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  if (request.code === undefined) {
    return prepareBundleFunctionVersion(request, version, stageDir, finalDir);
  }
  return request.prebundled === true
    ? preparePrebundledFunctionVersion(request, version, stageDir, finalDir)
    : prepareSingleFunctionVersion(request, version, stageDir, finalDir);
}

function activatedFunctionConfig(
  current: EdgeFunctionConfig,
  configPatch: EdgeFunctionDeploymentConfig | undefined,
  prepared: PreparedFunctionVersion,
): EdgeFunctionConfig {
  const next = { ...current, ...configPatch, version: prepared.version };
  if (prepared.importMap === null) delete next.import_map;
  else next.import_map = prepared.importMap;
  if (prepared.entrypoint === null) delete next.entrypoint;
  else next.entrypoint = prepared.entrypoint;
  return next;
}

function restoredFunctionConfig(
  current: EdgeFunctionConfig,
  metadata: FunctionVersionMetadata,
): EdgeFunctionConfig {
  const restored: EdgeFunctionConfig = {
    ...current,
    verify_jwt: metadata.verify_jwt,
    background_routes: metadata.background_routes,
    version: metadata.version,
  };
  if (metadata.import_map === null) delete restored.import_map;
  else restored.import_map = metadata.import_map;
  if (metadata.entrypoint === null) delete restored.entrypoint;
  else restored.entrypoint = metadata.entrypoint;
  return restored;
}

type FunctionActivationCommit = {
  ref: string;
  slug: string;
  previousState: FunctionManifestState;
  nextConfig: EdgeFunctionConfig;
  artifactSha256: string | null;
};

type PreparedFunctionActivation = FunctionActivationCommit & {
  authority: EdgeFunctionActivationAuthority;
};

function activationConfigRecord(config: EdgeFunctionConfig): Record<string, unknown> {
  return { ...config };
}

function nextFunctionActivationAuthority(
  previous: FunctionManifestState,
  artifactSha256: string | null,
): EdgeFunctionActivationAuthority {
  const targetState = artifactSha256 === null ? "absent" : "active";
  return {
    schema: EDGE_FUNCTION_ACTIVATION_SCHEMA,
    activation_id: crypto.randomUUID(),
    activation_generation: (previous.authority?.activation_generation ?? 0) + 1,
    previous_activation_id: previous.authority?.activation_id ?? null,
    target_state: targetState,
    artifact_sha256: artifactSha256,
  };
}

async function preparedFunctionActivation(
  commit: FunctionActivationCommit,
): Promise<PreparedFunctionActivation> {
  const authority = nextFunctionActivationAuthority(
    commit.previousState,
    commit.artifactSha256,
  );
  await writeEdgeFunctionActivationGeneration({
    projectDirectory: getFuncDir(commit.ref),
    functionSlug: commit.slug,
    config: activationConfigRecord(commit.nextConfig),
    authority,
  });
  return { ...commit, authority };
}

function runtimeActivationFailure(message: string): ServiceUnavailableError {
  return new ServiceUnavailableError("Edge Runtime function activation", message);
}

async function requiredRuntimeActivationState(
  request: RuntimeFunctionActivationRequest,
  acceptedStates: readonly RuntimeFunctionActivationState[],
): Promise<RuntimeFunctionActivationAck> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await runtimeFunctionActivationControl(request);
    const state = control.acknowledgement?.state;
    if (control.ok && control.acknowledgement && state && acceptedStates.includes(state)) {
      return control.acknowledgement;
    }
    const readback = await runtimeFunctionActivationControl({
      ...request,
      action: "status",
    });
    const readbackState = readback.acknowledgement?.state;
    if (readback.ok
      && readback.acknowledgement
      && readbackState
      && acceptedStates.includes(readbackState)) {
      return readback.acknowledgement;
    }
    if (readbackState === "uncertain") break;
  }
  throw runtimeActivationFailure("runtime activation state is uncertain");
}

async function beginPreparedFunctionActivation(
  activation: PreparedFunctionActivation,
): Promise<RuntimeFunctionActivationAck> {
  return requiredRuntimeActivationState({
    ref: activation.ref,
    slug: activation.slug,
    activationId: activation.authority.activation_id,
    action: "begin",
  }, ["fenced"]);
}

function assertPreheatFollowsFence(
  fence: RuntimeFunctionActivationAck,
  preheat: ValidatedEdgeRuntimePreheat,
): void {
  if (preheat.identity.runtimeInstanceId !== fence.runtimeInstanceId
    || preheat.foreground.generation !== fence.foregroundGeneration + 1
    || preheat.background.generation !== fence.backgroundGeneration + 1) {
    throw runtimeActivationFailure(
      "runtime instance or worker generation changed after activation fence",
    );
  }
}

async function preheatPreparedFunctionActivation(
  activation: PreparedFunctionActivation,
  fence: RuntimeFunctionActivationAck,
): Promise<EdgeFunctionPreheatResult | null> {
  if (activation.authority.target_state === "absent") return null;
  const requestedVersion = activation.nextConfig.version;
  if (!requestedVersion || !activation.artifactSha256) {
    throw new Error("Active Function activation is missing its immutable artifact identity");
  }
  const readiness = await preheatRuntimeFunction({
    projectRef: activation.ref,
    functionSlug: activation.slug,
    requestedVersion,
    resolvedVersion: requestedVersion,
    artifactSha256: activation.artifactSha256,
    verifyJwt: activation.nextConfig.verify_jwt,
    activationId: activation.authority.activation_id,
  });
  const attestation = requiredPreheatAttestation(readiness, "candidate readiness");
  assertPreheatFollowsFence(fence, attestation);
  return readiness.summary;
}

async function publishPreparedFunctionActivation(
  activation: PreparedFunctionActivation,
): Promise<void> {
  await replaceEdgeFunctionActivationManifest({
    manifestPath: getConfigPath(activation.ref, activation.slug),
    config: activationConfigRecord(activation.nextConfig),
    authority: activation.authority,
  });
}

async function currentManifestIsActivation(
  activation: PreparedFunctionActivation,
): Promise<boolean> {
  const current = await readFunctionManifestState(activation.ref, activation.slug);
  return current.authority?.activation_id === activation.authority.activation_id;
}

async function commitPreparedFunctionActivation(
  activation: PreparedFunctionActivation,
): Promise<void> {
  await requiredRuntimeActivationState({
    ref: activation.ref,
    slug: activation.slug,
    activationId: activation.authority.activation_id,
    action: "commit",
  }, ["committed"]);
}

async function abortPreparedFunctionActivation(
  activation: PreparedFunctionActivation,
): Promise<RuntimeFunctionActivationState> {
  const acknowledgement = await requiredRuntimeActivationState({
    ref: activation.ref,
    slug: activation.slug,
    activationId: activation.authority.activation_id,
    action: "abort",
  }, ["aborted", "committed"]);
  return acknowledgement.state;
}

async function commitFunctionActivation(
  commit: FunctionActivationCommit,
): Promise<{ config: EdgeFunctionConfigSnapshot; preheat: EdgeFunctionPreheatResult | null }> {
  const activation = await preparedFunctionActivation(commit);
  const fence = await beginPreparedFunctionActivation(activation);
  let preheat: EdgeFunctionPreheatResult | null = null;
  let published = false;
  try {
    preheat = await preheatPreparedFunctionActivation(activation, fence);
    try {
      await publishPreparedFunctionActivation(activation);
      published = true;
    } catch (error: unknown) {
      if (error instanceof EdgeFunctionActivationDurabilityError) throw error;
      published = await currentManifestIsActivation(activation);
      if (!published) throw error;
    }
    await commitPreparedFunctionActivation(activation);
  } catch (error: unknown) {
    if (error instanceof EdgeFunctionActivationDurabilityError) {
      throw runtimeActivationFailure("manifest durability is uncertain");
    }
    if (published || await currentManifestIsActivation(activation)) {
      await commitPreparedFunctionActivation(activation);
    } else {
      const state = await abortPreparedFunctionActivation(activation);
      if (state === "committed") await commitPreparedFunctionActivation(activation);
      else throw error;
    }
  }
  return {
    config: {
      ...activation.nextConfig,
      activation_id: activation.authority.activation_id,
    },
    preheat,
  };
}

function releaseResult(
  prepared: PreparedFunctionVersion,
  readiness: EdgeFunctionPreheatResult,
  functionConfig: EdgeFunctionConfigSnapshot,
  previousActiveVersion: EdgeFunctionActiveVersion,
): EdgeFunctionDeployResult {
  return {
    success: true,
    previous_active_version: previousActiveVersion,
    active_version: prepared.version,
    activation_id: functionConfig.activation_id,
    version: prepared.version,
    bundled: prepared.bundled,
    files: prepared.files,
    import_map: prepared.importMap,
    bundle_hash: prepared.bundleHash,
    bundle_size_bytes: prepared.bundleSizeBytes,
    import_count: prepared.importCount,
    content_path: prepared.contentPath,
    external_packages: resolveExternalPackages(),
    preheat: readiness,
    config: functionConfig,
  };
}

async function deployFunctionRelease(
  request: EdgeFunctionReleaseRequest,
  previousActiveVersion: EdgeFunctionActiveVersion,
  initialState: FunctionManifestState,
): Promise<EdgeFunctionDeployResult> {
  const currentState = await ensureCurrentRollbackSnapshot({
    ref: request.ref,
    slug: request.slug,
    currentState: initialState,
  });
  const version = await computeNextFunctionVersion(request.ref, request.slug);
  const release = await immutableFunctionVersion(request, version, currentState.config);
  const activation = await commitFunctionActivation({
    ref: request.ref,
    slug: request.slug,
    previousState: currentState,
    nextConfig: release.config,
    artifactSha256: release.prepared.artifactSha256,
  });
  if (!activation.preheat) {
    throw new Error("Active Function deployment did not produce a readiness attestation");
  }
  recordDeployMetrics(
    release.prepared.bundleSizeBytes,
    release.prepared.importCount,
    activation.preheat,
  );
  return releaseResult(
    release.prepared,
    activation.preheat,
    activation.config,
    previousActiveVersion,
  );
}

function failedDeployResult(
  request: EdgeFunctionReleaseRequest,
  error: unknown,
): EdgeFunctionDeployResult {
  logger.error("[EdgeFunction] Deploy failed", { ref: request.ref, slug: request.slug, error });
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function deployLatestFunctionRelease(
  request: EdgeFunctionReleaseRequest,
): Promise<EdgeFunctionDeployResult> {
  const releaseLock = await preflightAndAcquireFunctionDeployLock(request.ref, request.slug);
  try {
    const state = await readFunctionManifestState(request.ref, request.slug);
    await settleRuntimeFunctionActivation(request.ref, request.slug, state);
    const activeVersion = await activeVersionFromState(request.ref, request.slug, state);
    return await deployFunctionRelease(request, activeVersion, state);
  } catch (error) {
    return failedDeployResult(request, error);
  } finally {
    releaseLock();
  }
}

export const edgeFunctionService = {
  async getActiveVersion(ref: string, slug: string): Promise<EdgeFunctionActiveVersion> {
    return activeFunctionVersion(ref, slug);
  },

  /** Read function config (verify_jwt, etc.) */
  async getConfig(ref: string, slug: string): Promise<EdgeFunctionConfigSnapshot> {
    return functionConfigSnapshot(await readFunctionManifestState(ref, slug));
  },

  async getState(ref: string, slug: string): Promise<EdgeFunctionStateSnapshot> {
    const state = await readFunctionManifestState(ref, slug);
    return {
      config: functionConfigSnapshot(state),
      active_version: await activeVersionFromState(ref, slug, state),
    };
  },

  /** Update function config */
  async updateConfig(
    ref: string,
    slug: string,
    configPatch: Partial<EdgeFunctionConfig>,
    expectedActivationId: EdgeFunctionActivationId,
  ): Promise<EdgeFunctionConfigSnapshot> {
    const releaseLock = await preflightAndAcquireFunctionDeployLock(ref, slug);
    try {
      const expectedState = await assertExpectedActivationIdentity(
        ref,
        slug,
        expectedActivationId,
      );
      await settleRuntimeFunctionActivation(ref, slug, expectedState);
      const currentState = await ensureCurrentRollbackSnapshot({
        ref,
        slug,
        currentState: expectedState,
      });
      const merged = { ...currentState.config, ...configPatch };
      const activation = await commitFunctionActivation({
        ref,
        slug,
        previousState: currentState,
        nextConfig: merged,
        artifactSha256: await functionActivationArtifactSha256(ref, slug, currentState),
      });
      logger.info(
        `[EdgeFunction] Config updated for ${slug}@${ref}: verify_jwt=${merged.verify_jwt}, background_routes=${(merged.background_routes || []).length}`,
      );
      return activation.config;
    } finally {
      releaseLock();
    }
  },

  async deployRelease(request: EdgeFunctionDeploymentRequest): Promise<EdgeFunctionDeployResult> {
    const releaseLock = await preflightAndAcquireFunctionDeployLock(request.ref, request.slug);
    try {
      const expected = await assertExpectedFunctionState(
        request.ref,
        request.slug,
        request.expectedActiveVersion,
        request.expectedActivationId,
      );
      await settleRuntimeFunctionActivation(request.ref, request.slug, expected.state);
      const deployed = await deployFunctionRelease(
        request,
        expected.activeVersion,
        expected.state,
      );
      logger.info(
        `[EdgeFunction] Deployed ${request.slug} for ${request.ref} (version=${deployed.version}, verify_jwt=${deployed.config?.verify_jwt}, size=${deployed.bundle_size_bytes}, imports=${deployed.import_count})`,
      );
      return deployed;
    } catch (error) {
      if (error instanceof EdgeFunctionActiveVersionConflictError) {
        return {
          success: false,
          error_code: error.code,
          expected_active_version: error.expectedActiveVersion,
          expected_activation_id: error.expectedActivationId,
          active_version: error.activeVersion,
          activation_id: error.activationId,
          error: error.message,
        };
      }
      return failedDeployResult(request, error);
    } finally {
      releaseLock();
    }
  },

  /**
   * Deploy a single-file Edge Function.
   * The source code is preserved as .src.ts; a bundled .js is written for the runtime.
   */
  async deploy(
    ref: string,
    slug: string,
    code: string,
    minify: boolean = false,
  ): Promise<boolean> {
    const result = await this.deployDetailed(ref, slug, code, minify);
    return result.success;
  },

  async deployDetailed(
    ref: string,
    slug: string,
    code: string,
    minify: boolean = false,
  ): Promise<EdgeFunctionDeployResult> {
    return deployLatestFunctionRelease({ ref, slug, code, minify });
  },

  /**
   * Deploy a multi-file Edge Function bundle.
   * Writes all files to a subdirectory, then bundles from the entrypoint.
   *
   * @param files — Record<relativePath, sourceCode>, e.g.:
   *   { "index.ts": "...", "_shared/config.ts": "...", "_shared/cors.ts": "..." }
   * @param entrypoint — which file is the main entrypoint (default: "index.ts")
   */
  async deployBundle(
    ref: string,
    slug: string,
    files: Record<string, string>,
    entrypoint: string = "index.ts",
    minify: boolean = false,
  ): Promise<boolean> {
    const result = await this.deployBundleDetailed(
      ref,
      slug,
      files,
      entrypoint,
      minify,
    );
    return result.success;
  },

  async deployBundleDetailed(
    ref: string,
    slug: string,
    files: Record<string, string>,
    entrypoint: string = "index.ts",
    minify: boolean = false,
  ): Promise<EdgeFunctionDeployResult> {
    return deployLatestFunctionRelease({ ref, slug, files, entrypoint, minify });
  },

  async runtimeCheck(
    ref: string,
    slug: string,
  ): Promise<{
    runtime_url: string;
    active_version: string | null;
    active_artifact_path: string | null;
    artifact_exists: boolean;
    runtime_healthy: boolean;
    preheat_ok: boolean;
    preheat_status?: number;
    deploy_metrics: EdgeFunctionDeployMetrics;
    error?: string;
  }> {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const cfg = await this.getConfig(ref, slug);
    const activeVersion = cfg.version || null;
    const activeArtifactPath = activeVersion
      ? await getVersionedArtifactPath(ref, slug, activeVersion)
      : getFuncPath(ref, slug);
    const artifactExists = activeArtifactPath
      ? await fileExists(activeArtifactPath)
      : false;

    let runtimeHealthy = false;
    try {
      const healthRes = await fetch(`${runtimeUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      runtimeHealthy = healthRes.ok;
    } catch {
      runtimeHealthy = false;
    }

    try {
      if (!activeArtifactPath || !artifactExists) {
        throw new Error("Function artifact is unavailable for readiness attestation");
      }
      const readiness = await preheatRuntimeFunction({
        projectRef: ref,
        functionSlug: slug,
        requestedVersion: null,
        resolvedVersion: activeVersion,
        artifactSha256: await sha256Hex(await Bun.file(activeArtifactPath).text()),
        verifyJwt: cfg.verify_jwt,
        activationId: cfg.activation_id === EDGE_FUNCTION_LEGACY_ACTIVATION_ID
          ? null
          : cfg.activation_id,
      });
      return {
        runtime_url: runtimeUrl,
        active_version: activeVersion,
        active_artifact_path: activeArtifactPath,
        artifact_exists: artifactExists,
        runtime_healthy: runtimeHealthy,
        preheat_ok: readiness.summary.ok,
        preheat_status: readiness.summary.status,
        deploy_metrics: snapshotDeployMetrics(),
        ...(readiness.summary.error ? { error: readiness.summary.error } : {}),
      };
    } catch (err) {
      return {
        runtime_url: runtimeUrl,
        active_version: activeVersion,
        active_artifact_path: activeArtifactPath,
        artifact_exists: artifactExists,
        runtime_healthy: runtimeHealthy,
        preheat_ok: false,
        deploy_metrics: snapshotDeployMetrics(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  deployMetrics(): EdgeFunctionDeployMetrics {
    return snapshotDeployMetrics();
  },

  /** Read function bundled code (runtime version) */
  async read(ref: string, slug: string): Promise<string | null> {
    const state = await readFunctionManifestState(ref, slug);
    if (state.authority?.target_state === "absent") return null;
    if (state.config.version !== undefined) {
      const versioned = await readVersionedFunctionCode(ref, slug, state.config.version);
      if (versioned === null) throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
      return versioned;
    }
    return readOptionalFunctionFile(getFuncPath(ref, slug));
  },

  /** Read function original source (for debugging) */
  async readSource(ref: string, slug: string): Promise<string | null> {
    const state = await readFunctionManifestState(ref, slug);
    if (state.authority?.target_state === "absent") return null;
    if (state.config.version !== undefined) {
      return readVersionedFunctionSource(
        ref,
        slug,
        state.config.version,
        state.config.entrypoint,
      );
    }
    return readOptionalFunctionFile(getSrcPath(ref, slug));
  },

  async listVersions(ref: string, slug: string): Promise<EdgeFunctionVersionRecord[]> {
    const cfg = await this.getConfig(ref, slug);
    const activeVersion = cfg.version ?? null;
    const versions = await listVersionDirectories(ref, slug);

    const records = await Promise.all(
      versions.map(async (version) => {
        const versionDir = getFunctionVersionDir(ref, slug, version);
        const bundlePath = await getVersionedArtifactPath(ref, slug, version);
        const sourcePath = getVersionedSrcPath(ref, slug, version);
        const sourceDirPath = assertInside(versionDir, path.join(versionDir, "src"));
        const [hasBundle, hasSource, hasSourceDir] = await Promise.all([
          bundlePath ? fileExists(bundlePath) : Promise.resolve(false),
          fileExists(sourcePath),
          fileExists(sourceDirPath),
        ]);

        const updatedAt =
          (await statIso(bundlePath)) ||
          (await statIso(sourcePath)) ||
          (await statIso(sourceDirPath)) ||
          new Date().toISOString();

        const createdAt = updatedAt;

        return {
          version,
          is_active: version === activeVersion,
          created_at: createdAt,
          updated_at: updatedAt,
          bundle_path: hasBundle ? bundlePath : null,
          source_path: hasSource ? sourcePath : null,
          source_dir_path: hasSourceDir ? sourceDirPath : null,
          has_bundle: hasBundle,
          has_source: hasSource,
          has_source_dir: hasSourceDir,
        } satisfies EdgeFunctionVersionRecord;
      }),
    );

    if (activeVersion !== null) {
      const activeRecord = records.find((record) => record.version === activeVersion);
      if (!activeRecord?.has_bundle) {
        throw new Error(EDGE_FUNCTION_ACTIVE_ARTIFACT_MISSING_MESSAGE);
      }
    }

    return records.sort(
      (a, b) => Number.parseInt(b.version, 10) - Number.parseInt(a.version, 10),
    );
  },

  async getVersion(
    ref: string,
    slug: string,
    version: string,
  ): Promise<EdgeFunctionVersionDetail | null> {
    const versions = await this.listVersions(ref, slug);
    const record = versions.find((item) => item.version === version);
    if (!record) return null;

    const [bundleCode, sourceCode] = await Promise.all([
      record.has_bundle ? readVersionedFunctionCode(ref, slug, version) : Promise.resolve(null),
      record.has_source ? readVersionedFunctionSource(ref, slug, version) : Promise.resolve(null),
    ]);

    return {
      ...record,
      bundle_code: bundleCode,
      source_code: sourceCode,
    };
  },

  async activateVersion(
    ref: string,
    slug: string,
    version: string,
    expectedActiveVersion: EdgeFunctionActiveVersion,
    expectedActivationId: EdgeFunctionActivationId,
  ): Promise<EdgeFunctionActivationResult | null> {
    const releaseLock = await preflightAndAcquireFunctionDeployLock(ref, slug);
    try {
      const expected = await assertExpectedFunctionState(
        ref,
        slug,
        expectedActiveVersion,
        expectedActivationId,
      );
      await settleRuntimeFunctionActivation(ref, slug, expected.state);
      const detail = await this.getVersion(ref, slug, version);
      if (!detail || !detail.has_bundle) return null;
      if (detail.bundle_code === null) {
        throw new Error("Function version artifact is unavailable for readiness attestation");
      }

      const versionMetadata = await readFunctionVersionMetadata(ref, slug, version);
      const updated = restoredFunctionConfig(expected.state.config, versionMetadata);
      const artifactSha256 = await sha256Hex(detail.bundle_code);
      if (artifactSha256 !== versionMetadata.artifact_sha256) {
        throw new Error("Function version artifact does not match its immutable metadata");
      }
      const activation = await commitFunctionActivation({
        ref,
        slug,
        previousState: expected.state,
        nextConfig: updated,
        artifactSha256,
      });
      logger.info(`[EdgeFunction] Activated version ${version} for ${slug}@${ref}`);
      return {
        previous_active_version: expected.activeVersion,
        active_version: version,
        activation_id: activation.config.activation_id,
        config: activation.config,
      };
    } finally {
      releaseLock();
    }
  },

  /** List active function slugs for a project */
  async list(ref: string): Promise<string[]> {
    const dir = getFuncDir(ref);
    const { Glob } = await import("bun");
    const glob = new Glob("*.js");
    let entries: string[];
    try {
      entries = Array.from(glob.scanSync({ cwd: dir, onlyFiles: true }));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const slugs = new Set<string>();
    for (const entry of entries) {
      if (parseLegacyVersionedFile(entry)) continue;
      slugs.add(entry.replace(/\.js$/, ""));
    }

    const versionsRoot = path.join(dir, VERSIONED_DIR);
    const versionedEntries = await fs.readdir(versionsRoot, { withFileTypes: true })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    for (const entry of versionedEntries) {
      if (entry.isDirectory()) slugs.add(entry.name);
    }

    const activeSlugs = await Promise.all(Array.from(slugs, async (slug) =>
      await activeFunctionVersion(ref, slug) === EDGE_FUNCTION_ABSENT_ACTIVE_VERSION
        ? null
        : slug
    ));
    return activeSlugs.filter((slug): slug is string => slug !== null).sort();
  },

  /** Delete a function (both bundled and source) */
  async remove(
    ref: string,
    slug: string,
    expectedActivationId: EdgeFunctionActivationId,
  ): Promise<EdgeFunctionActivationResult> {
    const releaseLock = await preflightAndAcquireFunctionDeployLock(ref, slug);
    try {
      const currentState = await assertExpectedActivationIdentity(
        ref,
        slug,
        expectedActivationId,
      );
      await settleRuntimeFunctionActivation(ref, slug, currentState);
      const previousActiveVersion = await activeVersionFromState(ref, slug, currentState);
      const activation = await commitFunctionActivation({
        ref,
        slug,
        previousState: currentState,
        nextConfig: { ...DEFAULT_FUNCTION_CONFIG },
        artifactSha256: null,
      });
      await removeFunctionArtifacts(ref, slug).catch((error: unknown) => {
        logger.warn("[EdgeFunction] Deleted Function left inactive artifacts for cleanup", {
          ref,
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info(`[EdgeFunction] Deleted ${slug} for ${ref}`);
      return {
        previous_active_version: previousActiveVersion,
        active_version: EDGE_FUNCTION_ABSENT_ACTIVE_VERSION,
        activation_id: activation.config.activation_id,
        config: activation.config,
      };
    } finally {
      releaseLock();
    }
  },

  async getLogs(
    ref: string,
    slug: string,
    limit: number = 50,
    offset: number = 0,
    version?: string | null,
  ): Promise<
    Array<{
      id: string;
      timestamp: string;
      event_type: string;
      severity: string;
      message: string;
      metadata: Record<string, unknown>;
    }>
  > {
    try {
      const logDir = path.join(getFunctionsRoot(), ref, ".logs");
      await fs.mkdir(logDir, { recursive: true }).catch(() => {});
      const logFile = path.join(logDir, `${slug}.log`);
      const content = await Bun.file(logFile)
        .text()
        .catch(() => "");
      if (!content) return [];
      const lines = content.trim().split("\n").filter(Boolean);
      const parsed = lines.map((line, idx) => {
        try {
          return JSON.parse(line);
        } catch {
          return {
            id: String(idx),
            timestamp: new Date().toISOString(),
            event_type: "log",
            severity: "info",
            message: line,
            metadata: {},
          };
        }
      });
      const filtered = version
        ? parsed.filter((entry) => entry?.metadata?.function_version === version)
        : parsed;
      return filtered.slice(offset, offset + limit);
    } catch {
      return [];
    }
  },
};

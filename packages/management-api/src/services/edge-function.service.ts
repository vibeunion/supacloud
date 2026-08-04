import { logger } from "../utils/logger";
import { config } from "../config";
import { ServiceUnavailableError } from "../utils/errors";
import path from "path";
import fs from "fs/promises";

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
  config?: EdgeFunctionConfig;
  error?: string;
}

export type EdgeFunctionDeploymentConfig = Pick<
  Partial<EdgeFunctionConfig>,
  "verify_jwt" | "background_routes"
>;

export type EdgeFunctionDeploymentRequest = {
  ref: string;
  slug: string;
  minify?: boolean;
  config?: EdgeFunctionDeploymentConfig;
} & (
  | { code: string; files?: never; entrypoint?: never }
  | { files: Record<string, string>; entrypoint?: string; code?: never }
);

export interface EdgeFunctionPreheatPoolResult {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
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
const functionDeployLocks = new Map<string, Promise<void>>();
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

type BuildMetafileImport = {
  path?: string;
  original?: string;
  kind?: string;
  external?: boolean;
};

type BuildMetafile = {
  inputs?: Record<string, {
    bytes?: number;
    imports?: BuildMetafileImport[];
  }>;
  outputs?: Record<string, {
    bytes?: number;
    imports?: BuildMetafileImport[];
  }>;
};

type BundleFunctionResult = {
  code: string;
  sizeBytes: number;
  importCount: number;
  metafile: BuildMetafile | null;
};

type EdgeFunctionRuntimeControlResult = {
  ok: boolean;
  status?: number;
  error?: string;
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

async function acquireFunctionDeployLock(
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

function getFuncPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.js`));
}

function getVersionedFuncPath(ref: string, slug: string, version: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version, "index.js"));
}

function getSrcPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.src.ts`));
}

function getVersionedSrcPath(ref: string, slug: string, version: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version, "index.src.ts"));
}

function getConfigPath(ref: string, slug: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), `${validateSlug(slug)}.config.json`));
}

function getVersionRoot(ref: string, slug: string): string {
  const dir = getFuncDir(ref);
  return assertInside(dir, path.join(dir, VERSIONED_DIR, validateSlug(slug)));
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

async function readFunctionConfig(ref: string, slug: string): Promise<EdgeFunctionConfig> {
  try {
    const raw = await Bun.file(getConfigPath(ref, slug)).text();
    return { ...DEFAULT_FUNCTION_CONFIG, ...JSON.parse(raw) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...DEFAULT_FUNCTION_CONFIG };
  }
}

async function functionConfigExists(ref: string, slug: string): Promise<boolean> {
  try {
    await fs.access(getConfigPath(ref, slug));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function writeFunctionConfigManifest(
  ref: string,
  slug: string,
  functionConfig: EdgeFunctionConfig,
): Promise<void> {
  const dir = getFuncDir(ref);
  const configPath = getConfigPath(ref, slug);
  const pendingPath = assertInside(
    dir,
    path.join(dir, `.${validateSlug(slug)}.config.${crypto.randomUUID()}.tmp`),
  );
  await fs.mkdir(dir, { recursive: true });
  try {
    await Bun.write(pendingPath, JSON.stringify(functionConfig, null, 2));
    await fs.rename(pendingPath, configPath);
  } finally {
    await fs.rm(pendingPath, { force: true }).catch(() => {});
  }
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
  // Accept any non-empty code - Bun.build() will validate syntax
  return { valid: true };
}

/**
 * Bundle a TypeScript entrypoint into a single self-contained .js file using Bun.build().
 * Returns the bundled code string, or null on failure.
 */
async function bundleFunction(
  entrypoint: string,
  outdir: string,
  outName: string,
  minify: boolean = false,
  importMapPath?: string,
): Promise<BundleFunctionResult | null> {
  try {
    const buildOptions: Parameters<typeof Bun.build>[0] & {
      importMap?: string;
      metafile?: boolean;
    } = {
      entrypoints: [entrypoint],
      outdir,
      naming: `${outName}.[ext]`,
      target: "bun",
      minify,
      external: resolveExternalPackages(),
      metafile: true,
    };
    if (importMapPath) {
      buildOptions.importMap = importMapPath;
    }
    const result = await Bun.build(buildOptions);

    if (!result.success) {
      const messages = result.logs
        .map((l: { message?: string }) => l.message || String(l))
        .join("\n");
      logger.error(`[EdgeFunction] Bun.build() failed:\n${messages}`);
      return null;
    }

    const artifact = result.outputs.find((output) => output.kind === "entry-point") ?? result.outputs[0];
    if (!artifact) {
      logger.error(`[EdgeFunction] Bun.build() produced no output`, { entrypoint });
      return null;
    }

    const code = await artifact.text();
    const metafile = normalizeBuildMetafile((result as { metafile?: unknown }).metafile);
    return {
      code,
      sizeBytes: typeof artifact.size === "number" ? artifact.size : bundleSizeBytes(code),
      importCount: countMetafileImports(metafile) ?? countImports(code),
      metafile,
    };
  } catch (err) {
    logger.error(`[EdgeFunction] Bundle error`, { error: err });
    return null;
  }
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

function normalizeBuildMetafile(value: unknown): BuildMetafile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as BuildMetafile;
  return {
    inputs: record.inputs && typeof record.inputs === "object" ? record.inputs : undefined,
    outputs: record.outputs && typeof record.outputs === "object" ? record.outputs : undefined,
  };
}

function countMetafileImports(metafile: BuildMetafile | null): number | null {
  if (!metafile?.inputs) return null;
  const specs = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const importEntry of input.imports || []) {
      const specifier = importEntry.original || importEntry.path;
      if (specifier) specs.add(specifier);
    }
  }
  return specs.size;
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

function countImports(code: string): number {
  const specs = new Set<string>();
  for (const match of code.matchAll(/\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g)) {
    specs.add(match[1]);
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.add(match[1]);
  }
  for (const match of code.matchAll(/\bexport\s+[^"'()]*?\s+from\s+["']([^"']+)["']/g)) {
    specs.add(match[1]);
  }
  return specs.size;
}

function countFileImports(files: Record<string, string>): number {
  const specs = new Set<string>();
  for (const code of Object.values(files)) {
    for (const match of code.matchAll(/\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g)) {
      specs.add(match[1]);
    }
    for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      specs.add(match[1]);
    }
    for (const match of code.matchAll(/\bexport\s+[^"'()]*?\s+from\s+["']([^"']+)["']/g)) {
      specs.add(match[1]);
    }
  }
  return specs.size;
}

type PreparedFunctionVersion = {
  version: string;
  bundled: boolean;
  files?: number;
  entrypoint: string | null;
  importMap: string | null;
  bundleHash: string;
  bundleSizeBytes: number;
  importCount: number;
  contentPath: string;
};

type FunctionVersionMetadata = {
  version: string;
  verify_jwt: boolean;
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
  currentConfig: EdgeFunctionConfig;
  hadManifest: boolean;
};

async function writePreparedBundle(
  stageDir: string,
  finalDir: string,
  code: string,
  artifactSizeBytes?: number,
): Promise<Pick<PreparedFunctionVersion, "bundleHash" | "bundleSizeBytes" | "contentPath">> {
  const bundleHash = (await sha256Hex(code)).slice(0, 16);
  const sizeBytes = artifactSizeBytes ?? bundleSizeBytes(code);
  await Bun.write(path.join(stageDir, "index.js"), code);
  await Bun.write(path.join(stageDir, `index.${bundleHash}.js`), code);
  return {
    bundleHash,
    bundleSizeBytes: sizeBytes,
    contentPath: path.join(finalDir, `index.${bundleHash}.js`),
  };
}

async function prepareSingleFunctionVersion(
  request: EdgeFunctionDeploymentRequest & { code: string },
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  const validation = validateFunctionCode(request.code);
  if (!validation.valid) throw new Error(validation.error);
  await fs.mkdir(stageDir, { recursive: true });
  const sourcePath = path.join(stageDir, "index.src.ts");
  const buildDir = path.join(stageDir, ".build");
  await Bun.write(sourcePath, request.code);
  const bundle = await bundleFunction(sourcePath, buildDir, "index", request.minify ?? false);
  const deployedCode = bundle?.code ?? request.code;
  const artifact = await writePreparedBundle(stageDir, finalDir, deployedCode, bundle?.sizeBytes);
  await fs.rm(buildDir, { recursive: true, force: true });
  return {
    version,
    bundled: bundle !== null,
    entrypoint: null,
    importMap: null,
    importCount: bundle?.importCount ?? countImports(request.code),
    ...artifact,
  };
}

async function detectedImportMap(sourceDir: string): Promise<string | null> {
  for (const candidate of ["import_map.json", "import_map", "deno.json", "deno.jsonc"]) {
    if (await fileExists(resolveInside(sourceDir, candidate))) return candidate;
  }
  return null;
}

function validatedBundleEntrypoint(
  request: EdgeFunctionDeploymentRequest & { files: Record<string, string> },
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
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, content);
  }
}

async function prepareBundleFunctionVersion(
  request: EdgeFunctionDeploymentRequest & { files: Record<string, string> },
  version: string,
  stageDir: string,
  finalDir: string,
): Promise<PreparedFunctionVersion> {
  const entrypoint = validatedBundleEntrypoint(request);
  const sourceDir = path.join(stageDir, "src");
  await writeBundleSources(sourceDir, request.files);
  const importMap = await detectedImportMap(sourceDir);
  const buildDir = path.join(stageDir, ".build");
  const bundle = await bundleFunction(
    resolveInside(sourceDir, entrypoint),
    buildDir,
    "index",
    request.minify ?? false,
    importMap ? resolveInside(sourceDir, importMap) : undefined,
  );
  if (!bundle) throw new Error("Bun.build() failed while bundling the function");
  await Bun.write(path.join(sourceDir, BUNDLED_SOURCE_RUNTIME_ENTRY), bundle.code);
  const artifact = await writePreparedBundle(stageDir, finalDir, bundle.code, bundle.sizeBytes);
  await fs.rm(buildDir, { recursive: true, force: true });
  return {
    version,
    bundled: true,
    files: Object.keys(request.files).length,
    entrypoint,
    importMap,
    importCount: bundle.importCount ?? countFileImports(request.files),
    ...artifact,
  };
}

function functionVersionMetadata(
  version: string,
  functionConfig: EdgeFunctionConfig,
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
    background_routes: backgroundRoutes,
    import_map: functionConfig.import_map ?? null,
    entrypoint: functionConfig.entrypoint ?? null,
  };
}

async function writeFunctionVersionMetadata(
  stageDir: string,
  metadata: FunctionVersionMetadata,
): Promise<void> {
  await Bun.write(
    path.join(stageDir, FUNCTION_VERSION_METADATA_FILE),
    JSON.stringify(metadata, null, 2),
  );
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
  const versionDir = assertInside(getVersionRoot(ref, slug), path.join(getVersionRoot(ref, slug), version));
  const metadataPath = path.join(versionDir, FUNCTION_VERSION_METADATA_FILE);
  const metadataRecord = JSON.parse(await Bun.file(metadataPath).text()) as Record<string, unknown>;
  if (!metadataRecord || typeof metadataRecord !== "object" || Array.isArray(metadataRecord)) {
    throw new Error("Function version metadata must be an object");
  }
  if (metadataRecord.version !== version || typeof metadataRecord.verify_jwt !== "boolean") {
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
  const versionDir = assertInside(getVersionRoot(ref, slug), path.join(getVersionRoot(ref, slug), version));
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
  await replaceFunctionVersionMetadata(
    versionDir,
    functionVersionMetadata(version, sourceConfig),
  );
}

async function snapshotFrozenLegacyVersion(
  snapshot: LegacyVersionSnapshotRequest,
): Promise<EdgeFunctionConfig> {
  const versionRoot = getVersionRoot(snapshot.ref, snapshot.slug);
  const finalDir = assertInside(versionRoot, path.join(versionRoot, snapshot.version));
  if (await fileExists(finalDir)) {
    return completeFrozenLegacyVersionSnapshot(snapshot, finalDir);
  }
  const stageDir = assertInside(
    versionRoot,
    path.join(versionRoot, `.pending-legacy-${snapshot.version}-${crypto.randomUUID()}`),
  );
  await fs.mkdir(stageDir, { recursive: true });
  try {
    const runtimeCode = await Bun.file(snapshot.runtimePath).text();
    await writePreparedBundle(stageDir, finalDir, runtimeCode);
    await copyFrozenLegacySource(snapshot.ref, snapshot.slug, stageDir);
    const snapshotConfig = await sourceMetadataConfig(
      snapshot.functionConfig,
      snapshot.version,
      stageDir,
    );
    await writeFunctionVersionMetadata(
      stageDir,
      functionVersionMetadata(snapshot.version, snapshotConfig),
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
  await fs.mkdir(pendingDir, { recursive: true });
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
      functionVersionMetadata(snapshot.version, snapshotConfig),
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
  legacyRuntimePath: string | null,
): Promise<EdgeFunctionConfig> {
  const version = currentConfig.version!;
  if (parseVersionNumber(version) === null) {
    throw new Error("Function config contains an invalid version");
  }
  if (await getVersionedArtifactPath(ref, slug, version)) {
    await backfillActiveVersionMetadata(ref, slug, version, currentConfig);
    return currentConfig;
  }
  if (!legacyRuntimePath) {
    throw new Error("Active function version artifact is missing and no frozen legacy alias exists");
  }
  return snapshotFrozenLegacyVersion({
    ref,
    slug,
    version,
    functionConfig: currentConfig,
    runtimePath: legacyRuntimePath,
  });
}

async function ensureLegacyVersionZeroSnapshot(
  snapshot: CurrentRollbackSnapshotRequest,
  legacyRuntimePath: string,
): Promise<EdgeFunctionConfig> {
  const versionZeroArtifact = await getVersionedArtifactPath(snapshot.ref, snapshot.slug, "0");
  const versionZeroConfig = versionZeroArtifact
    ? await sourceMetadataConfig(
        snapshot.currentConfig,
        "0",
        path.join(getVersionRoot(snapshot.ref, snapshot.slug), "0"),
      )
    : await snapshotFrozenLegacyVersion({
        ref: snapshot.ref,
        slug: snapshot.slug,
        version: "0",
        functionConfig: snapshot.currentConfig,
        runtimePath: legacyRuntimePath,
      });
  if (versionZeroArtifact) {
    await replaceFunctionVersionMetadata(
      path.join(getVersionRoot(snapshot.ref, snapshot.slug), "0"),
      functionVersionMetadata("0", versionZeroConfig),
    );
  }
  await commitFunctionActivation({
    ref: snapshot.ref,
    slug: snapshot.slug,
    previousConfig: snapshot.currentConfig,
    hadManifest: snapshot.hadManifest,
    nextConfig: versionZeroConfig,
  });
  return versionZeroConfig;
}

async function ensureCurrentRollbackSnapshot(
  snapshot: CurrentRollbackSnapshotRequest,
): Promise<EdgeFunctionConfig> {
  const legacyRuntimePath = await frozenLegacyRuntimePath(snapshot.ref, snapshot.slug);
  if (snapshot.currentConfig.version) {
    return ensureConfiguredRollbackSnapshot(
      snapshot.ref,
      snapshot.slug,
      snapshot.currentConfig,
      legacyRuntimePath,
    );
  }
  if (!legacyRuntimePath) return snapshot.currentConfig;
  return ensureLegacyVersionZeroSnapshot(snapshot, legacyRuntimePath);
}

function normalizePreheatPool(value: unknown): EdgeFunctionPreheatPoolResult {
  if (!value || typeof value !== "object") {
    return { attempted: 0, succeeded: 0, cacheHits: 0, cacheMisses: 0, durationMs: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    attempted: Number(record.attempted) || 0,
    succeeded: Number(record.succeeded) || 0,
    cacheHits: Number(record.cacheHits) || 0,
    cacheMisses: Number(record.cacheMisses) || 0,
    durationMs: Number(record.durationMs) || 0,
  };
}

async function readRuntimeControlBody(response: Response): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  if (!bodyText) return {};
  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function preheatAcknowledgementError(
  body: Record<string, unknown>,
  requestedVersion?: string,
): string | undefined {
  if (requestedVersion === undefined) {
    return body.success === false ? "Edge Runtime reported preheat failure" : undefined;
  }
  if (body.success !== true) {
    return "Edge Runtime did not report successful version readiness";
  }
  if (body.version !== requestedVersion) {
    return "Edge Runtime did not confirm the requested function version";
  }
  return undefined;
}

async function preheatRuntimeFunction(
  ref: string,
  slug: string,
  requestedVersion?: string,
): Promise<EdgeFunctionPreheatResult> {
  const start = performance.now();
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const headers = runtimeInternalHeaders();
    if (requestedVersion) {
      headers["x-supacloud-function-version"] = requestedVersion;
    }
    const preheatRes = await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const durationMs = Math.round(performance.now() - start);
    const bodyRecord = await readRuntimeControlBody(preheatRes);
    const foreground = normalizePreheatPool(bodyRecord.foreground);
    const background = normalizePreheatPool(bodyRecord.background);
    const acknowledgementError = preheatAcknowledgementError(bodyRecord, requestedVersion);
    return {
      ok: preheatRes.ok && acknowledgementError === undefined,
      status: preheatRes.status,
      duration_ms: durationMs,
      attempted: foreground.attempted + background.attempted,
      succeeded: foreground.succeeded + background.succeeded,
      cache_hits: foreground.cacheHits + background.cacheHits,
      cache_misses: foreground.cacheMisses + background.cacheMisses,
      foreground,
      background,
      error: acknowledgementError,
    };
  } catch (error) {
    return {
      ok: false,
      duration_ms: Math.round(performance.now() - start),
      attempted: 0,
      succeeded: 0,
      cache_hits: 0,
      cache_misses: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clear module caches so Worker threads pick up the new version.
 */
function runtimeInternalHeaders(): Record<string, string> {
  return { "x-supacloud-internal-auth": config.edgeRuntimeMasterKey || config.masterToken };
}

function isRuntimeInvalidationPoolAck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pool = value as Record<string, unknown>;
  if (![pool.attempted, pool.succeeded, pool.invalidated].every(
    (metric) => Number.isSafeInteger(metric) && Number(metric) >= 0,
  )) return false;
  return pool.succeeded === pool.attempted;
}

function runtimeInvalidationAckError(
  body: Record<string, unknown>,
  expectedFunctionId: string,
): string | undefined {
  if (body.invalidated !== expectedFunctionId) {
    return "Edge Runtime did not confirm the invalidation target";
  }
  if (body.success !== undefined && body.success !== true) {
    return "Edge Runtime reported invalidation failure";
  }
  if (body.config_cache_evicted !== true) {
    return "Edge Runtime did not confirm function config eviction";
  }
  if (body.module_scope !== "legacy-base-only" || body.immutable_versions_retained !== true) {
    return "Edge Runtime returned an unsafe module invalidation scope";
  }
  if (!isRuntimeInvalidationPoolAck(body.foreground)
    || !isRuntimeInvalidationPoolAck(body.background)) {
    return "Edge Runtime returned an invalid invalidation acknowledgement";
  }
  return undefined;
}

async function invalidateRuntimeFunction(
  ref: string,
  slug: string,
): Promise<EdgeFunctionRuntimeControlResult> {
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const res = await fetch(`${runtimeUrl}/invalidate/${ref}/${slug}`, {
      method: "POST",
      headers: runtimeInternalHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    const bodyRecord = await readRuntimeControlBody(res);
    const acknowledgementError = runtimeInvalidationAckError(
      bodyRecord,
      `${ref}_${slug}`,
    );
    return {
      ok: res.ok && acknowledgementError === undefined,
      status: res.status,
      error: acknowledgementError,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function invalidateCache(
  ref: string,
  slug: string,
): Promise<EdgeFunctionRuntimeControlResult> {
  // 1. Clear the transform file cache
  const cacheDir = path.join(getFunctionsRoot(), ".cache", ref);
  for (const ext of [".ts", ".js"]) {
    try {
      await fs.unlink(path.join(cacheDir, `${slug}${ext}`));
    } catch {
      /* may not exist */
    }
  }

  // 2. Notify Edge Runtime to evict the module from Worker thread caches
  const result = await invalidateRuntimeFunction(ref, slug);
  if (!result.ok) {
    logger.warn(`[EdgeFunction] Runtime invalidate failed`, {
      ref,
      slug,
      status: result.status,
      error: result.error,
    });
  }
  return result;
}

function requireRuntimeControl(
  control: EdgeFunctionRuntimeControlResult,
  operation: string,
): void {
  if (control.ok) return;
  const status = control.status ? ` (HTTP ${control.status})` : "";
  throw new ServiceUnavailableError(
    "Edge Runtime function activation",
    `${operation}${status}: ${control.error || "control request failed"}`,
  );
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
  const candidate = assertInside(
    getFuncDir(ref),
    path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), String(version)),
  );
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
  const versionRoot = path.join(getVersionRoot(ref, slug), version);
  const candidates = [
    getVersionedSrcPath(ref, slug, version),
    resolveInside(path.join(versionRoot, "src"), entrypoint),
    path.join(versionRoot, "src", BUNDLED_SOURCE_RUNTIME_ENTRY),
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
  const dir = assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version));
  try {
    const entries = await fs.readdir(dir);
    const contentAddressed = entries
      .filter((entry) => /^index\.[a-f0-9]{16}\.js$/.test(entry))
      .sort()
      .at(0);
    if (contentAddressed) return assertInside(dir, path.join(dir, contentAddressed));
  } catch {
    // Fall back to the compatibility index.js artifact below.
  }
  const modern = getVersionedFuncPath(ref, slug, version);
  if (await fileExists(modern)) return modern;
  return null;
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

async function directoryEntries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
    getConfigPath(ref, safeSlug),
    getLegacySourceDir(ref, safeSlug),
    getVersionRoot(ref, safeSlug),
    ...legacyArtifacts.map((entry) => resolveInside(dir, entry)),
  ];
  await Promise.all(exactTargets.map((target) =>
    fs.rm(target, { recursive: true, force: true })
  ));
}

export async function migrateLegacyVersionArtifacts(): Promise<{ moved: number }> {
  let moved = 0;
  const projectDirs = await fs.readdir(getFunctionsRoot(), { withFileTypes: true }).catch(() => []);

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() || projectDir.name === ".cache") continue;

    const ref = projectDir.name;
    const dir = getFuncDir(ref);
    const entries = await fs.readdir(dir).catch(() => []);

    for (const entry of entries) {
      const parsed = parseLegacyVersionedFile(entry);
      if (parsed) {
        const sourcePath = resolveInside(dir, entry);
        const targetPath = parsed.kind === "js"
          ? getVersionedFuncPath(ref, parsed.slug, parsed.version)
          : getVersionedSrcPath(ref, parsed.slug, parsed.version);

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rm(targetPath, { force: true }).catch(() => {});
        await fs.rename(sourcePath, targetPath);
        moved += 1;
        continue;
      }

      const parsedSourceDir = parseLegacyVersionedSourceDir(entry);
      if (!parsedSourceDir) continue;

      const sourceDir = resolveInside(dir, entry);
      const targetDir = assertInside(dir, path.join(
        dir,
        VERSIONED_DIR,
        validateSlug(parsedSourceDir.slug),
        parsedSourceDir.version,
        "src",
      ));

      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(sourceDir, targetDir);
      moved += 1;
    }
  }

  return { moved };
}

async function immutableFunctionVersion(
  request: EdgeFunctionDeploymentRequest,
  version: string,
  currentConfig: EdgeFunctionConfig,
): Promise<PreparedFunctionRelease> {
  const versionRoot = getVersionRoot(request.ref, request.slug);
  const finalDir = assertInside(versionRoot, path.join(versionRoot, version));
  const stageDir = assertInside(
    versionRoot,
    path.join(versionRoot, `.pending-${version}-${crypto.randomUUID()}`),
  );
  await fs.mkdir(versionRoot, { recursive: true });
  try {
    const prepared = request.code !== undefined
      ? await prepareSingleFunctionVersion(request, version, stageDir, finalDir)
      : await prepareBundleFunctionVersion(request, version, stageDir, finalDir);
    const functionConfig = activatedFunctionConfig(currentConfig, request.config, prepared);
    await writeFunctionVersionMetadata(
      stageDir,
      functionVersionMetadata(version, functionConfig),
    );
    await fs.rename(stageDir, finalDir);
    return { prepared, config: functionConfig };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
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
  previousConfig: EdgeFunctionConfig;
  hadManifest: boolean;
  nextConfig: EdgeFunctionConfig;
};

async function restoreFunctionManifest(commit: FunctionActivationCommit): Promise<void> {
  if (commit.hadManifest) {
    await writeFunctionConfigManifest(commit.ref, commit.slug, commit.previousConfig);
  } else {
    await fs.rm(getConfigPath(commit.ref, commit.slug), { force: true });
  }
}

async function commitFunctionActivation(commit: FunctionActivationCommit): Promise<void> {
  await writeFunctionConfigManifest(commit.ref, commit.slug, commit.nextConfig);
  const invalidation = await invalidateCache(commit.ref, commit.slug);
  if (invalidation.ok) return;
  await restoreFunctionManifest(commit);
  const rollbackInvalidation = await invalidateCache(commit.ref, commit.slug);
  if (!rollbackInvalidation.ok) {
    const status = rollbackInvalidation.status ? `HTTP ${rollbackInvalidation.status}: ` : "";
    throw new ServiceUnavailableError(
      "Edge Runtime function activation",
      `activation manifest was restored but runtime state is uncertain; rollback invalidation failed (${status}${rollbackInvalidation.error || "control request failed"})`,
    );
  }
  requireRuntimeControl(invalidation, "cache invalidation");
}

function releaseResult(
  prepared: PreparedFunctionVersion,
  readiness: EdgeFunctionPreheatResult,
  functionConfig: EdgeFunctionConfig,
): EdgeFunctionDeployResult {
  return {
    success: true,
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
  request: EdgeFunctionDeploymentRequest,
): Promise<EdgeFunctionDeployResult> {
  let currentConfig = await readFunctionConfig(request.ref, request.slug);
  const hadManifest = await functionConfigExists(request.ref, request.slug);
  currentConfig = await ensureCurrentRollbackSnapshot({
    ref: request.ref,
    slug: request.slug,
    currentConfig,
    hadManifest,
  });
  const version = await computeNextFunctionVersion(request.ref, request.slug);
  const release = await immutableFunctionVersion(request, version, currentConfig);
  const readiness = await preheatRuntimeFunction(request.ref, request.slug, version);
  requireRuntimeControl(readiness, "version readiness");

  await commitFunctionActivation({
    ref: request.ref,
    slug: request.slug,
    previousConfig: currentConfig,
    hadManifest: hadManifest || currentConfig.version === "0",
    nextConfig: release.config,
  });
  recordDeployMetrics(release.prepared.bundleSizeBytes, release.prepared.importCount, readiness);
  return releaseResult(release.prepared, readiness, release.config);
}

export const edgeFunctionService = {
  /** Read function config (verify_jwt, etc.) */
  async getConfig(ref: string, slug: string): Promise<EdgeFunctionConfig> {
    return readFunctionConfig(ref, slug);
  },

  /** Update function config */
  async updateConfig(
    ref: string,
    slug: string,
    configPatch: Partial<EdgeFunctionConfig>,
  ): Promise<EdgeFunctionConfig> {
    const releaseLock = await acquireFunctionDeployLock(ref, slug);
    try {
      const currentConfig = await readFunctionConfig(ref, slug);
      const merged = { ...currentConfig, ...configPatch };
      await commitFunctionActivation({
        ref,
        slug,
        previousConfig: currentConfig,
        hadManifest: await functionConfigExists(ref, slug),
        nextConfig: merged,
      });
      logger.info(
        `[EdgeFunction] Config updated for ${slug}@${ref}: verify_jwt=${merged.verify_jwt}, background_routes=${(merged.background_routes || []).length}`,
      );
      return merged;
    } finally {
      releaseLock();
    }
  },

  async deployRelease(request: EdgeFunctionDeploymentRequest): Promise<EdgeFunctionDeployResult> {
    const releaseLock = await acquireFunctionDeployLock(request.ref, request.slug);
    try {
      const deployed = await deployFunctionRelease(request);
      logger.info(
        `[EdgeFunction] Deployed ${request.slug} for ${request.ref} (version=${deployed.version}, verify_jwt=${deployed.config?.verify_jwt}, size=${deployed.bundle_size_bytes}, imports=${deployed.import_count})`,
      );
      return deployed;
    } catch (error) {
      logger.error("[EdgeFunction] Deploy failed", {
        ref: request.ref,
        slug: request.slug,
        error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
    return this.deployRelease({ ref, slug, code, minify });
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
    return this.deployRelease({ ref, slug, files, entrypoint, minify });
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
    preheat_body?: unknown;
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
      const preheatRes = await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
        method: "POST",
        headers: runtimeInternalHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      let preheatBody: unknown = null;
      try {
        preheatBody = await preheatRes.json();
      } catch {
        preheatBody = await preheatRes.text();
      }
      return {
        runtime_url: runtimeUrl,
        active_version: activeVersion,
        active_artifact_path: activeArtifactPath,
        artifact_exists: artifactExists,
        runtime_healthy: runtimeHealthy,
        preheat_ok:
          preheatRes.ok &&
          typeof preheatBody === "object" &&
          preheatBody !== null &&
          "success" in (preheatBody as Record<string, unknown>)
            ? Boolean((preheatBody as Record<string, unknown>).success)
            : preheatRes.ok,
        preheat_status: preheatRes.status,
        preheat_body: preheatBody,
        deploy_metrics: snapshotDeployMetrics(),
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
    try {
      const cfg = await this.getConfig(ref, slug);
      if (cfg.version) {
        const versioned = await readVersionedFunctionCode(ref, slug, cfg.version);
        if (versioned !== null) return versioned;
      }
      return await Bun.file(getFuncPath(ref, slug)).text();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error(`[EdgeFunction] Failed to read ${slug}`, {
          ref,
          error: err,
        });
      }
      return null;
    }
  },

  /** Read function original source (for debugging) */
  async readSource(ref: string, slug: string): Promise<string | null> {
    try {
      const cfg = await this.getConfig(ref, slug);
      if (cfg.version) {
        const versioned = await readVersionedFunctionSource(ref, slug, cfg.version, cfg.entrypoint);
        if (versioned !== null) return versioned;
      }
      return await Bun.file(getSrcPath(ref, slug)).text();
    } catch {
      return null;
    }
  },

  async listVersions(ref: string, slug: string): Promise<EdgeFunctionVersionRecord[]> {
    const cfg = await this.getConfig(ref, slug);
    const activeVersion = cfg.version || null;
    const versions = await listVersionDirectories(ref, slug);

    const records = await Promise.all(
      versions.map(async (version) => {
        const bundlePath = await getVersionedArtifactPath(ref, slug, version);
        const sourcePath = getVersionedSrcPath(ref, slug, version);
        const sourceDirPath = assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version, "src"));
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

  async activateVersion(ref: string, slug: string, version: string): Promise<EdgeFunctionConfig | null> {
    const releaseLock = await acquireFunctionDeployLock(ref, slug);
    try {
      const detail = await this.getVersion(ref, slug, version);
      if (!detail || !detail.has_bundle) return null;

      const versionMetadata = await readFunctionVersionMetadata(ref, slug, version);
      const readiness = await preheatRuntimeFunction(ref, slug, version);
      requireRuntimeControl(readiness, "version readiness");

      const currentConfig = await readFunctionConfig(ref, slug);
      const hadManifest = await functionConfigExists(ref, slug);
      const updated = restoredFunctionConfig(currentConfig, versionMetadata);
      await commitFunctionActivation({
        ref,
        slug,
        previousConfig: currentConfig,
        hadManifest,
        nextConfig: updated,
      });
      logger.info(`[EdgeFunction] Activated version ${version} for ${slug}@${ref}`);
      return updated;
    } finally {
      releaseLock();
    }
  },

  /** List all function slugs for a project */
  async list(ref: string): Promise<string[]> {
    try {
      const dir = getFuncDir(ref);
      const { Glob } = await import("bun");
      const glob = new Glob("*.js");
      const entries = Array.from(glob.scanSync({ cwd: dir, onlyFiles: true }));
      const slugs = new Set<string>();

      for (const entry of entries) {
        const parsedLegacy = parseLegacyVersionedFile(entry);
        if (parsedLegacy) continue;
        slugs.add(entry.replace(/\.js$/, ""));
      }

      const versionsRoot = path.join(dir, VERSIONED_DIR);
      const versionedEntries = await fs.readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of versionedEntries) {
        if (entry.isDirectory()) slugs.add(entry.name);
      }

      return Array.from(slugs).sort();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[EdgeFunction] Failed to list functions for ${ref}`, {
          error: err,
        });
      }
      return [];
    }
  },

  /** Delete a function (both bundled and source) */
  async remove(ref: string, slug: string): Promise<boolean> {
    const releaseLock = await acquireFunctionDeployLock(ref, slug);
    try {
      await removeFunctionArtifacts(ref, slug);
      const invalidation = await invalidateCache(ref, slug);
      requireRuntimeControl(invalidation, "function deletion invalidation");
      logger.info(`[EdgeFunction] Deleted ${slug} for ${ref}`);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error(`[EdgeFunction] Failed to delete ${slug}`, {
          ref,
          error: err,
        });
      }
      return false;
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

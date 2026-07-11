import { logger } from "../utils/logger";
import { config } from "../config";
import path from "path";
import fs from "fs/promises";

/** Per-function configuration (mirrors Supabase config.toml [functions.xxx]) */
export interface EdgeFunctionConfig {
  verify_jwt: boolean;
  import_map?: string;
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
  error?: string;
}

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
const SAFE_REF_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_SLUG_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const EXTERNAL_PACKAGE_REGEX = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;
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
  bunArtifactHash: string | null;
  metafile: BuildMetafile | null;
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

function getVersionedContentFuncPath(ref: string, slug: string, version: string, hash: string): string {
  return assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version, `index.${hash}.js`));
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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
      bunArtifactHash: typeof artifact.hash === "string" ? artifact.hash : null,
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

async function writeVersionedBundleArtifacts(
  ref: string,
  slug: string,
  version: string,
  code: string,
  artifactSizeBytes?: number,
): Promise<{ hash: string; sizeBytes: number; contentPath: string }> {
  const hash = (await sha256Hex(code)).slice(0, 16);
  const sizeBytes = typeof artifactSizeBytes === "number" ? artifactSizeBytes : bundleSizeBytes(code);
  const indexPath = getVersionedFuncPath(ref, slug, version);
  const contentPath = getVersionedContentFuncPath(ref, slug, version, hash);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await Bun.write(indexPath, code);
  await Bun.write(contentPath, code);
  return { hash, sizeBytes, contentPath };
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

async function preheatRuntimeFunction(ref: string, slug: string): Promise<EdgeFunctionPreheatResult> {
  const start = performance.now();
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const preheatRes = await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
      method: "POST",
      headers: runtimeInternalHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const durationMs = Math.round(performance.now() - start);
    let body: unknown = null;
    try {
      body = await preheatRes.json();
    } catch {
      body = await preheatRes.text();
    }
    const bodyRecord = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const foreground = normalizePreheatPool(bodyRecord.foreground);
    const background = normalizePreheatPool(bodyRecord.background);
    return {
      ok: preheatRes.ok && Boolean(bodyRecord.success ?? true),
      status: preheatRes.status,
      duration_ms: durationMs,
      attempted: foreground.attempted + background.attempted,
      succeeded: foreground.succeeded + background.succeeded,
      cache_hits: foreground.cacheHits + background.cacheHits,
      cache_misses: foreground.cacheMisses + background.cacheMisses,
      foreground,
      background,
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

async function invalidateCache(ref: string, slug: string): Promise<void> {
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
  try {
    const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
    const res = await fetch(`${runtimeUrl}/invalidate/${ref}/${slug}`, {
      method: "POST",
      headers: runtimeInternalHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      logger.warn(`[EdgeFunction] Runtime invalidate failed`, { ref, slug, status: res.status });
    }
  } catch {
    // Edge Runtime may not be running — modules will load fresh on next start
  }
}

async function computeNextFunctionVersion(ref: string, slug: string): Promise<string> {
  try {
    const raw = await Bun.file(getConfigPath(ref, slug)).text();
    const parsed = JSON.parse(raw) as EdgeFunctionConfig;
    const current = Number.parseInt(parsed.version || "0", 10);
    if (Number.isFinite(current)) return String(current + 1);
  } catch {
    // no existing config
  }
  return "1";
}

async function readVersionedFunctionCode(ref: string, slug: string, version: string): Promise<string | null> {
  const candidate = await getVersionedArtifactPath(ref, slug, version);
  if (!candidate) return null;
  if (!(await fileExists(candidate))) return null;
  return await Bun.file(candidate).text();
}

async function readVersionedFunctionSource(ref: string, slug: string, version: string): Promise<string | null> {
  const candidate = getVersionedSrcPath(ref, slug, version);
  if (!(await fileExists(candidate))) return null;
  return await Bun.file(candidate).text();
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
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  } catch {
    return [];
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

export const edgeFunctionService = {
  /** Read function config (verify_jwt, etc.) */
  async getConfig(ref: string, slug: string): Promise<EdgeFunctionConfig> {
    try {
      const raw = await Bun.file(getConfigPath(ref, slug)).text();
      return { ...DEFAULT_FUNCTION_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_FUNCTION_CONFIG };
    }
  },

  /** Update function config */
  async updateConfig(
    ref: string,
    slug: string,
    config: Partial<EdgeFunctionConfig>,
  ): Promise<EdgeFunctionConfig> {
    const current = await this.getConfig(ref, slug);
    const merged = { ...current, ...config };
    const dir = getFuncDir(ref);
    await fs.mkdir(dir, { recursive: true });
    await Bun.write(getConfigPath(ref, slug), JSON.stringify(merged, null, 2));
    logger.info(
      `[EdgeFunction] Config updated for ${slug}@${ref}: verify_jwt=${merged.verify_jwt}, background_routes=${(merged.background_routes || []).length}`,
    );
    return merged;
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
    try {
      const validation = validateFunctionCode(code);
      if (!validation.valid) {
        logger.error(`[EdgeFunction] Validation failed: ${validation.error}`, {
          ref,
          slug,
        });
        return { success: false, error: validation.error };
      }

      const dir = getFuncDir(ref);
      const safeSlug = validateSlug(slug);
      await fs.mkdir(dir, { recursive: true });
      const version = await computeNextFunctionVersion(ref, safeSlug);
      await fs.mkdir(path.dirname(getVersionedFuncPath(ref, safeSlug, version)), {
        recursive: true,
      });

      // 1. Preserve source for debugging
      const srcPath = getSrcPath(ref, safeSlug);
      await Bun.write(srcPath, code);
      await Bun.write(getVersionedSrcPath(ref, safeSlug, version), code);

      // 2. Bundle with Bun.build()
      const bundle = await bundleFunction(srcPath, dir, safeSlug, minify);
      const deployedCode = bundle?.code || code;
      if (!bundle) {
        // Fallback: if bundling fails (e.g., missing relative imports),
        // write the raw code directly as .js so at least simple functions work
        logger.warn(
          `[EdgeFunction] Bundle failed, falling back to raw deploy`,
          { ref, slug },
        );
        await Bun.write(getFuncPath(ref, safeSlug), code);
      } else {
        await Bun.write(getFuncPath(ref, safeSlug), bundle.code);
      }
      const bundleMeta = await writeVersionedBundleArtifacts(ref, safeSlug, version, deployedCode, bundle?.sizeBytes);
      const importCount = bundle?.importCount ?? countImports(code);

      // 3. Invalidate runtime caches
      await invalidateCache(ref, slug);

      // 4. Pre-heat the function in the worker pool (zero cold-start)
      const preheat = await preheatRuntimeFunction(ref, slug);
      if (!preheat.ok) {
        logger.warn(`[EdgeFunction] Runtime preheat failed`, { ref, slug, status: preheat.status, error: preheat.error });
      }
      recordDeployMetrics(bundleMeta.sizeBytes, importCount, preheat);

      await this.updateConfig(ref, safeSlug, { version });

      logger.info(
        `[EdgeFunction] Deployed ${slug} for ${ref} (bundled=${!!bundle}, minify=${minify}, version=${version}, size=${bundleMeta.sizeBytes}, imports=${importCount}, bun_hash=${bundle?.bunArtifactHash || "none"}, externals=${resolveExternalPackages().join(",") || "none"}, preheat_ms=${preheat.duration_ms}, preheat=${preheat.succeeded}/${preheat.attempted})`,
      );
      return {
        success: true,
        bundled: !!bundle,
        version,
        bundle_hash: bundleMeta.hash,
        bundle_size_bytes: bundleMeta.sizeBytes,
        import_count: importCount,
        content_path: bundleMeta.contentPath,
        external_packages: resolveExternalPackages(),
        preheat,
      };
    } catch (err) {
      logger.error(`[EdgeFunction] Deploy failed`, { ref, slug, error: err });
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
    try {
      if (!files[entrypoint]) {
        const error = `Entrypoint '${entrypoint}' not found in file map`;
        logger.error(
          `[EdgeFunction] ${error}`,
          { ref, slug },
        );
        return { success: false, error };
      }

      // Validate the entrypoint
      const validation = validateFunctionCode(files[entrypoint]);
      if (!validation.valid) {
        logger.error(`[EdgeFunction] Validation failed: ${validation.error}`, {
          ref,
          slug,
        });
        return { success: false, error: validation.error };
      }

      const dir = getFuncDir(ref);
      const safeSlug = validateSlug(slug);
      const version = await computeNextFunctionVersion(ref, safeSlug);
      // Use a staging subdirectory to write the full file tree
      const stageDir = assertInside(dir, path.join(dir, `.staging-${safeSlug}`));
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(stageDir, { recursive: true });

      // 1. Write all files to staging
      for (const [relPath, content] of Object.entries(files)) {
        const filePath = resolveInside(stageDir, relPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, content);
      }

      // 2. Resolve import_map if present
      let importMapPath: string | undefined;
      const importMapCandidates = [
        "import_map.json",
        "import_map",
        "deno.json",
        "deno.jsonc",
      ];
      for (const candidate of importMapCandidates) {
        const candidatePath = resolveInside(stageDir, candidate);
        try {
          await fs.access(candidatePath);
          importMapPath = candidatePath;
          break;
        } catch {
          /* not found */
        }
      }

      // 3. Bundle from entrypoint
      const entrypointPath = resolveInside(stageDir, entrypoint);
      const bundle = await bundleFunction(
        entrypointPath,
        dir,
        slug,
        minify,
        importMapPath,
      );

      if (!bundle) {
        // Cleanup staging on failure
        await fs.rm(stageDir, { recursive: true, force: true });
        logger.error(`[EdgeFunction] Bundle deploy failed`, { ref, slug });
        return {
          success: false,
          error:
            "Bun.build() failed while bundling the function. Check Management API logs for [EdgeFunction] Bun.build() details.",
        };
      }

      // 3. Preserve the source tree (rename staging → .src-{slug})
      const srcDir = assertInside(dir, path.join(dir, `.src-${safeSlug}`));
      await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(stageDir, srcDir);
      const versionedSrcDir = assertInside(dir, path.join(dir, VERSIONED_DIR, safeSlug, version, "src"));
      await fs.rm(versionedSrcDir, {
        recursive: true,
        force: true,
      }).catch(() => {});
      await fs.mkdir(path.dirname(versionedSrcDir), { recursive: true });
      await fs.cp(srcDir, versionedSrcDir, {
        recursive: true,
      });
      await Bun.write(getFuncPath(ref, slug), bundle.code);
      const bundleMeta = await writeVersionedBundleArtifacts(ref, slug, version, bundle.code, bundle.sizeBytes);
      const importCount = bundle.importCount ?? countFileImports(files);

      // 4. Invalidate runtime caches
      await invalidateCache(ref, slug);

      const preheat = await preheatRuntimeFunction(ref, slug);
      if (!preheat.ok) {
        logger.warn(`[EdgeFunction] Runtime preheat failed`, { ref, slug, status: preheat.status, error: preheat.error });
      }
      recordDeployMetrics(bundleMeta.sizeBytes, importCount, preheat);

      await this.updateConfig(ref, slug, {
        version,
        import_map: importMapPath ? path.basename(importMapPath) : undefined,
      });

      logger.info(
        `[EdgeFunction] Bundle deployed ${slug} for ${ref} (${Object.keys(files).length} files, minify=${minify}, version=${version}, size=${bundleMeta.sizeBytes}, imports=${importCount}, bun_hash=${bundle.bunArtifactHash || "none"}, externals=${resolveExternalPackages().join(",") || "none"}, preheat_ms=${preheat.duration_ms}, preheat=${preheat.succeeded}/${preheat.attempted})`,
      );
      return {
        success: true,
        bundled: true,
        version,
        files: Object.keys(files).length,
        import_map: importMapPath ? path.basename(importMapPath) : null,
        bundle_hash: bundleMeta.hash,
        bundle_size_bytes: bundleMeta.sizeBytes,
        import_count: importCount,
        content_path: bundleMeta.contentPath,
        external_packages: resolveExternalPackages(),
        preheat,
      };
    } catch (err) {
      logger.error(`[EdgeFunction] Bundle deploy failed`, {
        ref,
        slug,
        error: err,
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
        const versioned = await readVersionedFunctionSource(ref, slug, cfg.version);
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
    const detail = await this.getVersion(ref, slug, version);
    if (!detail || !detail.has_bundle) return null;

    const bundleCode = detail.bundle_code ?? (await readVersionedFunctionCode(ref, slug, version));
    if (bundleCode == null) return null;

    const dir = getFuncDir(ref);
    const safeSlug = validateSlug(slug);
    await fs.mkdir(dir, { recursive: true });
    await Bun.write(getFuncPath(ref, safeSlug), bundleCode);

    const sourceCode =
      detail.source_code ?? (detail.has_source ? await readVersionedFunctionSource(ref, slug, version) : null);
    if (sourceCode != null) {
      await Bun.write(getSrcPath(ref, safeSlug), sourceCode);
    }

    if (detail.has_source_dir && detail.source_dir_path) {
      const srcDir = assertInside(dir, path.join(dir, `.src-${safeSlug}`));
      await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      await fs.cp(detail.source_dir_path, srcDir, { recursive: true });
    }

    await invalidateCache(ref, slug);

    try {
      const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
      const preheatRes = await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
        method: "POST",
        headers: runtimeInternalHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!preheatRes.ok) {
        logger.warn("[EdgeFunction] Runtime preheat failed during version activation", { ref, slug, version, status: preheatRes.status });
      }
    } catch {
      logger.debug("[EdgeFunction] Preheat skipped during version activation", {
        ref,
        slug,
        version,
      });
    }

    const updated = await this.updateConfig(ref, slug, { version });
    logger.info(`[EdgeFunction] Activated version ${version} for ${slug}@${ref}`);
    return updated;
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
    try {
      // Remove bundled output
      await fs.unlink(getFuncPath(ref, slug)).catch(() => {});
      const dir = getFuncDir(ref);
      const safeSlug = validateSlug(slug);
      const entries = await fs.readdir(dir).catch(() => []);
      const versions = await listVersionDirectories(ref, safeSlug);
      await Promise.all(
        versions.map((version) =>
          fs.rm(assertInside(dir, path.join(dir, VERSIONED_DIR, safeSlug, version)), {
            recursive: true,
            force: true,
          }).catch(() => {}),
        ),
      );
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(`${safeSlug}.v`) && (entry.endsWith(".js") || entry.endsWith(".src.ts")))
          .map((entry) => fs.unlink(resolveInside(dir, entry)).catch(() => {})),
      );
      // Remove source file
      await fs.unlink(getSrcPath(ref, slug)).catch(() => {});
      // Remove source directory (bundle deploys)
      await fs
        .rm(assertInside(dir, path.join(dir, `.src-${safeSlug}`)), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(`.src-${safeSlug}-v`))
          .map((entry) =>
            fs.rm(resolveInside(dir, entry), {
              recursive: true,
              force: true,
            }).catch(() => {}),
          ),
      );
      await fs.rm(assertInside(dir, path.join(dir, VERSIONED_DIR, safeSlug)), {
        recursive: true,
        force: true,
      }).catch(() => {});

      await invalidateCache(ref, slug);

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

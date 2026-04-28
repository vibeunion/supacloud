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
  error?: string;
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

const FUNCTIONS_ROOT = path.resolve(config.edgeFunctionsDir);
const VERSIONED_DIR = ".versions";
const SAFE_REF_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_SLUG_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

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
  return assertInside(FUNCTIONS_ROOT, path.join(FUNCTIONS_ROOT, validateRef(ref)));
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
): Promise<string | null> {
  try {
    const buildOptions: any = {
      entrypoints: [entrypoint],
      outdir,
      naming: `${outName}.[ext]`,
      target: "bun",
      minify,
      external: [],
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

    // Read the output
    const outPath = path.join(outdir, `${outName}.js`);
    return await Bun.file(outPath).text();
  } catch (err) {
    logger.error(`[EdgeFunction] Bundle error`, { error: err });
    return null;
  }
}

/**
 * Clear module caches so Worker threads pick up the new version.
 */
async function invalidateCache(ref: string, slug: string): Promise<void> {
  // 1. Clear the transform file cache
  const cacheDir = path.join(FUNCTIONS_ROOT, ".cache", ref);
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
    await fetch(`${runtimeUrl}/invalidate/${ref}/${slug}`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
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
  const candidate = getVersionedFuncPath(ref, slug, version);
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
  const projectDirs = await fs.readdir(FUNCTIONS_ROOT, { withFileTypes: true }).catch(() => []);

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
      const bundled = await bundleFunction(srcPath, dir, safeSlug, minify);
      if (!bundled) {
        // Fallback: if bundling fails (e.g., missing relative imports),
        // write the raw code directly as .js so at least simple functions work
        logger.warn(
          `[EdgeFunction] Bundle failed, falling back to raw deploy`,
          { ref, slug },
        );
        await Bun.write(getFuncPath(ref, safeSlug), code);
        await Bun.write(getVersionedFuncPath(ref, safeSlug, version), code);
      } else {
        await Bun.write(getFuncPath(ref, safeSlug), bundled);
        await Bun.write(getVersionedFuncPath(ref, safeSlug, version), bundled);
      }

      // 3. Invalidate runtime caches
      await invalidateCache(ref, slug);

      // 4. Pre-heat the function in the worker pool (zero cold-start)
      try {
        const runtimeUrl = `http://${config.edgeRuntimeInternal}`;
        await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
          method: "POST",
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        // Non-fatal: function will be loaded on first real request
        logger.debug(`[EdgeFunction] Preheat skipped (runtime unavailable)`, {
          ref,
          slug,
        });
      }

      await this.updateConfig(ref, safeSlug, { version });

      logger.info(
        `[EdgeFunction] Deployed ${slug} for ${ref} (bundled=${!!bundled}, minify=${minify}, version=${version})`,
      );
      return { success: true, bundled: !!bundled, version };
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
      const bundled = await bundleFunction(
        entrypointPath,
        dir,
        slug,
        minify,
        importMapPath,
      );

      if (!bundled) {
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
      await Bun.write(getFuncPath(ref, slug), bundled);
      await Bun.write(getVersionedFuncPath(ref, slug, version), bundled);

      // 4. Invalidate runtime caches
      await invalidateCache(ref, slug);

      await this.updateConfig(ref, slug, {
        version,
        import_map: importMapPath ? path.basename(importMapPath) : undefined,
      });

      logger.info(
        `[EdgeFunction] Bundle deployed ${slug} for ${ref} (${Object.keys(files).length} files, minify=${minify}, version=${version})`,
      );
      return {
        success: true,
        bundled: true,
        version,
        files: Object.keys(files).length,
        import_map: importMapPath ? path.basename(importMapPath) : null,
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
      };
    } catch (err) {
      return {
        runtime_url: runtimeUrl,
        active_version: activeVersion,
        active_artifact_path: activeArtifactPath,
        artifact_exists: artifactExists,
        runtime_healthy: runtimeHealthy,
        preheat_ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
        const bundlePath = getVersionedFuncPath(ref, slug, version);
        const sourcePath = getVersionedSrcPath(ref, slug, version);
        const sourceDirPath = assertInside(getFuncDir(ref), path.join(getFuncDir(ref), VERSIONED_DIR, validateSlug(slug), version, "src"));
        const [hasBundle, hasSource, hasSourceDir] = await Promise.all([
          fileExists(bundlePath),
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
      await fetch(`${runtimeUrl}/preheat/${ref}/${slug}`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
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
      const logDir = path.join(FUNCTIONS_ROOT, ref, ".logs");
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

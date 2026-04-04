import { logger } from "../utils/logger";
import { config } from "../config";
import path from "path";
import fs from "fs/promises";

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

const FUNCTIONS_ROOT = config.edgeFunctionsDir;

function getFuncDir(ref: string): string {
  return path.join(FUNCTIONS_ROOT, ref);
}

function getFuncPath(ref: string, slug: string): string {
  return path.join(getFuncDir(ref), `${slug}.js`);
}

function getSrcPath(ref: string, slug: string): string {
  return path.join(getFuncDir(ref), `${slug}.src.ts`);
}

/**
 * Validate that function code contains a serve handler.
 * Accepts Deno.serve, export default, module.exports, fetch handlers, etc.
 */
function validateFunctionCode(code: string): { valid: boolean; error?: string } {
  if (!code || code.trim().length === 0) {
    return { valid: false, error: "Function code is empty" };
  }

  const hasHandler =
    code.includes("Deno.serve") ||
    code.includes("serve(") ||
    code.includes("export default") ||
    code.includes("module.exports") ||
    code.includes("__esModule") ||
    code.includes("exports.default") ||
    code.includes("async fetch") ||
    code.includes("new Request") ||
    code.includes("new Response");

  if (!hasHandler) {
    return {
      valid: false,
      error: "Function must contain a handler (Deno.serve, export default, module.exports, or fetch handler)",
    };
  }

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
): Promise<string | null> {
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir,
      naming: `${outName}.[ext]`,
      target: "bun",
      minify,
      // Inline everything — no external dependencies at runtime
      external: [],
    });

    if (!result.success) {
      const messages = result.logs.map((l: any) => l.message || String(l)).join("\n");
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
    } catch { /* may not exist */ }
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

export const edgeFunctionService = {
  /**
   * Deploy a single-file Edge Function.
   * The source code is preserved as .src.ts; a bundled .js is written for the runtime.
   */
  async deploy(ref: string, slug: string, code: string, minify: boolean = false): Promise<boolean> {
    try {
      const validation = validateFunctionCode(code);
      if (!validation.valid) {
        logger.error(`[EdgeFunction] Validation failed: ${validation.error}`, { ref, slug });
        return false;
      }

      const dir = getFuncDir(ref);
      await fs.mkdir(dir, { recursive: true });

      // 1. Preserve source for debugging
      const srcPath = getSrcPath(ref, slug);
      await Bun.write(srcPath, code);

      // 2. Bundle with Bun.build()
      const bundled = await bundleFunction(srcPath, dir, slug, minify);
      if (!bundled) {
        // Fallback: if bundling fails (e.g., missing relative imports),
        // write the raw code directly as .js so at least simple functions work
        logger.warn(`[EdgeFunction] Bundle failed, falling back to raw deploy`, { ref, slug });
        await Bun.write(getFuncPath(ref, slug), code);
      }

      // 3. Invalidate runtime caches
      await invalidateCache(ref, slug);

      logger.info(`[EdgeFunction] Deployed ${slug} for ${ref} (bundled=${!!bundled}, minify=${minify})`);
      return true;
    } catch (err) {
      logger.error(`[EdgeFunction] Deploy failed`, { ref, slug, error: err });
      return false;
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
    try {
      if (!files[entrypoint]) {
        logger.error(`[EdgeFunction] Entrypoint '${entrypoint}' not found in file map`, { ref, slug });
        return false;
      }

      // Validate the entrypoint
      const validation = validateFunctionCode(files[entrypoint]);
      if (!validation.valid) {
        logger.error(`[EdgeFunction] Validation failed: ${validation.error}`, { ref, slug });
        return false;
      }

      const dir = getFuncDir(ref);
      // Use a staging subdirectory to write the full file tree
      const stageDir = path.join(dir, `.staging-${slug}`);
      await fs.mkdir(stageDir, { recursive: true });

      // 1. Write all files to staging
      for (const [relPath, content] of Object.entries(files)) {
        const filePath = path.join(stageDir, relPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await Bun.write(filePath, content);
      }

      // 2. Bundle from entrypoint
      const entrypointPath = path.join(stageDir, entrypoint);
      const bundled = await bundleFunction(entrypointPath, dir, slug, minify);

      if (!bundled) {
        // Cleanup staging on failure
        await fs.rm(stageDir, { recursive: true, force: true });
        logger.error(`[EdgeFunction] Bundle deploy failed`, { ref, slug });
        return false;
      }

      // 3. Preserve the source tree (rename staging → .src-{slug})
      const srcDir = path.join(dir, `.src-${slug}`);
      await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      await fs.rename(stageDir, srcDir);

      // 4. Invalidate runtime caches
      await invalidateCache(ref, slug);

      logger.info(`[EdgeFunction] Bundle deployed ${slug} for ${ref} (${Object.keys(files).length} files, minify=${minify})`);
      return true;
    } catch (err) {
      logger.error(`[EdgeFunction] Bundle deploy failed`, { ref, slug, error: err });
      return false;
    }
  },

  /** Read function bundled code (runtime version) */
  async read(ref: string, slug: string): Promise<string | null> {
    try {
      return await Bun.file(getFuncPath(ref, slug)).text();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
         logger.error(`[EdgeFunction] Failed to read ${slug}`, { ref, error: err });
      }
      return null;
    }
  },

  /** Read function original source (for debugging) */
  async readSource(ref: string, slug: string): Promise<string | null> {
    try {
      return await Bun.file(getSrcPath(ref, slug)).text();
    } catch {
      return null;
    }
  },

  /** List all function slugs for a project */
  async list(ref: string): Promise<string[]> {
    try {
      const dir = getFuncDir(ref);
      const { Glob } = await import("bun");
      const glob = new Glob("*.js");
      const entries = Array.from(glob.scanSync({ cwd: dir, onlyFiles: true }));
      return entries.map((f) => f.replace(/\.js$/, ""));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
         logger.warn(`[EdgeFunction] Failed to list functions for ${ref}`, { error: err });
      }
      return [];
    }
  },

  /** Delete a function (both bundled and source) */
  async remove(ref: string, slug: string): Promise<boolean> {
    try {
      // Remove bundled output
      await fs.unlink(getFuncPath(ref, slug)).catch(() => {});
      // Remove source file
      await fs.unlink(getSrcPath(ref, slug)).catch(() => {});
      // Remove source directory (bundle deploys)
      await fs.rm(path.join(getFuncDir(ref), `.src-${slug}`), { recursive: true, force: true }).catch(() => {});

      await invalidateCache(ref, slug);

      logger.info(`[EdgeFunction] Deleted ${slug} for ${ref}`);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
         logger.error(`[EdgeFunction] Failed to delete ${slug}`, { ref, error: err });
      }
      return false;
    }
  },
};

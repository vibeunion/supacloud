import { logger } from "../utils/logger";
import { config } from "../config";
import path from "path";
import fs from "fs/promises";

/**
 * Edge Function file management — handles function source files on disk.
 * Supports both Deno-style and Bun-native user code.
 *
 * When deploying, source is stored as-is (original Deno code).
 * Transformation to Bun-compatible code happens at runtime in the edge-function-runner.
 */

const FUNCTIONS_ROOT = config.edgeFunctionsDir;

function getFuncDir(ref: string): string {
  return path.join(FUNCTIONS_ROOT, ref);
}

function getFuncPath(ref: string, slug: string): string {
  return path.join(getFuncDir(ref), `${slug}.ts`);
}

/**
 * Validate that function code contains a serve handler.
 * Accepts both `Deno.serve(...)` and `serve(...)` patterns.
 */
function validateFunctionCode(code: string): { valid: boolean; error?: string } {
  if (!code || code.trim().length === 0) {
    return { valid: false, error: "Function code is empty" };
  }

  // Accept many patterns: original Deno style, bundled CommonJS, or any export
  const hasHandler =
    code.includes("Deno.serve") ||
    code.includes("serve(") ||
    code.includes("export default") ||
    // Bun bundler output patterns
    code.includes("module.exports") ||
    code.includes("__esModule") ||
    code.includes("exports.default") ||
    // Generic handler patterns
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

export const edgeFunctionService = {
  /** Deploy (create/update) a function */
  async deploy(ref: string, slug: string, code: string): Promise<boolean> {
    try {
      const validation = validateFunctionCode(code);
      if (!validation.valid) {
        logger.error(`[EdgeFunction] Validation failed: ${validation.error}`, { ref, slug });
        return false;
      }

      const dir = getFuncDir(ref);
      await fs.mkdir(dir, { recursive: true });
      await Bun.write(getFuncPath(ref, slug), code);

      // Also clear the transform cache so the runner picks up the new version
      const cacheDir = path.join(FUNCTIONS_ROOT, ".cache", ref);
      const cachePath = path.join(cacheDir, `${slug}.ts`);
      try {
        await fs.unlink(cachePath);
      } catch {
        // Cache file may not exist yet, ignore
      }

      logger.info(`[EdgeFunction] Deployed ${slug} for ${ref}`);
      return true;
    } catch (err) {
      logger.error(`[EdgeFunction] Deploy failed`, { ref, slug, error: err });
      return false;
    }
  },

  /** Read function source code */
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

  /** List all function slugs for a project */
  async list(ref: string): Promise<string[]> {
    try {
      const dir = getFuncDir(ref);
      const entries = await fs.readdir(dir);
      return entries
        .filter((f) => f.endsWith(".ts") && f !== "index.ts")
        .map((f) => f.replace(/\.ts$/, ""));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
         logger.warn(`[EdgeFunction] Failed to list functions for ${ref}`, { error: err });
      }
      return [];
    }
  },

  /** Delete a function */
  async remove(ref: string, slug: string): Promise<boolean> {
    try {
      await fs.unlink(getFuncPath(ref, slug));

      // Also clean cache
      const cachePath = path.join(FUNCTIONS_ROOT, ".cache", ref, `${slug}.ts`);
      try {
        await fs.unlink(cachePath);
      } catch {
        // Ignore
      }

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

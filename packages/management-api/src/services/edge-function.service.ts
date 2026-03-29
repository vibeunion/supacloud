import { logger } from "../utils/logger";
import { config } from "../config";
import path from "path";
import fs from "fs/promises";

/**
 * Edge Function file management — replaces the old Deno-based function_manager.sh
 * Manages function source files on disk for the Bun Edge Runtime.
 */

const FUNCTIONS_ROOT = config.edgeFunctionsDir;

function getFuncDir(ref: string): string {
  return path.join(FUNCTIONS_ROOT, ref);
}

function getFuncPath(ref: string, slug: string): string {
  return path.join(getFuncDir(ref), `${slug}.ts`);
}

export const edgeFunctionService = {
  /** Deploy (create/update) a function */
  async deploy(ref: string, slug: string, code: string): Promise<boolean> {
    try {
      const dir = getFuncDir(ref);
      await fs.mkdir(dir, { recursive: true });
      await Bun.write(getFuncPath(ref, slug), code);
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

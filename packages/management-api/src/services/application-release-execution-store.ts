import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ReleaseExecutionError,
  parseReleaseExecutionDocument,
  type ReleaseExecutionDocument,
} from "./application-release-execution.service";

/**
 * Durable store for release-execution observations. It is a port so the API can
 * be tested without a filesystem and so a deployment can back it with a
 * dedicated table later. Reads are always validated, so a corrupted or tampered
 * record never becomes a verified release.
 */
export interface ReleaseExecutionStore {
  save(projectRef: string, applicationId: string, document: ReleaseExecutionDocument): Promise<void>;
  read(projectRef: string, applicationId: string, releaseId: string, target: string): Promise<ReleaseExecutionDocument | null>;
}

const PROJECT = /^[A-Za-z0-9_-]{1,20}$/;
const APPLICATION = /^[A-Za-z0-9_-]{1,64}$/;
const RELEASE = /^[a-f0-9]{64}$/;
const TARGET = /^[a-z][a-z0-9-]{0,62}$/;

function invalid(): never {
  throw new ReleaseExecutionError("RELEASE_EXECUTION_INVALID");
}

function assertKey(projectRef: string, applicationId: string, releaseId: string, target: string): void {
  if (!PROJECT.test(projectRef) || !APPLICATION.test(applicationId) || !RELEASE.test(releaseId) || !TARGET.test(target)) invalid();
}

async function writeDurable(path: string, bytes: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Atomic, validating filesystem store under `baseDir/<project>/<application>/<release>/<target>.json`. */
export function createFileReleaseExecutionStore(baseDir = "/var/supacloud/application-executions"): ReleaseExecutionStore {
  const root = resolve(baseDir);

  const fileOf = async (projectRef: string, applicationId: string, releaseId: string, target: string, create: boolean) => {
    assertKey(projectRef, applicationId, releaseId, target);
    const directory = join(root, projectRef, applicationId, releaseId);
    if (create) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Ensure the directory entry itself is persisted, not just its contents.
      for (let ancestor = await realpath(directory); ; ancestor = dirname(ancestor)) {
        const handle = await open(ancestor, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        if (ancestor === dirname(ancestor)) break;
      }
    } else {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    }
    return join(directory, `${target}.json`);
  };

  return {
    async save(projectRef, applicationId, document) {
      const file = await fileOf(projectRef, applicationId, document.release_id, document.target, true);
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeDurable(temporary, JSON.stringify(document));
      await rename(temporary, file);
      const handle = await open(file, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      await rm(temporary, { force: true });
    },
    async read(projectRef, applicationId, releaseId, target) {
      let file: string;
      try {
        file = await fileOf(projectRef, applicationId, releaseId, target, false);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      let bytes: string;
      try {
        bytes = await readFile(file, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes);
      } catch {
        invalid();
      }
      return parseReleaseExecutionDocument(parsed, { release_id: releaseId, target });
    },
  };
}
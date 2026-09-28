import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stableStringify } from "../utils/stable-json";
import { applicationRuntimePlan, type ApplicationRuntimeInput } from "./application-runtime";
import { parseApplicationActiveRecord, type ApplicationActiveRecord } from "./application-activation";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncAncestors(directory: string, beforeSync?: (path: string) => Promise<void>): Promise<void> {
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    await beforeSync?.(ancestor);
    await sync(ancestor);
    if (ancestor === dirname(ancestor)) break;
  }
}

/** Writes require the application's project-mutation resource lease. */
export class ApplicationActiveStorage {
  constructor(
    private readonly root = "/var/supacloud/application-state",
    private readonly operations: { beforeDirectorySync?(path: string): Promise<void> } = {},
  ) {}

  private async directory(projectRef: string, applicationId: string, environmentId: string, create = false): Promise<string> {
    if (!/^[a-z0-9-]{1,20}$/.test(projectRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(applicationId) || !/^[A-Za-z0-9_-]{1,64}$/.test(environmentId)) {
      throw new Error("APPLICATION_ACTIVE_IDENTITY_INVALID");
    }
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let directory = await realpath(this.root);
    for (const component of [projectRef, applicationId, environmentId]) {
      directory = join(directory, component);
      if (create) await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("APPLICATION_ACTIVE_DIRECTORY_INVALID");
    }
    return directory;
  }

  async read(runtime: ApplicationRuntimeInput): Promise<ApplicationActiveRecord | null> {
    applicationRuntimePlan(runtime);
    return this.readForApplication(runtime.release.project_ref, runtime.release.application_id, runtime.environmentId);
  }

  async readForApplication(projectRef: string, applicationId: string, environmentId: string): Promise<ApplicationActiveRecord | null> {
    let directory: string;
    try { directory = await this.directory(projectRef, applicationId, environmentId); }
    catch (error) { if (missing(error)) return null; throw error; }
    const path = join(directory, "active.json");
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error("APPLICATION_ACTIVE_INVALID");
    return parseApplicationActiveRecord(JSON.parse(await readFile(path, "utf8")), {
      release: { project_ref: projectRef, application_id: applicationId }, environmentId,
    });
  }

  async write(record: ApplicationActiveRecord, expectedActivationId: string | null): Promise<void> {
    parseApplicationActiveRecord(record, record.runtime);
    const current = await this.read(record.runtime);
    const { project_ref: projectRef, application_id: applicationId } = record.runtime.release;
    const environmentId = record.runtime.environmentId;
    if (stableStringify(current) === stableStringify(record)) {
      await syncAncestors(await this.directory(projectRef, applicationId, environmentId), this.operations.beforeDirectorySync);
      return;
    }
    if ((current?.runtime.activationId ?? null) !== expectedActivationId) {
      throw new Error("APPLICATION_ACTIVATION_REVISION_CONFLICT");
    }
    const content = stableStringify(record);
    if (Buffer.byteLength(content) > 65_536) throw new Error("APPLICATION_ACTIVE_TOO_LARGE");
    const directory = await this.directory(projectRef, applicationId, environmentId, true);
    const temporary = join(directory, `.active-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(directory, "active.json"));
      await syncAncestors(directory, this.operations.beforeDirectorySync);
    } finally { await rm(temporary, { force: true }); }
  }

  /** Repair only durability of already matching authority; never replace its contents. */
  async confirm(record: ApplicationActiveRecord): Promise<void> {
    parseApplicationActiveRecord(record, record.runtime);
    const read = () => this.read(record.runtime);
    if (stableStringify(await read()) !== stableStringify(record)) throw new Error("APPLICATION_ACTIVATION_READBACK_MISMATCH");
    const directory = await this.directory(
      record.runtime.release.project_ref, record.runtime.release.application_id, record.runtime.environmentId,
    );
    await sync(join(directory, "active.json"));
    await syncAncestors(directory, this.operations.beforeDirectorySync);
    if (stableStringify(await read()) !== stableStringify(record)) throw new Error("APPLICATION_ACTIVATION_READBACK_MISMATCH");
  }
}

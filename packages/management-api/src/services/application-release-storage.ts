import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Value } from "typebox/value";
import {
  ApplicationIdSchema as identity, ApplicationReleaseIdSchema as digest,
  applicationReleaseId as releaseId, parseApplicationReleaseRecord,
  readDeliveryExecutableArchive, readDeliveryMigrationArchive,
  type ApplicationReleaseRecord, type ApplicationReleaseInventory,
} from "@supacloud/delivery";
import { stableSha256, stableStringify } from "../utils/stable-json";

export type { ApplicationReleaseRecord } from "@supacloud/delivery";

export interface ImportApplicationRelease {
  projectRef: string;
  applicationId: string;
  manifestPath: string;
  expectedObjects: Readonly<Record<string, string>>;
}

export class ApplicationReleaseError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "ApplicationReleaseError";
  }
}

function invalid(code = "APPLICATION_RELEASE_INVALID", statusCode = 400): never {
  throw new ApplicationReleaseError(code, statusCode);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurable(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Internal intake only: callers supply an owned upload directory, never a client-selected server path. */
export class ApplicationReleaseStorage {
  constructor(private readonly baseDir = "/var/supacloud/applications") {}

  private async releasesDirectory(projectRef: string, applicationId: string, create = false): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(projectRef) || !Value.Check(identity, applicationId)) invalid();
    if (create) await mkdir(resolve(this.baseDir), { recursive: true, mode: 0o700 });
    let directory = await realpath(this.baseDir);
    if (create) {
      // Persist new root entries too, including roots created by a concurrent importer.
      for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
        await syncDirectory(ancestor);
        if (ancestor === dirname(ancestor)) break;
      }
    }
    for (const component of [projectRef, applicationId, "releases"]) {
      const parent = directory;
      directory = join(parent, component);
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        });
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
      if (create) await syncDirectory(parent);
    }
    return directory;
  }

  async importRelease(input: ImportApplicationRelease): Promise<ApplicationReleaseRecord> {
    const directory = await this.releasesDirectory(input.projectRef, input.applicationId, true);
    const archive = await readDeliveryExecutableArchive(input.manifestPath);
    const actualObjects = Object.fromEntries(archive.objects.map(({ object }) => [object.name, object.objectId]));
    if (stableStringify(input.expectedObjects) !== stableStringify(actualObjects)) {
      invalid("APPLICATION_RELEASE_OBJECT_MISMATCH", 409);
    }
    const manifest = stableStringify(archive.manifest);
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const id = releaseId(input.projectRef, input.applicationId, manifestSha256);
    const record: ApplicationReleaseRecord = {
      schema: "supacloud.application-release.v1",
      project_ref: input.projectRef, application_id: input.applicationId, release_id: id,
      manifest_sha256: manifestSha256, created_at: new Date().toISOString(),
      targets: archive.objects.map(({ object }) => ({
        name: object.name, object_id: object.objectId,
        kind: object.entryKind === "bun-worker-application" ? "worker" : "http",
        entrypoint: object.entrypoint,
      })),
    };
    const staging = await mkdtemp(join(directory, ".incoming-"));
    try {
      const directories = new Set([staging]);
      await writeDurable(join(staging, "delivery.manifest.json"), manifest);
      for (const { object, files } of archive.objects) {
        for (const [path, content] of files) {
          const destination = join(staging, "objects", object.objectId, path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          for (let parent = dirname(destination); parent !== staging; parent = dirname(parent)) {
            directories.add(parent);
          }
          await writeDurable(destination, content);
        }
      }
      // Validate the stored snapshot, including SQL inventories, before publishing it.
      await readDeliveryExecutableArchive(join(staging, "delivery.manifest.json"));
      for (const target of record.targets) {
        await readDeliveryMigrationArchive(join(staging, "delivery.manifest.json"), target.name);
      }
      await writeDurable(join(staging, "release.json"), stableStringify(record));
      for (const path of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(path);
      try {
        await rename(staging, join(directory, id));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)
          || (error.code !== "ENOTEMPTY" && error.code !== "EEXIST")) throw error;
        const existing = await this.readRelease(input.projectRef, input.applicationId, id);
        await syncDirectory(directory);
        return existing;
      }
      await syncDirectory(directory);
      return record;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async storedRecord(projectRef: string, applicationId: string, id: string) {
    if (!Value.Check(digest, id)) invalid();
    let directory: string;
    try {
      directory = join(await this.releasesDirectory(projectRef, applicationId), id);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    } catch (error) {
      if (isMissing(error)) invalid("APPLICATION_RELEASE_NOT_FOUND", 404);
      throw error;
    }
    const recordPath = join(directory, "release.json");
    const recordStat = await lstat(recordPath);
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 65_536) invalid();
    let record: ApplicationReleaseRecord;
    try { record = parseApplicationReleaseRecord(JSON.parse(await readFile(recordPath, "utf8"))); }
    catch { invalid("APPLICATION_RELEASE_CORRUPT", 409); }
    if (record.project_ref !== projectRef || record.application_id !== applicationId || record.release_id !== id) invalid();
    return { directory, record };
  }

  async listReleases(
    projectRef: string, applicationId: string, page: { cursor?: string; limit?: number } = {},
  ): Promise<ApplicationReleaseInventory> {
    const limit = page.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100
      || (page.cursor !== undefined && !Value.Check(digest, page.cursor))) invalid();
    let directory: string;
    try { directory = await this.releasesDirectory(projectRef, applicationId); }
    catch (error) {
      if (isMissing(error)) return { project_ref: projectRef, application_id: applicationId, releases: [], next_cursor: null };
      throw error;
    }
    const ids = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && Value.Check(digest, entry.name)
        && (page.cursor === undefined || entry.name > page.cursor))
      .map(entry => entry.name).sort();
    const selected = ids.slice(0, limit);
    const releases: ApplicationReleaseRecord[] = [];
    // Listing reads stored metadata; individual reads verify the artifact bytes.
    for (const id of selected) releases.push((await this.storedRecord(projectRef, applicationId, id)).record);
    return {
      project_ref: projectRef, application_id: applicationId, releases,
      next_cursor: ids.length > limit ? selected.at(-1) ?? null : null,
    };
  }

  async readRelease(projectRef: string, applicationId: string, id: string): Promise<ApplicationReleaseRecord> {
    return (await this.readArchive(projectRef, applicationId, id)).record;
  }

  async readMigrations(projectRef: string, applicationId: string, id: string) {
    const { record } = await this.readArchive(projectRef, applicationId, id);
    const { directory } = await this.storedRecord(projectRef, applicationId, id);
    const archives = [];
    for (const target of record.targets) {
      const archive = await readDeliveryMigrationArchive(join(directory, "delivery.manifest.json"), target.name);
      if (archive.objectId !== target.object_id) invalid("APPLICATION_RELEASE_CORRUPT", 409);
      archives.push(archive);
    }
    return { record, archives };
  }

  async readArchive(projectRef: string, applicationId: string, id: string) {
    const { directory, record } = await this.storedRecord(projectRef, applicationId, id);
    const archive = await readDeliveryExecutableArchive(join(directory, "delivery.manifest.json"));
    if (stableSha256(archive.manifest) !== record.manifest_sha256
      || stableStringify(record.targets) !== stableStringify(archive.objects.map(({ object }) => ({
        name: object.name, object_id: object.objectId,
        kind: object.entryKind === "bun-worker-application" ? "worker" : "http",
        entrypoint: object.entrypoint,
      })))) invalid();
    return { record, archive };
  }
}

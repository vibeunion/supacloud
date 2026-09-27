import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { APPLICATION_RESERVED_ENVIRONMENT_NAMES, readDeliveryExecutableArchive } from "@supacloud/delivery";
import { canonical, digest } from "@supacloud/delivery/files";
import { renderSystemdEnvLine } from "../utils/systemd-env";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { applicationRuntimePlan, type ApplicationRuntimeInput, type ApplicationRuntimePlan } from "./application-runtime";

export type ApplicationTargetEnvironment = Readonly<Record<string, Readonly<Record<string, string>>>>;

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableFile(path: string, content: string | Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(content); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
}

function environments(plan: ApplicationRuntimePlan, input: ApplicationTargetEnvironment): Map<string, string> {
  if (Object.keys(input).sort().join("\0") !== plan.targets.map(target => target.name).sort().join("\0")) {
    throw new Error("APPLICATION_RUNTIME_ENVIRONMENT_MISMATCH");
  }
  return new Map(plan.targets.map(target => {
    const values = input[target.name]!;
    const lines = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
      if (typeof value !== "string" || APPLICATION_RESERVED_ENVIRONMENT_NAMES.has(name)) {
        throw new Error("APPLICATION_RUNTIME_ENVIRONMENT_INVALID");
      }
      return renderSystemdEnvLine(name, value);
    });
    return [target.name, `${lines.join("\n")}\n`];
  }));
}

/** Runtime copies are separate from private intake; only systemd reads the 0600 environment files. */
export class ApplicationRuntimeFiles {
  constructor(
    private readonly storage = new ApplicationReleaseStorage(),
    private readonly root = "/var/supacloud/application-runtime",
  ) {}

  async prepare(input: ApplicationRuntimeInput, environment: ApplicationTargetEnvironment): Promise<string> {
    const plan = applicationRuntimePlan(input);
    const env = environments(plan, environment);
    const { record, archive } = await this.storage.readArchive(plan.projectRef, plan.applicationId, plan.releaseId);
    if (canonical(record) !== canonical(input.release)) throw new Error("APPLICATION_RUNTIME_RELEASE_MISMATCH");
    const receipt = canonical({
      plan,
      environmentDigests: Object.fromEntries([...env].map(([name, text]) => [name, digest(text)])),
    });
    const configuredRoot = resolve(this.root);
    await mkdir(configuredRoot, { recursive: true, mode: 0o711 });
    const rootStat = await lstat(configuredRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid runtime root");
    await chmod(configuredRoot, 0o711);
    const root = await realpath(configuredRoot);
    const project = join(root, plan.projectRef);
    await mkdir(project, { mode: 0o711 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const projectStat = await lstat(project);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("Invalid runtime project directory");
    await chmod(project, 0o711);
    const destination = join(project, plan.activationId);
    const staging = await mkdtemp(join(project, ".preparing-"));
    try {
      const directories = new Set([staging]);
      await durableFile(join(staging, "delivery.manifest.json"), canonical(archive.manifest), 0o444);
      for (const { object, files } of archive.objects) {
        for (const [path, bytes] of files) {
          const fullPath = join(staging, "objects", object.objectId, path);
          await mkdir(dirname(fullPath), { recursive: true, mode: 0o755 });
          for (let parent = dirname(fullPath); parent !== staging; parent = dirname(parent)) directories.add(parent);
          await durableFile(fullPath, bytes, 0o444);
        }
      }
      for (const [name, text] of env) await durableFile(join(staging, `${name}.env`), text, 0o600);
      await durableFile(join(staging, "runtime.json"), receipt, 0o600);
      await readDeliveryExecutableArchive(join(staging, "delivery.manifest.json"));
      await chmod(staging, 0o711);
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        if (directory !== staging) await chmod(directory, 0o755);
        await sync(directory);
      }
      try { await rename(staging, destination); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
      }
      // A repeated activation ID may only reuse the exact same bytes and configuration.
      const destinationStat = await lstat(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()
        || await readFile(join(destination, "runtime.json"), "utf8") !== receipt) {
        throw new Error("APPLICATION_RUNTIME_CONFIGURATION_CONFLICT");
      }
      const existing = await readDeliveryExecutableArchive(join(destination, "delivery.manifest.json"));
      if (canonical(existing.manifest) !== canonical(archive.manifest)) throw new Error("APPLICATION_RUNTIME_ARTIFACT_MISMATCH");
      const traversed = new Set<string>();
      for (const { object, files } of existing.objects) {
        for (const name of files.keys()) {
          const path = join(destination, "objects", object.objectId, name);
          if (((await lstat(path)).mode & 0o044) !== 0o044) throw new Error("APPLICATION_RUNTIME_UNREADABLE");
          for (let parent = dirname(path); parent !== project && !traversed.has(parent); parent = dirname(parent)) {
            traversed.add(parent);
            if (((await lstat(parent)).mode & 0o011) !== 0o011) throw new Error("APPLICATION_RUNTIME_UNREADABLE");
          }
        }
      }
      for (const [name, text] of env) {
        const path = join(destination, `${name}.env`);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
          || await readFile(path, "utf8") !== text) throw new Error("APPLICATION_RUNTIME_ENVIRONMENT_MISMATCH");
      }
      for (let ancestor = project; ; ancestor = dirname(ancestor)) {
        await sync(ancestor);
        if (ancestor === dirname(ancestor)) break;
      }
      return destination;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

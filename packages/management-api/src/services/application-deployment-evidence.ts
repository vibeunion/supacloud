import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseDeploymentEvidence, type DeploymentEvidence } from "@supacloud/delivery";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function identity(projectRef: string, applicationId: string, environmentId: string): void {
  if (!/^[a-z0-9-]{1,20}$/.test(projectRef)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(applicationId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(environmentId)) {
    throw new Error("APPLICATION_DEPLOYMENT_EVIDENCE_IDENTITY_INVALID");
  }
}

/** Durable, project-scoped evidence authority for single-node deployments. */
export class ApplicationDeploymentEvidenceStorage {
  constructor(private readonly root = "/var/supacloud/application-state") {}

  private async directory(projectRef: string, applicationId: string, environmentId: string, create = false): Promise<string> {
    identity(projectRef, applicationId, environmentId);
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let directory = await realpath(this.root);
    for (const component of [projectRef, applicationId, environmentId]) {
      directory = join(directory, component);
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        });
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("APPLICATION_DEPLOYMENT_EVIDENCE_DIRECTORY_INVALID");
      }
    }
    return directory;
  }

  async read(projectRef: string, applicationId: string, environmentId: string): Promise<DeploymentEvidence | null> {
    let directory: string;
    try { directory = await this.directory(projectRef, applicationId, environmentId); }
    catch (error) { if (missing(error)) return null; throw error; }
    const path = join(directory, "deployment-evidence.json");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
        throw new Error("APPLICATION_DEPLOYMENT_EVIDENCE_INVALID");
      }
      return parseDeploymentEvidence(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async write(value: DeploymentEvidence): Promise<DeploymentEvidence> {
    const evidence = parseDeploymentEvidence(value);
    const directory = await this.directory(
      evidence.scope.project_ref, evidence.scope.application_id, evidence.scope.environment_id, true,
    );
    const path = join(directory, "deployment-evidence.json");
    const temporary = join(directory, `.deployment-evidence-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(evidence)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      const result = await this.read(
        evidence.scope.project_ref, evidence.scope.application_id, evidence.scope.environment_id,
      );
      if (!result || JSON.stringify(result) !== JSON.stringify(evidence)) {
        throw new Error("APPLICATION_DEPLOYMENT_EVIDENCE_READBACK_MISMATCH");
      }
      return result;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

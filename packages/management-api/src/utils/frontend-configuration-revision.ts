import { createHash } from "node:crypto";
import type { FrontendDeployment } from "../types/frontend";
import { decryptSecret, encryptSecret } from "./secret-crypto";

export class FrontendConfigurationConflictError extends Error {
  constructor() {
    super("Configuration changed; reload before saving");
    this.name = "FrontendConfigurationConflictError";
  }
}

function fingerprint(deployment: FrontendDeployment): string {
  return createHash("sha256").update(JSON.stringify([
    "supacloud:frontend-configuration:v1", deployment.project_ref, deployment.id,
    deployment.build_command, deployment.output_dir, deployment.install_command,
    deployment.node_version, deployment.health_check_path ?? "/",
    deployment.git_url ?? "", deployment.git_branch ?? "main",
  ])).digest("hex");
}

export function createFrontendConfigurationRevision(deployment: FrontendDeployment): string {
  return encryptSecret(fingerprint(deployment));
}

export function requireFrontendConfigurationRevision(deployment: FrontendDeployment, revision: unknown): void {
  if (typeof revision !== "string" || revision.length > 256 || !/^enc:v1:[A-Za-z0-9_-]+$/.test(revision)) {
    throw new FrontendConfigurationConflictError();
  }
  let expected: string;
  try { expected = decryptSecret(revision); } catch { throw new FrontendConfigurationConflictError(); }
  if (expected !== fingerprint(deployment)) throw new FrontendConfigurationConflictError();
}

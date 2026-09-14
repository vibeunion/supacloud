import { createHash } from "node:crypto";
import type { FrontendDeployment } from "../types/frontend";
import { decryptSecret, encryptSecret } from "./secret-crypto";

export class FrontendEnvironmentConflictError extends Error {
  constructor() {
    super("Environment changed; reload before saving");
    this.name = "FrontendEnvironmentConflictError";
  }
}

function fingerprint(deployment: FrontendDeployment): string {
  const entries = Object.entries(deployment.env_vars).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify([
    "supacloud:frontend-environment:v1", deployment.project_ref, deployment.id, entries,
  ])).digest("hex");
}

export function createFrontendEnvironmentRevision(deployment: FrontendDeployment): string {
  // Encrypt the digest so a public revision cannot be used to guess low-entropy secrets.
  return encryptSecret(fingerprint(deployment));
}

export function requireFrontendEnvironmentRevision(
  deployment: FrontendDeployment, revision: unknown,
): void {
  if (typeof revision !== "string" || revision.length > 256 || !/^enc:v1:[A-Za-z0-9_-]+$/.test(revision)) {
    throw new FrontendEnvironmentConflictError();
  }
  let expected: string;
  try {
    expected = decryptSecret(revision);
  } catch {
    throw new FrontendEnvironmentConflictError();
  }
  if (expected !== fingerprint(deployment)) throw new FrontendEnvironmentConflictError();
}

import { createHmac } from "node:crypto";
import { config } from "../config";

export const ATTESTED_REVISION_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;

function attestedRevision(
  domain: "runtime-env" | "postgrest-config",
  projectRef: string,
  canonicalPayload: string,
): string {
  const digest = createHmac("sha256", config.secretsEncryptionKey)
    .update(`supacloud:${domain}:v1\0`, "utf8")
    .update(projectRef, "utf8")
    .update("\0", "utf8")
    .update(canonicalPayload, "utf8")
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

export function canonicalRuntimeEnv(env: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(env).sort().map((name) => [name, env[name]]),
  );
}

export function runtimeEnvRevision(
  projectRef: string,
  env: Record<string, string>,
): string {
  return attestedRevision("runtime-env", projectRef, canonicalRuntimeEnv(env));
}

export function edgeRuntimeEnvProof(
  projectRef: string,
  env: Record<string, string>,
): string {
  if (!config.edgeRuntimeMasterKey) {
    throw new Error("Edge Runtime master key is unavailable");
  }
  const digest = createHmac("sha256", config.edgeRuntimeMasterKey)
    .update("supacloud:edge-runtime-env-proof:v1\0", "utf8")
    .update(projectRef, "utf8")
    .update("\0", "utf8")
    .update(canonicalRuntimeEnv(env), "utf8")
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

export function canonicalPostgrestConfig(content: string): string {
  return `${content.replace(/\n*$/, "")}\n`;
}

export function postgrestConfigRevision(projectRef: string, content: string): string {
  return attestedRevision(
    "postgrest-config",
    projectRef,
    canonicalPostgrestConfig(content),
  );
}

export function revisionHex(revision: string): string {
  if (!ATTESTED_REVISION_PATTERN.test(revision)) {
    throw new Error("Invalid attested revision");
  }
  return revision.slice("hmac-sha256:".length);
}

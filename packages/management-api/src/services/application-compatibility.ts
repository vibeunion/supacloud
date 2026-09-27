import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertApplicationConfigurationScope } from "@supacloud/delivery";
import type { ApplicationDeploymentDependencies } from "./application-deployment";
import { applicationRuntimePlan } from "./application-runtime";
import { stableSha256 } from "../utils/stable-json";

export type ApplicationCompatibilityInput = Parameters<ApplicationDeploymentDependencies["verifyCompatibility"]>[0];

export interface ApplicationCompatibilityOperations {
  executable(input: ApplicationCompatibilityInput): Promise<string>;
  execute(executable: string, request: string): Promise<string>;
}

/**
 * Operators install a root-owned executable at
 * /etc/supacloud/application-verifiers/<project>/<application>/<environment>/verify.
 * It must perform read-only schema, binding, runtime and provisioning probes.
 * Input is JSON on stdin (including secrets); stdout is only the bound receipt.
 * Uploaded application artifacts must never supply this privileged executable.
 */
async function executable(input: ApplicationCompatibilityInput): Promise<string> {
  const scope = {
    projectRef: input.runtime.release.project_ref,
    applicationId: input.runtime.release.application_id,
    environmentId: input.runtime.environmentId,
  };
  assertApplicationConfigurationScope(scope);
  const parts = ["etc", "supacloud", "application-verifiers",
    scope.projectRef, scope.applicationId, scope.environmentId, "verify"];
  let path = "/";
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0
      || (index === parts.length - 1 ? !info.isFile() || !(info.mode & 0o111) : !info.isDirectory())) {
      throw new Error("APPLICATION_COMPATIBILITY_VERIFIER_UNTRUSTED");
    }
  }
  if (await realpath(path) !== resolve(path)) throw new Error("APPLICATION_COMPATIBILITY_VERIFIER_UNTRUSTED");
  return path;
}

export async function executeApplicationCompatibility(
  path: string, request: string, timeoutMs = 30_000,
): Promise<string> {
  const child = Bun.spawn([path], {
    stdin: new TextEncoder().encode(request),
    stdout: "pipe", stderr: "ignore",
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  const reader = child.stdout.getReader();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) throw new Error("APPLICATION_COMPATIBILITY_OUTPUT_INVALID");
      chunks.push(value);
    }
    const exitCode = await child.exited;
    if (timedOut) throw new Error("APPLICATION_COMPATIBILITY_TIMEOUT");
    if (exitCode !== 0) throw new Error("APPLICATION_COMPATIBILITY_REJECTED");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.exited;
  }
}

/** A fresh operator probe is mandatory; metadata and platform liveness are not a pass. */
export function createApplicationCompatibilityVerifier(
  operations: ApplicationCompatibilityOperations = { executable, execute: executeApplicationCompatibility },
): ApplicationDeploymentDependencies["verifyCompatibility"] {
  return async input => {
    try {
      applicationRuntimePlan(input.runtime);
      const owned = structuredClone(input);
      const request = {
        schema: "supacloud.application-compatibility-request.v1",
        nonce: randomUUID(), input_sha256: stableSha256(owned), input: owned,
      };
      const path = await operations.executable(owned);
      const output = await operations.execute(path, JSON.stringify(request));
      const receipt: unknown = JSON.parse(output);
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error();
      const value = receipt as Record<string, unknown>;
      if (value.schema !== "supacloud.application-compatibility-result.v1"
        || value.nonce !== request.nonce || value.input_sha256 !== request.input_sha256
        || value.compatible !== true || !value.checks || typeof value.checks !== "object"
        || Array.isArray(value.checks)) throw new Error();
      const checks = value.checks as Record<string, unknown>;
      if (["schema", "bindings", "runtime", "operator_provisioning"].some(name => checks[name] !== true)) {
        throw new Error();
      }
    } catch {
      // Verifier output and input can contain configuration secrets.
      throw new Error("APPLICATION_COMPATIBILITY_NOT_VERIFIED");
    }
  };
}

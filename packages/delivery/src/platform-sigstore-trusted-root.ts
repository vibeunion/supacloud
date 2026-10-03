/// <reference path="./types/jsonl.d.ts" />

import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import embeddedTrustedRootJsonl from "./assets/sigstore-public-good-trusted-root.jsonl" with { type: "text" };

export const SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME = "trusted_root.jsonl";
// Rotation procedure: refresh trusted_root.json through a TUF client anchored by
// Sigstore's published root, verify this target digest, then normalize it with
// `jq -c .` and update the reviewed JSONL digest and size below in one change.
export const SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_TUF_TARGET_SHA256 =
  "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66";
export const SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256 =
  "3c2cc7f357dc064ec527fdcd78da6e9245c21a381e1abaa0f2b62b186bcac1a1";
export const SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE = 5_748;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validateEmbeddedTrustedRoot(jsonl: string): string {
  if (Buffer.byteLength(jsonl) !== SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE
    || sha256(jsonl) !== SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256) {
    throw new Error("Embedded Sigstore Public Good trusted root does not match its pinned digest");
  }
  if (!jsonl.endsWith("\n") || jsonl.slice(0, -1).includes("\n")) {
    throw new Error("Embedded Sigstore Public Good trusted root must be compact JSONL");
  }
  let trustedRoot: unknown;
  try {
    trustedRoot = JSON.parse(jsonl);
  } catch {
    throw new Error("Embedded Sigstore Public Good trusted root is not valid JSON");
  }
  if (!trustedRoot || typeof trustedRoot !== "object" || Array.isArray(trustedRoot)
    || `${JSON.stringify(trustedRoot)}\n` !== jsonl) {
    throw new Error("Embedded Sigstore Public Good trusted root is not canonical compact JSONL");
  }
  return jsonl;
}

export const SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL =
  validateEmbeddedTrustedRoot(embeddedTrustedRootJsonl);

export type SigstoreVerificationDirectory = {
  directory: string;
  trustedRootPath: string;
};

export function createSigstoreVerificationDirectory(): SigstoreVerificationDirectory {
  const directory = mkdtempSync(path.join(tmpdir(), "supacloud-sigstore-"));
  try {
    chmodSync(directory, 0o700);
    const trustedRootPath = path.join(directory, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
    writeFileSync(trustedRootPath, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(trustedRootPath, 0o600);
    return { directory, trustedRootPath };
  } catch (operationError: unknown) {
    try {
      rmSync(directory, { recursive: true });
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Sigstore trusted root creation failed and temporary directory cleanup did not complete",
      );
    }
    throw operationError;
  }
}

type VerificationDirectoryOutcome = {
  operationFailed: boolean;
  operationError: unknown;
  cleanupFailed: boolean;
  cleanupError: unknown;
};

function throwVerificationDirectoryOutcome(outcome: VerificationDirectoryOutcome): void {
  if (outcome.operationFailed && outcome.cleanupFailed) {
    throw new AggregateError(
      [outcome.operationError, outcome.cleanupError],
      "Sigstore verification failed and temporary trusted root cleanup did not complete",
    );
  }
  if (outcome.operationFailed) throw outcome.operationError;
  if (outcome.cleanupFailed) {
    throw new AggregateError(
      [outcome.cleanupError], "Temporary Sigstore trusted root cleanup did not complete",
    );
  }
}

export async function withSigstoreVerificationDirectory<T>(
  operation: (resources: SigstoreVerificationDirectory) => Promise<T>,
): Promise<T> {
  const resources = createSigstoreVerificationDirectory();
  let operationOutput: T | undefined;
  let operationFailed: boolean = false;
  let operationError: unknown;
  try {
    operationOutput = await operation(resources);
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupFailed: boolean = false;
  let cleanupError: unknown;
  try {
    rmSync(resources.directory, { recursive: true });
  } catch (error: unknown) {
    cleanupFailed = true;
    cleanupError = error;
  }
  throwVerificationDirectoryOutcome({ operationFailed, operationError, cleanupFailed, cleanupError });
  return operationOutput as T;
}

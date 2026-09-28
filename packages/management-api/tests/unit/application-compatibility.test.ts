import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createApplicationCompatibilityVerifier, executeApplicationCompatibility,
  type ApplicationCompatibilityInput,
} from "../../src/services/application-compatibility";
import { runtimeInput } from "../helpers/application-runtime";

function input(): ApplicationCompatibilityInput {
  const runtime = runtimeInput();
  return {
    runtime, previous: null, environment: { api: { PRIVATE_VALUE: "private-fixture" }, jobs: {} },
    migrations: {
      schema: "supacloud.application-migrations.v1",
      project_ref: "demo", application_id: "reviews", release_id: runtime.release.release_id,
      manifest_sha256: runtime.release.manifest_sha256, ledger_digest: "d".repeat(64),
      ledger_compatible: true, project_migrations_applied: true, declaration_conflicts: [], targets: [],
      operator_provisioning: "separate-verification-required", compatibility: "not-proven",
      execution_performed: false, data_recovery: "separate-required",
    },
  };
}

function receipt(request: string) {
  const { nonce, input_sha256 } = JSON.parse(request);
  return {
    schema: "supacloud.application-compatibility-result.v1", nonce, input_sha256,
    compatible: true, checks: { schema: true, bindings: true, runtime: true, operator_provisioning: true },
  };
}

test("each compatibility check executes a fresh probe bound to the complete input", async () => {
  const requests: string[] = [];
  const verify = createApplicationCompatibilityVerifier({
    executable: async () => "/operator/verify",
    execute: async (path, request) => {
      expect(path).toBe("/operator/verify");
      requests.push(request);
      return JSON.stringify(receipt(request));
    },
  });
  const original = input();
  await verify(original);
  await verify(original);
  const changed = structuredClone(original);
  changed.environment = { ...changed.environment, api: { PRIVATE_VALUE: "changed" } };
  await verify(changed);
  expect(requests).toHaveLength(3);
  const [first, second, third] = requests.map(value => JSON.parse(value));
  expect(first.input).toEqual(original);
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.input_sha256).toBe(second.input_sha256);
  expect(first.input_sha256).not.toBe(third.input_sha256);
});

test("metadata-only, stale, mismatched and incomplete receipts cannot authorize activation", async () => {
  for (const response of [
    (_request: string) => ({ compatible: true }),
    (request: string) => ({ ...receipt(request), nonce: "old" }),
    (request: string) => ({ ...receipt(request), input_sha256: "e".repeat(64) }),
    (request: string) => ({ ...receipt(request), compatible: false }),
    ...["schema", "bindings", "runtime", "operator_provisioning"].map(name =>
      (request: string) => ({ ...receipt(request), checks: { ...receipt(request).checks, [name]: false } })),
  ]) {
    await expect(createApplicationCompatibilityVerifier({
      executable: async () => "/operator/verify",
      execute: async (_path, request) => JSON.stringify(response(request)),
    })(input())).rejects.toThrow("APPLICATION_COMPATIBILITY_NOT_VERIFIED");
  }
});

test("missing verifier and probe errors fail closed without reflecting secrets", async () => {
  let executed = false;
  await expect(createApplicationCompatibilityVerifier({
    executable: async () => { throw new Error("private-fixture"); },
    execute: async () => { executed = true; return ""; },
  })(input())).rejects.toThrow("APPLICATION_COMPATIBILITY_NOT_VERIFIED");
  expect(executed).toBe(false);
  try {
    await createApplicationCompatibilityVerifier({
      executable: async () => "/operator/verify",
      execute: async () => { throw new Error("private-fixture"); },
    })(input());
    throw new Error("Expected rejection");
  } catch (error) {
    expect(String(error)).toBe("Error: APPLICATION_COMPATIBILITY_NOT_VERIFIED");
  }
});

test("invalid runtime identity is rejected before selecting an executable", async () => {
  let selected = false;
  const candidate = input();
  candidate.runtime.environmentId = "../escape";
  await expect(createApplicationCompatibilityVerifier({
    executable: async () => { selected = true; return "/operator/verify"; },
    execute: async () => "",
  })(candidate)).rejects.toThrow("APPLICATION_COMPATIBILITY_NOT_VERIFIED");
  expect(selected).toBe(false);
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function executable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "application-compatibility-"));
  directories.push(directory);
  const path = join(directory, "verify");
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("real executable receives JSON on stdin and returns a request-bound receipt", async () => {
  const path = await executable(`
    const request = await Bun.stdin.json();
    if (process.env.APPLICATION_VERIFIER_TEST_SECRET !== undefined) process.exit(3);
    if (request.input.environment.api.PRIVATE_VALUE !== "private-fixture") process.exit(4);
    console.log(JSON.stringify({
      schema: "supacloud.application-compatibility-result.v1",
      nonce: request.nonce, input_sha256: request.input_sha256, compatible: true,
      checks: { schema: true, bindings: true, runtime: true, operator_provisioning: true }
    }));
  `);
  const prior = process.env.APPLICATION_VERIFIER_TEST_SECRET;
  process.env.APPLICATION_VERIFIER_TEST_SECRET = "must-not-inherit";
  try {
    await createApplicationCompatibilityVerifier({
      executable: async () => path, execute: executeApplicationCompatibility,
    })(input());
  } finally {
    if (prior === undefined) delete process.env.APPLICATION_VERIFIER_TEST_SECRET;
    else process.env.APPLICATION_VERIFIER_TEST_SECRET = prior;
  }
});

test("real executable rejection, excessive output and timeout are bounded", async () => {
  const rejected = await executable(`console.error("private-fixture"); process.exit(7);`);
  await expect(executeApplicationCompatibility(rejected, "{}")).rejects.toThrow("APPLICATION_COMPATIBILITY_REJECTED");
  const noisy = await executable(`console.log("x".repeat(20_000));`);
  await expect(executeApplicationCompatibility(noisy, "{}")).rejects.toThrow("APPLICATION_COMPATIBILITY_OUTPUT_INVALID");
  const stalled = await executable(`setInterval(() => {}, 1000);`);
  await expect(executeApplicationCompatibility(stalled, "{}", 100)).rejects.toThrow("APPLICATION_COMPATIBILITY_TIMEOUT");
});

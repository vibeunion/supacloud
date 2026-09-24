import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as contracts from "./contracts";
import * as shared from "@supacloud/contracts/client";
import { createSupaCloudClient } from "./index";

function decodeOperation(value: unknown): { operationId: string } {
  if (value === null || typeof value !== "object" || !("operationId" in value)
    || typeof value.operationId !== "string" || !value.operationId.trim()) {
    throw new TypeError("Invalid operation");
  }
  return { operationId: value.operationId };
}

const contract = {
  input: decodeOperation,
  acknowledgement: decodeOperation,
  authority: decodeOperation,
  matches: (input: { operationId: string }, result: { operationId: string }) =>
    input.operationId === result.operationId,
};

test("contracts reuse the shared client runtime without exporting service-role or browser storage APIs", () => {
  expect(contracts.createAuthoritativeCommandClient).toBe(shared.createAuthoritativeCommandClient);
  expect(contracts.createAuthenticatedFetch).toBe(shared.createAuthenticatedFetch);
  expect(contracts.createCommandScope).toBe(shared.createCommandScope);
  expect(contracts.CommandAuthenticationError).toBe(shared.CommandAuthenticationError);
  for (const name of ["createSupaCloudClient", "SupaCloudCommandsClient", "createDurableCommandLocks"]) {
    expect(Object.hasOwn(contracts, name)).toBe(false);
  }
  expect(typeof createSupaCloudClient).toBe("function");
});

test("the built public entrypoint retains the original runtime identities", async () => {
  const published = await import("@supacloud/js/contracts");
  expect(published.createAuthoritativeCommandClient).toBe(shared.createAuthoritativeCommandClient);
  expect(published.createAuthenticatedFetch).toBe(shared.createAuthenticatedFetch);
  expect(published.createCommandScope).toBe(shared.createCommandScope);
  expect(published.CommandAuthenticationError).toBe(shared.CommandAuthenticationError);
});

test("one failed write can be confirmed by one authoritative lookup without replay", async () => {
  let sends = 0;
  let lookups = 0;
  const execute = contracts.createAuthoritativeCommandClient(contract, {
    async send() { sends++; throw new Error("Lost response"); },
    async lookup(input) { lookups++; return input; },
  });
  const outcome = await execute({ operationId: "approval-1" });
  expect(outcome.status).toBe("confirmed");
  if (outcome.status !== "confirmed") throw new Error("Expected confirmation");
  expect(outcome.source).toBe("lookup");
  expect(outcome.authority.operationId).toBe("approval-1");
  expect({ sends, lookups }).toEqual({ sends: 1, lookups: 1 });
});

test("a valid acknowledgement does not confirm a mismatched business result", async () => {
  let sends = 0;
  let lookups = 0;
  const execute = contracts.createAuthoritativeCommandClient(contract, {
    async send(input) { sends++; return input; },
    async lookup() { lookups++; return { operationId: "another-operation" }; },
  });
  const outcome = await execute({ operationId: "approval-1" });
  expect(outcome.status).toBe("unknown");
  expect(outcome.diagnostics).toContainEqual({ stage: "authority", code: "AUTHORITY_MISMATCH" });
  expect({ sends, lookups }).toEqual({ sends: 1, lookups: 1 });
});

test("invalid input never reaches a transport", async () => {
  let calls = 0;
  const execute = contracts.createAuthoritativeCommandClient(contract, {
    async send() { calls++; },
    async lookup() { calls++; },
  });
  expect((await execute({ operationId: 42 })).status).toBe("invalid");
  expect(calls).toBe(0);
});

test("an invalidated scope prevents a late confirmation from updating a reused view", async () => {
  const scope = contracts.createCommandScope();
  const attempt = scope.begin("approval-1");
  let finish: ((value: unknown) => void) | undefined;
  const execute = contracts.createAuthoritativeCommandClient(contract, {
    async send(input) { return input; },
    lookup: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = execute({ operationId: "approval-1" });
  await Promise.resolve();
  if (!finish) throw new Error("Expected a pending lookup");
  scope.invalidate();
  finish({ operationId: "approval-1" });
  const result = await pending;
  let displayed = false;
  expect(result.status).toBe("confirmed");
  expect(attempt.signal.aborted).toBe(true);
  expect(attempt.commit(() => { displayed = true; })).toBe(false);
  expect(displayed).toBe(false);
  expect(scope.begin("approval-2").isCurrent()).toBe(true);
  scope.destroy();
});

test("the public contracts entrypoint bundles for the browser without the platform SDK", async () => {
  const consumer = fileURLToPath(new URL("../test/consumer-contracts.ts", import.meta.url));
  const facade = realpathSync(fileURLToPath(new URL("../dist/contracts.js", import.meta.url)));
  const sharedDist = dirname(realpathSync(fileURLToPath(import.meta.resolve("@supacloud/contracts/client"))));
  const build = await Bun.build({
    entrypoints: [consumer],
    target: "browser",
    metafile: true,
  });
  expect(build.success).toBe(true);
  const graph = build.metafile;
  if (!graph) throw new Error("Missing dependency graph");
  const inputs = Object.keys(graph.inputs).map(path => realpathSync(resolve(path)));
  expect(inputs).toContain(facade);
  for (const path of inputs) {
    expect(path === realpathSync(consumer) || path === facade || dirname(path) === sharedDist).toBe(true);
  }
  expect(inputs).not.toContain(resolve(sharedDist, "browser.js"));
  const exports = Object.values(graph.outputs).flatMap(output => output.exports);
  expect(exports).toContain("createAuthoritativeCommandClient");
  expect(exports).toContain("createCommandScope");
  for (const output of build.outputs) {
    expect(await output.text()).not.toMatch(/localStorage|navigator\.locks|SupaCloudCommandsClient|node:/);
  }
});

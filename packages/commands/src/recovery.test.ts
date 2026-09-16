import { expect, test } from "bun:test";
import type { CommandAuthorization } from "@supacloud/contracts";
import { createCommandRecoveryJob } from "./recovery";
import type { CommandRecoveryStore, RecoveryClaim } from "./store";

const claim: RecoveryClaim = {
  tenantId: "tenant", actorId: "actor", command: "remote", operationId: "op",
  leaseId: "lease", createdAt: 10, attempts: 1,
};
function fixture() {
  const released: RecoveryClaim[] = [];
  let claims = 0, before: number | undefined;
  const store: CommandRecoveryStore = {
    claim: async () => { claims++; return [{ ...claim }]; },
    release: async (value) => { released.push(value); },
    redactCompleted: async (options) => { before = options.before; return 0; },
  };
  return {
    store, released, count: () => claims, before: () => before,
    options: {
      store, tenantId: "tenant", principal: { subject: "worker" },
      authorize: (): CommandAuthorization => "allow",
      commands: { remote: { recover: async () => null } },
      batchSize: 10, leaseMs: 100, retryAfterMs: 200, alertAfterMs: 300, inputRetentionMs: 1000,
      now: () => 500,
    },
  };
}

test("bounded recovery alerts unresolved work, releases leases and clamps retention", async () => {
  const f = fixture();
  expect(await createCommandRecoveryJob(f.options).run()).toMatchObject({
    claimed: 1, unresolved: 1, failed: 0, alerts: [{ code: "COMMAND_RECOVERY_REQUIRED" }],
  });
  expect(f.released).toEqual([claim]);
  expect(f.before()).toBe(0);
});
test("handler failure releases lease and alerts without leaking exception details", async () => {
  const f = fixture();
  const report = await createCommandRecoveryJob({
    ...f.options, commands: { remote: { recover: async () => { throw new Error("credential-secret"); } } },
  }).run();
  expect(report.failed).toBe(1);
  expect(JSON.stringify(report)).not.toContain("credential-secret");
  expect(f.released).toEqual([claim]);
});
test("mismatched receipts fail validation and cannot count as completed", async () => {
  const f = fixture();
  const report = await createCommandRecoveryJob({
    ...f.options, commands: { remote: { recover: async () => ({
      ...claim, tenantId: "other", dispatchKey: "dispatch", status: "confirmed", audit: "complete", result: true,
    }) } },
  }).run();
  expect(report).toMatchObject({ completed: 0, failed: 1 });
});
test("authorization and overflow checks run before claiming any work", async () => {
  const f = fixture();
  for (const authorize of [
    (): CommandAuthorization => "deny",
    (): CommandAuthorization => { throw new Error("offline"); },
  ]) {
    await expect(createCommandRecoveryJob({ ...f.options, authorize }).run()).rejects.toThrow();
  }
  await expect(createCommandRecoveryJob({ ...f.options, now: () => Number.MAX_SAFE_INTEGER }).run()).rejects.toThrow();
  expect(() => createCommandRecoveryJob({ ...f.options, batchSize: 1001 })).toThrow();
  expect(f.count()).toBe(0);
});
test("registration snapshots tenant, principal and handler selection", async () => {
  const f = fixture(), options = { ...f.options };
  const job = createCommandRecoveryJob(options);
  options.tenantId = "other"; options.principal.subject = "other";
  options.commands.remote = { recover: async () => { throw new Error("Changed registration"); } };
  expect(await job.run()).toMatchObject({ failed: 0, unresolved: 1 });
});

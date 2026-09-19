import { describe, expect, it } from "bun:test";
import type {
  CommandRuntimeGovernance,
  CommandRuntimeInvocation,
} from "./command_runtime";

interface FixtureCommand {
  readonly name: string;
  readonly permission: string;
  readonly transaction: "required";
  readonly idempotency: "required";
  readonly audit: string;
}

type FixtureInvocation = CommandRuntimeInvocation<FixtureCommand>;

describe("command runtime contract", () => {
  it("describes one adapter boundary for authorization, receipt, transaction and audit", async () => {
    const events: string[] = [];
    const governance: CommandRuntimeGovernance<FixtureInvocation> = {
      authorize: () => { events.push("authorize"); },
      idempotency: async (_invocation, next) => { events.push("idempotency"); return next(); },
      transaction: async (_invocation, next) => { events.push("transaction"); return next(); },
      audit: {
        succeeded: () => { events.push("audit"); },
        failed: () => { events.push("audit-failed"); },
      },
      rpc: {
        update: {
          capabilities: { boundary: "database", audit: true, idempotency: true, transaction: true },
          execute: async (_invocation, next) => next(),
        },
      },
    };

    await governance.authorize({
      command: { name: "case.update", permission: "case:update", transaction: "required", idempotency: "required", audit: "case.updated" },
      input: { body: {}, params: {}, query: {} },
      request: new Request("https://example.test"),
      requestContext: {},
      services: {},
    });
    expect(governance.rpc?.update.capabilities).toEqual({
      boundary: "database", audit: true, idempotency: true, transaction: true,
    });
    expect(events).toEqual(["authorize"]);
  });
});

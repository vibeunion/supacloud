import { describe, expect, it } from "bun:test";
import {
  createApplication,
  type ApplicationOptions,
  type CommandGovernance,
  type CompiledCommand,
  type CompiledModule,
} from "./index";

const command: CompiledCommand = {
  className: "UpdateCase", name: "case.update", permission: "case:update",
  audit: "case.updated", transaction: "required", idempotency: "required",
};
const complete: CommandGovernance = {
  authorize: () => {},
  audit: { succeeded: () => {}, failed: () => {} },
  idempotency: (_invocation, next) => next(),
  transaction: (_invocation, next) => next(),
};
const rpcAdapter = {
  capabilities: { boundary: "database" as const, audit: true, idempotency: true, transaction: true },
  execute: complete.transaction!,
};

function moduleWith(descriptor: CompiledCommand = command): CompiledModule {
  return { name: "case", createServices: () => ({}), controllers: [], commands: [descriptor] };
}

function boot(governance: unknown, descriptor: CompiledCommand = command) {
  return createApplication({
    modules: [moduleWith(descriptor)],
    // Exercise JavaScript/untyped host configuration, not just valid TS input.
    commandGovernance: governance as CommandGovernance,
  });
}

function expectStartupFailure(run: () => unknown, code: string): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ status: 500, code });
}

describe("command governance startup validation", () => {
  const invalid: [string, unknown, string][] = [
    ["absent governance", undefined, "COMMAND_GOVERNANCE_UNCONFIGURED"],
    ["missing authorization", { ...complete, authorize: undefined }, "COMMAND_AUTHORIZATION_UNCONFIGURED"],
    ["non-callable authorization", { ...complete, authorize: true }, "COMMAND_AUTHORIZATION_UNCONFIGURED"],
    ["missing audit", { ...complete, audit: undefined }, "COMMAND_AUDIT_UNCONFIGURED"],
    ["incomplete audit", { ...complete, audit: { succeeded: () => {} } }, "COMMAND_AUDIT_UNCONFIGURED"],
    ["non-callable audit", { ...complete, audit: { succeeded: true, failed: () => {} } }, "COMMAND_AUDIT_UNCONFIGURED"],
    ["missing idempotency", { ...complete, idempotency: undefined }, "COMMAND_IDEMPOTENCY_UNCONFIGURED"],
    ["non-callable idempotency", { ...complete, idempotency: {} }, "COMMAND_IDEMPOTENCY_UNCONFIGURED"],
    ["missing transaction", { ...complete, transaction: undefined }, "COMMAND_TRANSACTION_UNCONFIGURED"],
    ["non-callable transaction", { ...complete, transaction: true }, "COMMAND_TRANSACTION_UNCONFIGURED"],
  ];
  for (const [name, governance, code] of invalid) {
    it(`rejects ${name} even without a command-bound HTTP route`, () => {
      expectStartupFailure(() => boot(governance), code);
    });
  }

  const invalidRpc: [string, unknown, string][] = [
    ["missing adapter", undefined, "COMMAND_RPC_UNCONFIGURED"],
    ["non-callable executor", { ...rpcAdapter, execute: true }, "COMMAND_RPC_UNCONFIGURED"],
    ["missing capabilities", { execute: rpcAdapter.execute }, "COMMAND_RPC_UNCONFIGURED"],
    ["null capabilities", { ...rpcAdapter, capabilities: null }, "COMMAND_RPC_UNCONFIGURED"],
    ["missing audit capability", { ...rpcAdapter, capabilities: { ...rpcAdapter.capabilities, audit: false } }, "COMMAND_AUDIT_UNCONFIGURED"],
    ["missing idempotency capability", { ...rpcAdapter, capabilities: { ...rpcAdapter.capabilities, idempotency: false } }, "COMMAND_IDEMPOTENCY_UNCONFIGURED"],
    ["missing transaction capability", { ...rpcAdapter, capabilities: { ...rpcAdapter.capabilities, transaction: false } }, "COMMAND_TRANSACTION_UNCONFIGURED"],
  ];
  for (const [name, adapter, code] of invalidRpc) {
    it(`rejects an RPC with ${name}`, () => {
      expectStartupFailure(() => boot({
        ...complete, rpc: { update_case: adapter },
      }, { ...command, rpc: "update_case" }), code);
    });
  }

  it("does not accept inherited RPC adapters or treat an empty RPC name as a local command", () => {
    expectStartupFailure(() => boot({
      ...complete, rpc: Object.create({ update_case: rpcAdapter }),
    }, { ...command, rpc: "update_case" }), "COMMAND_RPC_UNCONFIGURED");
    expectStartupFailure(() => boot(complete, { ...command, rpc: "" }), "COMMAND_RPC_UNCONFIGURED");
  });

  it("validates authorization for RPC commands as well as local commands", () => {
    expectStartupFailure(() => boot({
      rpc: { update_case: rpcAdapter },
    }, { ...command, rpc: "update_case" }), "COMMAND_AUTHORIZATION_UNCONFIGURED");
  });

  it("checks callable ports without invoking any business adapter at startup", () => {
    const calls: string[] = [];
    const governance: CommandGovernance = {
      authorize: () => { calls.push("authorize"); },
      audit: {
        succeeded: () => { calls.push("audit-success"); },
        failed: () => { calls.push("audit-failure"); },
      },
      idempotency: (_invocation, next) => { calls.push("idempotency"); return next(); },
      transaction: (_invocation, next) => { calls.push("transaction"); return next(); },
      rpc: {
        update_case: {
          ...rpcAdapter,
          execute: (_invocation, next) => { calls.push("rpc"); return next(); },
        },
      },
    };
    expect(() => boot(governance)).not.toThrow();
    expect(() => boot(governance, { ...command, rpc: "update_case" })).not.toThrow();
    expect(calls).toEqual([]);
  });

  it("preserves the explicit custom-executor escape hatch but rejects non-callable executors", () => {
    const options: ApplicationOptions = {
      modules: [moduleWith()], commandExecutor: (_invocation, next) => next(),
    };
    expect(() => createApplication(options)).not.toThrow();
    expectStartupFailure(() => createApplication({
      ...options, commandExecutor: true as unknown as NonNullable<ApplicationOptions["commandExecutor"]>,
    }), "COMMAND_EXECUTOR_UNCONFIGURED");
  });

  it("does not require governance for modules without commands", () => {
    const module = { ...moduleWith(), commands: [] };
    expect(() => createApplication({ modules: [module] })).not.toThrow();
  });
});

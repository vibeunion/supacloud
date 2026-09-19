import { expect, spyOn, test } from "bun:test";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase } from "@supacloud/db";
import type { CommandInvocation } from "./index";
import { createWebhookMigrationExample, executeWebhookCommand } from "./webhook-migration-example";
import { createCompiledModules } from "./fixtures/webhook-generated/application";
import { WebhookEnvironment } from "./fixtures/webhook/environment";
import { UpdateWebhook } from "./fixtures/webhook/update.command";

function fixture() {
  const calls: string[] = [];
  const database: CommandDatabase = {
    async transaction<T>(): Promise<T> {
      calls.push("database");
      throw new Error("No database work is allowed during composition");
    },
  };
  const environment = new WebhookEnvironment(
    createPostgresCommandStore(database),
    async () => { calls.push("authorize"); return "deny"; },
    async () => { calls.push("audit"); },
  );
  const module = createCompiledModules().find((item) => item.name === "webhook");
  if (!module) throw new Error("Generated webhook module is missing");
  const descriptor = module.commands.find((item) => item.className === "UpdateWebhook");
  if (!descriptor) throw new Error("Generated webhook command is missing");
  const services = module.createServices({ webhookEnvironment: environment }, {});
  const command = services.updateWebhook;
  if (!(command instanceof UpdateWebhook)) throw new Error("Generated command service is missing");
  const identity = { tenantId: "tenant-1", actorId: "actor-1" };
  const invocation: CommandInvocation = {
    command: descriptor, services,
    request: new Request("http://localhost/webhooks/update", {
      method: "POST", headers: { "idempotency-key": "operation-1" },
    }),
    requestContext: identity,
    input: { body: { id: "webhook-1", enabled: true }, params: {}, query: {} },
  };
  return { database, environment, module, command, identity, invocation, calls };
}

test("webhook composition registers native governance without a database or startup side effects", () => {
  const f = fixture();
  const example = createWebhookMigrationExample({
    database: f.database,
    authenticate: async () => { f.calls.push("authenticate"); return f.identity; },
    authorize: f.environment.authorize,
    writeAudit: f.environment.writeAudit,
  });
  expect(example.modules[0]?.commands[0]?.rpc).toBe("webhookUpdate");
  expect(typeof example.app.handle).toBe("function");
  expect(f.calls).toEqual([]);
});

test("registered webhook executor delegates to the generated persistent service and never runs a second handler", async () => {
  const f = fixture();
  const execute = spyOn(f.command, "execute").mockRejectedValue(new CommandError("COMMAND_REJECTED"));
  try {
    await expect(executeWebhookCommand(f.invocation, () => { f.calls.push("continuation"); })).rejects.toMatchObject({
      status: 403, code: "COMMAND_REJECTED",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(f.identity, "operation-1", f.invocation.input.body);
    expect(f.calls).toEqual([]);
  } finally { execute.mockRestore(); }
});

test("webhook executor cannot obtain trusted identity from a forged request body", async () => {
  const f = fixture();
  const execute = spyOn(f.command, "execute");
  try {
    await expect(executeWebhookCommand({
      ...f.invocation, requestContext: {},
      input: { ...f.invocation.input, body: { ...f.identity, id: "webhook-1", enabled: true } },
    }, () => { f.calls.push("continuation"); })).rejects.toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  } finally { execute.mockRestore(); }
});

test("webhook executor rejects a missing operation key before native execution", async () => {
  const f = fixture();
  const execute = spyOn(f.command, "execute");
  try {
    await expect(executeWebhookCommand({
      ...f.invocation, request: new Request("http://localhost/webhooks/update", { method: "POST" }),
    }, () => { f.calls.push("continuation"); })).rejects.toMatchObject({
      status: 400, code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  } finally { execute.mockRestore(); }
});

test("webhook registration fails closed for unknown descriptors, weaker policies and missing services", async () => {
  const f = fixture();
  const execute = spyOn(f.command, "execute");
  try {
    for (const patch of [
      { className: "OtherCommand" }, { name: "other.update" }, { rpc: "otherUpdate" },
      { permission: "other.update" }, { audit: "" }, { transaction: "none" }, { idempotency: "none" },
    ]) {
      await expect(executeWebhookCommand({
        ...f.invocation, command: { ...f.invocation.command, ...patch },
      }, () => { f.calls.push("continuation"); })).rejects.toMatchObject({ code: "COMMAND_NOT_REGISTERED" });
    }
    await expect(executeWebhookCommand({
      ...f.invocation, services: {},
    }, () => { f.calls.push("continuation"); })).rejects.toMatchObject({ code: "COMMAND_NOT_REGISTERED" });
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  } finally { execute.mockRestore(); }
});

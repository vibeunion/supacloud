import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSupacloudConfig } from "./config";
import { compileProject, checkProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import { validateGraph } from "./validate";
import type { ApplicationGraph, CommandExecutionCapabilities } from "./types";

function graph(transaction: "required" | "none" = "required"): ApplicationGraph {
  return {
    externalTokens: [],
    modules: [{
      name: "webhook", className: "WebhookModule", file: "webhook.module.ts", line: 1,
      imports: [], providers: [], controllers: [], queries: [], exports: [],
      commands: [{
        className: "UpdateWebhook", name: "webhook.update.v1", permission: "webhook.update",
        rpc: "update", audit: "webhook.updated", idempotency: "required", transaction,
      }],
    }],
  };
}

test("persistent command profile accepts database and external adapters with truthful boundaries", () => {
  for (const boundary of ["database", "external"] as const) {
    const capabilities: CommandExecutionCapabilities = {
      requirePersistentAdapters: true, permission: true,
      rpc: { update: { boundary, audit: true, idempotency: true, transaction: boundary === "database" } },
    };
    expect(validateGraph(graph(boundary === "database" ? "required" : "none"), { commandCapabilities: capabilities })
      .filter((item) => item.code.startsWith("command-"))).toEqual([]);
  }
});

test("external effects cannot acquire transaction guarantees from metadata", () => {
  const diagnostics = validateGraph(graph(), { commandCapabilities: {
    rpc: { update: { boundary: "external", audit: true, idempotency: true, transaction: false } },
  } });
  expect(diagnostics.some((item) => item.code === "command-external-transaction" && item.severity === "error")).toBe(true);
});

test("persistent profile rejects unproven adapters and weak command policy", () => {
  const diagnostics = validateGraph(graph(), { commandCapabilities: {
    requirePersistentAdapters: true, rpc: { update: { audit: true, idempotency: true, transaction: true } },
  } });
  expect(diagnostics.some((item) => item.code === "command-persistence-required")).toBe(true);
});

test("untrusted configuration rejects mistyped persistence capabilities", () => {
  for (const capabilities of [null, [], { requirePersistentAdapters: "true" },
    { rpc: [] }, { rpc: { update: { boundary: "external", transaction: true } } },
    { rpc: { update: { boundary: "magical" } } }, { rpc: { update: { idempotency: "yes" } } }]) {
    expect(() => Reflect.apply(defineSupacloudConfig, undefined, [{ commandCapabilities: capabilities }])).toThrow();
  }
});

test("a complete decorated module retains the persistent binding and refuses an unsafe external migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-webhook-migration-"));
  try {
    await writeFixtureProject(root, { "webhook.ts": `
import { Module, Controller, Command, Post, Body } from "@supacloud/app";
import { t } from "elysia";
export const Input = t.Object({ id: t.String(), enabled: t.Boolean() });
export const Receipt = t.Object({ status: t.Literal("confirmed"), result: Input });
@Command({ name: "webhook.update.v1", permission: "webhook.update", rpc: "webhookUpdate",
  transaction: "required", audit: "webhook.updated", idempotency: "required" })
export class UpdateWebhook {}
@Controller("/webhooks")
export class WebhookController {
  @Post("/update", { body: Input, response: Receipt, command: UpdateWebhook })
  update(@Body() input: unknown): never { throw new Error("Persistent adapter required"); }
}
@Module({ name: "webhook", controllers: [WebhookController], commands: [UpdateWebhook] })
export class WebhookModule {}
` });
    const options = {
      rootDir: root, outDir: join(root, "generated"), requireRouteContracts: true,
      commandCapabilities: {
        requirePersistentAdapters: true, permission: true,
        rpc: { webhookUpdate: { boundary: "database" as const, audit: true, transaction: true, idempotency: true } },
      },
    };
    const compiled = await compileProject(options);
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.graph.modules[0]?.controllers[0]?.routes[0]?.command).toBe("UpdateWebhook");
    const generated = await Bun.file(join(root, "generated/application.ts")).text();
    expect(generated).toContain('rpc: "webhookUpdate"');
    expect((await checkProject(options)).upToDate).toBe(true);
    const failed = await compileProject({
      ...options, commandCapabilities: {
        ...options.commandCapabilities,
        rpc: { webhookUpdate: { boundary: "external", audit: true, transaction: false, idempotency: true } },
      },
    });
    expect(failed.written).toEqual([]);
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({
      code: "command-external-transaction", severity: "error",
      suggestion: expect.stringContaining("reconciliation"),
    }));
    expect(await Bun.file(join(root, "generated/application.ts")).text()).toBe(generated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import { inspectRouteContracts } from "./route-contracts";
import { createExecutionPlans } from "./inspect";

async function fixture(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "consumer-governance-"));
  try {
    await writeFixtureProject(root, { "app.ts": source });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const source = `
import { Module, Controller, Command, Post, Delete, Body } from "@supacloud/app";
const Type = { Unknown: () => ({}) };
export const Input = Type.Unknown();
export const Result = {};
@Command({name: "remove", permission: "remove", rpc: "remove_item", transaction: "required", audit: "removed", idempotency: "required"})
export class Remove {}
@Controller("/items")
export class Items {
  @Post("/delete", {body: Input, response: Result, contract: {body: "domain", response: "native-json", evidence: "items.test.ts"}})
  remove(@Body() body: unknown): Response { return new Response(JSON.stringify(body)); }
}
@Module({name: "items", controllers: [Items], commands: [Remove]})
export class ItemsModule {}
`;
test("POST command protocol, RPC descriptor and honest contracts survive compilation", async () => {
  await fixture(source, async (rootDir) => {
    const result = await compileProject({ rootDir, outDir: join(rootDir, "generated"), strict: false,
      commandCapabilities: { audit: false, idempotency: false, transaction: "rpc-only",
        rpc: { remove_item: { audit: true, transaction: true, idempotency: true } } } });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const generated = await Bun.file(join(rootDir, "generated/application.ts")).text();
    expect(generated).toContain('rpc: "remove_item"');
    expect(generated).toContain("req.body");
    expect(inspectRouteContracts(result.graph)[0]?.validation).toMatchObject({
      body: "domain", response: "native-json", schemas: { body: "opaque" }, verified: false,
    });
    expect(createExecutionPlans(result.graph).find((p) => p.kind === "command")?.stages).toContain("rpc:remove_item");
  });
});
test("DELETE bodies remain forbidden and RPC requires a configured adapter", async () => {
  await fixture(source.replace('@Post("/delete"', '@Delete("/delete"'), async (rootDir) => {
    const result = await compileProject({ rootDir, outDir: join(rootDir, "generated"), strict: false });
    expect(result.diagnostics.some((d) => d.code === "disallowed-body-on-get-delete")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "command-rpc-unavailable")).toBe(true);
    expect(result.written).toEqual([]);
  });
});
test("opaque and native response are detected without owner annotations", async () => {
  await fixture(source.replace(', contract: {body: "domain", response: "native-json", evidence: "items.test.ts"}', ""), async (rootDir) => {
    const result = await compileProject({ rootDir, outDir: join(rootDir, "generated"), strict: false });
    expect(inspectRouteContracts(result.graph)[0]?.validation).toMatchObject({
      body: "opaque", response: "native-response-unclassified", verified: false,
    });
  });
});

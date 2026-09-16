import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";

test("named headers compile to lower-case selection while unnamed headers preserve the map", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-headers-"));
  try {
    await writeFixtureProject(root, { "webhook.ts": `
import { Module, Controller, Get, Headers } from "@supacloud/app";
@Controller("/headers")
export class HeaderController {
  @Get("/")
  read(@Headers("Idempotency-Key") key: unknown, @Headers() all: unknown) { return { key, all }; }
}
@Module({ name: "headers", controllers: [HeaderController] })
export class HeaderModule {}
` });
    const result = await compileProject({ rootDir: root, outDir: join(root, "generated") });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.graph.modules[0]?.controllers[0]?.routes[0]?.handlerParams).toMatchObject([
      { kind: "headers", bindingName: "Idempotency-Key" }, { kind: "headers" },
    ]);
    const output = await Bun.file(join(root, "generated/application.ts")).text();
    expect(output).toContain('[req.headers?.["idempotency-key"], req.headers]');
  } finally { await rm(root, { recursive: true, force: true }); }
});

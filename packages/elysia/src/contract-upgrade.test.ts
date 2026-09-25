import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "elysia";
import * as ts from "@typescript/typescript6";
import { compileProject, migrateProject } from "@supacloud/compiler";
import { createApplication, type CompiledModule } from "./index";

interface GeneratedApplication {
  createCompiledModules(): CompiledModule[];
}
interface GeneratedClient {
  decodeResponseSchema(value: unknown, status: number, schemas: Record<string, unknown>): unknown;
  createApiClient(options: { baseUrl: string }): {
    acceptance: {
      read(input: { query: { count: string } }): Promise<unknown>;
      write(input: { body: { note?: string | null } }): Promise<unknown>;
    };
  };
}

test("fixed legacy fixture upgrades, compiles, types, serves and restores from a source checkpoint", async () => {
  const started = performance.now();
  const phase = (name: string) => {
    if (process.env.SUPACLOUD_TEST_TIMINGS === "1") console.info(`contract-upgrade: ${name} ${Math.round(performance.now() - started)}ms`);
  };
  const root = await mkdtemp(join(tmpdir(), "supacloud-contract-upgrade-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    await mkdir(join(root, "src"));
    // Resolve the real built dependencies, not stubs, for compilation and HTTP execution.
    const dependencies = resolve(import.meta.dir, "../node_modules");
    await mkdir(join(root, "node_modules/@supacloud"), { recursive: true });
    for (const name of await readdir(dependencies)) {
      if (name === "@supacloud") continue;
      await symlink(join(dependencies, name), join(root, "node_modules", name), "dir");
    }
    for (const name of await readdir(join(dependencies, "@supacloud"))) {
      await symlink(join(dependencies, "@supacloud", name), join(root, "node_modules/@supacloud", name), "dir");
    }
    await symlink(resolve(import.meta.dir, ".."), join(root, "node_modules/@supacloud/elysia"), "dir");
    const original = await readFile(new URL("./fixtures/acceptance-v011/application.ts.txt", import.meta.url), "utf8");
    const sourcePath = join(root, "src/application.ts");
    await writeFile(sourcePath, original);
    const backup = join(root, "checkpoint.txt");
    await cp(sourcePath, backup);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, experimentalDecorators: true, target: "ES2022",
        module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    }));
    const migrationOptions = {
      rootDir: root, include: ["src/**/*.ts"], fromVersion: "0.11.0", toVersion: "0.12.0",
    };
    phase("migration preview start");
    const preview = await migrateProject(migrationOptions);
    phase("migration preview end");
    expect(preview.issues).toEqual([]);
    expect(preview.changedFiles).toEqual(["src/application.ts"]);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    const applied = await migrateProject({ ...migrationOptions, write: true });
    phase("migration write end");
    expect(applied.issues).toEqual([]);
    expect(applied.changedFiles).toEqual(["src/application.ts"]);
    expect((await migrateProject({ ...migrationOptions, write: true })).changedFiles).toEqual([]);
    phase("migration idempotence end");

    const compileOptions = {
      rootDir: root, include: ["src/**/*.ts"], outDir: join(root, "generated"),
      strict: true, requireRouteContracts: true, generateClient: true, generateOpenApi: true,
    };
    const compilation = await compileProject(compileOptions);
    phase("compilation end");
    expect(compilation.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(compilation.graph.modules).toHaveLength(1);

    const consumer = [
      'import { createApiClient } from "./generated/client";',
      "const api = createApiClient();",
      "const read: Promise<{ note: string | null; count: number; tag?: string }> = api.acceptance.read({ query: { count: '7' } });",
      "const write: Promise<{ note: string | null; count: number; tag?: string } | { conflict: true }> = api.acceptance.write({ body: {} });",
      "api.acceptance.write({ body: { note: null } });",
      "// @ts-expect-error The wire query is encoded as a string, not its decoded number.",
      "api.acceptance.read({ query: { count: 7 } });",
      "// @ts-expect-error Optional nullable does not mean an arbitrary value.",
      "api.acceptance.write({ body: { note: false } });",
      "// @ts-expect-error A status branch cannot disappear from the output union.",
      "const missingConflict: Promise<{ count: number }> = api.acceptance.write({ body: {} });",
    ].join("\n");
    await writeFile(join(root, "consumer.ts"), consumer);
    const typeOptions: ts.CompilerOptions = {
      strict: true, exactOptionalPropertyTypes: true, noEmit: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
      types: [], experimentalDecorators: true,
    };
    const diagnostics = (source: string) => ts.getPreEmitDiagnostics(
      ts.createProgram([join(root, source)], typeOptions),
    ).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics("consumer.ts")).toEqual([]);
    phase("consumer TypeScript API end");
    // Prove the negative assertions really fail rather than relying on permissive types.
    await writeFile(join(root, "negative.ts"), consumer.replaceAll("// @ts-expect-error", "// expected failure"));
    expect(diagnostics("negative.ts").length).toBeGreaterThanOrEqual(3);
    phase("negative TypeScript API end");
    for (const file of ["consumer.ts", "negative.ts"]) {
      const configPath = join(root, `typecheck-${file}.json`);
      await writeFile(configPath, JSON.stringify({
        compilerOptions: {
          strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
          experimentalDecorators: true, target: "ES2022", module: "ESNext",
          moduleResolution: "Bundler", types: [],
        }, files: [file], include: [],
      }));
      const child = Bun.spawn([
        resolve(import.meta.dir, "../node_modules/.bin/tsc"),
        "--project", configPath,
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
      let result: [number, string, string];
      try {
        result = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      const [exit, stdout, stderr] = result;
      expect(timedOut).toBe(false);
      phase(`${file} TypeScript CLI end`);
      if (file === "consumer.ts") expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
      else {
        expect(exit).not.toBe(0);
        expect(stdout).toContain("negative.ts");
      }
    }

    const generated: GeneratedApplication = await import(pathToFileURL(join(root, "generated/application.ts")).href);
    phase("runtime start");
    const errors: unknown[] = [];
    const app = createApplication({
      modules: generated.createCompiledModules(),
      errorMapper: (error) => { errors.push(error); return undefined; },
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handle(request) });
    stop = async () => { await server.stop(true); };
    const probe = await fetch(new URL("/acceptance/item?count=7", server.url));
    expect({ status: probe.status, errors: errors.map(String) }).toEqual({ status: 200, errors: [] });
    expect(await probe.json()).toEqual({ note: null, count: 7 });
    const generatedClient: GeneratedClient = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const client = generatedClient.createApiClient({ baseUrl: server.url.origin });
    expect(() => generatedClient.decodeResponseSchema("7", 200, {
      "200": t.Transform(t.String()).Decode(Number).Encode(String),
    })).toThrow("Response schema transforms are unsupported");
    expect(await client.acceptance.read({ query: { count: "7" } })).toEqual({ note: null, count: 7 });
    expect(await client.acceptance.write({ body: {} })).toEqual({ note: null, count: 0 });
    expect(await client.acceptance.write({ body: { note: null } })).toEqual({ note: null, count: 0 });
    expect(await client.acceptance.write({ body: { note: "conflict" } })).toEqual({ conflict: true });
    const invalid = await fetch(new URL("/acceptance/item", server.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"note":false}',
    });
    expect(invalid.status).toBe(422);
    await invalid.arrayBuffer();
    const openApi: { OPENAPI_DOCUMENT: unknown } = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
    expect(openApi.OPENAPI_DOCUMENT).toMatchObject({
      paths: {
        "/acceptance/item": {
          get: { parameters: [{ name: "count", in: "query", required: true, schema: { type: "string" } }] },
          post: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/ResultSchema" } } } },
              "409": { content: { "application/json": { schema: { $ref: "#/components/schemas/ConflictSchema" } } } },
            },
          },
        },
      },
      components: { schemas: {
        ResultSchema: {
          required: ["note", "count"],
          properties: {
            count: { type: "number" },
            note: { anyOf: [{ type: "string" }, { type: "null" }] },
            tag: { type: "string" },
          },
        },
        BodySchema: { properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } } },
        ConflictSchema: { required: ["conflict"], properties: { conflict: { const: true } } },
      } },
    });

    await stop();
    stop = undefined;
    // Rollback restores source and regenerates matching artifacts as one unit.
    await cp(backup, sourcePath);
    await rm(join(root, "generated"), { recursive: true });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    const restored = await compileProject(compileOptions);
    phase("rollback compilation end");
    expect(restored.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const rollbackUrl = pathToFileURL(join(root, "generated/application.ts"));
    rollbackUrl.searchParams.set("checkpoint", "restored");
    const rollback: GeneratedApplication = await import(rollbackUrl.href);
    const rollbackApp = createApplication({ modules: rollback.createCompiledModules() });
    const response = await rollbackApp.handle(new Request("http://localhost/acceptance/item?count=9"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ note: null, count: 9 });
  } finally {
    await stop?.();
    await rm(root, { recursive: true, force: true });
  }
  // Multiple real dependency graphs plus two isolated TS CLI runs are expensive
  // on cold filesystems. Keep all positive/negative checks within a bounded budget.
}, 600_000);

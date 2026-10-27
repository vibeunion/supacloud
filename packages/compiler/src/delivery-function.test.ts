import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { parseDeliveryBuildManifest } from "./delivery-build-schema";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

const hostSource = `export function createDeliveryApplication(_modules: unknown[]) {
  return {
    fetch(request: Request) {
      return new Response("function-host:" + new URL(request.url).pathname);
    },
  };
}`;

test("builds a module-owned Function target and moves its routes off the API", async () => {
  const project = await mkdtemp(join(tmpdir(), "delivery-function-module-"));
  try {
    await writeFixtureProject(project, {
      "package.json": JSON.stringify({ name: "delivery-function-fixture", private: true, type: "module" }),
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
      "src/health.ts": `import { Module, Controller, Get } from "./runtime";
        @Controller("/health") export class HealthController {
          @Get("/", {response: {type: "string"}}) status(): string {return "ready";}
        }
        @Module({name: "health", controllers: [HealthController]}) export class HealthModule {}`,
      "src/host.ts": hostSource,
    });
    const result = await buildDeliveryProject({
      rootDir: join(project, "src"), outDir: join(project, "generated"),
      strict: false, generateClient: false, generatePermissions: false, requireRouteContracts: false,
    }, {
      version: 1,
      functions: [{
        slug: "health-fn", modules: ["health"],
        entrypoint: "host.ts", verifyJwt: true,
      }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const target = requireValue(result.manifest.plan.targets.find((item) => item.name === "health-fn"));
    expect(target.kind).toBe("function");
    expect(target.modules.map((module) => module.name)).toEqual(["health"]);
    expect(target.routes.map((route) => route.path)).toEqual(["/health"]);
    expect(result.manifest.routes).toEqual([{ method: "GET", path: "/health", target: "health-fn" }]);
    expect(result.manifest.plan.targets.some((item) => item.name === "api")).toBe(false);

    const object = requireValue(result.manifest.objects[0]);
    expect(object.entryKind).toBe("bun-function-application");
    expect(parseDeliveryBuildManifest(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest);
    expect(() => parseDeliveryBuildManifest({
      ...result.manifest, objects: [{ ...object, entryKind: "bun-http-application" }],
    })).toThrow("Delivery executable kind does not match its target.");
    const bundle = join(project, "generated/delivery/objects", object.objectId, "bundle");
    expect(JSON.parse(await readFile(join(bundle, "function.json"), "utf8")))
      .toEqual({ slug: "health-fn", entrypoint: "host.ts", verifyJwt: true });
    const loaded = await import(join(bundle, "index.js"));
    const handler = loaded.default as { fetch(request: Request): Response | Promise<Response> };
    expect(await (await handler.fetch(new Request("http://edge.test/health"))).text())
      .toBe("function-host:/health");
  } finally { await rm(project, { recursive: true, force: true }); }
}, 120_000);

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const functionsRoot = await mkdtemp(join(tmpdir(), "supacloud-edge-functions-"));
const originalFunctionsDir = process.env.EDGE_FUNCTIONS_DIR;
const originalRuntimeInternal = process.env.EDGE_RUNTIME_INTERNAL;
const originalExternalPackages = process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES;
const originalFetch = globalThis.fetch;

mock.restore();
process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

const { edgeFunctionService, getVersionedArtifactPath } = await import(
  "../../src/services/edge-function.service"
);

afterEach(() => {
  process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES = originalExternalPackages ?? "";
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (originalFunctionsDir === undefined) {
    delete process.env.EDGE_FUNCTIONS_DIR;
  } else {
    process.env.EDGE_FUNCTIONS_DIR = originalFunctionsDir;
  }
  if (originalRuntimeInternal === undefined) {
    delete process.env.EDGE_RUNTIME_INTERNAL;
  } else {
    process.env.EDGE_RUNTIME_INTERNAL = originalRuntimeInternal;
  }
  if (originalExternalPackages === undefined) {
    delete process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES;
  } else {
    process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES = originalExternalPackages;
  }
  globalThis.fetch = originalFetch;
  await rm(functionsRoot, { recursive: true, force: true });
});

describe("edgeFunctionService bundle metadata", () => {
  test("keeps multi-file runtime code beside its static assets", async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({ ok: true }))) as typeof fetch;

    const deployResult = await edgeFunctionService.deployBundleDetailed(
      "proj_assets",
      "asset-reader",
      {
        "index.ts": `
          export default {
            async fetch() {
              const asset = await Bun.file(import.meta.dir + "/public/message.txt").text();
              return new Response(asset);
            }
          };
        `,
        "public/message.txt": "asset-from-source-dir",
      },
    );

    expect(deployResult.success).toBe(true);
    const runtimeEntry = join(
      functionsRoot,
      "proj_assets",
      ".src-asset-reader",
      ".supacloud-entry.js",
    );
    const versionedRuntimeEntry = join(
      functionsRoot,
      "proj_assets",
      ".versions",
      "asset-reader",
      "1",
      "src",
      ".supacloud-entry.js",
    );
    expect(existsSync(runtimeEntry)).toBe(true);
    expect(existsSync(versionedRuntimeEntry)).toBe(true);
    const runtimeModule = await import(`${pathToFileURL(runtimeEntry).href}?test=${Date.now()}`);
    const runtimeResponse = await runtimeModule.default.fetch(new Request("http://localhost/"));
    expect(await runtimeResponse.text()).toBe("asset-from-source-dir");
  });

  test("rejects a bundle upload that collides with the runtime entry", async () => {
    const deployResult = await edgeFunctionService.deployBundleDetailed(
      "proj_reserved",
      "reserved-entry",
      {
        "index.ts": "export default { fetch: () => new Response('ok') };",
        ".supacloud-entry.js": "user-controlled",
      },
    );

    expect(deployResult).toEqual({
      success: false,
      error: "Bundle path '.supacloud-entry.js' is reserved by the runtime",
    });
  });

  test("writes content-addressed version artifacts and returns deploy preheat metadata", async () => {
    const metricsBefore = edgeFunctionService.deployMetrics();
    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/preheat/")) {
        return Promise.resolve(Response.json({
          success: true,
          foreground: {
            attempted: 2,
            succeeded: 2,
            cacheHits: 0,
            cacheMisses: 2,
            durationMs: 12,
          },
          background: {
            attempted: 1,
            succeeded: 1,
            cacheHits: 1,
            cacheMisses: 0,
            durationMs: 4,
          },
        }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES = "left-pad,@scope/pkg,invalid/pkg/name";

    const result = await edgeFunctionService.deployBundleDetailed(
      "proj_meta",
      "hello",
      {
        "index.ts": `
          import leftPad from "left-pad";
          import { message } from "./_shared/message";
          export default {
            fetch() {
              return new Response(leftPad(message, 7, "!"));
            }
          }
        `,
        "_shared/message.ts": `export const message = "hello";`,
      },
      "index.ts",
      false,
    );

    expect(result.success).toBe(true);
    expect(result.version).toBe("1");
    expect(result.bundle_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.bundle_size_bytes).toBeGreaterThan(0);
    expect(result.import_count).toBe(2);
    expect(result.external_packages).toEqual(["left-pad", "@scope/pkg"]);
    expect(result.preheat).toMatchObject({
      ok: true,
      attempted: 3,
      succeeded: 3,
      cache_hits: 1,
      cache_misses: 2,
    });

    expect(result.content_path).toBeTruthy();
    expect(existsSync(result.content_path!)).toBe(true);
    expect(existsSync(join(functionsRoot, "proj_meta", ".versions", "hello", "1", "index.js"))).toBe(true);
    expect(await getVersionedArtifactPath("proj_meta", "hello", "1")).toBe(result.content_path);

    const detail = await edgeFunctionService.getVersion("proj_meta", "hello", "1");
    expect(detail?.bundle_path).toBe(result.content_path);
    expect(detail?.has_bundle).toBe(true);
    expect(detail?.bundle_code).toContain("hello");

    const metricsAfter = edgeFunctionService.deployMetrics();
    expect(metricsAfter).toMatchObject({
      total_deploys: metricsBefore.total_deploys + 1,
      total_bundle_size_bytes: metricsBefore.total_bundle_size_bytes + result.bundle_size_bytes!,
      last_bundle_size_bytes: result.bundle_size_bytes,
      total_import_count: metricsBefore.total_import_count + 2,
      last_import_count: 2,
      total_preheat_duration_ms: metricsBefore.total_preheat_duration_ms + result.preheat!.duration_ms,
      last_preheat_duration_ms: result.preheat?.duration_ms,
      total_preheat_attempted: metricsBefore.total_preheat_attempted + 3,
      total_preheat_succeeded: metricsBefore.total_preheat_succeeded + 3,
      total_preheat_cache_hits: metricsBefore.total_preheat_cache_hits + 1,
      total_preheat_cache_misses: metricsBefore.total_preheat_cache_misses + 2,
    });

    expect(fetchCalls.some((url) => url.includes("/invalidate/proj_meta/hello"))).toBe(true);
    expect(fetchCalls.some((url) => url.includes("/preheat/proj_meta/hello"))).toBe(true);
  });
});

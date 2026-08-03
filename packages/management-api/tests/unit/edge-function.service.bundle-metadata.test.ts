import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  test("allocates after retained history instead of overwriting a rolled-back version", async () => {
    const ref = "proj_rollback_history";
    const slug = "history-safe";
    globalThis.fetch = ((_input, init) => {
      const requestedVersion = new Headers(init?.headers).get("x-supacloud-function-version");
      return Promise.resolve(Response.json({ success: true, version: requestedVersion }));
    }) as typeof fetch;

    const v1 = await edgeFunctionService.deployBundleDetailed(ref, slug, {
      "index.ts": "export default { fetch: () => new Response('v1') };",
    });
    const v2 = await edgeFunctionService.deployBundleDetailed(ref, slug, {
      "index.ts": "export default { fetch: () => new Response('retained-v2') };",
    });

    expect(v1).toMatchObject({ success: true, version: "1" });
    expect(v2).toMatchObject({ success: true, version: "2" });

    const v2Bundle = await readFile(v2.content_path!);
    const v2SourcePath = join(functionsRoot, ref, ".versions", slug, "2", "src", "index.ts");
    const v2Source = await readFile(v2SourcePath);
    const v2BundleHash = createHash("sha256").update(v2Bundle).digest("hex");
    const v2SourceHash = createHash("sha256").update(v2Source).digest("hex");

    await edgeFunctionService.activateVersion(ref, slug, "1");

    const result = await edgeFunctionService.deployBundleDetailed(ref, slug, {
      "index.ts": "export default { fetch: () => new Response('new-v3') };",
    });

    expect(result).toMatchObject({ success: true, version: "3" });
    expect(createHash("sha256").update(await readFile(v2.content_path!)).digest("hex")).toBe(v2BundleHash);
    expect(createHash("sha256").update(await readFile(v2SourcePath)).digest("hex")).toBe(v2SourceHash);
    expect(existsSync(join(functionsRoot, ref, ".versions", slug, "3", "src", "index.ts"))).toBe(true);
  });

  test("starts at version 1 when neither config nor version history exists", async () => {
    const result = await edgeFunctionService.deployBundleDetailed("proj_first_version", "first", {
      "index.ts": "export default { fetch: () => new Response('first') };",
    });

    expect(result).toMatchObject({ success: true, version: "1" });
  });

  test("ignores malformed history directory names", async () => {
    const ref = "proj_bad_history";
    const slug = "bad-history";
    const versionDir = join(functionsRoot, ref, ".versions", slug);
    await Promise.all([
      mkdir(join(versionDir, "not-a-version"), { recursive: true }),
      mkdir(join(versionDir, "01"), { recursive: true }),
    ]);
    await edgeFunctionService.updateConfig(ref, slug, { version: "1" });

    const result = await edgeFunctionService.deployBundleDetailed(ref, slug, {
      "index.ts": "export default { fetch: () => new Response('next') };",
    });

    expect(result).toMatchObject({ success: true, version: "2" });
    expect(existsSync(join(versionDir, "not-a-version"))).toBe(true);
    expect(existsSync(join(versionDir, "01"))).toBe(true);
  });

  test("fails closed for unsafe numeric history and config versions", async () => {
    const unsafeVersion = "9007199254740992";
    const historyRef = "proj_unsafe_history";
    const historySlug = "unsafe-history";
    await mkdir(join(functionsRoot, historyRef, ".versions", historySlug, unsafeVersion), { recursive: true });

    const historyResult = await edgeFunctionService.deployBundleDetailed(historyRef, historySlug, {
      "index.ts": "export default { fetch: () => new Response('blocked') };",
    });

    expect(historyResult).toMatchObject({ success: false, error: "Function version exceeds the safe integer range" });

    const configRef = "proj_unsafe_config";
    const configSlug = "unsafe-config";
    await edgeFunctionService.updateConfig(configRef, configSlug, { version: unsafeVersion });

    const configResult = await edgeFunctionService.deployBundleDetailed(configRef, configSlug, {
      "index.ts": "export default { fetch: () => new Response('blocked') };",
    });

    expect(configResult).toMatchObject({ success: false, error: "Function version exceeds the safe integer range" });
  });

  test("serializes single-file and bundle deployments for the same function", async () => {
    const ref = "proj_concurrent";
    const slug = "same-function";
    const [bundleResult, singleResult] = await Promise.all([
      edgeFunctionService.deployBundleDetailed(ref, slug, {
        "index.ts": "export default { fetch: () => new Response('bundle-marker') };",
      }),
      edgeFunctionService.deployDetailed(
        ref,
        slug,
        "export default { fetch: () => new Response('single-marker') };",
      ),
    ]);

    expect(bundleResult).toMatchObject({ success: true });
    expect(singleResult).toMatchObject({ success: true });
    expect([bundleResult.version, singleResult.version].sort()).toEqual(["1", "2"]);
    expect(await Bun.file(bundleResult.content_path!).text()).toContain("bundle-marker");
    expect(await Bun.file(singleResult.content_path!).text()).toContain("single-marker");
    expect(
      await Bun.file(join(functionsRoot, ref, ".versions", slug, bundleResult.version!, "src", "index.ts")).text(),
    ).toContain("bundle-marker");
    expect(
      await Bun.file(join(functionsRoot, ref, ".versions", slug, singleResult.version!, "index.src.ts")).text(),
    ).toContain("single-marker");
  });

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

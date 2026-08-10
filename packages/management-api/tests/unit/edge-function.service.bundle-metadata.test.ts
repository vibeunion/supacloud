import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const runtimeInvalidationProtocol = {
  module_scope: "legacy-base-only",
  immutable_versions_retained: true,
  config_cache_evicted: true,
};

function runtimeSuccessFetch(): typeof fetch {
  return ((input, init) => {
    const url = String(input);
    if (url.includes("/invalidate/")) {
      const segments = new URL(url).pathname.split("/");
      return Promise.resolve(Response.json({
        invalidated: `${segments.at(-2)}_${segments.at(-1)}`,
        ...runtimeInvalidationProtocol,
        foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
        background: { attempted: 0, succeeded: 0, invalidated: 0 },
      }));
    }
    const version = new Headers(init?.headers).get("x-supacloud-function-version");
    return Promise.resolve(Response.json({ success: true, version }));
  }) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = runtimeSuccessFetch();
});

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
  for (const minify of [false, true]) {
    test(`normalizes single-file computed imports before writing (minify=${minify})`, async () => {
      const ref = `proj_single_normalize_${minify}`;
      const deployed = await edgeFunctionService.deployRelease({
        ref,
        slug: "otel-loader",
        minify,
        code: `
          var OTEL_PKG = "@opentelemetry/api";
          export default { async fetch() { await import(OTEL_PKG); return new Response("ok"); } };
        `,
      });

      expect(deployed).toMatchObject({ success: true, bundled: true, version: "1" });
      const bundle = await Bun.file(deployed.content_path!).text();
      expect(bundle).toContain('import("@opentelemetry/api")');
      expect(bundle).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);
      expect(deployed.bundle_size_bytes).toBe(new TextEncoder().encode(bundle).byteLength);
      expect(deployed.bundle_hash).toBe(createHash("sha256").update(bundle).digest("hex").slice(0, 16));
      expect(deployed.import_count).toBe(1);
    });

    test(`normalizes multi-file computed imports before writing (minify=${minify})`, async () => {
      const ref = `proj_bundle_normalize_${minify}`;
      const deployed = await edgeFunctionService.deployRelease({
        ref,
        slug: "otel-loader",
        minify,
        files: {
          "index.ts": `
            import { OTEL_PKG } from "./shared";
            export default { async fetch() { await import(OTEL_PKG); return new Response("ok"); } };
          `,
          "shared.ts": 'export const OTEL_PKG = "@opentelemetry/api";',
        },
        entrypoint: "index.ts",
      });

      expect(deployed).toMatchObject({ success: true, bundled: true, version: "1" });
      const bundle = await Bun.file(deployed.content_path!).text();
      expect(bundle).toContain('import("@opentelemetry/api")');
      expect(bundle).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);
    });
  }

  test("counts normalized dynamic imports with options", async () => {
    const deployed = await edgeFunctionService.deployRelease({
      ref: "proj_single_options",
      slug: "json-loader",
      code: `
        const target = "./fixture.json";
        export default { async fetch() { return import((target), { with: { type: "json" } }); } };
      `,
    });

    expect(deployed).toMatchObject({ success: true, import_count: 1 });
    const bundle = await Bun.file(deployed.content_path!).text();
    expect(bundle).toMatch(/import\(["']\.\/fixture\.json["'],\s*\{/);
  });

  for (const deploymentKind of ["single-file", "multi-file"] as const) {
    test(`does not list a failed first ${deploymentKind} deployment`, async () => {
      const ref = `proj_first_rejected_${deploymentKind}`;
      const slug = "unsafe-loader";
      const code = `
        const moduleName = process.env.MODULE_NAME;
        export default { async fetch() { return import(moduleName); } };
      `;
      const rejected = await edgeFunctionService.deployRelease({
        ref,
        slug,
        ...(deploymentKind === "single-file"
          ? { code }
          : { files: { "index.ts": code } }),
      });

      expect(rejected).toMatchObject({ success: false });
      expect(await edgeFunctionService.list(ref)).not.toContain(slug);
      expect(existsSync(join(functionsRoot, ref, ".versions", slug))).toBe(false);
    });
  }

  test("rejects an unsafe single-file bundle without activating or preserving raw source", async () => {
    const ref = "proj_single_fail_closed";
    const slug = "unsafe-loader";
    const initial = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: 'export default { fetch: () => new Response("v1") };',
    });
    const rejected = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: `
        const moduleName = process.env.MODULE_NAME;
        export default { async fetch() { await import(moduleName); return new Response("v2"); } };
      `,
    });

    expect(initial).toMatchObject({ success: true, version: "1" });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("incompatible with the production runtime"),
    });
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "1" });
    expect(existsSync(join(functionsRoot, ref, ".versions", slug, "2"))).toBe(false);
  });

  test("rejects an unsafe multi-file bundle without activating it", async () => {
    const ref = "proj_bundle_fail_closed";
    const slug = "unsafe-loader";
    const initial = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: 'export default { fetch: () => new Response("v1") };',
    });
    const rejected = await edgeFunctionService.deployRelease({
      ref,
      slug,
      files: {
        "index.ts": `
          const moduleName = process.env.MODULE_NAME;
          export default { async fetch() { await import(moduleName); return new Response("v2"); } };
        `,
      },
    });

    expect(initial).toMatchObject({ success: true, version: "1" });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("incompatible with the production runtime"),
    });
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "1" });
    expect(existsSync(join(functionsRoot, ref, ".versions", slug, "2"))).toBe(false);
  });

  test("commits verify_jwt=false with the activated version before invalidation", async () => {
    const ref = "proj_atomic_false";
    const slug = "public-hook";
    let configAtInvalidation: unknown;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/invalidate/")) {
        configAtInvalidation = await edgeFunctionService.getConfig(ref, slug);
        return Response.json({
          invalidated: `${ref}_${slug}`,
          ...runtimeInvalidationProtocol,
          foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
          background: { attempted: 0, succeeded: 0, invalidated: 0 },
        });
      }
      return Response.json({
        success: true,
        version: new Headers(init?.headers).get("x-supacloud-function-version"),
      });
    }) as typeof fetch;

    const deployed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('public') };",
      config: { verify_jwt: false },
    });

    expect(deployed).toMatchObject({
      success: true,
      version: "1",
      config: { verify_jwt: false, version: "1" },
    });
    expect(configAtInvalidation).toMatchObject({ verify_jwt: false, version: "1" });
  });

  test("preserves an existing false policy when a later deploy omits policy", async () => {
    const ref = "proj_preserve_false";
    const slug = "public-hook";
    await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });

    const deployed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v2') };",
    });

    expect(deployed.config).toMatchObject({ verify_jwt: false, version: "2" });
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({
      verify_jwt: false,
      version: "2",
    });
  });

  test("clears bundle source metadata when a single-file version becomes active", async () => {
    const ref = "proj_single_metadata";
    const slug = "metadata-clear";
    await edgeFunctionService.deployRelease({
      ref,
      slug,
      files: {
        "worker.ts": "export default { fetch: () => new Response('bundle') };",
        "import_map.json": JSON.stringify({ imports: {} }),
      },
      entrypoint: "worker.ts",
    });

    const singleFile = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('single-file') };",
    });

    expect(singleFile).toMatchObject({ success: true, version: "2" });
    expect(Object.hasOwn(singleFile.config!, "entrypoint")).toBe(false);
    expect(Object.hasOwn(singleFile.config!, "import_map")).toBe(false);
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("single-file");
  });

  test("defaults a new function policy to verify_jwt=true", async () => {
    const deployed = await edgeFunctionService.deployRelease({
      ref: "proj_default_true",
      slug: "secured",
      code: "export default { fetch: () => new Response('secured') };",
    });

    expect(deployed.config).toMatchObject({ verify_jwt: true, version: "1" });
  });

  test("snapshots frozen legacy aliases before first deploy and restores version zero", async () => {
    const ref = "proj_legacy_migration";
    const slug = "legacy-hook";
    await edgeFunctionService.updateConfig(ref, slug, {
      verify_jwt: false,
      background_routes: ["/legacy/*"],
    });
    const legacyBundlePath = join(functionsRoot, ref, `${slug}.js`);
    const legacySourcePath = join(functionsRoot, ref, `${slug}.src.ts`);
    await Bun.write(legacyBundlePath, "export default { fetch: () => new Response('legacy') };");
    await Bun.write(legacySourcePath, "export default { fetch: () => new Response('legacy-source') };");
    const legacyBundleBefore = await readFile(legacyBundlePath, "utf8");
    const legacySourceBefore = await readFile(legacySourcePath, "utf8");

    const deployed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('immutable-v1') };",
    });

    expect(deployed.config).toMatchObject({ verify_jwt: false, version: "1" });
    expect(await readFile(legacyBundlePath, "utf8")).toBe(legacyBundleBefore);
    expect(await readFile(legacySourcePath, "utf8")).toBe(legacySourceBefore);
    expect(await edgeFunctionService.read(ref, slug)).toContain("immutable-v1");
    expect(await edgeFunctionService.list(ref)).toContain(slug);

    const restored = await edgeFunctionService.activateVersion(ref, slug, "0");

    expect(restored).toMatchObject({
      version: "0",
      verify_jwt: false,
      background_routes: ["/legacy/*"],
    });
    expect(Object.hasOwn(restored!, "entrypoint")).toBe(false);
    expect(Object.hasOwn(restored!, "import_map")).toBe(false);
    expect(await edgeFunctionService.read(ref, slug)).toContain("legacy");
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("legacy-source");
  });

  test("repairs a configured version with missing artifacts from frozen aliases", async () => {
    const ref = "proj_missing_active_artifact";
    const slug = "missing-active-artifact";
    const projectDir = join(functionsRoot, ref);
    const versionDir = join(projectDir, ".versions", slug, "7");
    const legacyBundlePath = join(projectDir, `${slug}.js`);
    const legacySourcePath = join(projectDir, `${slug}.src.ts`);
    const legacyBundle = "export default { fetch: () => new Response('legacy-seven') };";
    await mkdir(versionDir, { recursive: true });
    await Promise.all([
      Bun.write(legacyBundlePath, legacyBundle),
      Bun.write(legacySourcePath, "export default { fetch: () => new Response('source-seven') };"),
      Bun.write(join(projectDir, `${slug}.config.json`), JSON.stringify({
        verify_jwt: false,
        background_routes: ["/seven/*"],
        version: "7",
      })),
    ]);

    const deployed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('version-eight') };",
      config: { verify_jwt: true, background_routes: ["/eight/*"] },
    });

    expect(deployed).toMatchObject({ success: true, version: "8" });
    expect(await Bun.file(legacyBundlePath).text()).toBe(legacyBundle);
    const restored = await edgeFunctionService.activateVersion(ref, slug, "7");
    expect(restored).toMatchObject({
      version: "7",
      verify_jwt: false,
      background_routes: ["/seven/*"],
    });
    expect(await edgeFunctionService.read(ref, slug)).toContain("legacy-seven");
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("source-seven");
  });

  test("backfills full metadata for an existing active version before deployment", async () => {
    const ref = "proj_active_metadata_backfill";
    const slug = "active-metadata-backfill";
    const projectDir = join(functionsRoot, ref);
    const versionDir = join(projectDir, ".versions", slug, "3");
    await mkdir(versionDir, { recursive: true });
    await Promise.all([
      Bun.write(
        join(versionDir, "index.js"),
        "export default { fetch: () => new Response('runtime-three') };",
      ),
      Bun.write(
        join(versionDir, "index.src.ts"),
        "export default { fetch: () => new Response('source-three') };",
      ),
      Bun.write(join(projectDir, `${slug}.config.json`), JSON.stringify({
        verify_jwt: false,
        background_routes: ["/three/*"],
        version: "3",
      })),
    ]);

    const deployed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('version-four') };",
      config: { verify_jwt: true, background_routes: ["/four/*"] },
    });

    expect(deployed).toMatchObject({ success: true, version: "4" });
    const restored = await edgeFunctionService.activateVersion(ref, slug, "3");
    expect(restored).toMatchObject({
      version: "3",
      verify_jwt: false,
      background_routes: ["/three/*"],
    });
    expect(await edgeFunctionService.read(ref, slug)).toContain("runtime-three");
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("source-three");
  });

  test("does not replace a corrupted manifest when deploy policy is omitted", async () => {
    const ref = "proj_corrupt_manifest";
    const slug = "corrupt-hook";
    await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const corruptedManifest = '{"verify_jwt": false';
    await Bun.write(manifestPath, corruptedManifest);

    const failed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v2') };",
    });

    expect(failed.success).toBe(false);
    expect(await readFile(manifestPath, "utf8")).toBe(corruptedManifest);
  });

  test("rolls back config-only updates when runtime invalidation fails", async () => {
    const ref = "proj_config_rollback";
    const slug = "config-hook";
    await edgeFunctionService.updateConfig(ref, slug, { verify_jwt: false });
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const manifestBefore = await readFile(manifestPath, "utf8");
    let invalidationCalls = 0;
    globalThis.fetch = ((input) => {
      invalidationCalls += 1;
      if (invalidationCalls === 1) {
        return Promise.resolve(Response.json({ message: "unavailable" }, { status: 503 }));
      }
      const segments = new URL(String(input)).pathname.split("/");
      return Promise.resolve(Response.json({
        invalidated: `${segments.at(-2)}_${segments.at(-1)}`,
        ...runtimeInvalidationProtocol,
        foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
        background: { attempted: 0, succeeded: 0, invalidated: 0 },
      }));
    }) as typeof fetch;

    await expect(edgeFunctionService.updateConfig(ref, slug, { verify_jwt: true })).rejects.toThrow(
      "cache invalidation",
    );
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(invalidationCalls).toBe(2);
  });

  test("reports uncertain runtime state when activation and rollback invalidation both fail", async () => {
    const ref = "proj_manifest_rollback";
    const slug = "public-hook";
    await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const manifestBefore = await readFile(manifestPath, "utf8");
    let invalidationCalls = 0;
    globalThis.fetch = ((input, init) => {
      if (String(input).includes("/preheat/")) {
        return Promise.resolve(Response.json({
          success: true,
          version: new Headers(init?.headers).get("x-supacloud-function-version"),
        }));
      }
      invalidationCalls += 1;
      return Promise.resolve(Response.json({ message: "unavailable" }, { status: 503 }));
    }) as typeof fetch;

    const failed = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v2') };",
      config: { verify_jwt: true },
    });

    expect(failed.success).toBe(false);
    expect(failed.error).toContain("runtime state is uncertain");
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(invalidationCalls).toBe(2);
  });

  test("allocates after retained history instead of overwriting a rolled-back version", async () => {
    const ref = "proj_rollback_history";
    const slug = "history-safe";
    globalThis.fetch = ((input, init) => {
      if (String(input).includes("/invalidate/")) {
        return Promise.resolve(Response.json({
          invalidated: `${ref}_${slug}`,
          ...runtimeInvalidationProtocol,
          foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
          background: { attempted: 0, succeeded: 0, invalidated: 0 },
        }));
      }
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
    await edgeFunctionService.deployBundleDetailed(ref, slug, {
      "index.ts": "export default { fetch: () => new Response('current') };",
    });
    const versionDir = join(functionsRoot, ref, ".versions", slug);
    await Promise.all([
      mkdir(join(versionDir, "not-a-version"), { recursive: true }),
      mkdir(join(versionDir, "01"), { recursive: true }),
    ]);

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
    globalThis.fetch = ((input, init) => Promise.resolve(Response.json(
      String(input).includes("/invalidate/")
        ? {
            invalidated: "proj_assets_asset-reader",
            ...runtimeInvalidationProtocol,
            foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
            background: { attempted: 0, succeeded: 0, invalidated: 0 },
          }
        : {
            success: true,
            version: new Headers(init?.headers).get("x-supacloud-function-version"),
          },
    ))) as typeof fetch;

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
    const legacyRuntimeEntry = join(functionsRoot, "proj_assets", ".src-asset-reader", ".supacloud-entry.js");
    const versionedRuntimeEntry = join(
      functionsRoot,
      "proj_assets",
      ".versions",
      "asset-reader",
      "1",
      "src",
      ".supacloud-entry.js",
    );
    expect(existsSync(legacyRuntimeEntry)).toBe(false);
    expect(existsSync(versionedRuntimeEntry)).toBe(true);
    const runtimeModule = await import(`${pathToFileURL(versionedRuntimeEntry).href}?test=${Date.now()}`);
    const runtimeResponse = await runtimeModule.default.fetch(new Request("http://localhost/"));
    expect(await runtimeResponse.text()).toBe("asset-from-source-dir");
    expect(await edgeFunctionService.readSource("proj_assets", "asset-reader")).toContain("/public/message.txt");
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

  test("deletes only the target manifest and immutable artifacts after runtime ACK", async () => {
    const ref = "proj_delete_exact";
    const targetSlug = "delete-target";
    const siblingSlug = "delete-sibling";
    await edgeFunctionService.deployDetailed(
      ref,
      targetSlug,
      "export default { fetch: () => new Response('target') };",
    );
    await edgeFunctionService.deployDetailed(
      ref,
      siblingSlug,
      "export default { fetch: () => new Response('sibling') };",
    );

    expect(await edgeFunctionService.remove(ref, targetSlug)).toBe(true);
    expect(existsSync(join(functionsRoot, ref, `${targetSlug}.config.json`))).toBe(false);
    expect(existsSync(join(functionsRoot, ref, ".versions", targetSlug))).toBe(false);
    expect(existsSync(join(functionsRoot, ref, `${siblingSlug}.config.json`))).toBe(true);
    expect(existsSync(join(functionsRoot, ref, ".versions", siblingSlug))).toBe(true);
    expect(await edgeFunctionService.getConfig(ref, targetSlug)).toEqual({ verify_jwt: true });
  });

  test("reports deletion failure when runtime invalidation is not acknowledged", async () => {
    const ref = "proj_delete_unconfirmed";
    const slug = "delete-unconfirmed";
    await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('delete-me') };",
    );
    let invalidationCalls = 0;
    globalThis.fetch = ((input) => {
      expect(String(input)).toContain(`/invalidate/${ref}/${slug}`);
      invalidationCalls += 1;
      return Promise.resolve(Response.json({ message: "unavailable" }, { status: 503 }));
    }) as typeof fetch;

    expect(await edgeFunctionService.remove(ref, slug)).toBe(false);
    expect(invalidationCalls).toBe(1);
    expect(existsSync(join(functionsRoot, ref, `${slug}.config.json`))).toBe(false);
    expect(existsSync(join(functionsRoot, ref, ".versions", slug))).toBe(false);
  });

  test("writes content-addressed version artifacts and returns deploy preheat metadata", async () => {
    const metricsBefore = edgeFunctionService.deployMetrics();
    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/preheat/")) {
        return Promise.resolve(Response.json({
          success: true,
          version: new Headers(init?.headers).get("x-supacloud-function-version"),
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
      return Promise.resolve(Response.json({
        invalidated: "proj_meta_hello",
        ...runtimeInvalidationProtocol,
        foreground: { attempted: 0, succeeded: 0, invalidated: 0 },
        background: { attempted: 0, succeeded: 0, invalidated: 0 },
      }));
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

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const functionsRoot = await mkdtemp(join(tmpdir(), "supacloud-function-activation-"));
const originalFunctionsDir = process.env.EDGE_FUNCTIONS_DIR;
const originalRuntimeInternal = process.env.EDGE_RUNTIME_INTERNAL;
const originalFetch = globalThis.fetch;

process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

const {
  EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
  edgeFunctionService,
} = await import("../../src/services/edge-function.service");

async function deployConditionalRelease(
  request: Omit<Parameters<typeof edgeFunctionService.deployRelease>[0], "expectedActiveVersion">,
) {
  const expectedActiveVersion = (await edgeFunctionService.getConfig(request.ref, request.slug)).version ?? "absent";
  return edgeFunctionService.deployRelease({ ...request, expectedActiveVersion });
}

async function activateConditionalVersion(ref: string, slug: string, version: string) {
  const expectedActiveVersion = (await edgeFunctionService.getConfig(ref, slug)).version ?? "absent";
  return (await edgeFunctionService.activateVersion(ref, slug, version, expectedActiveVersion))?.config ?? null;
}

type FetchStep = {
  path: "/preheat/" | "/invalidate/";
  response: Response;
};

const successfulPoolAck = {
  attempted: 1,
  succeeded: 1,
  invalidated: 0,
};

function successfulInvalidationAck(ref: string, slug: string) {
  return {
    invalidated: `${ref}_${slug}`,
    module_scope: "legacy-base-only",
    immutable_versions_retained: true,
    config_cache_evicted: true,
    foreground: successfulPoolAck,
    background: successfulPoolAck,
  };
}

function runtimeSuccessFetch(): typeof fetch {
  return ((input, init) => {
    const runtimeUrl = new URL(String(input));
    if (runtimeUrl.pathname.includes("/invalidate/")) {
      const pathSegments = runtimeUrl.pathname.split("/");
      return Promise.resolve(Response.json(successfulInvalidationAck(
        pathSegments.at(-2)!,
        pathSegments.at(-1)!,
      )));
    }
    const requestedVersion = new Headers(init?.headers).get("x-supacloud-function-version");
    return Promise.resolve(Response.json({ success: true, version: requestedVersion }));
  }) as typeof fetch;
}

function sequenceFetch(steps: FetchStep[]): typeof fetch {
  return ((input, init) => {
    const step = steps.shift();
    if (!step) throw new Error(`Unexpected runtime request: ${String(input)}`);
    expect(String(input)).toContain(step.path);
    if (step.path === "/preheat/") {
      expect(new Headers(init?.headers).get("x-supacloud-function-version")).toBe("2");
    }
    return Promise.resolve(step.response);
  }) as typeof fetch;
}

async function prepareRollback(ref: string, slug: string) {
  globalThis.fetch = runtimeSuccessFetch();
  await edgeFunctionService.deployBundleDetailed(ref, slug, {
    "index.ts": "export default { fetch: () => new Response('version-one') };",
    "public/version.txt": "version-one",
  });
  await edgeFunctionService.deployBundleDetailed(ref, slug, {
    "index.ts": "export default { fetch: () => new Response('version-two') };",
    "public/version.txt": "version-two",
  });
  await activateConditionalVersion(ref, slug, "1");

  return {
    config: await edgeFunctionService.getConfig(ref, slug),
    artifact: await edgeFunctionService.read(ref, slug),
    source: await edgeFunctionService.readSource(ref, slug),
  };
}

async function expectRollbackUnchanged(
  ref: string,
  slug: string,
  before: Awaited<ReturnType<typeof prepareRollback>>,
) {
  expect(await edgeFunctionService.getConfig(ref, slug)).toEqual(before.config);
  expect(await edgeFunctionService.read(ref, slug)).toBe(before.artifact);
  expect(await edgeFunctionService.readSource(ref, slug)).toBe(before.source);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (originalFunctionsDir === undefined) delete process.env.EDGE_FUNCTIONS_DIR;
  else process.env.EDGE_FUNCTIONS_DIR = originalFunctionsDir;
  if (originalRuntimeInternal === undefined) delete process.env.EDGE_RUNTIME_INTERNAL;
  else process.env.EDGE_RUNTIME_INTERNAL = originalRuntimeInternal;
  globalThis.fetch = originalFetch;
  await rm(functionsRoot, { recursive: true, force: true });
});

describe("edgeFunctionService version activation readiness", () => {
  test("rejects stale activation before target preheat or manifest mutation", async () => {
    const ref = "proj_activation_stale";
    const slug = "activation-stale";
    const before = await prepareRollback(ref, slug);
    let runtimeCalls = 0;
    globalThis.fetch = (async () => {
      runtimeCalls += 1;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      edgeFunctionService.activateVersion(ref, slug, "2", "2"),
    ).rejects.toMatchObject({
      code: EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
      expectedActiveVersion: "2",
      activeVersion: "1",
    });
    expect(runtimeCalls).toBe(0);
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("fails closed when version preheat is unauthorized", async () => {
    const ref = "proj_activation_preheat_401";
    const slug = "activate-preheat-401";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ message: "Unauthorized" }, { status: 401 }) },
    ]);

    await expect(activateConditionalVersion(ref, slug, "2")).rejects.toThrow("HTTP 401");
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("fails closed when cache invalidation is unauthorized", async () => {
    const ref = "proj_activation_invalidate_401";
    const slug = "activate-invalidate-401";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ success: true, version: "2" }) },
      { path: "/invalidate/", response: Response.json({ message: "Unauthorized" }, { status: 401 }) },
      { path: "/invalidate/", response: Response.json(successfulInvalidationAck(ref, slug)) },
    ]);

    await expect(activateConditionalVersion(ref, slug, "2")).rejects.toThrow("HTTP 401");
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("fails closed when preheat reports success false", async () => {
    const ref = "proj_activation_preheat_false";
    const slug = "activate-preheat-false";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ success: false, version: "2" }) },
    ]);

    await expect(activateConditionalVersion(ref, slug, "2")).rejects.toThrow(
      "did not report successful version readiness",
    );
    await expectRollbackUnchanged(ref, slug, before);
  });

  test.each([
    ["missing success", { version: "2" }],
    ["non-boolean success", { success: "true", version: "2" }],
    ["missing version", { success: true }],
    ["wrong version", { success: true, version: "1" }],
  ])("fails closed when preheat has %s acknowledgement", async (ackCase, responseBody) => {
    const ref = `proj_preheat_ack_${ackCase.replaceAll(" ", "_")}`;
    const slug = "activate-preheat-ack";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json(responseBody) },
    ]);

    await expect(activateConditionalVersion(ref, slug, "2")).rejects.toThrow(
      "Edge Runtime function activation unavailable",
    );
    await expectRollbackUnchanged(ref, slug, before);
  });

  test.each([
    ["empty response", {}],
    ["missing pool acknowledgement", { invalidated: "TARGET" }],
    [
      "partial pool acknowledgement",
      {
        invalidated: "TARGET",
        foreground: { attempted: 2, succeeded: 1, invalidated: 1 },
        background: successfulPoolAck,
      },
    ],
    [
      "wrong target",
      {
        invalidated: "another_function",
        foreground: successfulPoolAck,
        background: successfulPoolAck,
      },
    ],
  ])("fails closed when invalidation has %s", async (ackCase, responseBody) => {
    const ref = `proj_invalidate_ack_${ackCase.replaceAll(" ", "_")}`;
    const slug = "activate-invalidate-ack";
    const before = await prepareRollback(ref, slug);
    const acknowledgedBody = responseBody.invalidated === "TARGET"
      ? { ...responseBody, invalidated: `${ref}_${slug}` }
      : responseBody;
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ success: true, version: "2" }) },
      { path: "/invalidate/", response: Response.json(acknowledgedBody) },
      { path: "/invalidate/", response: Response.json(successfulInvalidationAck(ref, slug)) },
    ]);

    await expect(activateConditionalVersion(ref, slug, "2")).rejects.toThrow(
      "Edge Runtime function activation unavailable",
    );
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("activates only after target readiness and invalidation succeed", async () => {
    const ref = "proj_activation_success";
    const slug = "activate-success";
    await prepareRollback(ref, slug);
    const steps: FetchStep[] = [
      { path: "/preheat/", response: Response.json({ success: true, version: "2" }) },
      {
        path: "/invalidate/",
        response: Response.json(successfulInvalidationAck(ref, slug)),
      },
    ];
    globalThis.fetch = sequenceFetch(steps);

    const activation = await edgeFunctionService.activateVersion(ref, slug, "2", "1");

    expect(activation).toMatchObject({
      previous_active_version: "1",
      active_version: "2",
      config: { version: "2" },
    });
    expect(await edgeFunctionService.read(ref, slug)).toContain("version-two");
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("version-two");
    expect(steps).toHaveLength(0);
  });

  test("restores the target version source metadata and authorization policy", async () => {
    const ref = "proj_activation_full_metadata";
    const slug = "metadata-rollback";
    globalThis.fetch = runtimeSuccessFetch();
    const versionOne = await deployConditionalRelease({
      ref,
      slug,
      files: {
        "version-one.ts": "export default { fetch: () => new Response('source-version-one') };",
        "import_map.json": JSON.stringify({ imports: {} }),
      },
      entrypoint: "version-one.ts",
      config: { verify_jwt: false, background_routes: ["/version-one/*"] },
    });
    const versionTwo = await deployConditionalRelease({
      ref,
      slug,
      files: {
        "version-two.ts": "export default { fetch: () => new Response('source-version-two') };",
        "deno.json": JSON.stringify({ imports: {} }),
      },
      entrypoint: "version-two.ts",
      config: { verify_jwt: true, background_routes: ["/version-two/*"] },
    });

    expect(versionOne).toMatchObject({ success: true, version: "1" });
    expect(versionTwo).toMatchObject({ success: true, version: "2" });

    const restored = await activateConditionalVersion(ref, slug, "1");

    expect(restored).toMatchObject({
      version: "1",
      verify_jwt: false,
      background_routes: ["/version-one/*"],
      entrypoint: "version-one.ts",
      import_map: "import_map.json",
    });
    expect(await edgeFunctionService.getConfig(ref, slug)).toEqual(restored!);
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("source-version-one");
  });
});

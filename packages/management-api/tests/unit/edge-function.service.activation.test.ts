import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const functionsRoot = await mkdtemp(join(tmpdir(), "supacloud-function-activation-"));
const originalFunctionsDir = process.env.EDGE_FUNCTIONS_DIR;
const originalRuntimeInternal = process.env.EDGE_RUNTIME_INTERNAL;
const originalFetch = globalThis.fetch;

process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

const { edgeFunctionService } = await import("../../src/services/edge-function.service");

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
  await edgeFunctionService.activateVersion(ref, slug, "1");

  return {
    config: await edgeFunctionService.getConfig(ref, slug),
    artifact: await readFile(join(functionsRoot, ref, `${slug}.js`), "utf8"),
    sourceAsset: await readFile(
      join(functionsRoot, ref, `.src-${slug}`, "public", "version.txt"),
      "utf8",
    ),
  };
}

async function expectRollbackUnchanged(
  ref: string,
  slug: string,
  before: Awaited<ReturnType<typeof prepareRollback>>,
) {
  expect(await edgeFunctionService.getConfig(ref, slug)).toEqual(before.config);
  expect(await readFile(join(functionsRoot, ref, `${slug}.js`), "utf8")).toBe(before.artifact);
  expect(
    await readFile(join(functionsRoot, ref, `.src-${slug}`, "public", "version.txt"), "utf8"),
  ).toBe(before.sourceAsset);
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
  test("fails closed when version preheat is unauthorized", async () => {
    const ref = "proj_activation_preheat_401";
    const slug = "activate-preheat-401";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ message: "Unauthorized" }, { status: 401 }) },
    ]);

    await expect(edgeFunctionService.activateVersion(ref, slug, "2")).rejects.toThrow("HTTP 401");
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("fails closed when cache invalidation is unauthorized", async () => {
    const ref = "proj_activation_invalidate_401";
    const slug = "activate-invalidate-401";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ success: true, version: "2" }) },
      { path: "/invalidate/", response: Response.json({ message: "Unauthorized" }, { status: 401 }) },
    ]);

    await expect(edgeFunctionService.activateVersion(ref, slug, "2")).rejects.toThrow("HTTP 401");
    await expectRollbackUnchanged(ref, slug, before);
  });

  test("fails closed when preheat reports success false", async () => {
    const ref = "proj_activation_preheat_false";
    const slug = "activate-preheat-false";
    const before = await prepareRollback(ref, slug);
    globalThis.fetch = sequenceFetch([
      { path: "/preheat/", response: Response.json({ success: false, version: "2" }) },
    ]);

    await expect(edgeFunctionService.activateVersion(ref, slug, "2")).rejects.toThrow(
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

    await expect(edgeFunctionService.activateVersion(ref, slug, "2")).rejects.toThrow(
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
    ]);

    await expect(edgeFunctionService.activateVersion(ref, slug, "2")).rejects.toThrow(
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

    const config = await edgeFunctionService.activateVersion(ref, slug, "2");

    expect(config?.version).toBe("2");
    expect(await readFile(join(functionsRoot, ref, `${slug}.js`), "utf8")).toContain("version-two");
    expect(
      await readFile(join(functionsRoot, ref, `.src-${slug}`, "public", "version.txt"), "utf8"),
    ).toBe("version-two");
    expect(steps).toHaveLength(0);
  });
});

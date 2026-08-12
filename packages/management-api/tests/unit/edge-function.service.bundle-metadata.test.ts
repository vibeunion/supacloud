import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const functionsRoot = await mkdtemp(join(homedir(), ".supacloud-edge-functions-"));
const originalFunctionsDir = process.env.EDGE_FUNCTIONS_DIR;
const originalRuntimeInternal = process.env.EDGE_RUNTIME_INTERNAL;
const originalExternalPackages = process.env.EDGE_FUNCTION_EXTERNAL_PACKAGES;
const originalFetch = globalThis.fetch;

mock.restore();
process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

const {
  EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
  edgeFunctionService,
  getVersionedArtifactPath,
  migrateLegacyVersionArtifacts,
} = await import(
  "../../src/services/edge-function.service"
);

async function deployConditionalRelease(
  request: Omit<
    Parameters<typeof edgeFunctionService.deployRelease>[0],
    "expectedActiveVersion" | "expectedActivationId"
  >,
) {
  const current = await edgeFunctionService.getConfig(request.ref, request.slug);
  return edgeFunctionService.deployRelease({
    ...request,
    expectedActiveVersion: current.version ?? "absent",
    expectedActivationId: current.activation_id,
  });
}

async function activateConditionalVersion(ref: string, slug: string, version: string) {
  const current = await edgeFunctionService.getConfig(ref, slug);
  return (await edgeFunctionService.activateVersion(
    ref,
    slug,
    version,
    current.version ?? "absent",
    current.activation_id,
  ))?.config ?? null;
}

async function expectAttestedRuntimeEntry(
  ref: string,
  slug: string,
  deployment: { version?: string; content_path?: string | null; bundle_hash?: string },
) {
  const versionDir = join(functionsRoot, ref, ".versions", slug, deployment.version!);
  const runtimeEntry = join(versionDir, "src", ".supacloud-entry.js");
  const content = await readFile(deployment.content_path!);
  const artifactSha256 = createHash("sha256").update(content).digest("hex");
  expect(await readFile(runtimeEntry)).toEqual(content);
  expect(artifactSha256.slice(0, 16)).toBe(deployment.bundle_hash);
  expect(JSON.parse(await readFile(join(versionDir, ".supacloud-version.json"), "utf8")))
    .toMatchObject({ artifact_sha256: artifactSha256 });
  expect((await stat(runtimeEntry)).mode & 0o222).toBe(0);
}

async function writeConfiguredAliases(ref: string, slug: string, version: string): Promise<void> {
  const projectDir = join(functionsRoot, ref);
  await mkdir(projectDir, { recursive: true });
  await Promise.all([
    Bun.write(join(projectDir, `${slug}.config.json`), JSON.stringify({ version })),
    Bun.write(join(projectDir, `${slug}.js`), "stale-alias-bundle"),
    Bun.write(join(projectDir, `${slug}.src.ts`), "stale-alias-source"),
  ]);
}

async function writeCrossSlugFixture(ref: string): Promise<void> {
  const otherVersionDir = join(functionsRoot, ref, ".versions", "other", "1");
  await mkdir(otherVersionDir, { recursive: true });
  await Promise.all([
    Bun.write(join(otherVersionDir, "index.js"), "cross-slug-bundle"),
    Bun.write(join(otherVersionDir, "index.src.ts"), "cross-slug-source"),
    writeConfiguredAliases(ref, "traversal", "../other/1"),
  ]);
}

const TEST_RUNTIME_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const TEST_RUNTIME_REVISION = `hmac-sha256:${"a".repeat(64)}`;
const TEST_RUNTIME_ENV_PROOF = `hmac-sha256:${"b".repeat(64)}`;
const TEST_FOREGROUND_MODULE_ENV_PROOF = `hmac-sha256:${"c".repeat(64)}`;
const TEST_BACKGROUND_MODULE_ENV_PROOF = `hmac-sha256:${"d".repeat(64)}`;
const TEST_FENCE_GENERATION = 1;
const TEST_PREHEAT_GENERATION = 2;

function preheatRotation() {
  return {
    generation: TEST_PREHEAT_GENERATION,
    attempted: 0,
    idleRetired: 0,
    busyTainted: 0,
    alreadyTainted: 0,
    immediateReplacements: 0,
  };
}

type TestPreheatPoolStats = {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
};

const DEFAULT_FOREGROUND_PREHEAT: TestPreheatPoolStats = {
  attempted: 1,
  succeeded: 1,
  cacheHits: 0,
  cacheMisses: 1,
  durationMs: 1,
};
const DEFAULT_BACKGROUND_PREHEAT: TestPreheatPoolStats = {
  attempted: 1,
  succeeded: 1,
  cacheHits: 0,
  cacheMisses: 1,
  durationMs: 0,
};

function testPreheatPool(
  stats: TestPreheatPoolStats,
  attestation: object,
  requestedVersion: string | null,
) {
  return {
    ...stats,
    attestation: stats.succeeded > 0 ? attestation : null,
    ...(requestedVersion === null ? {} : { rotation: preheatRotation() }),
  };
}

type TestPreheatIdentity = {
  ref: string;
  slug: string;
  requestedVersion: string | null;
  resolvedVersion: string | null;
  artifactSha256: string;
  verifyJwt: boolean;
  activationId: string | null;
};

function testPreheatAttestation(
  identity: TestPreheatIdentity,
  executionProfile: "foreground" | "background",
) {
  return {
    schema: "supacloud.edge-runtime-preheat-attestation.v1",
    project_ref: identity.ref,
    function_slug: identity.slug,
    requested_version: identity.requestedVersion,
    target_version: identity.resolvedVersion,
    resolved_version: identity.resolvedVersion,
    artifact_sha256: identity.artifactSha256,
    verify_jwt: identity.verifyJwt,
    activation_id: identity.activationId,
    runtime_instance_id: TEST_RUNTIME_INSTANCE_ID,
    execution_profile: executionProfile,
    module_env_proof: executionProfile === "foreground"
      ? TEST_FOREGROUND_MODULE_ENV_PROOF
      : TEST_BACKGROUND_MODULE_ENV_PROOF,
    tenant_env: {
      loaded_revision: TEST_RUNTIME_REVISION,
      env_proof: TEST_RUNTIME_ENV_PROOF,
      load_state: "loaded",
      load_source: "management_api",
    },
    module_loaded: true,
  };
}

type TestFunctionConfig = {
  version: string | null;
  verifyJwt: boolean;
  activationId: string | null;
};

async function functionTestConfig(
  ref: string,
  slug: string,
  activationId: string | null,
): Promise<TestFunctionConfig> {
  const manifestPath = activationId === null
    ? join(functionsRoot, ref, `${slug}.config.json`)
    : join(functionsRoot, ref, ".activation-generations", slug, `${activationId}.json`);
  try {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      version?: unknown;
      verify_jwt?: unknown;
      _supacloud_activation?: { activation_id?: unknown };
    };
    return {
      version: typeof manifest.version === "string" ? manifest.version : null,
      verifyJwt: manifest.verify_jwt !== false,
      activationId: typeof manifest._supacloud_activation?.activation_id === "string"
        ? manifest._supacloud_activation.activation_id
        : null,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || activationId !== null) throw error;
    return { version: null, verifyJwt: true, activationId: null };
  }
}

function runtimeActivationAck(
  activationId: string,
  state: "fenced" | "commit_pending" | "committed" | "aborted" | "uncertain",
  generation: number,
) {
  return {
    schema: "supacloud.edge-runtime-function-activation.v1",
    activation_id: activationId,
    state,
    runtime_instance_id: TEST_RUNTIME_INSTANCE_ID,
    foreground_generation: generation,
    background_generation: generation,
    cancelled_queued: 0,
  };
}

async function runtimePreheatSuccess(
  url: string,
  init?: RequestInit,
  foreground = DEFAULT_FOREGROUND_PREHEAT,
  background = DEFAULT_BACKGROUND_PREHEAT,
): Promise<Response> {
  const segments = new URL(url).pathname.split("/");
  const ref = segments.at(-2)!;
  const slug = segments.at(-1)!;
  const headers = new Headers(init?.headers);
  const requestedVersion = headers.get("x-supacloud-function-version");
  const requestedActivationId = headers.get("x-supacloud-activation-id");
  const targetConfig = await functionTestConfig(ref, slug, requestedActivationId);
  const resolvedVersion = requestedVersion ?? targetConfig.version;
  const artifactPath = resolvedVersion
    ? await getVersionedArtifactPath(ref, slug, resolvedVersion)
    : join(functionsRoot, ref, `${slug}.js`);
  if (!artifactPath || !existsSync(artifactPath)) {
    throw new Error("Test preheat artifact is unavailable");
  }
  const artifactSha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const identity = {
    ref,
    slug,
    requestedVersion,
    resolvedVersion,
    artifactSha256,
    verifyJwt: targetConfig.verifyJwt,
    activationId: requestedActivationId,
  };
  const foregroundAttestation = testPreheatAttestation(identity, "foreground");
  const backgroundAttestation = testPreheatAttestation(identity, "background");
  const versionSuffix = resolvedVersion === null ? "" : `_v${resolvedVersion}`;
  return Response.json({
    preheated: `${ref}_${slug}${versionSuffix}`,
    version: requestedVersion,
    success: true,
    attestation: foregroundAttestation,
    foreground: testPreheatPool(foreground, foregroundAttestation, requestedVersion),
    background: testPreheatPool(background, backgroundAttestation, requestedVersion),
  });
}

type RuntimePreheatResponder = (url: string, init?: RequestInit) => Promise<Response>;
type RuntimeActivationAction = "begin" | "status" | "commit" | "abort";
type RuntimeActivationContext = {
  action: RuntimeActivationAction;
  activationId: string;
  activeActivationId: string | null;
  ref: string;
  slug: string;
};
type RuntimeActivationResponder = (
  context: RuntimeActivationContext,
) => Response | null | Promise<Response | null>;

class TestActivationRuntime {
  private readonly fencedActivations = new Set<string>();

  constructor(
    private readonly preheatResponder: RuntimePreheatResponder,
    private readonly activationResponder?: RuntimeActivationResponder,
  ) {}

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/preheat/")) return this.preheatResponder(url.href, init);
    if (!url.pathname.includes("/internal/function-activation/")) {
      throw new Error(`Unexpected runtime request: ${url.pathname}`);
    }
    const activationId = new Headers(init?.headers).get("x-supacloud-activation-id");
    if (activationId === null) throw new Error("Test activation identity is missing");
    return this.activationResponse(url, activationId);
  }) as typeof fetch;

  private async activationContext(url: URL, activationId: string): Promise<RuntimeActivationContext> {
    const segments = url.pathname.split("/");
    const action = segments.at(-1) as RuntimeActivationAction;
    const slug = segments.at(-2)!;
    const ref = segments.at(-3)!;
    const active = await functionTestConfig(ref, slug, null);
    return { action, activationId, activeActivationId: active.activationId, ref, slug };
  }

  private async activationResponse(url: URL, activationId: string): Promise<Response> {
    const context = await this.activationContext(url, activationId);
    const overridden = await this.activationResponder?.(context);
    if (overridden) return overridden;
    if (context.action === "begin") return this.begin(context.activationId);
    if (context.action === "status") return this.status(context);
    if (context.action === "commit") return this.commit(context);
    if (context.action === "abort") return this.abort(context);
    throw new Error(`Unexpected activation action: ${context.action}`);
  }

  private begin(activationId: string): Response {
    this.fencedActivations.add(activationId);
    return Response.json(runtimeActivationAck(
      activationId,
      "fenced",
      TEST_FENCE_GENERATION,
    ));
  }

  private status(context: RuntimeActivationContext): Response {
    const isFenced = this.fencedActivations.has(context.activationId);
    const state = context.activeActivationId === context.activationId
      ? (isFenced ? "commit_pending" : "committed")
      : (isFenced ? "fenced" : "uncertain");
    const generation = state === "fenced" ? TEST_FENCE_GENERATION : TEST_PREHEAT_GENERATION;
    return Response.json(runtimeActivationAck(context.activationId, state, generation));
  }

  private commit(context: RuntimeActivationContext): Response {
    if (context.activeActivationId !== context.activationId) {
      return this.uncertain(context.activationId);
    }
    this.fencedActivations.delete(context.activationId);
    return Response.json(runtimeActivationAck(
      context.activationId,
      "committed",
      TEST_PREHEAT_GENERATION,
    ));
  }

  private abort(context: RuntimeActivationContext): Response {
    if (context.activeActivationId === context.activationId) {
      return Response.json(runtimeActivationAck(
        context.activationId,
        "committed",
        TEST_PREHEAT_GENERATION,
      ));
    }
    if (!this.fencedActivations.delete(context.activationId)) {
      return this.uncertain(context.activationId);
    }
    return Response.json(runtimeActivationAck(
      context.activationId,
      "aborted",
      TEST_FENCE_GENERATION,
    ));
  }

  private uncertain(activationId: string): Response {
    return Response.json(runtimeActivationAck(
      activationId,
      "uncertain",
      TEST_FENCE_GENERATION,
    ), { status: 409 });
  }
}

function runtimeSuccessFetch(
  preheatResponder: RuntimePreheatResponder = runtimePreheatSuccess,
  activationResponder?: RuntimeActivationResponder,
): typeof fetch {
  return new TestActivationRuntime(preheatResponder, activationResponder).fetch;
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
  test("rejects an unattested Edge Runtime preheat failure", async () => {
    const ref = "proj_preheat_diagnostic";
    const slug = "computed-import";
    globalThis.fetch = runtimeSuccessFetch(async () => Response.json({
      success: false,
      version: "1",
      foreground: {
        attempted: 1,
        succeeded: 0,
        cacheHits: 0,
        cacheMisses: 0,
        durationMs: 1,
        error: "Computed dynamic imports are disabled in the multi-tenant Edge Runtime.",
      },
      background: {
        attempted: 0,
        succeeded: 0,
        cacheHits: 0,
        cacheMisses: 0,
        durationMs: 0,
      },
    }));

    const deployed = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('unreachable') };",
    });

    expect(deployed.success).toBe(false);
    expect(deployed.error).toContain("invalid preheat attestation");
    expect((await edgeFunctionService.listVersions(ref, slug)).map(({ version }) => version))
      .toEqual(["1"]);
    expect((await edgeFunctionService.getConfig(ref, slug)).version).toBeUndefined();
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("absent");
    expect(await edgeFunctionService.list(ref)).toEqual([]);
  });

  test.each([
    ["oversized body", () => new Response(new Uint8Array(64 * 1024 + 1)), /too large/],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xc3, 0x28])), /Invalid byte sequence|UTF-8/i],
    ["non-object JSON", () => Response.json([]), /must be an object/],
  ])("rejects a preheat %s before activation", async (caseName, response, expectedError) => {
    const ref = `proj_preheat_${caseName.replace(/\W+/g, "_")}`;
    const slug = "bounded-control";
    globalThis.fetch = runtimeSuccessFetch(async () => response());

    const deployed = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('unreachable') };",
    });

    expect(deployed).toMatchObject({ success: false });
    expect(deployed.error).toMatch(expectedError);
    expect((await edgeFunctionService.getConfig(ref, slug)).version).toBeUndefined();
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("absent");
  });

  test("propagates corrupt candidate config without hiding valid active functions", async () => {
    const ref = "proj_list_corrupt_config";
    const projectDir = join(functionsRoot, ref);
    await Promise.all([
      mkdir(join(projectDir, ".versions", "configured", "1"), { recursive: true }),
      mkdir(join(projectDir, ".versions", "orphan", "1"), { recursive: true }),
      mkdir(join(projectDir, ".versions", "corrupt", "1"), { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(join(projectDir, "legacy.js"), "export default {};"),
      Bun.write(join(projectDir, "configured.config.json"), JSON.stringify({ version: "1" })),
      Bun.write(join(projectDir, "corrupt.config.json"), "{"),
    ]);

    await expect(edgeFunctionService.read(ref, "corrupt")).rejects.toThrow();
    await expect(edgeFunctionService.readSource(ref, "corrupt")).rejects.toThrow();
    await expect(edgeFunctionService.list(ref)).rejects.toThrow();

    await rm(join(projectDir, "corrupt.config.json"));
    expect(await edgeFunctionService.list(ref)).toEqual(["configured", "legacy"]);
  });

  test("rejects non-object function config documents at the read boundary", async () => {
    const ref = "proj_non_object_config";
    const projectDir = join(functionsRoot, ref);
    await mkdir(projectDir, { recursive: true });

    for (const [slug, document] of [["array", "[]"], ["null", "null"], ["scalar", '"value"']]) {
      await Bun.write(join(projectDir, `${slug}.config.json`), document);
      await expect(edgeFunctionService.read(ref, slug)).rejects.toThrow("Function config must be an object");
      await expect(edgeFunctionService.readSource(ref, slug)).rejects.toThrow("Function config must be an object");
    }
  });

  test("rejects noncanonical config versions without cross-function reads", async () => {
    const ref = "proj_version_path_binding";
    await writeCrossSlugFixture(ref);

    for (const [slug, version] of [
      ["traversal", "../other/1"],
      ["leading-zero", "01"],
      ["unsafe-integer", "9007199254740992"],
    ]) {
      if (slug !== "traversal") await writeConfiguredAliases(ref, slug, version);
      await expect(edgeFunctionService.read(ref, slug)).rejects.toThrow();
      await expect(edgeFunctionService.readSource(ref, slug)).rejects.toThrow();
    }
  });

  test("function read routes reject cross-function version paths", async () => {
    const ref = "proj_route_version_path_binding";
    await writeCrossSlugFixture(ref);

    const { projectFunctionsRoutes } = await import("../../src/routes/project-functions");
    const { projectService } = await import("../../src/services/project.service");
    const codeSpy = spyOn(projectService, "getFunctionCode")
      .mockImplementation((requestedRef, requestedSlug) => (
        edgeFunctionService.read(requestedRef, requestedSlug)
      ));
    const app = new Elysia().use(projectFunctionsRoutes);
    const request = (path: string) => app.handle(new Request(`http://localhost${path}`, {
      headers: { Authorization: "Bearer dev-master-token" },
    }));

    try {
      for (const suffix of ["", "/source", "/body"]) {
        const response = await request(`/v1/projects/${ref}/functions/traversal${suffix}`);
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(body).not.toContain("cross-slug");
        expect(body).not.toContain("stale-alias");
        expect(body).not.toContain('\"status\":\"ACTIVE\"');
      }
    } finally {
      codeSpy.mockRestore();
    }
  });

  test("version readbacks fail closed when the configured active bundle is missing", async () => {
    const ref = "proj_missing_active_version_readback";
    const slug = "missing-active-bundle";
    const projectDir = join(functionsRoot, ref);
    await mkdir(join(projectDir, ".versions", slug, "7"), { recursive: true });
    await Promise.all([
      Bun.write(join(projectDir, `${slug}.config.json`), JSON.stringify({ version: "7" })),
      Bun.write(join(projectDir, `${slug}.js`), "stale legacy alias"),
    ]);

    await expect(edgeFunctionService.listVersions(ref, slug))
      .rejects.toThrow("Active function artifact is missing");
    await expect(edgeFunctionService.getVersion(ref, slug, "7"))
      .rejects.toThrow("Active function artifact is missing");

    const { projectFunctionsRoutes } = await import("../../src/routes/project-functions");
    const app = new Elysia().use(projectFunctionsRoutes);
    const request = (path: string) => app.handle(new Request(`http://localhost${path}`, {
      headers: { Authorization: "Bearer dev-master-token" },
    }));

    for (const suffix of ["", "/7"]) {
      const response = await request(`/v1/projects/${ref}/functions/${slug}/versions${suffix}`);
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).not.toContain('"is_active":true');
      expect(body).not.toContain("stale legacy alias");
    }
  });

  test("keeps manifest-less legacy version zero readable without a versioned bundle", async () => {
    const ref = "proj_manifestless_legacy_zero";
    const slug = "legacy-zero";
    const projectDir = join(functionsRoot, ref);
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${slug}.js`), "legacy version zero");

    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("0");
    expect(await edgeFunctionService.listVersions(ref, slug)).toEqual([]);
    expect(await edgeFunctionService.read(ref, slug)).toBe("legacy version zero");
  });

  test("migrates only canonical legacy source-dir versions inside the matching slug root", async () => {
    const validRef = "proj_legacy_source_v0";
    const validSlug = "legacy-source";
    const validSourceDir = join(functionsRoot, validRef, `.src-${validSlug}-v0`);
    await mkdir(validSourceDir, { recursive: true });
    await Bun.write(join(validSourceDir, "index.ts"), "export default {};");

    await migrateLegacyVersionArtifacts();
    expect(await readFile(join(
      functionsRoot,
      validRef,
      ".versions",
      validSlug,
      "0",
      "src",
      "index.ts",
    ), "utf8")).toBe("export default {};");

    for (const version of ["01", "9007199254740992"]) {
      const ref = `proj_legacy_source_invalid_${version}`;
      const slug = "legacy-source";
      const sourceDir = join(functionsRoot, ref, `.src-${slug}-v${version}`);
      await mkdir(sourceDir, { recursive: true });
      await Bun.write(join(sourceDir, "index.ts"), "invalid legacy source");

      await expect(migrateLegacyVersionArtifacts()).rejects.toThrow();
      expect(existsSync(sourceDir)).toBe(true);
      expect(existsSync(join(functionsRoot, ref, ".versions", slug, version))).toBe(false);

      await rm(join(functionsRoot, ref), { recursive: true, force: true });
    }
  });

  test("migrates legacy metadata from the immutable artifact instead of a mutable alias", async () => {
    const ref = "proj_legacy_immutable_authority";
    const slug = "legacy-immutable-authority";
    const versionDir = join(functionsRoot, ref, ".versions", slug, "1");
    const immutableCode = "export default { fetch: () => new Response('immutable') };";
    const artifactSha256 = createHash("sha256").update(immutableCode).digest("hex");
    await mkdir(versionDir, { recursive: true });
    await Promise.all([
      Bun.write(join(versionDir, `index.${artifactSha256.slice(0, 16)}.js`), immutableCode),
      Bun.write(join(versionDir, "index.js"), "export default { fetch: () => new Response('tampered') };"),
      Bun.write(join(versionDir, ".supacloud-version.json"), JSON.stringify({
        version: "1",
        verify_jwt: false,
        background_routes: [],
        import_map: null,
        entrypoint: null,
      })),
    ]);

    expect(await migrateLegacyVersionArtifacts()).toEqual({ moved: 1 });
    expect(JSON.parse(await readFile(
      join(versionDir, ".supacloud-version.json"),
      "utf8",
    ))).toMatchObject({ artifact_sha256: artifactSha256 });
    expect(await getVersionedArtifactPath(ref, slug, "1"))
      .toBe(join(versionDir, `index.${artifactSha256.slice(0, 16)}.js`));
  });

  test("rejects unsafe startup migration parents without touching an external version target", async () => {
    const migrationRoot = await mkdtemp(join(homedir(), ".supacloud-legacy-migration-"));
    const ref = "proj_unsafe_legacy_migration";
    const slug = "unsafe-legacy";
    const projectDirectory = join(migrationRoot, ref);
    const outsideDirectory = join(migrationRoot, `${ref}_outside`);
    const legacyArtifact = join(projectDirectory, `${slug}.v1.js`);
    await mkdir(projectDirectory, { mode: 0o700 });
    await mkdir(outsideDirectory, { mode: 0o700 });
    await Bun.write(legacyArtifact, "legacy artifact");
    await Bun.write(join(outsideDirectory, "sentinel"), "unchanged");
    await fs.symlink(outsideDirectory, join(projectDirectory, ".versions"), "dir");
    await fs.chmod(projectDirectory, 0o777);
    process.env.EDGE_FUNCTIONS_DIR = migrationRoot;

    try {
      await expect(migrateLegacyVersionArtifacts()).rejects.toThrow(
        "Function mutation directory is not trusted",
      );
      expect(await Bun.file(legacyArtifact).text()).toBe("legacy artifact");
      expect(await fs.readdir(outsideDirectory)).toEqual(["sentinel"]);
      expect(await Bun.file(join(outsideDirectory, "sentinel")).text()).toBe("unchanged");
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await fs.chmod(projectDirectory, 0o700);
      await rm(migrationRoot, { recursive: true, force: true });
    }
  });

  test("rejects a version-directory symlink before legacy migration changes either tree", async () => {
    const migrationRoot = await mkdtemp(join(homedir(), ".supacloud-legacy-version-link-"));
    const ref = "proj_legacy_version_link";
    const slug = "legacy-version-link";
    const projectDirectory = join(migrationRoot, ref);
    const versionSlugDirectory = join(projectDirectory, ".versions", slug);
    const outsideDirectory = join(migrationRoot, `${ref}_outside`);
    const legacyArtifact = join(projectDirectory, `${slug}.v1.js`);
    await mkdir(versionSlugDirectory, { recursive: true, mode: 0o700 });
    await mkdir(outsideDirectory, { mode: 0o700 });
    await Bun.write(legacyArtifact, "legacy artifact");
    await Bun.write(join(outsideDirectory, "index.js"), "outside artifact");
    await Bun.write(join(outsideDirectory, "sentinel"), "unchanged");
    await fs.symlink(outsideDirectory, join(versionSlugDirectory, "1"), "dir");
    process.env.EDGE_FUNCTIONS_DIR = migrationRoot;

    try {
      await expect(migrateLegacyVersionArtifacts()).rejects.toThrow(
        "Function mutation directory is not trusted",
      );
      expect(await Bun.file(legacyArtifact).text()).toBe("legacy artifact");
      expect((await fs.readdir(outsideDirectory)).sort()).toEqual(["index.js", "sentinel"]);
      expect(await Bun.file(join(outsideDirectory, "index.js")).text()).toBe("outside artifact");
      expect(await Bun.file(join(outsideDirectory, "sentinel")).text()).toBe("unchanged");
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await rm(migrationRoot, { recursive: true, force: true });
    }
  });

  test.each(["file", "directory"] as const)(
    "rejects a legacy %s source symlink before creating a version target",
    async (sourceType) => {
      const migrationRoot = await mkdtemp(join(homedir(), `.supacloud-legacy-${sourceType}-link-`));
      const ref = `proj_legacy_${sourceType}_link`;
      const slug = `legacy-${sourceType}-link`;
      const projectDirectory = join(migrationRoot, ref);
      const externalPath = join(migrationRoot, `external-${sourceType}`);
      const sourcePath = sourceType === "file"
        ? join(projectDirectory, `${slug}.v1.js`)
        : join(projectDirectory, `.src-${slug}-v1`);
      await mkdir(projectDirectory, { mode: 0o700 });
      if (sourceType === "file") await Bun.write(externalPath, "external file");
      else {
        await mkdir(externalPath, { mode: 0o700 });
        await Bun.write(join(externalPath, "sentinel"), "external directory");
      }
      await fs.symlink(externalPath, sourcePath, sourceType === "file" ? "file" : "dir");
      process.env.EDGE_FUNCTIONS_DIR = migrationRoot;

      try {
        await expect(migrateLegacyVersionArtifacts()).rejects.toThrow(
          "Legacy Function migration source has an invalid type",
        );
        expect((await fs.lstat(sourcePath)).isSymbolicLink()).toBe(true);
        expect(existsSync(join(projectDirectory, ".versions"))).toBe(false);
        if (sourceType === "file") expect(await Bun.file(externalPath).text()).toBe("external file");
        else expect(await Bun.file(join(externalPath, "sentinel")).text()).toBe("external directory");
      } finally {
        process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
        await rm(migrationRoot, { recursive: true, force: true });
      }
    },
  );

  test("propagates a non-directory functions root during startup migration", async () => {
    const migrationRoot = await mkdtemp(join(homedir(), ".supacloud-legacy-root-error-"));
    const functionsFile = join(migrationRoot, "functions-file");
    await Bun.write(functionsFile, "not a directory");
    process.env.EDGE_FUNCTIONS_DIR = functionsFile;

    try {
      await expect(migrateLegacyVersionArtifacts()).rejects.toMatchObject({ code: "ENOTDIR" });
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await rm(migrationRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(process.geteuid?.() === undefined || process.geteuid() === 0)(
    "propagates an unreadable project directory during startup migration",
    async () => {
      const migrationRoot = await mkdtemp(join(homedir(), ".supacloud-legacy-project-error-"));
      const projectDirectory = join(migrationRoot, "proj_unreadable_legacy_migration");
      await mkdir(projectDirectory, { mode: 0o700 });
      await fs.chmod(projectDirectory, 0o000);
      process.env.EDGE_FUNCTIONS_DIR = migrationRoot;

      try {
        await expect(migrateLegacyVersionArtifacts()).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
        await fs.chmod(projectDirectory, 0o700);
        await rm(migrationRoot, { recursive: true, force: true });
      }
    },
  );

  test("rejects invalid project and Function identities before legacy migration writes", async () => {
    const migrationRoot = await mkdtemp(join(homedir(), ".supacloud-legacy-identity-"));
    const invalidProject = join(migrationRoot, "invalid.project");
    await mkdir(invalidProject);
    await Bun.write(join(invalidProject, "valid-slug.v1.js"), "invalid project");
    process.env.EDGE_FUNCTIONS_DIR = migrationRoot;

    try {
      await expect(migrateLegacyVersionArtifacts()).rejects.toThrow("Invalid project ref");
      expect(await fs.readdir(invalidProject)).toEqual(["valid-slug.v1.js"]);
      await rm(invalidProject, { recursive: true, force: true });

      const validProject = join(migrationRoot, "proj_invalid_legacy_slug");
      await mkdir(validProject);
      await Bun.write(join(validProject, "invalid.slug.v1.js"), "invalid slug");
      await expect(migrateLegacyVersionArtifacts()).rejects.toThrow("Invalid function slug");
      expect(await fs.readdir(validProject)).toEqual(["invalid.slug.v1.js"]);
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await rm(migrationRoot, { recursive: true, force: true });
    }
  });

  test("propagates unreadable version artifact directories", async () => {
    const ref = "proj_artifact_io";
    const slug = "hello";
    const projectDir = join(functionsRoot, ref);
    const versionDir = join(
      projectDir,
      ".versions",
      slug,
      "1",
    );
    await mkdir(versionDir, { recursive: true });
    await Promise.all([
      Bun.write(join(projectDir, `${slug}.config.json`), JSON.stringify({ version: "1" })),
      Bun.write(join(projectDir, `${slug}.js`), "stale alias bundle"),
      Bun.write(join(projectDir, `${slug}.src.ts`), "stale alias source"),
    ]);
    await fs.chmod(versionDir, 0o000);

    try {
      await expect(getVersionedArtifactPath(ref, slug, "1"))
        .rejects.toMatchObject({ code: "EACCES" });
      await expect(edgeFunctionService.read(ref, slug)).rejects.toMatchObject({ code: "EACCES" });
      await expect(edgeFunctionService.readSource(ref, slug)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await fs.chmod(versionDir, 0o700);
    }
  });

  test("normalizes computed imports in final single-file and bundle artifacts", async () => {
    const functionCode = `
      var optionalPackage = "optional-runtime-package";
      export default {
        fetch: async () => Response.json(await import(optionalPackage).catch(() => null)),
      };
    `;
    const singleFile = await edgeFunctionService.deployDetailed(
      "proj_normalized_single",
      "normalized-single",
      functionCode,
    );
    const bundle = await edgeFunctionService.deployBundleDetailed(
      "proj_normalized_bundle",
      "normalized-bundle",
      { "index.ts": functionCode },
    );

    for (const deployment of [singleFile, bundle]) {
      expect(deployment).toMatchObject({ success: true, import_count: 2 });
      const artifactCode = await readFile(deployment.content_path!, "utf8");
      expect(artifactCode).toContain('import("optional-runtime-package")');
      expect(artifactCode).toContain('import("undefined")');
      expect(artifactCode).not.toContain("import(optionalPackage)");
      expect(deployment.bundle_size_bytes).toBe(Buffer.byteLength(artifactCode));
      expect(deployment.bundle_hash).toBe(
        createHash("sha256").update(artifactCode).digest("hex").slice(0, 16),
      );
    }
  });

  test("stores verified prebundled source and runtime artifacts as the exact submitted bytes", async () => {
    const ref = "proj_prebundled_exact";
    const slug = "fa-api";
    const code = "export default { fetch: () => new Response('精确字节') };\r\n";
    const expectedSha256 = createHash("sha256").update(code).digest("hex");
    const buildSpy = spyOn(Bun, "build");

    try {
      const deployed = await edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "absent",
        expectedActivationId: "legacy",
        code,
        prebundled: true,
        expectedSha256,
      });

      expect(deployed).toMatchObject({
        success: true,
        previous_active_version: "absent",
        active_version: "1",
        version: "1",
        bundle_hash: expectedSha256.slice(0, 16),
        bundle_size_bytes: Buffer.byteLength(code),
      });
      expect(buildSpy).not.toHaveBeenCalled();
      expect(await readFile(deployed.content_path!)).toEqual(Buffer.from(code));
      expect(await readFile(join(
        functionsRoot,
        ref,
        ".versions",
        slug,
        "1",
        "index.src.ts",
      ))).toEqual(Buffer.from(code));
      expect(await edgeFunctionService.getVersion(ref, slug, "1")).toMatchObject({
        bundle_code: code,
        source_code: code,
      });
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("writes the attested source entry for every immutable deployment path", async () => {
    globalThis.fetch = runtimeSuccessFetch();
    const single = await edgeFunctionService.deployDetailed(
      "proj_attested_single",
      "single",
      "export default { fetch: () => new Response('single') };",
    );
    const prebundledCode = "export default { fetch: () => new Response('prebundled') };";
    const prebundled = await edgeFunctionService.deployRelease({
      ref: "proj_attested_prebundled",
      slug: "prebundled",
      expectedActiveVersion: "absent",
      expectedActivationId: "legacy",
      code: prebundledCode,
      prebundled: true,
      expectedSha256: createHash("sha256").update(prebundledCode).digest("hex"),
    });
    const bundle = await edgeFunctionService.deployBundleDetailed(
      "proj_attested_bundle",
      "bundle",
      { "index.ts": "export default { fetch: () => new Response('bundle') };" },
    );

    expect(single.success).toBe(true);
    expect(prebundled.success).toBe(true);
    expect(bundle.success).toBe(true);
    await expectAttestedRuntimeEntry("proj_attested_single", "single", single);
    await expectAttestedRuntimeEntry("proj_attested_prebundled", "prebundled", prebundled);
    await expectAttestedRuntimeEntry("proj_attested_bundle", "bundle", bundle);
  });

  test("rejects prebundled bytes that require runtime normalization before mutation", async () => {
    const ref = "proj_prebundled_normalization";
    const slug = "fa-api";
    const code = [
      'var runtimePackage = "optional-runtime-package";',
      "export default { fetch: async () => Response.json(await import(runtimePackage)) };",
      "",
    ].join("\n");
    let runtimeCalls = 0;
    globalThis.fetch = (async () => {
      runtimeCalls += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    const buildSpy = spyOn(Bun, "build");

    try {
      const rejected = await edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "absent",
        expectedActivationId: "legacy",
        code,
        prebundled: true,
        expectedSha256: createHash("sha256").update(code).digest("hex"),
      });

      expect(rejected).toMatchObject({ success: false });
      expect(rejected.error).toContain("would be modified");
      expect(buildSpy).not.toHaveBeenCalled();
      expect(runtimeCalls).toBe(0);
      expect(await edgeFunctionService.listVersions(ref, slug)).toEqual([]);
      expect(await edgeFunctionService.getConfig(ref, slug)).toEqual({
        verify_jwt: true,
        activation_id: "legacy",
      });
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("rejects a prebundled SHA-256 mismatch before mutation", async () => {
    const ref = "proj_prebundled_hash_mismatch";
    const slug = "fa-api";
    const code = "export default { fetch: () => new Response('replaced') };\n";
    let runtimeCalls = 0;
    globalThis.fetch = (async () => {
      runtimeCalls += 1;
      return Response.json({ success: true });
    }) as typeof fetch;
    const buildSpy = spyOn(Bun, "build");

    try {
      const rejected = await edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "absent",
        expectedActivationId: "legacy",
        code,
        prebundled: true,
        expectedSha256: createHash("sha256").update("approved").digest("hex"),
      });

      expect(rejected).toMatchObject({ success: false });
      expect(rejected.error).toContain("does not match expected_sha256");
      expect(buildSpy).not.toHaveBeenCalled();
      expect(runtimeCalls).toBe(0);
      expect(await edgeFunctionService.listVersions(ref, slug)).toEqual([]);
      expect(await edgeFunctionService.getConfig(ref, slug)).toEqual({
        verify_jwt: true,
        activation_id: "legacy",
      });
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("rejects unresolved computed imports without activating a new version", async () => {
    const ref = "proj_computed_import_rejected";
    const slug = "computed-import-rejected";
    const first = await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('version-one') };",
    );
    const rejected = await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: async () => Response.json(await import(process.env.RUNTIME_PACKAGE)) };",
    );

    expect(first).toMatchObject({ success: true, version: "1" });
    expect(rejected).toMatchObject({ success: false });
    expect(rejected.error).toContain("computed dynamic imports are disabled");
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "1" });
    expect((await edgeFunctionService.listVersions(ref, slug)).map((version) => version.version))
      .toEqual(["1"]);
  });

  test("does not write or preheat a single-file version when Bun.build fails", async () => {
    const ref = "proj_single_build_failure";
    const slug = "single-build-failure";
    let runtimeCalls = 0;
    globalThis.fetch = (async () => {
      runtimeCalls += 1;
      return Response.json({ success: true, version: "1" });
    }) as typeof fetch;

    const rejected = await edgeFunctionService.deployDetailed(
      ref,
      slug,
      `
        import "./missing-build-input.ts";
        export default { fetch: () => new Response("unreachable") };
      `,
    );

    expect(rejected).toMatchObject({ success: false });
    expect(rejected.error).toMatch(/bundle/i);
    expect(runtimeCalls).toBe(0);
    expect(await edgeFunctionService.getConfig(ref, slug)).toEqual({
      verify_jwt: true,
      activation_id: "legacy",
    });
    expect(await edgeFunctionService.listVersions(ref, slug)).toEqual([]);
    expect(existsSync(join(functionsRoot, ref, ".versions", slug, "1"))).toBe(false);
  });

  test("keeps verify_jwt=false invisible until candidate readiness succeeds", async () => {
    const ref = "proj_atomic_false";
    const slug = "public-hook";
    let configDuringPreheat: unknown;
    globalThis.fetch = runtimeSuccessFetch(async (url, init) => {
      configDuringPreheat = await edgeFunctionService.getConfig(ref, slug);
      return runtimePreheatSuccess(url, init);
    });

    const deployed = await deployConditionalRelease({
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
    expect(configDuringPreheat).toEqual({
      verify_jwt: true,
      activation_id: "legacy",
    });
  });

  test("preserves an existing false policy when a later deploy omits policy", async () => {
    const ref = "proj_preserve_false";
    const slug = "public-hook";
    await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });

    const deployed = await deployConditionalRelease({
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

  test("never promotes a mutable version alias into immutable rollback authority", async () => {
    const ref = "proj_immutable_rollback_authority";
    const slug = "immutable-rollback-authority";
    const first = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('immutable-v1') };",
    });
    const versionDirectory = join(functionsRoot, ref, ".versions", slug, "1");
    const metadataPath = join(versionDirectory, ".supacloud-version.json");
    const originalMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      artifact_sha256: string;
    };

    await Bun.write(
      join(versionDirectory, "index.js"),
      "export default { fetch: () => new Response('tampered-alias') };",
    );
    const second = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('immutable-v2') };",
    });

    expect(first).toMatchObject({ success: true, version: "1" });
    expect(second).toMatchObject({ success: true, version: "2" });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      artifact_sha256: originalMetadata.artifact_sha256,
    });
    await activateConditionalVersion(ref, slug, "1");
    expect(await edgeFunctionService.read(ref, slug)).toContain("immutable-v1");
    expect(await edgeFunctionService.read(ref, slug)).not.toContain("tampered-alias");
  });

  test("clears bundle source metadata when a single-file version becomes active", async () => {
    const ref = "proj_single_metadata";
    const slug = "metadata-clear";
    await deployConditionalRelease({
      ref,
      slug,
      files: {
        "worker.ts": "export default { fetch: () => new Response('bundle') };",
        "import_map.json": JSON.stringify({ imports: {} }),
      },
      entrypoint: "worker.ts",
    });

    const singleFile = await deployConditionalRelease({
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
    const deployed = await deployConditionalRelease({
      ref: "proj_default_true",
      slug: "secured",
      code: "export default { fetch: () => new Response('secured') };",
    });

    expect(deployed.config).toMatchObject({ verify_jwt: true, version: "1" });
  });

  test("snapshots frozen legacy aliases before first deploy and restores version zero", async () => {
    const ref = "proj_legacy_migration";
    const slug = "legacy-hook";
    await mkdir(join(functionsRoot, ref), { recursive: true });
    await Bun.write(join(functionsRoot, ref, `${slug}.config.json`), JSON.stringify({
      verify_jwt: false,
      background_routes: ["/legacy/*"],
    }));
    const legacyBundlePath = join(functionsRoot, ref, `${slug}.js`);
    const legacySourcePath = join(functionsRoot, ref, `${slug}.src.ts`);
    await Bun.write(legacyBundlePath, "export default { fetch: () => new Response('legacy') };");
    await Bun.write(legacySourcePath, "export default { fetch: () => new Response('legacy-source') };");
    const legacyBundleBefore = await readFile(legacyBundlePath, "utf8");
    const legacySourceBefore = await readFile(legacySourcePath, "utf8");

    const deployed = await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('immutable-v1') };",
    );

    expect(deployed.config).toMatchObject({ verify_jwt: false, version: "1" });
    expect(await readFile(legacyBundlePath, "utf8")).toBe(legacyBundleBefore);
    expect(await readFile(legacySourcePath, "utf8")).toBe(legacySourceBefore);
    expect(await edgeFunctionService.read(ref, slug)).toContain("immutable-v1");
    expect(await edgeFunctionService.list(ref)).toContain(slug);

    const restored = await activateConditionalVersion(ref, slug, "0");

    expect(restored).toMatchObject({
      version: "0",
      verify_jwt: false,
      background_routes: ["/legacy/*"],
    });
    expect(Object.hasOwn(restored!, "entrypoint")).toBe(false);
    expect(Object.hasOwn(restored!, "import_map")).toBe(false);
    expect(await edgeFunctionService.read(ref, slug)).toContain("legacy");
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("legacy-source");
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("0");

    const stale = await edgeFunctionService.deployRelease({
      ref,
      slug,
      expectedActiveVersion: "1",
      expectedActivationId: restored!.activation_id,
      code: "export default { fetch: () => new Response('stale-release') };",
    });

    expect(stale).toMatchObject({
      success: false,
      error_code: EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
      expected_active_version: "1",
      active_version: "0",
    });
    expect((await edgeFunctionService.listVersions(ref, slug)).map(({ version }) => version))
      .toEqual(["1", "0"]);
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "0" });
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("legacy-source");

    const continued = await edgeFunctionService.deployRelease({
      ref,
      slug,
      expectedActiveVersion: "0",
      expectedActivationId: restored!.activation_id,
      code: "export default { fetch: () => new Response('post-legacy-release') };",
    });

    expect(continued).toMatchObject({
      success: true,
      previous_active_version: "0",
      active_version: "2",
      version: "2",
      config: { version: "2" },
    });
    expect(await edgeFunctionService.readSource(ref, slug)).toContain("post-legacy-release");
  });

  test("rejects deploy when a configured positive artifact is missing despite a legacy alias", async () => {
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
    const manifestPath = join(projectDir, `${slug}.config.json`);
    const manifestBefore = await readFile(manifestPath, "utf8");
    let runtimeRequests = 0;
    globalThis.fetch = (async () => {
      runtimeRequests += 1;
      return Response.json({ success: true });
    }) as typeof fetch;

    await expect(edgeFunctionService.read(ref, slug))
      .rejects.toThrow("Active function artifact is missing");
    expect(await edgeFunctionService.readSource(ref, slug)).toBeNull();

    const deployed = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('version-eight') };",
      config: { verify_jwt: true, background_routes: ["/eight/*"] },
    });

    expect(deployed).toMatchObject({ success: false });
    expect(deployed.error).toContain("Active function version artifact is missing");
    expect(runtimeRequests).toBe(0);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(existsSync(join(versionDir, "index.js"))).toBe(false);
    expect(existsSync(join(projectDir, ".versions", slug, "8"))).toBe(false);
    expect(await Bun.file(legacyBundlePath).text()).toBe(legacyBundle);
    expect(await Bun.file(legacySourcePath).text()).toContain("source-seven");
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

    const deployed = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('version-four') };",
      config: { verify_jwt: true, background_routes: ["/four/*"] },
    });

    expect(deployed).toMatchObject({ success: true, version: "4" });
    const restored = await activateConditionalVersion(ref, slug, "3");
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
    await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const corruptedManifest = '{"verify_jwt": false';
    const corruptedReplacement = `${manifestPath}.corrupt.tmp`;
    await Bun.write(corruptedReplacement, corruptedManifest);
    await fs.rename(corruptedReplacement, manifestPath);

    const failed = await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('v2') };",
    );

    expect(failed.success).toBe(false);
    expect(await readFile(manifestPath, "utf8")).toBe(corruptedManifest);
  });

  test("does not publish a config-only candidate when readiness fails", async () => {
    const ref = "proj_config_rollback";
    const slug = "config-hook";
    await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('active') };",
      config: { verify_jwt: false },
    });
    const current = await edgeFunctionService.getConfig(ref, slug);
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const manifestBefore = await readFile(manifestPath, "utf8");
    globalThis.fetch = runtimeSuccessFetch(async () => (
      Response.json({ message: "unavailable" }, { status: 503 })
    ));

    await expect(edgeFunctionService.updateConfig(
      ref,
      slug,
      { verify_jwt: true },
      current.activation_id,
    )).rejects.toThrow("candidate readiness");
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(await edgeFunctionService.getConfig(ref, slug)).toEqual(current);
  });

  test("keeps the commit-point manifest when runtime commit remains uncertain", async () => {
    const ref = "proj_manifest_rollback";
    const slug = "public-hook";
    await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v1') };",
      config: { verify_jwt: false },
    });
    const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
    const manifestBefore = await readFile(manifestPath, "utf8");
    let candidateActivationId: string | null = null;
    let uncertainCommitCalls = 0;
    globalThis.fetch = runtimeSuccessFetch(runtimePreheatSuccess, (context) => {
      if (context.action === "begin") candidateActivationId = context.activationId;
      const isUncertainCommit = context.activationId === candidateActivationId
        && context.activeActivationId === candidateActivationId
        && (context.action === "commit" || context.action === "status");
      if (!isUncertainCommit) return null;
      uncertainCommitCalls += 1;
      return Response.json({ message: "unavailable" }, { status: 503 });
    });

    const failed = await deployConditionalRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('v2') };",
      config: { verify_jwt: true },
    });

    expect(failed.success).toBe(false);
    expect(failed.error).toContain("runtime activation state is uncertain");
    const manifestAfter = await readFile(manifestPath, "utf8");
    expect(manifestAfter).not.toBe(manifestBefore);
    expect(JSON.parse(manifestAfter)).toMatchObject({
      verify_jwt: true,
      version: "2",
      _supacloud_activation: { activation_id: candidateActivationId },
    });
    expect(uncertainCommitCalls).toBeGreaterThan(0);
  });

  test("allocates after retained history instead of overwriting a rolled-back version", async () => {
    const ref = "proj_rollback_history";
    const slug = "history-safe";
    globalThis.fetch = runtimeSuccessFetch();

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

    await activateConditionalVersion(ref, slug, "1");

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
    await mkdir(join(functionsRoot, configRef), { recursive: true });
    await Bun.write(
      join(functionsRoot, configRef, `${configSlug}.config.json`),
      JSON.stringify({ version: unsafeVersion }),
    );

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

  test("rejects a stale deploy before creating, preheating, or activating a version", async () => {
    const ref = "proj_stale_deploy";
    const slug = "stale-deploy";
    await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('version-one') };",
    );
    const current = await edgeFunctionService.getConfig(ref, slug);
    let runtimeCalls = 0;
    globalThis.fetch = (async () => {
      runtimeCalls += 1;
      return Response.json({});
    }) as typeof fetch;
    const buildSpy = spyOn(Bun, "build");

    try {
      const rejected = await edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "2",
        expectedActivationId: current.activation_id,
        code: "export default { fetch: () => new Response('must-not-build') };",
      });

      expect(rejected).toMatchObject({
        success: false,
        error_code: EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
        expected_active_version: "2",
        active_version: "1",
      });
      expect(buildSpy).not.toHaveBeenCalled();
      expect(runtimeCalls).toBe(0);
      expect((await edgeFunctionService.listVersions(ref, slug)).map(({ version }) => version))
        .toEqual(["1"]);
      expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "1" });
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("allows only one concurrent deploy with the same expected active version", async () => {
    const ref = "proj_cas_concurrent";
    const slug = "cas-concurrent";
    await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('version-one') };",
    );
    const current = await edgeFunctionService.getConfig(ref, slug);

    const releases = await Promise.all([
      edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "1",
        expectedActivationId: current.activation_id,
        code: "export default { fetch: () => new Response('candidate-a') };",
      }),
      edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion: "1",
        expectedActivationId: current.activation_id,
        code: "export default { fetch: () => new Response('candidate-b') };",
      }),
    ]);

    expect(releases.filter(({ success }) => success)).toHaveLength(1);
    expect(releases.filter(({ error_code }) =>
      error_code === EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE)).toHaveLength(1);
    expect((await edgeFunctionService.listVersions(ref, slug)).map(({ version }) => version))
      .toEqual(["2", "1"]);
    expect(await edgeFunctionService.getConfig(ref, slug)).toMatchObject({ version: "2" });
  });

  test.each(["01", "", "9007199254740992"])(
    "rejects invalid expected active version %j without mutation",
    async (expectedActiveVersion) => {
      const ref = `proj_invalid_expected_${expectedActiveVersion || "empty"}`;
      const slug = "invalid-expected";
      const rejected = await edgeFunctionService.deployRelease({
        ref,
        slug,
        expectedActiveVersion,
        expectedActivationId: "legacy",
        code: "export default { fetch: () => new Response('must-not-deploy') };",
      });

      expect(rejected.success).toBe(false);
      expect(await edgeFunctionService.listVersions(ref, slug)).toEqual([]);
      expect((await edgeFunctionService.getConfig(ref, slug)).version).toBeUndefined();
    },
  );

  test("keeps multi-file runtime code beside its static assets", async () => {
    globalThis.fetch = runtimeSuccessFetch();

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

  test("commits a target tombstone and removes only its immutable artifacts", async () => {
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
    const targetBefore = await edgeFunctionService.getConfig(ref, targetSlug);

    const removal = await edgeFunctionService.remove(
      ref,
      targetSlug,
      targetBefore.activation_id,
    );
    expect(removal).toMatchObject({
      previous_active_version: "1",
      active_version: "absent",
    });
    expect(existsSync(join(functionsRoot, ref, `${targetSlug}.config.json`))).toBe(true);
    expect(existsSync(join(functionsRoot, ref, ".versions", targetSlug))).toBe(false);
    expect(existsSync(join(functionsRoot, ref, `${siblingSlug}.config.json`))).toBe(true);
    expect(existsSync(join(functionsRoot, ref, ".versions", siblingSlug))).toBe(true);
    expect(await edgeFunctionService.getConfig(ref, targetSlug)).toEqual({
      verify_jwt: true,
      activation_id: removal.activation_id,
    });
    await Promise.all([
      Bun.write(join(functionsRoot, ref, `${targetSlug}.js`), "residual-bundle"),
      Bun.write(join(functionsRoot, ref, `${targetSlug}.src.ts`), "residual-source"),
    ]);
    expect(await edgeFunctionService.read(ref, targetSlug)).toBeNull();
    expect(await edgeFunctionService.readSource(ref, targetSlug)).toBeNull();
  });

  test("preserves the active authority when delete fencing is not acknowledged", async () => {
    const ref = "proj_delete_unconfirmed";
    const slug = "delete-unconfirmed";
    await edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('delete-me') };",
    );
    const current = await edgeFunctionService.getConfig(ref, slug);
    let failedControlCalls = 0;
    globalThis.fetch = runtimeSuccessFetch(runtimePreheatSuccess, (context) => {
      if (context.activationId === current.activation_id) return null;
      failedControlCalls += 1;
      return Response.json({ message: "unavailable" }, { status: 503 });
    });

    await expect(edgeFunctionService.remove(ref, slug, current.activation_id))
      .rejects.toThrow("runtime activation state is uncertain");
    expect(failedControlCalls).toBeGreaterThan(0);
    expect(await edgeFunctionService.getConfig(ref, slug)).toEqual(current);
    expect(existsSync(join(functionsRoot, ref, ".versions", slug))).toBe(true);
  });

  test("writes content-addressed version artifacts and returns deploy preheat metadata", async () => {
    const metricsBefore = edgeFunctionService.deployMetrics();
    const fetchCalls: string[] = [];
    const runtimeFetch = runtimeSuccessFetch((url, init) => runtimePreheatSuccess(
      url,
      init,
      { attempted: 2, succeeded: 2, cacheHits: 0, cacheMisses: 2, durationMs: 12 },
      { attempted: 1, succeeded: 1, cacheHits: 1, cacheMisses: 0, durationMs: 4 },
    ));
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push(String(input));
      return runtimeFetch(input, init);
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
    expect(result.import_count).toBe(1);
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
      total_import_count: metricsBefore.total_import_count + 1,
      last_import_count: 1,
      total_preheat_duration_ms: metricsBefore.total_preheat_duration_ms + result.preheat!.duration_ms,
      last_preheat_duration_ms: result.preheat?.duration_ms,
      total_preheat_attempted: metricsBefore.total_preheat_attempted + 3,
      total_preheat_succeeded: metricsBefore.total_preheat_succeeded + 3,
      total_preheat_cache_hits: metricsBefore.total_preheat_cache_hits + 1,
      total_preheat_cache_misses: metricsBefore.total_preheat_cache_misses + 2,
    });

    expect(fetchCalls.some((url) => url.endsWith("/function-activation/proj_meta/hello/begin")))
      .toBe(true);
    expect(fetchCalls.some((url) => url.includes("/preheat/proj_meta/hello"))).toBe(true);
    expect(fetchCalls.some((url) => url.endsWith("/function-activation/proj_meta/hello/commit")))
      .toBe(true);
  });
});

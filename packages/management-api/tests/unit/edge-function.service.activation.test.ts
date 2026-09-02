import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  stat,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const functionsRoot = await mkdtemp(join(homedir(), ".supacloud-function-activation-"));
const canonicalTemporaryRoot = await realpath(tmpdir());
const originalFunctionsDir = process.env.EDGE_FUNCTIONS_DIR;
const originalRuntimeInternal = process.env.EDGE_RUNTIME_INTERNAL;
const originalFetch = globalThis.fetch;

process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

const {
  EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
  edgeFunctionService,
  ensureEdgeFunctionLogsForExistingProjects,
  ensureFunctionLogsDirectory,
  getVersionedArtifactPath,
} = await import("../../src/services/edge-function.service");
const { config } = await import("../../src/config");

const RUNTIME_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const LOADED_REVISION = `hmac-sha256:${"a".repeat(64)}`;
const ENV_PROOF = `hmac-sha256:${"b".repeat(64)}`;
const FOREGROUND_MODULE_PROOF = `hmac-sha256:${"c".repeat(64)}`;
const BACKGROUND_MODULE_PROOF = `hmac-sha256:${"d".repeat(64)}`;

type ActivationDocument = {
  verify_jwt?: boolean;
  version?: string;
  _supacloud_activation?: {
    activation_id: string;
    activation_generation: number;
  };
};

type RuntimeHook = (context: {
  ref: string;
  slug: string;
  activationId: string;
}) => void | Promise<void>;

async function activeDocument(ref: string, slug: string): Promise<ActivationDocument | null> {
  try {
    return JSON.parse(
      await readFile(join(functionsRoot, ref, `${slug}.config.json`), "utf8"),
    ) as ActivationDocument;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function candidateDocument(
  ref: string,
  slug: string,
  activationId: string,
): Promise<ActivationDocument> {
  return JSON.parse(await readFile(join(
    functionsRoot,
    ref,
    ".activation-generations",
    slug,
    `${activationId}.json`,
  ), "utf8")) as ActivationDocument;
}

async function directoryShape(directory: string, prefix = ""): Promise<string[]> {
  const shape: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    const entryType = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file";
    shape.push(`${entryType}:${relativePath}`);
    if (entry.isDirectory()) {
      shape.push(...await directoryShape(join(directory, entry.name), relativePath));
    }
  }
  return shape.sort();
}

function activationControlAck(
  activationId: string,
  state: "fenced" | "commit_pending" | "committed" | "aborted" | "uncertain",
  generation: number,
) {
  return {
    schema: "supacloud.edge-runtime-function-activation.v1",
    activation_id: activationId,
    state,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    foreground_generation: generation,
    background_generation: generation,
    cancelled_queued: 0,
  };
}

function preheatRotation() {
  return {
    generation: 2,
    attempted: 0,
    idleRetired: 0,
    busyTainted: 0,
    alreadyTainted: 0,
    immediateReplacements: 0,
  };
}

function preheatPool(attestation: object) {
  return {
    attempted: 1,
    succeeded: 1,
    cacheHits: 0,
    cacheMisses: 1,
    durationMs: 1,
    attestation,
    rotation: preheatRotation(),
  };
}

async function preheatAck(input: string, init?: RequestInit) {
  const url = new URL(input);
  const segments = url.pathname.split("/");
  const ref = segments.at(-2)!;
  const slug = segments.at(-1)!;
  const headers = new Headers(init?.headers);
  const activationId = headers.get("x-supacloud-activation-id")!;
  const requestedVersion = headers.get("x-supacloud-function-version")!;
  const candidate = await candidateDocument(ref, slug, activationId);
  const artifactPath = await getVersionedArtifactPath(ref, slug, requestedVersion);
  if (!artifactPath) throw new Error("Test candidate artifact is unavailable");
  const artifactSha256 = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  const identity = {
    schema: "supacloud.edge-runtime-preheat-attestation.v1",
    project_ref: ref,
    function_slug: slug,
    requested_version: requestedVersion,
    target_version: requestedVersion,
    resolved_version: requestedVersion,
    artifact_sha256: artifactSha256,
    verify_jwt: candidate.verify_jwt !== false,
    activation_id: activationId,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    tenant_env: {
      loaded_revision: LOADED_REVISION,
      env_proof: ENV_PROOF,
      load_state: "loaded",
      load_source: "management_api",
    },
    module_loaded: true,
  };
  const foreground = {
    ...identity,
    execution_profile: "foreground",
    module_env_proof: FOREGROUND_MODULE_PROOF,
  };
  const background = {
    ...identity,
    execution_profile: "background",
    module_env_proof: BACKGROUND_MODULE_PROOF,
  };
  return {
    preheated: `${ref}_${slug}_v${requestedVersion}`,
    version: requestedVersion,
    success: true,
    attestation: foreground,
    foreground: preheatPool(foreground),
    background: preheatPool(background),
  };
}

class FakeActivationRuntime {
  readonly calls: string[] = [];
  readonly fenced = new Set<string>();
  preheatHook?: RuntimeHook;
  preheatFailure?: Response;
  loseCommitAcknowledgement = false;

  fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.redirect !== "error") {
      throw new Error("Runtime control requests must reject redirects");
    }
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const activationId = headers.get("x-supacloud-activation-id")!;
    this.calls.push(url.pathname);
    if (url.pathname.includes("/internal/function-activation/")) {
      return this.activationControl(url, activationId);
    }
    if (url.pathname.includes("/preheat/")) {
      const segments = url.pathname.split("/");
      await this.preheatHook?.({
        ref: segments.at(-2)!,
        slug: segments.at(-1)!,
        activationId,
      });
      return this.preheatFailure ?? Response.json(await preheatAck(String(input), init));
    }
    throw new Error(`Unexpected runtime request: ${url.pathname}`);
  }) as typeof fetch;

  private async activationControl(url: URL, activationId: string): Promise<Response> {
    const segments = url.pathname.split("/");
    const action = segments.at(-1)!;
    const slug = segments.at(-2)!;
    const ref = segments.at(-3)!;
    if (action === "begin") {
      this.fenced.add(activationId);
      return Response.json(activationControlAck(activationId, "fenced", 1));
    }
    const activeId = (await activeDocument(ref, slug))?._supacloud_activation?.activation_id;
    if (action === "status") {
      if (activeId === activationId) {
        return Response.json(activationControlAck(
          activationId,
          this.fenced.has(activationId) ? "commit_pending" : "committed",
          2,
        ));
      }
      return Response.json(activationControlAck(
        activationId,
        this.fenced.has(activationId) ? "fenced" : "uncertain",
        1,
      ));
    }
    if (action === "commit") {
      if (activeId !== activationId) {
        return Response.json(activationControlAck(activationId, "uncertain", 1), {
          status: 409,
        });
      }
      this.fenced.delete(activationId);
      if (this.loseCommitAcknowledgement) {
        this.loseCommitAcknowledgement = false;
        throw new Error("simulated lost commit acknowledgement");
      }
      return Response.json(activationControlAck(activationId, "committed", 2));
    }
    if (action === "abort") {
      if (activeId === activationId) {
        return Response.json(activationControlAck(activationId, "committed", 2));
      }
      if (this.fenced.delete(activationId)) {
        return Response.json(activationControlAck(activationId, "aborted", 1));
      }
      return Response.json(activationControlAck(activationId, "uncertain", 1), {
        status: 409,
      });
    }
    throw new Error(`Unexpected activation action: ${action}`);
  }
}

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
  return edgeFunctionService.activateVersion(
    ref,
    slug,
    version,
    current.version ?? "absent",
    current.activation_id,
  );
}

async function deployVersion(
  runtime: FakeActivationRuntime,
  ref: string,
  slug: string,
  body: string,
  verifyJwt = true,
) {
  globalThis.fetch = runtime.fetch;
  return deployConditionalRelease({
    ref,
    slug,
    code: `export default { fetch: () => new Response(${JSON.stringify(body)}) };`,
    config: { verify_jwt: verifyJwt },
  });
}

type RedirectControlPath = "activation" | "preheat";
type RedirectScope = "same-origin" | "cross-origin";
type RedirectCapture = {
  sourceCredentialRequests: number;
  targetRequests: number;
  targetCredential: string | null;
};

function redirectTargetResponse(capture: RedirectCapture, request: Request): Response {
  capture.targetRequests += 1;
  capture.targetCredential = request.headers.get("x-supacloud-internal-auth");
  return new Response(null, { status: 500 });
}

function startRedirectTarget(capture: RedirectCapture): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => redirectTargetResponse(capture, request),
  });
}

function controlFallbackResponse(request: Request): Response {
  const activationId = request.headers.get("x-supacloud-activation-id")!;
  const action = new URL(request.url).pathname.split("/").at(-1);
  return Response.json(activationControlAck(
    activationId,
    action === "abort" ? "aborted" : "fenced",
    1,
  ));
}

function startControlRedirectSource(
  controlPath: RedirectControlPath,
  status: 302 | 307,
  location: string,
  capture: RedirectCapture,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/redirect-target") return redirectTargetResponse(capture, request);
      if (request.headers.has("x-supacloud-internal-auth")) {
        capture.sourceCredentialRequests += 1;
      }
      if (controlPath === "activation" || path.includes("/preheat/")) {
        return new Response(null, { status, headers: { location } });
      }
      return controlFallbackResponse(request);
    },
  });
}

async function redirectedControlDeployment(
  controlPath: RedirectControlPath,
  scope: RedirectScope,
  status: 302 | 307,
): Promise<{ deployment: { success: boolean }; targetRequests: number; targetCredential: string | null }> {
  const capture: RedirectCapture = {
    sourceCredentialRequests: 0,
    targetRequests: 0,
    targetCredential: null,
  };
  const target = scope === "cross-origin" ? startRedirectTarget(capture) : null;
  const location = target ? `http://127.0.0.1:${target.port}/redirect-target` : "/redirect-target";
  const source = startControlRedirectSource(controlPath, status, location, capture);
  const previousRuntimeInternal = config.edgeRuntimeInternal;
  const ref = `proj_redirect_${controlPath}_${scope.replace("-", "_")}_${status}`;
  config.edgeRuntimeInternal = `127.0.0.1:${source.port}`;
  globalThis.fetch = originalFetch;
  try {
    const deployment = await deployConditionalRelease({
      ref,
      slug: "redirect-guard",
      code: "export default { fetch: () => new Response('unreachable') };",
    });
    expect(capture.sourceCredentialRequests).toBeGreaterThan(0);
    return {
      deployment,
      targetRequests: capture.targetRequests,
      targetCredential: capture.targetCredential,
    };
  } finally {
    config.edgeRuntimeInternal = previousRuntimeInternal;
    source.stop(true);
    target?.stop(true);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalFunctionsDir === undefined) delete process.env.EDGE_FUNCTIONS_DIR;
  else process.env.EDGE_FUNCTIONS_DIR = originalFunctionsDir;
  if (originalRuntimeInternal === undefined) delete process.env.EDGE_RUNTIME_INTERNAL;
  else process.env.EDGE_RUNTIME_INTERNAL = originalRuntimeInternal;
  await rm(functionsRoot, { recursive: true, force: true });
});

describe("edgeFunctionService activation transaction", () => {
  test.each([
    ["activation", "same-origin", 302],
    ["activation", "same-origin", 307],
    ["activation", "cross-origin", 302],
    ["activation", "cross-origin", 307],
    ["preheat", "same-origin", 302],
    ["preheat", "same-origin", 307],
    ["preheat", "cross-origin", 302],
    ["preheat", "cross-origin", 307],
  ] as const)(
    "refuses %s %s HTTP %i redirects without forwarding runtime credentials",
    async (controlPath, scope, status) => {
      const result = await redirectedControlDeployment(controlPath, scope, status);

      expect(result.deployment.success).toBe(false);
      expect(result.targetRequests).toBe(0);
      expect(result.targetCredential).toBeNull();
    },
  );

  test("keeps a permissive target policy invisible until fenced readiness succeeds", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_policy_fence";
    const slug = "policy-fence";
    let policyDuringPreheat: boolean | null = null;
    runtime.preheatHook = async () => {
      policyDuringPreheat = (await activeDocument(ref, slug))?.verify_jwt !== false;
    };

    const deployment = await deployVersion(runtime, ref, slug, "ready", false);

    expect(deployment).toMatchObject({ success: true, version: "1" });
    expect(policyDuringPreheat).toBe(true);
    expect((await activeDocument(ref, slug))?.verify_jwt).toBe(false);
    expect(runtime.calls.map((path) => path.split("/").at(-1))).toEqual([
      "begin",
      slug,
      "commit",
    ]);
  });

  test("aborts the fence without publishing a failed candidate", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_failed_candidate";
    const slug = "failed-candidate";
    expect((await deployVersion(runtime, ref, slug, "one")).success).toBe(true);
    const before = await activeDocument(ref, slug);
    runtime.preheatFailure = Response.json({ success: false }, { status: 503 });

    const rejected = await deployVersion(runtime, ref, slug, "two", false);

    expect(rejected.success).toBe(false);
    expect((await activeDocument(ref, slug))?._supacloud_activation?.activation_id)
      .toBe(before?._supacloud_activation?.activation_id);
    expect(runtime.calls.at(-1)).toEndWith("/abort");
  });

  test("recovers a committed activation after the commit acknowledgement is lost", async () => {
    const runtime = new FakeActivationRuntime();
    runtime.loseCommitAcknowledgement = true;

    const deployment = await deployVersion(
      runtime,
      "proj_lost_ack",
      "lost-ack",
      "committed",
    );

    expect(deployment.success).toBe(true);
    expect(runtime.calls.some((path) => path.endsWith("/status"))).toBe(true);
    expect(runtime.calls.some((path) => path.endsWith("/abort"))).toBe(false);
  });

  test("does not accept a valid activation acknowledgement carried by HTTP 503", async () => {
    const runtime = new FakeActivationRuntime();
    globalThis.fetch = (async (input, init) => {
      const response = await runtime.fetch(input, init);
      if (!String(input).includes("/internal/function-activation/")) return response;
      return Response.json(await response.json(), { status: 503 });
    }) as typeof fetch;

    const rejected = await deployConditionalRelease({
      ref: "proj_non_success_ack",
      slug: "non-success-ack",
      code: "export default { fetch: () => new Response('unreachable') };",
    });

    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("runtime activation state is uncertain"),
    });
    expect(runtime.calls.some((path) => path.includes("/preheat/"))).toBe(false);
  });

  test("keeps the fence after a post-rename durability failure and recovers explicitly", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_manifest_durability";
    const slug = "manifest-durability";
    expect((await deployVersion(runtime, ref, slug, "one")).success).toBe(true);

    const probe = await open(functionsRoot, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: () => Promise<{ isDirectory: () => boolean }>;
      sync: () => Promise<void>;
    };
    await probe.close();
    const originalSync = fileHandlePrototype.sync;
    let failNextDirectorySync = false;
    runtime.preheatHook = () => {
      failNextDirectorySync = true;
    };
    const syncSpy = spyOn(fileHandlePrototype, "sync").mockImplementation(async function () {
      const metadata = await this.stat();
      if (metadata.isDirectory() && failNextDirectorySync) {
        failNextDirectorySync = false;
        throw Object.assign(
          new Error("simulated directory fsync failure"),
          { code: "EIO" },
        );
      }
      await originalSync.call(this);
    });

    let rejected: Awaited<ReturnType<typeof deployVersion>>;
    try {
      rejected = await deployVersion(runtime, ref, slug, "two");
    } finally {
      syncSpy.mockRestore();
    }

    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("manifest durability is uncertain"),
    });
    expect((await activeDocument(ref, slug))?.version).toBe("2");
    expect(runtime.calls.at(-1)?.split("/").at(-1)).toBe(slug);

    const recoveryCallsOffset = runtime.calls.length;
    const recovered = await deployVersion(runtime, ref, slug, "three");
    expect(recovered).toMatchObject({ success: true, version: "3" });
    expect(runtime.calls.slice(recoveryCallsOffset).map((path) => path.split("/").at(-1)))
      .toEqual(["status", "commit", "begin", slug, "commit"]);
  });

  test("rejects an active-version ABA when the activation identity is stale", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_activation_aba";
    const slug = "activation-aba";
    expect((await deployVersion(runtime, ref, slug, "one")).success).toBe(true);
    const originalVersionOne = await edgeFunctionService.getConfig(ref, slug);
    expect((await deployVersion(runtime, ref, slug, "two")).success).toBe(true);
    expect(await activateConditionalVersion(ref, slug, "1")).not.toBeNull();
    const callsBeforeConflict = runtime.calls.length;

    const stale = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch: () => new Response('stale') };",
      expectedActiveVersion: "1",
      expectedActivationId: originalVersionOne.activation_id,
    });

    expect(stale).toMatchObject({
      success: false,
      error_code: EDGE_FUNCTION_ACTIVE_VERSION_CONFLICT_CODE,
      expected_activation_id: originalVersionOne.activation_id,
      active_version: "1",
    });
    expect(runtime.calls).toHaveLength(callsBeforeConflict);
  });

  test("does not overwrite a foreign current authority while aborting", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_foreign_pointer";
    const slug = "foreign-pointer";
    expect((await deployVersion(runtime, ref, slug, "one")).success).toBe(true);
    const foreignId = randomUUID();
    runtime.preheatHook = async () => {
      const current = (await activeDocument(ref, slug))!;
      const manifestPath = join(functionsRoot, ref, `${slug}.config.json`);
      const replacementPath = `${manifestPath}.${foreignId}.tmp`;
      await writeFile(replacementPath, JSON.stringify({
        ...current,
        _supacloud_activation: {
          schema: "supacloud.edge-function-activation.v1",
          activation_id: foreignId,
          activation_generation: 999,
          previous_activation_id: current._supacloud_activation?.activation_id ?? null,
          target_state: "active",
          artifact_sha256: "f".repeat(64),
        },
      }));
      await rename(replacementPath, manifestPath);
    };
    runtime.preheatFailure = Response.json({ success: false }, { status: 503 });

    const rejected = await deployVersion(runtime, ref, slug, "two");

    expect(rejected.success).toBe(false);
    expect((await activeDocument(ref, slug))?._supacloud_activation?.activation_id)
      .toBe(foreignId);
  });

  test("reactivates an immutable version with its recorded authorization policy", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_restore_policy";
    const slug = "restore-policy";
    expect((await deployVersion(runtime, ref, slug, "one", false)).success).toBe(true);
    expect((await deployVersion(runtime, ref, slug, "two", true)).success).toBe(true);

    const activation = await activateConditionalVersion(ref, slug, "1");

    expect(activation?.config).toMatchObject({ verify_jwt: false, version: "1" });
    expect(activation?.activation_id).toBe(activation?.config.activation_id);
  });

  test("publishes an identity-preserving tombstone before artifact cleanup", async () => {
    const runtime = new FakeActivationRuntime();
    const ref = "proj_delete_tombstone";
    const slug = "delete-tombstone";
    expect((await deployVersion(runtime, ref, slug, "one")).success).toBe(true);
    const current = await edgeFunctionService.getConfig(ref, slug);

    const removal = await edgeFunctionService.remove(ref, slug, current.activation_id);
    expect(removal).toMatchObject({
      previous_active_version: "1",
      active_version: "absent",
      config: { activation_id: removal.activation_id },
    });

    const deleted = await edgeFunctionService.getConfig(ref, slug);
    expect(deleted.activation_id).not.toBe(current.activation_id);
    expect(deleted.version).toBeUndefined();
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("absent");

    const recreated = await edgeFunctionService.deployRelease({
      ref,
      slug,
      code: "export default { fetch() { return new Response('recreated') } }",
      expectedActiveVersion: "absent",
      expectedActivationId: removal.activation_id,
    });
    expect(recreated).toMatchObject({
      success: true,
      previous_active_version: "absent",
      active_version: "1",
    });
    expect(recreated.activation_id).not.toBe(removal.activation_id);
  });
});

describe("edgeFunctionService mutation directory preflight", () => {
  test("rejects every mutation entry before touching a group-writable project directory", async () => {
    const ref = "proj_untrusted_mutation_parent";
    const slug = "untrusted-parent";
    const projectDirectory = join(functionsRoot, ref);
    await mkdir(projectDirectory, { mode: 0o700 });
    await chmod(projectDirectory, 0o777);
    let runtimeRequests = 0;
    globalThis.fetch = (async () => {
      runtimeRequests += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    const trustError = "Function mutation directory is not trusted";
    const code = "export default { fetch: () => new Response('blocked') };";

    await expect(edgeFunctionService.deploy(ref, slug, code)).rejects.toThrow(trustError);
    await expect(edgeFunctionService.deployBundle(ref, slug, { "index.ts": code }))
      .rejects.toThrow(trustError);
    await expect(edgeFunctionService.deployRelease({
      ref,
      slug,
      code,
      expectedActiveVersion: "absent",
      expectedActivationId: "legacy",
    })).rejects.toThrow(trustError);
    await expect(edgeFunctionService.updateConfig(ref, slug, { verify_jwt: false }, "legacy"))
      .rejects.toThrow(trustError);
    await expect(edgeFunctionService.activateVersion(ref, slug, "1", "absent", "legacy"))
      .rejects.toThrow(trustError);
    await expect(edgeFunctionService.remove(ref, slug, "legacy")).rejects.toThrow(trustError);

    expect(runtimeRequests).toBe(0);
    expect(await directoryShape(projectDirectory)).toEqual([]);
  });

  test.each([
    "activation root",
    "activation slug",
    "version root",
    "version slug",
    "version child",
  ] as const)("rejects a %s symlink before lock, artifact, config, or generation writes", async (scope) => {
    const ref = `proj_symlink_${scope.replace(" ", "_")}`;
    const slug = "symlink-parent";
    const projectDirectory = join(functionsRoot, ref);
    const outsideDirectory = join(functionsRoot, `${ref}_outside`);
    await mkdir(projectDirectory, { mode: 0o700 });
    await mkdir(outsideDirectory, { mode: 0o700 });
    const parentName = scope.startsWith("activation")
      ? ".activation-generations"
      : ".versions";
    const parentDirectory = join(projectDirectory, parentName);
    if (scope === "version child") {
      await mkdir(join(parentDirectory, slug), { recursive: true, mode: 0o700 });
      await symlink(outsideDirectory, join(parentDirectory, slug, "1"), "dir");
    } else if (scope.endsWith("root")) {
      await symlink(outsideDirectory, parentDirectory, "dir");
    } else {
      await mkdir(parentDirectory, { mode: 0o700 });
      await symlink(outsideDirectory, join(parentDirectory, slug), "dir");
    }
    const before = await directoryShape(projectDirectory);
    let runtimeRequests = 0;
    globalThis.fetch = (async () => {
      runtimeRequests += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    await expect(edgeFunctionService.deployDetailed(
      ref,
      slug,
      "export default { fetch: () => new Response('blocked') };",
    )).rejects.toThrow("Function mutation directory is not trusted");

    expect(runtimeRequests).toBe(0);
    expect(await directoryShape(projectDirectory)).toEqual(before);
    expect(await directoryShape(outsideDirectory)).toEqual([]);
  });

  test("rejects a group-writable functions root before creating a project directory", async () => {
    const ref = "proj_untrusted_functions_root";
    const slug = "untrusted-functions-root";
    const projectDirectory = join(functionsRoot, ref);
    let runtimeRequests = 0;
    globalThis.fetch = (async () => {
      runtimeRequests += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    await chmod(functionsRoot, 0o777);
    try {
      await expect(edgeFunctionService.deployDetailed(
        ref,
        slug,
        "export default { fetch: () => new Response('blocked') };",
      )).rejects.toThrow("Function mutation directory is not trusted");
      expect(existsSync(projectDirectory)).toBe(false);
      expect(runtimeRequests).toBe(0);
    } finally {
      await chmod(functionsRoot, 0o700);
    }
  });

  test("rejects a writable ancestor before a root replacement can reach the lock or artifacts", async () => {
    const ancestor = await mkdtemp(join(canonicalTemporaryRoot, "supacloud-function-ancestor-race-"));
    const replaceableFunctionsRoot = join(ancestor, "functions");
    const savedFunctionsRoot = join(ancestor, "saved-functions");
    const replacementFunctionsRoot = join(ancestor, "replacement-functions");
    const ref = "proj_ancestor_replacement";
    const slug = "ancestor-replacement";
    await mkdir(join(replaceableFunctionsRoot, ref), { recursive: true, mode: 0o700 });
    await mkdir(join(replacementFunctionsRoot, ref), { recursive: true, mode: 0o700 });
    await chmod(ancestor, 0o777);
    let runtimeRequests = 0;
    globalThis.fetch = (async () => {
      runtimeRequests += 1;
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    process.env.EDGE_FUNCTIONS_DIR = replaceableFunctionsRoot;

    try {
      const deployment = edgeFunctionService.deployDetailed(
        ref,
        slug,
        "export default { fetch: () => new Response('blocked') };",
      );
      const rejection = expect(deployment).rejects.toThrow(
        /Function mutation directory (?:is not trusted|path is not canonical)/,
      );
      await rename(replaceableFunctionsRoot, savedFunctionsRoot);
      await rename(replacementFunctionsRoot, replaceableFunctionsRoot);

      await rejection;
      expect(runtimeRequests).toBe(0);
      expect(await directoryShape(join(savedFunctionsRoot, ref))).toEqual([]);
      expect(await directoryShape(join(replaceableFunctionsRoot, ref))).toEqual([]);
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await chmod(ancestor, 0o700);
      await rm(ancestor, { recursive: true, force: true });
    }
  });

  test("rejects a non-sticky writable ancestor before the first mutation", async () => {
    const ancestor = await mkdtemp(join(canonicalTemporaryRoot, "supacloud-function-untrusted-ancestor-"));
    const isolatedFunctionsRoot = join(ancestor, "functions");
    const ref = "proj_untrusted_ancestor";
    const projectDirectory = join(isolatedFunctionsRoot, ref);
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    await chmod(ancestor, 0o777);
    process.env.EDGE_FUNCTIONS_DIR = isolatedFunctionsRoot;

    try {
      await expect(edgeFunctionService.deployDetailed(
        ref,
        "untrusted-ancestor",
        "export default { fetch: () => new Response('blocked') };",
      )).rejects.toThrow("Function mutation directory is not trusted");
      expect(await directoryShape(projectDirectory)).toEqual([]);
    } finally {
      process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
      await chmod(ancestor, 0o700);
      await rm(ancestor, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux" || process.geteuid?.() !== 0)(
    "rejects an existing project owned by an untrusted uid without mutation",
    async () => {
      const ref = "proj_untrusted_owner";
      const slug = "untrusted-owner";
      const projectDirectory = join(functionsRoot, ref);
      await mkdir(projectDirectory, { mode: 0o700 });
      await chown(projectDirectory, 65_534, 65_534);
      const before = await directoryShape(projectDirectory);

      await expect(edgeFunctionService.deployDetailed(
        ref,
        slug,
        "export default { fetch: () => new Response('blocked') };",
      )).rejects.toThrow("Function mutation directory is not trusted");

      expect(await directoryShape(projectDirectory)).toEqual(before);
    },
  );
});

describe("edgeFunctionService log directory preparation", () => {
  test("prepares writable per-project .logs directories without changing project directory permissions", async () => {
    const projectDirectory = join(functionsRoot, "proj_logs");
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    await chmod(projectDirectory, 0o700);

    const calls: string[][] = [];
    await ensureFunctionLogsDirectory(
      projectDirectory,
      { user: "supacloud-edge", group: "supacloud-edge", isRoot: true },
      {
        lstat,
        mkdir,
        chmod,
        run: async (command) => {
          calls.push(command);
        },
      },
    );

    expect(calls).toEqual([[
      "chown",
      "-h",
      "supacloud-edge:supacloud-edge",
      join(projectDirectory, ".logs"),
    ]]);
    expect((await stat(projectDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(projectDirectory, ".logs"))).mode & 0o777).toBe(0o755);
  });

  test("accepts a concurrently created trusted .logs directory", async () => {
    const projectDirectory = join(functionsRoot, "proj_concurrent_logs");
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(projectDirectory);
    let lstatCalls = 0;
    let mkdirCalls = 0;

    await ensureFunctionLogsDirectory(
      projectDirectory,
      { user: "supacloud-edge", group: "supacloud-edge", isRoot: false },
      {
        lstat: (async () => {
          lstatCalls += 1;
          if (lstatCalls === 1) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return directoryInfo;
        }) as typeof lstat,
        mkdir: (async () => {
          mkdirCalls += 1;
          throw Object.assign(new Error("created by peer"), { code: "EEXIST" });
        }) as typeof mkdir,
        chmod,
        run: async () => {},
      },
    );

    expect(lstatCalls).toBe(2);
    expect(mkdirCalls).toBe(1);
  });

  test("repairs existing project log directories while ignoring hidden directories", async () => {
    const rootDirectory = join(functionsRoot, "logs-sweep");
    const validProject = join(rootDirectory, "proj_1");
    const hiddenProject = join(rootDirectory, ".activation-generations");
    await mkdir(validProject, { recursive: true, mode: 0o700 });
    await mkdir(hiddenProject, { recursive: true, mode: 0o700 });
    await chmod(validProject, 0o700);
    await chmod(hiddenProject, 0o700);

    const prepared = await ensureEdgeFunctionLogsForExistingProjects(rootDirectory, {
      lstat,
      mkdir,
      chmod,
      run: async () => {},
    });

    expect(prepared).toBe(1);
    expect((await stat(join(validProject, ".logs"))).mode & 0o777).toBe(0o755);
    expect(existsSync(join(hiddenProject, ".logs"))).toBe(false);
  });

  test("rejects a symlinked .logs directory instead of following it", async () => {
    const projectDirectory = join(functionsRoot, "proj_symlink_logs");
    const outsideDirectory = join(functionsRoot, "outside-logs");
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    await mkdir(outsideDirectory, { recursive: true, mode: 0o700 });
    await symlink(outsideDirectory, join(projectDirectory, ".logs"), "dir");

    await expect(ensureFunctionLogsDirectory(
      projectDirectory,
      { user: "supacloud-edge", group: "supacloud-edge", isRoot: false },
      {
        lstat,
        mkdir,
        chmod,
        run: async () => {},
      },
    )).rejects.toThrow("Function log directory is not trusted");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { FrontendService, frontendService } from "../../src/services/frontend.service";
import {
  FrontendReleaseError,
  frontendReleaseService,
} from "../../src/services/frontend-release.service";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FRONTEND_FRAMEWORKS, type FrontendDeployment } from "../../src/types/frontend";
import { hostingReceipt } from "../../../web-console/src/lib/hosting-mutations";
import { parseHostingList } from "../../../web-console/src/lib/hosting-list";
import { createHostingToken, HostingTokenCreationError, loadHostingTokens, parseScopedHostingTokens } from "../../../web-console/src/lib/hosting-tokens";
import { FrontendDomainService } from "../../src/services/frontend-domain.service";
import { parseFrontendTokenMetadata } from "../../src/utils/frontend-token-record";
import { loadHostingLogs, parseHostingLogs } from "../../../web-console/src/lib/hosting-logs";
import { HostingEnvironmentConflictError, HostingEnvironmentUpdateError, saveHostingEnvironment } from "../../../web-console/src/lib/hosting-env";
import { loadHostingDetail } from "../../../web-console/src/lib/hosting-detail";
import { saveHostingConfiguration, HostingConfigurationUpdateError, HostingConfigurationConflictError } from "../../../web-console/src/lib/hosting-configuration";
import { createFrontendConfigurationRevision } from "../../src/utils/frontend-configuration-revision";
import { createFrontendEnvironmentRevision } from "../../src/utils/frontend-environment-revision";

const requireProjectOrAdminAuth = mock<typeof authModule.requireProjectOrAdminAuth>(async () => undefined);
const authModule = await import("../../src/middleware/auth");
const requireProjectOrAdminAuthSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth,
);
const { frontendRoutes } = await import("../../src/routes/frontend");

function deploymentFixture(overrides: Partial<FrontendDeployment> = {}): FrontendDeployment {
  return {
    id: "dep123", project_ref: "proj123", name: "test-site", framework: "static",
    domain: "test.example.com", custom_domains: [], build_command: "", output_dir: "dist",
    install_command: "", node_version: "20", env_vars: {}, status: "pending",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    deployment_url: "https://test.example.com", ...overrides,
  };
}

describe("Frontend deployment upload routes", () => {
  const app = new Elysia().use(frontendRoutes);
  let testZipBytes: Uint8Array<ArrayBuffer>;
  let tempZipPath: string;

  afterAll(() => {
    requireProjectOrAdminAuthSpy.mockRestore();
  });

  beforeAll(async () => {
    // Dynamically generate a valid minimal zip binary for complete unzip verification testing
    const tempDir = path.join(tmpdir(), "supacloud-test-zip-");
    const testFile = path.join(tempDir, "index.html");
    tempZipPath = path.join(tempDir, "test.zip");

    await Bun.$`mkdir -p ${tempDir}`;
    await writeFile(testFile, "<h1>Hello</h1>");
    await Bun.$`cd ${tempDir} && zip -q test.zip index.html`;

    testZipBytes = new Uint8Array(await Bun.file(tempZipPath).arrayBuffer());

    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);

    // Mock getDeployment to ensure deployment exists
    spyOn(frontendService, "getDeployment").mockImplementation(async (ref, id) => {
      return deploymentFixture({
        id,
        project_ref: ref,
        name: "test-site",
        framework: "static",
        domain: "test.example.com",
        custom_domains: [],
        status: "pending",
      });
    });

    // Mock deployFromSource to avoid starting real build and publish logic
    spyOn(frontendService, "deployFromSource").mockImplementation(async (ref, id, sourceDir) => {
      return {
        success: true,
        deployment_id: id,
        url: "https://test.example.com",
        build_log: "Success mock",
        message: "Deployed successfully",
      };
    });
    spyOn(frontendReleaseService, "assertMutationSupported").mockResolvedValue();
  });

  function mockImmutableUpload(releaseId: string) {
    const written: Uint8Array[] = [];
    const staged = Object.freeze({ size_bytes: testZipBytes.byteLength, sha256: releaseId });
    const upload = {
      write: mock(async (chunk: Uint8Array) => { written.push(chunk.slice()); }),
      finish: mock(async (expected: string) => {
        if (expected !== releaseId) {
          throw new FrontendReleaseError("FRONTEND_RELEASE_SHA_MISMATCH", 400, "digest mismatch");
        }
        return staged;
      }),
      abort: mock(async () => undefined),
    };
    const prepare = spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    return { written, staged, upload, prepare };
  }

  test("token list service, route and consumer bind the same deployment identity", async () => {
    const token = { id: "token123", name: "ci", created_at: new Date(0).toISOString(), token: "private-marker" };
    let deployment: FrontendDeployment | null = deploymentFixture({ deploy_tokens: [token] });
    let reads = 0;
    const service = new FrontendDomainService({
      deploymentLock: async (_ref, _id, work) => work(),
      getDeployment: async () => { reads++; return deployment; },
      writeDeployment: async () => { throw new Error("Unexpected token-list write"); },
      commitHostMutation: async () => { throw new Error("Unexpected token-list host mutation"); },
    });
    const list = spyOn(frontendService, "listDeployTokens").mockImplementation(
      (ref, id) => service.listDeployTokens(ref, id),
    );
    const request = (url: string, options: RequestInit) => app.handle(new Request(`http://localhost${url}`, options));
    const signal = new AbortController().signal;
    try {
      await expect(service.listDeployTokens("../other", "dep123")).rejects.toThrow("Invalid deployment identity");
      expect(reads).toBe(0);
      expect(await loadHostingTokens("proj123", "dep123", request, signal)).toEqual([
        { id: token.id, name: token.name, created_at: token.created_at },
      ]);
      expect(list).toHaveBeenCalledWith("proj123", "dep123");
      const response = await request("/v1/projects/proj123/frontend/deployments/dep123/tokens", {});
      const payload: unknown = await response.json();
      expect(payload).toEqual({
        project_ref: "proj123", deployment_id: "dep123",
        tokens: [{ id: token.id, name: token.name, created_at: token.created_at }],
      });
      expect(JSON.stringify(payload)).not.toContain("private-marker");
      expect(() => parseScopedHostingTokens(payload, "other", "dep123")).toThrow();
      expect(() => parseScopedHostingTokens(payload, "proj123", "other")).toThrow();
      expect(() => parseScopedHostingTokens({ tokens: [] }, "proj123", "dep123")).toThrow();
      for (const change of [{ project_ref: "other" }, { id: "other" }]) {
        deployment = deploymentFixture({ ...change, deploy_tokens: [token] });
        await expect(loadHostingTokens("proj123", "dep123", request, signal)).rejects.toThrow();
      }
      for (const tokens of [null, false, [token, token], [{ ...token, name: 123 }]]) {
        deployment = deploymentFixture();
        Object.defineProperty(deployment, "deploy_tokens", { value: tokens, enumerable: true });
        const response = await request("/v1/projects/proj123/frontend/deployments/dep123/tokens", {});
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain("private-marker");
        await expect(loadHostingTokens("proj123", "dep123", request, signal)).rejects.toThrow();
      }
      deployment = null;
      expect(await loadHostingTokens("proj123", "dep123", request, signal)).toEqual([]);
    } finally {
      list.mockRestore();
    }
  });

  test("stored token metadata rejects corrupt records without reading or returning secrets", () => {
    const token = { id: "token123", name: "ci", created_at: new Date(0).toISOString() };
    for (const tokens of [
      null, false, {}, [null], [token, token], new Array(1),
      ...[
        { id: "../other" }, { name: 1 }, { name: "" }, { name: "x".repeat(1025) },
        { created_at: null }, { created_at: "2026-02-30T00:00:00.000Z" },
        { last_used_at: null }, { last_used_at: false },
      ].map(change => [{ ...token, ...change }]),
    ]) {
      expect(() => parseFrontendTokenMetadata({
        id: "dep123", project_ref: "proj123", deploy_tokens: tokens,
      }, "proj123", "dep123")).toThrow("Invalid stored deployment token record");
    }
    let accesses = 0;
    const withSecret = Object.defineProperty({ ...token }, "token_encrypted", {
      get() { accesses++; throw new Error("private secret"); }, enumerable: true,
    });
    expect(parseFrontendTokenMetadata({
      id: "dep123", project_ref: "proj123", deploy_tokens: [withSecret],
    }, "proj123", "dep123")).toEqual([token]);
    const accessor = Object.defineProperty({ ...token }, "name", {
      get() { accesses++; return "ci"; }, enumerable: true,
    });
    expect(() => parseFrontendTokenMetadata({
      id: "dep123", project_ref: "proj123", deploy_tokens: [accessor],
    }, "proj123", "dep123")).toThrow();
    expect(accesses).toBe(0);
    expect(parseFrontendTokenMetadata({ id: "dep123", project_ref: "proj123" }, "proj123", "dep123")).toEqual([]);
  });

  test("actual log responses preserve masking and the consumer rejects foreign or malformed logs", async () => {
    const stored = spyOn(frontendService, "getDeployment").mockResolvedValue(deploymentFixture({
      build_log: "private-marker\nbuild completed\n", env_vars: { SECRET: "private-marker" },
    }));
    const signal = new AbortController().signal;
    let calls = 0;
    const request = async (url: string, options: RequestInit) => {
      calls++;
      expect(url).toBe("/v1/projects/proj123/frontend/deployments/dep123/logs");
      expect(options.cache).toBe("no-store");
      expect(options.redirect).toBe("error");
      return app.handle(new Request(`http://localhost${url}`, options));
    };
    try {
      await expect(loadHostingLogs("../other", "dep123", request, signal)).rejects.toThrow();
      expect(calls).toBe(0);
      expect(await loadHostingLogs("proj123", "dep123", request, signal)).toBe("********\nbuild completed\n");
      stored.mockResolvedValue(deploymentFixture());
      expect(await loadHostingLogs("proj123", "dep123", request, signal)).toBe("");
      stored.mockRejectedValue(new Error("synthetic read failure"));
      await expect(loadHostingLogs("proj123", "dep123", request, signal)).rejects.toThrow();
      for (const value of [
        null, {}, { logs: "" },
        { project_ref: "other", deployment_id: "dep123", logs: "" },
        { project_ref: "proj123", deployment_id: "other", logs: "" },
        ...[null, false, {}, []].map(logs => ({ project_ref: "proj123", deployment_id: "dep123", logs })),
      ]) expect(() => parseHostingLogs(value, "proj123", "dep123")).toThrow();
      let accessed = 0;
      const accessor = Object.defineProperty({ project_ref: "proj123", deployment_id: "dep123" }, "logs", {
        enumerable: true, get() { accessed++; return "untrusted"; },
      });
      expect(() => parseHostingLogs(accessor, "proj123", "dep123")).toThrow();
      expect(accessed).toBe(0);
      await expect(loadHostingLogs("proj123", "dep123", async () => new Response("{}", {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }), signal)).rejects.toThrow();
    } finally {
      stored.mockRestore();
    }
  });

  test("log reads cancel a pending body without producing an empty success", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    const pending = loadHostingLogs("proj123", "dep123", async () => {
      started.resolve();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("token creation crosses the actual route and native storage without replaying an uncertain response", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-token-route-"));
    const service = new FrontendService(baseDir, async (_ref, _id, work) => work(), async () => ({
      activeBuildDir: async () => null,
      hasActiveRelease: async () => false,
      hasUnresolvedActivation: async () => false,
    }));
    const create = spyOn(frontendService, "createDeployToken").mockImplementation(
      (ref, id, name) => service.createDeployToken(ref, id, name),
    );
    const signal = new AbortController().signal;
    let posts = 0;
    let truncateResponse = false;
    const request = async (url: string, options: RequestInit) => {
      posts++;
      const response = await app.handle(new Request(`http://localhost${url}`, options));
      if (!truncateResponse || !response.ok) return response;
      const text = await response.text();
      return new Response(text.slice(0, -1), { status: response.status, headers: response.headers });
    };
    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
      const created = await createHostingToken("proj123", deployment.id, "ci", request, signal);
      expect(created).toMatchObject({
        project_ref: "proj123", deployment_id: deployment.id, name: "ci",
      });
      expect(create).toHaveBeenCalledWith("proj123", deployment.id, "ci");
      expect(posts).toBe(1);
      expect(await service.verifyDeployToken("proj123", deployment.id, created.token)).toBe(true);
      expect(await readFile(filename, "utf8")).not.toContain(created.token);
      expect(await service.listDeployTokens("proj123", deployment.id)).toHaveLength(1);

      truncateResponse = true;
      const uncertain = createHostingToken("proj123", deployment.id, "uncertain", request, signal);
      await expect(uncertain).rejects.toBeInstanceOf(HostingTokenCreationError);
      await expect(uncertain).rejects.toMatchObject({
        mutationMayHaveApplied: true, message: "Hosting token creation could not be confirmed",
      });
      expect(posts).toBe(2);
      const tokens = await service.listDeployTokens("proj123", deployment.id);
      expect(tokens).toHaveLength(2);
      expect(tokens.filter(token => token.name === "uncertain")).toHaveLength(1);
      const stored = await service.getDeployment("proj123", deployment.id);
      expect(stored?.deploy_tokens?.every(token => token.token === undefined && typeof token.token_encrypted === "string"))
        .toBe(true);

      truncateResponse = false;
      const beforeInvalid = await readFile(filename, "utf8");
      await expect(createHostingToken("proj123", deployment.id, "", request, signal)).rejects.toThrow();
      expect(posts).toBe(2);
      expect(await readFile(filename, "utf8")).toBe(beforeInvalid);
    } finally {
      create.mockRestore();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("environment saves verify scoped masked receipts through the actual route and native storage", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-env-route-"));
    const service = new FrontendService(baseDir, async (_ref, _id, work) => work(), async () => ({
      activeBuildDir: async () => null, hasActiveRelease: async () => false, hasUnresolvedActivation: async () => false,
    }));
    const save = spyOn(frontendService, "setEnvVars").mockImplementation(
      (ref, id, values, mode, revision) => service.setEnvVars(ref, id, values, mode, revision),
    );
    let requests = 0;
    let truncateResponse = false;
    const signal = new AbortController().signal;
    const request = async (url: string, options: RequestInit) => {
      requests++;
      const response = await app.handle(new Request(`http://localhost${url}`, options));
      const text = await response.text();
      expect(text).not.toContain("private-marker");
      if (requests === 1) expect(response.status, text).toBe(200);
      return new Response(truncateResponse ? text.slice(0, -1) : text, {
        status: response.status, headers: response.headers,
      });
    };
    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site", framework: "static", env_vars: { TOKEN: "private-marker" },
      });
      const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
      const currentRevision = async () => {
        const current = await service.getDeployment("proj123", deployment.id);
        if (!current) throw new Error("Missing deployment");
        return createFrontendEnvironmentRevision(current);
      };
      const revision = await saveHostingEnvironment("proj123", deployment.id, Object.fromEntries([
        ["TOKEN", "********"], ["PLAIN", "saved"],
      ]), request, signal, await currentRevision());
      const stored = await service.getDeployment("proj123", deployment.id);
      expect(stored?.env_vars).toMatchObject({ TOKEN: "private-marker", PLAIN: "saved" });
      expect(requests).toBe(1);
      truncateResponse = true;
      const pending = saveHostingEnvironment("proj123", deployment.id, { PLAIN: "after-cut" }, request, signal, revision);
      await expect(pending).rejects.toBeInstanceOf(HostingEnvironmentUpdateError);
      await expect(pending).rejects.toMatchObject({ mutationMayHaveApplied: true });
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars["PLAIN"]).toBe("after-cut");
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).not.toHaveProperty("TOKEN");
      expect(requests).toBe(2);
      truncateResponse = false;
      await saveHostingEnvironment("proj123", deployment.id,
        Object.fromEntries([["__proto__", "ordinary-variable"], ["constructor", "ordinary-constructor"]]), request, signal, await currentRevision());
      const special = await service.getDeployment("proj123", deployment.id);
      expect(special?.env_vars["__proto__"]).toBe("ordinary-variable");
      expect(special?.env_vars["constructor"]).toBe("ordinary-constructor");
      expect(Object.getPrototypeOf(special?.env_vars)).toBe(Object.prototype);
      const legacy = await app.handle(new Request(
        `http://localhost/v1/projects/proj123/frontend/deployments/${deployment.id}/env`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ env_vars: { LEGACY: "supported" } }) },
      ));
      expect(legacy.status).toBe(200);
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars["LEGACY"]).toBe("supported");
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars["__proto__"]).toBe("ordinary-variable");
      const beforeMissingMask = await readFile(filename, "utf8");
      await expect(saveHostingEnvironment("proj123", deployment.id, { MISSING: "********" }, request, signal, await currentRevision()))
        .rejects.toMatchObject({ mutationMayHaveApplied: true });
      expect(await readFile(filename, "utf8")).toBe(beforeMissingMask);
      await saveHostingEnvironment("proj123", deployment.id, {}, request, signal, await currentRevision());
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({});
      for (const body of [
        {},
        { mode: "invalid", env_entries: [] },
        { mode: "replace", env_entries: [] },
        { env_vars: {}, env_entries: [] },
        { env_entries: [{ name: "KEY", value: "one" }, { name: "KEY", value: "two" }] },
        { env_entries: [{ name: "KEY", value: null }] },
        { env_entries: Array.from({ length: 257 }, (_, index) => ({ name: `KEY${index}`, value: "value" })) },
      ]) {
        const before = await readFile(filename, "utf8");
        const calls = save.mock.calls.length;
        const response = await app.handle(new Request(
          `http://localhost/v1/projects/proj123/frontend/deployments/${deployment.id}/env`,
          { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        ));
        expect(response.status === 400 || response.status === 422 || response.status === 428).toBe(true);
        expect(save.mock.calls).toHaveLength(calls);
        expect(await readFile(filename, "utf8")).toBe(before);
      }
      const beforeInvalid = await readFile(filename, "utf8");
      for (const result of [
        deploymentFixture({ id: deployment.id, project_ref: "foreign", env_vars: { PLAIN: "wanted" } }),
        deploymentFixture({ id: deployment.id, env_vars: { PLAIN: "wrong" } }),
        deploymentFixture({ id: deployment.id, env_vars: {} }),
        deploymentFixture({ id: deployment.id, env_vars: { PLAIN: "wanted", EXTRA: "retained" } }),
      ]) {
        save.mockResolvedValue(result);
        await expect(saveHostingEnvironment("proj123", deployment.id, { PLAIN: "wanted" }, request, signal, await currentRevision()))
          .rejects.toBeInstanceOf(HostingEnvironmentUpdateError);
      }
      expect(await readFile(filename, "utf8")).toBe(beforeInvalid);
    } finally {
      save.mockRestore();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("environment revisions reject stale and foreign replacements under the deployment lock", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-env-conflict-"));
    let tail = Promise.resolve();
    const service = new FrontendService(baseDir, async (_ref, _id, work) => {
      const previous = tail;
      const released = Promise.withResolvers<void>();
      tail = released.promise;
      await previous;
      try { return await work(); } finally { released.resolve(); }
    }, async () => ({
      activeBuildDir: async () => null, hasActiveRelease: async () => false, hasUnresolvedActivation: async () => false,
    }));
    const save = spyOn(frontendService, "setEnvVars").mockImplementation(
      (ref, id, values, mode, revision) => service.setEnvVars(ref, id, values, mode, revision),
    );
    const get = spyOn(frontendService, "getDeployment").mockImplementation((ref, id) => service.getDeployment(ref, id));
    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site", framework: "static", env_vars: { TOKEN: "private-marker" },
      });
      const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
      const endpoint = `http://localhost/v1/projects/proj123/frontend/deployments/${deployment.id}`;
      const detail = await app.handle(new Request(endpoint));
      expect(detail.status).toBe(200);
      const data: unknown = await detail.json();
      if (!data || typeof data !== "object" || !("env_revision" in data) || typeof data.env_revision !== "string") {
        throw new Error("Missing environment revision");
      }
      const revision = data.env_revision;
      expect(JSON.stringify(data)).not.toContain("private-marker");
      const put = (expected: string, value: string) => app.handle(new Request(`${endpoint}/env`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "replace", expected_revision: expected,
          env_entries: [{ name: "TOKEN", value }],
        }),
      }));
      const [first, second] = await Promise.all([put(revision, "first-private-marker"), put(revision, "second-private-marker")]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const stored = await service.getDeployment("proj123", deployment.id);
      expect(stored?.env_vars["TOKEN"]).toBe(first.status === 200 ? "first-private-marker" : "second-private-marker");
      const savedBytes = await readFile(filename, "utf8");
      const stale = await put(revision, "stale");
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        code: "ENVIRONMENT_CONFLICT", message: "Environment changed; reload before saving",
        project_ref: "proj123", deployment_id: deployment.id, expected_revision: revision,
      });
      expect(await readFile(filename, "utf8")).toBe(savedBytes);
      if (!stored) throw new Error("Missing saved environment");
      for (const invalidRevision of [
        createFrontendEnvironmentRevision({ ...stored, project_ref: "other" }),
        createFrontendEnvironmentRevision({ ...stored, id: "other" }),
        "plaintext", `${revision}#`,
      ]) {
        expect((await put(invalidRevision, "unwanted")).status).toBe(409);
        expect(await readFile(filename, "utf8")).toBe(savedBytes);
      }
      const fresh = createFrontendEnvironmentRevision(stored);
      const kept = await put(fresh, "********");
      expect(kept.status).toBe(200);
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual(stored.env_vars);
      const responseText = await kept.text();
      expect(responseText).not.toContain("private-marker");
      expect(responseText).toContain('"env_revision"');
      const request = (url: string, options: RequestInit) => app.handle(new Request(`http://localhost${url}`, options));
      const signal = new AbortController().signal;
      const snapshot = await loadHostingDetail("proj123", deployment.id, request, signal);
      if (!snapshot) throw new Error("Missing consumer snapshot");
      const nextRevision = await saveHostingEnvironment("proj123", deployment.id, { TOKEN: "consumer-update" },
        request, signal, snapshot.env_revision);
      const beforeConflict = await readFile(filename, "utf8");
      await expect(saveHostingEnvironment("proj123", deployment.id, { TOKEN: "stale-consumer" },
        request, signal, snapshot.env_revision)).rejects.toBeInstanceOf(HostingEnvironmentConflictError);
      expect(await readFile(filename, "utf8")).toBe(beforeConflict);
      await saveHostingEnvironment("proj123", deployment.id, { TOKEN: "next-update" }, request, signal, nextRevision);
      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({ TOKEN: "next-update" });
    } finally {
      get.mockRestore();
      save.mockRestore();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("environment client rejects invalid input and receipts without leaking submitted values", async () => {
    const revision = "enc:v1:consumerFixture";
    let requests = 0;
    let getters = 0;
    const request = async () => { requests++; return Response.json({}); };
    const signal = new AbortController().signal;
    const accessor = Object.defineProperty({}, "TOKEN", {
      enumerable: true, get() { getters++; return "private-marker"; },
    });
    for (const input of [null, [], { TOKEN: 1 }, { "bad-key": "value" }, accessor]) {
      await expect(saveHostingEnvironment("proj123", "dep123", input, request, signal, revision)).rejects.toThrow();
    }
    for (const invalidRevision of ["", "invalid", `enc:v1:${"x".repeat(257)}`]) {
      await expect(saveHostingEnvironment("proj123", "dep123", {}, request, signal, invalidRevision)).rejects.toThrow();
    }
    expect(requests).toBe(0);
    expect(getters).toBe(0);
    const conflict = {
      code: "ENVIRONMENT_CONFLICT", message: "Environment changed; reload before saving",
      project_ref: "proj123", deployment_id: "dep123", expected_revision: revision,
    };
    for (const change of [
      { project_ref: "foreign" }, { deployment_id: "foreign" }, { expected_revision: "enc:v1:other" },
      { code: "UNKNOWN" }, { message: "private-marker" },
    ]) {
      await expect(saveHostingEnvironment("proj123", "dep123", {}, async () =>
        Response.json({ ...conflict, ...change }, { status: 409 }), signal, revision))
        .rejects.toMatchObject({ mutationMayHaveApplied: true });
    }
    const good = {
      success: true, operation: "update_env", mode: "replace", project_ref: "proj123", deployment_id: "dep123",
      id: "dep123", env_vars: { TOKEN: "********" },
      env_revision: revision, previous_env_revision: revision,
    };
    for (const change of [
      { operation: "other" }, { project_ref: "other" }, { deployment_id: "other" }, { id: "other" },
      { success: false }, { env_vars: {} }, { env_vars: { TOKEN: "private-marker" } },
      { mode: "merge" }, { mode: undefined }, { env_vars: { TOKEN: "********", EXTRA: "********" } },
      { previous_env_revision: undefined }, { previous_env_revision: "enc:v1:other" },
      { env_revision: undefined }, { env_revision: "invalid" },
    ]) {
      const pending = saveHostingEnvironment("proj123", "dep123", { TOKEN: "private-marker" },
        async () => Response.json({ ...good, ...change }), signal, revision);
      await expect(pending).rejects.toMatchObject({
        mutationMayHaveApplied: true, message: "Hosting environment update could not be confirmed",
      });
    }
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    const pending = saveHostingEnvironment("proj123", "dep123", { TOKEN: "private-marker" }, async () => {
      started.resolve();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }, controller.signal, revision);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ mutationMayHaveApplied: true });
    expect(cancelled).toBe(true);
  });

  test("configuration helper sends one atomic save and never replays an uncertain receipt", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-config-route-"));
    const service = new FrontendService(baseDir, async (_ref, _id, work) => work());
    const save = spyOn(frontendService, "saveBuildConfiguration").mockImplementation(
      (ref, id, configuration, url, branch, revision) => service.saveBuildConfiguration(ref, id, configuration, url, branch, revision),
    );
    const methods: string[] = [];
    let damage: string | undefined;
    const request = async (url: string, options: RequestInit) => {
      expect(url.endsWith("/configuration")).toBe(true);
      methods.push(options.method ?? "GET");
      expect(options.cache).toBe("no-store");
      expect(options.redirect).toBe("error");
      const response = await app.handle(new Request(`http://localhost${url}`, options));
      const text = await response.text();
      return new Response(options.method === damage ? text.slice(0, -1) : text, {
        status: response.status, headers: response.headers,
      });
    };
    const signal = new AbortController().signal;
    const input = {
      configuration: { build_command: "build", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/" },
      git: { url: "https://example.com/site.git", branch: "main" },
    };
    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      const currentRevision = async () => {
        const current = await service.getDeployment("proj123", deployment.id);
        if (!current) throw new Error("Missing configuration");
        return createFrontendConfigurationRevision(current);
      };
      const initialRevision = await currentRevision();
      const nextRevision = await saveHostingConfiguration("proj123", deployment.id, input, request, signal, initialRevision);
      expect(methods).toEqual(["PUT"]);
      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        ...input.configuration, git_url: input.git.url, git_branch: "main",
      });
      damage = "PUT";
      input.configuration.build_command = "after-cut";
      input.git.branch = "saved-together";
      await expect(saveHostingConfiguration("proj123", deployment.id, input, request, signal, nextRevision))
        .rejects.toMatchObject({ mutationMayHaveApplied: true });
      expect(methods).toEqual(["PUT", "PUT"]);
      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        build_command: "after-cut", git_branch: "saved-together",
      });
      damage = undefined;
      const beforeInvalid = await readFile(path.join(baseDir, "proj123", deployment.id, "deployment.json"), "utf8");
      input.configuration.build_command = "must-not-save";
      input.git.url = "file:///tmp/repo";
      await expect(saveHostingConfiguration("proj123", deployment.id, input, request, signal, await currentRevision()))
        .rejects.toBeInstanceOf(HostingConfigurationUpdateError);
      expect(methods).toEqual(["PUT", "PUT", "PUT"]);
      expect(await readFile(path.join(baseDir, "proj123", deployment.id, "deployment.json"), "utf8")).toBe(beforeInvalid);
      input.git.url = "";
      await saveHostingConfiguration("proj123", deployment.id, input, request, signal, await currentRevision());
      expect(methods).toEqual(["PUT", "PUT", "PUT", "PUT"]);
      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        build_command: "must-not-save", git_url: "",
      });
      const beforeConflict = await readFile(path.join(baseDir, "proj123", deployment.id, "deployment.json"), "utf8");
      await expect(saveHostingConfiguration("proj123", deployment.id, input, request, signal, initialRevision))
        .rejects.toBeInstanceOf(HostingConfigurationConflictError);
      expect(await readFile(path.join(baseDir, "proj123", deployment.id, "deployment.json"), "utf8")).toBe(beforeConflict);
    } finally {
      save.mockRestore();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("combined configuration saves publish both sections with one native metadata replacement", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-config-atomic-"));
    let locks = 0;
    const service = new FrontendService(baseDir, async (_ref, _id, work) => { locks++; return work(); });
    const save = spyOn(frontendService, "saveBuildConfiguration").mockImplementation(
      (ref, id, configuration, url, branch, revision) => service.saveBuildConfiguration(ref, id, configuration, url, branch, revision),
    );
    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site", framework: "static", env_vars: { TOKEN: "private-env" },
      });
      await service.setGitConfig("proj123", deployment.id, "https://user:private-git@example.com/site.git", "old");
      locks = 0;
      const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
      const before = await readFile(filename, "utf8");
      const configuration = {
        build_command: "new-build", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/",
      };
      const stored = await service.getDeployment("proj123", deployment.id);
      if (!stored) throw new Error("Missing configuration");
      const body = {
        configuration, git: { url: "https://example.com/site.git", branch: "feature/site" },
        expected_revision: createFrontendConfigurationRevision(stored),
      };
      const put = (value: unknown) => app.handle(new Request(
        `http://localhost/v1/projects/proj123/frontend/deployments/${deployment.id}/configuration`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) },
      ));
      const originalRename = filesystem.rename;
      let replacements = 0;
      let failReplacement = true;
      const rename = spyOn(filesystem, "rename").mockImplementation(async (source, target) => {
        replacements++;
        if (failReplacement) throw new Error("Synthetic metadata publication failure");
        return originalRename(source, target);
      });
      try {
        for (const invalid of [
          { ...body, git: { url: "file:///tmp/repo", branch: "main" } },
          { ...body, configuration: { ...configuration, output_dir: "../escape" } },
          { ...body, configuration: { build_command: "incomplete" } },
        ]) {
          expect((await put(invalid)).status).toBeGreaterThanOrEqual(400);
          expect(await readFile(filename, "utf8")).toBe(before);
        }
        expect(locks).toBe(0);
        expect(replacements).toBe(0);
        const callsBeforeMissing = save.mock.calls.length;
        expect((await put({ configuration, git: body.git })).status).toBe(428);
        expect(save.mock.calls).toHaveLength(callsBeforeMissing);
        for (const revision of [
          createFrontendEnvironmentRevision(stored),
          createFrontendConfigurationRevision({ ...stored, project_ref: "other" }),
          createFrontendConfigurationRevision({ ...stored, id: "other" }),
          "invalid",
        ]) {
          expect((await put({ ...body, expected_revision: revision })).status).toBe(409);
          expect(await readFile(filename, "utf8")).toBe(before);
        }
        expect(replacements).toBe(0);
        expect((await put(body)).status).toBeGreaterThanOrEqual(400);
        expect(replacements).toBe(1);
        expect(await readFile(filename, "utf8")).toBe(before);
        failReplacement = false;
        const response = await put(body);
        expect(response.status).toBe(200);
        expect(replacements).toBe(2);
        const text = await response.text();
        expect(text).not.toContain("private-git");
        expect(text).not.toContain("private-env");
        const receipt: unknown = JSON.parse(text);
        expect(receipt).toMatchObject({
          ...configuration, success: true, operation: "update_configuration",
          project_ref: "proj123", deployment_id: deployment.id,
          git_url: body.git.url, git_branch: "feature/site",
        });
        expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
          ...configuration, git_url: "https://user:private-git@example.com/site.git", git_branch: "feature/site",
          env_vars: { TOKEN: "private-env" }, status: "pending",
        });
        const updated = await service.getDeployment("proj123", deployment.id);
        if (!updated) throw new Error("Missing saved configuration");
        expect((await put({
          ...body, git: { url: "", branch: "main" }, expected_revision: createFrontendConfigurationRevision(updated),
        })).status).toBe(200);
        expect(replacements).toBe(3);
        expect((await service.getDeployment("proj123", deployment.id))?.git_url).toBe("");
      } finally {
        rename.mockRestore();
      }
    } finally {
      save.mockRestore();
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("configuration input and combined receipts reject malformed fields without replay", async () => {
    const revision = "enc:v1:configurationFixture";
    const configuration = {
      build_command: "build", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/",
    };
    const input = { configuration, git: { url: "https://example.com/site.git", branch: "main" } };
    const signal = new AbortController().signal;
    let requests = 0;
    let getterReads = 0;
    const request = async () => { requests++; return Response.json({}); };
    const accessor = Object.defineProperty({}, "configuration", { enumerable: true, get() { getterReads++; return configuration; } });
    for (const invalid of [
      null, {}, accessor, { ...input, git: null }, { ...input, extra: true },
      { ...input, configuration: { ...configuration, node_version: 20 } },
    ]) await expect(saveHostingConfiguration("proj123", "dep123", invalid, request, signal, revision)).rejects.toThrow();
    expect(requests).toBe(0);
    expect(getterReads).toBe(0);
    const conflict = {
      code: "CONFIGURATION_CONFLICT", message: "Configuration changed; reload before saving",
      project_ref: "proj123", deployment_id: "dep123", expected_revision: revision,
    };
    await expect(saveHostingConfiguration("proj123", "dep123", input, async () =>
      Response.json(conflict, { status: 409 }), signal, revision)).rejects.toBeInstanceOf(HostingConfigurationConflictError);
    for (const change of [
      { project_ref: "other" }, { deployment_id: "other" }, { expected_revision: "enc:v1:other" }, { code: "OTHER" },
    ]) {
      await expect(saveHostingConfiguration("proj123", "dep123", input, async () =>
        Response.json({ ...conflict, ...change }, { status: 409 }), signal, revision))
        .rejects.toMatchObject({ mutationMayHaveApplied: true });
    }
    const receipt = {
      ...configuration, success: true, operation: "update_configuration",
      project_ref: "proj123", deployment_id: "dep123", id: "dep123",
      git_url: input.git.url, git_branch: input.git.branch,
      previous_configuration_revision: revision, configuration_revision: "enc:v1:nextConfiguration",
    };
    for (const change of [
      { success: false }, { operation: "other" }, { project_ref: "foreign" }, { id: "foreign" },
      { deployment_id: "foreign" }, { build_command: "different" }, { node_version: 20 }, { output_dir: null },
      { previous_configuration_revision: undefined }, { previous_configuration_revision: "enc:v1:foreign" },
      { configuration_revision: undefined }, { configuration_revision: "invalid" },
    ]) {
      let calls = 0;
      await expect(saveHostingConfiguration("proj123", "dep123", input, async () => {
        calls++;
        return Response.json({ ...receipt, ...change });
      }, signal, revision)).rejects.toMatchObject({ mutationMayHaveApplied: true });
      expect(calls).toBe(1);
    }
    for (const change of [
      { operation: "update_deployment" }, { project_ref: "foreign" }, { deployment_id: "foreign" },
      { git_url: "https://example.com/other.git" }, { git_branch: "other" },
    ]) {
      let calls = 0;
      await expect(saveHostingConfiguration("proj123", "dep123", input, async () => {
        calls++;
        return Response.json({ ...receipt, ...change });
      }, signal, revision)).rejects.toMatchObject({ mutationMayHaveApplied: true });
      expect(calls).toBe(1);
    }
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let cancelled = false;
    const pending = saveHostingConfiguration("proj123", "dep123", input, async () => {
      entered.resolve();
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }, controller.signal, revision);
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ mutationMayHaveApplied: true });
    expect(cancelled).toBe(true);
  });

  test("supports direct raw binary uploads (application/zip)", async () => {
    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(testZipBytes.byteLength),
        },
        body: testZipBytes,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deployment_id).toBe("dep123");
  });

  test("passes the SvelteKit readiness path through create and update APIs", async () => {
    const createDeployment = spyOn(frontendService, "createDeployment").mockImplementation(
      async (ref, input) => ({
        id: "dep-sveltekit",
        project_ref: ref,
        name: input.name,
        framework: input.framework,
        domain: "sveltekit.example.com",
        custom_domains: [],
        build_command: "npm run build",
        output_dir: "build",
        install_command: "npm install",
        node_version: "20",
        ...(input.health_check_path === undefined ? {} : { health_check_path: input.health_check_path }),
        env_vars: {},
        status: "pending",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        deployment_url: "https://sveltekit.example.com",
      }),
    );
    const updateDeployment = spyOn(frontendService, "updateDeployment").mockImplementation(
      async () => ({
        id: "dep-sveltekit",
        project_ref: "proj123",
        name: "sveltekit-app",
        framework: "sveltekit",
        domain: "sveltekit.example.com",
        custom_domains: [],
        build_command: "npm run build",
        output_dir: "build",
        install_command: "npm install",
        node_version: "20",
        health_check_path: "/ready",
        env_vars: {},
        status: "pending",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
        deployment_url: "https://sveltekit.example.com",
      }),
    );

    const createResponse = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "sveltekit-app",
          framework: "sveltekit",
          health_check_path: "/ready",
        }),
      },
    ));
    expect(createResponse.status).toBe(201);
    expect(createDeployment).toHaveBeenCalledWith(
      "proj123",
      expect.objectContaining({ health_check_path: "/ready" }),
    );

    const updateResponse = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep-sveltekit",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ health_check_path: "/ready" }),
      },
    ));
    expect(updateResponse.status).toBe(200);
    expect(updateDeployment).toHaveBeenCalledWith(
      "proj123",
      "dep-sveltekit",
      expect.objectContaining({ health_check_path: "/ready" }),
    );
  });

  test("supports multipart/form-data upload when parsed by Elysia (mocked body.file)", async () => {
    // Simulate Elysia built-in parsed object format: body: { file: Blob }
    const mockFile = new Blob([testZipBytes], { type: "application/zip" });

    // Send request with FormData directly; Elysia should parse it by default
    const form = new FormData();
    form.append("file", mockFile, "upload.zip");

    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        body: form,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("gracefully handles invalid zip archive upload", async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const req = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/deploy/upload",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
        },
        body: invalidBytes,
      }
    );

    const res = await app.handle(req);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid zip archive");
  });

  test("denies the request when project authorization fails and skips the service", async () => {
    requireProjectOrAdminAuth.mockResolvedValue({
      status: 403,
      body: { error: "Missing capability: operations.manage" },
    });
    const createDeployment = spyOn(frontendService, "createDeployment");
    createDeployment.mockClear();

    const res = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "denied-site", framework: "static" }),
      },
    ));

    expect(res.status).toBe(403);
    expect(requireProjectOrAdminAuth).toHaveBeenCalledWith(expect.any(Request), "proj123");
    expect(createDeployment).not.toHaveBeenCalled();
  });

  test("validates deployment frameworks and preserves optional empty values without fabricating missing fields", async () => {
    const create = spyOn(frontendService, "createDeployment").mockImplementation(async (ref, input) =>
      deploymentFixture({ project_ref: ref, ...input }));
    try {
      for (const framework of FRONTEND_FRAMEWORKS) {
        const response = await app.handle(new Request("http://localhost/v1/projects/proj123/frontend/deployments", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test-site", framework, build_command: "", env_vars: {} }),
        }));
        expect(response.status).toBe(201);
        expect(create).toHaveBeenLastCalledWith("proj123", {
          name: "test-site", framework, build_command: "", env_vars: {},
        });
      }
      create.mockClear();
      for (const framework of ["unknown", "", 123, null]) {
        const response = await app.handle(new Request("http://localhost/v1/projects/proj123/frontend/deployments", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "test-site", framework }),
        }));
        expect(response.status).toBe(422);
      }
      expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  });

  test("routes immutable release inventory and upload through the release service", async () => {
    const releaseId = "a".repeat(64);
    const stream = mockImmutableUpload(releaseId);
    const listReleases = spyOn(frontendReleaseService, "listReleases").mockResolvedValue({
      project_ref: "proj123",
      deployment_id: "dep123",
      active_release_id: null,
      active_activation_id: null,
      releases: [],
      next_cursor: null,
    });
    const createRelease = spyOn(frontendReleaseService, "createRelease").mockResolvedValue({
      schema: "supacloud.frontend-release.v1",
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: "b".repeat(64),
      size_bytes: testZipBytes.byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static",
    });
    const inventory = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
    ));
    expect(inventory.status).toBe(200);
    expect(listReleases).toHaveBeenCalledWith("proj123", "dep123", { limit: 50 });

    const upload = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(testZipBytes.byteLength),
          "x-supacloud-content-sha256": releaseId,
        },
        body: testZipBytes,
      },
    ));
    expect(upload.status).toBe(201);
    expect(createRelease).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(stream.written).equals(testZipBytes)).toBe(true);
    expect(stream.prepare).toHaveBeenCalledWith("proj123", "dep123", testZipBytes.byteLength);
    expect(createRelease.mock.calls[0]?.slice(0, 2)).toEqual(["proj123", "dep123"]);
    expect(createRelease.mock.calls[0]?.[2]).toBe(stream.staged);
    expect(stream.upload.finish).toHaveBeenCalledWith(releaseId);
    expect(stream.upload.abort).toHaveBeenCalledTimes(1);
  });

  test("gets one release and rejects non-raw or unbounded immutable uploads", async () => {
    const releaseId = "a".repeat(64);
    const release = {
      schema: "supacloud.frontend-release.v1" as const,
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: "b".repeat(64),
      size_bytes: testZipBytes.byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static" as const,
    };
    const getRelease = spyOn(frontendReleaseService, "release").mockResolvedValue(release);
    const createRelease = spyOn(frontendReleaseService, "createRelease");
    createRelease.mockClear();

    const read = await app.handle(new Request(
      `http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases/${releaseId}`,
    ));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      project_ref: "proj123",
      deployment_id: "dep123",
      release,
    });
    expect(getRelease).toHaveBeenCalledWith("proj123", "dep123", releaseId);

    for (const headers of [
      { "Content-Type": "application/json", "Content-Length": "2" },
      { "Content-Type": "application/zip" },
    ]) {
      const response = await app.handle(new Request(
        "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
        { method: "POST", headers, body: new Uint8Array([1, 2]) },
      ));
      expect(response.status).toBe(headers["Content-Type"] === "application/json" ? 415 : 411);
    }
    expect(createRelease).not.toHaveBeenCalled();
  });

  test("rejects immutable upload before reading its body when storage mutations are unsupported", async () => {
    const preflight = spyOn(frontendReleaseService, "prepareReleaseUpload").mockRejectedValue(
      new (await import("../../src/services/frontend-release.service")).FrontendReleaseError(
        "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
        503,
        "Immutable frontend release storage requires Linux directory binding",
      ),
    );
    const createRelease = spyOn(frontendReleaseService, "createRelease");
    createRelease.mockClear();
    let bodyReaderRequests = 0;
    const request = new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": "64",
          "x-supacloud-content-sha256": "a".repeat(64),
        },
        body: new Uint8Array(64),
      },
    );
    const requestBody = request.body!;
    const originalGetReader = requestBody.getReader.bind(requestBody);
    requestBody.getReader = ((...args: Parameters<typeof requestBody.getReader>) => {
      bodyReaderRequests += 1;
      return originalGetReader(...args);
    }) as typeof requestBody.getReader;

    const response = await app.handle(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
      error: "Immutable frontend release storage requires Linux directory binding",
    });
    expect(preflight).toHaveBeenCalledWith("proj123", "dep123", 64);
    expect(createRelease).not.toHaveBeenCalled();
    expect(bodyReaderRequests).toBe(0);
  });

  test("bounds writes for a 100 MiB upload and always aborts the staging session", async () => {
    const byteLength = 100 * 1024 * 1024;
    const releaseId = "a".repeat(64);
    const sourceChunk = new Uint8Array(1024 * 1024);
    let sourceOffset = 0;
    let maximumWrite = 0;
    let totalWritten = 0;
    const startingRss = process.memoryUsage.rss();
    let peakRss = startingRss;
    const staged = Object.freeze({ size_bytes: byteLength, sha256: releaseId });
    const upload = {
      write: mock(async (chunk: Uint8Array) => {
        maximumWrite = Math.max(maximumWrite, chunk.byteLength);
        totalWritten += chunk.byteLength;
        peakRss = Math.max(peakRss, process.memoryUsage.rss());
      }),
      finish: mock(async () => staged),
      abort: mock(async () => undefined),
    };
    spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    spyOn(frontendReleaseService, "createRelease").mockResolvedValue({
      schema: "supacloud.frontend-release.v1",
      project_ref: "proj123",
      deployment_id: "dep123",
      release_id: releaseId,
      sha256: releaseId,
      tree_sha256: releaseId,
      size_bytes: byteLength,
      file_count: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      kind: "prebuilt_static",
    });
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "content-length": String(byteLength),
          "x-supacloud-content-sha256": releaseId,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sourceOffset === byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(sourceChunk);
            sourceOffset += sourceChunk.byteLength;
          },
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(totalWritten).toBe(byteLength);
    expect(maximumWrite).toBeLessThanOrEqual(64 * 1024);
    expect(peakRss - startingRss).toBeLessThan(64 * 1024 * 1024);
    expect(upload.abort).toHaveBeenCalledTimes(1);
  });

  for (const uploadCase of ["short", "long", "digest"] as const) {
    test(`aborts staged uploads after ${uploadCase} validation failure`, async () => {
      const createRelease = spyOn(frontendReleaseService, "createRelease");
      createRelease.mockClear();
      let written = 0;
      const upload = {
        write: mock(async (chunk: Uint8Array) => {
          written += chunk.byteLength;
          if (uploadCase === "long" && written > 2) {
            throw new FrontendReleaseError(
              "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
              400,
              "length mismatch",
            );
          }
        }),
        finish: mock(async () => {
          throw new FrontendReleaseError(
            uploadCase === "digest" ? "FRONTEND_RELEASE_SHA_MISMATCH" : "FRONTEND_RELEASE_CONTENT_LENGTH_MISMATCH",
            400,
            "upload mismatch",
          );
        }),
        abort: mock(async () => undefined),
      };
      spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
      const body = uploadCase === "long" ? new Uint8Array([1, 2, 3]) : new Uint8Array([1]);
      const response = await app.handle(new Request(
        "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
        {
          method: "POST",
          headers: {
            "content-type": "application/zip",
            "content-length": "2",
            "x-supacloud-content-sha256": "a".repeat(64),
          },
          body,
        },
      ));
      expect(response.status).toBe(400);
      expect(upload.abort).toHaveBeenCalledTimes(1);
      expect(createRelease).not.toHaveBeenCalled();
    });
  }

  test("aborts staging when the request body stream fails", async () => {
    const upload = {
      write: mock(async () => undefined),
      finish: mock(async () => Object.freeze({ size_bytes: 2, sha256: "a".repeat(64) })),
      abort: mock(async () => undefined),
    };
    spyOn(frontendReleaseService, "prepareReleaseUpload").mockResolvedValue(upload);
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "content-length": "2",
          "x-supacloud-content-sha256": "a".repeat(64),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new Error("body interrupted"));
          },
        }),
      },
    ));
    expect(response.status).toBe(500);
    expect(upload.finish).not.toHaveBeenCalled();
    expect(upload.abort).toHaveBeenCalledTimes(1);
  });

  test("passes exact activation CAS fields and verified principal to the release service", async () => {
    const releaseId = "a".repeat(64);
    const mutationId = "00000000-0000-4000-8000-000000000001";
    const principal = { type: "project" as const, id: "project:proj123" };
    const principalSpy = spyOn(authModule, "getVerifiedRequestPrincipal").mockResolvedValue(principal);
    const activate = spyOn(frontendReleaseService, "activateRelease").mockResolvedValue({
      project_ref: "proj123",
      deployment_id: "dep123",
      active_release_id: releaseId,
      activation_id: mutationId,
      release: {
        schema: "supacloud.frontend-release.v1",
        project_ref: "proj123",
        deployment_id: "dep123",
        release_id: releaseId,
        sha256: releaseId,
        tree_sha256: "b".repeat(64),
        size_bytes: 1,
        file_count: 1,
        created_at: "2026-08-12T00:00:00.000Z",
        kind: "prebuilt_static",
      },
      mutation: { mutation_id: mutationId, status: "succeeded", replayed: false },
    });

    const response = await app.handle(new Request(
      `http://localhost/v1/projects/proj123/frontend/deployments/dep123/releases/${releaseId}/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_active_release_id: "absent",
          expected_activation_id: "absent",
          mutation_id: mutationId,
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(activate).toHaveBeenCalledWith({
      projectRef: "proj123",
      deploymentId: "dep123",
      releaseId,
      expectedActiveReleaseId: "absent",
      expectedActivationId: "absent",
      mutationId,
      principal,
    });
    expect(JSON.stringify(await response.json())).not.toContain("authorization");
    principalSpy.mockRestore();
  });

  test("returns an explicit conflict instead of deleting an active immutable deployment", async () => {
    const deleteDeployment = spyOn(frontendService, "deleteDeployment").mockResolvedValue("active");
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj123/frontend/deployments/dep123",
      { method: "DELETE" },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Immutable frontend release is active",
      code: "FRONTEND_RELEASE_ACTIVE",
    });
    expect(deleteDeployment).toHaveBeenCalledWith("proj123", "dep123");
  });

  test("actual hosting mutation responses satisfy the Console's operation-specific receipts", async () => {
    const deleted = spyOn(frontendService, "deleteDeployment").mockResolvedValue("deleted");
    const token = spyOn(frontendService, "deleteDeployToken").mockResolvedValue(true);
    const domain = spyOn(frontendService, "removeCustomDomain").mockResolvedValue(deploymentFixture());
    try {
      const cases = [
        { method: "DELETE", suffix: "", mutation: { operation: "delete_deployment" } },
        { method: "DELETE", suffix: "/tokens/token123", mutation: { operation: "delete_token", tokenId: "token123" } },
        { method: "DELETE", suffix: "/domains/site.example.com", mutation: { operation: "remove_domain", domain: "site.example.com" } },
        { method: "POST", suffix: "/redeploy", mutation: { operation: "redeploy" } },
      ] satisfies Array<{ method: string; suffix: string; mutation: Parameters<typeof hostingReceipt>[2] }>;
      for (const entry of cases) {
        const response = await app.handle(new Request(
          `http://localhost/v1/projects/proj123/frontend/deployments/dep123${entry.suffix}`, { method: entry.method },
        ));
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(() => hostingReceipt("proj123", "dep123", entry.mutation)(body)).not.toThrow();
        expect(() => hostingReceipt("other-project", "dep123", entry.mutation)(body)).toThrow();
      }
      expect(deleted).toHaveBeenCalledWith("proj123", "dep123");
      expect(token).toHaveBeenCalledWith("proj123", "dep123", "token123");
      expect(domain).toHaveBeenCalledWith("proj123", "dep123", "site.example.com");
    } finally {
      deleted.mockRestore();
      token.mockRestore();
      domain.mockRestore();
    }
  });

  test("the actual deployment list route supplies the Console's project-bound projection", async () => {
    const fixture = deploymentFixture({
      env_vars: { SECRET: "private-marker" }, build_log: "private-marker",
      deploy_tokens: [{ id: "token123", name: "ci", token: "private-marker", created_at: new Date(0).toISOString() }],
    });
    const list = spyOn(frontendService, "listDeployments").mockResolvedValue([fixture]);
    try {
      const response = await app.handle(new Request(
        "http://localhost/v1/projects/proj123/frontend/deployments",
      ));
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const rows = parseHostingList(body, "proj123");
      expect(rows).toEqual([{
        id: "dep123", project_ref: "proj123", name: "test-site", framework: "static",
        domain: "test.example.com", custom_domains: [], status: "pending",
        created_at: new Date(0).toISOString(), deployment_url: "https://test.example.com",
      }]);
      expect(JSON.stringify(body)).not.toContain("private-marker");
      expect(() => parseHostingList(body, "other-project")).toThrow();
      expect(list).toHaveBeenCalledWith("proj123");
    } finally {
      list.mockRestore();
    }
  });

  test("absent tokens and contradictory domain or build results never produce positive receipts", async () => {
    const token = spyOn(frontendService, "deleteDeployToken").mockResolvedValue(false);
    const domain = spyOn(frontendService, "removeCustomDomain").mockResolvedValue(
      deploymentFixture({ custom_domains: ["site.example.com"] }),
    );
    const build = spyOn(frontendService, "deployFromSource").mockResolvedValue({
      success: true, deployment_id: "other-deployment", url: "https://site.example.com", build_log: "",
    });
    try {
      for (const [suffix, method, expected] of [
        ["/tokens/token123", "DELETE", 404], ["/domains/site.example.com", "DELETE", 502], ["/redeploy", "POST", 502],
      ] satisfies Array<[string, string, number]>) {
        const response = await app.handle(new Request(
          `http://localhost/v1/projects/proj123/frontend/deployments/dep123${suffix}`, { method },
        ));
        expect(response.status).toBe(expected);
        const body: unknown = await response.json();
        expect(body).not.toMatchObject({ success: true });
      }
    } finally {
      token.mockRestore();
      domain.mockRestore();
      build.mockRestore();
    }
  });
});

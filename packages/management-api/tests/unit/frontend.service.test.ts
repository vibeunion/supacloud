import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../src/config";
import { FrontendService } from "../../src/services/frontend.service";
import { FrontendDomainService } from "../../src/services/frontend-domain.service";
import { saveHostingConfiguration } from "../../../web-console/src/lib/hosting-configuration";
import { FrontendDeploymentReadError, MAX_FRONTEND_DEPLOYMENT_BYTES, readFrontendDeploymentFile } from "../../src/utils/frontend-deployment-record";
import {
  prepareSvelteKitRuntime,
  renderSvelteKitSystemdUnit,
} from "../../src/services/frontend-runtime";
import { FRAMEWORK_DEFAULTS, type FrontendDeployment } from "../../src/types/frontend";

const originalFetch = globalThis.fetch;
const originalCaddyPaths = { config: config.caddyConfigPath, state: config.caddyStateDir };
let caddyFixtureDirectory: string | undefined;
const withoutDeploymentLock = async <T>(
  _projectRef: string,
  _deploymentId: string,
  operation: () => Promise<T>,
): Promise<T> => operation();
const noImmutableRelease = async () => ({
  activeBuildDir: async () => null,
  hasActiveRelease: async () => false,
  hasUnresolvedActivation: async () => false,
});

function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  return { wait: new Promise<void>((resolve) => { release = resolve; }), release };
}

beforeEach(async () => {
  caddyFixtureDirectory = await mkdtemp(join(tmpdir(), "supacloud-frontend-caddy-"));
  config.caddyConfigPath = join(caddyFixtureDirectory, "config.json");
  config.caddyStateDir = join(caddyFixtureDirectory, "state");
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] })))) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.caddyConfigPath = originalCaddyPaths.config;
  config.caddyStateDir = originalCaddyPaths.state;
  if (caddyFixtureDirectory) await rm(caddyFixtureDirectory, { recursive: true, force: true });
  caddyFixtureDirectory = undefined;
});

test("native deployment reads distinguish missing files from invalid records and filesystem failures", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-read-"));
  const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
  const directory = join(baseDir, "proj123", "dep123");
  const filename = join(directory, "deployment.json");
  const deployment: FrontendDeployment = {
    id: "dep123", project_ref: "proj123", name: "site", framework: "static",
    domain: "site.example.com", custom_domains: [], build_command: "", output_dir: ".",
    install_command: "", node_version: "20", env_vars: { TOKEN: "private-marker" },
    status: "pending", created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    deployment_url: "https://site.example.com",
    deploy_tokens: [{ id: "token123", name: "ci", token_encrypted: "encrypted-marker", created_at: new Date(0).toISOString() }],
  };
  try {
    expect(await service.getDeployment("proj123", "dep123")).toBeNull();
    expect(await service.listDeployments("proj123")).toEqual([]);
    await expect(service.getDeployment("../other", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await expect(service.listDeployments("../other")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await mkdir(directory, { recursive: true });
    await writeFile(filename, JSON.stringify(deployment));
    expect(await service.getDeployment("proj123", "dep123")).toEqual(deployment);
    expect(await service.listDeployments("proj123")).toEqual([deployment]);
    await mkdir(join(baseDir, "proj123", "unfinished"));
    expect(await service.listDeployments("proj123")).toEqual([deployment]);
    await expect(service.updateDeployment("proj123", "dep123", {
      install_command: "x".repeat(MAX_FRONTEND_DEPLOYMENT_BYTES),
    })).rejects.toThrow("Frontend deployment metadata exceeds the byte limit");
    expect(await readFile(filename, "utf8")).toBe(JSON.stringify(deployment));
    for (const value of [
      null, false, [], {}, { ...deployment, id: "other" }, { ...deployment, project_ref: "other" },
      { ...deployment, framework: "unknown" }, { ...deployment, status: "unknown" },
      { ...deployment, build_command: 123 }, { ...deployment, env_vars: { TOKEN: 123 } },
      { ...deployment, deploy_tokens: null }, { ...deployment, deploy_tokens: [{ id: "token" }] },
      { ...deployment, created_at: "2026-02-30T00:00:00.000Z" },
      { ...deployment, unknown_future_field: "must not silently drop" },
    ]) {
      await writeFile(filename, JSON.stringify(value));
      await expect(service.getDeployment("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
      await expect(service.listDeployments("proj123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
      await expect(service.listDeployTokens("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
      expect(await readFile(filename, "utf8")).toBe(JSON.stringify(value));
    }
    await writeFile(filename, '{"private-marker":');
    await expect(service.listDeployments("proj123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    try {
      await service.getDeployment("proj123", "dep123");
      throw new Error("Expected malformed JSON failure");
    } catch (error) {
      expect(error).toBeInstanceOf(FrontendDeploymentReadError);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain("private-marker");
    }
    await rm(filename);
    const exact = { ...deployment, build_log: "" };
    const padding = MAX_FRONTEND_DEPLOYMENT_BYTES - Buffer.byteLength(JSON.stringify(exact));
    exact.build_log = "x".repeat(padding);
    await writeFile(filename, JSON.stringify(exact));
    expect((await service.getDeployment("proj123", "dep123"))?.build_log?.length).toBe(padding);
    await truncate(filename, MAX_FRONTEND_DEPLOYMENT_BYTES + 1);
    await expect(service.getDeployment("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await expect(service.listDeployments("proj123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await writeFile(filename, Buffer.concat([
      Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}'),
    ]));
    await expect(readFrontendDeploymentFile(filename)).rejects.toBeInstanceOf(TypeError);
    await expect(service.getDeployment("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await rm(filename);
    const target = join(baseDir, "outside.json");
    await writeFile(target, JSON.stringify(deployment));
    await symlink(target, filename);
    await expect(service.getDeployment("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await expect(service.listDeployments("proj123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(deployment));
    await rm(filename);
    await mkdir(filename);
    await expect(service.getDeployment("proj123", "dep123")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
    await writeFile(join(baseDir, "not-a-directory"), "private-marker");
    await expect(service.listDeployments("not-a-directory")).rejects.toBeInstanceOf(FrontendDeploymentReadError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("deployment updates decode before locking and preserve the captured input across a wait", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-update-"));
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let locks = 0;
  let accesses = 0;
  const service = new FrontendService(baseDir, async (_ref, _id, operation) => {
    locks++;
    acquired.resolve();
    await release.promise;
    return operation();
  }, noImmutableRelease);
  try {
    const creator = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
    const deployment = await creator.createDeployment("proj123", { name: "site", framework: "static" });
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const original = await readFile(filename, "utf8");
    const accessor = Object.defineProperty({}, "name", {
      enumerable: true, get() { accesses++; return "unexpected"; },
    });
    for (const update of [
      null, [], { id: "other" }, { project_ref: "other" }, { name: 1 },
      { status: "success" }, { build_log: "forged" },
      { framework: "unsupported" }, { env_vars: { KEY: 1 } }, { custom_domains: [null] },
      { node_version: null }, { custom_domains: new Array(1) },
      Object.create({ name: "inherited" }), accessor,
    ]) {
      await expect(service.updateDeployment("proj123", deployment.id, update))
        .rejects.toThrow("Invalid frontend deployment update");
    }
    expect(locks).toBe(0);
    expect(accesses).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(original);
    const update = {
      name: "captured", custom_domains: ["one.example.com"],
      env_vars: { KEY: "captured" }, node_version: undefined,
    };
    const pending = service.updateDeployment("proj123", deployment.id, update);
    await acquired.promise;
    update.name = "later";
    update.custom_domains[0] = "later.example.com";
    update.env_vars.KEY = "later";
    release.resolve();
    expect(await pending).toMatchObject({
      name: "captured", custom_domains: ["one.example.com"], env_vars: { KEY: "captured" },
      node_version: deployment.node_version,
    });
    expect(await creator.getDeployment("proj123", deployment.id)).toMatchObject({
      name: "captured", custom_domains: ["one.example.com"], env_vars: { KEY: "captured" },
    });
    expect(locks).toBe(1);
  } finally {
    release.resolve();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("deployment creation rejects invalid inputs before filesystem changes and writes bounded private metadata", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-create-"));
  const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
  const createUnknown = async (projectRef: string, input: unknown): Promise<unknown> => {
    const result: unknown = Reflect.apply(service.createDeployment, service, [projectRef, input]);
    return result;
  };
  let accessed = 0;
  const accessor = Object.defineProperty({ framework: "static" }, "name", {
    enumerable: true, get() { accessed++; return "site"; },
  });
  try {
    for (const input of [
      null, [], {}, { name: "site" }, { framework: "static" }, { name: "", framework: "static" },
      { name: "site", framework: "toString" }, { name: "site", framework: "static", project_ref: "other" },
      { name: "site", framework: "static", env_vars: { KEY: false } },
      { name: "site", framework: "static", custom_domains: [null] }, accessor,
    ]) await expect(createUnknown("proj123", input)).rejects.toThrow("Invalid frontend deployment configuration");
    await expect(service.createDeployment("../other", { name: "site", framework: "static" }))
      .rejects.toThrow("Invalid frontend project identity");
    await expect(service.createDeployment("proj123", {
      name: "site", framework: "static", install_command: "x".repeat(MAX_FRONTEND_DEPLOYMENT_BYTES),
    })).rejects.toThrow("Frontend deployment metadata exceeds the byte limit");
    expect(accessed).toBe(0);
    expect(await readdir(baseDir)).toEqual([]);
    const deployment = await service.createDeployment("proj123", {
      name: "site", framework: "static", env_vars: { KEY: "private-marker" },
    });
    expect(await service.getDeployment("proj123", deployment.id)).toEqual(deployment);
    const directory = join(baseDir, "proj123", deployment.id);
    expect((await readdir(directory)).sort()).toEqual(["build", "deployment.json", "source"]);
    expect((await lstat(join(directory, "deployment.json"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("metadata temporary files start private and collisions do not overwrite or remove foreign files", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-temp-"));
  const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
  const nativeOpen = fs.open;
  const observations: Array<{ mode: number; size: number }> = [];
  let failWrite = false;
  try {
    const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const uuid = "00000000-0000-4000-8000-000000000123";
    const temporaryPath = `${filename}.tmp-${uuid}`;
    const random = spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    const opening = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const file = await nativeOpen(path, flags, mode);
      if (path === temporaryPath) {
        const info = await file.stat();
        observations.push({ mode: info.mode & 0o777, size: info.size });
        if (failWrite) {
          const write = file.writeFile.bind(file);
          Object.defineProperty(file, "writeFile", { value: async () => {
            await write("partial-metadata");
            throw new Error("fixture write failure");
          } });
        }
      }
      return file;
    });
    try {
      await service.updateDeployment("proj123", deployment.id, { name: "updated" });
      expect(observations).toEqual([{ mode: 0o600, size: 0 }]);
      await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      const saved = await readFile(filename, "utf8");
      failWrite = true;
      await expect(service.updateDeployment("proj123", deployment.id, { name: "partial" }))
        .rejects.toThrow("fixture write failure");
      failWrite = false;
      await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(filename, "utf8")).toBe(saved);
      await writeFile(temporaryPath, "foreign-file");
      await expect(service.updateDeployment("proj123", deployment.id, { name: "collision" }))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(filename, "utf8")).toBe(saved);
      expect(await readFile(temporaryPath, "utf8")).toBe("foreign-file");
      await rm(temporaryPath);
      const target = join(baseDir, "foreign-target");
      await writeFile(target, "foreign-target-content");
      await symlink(target, temporaryPath);
      await expect(service.updateDeployment("proj123", deployment.id, { name: "symlink" }))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await readlink(temporaryPath)).toBe(target);
      expect(await readFile(target, "utf8")).toBe("foreign-target-content");
      expect(await readFile(filename, "utf8")).toBe(saved);
    } finally {
      opening.mockRestore();
      random.mockRestore();
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("token creation validates before locking and returns a scoped receipt for encrypted native storage", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-token-create-"));
  let locks = 0;
  let coercions = 0;
  const service = new FrontendService(baseDir, async (_ref, _id, operation) => {
    locks++;
    return operation();
  }, noImmutableRelease);
  try {
    const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const original = await readFile(filename, "utf8");
    for (const name of [null, false, 123, "", " ", "bad\nname", "x".repeat(1025),
      { toString() { coercions++; return "ci"; } }]) {
      const result: unknown = Reflect.apply(service.createDeployToken, service, ["proj123", deployment.id, name]);
      await expect(result).rejects.toThrow("Invalid deployment token creation input");
    }
    await expect(service.createDeployToken("../other", deployment.id, "ci"))
      .rejects.toThrow("Invalid deployment token creation input");
    expect(locks).toBe(0);
    expect(coercions).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(original);
    const receipt = await service.createDeployToken("proj123", deployment.id, "ci");
    expect(receipt).toMatchObject({
      operation: "create_token", project_ref: "proj123", deployment_id: deployment.id, name: "ci",
    });
    if (!receipt) throw new Error("Expected created token receipt");
    expect(receipt.token).toMatch(/^supa_deploy_[0-9a-f]{32}$/);
    expect(await readFile(filename, "utf8")).not.toContain(receipt.token);
    expect(await service.listDeployTokens("proj123", deployment.id)).toMatchObject([{ id: receipt.id, name: "ci" }]);
    expect(await service.verifyDeployToken("proj123", deployment.id, receipt.token)).toBe(true);
    const beforeCollision = await readFile(filename, "utf8");
    const random = spyOn(crypto, "randomUUID").mockReturnValue(`${receipt.id}-0000-4000-8000-000000000000`);
    try {
      await expect(service.createDeployToken("proj123", deployment.id, "duplicate"))
        .rejects.toThrow("Deployment token ID collision");
      expect(await readFile(filename, "utf8")).toBe(beforeCollision);
    } finally {
      random.mockRestore();
    }
    const full = {
      ...deployment,
      deploy_tokens: Array.from({ length: 5000 }, (_, index) => ({
        id: `token${index}`, name: "ci", created_at: new Date(0).toISOString(),
      })),
    };
    await writeFile(filename, JSON.stringify(full));
    await expect(service.createDeployToken("proj123", deployment.id, "overflow"))
      .rejects.toThrow("Deployment token count exceeds the limit");
    expect(await readFile(filename, "utf8")).toBe(JSON.stringify(full));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("token verification and deletion reject ambiguous inventories without mutating native metadata", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-token-lifecycle-"));
  let locks = 0;
  let coercions = 0;
  const service = new FrontendService(baseDir, async (_ref, _id, operation) => {
    locks++;
    return operation();
  }, noImmutableRelease);
  try {
    const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
    const created = await service.createDeployToken("proj123", deployment.id, "first");
    if (!created) throw new Error("Expected token");
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const original = await readFile(filename, "utf8");
    locks = 0;
    for (const token of [null, false, 123, "", " ", "bad\ntoken", "x".repeat(4097),
      { toString() { coercions++; return created.token; } }]) {
      const result: unknown = Reflect.apply(service.verifyDeployToken, service, ["proj123", deployment.id, token]);
      await expect(result).resolves.toBe(false);
    }
    await expect(service.deleteDeployToken("proj123", deployment.id, "../other"))
      .rejects.toThrow("Invalid deployment token deletion input");
    await expect(service.verifyDeployToken("../other", deployment.id, created.token))
      .rejects.toThrow("Invalid deployment token verification input");
    expect(locks).toBe(0);
    expect(coercions).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(original);
    const stored = await service.getDeployment("proj123", deployment.id);
    const storedToken = stored?.deploy_tokens?.[0];
    if (!stored || !storedToken) throw new Error("Expected stored token");
    const ambiguous = JSON.stringify({ ...stored, deploy_tokens: [storedToken, { ...storedToken }] });
    await writeFile(filename, ambiguous);
    await expect(service.verifyDeployToken("proj123", deployment.id, created.token))
      .rejects.toThrow("Invalid stored deployment token record");
    await expect(service.deleteDeployToken("proj123", deployment.id, created.id))
      .rejects.toThrow("Invalid stored deployment token record");
    await expect(service.createDeployToken("proj123", deployment.id, "new"))
      .rejects.toThrow("Invalid stored deployment token record");
    expect(await readFile(filename, "utf8")).toBe(ambiguous);
    await writeFile(filename, original);
    const second = await service.createDeployToken("proj123", deployment.id, "second");
    if (!second) throw new Error("Expected second token");
    const beforeRejected = await readFile(filename, "utf8");
    expect(await service.verifyDeployToken("proj123", deployment.id, "incorrect")).toBe(false);
    expect(await readFile(filename, "utf8")).toBe(beforeRejected);
    expect(await service.verifyDeployToken("proj123", deployment.id, created.token)).toBe(true);
    const listed = await service.listDeployTokens("proj123", deployment.id);
    expect(listed.find(token => token.id === created.id)?.last_used_at).toBeString();
    expect(listed.find(token => token.id === second.id)?.last_used_at).toBeUndefined();
    expect(await service.deleteDeployToken("proj123", deployment.id, created.id)).toBe(true);
    expect(await service.verifyDeployToken("proj123", deployment.id, created.token)).toBe(false);
    expect(await service.listDeployTokens("proj123", deployment.id)).toMatchObject([{ id: second.id, name: "second" }]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("Git updates reject malformed arguments before locking and reject foreign stored identities", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-git-input-"));
  let locks = 0;
  let coerced = 0;
  let requests = 0;
  const service = new FrontendService(baseDir, async (_ref, _id, work) => {
    locks++;
    return work();
  }, noImmutableRelease);
  try {
    const creator = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
    const deployment = await creator.createDeployment("proj123", { name: "site", framework: "static" });
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const before = await readFile(filename, "utf8");
    const coercible = { toString() { coerced++; return "coerced"; } };
    for (const [url, branch] of [
      [null, "main"], [undefined, "main"], [1, "main"], [coercible, "main"],
      ["https://example.com/a.git", null], ["https://example.com/a.git", coercible],
      ["bad\nurl", "main"], ["bad\u0000url", "main"], [" ", "main"],
      ["https://example.com/a.git", ""], ["https://example.com/a.git", " "],
      ["https://example.com/a.git", "bad\nbranch"], ["x".repeat(16_385), "main"],
      ["https://example.com/a.git", "x".repeat(16_385)],
    ]) {
      const pending: unknown = Reflect.apply(service.setGitConfig, service, ["proj123", deployment.id, url, branch]);
      await expect(pending).rejects.toThrow("Invalid frontend Git configuration");
      await expect(saveHostingConfiguration("proj123", deployment.id, {
        configuration: { build_command: "", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/" },
        git: { url, branch },
      }, async () => { requests++; return Response.json({}); }, new AbortController().signal, "enc:v1:fixture")).rejects.toThrow();
    }
    await expect(service.setGitConfig("../project", deployment.id, "", "main")).rejects.toThrow();
    await expect(service.setGitConfig("proj123", "../deployment", "", "main")).rejects.toThrow();
    const previousRestriction = process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS;
    process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS = "true";
    try {
      for (const url of [
        "git@localhost:org/repo.git", "git@localhost.:org/repo.git",
        "git@127.0.0.1:org/repo.git", "git@169.254.169.254:org/repo.git",
        "git@metadata.google.internal:org/repo.git", "git@10.0.0.1:org/repo.git",
        "https://localhost./repo.git", "ssh://[::1]/repo.git",
        "file:///tmp/repo.git", "ext::unsupported", "--upload-pack=unexpected",
      ]) await expect(service.setGitConfig("proj123", deployment.id, url, "main"))
        .rejects.toThrow("Invalid frontend Git configuration");
      for (const branch of ["--option", "feature..other", "x".repeat(129)]) {
        await expect(service.setGitConfig("proj123", deployment.id, "https://example.com/a.git", branch))
          .rejects.toThrow("Invalid frontend Git configuration");
      }
    } finally {
      if (previousRestriction === undefined) delete process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS;
      else process.env.SUPACLOUD_RESTRICT_GIT_PRIVATE_NETWORKS = previousRestriction;
    }
    expect(locks).toBe(0);
    expect(coerced).toBe(0);
    expect(requests).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(before);
    let writes = 0;
    for (const foreign of [
      { ...deployment, project_ref: "other" }, { ...deployment, id: "other" },
    ]) {
      const domain = new FrontendDomainService({
        deploymentLock: withoutDeploymentLock,
        getDeployment: async () => foreign,
        writeDeployment: async () => { writes++; },
        commitHostMutation: async () => { throw new Error("Unexpected host change"); },
      });
      await expect(domain.setGitConfig("proj123", deployment.id, "https://example.com/a.git", "main"))
        .rejects.toThrow("Invalid deployment identity");
    }
    expect(writes).toBe(0);
    await service.setGitConfig("proj123", deployment.id, "https://example.com/a.git", "main");
    expect((await creator.getDeployment("proj123", deployment.id))?.git_url).toBe("https://example.com/a.git");
    await service.setGitConfig("proj123", deployment.id, "git@example.com:org/repo.git", "feature/site");
    expect((await creator.getDeployment("proj123", deployment.id))?.git_url).toBe("git@example.com:org/repo.git");
    await service.setGitConfig("proj123", deployment.id, "", "main");
    expect((await creator.getDeployment("proj123", deployment.id))?.git_url).toBe("");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("environment updates snapshot before locking and preserve masks and prototype-like names", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-env-capture-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let locks = 0;
  let accessed = 0;
  const service = new FrontendService(baseDir, async (_ref, _id, work) => {
    locks++;
    entered.resolve();
    await release.promise;
    return work();
  }, noImmutableRelease);
  try {
    const creator = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
    const deployment = await creator.createDeployment("proj123", {
      name: "site", framework: "static", env_vars: { TOKEN: "private-marker" },
    });
    const filename = join(baseDir, "proj123", deployment.id, "deployment.json");
    const original = await readFile(filename, "utf8");
    const accessor = Object.defineProperty({}, "KEY", {
      enumerable: true, get() { accessed++; return "private-marker"; },
    });
    for (const input of [
      null, undefined, false, [], { KEY: 123 }, { KEY: "bad\nvalue" }, { PATH: "reserved" },
      Object.create({ KEY: "inherited" }), accessor,
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY${index}`, "value"])),
    ]) {
      const result: unknown = Reflect.apply(service.setEnvVars, service, ["proj123", deployment.id, input]);
      await expect(result).rejects.toThrow();
    }
    expect(locks).toBe(0);
    expect(accessed).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(original);
    const input = Object.fromEntries([
      ["TOKEN", "********"], ["PLAIN", "captured"], ["__proto__", "ordinary-variable"],
    ]);
    const pending = service.setEnvVars("proj123", deployment.id, input);
    await entered.promise;
    input["TOKEN"] = "later-secret";
    input["PLAIN"] = "later";
    input["__proto__"] = "later";
    release.resolve();
    const updated = await pending;
    expect(updated?.env_vars).toMatchObject({ TOKEN: "private-marker", PLAIN: "captured" });
    expect(updated?.env_vars["__proto__"]).toBe("ordinary-variable");
    expect(Object.getPrototypeOf(updated?.env_vars)).toBe(Object.prototype);
    const stored = await creator.getDeployment("proj123", deployment.id);
    expect(stored?.env_vars).toEqual(updated?.env_vars);
    expect(locks).toBe(1);
  } finally {
    release.resolve();
    await rm(baseDir, { recursive: true, force: true });
  }
});

describe("FrontendService DNS records", () => {
  test("uses the normalized base domain for temporary frontend hosts", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-test-"));
    const originalBaseDomain = config.baseDomain;

    try {
      for (const configuredBaseDomain of ["xai.xigu.team", "api.xai.xigu.team"]) {
        config.baseDomain = configuredBaseDomain;
        const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
        const deployment = await service.createDeployment("proj123", {
          name: "site",
          framework: "static",
        });

        expect(deployment.domain).toBe(`${deployment.id}.proj123.xai.xigu.team`);
        expect(deployment.deployment_url).toBe(`https://${deployment.id}.proj123.xai.xigu.team`);
      }
    } finally {
      config.baseDomain = originalBaseDomain;
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("returns managed temporary domain record and expected custom domain records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
        custom_domains: ["www.example.com"],
      });

      const records = await service.listDnsRecords("proj123", deployment.id);

      expect(records).not.toBeNull();
      expect(records?.length).toBe(2);
      expect(records?.[0]).toMatchObject({
        deployment_id: deployment.id,
        project_ref: "proj123",
        hostname: deployment.domain,
        type: "A",
        name: deployment.domain,
        value: config.dockerHostIp,
        status: "managed",
        source: "temporary_domain",
      });
      expect(records?.[1]).toMatchObject({
        deployment_id: deployment.id,
        project_ref: "proj123",
        hostname: "www.example.com",
        type: "CNAME",
        name: "www.example.com",
        value: deployment.domain,
        status: "expected",
        source: "custom_domain",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("uses the configured domain when a legacy deployment has no stored host", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-dns-fallback-test-"));
    const originalBaseDomain = config.baseDomain;

    try {
      config.baseDomain = "api.xai.xigu.team";
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
      });
      await writeFile(
        join(baseDir, "proj123", deployment.id, "deployment.json"),
        JSON.stringify({ ...deployment, domain: "" }),
      );

      const records = await service.listDnsRecords("proj123", deployment.id);

      expect(records?.[0]?.hostname).toBe(`${deployment.id}.proj123.xai.xigu.team`);
    } finally {
      config.baseDomain = originalBaseDomain;
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("returns null when deployment does not exist", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      await expect(service.listDnsRecords("proj123", "missing123")).resolves.toBeNull();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService SvelteKit defaults", () => {
  test("keeps shell-compatible build commands working by default", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-build-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-source-"));
    const previousPolicy = process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
    delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      (service as any).applyGatewayRoute = async () => undefined;
      const deployment = await service.createDeployment("proj123", {
        name: "shell-site",
        framework: "static",
        install_command: "",
        build_command: "mkdir -p dist && printf '<h1>ok</h1>' > dist/index.html",
        output_dir: "dist",
      });

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(true);
      expect(await readFile(join(baseDir, "proj123", deployment.id, "build", "index.html"), "utf8"))
        .toBe("<h1>ok</h1>");
    } finally {
      if (previousPolicy === undefined) delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
      else process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = previousPolicy;
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("supports an explicit restricted build-command policy", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-policy-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-shell-policy-source-"));
    const previousPolicy = process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
    process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = "true";

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", {
        name: "restricted-site",
        framework: "static",
        install_command: "",
        build_command: "printf ok > index.html && printf blocked > blocked.html",
        output_dir: ".",
      });

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("unsupported shell syntax");
    } finally {
      if (previousPolicy === undefined) delete process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS;
      else process.env.SUPACLOUD_RESTRICT_BUILD_COMMANDS = previousPolicy;
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("uses an adapter-node output and a root readiness probe", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-defaults-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-app",
        framework: "sveltekit",
      });

      expect(deployment.output_dir).toBe("build");
      expect(deployment.health_check_path).toBe("/");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("keeps existing build settings when only readiness is updated", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-update-"));
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-app",
        framework: "sveltekit",
      });
      const updated = await service.updateDeployment("proj123", deployment.id, {
        health_check_path: "/ready",
      });

      expect(updated).toMatchObject({
        name: "sveltekit-app",
        build_command: "npm run build",
        output_dir: "build",
        health_check_path: "/ready",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("provides a distinct adapter-static SvelteKit profile", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-static-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "sveltekit-static-app",
        framework: "sveltekit-static",
      });

      expect(deployment.framework).toBe("sveltekit-static");
      expect(deployment.output_dir).toBe("build");
      expect(deployment.build_command).toBe("npm run build");
      expect(FRAMEWORK_DEFAULTS["sveltekit-static"].is_ssr).toBe(false);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("stages adapter-node runtime dependencies and renders a Node service", async () => {
    const deploymentDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-runtime-"));
    const sourceDir = join(deploymentDir, "source");
    const buildDir = join(deploymentDir, "build");

    try {
      await mkdir(join(sourceDir, "node_modules"), { recursive: true });
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(sourceDir, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(sourceDir, "node_modules", "runtime-marker"), "present");
      await writeFile(join(buildDir, "index.js"), "console.log('ready')\n");

      await prepareSvelteKitRuntime(sourceDir, buildDir);

      expect(JSON.parse(await readFile(join(buildDir, "package.json"), "utf8"))).toEqual({
        type: "module",
      });
      expect((await lstat(join(buildDir, "node_modules"))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(buildDir, "node_modules"))).toBe("../source/node_modules");

      const unit = renderSvelteKitSystemdUnit({
        serviceName: "supacloud-frontend-proj123-app123",
        runtimeUser: "supacloud-proj123",
        description: "SvelteKit app",
        buildDir,
        envFile: join(deploymentDir, ".env"),
        port: 30123,
      });
      expect(unit).toContain(`WorkingDirectory=${buildDir}`);
      expect(unit).toContain("User=supacloud-proj123");
      expect(unit).toContain("Group=supacloud-proj123");
      expect(unit).toContain('Environment="PROTOCOL_HEADER=x-forwarded-proto"');
      expect(unit).toContain('Environment="HOST_HEADER=x-forwarded-host"');
      expect(unit).toContain('Environment="PORT_HEADER=x-forwarded-port"');
      expect(unit).toContain(`ExecStart=/usr/bin/env node ${buildDir}/index.js`);
      expect(unit).not.toContain("bun run");
    } finally {
      await rm(deploymentDir, { recursive: true, force: true });
    }
  });

  test("rejects adapter-static output when the SSR profile is selected", async () => {
    const deploymentDir = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-adapter-mismatch-"));
    const sourceDir = join(deploymentDir, "source");
    const buildDir = join(deploymentDir, "build");

    try {
      await mkdir(join(sourceDir, "node_modules"), { recursive: true });
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(sourceDir, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(buildDir, "index.html"), "<!doctype html>");

      await expect(prepareSvelteKitRuntime(sourceDir, buildDir)).rejects.toThrow(
        "use framework=sveltekit-static for adapter-static output",
      );
    } finally {
      await rm(deploymentDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService gateway routing", () => {
  test("registers frontend root route through the gateway provider", async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method || "GET";
      let body: any = null;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    const service = new FrontendService(
      "/tmp/supacloud-frontend-test",
      withoutDeploymentLock,
      noImmutableRelease,
    );
    const deployment: FrontendDeployment = {
      id: "0000002a",
      project_ref: "proj123",
      name: "site",
      framework: "static",
      domain: "site.example.com",
      custom_domains: ["www.example.com"],
      build_command: "",
      output_dir: ".",
      install_command: "",
      node_version: "20",
      env_vars: {},
      status: "pending",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z",
      deployment_url: "https://site.example.com",
    };

    await mkdir(join("/tmp/supacloud-frontend-test", "proj123", deployment.id), { recursive: true });
    await writeFile(
      join("/tmp/supacloud-frontend-test", "proj123", deployment.id, "deployment.json"),
      JSON.stringify(deployment),
    );
    await service.configureGatewayRoute(deployment, "/tmp/build", false);

    const loadCall = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
    const routes = loadCall?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
    const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002a");

    expect(route).toBeDefined();
    expect(route?.match?.[0]?.path).toEqual(["/*"]);
    expect(route?.match?.[0]?.host).toEqual(["site.example.com", "www.example.com"]);
    const subroute = route?.handle?.find((handler: any) => handler.handler === "subroute");
    const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);
    expect(fileServer?.handler).toBe("file_server");
    expect(fileServer?.root).toBe("/tmp/build");
    expect(fileServer?.precompressed_order).toEqual(["br", "zstd", "gzip"]);
  });

  test("reconciles successful static deployments back into Caddy routes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-reconcile-test-"));
    const calls: Array<{ url: string; method: string; body: any }> = [];

    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = init?.method || "GET";
      let body: any = null;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    try {
      const deploymentDir = join(baseDir, "proj123", "0000002c");
      const buildDir = join(deploymentDir, "build");
      await mkdir(buildDir, { recursive: true });
      await writeFile(join(buildDir, "index.html"), "<!doctype html><title>site</title>");
      await writeFile(join(deploymentDir, "deployment.json"), JSON.stringify({
        id: "0000002c",
        project_ref: "proj123",
        name: "site",
        framework: "static",
        domain: "site.example.com",
        custom_domains: ["www.example.com"],
        build_command: "",
        output_dir: ".",
        install_command: "",
        node_version: "20",
        env_vars: {},
        status: "success",
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z",
        deployment_url: "https://site.example.com",
      }));

      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const result = await service.reconcileGatewayRoutes();

      expect(result).toEqual({ total: 1, configured: 1, skipped: 0, errors: [] });

      const loadCall = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
      const routes = loadCall?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
      const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002c");
      const subroute = route?.handle?.find((handler: any) => handler.handler === "subroute");
      const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);

      expect(route?.match?.[0]?.host).toEqual(["site.example.com", "www.example.com"]);
      expect(route?.match?.[0]?.path).toEqual(["/*"]);
      expect(fileServer?.handler).toBe("file_server");
      expect(fileServer?.root).toBe(buildDir);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("re-reads deployment hosts inside the route lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-stale-hosts-"));
    const gatewayCalls: Array<{ method: string; body: any }> = [];
    globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      gatewayCalls.push({ method, body });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    }) as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const stale = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await writeFile(
        join(baseDir, "proj123", stale.id, "deployment.json"),
        JSON.stringify({ ...stale, domain: "current.example.com", custom_domains: ["www.current.example.com"] }),
      );

      await service.configureGatewayRoute(stale, join(baseDir, "build"), false);

      const routes = gatewayCalls.filter((call) => call.method === "POST").at(-1)
        ?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
      const route = routes.find((candidate: any) => candidate["@id"] === `route-frontend-proj123-${stale.id}`);
      expect(route?.match?.[0]?.host).toEqual(["current.example.com", "www.current.example.com"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService deployment serialization", () => {
  test("keeps the complete legacy SSR deployment inside the deployment lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-ssr-lock-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-ssr-source-"));
    const firstEntered = barrier();
    const releaseFirst = barrier();
    const operationContext = new AsyncLocalStorage<boolean>();
    let tail = Promise.resolve();
    let secondEntered = false;
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (operationContext.getStore()) return operation();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operationContext.run(true, operation);
      } finally {
        release();
      }
    };

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", {
        name: "ssr-site",
        framework: "nextjs",
        install_command: "",
        build_command: "",
      });
      // createDeployment applies framework defaults for empty commands; this
      // test exercises the full deployment flow, so store explicit empty commands.
      await writeFile(
        join(baseDir, "proj123", deployment.id, "deployment.json"),
        JSON.stringify({ ...deployment, install_command: "", build_command: "" }, null, 2),
      );
      await mkdir(join(sourceDir, ".next"));
      await writeFile(join(sourceDir, ".next", "index.js"), "console.log('ready')\n");
      const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);
      // Barrier in the build phase: only the outer deployFromSource lock keeps
      // the second operation out here; publish-time locks are re-entrant.
      const prepareOriginal = (service as any).prepareLegacySsrBuild.bind(service);
      (service as any).prepareLegacySsrBuild = async (...args: any[]) => {
        firstEntered.release();
        await releaseFirst.wait;
        return prepareOriginal(...args);
      };
      (service as any).startProcess = async () => 30001;
      (service as any).waitForReadiness = async () => true;
      (service as any).applyGatewayRoute = async () => undefined;
      (service as any).stopProcess = async () => undefined;
      (service as any).removeGatewayRoute = async () => undefined;
      const first = service.deployFromSource("proj123", deployment.id, sourceDir);
      await firstEntered.wait;
      let secondStarted = false;
      const second = Promise.resolve().then(async () => {
        secondStarted = true;
        return service.deleteDeployment("proj123", deployment.id);
      }).then((outcome) => {
        secondEntered = true;
        return outcome;
      });
      while (!secondStarted) await Promise.resolve();
      expect(secondEntered).toBe(false);
      releaseFirst.release();
      expect((await first).success).toBe(true);
      expect(await second).toBe("deleted");
      expect(secondEntered).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("keeps the complete legacy static deployment inside the deployment lock", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-lock-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-source-"));
    const firstEntered = barrier();
    const releaseFirst = barrier();
    const operationContext = new AsyncLocalStorage<boolean>();
    let tail = Promise.resolve();
    let secondEntered = false;
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (operationContext.getStore()) return operation();
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operationContext.run(true, operation);
      } finally {
        release();
      }
    };

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", {
        name: "static-site",
        framework: "static",
        install_command: "",
        build_command: "",
      });
      await writeFile(join(sourceDir, "index.html"), "<!doctype html>");
      const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);
      // Barrier in the build phase: only the outer deployFromSource lock keeps
      // the second operation out here; publish-time locks are re-entrant.
      const prepareOriginal = (service as any).prepareLegacyBuild.bind(service);
      (service as any).prepareLegacyBuild = async (...args: any[]) => {
        firstEntered.release();
        await releaseFirst.wait;
        return prepareOriginal(...args);
      };
      (service as any).applyGatewayRoute = async () => undefined;
      (service as any).stopProcess = async () => undefined;
      (service as any).removeGatewayRoute = async () => undefined;
      const first = service.deployFromSource("proj123", deployment.id, sourceDir);
      await firstEntered.wait;
      let secondStarted = false;
      const second = Promise.resolve().then(async () => {
        secondStarted = true;
        return service.deleteDeployment("proj123", deployment.id);
      }).then((outcome) => {
        secondEntered = true;
        return outcome;
      });
      while (!secondStarted) await Promise.resolve();
      expect(secondEntered).toBe(false);
      releaseFirst.release();
      expect((await first).success).toBe(true);
      expect(await second).toBe("deleted");
      expect(secondEntered).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("holds the deployment lock for every metadata read-modify-write", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-rmw-lock-"));
    const lockCalls: string[] = [];
    const trackedLock = async <T>(projectRef: string, deploymentId: string, operation: () => Promise<T>) => {
      lockCalls.push(`${projectRef}/${deploymentId}`);
      return operation();
    };
    const service = new FrontendService(baseDir, trackedLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await service.updateDeployment("proj123", deployment.id, { name: "renamed" });
      await service.setEnvVars("proj123", deployment.id, { FEATURE_FLAG: "enabled" });
      const deployToken = await service.createDeployToken("proj123", deployment.id, "ci");
      expect(deployToken).not.toBeNull();
      expect(await service.verifyDeployToken("proj123", deployment.id, deployToken!.token)).toBe(true);
      await service.setGitConfig("proj123", deployment.id, "https://git.example.com/org/repo.git", "main");
      expect(await service.deleteDeployToken("proj123", deployment.id, deployToken!.id)).toBe(true);

      expect(lockCalls).toEqual(Array(6).fill(`proj123/${deployment.id}`));
      const afterDeletion = await service.getDeployment("proj123", deployment.id);
      expect(await service.deleteDeployToken("proj123", deployment.id, deployToken!.id)).toBe(false);
      expect(await service.getDeployment("proj123", deployment.id)).toEqual(afterDeletion);
      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        name: "renamed",
        env_vars: { FEATURE_FLAG: "enabled" },
        git_url: "https://git.example.com/org/repo.git",
        git_branch: "main",
        deploy_tokens: [],
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("preserves private Git credentials when the UI saves a redacted repository URL", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-git-redaction-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await service.setGitConfig(
        "proj123",
        deployment.id,
        "https://build-user:build-secret@git.example.com/org/repo.git",
        "main",
      );
      await service.setGitConfig(
        "proj123",
        deployment.id,
        "https://git.example.com/org/repo.git",
        "main",
      );

      expect((await service.getDeployment("proj123", deployment.id))?.git_url)
        .toBe("https://build-user:build-secret@git.example.com/org/repo.git");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("does not overwrite an environment secret when the masked value is submitted back", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-env-mask-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", {
        name: "site",
        framework: "static",
        env_vars: { VITE_API_TOKEN: "real-secret-value" },
      });
      await service.setEnvVars("proj123", deployment.id, {
        VITE_API_TOKEN: "********",
        FEATURE_FLAG: "enabled",
      });

      expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({
        VITE_API_TOKEN: "real-secret-value",
        FEATURE_FLAG: "enabled",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("preserves concurrent env and git metadata updates", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-rmw-race-"));
    let tail = Promise.resolve();
    const serializedLock = async <T>(
      _projectRef: string,
      _deploymentId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const service = new FrontendService(baseDir, serializedLock, noImmutableRelease);

    try {
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await Promise.all([
        service.setEnvVars("proj123", deployment.id, { FEATURE_FLAG: "enabled" }),
        service.setGitConfig("proj123", deployment.id, "https://git.example.com/org/repo.git", "stable"),
      ]);

      expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
        env_vars: { FEATURE_FLAG: "enabled" },
        git_url: "https://git.example.com/org/repo.git",
        git_branch: "stable",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("rejects immutable domain mutations before changing metadata or gateway state", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-block-"));
    const gatewayRequest = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));
    globalThis.fetch = gatewayRequest as unknown as typeof fetch;
    const activeRelease = async () => ({
      activeBuildDir: async () => join(baseDir, "immutable"),
      hasActiveRelease: async () => true,
      hasUnresolvedActivation: async () => false,
    });

    try {
      const setup = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await setup.createDeployment("proj123", { name: "site", framework: "static" });
      const service = new FrontendService(baseDir, withoutDeploymentLock, activeRelease);

      await expect(service.addCustomDomain("proj123", deployment.id, "blocked.example.com"))
        .rejects.toMatchObject({ code: "FRONTEND_RELEASE_ACTIVE", statusCode: 409 });
      expect((await service.getDeployment("proj123", deployment.id))?.custom_domains).toEqual([]);
      expect(gatewayRequest).not.toHaveBeenCalled();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("does not commit custom-domain metadata when gateway publication fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-domain-gateway-failure-"));
    globalThis.fetch = mock(() => Promise.resolve(
      new Response("gateway rejected", { status: 500 }),
    )) as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });

      await expect(service.addCustomDomain("proj123", deployment.id, "uncommitted.example.com"))
        .rejects.toThrow();
      expect((await service.getDeployment("proj123", deployment.id))?.custom_domains).toEqual([]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("checks immutable authority again before publishing a prepared static build", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-cas-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-static-source-"));
    let activeChecks = 0;
    const changingReleaseState = async () => ({
      activeBuildDir: async () => null,
      hasActiveRelease: async () => ++activeChecks > 1,
      hasUnresolvedActivation: async () => false,
    });
    const gatewayRequest = mock(() => Promise.resolve(new Response(JSON.stringify({ data: [] }))));
    globalThis.fetch = gatewayRequest as unknown as typeof fetch;

    try {
      const service = new FrontendService(baseDir, withoutDeploymentLock, changingReleaseState);
      const deployment = await service.createDeployment("proj123", { name: "site", framework: "static" });
      await writeFile(join(sourceDir, "index.html"), "prepared but not published");

      const result = await service.deployFromSource("proj123", deployment.id, sourceDir);

      expect(result.success).toBe(false);
      expect(result.error).toContain("active or unresolved");
      await expect(access(join(baseDir, "proj123", deployment.id, "build", "index.html"))).rejects.toThrow();
      expect(gatewayRequest).not.toHaveBeenCalled();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("FrontendService optimizer", () => {
  test("generates br and gzip sidecars for static text assets", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-optimizer-test-"));
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);
    const assetPath = join(baseDir, "app.js");

    try {
      await writeFile(assetPath, "console.log('supacloud');\n".repeat(128));
      await (service as any).precompressStaticAssets(baseDir);

      await access(`${assetPath}.br`);
      await access(`${assetPath}.gz`);
      if ((await Bun.spawn(["which", "zstd"]).exited) === 0) {
        await access(`${assetPath}.zst`);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("generates image variant sidecars when optimizer tools are available", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "supacloud-frontend-image-optimizer-test-"));
    const binDir = join(baseDir, "bin");
    const imagePath = join(baseDir, "hero.jpg");
    const originalPath = process.env.PATH || "";
    const service = new FrontendService(baseDir, withoutDeploymentLock, noImmutableRelease);

    try {
      await mkdir(binDir);
      await writeFile(join(binDir, "cwebp"), "#!/bin/sh\ncp \"$4\" \"$6\"\n");
      await writeFile(join(binDir, "avifenc"), "#!/bin/sh\ncp \"$8\" \"$9\"\n");
      await chmod(join(binDir, "cwebp"), 0o755);
      await chmod(join(binDir, "avifenc"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;

      await writeFile(imagePath, Buffer.alloc(2048, 1));
      await (service as any).precompressStaticAssets(baseDir);

      await access(`${imagePath}.webp`);
      await access(`${imagePath}.avif`);
    } finally {
      process.env.PATH = originalPath;
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

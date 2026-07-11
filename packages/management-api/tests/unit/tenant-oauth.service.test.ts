import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TenantOAuthService } from "../../src/services/tenant-oauth.service";
import { renderSystemdEnvLine } from "../../src/services/tenant-runtime-config";
import type { OAuthProvider, OAuthProviderConfig } from "../../src/types/oauth";

const temporaryRoots: string[] = [];
const BASE_ENV = [
  'GOTRUE_OPERATOR_TOKEN="original-operator-token"',
  'GOTRUE_EXTERNAL_GOOGLE_ENABLED=true',
  'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID="old-client"',
  'GOTRUE_EXTERNAL_GOOGLE_SECRET="old-secret"',
  'GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI="https://old.example/callback"',
].join("\n");

async function createHarness(ref = "abc123") {
  const root = await mkdtemp(join(tmpdir(), "supacloud-tenant-oauth-"));
  temporaryRoots.push(root);
  const tenantConfigDir = join(root, "tenants");
  const runtimeDir = join(tenantConfigDir, `${ref}_gotrue.d`);
  const runtimeEnv = join(runtimeDir, "runtime.env");
  const legacyEnv = join(tenantConfigDir, `${ref}_gotrue.env`);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(runtimeEnv, `${BASE_ENV}\n`, { mode: 0o600 });
  await writeFile(legacyEnv, `${BASE_ENV}\n`, { mode: 0o600 });

  const ownership: Array<{ path: string; user: string }> = [];
  const reloads: Array<{ ref: string; message: string }> = [];
  const service = new TenantOAuthService({
    tenantConfigDir,
    chownPath: async (targetPath, runtimeUser) => {
      ownership.push({ path: targetPath, user: runtimeUser });
    },
    reloadAndPoll: async (projectRef, message) => {
      reloads.push({ ref: projectRef, message });
    },
  });

  return { service, tenantConfigDir, runtimeDir, runtimeEnv, legacyEnv, ownership, reloads, ref };
}

async function expectNoTemporaryFiles(...directories: string[]) {
  for (const directory of directories) {
    const entries = await readdir(directory);
    expect(entries.some((entry) => /\.(?:tmp|stage|backup)\b/.test(entry))).toBe(false);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TenantOAuthService secure EnvironmentFile updates", () => {
  test("serializes standard OAuth values and atomically keeps both 0600 env files tenant-owned", async () => {
    const harness = await createHarness();
    const special = `value @:/#?% = space '\"\\`;

    await harness.service.updateOAuthConfig(harness.ref, "google", {
      provider: "google",
      client_id: special,
      client_secret: special,
      redirect_uri: `https://example.com/callback?state=${special}`,
    });

    const runtimeContent = await readFile(harness.runtimeEnv, "utf8");
    const legacyContent = await readFile(harness.legacyEnv, "utf8");
    expect(runtimeContent).toBe(legacyContent);
    expect(runtimeContent).toContain(renderSystemdEnvLine("GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID", special));
    expect(runtimeContent).toContain(renderSystemdEnvLine("GOTRUE_EXTERNAL_GOOGLE_SECRET", special));
    expect(runtimeContent).toContain(renderSystemdEnvLine(
      "GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI",
      `https://example.com/callback?state=${special}`,
    ));
    expect(runtimeContent).toContain('GOTRUE_OPERATOR_TOKEN="original-operator-token"');
    expect((await stat(harness.runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(harness.runtimeEnv)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.legacyEnv)).mode & 0o777).toBe(0o600);
    expect(harness.ownership.every((entry) => entry.user === "supacloud-abc123")).toBe(true);
    expect(harness.ownership.some((entry) => entry.path === harness.runtimeDir)).toBe(true);
    expect(harness.ownership.some((entry) => dirname(entry.path) === harness.runtimeDir && entry.path.endsWith(".stage"))).toBe(true);
    expect(harness.ownership.some((entry) => dirname(entry.path) === harness.tenantConfigDir && entry.path.endsWith(".stage"))).toBe(true);
    expect(harness.reloads).toHaveLength(1);
    await expectNoTemporaryFiles(harness.runtimeDir, harness.tenantConfigDir);
  });

  test("rejects CR, LF, and NUL in every standard OAuth value before operator-token injection or writes", async () => {
    const cases: Array<{
      provider: OAuthProvider;
      patch: Partial<OAuthProviderConfig>;
    }> = [
      { provider: "google", patch: { client_id: "safe\nGOTRUE_OPERATOR_TOKEN=stolen" } },
      { provider: "google", patch: { client_secret: "safe\rGOTRUE_OPERATOR_TOKEN=stolen" } },
      { provider: "google", patch: { redirect_uri: "safe\0GOTRUE_OPERATOR_TOKEN=stolen" } },
      { provider: "keycloak", patch: { url: "safe\nGOTRUE_OPERATOR_TOKEN=stolen" } },
    ];

    for (const scenario of cases) {
      const harness = await createHarness();
      const providerConfig: OAuthProviderConfig = {
        provider: scenario.provider,
        client_id: "safe-client",
        client_secret: "safe-secret",
        ...scenario.patch,
      };
      await expect(harness.service.updateOAuthConfig(harness.ref, scenario.provider, providerConfig))
        .rejects.toThrow(/control character/i);
      expect(await readFile(harness.runtimeEnv, "utf8")).toBe(`${BASE_ENV}\n`);
      expect(await readFile(harness.legacyEnv, "utf8")).toBe(`${BASE_ENV}\n`);
      expect(harness.reloads).toHaveLength(0);
    }
  });

  test("serializes every custom OAuth value and restricts the provider name to an env-key fragment", async () => {
    const harness = await createHarness();
    const special = `custom @:/#?% = space '\"\\`;

    await harness.service.updateGoTrueCustomOAuth(harness.ref, {
      name: "my_provider",
      client_id: special,
      client_secret: special,
      redirect_uri: `https://example.com/callback?value=${special}`,
      authorize_url: `https://example.com/authorize?value=${special}`,
      token_url: `https://example.com/token?value=${special}`,
      user_url: `https://example.com/user?value=${special}`,
      auth_scheme: special,
    });

    const content = await readFile(harness.runtimeEnv, "utf8");
    expect(content).toBe(await readFile(harness.legacyEnv, "utf8"));
    for (const [key, value] of [
      ["GOTRUE_EXTERNAL_MY_PROVIDER_CLIENT_ID", special],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_SECRET", special],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_REDIRECT_URI", `https://example.com/callback?value=${special}`],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_URL", `https://example.com/authorize?value=${special}`],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_TOKEN_URL", `https://example.com/token?value=${special}`],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_USER_INFO_URL", `https://example.com/user?value=${special}`],
      ["GOTRUE_EXTERNAL_MY_PROVIDER_AUTH_SCHEME", special],
    ] as const) {
      expect(content).toContain(renderSystemdEnvLine(key, value));
    }

    for (const name of ["bad-name", "_bad", "bad name", "bad\nGOTRUE_OPERATOR_TOKEN", "a".repeat(33)]) {
      const rejected = await createHarness();
      await expect(rejected.service.updateGoTrueCustomOAuth(rejected.ref, {
        name,
        client_id: "client",
        client_secret: "secret",
        redirect_uri: "https://example.com/callback",
        authorize_url: "https://example.com/authorize",
        token_url: "https://example.com/token",
        user_url: "https://example.com/user",
      })).rejects.toThrow(/provider name|environment variable/i);
      expect(await readFile(rejected.runtimeEnv, "utf8")).toBe(`${BASE_ENV}\n`);
    }
  });

  test("rejects injection through every custom OAuth field", async () => {
    const fields = [
      "client_id",
      "client_secret",
      "redirect_uri",
      "authorize_url",
      "token_url",
      "user_url",
      "auth_scheme",
    ] as const;

    for (const field of fields) {
      const harness = await createHarness();
      const customConfig = {
        name: "safe_provider",
        client_id: "client",
        client_secret: "secret",
        redirect_uri: "https://example.com/callback",
        authorize_url: "https://example.com/authorize",
        token_url: "https://example.com/token",
        user_url: "https://example.com/user",
        auth_scheme: "bearer",
      };
      customConfig[field] = "safe\nGOTRUE_OPERATOR_TOKEN=stolen";
      await expect(harness.service.updateGoTrueCustomOAuth(harness.ref, customConfig))
        .rejects.toThrow(/control character/i);
      expect(await readFile(harness.runtimeEnv, "utf8")).toBe(`${BASE_ENV}\n`);
      expect(await readFile(harness.legacyEnv, "utf8")).toBe(`${BASE_ENV}\n`);
      expect(harness.reloads).toHaveLength(0);
    }
  });

  test("rejects project refs that could escape the tenant directory or username boundary", async () => {
    const harness = await createHarness();
    await expect(harness.service.updateOAuthConfig("../escape", "google", {
      provider: "google",
      client_id: "client",
      client_secret: "secret",
    })).rejects.toThrow(/project ref/i);
    expect(await readFile(harness.runtimeEnv, "utf8")).toBe(`${BASE_ENV}\n`);
    expect(harness.reloads).toHaveLength(0);
  });

  test("cleans staged files and leaves both configs unchanged when ownership staging fails", async () => {
    const harness = await createHarness();
    const failingService = new TenantOAuthService({
      tenantConfigDir: harness.tenantConfigDir,
      chownPath: async (targetPath) => {
        if (dirname(targetPath) === harness.tenantConfigDir && targetPath.endsWith(".stage")) {
          throw new Error("simulated legacy ownership failure");
        }
      },
      reloadAndPoll: async () => {},
    });

    await expect(failingService.updateOAuthConfig(harness.ref, "google", {
      provider: "google",
      client_id: "new-client",
      client_secret: "new-secret",
    })).rejects.toThrow(/ownership failure/i);
    expect(await readFile(harness.runtimeEnv, "utf8")).toBe(`${BASE_ENV}\n`);
    expect(await readFile(harness.legacyEnv, "utf8")).toBe(`${BASE_ENV}\n`);
    await expectNoTemporaryFiles(harness.runtimeDir, harness.tenantConfigDir);
  });

  test("restores both old files and modes when the second target replacement fails, repeatedly", async () => {
    const harness = await createHarness();
    const oldRuntimeContent = 'RUNTIME_OLD="runtime-value"\n';
    const oldLegacyContent = 'LEGACY_OLD="legacy-value"\n';
    await writeFile(harness.runtimeEnv, oldRuntimeContent);
    await writeFile(harness.legacyEnv, oldLegacyContent);
    await chmod(harness.runtimeEnv, 0o640);
    await chmod(harness.legacyEnv, 0o620);

    let failNextLegacyCommit = true;
    const failingService = new TenantOAuthService({
      tenantConfigDir: harness.tenantConfigDir,
      chownPath: async () => {},
      renamePath: async (sourcePath, targetPath) => {
        if (
          failNextLegacyCommit
          && targetPath === harness.legacyEnv
          && sourcePath.endsWith(".stage")
        ) {
          failNextLegacyCommit = false;
          throw new Error("simulated second target replacement failure");
        }
        await rename(sourcePath, targetPath);
      },
      reloadAndPoll: async () => {},
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      failNextLegacyCommit = true;
      await expect(failingService.updateOAuthConfig(harness.ref, "google", {
        provider: "google",
        client_id: `new-client-${attempt}`,
        client_secret: `new-secret-${attempt}`,
      })).rejects.toThrow(/second target replacement failure/i);
      expect(await readFile(harness.runtimeEnv, "utf8")).toBe(oldRuntimeContent);
      expect(await readFile(harness.legacyEnv, "utf8")).toBe(oldLegacyContent);
      expect((await stat(harness.runtimeEnv)).mode & 0o777).toBe(0o640);
      expect((await stat(harness.legacyEnv)).mode & 0o777).toBe(0o620);
      await expectNoTemporaryFiles(harness.runtimeDir, harness.tenantConfigDir);
    }
  });

  test("restores both old files and modes when target chmod fails", async () => {
    const harness = await createHarness();
    const oldRuntimeContent = 'RUNTIME_OLD="runtime-value"\n';
    const oldLegacyContent = 'LEGACY_OLD="legacy-value"\n';
    await writeFile(harness.runtimeEnv, oldRuntimeContent);
    await writeFile(harness.legacyEnv, oldLegacyContent);
    await chmod(harness.runtimeEnv, 0o640);
    await chmod(harness.legacyEnv, 0o620);

    let failLegacyChmod = true;
    const failingService = new TenantOAuthService({
      tenantConfigDir: harness.tenantConfigDir,
      chownPath: async () => {},
      chmodPath: async (targetPath, mode) => {
        if (failLegacyChmod && targetPath === harness.legacyEnv) {
          failLegacyChmod = false;
          throw new Error("simulated legacy chmod failure");
        }
        await chmod(targetPath, mode);
      },
      reloadAndPoll: async () => {},
    });

    await expect(failingService.updateOAuthConfig(harness.ref, "google", {
      provider: "google",
      client_id: "new-client",
      client_secret: "new-secret",
    })).rejects.toThrow(/legacy chmod failure/i);
    expect(await readFile(harness.runtimeEnv, "utf8")).toBe(oldRuntimeContent);
    expect(await readFile(harness.legacyEnv, "utf8")).toBe(oldLegacyContent);
    expect((await stat(harness.runtimeEnv)).mode & 0o777).toBe(0o640);
    expect((await stat(harness.legacyEnv)).mode & 0o777).toBe(0o620);
    await expectNoTemporaryFiles(harness.runtimeDir, harness.tenantConfigDir);
  });
});

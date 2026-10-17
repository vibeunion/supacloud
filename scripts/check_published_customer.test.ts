import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstalledPackagePath, assertPublishedPackageManifest, assertRegistryManifest, exactPublishedVersion, publishedConsumerEnvironment, writePrivateAcceptanceFile } from "./check_published_customer";

test("published acceptance requires an immutable registry version", () => {
  expect(exactPublishedVersion("0.99.0")).toBe("0.99.0");
  for (const version of ["latest", "^0.99.0", "file:../cli", "../cli", "", undefined]) {
    expect(() => exactPublishedVersion(version)).toThrow("exact published version");
  }
});
test("published package evidence requires the expected package identity and exact version", () => {
  expect(assertPublishedPackageManifest({ name: "@supacloud/lite", version: "0.29.5" }, "@supacloud/lite", "0.29.5"))
    .toBe("0.29.5");
  expect(() => assertPublishedPackageManifest({ name: "@supacloud/compiler", version: "latest" }, "@supacloud/compiler"))
    .toThrow("exact");
  expect(() => assertPublishedPackageManifest({ name: "@supacloud/app", version: "0.1.0" }, "@supacloud/lite"))
    .toThrow("name");
  expect(() => assertPublishedPackageManifest({ name: "@supacloud/lite", version: "0.29.4" }, "@supacloud/lite", "0.29.5"))
    .toThrow("match");
  for (const version of [undefined, 29, "", "^0.29.5", "workspace:*"]) {
    expect(() => assertPublishedPackageManifest({ name: "@supacloud/lite", version }, "@supacloud/lite"))
      .toThrow();
  }
  for (const manifest of [null, [], {}, { version: "0.29.5" }]) {
    expect(() => assertPublishedPackageManifest(manifest, "@supacloud/lite")).toThrow();
  }
});
test("consumer verification cannot fall back to workspace, tarballs or URLs", () => {
  assertRegistryManifest({ dependencies: { "@supacloud/app": "^0.1.0" } });
  for (const version of ["file:../app", "workspace:*", "link:../app", "https://host/package.tgz", "github:owner/repo"]) {
    expect(() => assertRegistryManifest({ overrides: { "@supacloud/app": version } })).toThrow();
  }
  expect(() => assertRegistryManifest({ overrides: { nested: { package: "1.0.0" } } })).toThrow();
});

test("consumer package checks accept canonical install aliases but reject external package links", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-installed-path-"));
  try {
    const nodeModules = join(root, "node_modules");
    const packageRoot = join(nodeModules, "@supacloud", "compiler");
    await mkdir(packageRoot, { recursive: true });
    const entry = join(packageRoot, "index.js");
    await writeFile(entry, "export {};\n");
    await expect(assertInstalledPackagePath(await realpath(entry), nodeModules, "CLI compiler"))
      .resolves.toBeUndefined();
    const alias = join(root, "aliased_modules");
    await symlink(nodeModules, alias, "junction");
    await expect(assertInstalledPackagePath(entry, alias, "CLI compiler"))
      .resolves.toBeUndefined();
    await expect(assertInstalledPackagePath(join(alias, "@supacloud", "compiler", "index.js"), nodeModules, "CLI compiler"))
      .resolves.toBeUndefined();
    await symlink(packageRoot, join(nodeModules, "internal"), "junction");
    await expect(assertInstalledPackagePath(join(nodeModules, "internal", "index.js"), nodeModules, "CLI compiler"))
      .resolves.toBeUndefined();
    const external = join(root, "node_modules-external");
    await mkdir(external);
    await writeFile(join(external, "index.js"), "export {};\n");
    await symlink(external, join(nodeModules, "escaped"), "junction");
    await expect(assertInstalledPackagePath(join(nodeModules, "escaped", "index.js"), nodeModules, "CLI compiler"))
      .rejects.toThrow("must be an installed package");
    await expect(assertInstalledPackagePath(join(external, "index.js"), nodeModules, "CLI compiler"))
      .rejects.toThrow("must be an installed package");
    await expect(assertInstalledPackagePath(root, nodeModules, "CLI compiler"))
      .rejects.toThrow("must be an installed package");
    await expect(assertInstalledPackagePath(nodeModules, nodeModules, "CLI compiler"))
      .rejects.toThrow("must be an installed package");
    await expect(assertInstalledPackagePath(join(packageRoot, "missing.js"), nodeModules, "CLI compiler"))
      .rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consumer subprocesses preserve proxy trust settings but not application credentials or TLS bypasses", () => {
  expect(publishedConsumerEnvironment({
    PATH: "/test/bin", HTTPS_PROXY: "http://proxy.example.test:8080", no_proxy: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/test/ca.pem", SSL_CERT_FILE: "/test/ca.pem",
    DATABASE_URL: "not-forwarded", SUPACLOUD_TOKEN: "not-forwarded", NPM_TOKEN: "not-forwarded",
    NODE_TLS_REJECT_UNAUTHORIZED: "0", BUN_CONFIG_SKIP_INSTALL_CHECK: "1",
    HOME: "/developer/home", USERPROFILE: "/developer/home", XDG_CONFIG_HOME: "/developer/config",
    BUN_INSTALL_CACHE_DIR: "/developer/cache",
  }, "/test/isolated-home")).toEqual({
    PATH: "/test/bin", HTTPS_PROXY: "http://proxy.example.test:8080", no_proxy: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/test/ca.pem", SSL_CERT_FILE: "/test/ca.pem",
    HOME: "/test/isolated-home", USERPROFILE: "/test/isolated-home",
  });
});

test("consumer subprocesses cannot discover the developer home configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-isolated-home-"));
  const sourceHome = join(root, "developer"), home = join(root, "consumer");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(sourceHome);
    await mkdir(home);
    await writeFile(join(sourceHome, ".npmrc"), "developer-config-marker");
    const running = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
      import { homedir } from "node:os";
      import { existsSync } from "node:fs";
      import { join } from "node:path";
      console.log(JSON.stringify({ home: homedir(), config: existsSync(join(homedir(), ".npmrc")) }));
    `], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: publishedConsumerEnvironment({ PATH: process.env["PATH"], HOME: sourceHome, USERPROFILE: sourceHome }, home),
    });
    child = running;
    const timer = setTimeout(() => running.kill(), 5_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        running.exited, new Response(running.stdout).text(), new Response(running.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ home, config: false });
      expect(await readFile(join(sourceHome, ".npmrc"), "utf8")).toBe("developer-config-marker");
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("rerun diagnostics replace permissive files with private atomic output", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-privacy-"));
  try {
    const file = join(root, "report.diagnostic.txt");
    await writeFile(file, "old");
    await chmod(file, 0o644);
    await writePrivateAcceptanceFile(file, "private diagnostic");
    expect(await readFile(file, "utf8")).toBe("private diagnostic");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["report.diagnostic.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("private reports replace destination symlinks without overwriting their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-symlink-"));
  try {
    const target = join(root, "unrelated.txt"), file = join(root, "report.json");
    await writeFile(target, "unchanged");
    await symlink(target, file);
    await writePrivateAcceptanceFile(file, "private report");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(await readFile(file, "utf8")).toBe("private report");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).sort()).toEqual(["report.json", "unrelated.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

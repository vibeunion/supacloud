import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRegistryManifest, exactPublishedVersion, publishedConsumerEnvironment, writePrivateAcceptanceFile } from "./check_published_customer";

test("published acceptance requires an immutable registry version", () => {
  expect(exactPublishedVersion("0.99.0")).toBe("0.99.0");
  for (const version of ["latest", "^0.99.0", "file:../cli", "../cli", "", undefined]) {
    expect(() => exactPublishedVersion(version)).toThrow("exact published version");
  }
});
test("consumer verification cannot fall back to workspace, tarballs or URLs", () => {
  assertRegistryManifest({ dependencies: { "@supacloud/app": "^0.1.0" } });
  for (const version of ["file:../app", "workspace:*", "link:../app", "https://host/package.tgz", "github:owner/repo"]) {
    expect(() => assertRegistryManifest({ overrides: { "@supacloud/app": version } })).toThrow();
  }
  expect(() => assertRegistryManifest({ overrides: { nested: { package: "1.0.0" } } })).toThrow();
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
    child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
      import { homedir } from "node:os";
      import { existsSync } from "node:fs";
      import { join } from "node:path";
      console.log(JSON.stringify({ home: homedir(), config: existsSync(join(homedir(), ".npmrc")) }));
    `], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: publishedConsumerEnvironment({ PATH: process.env["PATH"], HOME: sourceHome, USERPROFILE: sourceHome }, home),
    });
    const timer = setTimeout(() => child?.kill(), 5_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
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

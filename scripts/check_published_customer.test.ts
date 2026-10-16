import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  })).toEqual({
    PATH: "/test/bin", HTTPS_PROXY: "http://proxy.example.test:8080", no_proxy: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/test/ca.pem", SSL_CERT_FILE: "/test/ca.pem",
  });
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

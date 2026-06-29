import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime companion version assets", () => {
  test("installer downloads the current GoTrue release asset names", () => {
    const installer = readRepoFile("install.sh");

    expect(installer).toContain('GOTRUE_VERSION="${GOTRUE_VERSION:-v2.191.0}"');
    expect(installer).toContain('x86_64) GOTRUE_ARCH="amd64"');
    expect(installer).toContain('aarch64) GOTRUE_ARCH="arm64"');
    expect(installer).toContain('local GOTRUE_EXT="tar.xz"');
    expect(installer).toContain(
      'auth-${GOTRUE_VERSION}-${GOTRUE_ARCH}.${GOTRUE_EXT}',
    );
    expect(installer).not.toContain("auth-${GOTRUE_VERSION}-${GOTRUE_ARCH}.tar.gz");
    expect(installer).not.toContain('GOTRUE_ARCH="linux-amd64"');
  });

  test("tenant runtime installs the current PostgREST and GoTrue releases", () => {
    const runtime = readRepoFile("scripts/lib/tenant_runtime.sh");

    expect(runtime).toContain('local version="${POSTGREST_VERSION:-v14.13}"');
    expect(runtime).toContain('x86_64) arch="linux-static-x86-64"');
    expect(runtime).toContain('aarch64) arch="ubuntu-aarch64"');
    expect(runtime).toContain("postgrest-${version}-${arch}.tar.xz");

    expect(runtime).toContain('local version="${GOTRUE_VERSION:-v2.191.0}"');
    expect(runtime).toContain('x86_64) arch="amd64"');
    expect(runtime).toContain('aarch64) arch="arm64"');
    expect(runtime).toContain('local archive_ext="tar.xz"');
    expect(runtime).toContain("auth-${version}-${arch}.${archive_ext}");

    expect(runtime).not.toContain('local version="v12.2.3"');
    expect(runtime).not.toContain('local version="v2.189.0"');
    expect(runtime).not.toContain("linux-static-x64");
  });
});

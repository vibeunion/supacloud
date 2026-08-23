import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUN_VERSION = "1.4.0";
const repoRoot = join(import.meta.dir, "../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const packageDirectories = [
  "admin",
  "cli",
  "edge-runtime",
  "management-api",
  "pgredis-runtime",
  "supacloud-js",
  "supacloud-lite",
  "supacloud",
] as const;

const runtimeDockerfiles = [
  "docker/self-host/edge-runtime.Dockerfile",
  "docker/self-host/management-api.Dockerfile",
  "docker/self-host/pgredis-runtime.Dockerfile",
  "packages/edge-runtime/Dockerfile",
  "packages/management-api/Dockerfile",
  "packages/pgredis-runtime/Dockerfile",
] as const;

describe("Bun runtime version assets", () => {
  test("pins installation, CI, release, and container builds to the supported runtime", () => {
    const installer = readRepoFile("install.sh");
    expect(installer).toContain(`BUN_VERSION="\${BUN_VERSION:-${BUN_VERSION}}"`);
    expect(installer).not.toContain("1.3.14");

    for (const workflowPath of [
      ".github/workflows/management-api.yml",
      ".github/workflows/release-please.yml",
    ]) {
      const workflow = readRepoFile(workflowPath);
      expect(workflow).toContain(`BUN_VERSION: "${BUN_VERSION}"`);
      expect(workflow).not.toContain("bun-version: canary");
      expect(workflow).not.toContain("1.3.14");
    }

    for (const dockerfilePath of runtimeDockerfiles) {
      const dockerfile = readRepoFile(dockerfilePath);
      expect(dockerfile).toMatch(new RegExp(`^ARG BUN_VERSION=${BUN_VERSION.replaceAll(".", "\\.")}$`, "m"));
      expect(dockerfile).toContain("FROM oven/bun:${BUN_VERSION}");
      expect(dockerfile).not.toContain("1.3.14");
    }
  });

  test("keeps Bun type declarations and lockfiles on the runtime baseline", () => {
    for (const packageDirectory of packageDirectories) {
      const packageJson = JSON.parse(readRepoFile(`packages/${packageDirectory}/package.json`)) as {
        devDependencies?: Record<string, string>;
      };
      expect(packageJson.devDependencies?.["@types/bun"]).toBe(`^${BUN_VERSION}`);

      const lockfile = readRepoFile(`packages/${packageDirectory}/bun.lock`);
      expect(lockfile).toContain(`"@types/bun@${BUN_VERSION}"`);
      expect(lockfile).toContain(`"bun-types@${BUN_VERSION}"`);
      expect(lockfile).not.toContain('"@types/bun@1.3.14"');
      expect(lockfile).not.toContain('"bun-types@1.3.14"');
    }

    const litePackageJson = JSON.parse(readRepoFile("packages/supacloud-lite/package.json")) as {
      engines?: Record<string, string>;
    };
    expect(litePackageJson.engines?.bun).toBe(`>=${BUN_VERSION}`);
  });

  test("ships matching SupaCloud Lite runtime notices and launcher guidance", () => {
    const noticePath = `packages/supacloud-lite/LICENSES/BUN-${BUN_VERSION}-RUNTIME-NOTICES.txt`;
    expect(existsSync(join(repoRoot, noticePath))).toBe(true);
    expect(existsSync(join(repoRoot, "packages/supacloud-lite/LICENSES/BUN-1.3.14-RUNTIME-NOTICES.txt"))).toBe(false);

    const notices = readRepoFile("packages/supacloud-lite/THIRD_PARTY_NOTICES.md");
    expect(notices).toContain(`Version: ${BUN_VERSION}`);
    expect(notices).toContain(`LICENSES/BUN-${BUN_VERSION}-RUNTIME-NOTICES.txt`);
    expect(notices).not.toContain("1.3.14");

    const launcher = readRepoFile("packages/supacloud-lite/src/launcher.cjs");
    expect(launcher).toContain(`Install Bun ${BUN_VERSION} or newer`);
  });
});

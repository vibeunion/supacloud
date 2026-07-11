import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getConfigFilePath,
  mergeInstallInputValues,
  readInstallInputValues,
  resolveInstallArtifactPolicy,
  writeInstallInputAtomic,
} from "../../src/install";

const repoRoot = resolve(import.meta.dir, "../../../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("management install command persistence", () => {
  test("uses root install input instead of the tracked template and preserves values across reruns", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-install-command-"));
    tempDirs.push(dir);
    const installInput = join(dir, "install.env");
    const trackedTemplate = join(dir, "config.env");
    const trackedContents = "S3_STORAGE_TYPE=juicefs\nPG_VERSION=18\n";
    writeFileSync(trackedTemplate, trackedContents);

    expect(getConfigFilePath(join(repoRoot, "install.sh"), {
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
    })).toBe(installInput);

    const firstGenerated = {
      INTERNAL_IP: "10.0.0.8",
      SUPABASE_PUBLIC_DOMAIN: "api.stable.example",
      SUPABASE_STUDIO_DOMAIN: "studio.stable.example",
      POSTGRES_PASSWORD: "database-first",
      DASHBOARD_PASSWORD: "dashboard-first",
      GRAFANA_PASSWORD: "grafana-first",
      JWT_SECRET: "jwt-first",
      PG_VERSION: "17",
      S3_STORAGE_TYPE: "external",
    };
    const first = mergeInstallInputValues({}, {}, firstGenerated);
    writeInstallInputAtomic(installInput, first);

    const persisted = readInstallInputValues(installInput, join(repoRoot, "install.sh"));
    const second = mergeInstallInputValues(persisted, {}, {
      ...firstGenerated,
      POSTGRES_PASSWORD: "database-regenerated",
      DASHBOARD_PASSWORD: "dashboard-regenerated",
      JWT_SECRET: "jwt-regenerated",
      PG_VERSION: "18",
      S3_STORAGE_TYPE: "juicefs",
    });
    expect(second).toEqual(first);

    const explicit = mergeInstallInputValues(persisted, {
      SUPABASE_PUBLIC_DOMAIN: "api.explicit.example",
      S3_STORAGE_TYPE: "minio",
    }, firstGenerated);
    expect(explicit.SUPABASE_PUBLIC_DOMAIN).toBe("api.explicit.example");
    expect(explicit.S3_STORAGE_TYPE).toBe("minio");
    expect(explicit.POSTGRES_PASSWORD).toBe("database-first");

    writeInstallInputAtomic(installInput, explicit);
    expect(statSync(installInput).mode & 0o777).toBe(0o600);
    expect(readFileSync(trackedTemplate, "utf8")).toBe(trackedContents);
  });

  test("dry-run implementation has no tracked config write or credential-printing path", () => {
    const source = readFileSync(join(repoRoot, "packages/management-api/src/install.ts"), "utf8");
    expect(source).not.toContain('path.join(path.dirname(installerPath), "config.env")');
    expect(source).not.toContain("await Bun.write(configFile");
    expect(source).not.toContain("Dashboard Password:");
    expect(source).not.toContain("Database Password:");
    expect(source.toLowerCase()).not.toContain("screenshot to save");
    expect(source).not.toContain('"--password", config.postgresPass');
    expect(source).toContain("if (!isDryRun)");
  });

  test("local CLI installs opt into source fallback while release installs remain fail-closed", () => {
    expect(resolveInstallArtifactPolicy({})).toEqual({
      mode: "local",
      forceVerified: false,
    });
    expect(resolveInstallArtifactPolicy({
      SUPACLOUD_SETUP_ARTIFACT_MODE: "",
      SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
    })).toEqual({
      mode: "local",
      forceVerified: false,
    });
    expect(resolveInstallArtifactPolicy({
      SUPACLOUD_SETUP_ARTIFACT_MODE: "release",
    })).toEqual({
      mode: "release",
      forceVerified: true,
    });
    expect(resolveInstallArtifactPolicy({
      SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "true",
    })).toEqual({
      mode: "release",
      forceVerified: true,
    });
    expect(() => resolveInstallArtifactPolicy({
      SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
      SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "true",
    })).toThrow("cannot be combined");
    expect(() => resolveInstallArtifactPolicy({
      SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "yes",
    })).toThrow("must be true or false");
  });
});

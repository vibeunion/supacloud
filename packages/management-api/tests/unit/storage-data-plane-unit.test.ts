import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStorageDataPlaneCommand } from "../../src/standalone";

const repoRoot = join(import.meta.dir, "../../..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("storage data-plane systemd unit", () => {
  test("install.sh enables a service outside the Management API cgroup", () => {
    const installer = readRepoFile("install.sh");
    const unit = readRepoFile("infrastructure/systemd/supacloud-storage-data-plane.service");
    const managementUnit = readRepoFile("infrastructure/systemd/supacloud.service");
    const managementCall = installer.indexOf("    install_management_api\n");
    const storageCall = installer.indexOf("    install_storage_data_plane\n");

    expect(managementCall).toBeGreaterThan(0);
    expect(storageCall).toBeGreaterThan(managementCall);
    expect(installer).toContain("systemctl enable supacloud-storage-data-plane");
    expect(installer).toContain("systemctl restart supacloud-storage-data-plane");
    expect(installer).toContain("ExecStart=${binary} --storage-data-plane");
    expect(installer).not.toContain("systemctl restart supacloud-storage-data-plane --no-block");
    expect(unit).toContain("ExecStart=/usr/local/bin/supacloud --storage-data-plane");
    expect(unit).toContain("Environment=STORAGE_DATA_PLANE_PORT=9108");
    expect(unit).not.toMatch(/^(Requires|BindsTo|PartOf|JoinsNamespaceOf)=.*supacloud\.service/m);
    expect(managementUnit).not.toContain("storage-data-plane");
    expect(managementUnit).not.toContain("--storage-data-plane");
  });

  test("the binary flag starts only the storage data plane", () => {
    expect(isStorageDataPlaneCommand(["--storage-data-plane"])).toBe(true);
    expect(isStorageDataPlaneCommand(["--storage-data-plane", "--version"])).toBe(false);
    expect(isStorageDataPlaneCommand(["upgrade", "--storage-data-plane"])).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "../../..", "..");
const temporaryDirectories: string[] = [];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Management pre-start recovery sandbox", () => {
  test("does not invoke a container runtime from the mount-filtered service", () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-pre-start-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "container-runtime-called");

    for (const runtime of ["podman", "docker"]) {
      writeExecutable(join(directory, runtime), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${marker}"\nexit 99\n`);
    }
    writeExecutable(join(directory, "psql"), "#!/usr/bin/env bash\nprintf 'search_path=auth, public\\n'\n");
    writeExecutable(join(directory, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");

    const run = Bun.spawnSync(["bash", join(repoRoot, "scripts/pre_start_recovery.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH || ""}`,
        PGDATA: join(directory, "missing-pgdata"),
        EDGE_RUNTIME_MODE: "external",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const preStart = readRepoFile("scripts/pre_start_recovery.sh");
    expect(preStart).not.toContain("podman");
    expect(preStart).not.toContain("docker");
    expect(preStart).not.toContain("ensure_service_containers_running");
  });

  test("keeps container ownership outside the management sandbox", () => {
    const managementUnit = readRepoFile("infrastructure/systemd/supacloud.service");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");
    const installer = readRepoFile("install.sh");
    const imaginarySection = installer.slice(
      installer.indexOf("# --- 1. Deploy Imaginary"),
      installer.indexOf("# --- 2. Deploy Supabase Realtime"),
    );

    expect(managementUnit).toContain("SystemCallFilter=~@mount");
    expect(managementUnit).toContain("ExecStartPre=/opt/supacloud/scripts/pre_start_recovery.sh");
    expect(managementUnit).not.toContain("ExecStartPre=/usr/bin/podman");
    expect(realtimeUnit).toContain("ExecStart=/usr/bin/podman run");
    expect(realtimeUnit).not.toContain("SystemCallFilter=");
    expect(imaginarySection).toContain("--restart=always");
  });
});
